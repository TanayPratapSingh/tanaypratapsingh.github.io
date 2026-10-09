// Statistical seismology for the earthquake dashboard: catalog merging with
// revision and deletion tracking, magnitude of completeness, the Aki-Utsu
// b-value with Shi and Bolt and bootstrap uncertainty, Gardner-Knopoff
// windows, an Omori-Utsu maximum likelihood fit, and a Poisson burst rule.
// No DOM and no d3, so the node test suite imports this file directly.
import { rng, quantile, poissonSf, isNum } from '../assets/util.js';

// ---------------------------------------------------------------- constants
export const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, WEEK = 7 * DAY;
export const DM = 0.1;                 // magnitude bin width
export const MAXC_CORRECTION = 0.2;    // Woessner and Wiemer (2005), added to the MAXC estimate
export const MIN_MC_EVENTS = 50;       // events needed before MAXC is attempted
export const MIN_B_EVENTS = 50;        // events at or above Mc needed for a b-value
export const BOOT_N = 200;             // bootstrap resamples
export const MIN_MAIN_MAG = 4;         // smallest candidate mainshock
export const MIN_AFTERSHOCKS = 30;     // aftershocks needed for an Omori-Utsu fit
export const DELETE_MARGIN = 10 * MIN; // an event this close to the window edge may simply have aged out
export const BURST_P = 0.001;          // Poisson tail probability that flags an hour
export const BURST_BASE_HOURS = 24;    // trailing hours whose median count is the baseline rate
export const BURST_FLOOR = 1 / 24;     // baseline floor: one event a day
export const EARTH_KM = 6371;

// ---------------------------------------------------------------- regions
// Boxes are [lonMin, latMin, lonMax, latMax]. Alaska crosses the antimeridian,
// so it is two boxes; `view` gives the map a contiguous extent in degrees east.
const inBox = (e, b) => e.lon >= b[0] && e.lon <= b[2] && e.lat >= b[1] && e.lat <= b[3];
export const REGIONS = [
  { key: 'all', label: 'All events', view: null },
  { key: 'm45', label: 'Global M4.5+', view: null, minMag: 4.5 },
  { key: 'ca', label: 'California', boxes: [[-125, 32, -114, 42.1]], view: [-125, 32, -114, 42.1] },
  { key: 'ak', label: 'Alaska', boxes: [[-180, 50, -129, 72], [170, 50, 180, 72]], view: [170, 50, 231, 72] },
  { key: 'hi', label: 'Hawaii', boxes: [[-161, 18, -154, 23]], view: [-161, 18, -154, 23] },
  { key: 'pr', label: 'Puerto Rico', boxes: [[-68.5, 17, -64.5, 19.5]], view: [-68.5, 17, -64.5, 19.5] },
];
export function regionByKey(k) { return REGIONS.find(r => r.key === k) || REGIONS[0]; }
export function inRegion(region, e) {
  if (!e) return false;
  if (region.minMag != null && !(e.mag >= region.minMag)) return false;
  if (region.boxes && !region.boxes.some(b => inBox(e, b))) return false;
  return true;
}

// ---------------------------------------------------------------- geometry
export function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------- events
function parseIds(s, id) {
  const out = typeof s === 'string' ? s.split(',').filter(Boolean) : [];
  if (id && !out.includes(id)) out.push(id);
  return out;
}
export function toEvent(f) {
  const p = f.properties || {}, g = (f.geometry && f.geometry.coordinates) || [];
  return {
    id: f.id, ids: parseIds(p.ids, f.id),
    mag: isNum(p.mag) ? p.mag : NaN, magType: p.magType || '', place: p.place || '',
    time: p.time, updated: isNum(p.updated) ? p.updated : p.time,
    status: p.status || '', type: p.type || '', net: p.net || '', url: p.url || '',
    felt: p.felt ?? null, tsunami: p.tsunami || 0, sig: p.sig ?? null,
    lon: g[0], lat: g[1], depth: g[2],
  };
}
const SNAP = ['mag', 'magType', 'status', 'depth', 'place', 'lon', 'lat', 'time', 'type', 'url'];
export function snap(e) { const o = { id: e.id }; for (const k of SNAP) o[k] = e[k]; return o; }

// Field differences between two versions of the same event.
export function diffEvent(a, b) {
  const f = [];
  const num = (x, y, tol) => (isNum(x) && isNum(y)) ? Math.abs(x - y) > tol : isNum(x) !== isNum(y);
  if (num(a.mag, b.mag, 0.005)) f.push('mag');
  if (a.magType !== b.magType) f.push('magType');
  if (a.status !== b.status) f.push('status');
  if (num(a.depth, b.depth, 0.05)) f.push('depth');
  if (a.place !== b.place) f.push('place');
  if (isNum(a.lat) && isNum(b.lat) && haversine(a.lat, a.lon, b.lat, b.lon) >= 0.5) f.push('epicenter');
  if (a.type !== b.type) f.push('type');
  return f;
}

// ---------------------------------------------------------------- catalog
export function createCatalog({ maxLog = 5000 } = {}) {
  return {
    events: new Map(),   // primary id -> event
    alias: new Map(),    // every associated id -> primary id
    gone: new Map(),     // deleted primary id -> { updated, at }
    prev: {},            // window key -> { end, ids: Map(id -> time) } from the previous fetch
    log: [],             // revisions and deletions, oldest first
    touches: [],         // updates that changed none of the tracked fields
    maxLog, version: 0, logDropped: 0,
  };
}
function index(state, e) { for (const x of e.ids) state.alias.set(x, e.id); state.events.set(e.id, e); }
function unindex(state, e) {
  for (const x of e.ids) if (state.alias.get(x) === e.id) state.alias.delete(x);
  state.events.delete(e.id);
}
function pushLog(state, rec) {
  state.log.push(rec);
  if (state.log.length > state.maxLog) { state.log.splice(0, state.log.length - state.maxLog); state.logDropped++; }
}
function findPrimary(state, e) {
  for (const x of [e.id, ...e.ids]) {
    const pid = state.alias.get(x);
    if (pid && state.events.has(pid)) return pid;
  }
  return null;
}

// Merge one feed response into the catalog.
// opts.window = { key?, span, end }: `end` is metadata.generated, `span` the
// feed's window length. Deletions are detected only for keyed windows: an id in
// the previous response with the same key, absent now under every one of its
// associated ids, and still inside the window by DELETE_MARGIN.
// opts.initial marks the first load so its events are not counted as new.
// Returns { added, revised: [{id, prevId, before, after, fields}], deleted, touched }.
export function mergeCatalog(state, features, opts = {}) {
  const win = opts.window || {};
  const now = opts.now ?? win.end ?? Date.now();
  const initial = !!opts.initial;
  const added = [], revised = [], deleted = [];
  let touched = 0;
  const present = new Set();
  for (const f of features || []) {
    if (!f || !f.id) continue;
    const e = toEvent(f);
    for (const x of e.ids) present.add(x);
    if (!isNum(e.time) || e.time < now - WEEK) continue;
    let pid = state.events.has(e.id) ? e.id : findPrimary(state, e);
    const cur = pid ? state.events.get(pid) : null;

    if (e.status === 'deleted') {
      if (cur && !(e.updated <= cur.updated)) {
        unindex(state, cur); state.gone.set(cur.id, { updated: e.updated, at: now, end: win.end, snap: snap(cur), isNew: cur.isNew });
        const rec = { kind: 'deleted', id: cur.id, at: now, time: cur.time, before: snap(cur), after: null, fields: ['deleted'], via: 'status' };
        deleted.push(rec); pushLog(state, rec);
      }
      continue;
    }
    if (!cur) {
      const g = state.gone.get(e.id);
      if (g) {
        // An older cached copy of a deleted event is ignored. The event comes
        // back only with a newer version, or in a response built after the
        // deletion was seen (so a feed glitch cannot hide an event for good).
        const newer = e.updated > g.updated || (isNum(win.end) && isNum(g.end) && win.end > g.end);
        if (!newer) continue;
        state.gone.delete(e.id);
        e.firstSeen = now; e.isNew = !!g.isNew;
        index(state, e);
        const rec = { kind: 'revised', id: e.id, prevId: null, at: now, time: e.time, before: g.snap || null, after: snap(e), fields: ['restored'] };
        revised.push(rec); pushLog(state, rec);
        continue;
      }
      e.firstSeen = now; e.isNew = !initial;
      index(state, e); added.push(e);
      continue;
    }
    if (!(e.updated > cur.updated)) continue;          // same or older version, possibly from a stale cache
    const fields = diffEvent(cur, e);
    const rekey = cur.id !== e.id;
    if (rekey) fields.unshift('id');
    e.firstSeen = cur.firstSeen; e.isNew = cur.isNew;
    unindex(state, cur); index(state, e);
    if (fields.length) {
      const rec = { kind: 'revised', id: e.id, prevId: rekey ? cur.id : null, at: now, time: e.time, before: snap(cur), after: snap(e), fields };
      revised.push(rec); pushLog(state, rec);
    } else {
      touched++;
      state.touches.push({ at: now, lon: e.lon, lat: e.lat, mag: e.mag });
      if (state.touches.length > state.maxLog * 4) state.touches.splice(0, state.touches.length - state.maxLog * 4);
    }
  }

  if (win.key && isNum(win.end) && isNum(win.span)) {
    const prev = state.prev[win.key];
    // A response no newer than the previous one (a cache serving an older copy)
    // is never compared: it would lack events added in between.
    if (!prev || win.end > prev.end) {
      if (prev) {
        const edge = win.end - win.span + DELETE_MARGIN;
        for (const [id, t] of prev.ids) {
          if (present.has(id) || !(t >= edge)) continue;
          const pid = state.events.has(id) ? id : state.alias.get(id);
          const ev = pid && state.events.get(pid);
          if (!ev || ev.ids.some(x => present.has(x))) continue;
          unindex(state, ev); state.gone.set(ev.id, { updated: ev.updated, at: now, end: win.end, snap: snap(ev), isNew: ev.isNew });
          const rec = { kind: 'deleted', id: ev.id, at: now, time: ev.time, before: snap(ev), after: null, fields: ['deleted'], via: 'absent' };
          deleted.push(rec); pushLog(state, rec);
        }
      }
      const ids = new Map();
      for (const f of features || []) if (f && f.id && f.properties) ids.set(f.id, f.properties.time);
      state.prev[win.key] = { end: win.end, ids };
    }
  }

  // keep the catalog bounded to the last seven days
  for (const [id, e] of state.events) if (e.time < now - WEEK) unindex(state, e);
  for (const [id, g] of state.gone) if (g.at < now - 2 * WEEK) state.gone.delete(id);

  if (added.length || revised.length || deleted.length || touched) state.version++;
  return { added, revised, deleted, touched };
}

// Plain language description of one log entry.
const m2 = x => isNum(x) ? String(Number(x.toFixed(2))) : '?';
export function describeChange(rec) {
  if (rec.kind === 'deleted') return [rec.via === 'status' ? 'deleted (status)' : 'deleted'];
  const a = rec.before, b = rec.after, out = [];
  for (const f of rec.fields) {
    if (f === 'restored') out.push('back after a deletion');
    else if (f === 'id') out.push('id ' + rec.prevId + ' to ' + b.id);
    else if (f === 'mag') out.push('M ' + m2(a.mag) + ' to ' + m2(b.mag));
    else if (f === 'magType') out.push((a.magType || '?') + ' to ' + (b.magType || '?'));
    else if (f === 'status') out.push((a.status || '?') + ' to ' + (b.status || '?'));
    else if (f === 'depth') out.push('depth ' + m2(a.depth) + ' to ' + m2(b.depth) + ' km');
    else if (f === 'epicenter') out.push('moved ' + haversine(a.lat, a.lon, b.lat, b.lon).toFixed(1) + ' km');
    else if (f === 'place') out.push('place renamed');
    else if (f === 'type') out.push((a.type || '?') + ' to ' + (b.type || '?'));
  }
  return out;
}

// ---------------------------------------------------------------- magnitudes
// Bin index in units of 0.1, rounding to the nearest bin. The magnitude is first
// rounded to 0.01 so floating point noise in the feed cannot flip a bin.
export function binIndex(m) { return Math.round(Math.round(m * 100) / 10); }

function maxcK(ks) {
  const c = new Map();
  for (const k of ks) c.set(k, (c.get(k) || 0) + 1);
  let best = null, bc = -1;
  for (const [k, n] of c) if (n > bc || (n === bc && k < best)) { bc = n; best = k; }
  return best;
}
// Maximum curvature: the 0.1 bin with the most events (ties go to the smaller magnitude).
export function maxc(mags) {
  const ks = mags.filter(isNum).map(binIndex);
  if (!ks.length) return null;
  const k = maxcK(ks);
  return { k, mc: k / 10, count: ks.filter(x => x === k).length };
}
// Magnitude of completeness: MAXC plus the stated correction.
export function completeness(mags, correction = MAXC_CORRECTION) {
  const ks = mags.filter(isNum).map(binIndex);
  if (ks.length < MIN_MC_EVENTS) return { ok: false, n: ks.length, need: MIN_MC_EVENTS };
  const k = maxcK(ks), kc = Math.round(correction * 10);
  return { ok: true, n: ks.length, maxc: k / 10, correction, kMc: k + kc, mc: (k + kc) / 10 };
}

function akiUtsuK(ks, kMc, dM = DM) {
  let n = 0, s = 0;
  for (const k of ks) if (k >= kMc) { n++; s += k; }
  if (n < 2) return { n };
  const mean = s / n / 10, mc = kMc / 10, denom = mean - (mc - dM / 2);
  if (!(denom > 0)) return { n };
  const b = Math.LOG10E / denom;
  let ss = 0;
  for (const k of ks) if (k >= kMc) ss += (k / 10 - mean) ** 2;
  const sigma = 2.30 * b * b * Math.sqrt(ss / (n * (n - 1)));
  return { b, sigma, a: Math.log10(n) + b * mc, n, mean, mc };
}
// Aki (1965) maximum likelihood b-value with Utsu's binning correction, using
// binned magnitudes at or above mc; Shi and Bolt (1982) standard error.
export function akiUtsu(mags, mc, dM = DM) {
  return akiUtsuK(mags.filter(isNum).map(binIndex), Math.round(mc * 10), dM);
}

// Bootstrap of the whole catalog: each resample recomputes Mc (MAXC plus the
// correction) and then b. Resamples with too few events above Mc are dropped
// and counted.
export function bootstrapB(mags, { n = BOOT_N, seed = 1, correction = MAXC_CORRECTION, minAbove = MIN_B_EVENTS } = {}) {
  const ks = mags.filter(isNum).map(binIndex), N = ks.length, kc = Math.round(correction * 10);
  const r = rng(seed), sample = new Array(N), bs = [];
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < N; j++) sample[j] = ks[Math.floor(r() * N)];
    const fit = akiUtsuK(sample, maxcK(sample) + kc);
    if (isNum(fit.b) && fit.n >= minAbove) bs.push(fit.b); else dropped++;
  }
  bs.sort((a, b) => a - b);
  return { lo: quantile(bs, 0.025), hi: quantile(bs, 0.975), n: bs.length, dropped, values: bs };
}

// Non cumulative and cumulative counts per 0.1 bin, zero filled.
export function fmd(mags) {
  const ks = mags.filter(isNum).map(binIndex);
  if (!ks.length) return [];
  let lo = Infinity, hi = -Infinity;
  const c = new Map();
  for (const k of ks) { c.set(k, (c.get(k) || 0) + 1); lo = Math.min(lo, k); hi = Math.max(hi, k); }
  const out = [];
  for (let k = lo; k <= hi; k++) out.push({ k, m: k / 10, count: c.get(k) || 0, cum: 0 });
  let acc = 0;
  for (let i = out.length - 1; i >= 0; i--) { acc += out[i].count; out[i].cum = acc; }
  return out;
}

// The whole Gutenberg-Richter pipeline for one set of magnitudes.
export function gutenbergRichter(mags, opts = {}) {
  const valid = mags.filter(isNum);
  const comp = completeness(valid, opts.correction);
  const hist = fmd(valid);
  if (!comp.ok) return { ok: false, reason: 'few', n: comp.n, need: comp.need, hist };
  const fit = akiUtsu(valid, comp.mc);
  if (!isNum(fit.b) || fit.n < MIN_B_EVENTS) {
    return { ok: false, reason: 'fewAbove', n: comp.n, nAbove: fit.n || 0, need: MIN_B_EVENTS, mc: comp.mc, maxc: comp.maxc, correction: comp.correction, hist };
  }
  const boot = bootstrapB(valid, { n: opts.boot ?? BOOT_N, seed: opts.seed ?? 1, correction: opts.correction });
  return { ok: true, n: comp.n, nAbove: fit.n, mc: comp.mc, maxc: comp.maxc, correction: comp.correction, b: fit.b, sigma: fit.sigma, a: fit.a, mean: fit.mean, boot, hist };
}

// Share of each magnitude type, largest first.
export function magTypeMix(events) {
  const c = new Map();
  for (const e of events) { const t = (e.magType || '?').toLowerCase(); c.set(t, (c.get(t) || 0) + 1); }
  const n = events.length;
  return [...c].map(([type, k]) => ({ type, k, share: n ? k / n : 0 })).sort((a, b) => b.k - a.k);
}

// ---------------------------------------------------------------- aftershocks
// Gardner and Knopoff (1974) space and time windows.
export function gkWindow(M) {
  return { km: 10 ** (0.1238 * M + 0.983), days: M >= 6.5 ? 10 ** (0.032 * M + 2.7389) : 10 ** (0.5409 * M - 0.547) };
}

// Among events with M >= minMag, the mainshock whose Gardner-Knopoff window
// holds the most later events. A candidate followed inside its own window by a
// larger event is a foreshock and is skipped.
export function findSequence(events, { minMag = MIN_MAIN_MAG } = {}) {
  const ev = events.filter(e => isNum(e.mag) && isNum(e.time) && isNum(e.lat) && isNum(e.lon)).sort((a, b) => a.time - b.time);
  let best = null, candidates = 0;
  for (let i = 0; i < ev.length; i++) {
    const m = ev[i];
    if (m.mag < minMag) continue;
    const w = gkWindow(m.mag), tEnd = m.time + w.days * DAY, after = [];
    let foreshock = false;
    for (let j = i + 1; j < ev.length && ev[j].time <= tEnd; j++) {
      const e = ev[j];
      if (haversine(m.lat, m.lon, e.lat, e.lon) > w.km) continue;
      if (e.mag > m.mag) { foreshock = true; break; }
      after.push(e);
    }
    if (foreshock) continue;
    candidates++;
    if (!best || after.length > best.after.length || (after.length === best.after.length && m.mag > best.main.mag)) best = { main: m, after, window: w };
  }
  return best ? { ...best, candidates } : { main: null, after: [], window: null, candidates };
}

export function omoriIntegral(c, p, T) {
  if (Math.abs(p - 1) < 1e-9) return Math.log((T + c) / c);
  return (Math.pow(T + c, 1 - p) - Math.pow(c, 1 - p)) / (1 - p);
}
export function logGrid(lo, hi, n) { const a = Math.log10(lo), b = Math.log10(hi); return Array.from({ length: n }, (_, i) => 10 ** (a + (b - a) * i / (n - 1))); }
export const C_GRID = logGrid(0.001, 1, 61);                                   // 20 points a decade
export const P_GRID = Array.from({ length: 81 }, (_, i) => (40 + 2 * i) / 100); // 0.40 to 2.00 by 0.02

// Omori-Utsu n(t) = K / (t + c)^p by maximum likelihood (Ogata 1983) on times
// in days over [0, T], K profiled out as n / I(c, p), grid search over c and p.
// Also returns the 95% profile likelihood range of p on the grid.
export function omoriFit(times, T, { cGrid = C_GRID, pGrid = P_GRID } = {}) {
  const t = times.filter(x => isNum(x) && x >= 0 && x <= T);
  const n = t.length;
  if (n < 2 || !(T > 0)) return null;
  let best = { logL: -Infinity };
  const prof = new Array(pGrid.length).fill(-Infinity);
  for (let ci = 0; ci < cGrid.length; ci++) {
    const c = cGrid[ci];
    let S = 0;
    for (const x of t) S += Math.log(x + c);
    for (let pi = 0; pi < pGrid.length; pi++) {
      const p = pGrid[pi], I = omoriIntegral(c, p, T);
      if (!(I > 0)) continue;
      const K = n / I, logL = n * Math.log(K) - p * S - n;
      if (logL > prof[pi]) prof[pi] = logL;
      if (logL > best.logL) best = { K, c, p, logL, ci, pi };
    }
  }
  if (!isFinite(best.logL)) return null;
  const inside = pGrid.filter((_, i) => 2 * (best.logL - prof[i]) <= 3.841);
  return {
    K: best.K, c: best.c, p: best.p, n, T, logL: best.logL,
    pLo: Math.min(...inside), pHi: Math.max(...inside),
    edge: { c: best.ci === 0 || best.ci === cGrid.length - 1, p: best.pi === 0 || best.pi === pGrid.length - 1 },
  };
}
export const omoriRate = (fit, t) => fit.K / Math.pow(t + fit.c, fit.p);

// Rate in events per day in logarithmic time bins over (t0, T]; empty bins are
// returned with rate 0 so the caller can say how many it could not plot.
export function logBinnedRate(times, T, { t0, perDecade = 4 } = {}) {
  const t = times.filter(x => isNum(x) && x > 0 && x <= T).sort((a, b) => a - b);
  if (!t.length) return [];
  const lo = t0 ?? 10 ** (Math.floor(Math.log10(t[0]) * perDecade) / perDecade);
  const out = [];
  let a = lo, j = 0;
  while (j < t.length && t[j] < a) j++;
  for (let i = 1; a < T && i < 200; i++) {
    const b = Math.min(T, lo * 10 ** (i / perDecade));
    let k = 0;
    while (j < t.length && t[j] < b) { k++; j++; }
    if (b >= T) while (j < t.length && t[j] <= T) { k++; j++; }
    if (b - a > 0) out.push({ t0: a, t1: b, t: Math.sqrt(a * b), k, rate: k / (b - a) });
    a = b;
  }
  return out;
}

// ---------------------------------------------------------------- bursts
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Counts in whole UTC hours; the last bin is the current, partial hour.
export function hourlyCounts(times, end, hours = 168) {
  const h1 = Math.floor(end / HOUR) * HOUR, start = h1 - (hours - 1) * HOUR;
  const counts = new Array(hours).fill(0);
  for (const t of times) { const i = Math.floor((t - start) / HOUR); if (i >= 0 && i < hours) counts[i]++; }
  return { start, counts };
}
// Flag hour i when P(X >= k_i) < p under a Poisson rate lambda equal to the
// median of the previous `base` hourly counts. When that median is zero the
// mean is used, and lambda never drops below `floor`. The first `base` hours
// have no full baseline and are not tested.
export function burstFlags(counts, { base = BURST_BASE_HOURS, p = BURST_P, floor = BURST_FLOOR } = {}) {
  return counts.map((k, i) => {
    if (i < base) return { k, tested: false };
    const trail = counts.slice(i - base, i);
    let lambda = median(trail), rule = 'median';
    if (lambda === 0) { lambda = trail.reduce((s, x) => s + x, 0) / base; rule = 'mean'; }
    if (lambda < floor) { lambda = floor; rule = 'floor'; }
    const sf = poissonSf(k, lambda);
    return { k, tested: true, lambda, rule, sf, flag: sf < p };
  });
}

// ---------------------------------------------------------------- one region
// Everything the page shows for one region, from the catalog alone.
export function analyze(events, region, now, opts = {}) {
  const all = [...events].filter(e => inRegion(region, e));
  const quakes = all.filter(e => e.type === 'earthquake' && isNum(e.time));
  const excluded = new Map();
  for (const e of all) if (e.type !== 'earthquake') excluded.set(e.type || 'unknown', (excluded.get(e.type || 'unknown') || 0) + 1);
  quakes.sort((a, b) => b.time - a.time);
  const withMag = quakes.filter(e => isNum(e.mag));
  const day = withMag.filter(e => e.time > now - DAY);
  const hour = quakes.filter(e => e.time > now - HOUR);
  let largest = null;
  for (const e of day) if (!largest || e.mag > largest.mag) largest = e;
  const gr = gutenbergRichter(withMag.map(e => e.mag), opts);
  const above = gr.ok ? withMag.filter(e => binIndex(e.mag) >= Math.round(gr.mc * 10)) : withMag;
  const seq = findSequence(withMag, opts);
  let omori = null, rate = [], T = NaN;
  if (seq.main) {
    T = Math.max(1e-6, (now - seq.main.time) / DAY);
    const ts = seq.after.map(e => (e.time - seq.main.time) / DAY);
    rate = logBinnedRate(ts, T);
    if (seq.after.length >= MIN_AFTERSHOCKS) omori = omoriFit(ts, T);
  }
  const hc = hourlyCounts(quakes.map(e => e.time), now, 168);
  const flags = burstFlags(hc.counts);
  return {
    region, now, quakes, withMag, excluded: [...excluded].map(([type, k]) => ({ type, k })),
    day, hour, largest, gr, mix: magTypeMix(above), mixN: above.length,
    seq, omori, rate, T, hourly: { start: hc.start, flags },
  };
}
