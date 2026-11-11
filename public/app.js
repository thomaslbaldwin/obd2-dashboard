import { Gauge } from './gauge.js';
import { TimeChart } from './chart.js';
import { describeDtc, dtcSystem } from './dtc-codes.js';

// -----------------------------------------------------------------------------
// Metric catalogue (keys match the server's PID table)
// -----------------------------------------------------------------------------
const KIND = {
  speed: { metric: ['km/h', (v) => v], imperial: ['mph', (v) => v * 0.621371] },
  temp: { metric: ['°C', (v) => v], imperial: ['°F', (v) => (v * 9) / 5 + 32] },
  distance: { metric: ['km', (v) => v], imperial: ['mi', (v) => v * 0.621371] },
  pressure: { metric: ['kPa', (v) => v], imperial: ['psi', (v) => v * 0.145038] },
  flow: { metric: ['L/h', (v) => v], imperial: ['gal/h', (v) => v * 0.264172] },
};

const METRICS = {
  rpm: { label: 'Engine speed', unit: 'rpm', dp: 0 },
  speed: { label: 'Vehicle speed', kind: 'speed', dp: 0 },
  coolantTemp: { label: 'Coolant temp', kind: 'temp', dp: 0, range: [40, 120],
    level: (c) => (c >= 115 ? 'critical' : c >= 105 ? 'warning' : null) },
  oilTemp: { label: 'Oil temp', kind: 'temp', dp: 0, range: [40, 150],
    level: (c) => (c >= 140 ? 'critical' : c >= 125 ? 'warning' : null) },
  intakeTemp: { label: 'Intake air temp', kind: 'temp', dp: 0 },
  ambientTemp: { label: 'Ambient temp', kind: 'temp', dp: 0 },
  engineLoad: { label: 'Engine load', unit: '%', dp: 0, range: [0, 100] },
  throttle: { label: 'Throttle', unit: '%', dp: 0, range: [0, 100] },
  fuelLevel: { label: 'Fuel level', unit: '%', dp: 0, range: [0, 100],
    level: (v) => (v <= 8 ? 'critical' : v <= 15 ? 'warning' : null) },
  batteryVoltage: { label: 'Battery (adapter)', unit: 'V', dp: 1, range: [10, 16],
    level: (v) => (v < 11.5 || v > 15.2 ? 'critical' : v < 12.0 ? 'warning' : null) },
  moduleVoltage: { label: 'ECU voltage', unit: 'V', dp: 2, range: [10, 16],
    level: (v) => (v < 11.5 || v > 15.2 ? 'critical' : v < 12.0 ? 'warning' : null) },
  maf: { label: 'Mass air flow', unit: 'g/s', dp: 1 },
  map: { label: 'Manifold pressure', kind: 'pressure', dp: 1 },
  baroPressure: { label: 'Barometric', kind: 'pressure', dp: 1 },
  fuelPressure: { label: 'Fuel pressure', kind: 'pressure', dp: 0 },
  timingAdvance: { label: 'Timing advance', unit: '°', dp: 1 },
  stftB1: { label: 'Short fuel trim', unit: '%', dp: 1,
    level: (v) => (Math.abs(v) >= 25 ? 'critical' : Math.abs(v) >= 15 ? 'warning' : null) },
  ltftB1: { label: 'Long fuel trim', unit: '%', dp: 1,
    level: (v) => (Math.abs(v) >= 20 ? 'critical' : Math.abs(v) >= 10 ? 'warning' : null) },
  fuelRate: { label: 'Fuel rate', kind: 'flow', dp: 1 },
  runTime: { label: 'Run time', unit: '', dp: 0, format: formatDuration, noChart: true },
  distanceSinceClear: { label: 'Since codes cleared', kind: 'distance', dp: 0, noChart: true },
  distanceWithMil: { label: 'Driven with MIL on', kind: 'distance', dp: 0, noChart: true },
};
const TILE_ORDER = [
  'coolantTemp', 'oilTemp', 'throttle', 'engineLoad', 'batteryVoltage', 'fuelLevel', 'intakeTemp',
  'maf', 'map', 'timingAdvance', 'stftB1', 'ltftB1', 'fuelRate', 'moduleVoltage', 'ambientTemp',
  'baroPressure', 'fuelPressure', 'runTime', 'distanceSinceClear', 'distanceWithMil',
];
const DEFAULT_CHARTS = ['rpm', 'speed', 'coolantTemp', 'throttle'];
const ACTIVE_STATES = ['connecting', 'initializing', 'connected', 'reconnecting'];
const STATE_LABEL = {
  disconnected: 'Disconnected', connecting: 'Connecting…', initializing: 'Initializing…',
  connected: 'Live', reconnecting: 'Reconnecting…', error: 'Error',
};

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const prefs = loadPrefs();
const state = {
  vehicles: [],
  snaps: {}, // vehicleId -> { status, latest, history, dtcs, traffic }
  view: 'fleet',
  vehicleId: null,
};
let gauges = null;
let charts = new Map();
let renderQueued = false;
let editingId = null;
let lastHeaderRender = 0;

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  const p = { units: 'imperial', theme: 'dark', range: 60, charts: DEFAULT_CHARTS };
  try {
    Object.assign(p, JSON.parse(localStorage.getItem('obd-prefs') || '{}'));
  } catch (_) { /* storage unavailable */ }
  return p;
}
function savePrefs() {
  try { localStorage.setItem('obd-prefs', JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

function snap(id) {
  if (!state.snaps[id]) state.snaps[id] = { status: { state: 'disconnected' }, latest: {}, history: [], dtcs: null, traffic: [] };
  return state.snaps[id];
}

// -----------------------------------------------------------------------------
// Units & formatting
// -----------------------------------------------------------------------------
function unitOf(key) {
  const m = METRICS[key];
  return m.kind ? KIND[m.kind][prefs.units][0] : m.unit;
}
function convert(key, v) {
  const m = METRICS[key];
  return m.kind ? KIND[m.kind][prefs.units][1](v) : v;
}
function fmt(key, v) {
  if (v == null || Number.isNaN(v)) return '—';
  const m = METRICS[key];
  if (m.format) return m.format(v);
  return convert(key, v).toLocaleString(undefined, { maximumFractionDigits: m.dp, minimumFractionDigits: m.dp });
}
function formatDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// -----------------------------------------------------------------------------
// Server communication
// -----------------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let ws;
let wsDelay = 500;
function connectSocket() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { wsDelay = 500; $('ws-state').classList.add('ok'); $('ws-state').title = 'Connected to server'; };
  ws.onclose = () => {
    $('ws-state').classList.remove('ok');
    $('ws-state').title = 'Server connection lost — retrying';
    setTimeout(connectSocket, wsDelay);
    wsDelay = Math.min(wsDelay * 2, 8000);
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.vehicles = msg.vehicles;
      state.snaps = {};
      for (const v of msg.vehicles) snap(v.id).status = v.status;
      for (const [id, s] of Object.entries(msg.snapshots)) {
        Object.assign(snap(id), { status: s, latest: s.latest || {}, history: s.history || [], dtcs: s.dtcs, traffic: s.traffic || [] });
      }
      route();
      break;
    case 'vehicles':
      state.vehicles = msg.vehicles;
      for (const v of msg.vehicles) if (!state.snaps[v.id]) snap(v.id).status = v.status;
      if (state.view === 'vehicle' && !state.vehicles.some((v) => v.id === state.vehicleId)) location.hash = '#/';
      renderSidebar();
      if (state.view === 'fleet') renderFleet();
      else renderVehicleHeader();
      break;
    case 'status': {
      const s = snap(msg.vehicleId);
      s.status = msg.status;
      const v = state.vehicles.find((x) => x.id === msg.vehicleId);
      if (v) v.status = msg.status;
      if (msg.status.state !== 'connected') s.stale = true;
      renderSidebar();
      if (state.view === 'fleet') renderFleetLive();
      else if (msg.vehicleId === state.vehicleId) { renderVehicleHeader(); queueRender(); }
      break;
    }
    case 'data': {
      const s = snap(msg.vehicleId);
      s.stale = false;
      Object.assign(s.latest, msg.values);
      s.history.push({ t: msg.t, values: msg.values });
      if (s.history.length > 8000) s.history.splice(0, s.history.length - 8000);
      if (state.view === 'vehicle' && msg.vehicleId === state.vehicleId) {
        for (const [key, chart] of charts) {
          if (msg.values[key] != null) chart.push(msg.t, convert(key, msg.values[key]));
        }
      }
      queueRender();
      break;
    }
    case 'dtcs':
      snap(msg.vehicleId).dtcs = msg.dtcs;
      if (state.view === 'vehicle' && msg.vehicleId === state.vehicleId) renderDtcs();
      if (state.view === 'fleet') queueRender();
      break;
    case 'traffic': {
      const s = snap(msg.vehicleId);
      s.traffic.push(msg.entry);
      if (s.traffic.length > 300) s.traffic.shift();
      if (state.view === 'vehicle' && msg.vehicleId === state.vehicleId) appendTraffic(msg.entry);
      break;
    }
  }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (state.view === 'fleet') renderFleetLive();
    else renderLive();
  });
}

// -----------------------------------------------------------------------------
// Routing
// -----------------------------------------------------------------------------
function route() {
  const m = /^#\/vehicle\/([\w-]+)/.exec(location.hash);
  const vehicle = m && state.vehicles.find((v) => v.id === m[1]);
  $('sidebar').classList.remove('open');
  if (vehicle) {
    state.view = 'vehicle';
    state.vehicleId = vehicle.id;
    $('view-fleet').hidden = true;
    $('view-vehicle').hidden = false;
    openVehicle();
  } else {
    state.view = 'fleet';
    state.vehicleId = null;
    $('view-fleet').hidden = false;
    $('view-vehicle').hidden = true;
    destroyCharts();
    renderFleet();
  }
  renderSidebar();
}

// -----------------------------------------------------------------------------
// Sidebar
// -----------------------------------------------------------------------------
function renderSidebar() {
  $('nav-fleet').classList.toggle('active', state.view === 'fleet');
  $('vehicle-list').innerHTML = state.vehicles.map((v) => {
    const st = snap(v.id).status?.state || 'disconnected';
    return `<li><button data-id="${esc(v.id)}" class="${v.id === state.vehicleId ? 'active' : ''}">
      <span class="v-color" style="background:${esc(v.color || '#2a78d6')}"></span>
      <span class="v-label">${esc(v.name)}<small>${esc(STATE_LABEL[st] || st)}</small></span>
      <span class="dot" data-state="${esc(st)}" aria-hidden="true"></span>
    </button></li>`;
  }).join('');
  document.querySelectorAll('[data-units]').forEach((b) => b.classList.toggle('active', b.dataset.units === prefs.units));
}

// -----------------------------------------------------------------------------
// Fleet view
// -----------------------------------------------------------------------------
const MIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 6h7l2 2h2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1l-2 2H8l-2-2H4v-4H2v-3h2V9h2zm1 2v1H6v6h1l2 2h5l2-2h2v-5h-3l-2-2z"/></svg>';

function renderFleet() {
  const grid = $('fleet-grid');
  $('fleet-empty').hidden = state.vehicles.length > 0;
  grid.innerHTML = state.vehicles.map((v) => {
    const sub = [v.year, v.make, v.model].filter(Boolean).join(' ');
    return `<article class="card fleet-card" data-id="${esc(v.id)}" style="--v-color:${esc(v.color || '#2a78d6')}" tabindex="0">
      <header>
        <div><h2>${esc(v.name)}</h2><p class="muted">${esc(sub || `${v.host}:${v.port}`)}</p></div>
        <span class="status-pill" data-role="status"></span>
      </header>
      <div class="fleet-stats">
        <div><span>Speed</span><b data-k="speed"></b></div>
        <div><span>RPM</span><b data-k="rpm"></b></div>
        <div><span>Coolant</span><b data-k="coolantTemp"></b></div>
      </div>
      <footer>
        <span data-role="foot"></span>
        <button class="btn" data-role="toggle"></button>
      </footer>
    </article>`;
  }).join('');
  renderFleetLive();
}

function renderFleetLive() {
  for (const card of document.querySelectorAll('.fleet-card')) {
    const id = card.dataset.id;
    const s = snap(id);
    const st = s.status?.state || 'disconnected';
    const live = st === 'connected';
    const pill = card.querySelector('[data-role="status"]');
    pill.dataset.state = st;
    pill.textContent = STATE_LABEL[st] || st;
    for (const b of card.querySelectorAll('[data-k]')) {
      const k = b.dataset.k;
      const v = live ? s.latest[k] : null;
      b.innerHTML = `${esc(fmt(k, v))}<small>${v != null ? esc(unitOf(k)) : ''}</small>`;
    }
    const dt = s.dtcs;
    const mil = dt?.milOn ?? (s.latest.milOn != null ? !!s.latest.milOn : null);
    const parts = [];
    if (live && s.latest.batteryVoltage != null) parts.push(`${s.latest.batteryVoltage.toFixed(1)} V`);
    let milHtml = '';
    if (mil != null) {
      const n = dt?.stored?.length ?? s.latest.dtcCount ?? 0;
      milHtml = mil
        ? `<span class="mil-badge on">${MIL_ICON} Check engine · ${n} code${n === 1 ? '' : 's'}</span>`
        : `<span class="mil-badge off">${MIL_ICON} No faults</span>`;
    }
    card.querySelector('[data-role="foot"]').innerHTML = [milHtml, esc(parts.join(' · '))].filter(Boolean).join(' &nbsp; ');
    const btn = card.querySelector('[data-role="toggle"]');
    btn.textContent = ACTIVE_STATES.includes(st) ? 'Disconnect' : 'Connect';
  }
}

// -----------------------------------------------------------------------------
// Vehicle view
// -----------------------------------------------------------------------------
function currentVehicle() {
  return state.vehicles.find((v) => v.id === state.vehicleId);
}

function openVehicle() {
  buildGauges();
  renderVehicleHeader();
  buildTiles();
  buildCharts();
  renderDtcs();
  renderTerminal();
  renderLive();
  $('v-export').href = `/api/vehicles/${encodeURIComponent(state.vehicleId)}/log.csv`;
}

function renderVehicleHeader() {
  const v = currentVehicle();
  if (!v) return;
  const s = snap(v.id);
  const st = s.status?.state || 'disconnected';
  $('v-name').textContent = v.name;
  $('v-sub').textContent = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
  $('v-swatch').style.background = v.color || '#2a78d6';
  const pill = $('v-status');
  pill.dataset.state = st;
  pill.textContent = STATE_LABEL[st] || st;
  $('v-connect').textContent = ACTIVE_STATES.includes(st) ? 'Disconnect' : 'Connect';
  $('v-connect').classList.toggle('primary', !ACTIVE_STATES.includes(st));
  const connected = st === 'connected';
  $('dtc-read').disabled = !connected;
  $('dtc-clear').disabled = !connected;
  $('term-cmd').disabled = !connected;

  const info = s.status?.info || {};
  const items = [
    ['Adapter', `${v.host}:${v.port}`, true],
    ['VIN', info.vin || v.vin || '—', true],
    ['Protocol', info.protocol || '—'],
    ['Interface', info.adapter || '—'],
    ['PIDs', s.status?.activePids?.length ? `${s.status.activePids.length} polled` : '—'],
    ['Rate', connected && s.status?.rate ? `${s.status.rate} readings/s` : '—'],
  ];
  $('v-info').innerHTML = items.map(([k, val, mono]) => `<span><b>${k}</b><span class="${mono ? 'mono' : ''}">${esc(val)}</span></span>`).join('');

  const banner = $('v-banner');
  const warn = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2 1 21h22zm0 6 1 7h-2zm0 9.5a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"/></svg>';
  if ((st === 'error' || st === 'reconnecting') && s.status.error) {
    banner.className = 'banner error';
    banner.innerHTML = `${warn}<div><strong>Can't reach the vehicle.</strong> ${esc(s.status.error)}<br><span class="muted">Check your computer is joined to the adapter's WiFi network, the IP/port are right, and the ignition is on.</span></div>`;
    banner.hidden = false;
  } else if (info.vinMismatch) {
    const other = state.vehicles.find((x) => x.id === info.vinMismatch.matchesVehicleId);
    banner.className = 'banner warn';
    banner.innerHTML = `${warn}<div><strong>Different vehicle detected.</strong> This adapter is plugged into VIN <code>${esc(info.vinMismatch.actual)}</code>, but this profile expects <code>${esc(info.vinMismatch.expected)}</code>.${other ? ` That VIN belongs to <a href="#/vehicle/${esc(other.id)}">${esc(other.name)}</a>.` : ''}</div>`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function buildGauges() {
  const imperial = prefs.units === 'imperial';
  const rpmOpts = { label: 'Engine speed', unit: 'rpm', min: 0, max: 8000, majorStep: 1000, minorStep: 250, redFrom: 6500,
    tickFormat: (v) => String(v / 1000), format: (v) => Math.round(v).toLocaleString() };
  const speedOpts = imperial
    ? { label: 'Speed', unit: 'mph', min: 0, max: 160, majorStep: 20, minorStep: 5 }
    : { label: 'Speed', unit: 'km/h', min: 0, max: 260, majorStep: 20, minorStep: 10 };
  gauges = { rpm: new Gauge($('g-rpm'), rpmOpts), speed: new Gauge($('g-speed'), speedOpts) };
}

function buildTiles() {
  $('v-tiles').innerHTML = TILE_ORDER.map((k) => `
    <div class="tile" data-k="${k}" hidden>
      <div class="tile-label"><span>${esc(METRICS[k].label)}</span><span class="flag"></span></div>
      <div class="tile-value"></div>
      ${METRICS[k].range ? '<div class="bar"><i></i></div>' : ''}
    </div>`).join('');
}

function renderLive() {
  if (state.view !== 'vehicle') return;
  const s = snap(state.vehicleId);
  const live = s.status?.state === 'connected';
  const L = s.latest;
  if (live) {
    gauges.rpm.set(L.rpm);
    gauges.speed.set(L.speed != null ? convert('speed', L.speed) : null);
  } else {
    gauges.rpm.markStale();
    gauges.speed.markStale();
  }
  for (const tile of $('v-tiles').children) {
    const k = tile.dataset.k;
    const v = L[k];
    if (v == null) { tile.hidden = true; continue; }
    tile.hidden = false;
    tile.classList.toggle('stale', !live);
    const m = METRICS[k];
    const unit = unitOf(k);
    tile.querySelector('.tile-value').innerHTML = `${esc(fmt(k, v))}${unit ? `<small>${esc(unit)}</small>` : ''}`;
    const level = m.level ? m.level(v) : null;
    if (level) tile.dataset.level = level; else delete tile.dataset.level;
    tile.querySelector('.flag').textContent = level === 'critical' ? '▲ Critical' : level === 'warning' ? '▲ Check' : '';
    const bar = tile.querySelector('.bar > i');
    if (bar) {
      const [lo, hi] = m.range;
      bar.style.width = `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
    }
  }
  renderChips();
  for (const chart of charts.values()) chart.draw();
  // Header bits that change with data (sample rate, PID count) — refresh ~1/s.
  const now = Date.now();
  if (now - lastHeaderRender > 1000) {
    lastHeaderRender = now;
    renderVehicleHeader();
  }
}

// ----- Charts ---------------------------------------------------------------
function availableChartKeys() {
  const L = snap(state.vehicleId).latest;
  return Object.keys(METRICS).filter((k) => !METRICS[k].noChart && L[k] != null);
}

let lastChipKeys = '';
function renderChips() {
  const keys = availableChartKeys();
  const sig = keys.join() + '|' + prefs.charts.join();
  if (sig === lastChipKeys) return;
  lastChipKeys = sig;
  $('metric-chips').innerHTML = keys.length
    ? keys.map((k) => `<button class="chip" data-k="${k}" aria-pressed="${prefs.charts.includes(k)}">${esc(METRICS[k].label)}</button>`).join('')
    : '<span class="muted">Connect to the vehicle to see live trends.</span>';
  // Build charts for selected keys that became available.
  const want = prefs.charts.filter((k) => keys.includes(k));
  if (want.join() !== [...charts.keys()].join()) buildCharts();
}

function buildCharts() {
  destroyCharts();
  const s = snap(state.vehicleId);
  const keys = prefs.charts.filter((k) => s.latest[k] != null && !METRICS[k].noChart);
  for (const k of keys) {
    const chart = new TimeChart($('charts'), {
      title: METRICS[k].label, unit: unitOf(k),
      format: (v) => v.toLocaleString(undefined, { maximumFractionDigits: METRICS[k].dp, minimumFractionDigits: METRICS[k].dp }),
    });
    chart.window = prefs.range;
    chart.setData(s.history.filter((h) => h.values[k] != null).map((h) => [h.t, convert(k, h.values[k])]));
    charts.set(k, chart);
  }
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.range) === prefs.range));
}

function destroyCharts() {
  for (const c of charts.values()) c.destroy();
  charts = new Map();
  $('charts').innerHTML = '';
  lastChipKeys = '';
}

// ----- DTCs -----------------------------------------------------------------
function renderDtcs() {
  const d = snap(state.vehicleId).dtcs;
  const body = $('dtc-body');
  if (!d) {
    body.innerHTML = '<p class="none">Connect to read diagnostic trouble codes.</p>';
    return;
  }
  const mil = d.milOn;
  const read = new Date(d.readAt).toLocaleTimeString();
  const milBox = mil == null ? '' : `
    <div class="mil ${mil ? 'on' : 'off'}">${MIL_ICON}
      <div><strong>${mil ? 'Check engine light ON' : 'Check engine light off'}</strong>
      <span class="muted">${d.stored.length} stored · ${d.pending.length} pending · read ${esc(read)}</span></div>
    </div>`;
  const group = (title, codes, note) => `
    <div class="dtc-group"><h3>${title}</h3>
      ${codes.length ? codes.map((c) => `<div class="dtc"><code>${esc(c)}</code><div>${esc(describeDtc(c))}<small>${esc(dtcSystem(c))}${note ? ' · ' + note : ''}</small></div></div>`).join('')
        : '<div class="none">None</div>'}
    </div>`;
  body.innerHTML = milBox
    + group('Stored codes', d.stored)
    + group('Pending codes', d.pending, 'detected once, not yet confirmed')
    + (d.permanent.length ? group('Permanent codes', d.permanent, 'clears itself after the monitor passes') : '');
}

// ----- Terminal ---------------------------------------------------------------
function trafficLine(e) {
  const ts = new Date(e.t).toLocaleTimeString([], { hour12: false });
  const arrow = e.dir === 'tx' ? '→' : e.dir === 'rx' ? '←' : '!';
  return `<div class="${e.dir}"><span class="ts">${ts}</span>${arrow} ${esc(e.text.replace(/\r/g, ' ⏎ '))}</div>`;
}
function renderTerminal() {
  const term = $('terminal');
  term.innerHTML = snap(state.vehicleId).traffic.slice(-150).map(trafficLine).join('');
  term.scrollTop = term.scrollHeight;
}
function appendTraffic(e) {
  const term = $('terminal');
  term.insertAdjacentHTML('beforeend', trafficLine(e));
  while (term.childElementCount > 300) term.firstChild.remove();
  if ($('term-follow').checked) term.scrollTop = term.scrollHeight;
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4000);
}

async function toggleConnection(id) {
  const st = snap(id).status?.state || 'disconnected';
  try {
    if (ACTIVE_STATES.includes(st)) await api('POST', `/api/vehicles/${id}/disconnect`);
    else await api('POST', `/api/vehicles/${id}/connect`);
  } catch (err) {
    toast(err.message, true);
  }
}

function openVehicleDialog(vehicle) {
  editingId = vehicle?.id || null;
  const form = $('vehicle-form');
  form.reset();
  $('vehicle-dialog-title').textContent = vehicle ? 'Edit vehicle' : 'Add vehicle';
  $('vehicle-delete').hidden = !vehicle;
  $('vehicle-form-error').textContent = '';
  if (vehicle) {
    for (const el of form.elements) {
      if (el.name && vehicle[el.name] != null) el.value = vehicle[el.name];
    }
  } else {
    // Suggest a distinct colour for each new vehicle.
    const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
    form.elements.color.value = palette[state.vehicles.length % palette.length];
  }
  $('vehicle-dialog').showModal();
  form.elements.name.focus();
}

async function saveVehicle(e) {
  e.preventDefault();
  const form = $('vehicle-form');
  const data = Object.fromEntries(new FormData(form).entries());
  data.port = Number(data.port);
  if (!data.year) delete data.year;
  if (!editingId) for (const k of ['vin', 'notes', 'make', 'model']) if (!data[k]) delete data[k];
  try {
    const v = editingId ? await api('PUT', `/api/vehicles/${editingId}`, data) : await api('POST', '/api/vehicles', data);
    $('vehicle-dialog').close();
    if (!editingId) location.hash = `#/vehicle/${v.id}`;
    toast(editingId ? 'Vehicle updated' : 'Vehicle added');
  } catch (err) {
    $('vehicle-form-error').textContent = err.message;
  }
}

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------
function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  for (const c of charts.values()) c.draw();
}

function init() {
  applyTheme();
  window.addEventListener('hashchange', route);

  $('nav-fleet').onclick = () => (location.hash = '#/');
  $('vehicle-list').onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) location.hash = `#/vehicle/${b.dataset.id}`;
  };
  for (const id of ['add-vehicle', 'add-vehicle-2', 'add-vehicle-3']) $(id).onclick = () => openVehicleDialog(null);
  $('menu-btn').onclick = () => $('sidebar').classList.toggle('open');

  $('fleet-grid').onclick = (e) => {
    const card = e.target.closest('.fleet-card');
    if (!card) return;
    if (e.target.closest('[data-role="toggle"]')) toggleConnection(card.dataset.id);
    else location.hash = `#/vehicle/${card.dataset.id}`;
  };
  $('fleet-grid').onkeydown = (e) => {
    const card = e.target.closest('.fleet-card');
    if (card && e.key === 'Enter' && e.target === card) location.hash = `#/vehicle/${card.dataset.id}`;
  };

  document.querySelectorAll('[data-units]').forEach((b) => (b.onclick = () => {
    prefs.units = b.dataset.units;
    savePrefs();
    renderSidebar();
    if (state.view === 'vehicle') { buildGauges(); buildCharts(); renderLive(); } else renderFleetLive();
  }));
  $('theme-toggle').onclick = () => {
    prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  };

  $('v-connect').onclick = () => toggleConnection(state.vehicleId);
  $('v-edit').onclick = () => openVehicleDialog(currentVehicle());

  $('range-seg').onclick = (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    prefs.range = Number(b.dataset.range);
    savePrefs();
    document.querySelectorAll('#range-seg button').forEach((x) => x.classList.toggle('active', x === b));
    for (const c of charts.values()) c.setWindow(prefs.range);
  };
  $('metric-chips').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const k = b.dataset.k;
    prefs.charts = prefs.charts.includes(k) ? prefs.charts.filter((x) => x !== k) : [...prefs.charts, k];
    savePrefs();
    buildCharts();
    lastChipKeys = '';
    renderChips();
  };

  $('dtc-read').onclick = async () => {
    try {
      $('dtc-read').disabled = true;
      await api('POST', `/api/vehicles/${state.vehicleId}/dtcs/read`);
      toast('Trouble codes read');
    } catch (err) { toast(err.message, true); } finally { renderVehicleHeader(); }
  };
  $('dtc-clear').onclick = async () => {
    const ok = confirm('Clear all trouble codes and turn off the check engine light?\n\n' +
      'This also resets emissions readiness monitors (the car may fail an inspection until they re-run). ' +
      'Codes will return if the underlying fault is still present.');
    if (!ok) return;
    try {
      await api('POST', `/api/vehicles/${state.vehicleId}/dtcs/clear`);
      toast('Trouble codes cleared');
    } catch (err) { toast(err.message, true); }
  };
  $('term-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('term-cmd');
    const command = input.value.trim();
    if (!command) return;
    if (/^0?4$/.test(command.replace(/\s/g, '')) && !confirm('Mode 04 clears all trouble codes. Send it?')) return;
    input.value = '';
    try { await api('POST', `/api/vehicles/${state.vehicleId}/command`, { command }); } catch (err) { toast(err.message, true); }
  };

  $('vehicle-form').onsubmit = saveVehicle;
  $('vehicle-cancel').onclick = () => $('vehicle-dialog').close();
  $('vehicle-delete').onclick = async () => {
    const v = state.vehicles.find((x) => x.id === editingId);
    if (!v || !confirm(`Delete "${v.name}"? Its saved settings will be removed.`)) return;
    try {
      await api('DELETE', `/api/vehicles/${editingId}`);
      $('vehicle-dialog').close();
      location.hash = '#/';
    } catch (err) { $('vehicle-form-error').textContent = err.message; }
  };

  // Keep charts scrolling smoothly even between samples.
  setInterval(() => { if (state.view === 'vehicle') for (const c of charts.values()) c.draw(); }, 1000);

  connectSocket();
}

init();
