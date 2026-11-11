// Lightweight canvas time-series chart (one series per chart; charts are laid
// out as small multiples so each metric keeps its own single y-axis).

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class TimeChart {
  /**
   * @param {HTMLElement} container
   * @param {{title:string, unit:string, color?:string, format?:(v:number)=>string}} opts
   */
  constructor(container, opts) {
    this.opts = { format: (v) => v.toFixed(1), ...opts };
    this.points = []; // [t, v]
    this.window = 60;
    this.hoverX = null;

    this.root = document.createElement('div');
    this.root.className = 'chart';
    this.head = document.createElement('div');
    this.head.className = 'chart-title';
    this.head.innerHTML = `<b></b><span></span>`;
    this.head.firstChild.textContent = opts.title;
    this.current = this.head.lastChild;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', `${opts.title} over time`);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    this.root.append(this.head, this.canvas, this.tip);
    container.appendChild(this.root);

    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - rect.left;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
      this.draw();
    });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  setData(points) {
    this.points = points;
    this.draw();
  }

  push(t, v) {
    this.points.push([t, v]);
    const cutoff = t - 600_000;
    while (this.points.length && this.points[0][0] < cutoff) this.points.shift();
  }

  setWindow(seconds) {
    this.window = seconds;
    this.draw();
  }

  destroy() {
    this.ro.disconnect();
    this.root.remove();
  }

  draw() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const grid = cssVar('--grid');
    const axis = cssVar('--axis');
    const muted = cssVar('--muted');
    const color = this.opts.color || cssVar('--series');
    const surface = cssVar('--surface');

    const now = Date.now();
    const t0 = now - this.window * 1000;
    const pts = this.points.filter(([t]) => t >= t0 - 2000);
    const last = this.points[this.points.length - 1];
    this.current.textContent = last ? `${this.opts.format(last[1])} ${this.opts.unit}` : '—';

    const padL = 44, padR = 8, padT = 8, padB = 20;
    const pw = w - padL - padR;
    const ph = h - padT - padB;

    let lo = Infinity, hi = -Infinity;
    for (const [, v] of pts) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!pts.length) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    const x = (t) => padL + ((t - t0) / (this.window * 1000)) * pw;
    const y = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;

    ctx.font = `11px system-ui, sans-serif`;
    ctx.fillStyle = muted;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = lo; v <= hi + step / 2; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v - lo) < 1e-9 ? axis : grid;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(formatTick(v, step), padL - 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tStep = this.window <= 60 ? 15 : this.window <= 300 ? 60 : 120;
    for (let s = 0; s <= this.window; s += tStep) {
      const xx = padL + (1 - s / this.window) * pw;
      ctx.fillText(s === 0 ? 'now' : `-${s >= 60 ? s / 60 + 'm' : s + 's'}`, xx, h - padB + 6);
    }

    if (pts.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT - 2, pw, ph + 4);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
      ctx.stroke();
      ctx.restore();
    }

    // Crosshair + tooltip
    if (this.hoverX != null && pts.length && this.hoverX >= padL) {
      const tHover = t0 + ((this.hoverX - padL) / pw) * this.window * 1000;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - tHover) < Math.abs(best[0] - tHover)) best = p;
      const bx = x(best[0]);
      const by = y(best[1]);
      ctx.strokeStyle = axis;
      ctx.beginPath();
      ctx.moveTo(Math.round(bx) + 0.5, padT);
      ctx.lineTo(Math.round(bx) + 0.5, padT + ph);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.strokeStyle = surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const ago = Math.max(0, Math.round((now - best[0]) / 1000));
      this.tip.textContent = `${this.opts.format(best[1])} ${this.opts.unit} · ${ago ? ago + 's ago' : 'now'}`;
      this.tip.style.left = `${Math.min(Math.max(bx, 60), w - 60)}px`;
      this.tip.style.top = `${by + this.head.offsetHeight}px`;
      this.tip.hidden = false;
    }
  }
}

function formatTick(v, step) {
  const decimals = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
  return v.toFixed(decimals);
}
