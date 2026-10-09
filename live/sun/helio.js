// Pure space weather logic for the nowcast page. No DOM and no network, so the
// node test suite imports this file directly. Every formula here is either a
// unit conversion, a published empirical model (cited beside it), or a rule
// NOAA states for its own scales.

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const DEG = Math.PI / 180;
const MIN = 60e3;

// ---------------------------------------------------------------- constants
export const PD_COEFF = 1.6726e-6;   // proton mass times unit conversions: nPa per (cm^-3 (km/s)^2)
export const GEO_RE = 6.6;           // geosynchronous orbit radius, Earth radii
export const RE_KM = 6371.2;         // Earth radius used for distances in Re, km
export const KP_WINDOW_MS = 3 * 3600e3;

// ---------------------------------------------------------------- time
// NOAA json/rtsw and the Kp products write time tags without a zone. They are
// UTC, so a bare tag gets a Z appended before parsing.
export function parseUTC(s) {
  if (typeof s !== 'string' || !s) return NaN;
  let x = s.trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(x)) x += 'Z';
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : NaN;
}

// ---------------------------------------------------------------- join
// Join the RTSW plasma and field files on the UTC minute. Only rows flagged
// active are used, because each file carries every spacecraft (ACE, IMAP,
// SOLAR1, ...) and only one is the operational source at a time. Time tags are
// floored to the minute since some sources stamp seconds. The join is an outer
// join: a minute with plasma but no field (or the reverse) is kept with NaN in
// the missing columns, so each chart can use every sample it has.
export function joinSolarWind(windRows, magRows, { gapMs = 5 * MIN } = {}) {
  const W = new Map(), M = new Map();
  let dupW = 0, dupM = 0;
  const take = (rows, map, valid) => {
    let dup = 0;
    for (const r of rows || []) {
      if (!r || r.active !== true) continue;
      const t = parseUTC(r.time_tag);
      if (!isNum(t)) continue;
      const k = Math.floor(t / MIN) * MIN;
      const prev = map.get(k);
      if (prev) { dup++; if (!valid(prev) && valid(r)) map.set(k, r); continue; }
      map.set(k, r);
    }
    return dup;
  };
  dupW = take(windRows, W, r => isNum(r.proton_speed) && isNum(r.proton_density));
  dupM = take(magRows, M, r => isNum(r.bz_gsm) && isNum(r.by_gsm));
  const keys = [...new Set([...W.keys(), ...M.keys()])].sort((a, b) => a - b);
  const rows = keys.map(t => {
    const w = W.get(t), m = M.get(t);
    const windSource = w ? String(w.source) : null, magSource = m ? String(m.source) : null;
    return {
      t, windSource, magSource,
      source: windSource || magSource,
      mixed: !!(windSource && magSource && windSource !== magSource),
      v: num(w?.proton_speed), n: num(w?.proton_density), T: num(w?.proton_temperature), vx: num(w?.proton_vx_gse),
      bt: num(m?.bt), bx: num(m?.bx_gsm), by: num(m?.by_gsm), bz: num(m?.bz_gsm),
      wq: w ? w.overall_quality ?? null : null, mq: m ? m.overall_quality ?? null : null,
    };
  });
  const stream = (validFn, srcKey) => {
    const ts = [], srcs = [];
    for (const r of rows) if (validFn(r)) { ts.push(r.t); srcs.push(r[srcKey]); }
    const gaps = [], changes = [];
    let longest = null;
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i] - ts[i - 1];
      if (dt > gapMs) { const g = { from: ts[i - 1], to: ts[i], missing: Math.round(dt / MIN) - 1 }; gaps.push(g); }
      if (dt > MIN && (!longest || dt / MIN - 1 > longest.missing)) longest = { from: ts[i - 1], to: ts[i], missing: Math.round(dt / MIN) - 1 };
      if (srcs[i] !== srcs[i - 1]) changes.push({ t: ts[i], from: srcs[i - 1], to: srcs[i] });
    }
    const first = ts.length ? ts[0] : NaN, last = ts.length ? ts[ts.length - 1] : NaN;
    const expected = ts.length ? Math.round((last - first) / MIN) + 1 : 0;
    return { count: ts.length, first, last, expected, missing: expected - ts.length, gaps, longest, changes, source: srcs.length ? srcs[srcs.length - 1] : null, sources: [...new Set(srcs)] };
  };
  const wind = stream(r => isNum(r.v) && isNum(r.n), 'windSource');
  const mag = stream(r => isNum(r.bz) && isNum(r.by), 'magSource');
  let matched = 0;
  for (const r of rows) if (isNum(r.v) && isNum(r.n) && isNum(r.bz) && isNum(r.by)) matched++;
  return { rows, stats: { wind, mag, matched, dupWind: dupW, dupMag: dupM, mixed: rows.filter(r => r.mixed).length } };
}

// Latest row that has both plasma and field, the sample every derived KPI uses.
export function latestJoined(rows) {
  for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (isNum(r.v) && isNum(r.n) && isNum(r.bz) && isNum(r.by)) return r; }
  return null;
}

// ---------------------------------------------------------------- plasma physics
// Proton ram pressure. Pd [nPa] = 1.6726e-6 * n [cm^-3] * v^2 [km/s]. Alpha
// particles are not included (their columns are null in these files).
export function dynamicPressure(n, v) {
  if (!isNum(n) || !isNum(v) || n < 0) return NaN;
  return PD_COEFF * n * v * v;
}

// IMF clock angle in the GSM y z plane, radians: 0 is due north, pi due south.
export function clockAngle(by, bz) {
  if (!isNum(by) || !isNum(bz)) return NaN;
  return Math.atan2(by, bz);
}

// Newell et al. (2007), J. Geophys. Res. 112, A01206:
// dPhi/dt = v^(4/3) Bt^(2/3) sin^(8/3)(theta/2), Bt = sqrt(By^2 + Bz^2) (GSM).
// With v in km/s and B in nT the result is in (km/s)^(4/3) nT^(2/3); it is
// proportional to the rate magnetic flux is opened at the dayside magnetopause.
export function newell(v, by, bz) {
  if (!isNum(v) || !isNum(by) || !isNum(bz)) return NaN;
  const bt = Math.hypot(by, bz), th = Math.atan2(by, bz);
  const s = Math.abs(Math.sin(th / 2));
  return Math.pow(Math.abs(v), 4 / 3) * Math.pow(bt, 2 / 3) * Math.pow(s, 8 / 3);
}

// Shue et al. (1998), J. Geophys. Res. 103(A8), 17691: empirical magnetopause.
// r0 = (10.22 + 1.29 tanh(0.184 (Bz + 8.14))) Pd^(-1/6.6)  [Re]
// alpha = (0.58 - 0.007 Bz)(1 + 0.024 ln Pd)
// r(theta) = r0 (2 / (1 + cos theta))^alpha, theta from the Earth Sun line.
export function shueR0(pd, bz) {
  if (!isNum(pd) || !isNum(bz) || pd <= 0) return NaN;
  return (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14))) * Math.pow(pd, -1 / 6.6);
}
export function shueAlpha(pd, bz) {
  if (!isNum(pd) || !isNum(bz) || pd <= 0) return NaN;
  return (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(pd));
}
export function shue(pd, bz) { return { r0: shueR0(pd, bz), alpha: shueAlpha(pd, bz) }; }
export function shueR(theta, r0, alpha) {
  const c = 1 + Math.cos(theta);
  if (!isNum(r0) || !isNum(alpha) || c <= 0) return NaN;
  return r0 * Math.pow(2 / c, alpha);
}
// Points of the magnetopause in the x (sunward) and rho plane, Earth radii.
export function shueCurve(r0, alpha, maxDeg = 150, stepDeg = 2) {
  const out = [];
  if (!isNum(r0) || !isNum(alpha)) return out;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += stepDeg) {
    const th = d * DEG, r = shueR(th, r0, alpha);
    out.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return out;
}

// ---------------------------------------------------------------- propagation
// Ballistic delay from the spacecraft to Earth, seconds: x_GSE [km] / |Vx| [km/s].
// Vx is the GSE x component when the file has it, else the bulk speed.
export function ballisticDelay(xKm, vx, speed) {
  const u = isNum(vx) && Math.abs(vx) > 0 ? Math.abs(vx) : isNum(speed) && speed > 0 ? speed : NaN;
  if (!isNum(xKm) || !isNum(u) || xKm <= 0) return NaN;
  return xKm / u;
}

// Ephemeris rows grouped by source, sorted by time, one row per hour.
export function indexEphemeris(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || !isNum(r.x_gse)) continue;
    const t = parseUTC(r.time_tag); if (!isNum(t)) continue;
    const s = String(r.source);
    if (!by.has(s)) by.set(s, new Map());
    by.get(s).set(t, { t, source: s, active: r.active === true, x: r.x_gse, y: num(r.y_gse), z: num(r.z_gse) });
  }
  const out = new Map();
  for (const [s, m] of by) out.set(s, [...m.values()].sort((a, b) => a.t - b.t));
  return out;
}
export function nearestEphemeris(index, source, t) {
  const a = index && index.get(String(source));
  if (!a || !a.length) return null;
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid; else hi = mid; }
  return Math.abs(a[lo].t - t) <= Math.abs(a[hi].t - t) ? a[lo] : a[hi];
}
// The newest ephemeris row flagged active, with its source.
export function activeEphemeris(index) {
  let best = null;
  if (!index) return null;
  for (const a of index.values()) for (let i = a.length - 1; i >= 0; i--) if (a[i].active) { if (!best || a[i].t > best.t) best = a[i]; break; }
  return best;
}

// Adds Pd, Newell, Shue r0 and alpha, delay (s) and arrival time (ms) to each
// joined row. The delay uses the ephemeris of the plasma's own spacecraft at
// the nearest hour. Rows are mutated and also returned.
export function derive(rows, ephIndex) {
  for (const r of rows) {
    r.pd = dynamicPressure(r.n, r.v);
    r.nw = newell(r.v, r.by, r.bz);
    r.r0 = shueR0(r.pd, r.bz);
    r.alpha = shueAlpha(r.pd, r.bz);
    const e = r.windSource ? nearestEphemeris(ephIndex, r.windSource, r.t) : null;
    r.xKm = e ? e.x : NaN;
    r.ephAge = e ? Math.abs(r.t - e.t) : NaN;
    r.delay = ballisticDelay(r.xKm, r.vx, r.v);
    r.arrival = isNum(r.delay) ? r.t + r.delay * 1000 : NaN;
  }
  return rows;
}

// The L1 sample whose ballistic arrival time is nearest to `now`. Returns null
// when no sample arrives within `tolMs` of now (a gap, or the feed is stale).
export function arrivingNow(rows, now, tolMs = 5 * MIN) {
  let best = null, bd = Infinity;
  for (const r of rows) {
    if (!isNum(r.arrival)) continue;
    const d = Math.abs(r.arrival - now);
    if (d < bd) { bd = d; best = r; }
  }
  return best && bd <= tolMs ? best : null;
}

// Trailing mean over a time window. A point gets a value only when at least
// `minN` samples fall inside its window, so a gap shows as a gap.
export function rollingMean(rows, key, windowMs, minN = 1, out = 'mean') {
  let lo = 0, sum = 0, n = 0;
  const res = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][key];
    if (isNum(v)) { sum += v; n++; }
    while (rows[lo].t <= rows[i].t - windowMs) { const u = rows[lo][key]; if (isNum(u)) { sum -= u; n--; } lo++; }
    res[i] = n >= minN ? sum / n : NaN;
    if (out) rows[i][out] = res[i];
  }
  return res;
}

// ---------------------------------------------------------------- scales
// NOAA G scale from Kp: Kp 5 is G1, 6 G2, 7 G3, 8 G4, 9 G5.
// Two readings of a fractional Kp exist, so both are implemented:
//   'strict': a threshold on the value, so 4.67 (5-) is below G1.
//   'noaa'  : round to the nearest integer first, so 4.67 (5-) is G1 and
//             5.67 (6-) is G2. This matches the noaa_scale labels NOAA itself
//             writes into products/noaa-planetary-k-index-forecast.json.
export const G_TEXT = ['none', 'minor', 'moderate', 'strong', 'severe', 'extreme'];
export function kpToG(kp, rule = 'strict') {
  if (!isNum(kp)) return NaN;
  const k = rule === 'noaa' ? Math.round(kp + 1e-9) : kp;
  if (k >= 9) return 5;
  if (k >= 8) return 4;
  if (k >= 7) return 3;
  if (k >= 6) return 2;
  if (k >= 5) return 1;
  return 0;
}
export const gLabel = g => (isNum(g) ? (g ? 'G' + g : 'G0') : '–');

// GOES 0.1 to 0.8 nm flux [W/m^2] to flare class. The letter is the decade
// (A 1e-8, B 1e-7, C 1e-6, M 1e-5, X 1e-4) and the multiplier is truncated to
// one decimal, so 1.94e-6 is C1.9 and X continues past 10 (1.23e-3 is X12.3).
const CLASSES = [['A', 1e-8], ['B', 1e-7], ['C', 1e-6], ['M', 1e-5], ['X', 1e-4]];
export function flareClass(flux) {
  if (!isNum(flux) || flux <= 0) return null;
  const level = flux < 1e-7 ? 0 : flux < 1e-6 ? 1 : flux < 1e-5 ? 2 : flux < 1e-4 ? 3 : 4;
  const [letter, base] = CLASSES[level];
  const mult = Math.floor(flux / base * 10 + 1e-6) / 10;
  return { letter, level, mult, label: letter + mult.toFixed(1) };
}
export const FLARE_EDGES = [1e-8, 1e-7, 1e-6, 1e-5, 1e-4];

// ---------------------------------------------------------------- Sun
// Subsolar point from the low precision solar coordinates in the Astronomical
// Almanac (section C): mean longitude L, mean anomaly g, ecliptic longitude
// lambda, obliquity eps, then declination and right ascension. The equation of
// time is L - RA, and the subsolar longitude is where apparent solar time is
// noon. The Almanac quotes these formulas to about 0.01 degree for 1950 to 2050.
export function subsolarPoint(date) {
  const ms = date instanceof Date ? date.getTime() : +date;
  const n = ms / 86400e3 + 2440587.5 - 2451545.0;            // days from J2000.0
  const wrap360 = x => ((x % 360) + 360) % 360;
  const wrap180 = x => { const y = wrap360(x + 180) - 180; return y; };
  const L = wrap360(280.460 + 0.9856474 * n);
  const g = wrap360(357.528 + 0.9856003 * n) * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lam)) / DEG;
  const ra = wrap360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / DEG);
  const eotDeg = wrap180(L - ra);                             // degrees, 4 min per degree
  const utH = (((ms % 86400e3) + 86400e3) % 86400e3) / 3600e3;
  const lon = wrap180(-15 * (utH - 12) - eotDeg);
  // the same longitude from sidereal time, kept as a cross check in the tests
  const gmst = wrap360(280.46061837 + 360.98564736629 * n);
  const lonSidereal = wrap180(ra - gmst);
  return { lat: decl, lon, decl, eotMin: eotDeg * 4, lonSidereal };
}

// Sun to Earth distance in astronomical units, from the same Almanac low
// precision formulas: R = 1.00014 - 0.01671 cos g - 0.00014 cos 2g.
export const AU_KM = 149597870.7;
export function sunDistanceAU(date) {
  const ms = date instanceof Date ? date.getTime() : +date;
  const n = ms / 86400e3 + 2440587.5 - 2451545.0;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  return 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
}

// ---------------------------------------------------------------- stream
// Where each plasma sample is now, under the same ballistic assumption as the
// delay: distance travelled = (now - t) * |Vx| (bulk speed if Vx is missing),
// progress = travelled / x_GSE of its spacecraft. Progress 1 is arrival.
export function streamProgress(rows, now, { maxAgeMs = 2 * 3600e3 } = {}) {
  const out = [];
  for (const r of rows) {
    if (!(r.t >= now - maxAgeMs) || r.t > now) continue;
    const u = isNum(r.vx) && Math.abs(r.vx) > 0 ? Math.abs(r.vx) : isNum(r.v) && r.v > 0 ? r.v : NaN;
    if (!isNum(u) || !isNum(r.xKm) || r.xKm <= 0) continue;
    const km = (now - r.t) / 1000 * u;
    out.push({ row: r, km, d: r.xKm, u, progress: km / r.xKm });
  }
  return out;
}

// The sunward point of the Shue magnetopause at distance rho [Re] from the
// Sun Earth line: the angle theta where r(theta) sin(theta) = rho, by bisection,
// and its x. rho = 0 gives the nose (x = r0).
export function shueAtRho(r0, alpha, rho) {
  if (!isNum(r0) || !isNum(alpha) || !isNum(rho)) return null;
  const f = th => shueR(th, r0, alpha) * Math.sin(th);
  let lo = 0, hi = 170 * DEG;
  if (rho <= 0) return { theta: 0, x: r0 };
  if (f(hi) < rho) return null;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (f(mid) < rho) lo = mid; else hi = mid; }
  const th = (lo + hi) / 2, r = shueR(th, r0, alpha);
  return { theta: th, x: r * Math.cos(th) };
}

// ---------------------------------------------------------------- OVATION
// The OVATION file is a list of [lon 0..359, lat -90..90, probability %] on a
// one degree grid. Stored by (lat + 90) * 360 + lon.
export function ovationGrid(json) {
  const grid = new Float32Array(360 * 181).fill(NaN);
  let cells = 0, max = 0;
  const co = json && Array.isArray(json.coordinates) ? json.coordinates : [];
  for (const c of co) {
    if (!Array.isArray(c) || c.length < 3) continue;
    const lon = Math.round(c[0]), lat = Math.round(c[1]), p = c[2];
    if (!isNum(p) || lon < 0 || lon > 359 || lat < -90 || lat > 90) continue;
    grid[(lat + 90) * 360 + lon] = p; cells++; if (p > max) max = p;
  }
  return {
    grid, cells, max,
    obs: parseUTC(json && json['Observation Time']),
    fc: parseUTC(json && json['Forecast Time']),
  };
}
export const lonTo360 = lon => ((Math.round(lon) % 360) + 360) % 360;
// Probability at the nearest grid cell; NaN when the grid has no value there.
export function ovationAt(grid, lat, lon) {
  if (!grid || !isNum(lat) || !isNum(lon)) return NaN;
  const la = Math.max(-90, Math.min(90, Math.round(lat)));
  const v = grid[(la + 90) * 360 + lonTo360(lon)];
  return isNum(v) ? v : NaN;
}
// Southernmost northern hemisphere latitude whose cell at this longitude has
// at least `thr` percent. NaN when no cell reaches it.
export function auroraBoundary(grid, lon, thr = 10) {
  if (!grid || !isNum(lon)) return NaN;
  const lo = lonTo360(lon);
  for (let lat = 0; lat <= 90; lat++) { const v = grid[(lat + 90) * 360 + lo]; if (isNum(v) && v >= thr) return lat; }
  return NaN;
}

// ---------------------------------------------------------------- Kp
// Forecast product rows become 3 hour windows [t0, t1).
export function kpWindows(rows) {
  const out = [];
  for (const r of rows || []) {
    const t0 = parseUTC(r && r.time_tag);
    const kp = num(r && (r.kp ?? r.Kp));
    if (!isNum(t0) || !isNum(kp)) continue;
    out.push({ t0, t1: t0 + KP_WINDOW_MS, kp, type: r.observed || 'observed', label: r.noaa_scale ?? null, a: num(r.a_running), stations: num(r.station_count) });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
export function windowAt(windows, t) {
  for (const w of windows) if (t >= w.t0 && t < w.t1) return w;
  return null;
}
// Max and mean of the 1 min estimate inside [t0, min(t1, now)].
export function windowStats(k1m, t0, t1) {
  let n = 0, s = 0, max = -Infinity, last = null;
  for (const r of k1m) if (r.t >= t0 && r.t < t1 && isNum(r.kp)) { n++; s += r.kp; if (r.kp > max) max = r.kp; last = r; }
  return { n, mean: n ? s / n : NaN, max: n ? max : NaN, last };
}
// Rows for one chart that holds three step series (one per window type) and a
// 1 min line. A boundary row carries the ending window's value for its type,
// unless a window of the same type starts there, so steps join without gaps.
export function kpChartRows(windows, k1m, from, to) {
  const times = new Set([from, to]);
  for (const w of windows) {
    if (w.t1 < from || w.t0 > to) continue;
    times.add(Math.max(from, w.t0)); times.add(Math.min(to, w.t1));
  }
  const k1 = new Map();
  for (const r of k1m) if (r.t >= from && r.t <= to && isNum(r.kp)) { k1.set(r.t, r.kp); times.add(r.t); }
  const ts = [...times].sort((a, b) => a - b);
  return ts.map(t => {
    const row = { t, k1m: k1.has(t) ? k1.get(t) : NaN, observed: NaN, estimated: NaN, predicted: NaN };
    for (const w of windows) {
      if (t < w.t0 || t > w.t1 || !(w.type in row)) continue;
      if (t < w.t1 || !isNum(row[w.type])) row[w.type] = w.kp;
    }
    return row;
  });
}

// ---------------------------------------------------------------- freshness
// fresh within `fresh` ms, late within `late`, stale beyond, unknown if no age.
export function freshness(ageMs, { fresh, late }) {
  if (!isNum(ageMs)) return 'unknown';
  if (ageMs <= fresh) return 'fresh';
  if (ageMs <= late) return 'late';
  return 'stale';
}
