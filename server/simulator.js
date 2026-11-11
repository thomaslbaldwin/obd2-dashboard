'use strict';

/**
 * ELM327 WiFi adapter simulator.
 *
 * Emulates the TCP interface of a WiFi OBD2 dongle connected to a running car,
 * so the dashboard can be developed and demoed without being in a vehicle.
 *
 *   node server/simulator.js                 # one adapter on 0.0.0.0:35000
 *   node server/simulator.js --port 35001 --profile 1
 *   node server/simulator.js --count 3       # three adapters on 35000-35002
 */

const net = require('net');

const PROFILES = [
  {
    name: 'Daily Sedan', make: 'Generic', model: 'Sedan', year: 2019, color: '#2a78d6',
    vin: 'JTDBR32E720045671', protocol: '6',
    pids: ['01', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '10', '11', '1F', '21', '2F', '31', '33', '42', '46', '5C', '5E'],
    dtcs: ['P0171', 'P0420'], pending: ['P0300'], redline: 6500, idle: 750, gears: [3.5, 2.1, 1.4, 1.0, 0.8, 0.65],
  },
  {
    name: 'Work Truck', make: 'Generic', model: 'Pickup', year: 2013, color: '#eb6834',
    vin: '1FTFW1ET5DFC10312', protocol: '7',
    pids: ['01', '04', '05', '06', '07', '0B', '0C', '0D', '0E', '0F', '10', '11', '1F', '2F', '33', '42', '46'],
    dtcs: [], pending: [], redline: 5800, idle: 650, gears: [3.1, 1.9, 1.3, 1.0, 0.75, 0.62],
  },
  {
    name: 'Weekend Coupe', make: 'Generic', model: 'Coupe', year: 2008, color: '#1baf7a',
    vin: 'WVWZZZ1KZAW000001', protocol: '3',
    pids: ['01', '04', '05', '06', '07', '0C', '0D', '0E', '0F', '10', '11', '1F', '2F'],
    dtcs: ['P0128'], pending: [], redline: 7200, idle: 850, gears: [3.8, 2.3, 1.6, 1.2, 1.0, 0.85],
  },
];

/** Physics-ish drive model producing plausible, coherent sensor values. */
class CarModel {
  constructor(profile) {
    this.p = profile;
    this.start = Date.now();
    this.last = Date.now();
    this.speed = 0; // km/h
    this.rpm = profile.idle;
    this.throttle = 0;
    this.coolant = 22;
    this.oil = 22;
    this.fuel = 68;
    this.ambient = 21;
    this.dtcs = profile.dtcs.slice();
    this.pending = profile.pending.slice();
    this.distanceSinceClear = 1840;
  }

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.last) / 1000, 1);
    this.last = now;
    const t = (now - this.start) / 1000;
    // Repeating 90 s drive cycle: idle → accelerate → cruise → brake.
    const phase = t % 90;
    let target;
    if (phase < 8) target = 0;
    else if (phase < 30) target = 30 + (phase - 8) * 3.5;
    else if (phase < 60) target = 105 + Math.sin(t / 3) * 6;
    else if (phase < 75) target = 50 + Math.sin(t) * 4;
    else target = Math.max(0, 50 - (phase - 75) * 4);
    const accel = Math.max(-12, Math.min(8, (target - this.speed) * 0.6));
    this.speed = Math.max(0, this.speed + accel * dt);
    this.throttle = accel > 0.2 ? Math.min(85, 15 + accel * 9) : this.speed > 2 ? 12 : 0;

    const gears = this.p.gears;
    const gear = this.speed < 18 ? 0 : this.speed < 35 ? 1 : this.speed < 55 ? 2 : this.speed < 75 ? 3 : this.speed < 95 ? 4 : 5;
    const wheelRpm = this.speed * gears[gear] * 30;
    const targetRpm = Math.max(this.p.idle, Math.min(this.p.redline, wheelRpm + this.throttle * 8));
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 4);
    this.rpm += (Math.random() - 0.5) * 20;

    this.coolant = Math.min(91 + Math.random(), this.coolant + dt * 0.9);
    this.oil = Math.min(98, this.oil + dt * 0.5);
    this.fuel = Math.max(5, this.fuel - dt * 0.004);
    this.distanceSinceClear += (this.speed / 3600) * dt;
  }

  get load() { return Math.min(100, 18 + this.throttle * 0.9 + (this.rpm / this.p.redline) * 10); }
  get map() { return Math.min(101, 28 + this.throttle * 0.8); }
  get maf() { return (this.rpm / 1000) * (2 + this.load * 0.12); }
}

function byte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function word(v) {
  const n = Math.max(0, Math.min(65535, Math.round(v)));
  return [n >> 8, n & 0xff];
}

function pidBytes(car, pid) {
  switch (pid) {
    case '01': return [(car.dtcs.length ? 0x80 : 0) | car.dtcs.length, 0x07, 0xe5, 0x00];
    case '04': return [byte((car.load * 255) / 100)];
    case '05': return [byte(car.coolant + 40)];
    case '06': return [byte(128 + (Math.random() - 0.5) * 10)];
    case '07': return [byte(128 + (car.dtcs.includes('P0171') ? 14 : 3))];
    case '0A': return [byte(340 / 3)];
    case '0B': return [byte(car.map)];
    case '0C': return word(car.rpm * 4);
    case '0D': return [byte(car.speed)];
    case '0E': return [byte((12 + car.throttle * 0.1 + 64) * 2)];
    case '0F': return [byte(car.ambient + 9 + 40)];
    case '10': return word(car.maf * 100);
    case '11': return [byte((car.throttle * 255) / 100)];
    case '1F': return word((Date.now() - car.start) / 1000);
    case '21': return word(car.dtcs.length ? 37 : 0);
    case '2F': return [byte((car.fuel * 255) / 100)];
    case '31': return word(car.distanceSinceClear);
    case '33': return [101];
    case '42': return word(14.1 * 1000 + (Math.random() - 0.5) * 100);
    case '46': return [byte(car.ambient + 40)];
    case '5C': return [byte(car.oil + 40)];
    case '5E': return word((car.maf / 14.7 / 0.74) * 3.6 * 20);
    default: return null;
  }
}

function supportedBitmap(pids, base) {
  const bytes = [0, 0, 0, 0];
  for (const pid of pids) {
    const n = parseInt(pid, 16) - base;
    if (n >= 1 && n <= 32) bytes[(n - 1) >> 3] |= 0x80 >> ((n - 1) & 7);
  }
  // Advertise the next range if anything above it is supported.
  if (pids.some((p) => parseInt(p, 16) > base + 32)) bytes[3] |= 0x01;
  return bytes;
}

function hex(bytes, spaces) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(spaces ? ' ' : '');
}

function encodeDtc(code) {
  const letter = 'PCBU'.indexOf(code[0]);
  const first = (letter << 6) | (parseInt(code[1], 16) << 4) | parseInt(code[2], 16);
  return [first, parseInt(code.slice(3), 16)];
}

/** Handle one TCP client connection as an ELM327 would. */
function handleClient(socket, car, profile) {
  const s = { echo: true, spaces: true, headers: false, linefeeds: false, protocolReady: false };
  let buf = '';
  const isCan = ['6', '7', '8', '9'].includes(profile.protocol);

  const reply = (cmd, lines) => {
    const eol = s.linefeeds ? '\r\n' : '\r';
    let out = s.echo ? cmd + eol : '';
    out += lines.join(eol) + eol + eol + '>';
    // Small, realistic latency for the vehicle bus.
    const delay = /^AT/.test(cmd) ? 5 : 25 + Math.random() * 20;
    setTimeout(() => !socket.destroyed && socket.write(out), delay);
  };

  const obdReply = (cmd) => {
    const mode = cmd.slice(0, 2);
    const searching = !s.protocolReady ? ['SEARCHING...'] : [];
    s.protocolReady = true;
    car.tick();
    if (mode === '01') {
      const pid = cmd.slice(2, 4);
      let data;
      if (['00', '20', '40', '60'].includes(pid)) {
        const base = parseInt(pid, 16);
        if (base > 0 && !profile.pids.some((p) => parseInt(p, 16) > base)) return [...searching, 'NO DATA'];
        data = supportedBitmap(profile.pids, base);
      } else if (profile.pids.includes(pid)) {
        data = pidBytes(car, pid);
      }
      if (!data) return [...searching, 'NO DATA'];
      return [...searching, hex([0x41, parseInt(pid, 16), ...data], s.spaces)];
    }
    if (mode === '03' || mode === '07') {
      const list = mode === '03' ? car.dtcs : car.pending;
      const respMode = mode === '03' ? 0x43 : 0x47;
      if (isCan) return [hex([respMode, list.length, ...list.flatMap(encodeDtc)], s.spaces)];
      const bytes = list.flatMap(encodeDtc);
      while (bytes.length % 6 !== 0 || bytes.length === 0) bytes.push(0);
      const lines = [];
      for (let i = 0; i < bytes.length; i += 6) lines.push(hex([respMode, ...bytes.slice(i, i + 6)], s.spaces));
      return lines;
    }
    if (mode === '04') {
      car.dtcs = [];
      car.pending = [];
      car.distanceSinceClear = 0;
      return ['44'];
    }
    if (mode === '0A') return ['NO DATA'];
    if (cmd === '0902') {
      const vin = [...profile.vin].map((c) => c.charCodeAt(0));
      if (isCan) {
        const payload = [0x49, 0x02, 0x01, ...vin];
        const lines = ['014'];
        lines.push('0:' + hex(payload.slice(0, 6), s.spaces));
        for (let i = 6, n = 1; i < payload.length; i += 7, n++) lines.push(`${n}:` + hex(payload.slice(i, i + 7), s.spaces));
        return lines;
      }
      const padded = [0, 0, 0, ...vin];
      const lines = [];
      for (let i = 0, seq = 1; i < padded.length; i += 4, seq++) lines.push(hex([0x49, 0x02, seq, ...padded.slice(i, i + 4)], s.spaces));
      return lines;
    }
    return ['NO DATA'];
  };

  const handle = (raw) => {
    const cmd = raw.replace(/\s+/g, '').toUpperCase();
    if (!cmd) return reply('', ['?']);
    if (cmd.startsWith('AT')) {
      const at = cmd.slice(2);
      if (at === 'Z' || at === 'WS') {
        Object.assign(s, { echo: true, spaces: true, headers: false, linefeeds: false, protocolReady: false });
        return reply(cmd, ['', 'ELM327 v1.5']);
      }
      if (at === 'I') return reply(cmd, ['ELM327 v1.5']);
      if (at === 'RV') return reply(cmd, [(car.rpm > 400 ? 14.1 + Math.random() * 0.2 : 12.6).toFixed(1) + 'V']);
      if (at === 'DPN') return reply(cmd, ['A' + profile.protocol]);
      if (at === 'DP') return reply(cmd, ['AUTO, ISO 15765-4 (CAN 11/500)']);
      if (/^E[01]$/.test(at)) s.echo = at === 'E1';
      else if (/^S[01]$/.test(at)) s.spaces = at === 'S1';
      else if (/^H[01]$/.test(at)) s.headers = at === 'H1';
      else if (/^L[01]$/.test(at)) s.linefeeds = at === 'L1';
      else if (/^SP[0-9A-C]$/.test(at)) s.protocolReady = false;
      else if (!/^(AT[0-2]|ST[0-9A-F]{2}|D|M[01]|CAF[01])$/.test(at)) return reply(cmd, ['?']);
      return reply(cmd, ['OK']);
    }
    if (!/^[0-9A-F]+$/.test(cmd)) return reply(cmd, ['?']);
    return reply(cmd, obdReply(cmd));
  };

  socket.setNoDelay(true);
  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let idx;
    while ((idx = buf.indexOf('\r')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handle(line);
    }
  });
  socket.on('error', () => {});
}

function startSimulator({ port = 35000, host = '0.0.0.0', profile = PROFILES[0] } = {}) {
  const car = new CarModel(profile);
  const server = net.createServer((socket) => handleClient(socket, car, profile));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i !== -1 ? args[i + 1] : dflt;
  };
  const basePort = Number(opt('port', 35000));
  const count = Number(opt('count', 1));
  const first = Number(opt('profile', 0));
  for (let i = 0; i < count; i++) {
    const profile = PROFILES[(first + i) % PROFILES.length];
    const port = basePort + i;
    startSimulator({ port, profile }).then(() =>
      console.log(`Simulated ELM327 "${profile.name}" (VIN ${profile.vin}) on port ${port}`)
    );
  }
}

module.exports = { startSimulator, PROFILES, CarModel };
