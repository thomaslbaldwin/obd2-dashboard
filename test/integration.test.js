'use strict';

// End-to-end: two simulated WiFi adapters, the real server, REST + WebSocket.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createApp } = require('../server/index');
const { startSimulator, PROFILES } = require('../server/simulator');

async function json(base, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

function waitFor(fn, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const v = await fn();
        if (v) { clearInterval(iv); resolve(v); }
        else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error('waitFor timed out')); }
      } catch (err) { clearInterval(iv); reject(err); }
    }, 100);
  });
}

test('connects to multiple vehicles at once and streams live data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-test-'));
  const sims = await Promise.all([
    startSimulator({ port: 0, host: '127.0.0.1', profile: PROFILES[0] }),
    startSimulator({ port: 0, host: '127.0.0.1', profile: PROFILES[2] }),
  ]);
  const app = createApp({ dataFile: path.join(dir, 'vehicles.json'), sessionOptions: { reconnect: false } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  t.after(async () => {
    await app.shutdown();
    sims.forEach((s) => s.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Validation
  const bad = await json(base, 'POST', '/api/vehicles', { name: '', host: 'x' });
  assert.equal(bad.status, 400);

  const a = (await json(base, 'POST', '/api/vehicles', { name: 'Sedan', host: '127.0.0.1', port: sims[0].address().port })).body;
  const b = (await json(base, 'POST', '/api/vehicles', { name: 'Coupe', host: '127.0.0.1', port: sims[1].address().port })).body;
  assert.ok(a.id && b.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'vehicles.json'), 'utf8')).vehicles.length, 2);

  const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const seen = { [a.id]: 0, [b.id]: 0 };
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.type === 'data') seen[msg.vehicleId]++;
  });
  await new Promise((r) => ws.once('open', r));

  await json(base, 'POST', `/api/vehicles/${a.id}/connect`);
  await json(base, 'POST', `/api/vehicles/${b.id}/connect`);
  await waitFor(() => seen[a.id] > 5 && seen[b.id] > 5);

  // VIN is learned and saved onto each profile
  const list = (await json(base, 'GET', '/api/vehicles')).body;
  assert.equal(list.find((v) => v.id === a.id).vin, PROFILES[0].vin);
  assert.equal(list.find((v) => v.id === b.id).vin, PROFILES[2].vin);
  assert.equal(list.find((v) => v.id === b.id).status.info.protocol, 'ISO 9141-2');

  const snapA = (await json(base, 'GET', `/api/vehicles/${a.id}/snapshot`)).body;
  assert.equal(snapA.state, 'connected');
  assert.ok(snapA.latest.rpm > 0);
  assert.deepEqual(snapA.dtcs.stored, PROFILES[0].dtcs);

  // Raw command + clear codes
  const rv = (await json(base, 'POST', `/api/vehicles/${a.id}/command`, { command: 'ATRV' })).body;
  assert.match(rv.response, /V$/);
  const cleared = (await json(base, 'POST', `/api/vehicles/${a.id}/dtcs/clear`)).body;
  assert.deepEqual(cleared.stored, []);

  // CSV export
  const csv = await (await fetch(`${base}/api/vehicles/${a.id}/log.csv`)).text();
  assert.match(csv.split('\n')[0], /^timestamp,/);
  assert.ok(csv.split('\n').length > 2);

  await json(base, 'POST', `/api/vehicles/${a.id}/disconnect`);
  assert.equal((await json(base, 'GET', `/api/vehicles/${a.id}/snapshot`)).body.state, 'disconnected');
  assert.equal((await json(base, 'POST', `/api/vehicles/${a.id}/dtcs/read`)).status, 409);

  ws.close();
});

test('reports a clear error when the adapter is unreachable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-test-'));
  const app = createApp({ dataFile: path.join(dir, 'vehicles.json'), sessionOptions: { reconnect: false } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const v = (await json(base, 'POST', '/api/vehicles', { name: 'Nowhere', host: '127.0.0.1', port: 1 })).body;
  await json(base, 'POST', `/api/vehicles/${v.id}/connect`);
  const snap = await waitFor(async () => {
    const s = (await json(base, 'GET', `/api/vehicles/${v.id}/snapshot`)).body;
    return s.state === 'error' ? s : null;
  });
  assert.match(snap.error, /ECONNREFUSED/);
});
