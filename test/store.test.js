'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VehicleStore, ValidationError } = require('../server/store');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obd-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new VehicleStore(path.join(dir, 'vehicles.json'));
}

test('redline is optional, stored as an integer and can be cleared', (t) => {
  const store = tempStore(t);
  const base = { name: 'Truck', host: '192.168.0.10', port: 35000 };

  assert.equal(store.create(base).redline, undefined);

  const v = store.create({ ...base, redline: '4500' });
  assert.equal(v.redline, 4500);

  assert.equal(store.update(v.id, { redline: 5200 }).redline, 5200);
  assert.equal(store.update(v.id, { redline: '' }).redline, null);
});

test('redline outside 1,500–12,000 rpm is rejected', (t) => {
  const store = tempStore(t);
  const base = { name: 'Car', host: '192.168.0.10', port: 35000 };
  for (const redline of [900, 20000, 6500.5, 'fast']) {
    assert.throws(() => store.create({ ...base, redline }), ValidationError);
  }
});
