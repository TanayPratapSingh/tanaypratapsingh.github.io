// Pure helpers shared by every dashboard. Nothing here touches the DOM, so the
// node test suite in live/tests imports this file directly.

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const isNum = x => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------- formatting
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  int: x => isNum(x) ? nf0.format(Math.round(x)) : '–',
  compact: x => isNum(x) ? (Math.abs(x) < 10000 ? nf0.format(Math.round(x)) : nfc.format(x)) : '–',
  fixed: (x, d = 1) => isNum(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–',
  pct: (x, d = 1) => isNum(x) ? (x * 100).toFixed(d) + '%' : '–',
  signed: (x, d = 1) => isNum(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) : '–',
  sig: (x, s = 3) => isNum(x) ? Number(x.toPrecision(s)).toLocaleString('en-US', { maximumSignificantDigits: s }) : '–',
  // a duration in ms, short and human: 850 ms, 4.2 s, 3 min, 2 h 5 min
  dur(ms) {
    if (!isNum(ms)) return '–';
    const a = Math.abs(ms);
    if (a < 1000) return Math.round(ms) + ' ms';
    if (a < 60e3) return (ms / 1000).toFixed(a < 10e3 ? 1 : 0) + ' s';
    if (a < 3600e3) return Math.round(ms / 60e3) + ' min';
    const h = Math.floor(a / 3600e3), m = Math.round((a % 3600e3) / 60e3);
    return (ms < 0 ? '−' : '') + h + ' h' + (m ? ' ' + m + ' min' : '');
  },
  ago: ms => isNum(ms) ? fmt.dur(Math.max(0, ms)) + ' ago' : '–',
  time(t, utc = false, secs = true) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    const h = utc ? d.getUTCHours() : d.getHours(), m = utc ? d.getUTCMinutes() : d.getMinutes(), s = utc ? d.getUTCSeconds() : d.getSeconds();
    return p(h) + ':' + p(m) + (secs ? ':' + p(s) : '');
  },
  date(t, utc = false) {
    const d = new Date(t);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return (utc ? d.getUTCDate() : d.getDate()) + ' ' + mo[utc ? d.getUTCMonth() : d.getMonth()];
  },
};

// ---------------------------------------------------------------- containers
// Fixed capacity ring buffer; push is O(1) and old items fall off the front.
export class Ring {
  constructor(cap) { this.cap = cap; this.buf = new Array(cap); this.start = 0; this.n = 0; }
  push(x) {
    if (this.n < this.cap) { this.buf[(this.start + this.n) % this.cap] = x; this.n++; }
    else { this.buf[this.start] = x; this.start = (this.start + 1) % this.cap; }
  }
  get length() { return this.n; }
  at(i) { return i < 0 || i >= this.n ? undefined : this.buf[(this.start + i) % this.cap]; }
  last() { return this.n ? this.at(this.n - 1) : undefined; }
  toArray() { const out = new Array(this.n); for (let i = 0; i < this.n; i++) out[i] = this.at(i); return out; }
  clear() { this.start = 0; this.n = 0; }
}

// Exponentially weighted mean and variance in continuous time: a sample's weight
// halves every `halfLife` seconds, so irregular arrival times are handled correctly.
export class EWMA {
  constructor(halfLife) { this.tau = halfLife / Math.LN2; this.mean = NaN; this.var = 0; this.t = NaN; }
  update(x, tSec) {
    if (!isNum(this.mean)) { this.mean = x; this.var = 0; this.t = tSec; return this; }
    const a = 1 - Math.exp(-Math.max(0, tSec - this.t) / this.tau);
    const d = x - this.mean;
    this.mean += a * d;
    this.var = (1 - a) * (this.var + a * d * d);
    this.t = tSec;
    return this;
  }
  get std() { return Math.sqrt(this.var); }
}

// Per second event counter: bins arrivals into whole seconds and keeps `keep`
// seconds of history. Category keys let one counter hold a stacked breakdown.
export class SecondBins {
  constructor(keep = 300) { this.keep = keep; this.bins = new Map(); }
  add(tMs, key = 'n', w = 1) {
    const s = Math.floor(tMs / 1000);
    let b = this.bins.get(s);
    if (!b) { b = {}; this.bins.set(s, b); if (this.bins.size > this.keep + 5) this.trim(s); }
    b[key] = (b[key] || 0) + w;
  }
  trim(nowS) { for (const k of this.bins.keys()) if (k < nowS - this.keep) this.bins.delete(k); }
  // rows for every second in [now-keep, now), zero filled, oldest first
  rows(nowMs, keys) {
    const now = Math.floor(nowMs / 1000), out = [];
    for (let s = now - this.keep; s < now; s++) {
      const b = this.bins.get(s) || {}, r = { t: s * 1000 };
      for (const k of keys) r[k] = b[k] || 0;
      out.push(r);
    }
    return out;
  }
}

// ---------------------------------------------------------------- statistics
export function mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : NaN; }
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export function quantiles(arr, qs) { const s = Float64Array.from(arr).sort(); return qs.map(q => quantile(s, q)); }

// Ordinary least squares y = a + b x, with R squared and the slope's standard error.
export function ols(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  if (sxx === 0) return null;
  const b = sxy / sxx, a = my - b * mx;
  const sse = Math.max(0, syy - b * sxy);
  const r2 = syy === 0 ? 0 : 1 - sse / syy;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { a, b, r2, se, n };
}

// Deterministic PRNG (mulberry32) so bootstraps and tests are reproducible.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Poisson upper tail P(X >= k) for rate lam, summed in log space for stability.
export function poissonSf(k, lam) {
  if (k <= 0) return 1;
  if (lam <= 0) return 0;
  let logp = -lam, cdf = 0;
  for (let i = 0; i < k; i++) { if (i > 0) logp += Math.log(lam) - Math.log(i); cdf += Math.exp(logp); }
  return Math.max(0, 1 - cdf);
}

// ---------------------------------------------------------------- axes
// "Nice" linear ticks (1, 2, 2.5, 5 x 10^k) covering [lo, hi].
export function niceTicks(lo, hi, count = 5) {
  if (!isNum(lo) || !isNum(hi)) return { lo: 0, hi: 1, ticks: [0, 1], step: 1 };
  if (lo === hi) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const nlo = Math.floor(lo / step + 1e-9) * step, nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return { lo: nlo, hi: nhi, ticks, step };
}
export function logTicks(lo, hi) {
  const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi)), ticks = [];
  for (let k = a; k <= b; k++) ticks.push(Math.pow(10, k));
  return { lo: Math.pow(10, a), hi: Math.pow(10, b), ticks };
}
// Time ticks at a human step (seconds through days) for a span in ms.
export function timeTicks(t0, t1, count = 6) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800].map(s => s * 1000);
  const raw = (t1 - t0) / Math.max(1, count);
  const step = steps.find(s => s >= raw) || steps[steps.length - 1];
  const out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return { ticks: out, step };
}

// Index of the element of a sorted array of numbers (or of key(x)) nearest to v.
export function nearestIndex(arr, v, key = x => x) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < v) lo = mid; else hi = mid; }
  return Math.abs(key(arr[lo]) - v) <= Math.abs(key(arr[hi]) - v) ? lo : hi;
}
