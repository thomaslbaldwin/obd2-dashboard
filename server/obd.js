'use strict';

/**
 * OBD-II protocol helpers: PID definitions, response parsing, DTC and VIN decoding.
 * Everything here is pure (no I/O) so it can be unit-tested in isolation.
 */

// ---------------------------------------------------------------------------
// Mode 01 PID definitions
// tier: 1 = polled every cycle (fast-changing), 2 = every few cycles, 3 = slow
// ---------------------------------------------------------------------------
const PIDS = {
  '04': { key: 'engineLoad', name: 'Engine load', unit: '%', bytes: 1, tier: 1, min: 0, max: 100,
    decode: ([a]) => (a * 100) / 255 },
  '05': { key: 'coolantTemp', name: 'Coolant temp', unit: '°C', bytes: 1, tier: 2, min: -40, max: 215,
    decode: ([a]) => a - 40 },
  '06': { key: 'stftB1', name: 'Short-term fuel trim B1', unit: '%', bytes: 1, tier: 2, min: -100, max: 99.2,
    decode: ([a]) => ((a - 128) * 100) / 128 },
  '07': { key: 'ltftB1', name: 'Long-term fuel trim B1', unit: '%', bytes: 1, tier: 3, min: -100, max: 99.2,
    decode: ([a]) => ((a - 128) * 100) / 128 },
  '0A': { key: 'fuelPressure', name: 'Fuel pressure', unit: 'kPa', bytes: 1, tier: 3, min: 0, max: 765,
    decode: ([a]) => a * 3 },
  '0B': { key: 'map', name: 'Intake manifold pressure', unit: 'kPa', bytes: 1, tier: 1, min: 0, max: 255,
    decode: ([a]) => a },
  '0C': { key: 'rpm', name: 'Engine speed', unit: 'rpm', bytes: 2, tier: 1, min: 0, max: 8000,
    decode: ([a, b]) => (256 * a + b) / 4 },
  '0D': { key: 'speed', name: 'Vehicle speed', unit: 'km/h', bytes: 1, tier: 1, min: 0, max: 255,
    decode: ([a]) => a },
  '0E': { key: 'timingAdvance', name: 'Timing advance', unit: '°', bytes: 1, tier: 2, min: -64, max: 63.5,
    decode: ([a]) => a / 2 - 64 },
  '0F': { key: 'intakeTemp', name: 'Intake air temp', unit: '°C', bytes: 1, tier: 3, min: -40, max: 215,
    decode: ([a]) => a - 40 },
  '10': { key: 'maf', name: 'Mass air flow', unit: 'g/s', bytes: 2, tier: 1, min: 0, max: 655.35,
    decode: ([a, b]) => (256 * a + b) / 100 },
  '11': { key: 'throttle', name: 'Throttle position', unit: '%', bytes: 1, tier: 1, min: 0, max: 100,
    decode: ([a]) => (a * 100) / 255 },
  '1F': { key: 'runTime', name: 'Run time since start', unit: 's', bytes: 2, tier: 3, min: 0, max: 65535,
    decode: ([a, b]) => 256 * a + b },
  '21': { key: 'distanceWithMil', name: 'Distance with MIL on', unit: 'km', bytes: 2, tier: 3, min: 0, max: 65535,
    decode: ([a, b]) => 256 * a + b },
  '2F': { key: 'fuelLevel', name: 'Fuel level', unit: '%', bytes: 1, tier: 3, min: 0, max: 100,
    decode: ([a]) => (a * 100) / 255 },
  '31': { key: 'distanceSinceClear', name: 'Distance since codes cleared', unit: 'km', bytes: 2, tier: 3, min: 0, max: 65535,
    decode: ([a, b]) => 256 * a + b },
  '33': { key: 'baroPressure', name: 'Barometric pressure', unit: 'kPa', bytes: 1, tier: 3, min: 0, max: 255,
    decode: ([a]) => a },
  '42': { key: 'moduleVoltage', name: 'Control module voltage', unit: 'V', bytes: 2, tier: 3, min: 0, max: 65.535,
    decode: ([a, b]) => (256 * a + b) / 1000 },
  '46': { key: 'ambientTemp', name: 'Ambient air temp', unit: '°C', bytes: 1, tier: 3, min: -40, max: 215,
    decode: ([a]) => a - 40 },
  '5C': { key: 'oilTemp', name: 'Engine oil temp', unit: '°C', bytes: 1, tier: 3, min: -40, max: 210,
    decode: ([a]) => a - 40 },
  '5E': { key: 'fuelRate', name: 'Engine fuel rate', unit: 'L/h', bytes: 2, tier: 2, min: 0, max: 3276.75,
    decode: ([a, b]) => (256 * a + b) / 20 },
};

/** Default PID set used when the vehicle doesn't report its supported PIDs. */
const DEFAULT_PIDS = ['04', '05', '0B', '0C', '0D', '0F', '10', '11', '2F', '42'];

// ---------------------------------------------------------------------------
// Low-level response cleaning
// ---------------------------------------------------------------------------

// Matched against space-stripped lines, so patterns allow optional whitespace.
const ERROR_PATTERNS = [
  [/NO\s*DATA/, 'NO DATA'],
  [/UNABLE\s*TO\s*CONNECT/, 'UNABLE TO CONNECT'],
  [/CAN\s*ERROR/, 'CAN ERROR'],
  [/BUS\s*ERROR/, 'BUS ERROR'],
  [/BUS\s*BUSY/, 'BUS BUSY'],
  [/FB\s*ERROR/, 'FB ERROR'],
  [/DATA\s*ERROR/, 'DATA ERROR'],
  [/BUFFER\s*FULL/, 'BUFFER FULL'],
  [/STOPPED/, 'STOPPED'],
  [/ERR\d+/, null],
  [/^\?$/, 'UNKNOWN COMMAND'],
  [/LV\s*RESET/, 'LV RESET'],
];

class ObdError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ObdError';
    this.code = code || message;
  }
}

/**
 * Split a raw ELM327 reply into meaningful lines, removing echo/status noise.
 * Returns an array of upper-case, space-free strings.
 */
function cleanLines(raw) {
  return String(raw)
    .replace(/\0/g, '')
    .replace(/>/g, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length > 0)
    .filter((l) => !/^SEARCHING/.test(l))
    .filter((l) => !/^BUS INIT/.test(l))
    .map((l) => l.replace(/\s+/g, ''));
}

/** Throw an ObdError if the reply is an ELM327 error string. */
function assertNoError(lines) {
  if (lines.length === 0) throw new ObdError('NO RESPONSE');
  for (const line of lines) {
    for (const [pat, name] of ERROR_PATTERNS) {
      const m = pat.exec(line);
      if (m) throw new ObdError(name || m[0]);
    }
  }
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.substr(i, 2), 16);
    if (Number.isNaN(b)) break;
    out.push(b);
  }
  return out;
}

/**
 * Group lines into logical messages. Handles ISO 15765 (CAN) multi-frame
 * replies formatted by the ELM327 as:
 *   014
 *   0:490201314731
 *   1:4A433534343452
 * Single-frame replies are returned one message per line.
 */
function groupMessages(lines) {
  const messages = [];
  let current = null;
  for (const line of lines) {
    const m = /^([0-9A-F]):(.*)$/.exec(line);
    if (m) {
      if (m[1] === '0' || current === null) {
        current = '';
        messages.push(current);
      }
      current += m[2];
      messages[messages.length - 1] = current;
    } else if (/^[0-9A-F]{3}$/.test(line)) {
      // Byte-count header of a multi-frame message; the next "0:" starts it.
      current = null;
    } else {
      current = null;
      messages.push(line);
    }
  }
  return messages.filter((m) => /^[0-9A-F]+$/.test(m));
}

// ---------------------------------------------------------------------------
// Mode 01
// ---------------------------------------------------------------------------

/**
 * Parse a mode 01 reply for a given PID. Returns the data bytes (array) from
 * the first ECU that answered.
 */
function parseMode01(raw, pid) {
  const lines = cleanLines(raw);
  assertNoError(lines);
  const prefix = '41' + pid.toUpperCase();
  for (const msg of groupMessages(lines)) {
    const idx = msg.indexOf(prefix);
    if (idx !== -1) return hexToBytes(msg.slice(idx + prefix.length));
  }
  throw new ObdError('UNEXPECTED RESPONSE: ' + lines.join(' '));
}

/** Decode a mode 01 PID reply to a number using the PID table. */
function decodePid(pid, raw) {
  const def = PIDS[pid.toUpperCase()];
  if (!def) throw new Error('Unknown PID ' + pid);
  const bytes = parseMode01(raw, pid);
  if (bytes.length < def.bytes) throw new ObdError('SHORT RESPONSE');
  const value = def.decode(bytes);
  return Math.round(value * 100) / 100;
}

/**
 * Decode a "supported PIDs" bitmap reply (PID 00/20/40/...). Returns the list
 * of supported PID hex strings, e.g. ['01','04','05',...].
 */
function decodeSupportedPids(raw, basePid) {
  const base = parseInt(basePid, 16);
  const lines = cleanLines(raw);
  assertNoError(lines);
  const prefix = '41' + basePid.toUpperCase();
  const supported = new Set();
  // Several ECUs may answer; union their bitmaps.
  for (const msg of groupMessages(lines)) {
    const idx = msg.indexOf(prefix);
    if (idx === -1) continue;
    const bytes = hexToBytes(msg.slice(idx + prefix.length)).slice(0, 4);
    bytes.forEach((byte, i) => {
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (0x80 >> bit)) {
          const pid = base + i * 8 + bit + 1;
          supported.add(pid.toString(16).toUpperCase().padStart(2, '0'));
        }
      }
    });
  }
  if (supported.size === 0) throw new ObdError('UNEXPECTED RESPONSE: ' + lines.join(' '));
  return [...supported].sort();
}

/** Decode PID 01 (monitor status): MIL lamp state + stored DTC count. */
function decodeMonitorStatus(raw) {
  const bytes = parseMode01(raw, '01');
  return { milOn: (bytes[0] & 0x80) !== 0, dtcCount: bytes[0] & 0x7f };
}

// ---------------------------------------------------------------------------
// DTCs (modes 03 / 07 / 0A)
// ---------------------------------------------------------------------------

const DTC_LETTERS = ['P', 'C', 'B', 'U'];

function decodeDtc(hex4) {
  const a = parseInt(hex4.slice(0, 2), 16);
  const letter = DTC_LETTERS[(a & 0xc0) >> 6];
  const digit = (a & 0x30) >> 4;
  return letter + digit + hex4[1] + hex4.slice(2, 4);
}

function isCanProtocol(protocol) {
  if (!protocol) return false;
  let p = String(protocol).trim().toUpperCase();
  if (p.length === 2 && p[0] === 'A') p = p[1]; // "A6" = automatic, currently 6
  return ['6', '7', '8', '9', 'A', 'B', 'C'].includes(p);
}

/**
 * Parse a DTC reply. responseMode is '43' (stored), '47' (pending) or '4A' (permanent).
 * On CAN the byte after the mode is a DTC count; on older protocols codes follow directly.
 */
function parseDtcs(raw, responseMode = '43', protocol = null) {
  const lines = cleanLines(raw);
  if (lines.some((l) => /NO\s*DATA/.test(l))) return [];
  assertNoError(lines);
  const can = isCanProtocol(protocol);
  const codes = new Set();
  for (const msg of groupMessages(lines)) {
    const idx = msg.indexOf(responseMode);
    if (idx === -1) continue;
    let payload = msg.slice(idx + 2);
    let limit = Infinity;
    if (can) {
      limit = parseInt(payload.slice(0, 2), 16);
      payload = payload.slice(2);
    }
    let n = 0;
    for (let i = 0; i + 4 <= payload.length && n < limit; i += 4) {
      const chunk = payload.slice(i, i + 4);
      if (chunk === '0000') continue;
      codes.add(decodeDtc(chunk));
      n++;
    }
  }
  return [...codes];
}

// ---------------------------------------------------------------------------
// VIN (mode 09 PID 02)
// ---------------------------------------------------------------------------

function parseVin(raw) {
  const lines = cleanLines(raw);
  assertNoError(lines);
  // CAN: one reassembled message "49 02 01 <17 bytes>".
  // Legacy protocols: one line per frame, "49 02 <seq> <4 bytes>".
  // Either way, skip the 3-byte header of each message and concatenate.
  let hex = '';
  for (const msg of groupMessages(lines)) {
    const idx = msg.indexOf('4902');
    if (idx !== -1) hex += msg.slice(idx + 6);
  }
  const text = hexToBytes(hex)
    .map((b) => String.fromCharCode(b))
    .join('')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
  if (text.length < 17) throw new ObdError('INVALID VIN');
  return text.slice(-17);
}

/** Parse ATRV output, e.g. "12.6V". */
function parseVoltage(raw) {
  const m = /(\d+(?:\.\d+)?)\s*V/i.exec(String(raw));
  return m ? parseFloat(m[1]) : null;
}

const PROTOCOL_NAMES = {
  '0': 'Automatic',
  '1': 'SAE J1850 PWM',
  '2': 'SAE J1850 VPW',
  '3': 'ISO 9141-2',
  '4': 'ISO 14230-4 KWP (5 baud init)',
  '5': 'ISO 14230-4 KWP (fast init)',
  '6': 'ISO 15765-4 CAN (11 bit, 500 kbaud)',
  '7': 'ISO 15765-4 CAN (29 bit, 500 kbaud)',
  '8': 'ISO 15765-4 CAN (11 bit, 250 kbaud)',
  '9': 'ISO 15765-4 CAN (29 bit, 250 kbaud)',
  'A': 'SAE J1939 CAN',
  'B': 'USER1 CAN',
  'C': 'USER2 CAN',
};

function protocolName(dpn) {
  if (!dpn) return null;
  const p = String(dpn).trim().toUpperCase().replace(/^A(?=.)/, '');
  return PROTOCOL_NAMES[p] || `Protocol ${p}`;
}

module.exports = {
  PIDS,
  DEFAULT_PIDS,
  ObdError,
  cleanLines,
  assertNoError,
  hexToBytes,
  groupMessages,
  parseMode01,
  decodePid,
  decodeSupportedPids,
  decodeMonitorStatus,
  decodeDtc,
  parseDtcs,
  parseVin,
  parseVoltage,
  isCanProtocol,
  protocolName,
};
