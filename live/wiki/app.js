// Wikipedia edit stream dashboard: connection, state, and painting.
// Sketches and exact counters see the same events; every figure on the page
// is computed here from the stream. The message handler only mutates state and
// marks paint jobs dirty; painting happens on the shared scheduler.
import { fmt, Ring, EWMA, SecondBins, quantiles, isNum, clamp } from '../assets/util.js';
import { $, h, setText, safeHref, boot, Feed, mountFeeds, onPaint, initPause, tableView, mountLegend, palette, rgba } from '../assets/ui.js';
import { TimeChart, Columns } from '../assets/charts.js';
import {
  HyperLogLog, CountMinSketch, SpaceSaving, RecentIds, BurstDetector, murmur3_32,
  hash53, toBytes, sizeBin, SIZE_BINS, SCOPES, isCanary, cmsCollisionShare, dotRadius, rankLanes, wikiLabel,
} from './sketch.js';

const STREAM = 'https://stream.wikimedia.org/v2/stream/recentchange';
const ALLOW = ['wikipedia.org', 'wikimedia.org', 'wikidata.org', 'wiktionary.org', 'wikiquote.org', 'wikisource.org',
  'wikibooks.org', 'wikinews.org', 'wikiversity.org', 'wikivoyage.org', 'mediawiki.org', 'wikifunctions.org'];

// design parameters
const WINDOW_S = 300;          // throughput window
const SETTLE_MS = 2000;        // a second closes once the newest event time is this far past it
const RATE_WARM = 5;           // closed seconds before the rate tile shows a number
const BURST = { halfLife: 60, k: 4, minExcess: 10, warmup: 30 };
const LAG_N = 2000, LAG_MIN = 50, SHARE_MIN = 20;
const TAPE_N = 25, HH_N = 15, CMS_TOP = 12, DELTA_N = 10000, HLL_KEEP = 3600;
const SS_K = 200, CMS_W = 1024, CMS_D = 4, HLL_P = 12;
const CAP_PAGES = 500000, CAP_USERS = 2000000;
const KINDS = ['edit', 'categorize', 'new', 'log'];
const KIND_WORDS = { edit: 'edits', categorize: 'category changes', new: 'new pages', log: 'log actions' };
const RIVER_N = 2000, LANES = 6, SPAN_MIN = 4, SPAN_MAX = 60;

boot();
// on a phone the nav scrolls sideways; bring this page's entry into view
{
  const cur = document.querySelector('.top nav a[aria-current="page"]'), nav = cur && cur.parentElement;
  if (nav) { const a = cur.getBoundingClientRect(), b = nav.getBoundingClientRect(); if (a.right > b.right) nav.scrollLeft += a.left - b.left - 4; }
}

// ------------------------------------------------------------------ transport state (survives scope resets)
const feed = new Feed({ label: 'recentchange', kind: 'stream', staleMs: 15000 });
mountFeeds($('#status'), [feed]);
initPause($('#pause'), [feed]);
const recent = new RecentIds(5000);
const tr = { dupes: 0, canary: 0, bad: 0, opens: 0, maxDt: NaN };
const names = new Map();       // wiki id -> short server name, for display
const label = w => names.get(w) || w;

// ------------------------------------------------------------------ per scope state
let scope = SCOPES[0];
let st = fresh();
function fresh() {
  const t0 = Date.now();
  const first = isNum(tr.maxDt) ? Math.floor(tr.maxDt / 1000) + 1 : NaN;
  return {
    t0, firstSec: first, lastClosed: first - 1, closed: 0, late: 0,
    n: 0, human: 0, bot: 0, newPages: 0,
    bins: new SecondBins(WINDOW_S),
    rate: new EWMA(10), burst: new BurstDetector(BURST), base: null, flags: new Map(), flagsTotal: 0,
    // the same rule on arrival time bins, kept only to show what that binning would flag
    arr: new SecondBins(WINDOW_S), arrFirst: NaN, arrLast: NaN, arrBurst: new BurstDetector(BURST), arrFlags: 0,
    hll: new HyperLogLog(HLL_P), users: new Set(), hllS: new Ring(HLL_KEEP),
    cms: new CountMinSketch(CMS_W, CMS_D), wikis: new Map(),
    ss: new SpaceSaving(SS_K), pages: new Map(), meta: new Map(),
    ssChecks: 0, ssViol: 0, heavyChecks: 0, heavyMissing: 0, heavyNow: 0, trueTop: NaN, c15: NaN,
    size: { human: new Array(11).fill(0), bot: new Array(11).fill(0) },
    deltas: { human: new Ring(DELTA_N), bot: new Ring(DELTA_N) }, edits: { human: 0, bot: 0 },
    kinds: new Map(),
    lag: new Ring(LAG_N),
    tape: new Ring(TAPE_N), seq: 0,
    // edit river
    river: new Ring(RIVER_N), riverStart: NaN, editWikis: new Map(), lanes: [], laneIdx: new Map(), rf: null,
  };
}

function reset(reason) {
  st = fresh();
  tapeSeen = 0;
  rv.wy.clear(); rv.hover = null;
  $('#tape').replaceChildren(h('div', { class: 'empty' }, 'Waiting for events in this scope'));
  setText('#since', 'counters reset at ' + fmt.time(st.t0) + (reason ? ' (' + reason + ')' : ''));
  rateChart.set([]); hllChart.set([]); sizeChart.set([]); kindChart.set([]);
  dirty(); rv.job.now();
}

// ------------------------------------------------------------------ ingestion
function onMessage(e) {
  feed.hit(e.data.length);
  let d;
  try { d = JSON.parse(e.data); } catch { tr.bad++; return; }
  if (!d || typeof d !== 'object' || !d.meta || typeof d.meta !== 'object') return;
  if (isCanary(d)) { tr.canary++; return; }
  if (typeof d.meta.id === 'string' && !recent.add(d.meta.id)) { tr.dupes++; return; }
  const dt = Date.parse(d.meta.dt);
  if (isNum(dt)) {
    if (!(dt <= tr.maxDt)) tr.maxDt = dt;
    if (!isNum(st.firstSec)) { st.firstSec = Math.floor(dt / 1000) + 1; st.lastClosed = st.firstSec - 1; }
  }
  if (!scope.test(d)) return;
  ingest(d, dt, Date.now());
  dirty();
}

function ingest(d, dt, now) {
  const S = st, who = d.bot === true ? 'bot' : 'human';
  S.n++; S[who]++;
  S.arr.add(now);
  if (!isNum(S.arrFirst)) { S.arrFirst = Math.floor(now / 1000) + 1; S.arrLast = S.arrFirst - 1; }
  if (isNum(dt)) {
    const s = Math.floor(dt / 1000);
    S.bins.add(dt, who);
    if (s >= S.firstSec && s <= S.lastClosed) S.late++;
    S.lag.push(now - dt);
  }
  const type = typeof d.type === 'string' ? d.type : 'other';
  let k = S.kinds.get(type);
  if (!k) S.kinds.set(type, k = { human: 0, bot: 0 });
  k[who]++;
  if (type === 'new') S.newPages++;
  // the name is hashed here and not kept anywhere
  if (typeof d.user === 'string') { const b = toBytes(d.user); S.hll.add(b); S.users.add(hash53(b)); }
  const wiki = typeof d.wiki === 'string' ? d.wiki : String(d.meta.domain || 'unknown');
  if (!names.has(wiki)) names.set(wiki, wikiLabel(d.server_name, wiki));
  S.wikis.set(wiki, (S.wikis.get(wiki) || 0) + 1);
  S.cms.add(wiki);
  // User and User talk pages (namespaces 2 and 3) are named after an account or
  // an IP address, so their titles are hashed for counting and never shown
  const raw = typeof d.title === 'string' ? d.title : null;
  const hide = raw !== null && (d.namespace === 2 || d.namespace === 3);
  const title = hide ? (d.namespace === 2 ? 'User page (name hidden)' : 'User talk page (name hidden)') : raw;
  const uri = hide ? '' : d.meta.uri;
  const L = d.length && typeof d.length === 'object' ? d.length : null;
  let delta = NaN;
  if (L && isNum(L.new)) delta = L.new - (isNum(L.old) ? L.old : 0);
  if ((type === 'edit' || type === 'new') && raw !== null) {
    const key = hide ? wiki + '|#' + d.namespace + ':' + hash53(raw) : wiki + '|' + raw;
    S.ss.add(key);
    S.pages.set(key, (S.pages.get(key) || 0) + 1);
    S.meta.set(key, { title, wiki, uri });
    if (S.meta.size > 4 * SS_K) for (const m of S.meta.keys()) if (!S.ss.has(m)) S.meta.delete(m);
  }
  if (type === 'edit' && L && isNum(L.new) && isNum(L.old)) {
    const b = sizeBin(delta);
    if (b >= 0) { S.size[who][b]++; S.deltas[who].push(delta); S.edits[who]++; }
  }
  if ((type === 'edit' || type === 'new') && isNum(dt)) {
    S.editWikis.set(wiki, (S.editWikis.get(wiki) || 0) + 1);
    if (!isNum(S.riverStart)) S.riverStart = now;
    S.river.push({
      t: dt, at: performance.now(), wiki, bot: who === 'bot', isNew: type === 'new', type, delta, title,
      r: dotRadius(delta), jy: (murmur3_32(String(d.meta.id || dt)) / 4294967296) - 0.5, _f: -1, _i: -1,
    });
    if (!S.lanes.length) relane();
  }
  S.tape.push({ seq: ++S.seq, t: isNum(dt) ? dt : now, wiki, type, title, uri, delta, bot: who === 'bot' });
  if (S.pages.size >= CAP_PAGES) reset('exact page map reached ' + fmt.int(CAP_PAGES) + ' keys');
  else if (S.users.size >= CAP_USERS) reset('exact editor set reached ' + fmt.int(CAP_USERS) + ' keys');
}

// Close event time seconds once the newest event time is SETTLE_MS past them.
function closeSeconds() {
  const S = st;
  if (!isNum(S.firstSec) || !isNum(tr.maxDt)) return;
  while ((S.lastClosed + 1) * 1000 + SETTLE_MS <= tr.maxDt) {
    const s = ++S.lastClosed, b = S.bins.bins.get(s), x = b ? (b.human || 0) + (b.bot || 0) : 0;
    S.rate.update(x, s); S.closed++;
    const r = S.burst.push(x, s);
    S.base = r;
    if (r.flag) { S.flags.set(s, { n: x, mean: r.mean, std: r.std }); S.flagsTotal++; }
  }
  for (const s of S.flags.keys()) if (s <= S.lastClosed - WINDOW_S) S.flags.delete(s);
  // arrival seconds close on this computer's clock
  const nowS = Math.floor(Date.now() / 1000);
  while (isNum(S.arrLast) && S.arrLast < nowS - 1) {
    const s = ++S.arrLast, b = S.arr.bins.get(s);
    if (S.arrBurst.push(b ? b.n || 0 : 0, s).flag) S.arrFlags++;
  }
}

// HyperLogLog against the exact set, once a second.
function sampleHll() {
  const S = st, n = S.users.size;
  if (!n) return;
  const d = S.hll.detail();
  S.hllS.push({ t: Date.now(), err: (d.estimate - n) / n * 100, est: d.estimate, exact: n, regime: d.regime });
}

// Check Space-Saving's guarantees against the exact map, once a second.
function checkSpaceSaving() {
  const S = st, ss = S.ss;
  if (!ss.N) return;
  for (const c of ss.heap) {
    const f = S.pages.get(c.item) || 0;
    S.ssChecks++;
    if (!(c.count - c.error <= f && f <= c.count)) S.ssViol++;
  }
  const thr = ss.N / ss.k;
  let heavy = 0;
  const top = [];                    // the 15 largest exact counts, descending
  for (const [key, f] of S.pages) {
    if (f > thr) { heavy++; S.heavyChecks++; if (!ss.has(key)) S.heavyMissing++; }
    if (top.length < HH_N || f > top[top.length - 1]) {
      let i = top.length; top.push(f);
      while (i > 0 && top[i - 1] < f) { top[i] = top[i - 1]; i--; }
      top[i] = f;
      if (top.length > HH_N) top.pop();
    }
  }
  S.heavyNow = heavy;
  S.c15 = top.length ? top[top.length - 1] : NaN;
  const shown = ss.top(HH_N);
  S.trueTop = shown.filter(c => (S.pages.get(c.item) || 0) >= S.c15).length;
}

// River lanes: the busiest wikis by edits, with hysteresis so rows settle.
function relane() {
  const S = st;
  S.lanes = rankLanes(S.lanes, S.editWikis, LANES);
  S.laneIdx = new Map(S.lanes.map((w, i) => [w, i]));
}

// River facts: recent counts per wiki, the largest change, and the stage footer.
function riverFacts() {
  const S = st, R = S.river, now = Date.now();
  let n10 = 0, n60 = 0, h60 = 0, best = null;
  const per = new Map();
  for (let i = 0; i < R.length; i++) {
    const d = R.at(i), age = now - d.t;
    if (age > SPAN_MAX * 1000) continue;
    n60++; if (!d.bot) h60++;
    if (age <= 10000) n10++;
    per.set(d.wiki, (per.get(d.wiki) || 0) + 1);
    if (isNum(d.delta) && (!best || Math.abs(d.delta) > Math.abs(best.delta))) best = d;
  }
  const el = isNum(S.riverStart) ? (now - S.riverStart) / 1000 : 0;
  let top = null;
  for (const [w, c] of per) if (!top || c > top[1]) top = [w, c];
  S.rf = { n10, n60, h60, per, best, win: clamp(el, 1, SPAN_MAX), w10: clamp(el, 1, 10), top };
}

setInterval(closeSeconds, 250);
setInterval(() => { sampleHll(); checkSpaceSaving(); dirty(); }, 1000);
setInterval(() => { relane(); riverFacts(); factsJob.invalidate(); }, 500);

// ------------------------------------------------------------------ paint helpers
const jobs = [];
const job = (fn, ms) => { const j = onPaint(fn, ms); jobs.push(j); return j; };
function dirty() { for (const j of jobs) j.invalidate(); }

const NA = fmt.int(NaN);       // util's missing value glyph
const signedInt = x => !isNum(x) ? NA : (x > 0 ? '+' : x < 0 ? '−' : '') + fmt.int(Math.abs(x));
const secs = ms => { const s = ms / 1000; return Math.abs(s) < 10 ? s.toFixed(1) : s.toFixed(0); };
const pctTick = v => { const p = v * 100; return (Math.abs(p - Math.round(p)) < 1e-9 ? p.toFixed(0) : p.toFixed(1)) + '%'; };
const errTick = v => (v > 0 ? '+' : v < 0 ? '−' : '') + (Number.isInteger(v) ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)) + '%';
const median = ring => { const a = ring.toArray(); return a.length ? quantiles(a, [0.5])[0] : NaN; };
const rate1 = r => r < 10 ? fmt.fixed(r, 1) : fmt.int(r);
const plural = (n, one, many) => fmt.int(n) + ' ' + (n === 1 ? one : many);

// KPI tile: value parts (strings, or [text] for a small unit), or a compact waiting state
function kpi(id, value, sub) {
  const el = $('#' + id), key = JSON.stringify(value);
  if (el._k !== key) {
    el._k = key;
    el.removeAttribute('data-wait');
    el.replaceChildren(...value.map(v => Array.isArray(v) ? h('small', null, v[0]) : v));
  }
  setText('#' + id + '-s', sub);
}
function kpiWait(id, have, need, unit, sub) {
  const el = $('#' + id), key = 'w' + have + '/' + need + unit;
  if (el._k !== key) {
    el._k = key;
    el.setAttribute('data-wait', '');
    const bar = need ? h('i', { class: 'kprog', 'aria-hidden': 'true' }, h('b', { style: { width: clamp(have / need, 0, 1) * 100 + '%' } })) : null;
    el.replaceChildren(need ? have + ' / ' + need + (unit ? ' ' + unit : '') : 'waiting', bar);
  }
  setText('#' + id + '-s', sub);
}
function foot(id, ...parts) {
  const el = $('#' + id), key = JSON.stringify(parts);
  if (el._k === key) return;
  el._k = key;
  el.replaceChildren(...parts.map(p => Array.isArray(p) ? h('b', null, p[0]) : p));
}

// ------------------------------------------------------------------ KPIs
job(() => {
  const S = st, since = fmt.time(S.t0);
  if (S.closed < RATE_WARM) kpiWait('k-rate', S.closed, RATE_WARM, 's', 'learning the rate');
  else kpi('k-rate', [fmt.fixed(S.rate.mean, 1)], fmt.int(S.n) + ' since ' + since + ', smoothed over 10 s');

  const last = S.hllS.last();
  if (!last) kpiWait('k-hll', 0, 0, '', 'estimated in 4 KB');
  else kpi('k-hll', [last.est < 10000 ? fmt.fixed(last.est, 1) : fmt.int(last.est)], 'exact ' + fmt.int(last.exact) + ', off by ' + fmt.signed(last.err, 1) + '% (typical 1.6%)');

  if (S.n < SHARE_MIN) kpiWait('k-human', S.n, SHARE_MIN, '', 'the rest by bot accounts');
  else kpi('k-human', [fmt.pct(S.human / S.n, 1)], 'the rest by accounts flagged as bots');

  const el = (Date.now() - S.t0) / 1000;
  if (!S.n) kpiWait('k-new', 0, 0, '', 'pages created');
  else kpi('k-new', [fmt.int(S.newPages)], el >= 60 ? fmt.fixed(S.newPages / (el / 60), 1) + ' a minute' : 'pages created; rate after 1 minute');

  if (!S.n) kpiWait('k-pages', 0, 0, '', 'counted exactly');
  else kpi('k-pages', [fmt.int(S.pages.size)], 'edited or created, counted exactly');

  if (!S.n) kpiWait('k-wikis', 0, 0, '', 'counted exactly');
  else kpi('k-wikis', [fmt.int(S.wikis.size)], 'counted exactly since ' + since);

  if (S.lag.length < LAG_MIN) kpiWait('k-lag', S.lag.length, LAG_MIN, '', 'median / 95th percentile');
  else {
    const [p50, p95] = quantiles(S.lag.toArray(), [0.5, 0.95]);
    kpi('k-lag', [secs(p50) + ' / ' + secs(p95), [' s']], 'median / 95th percentile; includes clock offset');
  }
}, 500);

// ------------------------------------------------------------------ the stage: edit river
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const stage = $('#stage'), riverBox = $('#river'), spot = $('#spot');
mountLegend($('.stage__legend', stage), [{ label: 'People', color: 1, shape: 'dot' }, { label: 'Bots', color: 2, shape: 'dot' }, { label: 'New page', color: 'ink', shape: 'ring' }]);
const rv = {
  cv: h('canvas', { role: 'img', 'aria-label': 'Edit river: each dot is one edit, in a row for its wiki, drifting left as it ages' }),
  tip: h('div', { class: 'tip', 'aria-hidden': 'true' }),
  w: 0, h: 0, dpr: 1, top: 96, mobile: false, frame: 0, frameT: 0, lastPerf: 0, lh: NaN,
  px: new Float32Array(RIVER_N), py: new Float32Array(RIVER_N), pr: new Float32Array(RIVER_N), pc: new Uint8Array(RIVER_N), pi: new Int32Array(RIVER_N), n: 0,
  wy: new Map(), hover: null, mx: NaN, my: NaN, labels: new Map(), spotBox: null,
};
riverBox.append(rv.cv, rv.tip);
rv.ctx = rv.cv.getContext('2d');
function riverLayout() {
  const w = Math.max(240, Math.floor(riverBox.clientWidth));
  const mobile = getComputedStyle($('.stage__cap', stage)).position === 'static';
  const hgt = mobile ? 300 : 380;
  if (w !== rv.w || hgt !== rv.h || rv.dpr !== (devicePixelRatio || 1)) {
    rv.w = w; rv.h = hgt; rv.dpr = devicePixelRatio || 1;
    rv.cv.width = Math.round(w * rv.dpr); rv.cv.height = Math.round(hgt * rv.dpr);
    rv.cv.style.height = hgt + 'px'; rv.labels.clear();
  }
  rv.mobile = mobile;
  placeSpot();
}
// On wide screens the caption, legend and callout float over the top of the
// canvas; the lanes start below the lowest of them.
function placeSpot() {
  if (rv.mobile) { rv.top = 10; rv.spotBox = null; return; }
  const sb = stage.getBoundingClientRect(), cap = $('.stage__cap', stage).getBoundingClientRect(), leg = $('.stage__legend', stage).getBoundingClientRect();
  const sw = spot.offsetWidth, shh = Math.max(spot.offsetHeight, 92);
  let left = cap.right - sb.left + 20, top = 14;
  if (left + sw > leg.left - sb.left - 16) { left = sb.width - sw - 14; top = leg.bottom - sb.top + 8; }
  spot.style.left = left + 'px'; spot.style.top = top + 'px';
  rv.spotBox = { x: left, y: top, w: sw, h: spot.offsetHeight };
  rv.top = Math.round(Math.max(cap.bottom - sb.top, leg.bottom - sb.top, top + shh) + 12);
}
new ResizeObserver(() => { riverLayout(); rv.job.now(); }).observe(riverBox);

function fitText(c, s, max) {
  const key = s + '|' + max;
  let t = rv.labels.get(key);
  if (t !== undefined) return t;
  t = s;
  if (c.measureText(t).width > max) { while (t.length > 1 && c.measureText(t + '…').width > max) t = t.slice(0, -1); t += '…'; }
  if (rv.labels.size > 400) rv.labels.clear();
  rv.labels.set(key, t);
  return t;
}

function paintRiver(tPerf) {
  const c = rv.ctx, p = palette(), W = rv.w, H = rv.h, S = st, R = S.river, reduce = RM.matches;
  c.setTransform(rv.dpr, 0, 0, rv.dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const now = Date.now(), frame = ++rv.frame;
  rv.frameT = now;
  const dtF = rv.lastPerf ? (tPerf - rv.lastPerf) / 1000 : 1;
  rv.lastPerf = tPerf;
  // after a gap (first frame, or the tab was hidden) everything snaps to place
  const ease = reduce || dtF > 0.25 ? 1 : 1 - Math.exp(-dtF / 0.3);
  const labelW = rv.mobile ? 96 : 156, left = labelW + 6, right = W - (rv.mobile ? 10 : 16);
  const top = rv.top, bottom = H - 24;
  const el = isNum(S.riverStart) ? (now - S.riverStart) / 1000 : 0;
  const span = clamp(el + 1, SPAN_MIN, SPAN_MAX) * 1000;
  const X = age => right - clamp(age, 0, span) / span * (right - left);
  const order = S.lanes, hasOther = S.editWikis.size > order.length;
  const nL = Math.max(1, order.length + (hasOther ? 1 : 0));
  const lhT = (bottom - top) / nL;
  rv.lh = isNum(rv.lh) ? rv.lh + (lhT - rv.lh) * ease : lhT;
  const laneY = i => top + lhT * (i + 0.5);
  const otherIdx = order.length;
  const target = w => laneY(S.laneIdx.has(w) ? S.laneIdx.get(w) : otherIdx);

  // time grid and axis
  const step = span <= 6000 ? 1000 : span <= 12000 ? 2000 : span <= 30000 ? 5000 : 15000;
  c.font = '10.5px ' + p.mono; c.textBaseline = 'alphabetic'; c.lineWidth = 1;
  let lastLab = 0;                       // the leftmost labelled tick carries "ago"
  for (let a = step; a <= span + 1; a += step) if (X(a) - left > 30) lastLab = a;
  for (let a = 0; a <= span + 1; a += step) {
    const x = Math.round(X(a)) + 0.5;
    c.strokeStyle = a === 0 ? p.axis : p.grid;
    c.beginPath(); c.moveTo(x, top - 4); c.lineTo(x, bottom); c.stroke();
    c.fillStyle = p.muted;
    c.textAlign = a === 0 ? 'right' : 'center';
    if (a === 0) c.fillText('now', x + 2, H - 8);
    else if (a <= lastLab) c.fillText((a / 1000) + ' s' + (a === lastLab ? ' ago' : ''), x, H - 8);
  }
  // lane separators
  c.strokeStyle = p.grid;
  for (let i = 1; i < nL; i++) { const y = Math.round(top + rv.lh * i) + 0.5; c.beginPath(); c.moveTo(0, y); c.lineTo(right, y); c.stroke(); }

  // ease each wiki toward its lane, and its label toward visible or hidden
  for (const [w, e] of rv.wy) {
    const ty = w === '\u0000other' ? laneY(otherIdx) : target(w);
    e.y += (ty - e.y) * ease;
    const ta = w === '\u0000other' ? (hasOther ? 1 : 0) : (S.laneIdx.has(w) ? 1 : 0);
    // labels never slide past each other: a label that moves to another row jumps there and
    // fades in, while its dots glide; small shifts (a resize) just track; a leaving label fades where it stood
    if (ta) { if (!isNum(e.ly) || Math.abs(ty - e.ly) > rv.lh * 0.5) { e.ly = ty; e.a = 0; } else e.ly = ty; }
    e.a += (ta - e.a) * (ta ? ease : Math.min(1, ease * 2));
  }
  const wyGet = w => { let e = rv.wy.get(w); if (!e) { const y = target(w); e = { y, ly: y, a: 0 }; rv.wy.set(w, e); } return e; };
  for (const w of order) wyGet(w);
  if (hasOther && !rv.wy.has('\u0000other')) rv.wy.set('\u0000other', { y: laneY(otherIdx), ly: laneY(otherIdx), a: 0 });

  // lane labels: name, then the edit rate over the river's window
  const rf = S.rf, win = rf ? rf.win : 1;
  for (const [w, e] of rv.wy) {
    if (e.a < 0.02) continue;
    let name, n;
    if (w === '\u0000other') {
      name = 'all others'; n = 0;
      if (rf) { let lanes = 0; for (const lw of order) lanes += rf.per.get(lw) || 0; n = rf.n60 - lanes; }
    } else { name = label(w); n = rf ? rf.per.get(w) || 0 : 0; }
    c.globalAlpha = e.a;
    c.textAlign = 'left';
    c.font = (rv.mobile ? '11px ' : '12px ') + p.mono; c.fillStyle = p.ink2;
    c.fillText(fitText(c, name, labelW - 14), rv.mobile ? 10 : 16, e.ly - 1);
    c.font = '10.5px ' + p.mono; c.fillStyle = p.muted;
    c.fillText(rate1(n / win) + ' edits/s', rv.mobile ? 10 : 16, e.ly + 12);
  }
  c.globalAlpha = 1;

  if (!R.length) {
    c.fillStyle = p.ink3; c.font = '13px ' + p.sans; c.textAlign = 'center';
    c.fillText('Waiting for the first edit', (left + right) / 2, (top + bottom) / 2);
    rv.n = 0;
    if (!reduce) rv.job.invalidate();
    return;
  }

  // dot positions for this frame, into preallocated arrays
  const spread = Math.min(rv.lh * 0.74, 64), rs = rv.mobile ? 0.85 : 1;
  let n = 0;
  for (let i = 0; i < R.length; i++) {
    const d = R.at(i), age = now - d.t;
    if (age > span) continue;
    const e = wyGet(d.wiki);
    let r = d.r * rs;
    if (!reduce) { const g = (tPerf - d.at) / 350; if (g < 1) r *= g <= 0 ? 0.05 : 1 - (1 - g) * (1 - g); }
    rv.px[n] = X(age); rv.py[n] = e.y + d.jy * spread; rv.pr[n] = r;
    rv.pc[n] = (d.bot ? 1 : 0) + (d.isNew ? 2 : 0); rv.pi[n] = i;
    d._f = frame; d._i = n;
    n++;
  }
  rv.n = n;

  c.save();
  c.beginPath(); c.rect(left - 8, top - 6, right - left + 16, bottom - top + 8); c.clip();
  const cols = [p.color(1), p.color(2)];
  for (let k = 0; k < 2; k++) {          // filled dots, people then bots
    c.beginPath();
    for (let j = 0; j < n; j++) if (rv.pc[j] === k) { const x = rv.px[j], y = rv.py[j], r = rv.pr[j]; c.moveTo(x + r, y); c.arc(x, y, r, 0, 6.2832); }
    c.fillStyle = rgba(cols[k], 0.8); c.fill();
  }
  c.lineWidth = 1.6;
  for (let k = 0; k < 2; k++) {          // new pages as rings
    c.beginPath();
    for (let j = 0; j < n; j++) if (rv.pc[j] === k + 2) { const x = rv.px[j], y = rv.py[j], r = rv.pr[j] + 1.5; c.moveTo(x + r, y); c.arc(x, y, r, 0, 6.2832); }
    c.fillStyle = p.surface; c.fill(); c.strokeStyle = cols[k]; c.stroke();
  }
  // the largest change in the last minute, and the hovered dot
  const best = rf && rf.best && rf.best._f === frame ? rf.best : null;
  if (best) {
    const j = best._i, x = rv.px[j], y = rv.py[j];
    c.strokeStyle = p.ink; c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, rv.pr[j] + 4, 0, 6.2832); c.stroke();
  }
  // keep the hovered dot under a resting pointer as the river flows
  if (isNum(rv.mx)) hoverAt(rv.mx, rv.my);
  const hv = rv.hover && rv.hover._f === frame ? rv.hover : null;
  if (hv) {
    const j = hv._i;
    c.strokeStyle = p.ink; c.lineWidth = 2;
    c.beginPath(); c.arc(rv.px[j], rv.py[j], rv.pr[j] + 3, 0, 6.2832); c.stroke();
  }
  c.restore();
  if (best && rv.spotBox) {             // leader line from the callout to its dot
    const j = best._i, b = rv.spotBox;
    const sx = clamp(rv.px[j], b.x + 12, b.x + b.w - 12), sy = b.y + b.h;
    c.strokeStyle = p.ink3; c.lineWidth = 1;
    c.beginPath(); c.moveTo(sx, sy); c.lineTo(rv.px[j], rv.py[j] - rv.pr[j] - 4); c.stroke();
  }
  if (!reduce) rv.job.invalidate();
}
rv.job = onPaint(paintRiver, 33);
setInterval(() => { if (RM.matches) rv.job.now(); }, 1000);

function hoverAt(x, y) {
  let best = -1, bd = 24 * 24;
  for (let j = 0; j < rv.n; j++) { const dx = rv.px[j] - x, dy = rv.py[j] - y, q = dx * dx + dy * dy; if (q < bd) { bd = q; best = j; } }
  const d = best >= 0 ? st.river.at(rv.pi[best]) : null;
  if (d !== rv.hover || (d && rv.frameT - rv.tipAt > 500)) { rv.hover = d; showRiverTip(d, x, y); }
  else if (d) placeTip(x, y);
}
function showRiverTip(d, x, y) {
  const t = rv.tip;
  if (!d) { t.style.display = 'none'; return; }
  rv.tipAt = rv.frameT;
  const p = palette(), age = Math.max(0, rv.frameT - d.t);
  t.replaceChildren(
    h('div', { class: 'tip__h' }, label(d.wiki) + ' · ' + (d.isNew ? 'new page' : 'edit')),
    h('div', { class: 'tip__t' }, d.title === null ? '(no title)' : d.title),
    h('div', { class: 'tip__r' }, h('i', { style: { background: p.color(d.bot ? 2 : 1), height: '8px', width: '8px', borderRadius: '50%' } }), h('b', null, isNum(d.delta) ? signedInt(d.delta) + ' bytes' : 'size not given'), h('span', null, d.bot ? 'by a bot' : 'by a person')),
    h('div', { class: 'tip__r' }, h('i', null), h('b', null, fmt.dur(age)), h('span', null, 'ago')));
  t.style.display = 'block';
  placeTip(x, y);
}
function placeTip(x, y) {
  const t = rv.tip, tw = t.offsetWidth, th = t.offsetHeight;
  let lx = x + 14; if (lx + tw > rv.w) lx = x - tw - 14; lx = clamp(lx, 0, Math.max(0, rv.w - tw));
  let ty = y - th - 10; if (ty < 0) ty = y + 14;
  t.style.left = lx + 'px'; t.style.top = ty + 'px';
}
rv.cv.addEventListener('pointermove', e => { rv.mx = e.offsetX; rv.my = e.offsetY; hoverAt(rv.mx, rv.my); rv.job.now(); });
rv.cv.addEventListener('pointerleave', () => { rv.mx = rv.my = NaN; rv.hover = null; rv.tip.style.display = 'none'; rv.job.now(); });

// stage footer facts and the callout, twice a second
const factsJob = onPaint(() => {
  const S = st, rf = S.rf;
  if (!rf || !rf.n60) {
    foot('sf1', 'Waiting for the first edit'); foot('sf2'); foot('sf3'); foot('sf4');
    setText('#spot-v', 'waiting'); setText('#spot-t', ''); setText('#spot-m', '');
    return;
  }
  foot('sf1', [fmt.int(rf.n10)], ' edits in the last ' + (rf.w10 < 10 ? Math.round(rf.w10) + ' s' : '10 s'));
  foot('sf2', [fmt.pct(rf.h60 / rf.n60, 0)], ' by people in the last ' + (rf.win < SPAN_MAX ? Math.round(rf.win) + ' s' : 'minute'));
  if (rf.top) foot('sf3', 'busiest: ', [label(rf.top[0])], ' at ' + rate1(rf.top[1] / rf.win) + ' edits/s');
  const last = S.hllS.last();
  foot('sf4', ...(last ? [[fmt.int(last.est)], ' different editors since ' + fmt.time(S.t0, false, false) + ' (estimate)'] : []));
  const b = rf.best;
  if (b) {
    setText('#spot-k', 'Largest change in the last ' + (rf.win < SPAN_MAX ? Math.round(rf.win) + ' s' : 'minute'));
    setText('#spot-v', signedInt(b.delta) + ' bytes');
    setText('#spot-t', b.title === null ? '(no title)' : b.title);
    setText('#spot-m', label(b.wiki) + ' · ' + (b.bot ? 'bot' : 'person') + ' · ' + fmt.dur(Math.max(0, Date.now() - b.t)) + ' ago');
    if (rv.spotFor !== b) { rv.spotFor = b; placeSpot(); }
  }
}, 500);
riverLayout();

// ------------------------------------------------------------------ 1. throughput
const cRate = $('#c-rate');
mountLegend($('.legend', cRate), [{ label: 'People', color: 1, shape: 'rect' }, { label: 'Bots', color: 2, shape: 'rect' }]);
const rateChart = new TimeChart($('.card__b', cRate), {
  height: 220, aria: 'Changes per second, people and bots, last 5 minutes',
  series: [{ key: 'human', label: 'People', color: 1, stack: 'a', fmt: fmt.int }, { key: 'bot', label: 'Bots', color: 2, stack: 'a', fmt: fmt.int }],
  x: { span: WINDOW_S * 1000 }, y: { fmt: fmt.int, tipFmt: fmt.int },
  empty: 'Waiting for the first complete second',
  tipExtra: r => {
    const f = st.flags.get(r.t / 1000), out = [{ value: isNum(r.human) ? fmt.int(r.human + r.bot) : NA, label: 'total' }];
    if (f) out.push({ value: 'burst', label: 'over ' + fmt.fixed(f.mean + BURST.k * f.std, 1) });
    return out;
  },
});
// closed seconds in the window; seconds before counting started are NaN, not zero
function rateRows() {
  const S = st;
  if (!isNum(S.firstSec) || S.lastClosed < S.firstSec) return [];
  return S.bins.rows((S.lastClosed + 1) * 1000, ['human', 'bot']).map(r => r.t < S.firstSec * 1000 ? { t: r.t, human: NaN, bot: NaN } : r);
}
job(() => {
  const S = st, rows = rateRows();
  if (!rows.length) rateChart.set([]);
  else rateChart.set(rows, { now: (S.lastClosed + 1) * 1000, marks: [...S.flags.keys()].map(s => ({ t: s * 1000, color: 'ink' })) });
  if (!S.burst.ready) foot('f-rate', 'Learning the usual rate before flagging bursts: ', [Math.min(S.closed, BURST.warmup) + ' / ' + BURST.warmup + ' s'], '.');
  else {
    const nb = S.flags.size;
    foot('f-rate', 'Usually about ', [fmt.int(S.base.mean)], ' changes a second, give or take ' + fmt.int(S.base.std) + '. ',
      nb ? [plural(nb, 'burst', 'bursts')] : 'No bursts', ' in the last 5 minutes.');
  }
  foot('h-rate', 'Now μ = ', [fmt.fixed(S.base ? S.base.mean : NaN, 1)], ' and σ = ', [fmt.fixed(S.base ? S.base.std : NaN, 1)], ' changes/s. Bursts since ' + fmt.time(S.t0) + ': ' + fmt.int(S.flagsTotal) + '. ',
    [fmt.int(S.late)], (S.late === 1 ? ' late event' : ' late events') + ' missed the detector. The same rule on arrival time bins flagged ', [fmt.int(S.arrFlags)],
    S.arrBurst.ready ? '.' : ' (its baseline is still forming).');
}, 1000);
tableView(cRate, () => ({
  cols: [{ key: 't', label: 'Second', fmt: t => fmt.time(t) }, { key: 'human', label: 'People', fmt: fmt.int }, { key: 'bot', label: 'Bots', fmt: fmt.int },
    { key: 'total', label: 'Total', fmt: fmt.int }, { key: 'flag', label: 'Burst', fmt: v => v ? 'flagged' : '' }],
  rows: rateRows().filter(r => isNum(r.human)).reverse().map(r => ({ ...r, total: r.human + r.bot, flag: st.flags.has(r.t / 1000) })),
}));

// ------------------------------------------------------------------ 2. HyperLogLog error
const cHll = $('#c-hll');
const SE = 1.04 / Math.sqrt(1 << HLL_P) * 100;
mountLegend($('.legend', cHll), [{ label: 'estimate error, %', color: 3, shape: '' }]);
const hllChart = new TimeChart($('.card__b', cHll), {
  height: 220, aria: 'HyperLogLog relative error over time',
  series: [{ key: 'err', label: 'error', color: 3, fmt: v => fmt.signed(v, 2) + '%' }],
  y: { min: -4, max: 4, fmt: errTick, zero: true },
  refs: [{ y: SE, label: '+1σ' }, { y: -SE, label: '−1σ' }],
  bands: [{ y0: -2 * SE, y1: 2 * SE, label: '±2σ' }],
  empty: 'Waiting for two samples',
  tipExtra: r => [{ value: fmt.fixed(r.est, 1), label: 'estimate' }, { value: fmt.int(r.exact), label: 'exact' }],
});
job(() => {
  const S = st, rows = S.hllS.toArray();
  hllChart.set(rows.length >= 2 ? rows : []);
  const last = S.hllS.last();
  if (!last) { foot('f-hll', 'Waiting for the first editor.'); foot('h-hll'); return; }
  foot('f-hll', 'Estimate ', [fmt.fixed(last.est, 1)], ' against an exact ', [fmt.int(last.exact)], ', off by ' + fmt.signed(last.err, 1) + '%. It stays at 4 KB while the exact list keeps growing.');
  foot('h-hll', 'Branch now: ' + (last.regime === 'linear' ? 'linear counting (raw estimate at most 10,240)' : last.regime === 'raw' ? 'raw estimate (above 10,240)' : 'large range correction') +
    '. Exact set: ', [fmt.int(S.users.size)], ' keys, each a 53 bit hash of a name.');
}, 1000);
tableView(cHll, () => ({
  cols: [{ key: 't', label: 'Time', fmt: t => fmt.time(t) }, { key: 'exact', label: 'Exact', fmt: fmt.int }, { key: 'est', label: 'Estimate', fmt: v => fmt.fixed(v, 1) },
    { key: 'err', label: 'Error', fmt: v => fmt.signed(v, 2) + '%' }, { key: 'regime', label: 'Branch', left: true }],
  rows: st.hllS.toArray().reverse().slice(0, 600),
}));

// ------------------------------------------------------------------ 3. heavy hitters
const cHh = $('#c-hh');
mountLegend($('.legend', cHh), [{ label: 'guaranteed minimum', color: 4, shape: 'rect' }, { label: 'possible overcount', color: 'other', shape: 'rect' }, { label: 'exact count (tick)', color: 'ink', shape: '' }]);
const pageLink = (title, uri) => {
  const href = safeHref(uri, ALLOW), text = title === null ? '(no title)' : title;
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : h('span', null, text);
};
function hhRows() {
  const S = st;
  return S.ss.top(HH_N).map((c, i) => {
    const bar = c.item.indexOf('|'), rest = c.item.slice(bar + 1);
    const m = S.meta.get(c.item) || { title: rest.startsWith('#2') ? 'User page (name hidden)' : rest.startsWith('#3') ? 'User talk page (name hidden)' : rest, wiki: c.item.slice(0, bar), uri: '' };
    const exact = S.pages.get(c.item) || 0;
    return { rank: i + 1, title: m.title, wiki: label(m.wiki), uri: m.uri, est: c.count, err: c.error, lo: c.count - c.error, exact, ok: c.count - c.error <= exact && exact <= c.count };
  });
}
job(() => {
  const S = st, rows = hhRows(), box = $('#hh');
  if (!rows.length) {
    if (!box.querySelector('.empty')) box.replaceChildren(h('div', { class: 'empty' }, 'Waiting for the first edit in this scope'));
  } else {
    const max = Math.max(...rows.map(r => Math.max(r.est, r.exact)));
    const w = v => (v / max * 100).toFixed(2) + '%';
    const head = h('div', { class: 'row hh__h', 'aria-hidden': 'true' }, h('div', { class: 'row__l' }, 'page'),
      h('div', { class: 'row__v' }, h('span', null, 'est'), h('span', null, 'min'), h('span', null, 'exact')));
    box.replaceChildren(head, ...rows.map(r => h('div', { class: 'row' },
      h('div', { class: 'row__l' }, h('span', { class: 'rk' }, String(r.rank)), h('span', { class: 'pill' }, r.wiki), pageLink(r.title, r.uri)),
      h('div', { class: 'row__v' },
        h('span', { title: 'estimated count' }, fmt.int(r.est)),
        h('span', { title: 'guaranteed minimum, count minus error' }, fmt.int(r.lo)),
        h('span', { title: 'exact count' }, fmt.int(r.exact)),
        r.ok ? null : h('span', { class: 'badge badge--critical' }, 'bound broken')),
      h('div', { class: 'row__bar', 'aria-hidden': 'true' },
        h('i', { class: 'all', style: { width: w(r.est) } }), h('i', { class: 'lo', style: { width: w(r.lo) } }),
        h('u', { style: { left: 'calc(' + w(r.exact) + ' - 1px)' } })))));
  }
  const ss = S.ss;
  if (!ss.N) { foot('f-hh', 'Waiting for edits.'); foot('h-hh'); return; }
  foot('f-hh', ...(S.ssViol ? [[fmt.int(S.ssViol)], ' counts broke their guarantee in ' + fmt.int(S.ssChecks) + ' checks. '] :
    ['Every count has stayed inside its guarantee: ', ['0'], ' misses in ' + fmt.int(S.ssChecks) + ' checks. ']),
  ...(isNum(S.trueTop) ? [[String(S.trueTop)], ' of these ' + Math.min(HH_N, ss.size) + ' pages belong in the exact top 15.'] : []));
  foot('h-hh', 'N = ' + fmt.int(ss.N) + ' edits and creations, so N / k = ', [fmt.fixed(ss.threshold, 1)], ': ' + fmt.int(S.heavyMissing) + ' of ' + fmt.int(S.heavyChecks) +
    ' checks found a page above N / k missing (' + plural(S.heavyNow, 'such page', 'such pages') + ' now). Exact map: ' + fmt.int(S.pages.size) + ' pages and growing.');
}, 1000);
tableView(cHh, () => ({
  cols: [{ key: 'rank', label: '#', fmt: String }, { key: 'title', label: 'Page', left: true }, { key: 'wiki', label: 'Wiki', left: true },
    { key: 'est', label: 'Estimate', fmt: fmt.int }, { key: 'err', label: 'Error', fmt: fmt.int }, { key: 'lo', label: 'Minimum', fmt: fmt.int },
    { key: 'exact', label: 'Exact', fmt: fmt.int }, { key: 'ok', label: 'Bounds hold', fmt: v => v ? 'yes' : 'no' }],
  rows: hhRows(),
}));

// ------------------------------------------------------------------ 4. Count-Min per wiki
job(() => {
  const S = st, cms = S.cms, box = $('#cms');
  if (!S.wikis.size) {
    if (!box.querySelector('.empty')) box.replaceChildren(h('div', { class: 'empty' }, 'Waiting for the first event in this scope'));
    foot('f-cms', 'Waiting for events.'); foot('h-cms');
    return;
  }
  const bound = cms.bound();
  let under = 0, over = 0, inflated = 0, maxOver = 0;
  for (const [k, f] of S.wikis) {
    const e = cms.estimate(k);
    if (e < f) under++;
    if (e > f) inflated++;
    if (e - f > bound) over++;
    maxOver = Math.max(maxOver, e - f);
  }
  const top = [...S.wikis].sort((a, b) => b[1] - a[1]).slice(0, CMS_TOP).map(([wiki, exact]) => {
    const est = cms.estimate(wiki);
    return { wiki, exact, est, over: est - exact, ok: est - exact <= bound };
  });
  const within = top.filter(r => r.ok).length;
  box.replaceChildren(h('table', { class: 'cmst' },
    h('thead', null, h('tr', null, ['Wiki', 'Exact', 'Estimate', 'Over', 'Within bound'].map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', null, top.map(r => h('tr', null,
      h('td', null, label(r.wiki)), h('td', null, fmt.int(r.exact)), h('td', null, fmt.int(r.est)),
      h('td', { class: r.over ? null : 'z' }, '+' + fmt.int(r.over)),
      h('td', null, h('span', { class: 'badge ' + (r.ok ? 'badge--good' : 'badge--critical') }, r.ok ? 'within' : 'over')))))));
  const K = S.wikis.size, exp = cmsCollisionShare(K, CMS_W, CMS_D);
  if (K === 1) foot('f-cms', 'This scope has one wiki, so nothing can collide. Choose All projects or Wikipedia to see collisions.');
  else foot('f-cms', within === top.length ? 'All ' : within + ' of ', [String(top.length)], ' estimates are within the allowed error, and the largest overcount across ' + fmt.int(K) + ' wikis is ', [fmt.int(maxOver)], '.');
  foot('h-cms', 'Now N = ' + fmt.int(cms.N) + ' changes, so ε N = ', [fmt.fixed(bound, 1)], '. Across ' + (K === 1 ? 'the one wiki' : 'all ' + fmt.int(K) + ' wikis') + ': ' + over + ' over ε N, ' + inflated +
    ' inflated at all (' + fmt.pct(inflated / K, 1) + '; expected under uniform hashing ' + fmt.pct(exp, 3) + '), ' + under + ' undercounts.');
}, 1000);

// ------------------------------------------------------------------ 5. edit size
const cSize = $('#c-size');
mountLegend($('.legend', cSize), [{ label: 'People', color: 1, shape: 'rect' }, { label: 'Bots', color: 2, shape: 'rect' }]);
const sizeChart = new Columns($('.card__b', cSize), {
  height: 200, aria: 'Share of edits by byte change, people and bots',
  series: [{ key: 'hs', label: 'People', color: 1, fmt: v => fmt.pct(v, 1) }, { key: 'bs', label: 'Bots', color: 2, fmt: v => fmt.pct(v, 1) }],
  y: { fmt: pctTick }, empty: 'Waiting for edits',
  tipExtra: k => [{ value: fmt.int(k.hn), label: 'edits by people' }, { value: fmt.int(k.bn), label: 'edits by bots' }],
});
function sizeCats() {
  const S = st, H = S.edits.human, B = S.edits.bot;
  return SIZE_BINS.map((b, i) => ({ label: b.label, tip: b.tip, hn: S.size.human[i], bn: S.size.bot[i], hs: H ? S.size.human[i] / H : 0, bs: B ? S.size.bot[i] / B : 0 }));
}
const sizeWords = m => !isNum(m) ? 'has no size yet' : m > 0 ? 'adds ' + fmt.int(m) + ' bytes' : m < 0 ? 'removes ' + fmt.int(-m) + ' bytes' : 'leaves the size unchanged';
job(() => {
  const S = st;
  if (!S.edits.human && !S.edits.bot) { sizeChart.set([]); foot('f-size', 'Waiting for edits.'); foot('h-size'); return; }
  sizeChart.set(sizeCats());
  const mh = S.edits.human ? median(S.deltas.human) : NaN, mb = S.edits.bot ? median(S.deltas.bot) : NaN;
  foot('f-size', 'A typical edit by a person ', [sizeWords(mh)], '; a typical bot edit ', [sizeWords(mb)], '.');
  const part = (who, word) => word + ' ' + signedInt(who === 'human' ? mh : mb) + ' bytes (' + fmt.int(S.edits[who]) + ' edits)';
  foot('h-size', 'Medians' + (S.edits.human > DELTA_N || S.edits.bot > DELTA_N ? ' over the latest ' + fmt.int(DELTA_N) + ' edits per group' : '') + ': ' + part('human', 'people') + ', ' + part('bot', 'bots') + '.');
}, 1000);
tableView(cSize, () => ({
  cols: [{ key: 'label', label: 'Bin' }, { key: 'tip', label: 'Range', left: true }, { key: 'hn', label: 'People', fmt: fmt.int }, { key: 'hs', label: 'People share', fmt: v => fmt.pct(v, 1) },
    { key: 'bn', label: 'Bots', fmt: fmt.int }, { key: 'bs', label: 'Bot share', fmt: v => fmt.pct(v, 1) }],
  rows: sizeCats(),
}));

// ------------------------------------------------------------------ 6. kinds of change
const cKind = $('#c-kind');
mountLegend($('.legend', cKind), [{ label: 'People', color: 1, shape: 'rect' }, { label: 'Bots', color: 2, shape: 'rect' }]);
const kindChart = new Columns($('.card__b', cKind), {
  height: 200, aria: 'Changes by type, people and bots',
  series: [{ key: 'human', label: 'People', color: 1 }, { key: 'bot', label: 'Bots', color: 2 }],
  empty: 'Waiting for events',
  tipExtra: k => [{ value: fmt.pct(k.human + k.bot ? k.bot / (k.human + k.bot) : NaN, 1), label: 'by bots' }],
});
function kindCats() {
  const S = st, names = [...KINDS, ...[...S.kinds.keys()].filter(k => !KINDS.includes(k)).sort()];
  return names.map(n => { const k = S.kinds.get(n) || { human: 0, bot: 0 }; return { label: n, human: k.human, bot: k.bot }; });
}
job(() => {
  const S = st;
  if (!S.n) { kindChart.set([]); foot('f-kind', 'Waiting for events.'); return; }
  const cats = kindCats(), seen = cats.filter(c => c.human + c.bot);
  kindChart.set(cats);
  const parts = seen.map(c => fmt.pct(c.bot / (c.human + c.bot), 0) + ' of ' + (KIND_WORDS[c.label] || c.label));
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
  foot('f-kind', 'Bots make ', [list], '.');
}, 1000);
tableView(cKind, () => ({
  cols: [{ key: 'label', label: 'Type' }, { key: 'human', label: 'People', fmt: fmt.int }, { key: 'bot', label: 'Bots', fmt: fmt.int },
    { key: 'share', label: 'Bot share', fmt: v => fmt.pct(v, 1) }],
  rows: kindCats().map(c => ({ ...c, share: c.human + c.bot ? c.bot / (c.human + c.bot) : NaN })),
}));

// ------------------------------------------------------------------ 7. live tape
let tapeSeen = 0;
job(() => {
  const S = st, items = S.tape.toArray(), box = $('#tape');
  const fresh = items.filter(x => x.seq > tapeSeen);
  if (fresh.length) {
    const emp = box.querySelector('.empty'); if (emp) emp.remove();
    for (const x of fresh) box.prepend(h('div', { class: 'tape__r new' },
      h('time', { datetime: new Date(x.t).toISOString() }, fmt.time(x.t)),
      h('div', { class: 't' }, h('span', { class: 'pill' }, label(x.wiki)), h('span', { class: 'pill' }, x.type), x.bot ? h('span', { class: 'pill' }, 'bot') : null, pageLink(x.title, x.uri)),
      h('span', { class: 'v' }, isNum(x.delta) ? signedInt(x.delta) : '')));
    while (box.children.length > TAPE_N) box.lastElementChild.remove();
    tapeSeen = items[items.length - 1].seq;
  }
  foot('f-tape', [fmt.int(tr.dupes)], (tr.dupes === 1 ? ' repeated event' : ' repeated events') + ' dropped after reconnects; ' + plural(tr.opens, 'connection', 'connections') + ' so far.');
  foot('h-tape', 'Reconnect attempts: ' + feed.reconnects + '. Canary events discarded: ' + tr.canary + '.' + (tr.bad ? ' Unparseable messages: ' + tr.bad + '.' : ''));
}, 1000);

// ------------------------------------------------------------------ scope control
for (const b of document.querySelectorAll('#scope button')) b.addEventListener('click', () => {
  const next = SCOPES.find(s => s.id === b.dataset.scope);
  if (!next || next === scope) return;
  scope = next;
  for (const o of document.querySelectorAll('#scope button')) o.setAttribute('aria-pressed', String(o === b));
  reset('');
});

// ------------------------------------------------------------------ connection
// EventSource retries on its own after a dropped connection and sends
// Last-Event-ID. If it gives up (readyState CLOSED), reconnect by hand from
// the last event time; RecentIds absorbs the overlap.
let es = null, retry = 0;
function connect(since) {
  es = new EventSource(since ? STREAM + '?since=' + encodeURIComponent(since) : STREAM);
  es.onopen = () => { tr.opens++; retry = 0; };
  es.onmessage = onMessage;
  es.onerror = () => {
    feed.reconnects++;
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      const wait = Math.min(60, 2 ** retry++) * 1000;
      feed.set('error', 'closed, retry in ' + fmt.dur(wait));
      // resume 5 s before the newest event time seen; the dedupe set drops the overlap
      setTimeout(() => { feed.set('connecting'); connect(isNum(tr.maxDt) ? new Date(tr.maxDt - 5000).toISOString() : ''); }, wait);
    } else feed.set('connecting');
  };
}
setText('#since', 'counting since ' + fmt.time(st.t0));
feed.set('connecting');
connect('');
