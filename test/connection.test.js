'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');
const { startSimulator, PROFILES } = require('../server/simulator');

async function post(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('test-connection reports a reachable adapter, an unreachable one and one in use', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-test-'));
  const sim = await startSimulator({ port: 0, host: '127.0.0.1', profile: PROFILES[0] });
  const app = createApp({ dataFile: path.join(dir, 'vehicles.json'), sessionOptions: { reconnect: false } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.shutdown();
    sim.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = sim.address().port;

  const ok = (await post(base, '/api/test-connection', { host: '127.0.0.1', port })).body;
  assert.equal(ok.ok, true);
  assert.match(ok.adapter, /ELM327/);
  assert.equal(typeof ok.voltage, 'number');

  const bad = (await post(base, '/api/test-connection', { host: '127.0.0.1', port: 1 })).body;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ECONNREFUSED/);

  assert.equal((await post(base, '/api/test-connection', { host: 'not a host', port })).status, 400);
  assert.equal((await post(base, '/api/test-connection', { host: '127.0.0.1', port: 0 })).status, 400);

  // Nothing was saved by testing.
  assert.equal((await (await fetch(`${base}/api/vehicles`)).json()).length, 0);

  // Once a vehicle is using the adapter, the test must not open a second socket to it.
  const v = (await post(base, '/api/vehicles', { name: 'Car', host: '127.0.0.1', port })).body;
  await post(base, `/api/vehicles/${v.id}/connect`, {});
  const inUse = (await post(base, '/api/test-connection', { host: '127.0.0.1', port })).body;
  assert.equal(inUse.inUse, true);
  assert.equal(inUse.vehicle, 'Car');
});
