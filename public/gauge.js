// Radial SVG gauge with a 240° sweep, value arc, centred readout and optional red zone.
const NS = 'http://www.w3.org/2000/svg';
const SWEEP = 240;
const START = -120; // degrees from 12 o'clock

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

export class Gauge {
  /**
   * @param {HTMLElement} container
   * @param {{label:string, unit:string, min:number, max:number, majorStep:number,
   *          minorStep?:number, redFrom?:number, tickFormat?:(v:number)=>string,
   *          format?:(v:number)=>string}} opts
   */
  constructor(container, opts) {
    this.container = container;
    this.configure(opts);
  }

  configure(opts) {
    this.opts = { minorStep: opts.majorStep / 5, tickFormat: (v) => String(v), format: (v) => String(Math.round(v)), ...opts };
    this.render();
    if (this.value != null) this.set(this.value);
  }

  render() {
    const { min, max, majorStep, minorStep, redFrom, label, unit, tickFormat } = this.opts;
    const cx = 150, cy = 150, r = 120;
    this.container.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 300 262', class: 'gauge stale', role: 'img', 'aria-label': label });
    this.svg = svg;
    const angle = (v) => START + ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * SWEEP;
    this.angle = angle;

    el('path', { d: arcPath(cx, cy, r, START, START + SWEEP), class: 'track', 'stroke-width': 14, fill: 'none', 'stroke-linecap': 'round' }, svg);
    if (redFrom != null && redFrom < max) {
      el('path', { d: arcPath(cx, cy, r + 13, angle(redFrom), START + SWEEP), class: 'redzone', 'stroke-width': 5, fill: 'none' }, svg);
    }
    // Value arc drawn with dasharray so it can animate.
    const fullLen = (Math.PI * 2 * r * SWEEP) / 360;
    this.fullLen = fullLen;
    this.fill = el('path', {
      d: arcPath(cx, cy, r, START, START + SWEEP), class: 'fill', 'stroke-width': 14, fill: 'none', 'stroke-linecap': 'round',
      'stroke-dasharray': `${fullLen} ${fullLen}`, 'stroke-dashoffset': fullLen,
    }, svg);

    for (let v = min; v <= max + 1e-9; v += minorStep) {
      const major = Math.abs((v - min) / majorStep - Math.round((v - min) / majorStep)) < 1e-6;
      const a = angle(v);
      const [x0, y0] = polar(cx, cy, r - 14, a);
      const [x1, y1] = polar(cx, cy, r - (major ? 26 : 20), a);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'tick major' : 'tick', 'stroke-width': major ? 2 : 1 }, svg);
      if (major) {
        const [tx, ty] = polar(cx, cy, r - 40, a);
        const t = el('text', { x: tx, y: ty + 4, 'text-anchor': 'middle', class: 'tick-label' }, svg);
        t.textContent = tickFormat(v);
      }
    }

    // The arc shows position and the number shows the value; a needle would repeat both.
    this.valueText = el('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'value' }, svg);
    this.valueText.textContent = '—';
    const u = el('text', { x: cx, y: cy + 42, 'text-anchor': 'middle', class: 'unit' }, svg);
    u.textContent = unit;
    const l = el('text', { x: cx, y: cy + 104, 'text-anchor': 'middle', class: 'label' }, svg);
    l.textContent = label;

    this.container.appendChild(svg);
  }

  set(value) {
    this.value = value;
    if (value == null || Number.isNaN(value)) {
      // No reading: empty the arc so an old value can't be mistaken for a live one.
      this.svg.classList.add('stale');
      this.valueText.textContent = '—';
      this.fill.setAttribute('stroke-dashoffset', this.fullLen);
      this.svg.setAttribute('aria-label', `${this.opts.label}: no reading`);
      return;
    }
    const { min, max, format } = this.opts;
    const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
    this.svg.classList.remove('stale');
    this.fill.setAttribute('stroke-dashoffset', this.fullLen * (1 - frac));
    this.valueText.textContent = format(value);
    this.svg.setAttribute('aria-label', `${this.opts.label}: ${format(value)} ${this.opts.unit}`);
  }

  markStale() {
    this.svg.classList.add('stale');
  }
}
