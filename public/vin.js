// Offline VIN decoding: model year and make only.
//
// A VIN does not spell out the model. The model is encoded in manufacturer-specific
// positions 4–8, which need a per-manufacturer database to read, so it is left to the user.

// Position 10: model-year code, a 30-year cycle (no I, O, Q, U, Z or 0).
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

// World Manufacturer Identifier (positions 1–3) for common makes. Only prefixes that map
// to a single make are listed; prefixes shared between brands are left out on purpose.
const WMI = {
  Acura: ['JH4', '19U', '2HN', '5J8'],
  Audi: ['WAU', 'WA1', 'TRU'],
  BMW: ['WBA', 'WBS', 'WBY', '5UX', '4US'],
  Buick: ['1G4', '2G4', 'KL4'],
  Cadillac: ['1G6', '1GY', '3GY'],
  Chevrolet: ['1G1', '1GC', '1GN', '2G1', '2GN', '3G1', '3GC', '3GN', 'KL7', 'KL8'],
  'Citroën': ['VF7'],
  Dodge: ['1B3', '2B3', '1D7', '3D7'],
  Fiat: ['ZFA'],
  Ford: ['1FA', '1FB', '1FC', '1FD', '1FM', '1FT', '1ZV', '2FA', '2FM', '2FT', '3FA', '3FT'],
  GMC: ['1GT', '1GK', '2GT', '2GK', '3GT', '3GK'],
  Honda: ['1HG', '2HG', '2HK', 'JHM', '5FN', '5J6', '19X', 'SHH'],
  Hyundai: ['KMH', 'KM8', '5NP', '5NM'],
  Infiniti: ['JNK', '5N3'],
  Jaguar: ['SAJ'],
  Jeep: ['1J4', '1J8'],
  Kia: ['KNA', 'KND', '5XX'],
  'Land Rover': ['SAL'],
  Lexus: ['JTH', 'JTJ', '2T2'],
  Lincoln: ['1LN', '2LM', '3LN', '5LM'],
  Mazda: ['JM1', 'JM3', '1YV'],
  'Mercedes-Benz': ['WDB', 'WDC', 'WDD', 'W1K', 'W1N', '4JG', '55S'],
  Mercury: ['1ME', '2ME', '4M2'],
  MINI: ['WMW'],
  Mitsubishi: ['JA3', 'JA4', '4A3', '4A4', 'ML3'],
  Nissan: ['1N4', '1N6', '3N1', '3N6', '5N1', 'JN1', 'JN8'],
  Oldsmobile: ['1G3'],
  'Opel/Vauxhall': ['W0L'],
  Peugeot: ['VF3'],
  Pontiac: ['1G2', '2G2', '5Y2'],
  Porsche: ['WP0', 'WP1'],
  Ram: ['1C6', '3C6', '3C7'],
  Renault: ['VF1'],
  Saturn: ['1G8', '5GZ'],
  SEAT: ['VSS'],
  'Škoda': ['TMB'],
  Smart: ['WME'],
  Subaru: ['JF1', 'JF2', '4S3', '4S4'],
  Tesla: ['5YJ', '7SA'],
  Toyota: ['JTD', 'JTE', 'JTM', 'JTN', 'JT2', 'JT3', '2T1', '2T3', '4T1', '4T3', '5TD', '5TF', '5YF'],
  Volkswagen: ['WVW', 'WVG', 'WV1', 'WV2', '1VW', '3VW'],
  Volvo: ['YV1', 'YV4'],
};
const MAKE_BY_WMI = Object.fromEntries(Object.entries(WMI).flatMap(([make, list]) => list.map((w) => [w, make])));

/**
 * Model year from position 10. The code repeats every 30 years; position 7 tells the two
 * cycles apart on North American cars (letter = 2010 onwards). OBD2 starts in 1996, so
 * anything that would land before then is taken from the later cycle.
 */
function decodeYear(vin, thisYear) {
  const i = YEAR_CODES.indexOf(vin[9]);
  if (i < 0) return null;
  const early = 1980 + i;
  const late = early + 30;
  const plausible = (y) => y >= 1996 && y <= thisYear + 1;
  const preferred = /[A-Z]/.test(vin[6]) ? late : early;
  const other = preferred === late ? early : late;
  if (plausible(preferred)) return preferred;
  if (plausible(other)) return other;
  return null;
}

/** @returns {{year: number|null, make: string|null}|null} null if the VIN is not well formed */
export function decodeVin(vin, thisYear = new Date().getFullYear()) {
  const v = String(vin || '').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return null;
  return { year: decodeYear(v, thisYear), make: MAKE_BY_WMI[v.slice(0, 3)] || null };
}
