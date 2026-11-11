'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { VehicleStore, ValidationError } = require('./store');
const { VehicleSession } = require('./session');
const { PIDS, parseVoltage } = require('./obd');
const { Elm327 } = require('./elm327');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function createApp({ dataFile = path.join(ROOT, 'data', 'vehicles.json'), sessionOptions = {} } = {}) {
  const store = new VehicleStore(dataFile);
  const sessions = new Map(); // vehicleId -> VehicleSession
  const clients = new Set();

  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(text);
  }

  function vehicleList() {
    return store.list().map((v) => ({ ...v, status: sessions.get(v.id)?.status() || { state: 'disconnected' } }));
  }

  function getSession(vehicle) {
    let s = sessions.get(vehicle.id);
    if (s) {
      s.vehicle = vehicle;
      return s;
    }
    s = new VehicleSession(vehicle, sessionOptions);
    s.on('status', (status) => broadcast({ type: 'status', vehicleId: vehicle.id, status }));
    s.on('data', (sample) => broadcast({ type: 'data', vehicleId: vehicle.id, ...sample }));
    s.on('dtcs', (dtcs) => broadcast({ type: 'dtcs', vehicleId: vehicle.id, dtcs }));
    s.on('traffic', (entry) => broadcast({ type: 'traffic', vehicleId: vehicle.id, entry }));
    s.on('identified', (info) => {
      // Learn the VIN the first time we see this car; flag a mismatch otherwise.
      const current = store.get(vehicle.id);
      if (!current || !info.vin) return;
      if (!current.vin) {
        store.update(vehicle.id, { vin: info.vin });
        broadcast({ type: 'vehicles', vehicles: vehicleList() });
      } else if (current.vin !== info.vin) {
        const other = store.findByVin(info.vin);
        info.vinMismatch = { expected: current.vin, actual: info.vin, matchesVehicleId: other?.id || null };
      }
    });
    sessions.set(vehicle.id, s);
    return s;
  }

  // ---------------------------------------------------------------------------
  // HTTP API
  // ---------------------------------------------------------------------------
  const routes = [
    ['GET', /^\/api\/vehicles$/, () => vehicleList()],
    ['GET', /^\/api\/pids$/, () =>
      Object.entries(PIDS).map(([pid, d]) => ({ pid, key: d.key, name: d.name, unit: d.unit, min: d.min, max: d.max }))],
    // Check that an adapter answers at host:port, without saving anything.
    ['POST', /^\/api\/test-connection$/, async (_, body) => {
      const host = String(body.host || '').trim();
      const port = Number(body.port);
      if (!/^[A-Za-z0-9.\-:]+$/.test(host)) throw httpError(400, 'A valid adapter host/IP is required');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'Port must be 1–65535');
      // Most adapters accept one client at a time, so don't open a second socket to one in use.
      for (const [id, s] of sessions) {
        const v = store.get(id);
        if (v && v.host === host && v.port === port && s.state !== 'disconnected' && s.state !== 'error') {
          return { ok: true, inUse: true, vehicle: v.name, state: s.state };
        }
      }
      return testAdapter(host, port);
    }],
    ['POST', /^\/api\/vehicles$/, (_, body) => {
      const v = store.create(body);
      broadcast({ type: 'vehicles', vehicles: vehicleList() });
      return v;
    }],
    ['PUT', /^\/api\/vehicles\/([\w-]+)$/, async ([id], body) => {
      const v = store.update(id, body);
      if (!v) throw httpError(404, 'Vehicle not found');
      const s = sessions.get(id);
      if (s && ('host' in body || 'port' in body || 'protocol' in body) && s.state !== 'disconnected') {
        await s.stop();
        s.vehicle = v;
        s.start();
      } else if (s) {
        s.vehicle = v;
      }
      broadcast({ type: 'vehicles', vehicles: vehicleList() });
      return v;
    }],
    ['DELETE', /^\/api\/vehicles\/([\w-]+)$/, async ([id]) => {
      const s = sessions.get(id);
      if (s) {
        await s.stop();
        s.removeAllListeners();
        sessions.delete(id);
      }
      if (!store.remove(id)) throw httpError(404, 'Vehicle not found');
      broadcast({ type: 'vehicles', vehicles: vehicleList() });
      return { ok: true };
    }],
    ['GET', /^\/api\/vehicles\/([\w-]+)\/snapshot$/, ([id]) => {
      const v = requireVehicle(id);
      return sessions.get(v.id)?.snapshot() || { vehicleId: v.id, state: 'disconnected', latest: {}, history: [] };
    }],
    ['POST', /^\/api\/vehicles\/([\w-]+)\/connect$/, ([id]) => {
      const s = getSession(requireVehicle(id));
      s.start();
      return s.status();
    }],
    ['POST', /^\/api\/vehicles\/([\w-]+)\/disconnect$/, async ([id]) => {
      requireVehicle(id);
      const s = sessions.get(id);
      if (s) await s.stop();
      return { ok: true };
    }],
    ['POST', /^\/api\/vehicles\/([\w-]+)\/dtcs\/read$/, ([id]) => connectedSession(id).readDtcs()],
    ['POST', /^\/api\/vehicles\/([\w-]+)\/dtcs\/clear$/, ([id]) => connectedSession(id).clearDtcs()],
    ['POST', /^\/api\/vehicles\/([\w-]+)\/command$/, async ([id], body) => {
      const response = await connectedSession(id).rawCommand(body.command || '');
      return { response };
    }],
  ];

  async function testAdapter(host, port) {
    const elm = new Elm327({ host, port, connectTimeout: 5000 });
    elm.on('error', () => {}); // a late socket error must not crash the server
    const started = Date.now();
    try {
      await elm.connect();
      const reset = await elm.send('ATZ', { timeout: 4000 });
      const adapter = reset.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop() || null;
      if (!adapter || !/ELM|OBD|STN|v\d/i.test(adapter)) {
        return { ok: false, error: 'Something answered, but it does not look like an ELM327 adapter' };
      }
      let voltage = null;
      try { voltage = parseVoltage(await elm.send('ATRV', { timeout: 3000 })); } catch (_) { /* optional */ }
      return { ok: true, adapter, voltage, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      elm.destroy();
    }
  }

  function requireVehicle(id) {
    const v = store.get(id);
    if (!v) throw httpError(404, 'Vehicle not found');
    return v;
  }

  function connectedSession(id) {
    requireVehicle(id);
    const s = sessions.get(id);
    if (!s || s.state !== 'connected') throw httpError(409, 'Vehicle is not connected');
    return s;
  }

  async function handleApi(req, res, url) {
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};
        const result = await handler(m.slice(1), body);
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err.status || (err instanceof ValidationError ? 400 : 500);
        return sendJson(res, status, { error: err.message });
      }
    }
    // CSV export of recent history
    const csv = /^\/api\/vehicles\/([\w-]+)\/log\.csv$/.exec(url.pathname);
    if (req.method === 'GET' && csv) {
      const v = store.get(csv[1]);
      if (!v) return sendJson(res, 404, { error: 'Vehicle not found' });
      const history = sessions.get(v.id)?.history || [];
      const keys = [...new Set(history.flatMap((h) => Object.keys(h.values)))];
      const lines = [['timestamp', ...keys].join(',')];
      for (const h of history) {
        lines.push([new Date(h.t).toISOString(), ...keys.map((k) => h.values[k] ?? '')].join(','));
      }
      const safeName = v.name.replace(/[^\w-]+/g, '_');
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${safeName}-${Date.now()}.csv"`,
      });
      return res.end(lines.join('\n'));
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
    else serveStatic(req, res, url);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    const snapshots = {};
    for (const [id, s] of sessions) snapshots[id] = s.snapshot();
    ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now(), vehicles: vehicleList(), snapshots }));
  });

  async function shutdown() {
    await Promise.all([...sessions.values()].map((s) => s.stop()));
    for (const ws of clients) ws.terminate();
    wss.close();
    await new Promise((r) => server.close(r));
  }

  return { server, store, sessions, shutdown };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) {
        reject(httpError(413, 'Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';

  const app = createApp();

  if (demo) {
    const { startSimulator, PROFILES } = require('./simulator');
    PROFILES.slice(0, 2).forEach((profile, i) => {
      const port = 35100 + i;
      startSimulator({ port, profile }).then(() => {
        console.log(`  Demo adapter "${profile.name}" listening on 127.0.0.1:${port}`);
      });
      if (!app.store.list().some((v) => v.port === port && v.host === '127.0.0.1')) {
        app.store.create(
          { name: `${profile.name} (demo)`, make: profile.make, model: profile.model, year: profile.year,
            host: '127.0.0.1', port, color: profile.color, redline: profile.redline },
          { ephemeral: true }
        );
      }
    });
  }

  app.server.listen(PORT, HOST, () => {
    console.log(`OBD2 dashboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '127.0.0.1') console.log('  (set HOST=0.0.0.0 to open it from a phone/tablet on the same network)');
  });

  const stop = () => app.shutdown().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createApp };
