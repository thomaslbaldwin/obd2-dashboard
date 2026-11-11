'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const obd = require('../server/obd');

test('decodes common mode 01 PIDs (spaces, echo noise, prompt)', () => {
  assert.equal(obd.decodePid('0C', '41 0C 1A F8\r\r>'), 1726);
  assert.equal(obd.decodePid('0D', '410D3C'), 60);
  assert.equal(obd.decodePid('05', 'SEARCHING...\r41 05 7B'), 83);
  assert.equal(obd.decodePid('42', '4142 37 A0'), 14.24);
  assert.equal(obd.decodePid('11', '4111FF'), 100);
  assert.equal(obd.decodePid('06', '410680'), 0);
});

test('takes the first ECU when several respond', () => {
  assert.equal(obd.decodePid('0D', '410D28\r410D28'), 40);
});

test('raises ObdError for adapter error replies', () => {
  assert.throws(() => obd.decodePid('0C', 'NO DATA'), /NO DATA/);
  assert.throws(() => obd.decodePid('0C', 'UNABLE TO CONNECT'), /UNABLE TO CONNECT/);
  assert.throws(() => obd.decodePid('0C', '?'), obd.ObdError);
  assert.throws(() => obd.decodePid('0C', ''), /NO RESPONSE/);
});

test('decodes supported-PID bitmaps', () => {
  // BE 1F A8 13 is the classic example bitmap
  const pids = obd.decodeSupportedPids('41 00 BE 1F A8 13', '00');
  assert.deepEqual(pids, ['01', '03', '04', '05', '06', '07', '0C', '0D', '0E', '0F', '10', '11', '13', '15', '1C', '1F', '20']);
  assert.deepEqual(obd.decodeSupportedPids('4120 80000001', '20'), ['21', '40']);
});

test('decodes monitor status (MIL + count)', () => {
  assert.deepEqual(obd.decodeMonitorStatus('41 01 83 07 E5 00'), { milOn: true, dtcCount: 3 });
  assert.deepEqual(obd.decodeMonitorStatus('4101000765 00'), { milOn: false, dtcCount: 0 });
});

test('decodes DTC letters and digits', () => {
  assert.equal(obd.decodeDtc('0133'), 'P0133');
  assert.equal(obd.decodeDtc('0420'), 'P0420');
  assert.equal(obd.decodeDtc('4123'), 'C0123');
  assert.equal(obd.decodeDtc('9234'), 'B1234');
  assert.equal(obd.decodeDtc('C100'), 'U0100');
  assert.equal(obd.decodeDtc('1300'), 'P1300');
});

test('parses CAN mode 03 replies (count byte)', () => {
  assert.deepEqual(obd.parseDtcs('43 02 01 71 04 20', '43', 'A6'), ['P0171', 'P0420']);
  assert.deepEqual(obd.parseDtcs('4300', '43', '6'), []);
});

test('parses multi-frame CAN mode 03 replies', () => {
  const raw = '00A\r0:43040171042003\r1:00030100000000';
  assert.deepEqual(obd.parseDtcs(raw, '43', '6'), ['P0171', 'P0420', 'P0300', 'P0301']);
});

test('parses legacy (non-CAN) mode 03 replies', () => {
  assert.deepEqual(obd.parseDtcs('43 01 71 04 20 00 00\r43 03 00 00 00 00 00', '43', '3'), ['P0171', 'P0420', 'P0300']);
});

test('NO DATA from mode 03 means no codes', () => {
  assert.deepEqual(obd.parseDtcs('NO DATA', '43', '6'), []);
});

test('parses VIN from CAN multi-frame', () => {
  const raw = '014\r0: 49 02 01 31 47 31\r1: 4A 43 35 34 34 34 52\r2: 37 32 35 32 33 36 37';
  assert.equal(obd.parseVin(raw), '1G1JC5444R7252367');
});

test('parses VIN from legacy line-per-frame replies', () => {
  const vin = 'WVWZZZ1KZAW000001';
  const bytes = [0, 0, 0, ...[...vin].map((c) => c.charCodeAt(0))];
  const lines = [];
  for (let i = 0, seq = 1; i < bytes.length; i += 4, seq++) {
    lines.push('4902' + [seq, ...bytes.slice(i, i + 4)].map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  assert.equal(obd.parseVin(lines.join('\r')), vin);
});

test('parses ATRV voltage and protocol names', () => {
  assert.equal(obd.parseVoltage('12.6V'), 12.6);
  assert.equal(obd.parseVoltage('?'), null);
  assert.equal(obd.protocolName('A6'), 'ISO 15765-4 CAN (11 bit, 500 kbaud)');
  assert.equal(obd.protocolName('3'), 'ISO 9141-2');
  assert.equal(obd.isCanProtocol('A7'), true);
  assert.equal(obd.isCanProtocol('A'), true);
  assert.equal(obd.isCanProtocol('3'), false);
});
