'use strict';

const { EventEmitter } = require('events');
const { Elm327 } = require('./elm327');
const obd = require('./obd');

const INIT_COMMANDS = [
  ['ATZ', 4000], // reset
  ['ATE0'], // echo off
  ['ATL0'], // linefeeds off
  ['ATS0'], // spaces off
  ['ATH0'], // headers off
  ['ATAT1'], // adaptive timing
];

const HISTORY_SECONDS = 600; // in-memory history kept per vehicle
const TRAFFIC_LOG_SIZE = 200;

/**
 * One live connection to one vehicle's adapter. Owns the polling loop.
 *
 * Events:
 *   'status'  (statusObject)
 *   'data'    ({ t, values: { key: number } })
 *   'dtcs'    ({ stored, pending, permanent, milOn, dtcCount, readAt })
 *   'traffic' ({ t, dir, text })
 */
class VehicleSession extends EventEmitter {
  constructor(vehicle, options = {}) {
    super();
    this.vehicle = vehicle;
    this.pollInterval = options.pollInterval ?? 0; // extra delay between cycles (ms)
    this.reconnect = options.reconnect ?? true;
    this.elm = null;
    this.state = 'disconnected';
    this.error = null;
    this.info = {};
    this.supportedPids = [];
    this.activePids = [];
    this.latest = {};
    this.history = []; // [{t, values}]
    this.traffic = [];
    this.dtcs = null;
    this.failCounts = {};
    this.cycle = 0;
    this.stopRequested = false;
    this.loopPromise = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
    this.rate = 0; // samples per second
  }

  get id() {
    return this.vehicle.id;
  }

  status() {
    return {
      vehicleId: this.vehicle.id,
      state: this.state,
      error: this.error,
      info: this.info,
      supportedPids: this.supportedPids,
      activePids: this.activePids,
      rate: this.rate,
    };
  }

  snapshot() {
    return {
      ...this.status(),
      latest: this.latest,
      history: this.history,
      dtcs: this.dtcs,
      traffic: this.traffic.slice(-50),
    };
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('status', this.status());
  }

  async start() {
    if (['connecting', 'initializing', 'connected'].includes(this.state)) return;
    this.stopRequested = false;
    clearTimeout(this.reconnectTimer);
    const { host, port } = this.vehicle;
    this._setState('connecting');

    const elm = new Elm327({ host, port: Number(port) });
    this.elm = elm;
    elm.on('traffic', (t) => this._logTraffic(t.dir, t.text));
    elm.on('error', (err) => this._logTraffic('err', err.message));
    elm.on('close', () => {
      if (this.elm !== elm) return;
      this._logTraffic('err', 'Adapter connection closed');
      if (!this.stopRequested) this._handleFailure(new Error('Adapter connection closed'));
    });

    try {
      await elm.connect();
      this._setState('initializing');
      await this._initialize();
      this.reconnectDelay = 2000;
      this._setState('connected');
      this.loopPromise = this._pollLoop();
    } catch (err) {
      if (this.elm === elm) this._handleFailure(err);
    }
  }

  async stop() {
    this.stopRequested = true;
    clearTimeout(this.reconnectTimer);
    const elm = this.elm;
    this.elm = null;
    if (elm) elm.close();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
    this.rate = 0;
    this._setState('disconnected');
  }

  _handleFailure(err) {
    const elm = this.elm;
    this.elm = null;
    if (elm) elm.destroy();
    this.rate = 0;
    if (this.stopRequested) return;
    if (this.reconnect) {
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this._setState('reconnecting', `${err.message} — retrying in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.start(), delay);
    } else {
      this._setState('error', err.message);
    }
  }

  _logTraffic(dir, text) {
    const entry = { t: Date.now(), dir, text };
    this.traffic.push(entry);
    if (this.traffic.length > TRAFFIC_LOG_SIZE) this.traffic.shift();
    this.emit('traffic', entry);
  }

  async _initialize() {
    const elm = this.elm;
    for (const [cmd, timeout] of INIT_COMMANDS) {
      const res = await elm.send(cmd, { timeout });
      if (cmd === 'ATZ') this.info.adapter = res.split(/[\r\n]+/).filter(Boolean).pop() || 'ELM327';
    }
    const protocol = String(this.vehicle.protocol || '0');
    await elm.send('ATSP' + protocol);

    // First OBD request triggers protocol search; allow it plenty of time.
    let supported = [];
    try {
      const res = await elm.send('0100', { timeout: 15000 });
      supported = obd.decodeSupportedPids(res, '00');
      for (const base of ['20', '40']) {
        if (!supported.includes(base)) break;
        try {
          const more = await elm.send('01' + base);
          supported = supported.concat(obd.decodeSupportedPids(more, base));
        } catch (_) {
          break;
        }
      }
    } catch (err) {
      if (/UNABLE TO CONNECT|NO RESPONSE|BUS INIT|Timeout/i.test(err.message)) {
        throw new Error(
          `Adapter reachable but vehicle ECU not responding (${err.message}). Is the ignition on?`
        );
      }
      this._logTraffic('err', `Supported-PID query failed (${err.message}); using defaults`);
    }

    this.supportedPids = supported;
    const known = Object.keys(obd.PIDS).sort();
    this.activePids = supported.length
      ? known.filter((p) => supported.includes(p))
      : obd.DEFAULT_PIDS.slice();

    try {
      const dpn = await elm.send('ATDPN');
      this.info.protocolCode = dpn.trim();
      this.info.protocol = obd.protocolName(dpn);
    } catch (_) {
      /* optional */
    }
    try {
      this.info.vin = obd.parseVin(await elm.send('0902', { timeout: 6000 }));
    } catch (_) {
      this.info.vin = null;
    }
    try {
      this.info.batteryVoltage = obd.parseVoltage(await elm.send('ATRV'));
    } catch (_) {
      /* optional */
    }
    this.emit('identified', this.info);
    await this.readDtcs({ duringInit: true }).catch((err) => this._logTraffic('err', `DTC read failed: ${err.message}`));
  }

  /** PIDs to query on a given cycle — fast PIDs every cycle, slower ones less often. */
  _pidsForCycle(cycle) {
    return this.activePids.filter((pid) => {
      const tier = obd.PIDS[pid].tier;
      if (tier === 1) return true;
      if (tier === 2) return cycle % 3 === 0;
      return cycle % 10 === 0;
    });
  }

  async _pollLoop() {
    let windowStart = Date.now();
    let samples = 0;
    while (this.elm && this.state === 'connected' && !this.stopRequested) {
      const elm = this.elm;
      const values = {};
      const pids = this._pidsForCycle(this.cycle);
      for (const pid of pids) {
        if (!this.elm || this.stopRequested) return;
        try {
          const raw = await elm.send('01' + pid);
          values[obd.PIDS[pid].key] = obd.decodePid(pid, raw);
          this.failCounts[pid] = 0;
          samples++;
        } catch (err) {
          if (!elm.connected) return; // connection loss is handled by 'close'
          this.failCounts[pid] = (this.failCounts[pid] || 0) + 1;
          // Drop PIDs the car consistently refuses to answer.
          if (this.failCounts[pid] >= 3 && /NO DATA|UNEXPECTED|SHORT/.test(err.message)) {
            this.activePids = this.activePids.filter((p) => p !== pid);
            this._logTraffic('err', `PID ${pid} not answered; removed from polling`);
            this.emit('status', this.status());
          }
        }
      }
      if (this.cycle % 10 === 0) {
        try {
          const v = obd.parseVoltage(await elm.send('ATRV'));
          if (v != null) values.batteryVoltage = v;
        } catch (_) {
          if (!elm.connected) return;
        }
      }
      if (this.cycle % 25 === 0) {
        try {
          const ms = obd.decodeMonitorStatus(await elm.send('0101'));
          values.milOn = ms.milOn ? 1 : 0;
          values.dtcCount = ms.dtcCount;
        } catch (_) {
          if (!elm.connected) return;
        }
      }
      this.cycle++;

      if (Object.keys(values).length) {
        const t = Date.now();
        Object.assign(this.latest, values);
        this.history.push({ t, values });
        const cutoff = t - HISTORY_SECONDS * 1000;
        while (this.history.length && this.history[0].t < cutoff) this.history.shift();
        this.emit('data', { t, values });
      }

      const now = Date.now();
      if (now - windowStart >= 2000) {
        this.rate = Math.round((samples * 1000) / (now - windowStart));
        samples = 0;
        windowStart = now;
        this.emit('status', this.status());
      }
      if (this.pollInterval) await sleep(this.pollInterval);
      else if (pids.length === 0) await sleep(250);
    }
  }

  async readDtcs({ duringInit = false } = {}) {
    const elm = duringInit ? this.elm : this.requireConnection();
    const protocol = this.info.protocolCode;
    const stored = obd.parseDtcs(await elm.send('03', { timeout: 8000 }), '43', protocol);
    let pending = [];
    let permanent = [];
    try {
      pending = obd.parseDtcs(await elm.send('07', { timeout: 8000 }), '47', protocol);
    } catch (_) { /* not all vehicles support mode 07 */ }
    try {
      permanent = obd.parseDtcs(await elm.send('0A', { timeout: 8000 }), '4A', protocol);
    } catch (_) { /* mode 0A is 2010+ only */ }
    let milOn = null;
    let dtcCount = null;
    try {
      const ms = obd.decodeMonitorStatus(await elm.send('0101'));
      milOn = ms.milOn;
      dtcCount = ms.dtcCount;
    } catch (_) { /* optional */ }
    this.dtcs = { stored, pending, permanent, milOn, dtcCount, readAt: Date.now() };
    this.emit('dtcs', this.dtcs);
    return this.dtcs;
  }

  async clearDtcs() {
    const elm = this.requireConnection();
    const res = await elm.send('04', { timeout: 8000 });
    const lines = obd.cleanLines(res);
    obd.assertNoError(lines);
    if (!lines.some((l) => l.includes('44'))) {
      throw new Error('Vehicle did not confirm clear (engine may need to be off with ignition on)');
    }
    return this.readDtcs();
  }

  async rawCommand(cmd) {
    const elm = this.requireConnection();
    const clean = String(cmd).trim().toUpperCase();
    if (!/^[0-9A-Z @.]{1,40}$/.test(clean)) throw new Error('Invalid command');
    return elm.send(clean, { timeout: 10000 });
  }

  requireConnection() {
    if (!this.elm || this.state !== 'connected') throw new Error('Vehicle is not connected');
    return this.elm;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { VehicleSession };
