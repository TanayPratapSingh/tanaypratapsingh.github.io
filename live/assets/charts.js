// Canvas charts for high rate data. Each chart owns one canvas sized to its
// container at device pixel ratio, paints through the shared scheduler, and
// carries its own hover layer: a crosshair that snaps to the nearest time on
// time series, and a per mark tooltip on columns and scatter points.
import { niceTicks, logTicks, timeTicks, nearestIndex, fmt, isNum, clamp } from './util.js';
import { h, palette, rgba, onPaint } from './ui.js';

const groups = new Map();   // crosshair sync: group name -> Set of charts

class Base {
  constructor(container, opts) {
    this.o = Object.assign({ height: 200, every: 200 }, opts);
    this.root = h('div', { class: 'chart viz' });
    this.cv = h('canvas', { tabindex: '0', role: 'img', 'aria-label': opts.aria || 'chart' });
    this.tip = h('div', { class: 'tip', 'aria-hidden': 'true' });
    this.root.append(this.cv, this.tip);
    container.append(this.root);
    this.ctx = this.cv.getContext('2d');
    this.w = 0; this.hgt = this.o.height; this.dpr = 1;
    this.job = onPaint(() => this.paint(), this.o.every);
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.resize();
    this.cv.addEventListener('pointermove', e => this.hover(e.offsetX, e.offsetY));
    this.cv.addEventListener('pointerleave', () => this.leave());
    this.cv.addEventListener('blur', () => this.leave());
    this.cv.addEventListener('keydown', e => this.key(e));
  }
  resize() {
    const w = Math.max(120, Math.floor(this.root.clientWidth));
    const hgt = typeof this.o.height === 'function' ? this.o.height(w) : this.o.height;
    if (w === this.w && hgt === this.hgt && this.dpr === devicePixelRatio) return;
    this.w = w; this.hgt = hgt; this.dpr = devicePixelRatio || 1;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(hgt * this.dpr);
    this.cv.style.height = hgt + 'px';
    this.job.now();
  }
  begin() {
    const c = this.ctx, p = palette();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.hgt);
    c.font = '11px ' + p.mono; c.textBaseline = 'alphabetic';
    return { c, p };
  }
  showTip(x, y, head, rows) {
    const t = this.tip;
    t.replaceChildren(h('div', { class: 'tip__h' }, head), ...rows.map(r =>
      h('div', { class: 'tip__r' }, h('i', { style: { background: r.color || 'transparent', height: r.shape === 'rect' ? '10px' : '2px', width: r.shape === 'rect' ? '10px' : '12px' } }), h('b', null, r.value), h('span', null, r.label))));
    t.style.display = 'block';
    const tw = t.offsetWidth, th = t.offsetHeight;
    let left = x + 14; if (left + tw > this.w) left = x - tw - 14; left = clamp(left, 0, Math.max(0, this.w - tw));
    let top = y - th - 10; if (top < 0) top = y + 14;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  hideTip() { this.tip.style.display = 'none'; }
  leave() { this.hideTip(); }
  key() {}
  invalidate() { this.job.invalidate(); }
}

function yScale(o, lo, hi, top, bottom) {
  if (o.log) {
    const L0 = Math.log10(lo), L1 = Math.log10(hi);
    return v => bottom - (Math.log10(Math.max(v, lo)) - L0) / (L1 - L0) * (bottom - top);
  }
  return v => bottom - (v - lo) / (hi - lo || 1) * (bottom - top);
}

// ------------------------------------------------------------------ TimeChart
// rows: [{t, key: value, ...}] sorted by t. Series kinds: line, area, step.
// Series sharing a `stack` name are stacked in declaration order.
export class TimeChart extends Base {
  constructor(container, opts) {
    super(container, Object.assign({ series: [], y: {}, x: {}, bands: [], refs: [] }, opts));
    this.rows = []; this.marks = []; this.vlines = []; this.hoverT = NaN; this.domain = [0, 1];
    if (this.o.group) { if (!groups.has(this.o.group)) groups.set(this.o.group, new Set()); groups.get(this.o.group).add(this); }
  }
  set(rows, extra = {}) {
    this.rows = rows; this.now = extra.now ?? null; this.marks = extra.marks || []; this.vlines = extra.vlines || [];
    if (extra.refs) this.o.refs = extra.refs;
    if (extra.bands) this.o.bands = extra.bands;
    this.invalidate();
  }
  stacked() {
    const out = this.o.series.map(() => []);
    for (const r of this.rows) {
      const acc = {};
      this.o.series.forEach((s, i) => {
        const v = r[s.key];
        if (s.stack) { const b = acc[s.stack] || 0; const top = isNum(v) ? b + v : NaN; out[i].push([r.t, b, top]); if (isNum(v)) acc[s.stack] = top; }
        else out[i].push([r.t, 0, isNum(v) ? v : NaN]);
      });
    }
    return out;
  }
  paint() {
    const { c, p } = this.begin(), o = this.o, W = this.w, H = this.hgt;
    const top = 8, bottom = H - 20, left = 0, right = W - (o.rightPad ?? 4);
    if (!this.rows.length) { c.fillStyle = p.ink3; c.font = '12px ' + p.sans; c.textAlign = 'center'; c.fillText(o.empty || 'Waiting for data', W / 2, H / 2); return; }
    const pts = this.stacked();
    const t1 = o.x.span && this.now ? this.now : this.rows[this.rows.length - 1].t;
    const t0 = o.x.span ? t1 - o.x.span : this.rows[0].t;
    this.domain = [t0, t1];
    const X = t => left + (t - t0) / (t1 - t0 || 1) * (right - left);
    // y domain from visible values
    let lo = Infinity, hi = -Infinity;
    pts.forEach((sp, i) => { if (o.series[i].hidden) return; for (const [t, b, v] of sp) if (t >= t0 && isNum(v)) { lo = Math.min(lo, v, o.series[i].stack ? b : v); hi = Math.max(hi, v); } });
    for (const r of o.refs) if (r.y != null && r.fit !== false) { lo = Math.min(lo, r.y); hi = Math.max(hi, r.y); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (o.y.zero !== false && !o.y.log) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (o.y.min != null) lo = Math.min(lo, o.y.min);
    if (o.y.max != null) hi = Math.max(hi, o.y.max);
    if (o.y.minSpan && hi - lo < o.y.minSpan) { const m = (hi + lo) / 2; lo = m - o.y.minSpan / 2; hi = m + o.y.minSpan / 2; }
    let ticks;
    if (o.y.log) { const fl = o.y.floor || 1e-12; const L = logTicks(Math.max(lo, fl), Math.max(hi, fl * 10)); lo = L.lo; hi = L.hi; ticks = L.ticks; }
    else { const pad = (hi - lo) * (o.y.pad ?? 0.06); const N = niceTicks(lo === 0 ? 0 : lo - pad, hi + pad, o.y.ticks || 4); lo = N.lo; hi = N.hi; ticks = N.ticks; }
    const Y = yScale(o.y, lo, hi, top, bottom);
    this.Y = Y; this.X = X;
    // bands
    for (const b of o.bands) {
      const y0 = Y(Math.min(Math.max(b.y0, lo), hi)), y1 = Y(Math.max(Math.min(b.y1, hi), lo));
      if (y0 - y1 < 1) continue;
      c.fillStyle = b.color ? rgba(p.color(b.color), 0.07) : p.sunk; c.fillRect(left, y1, right - left, y0 - y1);
      if (b.label) { c.fillStyle = p.ink3; c.textAlign = 'right'; c.fillText(b.label, right - 4, y1 + 12); }
    }
    // grid + y labels (labels sit above their gridline, left aligned)
    c.lineWidth = 1; c.textAlign = 'left';
    const yf = o.y.fmt || (v => fmt.sig(v, 3));
    for (const v of ticks) {
      const y = Math.round(Y(v)) + 0.5;
      c.strokeStyle = v === 0 && !o.y.log ? p.axis : p.grid; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      // the top tick sits on the canvas edge, so its label goes under its gridline
      c.fillStyle = p.muted; c.fillText(yf(v), left + 2, y - 3 < 10 ? y + 11 : y - 3);
    }
    // x ticks
    const { ticks: xt } = timeTicks(t0, t1, Math.max(2, Math.floor(W / 110)));
    c.textAlign = 'center'; c.fillStyle = p.muted;
    const showSecs = (t1 - t0) < 10 * 60e3;
    for (const t of xt) {
      const x = X(t); if (x < 20 || x > right - 20) continue;
      c.fillText(o.x.fmt ? o.x.fmt(t) : ((t1 - t0) > 2 * 86400e3 ? fmt.date(t, o.x.utc) + ' ' + fmt.time(t, o.x.utc, false) : fmt.time(t, o.x.utc, showSecs)), x, H - 5);
    }
    // vertical reference lines
    for (const v of this.vlines) {
      const x = Math.round(X(v.t)) + 0.5; if (x < left || x > right) continue;
      c.strokeStyle = p.ink3; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      if (v.label) { c.fillStyle = p.ink2; c.textAlign = x > W - 90 ? 'right' : 'left'; c.fillText(v.label, x + (x > W - 90 ? -4 : 4), top + 10); }
    }
    // horizontal reference lines
    for (const r of o.refs) {
      if (r.y == null || r.y < lo || r.y > hi) continue;
      const y = Math.round(Y(r.y)) + 0.5;
      c.strokeStyle = r.color ? p.color(r.color) : p.ink3; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      if (r.label) { c.fillStyle = p.ink2; c.textAlign = 'right'; c.fillText(r.label, right - 4, y - 4); }
    }
    // series
    c.save(); c.beginPath(); c.rect(left, top - 4, right - left, bottom - top + 8); c.clip();
    const gap = o.gapMs;
    pts.forEach((sp, i) => {
      const s = o.series[i]; if (s.hidden) return;
      const col = p.color(s.color);
      const kind = s.kind || 'line';
      // split into runs at gaps and NaNs so missing data is never drawn as a line
      const runs = []; let run = [];
      for (const q of sp) {
        if (!isNum(q[2])) { if (run.length) runs.push(run); run = []; continue; }
        if (gap && run.length && q[0] - run[run.length - 1][0] > gap) { runs.push(run); run = []; }
        run.push(q);
      }
      if (run.length) runs.push(run);
      for (const r of runs) {
        if (kind === 'area' || s.stack) {
          c.beginPath();
          r.forEach((q, k) => { const x = X(q[0]), y = Y(q[2]); k ? c.lineTo(x, y) : c.moveTo(x, y); });
          for (let k = r.length - 1; k >= 0; k--) c.lineTo(X(r[k][0]), Y(o.y.log ? Math.max(r[k][1], lo) : r[k][1]));
          c.closePath(); c.fillStyle = rgba(col, s.stack ? 0.22 : 0.10); c.fill();
        }
        c.beginPath(); c.lineWidth = s.width || 2; c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = col;
        let py = 0;
        r.forEach((q, k) => {
          const x = X(q[0]), y = Y(q[2]);
          if (!k) c.moveTo(x, y);
          else if (kind === 'step') { c.lineTo(x, py); c.lineTo(x, y); }
          else c.lineTo(x, y);
          py = y;
        });
        c.stroke();
      }
      if (s.endDot !== false && sp.length) {
        for (let k = sp.length - 1; k >= 0; k--) if (isNum(sp[k][2])) { dot(c, X(sp[k][0]), Y(sp[k][2]), col, p.surface); break; }
      }
    });
    // event marks: small triangles, at a value or along the top edge
    for (const m of this.marks) {
      const x = X(m.t); if (x < left || x > right) continue;
      const y = m.y != null ? Y(m.y) : top + 2;
      c.fillStyle = m.color ? p.color(m.color) : p.critical;
      c.beginPath(); c.moveTo(x, y - 6); c.lineTo(x + 5, y + 3); c.lineTo(x - 5, y + 3); c.closePath(); c.fill();
    }
    c.restore();
    // crosshair
    if (isNum(this.hoverT) && this.hoverT >= t0 && this.hoverT <= t1) {
      const i = nearestIndex(this.rows, this.hoverT, r => r.t);
      const row = this.rows[i];
      const x = Math.round(X(row.t)) + 0.5;
      c.strokeStyle = p.ink3; c.lineWidth = 1; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      pts.forEach((sp, k) => { const s = o.series[k]; if (s.hidden) return; const q = sp[i]; if (q && isNum(q[2])) dot(c, x, Y(q[2]), p.color(s.color), p.surface); });
      const lines = [];
      o.series.forEach(s => { if (s.hidden) return; const v = row[s.key]; lines.push({ color: p.color(s.color), value: isNum(v) ? (s.fmt || o.y.tipFmt || yf)(v) : '–', label: s.label }); });
      if (o.tipExtra) lines.push(...o.tipExtra(row));
      if (this.ownHover) this.showTip(x, this.hy ?? top + 30, (o.x.tipFmt || (t => fmt.date(t, o.x.utc) + ' ' + fmt.time(t, o.x.utc) + (o.x.utc ? ' UTC' : '')))(row.t), o.stackTip === false ? lines : lines.reverse());
      else this.hideTip();
    }
  }
  setHover(t, own, y) {
    const g = this.o.group ? groups.get(this.o.group) : [this];
    for (const ch of g) { ch.hoverT = t; ch.ownHover = ch === this ? own : false; if (ch === this) ch.hy = y; ch.job.now(); }
  }
  hover(x, y) {
    if (!this.rows.length) return;
    const [t0, t1] = this.domain, right = this.w - (this.o.rightPad ?? 4);
    this.setHover(t0 + clamp(x / right, 0, 1) * (t1 - t0), true, y);
  }
  leave() { this.setHover(NaN, false); this.hideTip(); }
  key(e) {
    if (!this.rows.length || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    let i = isNum(this.hoverT) ? nearestIndex(this.rows, this.hoverT, r => r.t) : this.rows.length - 1;
    i = clamp(i + (e.key === 'ArrowLeft' ? -1 : 1), 0, this.rows.length - 1);
    this.setHover(this.rows[i].t, true, 30);
  }
}

export function dot(c, x, y, col, ring) {
  c.beginPath(); c.arc(x, y, 6, 0, 7); c.fillStyle = ring; c.fill();
  c.beginPath(); c.arc(x, y, 4, 0, 7); c.fillStyle = col; c.fill();
}
export function roundTop(c, x, y, w, hh, r) {
  r = Math.min(r, w / 2, Math.max(0, hh));
  c.beginPath(); c.moveTo(x, y + hh); c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r); c.lineTo(x + w, y + hh); c.closePath();
}

// ------------------------------------------------------------------ Columns
// cats: [{label, tip?, key: value, ...}]. Series sit side by side, or stack
// with a 2px surface gap when `stacked` is set. Bars cap at 24px.
export class Columns extends Base {
  constructor(container, opts) {
    super(container, Object.assign({ series: [], y: {}, stacked: false, labelEvery: 0 }, opts));
    this.cats = []; this.hi = -1; this.refs = [];
  }
  set(cats, extra = {}) { this.cats = cats; this.refs = extra.refs || []; this.invalidate(); }
  paint() {
    const { c, p } = this.begin(), o = this.o, W = this.w, H = this.hgt;
    const top = 10, bottom = H - (o.xLabels === false ? 6 : 20);
    if (!this.cats.length) { c.fillStyle = p.ink3; c.font = '12px ' + p.sans; c.textAlign = 'center'; c.fillText(o.empty || 'Waiting for data', W / 2, H / 2); return; }
    let hi = 0, lo = 0;
    for (const k of this.cats) {
      if (o.stacked) { let s = 0; for (const se of o.series) s += k[se.key] || 0; hi = Math.max(hi, s); }
      else for (const se of o.series) { hi = Math.max(hi, k[se.key] || 0); lo = Math.min(lo, k[se.key] || 0); }
    }
    for (const r of this.refs) hi = Math.max(hi, r.y);
    let ticks, Y;
    if (o.y.log) { const L = logTicks(o.y.floor || 1, Math.max(hi, 10)); ticks = L.ticks; Y = yScale({ log: true }, L.lo, L.hi, top, bottom); }
    else { const N = niceTicks(lo, hi || 1, o.y.ticks || 4); ticks = N.ticks; Y = yScale({}, N.lo, N.hi, top, bottom); }
    const yf = o.y.fmt || fmt.compact;
    c.textAlign = 'left'; c.lineWidth = 1;
    for (const v of ticks) { const y = Math.round(Y(v)) + 0.5; c.strokeStyle = v === 0 ? p.axis : p.grid; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); if (!o.y.labelsOver) { c.fillStyle = p.muted; c.fillText(yf(v), 2, y - 3 < 10 ? y + 11 : y - 3); } }
    const n = this.cats.length, slot = W / n, ns = o.stacked ? 1 : o.series.length;
    const bw = Math.max(1, Math.min(24, (slot - 2) / ns - (ns > 1 ? 2 : 0)));
    const base = o.y.log ? bottom : Y(0);
    const every = o.labelEvery || Math.ceil(n / Math.max(1, Math.floor(W / 46)));
    this.cats.forEach((k, i) => {
      const x0 = i * slot + (slot - (bw * ns + 2 * (ns - 1))) / 2;
      let acc = 0;
      o.series.forEach((se, j) => {
        const v = k[se.key] || 0;
        const col = p.color(typeof se.color === 'function' ? se.color(k) : se.color);
        let x, y0, y1;
        if (o.stacked) { x = x0; y0 = Y(acc); acc += v; y1 = Y(acc); if (acc > v) y0 -= 2; }
        else { x = x0 + j * (bw + 2); y0 = v >= 0 ? base : Y(v); y1 = v >= 0 ? Y(o.y.log ? Math.max(v, o.y.floor || 1) : v) : base; if (o.y.log && v <= 0) y1 = y0; }
        const hh = y0 - y1;
        if (hh > 0.5) {
          c.fillStyle = this.hi === i ? rgba(col, 0.72) : col;
          if (o.stacked && j < o.series.length - 1) c.fillRect(x, y1, bw, hh); else { roundTop(c, x, y1, bw, hh, bw >= 8 ? 4 : 1); c.fill(); }
        }
      });
      if (o.xLabels !== false && i % every === 0) { c.fillStyle = p.muted; c.textAlign = 'center'; c.fillText(k.label, i * slot + slot / 2, H - 5); }
    });
    // opt in: y labels drawn after the bars with a surface halo, so a wide first bar cannot hide them
    if (o.y.labelsOver) { c.textAlign = 'left'; c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = p.surface; c.fillStyle = p.muted; for (const v of ticks) { const y = Math.round(Y(v)) + 0.5, ly = y - 3 < 10 ? y + 11 : y - 3; c.strokeText(yf(v), 2, ly); c.fillText(yf(v), 2, ly); } c.lineWidth = 1; }
    for (const r of this.refs) { const y = Math.round(Y(r.y)) + 0.5; c.strokeStyle = p.ink3; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); if (r.label) { c.fillStyle = p.ink2; c.textAlign = 'right'; c.fillText(r.label, W - 4, y - 4); } }
  }
  hover(x, y) {
    const n = this.cats.length; if (!n) return;
    const i = clamp(Math.floor(x / (this.w / n)), 0, n - 1), k = this.cats[i], p = palette();
    if (this.hi !== i) { this.hi = i; this.job.now(); }
    const rows = this.o.series.map(se => ({ color: p.color(typeof se.color === 'function' ? se.color(k) : se.color), shape: 'rect', value: (se.fmt || this.o.y.tipFmt || fmt.int)(k[se.key] || 0), label: se.label }));
    if (this.o.tipExtra) rows.push(...this.o.tipExtra(k));
    this.showTip(x, y, k.tip || k.label, rows);
  }
  leave() { this.hi = -1; this.hideTip(); this.job.now(); }
}

// ------------------------------------------------------------------ Scatter
// points: [{x, y, color?, r?, alpha?}] with an optional fitted line {a, b}.
// Hover finds the nearest point within 24px, not the painted pixels.
export class Scatter extends Base {
  constructor(container, opts) {
    super(container, Object.assign({ x: {}, y: {} }, opts));
    this.pts = []; this.fit = null; this.hi = -1;
  }
  set(pts, extra = {}) { this.pts = pts; this.fit = extra.fit || null; this.invalidate(); }
  paint() {
    const { c, p } = this.begin(), o = this.o, W = this.w, H = this.hgt;
    const top = 10, bottom = H - 20, left = 0, right = W - 4;
    if (!this.pts.length) { c.fillStyle = p.ink3; c.font = '12px ' + p.sans; c.textAlign = 'center'; c.fillText(o.empty || 'Waiting for data', W / 2, H / 2); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of this.pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    if (o.x.sym) { const m = Math.max(Math.abs(x0), Math.abs(x1)) || 1; x0 = -m; x1 = m; }
    if (o.y.sym) { const m = Math.max(Math.abs(y0), Math.abs(y1)) || 1; y0 = -m; y1 = m; }
    if (o.x.min != null) x0 = Math.min(x0, o.x.min); if (o.x.max != null) x1 = Math.max(x1, o.x.max);
    if (o.y.min != null) y0 = Math.min(y0, o.y.min); if (o.y.max != null) y1 = Math.max(y1, o.y.max);
    const NX = niceTicks(x0, x1, Math.max(3, Math.floor(W / 120))), NY = niceTicks(y0, y1, 4);
    const X = v => left + (v - NX.lo) / (NX.hi - NX.lo || 1) * (right - left);
    const Y = v => bottom - (v - NY.lo) / (NY.hi - NY.lo || 1) * (bottom - top);
    this.X = X; this.Y = Y;
    c.lineWidth = 1; c.textAlign = 'left';
    for (const v of NY.ticks) { const y = Math.round(Y(v)) + 0.5; c.strokeStyle = v === 0 ? p.axis : p.grid; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); if (!o.y.labelsOver) { c.fillStyle = p.muted; c.fillText((o.y.fmt || fmt.sig)(v), left + 2, y - 3 < 10 ? y + 11 : y - 3); } }
    c.textAlign = 'center';
    for (const v of NX.ticks) { const x = Math.round(X(v)) + 0.5; if (v === 0) { c.strokeStyle = p.axis; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); } if (x > 16 && x < right - 16) { c.fillStyle = p.muted; c.fillText((o.x.fmt || fmt.sig)(v), x, H - 5); } }
    if (o.x.label) { c.textAlign = 'right'; c.fillStyle = p.ink3; c.fillText(o.x.label, right, bottom - 5); }
    if (o.y.label) { c.textAlign = 'left'; c.fillStyle = p.ink3; c.fillText(o.y.label, left + 2, top + 2); }
    this.pts.forEach(q => {
      const col = p.color(q.color || o.color || 1), r = q.r || 3.5;
      c.globalAlpha = q.alpha ?? 0.55; c.beginPath(); c.arc(X(q.x), Y(q.y), r, 0, 7); c.fillStyle = col; c.fill(); c.globalAlpha = 1;
    });
    // opt in: y labels drawn after the points, with a surface halo, so marks never hide them
    if (o.y.labelsOver) { c.textAlign = 'left'; c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = p.surface; c.fillStyle = p.muted; for (const v of NY.ticks) { const y = Math.round(Y(v)) + 0.5, ly = y - 3 < 10 ? y + 11 : y - 3, s = (o.y.fmt || fmt.sig)(v); c.strokeText(s, left + 2, ly); c.fillText(s, left + 2, ly); } c.lineWidth = 1; }
    if (this.hi >= 0 && this.pts[this.hi]) { const q = this.pts[this.hi]; dot(c, X(q.x), Y(q.y), p.color(q.color || o.color || 1), p.surface); }
    if (this.fit) {
      const f = this.fit;
      c.save(); c.beginPath(); c.rect(left, top, right - left, bottom - top); c.clip();
      c.strokeStyle = p.ink; c.lineWidth = 2; c.beginPath(); c.moveTo(X(NX.lo), Y(f.a + f.b * NX.lo)); c.lineTo(X(NX.hi), Y(f.a + f.b * NX.hi)); c.stroke();
      c.restore();
    }
  }
  hover(x, y) {
    if (!this.pts.length || !this.X) return;
    let best = -1, bd = 24 * 24;
    this.pts.forEach((q, i) => { const dx = this.X(q.x) - x, dy = this.Y(q.y) - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
    if (best !== this.hi) { this.hi = best; this.job.now(); }
    if (best < 0) { this.hideTip(); return; }
    const q = this.pts[best], t = this.o.tip ? this.o.tip(q) : { head: '', rows: [{ value: fmt.sig(q.y), label: fmt.sig(q.x) }] };
    this.showTip(x, y, t.head, t.rows);
  }
  leave() { this.hi = -1; this.hideTip(); this.job.now(); }
}
