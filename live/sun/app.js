// DOM wiring for the space weather nowcast: nine NOAA polls feed one state
// object; a paint job derives every KPI, footer, chart and drawing from it.
// Data handlers only mutate state and invalidate; nothing paints in a handler.
import { boot, $, h, setText, Feed, mountFeeds, poll, onPaint, initPause, tableView, mountLegend, palette } from '../assets/ui.js';
import { TimeChart } from '../assets/charts.js';
import { fmt, isNum, quantiles } from '../assets/util.js';
import * as H from './helio.js';

boot();

const BASE = 'https://services.swpc.noaa.gov/';
const MIN = 60e3, HOUR = 3600e3, DAY = 864e5, DEG = Math.PI / 180;
// How fractional Kp maps to the G scale; see kpToG in helio.js. 'noaa' matches
// the noaa_scale labels in NOAA's own forecast file, 'strict' is a threshold.
const G_RULE = 'noaa';

const LOCS = {
  syr: { name: 'Syracuse NY', lat: 43.04, lon: -76.13 },
  fai: { name: 'Fairbanks AK', lat: 64.84, lon: -147.72 },
  rey: { name: 'Reykjavik', lat: 64.15, lon: -21.94 },
  tro: { name: 'Tromso', lat: 69.65, lon: 18.96 },
  edi: { name: 'Edinburgh', lat: 55.95, lon: -3.19 },
};

// One entry per endpoint. fresh and late are sample age thresholds (ms).
const SPEC = [
  { id: 'wind', label: 'RTSW plasma', path: 'json/rtsw/rtsw_wind_1m.json', every: MIN, fresh: 10 * MIN, late: 30 * MIN, group: 'sw', sample: 'newest active plasma minute' },
  { id: 'mag', label: 'RTSW magnetic field', path: 'json/rtsw/rtsw_mag_1m.json', every: MIN, fresh: 10 * MIN, late: 30 * MIN, group: 'sw', sample: 'newest active field minute' },
  { id: 'eph', label: 'RTSW ephemerides', path: 'json/rtsw/rtsw_ephemerides_1h.json', every: 30 * MIN, fresh: 4 * HOUR, late: 12 * HOUR, group: 'sw', sample: 'newest active position' },
  { id: 'kp1m', label: 'Kp 1 min estimate', path: 'json/planetary_k_index_1m.json', every: MIN, fresh: 10 * MIN, late: 30 * MIN, group: 'kp', sample: 'newest minute' },
  { id: 'kp3h', label: 'Kp 3 hour final', path: 'products/noaa-planetary-k-index.json', every: 10 * MIN, fresh: 4 * HOUR, late: 7 * HOUR, group: 'kp', sample: 'end of the newest window' },
  { id: 'kpfc', label: 'Kp forecast', path: 'products/noaa-planetary-k-index-forecast.json', every: 30 * MIN, fresh: 3 * HOUR, late: 12 * HOUR, group: 'kp', sample: 'file Last-Modified header' },
  { id: 'scales', label: 'NOAA scales', path: 'products/noaa-scales.json', every: 10 * MIN, fresh: 3 * HOUR, late: 12 * HOUR, group: 'kp', sample: 'time stamp of the current entry' },
  { id: 'xray', label: 'GOES X-ray flux', path: 'json/goes/primary/xrays-6-hour.json', every: MIN, fresh: 10 * MIN, late: 30 * MIN, group: 'xr', sample: 'newest minute' },
  { id: 'ovation', label: 'OVATION aurora', path: 'json/ovation_aurora_latest.json', every: 5 * MIN, fresh: 20 * MIN, late: 60 * MIN, group: 'au', sample: 'Observation Time' },
];
const SPEC_BY = Object.fromEntries(SPEC.map(s => [s.id, s]));

// ---------------------------------------------------------------- state
const S = {
  raw: {}, meta: {},
  sw: [], swStats: null, eph: null, latest: null, minR0: null, arriving: null,
  k1m: new Map(), kpRev: { n: 0, last: null }, win: [], k3: [], xray: [], ov: null, scales: null,
  loc: 'syr',
};
try { const l = localStorage.getItem('sun-loc'); if (l && LOCS[l]) S.loc = l; } catch { /* storage blocked */ }

// ---------------------------------------------------------------- formatting
const p2 = n => String(n).padStart(2, '0');
const utc = t => isNum(t) ? fmt.time(t, true, false) + ' UTC' : '–';
const dt = t => isNum(t) ? fmt.date(t, true) + ' ' + fmt.time(t, true, false) : '–';
const sgn = (x, d = 1) => isNum(x) ? (x < 0 ? '−' : '') + Math.abs(x).toFixed(d) : '–';
const fx = (x, d = 1) => fmt.fixed(x, d);
const kpf = x => isNum(x) ? x.toFixed(2) : '–';
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const pow10 = v => '10' + String(Math.round(Math.log10(v))).split('').map(c => SUP[c] ?? c).join('');
const sci = (v, d = 2) => isNum(v) && v > 0 ? v.toExponential(d).replace('e-', 'e−').replace('e+', 'e') : '–';
const ageTxt = ms => isNum(ms) ? fmt.dur(Math.max(0, ms)) : '–';
const span = (t0, t1) => fmt.time(t0, true, false) + ' to ' + fmt.time(t1, true, false) + ' UTC';
function gBadge(el, g, extra = '') {
  el.className = 'badge ' + (!isNum(g) ? '' : g === 0 ? 'badge--good' : g <= 2 ? 'badge--warning' : g === 3 ? 'badge--serious' : 'badge--critical');
  el.textContent = !isNum(g) ? 'no data' : g === 0 ? 'below G1' + extra : 'G' + g + ' ' + H.G_TEXT[g] + extra;
}
// replace an element's content only when its text changes, so an open <details> or a text selection survives repaints
const parts = (el, ...kids) => {
  const ks = kids.flat(Infinity).filter(k => k != null && k !== false && k !== '');
  const t = ks.map(k => (k instanceof Node ? k.textContent : String(k))).join('');
  if (el._t === t) return;
  el._t = t; el.replaceChildren(...ks);
};
const b = x => h('b', null, x);
const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

// ---------------------------------------------------------------- feeds
class GroupFeed extends Feed {
  constructor(label, members) { super({ label, kind: 'poll' }); this.members = members; }
  setPaused(p) { this.paused = p; this.paint(); }
  view() {
    const vs = this.members.map(m => m.view());
    const order = ['error', 'connecting', 'stale', 'paused', 'live'];
    const st = order.find(o => vs.some(v => v.st === o)) || 'connecting';
    const words = { live: 'Live', stale: 'Stale', connecting: 'Connecting', error: 'Error', paused: 'Display paused' };
    const n = vs.length, k = vs.filter(v => v.st === st).length;
    if (n === 1) return { st, word: words[st], detail: vs[0].detail };
    let detail;
    if (st === 'live' || st === 'paused') {
      const ages = this.members.map(m => performance.now() - m.lastAt).filter(isNum);
      detail = n + ' feeds · newest poll ' + fmt.ago(Math.min(...ages));
    } else if (st === 'error') detail = k + ' of ' + n + ' failing · see freshness';
    else if (st === 'connecting') detail = k + ' of ' + n + ' opening';
    else detail = k + ' of ' + n + ' overdue';
    return { st, word: words[st], detail };
  }
}
const feeds = {};
for (const s of SPEC) feeds[s.id] = new Feed({ label: s.label, kind: 'poll', staleMs: 2.5 * s.every + 20e3 });
const groups = [
  new GroupFeed('Solar wind, RTSW', ['wind', 'mag', 'eph'].map(i => feeds[i])),
  new GroupFeed('Kp and NOAA scales', ['kp1m', 'kp3h', 'kpfc', 'scales'].map(i => feeds[i])),
  new GroupFeed('GOES X-ray', [feeds.xray]),
  new GroupFeed('OVATION', [feeds.ovation]),
];
mountFeeds($('#status'), groups);
initPause($('#pause'), [...Object.values(feeds), ...groups]);

// ---------------------------------------------------------------- ingest
function recomputeSW() {
  const { rows, stats } = H.joinSolarWind(S.raw.wind || [], S.raw.mag || []);
  H.derive(rows, S.eph);
  H.rollingMean(rows, 'nw', 30 * MIN, 15, 'nw30');
  S.sw = rows; S.swStats = stats;
  S.latest = H.latestJoined(rows);
  S.minR0 = null;
  const cut = Date.now() - DAY;
  for (const r of rows) if (r.t >= cut && isNum(r.r0) && (!S.minR0 || r.r0 < S.minR0.r0)) S.minR0 = r;
  stageData();
  S.meta.wind && (S.meta.wind.newest = stats.wind.last);
  S.meta.mag && (S.meta.mag.newest = stats.mag.last);
}
const handlers = {
  wind(d) { S.raw.wind = Array.isArray(d) ? d : []; recomputeSW(); },
  mag(d) { S.raw.mag = Array.isArray(d) ? d : []; recomputeSW(); },
  eph(d) {
    S.eph = H.indexEphemeris(Array.isArray(d) ? d : []);
    const a = H.activeEphemeris(S.eph);
    S.meta.eph.newest = a ? a.t : NaN; S.meta.eph.active = a;
    recomputeSW();
  },
  kp1m(d) {
    for (const r of Array.isArray(d) ? d : []) {
      const t = H.parseUTC(r.time_tag), kp = r.estimated_kp;
      if (!isNum(t) || !isNum(kp)) continue;
      // NOAA rewrites recent minutes after first publishing them; count each change
      const old = S.k1m.get(t);
      if (old !== undefined && old !== kp) { S.kpRev.n++; S.kpRev.last = { t, from: old, to: kp }; }
      S.k1m.set(t, kp);
    }
    const cut = Date.now() - DAY;
    for (const t of S.k1m.keys()) if (t < cut) S.k1m.delete(t);
    S.meta.kp1m.newest = S.k1m.size ? Math.max(...S.k1m.keys()) : NaN;
  },
  kp3h(d) { S.k3 = H.kpWindows(Array.isArray(d) ? d : []); const w = S.k3[S.k3.length - 1]; S.meta.kp3h.newest = w ? w.t1 : NaN; },
  kpfc(d, meta) {
    S.win = H.kpWindows(Array.isArray(d) ? d : []);
    const lm = Date.parse(meta.lastModified || '');
    S.meta.kpfc.newest = isNum(lm) ? lm : NaN;
  },
  scales(d) {
    S.scales = d && typeof d === 'object' ? d : null;
    const c = S.scales && S.scales['0'];
    S.meta.scales.newest = c ? H.parseUTC(c.DateStamp + 'T' + c.TimeStamp) : NaN;
  },
  xray(d) {
    const by = new Map();
    for (const r of Array.isArray(d) ? d : []) {
      const t = H.parseUTC(r.time_tag); if (!isNum(t)) continue;
      let o = by.get(t); if (!o) { o = { t, long: NaN, short: NaN, sat: null, ec: false }; by.set(t, o); }
      const f = isNum(r.flux) && r.flux > 0 ? r.flux : NaN;
      if (r.energy === '0.1-0.8nm') { o.long = f; o.sat = r.satellite; }
      else if (r.energy === '0.05-0.4nm') { o.short = f; o.ec = r.electron_contaminaton === true; }
    }
    S.xray = [...by.values()].sort((a, b2) => a.t - b2.t);
    const L = S.xray.filter(r => isNum(r.long));
    S.meta.xray.newest = L.length ? L[L.length - 1].t : NaN;
  },
  ovation(d) { S.ov = H.ovationGrid(d); S.meta.ovation.newest = S.ov.obs; mapJob.invalidate(); },
};

// ---------------------------------------------------------------- charts
const swRoot = $('#sw-panels');
function panel(title, legendItems) {
  const head = h('div', { class: 'sm__h' }, h('p', { class: 'sm__t' }, title));
  if (legendItems) { const lg = h('div', { class: 'legend' }); head.append(lg); mountLegend(lg, legendItems); }
  swRoot.append(head);
  return swRoot;
}
const smH = w => (w < 520 ? 104 : 120);
const swOpts = (aria, empty) => ({ height: smH, group: 'sw', gapMs: 5 * MIN, x: { span: DAY, utc: true }, aria, empty, stackTip: false });
const srcTip = r => [{ color: 'transparent', value: r.windSource || r.magSource || '–', label: 'source' }];
const chSpeed = new TimeChart(panel('Speed, km/s'), Object.assign(swOpts('Solar wind speed, last 24 hours', 'Waiting for RTSW plasma'), {
  y: { zero: false, minSpan: 100, ticks: 2, fmt: v => fmt.int(v) }, series: [{ key: 'v', label: 'speed', color: 1, fmt: v => fmt.int(v) + ' km/s' }], tipExtra: srcTip,
}));
const chDens = new TimeChart(panel('Density, protons per cm³'), Object.assign(swOpts('Proton density, last 24 hours', 'Waiting for RTSW plasma'), {
  y: { minSpan: 4, ticks: 2 }, series: [{ key: 'n', label: 'density', color: 1, fmt: v => fx(v, 2) + ' cm⁻³' }], tipExtra: srcTip,
}));
const chField = new TimeChart(panel('Magnetic field, nT', [{ label: 'Bz, north (+) or south (−)', color: 1 }, { label: 'Bt, total strength', color: 2 }]), Object.assign(swOpts('IMF Bz and total field, last 24 hours', 'Waiting for RTSW magnetic field'), {
  y: { minSpan: 8, ticks: 2 }, series: [{ key: 'bz', label: 'Bz', color: 1, fmt: v => sgn(v, 2) + ' nT' }, { key: 'bt', label: 'Bt total', color: 2, fmt: v => fx(v, 2) + ' nT' }],
  tipExtra: r => [{ color: 'transparent', value: r.magSource || '–', label: 'source' }],
}));
const chPd = new TimeChart(panel('Pressure, nPa'), Object.assign(swOpts('Proton dynamic pressure, last 24 hours', 'Waiting for RTSW plasma'), {
  y: { minSpan: 1, ticks: 2 }, series: [{ key: 'pd', label: 'Pd', color: 1, fmt: v => fx(v, 2) + ' nPa' }],
  tipExtra: r => [{ color: 'transparent', value: isNum(r.arrival) ? utc(r.arrival) : '–', label: 'ballistic arrival' }, ...srcTip(r)],
}));

mountLegend($('#lg-nw'), [{ label: '1 min', color: 1 }, { label: 'trailing 30 min mean', color: 2 }]);
const chNw = new TimeChart($('#nw'), {
  height: w => (w < 520 ? 200 : 240), gapMs: 5 * MIN, x: { span: DAY, utc: true }, stackTip: false,
  aria: 'Newell coupling function, last 24 hours', empty: 'Waiting for plasma and field samples',
  y: { fmt: v => fmt.int(v) },
  series: [{ key: 'nw', label: '1 min', color: 1, width: 1.25, endDot: false, fmt: v => fmt.int(v) }, { key: 'nw30', label: '30 min mean', color: 2, fmt: v => fmt.int(v) }],
});

mountLegend($('#lg-kp'), [{ label: 'Observed', color: 1 }, { label: 'Estimated', color: 3 }, { label: 'Predicted', color: 2 }, { label: '1 min estimate', color: 'ink2' }]);
const G_BANDS = [5, 6, 7, 8, 9].map((k, i) => ({ y0: k, y1: k + 1, label: 'G' + (i + 1), color: i % 2 ? 'surface' : undefined }));
const chKp = new TimeChart($('#kp'), {
  height: w => (w < 520 ? 220 : 260), x: { utc: true }, stackTip: false, bands: G_BANDS,
  aria: 'Planetary Kp, three days back to three days ahead', empty: 'Waiting for the Kp feeds',
  y: { max: 9, ticks: 5, fmt: v => String(v) },
  series: [
    { key: 'k1m', label: '1 min estimate', color: 'ink2', width: 1, fmt: kpf },
    { key: 'observed', label: 'Observed', color: 1, kind: 'step', endDot: false, fmt: kpf },
    { key: 'estimated', label: 'Estimated', color: 3, kind: 'step', endDot: false, fmt: kpf },
    { key: 'predicted', label: 'Predicted', color: 2, kind: 'step', endDot: false, fmt: kpf },
  ],
});

let xrTop = 1e-3;   // top of the X-ray chart's log axis, kept in step with the data in renderXR
mountLegend($('#lg-xr'), [{ label: '0.1 to 0.8 nm, defines the class', color: 1 }, { label: '0.05 to 0.4 nm', color: 2 }]);
const XR_BANDS = [['A', 1e-9, 1e-7], ['B', 1e-7, 1e-6], ['C', 1e-6, 1e-5], ['M', 1e-5, 1e-4], ['X', 1e-4, 1e-1]].map(([l, y0, y1], i) => ({ y0, y1, label: l, color: i % 2 ? undefined : 'surface' }));
const chXr = new TimeChart($('#xr'), {
  height: w => (w < 520 ? 240 : w < 640 ? 300 : 380), gapMs: 5 * MIN, x: { span: 6 * HOUR, utc: true }, stackTip: false, bands: XR_BANDS,
  aria: 'GOES X-ray flux, last 6 hours, log scale', empty: 'Waiting for the GOES X-ray feed',
  // the top decade's label would sit under its gridline and read as the next one, so it is left blank
  y: { log: true, floor: 1e-9, min: 1e-9, max: 1e-3, fmt: v => (v >= xrTop * 0.999 ? '' : pow10(v)) },
  series: [{ key: 'long', label: '0.1 to 0.8 nm', color: 1, endDot: false, fmt: v => sci(v) }, { key: 'short', label: '0.05 to 0.4 nm', color: 2, endDot: false, fmt: v => sci(v) }],
  tipExtra: r => [{ color: 'transparent', value: H.flareClass(r.long)?.label ?? '–', label: 'class' }],
});

// ---------------------------------------------------------------- magnetosphere drawing
const NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
  for (const k of kids) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
mountLegend($('#lg-mp'), [{ label: 'now, from the latest L1 sample', color: 1 }, { label: 'closest in 24 h', color: 'muted' }, { label: 'geostationary orbit', color: 'ink3' }]);
const mpBox = $('#mp');
function paintMP() {
  const W = Math.max(240, Math.floor(mpBox.clientWidth || 300));
  const Hh = Math.round(Math.min(400, Math.max(250, W * 0.86)));
  const cur = S.latest, mn = S.minR0;
  const root = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, role: 'img', 'aria-label': cur ? `Magnetopause standoff ${fx(cur.r0, 1)} Earth radii` : 'Magnetosphere drawing, waiting for data' });
  if (!cur || !isNum(cur.r0)) {
    root.append(sv('text', { x: W / 2, y: Hh / 2, 'text-anchor': 'middle', class: 'muted' }, S.raw.wind && S.raw.mag ? 'No minute with both plasma and field yet' : 'Waiting for plasma and field samples'));
    mpBox.replaceChildren(root); return;
  }
  const rMax = Math.max(12, cur.r0, mn ? mn.r0 : 0);
  const ex = 0.64, cx = Math.round(W * ex), cy = Math.round(Hh / 2);
  const s = (W * ex - 14) / (rMax * 1.3);           // px per Earth radius
  // text kept inside the box: about 6.3 px per character at 10.5 px mono
  const label = (x, y, t, anchor, cls) => {
    const w = t.length * 6.3;
    let x0 = anchor === 'end' ? x - w : x;
    x0 = Math.max(3, Math.min(W - 3 - w, x0));
    return sv('text', { x: x0.toFixed(1), y, class: cls }, t);
  };
  const X = x => cx - x * s, Y = y => cy - y * s;    // Sun to the left
  const line = pts => pts.map((q, i) => (i ? 'L' : 'M') + X(q[0]).toFixed(1) + ' ' + Y(q[1]).toFixed(1)).join(' ');
  // Sun Earth line and the Sun marker
  root.append(sv('line', { x1: 0, y1: cy + 0.5, x2: W, y2: cy + 0.5, stroke: 'var(--grid)', 'stroke-width': 1 }));
  root.append(sv('path', { d: `M 4 ${cy} l 9 -5 l 0 10 z`, fill: 'var(--ink-3)' }));
  root.append(sv('text', { x: 4, y: cy - 10, class: 'muted' }, 'Sun'));
  // geosynchronous orbit
  root.append(sv('circle', { cx, cy, r: H.GEO_RE * s, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 0.75 }));
  root.append(label(cx - 32, cy + H.GEO_RE * s + 13, 'GEO 6.6 Re', 'start', 'muted'));
  // the 24 h most compressed curve, then the current one
  if (mn && mn !== cur && isNum(mn.r0)) {
    root.append(sv('path', { d: line(H.shueCurve(mn.r0, mn.alpha, 165)), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
  }
  root.append(sv('path', { d: line(H.shueCurve(cur.r0, cur.alpha, 165)), fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  // Earth to scale: day half light, night half dark
  const re = s;
  root.append(sv('path', { d: `M ${cx} ${cy - re} A ${re} ${re} 0 0 0 ${cx} ${cy + re} Z`, fill: 'var(--earth-day)' }));
  root.append(sv('path', { d: `M ${cx} ${cy - re} A ${re} ${re} 0 0 1 ${cx} ${cy + re} Z`, fill: 'var(--earth-night)' }));
  root.append(sv('circle', { cx, cy, r: re, fill: 'none', stroke: 'var(--ink-2)', 'stroke-width': 1 }));
  // labels sit sunward of each curve, 45 degrees off the nose: now above, the 24 h minimum below
  root.append(sv('circle', { cx: X(cur.r0), cy, r: 2.5, fill: 'var(--s1)' }));
  const tag = (r0, alpha, deg, dy) => { const th = deg * DEG, r = H.shueR(th, r0, alpha); return [X(r * Math.cos(th)) - 6, Y(r * Math.sin(th)) + dy]; };
  const [ax, ay] = tag(cur.r0, cur.alpha, 45, -4);
  root.append(label(ax, ay, 'now ' + fx(cur.r0, 1) + ' Re', 'end'));
  if (mn && mn !== cur && isNum(mn.r0)) {
    const [bx, by] = tag(mn.r0, mn.alpha, -45, 12);
    root.append(label(bx, by, '24 h min ' + fx(mn.r0, 1), 'end', 'muted'));
  }
  // scale bar
  const sb = 5 * s, by0 = Hh - 12;
  root.append(sv('line', { x1: W - 8 - sb, y1: by0, x2: W - 8, y2: by0, stroke: 'var(--ink-2)', 'stroke-width': 1.5 }));
  root.append(sv('text', { x: W - 8, y: by0 - 5, 'text-anchor': 'end', class: 'muted' }, 'scale: 5 Re'));
  root.append(sv('text', { x: W - 6, y: 14, 'text-anchor': 'end', class: 'muted' }, 'night side'));
  mpBox.replaceChildren(root);
}

// ---------------------------------------------------------------- aurora map
const auBox = $('#au');
const auCv = h('canvas', { role: 'img', 'aria-label': 'North polar aurora probability map' });
auBox.append(auCv);
const AUR_BINS = [[1, 10, 1], [10, 30, 2], [30, 50, 3], [50, 70, 4], [70, 101, 5]];
mountLegend($('#lg-au'), [
  { label: '1 to 9%', color: 'var(--aur-1)', shape: 'rect' }, { label: '10 to 29%', color: 'var(--aur-2)', shape: 'rect' },
  { label: '30 to 49%', color: 'var(--aur-3)', shape: 'rect' }, { label: '50 to 69%', color: 'var(--aur-4)', shape: 'rect' },
  { label: '70% and up', color: 'var(--aur-5)', shape: 'rect' }, { label: 'night side', color: 'var(--night-swatch)', shape: 'rect' },
]);
let d3 = null, land = null, mapNote = 'Loading the map library';
(async () => {
  try {
    d3 = await import('https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm');
  } catch (e) { mapNote = 'The map library could not be loaded (' + (e.message || 'network') + '); the numbers below still come from the OVATION file.'; mapJob.now(); return; }
  try {
    const topo = await import('https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm');
    const r = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    land = topo.feature(j, j.objects.land);
  } catch (e) { console.warn('land outlines unavailable', e); }
  mapJob.now();
})();
function paintMap() {
  const W = Math.floor(auBox.clientWidth || 300);
  const size = Math.max(220, Math.min(W, 430));
  const dpr = devicePixelRatio || 1;
  if (auCv.width !== Math.round(size * dpr)) { auCv.width = Math.round(size * dpr); auCv.height = Math.round(size * dpr); auCv.style.width = size + 'px'; auCv.style.height = size + 'px'; }
  const c = auCv.getContext('2d'), p = palette();
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, size, size);
  const text = (t, x, y, align = 'center', col = p.ink2, font = '11px ') => {
    c.font = font + p.mono; c.textAlign = align; c.lineJoin = 'round';
    c.strokeStyle = p.surface; c.lineWidth = 3; c.strokeText(t, x, y); c.fillStyle = col; c.fillText(t, x, y);
  };
  if (!d3) { c.fillStyle = p.ink3; c.font = '12px ' + p.sans; c.textAlign = 'center'; wrapText(c, mapNote, size / 2, size / 2, size - 40); return; }
  const cs = getComputedStyle(document.documentElement);
  const aur = [0, 1, 2, 3, 4, 5].map(i => cs.getPropertyValue('--aur-' + i).trim());
  const L = LOCS[S.loc], now = Date.now();
  const clip = 52, R = size / 2 - 16;
  const proj = d3.geoOrthographic().rotate([-L.lon, -90, 0]).clipAngle(clip).scale(R / Math.sin(clip * DEG)).translate([size / 2, size / 2]).precision(0.3);
  const path = d3.geoPath(proj, c);
  c.beginPath(); path({ type: 'Sphere' }); c.fillStyle = aur[0] || p.surface; c.fill();
  // OVATION cells, one path per probability bin
  if (S.ov) {
    const g = S.ov.grid, lat0 = 90 - clip - 1;
    for (const [lo, hi, k] of AUR_BINS) {
      c.beginPath(); let any = false;
      for (let lat = lat0; lat <= 90; lat++) for (let lon = 0; lon < 360; lon++) {
        const v = g[(lat + 90) * 360 + lon];
        if (!(v >= lo && v < hi)) continue;
        const a = proj([lon - 0.5, lat - 0.5]), b2 = proj([lon + 0.5, lat - 0.5]), c2 = proj([lon + 0.5, Math.min(90, lat + 0.5)]), d = proj([lon - 0.5, Math.min(90, lat + 0.5)]);
        if (!a || !b2 || !c2 || !d) continue;
        c.moveTo(a[0], a[1]); c.lineTo(b2[0], b2[1]); c.lineTo(c2[0], c2[1]); c.lineTo(d[0], d[1]); c.closePath(); any = true;
      }
      if (any) { c.fillStyle = aur[k]; c.fill(); c.strokeStyle = aur[k]; c.lineWidth = 0.6; c.stroke(); }
    }
  }
  // night side: more than 90 degrees from the subsolar point
  const ss = H.subsolarPoint(new Date(now));
  const night = d3.geoCircle().center([ss.lon + 180, -ss.lat]).radius(90)();
  c.beginPath(); path(night); c.fillStyle = cs.getPropertyValue('--night').trim() || 'rgba(0,0,0,0.1)'; c.fill();
  c.setLineDash([3, 3]); c.strokeStyle = p.ink3; c.lineWidth = 0.75; c.stroke(); c.setLineDash([]);
  // graticule and land
  c.beginPath(); path(d3.geoGraticule().step([30, 10]).extent([[-180, 30], [180, 89.9]])()); c.strokeStyle = p.grid; c.lineWidth = 0.75; c.stroke();
  if (land) { c.beginPath(); path(land); c.strokeStyle = p.ink3; c.lineWidth = 0.8; c.stroke(); }
  c.beginPath(); path({ type: 'Sphere' }); c.strokeStyle = p.axis; c.lineWidth = 1; c.stroke();
  // latitude labels along the meridian 90 degrees east of the location
  let lastX = -1e9;
  for (const la of [50, 60, 70, 80]) { const q = proj([L.lon + 90, la]); if (q && Math.abs(q[0] - lastX) >= 34) { text(la + '°N', q[0], q[1] + 4, 'center', p.muted, '10px '); lastX = q[0]; } }
  // direction of the Sun at the rim
  const sq = proj([ss.lon, 90 - clip + 2]);
  if (sq) text('Sun', sq[0], sq[1] + 4, 'center', p.ink3, '10px ');
  // southernmost 10% latitude on the location's meridian
  if (S.ov) {
    const bl = H.auroraBoundary(S.ov.grid, L.lon);
    if (isNum(bl) && bl >= 90 - clip) {
      const q = proj([L.lon, bl]);
      c.beginPath(); c.moveTo(q[0] - 7, q[1]); c.lineTo(q[0] + 7, q[1]); c.strokeStyle = p.ink; c.lineWidth = 2; c.stroke();
      text('10% edge ' + bl + '°N', q[0] + 10, q[1] + 4, 'left', p.ink2, '10.5px ');
    }
  }
  // the selected place
  const q = proj([L.lon, L.lat]);
  if (q) {
    c.beginPath(); c.arc(q[0], q[1], 5, 0, 7); c.fillStyle = p.surface; c.fill();
    c.beginPath(); c.arc(q[0], q[1], 3.5, 0, 7); c.fillStyle = p.ink; c.fill();
    text(L.name, q[0], q[1] - 9, 'center', p.ink, '11.5px ');
  }
  if (!S.ov) text('Waiting for the OVATION file', size / 2, size / 2, 'center', p.ink3, '12px ');
}
function wrapText(c, t, x, y, maxW) {
  const words = t.split(' '), lines = []; let cur = '';
  for (const w of words) { const nx = cur ? cur + ' ' + w : w; if (c.measureText(nx).width > maxW && cur) { lines.push(cur); cur = w; } else cur = nx; }
  lines.push(cur);
  lines.forEach((l, i) => c.fillText(l, x, y + (i - (lines.length - 1) / 2) * 16));
}
const mapJob = onPaint(paintMap, 500);
new ResizeObserver(() => { mapJob.invalidate(); mainJob.invalidate(); }).observe(auBox);
new ResizeObserver(() => mainJob.invalidate()).observe(mpBox);
setInterval(() => mapJob.invalidate(), 60e3);

// ---------------------------------------------------------------- location control
function setLoc(id) {
  S.loc = id;
  for (const btn of document.querySelectorAll('#loc button')) btn.setAttribute('aria-pressed', String(btn.dataset.loc === id));
  try { localStorage.setItem('sun-loc', id); } catch { /* storage blocked */ }
  mapJob.now(); mainJob.now();
}
$('#loc').addEventListener('click', e => { const btn = e.target.closest('button[data-loc]'); if (btn) setLoc(btn.dataset.loc); });

// ---------------------------------------------------------------- the stage
// Sun to Earth: every real 1 minute plasma sample from the last 2 hours is a dot,
// placed by its own ballistic progress. Painted through onPaint at up to 20 fps,
// or once a second under prefers-reduced-motion. No allocation in the dot loop.
const stageCv = $('#stage-cv'), spotEl = $('#spot'), capEl = $('#stage .stage__cap');
const stCanvas = h('canvas', { role: 'img', tabindex: '0', 'aria-label': 'Solar wind from L1 to Earth, loading' });
const stTip = h('div', { class: 'tip', 'aria-hidden': 'true' });
stageCv.prepend(stCanvas); stageCv.append(stTip);
mountLegend($('#stage-legend'), [
  { label: 'field southward, lets energy in', color: 2, shape: 'dot' },
  { label: 'near zero', color: 'muted', shape: 'dot' },
  { label: 'northward, lets little in', color: 1, shape: 'dot' },
  { label: 'bigger dot, denser wind', color: 'ink3', shape: 'dot' },
]);
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const GOLD = 0.6180339887498949;
const MAXDOTS = 400;
const ST = {
  w: 0, h: 0, dpr: 1, mobile: false, tok: null,
  stream: [], seen: new Map(), geoRow: null, geoKey: '', curve: null,
  hx: new Float32Array(MAXDOTS), hy: new Float32Array(MAXDOTS), hi: new Int16Array(MAXDOTS), hn: 0,
  hover: null, fixed: {}, spotKey: '',
};
const hexRGB = x => { x = String(x || '#888').trim().replace('#', ''); if (x.length === 3) x = [...x].map(c => c + c).join(''); const n = parseInt(x, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
function stageTokens() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue('--' + n).trim();
  const p = palette();
  ST.tok = { sunCore: v('sun-core'), sunGlow: v('sun-glow'), bubble: v('bubble'), day: v('earth-day'), night: v('earth-night'),
    zero: hexRGB(p.muted), south: hexRGB(p.s[1]), north: hexRGB(p.s[0]) };
}
addEventListener('themechange', () => { stageTokens(); ST.geoKey = ''; });
function stageSize() {
  const w = Math.max(280, Math.floor(stageCv.clientWidth || 600));
  const hh = w < 600 ? 300 : 380, dpr = devicePixelRatio || 1;
  if (w !== ST.w || hh !== ST.h || dpr !== ST.dpr) {
    ST.w = w; ST.h = hh; ST.dpr = dpr; ST.geoKey = ''; ST.spotKey = '';
    stCanvas.width = Math.round(w * dpr); stCanvas.height = Math.round(hh * dpr); stCanvas.style.height = hh + 'px';
    ST.mobile = getComputedStyle(capEl).position === 'static';
  }
}
// diverging colour for Bz: slot 2 southward, slot 1 northward, muted grey near zero,
// full colour at 6 nT along a monotonic (|Bz| / 6)^0.7 curve so weak fields stay visible
function bzRGB(bz) {
  const t = Math.pow(Math.min(1, Math.abs(bz) / 6), 0.7), a = ST.tok.zero, e = bz < 0 ? ST.tok.south : ST.tok.north;
  return [a[0] + (e[0] - a[0]) * t, a[1] + (e[1] - a[1]) * t, a[2] + (e[2] - a[2]) * t];
}
const rgbStr = (c, al) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al.toFixed(3)})`;

// Called when the solar wind join changes: the samples that can be in flight.
function stageData() {
  const now = Date.now(), out = [];
  for (const r of S.sw) {
    if (r.t < now - 2.5 * HOUR) continue;
    const u = isNum(r.vx) && Math.abs(r.vx) > 0 ? Math.abs(r.vx) : isNum(r.v) && r.v > 0 ? r.v : NaN;
    if (!isNum(u) || !isNum(r.xKm) || !isNum(r.n)) continue;
    const m = r.t / MIN, f = (m * GOLD) % 1 - 0.5;
    out.push({ r, u, d: r.xKm, lane: f, xc: NaN, thc: 0, dc: NaN });
  }
  ST.stream = out; ST.geoKey = '';
  for (const t of ST.seen.keys()) if (t < now - 3 * HOUR) ST.seen.delete(t);
}

function stageLayout() {
  const W = ST.w, Hh = ST.h, mob = ST.mobile;
  const cy = Math.round(mob ? Hh * 0.5 : Hh * 0.6);
  const sunR = mob ? 18 : 30, sunX = mob ? 24 : 48;
  const l1X = Math.round(W * 0.25);
  const earthX = Math.round(W - Math.max(mob ? 34 : 52, W * 0.07));
  const sMag = Math.min(W * 0.16, Hh * 0.3) / 12;            // px per Earth radius around Earth
  const band = Hh * (mob ? 0.24 : 0.2);
  return { W, Hh, cy, sunR, sunX, l1X, earthX, sMag, band };
}

function paintStage() {
  stageSize();
  if (!ST.tok) stageTokens();
  const p = palette(), c = stCanvas.getContext('2d'), now = Date.now(), Ly = stageLayout();
  const { W, Hh, cy, sunR, sunX, l1X, earthX, sMag, band } = Ly;
  c.setTransform(ST.dpr, 0, 0, ST.dpr, 0, 0); c.clearRect(0, 0, W, Hh);
  const txt = (s, x, y, align, col, size = 10.5) => { c.font = size + 'px ' + p.mono; c.textAlign = align; c.fillStyle = col; c.fillText(s, x, y); };

  // magnetopause geometry: the sample reaching Earth now, else the latest one
  const g = S.arriving && isNum(S.arriving.r0) ? S.arriving : S.latest && isNum(S.latest.r0) ? S.latest : null;
  const key = (g ? g.t : 'none') + '|' + W + '|' + Hh + '|' + ST.stream.length;
  if (key !== ST.geoKey) {
    ST.geoKey = key; ST.geoRow = g;
    ST.curve = g ? H.shueCurve(g.r0, g.alpha, 160, 2).map(([x, y]) => [earthX - x * sMag, cy - y * sMag]) : null;
    for (const q of ST.stream) {
      const hit = g ? H.shueAtRho(g.r0, g.alpha, Math.abs(q.lane * band) / sMag) : null;
      if (hit) { q.xc = hit.x; q.thc = hit.theta; q.dc = q.d - hit.x * H.RE_KM; }
      else { q.xc = NaN; q.thc = 0; q.dc = q.d; }
    }
  }
  const noseX = g ? earthX - g.r0 * sMag : earthX - 10 * sMag;

  // the Sun Earth line, broken between the Sun and L1
  c.strokeStyle = p.grid; c.lineWidth = 1; c.setLineDash([3, 4]);
  c.beginPath(); c.moveTo(sunX + sunR + 6, cy + 0.5); c.lineTo(noseX - 4, cy + 0.5); c.stroke(); c.setLineDash([]);
  const bx = Math.round((sunX + sunR + l1X) / 2);
  c.strokeStyle = p.ink3; c.lineWidth = 1.2; c.beginPath();
  c.moveTo(bx - 5, cy + 6); c.lineTo(bx - 1, cy - 6); c.moveTo(bx + 1, cy + 6); c.lineTo(bx + 5, cy - 6); c.stroke();
  c.fillStyle = p.surface; c.fillRect(bx - 1, cy - 7, 2, 14);

  // the Sun: a disk with a soft glow
  const gr = c.createRadialGradient(sunX, cy, sunR * 0.6, sunX, cy, sunR * 3.2);
  gr.addColorStop(0, ST.tok.sunGlow); gr.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gr; c.beginPath(); c.arc(sunX, cy, sunR * 3.2, 0, 7); c.fill();
  c.fillStyle = ST.tok.sunCore; c.beginPath(); c.arc(sunX, cy, sunR, 0, 7); c.fill();
  txt('Sun', sunX, cy + sunR + 16, 'center', p.ink2, 11);
  ST.fixed.sun = [sunX, cy];

  // Earth's magnetic bubble, the magnetopause, geostationary orbit, Earth
  if (ST.curve) {
    c.beginPath(); ST.curve.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.lineTo(W + 10, ST.curve[ST.curve.length - 1][1]); c.lineTo(W + 10, ST.curve[0][1]); c.closePath();
    c.fillStyle = ST.tok.bubble; c.fill();
    c.beginPath(); ST.curve.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = p.ink2; c.lineWidth = 1.5; c.stroke();
    if (!ST.mobile) txt('magnetopause', noseX - 8, cy - band / 2 - 14, 'right', p.ink3);
  }
  c.strokeStyle = p.axis; c.lineWidth = 0.75; c.beginPath(); c.arc(earthX, cy, H.GEO_RE * sMag, 0, 7); c.stroke();
  const re = Math.max(3, sMag);
  c.fillStyle = ST.tok.night; c.beginPath(); c.arc(earthX, cy, re, -Math.PI / 2, Math.PI / 2); c.fill();
  c.fillStyle = ST.tok.day; c.beginPath(); c.arc(earthX, cy, re, Math.PI / 2, Math.PI * 1.5); c.fill();
  c.strokeStyle = p.ink2; c.lineWidth = 1; c.beginPath(); c.arc(earthX, cy, re, 0, 7); c.stroke();
  txt('Earth', earthX, cy + H.GEO_RE * sMag + 14, 'center', p.ink2, 11);
  ST.fixed.earth = [earthX, cy];

  // the dots
  const span = (x0, x1, km, dc) => x0 + (km / dc) * (x1 - x0);
  let n = 0, inFlight = 0;
  const hov = ST.hover && ST.hover.kind === 'dot' ? ST.hover.t : NaN;
  const sc = ST.mobile ? 0.75 : 1;
  for (let i = 0; i < ST.stream.length; i++) {
    const q = ST.stream[i], r = q.r;
    if (r.t > now) continue;
    const km = (now - r.t) / 1000 * q.u;
    if (km >= q.d) continue;                                   // arrived
    let first = ST.seen.get(r.t); if (first === undefined) { first = now; ST.seen.set(r.t, now); }
    const fade = Math.min(1, (now - first) / 700);
    const sign = q.lane < 0 ? -1 : 1, yLane = cy + q.lane * band;
    const cX = isNum(q.xc) ? earthX - q.xc * sMag : earthX - 2 * sMag;
    let x, y, al = 0.9 * fade, trail = true;
    if (km <= q.dc) { x = span(l1X, cX, km, q.dc); y = yLane; }
    else {
      const rest = q.d - q.dc, f = rest > 0 ? (km - q.dc) / rest : 1;
      if (isNum(q.xc) && ST.geoRow) {
        const th = q.thc + f * 55 * DEG, rr = H.shueR(th, ST.geoRow.r0, ST.geoRow.alpha);
        x = earthX - rr * Math.cos(th) * sMag; y = cy + sign * Math.abs(rr * Math.sin(th)) * sMag;
      } else { x = cX; y = yLane; }
      al *= Math.max(0, 1 - f); trail = false;
    }
    inFlight++;
    const rad = Math.min(9, 1.6 + 1.5 * Math.sqrt(Math.max(0, r.n))) * sc;
    const col = isNum(r.bz) ? bzRGB(r.bz) : null;
    if (trail && km > 0) {
      const kb = Math.max(0, km - q.u * 240), xb = span(l1X, cX, kb, q.dc);
      c.strokeStyle = col ? rgbStr(col, 0.28 * al) : rgbStr(hexRGB(p.ink3), 0.2 * al); c.lineWidth = Math.max(1, rad * 0.55); c.lineCap = 'round';
      c.beginPath(); c.moveTo(xb, y); c.lineTo(x, y); c.stroke();
    }
    c.beginPath(); c.arc(x, y, rad, 0, 7);
    if (col) { c.fillStyle = rgbStr(col, al); c.fill(); }
    else { c.strokeStyle = rgbStr(hexRGB(p.ink3), al); c.lineWidth = 1; c.stroke(); }
    if (r.t === hov) { c.strokeStyle = p.ink; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, rad + 3, 0, 7); c.stroke(); }
    if (n < MAXDOTS) { ST.hx[n] = x; ST.hy[n] = y; ST.hi[n] = i; n++; }
  }
  ST.hn = n; ST.inFlight = inFlight;

  // the spacecraft at L1, on top of the newest dots
  const src = (S.swStats && S.swStats.wind.source) || (S.meta.eph && S.meta.eph.active && S.meta.eph.active.source) || 'spacecraft';
  c.fillStyle = p.surface; c.fillRect(l1X - 11, cy - 4, 22, 8);
  c.fillStyle = p.ink; c.fillRect(l1X - 3.5, cy - 3.5, 7, 7);
  c.fillStyle = p.ink2; c.fillRect(l1X - 11, cy - 2, 6, 4); c.fillRect(l1X + 5, cy - 2, 6, 4);
  txt(src + ' at L1', l1X, cy - band / 2 - 14, 'center', p.ink, 11);
  ST.fixed.l1 = [l1X, cy];

  // distances, honestly labelled as not to scale
  const xKm = S.meta.eph && S.meta.eph.active ? S.meta.eph.active.x : g ? g.xKm : NaN;
  const sunKm = H.sunDistanceAU(now) * H.AU_KM - (isNum(xKm) ? xKm : 0);
  if (!ST.mobile) {
    txt(fx(sunKm / 1e6, 1) + ' million km, shortened', (sunX + sunR + l1X) / 2 + 10, cy + band / 2 + 26, 'center', p.ink3);
    if (isNum(xKm)) txt(fx(xKm / 1e6, 2) + ' million km, stretched', (l1X + noseX) / 2, cy - band / 2 - 14, 'center', p.ink3);
    txt('Not to scale; height only separates the dots', noseX - 8, Hh - 12, 'right', p.ink3);
  } else {
    txt('Not to scale: Sun to L1 ' + fx(sunKm / 1e6, 0) + ' million km,', W / 2, Hh - 24, 'center', p.ink3, 9.5);
    txt('L1 to Earth ' + (isNum(xKm) ? fx(xKm / 1e6, 2) : '–') + ' million km', W / 2, Hh - 11, 'center', p.ink3, 9.5);
  }
  if (!inFlight) txt(S.sw.length && !S.eph ? 'Waiting for the spacecraft position' : 'Loading the last 2 hours of solar wind', (l1X + noseX) / 2, cy + 4, 'center', p.ink3, 12);

  placeSpot(Ly);
}

// The countdown callout sits under L1 on wide screens; CSS makes it static on phones.
function placeSpot(Ly) {
  if (spotEl.hidden) return;
  const k = ST.mobile + '|' + Ly.W + '|' + Ly.Hh;
  if (k === ST.spotKey) return;
  ST.spotKey = k;
  if (ST.mobile) { spotEl.style.left = ''; spotEl.style.top = ''; return; }
  spotEl.style.left = Math.max(8, Math.min(Ly.W - 290, Ly.l1X - 16)) + 'px';
  spotEl.style.top = Math.round(Math.min(Ly.cy + Ly.band / 2 + 12, Ly.Hh - spotEl.offsetHeight - 8)) + 'px';
}

function stageTip(x, y) {
  let best = null, bd = 24 * 24;
  for (let k = 0; k < ST.hn; k++) { const dx = ST.hx[k] - x, dy = ST.hy[k] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { kind: 'dot', q: ST.stream[ST.hi[k]] }; } }
  for (const [kind, pt] of Object.entries(ST.fixed)) { const dx = pt[0] - x, dy = pt[1] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { kind }; } }
  if (!best) { ST.hover = null; stTip.style.display = 'none'; return; }
  const row = (value, label) => h('div', { class: 'tip__r' }, h('i', { style: { background: 'transparent' } }), h('b', null, value), h('span', null, label));
  let head = '', rows = [];
  if (best.kind === 'dot') {
    const r = best.q.r; ST.hover = { kind: 'dot', t: r.t };
    const bzw = isNum(r.bz) ? (r.bz < 0 ? 'southward ' : r.bz > 0 ? 'northward ' : '') + fx(Math.abs(r.bz), 1) + ' nT' : 'no field sample';
    head = 'Measured ' + utc(r.t) + ' at ' + (r.windSource || '–');
    rows = [row(fmt.int(r.v) + ' km/s', 'speed'), row(fx(r.n, 2) + ' per cm³', 'density'), row(bzw, 'field'),
      row(isNum(r.arrival) ? utc(r.arrival) : '–', 'reaches Earth, ballistic'), row(fmt.int(Math.min(100, (Date.now() - r.t) / 1000 * best.q.u / best.q.d * 100)) + '%', 'of the way')];
  } else if (best.kind === 'l1') {
    ST.hover = { kind: 'l1' };
    const a = S.meta.eph && S.meta.eph.active;
    head = (a ? a.source : 'Spacecraft') + ' at L1';
    rows = [row(a ? fmt.int(a.x) + ' km' : '–', 'sunward of Earth (x_GSE)'), row(a ? utc(a.t) : '–', 'position time')];
  } else if (best.kind === 'sun') {
    ST.hover = { kind: 'sun' };
    const a = S.meta.eph && S.meta.eph.active;
    head = 'The Sun';
    rows = [row(fx((H.sunDistanceAU(Date.now()) * H.AU_KM - (a ? a.x : 0)) / 1e6, 1) + ' million km', 'from L1 today'), row('not to scale', 'drawn far closer')];
  } else {
    ST.hover = { kind: 'earth' };
    const gg = ST.geoRow;
    head = 'Earth and its magnetopause';
    rows = [row(gg ? fx(gg.r0, 1) + ' Re' : '–', 'edge toward the Sun'), row(gg ? utc(gg.t) : '–', 'from wind measured at'), row('not to scale', 'drawn larger')];
  }
  stTip.replaceChildren(h('div', { class: 'tip__h' }, head), ...rows);
  stTip.style.display = 'block';
  const tw = stTip.offsetWidth, th = stTip.offsetHeight;
  let left = x + 14; if (left + tw > ST.w) left = x - tw - 14; left = Math.max(0, Math.min(ST.w - tw, left));
  let top = y - th - 10; if (top < 0) top = y + 14;
  stTip.style.left = left + 'px'; stTip.style.top = top + 'px';
}
stCanvas.addEventListener('pointermove', e => { const R = stCanvas.getBoundingClientRect(); stageTip(e.clientX - R.left, e.clientY - R.top); stageJob.now(); });
stCanvas.addEventListener('pointerleave', () => { ST.hover = null; stTip.style.display = 'none'; stageJob.now(); });
stCanvas.addEventListener('blur', () => { ST.hover = null; stTip.style.display = 'none'; });
const stageJob = onPaint(() => { paintStage(); if (!RM.matches) stageJob.invalidate(); }, 50);
new ResizeObserver(() => { stageSize(); stageJob.now(); }).observe(stageCv);
setInterval(() => { if (RM.matches) stageJob.invalidate(); }, 1000);

function renderStage(now) {
  const L = S.latest;
  // the countdown follows the latest joined sample, else the newest plasma sample
  let nw = L && isNum(L.arrival) ? L : null;   // same joined sample as the foot and the tiles
  if (!nw) for (let i = S.sw.length - 1; i >= 0; i--) { const r = S.sw[i]; if (isNum(r.v) && isNum(r.arrival)) { nw = r; break; } }
  if (nw) {
    const mins = Math.round((nw.arrival - now) / MIN);
    spotEl.hidden = false;
    setText('#spot-v', mins > 0 ? 'in ' + mins + ' min' : 'arriving now');
    setText('#spot-t', 'Wind measured at ' + utc(nw.t) + ' reaches Earth at about ' + utc(nw.arrival) + '.');
    stCanvas.setAttribute('aria-label', 'Solar wind from ' + (nw.windSource || 'L1') + ' to Earth: ' + (ST.inFlight || 0) + ' minutes of wind in flight; the newest, measured ' + utc(nw.t) + ', arrives about ' + utc(nw.arrival) + '.');
  }
  const foot = $('#stage-foot');
  if (L) {
    const gg = ST.geoRow;
    const bzw = L.bz < 0 ? 'southward ' : L.bz > 0 ? 'northward ' : '';
    // the three L1 readings share one timestamp; the magnetopause drawn on the stage comes
    // from the wind reaching Earth now, measured about an hour earlier, so it says so
    const arriving = gg && gg === S.arriving && gg.t !== L.t;
    parts(foot,
      h('span', null, 'Speed ', b(fmt.int(L.v) + ' km/s')),
      h('span', null, 'Density ', b(fx(L.n, 1) + ' per cm³')),
      h('span', null, 'Field ', b(bzw + fx(Math.abs(L.bz), 1) + ' nT')),
      h('span', { class: 'muted' }, 'measured at L1, ' + utc(L.t)),
      gg ? h('span', null, 'Magnetopause ', b(fx(gg.r0, 1) + ' Earth radii'), arriving ? ' out, for the wind reaching Earth now (measured ' + utc(gg.t) + ')' : ' out') : null);
  }
}

// ---------------------------------------------------------------- render
function stale(id, now) {
  const m = S.meta[id], sp = SPEC_BY[id];
  if (!m || !isNum(m.newest)) return '';
  const age = now - m.newest;
  return age > sp.late ? ' (stale, ' + ageTxt(age) + ' old)' : '';
}
const flareWord = c => (c ? (c.level <= 2 ? 'small' : c.level === 3 ? 'medium' : 'large') : '');
function renderKPIs(now) {
  const L = S.latest;
  const ks = [...S.k1m.entries()].sort((a, b2) => a[0] - b2[0]);
  const kl = ks.length ? ks[ks.length - 1] : null;
  setText('#kv-kp', kl ? kpf(kl[1]) : '–');
  if (kl) gBadge($('#kv-g'), H.kpToG(kl[1], G_RULE));
  const cw = H.windowAt(S.win, now);
  if (kl || S.win.length) setText('#ks-kp', (cw ? 'NOAA forecast for this 3 hour window: ' + kpf(cw.kp) : 'no NOAA value for this window') + stale('kp1m', now));
  if (L) {
    setText('#kv-v', fmt.int(L.v)); setText('#ks-v', 'at L1, measured ' + utc(L.t) + stale('wind', now));
    setText('#kv-n', fx(L.n, 1)); setText('#ks-n', 'protons; denser wind pushes harder');
    setText('#kv-bz', sgn(L.bz, 1));
    setText('#ks-bz', (L.bz <= -0.5 ? 'southward, lets energy in' : L.bz >= 0.5 ? 'northward, lets little in' : 'near zero') + stale('mag', now));
    setText('#kv-pd', fx(L.pd, 2)); setText('#ks-pd', "pushes Earth's magnetic field inward");
    setText('#kv-r0', fx(L.r0, 1));
    setText('#ks-r0', L.r0 < H.GEO_RE ? 'Earth radii, inside geostationary orbit (6.6)' : 'Earth radii; geostationary satellites orbit at 6.6');
    if (isNum(L.delay)) { setText('#kv-dl', fmt.int(L.delay / 60)); setText('#ks-dl', 'from ' + L.windSource + ', ' + fx(L.xKm / 1e6, 2) + ' million km out'); }
    else { setText('#kv-dl', '–'); setText('#ks-dl', S.eph ? 'no position for ' + L.windSource : 'loading'); }
  } else if (S.raw.wind && S.raw.mag) for (const k of ['v', 'n', 'bz', 'pd', 'r0', 'dl']) setText('#ks-' + k, 'no joined minute yet');
  const xl = S.xray.filter(r => isNum(r.long)), xn = xl[xl.length - 1];
  if (xn) { const fc = H.flareClass(xn.long); setText('#kv-xr', fc.label); setText('#ks-xr', flareWord(fc) + ' on the A, B, C, M, X scale' + stale('xray', now)); }
  const loc = LOCS[S.loc];
  setText('#kl-au', 'Aurora, ' + loc.name);
  if (S.ov) {
    const pr = H.ovationAt(S.ov.grid, loc.lat, loc.lon);
    setText('#kv-au', isNum(pr) ? fmt.int(pr) : '–');
    setText('#ks-au', 'chance overhead, OVATION, for ' + utc(S.ov.fc) + stale('ovation', now));
  }
}

function renderSW(now) {
  const rows = S.sw, st = S.swStats;
  S.arriving = rows.length ? H.arrivingNow(rows, now) : null;
  const vl = S.arriving ? [{ t: S.arriving.t, label: 'reaching Earth now' }] : [];
  chSpeed.set(rows.filter(r => isNum(r.v)), { now, vlines: vl });
  chDens.set(rows.filter(r => isNum(r.n)), { now, vlines: vl });
  chField.set(rows.filter(r => isNum(r.bz)), { now, vlines: vl });
  chPd.set(rows.filter(r => isNum(r.pd)), { now, vlines: vl });
  if (!st) return;
  const L = S.latest;
  if (L) parts($('#f-sw'), 'Wind at ', b(fmt.int(L.v) + ' km/s'), ' with the field ', b((L.bz < 0 ? 'southward ' : 'northward ') + fx(Math.abs(L.bz), 1) + ' nT'), '. ',
    S.arriving ? ['What reaches Earth now left L1 at ', b(utc(S.arriving.t)), '.'] : 'No sample is reaching Earth this minute (a data gap).', stale('wind', now));
  const wsrc = st.wind.source, msrc = st.mag.source;
  const srcTxt = wsrc && wsrc === msrc ? 'Active source ' + wsrc + ' for plasma and field' : 'Active sources: plasma ' + (wsrc || 'none') + ', field ' + (msrc || 'none');
  const ch = [...st.wind.changes.map(c => ['plasma', c]), ...st.mag.changes.map(c => ['field', c])];
  const chTxt = ch.length ? ch.map(([k, c]) => k + ' switched ' + c.from + ' to ' + c.to + ' at ' + dt(c.t) + ' UTC').join('; ') : 'no change of active spacecraft in the file';
  const lg = [st.wind.longest && ['plasma', st.wind.longest], st.mag.longest && ['field', st.mag.longest]].filter(Boolean).sort((a, b2) => b2[1].missing - a[1].missing)[0];
  parts($('#h-sw'),
    srcTxt, '; ', chTxt, '. Coverage over 24 h: plasma ', fmt.int(st.wind.count) + ' of ' + fmt.int(st.wind.expected), ' minutes, field ', fmt.int(st.mag.count) + ' of ' + fmt.int(st.mag.expected),
    '. Gaps longer than 5 min: ', pl(st.wind.gaps.length, 'plasma gap'), ' and ', pl(st.mag.gaps.length, 'field gap'),
    lg ? ' (longest ' + lg[1].missing + ' min of ' + lg[0] + ' after ' + utc(lg[1].from) + ')' : '', '. ',
    S.arriving ? 'The line marks the ' + utc(S.arriving.t) + ' sample, whose ballistic arrival is ' + utc(S.arriving.arrival) + '.'
      : (S.eph ? 'No sample has a ballistic arrival within 5 min of now, so no line is drawn.' : 'Waiting for the ephemeris file.'));
}

function renderMP(now) {
  paintMP();
  const L = S.latest, mn = S.minR0, list = $('#mp-stats');
  if (!L || !isNum(L.r0)) { list.replaceChildren(); return; }
  const row = (k, v) => h('div', { class: 'row' }, h('span', { class: 'row__l' }, k), h('span', { class: 'row__v' }, v));
  parts(list,
    row('edge toward the Sun (r0)', fx(L.r0, 2) + ' Re'),
    row('flank flaring (alpha)', fx(L.alpha, 3)),
    row('pressure, field Bz', fx(L.pd, 2) + ' nPa, ' + sgn(L.bz, 1) + ' nT'),
    row('measured, reaches Earth', utc(L.t) + ', ' + (isNum(L.arrival) ? utc(L.arrival) : '–')),
    row('closest in 24 h', mn ? fx(mn.r0, 2) + ' Re at ' + utc(mn.t) : '–'));
  const gap = L.r0 - H.GEO_RE;
  parts($('#f-mp'), L.r0 < H.GEO_RE
    ? ['The edge is ', b(fx(L.r0, 1) + ' Earth radii'), ' out, inside geostationary orbit. Satellites there near local noon face the solar wind directly.']
    : ['The edge sits ', b(fx(L.r0, 1) + ' Earth radii'), ' out, ', fx(gap, 1), ' beyond the orbit of geostationary satellites.']);
  parts($('#h-mp'), 'Inputs: Pd ', fx(L.pd, 2), ' nPa and Bz ', sgn(L.bz, 1), ' nT, measured at ', utc(L.t), '. Closest in 24 h: ', mn ? fx(mn.r0, 2) + ' Re at ' + dt(mn.t) + ' UTC (Pd ' + fx(mn.pd, 2) + ', Bz ' + sgn(mn.bz, 1) + ').' : '–.');
}

function renderNW(now) {
  const rows = S.sw.filter(r => isNum(r.nw));
  chNw.set(rows, { now });
  if (!rows.length) return;
  const day = rows.filter(r => r.t >= now - DAY).map(r => r.nw);
  const [med] = quantiles(day, [0.5]);
  let mx = rows[0]; for (const r of rows) if (r.nw > mx.nw) mx = r;
  const last = rows[rows.length - 1], ref = isNum(last.nw30) ? last.nw30 : last.nw;
  const ratio = med > 0 ? ref / med : NaN;
  parts($('#f-nw'), 'Energy input is ', b(isNum(ratio) ? fx(ratio, 1) + ' times' : '–'), ' its median for the past day, with the field pointing ', last.bz < 0 ? 'south.' : 'north.');
  parts($('#h-nw'), 'Now ', fmt.int(last.nw), ' at ', utc(last.t), ', 30 minute mean ', fmt.int(last.nw30), '; 24 h median ', fmt.int(med), ', maximum ', fmt.int(mx.nw), ' at ', utc(mx.t), ', all in (km/s)^(4/3) nT^(2/3).');
}

function renderKP(now) {
  const from = now - 3 * DAY, to = now + 3 * DAY;
  const k1 = [...S.k1m.entries()].map(([t, kp]) => ({ t, kp })).sort((a, b2) => a.t - b2.t);
  const rows = (S.win.length || k1.length) ? H.kpChartRows(S.win, k1, from, to) : [];
  chKp.set(rows, { now, vlines: [{ t: now, label: 'now' }] });
  if (!S.win.length && !k1.length) return;
  const cw = H.windowAt(S.win, now);
  const st = cw ? H.windowStats(k1, cw.t0, cw.t1) : null;
  const fin = S.k3[S.k3.length - 1];
  const ahead = S.win.filter(w => w.t1 > now && w.type === 'predicted');
  let pk = null; for (const w of ahead) if (!pk || w.kp > pk.kp) pk = w;
  const kl = k1[k1.length - 1];
  const gNow = kl ? H.kpToG(kl.kp, G_RULE) : NaN, gPk = pk ? H.kpToG(pk.kp, G_RULE) : NaN;
  parts($('#f-kp'),
    kl ? (gNow > 0 ? ['Storm level now: ', b('Kp ' + kpf(kl.kp)), ', G' + gNow + ' (' + H.G_TEXT[gNow] + '). '] : [b('Kp ' + kpf(kl.kp)), ' now, below storm level (5). ']) : '',
    pk ? (gPk > 0 ? ['NOAA forecasts up to ', b('Kp ' + kpf(pk.kp)), ', a G' + gPk + ' (' + H.G_TEXT[gPk] + ') storm, around ', fmt.time(pk.t0, true, false), ' UTC on ', fmt.date(pk.t0, true), '.']
      : ['NOAA forecasts no storm in the next 3 days (highest Kp ', kpf(pk.kp), ').']) : '');
  const sc = S.scales;
  const gDays = sc ? ['1', '2', '3'].map(k => sc[k]).filter(x => x && x.G && x.G.Scale != null && x.G.Scale !== '0').map(x => 'G' + x.G.Scale + ' ' + (x.G.Text || '') + ' predicted for ' + x.DateStamp) : [];
  parts($('#h-kp'),
    cw ? ['NOAA value for ', span(cw.t0, cw.t1), ': Kp ', kpf(cw.kp), ', marked ', cw.type, ' in the file. The 1 min estimate so far in this window: max ', kpf(st.max), ', mean ', kpf(st.mean), ' over ', String(st.n), ' minutes. '] : 'No forecast row covers the current window. ',
    fin ? 'Latest final 3 hour Kp: ' + kpf(fin.kp) + ' for ' + span(fin.t0, fin.t1) + (isNum(fin.stations) ? ' from ' + fin.stations + ' stations' : '') + '. ' : '',
    pk && pk.label ? 'NOAA labels the highest predicted window ' + pk.label + '. ' : '',
    gDays.length ? 'NOAA scales file: ' + gDays.join('; ') + '. ' : '',
    S.kpRev.n ? 'NOAA has rewritten ' + pl(S.kpRev.n, 'minute') + ' of the 1 min estimate since this page opened (latest ' + utc(S.kpRev.last.t) + ', ' + kpf(S.kpRev.last.from) + ' to ' + kpf(S.kpRev.last.to) + ').' : 'No rewrites of the 1 min estimate seen since this page opened.');
}

function renderXR(now) {
  let fmax = 1e-3;
  for (const r of S.xray) if (r.t >= now - 6 * HOUR) { if (r.long > fmax) fmax = r.long; if (r.short > fmax) fmax = r.short; }
  xrTop = Math.pow(10, Math.ceil(Math.log10(fmax) - 1e-9));
  chXr.set(S.xray, { now });
  const xl = S.xray.filter(r => isNum(r.long) && r.t >= now - 6 * HOUR);
  if (!xl.length) return;
  const xn = xl[xl.length - 1];
  let mx = xl[0]; for (const r of xl) if (r.long > mx.long) mx = r;
  const cn = H.flareClass(xn.long), cm = H.flareClass(mx.long);
  parts($('#f-xr'), 'The Sun is at ', b(cn.label), ', a ', flareWord(cn), ' level. The largest flare in 6 hours was ', b(cm.label), ' at ', utc(mx.t), '.', stale('xray', now));
  const ec = S.xray.filter(r => r.ec).length;
  const sats = [...new Set(xl.map(r => r.sat))].map(s => 'GOES-' + s).join(', ');
  const sc = S.scales;
  const r0 = sc && sc['0'] && sc['0'].R, r1 = sc && sc['-1'] && sc['-1'].R;
  parts($('#h-xr'), 'Now ', sci(xn.long), ' W/m² at ', utc(xn.t), ' from ', sats, '. ',
    r0 ? 'NOAA radio blackout scale in the scales file: R' + r0.Scale + ' latest, R' + (r1 ? r1.Scale + (r1.Text && r1.Text !== 'none' ? ' ' + r1.Text : '') : '?') + ' as the 24 h maximum. ' : '',
    ec ? ec + ' short channel minutes are flagged for electron contamination.' : '');
}

function renderAU(now) {
  const L = LOCS[S.loc];
  if (!S.ov) return;
  const pr = H.ovationAt(S.ov.grid, L.lat, L.lon), bl = H.auroraBoundary(S.ov.grid, L.lon);
  const lead = S.ov.fc - S.ov.obs;
  parts($('#f-au'), b(isNum(pr) ? fmt.int(pr) + '%' : 'No value'), ' chance overhead in ', L.name, '. ',
    !isNum(bl) ? 'No part of the oval at this longitude reaches 10%.'
      : bl <= Math.round(L.lat) ? ['The place is inside the oval; its southern edge here is ', b(bl + '°N'), '.']
        : ['The southern edge of the aurora at this longitude is ', b(bl + '°N'), ', ', String(Math.round(bl - L.lat)), ' degrees farther north.'],
    stale('ovation', now));
  parts($('#h-au'), 'Nearest cell ', Math.round(L.lat) + '°N ' + H.lonTo360(L.lon) + '°E. The file says observation ', dt(S.ov.obs), ' UTC, forecast for ', dt(S.ov.fc), ' UTC', isNum(lead) ? ' (' + fmt.dur(lead) + ' ahead)' : '', '. Highest cell in the file: ', fmt.int(S.ov.max), '%.');
}

function renderFresh(now) {
  const tv = $('#fr');
  const st = S.swStats;
  const cols = ['Feed', 'Every', 'Fetched', 'Newest sample', 'Age', 'Status', 'Fresh / late', 'Notes'];
  const tally = { fresh: 0, late: [], stale: [], other: [] };
  const body = SPEC.map(sp => {
    const m = S.meta[sp.id], fd = feeds[sp.id];
    const age = m && isNum(m.newest) ? now - m.newest : NaN;
    const fv = fd.view();
    let cls = '', word = 'loading';
    if (fv.st === 'error') { cls = 'badge--critical'; word = 'error'; tally.other.push(sp.label); }
    else if (m) {
      const fr = H.freshness(age, sp); word = fr === 'unknown' ? 'no sample' : fr;
      cls = { fresh: 'badge--good', late: 'badge--warning', stale: 'badge--serious', unknown: 'badge--serious' }[fr];
      if (fr === 'fresh') tally.fresh++; else if (fr === 'late') tally.late.push(sp.label); else tally.stale.push(sp.label);
    }
    let note = sp.sample;
    if ((sp.id === 'wind' || sp.id === 'mag') && st) {
      const s2 = sp.id === 'wind' ? st.wind : st.mag;
      note = 'active ' + (s2.source || 'none') + '; ' + fmt.int(s2.count) + ' of ' + fmt.int(s2.expected) + ' minutes; ' + (s2.changes.length ? s2.changes.length + ' source change(s)' : 'no source change');
    } else if (sp.id === 'eph' && m && m.active) note = 'active ' + m.active.source + ', x_GSE ' + fmt.int(m.active.x) + ' km';
    else if (sp.id === 'kp3h' && S.k3.length) { const w = S.k3[S.k3.length - 1]; note = 'window ' + span(w.t0, w.t1) + (isNum(w.stations) ? ', ' + w.stations + ' stations' : ''); }
    else if (sp.id === 'kpfc' && S.win.length) note = 'age from Last-Modified; ' + S.win.filter(w => w.type === 'predicted').length + ' predicted windows';
    else if (sp.id === 'xray' && S.xray.length) note = 'satellite ' + S.xray[S.xray.length - 1].sat;
    else if (sp.id === 'ovation' && S.ov) note = 'age from Observation Time; forecast for ' + utc(S.ov.fc);
    else if (sp.id === 'scales' && S.scales && S.scales['0']) note = 'entry dated ' + S.scales['0'].DateStamp + ' ' + S.scales['0'].TimeStamp;
    else if (sp.id === 'kp1m') note = S.k1m.size + ' minutes held (file carries about 6 h); ' + pl(S.kpRev.n, 'rewritten minute');
    if (fv.st === 'error') note = fd.err + '; ' + note;
    return h('tr', null,
      h('td', { class: 'l' }, h('a', { href: BASE + sp.path, rel: 'noopener' }, sp.label)),
      h('td', null, fmt.dur(sp.every)),
      h('td', null, m ? fmt.ago(now - m.polledAt) : '–'),
      h('td', null, m && isNum(m.newest) ? dt(m.newest) + ' UTC' : '–'),
      h('td', null, ageTxt(age)),
      h('td', { class: 'l' }, h('span', { class: 'badge ' + cls }, word)),
      h('td', null, fmt.dur(sp.fresh) + ' / ' + fmt.dur(sp.late)),
      h('td', { class: 'note' }, note));
  });
  tv.replaceChildren(h('table', null,
    h('thead', null, h('tr', null, cols.map((c, i) => h('th', { scope: 'col', class: [0, 5, 7].includes(i) ? 'l' : null }, c)))),
    h('tbody', null, body)));
  const n = SPEC.length, bad = [...tally.late.map(l => l + ' is late'), ...tally.stale.map(l => l + ' is stale'), ...tally.other.map(l => l + ' failed to load')];
  if (tally.fresh + bad.length) parts($('#f-fr'), tally.fresh === n ? ['All ', b(String(n)), ' feeds are current.'] : [b(tally.fresh + ' of ' + n), ' feeds are current; ', bad.join(', '), '.']);
}

function render() {
  const now = Date.now();
  renderKPIs(now); renderSW(now); renderStage(now); renderMP(now); renderNW(now); renderKP(now); renderXR(now); renderAU(now); renderFresh(now);
}
const mainJob = onPaint(render, 400);
setInterval(() => mainJob.invalidate(), 10e3);

// ---------------------------------------------------------------- table views
const C = (key, label, f, left) => ({ key, label, fmt: f, left });
const last3h = rows => rows.filter(r => r.t >= Date.now() - 3 * HOUR).reverse();
tableView($('#c-sw'), () => ({
  cols: [C('t', 'UTC, last 3 h', dt, true), C('source', 'Source', null, true), C('v', 'Speed km/s', fmt.int), C('n', 'Density cm⁻³', v => fx(v, 2)), C('bz', 'Bz nT', v => sgn(v, 2)), C('bt', 'Bt nT', v => fx(v, 2)), C('pd', 'Pd nPa', v => fx(v, 2)), C('arrival', 'Ballistic arrival', v => isNum(v) ? fmt.time(v, true, false) : '–')],
  rows: last3h(S.sw),
}));
tableView($('#c-mp'), () => {
  const rows = [];
  if (S.latest) rows.push(Object.assign({ which: 'latest sample' }, S.latest));
  if (S.minR0) rows.push(Object.assign({ which: '24 h minimum' }, S.minR0));
  const hourly = new Map();
  for (const r of S.sw) if (isNum(r.r0)) hourly.set(Math.floor(r.t / HOUR), r);
  for (const r of [...hourly.values()].reverse()) rows.push(Object.assign({ which: 'last sample of the hour' }, r));
  return { cols: [C('which', 'Row', null, true), C('t', 'UTC', dt, true), C('r0', 'r0 Re', v => fx(v, 2)), C('alpha', 'alpha', v => fx(v, 3)), C('pd', 'Pd nPa', v => fx(v, 2)), C('bz', 'Bz nT', v => sgn(v, 2))], rows };
});
tableView($('#c-nw'), () => ({
  cols: [C('t', 'UTC, last 3 h', dt, true), C('source', 'Source', null, true), C('nw', 'Newell, 1 min', fmt.int), C('nw30', '30 min mean', fmt.int)],
  rows: last3h(S.sw.filter(r => isNum(r.nw))),
}));
tableView($('#c-kp'), () => {
  const now = Date.now();
  const rows = S.win.filter(w => w.t1 >= now - 3 * DAY && w.t0 <= now + 3 * DAY).map(w => Object.assign({ g: H.kpToG(w.kp, G_RULE) }, w)).reverse();
  return { cols: [C('t0', 'Window start, UTC', dt, true), C('t1', 'End', v => fmt.time(v, true, false), true), C('kp', 'Kp', kpf), C('type', 'Status in file', null, true), C('label', 'NOAA label', v => v || '–', true), C('g', 'G, this page', H.gLabel, true)], rows };
});
tableView($('#c-xr'), () => ({
  cols: [C('t', 'UTC, last 6 h', dt, true), C('long', '0.1 to 0.8 nm W/m²', v => sci(v)), C('cls', 'Class', null, true), C('short', '0.05 to 0.4 nm W/m²', v => sci(v)), C('sat', 'Satellite', v => v == null ? '–' : 'GOES-' + v)],
  rows: S.xray.filter(r => r.t >= Date.now() - 6 * HOUR).map(r => Object.assign({ cls: H.flareClass(r.long)?.label ?? '–' }, r)).reverse(),
}));
tableView($('#c-au'), () => ({
  cols: [C('name', 'Place', null, true), C('lat', 'Lat', v => fx(v, 2) + '°N'), C('lon', 'Lon', v => fx(Math.abs(v), 2) + (v < 0 ? '°W' : '°E')), C('p', 'Overhead %', v => isNum(v) ? fmt.int(v) : '–'), C('b', 'Southernmost 10% lat', v => isNum(v) ? v + '°N' : 'none')],
  rows: Object.entries(LOCS).map(([id, L]) => ({ name: L.name + (id === S.loc ? ' (selected)' : ''), lat: L.lat, lon: L.lon, p: S.ov ? H.ovationAt(S.ov.grid, L.lat, L.lon) : NaN, b: S.ov ? H.auroraBoundary(S.ov.grid, L.lon) : NaN })),
}));

// ---------------------------------------------------------------- start polling
setLoc(S.loc);
for (const sp of SPEC) {
  poll(BASE + sp.path, {
    every: sp.every, feed: feeds[sp.id], timeoutMs: 30e3,
    onData(data, meta) {
      const m = S.meta[sp.id] || (S.meta[sp.id] = {});
      m.polledAt = Date.now(); m.bytes = meta.bytes; m.ms = meta.ms; m.lastModified = meta.lastModified;
      try { handlers[sp.id](data, meta); }
      catch (e) { console.error(sp.id, e); feeds[sp.id].set('error', 'unexpected shape: ' + e.message); }
      mainJob.invalidate();
    },
  });
}

