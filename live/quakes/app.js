// DOM wiring for the earthquake dashboard: loads the past week once, polls
// the past hour and past day feeds, merges them through seismo.js, and paints
// the stage map, the custom canvases and the shared charts through the scheduler.
import { fmt, isNum, clamp, niceTicks } from '../assets/util.js';
import * as ui from '../assets/ui.js';
import { Columns, Scatter } from '../assets/charts.js';
import {
  REGIONS, regionByKey, analyze, findSequence, createCatalog, mergeCatalog, describeChange, inRegion, omoriRate, median,
  WEEK, DAY, HOUR, MIN, MIN_AFTERSHOCKS, MIN_MAIN_MAG, BOOT_N, BURST_P, BURST_BASE_HOURS,
} from './seismo.js';

const { $, h, setText, safeHref, palette, rgba, onPaint } = ui;
const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const ALLOW = ['earthquake.usgs.gov'];
const LIB_GEO = 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm';
const LIB_TOPO = 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm';
const LAND = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';
const PLATES = 'https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@339b0c56563c118307b1f4542703047f5f698fae/GeoJSON/PB2002_boundaries.json';
const STAGE_MAX = 460;         // stage height on wide screens, px
const RIP_PERIOD = 4000;       // a ripple every 4 s for quakes of the last hour
const RIP_DUR = 2800;          // each ring expands and fades over 2.8 s
const RIP_NEW = 3;             // ripples for a quake that arrived since the page opened
const SPOT_MIN = 2.5;          // the callout shows the latest quake of at least this magnitude
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

ui.boot();

// ---------------------------------------------------------------- state
const cat = createCatalog();
const S = { region: REGIONS[0], loaded: false, openedAt: Date.now(), gen: { week: NaN, hour: NaN, day: NaN }, dayPolls: 0 };
try { const k = localStorage.getItem('quakes-region'); if (k) S.region = regionByKey(k); } catch { /* storage blocked */ }

const fWeek = new ui.Feed({ label: 'past week, loaded once', kind: 'poll', staleMs: Infinity });
const fHour = new ui.Feed({ label: 'past hour, every 60 s', kind: 'poll', staleMs: 180e3 });
const fDay = new ui.Feed({ label: 'past day, every 5 min', kind: 'poll', staleMs: 900e3 });
const feeds = [fWeek, fHour, fDay];
ui.mountFeeds($('#status'), feeds);
ui.initPause($('#pause'), feeds);

// One analysis per (catalog version, region, minute); every painter reads it.
let memo = { key: '', A: null };
function analysis() {
  const now = Date.now();
  const key = cat.version + '|' + S.region.key + '|' + Math.floor(now / MIN);
  if (memo.key !== key) {
    const A = analyze(cat.events.values(), S.region, now);
    A.byMag = A.withMag.slice().sort((a, b) => b.mag - a.mag);
    A.spot = A.quakes.find(e => isNum(e.mag) && e.mag >= SPOT_MIN) || A.quakes[0] || null;
    A.spotBig = !!(A.spot && A.spot.mag >= SPOT_MIN);
    memo = { key, A };
  }
  return memo.A;
}
// The busiest sequence in the whole feed, named when the region has none.
let seqAll = { key: '', s: null };
function busiestAnywhere() {
  const key = cat.version + '|' + Math.floor(Date.now() / MIN);
  if (seqAll.key !== key) seqAll = { key, s: findSequence([...cat.events.values()].filter(e => e.type === 'earthquake')) };
  return seqAll.s;
}

// ---------------------------------------------------------------- ingestion
async function loadWeek(attempt = 0) {
  try {
    const r = await fetch(FEED + 'all_week.geojson', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const d = JSON.parse(text);
    fWeek.hit(text.length);
    const g = d.metadata && d.metadata.generated;
    mergeCatalog(cat, d.features || [], { window: { span: WEEK, end: g }, initial: true });
    S.gen.week = g; S.loaded = true;
    refresh();
    ui.poll(FEED + 'all_hour.geojson', { every: 60e3, feed: fHour, onData: d2 => ingest(d2, 'hour') });
    ui.poll(FEED + 'all_day.geojson', { every: 300e3, feed: fDay, onData: d2 => ingest(d2, 'day') });
  } catch (e) {
    fWeek.set('error', (e.message || 'failed') + ' · retry ' + (attempt + 1));
    setTimeout(() => loadWeek(attempt + 1), Math.min(120e3, 5e3 * 2 ** attempt));
  }
}
function ingest(d, which) {
  const g = d && d.metadata && d.metadata.generated;
  const win = which === 'day' ? { key: 'day', span: DAY, end: g } : { span: HOUR, end: g };
  const res = mergeCatalog(cat, (d && d.features) || [], { window: win });
  const now = Date.now();
  for (const e of res.added) e.arrived = now;
  if (isNum(g)) S.gen[which] = Math.max(S.gen[which] || 0, g);
  if (which === 'day') S.dayPolls++;
  refresh();
}

// ---------------------------------------------------------------- painters
const jobs = [];
function refresh() { for (const j of jobs) j.invalidate(); }
addEventListener('themechange', refresh);

// A canvas sized to its container at device pixel ratio, with a tooltip layer.
class Pane {
  constructor(mount, { height, aria, every = 100, draw, click }) {
    this.root = h('div', { class: 'chart viz' });
    this.cv = h('canvas', { tabindex: '0', role: 'img', 'aria-label': aria });
    this.tip = h('div', { class: 'tip', 'aria-hidden': 'true' });
    this.root.append(this.cv, this.tip);
    mount.append(this.root);
    this.ctx = this.cv.getContext('2d');
    this.height = height; this.draw = draw;
    this.w = 0; this.hgt = 0; this.dpr = 1; this.mx = NaN; this.my = NaN;
    this.job = onPaint(() => this.paint(), every);
    jobs.push(this.job);
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.cv.addEventListener('pointermove', e => { this.mx = e.offsetX; this.my = e.offsetY; this.job.now(); });
    this.cv.addEventListener('pointerleave', () => { this.mx = NaN; this.my = NaN; this.hideTip(); this.job.now(); });
    this.cv.addEventListener('blur', () => { this.mx = NaN; this.hideTip(); this.job.now(); });
    if (click) this.cv.addEventListener('click', e => click(e.offsetX, e.offsetY));
    this.resize();
  }
  resize(force) {
    const w = Math.max(120, Math.floor(this.root.clientWidth));
    const hgt = Math.round(typeof this.height === 'function' ? this.height(w) : this.height);
    if (!force && w === this.w && hgt === this.hgt && this.dpr === devicePixelRatio) return;
    this.w = w; this.hgt = hgt; this.dpr = devicePixelRatio || 1;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(hgt * this.dpr);
    this.cv.style.height = hgt + 'px';
    this.job.now();
  }
  paint() {
    const c = this.ctx, p = palette();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.hgt);
    c.font = '11px ' + p.mono; c.textBaseline = 'alphabetic'; c.globalAlpha = 1;
    this.draw(c, p, this);
  }
  showTip(x, y, head, rows) {
    const t = this.tip;
    t.replaceChildren(h('div', { class: 'tip__h' }, head), ...rows.map(r =>
      h('div', { class: 'tip__r' }, h('i', { style: { background: r.color || 'transparent', height: r.shape === 'rect' ? '10px' : r.shape === 'dot' ? '8px' : '2px', width: r.shape === 'rect' ? '10px' : r.shape === 'dot' ? '8px' : '12px', borderRadius: r.shape === 'dot' ? '50%' : '1px' } }), h('b', null, r.value), h('span', null, r.label))));
    t.style.display = 'block';
    const tw = t.offsetWidth, th = t.offsetHeight;
    let left = x + 14; if (left + tw > this.w) left = x - tw - 14; left = clamp(left, 0, Math.max(0, this.w - tw));
    let top = y - th - 10; if (top < 0) top = y + 14;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  hideTip() { this.tip.style.display = 'none'; }
}

// axis label with a surface colored halo so marks under it stay legible
function label(c, p, s, x, y, color) {
  c.lineWidth = 3; c.strokeStyle = p.surface; c.lineJoin = 'round'; c.strokeText(s, x, y);
  c.fillStyle = color || p.muted; c.fillText(s, x, y); c.lineWidth = 1;
}
// text centered in a canvas, one line per entry
function centerText(c, p, W, H, lines) {
  c.textAlign = 'center';
  const y0 = H / 2 - (lines.length - 1) * 9;
  lines.forEach((s, i) => { c.font = (i === 0 ? '600 12.5px ' : '12px ') + p.sans; c.fillStyle = i === 0 ? p.ink : p.ink2; c.fillText(s, W / 2, y0 + i * 18); });
  c.font = '11px ' + p.mono;
}
const m1 = x => isNum(x) ? x.toFixed(1) : '–';
// time since, in days once it passes two days
const ago = ms => isNum(ms) && ms >= 2 * DAY ? fmt.fixed(ms / DAY, 1) + ' days ago' : fmt.ago(ms);
const placeOf = e => e.place || 'unnamed location';
// "102 km NE of Norsup, Vanuatu" becomes "near Norsup, Vanuatu"
const nearOf = e => { const s = placeOf(e), i = s.lastIndexOf(' of '); return i > 0 ? 'near ' + s.slice(i + 4) : s; };
const utc = t => fmt.date(t, true) + ' ' + fmt.time(t, true, false) + ' UTC';
const km = x => isNum(x) ? fmt.fixed(x, 1) + ' km' : '–';
const times = x => (x >= 10 ? fmt.fixed(x, 0) : fmt.fixed(x, 1)) + ' times';
function fmtP(x) { if (!isNum(x)) return '–'; if (x < 1e-12) return '< 1e-12'; if (x < 0.001) return x.toExponential(1); return x.toPrecision(2); }
function plural(n, one, many) { return fmt.int(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
const statusWords = s => s === 'reviewed' ? 'reviewed by a seismologist' : s === 'automatic' ? 'automatic, not yet reviewed' : (s || 'status unknown');
// replace an element's children only when the text would change, so open
// disclosures and text selections survive the repaint
function fill(sel, ...kids) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  const tmp = h('div', null, ...kids);
  if (tmp.textContent !== el.textContent) el.replaceChildren(...tmp.childNodes);
}

// ---------------------------------------------------------------- color helpers
function rgbOf(c) {
  if (Array.isArray(c)) return c;
  const x = c.trim().replace('#', ''), n = parseInt(x.length === 3 ? [...x].map(k => k + k).join('') : x, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function mix(a, b, t) { const A = rgbOf(a), B = rgbOf(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; }

// ---------------------------------------------------------------- stage map
const geo = { ready: false, failed: '', lib: null, land: null, plates: null, grat: null };
(async () => {
  try {
    const [g, topo, land, plates] = await Promise.all([
      import(LIB_GEO), import(LIB_TOPO),
      fetch(LAND).then(r => { if (!r.ok) throw new Error('land HTTP ' + r.status); return r.json(); }),
      fetch(PLATES).then(r => { if (!r.ok) throw new Error('plates HTTP ' + r.status); return r.json(); }),
    ]);
    geo.lib = g; geo.land = topo.feature(land, land.objects.land); geo.plates = plates;
    geo.grat = g.geoGraticule().step([30, 30])();
    geo.ready = true;
  } catch (e) { geo.failed = e.message || 'failed'; }
  stage.resize(true); refresh();
})();

const LOG701 = Math.log10(701);
const depthT = d => Math.log10(1 + clamp(isNum(d) ? d : 0, 0, 700)) / LOG701;
const depthColor = (p, d) => p.seqAt(0.35 + 0.65 * depthT(d));
// radius in px: 1.5 up to M 1, plus 1.6 s per magnitude unit, s following map width
const radiusScale = W => clamp(W / 800, 0.6, 1.2);
const radius = (M, s) => 1.5 + 1.6 * s * Math.max(0, (isNum(M) ? M : 0) - 1);

const wrap = x => ((x + 540) % 360) - 180;
function viewObject(region) {
  if (!region.view) return { type: 'Sphere' };
  const [x0, y0, x1, y1] = region.view, pts = [], n = 24;
  for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; pts.push([wrap(x), y0], [wrap(x), y1]); }
  for (let i = 0; i <= n; i++) { const y = y0 + (y1 - y0) * i / n; pts.push([wrap(x0), y], [wrap(x1), y]); }
  return { type: 'MultiPoint', coordinates: pts };
}
function boxLine(region) {
  const [x0, y0, x1, y1] = region.view, ring = [], n = 32;
  for (let i = 0; i <= n; i++) ring.push([wrap(x0 + (x1 - x0) * i / n), y0]);
  for (let i = 0; i <= n; i++) ring.push([wrap(x1), y0 + (y1 - y0) * i / n]);
  for (let i = 0; i <= n; i++) ring.push([wrap(x1 - (x1 - x0) * i / n), y1]);
  for (let i = 0; i <= n; i++) ring.push([wrap(x0), y1 - (y1 - y0) * i / n]);
  return { type: 'LineString', coordinates: ring };
}
const centerLon = region => region.view ? (region.view[0] + region.view[2]) / 2 : 150;
function projectionFor(region, W, H) {
  const pad = region.view ? 22 : 6;
  return geo.lib.geoEqualEarth().rotate([-centerLon(region), 0]).fitExtent([[pad, pad], [W - pad, H - pad]], viewObject(region));
}
function stageHeight(w) {
  let aspect = 2.05;
  if (geo.ready) {
    const pr = projectionFor(S.region, 1000, 1000), b = geo.lib.geoPath(pr).bounds(viewObject(S.region));
    aspect = (b[1][0] - b[0][0]) / Math.max(1, b[1][1] - b[0][1]);
  }
  return clamp(w / aspect, 170, Math.min(STAGE_MAX, innerWidth <= 760 ? w * 1.1 : STAGE_MAX));
}

// map tones: ocean a faint tint of the sequential ramp, land a step off the surface
function tones(p) {
  const dark = ui.currentTheme() === 'dark';
  return {
    ocean: mix(p.surface, p.seq[1], dark ? 0.32 : 0.22),
    land: dark ? mix(p.surface, p.ink, 0.075) : mix(p.surface, p.sunk, 1),
    coast: dark ? mix(p.surface, p.ink, 0.16) : mix(p.sunk, p.ink, 0.12),
    grat: dark ? mix(p.surface, p.ink, 0.05) : mix(p.surface, p.seq[2], 0.12),
    plate: rgba(getComputedStyle(document.documentElement).getPropertyValue('--rule-2').trim() || p.rule, dark ? 0.95 : 0.9),
  };
}

const base = { key: '', cv: null };
function baseLayer(p, proj, W, H, dpr) {
  const t = tones(p);
  const key = [S.region.key, W, H, dpr, p.surface, t.ocean, t.land].join('|');
  if (base.key === key) return base.cv;
  const cv = base.cv || document.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  proj.clipExtent([[0, 0], [W, H]]);
  const path = geo.lib.geoPath(proj, c);
  c.beginPath(); path({ type: 'Sphere' }); c.fillStyle = t.ocean; c.fill();
  c.beginPath(); path(geo.grat); c.strokeStyle = t.grat; c.lineWidth = 0.6; c.stroke();
  c.beginPath(); path(geo.land); c.fillStyle = t.land; c.fill(); c.strokeStyle = t.coast; c.lineWidth = 0.6; c.stroke();
  c.beginPath(); path(geo.plates); c.strokeStyle = t.plate; c.lineWidth = 1; c.stroke();
  if (!S.region.view) { c.beginPath(); path({ type: 'Sphere' }); c.strokeStyle = p.rule; c.lineWidth = 1; c.stroke(); }
  else { c.beginPath(); path(boxLine(S.region)); c.setLineDash([4, 4]); c.strokeStyle = p.ink3; c.globalAlpha = 0.55; c.lineWidth = 1; c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
  base.key = key; base.cv = cv;
  return cv;
}

// every dot drawn once per catalog change into its own layer; ripples go on top
const dots = { key: '', cv: null, pts: [] };
function dotLayer(p, proj, W, H, dpr, A) {
  const key = [memo.key, W, H, dpr, p.surface, p.seqAt(0.5)].join('|');
  if (dots.key === key) return dots;
  const cv = dots.cv || document.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const rs = radiusScale(W), now = A.now, pts = [];
  for (const e of A.byMag) {
    const xy = proj([e.lon, e.lat]);
    if (!xy) continue;
    const [x, y] = xy;
    if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
    const r = radius(e.mag, rs), a = clamp(1 - 0.75 * (now - e.time) / WEEK, 0.25, 1);
    c.globalAlpha = 0.85 * a; c.beginPath(); c.arc(x, y, r + 2, 0, 7); c.fillStyle = p.surface; c.fill();
    c.globalAlpha = a; c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = depthColor(p, e.depth); c.fill();
    pts.push({ x, y, r, e });
  }
  c.globalAlpha = 1;
  dots.key = key; dots.cv = cv; dots.pts = pts;
  return dots;
}
function nearestDot(x, y) {
  let best = null, bd = 24 * 24;
  for (const q of dots.pts) { const dx = q.x - x, dy = q.y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = q; } }
  return best;
}

// The callout floats on wide screens where it hides the fewest quakes: beside its own
// quake if that spot is clear, otherwise in an empty corner of the stage, joined to the
// quake by a leader line. It always stays clear of the caption and legend.
let spotShown = '';
function placeSpot(q, W, H, pts) {
  const el = $('#spot'), stageEl = $('#stage');
  if (!q || stageEl.dataset.view === 'table') return null;
  if (getComputedStyle(el).position !== 'absolute') { el.style.left = el.style.top = ''; return null; }
  const sw = el.offsetWidth, sh = el.offsetHeight, top0 = $('#stage-mount').offsetTop;
  const avoid = [$('#stage .stage__cap'), $('#stage-legend')].map(n => ({ x: n.offsetLeft, y: n.offsetTop - top0, w: n.offsetWidth, h: n.offsetHeight }));
  const hit = (x, y) => avoid.some(r => x < r.x + r.w + 8 && x + sw + 8 > r.x && y < r.y + r.h + 8 && y + sh + 8 > r.y);
  const covered = (x, y) => { let n = 0; for (const d of pts) if (d.x + d.r > x - 6 && d.x - d.r < x + sw + 6 && d.y + d.r > y - 6 && d.y - d.r < y + sh + 6) n++; return n; };
  const gap = 34, m = 12;
  const cands = [[q.x + gap, q.y + 18], [q.x - gap - sw, q.y + 18], [q.x + gap, q.y - 18 - sh], [q.x - gap - sw, q.y - 18 - sh],
    [m, H - sh - m], [W - sw - m, H - sh - m], [m, H / 2 - sh / 2], [W - sw - m, H / 2 - sh / 2]];
  let pos = null, best = Infinity;
  for (const [x, y] of cands) {
    if (x < 8 || y < 8 || x + sw > W - 8 || y + sh > H - 8 || hit(x, y)) continue;
    const score = covered(x, y) * 1000 + Math.hypot(x + sw / 2 - q.x, y + sh / 2 - q.y);
    if (score < best) { best = score; pos = [x, y]; }
  }
  if (!pos) pos = [q.x < W / 2 ? W - sw - 8 : 8, Math.max(8, H - sh - 8)];
  el.style.left = Math.round(pos[0]) + 'px'; el.style.top = Math.round(pos[1] + top0) + 'px';
  return { x: pos[0], y: pos[1], w: sw, h: sh };
}
function paintSpot(A, now) {
  const el = $('#spot'), e = A.spot;
  if (!e) { el.hidden = true; return; }
  el.hidden = false;
  setText('#spot-k', A.spotBig ? `Latest M ${SPOT_MIN} or larger` : 'Newest earthquake');
  fill('#spot-v', 'M ' + m1(e.mag), h('small', null, e.magType));
  setText('#spot-p', placeOf(e));
  setText('#spot-m', `${km(e.depth)} deep · ${ago(now - e.time)} · ${statusWords(e.status)}`);
  spotShown = e.id;
}

function drawStage(c, p, pane) {
  const W = pane.w, H = pane.hgt;
  if (!geo.ready) { centerText(c, p, W, H, geo.failed ? ['Map layers failed to load', geo.failed + '. The table lists every event.'] : ['Loading the map']); return; }
  const proj = projectionFor(S.region, W, H);
  c.drawImage(baseLayer(p, proj, W, H, pane.dpr), 0, 0, W, H);
  if (!S.loaded) { centerText(c, p, W, H, ['Loading the past week of earthquakes']); return; }
  const A = analysis(), now = Date.now();
  const L = dotLayer(p, proj, W, H, pane.dpr, A);
  c.drawImage(L.cv, 0, 0, W, H);

  // ripples: every quake of the last hour, and any that arrived since the page opened
  const s2 = p.s[1];
  let active = false;
  c.strokeStyle = s2;
  for (const q of L.pts) {
    const e = q.e, recent = now - e.time < HOUR;
    const fresh = !!e.arrived && now - e.arrived < RIP_NEW * RIP_PERIOD;
    if (!recent && !fresh) continue;
    if (reduceMotion) {
      c.lineWidth = 1.5; c.globalAlpha = 0.8; c.beginPath(); c.arc(q.x, q.y, q.r + 4, 0, 7); c.stroke();
      c.lineWidth = 1; c.globalAlpha = 0.4; c.beginPath(); c.arc(q.x, q.y, q.r + 9, 0, 7); c.stroke();
      continue;
    }
    active = true;
    const t0 = fresh ? e.arrived : e.time, ph = ((now - t0) % RIP_PERIOD) / RIP_DUR;
    if (ph > 1) continue;
    const ease = 1 - (1 - ph) ** 2;
    c.lineWidth = 1.6; c.globalAlpha = 0.75 * (1 - ph) ** 1.4;
    c.beginPath(); c.arc(q.x, q.y, q.r + 3 + 20 * ease, 0, 7); c.stroke();
  }
  c.globalAlpha = 1;

  // the callout's quake: a ring, and a leader line to the callout on wide screens
  const sq = A.spot && L.pts.find(q => q.e === A.spot);
  if (A.spot && spotShown !== A.spot.id) paintSpot(A, now);
  const box = sq ? placeSpot(sq, W, H, L.pts) : null;
  if (sq) {
    c.strokeStyle = p.ink; c.lineWidth = 1.5; c.beginPath(); c.arc(sq.x, sq.y, sq.r + 4, 0, 7); c.stroke();
    if (box) {
      const bx = clamp(sq.x, box.x, box.x + box.w), by = clamp(sq.y, box.y, box.y + box.h);
      const d = Math.hypot(bx - sq.x, by - sq.y);
      if (d > sq.r + 8) {
        const ux = (bx - sq.x) / d, uy = (by - sq.y) / d;
        c.strokeStyle = p.ink3; c.lineWidth = 1; c.beginPath(); c.moveTo(sq.x + ux * (sq.r + 5), sq.y + uy * (sq.r + 5)); c.lineTo(bx, by); c.stroke();
      }
    }
  }

  const hq = isNum(pane.mx) ? nearestDot(pane.mx, pane.my) : null;
  if (hq) {
    c.lineWidth = 2; c.strokeStyle = p.ink; c.beginPath(); c.arc(hq.x, hq.y, hq.r + 3, 0, 7); c.stroke();
    const e = hq.e;
    pane.showTip(hq.x, hq.y, 'M ' + m1(e.mag) + ' ' + (e.magType || '') + ' · ' + placeOf(e), [
      { value: ago(now - e.time), label: utc(e.time) },
      { value: km(e.depth), label: 'depth', color: depthColor(p, e.depth), shape: 'dot' },
      { value: e.status || '–', label: e.isNew ? 'status, arrived since you opened the page' : 'status' },
    ]);
    pane.cv.style.cursor = safeHref(e.url, ALLOW) ? 'pointer' : 'crosshair';
  } else { pane.hideTip(); pane.cv.style.cursor = 'crosshair'; }
  if (active) pane.job.invalidate();
}
const stage = new Pane($('#stage-mount'), {
  height: stageHeight, every: 33, aria: 'Map of earthquake epicenters in the past week. The Table button lists every event.', draw: drawStage,
  click: (x, y) => { const q = nearestDot(x, y), u = q && safeHref(q.e.url, ALLOW); if (u) window.open(u, '_blank', 'noopener'); },
});
addEventListener('resize', () => stage.resize());
ui.tableView($('#stage'), () => {
  const A = memo.A;
  if (!A) return { cols: [{ key: 'x', label: 'Waiting for the catalog' }], rows: [] };
  const cap = 500, rows = A.quakes.slice(0, cap);
  if (A.quakes.length > cap) rows.push({ time: NaN, _note: 'Newest ' + cap + ' of ' + fmt.int(A.quakes.length) + ' shown' });
  return { cols: eventCols(true), rows };
});
function eventCols(full) {
  const cols = [
    { key: 'time', label: 'Time UTC', fmt: t => isNum(t) ? fmt.date(t, true) + ' ' + fmt.time(t, true) : '' },
    { key: 'mag', label: 'M', fmt: m1 }, { key: 'magType', label: 'Type', left: true },
    { key: 'place', label: 'Place', left: true, fmt: (v, r) => eventLink(r) },
  ];
  if (full) cols.push({ key: 'lat', label: 'Lat', fmt: v => fmt.fixed(v, 3) }, { key: 'lon', label: 'Lon', fmt: v => fmt.fixed(v, 3) });
  cols.push({ key: 'depth', label: 'Depth km', fmt: v => fmt.fixed(v, 1) }, { key: 'status', label: 'Status', left: true });
  return cols;
}
function eventLink(e) {
  if (e._note) return e._note;
  const u = safeHref(e.url, ALLOW);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, placeOf(e)) : placeOf(e);
}
function paintStageLegend() {
  const p = palette(), rs = radiusScale(stage.w || 800), stops = [];
  for (let i = 0; i <= 8; i++) stops.push(p.seqAt(0.35 + 0.65 * i / 8));
  const ring = [2, 4, 6].map(M => { const d = 2 * radius(M, rs); return h('i', { style: { width: d + 'px', height: d + 'px' } }); });
  fill('#stage-legend',
    h('span', null, 'shallow', h('i', { class: 'grad', style: { background: 'linear-gradient(to right,' + stops.join(',') + ')' } }), 'deep'),
    h('span', { class: 'sz' }, ...ring, h('b', { style: { fontWeight: 400, marginLeft: '3px' } }, 'M 2, 4, 6')),
    h('span', null, h('i', { class: 'rip', style: { color: p.s[1] } }), 'last hour'));
  // the color swatches change with the theme even when the words do not
  const g = $('#stage-legend .grad'); if (g) g.style.background = 'linear-gradient(to right,' + stops.join(',') + ')';
  const r = $('#stage-legend .rip'); if (r) r.style.color = p.s[1];
  const ts = [0, 10, 30, 100, 300, 700];
  $('#dscale').replaceChildren(h('div', { class: 'dscale__bar', style: { background: 'linear-gradient(to right,' + stops.join(',') + ')' } }),
    ...ts.map((d, i) => h('span', { class: 'dscale__t' + (i === 0 ? ' first' : i === ts.length - 1 ? ' last' : ''), style: { left: (100 * depthT(d)) + '%' } }, d + (i === ts.length - 1 ? ' km' : ''))));
}

// ---------------------------------------------------------------- frequency magnitude
ui.mountLegend($('#fmd-leg'), [
  { label: 'per 0.1 of magnitude', color: 'other', shape: 'rect' },
  { label: 'at or above', color: 1, shape: 'dot' },
  { label: 'fit from Mc', color: 'ink' },
]);
const cardChart = w => clamp(w * 0.62, 220, 290);
function drawFmd(c, p, pane) {
  const W = pane.w, H = pane.hgt;
  if (!S.loaded) { centerText(c, p, W, H, ['Waiting for the catalog']); return; }
  const A = analysis(), gr = A.gr, hist = gr.hist;
  if (!hist.length) { centerText(c, p, W, H, ['No earthquakes with a magnitude', 'in this region this week']); return; }
  const top = 12, bottom = H - 20, left = 0, right = W - 6;
  const NX = niceTicks(hist[0].m - 0.1, hist[hist.length - 1].m + 0.1, Math.max(3, Math.floor(W / 70)));
  const X = m => left + 8 + (m - NX.lo) / (NX.hi - NX.lo || 1) * (right - left - 12);
  const nMax = hist[0].cum, L0 = -0.3, L1 = Math.max(1, Math.ceil(Math.log10(nMax) + 0.05));
  const Y = v => bottom - (Math.log10(Math.max(v, 10 ** L0)) - L0) / (L1 - L0) * (bottom - top);
  c.lineWidth = 1;
  for (let k = 0; k <= L1; k++) { const y = Math.round(Y(10 ** k)) + 0.5; c.strokeStyle = k === 0 ? p.axis : p.grid; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); }
  c.textAlign = 'center';
  for (const v of NX.ticks) { const x = X(v); if (x < 14 || x > right - 78) continue; c.fillStyle = p.muted; c.fillText(fmt.sig(v, 3), x, H - 5); }
  c.textAlign = 'right'; c.fillStyle = p.ink3; c.fillText('magnitude', right, H - 5);
  const slot = Math.abs(X(0.1) - X(0)), bw = Math.max(1, Math.min(8, slot * 0.6));
  if (isNum(gr.mc)) {
    const x = Math.round(X(gr.mc - 0.05)) + 0.5;
    c.strokeStyle = p.ink3; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.setLineDash([]);
  }
  let hi = -1;
  if (isNum(pane.mx)) { let bd = Infinity; hist.forEach((b, i) => { const d = Math.abs(X(b.m) - pane.mx); if (d < bd) { bd = d; hi = i; } }); if (bd > Math.max(12, slot)) hi = -1; }
  hist.forEach((b, i) => { if (!b.count) return; const x = X(b.m), y = Y(b.count); c.fillStyle = i === hi ? p.ink3 : p.other; c.fillRect(x - bw / 2, y, bw, bottom - y); });
  c.fillStyle = p.s[0];
  hist.forEach(b => { c.beginPath(); c.arc(X(b.m), Y(b.cum), 2.4, 0, 7); c.fill(); });
  if (gr.ok) {
    const m0 = gr.mc, mEnd = hist[hist.length - 1].m + 0.05;
    c.save(); c.beginPath(); c.rect(left, top, right - left, bottom - top); c.clip();
    c.strokeStyle = p.ink; c.lineWidth = 2; c.beginPath(); c.moveTo(X(m0), Y(10 ** (gr.a - gr.b * m0))); c.lineTo(X(mEnd), Y(10 ** (gr.a - gr.b * mEnd))); c.stroke();
    c.restore();
  } else {
    c.textAlign = 'right'; c.font = '12px ' + p.sans;
    label(c, p, gr.reason === 'few' ? `${gr.n} quakes, a fit needs ${gr.need}` : `${gr.nAbove} above Mc, a fit needs ${gr.need}`, right, top + 24, p.ink2);
    c.font = '11px ' + p.mono;
  }
  c.textAlign = 'left';
  for (let k = 0; k <= L1; k++) label(c, p, fmt.int(10 ** k), left + 2, Math.round(Y(10 ** k)) + 0.5 - 3);
  if (isNum(gr.mc)) { const x = Math.round(X(gr.mc - 0.05)) + 0.5; c.textAlign = x > W - 70 ? 'right' : 'left'; label(c, p, 'Mc ' + gr.mc.toFixed(1), x + (x > W - 70 ? -4 : 4), top + 8, p.ink2); }
  if (hi >= 0) {
    const b = hist[hi], rows = [
      { value: fmt.int(b.count), label: 'in this bin', color: p.other, shape: 'rect' },
      { value: fmt.int(b.cum), label: 'at or above ' + b.m.toFixed(1), color: p.s[0], shape: 'dot' },
    ];
    if (gr.ok && b.m >= gr.mc - 1e-9) rows.push({ value: fmt.sig(10 ** (gr.a - gr.b * b.m), 3), label: 'fit, at or above', color: p.ink });
    pane.showTip(X(b.m), Y(b.cum), 'M ' + (b.m - 0.05).toFixed(2) + ' to ' + (b.m + 0.05).toFixed(2), rows);
  } else pane.hideTip();
}
new Pane($('#fmd-mount'), { height: cardChart, aria: 'Frequency magnitude distribution on a log scale', draw: drawFmd });
ui.tableView($('#fmd'), () => {
  const A = memo.A; if (!A) return { cols: [{ key: 'x', label: 'Waiting' }], rows: [] };
  const gr = A.gr;
  return {
    cols: [{ key: 'm', label: 'M bin', fmt: v => v.toFixed(1) }, { key: 'count', label: 'Count', fmt: fmt.int }, { key: 'cum', label: 'N at or above', fmt: fmt.int },
      { key: 'fit', label: 'Fit N at or above', fmt: v => isNum(v) ? fmt.sig(v, 3) : '' }],
    rows: gr.hist.slice().reverse().map(b => ({ ...b, fit: gr.ok && b.m >= gr.mc - 1e-9 ? 10 ** (gr.a - gr.b * b.m) : NaN })),
  };
});

// ---------------------------------------------------------------- shared chart data
// Registered before the charts so new data reaches them in the same frame.
let memoChart = null;
const dataJob = onPaint(() => {
  if (!S.loaded) return;
  const A = analysis();
  if (A === memoChart) return;
  memoChart = A;
  const start = A.hourly.start;
  hourly.set(A.hourly.flags.map((f, i) => {
    const t = start + i * HOUR, d = new Date(t), last = i === A.hourly.flags.length - 1;
    return { label: d.getUTCHours() === 0 && i > 5 && i < 162 ? fmt.date(t, true) : '', tip: fmt.date(t, true) + ' ' + fmt.time(t, true, false) + ' to ' + fmt.time(t + HOUR, true, false) + ' UTC' + (last ? ', current hour, partial' : ''), k: f.k, flag: !!f.flag, f };
  }));
  depthChart.set(A.withMag.filter(e => isNum(e.depth)).map(e => ({ x: e.mag, y: -Math.max(0, e.depth), r: 2.2, alpha: 0.5, e })));
}, 200);
jobs.push(dataJob);

// ---------------------------------------------------------------- hourly counts
ui.mountLegend($('#hourly-leg'), [{ label: 'unusually busy hour', color: 2, shape: 'rect' }, { label: 'hour', color: 1, shape: 'rect' }]);
const ruleText = { median: '24 h median', mean: '24 h mean, median was 0', floor: 'floor, 1/24 per hour' };
const hourly = new Columns($('#hourly-mount'), {
  height: 190, aria: 'Earthquakes per UTC hour over the last week', labelEvery: 1,
  series: [{ key: 'k', label: 'earthquakes', color: k => k.flag ? 2 : 1 }],
  y: { fmt: fmt.int, ticks: 4, labelsOver: true },
  tipExtra: k => k.f.tested
    ? [{ value: fmt.fixed(k.f.lambda, 2), label: 'usual (' + ruleText[k.f.rule] + ')' }, { value: fmtP(k.f.sf), label: 'chance of this many or more' }, { value: k.f.flag ? 'flagged' : 'not flagged', label: 'flag below 0.001' }]
    : [{ value: 'not tested', label: 'no full 24 h baseline yet' }],
});
jobs.push(hourly.job);
ui.tableView($('#hourly'), () => {
  const A = memo.A; if (!A) return { cols: [{ key: 'x', label: 'Waiting' }], rows: [] };
  return {
    cols: [{ key: 't', label: 'Hour UTC', fmt: t => fmt.date(t, true) + ' ' + fmt.time(t, true, false) }, { key: 'k', label: 'Count', fmt: fmt.int },
      { key: 'lambda', label: 'lambda', fmt: v => isNum(v) ? fmt.fixed(v, 2) : '' }, { key: 'sf', label: 'P(X ≥ k)', fmt: v => isNum(v) ? fmtP(v) : '' },
      { key: 'flag', label: 'Flagged', fmt: (v, r) => r.tested ? (v ? 'yes' : 'no') : 'not tested' }],
    rows: A.hourly.flags.map((f, i) => ({ t: A.hourly.start + i * HOUR, ...f })).reverse(),
  };
});

// ---------------------------------------------------------------- aftershocks
ui.mountLegend($('#omori-leg'), [{ label: 'aftershocks per day', color: 1, shape: 'dot' }, { label: 'each aftershock', color: 1, shape: 'tick' }, { label: 'Omori-Utsu fit', color: 'ink' }]);
function drawOmori(c, p, pane) {
  const W = pane.w, H = pane.hgt;
  if (!S.loaded) { centerText(c, p, W, H, ['Waiting for the catalog']); return; }
  const A = analysis(), s = A.seq, o = A.omori;
  if (!s.main) {
    const g = busiestAnywhere();
    centerText(c, p, W, H, [`No quake of M ${MIN_MAIN_MAG} or more here this week`, g && g.main ? `Busiest sequence in the feed: M ${m1(g.main.mag)} ${nearOf(g.main)}` : 'so there is no aftershock sequence to follow']);
    return;
  }
  const ts = s.after.map(e => (e.time - s.main.time) / DAY).filter(t => t > 0);
  const pts = A.rate.filter(b => b.k > 0);
  if (!ts.length) { centerText(c, p, W, H, [`No aftershocks yet after the M ${m1(s.main.mag)}`, nearOf(s.main) + ', ' + ago(Date.now() - s.main.time)]); return; }
  const top = 12, bottom = H - 22, left = 0, right = W - 6;
  const tLo = Math.min(...A.rate.map(b => b.t0)), tHi = A.T;
  let rLo = Infinity, rHi = -Infinity;
  for (const b of pts) { rLo = Math.min(rLo, b.rate); rHi = Math.max(rHi, b.rate); }
  if (o) { rHi = Math.max(rHi, omoriRate(o, tLo)); rLo = Math.min(rLo, omoriRate(o, tHi)); }
  const X0 = Math.floor(Math.log10(tLo)), X1 = Math.ceil(Math.log10(tHi)), Y0 = Math.floor(Math.log10(rLo)), Y1 = Math.ceil(Math.log10(rHi) + 1e-9);
  const X = t => left + 6 + (Math.log10(t) - X0) / (X1 - X0 || 1) * (right - left - 12);
  const Y = r => bottom - (Math.log10(r) - Y0) / (Y1 - Y0 || 1) * (bottom - top - 10);
  c.lineWidth = 1;
  const yStep = Math.ceil((Y1 - Y0) / 4) || 1;
  for (let k = Y0; k <= Y1; k += yStep) { const y = Math.round(Y(10 ** k)) + 0.5; c.strokeStyle = p.grid; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); }
  c.textAlign = 'center';
  const xStep = Math.ceil((X1 - X0) / Math.max(2, Math.floor(W / 70))) || 1;
  for (let k = X0; k <= X1; k += xStep) { const x = Math.round(X(10 ** k)) + 0.5; c.strokeStyle = p.grid; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); if (x > 16 && x < right - 16) { c.fillStyle = p.muted; c.fillText(fmt.sig(10 ** k, 2) + ' d', x, bottom + 16); } }
  // one tick per aftershock along the bottom
  c.strokeStyle = p.s[0]; c.globalAlpha = 0.55; c.lineWidth = 1;
  for (const t of ts) { const x = Math.round(X(Math.max(t, tLo))) + 0.5; c.beginPath(); c.moveTo(x, bottom - 7); c.lineTo(x, bottom); c.stroke(); }
  c.globalAlpha = 1;
  if (o) {
    c.save(); c.beginPath(); c.rect(left, top, right - left, bottom - top); c.clip();
    c.strokeStyle = p.ink; c.lineWidth = 2; c.beginPath();
    for (let i = 0; i <= 80; i++) { const t = 10 ** (Math.log10(tLo) + (Math.log10(tHi) - Math.log10(tLo)) * i / 80), x = X(t), y = Y(omoriRate(o, t)); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke(); c.restore();
  } else {
    c.textAlign = 'right'; c.font = '12px ' + p.sans;
    label(c, p, `${s.after.length} so far, a fit needs ${MIN_AFTERSHOCKS}`, right - 4, top + 14, p.ink2);
    c.font = '11px ' + p.mono;
  }
  let hi = null, bd = 24 * 24;
  for (const b of pts) { const dx = X(b.t) - pane.mx, dy = Y(b.rate) - pane.my, d = dx * dx + dy * dy; if (d < bd) { bd = d; hi = b; } }
  c.fillStyle = p.s[0];
  for (const b of pts) { c.beginPath(); c.arc(X(b.t), Y(b.rate), 3.5, 0, 7); c.fill(); }
  c.textAlign = 'left';
  for (let k = Y0; k <= Y1; k += yStep) label(c, p, fmt.sig(10 ** k, 2) + ' /d', left + 2, Math.round(Y(10 ** k)) + 0.5 - 3);
  if (hi) {
    c.beginPath(); c.arc(X(hi.t), Y(hi.rate), 6, 0, 7); c.fillStyle = p.surface; c.fill(); c.beginPath(); c.arc(X(hi.t), Y(hi.rate), 4, 0, 7); c.fillStyle = p.s[0]; c.fill();
    const rows = [{ value: fmt.sig(hi.rate, 3) + ' /d', label: plural(hi.k, 'aftershock') + ' in the bin', color: p.s[0], shape: 'dot' }];
    if (o) rows.push({ value: fmt.sig(omoriRate(o, hi.t), 3) + ' /d', label: 'fit at the bin center', color: p.ink });
    pane.showTip(X(hi.t), Y(hi.rate), fmt.sig(hi.t0, 2) + ' to ' + fmt.sig(hi.t1, 2) + ' days after', rows);
  } else pane.hideTip();
}
new Pane($('#omori-mount'), { height: cardChart, aria: 'Aftershock rate against time since the mainshock, log log', draw: drawOmori });
ui.tableView($('#omori'), () => {
  const A = memo.A; if (!A || !A.seq.main) return { cols: [{ key: 'x', label: 'No candidate mainshock' }], rows: [] };
  const o = A.omori;
  return {
    cols: [{ key: 't0', label: 'From day', fmt: v => fmt.sig(v, 3) }, { key: 't1', label: 'To day', fmt: v => fmt.sig(v, 3) }, { key: 'k', label: 'Events', fmt: fmt.int },
      { key: 'rate', label: 'Rate per day', fmt: v => fmt.sig(v, 3) }, { key: 'fit', label: 'Fit per day', fmt: v => isNum(v) ? fmt.sig(v, 3) : '' }],
    rows: A.rate.map(b => ({ ...b, fit: o ? omoriRate(o, b.t) : NaN })),
  };
});

// ---------------------------------------------------------------- depth against magnitude
const depthChart = new Scatter($('#depth-mount'), {
  height: w => clamp(w * 0.78, 240, 360), aria: 'Depth against magnitude', color: 1,
  x: { label: 'magnitude' }, y: { fmt: v => fmt.int(-v + 0) + ' km', labelsOver: true },
  tip: q => ({ head: 'M ' + m1(q.e.mag) + ' ' + q.e.magType + ' · ' + placeOf(q.e), rows: [{ value: km(q.e.depth), label: 'depth' }, { value: ago(Date.now() - q.e.time), label: utc(q.e.time) }] }),
});
jobs.push(depthChart.job);
ui.tableView($('#depth'), () => {
  const A = memo.A; if (!A) return { cols: [{ key: 'x', label: 'Waiting' }], rows: [] };
  return { cols: [{ key: 'mag', label: 'M', fmt: m1 }, { key: 'depth', label: 'Depth km', fmt: v => fmt.fixed(v, 1) }, { key: 'place', label: 'Place', left: true }], rows: A.byMag.slice(0, 500) };
});

// ---------------------------------------------------------------- lists
function scopedLog() { return cat.log.filter(r => inRegion(S.region, r.after || r.before) || (r.before && inRegion(S.region, r.before))).reverse(); }
let shownLatest = new Set();
function paintLatest(A, now) {
  const list = $('#latest-list'), rows = A.quakes.slice(0, 30);
  if (!rows.length) { list.replaceChildren(h('div', { class: 'empty' }, 'No earthquakes in this region in the past week.')); return; }
  const prev = shownLatest; shownLatest = new Set(rows.map(e => e.id));
  list.replaceChildren(
    h('div', { class: 'evr evh', 'aria-hidden': 'true' }, h('span', null, 'time UTC'), h('span', null, 'magnitude'), h('span', null, 'place'), h('span', { class: 'd' }, 'depth'), h('span', { class: 'st' }, 'status')),
    ...rows.map(e => h('div', { class: 'evr' + (prev.size && !prev.has(e.id) ? ' new' : '') },
      h('time', { datetime: new Date(e.time).toISOString() }, fmt.date(e.time, true) + ' ' + fmt.time(e.time, true, false), h('span', { class: 'ago' }, ago(now - e.time))),
      h('span', { class: 'm' }, 'M ' + m1(e.mag), h('small', null, e.magType)),
      h('span', { class: 'pl' }, eventLink(e)),
      h('span', { class: 'd' }, km(e.depth)),
      h('span', { class: 'st' }, h('span', { class: 'pill' }, e.status || 'unknown'), e.isNew ? h('span', { class: 'pill' }, 'new') : null))));
}
ui.tableView($('#latest'), () => {
  const A = memo.A; if (!A) return { cols: [{ key: 'x', label: 'Waiting' }], rows: [] };
  return { cols: eventCols(false), rows: A.quakes.slice(0, 30) };
});

function paintRevs(log, now) {
  const list = $('#rev-list');
  if (!log.length) {
    list.replaceChildren(h('div', { class: 'empty' }, !S.dayPolls ? 'Waiting for the first check of the past day.'
      : `No changes in this region since ${fmt.time(S.openedAt, true, false)} UTC. The page checks the past hour every minute and the past day every 5 minutes.`));
    return;
  }
  list.replaceChildren(...log.slice(0, 100).map(r => {
    const e = r.after || r.before, ch = describeChange(r), u = safeHref(e.url, ALLOW);
    return h('div', { class: 'rvr' },
      h('time', { datetime: new Date(r.at).toISOString(), title: 'feed built ' + utc(r.at) }, fmt.time(r.at, true, false), h('br'), now - r.at < MIN ? 'under 1 min ago' : fmt.ago(now - r.at)),
      h('span', { class: 'ev' }, 'M ' + m1(e.mag) + ' ', u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, placeOf(e)) : placeOf(e)),
      h('span', { class: 'ch' }, ...ch.flatMap((x, i) => i ? ['; ', h('b', null, x)] : [h('b', null, x)])));
  }));
}
ui.tableView($('#revs'), () => ({
  cols: [{ key: 'at', label: 'Seen UTC', fmt: t => fmt.time(t, true) }, { key: 'id', label: 'Event id', left: true },
    { key: 'm', label: 'M', fmt: (v, r) => m1((r.after || r.before).mag) }, { key: 'p', label: 'Place', left: true, fmt: (v, r) => placeOf(r.after || r.before) },
    { key: 'c', label: 'Change', left: true, fmt: (v, r) => describeChange(r).join('; ') }],
  rows: scopedLog(),
}));

// ---------------------------------------------------------------- KPIs, stage and footers
function setKpi(id, value, sub, na) {
  const el = $('#' + id);
  if (el) { setText(el, value); el.classList.toggle('na', !!na); }
  if (sub != null) setText('#' + id + '-s', sub);
}
const STAGE_H = { all: 'The week\'s earthquakes, updated every minute', m45: 'The week\'s strongest earthquakes worldwide' };
let lastKey = '', lastTheme = '';
function paintDom() {
  const now = Date.now();
  const ages = [S.gen.hour, S.gen.day, S.gen.week].filter(isNum);
  if (ages.length) setKpi('k-age', fmt.dur(Math.max(0, now - Math.max(...ages))), 'since USGS built the newest feed');
  else setKpi('k-age', '–', 'no feed has answered yet');
  setText('#stage-h', STAGE_H[S.region.key] || `The week's earthquakes in ${S.region.label}`);
  if (!S.loaded) return;
  const A = analysis(), gr = A.gr, log = scopedLog();
  const revN = log.filter(r => r.kind === 'revised').length, delN = log.filter(r => r.kind === 'deleted').length;
  const theme = palette().seqAt(0.5);
  const opened = fmt.time(S.openedAt, true, false) + ' UTC';
  const mixed = A.mix.length > 1 && A.mix[0].share < 0.9;

  // KPIs: plain words, short subs
  const L = A.largest;
  setKpi('k-day', fmt.int(A.day.length), L ? `Largest M ${m1(L.mag)}, ${nearOf(L)}, ${ago(now - L.time)}` : 'None with a magnitude in the last 24 hours');
  if (gr.ok) {
    setKpi('k-b', fmt.fixed(gr.b, 2) + ' ± ' + fmt.fixed(gr.sigma, 2), `${fmt.fixed(10 ** gr.b, 1)}× rarer per step · 95% range ${fmt.fixed(gr.boot.lo, 2)} to ${fmt.fixed(gr.boot.hi, 2)}${mixed ? ' · mixed scales' : ''}`);
    setKpi('k-mc', 'M ' + gr.mc.toFixed(1), 'Smaller quakes here are partly missed');
  } else if (gr.reason === 'few') {
    setKpi('k-b', 'Too few', `${plural(gr.n, 'quake')}, a fit needs ${gr.need}`, true);
    setKpi('k-mc', 'Too few', `${plural(gr.n, 'quake')}, needs ${gr.need}`, true);
  } else {
    setKpi('k-b', 'Too few', `${fmt.int(gr.nAbove)} at or above Mc, a fit needs ${gr.need}`, true);
    setKpi('k-mc', 'M ' + gr.mc.toFixed(1), 'Smaller quakes here are partly missed');
  }
  const newN = A.quakes.filter(e => e.isNew).length;
  setKpi('k-hr', fmt.int(A.hour.length), `${fmt.int(newN)} new since you opened the page`);
  setKpi('k-rev', fmt.int(revN + delN), `${fmt.int(revN)} revised, ${fmt.int(delN)} deleted since ${opened}`);

  // stage foot
  const big = A.byMag[0], newest = A.quakes[0];
  setText('#sf-day', fmt.int(A.day.length));
  setText('#sf-big', big ? `M ${m1(big.mag)} ${nearOf(big)}` : 'none');
  setText('#sf-new', newest ? ago(now - newest.time) : 'none');
  setText('#sf-rev', fmt.int(revN + delN));

  // lists and footers: rebuilt when the analysis or theme changes, and every 5 s for "ago" text
  const key = memo.key + '|' + cat.log.length + '|' + S.dayPolls + '|' + Math.floor(now / 5000);
  if (key === lastKey && theme === lastTheme) return;
  lastKey = key; lastTheme = theme;
  paintSpot(A, now); stage.job.invalidate();
  paintStageLegend();
  paintLatest(A, now);
  paintRevs(log, now);
  const excl = A.excluded.length ? ' Not drawn or counted: ' + A.excluded.map(x => plural(x.k, x.type)).join(', ') + '.' : '';
  fill('#h-map', `Radius 1.5 px up to M 1, plus ${fmt.fixed(1.6 * radiusScale(stage.w), 2)} px per magnitude unit at this width (1.6 px times width / 800, kept within 0.6 to 1.2). ${plural(A.withMag.length, 'earthquake')} drawn.${excl} Click a dot to open its USGS page.`);

  // frequency magnitude
  const mix = A.mix.slice(0, 4).map(m => m.type + ' ' + fmt.pct(m.share, 0)).join(', ');
  if (gr.ok) {
    fill('#fmd-f', 'Each step up in magnitude is ', h('b', null, times(10 ** gr.b)), ` rarer here (b = ${fmt.fixed(gr.b, 2)}). `,
      mixed ? 'This view mixes magnitude scales from different networks, which flattens the curve, so read it as a property of the catalog.' : 'Single regions usually come out near 10 times (b = 1).');
    fill('#h-fmd', h('b', null, 'Live values. '), `b = ${fmt.fixed(gr.b, 3)} ± ${fmt.fixed(gr.sigma, 3)} (Shi and Bolt), a = ${fmt.fixed(gr.a, 2)}, n = ${fmt.int(gr.n)}, ${fmt.int(gr.nAbove)} at or above Mc = ${gr.mc.toFixed(1)} (maximum curvature ${gr.maxc.toFixed(1)} + 0.2). Bootstrap 95% range [${fmt.fixed(gr.boot.lo, 3)}, ${fmt.fixed(gr.boot.hi, 3)}] from ${gr.boot.n} of ${BOOT_N} resamples${gr.boot.dropped ? ` (${gr.boot.dropped} had fewer than 50 events above their own Mc)` : ''}. Magnitude types at or above Mc: ${mix}.`);
  } else {
    fill('#fmd-f', 'Too few earthquakes here for a fit: ', h('b', null, gr.reason === 'few' ? fmt.int(gr.n) : fmt.int(gr.nAbove)), gr.reason === 'few' ? `, and Mc needs ${gr.need}.` : ` at or above Mc ${gr.mc.toFixed(1)}, and the fit needs ${gr.need}.`);
    fill('#h-fmd', h('b', null, 'Live values. '), gr.reason === 'few' ? `${plural(gr.n, 'earthquake')} in the region this week.` : `${fmt.int(gr.n)} earthquakes; Mc = ${gr.mc.toFixed(1)} (maximum curvature ${gr.maxc.toFixed(1)} + 0.2); ${fmt.int(gr.nAbove)} at or above it.`, mix ? ` Magnitude types: ${mix}.` : '');
  }

  // hourly
  const tested = A.hourly.flags.filter(f => f.tested), flagged = tested.filter(f => f.flag);
  const lastFlag = [...A.hourly.flags.keys()].reverse().find(i => A.hourly.flags[i].flag);
  if (flagged.length) {
    const f = A.hourly.flags[lastFlag];
    fill('#hourly-f', h('b', null, `${flagged.length} of ${tested.length}`), ` hour${flagged.length === 1 ? ' was' : 's were'} unusually busy. The latest, ${utc(A.hourly.start + lastFlag * HOUR)}, had `, h('b', null, fmt.int(f.k)), ` quakes where about ${fmt.fixed(f.lambda, 1)} was usual.`);
    fill('#h-hourly', h('b', null, 'Live values. '), `Latest flag: k = ${f.k}, lambda = ${fmt.fixed(f.lambda, 2)} (${ruleText[f.rule]}), P(X ≥ k) = ${fmtP(f.sf)}. Baselines this week: ${['median', 'mean', 'floor'].map(r => tested.filter(x => x.rule === r).length + ' ' + r).join(', ')}.`);
  } else {
    fill('#hourly-f', 'No hour this week was unusually busy here ', h('b', null, `(${tested.length} tested)`), '.');
    fill('#h-hourly', h('b', null, 'Live values. '), `Smallest tail probability this week: ${fmtP(Math.min(...tested.map(x => x.sf)))}. Baselines: ${['median', 'mean', 'floor'].map(r => tested.filter(x => x.rule === r).length + ' ' + r).join(', ')}.`);
  }

  // aftershocks
  const s = A.seq, o = A.omori;
  if (!s.main) {
    const g = busiestAnywhere();
    fill('#omori-f', `No earthquake of M ${MIN_MAIN_MAG} or more here this week, so there is no aftershock sequence to follow.`, g && g.main ? [' The busiest in the whole feed follows the ', h('b', null, `M ${m1(g.main.mag)} ${nearOf(g.main)}`), ` (${plural(g.after.length, 'aftershock')}).`] : '');
    fill('#h-omori', h('b', null, 'Live values. '), `0 candidates of M ${MIN_MAIN_MAG} or more in this region.`);
  } else {
    const w = s.window, main = `M ${m1(s.main.mag)} ${nearOf(s.main)}`;
    const tech = `Mainshock M ${m1(s.main.mag)} ${s.main.magType}, ${placeOf(s.main)}, ${utc(s.main.time)}. Window ${fmt.fixed(w.km, 1)} km and ${fmt.fixed(w.days, 0)} days; ${fmt.fixed(A.T, 2)} days observed; ${plural(s.candidates, 'candidate')} compared.`;
    if (o) {
      fill('#omori-f', `After the ${main}, the aftershock rate drops about `, h('b', null, times(10 ** o.p)), ` each time the elapsed time grows tenfold (p = ${fmt.fixed(o.p, 2)}, from ${o.n} aftershocks).`);
      const edge = [o.edge.c ? 'c is at the edge of its grid' : '', o.edge.p ? 'p is at the edge of its grid' : ''].filter(Boolean).join('; ');
      fill('#h-omori', h('b', null, 'Live values. '), `p = ${fmt.fixed(o.p, 2)} (95% profile range ${fmt.fixed(o.pLo, 2)} to ${fmt.fixed(o.pHi, 2)}), c = ${fmt.sig(o.c, 2)} days, K = ${fmt.sig(o.K, 3)}, n = ${o.n}, log L = ${fmt.fixed(o.logL, 1)}. ${tech}${edge ? ' ' + edge + '.' : ''}`);
    } else {
      fill('#omori-f', 'Only ', h('b', null, fmt.int(s.after.length)), ` aftershock${s.after.length === 1 ? '' : 's'} so far, too few to fit a decay curve (needs ${MIN_AFTERSHOCKS}). They follow the ${main}, ${ago(now - s.main.time)}.`);
      fill('#h-omori', h('b', null, 'Live values. '), tech);
    }
  }

  // depth
  const ds = A.withMag.map(e => e.depth).filter(isNum).sort((a, b) => a - b);
  if (ds.length) {
    const at10 = ds.filter(d => d === 10).length, above = ds.filter(d => d < 0).length;
    fill('#depth-f', 'Half are shallower than ', h('b', null, fmt.fixed(median(ds), 1) + ' km'), ', and ', h('b', null, fmt.pct(ds.filter(d => d < 70).length / ds.length, 0)), ' are shallower than 70 km.');
    fill('#h-depth', h('b', null, 'Live values. '), `${plural(ds.length, 'depth')}; deepest ${fmt.fixed(ds[ds.length - 1], 1)} km; ${plural(at10, 'earthquake')} at exactly 10 km; ${plural(above, 'earthquake')} above sea level drawn at 0 km.`);
  } else { fill('#depth-f', 'No depths yet.'); fill('#h-depth', ''); }

  // latest
  const top30 = A.quakes.slice(0, 30), auto = top30.filter(e => e.status === 'automatic').length;
  fill('#latest-f', top30.length ? [h('b', null, `${auto} of these ${top30.length}`), ' are automatic, so their numbers can still change. Times are UTC.'] : 'No earthquakes in this region this week.');

  // revisions
  const mags = log.filter(r => r.kind === 'revised' && r.fields.includes('mag'));
  const mad = mags.length ? mags.reduce((sum, r) => sum + Math.abs(r.after.mag - r.before.mag), 0) / mags.length : NaN;
  fill('#rev-f', h('b', null, plural(revN, 'revision')), ' and ', h('b', null, plural(delN, 'deletion')), ` since ${opened}.`,
    mags.length ? [' Magnitudes moved by ', h('b', null, fmt.fixed(mad, 2)), ' on average.'] : '');
  const counts = {}; for (const r of log) for (const f of r.fields) counts[f] = (counts[f] || 0) + 1;
  const parts = [['mag', 'magnitude'], ['magType', 'magnitude type'], ['status', 'status'], ['depth', 'depth'], ['epicenter', 'epicenter'], ['place', 'place'], ['id', 'preferred id'], ['type', 'event type'], ['restored', 'restored after a deletion']].filter(([k]) => counts[k]).map(([k, l]) => counts[k] + ' ' + l);
  const touches = cat.touches.filter(t => inRegion(S.region, t)).length;
  fill('#h-rev', h('b', null, 'Live values. '), `${plural(S.dayPolls, 'past day response')} compared. Fields changed: ${parts.length ? parts.join(', ') : 'none yet'}. Mean |ΔM| ${mags.length ? fmt.fixed(mad, 3) + ' over ' + plural(mags.length, 'magnitude revision') : 'not available yet'}. ${plural(touches, 'other update')} changed none of the tracked fields.${cat.logDropped ? ` The log keeps the newest ${cat.maxLog} entries.` : ''}`);
}
const domJob = onPaint(paintDom, 400);
jobs.push(domJob);
setInterval(() => { domJob.invalidate(); stage.job.invalidate(); }, 5000);

// ---------------------------------------------------------------- region control
function setRegion(key) {
  S.region = regionByKey(key);
  try { localStorage.setItem('quakes-region', S.region.key); } catch { /* storage blocked */ }
  for (const b of document.querySelectorAll('#region button')) b.setAttribute('aria-pressed', String(b.dataset.region === S.region.key));
  shownLatest = new Set(); spotShown = '';
  stage.resize(true);
  for (const j of jobs) j.now();
}
for (const b of document.querySelectorAll('#region button')) b.addEventListener('click', () => setRegion(b.dataset.region));
setRegion(S.region.key);

loadWeek();

// Test hook for the browser checks: merges synthetic features as if a poll had
// returned them. Not used by the page itself.
export const _test = { cat, S, analysis, inject(features, which = 'hour') { ingest({ metadata: { generated: Date.now() }, features }, which); } };
