'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// public/vin.js is a browser ES module; load it here without needing ESM support in the runner.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'vin.js'), 'utf8').replace(/^export /gm, '');
const { decodeVin } = new Function(`${source}\nreturn { decodeVin };`)();

test('decodes make and model year', () => {
  assert.deepEqual(decodeVin('1FTFW1ET5DFC10312', 2026), { year: 2013, make: 'Ford' });
  assert.deepEqual(decodeVin('JTDBR32E720045671', 2026), { year: 2002, make: 'Toyota' });
  assert.deepEqual(decodeVin('1hgcm82633a004352', 2026), { year: 2003, make: 'Honda' });
});

test('picks the 30-year cycle that makes sense', () => {
  // Position 10 "A" is 1980 or 2010; a digit in position 7 would mean 1980, which predates OBD2.
  assert.equal(decodeVin('1G1ZT5180AF000000', 2026).year, 2010);
  // Position 10 "T" with a letter in position 7 would mean 2026.
  assert.equal(decodeVin('5YJ3E1EA5TF000001', 2026).year, 2026);
  // ...which is not plausible yet in 2020, so it falls back to 1996.
  assert.equal(decodeVin('5YJ3E1EA5TF000001', 2020).year, 1996);
});

test('returns nulls for unknown makes and null for malformed VINs', () => {
  assert.deepEqual(decodeVin('ZZZBR32E720045671', 2026), { year: 2002, make: null });
  assert.equal(decodeVin('TOO-SHORT'), null);
  assert.equal(decodeVin('1FTFW1ET5DFC1031O'), null); // contains the letter O
  assert.equal(decodeVin(null), null);
});
