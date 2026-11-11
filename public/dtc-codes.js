// Descriptions for common generic (SAE J2012) diagnostic trouble codes.
// Manufacturer-specific codes (P1xxx, P3xxx, etc.) fall back to a category description.
export const DTC_DESCRIPTIONS = {
  P0010: 'Camshaft position actuator circuit (Bank 1)',
  P0011: 'Camshaft timing over-advanced (Bank 1)',
  P0012: 'Camshaft timing over-retarded (Bank 1)',
  P0016: 'Crankshaft/camshaft position correlation (Bank 1 Sensor A)',
  P0030: 'HO2S heater control circuit (Bank 1 Sensor 1)',
  P0087: 'Fuel rail/system pressure too low',
  P0100: 'Mass air flow circuit malfunction',
  P0101: 'Mass air flow circuit range/performance',
  P0102: 'Mass air flow circuit low input',
  P0103: 'Mass air flow circuit high input',
  P0106: 'MAP/barometric pressure circuit range/performance',
  P0107: 'MAP/barometric pressure circuit low input',
  P0108: 'MAP/barometric pressure circuit high input',
  P0110: 'Intake air temperature circuit malfunction',
  P0113: 'Intake air temperature circuit high input',
  P0115: 'Engine coolant temperature circuit malfunction',
  P0116: 'Engine coolant temperature circuit range/performance',
  P0117: 'Engine coolant temperature circuit low input',
  P0118: 'Engine coolant temperature circuit high input',
  P0120: 'Throttle position sensor A circuit malfunction',
  P0121: 'Throttle position sensor A range/performance',
  P0122: 'Throttle position sensor A circuit low input',
  P0123: 'Throttle position sensor A circuit high input',
  P0125: 'Insufficient coolant temperature for closed-loop fuel control',
  P0128: 'Coolant thermostat (coolant temp below thermostat regulating temperature)',
  P0130: 'O2 sensor circuit malfunction (Bank 1 Sensor 1)',
  P0131: 'O2 sensor circuit low voltage (Bank 1 Sensor 1)',
  P0132: 'O2 sensor circuit high voltage (Bank 1 Sensor 1)',
  P0133: 'O2 sensor circuit slow response (Bank 1 Sensor 1)',
  P0134: 'O2 sensor circuit no activity detected (Bank 1 Sensor 1)',
  P0135: 'O2 sensor heater circuit malfunction (Bank 1 Sensor 1)',
  P0136: 'O2 sensor circuit malfunction (Bank 1 Sensor 2)',
  P0137: 'O2 sensor circuit low voltage (Bank 1 Sensor 2)',
  P0138: 'O2 sensor circuit high voltage (Bank 1 Sensor 2)',
  P0141: 'O2 sensor heater circuit malfunction (Bank 1 Sensor 2)',
  P0171: 'System too lean (Bank 1)',
  P0172: 'System too rich (Bank 1)',
  P0174: 'System too lean (Bank 2)',
  P0175: 'System too rich (Bank 2)',
  P0190: 'Fuel rail pressure sensor circuit malfunction',
  P0201: 'Injector circuit malfunction – cylinder 1',
  P0202: 'Injector circuit malfunction – cylinder 2',
  P0203: 'Injector circuit malfunction – cylinder 3',
  P0204: 'Injector circuit malfunction – cylinder 4',
  P0217: 'Engine overheat condition',
  P0219: 'Engine overspeed condition',
  P0230: 'Fuel pump primary circuit malfunction',
  P0234: 'Turbo/supercharger overboost condition',
  P0299: 'Turbo/supercharger underboost',
  P0300: 'Random/multiple cylinder misfire detected',
  P0301: 'Cylinder 1 misfire detected',
  P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected',
  P0304: 'Cylinder 4 misfire detected',
  P0305: 'Cylinder 5 misfire detected',
  P0306: 'Cylinder 6 misfire detected',
  P0307: 'Cylinder 7 misfire detected',
  P0308: 'Cylinder 8 misfire detected',
  P0325: 'Knock sensor 1 circuit malfunction (Bank 1)',
  P0335: 'Crankshaft position sensor A circuit malfunction',
  P0340: 'Camshaft position sensor circuit malfunction',
  P0400: 'Exhaust gas recirculation flow malfunction',
  P0401: 'Exhaust gas recirculation flow insufficient',
  P0402: 'Exhaust gas recirculation flow excessive',
  P0410: 'Secondary air injection system malfunction',
  P0420: 'Catalyst system efficiency below threshold (Bank 1)',
  P0430: 'Catalyst system efficiency below threshold (Bank 2)',
  P0440: 'Evaporative emission control system malfunction',
  P0441: 'Evaporative emission control system incorrect purge flow',
  P0442: 'EVAP system leak detected (small leak)',
  P0446: 'EVAP system vent control circuit malfunction',
  P0449: 'EVAP system vent valve/solenoid circuit malfunction',
  P0455: 'EVAP system leak detected (large leak)',
  P0456: 'EVAP system leak detected (very small leak)',
  P0457: 'EVAP system leak detected (fuel cap loose/off)',
  P0500: 'Vehicle speed sensor malfunction',
  P0505: 'Idle control system malfunction',
  P0506: 'Idle control system RPM lower than expected',
  P0507: 'Idle control system RPM higher than expected',
  P0520: 'Engine oil pressure sensor/switch circuit malfunction',
  P0562: 'System voltage low',
  P0563: 'System voltage high',
  P0600: 'Serial communication link malfunction',
  P0601: 'Internal control module memory checksum error',
  P0606: 'Control module processor fault',
  P0700: 'Transmission control system malfunction',
  P0705: 'Transmission range sensor circuit malfunction',
  P0715: 'Input/turbine speed sensor circuit malfunction',
  P0720: 'Output speed sensor circuit malfunction',
  P0730: 'Incorrect gear ratio',
  P0740: 'Torque converter clutch circuit malfunction',
  P0750: 'Shift solenoid A malfunction',
  U0100: 'Lost communication with ECM/PCM',
  U0101: 'Lost communication with TCM',
  U0121: 'Lost communication with ABS control module',
  U0140: 'Lost communication with body control module',
  U0155: 'Lost communication with instrument panel cluster',
};

const SYSTEMS = { P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network' };

export function describeDtc(code) {
  if (DTC_DESCRIPTIONS[code]) return DTC_DESCRIPTIONS[code];
  const system = SYSTEMS[code[0]] || 'Unknown system';
  const generic = code[1] === '0' || code[1] === '2';
  return `${system} — ${generic ? 'generic' : 'manufacturer-specific'} code (look up for your make)`;
}

export function dtcSystem(code) {
  return SYSTEMS[code[0]] || 'Unknown';
}

// General guidance for generic codes: how urgent it usually is and where to look first.
// First matching rule wins. Causes vary by make and model, so this is a starting point only.
// severity: 'stop' = don't keep driving, 'soon' = get it looked at, 'ok' = usually fine to drive.
const GUIDANCE = [
  [/^P0217$/, 'stop', 'The engine reported overheating. Let it cool, then check coolant level, the radiator fan and for leaks before driving.'],
  [/^P0520$/, 'stop', 'Check the oil level and the oil warning light before driving. Often the pressure sensor or its wiring, but real low oil pressure destroys an engine.'],
  [/^P0219$/, 'soon', 'The engine was revved past its limit, usually from a missed downshift. Have it checked if it now runs rough.'],
  [/^P030\d$/, 'soon', 'Often spark plugs, ignition coils, a vacuum leak or an injector. If the check engine light flashes or the engine shakes, stop: raw fuel can ruin the catalytic converter.'],
  [/^P001[0-6]$/, 'soon', 'Often low or dirty engine oil, a sticking variable valve timing solenoid, or a stretched timing chain.'],
  [/^P0087$/, 'soon', 'Often a weak fuel pump, a clogged fuel filter or a faulty pressure regulator.'],
  [/^P010[0-3]$/, 'soon', 'Often a dirty or failed mass air flow sensor, an intake air leak, or its wiring.'],
  [/^P010[6-8]$/, 'soon', 'Often the MAP sensor, a cracked vacuum hose or its wiring.'],
  [/^P011[03]$/, 'ok', 'Often the intake air temperature sensor or its connector.'],
  [/^P011[5-8]$/, 'soon', 'Often the coolant temperature sensor or its wiring. The gauge and fan control may be unreliable, so watch for overheating.'],
  [/^P012[0-3]$/, 'soon', 'Often the throttle position sensor, a dirty throttle body or its wiring. The car may limit power.'],
  [/^P012[58]$/, 'ok', 'Usually a thermostat stuck open, so the engine warms up slowly. Expect a weak heater and higher fuel use.'],
  [/^(P0030|P013\d|P014[01])$/, 'ok', 'Often an ageing oxygen sensor, its heater circuit, or an exhaust leak near it. Fuel economy may drop.'],
  [/^P017[14]$/, 'soon', 'Too much air or too little fuel: often a vacuum leak, a dirty mass air flow sensor or low fuel pressure.'],
  [/^P017[25]$/, 'soon', 'Too much fuel: often a leaking injector, high fuel pressure or a faulty mass air flow or oxygen sensor.'],
  [/^P0190$/, 'soon', 'Often the fuel rail pressure sensor or its wiring.'],
  [/^P020\d$/, 'soon', 'Often the injector itself, its connector or wiring. Expect a misfire on that cylinder.'],
  [/^P0230$/, 'soon', 'Often the fuel pump relay, fuse or wiring. The engine may fail to start.'],
  [/^P0234$/, 'soon', 'Often a sticking wastegate or boost control solenoid. Avoid hard acceleration until fixed.'],
  [/^P0299$/, 'soon', 'Often a boost leak in an intake hose, a sticking wastegate or a worn turbocharger.'],
  [/^P0325$/, 'soon', 'Often the knock sensor or its wiring. The engine may run with reduced power to protect itself.'],
  [/^P03(35|40)$/, 'soon', 'Often the position sensor or its wiring. The engine may stall or fail to start.'],
  [/^P040[0-2]$/, 'ok', 'Often a clogged or sticking EGR valve or blocked EGR passages.'],
  [/^P0410$/, 'ok', 'Often the secondary air pump, its relay or a check valve.'],
  [/^P04[23]0$/, 'ok', 'Often a worn catalytic converter; sometimes an oxygen sensor or exhaust leak. The car will fail an emissions test.'],
  [/^P04(4\d|5\d)$/, 'ok', 'Check that the fuel cap is tight and its seal is intact. Otherwise often a cracked hose or a purge or vent valve.'],
  [/^P0500$/, 'soon', 'Often the vehicle speed sensor or its wiring. The speedometer, ABS or gear shifts may be affected.'],
  [/^P050[5-7]$/, 'ok', 'Often a dirty throttle body, a faulty idle air control valve or a vacuum leak.'],
  [/^P056[23]$/, 'soon', 'Often a weak battery, a failing alternator or a poor ground. The car may not restart.'],
  [/^P060[016]$/, 'soon', 'An internal fault in the engine computer. Check battery voltage and grounds first; it may need reprogramming or replacing.'],
  [/^P07\d\d$/, 'soon', 'A transmission fault. Check the transmission fluid level and condition; avoid towing or hard driving until diagnosed.'],
  [/^U01\d\d$/, 'soon', 'A control module stopped responding. Often a weak battery, a blown fuse, or a wiring or connector fault.'],
];

export const SEVERITY_LABEL = {
  stop: 'Stop driving',
  soon: 'Service soon',
  ok: 'Usually safe to drive',
  unknown: 'Look up before driving far',
};

/** @returns {{severity: 'stop'|'soon'|'ok'|'unknown', cause: string|null}} */
export function dtcGuidance(code) {
  for (const [pattern, severity, cause] of GUIDANCE) {
    if (pattern.test(code)) return { severity, cause };
  }
  return { severity: 'unknown', cause: null };
}
