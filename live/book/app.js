// DOM wiring for the order book dashboard. One WebSocket to Kraken v2 carries
// book and trades; BookSession (book.js) owns the protocol, the local book and
// checksum verification. This file keeps the derived series, draws the two
// custom canvases (the stage heatmap and the depth chart) and feeds the shared
// charts. The message handler only mutates state; every repaint goes through
// the shared scheduler.
import { boot, Feed, mountFeeds, onPaint, initPause, tableView, mountLegend, palette, rgba, h, $, $$, setText } from '../assets/ui.js';
import { TimeChart, Columns, Scatter } from '../assets/charts.js';
import { fmt, Ring, quantiles, isNum, clamp, niceTicks } from '../assets/util.js';
import {
  BookSession, FlowSeconds, ofiRegression, realizedVol, annualize, rvRelSE,
  midOf, spreadOf, spreadBps, microprice, imbalance, TradeTally, NOTIONAL_BINS,
} from './book.js';

boot();

// ---------------------------------------------------------------- design parameters
const WS_URL = 'wss://ws.kraken.com/v2';
const DEPTH = 100;                         // subscribed book depth per side
const COL_MS = 500, HEAT_SPAN = 240e3;     // stage: one column per 500 ms, 4 minutes
const HEAT_N = HEAT_SPAN / COL_MS;
const MIN_SPAN = 1500;                     // while filling, the axis spans first column to now (at least 1.5 s)
const SAMPLE_MS = 500, SI_SPAN = 300e3;    // spread and imbalance sampling
const OFI_WIN = 300, OFI_MIN = 30;         // seconds in the regression, minimum for a fit
const RV_WIN = 300, RV_MIN = 120;          // seconds in the RV window, minimum before showing
const FLOW_BIN = 10e3, FLOW_N = 60;        // trade flow: 10 s bins, 10 minutes
const TPM_MS = 60e3;                       // trades per minute window
const TAPE_N = 20;
const LAG_KEEP = 300;                      // seconds of lag history
const BAND_BPS = 5;                        // depth footnote band around mid
const RECENTER = 0.6;                      // stage recenters when mid leaves the middle 60%
const FADE_MS = 450;                       // new trade bubbles fade in over this long
const NARROW = matchMedia('(max-width:760px)');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- state
function fresh(symbol) {
  const [base, quote] = symbol.split('/');
  return {
    symbol, base, quote, subAt: NaN, pending: '',
    cols: new Ring(HEAT_N + 40),            // stage columns: copies of the book
    si: new Ring(SI_SPAN / SAMPLE_MS + 40),  // spread and imbalance samples
    trades: new Ring(5000),
    tape: new Ring(TAPE_N), tapeVer: 0,
    flow: new FlowSeconds(900),
    tally: new TradeTally(),
    flowBins: new Map(),
    lagBins: new Map(),
    events: new Ring(40),                   // resyncs and reconnects, drawn on time charts
    lastEx: NaN,
  };
}
let S = fresh($('#sym').value || 'BTC/USD');
const prec = () => session.precision.get(S.symbol) || { pricePrec: 2, qtyPrec: 8 };
const pp = () => prec().pricePrec;

// ---------------------------------------------------------------- formatting
const MISSING = fmt.int(NaN);   // the shared missing value glyph from util.js
const fPx = (v, extra = 0) => fmt.fixed(v, pp() + extra);
function fQty(q) {
  if (!isNum(q)) return MISSING;
  const a = Math.abs(q);
  if (a >= 1000) return fmt.int(q);
  if (a >= 100) return fmt.fixed(q, 1);
  if (a >= 1) return fmt.fixed(q, 3);
  return fmt.sig(q, 3);
}
function fUsd(v) {
  if (!isNum(v)) return MISSING;
  if (Math.abs(v) < 10) return '$' + v.toFixed(2);
  if (Math.abs(v) < 1e5) return '$' + fmt.int(v);
  return '$' + fmt.compact(v);
}
const fMs = v => isNum(v) ? fmt.int(v) + ' ms' : MISSING;
const fClock = t => fmt.time(t) + '.' + String(Math.floor((t % 1000) / 100));
// a line of text with bold numbers: parts are strings or { b: text }
function rich(sel, parts) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  const sig = parts.map(x => typeof x === 'string' ? x : '*' + x.b).join('');
  if (el._sig === sig) return;
  el._sig = sig;
  el.replaceChildren(...parts.map(x => typeof x === 'string' ? x : h('b', null, x.b)));
}

// ---------------------------------------------------------------- feed and session
const feed = new Feed({ label: 'Kraken v2', kind: 'stream', staleMs: 5000 });
mountFeeds($('#status'), [feed]);
initPause($('#pause'), [feed]);

let ws = null, attempt = 0, lastMsgAt = 0, retryTimer = 0, lastError = '';
const jobs = [];
const dirty = () => { for (const j of jobs) j.invalidate(); };

const session = new BookSession({
  symbol: S.symbol, depth: DEPTH,
  send: o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); },
  onSnapshot(book, tEx, tArr) {
    S.flow.reset();
    const b = book.bbo(); if (b) S.flow.add(tEx, b);
    if (!isNum(S.subAt)) S.subAt = tArr;
    else if (S.pending) S.events.push({ t: tArr, label: S.pending });
    S.pending = ''; S.lastEx = tEx;
    attempt = 0;
    dirty();
  },
  onBook(book, tEx, tArr) {
    const b = book.bbo(); if (b) S.flow.add(tEx, b);
    S.lastEx = tEx;
    addLag('book', tArr, tArr - tEx);
    depth.invalidate();
  },
  onTrade(t, tEx, tArr) {
    const tr = { t: tArr, te: tEx, side: t.side === 'buy' ? 'buy' : 'sell', price: +t.price, qty: +t.qty, id: t.trade_id };
    if (!(tr.price > 0) || !(tr.qty > 0)) return;
    S.trades.push(tr); S.tape.push(tr); S.tapeVer++;
    S.tally.add(t);
    const k = Math.floor(tArr / FLOW_BIN);
    let fb = S.flowBins.get(k);
    if (!fb) { fb = { buy: 0, sell: 0, n: 0 }; S.flowBins.set(k, fb); for (const j of S.flowBins.keys()) if (j < k - FLOW_N - 2) S.flowBins.delete(j); }
    fb[tr.side] += tr.qty; fb.n++;
    addLag('trade', tArr, tArr - tEx);
    stage.invalidate();
  },
  onMismatch() { S.pending = 'resync'; },
  onError(msg) { lastError = msg; },
});

function addLag(kind, tArr, lag) {
  if (!isNum(lag)) return;
  const s = Math.floor(tArr / 1000);
  let b = S.lagBins.get(s);
  if (!b) {
    b = { book: [], trade: [], q: null };
    S.lagBins.set(s, b);
    if (S.lagBins.size > LAG_KEEP + 5) for (const k of S.lagBins.keys()) if (k < s - LAG_KEEP) S.lagBins.delete(k);
  }
  b[kind].push(lag);
}

function connect() {
  clearTimeout(retryTimer);
  feed.set('connecting');
  try { ws = new WebSocket(WS_URL); }
  catch (e) { feed.set('error', 'WebSocket unavailable'); scheduleReconnect(); return; }
  const me = ws;
  me.onopen = () => { if (ws !== me) return; lastMsgAt = Date.now(); session.start(); };
  me.onmessage = ev => {
    if (ws !== me) return;
    const raw = typeof ev.data === 'string' ? ev.data : '';
    const now = Date.now();
    lastMsgAt = now;
    feed.hit(raw.length);
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    session.handle(m, now, raw.length);
    dirty();
  };
  me.onclose = () => {
    if (ws !== me) return;
    ws = null;
    session.closed();
    S.pending = 'reconnect';
    scheduleReconnect();
  };
  me.onerror = () => { /* a close event follows and schedules the retry */ };
}
function scheduleReconnect() {
  const delay = Math.min(30e3, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
  attempt++;
  feed.reconnects++;
  feed.set('error', 'closed, retry in ' + fmt.dur(delay));
  retryTimer = setTimeout(connect, delay);
}
// heartbeats arrive about once a second; 10 s of silence means the socket is dead
setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsgAt > 10e3) ws.close(); }, 2000);

// ---------------------------------------------------------------- sampler (arrival clock)
setInterval(() => {
  if (session.state !== 'live') return;
  const book = session.book, b = book.bbo();
  if (!b) return;
  const now = Date.now();
  S.cols.push({
    t: now, slot: Math.floor(now / COL_MS), pb: b.pb, pa: b.pa,
    bp: Float64Array.from(book.bids.px), bq: Float64Array.from(book.bids.qty),
    ap: Float64Array.from(book.asks.px), aq: Float64Array.from(book.asks.qty), cache: null,
  });
  const tick = Math.pow(10, -pp());
  S.si.push({ t: now, spread: spreadBps(b), ticks: Math.round(spreadOf(b) / tick), imb: imbalance(b) });
  stage.invalidate(); siJob.invalidate();
}, SAMPLE_MS);

// ---------------------------------------------------------------- controls
$('#sym').addEventListener('change', e => {
  const sym = e.target.value;
  S = fresh(sym);
  session.resetStats();
  session.setSymbol(sym);
  stage.reset(); tapeSeen = -1;
  $$('[data-sym]').forEach(el => setText(el, sym));
  $$('[data-base]').forEach(el => setText(el, S.base));
  $$('[data-quote]').forEach(el => setText(el, S.quote));
  ofiChart.o.x.label = 'net buying, ' + S.base;
  dirty(); depth.invalidate(); stage.invalidate();
});
$$('#win button').forEach(btn => btn.addEventListener('click', () => {
  $$('#win button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
  stage.win = +btn.dataset.w; stage.center = NaN; stage.colorAt = 0; stage.invalidate();
}));

// ---------------------------------------------------------------- canvas panel base
// A small twin of the shared chart base for the two custom canvases: canvas at
// device pixel ratio, a ResizeObserver, the shared tooltip markup, and a paint
// job on the shared scheduler.
class Panel {
  constructor(container, { height, every = 250, aria = 'chart', cls = '', before = null }) {
    this.heightFn = height;
    this.root = h('div', { class: 'chart viz ' + cls });
    this.cv = h('canvas', { tabindex: '0', role: 'img', 'aria-label': aria });
    this.tip = h('div', { class: 'tip', 'aria-hidden': 'true' });
    this.root.append(this.cv, this.tip);
    if (before) container.insertBefore(this.root, before); else container.append(this.root);
    this.ctx = this.cv.getContext('2d');
    this.w = 0; this.hgt = 0; this.dpr = 1; this.hx = NaN; this.hy = NaN;
    this.job = onPaint(() => this.paint(), every);
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.resize();
    this.cv.addEventListener('pointermove', e => { this.hx = e.offsetX; this.hy = e.offsetY; this.job.now(); });
    const leave = () => { this.hx = NaN; this.hy = NaN; this.hideTip(); this.job.now(); };
    this.cv.addEventListener('pointerleave', leave);
    this.cv.addEventListener('blur', leave);
  }
  resize() {
    const w = Math.max(120, Math.floor(this.root.clientWidth));
    const hg = typeof this.heightFn === 'function' ? this.heightFn(w) : this.heightFn;
    if (w === this.w && hg === this.hgt && this.dpr === devicePixelRatio) return;
    this.w = w; this.hgt = hg; this.dpr = devicePixelRatio || 1;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(hg * this.dpr);
    this.cv.style.height = hg + 'px';
    this.job.now();
  }
  begin() {
    const c = this.ctx, p = palette();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.hgt);
    c.font = '11px ' + p.mono; c.textBaseline = 'alphabetic';
    return { c, p };
  }
  empty(c, p, text, y = this.hgt / 2) { c.fillStyle = p.ink3; c.font = '13px ' + p.sans; c.textAlign = 'center'; c.fillText(text, this.w / 2, y); }
  showTip(x, y, head, rows) {
    const t = this.tip;
    t.replaceChildren(h('div', { class: 'tip__h' }, head), ...rows.map(r =>
      h('div', { class: 'tip__r' }, h('i', { style: { background: r.color || 'transparent', height: r.shape === 'rect' ? '10px' : r.shape === 'dot' ? '9px' : '2px', width: r.shape === 'rect' ? '10px' : r.shape === 'dot' ? '9px' : '12px', borderRadius: r.shape === 'dot' ? '50%' : '1px' } }), h('b', null, r.value), h('span', null, r.label))));
    t.style.display = 'block';
    const tw = t.offsetWidth, th = t.offsetHeight;
    let left = x + 14; if (left + tw > this.w) left = x - tw - 14; left = clamp(left, 0, Math.max(0, this.w - tw));
    let top = y - th - 10; if (top < 0) top = y + 14;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  hideTip() { this.tip.style.display = 'none'; }
  invalidate() { this.job.invalidate(); }
}

// Sequential ramp through the six theme stops with a Catmull-Rom spline, so the
// color changes smoothly instead of bending at each stop.
function ramp(seq, t) {
  const n = seq.length - 1, x = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(x)), u = x - i;
  const P0 = seq[Math.max(0, i - 1)], P1 = seq[i], P2 = seq[i + 1], P3 = seq[Math.min(n, i + 2)];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = clamp(0.5 * (2 * P1[k] + (P2[k] - P0[k]) * u + (2 * P0[k] - 5 * P1[k] + 4 * P2[k] - P3[k]) * u * u + (3 * P1[k] - P0[k] - 3 * P2[k] + P3[k]) * u * u * u), 0, 255);
  return out;
}
const RAMP_T0 = 0.14;   // the smallest visible size starts here, clear of the empty color
const rampCss = (p, t) => { const c = ramp(p.seq, t); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };
const hex = x => { x = x.replace('#', ''); if (x.length === 3) x = [...x].map(ch => ch + ch).join(''); const n = parseInt(x, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

// ---------------------------------------------------------------- the stage
// x: time, one image column per 500 ms slot; y: price, one image row per CSS
// pixel, each row a price bucket. Every captured column keeps a full copy of the
// book, so a new window or a recenter repaints history correctly. The pixel
// image is rebuilt only when a column, the axis or the color scale changes; each
// frame then draws it scaled, plus the vector overlays (quote lines, trades,
// price tag, axes), which keeps fade ins cheap.
class Stage extends Panel {
  constructor(el) {
    super(el, {
      height: () => NARROW.matches ? 300 : 460, every: REDUCED.matches ? 1000 : 250, cls: 'stage__viz', before: $('.tv', el),
      aria: 'Heatmap of waiting order size by price and time, with best bid and ask lines and every trade. The Table button lists the same columns.',
    });
    this.el = el; this.cap = $('.stage__cap', el); this.leg = $('.stage__legend', el);
    this.spot = $('#spot', el); this.spotId = undefined; this.spotPos = '';
    this.off = document.createElement('canvas'); this.offCtx = this.off.getContext('2d');
    this.img = null; this.baseKey = ''; this.unobs = null;
    this.win = +(($('#win [aria-pressed="true"]') || {}).dataset || {}).w || 0.0005;
    this.lut = null; this.lutFor = null; this.hatch = null; this.hatchFor = '';
    this.reset();
    NARROW.addEventListener('change', () => this.resize());
  }
  reset() { this.center = NaN; this.lo = NaN; this.hi = NaN; this.colorAt = 0; this.scaleVer = (this.scaleVer || 0) + 1; this.view = null; this.baseKey = ''; this.spotId = undefined; }
  buildLut(p) {
    // 0: empty bucket (surface), 1: not observed (sunk), 2..255: log size on the ramp
    const pack = ([r, g, b]) => (255 << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0;
    const lut = new Uint32Array(256);
    lut[0] = pack(p.seq[0]); lut[1] = pack(hex(p.sunk));
    for (let k = 2; k < 256; k++) { const c = ramp(p.seq, RAMP_T0 + (1 - RAMP_T0) * (k - 2) / 253); lut[k] = pack([c[0] | 0, c[1] | 0, c[2] | 0]); }
    this.lut = lut; this.lutFor = p;
  }
  hatchPattern(c, p) {
    const key = p.rule2 + '|' + p.sunk + '|' + this.dpr;
    if (this.hatch && this.hatchFor === key) return this.hatch;
    const d = this.dpr, s = Math.round(6 * d), tile = document.createElement('canvas');
    tile.width = s; tile.height = s;
    const t = tile.getContext('2d');
    t.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--rule-2').trim() || p.axis;
    t.lineWidth = Math.max(1, d * 0.75);
    t.beginPath(); t.moveTo(0, s); t.lineTo(s, 0); t.moveTo(-s / 2, s / 2); t.lineTo(s / 2, -s / 2); t.moveTo(s / 2, s * 1.5); t.lineTo(s * 1.5, s / 2); t.stroke();
    const pat = c.createPattern(tile, 'repeat');
    if (pat && pat.setTransform) pat.setTransform(new DOMMatrix().scale(1 / d));
    this.hatch = pat; this.hatchFor = key;
    return pat;
  }
  // bucket sums for one column on the current axis, cached on the column
  buckets(col, key, pTop, bucket, rows) {
    if (col.cache && col.cache.key === key) return col.cache;
    const v = new Float32Array(rows);
    const { bp, bq, ap, aq } = col;
    for (let j = 0; j < bp.length; j++) { const r = Math.floor((pTop - bp[j]) / bucket); if (r >= rows) break; if (r >= 0) v[r] += bq[j]; }
    for (let j = 0; j < ap.length; j++) { const r = Math.floor((pTop - ap[j]) / bucket); if (r < 0) break; if (r < rows) v[r] += aq[j]; }
    // rows past the worst held level on either side were not observed
    const askEdge = ap.length ? Math.floor((pTop - ap[ap.length - 1]) / bucket) : rows;
    const bidEdge = bp.length ? Math.floor((pTop - bp[bp.length - 1]) / bucket) : -1;
    col.cache = { key, v, askEdge, bidEdge, bidN: bp.length, askN: ap.length, idx: null, idxVer: -1 };
    return col.cache;
  }
  unobserved(b, r) { return (b.askN >= DEPTH && r < b.askEdge) || (b.bidN >= DEPTH && r > b.bidEdge); }
  rebuild(p, v) {
    const { N, rows, slotCol, key, pTop, bucket } = v;
    if (this.lutFor !== p) this.buildLut(p);
    if (!this.img || this.img.width !== N || this.img.height !== rows) { this.img = new ImageData(N, rows); this.off.width = N; this.off.height = rows; }
    const px = new Uint32Array(this.img.data.buffer), lut = this.lut, lo = this.lo, span = (this.hi - this.lo) || 1;
    const uTop = new Int32Array(N), uBot = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const col = slotCol[i];
      if (!col) { for (let r = 0; r < rows; r++) px[r * N + i] = lut[1]; uTop[i] = rows; continue; }
      const b = this.buckets(col, key, pTop, bucket, rows);
      if (b.idxVer !== this.scaleVer || !b.idx) {
        const idx = b.idx || (b.idx = new Uint8Array(rows));
        for (let r = 0; r < rows; r++) idx[r] = this.unobserved(b, r) ? 1 : b.v[r] > 0 ? 2 + Math.round(clamp((Math.log10(b.v[r]) - lo) / span, 0, 1) * 253) : 0;
        b.idxVer = this.scaleVer;
      }
      const idx = b.idx;
      for (let r = 0; r < rows; r++) px[r * N + i] = lut[idx[r]];
      uTop[i] = b.askN >= DEPTH ? clamp(b.askEdge, 0, rows) : 0;
      uBot[i] = b.bidN >= DEPTH ? clamp(rows - 1 - b.bidEdge, 0, rows) : 0;
    }
    this.offCtx.putImageData(this.img, 0, 0);
    // unobserved ranges as merged rectangles, filled with a hatch over the flat grey
    const path = new Path2D(), colW = v.plotW / N, rowH = (v.bottom - v.top) / rows;
    for (const [arr, fromTop] of [[uTop, true], [uBot, false]]) {
      for (let i = 0; i < N;) {
        let j = i + 1; while (j < N && arr[j] === arr[i]) j++;
        if (arr[i] > 0) { const hh = arr[i] * rowH; path.rect(v.L + i * colW, fromTop ? v.top : v.bottom - hh, (j - i) * colW, hh); }
        i = j;
      }
    }
    this.unobs = path;
  }
  paint() {
    const { c, p } = this.begin(), W = this.w, H = this.hgt, now = Date.now();
    const narrow = NARROW.matches, table = this.el.dataset.view === 'table';
    let top = 12;
    if (!narrow && !table) top = Math.max(this.cap.offsetTop + this.cap.offsetHeight, this.leg.offsetTop + this.leg.offsetHeight) + 16;
    const bottom = H - 26;
    const cols = S.cols;
    if (!cols.length) {
      this.view = null; this.showSpot(null);
      const msg = session.state === 'live' ? 'Capturing the first column' : session.state === 'syncing' ? 'Waiting for the first verified book' : session.state === 'instrument' ? 'Reading the instrument precision' : 'Connecting to Kraken';
      this.empty(c, p, msg, (top + bottom) / 2);
      return;
    }
    const last = cols.last(), mCol = (last.pb + last.pa) / 2;
    const b = session.state === 'live' ? session.book.bbo() : null;
    const mLive = b ? midOf(b) : mCol, gapLive = b ? spreadOf(b) : last.pa - last.pb;
    if (!isNum(this.center)) this.center = mCol;
    let hw = this.win * this.center;
    if (Math.abs(mCol - this.center) > RECENTER * hw) { this.center = mCol; hw = this.win * mCol; this.colorAt = 0; }
    const pTop = this.center + hw, pBot = this.center - hw;
    // right gutter: price axis and the live price tag
    c.font = '600 12px ' + p.mono;
    const tagText = fPx(mLive, 1), tagW = Math.ceil(c.measureText(tagText).width) + 18;
    const L = 0, R = W - tagW - 10, plotW = R - L;
    const rows = Math.max(20, Math.round(bottom - top)), bucket = (pTop - pBot) / rows;
    // time span: grows from the first column until the 4 minute window is full
    const nowSlot = Math.floor(now / COL_MS);
    const N = clamp(nowSlot - cols.at(0).slot + 1, Math.ceil(MIN_SPAN / COL_MS), HEAT_N);
    const spanMs = N * COL_MS, filling = now - cols.at(0).t < HEAT_SPAN, slot0 = nowSlot - N + 1;
    const t0 = slot0 * COL_MS, t1 = (nowSlot + 1) * COL_MS;
    const key = this.center + '|' + hw + '|' + rows;
    // each slot takes the newest column at or before it (the book is unchanged in between); gaps over 2 s stay empty
    const slotCol = new Array(N).fill(null);
    let j = 0;
    while (j < cols.length && cols.at(j).slot < slot0 - 4) j++;
    for (let i = 0; i < N; i++) {
      const s = slot0 + i;
      while (j + 1 < cols.length && cols.at(j + 1).slot <= s) j++;
      const col = cols.at(j);
      if (col && col.slot <= s && s - col.slot <= 4) slotCol[i] = col;
    }
    // color scale: 2nd to 99.5th percentile of visible log sizes, refreshed every 2 s
    if (!isNum(this.lo) || now - this.colorAt > 2000) {
      const logs = [];
      for (let i = 0; i < N; i += Math.max(1, Math.floor(N / 160))) {
        const col = slotCol[i]; if (!col) continue;
        const bk = this.buckets(col, key, pTop, bucket, rows);
        for (let r = 0; r < rows; r++) if (bk.v[r] > 0) logs.push(Math.log10(bk.v[r]));
      }
      if (logs.length > 10) { const [a, z] = quantiles(logs, [0.02, 0.995]); this.lo = a; this.hi = Math.max(z, a + 0.5); this.colorAt = now; this.scaleVer++; }
    }
    const v = { L, R, top, bottom, plotW, rows, N, slotCol, key, pTop, pBot, bucket, t0, t1, spanMs, filling };
    v.X = t => L + (t - t0) / (t1 - t0) * plotW;
    v.Y = x => top + (pTop - x) / (pTop - pBot) * (bottom - top);
    this.view = v;
    const baseKey = [nowSlot, N, key, this.scaleVer, cols.length, last.t, W, H, top].join('|');
    if (baseKey !== this.baseKey || this.lutFor !== p) { this.rebuild(p, v); this.baseKey = baseKey; }
    const { X, Y } = v, colW = plotW / N;
    // heatmap, smoothed between columns, then the hatch over unobserved ranges
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(this.off, L, top, plotW, bottom - top);
    const hp = this.hatchPattern(c, p);
    if (hp && this.unobs) { c.fillStyle = hp; c.fill(this.unobs); }
    c.save(); c.beginPath(); c.rect(L, top, plotW, bottom - top); c.clip();
    // resyncs and reconnects
    c.font = '11px ' + p.mono;
    for (let i = 0; i < S.events.length; i++) {
      const ev = S.events.at(i), x = Math.round(X(ev.t)) + 0.5;
      if (x < L || x > R) continue;
      c.strokeStyle = p.ink3; c.lineWidth = 1; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke(); c.setLineDash([]);
      c.fillStyle = p.ink2; c.textAlign = x > R - 80 ? 'right' : 'left'; c.fillText(ev.label, x + (x > R - 80 ? -4 : 4), top + 12);
    }
    // best bid and ask as step lines over a surface halo; each sits 1px outside its own price
    const quote = (k, off) => {
      c.beginPath(); let on = false;
      for (let i = 0; i < N; i++) {
        const cc = slotCol[i];
        if (!cc) { on = false; continue; }
        const xa = L + i * colW, xb = xa + colW, y = Y(cc[k]) + off;
        if (!on) { c.moveTo(xa, y); on = true; } else c.lineTo(xa, y);
        c.lineTo(xb, y);
      }
    };
    c.lineJoin = 'miter'; c.lineCap = 'butt';
    for (const pass of [0, 1]) for (const [k, col, off] of [['pb', 1, 1], ['pa', 2, -1]]) {
      quote(k, off);
      c.strokeStyle = pass ? p.color(col) : rgba(p.surface, 0.9); c.lineWidth = pass ? 2 : 4.5; c.stroke();
    }
    // trades: soft bubbles, area proportional to size, a 2px surface ring, a short fade in
    const vis = [];
    let qmax = 0, big = null;
    for (let i = S.trades.length - 1; i >= 0; i--) {
      const tr = S.trades.at(i); if (tr.t < t0) break;
      vis.push(tr); if (tr.qty > qmax) qmax = tr.qty;
      if (tr.t >= now - 60e3 && (!big || tr.qty * tr.price > big.qty * big.price)) big = tr;
    }
    const rMax = narrow ? 10 : 15, motion = !REDUCED.matches;
    let animating = false;
    this.marks = [];
    for (let i = vis.length - 1; i >= 0; i--) {
      const tr = vis[i], x = X(tr.t), y = Y(tr.price);
      if (y < top - 16 || y > bottom + 16) continue;
      let r = Math.max(2.2, rMax * Math.sqrt(tr.qty / (qmax || 1))), a = 1;
      const age = now - tr.t;
      if (motion && age < FADE_MS) { const e = 1 - Math.pow(1 - Math.max(0, age) / FADE_MS, 3); a = e; r *= 0.55 + 0.45 * e; animating = true; }
      c.globalAlpha = a;
      c.beginPath(); c.arc(x, y, r + 2, 0, 7); c.fillStyle = p.surface; c.fill();
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = rgba(p.color(tr.side === 'buy' ? 1 : 2), 0.82); c.fill();
      c.globalAlpha = 1;
      this.marks.push({ x, y, r, tr });
    }
    c.restore();
    // the callout for the largest trade of the last minute, with a leader line on wide screens
    const bigMark = big && this.marks.find(mk => mk.tr === big);
    this.showSpot(big, bigMark, v, c, p);
    // right gutter: price ticks, then the live price tag that follows the mid
    c.font = '11px ' + p.mono; c.textAlign = 'left';
    const NT = niceTicks(pBot, pTop, Math.max(3, Math.floor((bottom - top) / 64)));
    const dec = Math.max(0, -Math.floor(Math.log10(NT.step) + 1e-9));
    const tagY = clamp(Y(mLive), top + 17, bottom - 17);
    for (const tv of NT.ticks) {
      if (tv < pBot || tv > pTop) continue;
      const y = Math.round(Y(tv)) + 0.5;
      c.strokeStyle = p.axis; c.lineWidth = 1; c.beginPath(); c.moveTo(R, y); c.lineTo(R + 4, y); c.stroke();
      if (Math.abs(y - tagY) > 24 && y > top + 6 && y < bottom - 2) { c.fillStyle = p.muted; c.fillText(fmt.fixed(tv, dec), R + 8, y + 4); }
    }
    c.strokeStyle = p.axis; c.beginPath(); c.moveTo(R + 0.5, top); c.lineTo(R + 0.5, bottom); c.stroke();
    const tx = R + 6, tw = W - tx - 4, th = 32;
    c.fillStyle = p.ink;
    c.beginPath(); c.moveTo(R + 1, tagY); c.lineTo(tx, tagY - 6); c.lineTo(tx, tagY + 6); c.closePath(); c.fill();
    c.beginPath(); c.roundRect ? c.roundRect(tx, tagY - th / 2, tw, th, 4) : c.rect(tx, tagY - th / 2, tw, th); c.fill();
    c.fillStyle = p.surface; c.textAlign = 'center';
    c.font = '600 12px ' + p.mono; c.fillText(tagText, tx + tw / 2, tagY - 1);
    c.globalAlpha = 0.78; c.font = '10px ' + p.mono; c.fillText('gap ' + fPx(gapLive), tx + tw / 2, tagY + 11); c.globalAlpha = 1;
    // time axis: relative labels, with how much history is on screen at the left
    c.font = '11px ' + p.mono; c.fillStyle = p.muted;
    c.strokeStyle = p.axis; c.beginPath(); c.moveTo(L, bottom + 0.5); c.lineTo(R, bottom + 0.5); c.stroke();
    const shown = Math.min(spanMs, now - cols.at(0).t);
    const histLabel = filling ? 'last ' + fmt.dur(Math.max(1000, shown)) : 'last 4 min';
    c.textAlign = 'left'; c.fillStyle = p.ink2; c.fillText(histLabel, L + 8, H - 8);
    const histW = c.measureText(histLabel).width + 18, nowW = c.measureText('now').width + 16;
    c.fillStyle = p.muted; c.textAlign = 'right'; c.fillText('now', R - 4, H - 8);
    const pxPerS = plotW / ((t1 - t0) / 1000);
    const step = [5, 10, 15, 30, 60, 120].find(s => s * pxPerS >= 90) || 120;
    c.textAlign = 'center';
    for (let k = 1; ; k++) {
      const secs = k * step, x = X(t1 - secs * 1000);
      const lab = secs < 60 ? secs + ' s ago' : (secs % 60 ? Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s ago' : secs / 60 + ' min ago');
      const lw = c.measureText(lab).width / 2;
      if (x - lw < L + histW) break;
      if (x + lw > R - nowW) continue;
      c.beginPath(); c.moveTo(Math.round(x) + 0.5, bottom); c.lineTo(Math.round(x) + 0.5, bottom + 4); c.stroke();
      c.fillText(lab, x, H - 8);
    }
    // hover: the bucket under the pointer, and the nearest trade within 24 px
    if (isNum(this.hx) && this.hx >= L && this.hx <= R && this.hy >= top && this.hy <= bottom) {
      const i = clamp(Math.floor((this.hx - L) / colW), 0, N - 1), r = clamp(Math.floor((this.hy - top) / ((bottom - top) / rows)), 0, rows - 1);
      const x = Math.round(L + (i + 0.5) * colW) + 0.5;
      c.strokeStyle = p.ink3; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.beginPath(); c.moveTo(L, Math.round(this.hy) + 0.5); c.lineTo(R, Math.round(this.hy) + 0.5); c.stroke();
      const col = slotCol[i], hiP = pTop - r * bucket, loP = hiP - bucket, out = [];
      if (col) {
        const bk = this.buckets(col, key, pTop, bucket, rows), un = this.unobserved(bk, r), q = bk.v[r];
        const span = (this.hi - this.lo) || 1;
        out.push({ value: fPx(loP) + ' to ' + fPx(hiP), label: S.quote });
        out.push({ shape: 'rect', color: un ? p.sunk : q > 0 ? rampCss(p, RAMP_T0 + (1 - RAMP_T0) * clamp((Math.log10(q) - this.lo) / span, 0, 1)) : p.seqAt(0), value: un ? 'not observed' : fQty(q) + ' ' + S.base, label: un ? 'past level 100' : 'waiting' });
        out.push({ color: p.color(1), value: fPx(col.pb), label: 'best bid' });
        out.push({ color: p.color(2), value: fPx(col.pa), label: 'best ask' });
      } else out.push({ value: 'no data', label: 'not connected' });
      let best = null, bd = 24;
      for (const mk of this.marks) { const d = Math.hypot(mk.x - this.hx, mk.y - this.hy); if (d <= bd) { bd = d; best = mk; } }
      if (best) out.push({ shape: 'dot', color: p.color(best.tr.side === 'buy' ? 1 : 2), value: best.tr.side + ' ' + fQty(best.tr.qty) + ' at ' + fPx(best.tr.price), label: fUsd(best.tr.qty * best.tr.price) + ', ' + fmt.time(best.tr.te) });
      this.showTip(this.hx, this.hy, fClock((slot0 + i) * COL_MS), out);
    } else this.hideTip();
    if (animating && !isPausedDisplay()) this.job.now();
  }
  // the .spot callout: content changes only when the largest trade changes
  showSpot(tr, mark, v, c, p) {
    const sp = this.spot;
    if (!tr) { if (!sp.hidden) sp.hidden = true; this.spotId = undefined; return; }
    if (this.spotId !== tr.id) {
      this.spotId = tr.id;
      const pal = palette();
      setText('#spot-v', fUsd(tr.qty * tr.price));
      $('#spot-d').replaceChildren(
        h('span', { class: 'side' }, h('i', { style: { background: pal.color(tr.side === 'buy' ? 1 : 2) } }), tr.side), ' ',
        fQty(tr.qty) + ' ' + S.base + ' at ' + fPx(tr.price) + ', ' + fmt.time(tr.te));
    }
    if (sp.hidden) sp.hidden = false;
    if (NARROW.matches || !mark || !v) { if (this.spotPos) { sp.style.left = ''; sp.style.top = ''; this.spotPos = ''; } return; }
    const sw = sp.offsetWidth, sh = sp.offsetHeight;
    let left, top, right = false;
    if (mark.x - mark.r - 26 - sw > v.L + (v.R - v.L) * 0.4) {
      // a recent trade: park the callout over the oldest history, in the half away from
      // the trade, so it never covers the last seconds of the book
      left = v.L + 14;
      top = mark.y > (v.top + v.bottom) / 2 ? v.top + 10 : v.bottom - sh - 10;
    } else {
      left = mark.x - mark.r - 26 - sw;
      if (left < v.L + 8) { left = mark.x + mark.r + 26; right = true; }
      left = Math.min(left, v.R - 8 - sw);
      top = clamp(mark.y - sh / 2, v.top + 6, v.bottom - sh - 6);
    }
    const pos = Math.round(left) + ',' + Math.round(top);
    if (pos !== this.spotPos) { sp.style.left = Math.round(left) + 'px'; sp.style.top = Math.round(top) + 'px'; this.spotPos = pos; }
    // leader line from the bubble to the callout
    const ex = right ? left : left + sw, ey = clamp(mark.y, top + 10, top + sh - 10);
    c.strokeStyle = p.ink3; c.lineWidth = 1;
    c.beginPath(); c.moveTo(mark.x + (right ? mark.r + 3 : -mark.r - 3), mark.y); c.lineTo(ex, ey); c.stroke();
  }
}
// the shared scheduler pauses on the Pause button; the stage must not keep itself awake then
const pauseBtn = $('#pause');
const isPausedDisplay = () => pauseBtn.getAttribute('aria-pressed') === 'true';

// ---------------------------------------------------------------- depth chart
class DepthChart extends Panel {
  constructor(container) {
    super(container, { height: w => w < 500 ? 230 : 280, every: 250, aria: 'Cumulative depth: bid size to the left of mid and ask size to the right. The table view lists every level.' });
  }
  paint() {
    const { c, p } = this.begin(), W = this.w, H = this.hgt;
    const book = session.book, b = session.state === 'live' ? book.bbo() : null;
    if (!b) { this.view = null; this.empty(c, p, 'Waiting for the first verified book'); return; }
    const m = midOf(b);
    const bp = book.bids.px, bq = book.bids.qty, ap = book.asks.px, aq = book.asks.qty;
    const cb = new Float64Array(bp.length), ca = new Float64Array(ap.length);
    for (let i = 0, s = 0; i < bp.length; i++) cb[i] = s += bq[i];
    for (let i = 0, s = 0; i < ap.length; i++) ca[i] = s += aq[i];
    const half = Math.max(m - bp[bp.length - 1], ap[ap.length - 1] - m);
    const x0 = m - half * 1.02, x1 = m + half * 1.02;
    const top = 18, bottom = H - 20, left = 0, right = W - 4;
    const NY = niceTicks(0, Math.max(cb[cb.length - 1], ca[ca.length - 1]) * 1.04, 4);
    const X = v => left + (v - x0) / (x1 - x0) * (right - left);
    const Y = v => bottom - v / NY.hi * (bottom - top);
    c.lineWidth = 1; c.textAlign = 'left';
    for (const v of NY.ticks) {
      const y = Math.round(Y(v)) + 0.5;
      c.strokeStyle = v === 0 ? p.axis : p.grid; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      if (v > 0) { c.fillStyle = p.muted; c.fillText(fmt.sig(v, 3), left + 2, y - 3); }
    }
    const NX = niceTicks(x0, x1, Math.max(2, Math.floor(W / 120)));
    const dec = Math.max(0, -Math.floor(Math.log10(NX.step) + 1e-9));
    c.textAlign = 'center'; c.fillStyle = p.muted;
    for (const v of NX.ticks) { const x = X(v); if (x < 30 || x > right - 30) continue; c.fillText(fmt.fixed(v, dec), x, H - 5); }
    // step areas: cumulative size is flat between levels and jumps at each level
    const side = (px, cum, col) => {
      const pts = [[px[0], 0], [px[0], cum[0]]];
      for (let i = 1; i < px.length; i++) { pts.push([px[i], cum[i - 1]]); pts.push([px[i], cum[i]]); }
      c.beginPath(); pts.forEach(([u, v], k) => k ? c.lineTo(X(u), Y(v)) : c.moveTo(X(u), Y(v)));
      c.lineTo(X(px[px.length - 1]), Y(0)); c.closePath();
      c.fillStyle = rgba(p.color(col), 0.14); c.fill();
      c.beginPath(); pts.forEach(([u, v], k) => k ? c.lineTo(X(u), Y(v)) : c.moveTo(X(u), Y(v)));
      c.strokeStyle = p.color(col); c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
    };
    side(bp, cb, 1); side(ap, ca, 2);
    const xm = Math.round(X(m)) + 0.5;
    c.strokeStyle = p.ink3; c.lineWidth = 1; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(xm, top); c.lineTo(xm, bottom); c.stroke(); c.setLineDash([]);
    c.fillStyle = p.ink2; c.textAlign = xm > W / 2 ? 'right' : 'left';
    c.fillText('mid ' + fPx(m, 1), xm + (xm > W / 2 ? -5 : 5), top + 10);
    this.view = { X, Y, x0, x1, left, right, top, bottom };
    if (isNum(this.hx) && this.hx >= left && this.hx <= right) {
      const v = x0 + (this.hx - left) / (right - left) * (x1 - x0);
      const x = Math.round(this.hx) + 0.5;
      c.strokeStyle = p.ink3; c.lineWidth = 1; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      const head = fPx(v) + ' ' + S.quote + ' (' + fmt.signed((v - m) / m * 1e4, 1) + ' bps from mid)';
      let q = 0, n = 0, k = 0, col = 0;
      if (v <= b.pb) { for (; k < bp.length && bp[k] >= v; k++) { q += bq[k]; n += bp[k] * bq[k]; } col = 1; }
      else if (v >= b.pa) { for (; k < ap.length && ap[k] <= v; k++) { q += aq[k]; n += ap[k] * aq[k]; } col = 2; }
      if (col) {
        const y = Y(q);
        c.beginPath(); c.arc(x, y, 6, 0, 7); c.fillStyle = p.surface; c.fill();
        c.beginPath(); c.arc(x, y, 4, 0, 7); c.fillStyle = p.color(col); c.fill();
        const beyond = col === 1 ? v < bp[bp.length - 1] : v > ap[ap.length - 1];
        this.showTip(this.hx, this.hy, head, [
          { color: p.color(col), value: fQty(q) + ' ' + S.base, label: (col === 1 ? 'waiting to buy' : 'waiting to sell') + ', ' + k + ' levels' },
          { color: p.color(col), value: fUsd(n), label: 'dollar value' },
          ...(beyond ? [{ value: 'past level 100', label: 'not subscribed' }] : []),
        ]);
      } else this.showTip(this.hx, this.hy, head, [{ value: fPx(b.pa - b.pb), label: 'inside the gap' }]);
    } else this.hideTip();
  }
}

// ---------------------------------------------------------------- mount
const stageEl = $('#stage'), stage = new Stage(stageEl);
mountLegend($('.legend', stageEl), [
  { label: 'Best bid', color: 1 }, { label: 'Best ask', color: 2 },
  { label: 'Buy', color: 1, shape: 'dot' }, { label: 'Sell', color: 2, shape: 'dot' },
  { label: 'Not observed', color: 'sunk', shape: 'rect' },
]);

const depthCard = $('#c-depth'), depth = new DepthChart($('.card__b', depthCard));
mountLegend($('.legend', depthCard), [{ label: 'Waiting to buy (bids)', color: 1, shape: 'rect' }, { label: 'Waiting to sell (asks)', color: 2, shape: 'rect' }]);

const ofiCard = $('#c-ofi');
mountLegend($('.legend', ofiCard), [
  { label: 'Net buying', color: 1, shape: 'dot' }, { label: 'Net selling', color: 2, shape: 'dot' }, { label: 'Least squares line', color: 'ink' },
]);
const ofiChart = new Scatter($('.card__b', ofiCard), {
  height: w => w < 500 ? 240 : 280, every: 500,
  x: { sym: true, label: 'net buying, ' + S.base, fmt: v => fmt.sig(v, 2) },
  y: { sym: true, fmt: v => fmt.sig(v, 2) },
  empty: 'Collecting one point per second',
  aria: 'Scatter of per second order flow imbalance against mid price change, with a least squares line',
  tip: q => ({ head: fmt.time(q.t) + ' exchange time', rows: [
    { color: palette().color(q.color), shape: 'dot', value: fmt.signed(q.x, 3) + ' ' + S.base, label: 'net buying (OFI)' },
    { value: fmt.signed(q.y, pp() + 1) + ' ' + S.quote, label: 'mid change' },
  ] }),
});

const siCard = $('#c-si'), siBody = $('.card__b', siCard);
siBody.append(h('p', { class: 'pair__lab' }, 'Gap between best bid and ask, bps'));
const spreadChart = new TimeChart(siBody, {
  height: 120, every: 500, group: 'book-si', gapMs: 2000,
  series: [{ key: 'spread', label: 'gap', color: 3, kind: 'step', fmt: v => fmt.sig(v, 3) + ' bps' }],
  y: { min: 0, ticks: 3, fmt: v => fmt.sig(v, 2) }, x: { span: SI_SPAN },
  tipExtra: r => [{ value: fmt.int(r.ticks), label: r.ticks === 1 ? 'tick' : 'ticks' }],
  empty: 'Waiting for the first verified book', aria: 'Spread in basis points, last 5 minutes',
});
siBody.append(h('p', { class: 'pair__lab' }, "Bids' share of size at the best prices"));
const imbChart = new TimeChart(siBody, {
  height: 120, every: 500, group: 'book-si', gapMs: 2000,
  series: [{ key: 'imb', label: 'bid share', color: 1, fmt: v => fmt.pct(v, 0) }],
  y: { min: 0, max: 1, pad: 0, ticks: 4, fmt: v => fmt.pct(v, 0) }, x: { span: SI_SPAN },
  refs: [{ y: 0.5, label: 'even' }],
  empty: 'Waiting for the first verified book', aria: 'Top of book imbalance, last 5 minutes',
});

const flowCard = $('#c-flow');
mountLegend($('.legend', flowCard), [{ label: 'Bought (buyer crossed)', color: 1, shape: 'rect' }, { label: 'Sold (seller crossed)', color: 2, shape: 'rect' }]);
const flowChart = new Columns($('.card__b', flowCard), {
  height: 250, every: 1000, stacked: true, labelEvery: 1,
  series: [{ key: 'buy', label: 'bought', color: 1, fmt: v => fQty(v) }, { key: 'sell', label: 'sold', color: 2, fmt: v => fQty(v) }],
  y: { fmt: v => fQty(v), labelsOver: true },
  tipExtra: k => [{ value: fmt.int(k.n), label: 'trades' }, { value: fmt.pct(k.share, 0), label: 'bought share' }],
  empty: 'Collecting the first 10 s', aria: 'Stacked columns of buyer and seller initiated volume per 10 seconds',
});

const sizesCard = $('#c-sizes');
mountLegend($('.legend', sizesCard), [{ label: 'Buys', color: 1, shape: 'rect' }, { label: 'Sells', color: 2, shape: 'rect' }]);
const sizesChart = new Columns($('.card__b', sizesCard), {
  height: 270, every: 1000,
  series: [{ key: 'buy', label: 'buys', color: 1 }, { key: 'sell', label: 'sells', color: 2 }],
  y: { fmt: v => fmt.int(v), labelsOver: true },
  empty: 'Waiting for the first trade', aria: 'Columns of trade counts by notional size bin',
});

const integCard = $('#c-integ');
mountLegend($('.legend', integCard), [{ label: 'Median (p50)', color: 3 }, { label: '95th percentile (p95)', color: 4 }]);
const lagChart = new TimeChart($('#lag-chart'), {
  height: 190, every: 1000, gapMs: 3000,
  series: [{ key: 'p50', label: 'p50', color: 3, fmt: fMs }, { key: 'p95', label: 'p95', color: 4, fmt: fMs }],
  y: { min: 0, ticks: 3, fmt: v => fmt.int(v) }, x: { span: LAG_KEEP * 1000 }, stackTip: false,
  empty: 'Waiting for book updates', aria: 'Exchange timestamp to arrival lag per second, median and 95th percentile',
});

// ---------------------------------------------------------------- derived series
function ofiRows() { return S.flow.rows(OFI_WIN, S.flow.last); }
function rvNow() {
  const span = S.flow.span(S.flow.last);
  if (span < RV_MIN + 1) return { ready: false, span };
  const mids = S.flow.rows(Math.min(RV_WIN + 1, span), S.flow.last).map(r => r.mid);
  const r1 = realizedVol(mids, 1), r10 = realizedVol(mids, 10);
  return { ready: true, span, r1, r10, a1: annualize(r1.rv, r1.windowSec), a10: annualize(r10.rv, r10.windowSec) };
}
function flowCats(now) {
  const cur = Math.floor(now / FLOW_BIN), out = [];
  const first = isNum(S.subAt) ? Math.ceil(S.subAt / FLOW_BIN) : cur;
  for (let k = Math.max(cur - FLOW_N, first); k < cur; k++) {
    const b = S.flowBins.get(k) || { buy: 0, sell: 0, n: 0 }, t = k * FLOW_BIN, tot = b.buy + b.sell;
    out.push({ t, buy: b.buy, sell: b.sell, n: b.n, share: tot > 0 ? b.buy / tot : NaN,
      label: (k % (flowChart.w < 500 ? 12 : 6) === 0) ? fmt.time(t, false, false) : '', tip: fmt.time(t) + ' to ' + fmt.time(t + FLOW_BIN) });
  }
  return out;
}
function lagRows(now) {
  const cur = Math.floor(now / 1000), out = [];
  for (let s = cur - LAG_KEEP; s < cur; s++) {
    const b = S.lagBins.get(s);
    if (!b || !b.book.length) continue;
    if (!b.q) { const [p50, p95] = quantiles(b.book, [0.5, 0.95]); b.q = { p50, p95, n: b.book.length }; }
    out.push({ t: s * 1000, p50: b.q.p50, p95: b.q.p95, n: b.q.n });
  }
  return out;
}
function lagWindow(kind, now, secs = 60) {
  const cur = Math.floor(now / 1000), all = [];
  for (let s = cur - secs; s <= cur; s++) { const b = S.lagBins.get(s); if (b) for (const v of b[kind]) all.push(v); }
  if (!all.length) return null;
  const [p50, p95] = quantiles(all, [0.5, 0.95]);
  return { p50, p95, n: all.length };
}
function tradesLastMinute(now) {
  let n = 0, nb = 0;
  for (let i = S.trades.length - 1; i >= 0; i--) { const tr = S.trades.at(i); if (tr.t < now - TPM_MS) break; n++; if (tr.side === 'buy') nb++; }
  return { n, nb, ready: isNum(S.subAt) && now - S.subAt >= TPM_MS, secs: isNum(S.subAt) ? Math.floor((now - S.subAt) / 1000) : 0 };
}

// ---------------------------------------------------------------- KPIs
const kv = {};
function setKpi(id, value, unit = '', sub = null) {
  const el = $('#' + id), keyStr = value + '|' + unit;
  if (kv[id] !== keyStr) {
    kv[id] = keyStr;
    el.removeAttribute('data-wait');
    el.replaceChildren(value, ...(unit ? [h('small', null, unit)] : []));
  }
  if (sub != null) setSubs(id + '-s', sub);
}
// a waiting tile: short text and, while collecting, a small progress bar, on one line
function setWait(id, text, frac = null, sub = null) {
  const el = $('#' + id), key = 'wait|' + text + '|' + (frac == null ? '' : Math.round(frac * 50));
  if (kv[id] !== key) {
    kv[id] = key;
    el.setAttribute('data-wait', '');
    el.replaceChildren(h('span', null, text), ...(frac == null ? [] : [h('span', { class: 'wait__bar', role: 'presentation' }, h('i', { style: { width: Math.round(clamp(frac, 0, 1) * 100) + '%' } }))]));
  }
  if (sub != null) setSubs(id + '-s', sub);
}
// sub lines are built from parts so a badge can carry an icon and a label
function setSubs(id, parts) {
  const el = $('#' + id), arr = Array.isArray(parts) ? parts : [parts];
  const sig = arr.map(x => typeof x === 'string' ? x : x.badge + ':' + x.text).join('|');
  if (el._sig === sig) return;
  el._sig = sig;
  el.replaceChildren(...arr.map(x => typeof x === 'string' ? x : h('span', { class: 'badge badge--' + x.badge }, x.text)));
}

const kpiJob = onPaint(() => {
  const now = Date.now(), live = session.state === 'live', b = live ? session.book.bbo() : null;
  const st = session.stats, tick = Math.pow(10, -pp());
  const stateWord = session.state === 'syncing' ? 'resyncing' : session.state === 'instrument' ? 'reading precision' : 'connecting';
  if (b) {
    const m = midOf(b), mp = microprice(b), ticks = Math.round(spreadOf(b) / tick);
    setKpi('k-mid', fPx(m, 1), '', 'microprice ' + fPx(mp, 2) + ', the mid nudged toward the thinner side');
    setKpi('k-spr', fmt.sig(spreadBps(b), 2), 'bps', fPx(spreadOf(b)) + ' ' + S.quote + ', ' + (ticks === 1 ? 'one tick' : ticks + ' ticks') + '; 1 bps is 0.01%');
    setKpi('k-imb', fmt.pct(imbalance(b), 0), '', fQty(b.qb) + ' bid vs ' + fQty(b.qa) + ' ask, ' + S.base);
    setText('#h-top', 'Right now the mid is ' + fPx(m, 1) + ', the microprice ' + fPx(mp, 2) + ' (' + fmt.signed(mp - m, pp() + 2) + ' vs mid), the gap ' + fPx(spreadOf(b)) + ' ' + S.quote + ' (' + ticks + (ticks === 1 ? ' tick' : ' ticks') + ' of ' + fPx(tick) + '), and the bid share ' + fmt.fixed(imbalance(b), 3) + ' (' + fQty(b.qb) + ' vs ' + fQty(b.qa) + ' ' + S.base + ').');
    setText('#sf-mid', fPx(m, 1));
    setText('#sf-gap', fPx(spreadOf(b)) + ' ' + S.quote + ' (' + fmt.sig(spreadBps(b), 2) + ' bps)');
  } else {
    setWait('k-mid', stateWord, null, 'the mid between best bid and best ask');
    setWait('k-spr', stateWord); setWait('k-imb', stateWord);
    setText('#sf-mid', stateWord); setText('#sf-gap', stateWord);
  }
  // integrity
  const total = st.verified + st.mismatched;
  if (total) {
    setKpi('k-int', st.mismatched ? fmt.pct(st.verified / total, 2) : '100%', 'match', [
      st.mismatched === 0 ? { badge: 'good', text: 'exact' } : live ? { badge: 'warning', text: 'resynced' } : { badge: 'critical', text: 'resyncing' },
      fmt.int(st.verified) + ' of ' + fmt.int(total) + ' checks, ' + fmt.int(st.resyncs) + (st.resyncs === 1 ? ' resync' : ' resyncs'),
    ]);
    setText('#h-int', 'So far ' + fmt.int(st.verified) + ' of ' + fmt.int(total) + ' book messages matched, ' + fmt.int(st.mismatched) + (st.mismatched === 1 ? ' mismatch, ' : ' mismatches, ') + fmt.int(st.resyncs) + (st.resyncs === 1 ? ' resync, ' : ' resyncs, ') + fmt.int(feed.reconnects) + ' reconnect attempts.');
    setText('#sf-chk', fmt.int(st.verified) + ' of ' + fmt.int(total));
  } else { setWait('k-int', stateWord, null, 'checked after every update'); setText('#sf-chk', stateWord); }
  // trades per minute
  const tm = tradesLastMinute(now);
  if (tm.ready) {
    setKpi('k-tpm', fmt.int(tm.n), '', fmt.int(tm.nb) + ' buys, ' + fmt.int(tm.n - tm.nb) + ' sells, last 60 s');
    setText('#sf-tpm', fmt.int(tm.n));
  } else if (isNum(S.subAt)) {
    setWait('k-tpm', tm.secs + ' / 60 s', tm.secs / 60, 'counted over the last 60 s');
    setText('#sf-tpm', 'collecting, ' + tm.secs + ' / 60 s');
  } else { setWait('k-tpm', stateWord, null, 'counted over the last 60 s'); setText('#sf-tpm', stateWord); }
  // realized volatility
  const rv = rvNow();
  if (rv.ready) {
    const win = rv.r1.windowSec >= RV_WIN ? 'last 5 min' : 'last ' + rv.r1.windowSec + ' s';
    setKpi('k-rv1', fmt.pct(rv.a1, 1), '', 'yearly volatility from ' + win + ' of 1 s moves');
    // the gap is read against its own sampling error (both estimates treated as independent)
    const gap = rv.a1 - rv.a10, seGap = Math.hypot(rv.a1 * rvRelSE(rv.r1.n), rv.a10 * rvRelSE(rv.r10.n));
    const within = Math.abs(gap) <= 2 * seGap;
    setKpi('k-rv10', fmt.pct(rv.a10, 1), '', within ? 'agrees with the 1 s figure within error' : gap > 0 ? 'below 1 s, which quote noise lifts' : 'above 1 s; prices moved in runs');
    setText('#h-rv', 'Right now 1 s sampling gives ' + rv.r1.n + ' returns over ' + rv.r1.windowSec + ' s (error about ' + fmt.pct(rvRelSE(rv.r1.n), 0) + '); 10 s sampling gives ' + rv.r10.n + ' returns (about ' + fmt.pct(rvRelSE(rv.r10.n), 0) + '). The 1 s figure minus the 10 s figure is ' + fmt.signed(gap * 100, 1) + ' points, against twice its standard error of ' + fmt.fixed(2 * seGap * 100, 1) + ' points, so ' + (within ? 'the two agree within sampling error.' : gap > 0 ? 'the excess at 1 s reflects microstructure noise, because tick size and flickering quotes add to the sum of squares at fine sampling.' : 'the 10 s figure is higher, which noise cannot cause, so prices moved in short runs within the window.'));
  } else {
    const shown = Math.max(0, rv.span);
    setWait('k-rv1', shown + ' / ' + RV_MIN + ' s', shown / RV_MIN, 'yearly volatility from 1 s moves');
    setWait('k-rv10', shown + ' / ' + RV_MIN + ' s', shown / RV_MIN, 'same, from 10 s moves');
  }
  setText('#since', isNum(S.subAt) ? S.symbol + ' since ' + fmt.time(S.subAt) + ', precision ' + prec().pricePrec + ' / ' + prec().qtyPrec + ' decimals' : session.state === 'idle' ? 'connecting' : 'subscribing to ' + S.symbol);
}, 250);
jobs.push(kpiJob);

// ---------------------------------------------------------------- chart feeds
const siJob = onPaint(() => {
  const rows = S.si.toArray(), now = Date.now();
  const vl = S.events.toArray().map(e => ({ t: e.t, label: e.label }));
  spreadChart.set(rows, { now, vlines: vl });
  imbChart.set(rows, { now, vlines: vl });
  if (rows.length) {
    const [med] = quantiles(rows.map(r => r.spread), [0.5]);
    let one = 0, im = 0; for (const r of rows) { if (r.ticks <= 1) one++; im += r.imb; }
    rich('#f-si', ['The gap sat at its one tick minimum ', { b: fmt.pct(one / rows.length, 0) }, ' of the time; bids held ', { b: fmt.pct(im / rows.length, 0) }, ' of the size at the best prices on average.']);
    setText('#h-si', 'Right now the median spread is ' + fmt.sig(med, 2) + ' bps over ' + fmt.int(rows.length) + ' samples, and the mean imbalance is ' + fmt.fixed(im / rows.length, 3) + '.');
  }
}, 500);
jobs.push(siJob);

const dataJob = onPaint(() => {
  const now = Date.now();
  // OFI scatter and fit
  const rows = ofiRows(), valid = rows.filter(r => r.valid);
  const fit = valid.length >= OFI_MIN ? ofiRegression(rows) : null;
  ofiChart.set(valid.map(r => ({ x: r.ofi, y: r.dmid, t: r.t, color: r.ofi >= 0 ? 1 : 2, r: 3, alpha: 0.6 })), { fit });
  if (fit) {
    rich('#f-ofi', ['Each ' + S.base + ' of net buying went with a ', { b: fmt.sig(Math.abs(fit.b), 2) + ' ' + S.quote }, (fit.b >= 0 ? ' rise' : ' fall') + ' in the same second; the line explains ', { b: fmt.pct(fit.r2, 0) }, ' of the moves.']);
    setText('#h-ofi', 'Right now slope b = ' + fmt.sig(fit.b, 3) + ' ' + S.quote + ' per ' + S.base + ' (standard error ' + fmt.sig(fit.se, 2) + '), intercept a = ' + fmt.signed(fit.a, 3) + ' ' + S.quote + ', R squared ' + fmt.fixed(fit.r2, 2) + ', n = ' + fit.n + ' seconds.');
  } else if (valid.length >= OFI_MIN) rich('#f-ofi', ['No line yet, because net buying did not vary over the window.']);
  else rich('#f-ofi', ['Collecting seconds, ', { b: valid.length + ' of ' + OFI_MIN }, ' needed before a line is fitted.']);
  // trade flow
  flowChart.set(flowCats(now));
  const tl = S.tally;
  if (tl.n) {
    rich('#f-flow', ['Buyers started ', { b: fmt.pct(tl.buyShare(), 0) }, ' of the volume since ' + fmt.time(S.subAt, false, false) + '; the average price paid was ', { b: fPx(tl.vwap(), 1) + ' ' + S.quote }, '.']);
    setText('#h-flow', 'Right now VWAP is ' + fPx(tl.vwap(), 2) + ' ' + S.quote + ' over ' + fmt.int(tl.n) + ' trades since ' + fmt.time(S.subAt) + '; buyer initiated share of volume ' + fmt.pct(tl.buyShare(), 1) + '.');
  } else if (isNum(S.subAt)) rich('#f-flow', ['No trades yet since ' + fmt.time(S.subAt) + '.']);
  // trade sizes
  sizesChart.set(tl.n ? NOTIONAL_BINS.map((label, i) => ({ label, buy: tl.bins[i].buy, sell: tl.bins[i].sell, tip: label + (i === 0 ? '' : i === NOTIONAL_BINS.length - 1 ? ' and above' : ' to ' + NOTIONAL_BINS[i + 1].replace('+', '')) })) : []);
  if (S.trades.length) {
    const notion = S.trades.toArray().map(t => t.price * t.qty), [med] = quantiles(notion, [0.5]);
    let mx = 0; for (const v of notion) mx = Math.max(mx, v);
    rich('#f-sizes', ['Half of trades were under ', { b: fUsd(med) }, '; the largest was ', { b: fUsd(mx) }, '.']);
    setText('#h-sizes', 'Median and largest over the last ' + fmt.int(notion.length) + ' trades (up to 5,000 kept).');
    rich('#f-tape', [{ b: fmt.int(tl.n) }, ' trades since subscribing. A buy lifted the ask; a sell hit the bid.']);
  }
  lagChart.set(lagRows(now), { now });
  // depth
  const b = session.state === 'live' ? session.book.bbo() : null;
  if (b) {
    const m = midOf(b), lo = m * (1 - BAND_BPS / 1e4), hi = m * (1 + BAND_BPS / 1e4), bk = session.book;
    let qb = 0, qa = 0;
    for (let i = 0; i < bk.bids.length && bk.bids.px[i] >= lo; i++) qb += bk.bids.qty[i];
    for (let i = 0; i < bk.asks.length && bk.asks.px[i] <= hi; i++) qa += bk.asks.qty[i];
    const bEdge = bk.bids.edge(), aEdge = bk.asks.edge();
    const short = (bk.bids.length >= DEPTH && bEdge > lo) || (bk.asks.length >= DEPTH && aEdge < hi);
    rich('#f-depth', ['Within 0.05% of the price, ', { b: fQty(qb) + ' ' + S.base }, ' wait to buy and ', { b: fQty(qa) + ' ' + S.base }, ' wait to sell' + (short ? ' (a lower bound, because level 100 sits inside that band).' : '.')]);
    setText('#h-depth', 'Right now level 100 sits ' + fmt.fixed((m - bEdge) / m * 1e4, 1) + ' bps below mid and ' + fmt.fixed((aEdge - m) / m * 1e4, 1) + ' bps above.');
  }
  // stage scale and its technical note
  const v = stage.view;
  if (v && isNum(stage.lo)) {
    $('#sf-scale').hidden = false;
    setText('#sf-lo', fmt.sig(Math.pow(10, stage.lo), 2));
    setText('#sf-hi', fmt.sig(Math.pow(10, stage.hi), 2) + ' ' + S.base);
    setText('#h-bucket', fPx(v.bucket, 2) + ' ' + S.quote);
    setText('#h-scale', fmt.sig(Math.pow(10, stage.lo), 2) + ' to ' + fmt.sig(Math.pow(10, stage.hi), 2) + ' ' + S.base + ' right now');
  }
  integrityRows(now);
}, 1000);
jobs.push(dataJob);

// ---------------------------------------------------------------- integrity rows
const integEl = $('#integ-rows'), integRefs = {};
function integrityRows(now) {
  const st = session.stats, bt = st.byType;
  const lb = lagWindow('book', now), lt = lagWindow('trade', now);
  const items = [
    ['Checksums matched', fmt.int(st.verified)],
    ['Mismatches', fmt.int(st.mismatched)],
    ['Resyncs (unsubscribe, resubscribe)', fmt.int(st.resyncs)],
    ['Reconnect attempts', fmt.int(feed.reconnects)],
    ['Book snapshots', fmt.int(bt.snapshot || 0)],
    ['Book updates', fmt.int(bt.update || 0)],
    ['Updates ignored while resyncing or switching', fmt.int(st.ignored)],
    ['Trade messages (trades)', fmt.int(bt.trade || 0) + ' (' + fmt.int(st.trades) + ')'],
    ['Heartbeats', fmt.int(bt.heartbeat || 0)],
    ['Status, instrument and acks', fmt.int((bt.status || 0) + (bt.instrument || 0) + (bt.ack || 0))],
    ['Request errors', fmt.int(st.errors) + (lastError ? ' (last: ' + lastError + ')' : '')],
    ['Delay, book updates, last 60 s', lb ? 'p50 ' + fMs(lb.p50) + ', p95 ' + fMs(lb.p95) : 'waiting'],
    ['Delay, trades, last 60 s', lt ? 'p50 ' + fMs(lt.p50) + ', p95 ' + fMs(lt.p95) : 'waiting'],
    ['Data received', fmt.compact(st.bytes / 1024) + ' KB in ' + fmt.int(st.msgs) + ' messages'],
  ];
  for (const [label, value] of items) {
    let r = integRefs[label];
    if (!r) { r = h('div', { class: 'row__v' }); integEl.append(h('div', { class: 'row' }, h('div', { class: 'row__l' }, label), r)); integRefs[label] = r; }
    setText(r, value);
  }
  const total = st.verified + st.mismatched, lw = lagWindow('book', now, 300);
  if (total && lw) {
    rich('#f-integ', [{ b: fmt.int(st.verified) + ' of ' + fmt.int(total) }, ' updates matched the exchange; updates arrive in about ', { b: fMs(lw.p50) }, ' (median).']);
    setText('#h-integ', 'Over the last 5 minutes p50 was ' + fMs(lw.p50) + ' and p95 ' + fMs(lw.p95) + ', over ' + fmt.int(lw.n) + ' book updates.');
  }
}

// ---------------------------------------------------------------- trade tape
const tapeEl = $('#tape');
let tapeSeen = -1;
const tapeJob = onPaint(() => {
  if (S.tapeVer === tapeSeen) return;
  const firstPaint = tapeSeen < 0;
  tapeSeen = S.tapeVer;
  const p = palette(), list = S.tape.toArray().reverse();
  if (!list.length) { tapeEl.replaceChildren(h('div', { class: 'empty' }, isNum(S.subAt) ? 'No trades yet since subscribing.' : 'Waiting for the first trade.')); return; }
  const head = h('div', { class: 'tape__r tape__h' }, h('span', null, 'time'), h('span', null, 'side'), h('span', { class: 'v' }, 'price'), h('span', { class: 'v' }, 'size, ' + S.base), h('span', { class: 'v n' }, 'value'));
  const prevTop = tapeEl._top;
  tapeEl.replaceChildren(head, ...list.map(tr => h('div', { class: 'tape__r' + (!firstPaint && prevTop != null && tr.id > prevTop ? ' new' : '') },
    h('time', null, fmt.time(tr.te)),
    h('span', { class: 'side' }, h('i', { style: { background: p.color(tr.side === 'buy' ? 1 : 2) } }), tr.side),
    h('span', { class: 'v' }, fPx(tr.price)),
    h('span', { class: 'v' }, fQty(tr.qty)),
    h('span', { class: 'v n' }, fUsd(tr.price * tr.qty)))));
  tapeEl._top = list[0].id;
}, 500);
jobs.push(tapeJob);
addEventListener('themechange', () => { tapeSeen = -2; stage.spotId = undefined; });

// ---------------------------------------------------------------- table views
tableView(stageEl, () => {
  const rows = [], v = stage.view;
  for (let i = S.cols.length - 1; i >= 0 && rows.length < 120; i--) {
    const c = S.cols.at(i);
    let qb = 0, qa = 0;
    if (v) { for (let k = 0; k < c.bp.length && c.bp[k] >= v.pBot; k++) qb += c.bq[k]; for (let k = 0; k < c.ap.length && c.ap[k] <= v.pTop; k++) qa += c.aq[k]; }
    rows.push({ t: c.t, pb: c.pb, pa: c.pa, mid: (c.pb + c.pa) / 2, qb, qa });
  }
  return { cols: [
    { key: 't', label: 'Time', fmt: fClock }, { key: 'pb', label: 'Best bid', fmt: x => fPx(x) }, { key: 'pa', label: 'Best ask', fmt: x => fPx(x) },
    { key: 'mid', label: 'Mid', fmt: x => fPx(x, 1) }, { key: 'qb', label: 'Bid size in window, ' + S.base, fmt: fQty }, { key: 'qa', label: 'Ask size in window, ' + S.base, fmt: fQty },
  ], rows };
});
$('[data-act="table"]', stageEl).addEventListener('click', () => { stage.job.now(); });
tableView(depthCard, () => {
  const bk = session.book, rows = [];
  let cq = 0, cn = 0;
  for (let i = 0; i < bk.bids.length; i++) { cq += bk.bids.qty[i]; cn += bk.bids.px[i] * bk.bids.qty[i]; rows.push({ side: 'bid', lvl: i + 1, px: bk.bids.px[i], q: bk.bids.qty[i], cq, cn }); }
  cq = 0; cn = 0;
  for (let i = 0; i < bk.asks.length; i++) { cq += bk.asks.qty[i]; cn += bk.asks.px[i] * bk.asks.qty[i]; rows.push({ side: 'ask', lvl: i + 1, px: bk.asks.px[i], q: bk.asks.qty[i], cq, cn }); }
  return { cols: [
    { key: 'side', label: 'Side', left: true }, { key: 'lvl', label: 'Level' }, { key: 'px', label: 'Price', fmt: x => fPx(x) },
    { key: 'q', label: 'Size, ' + S.base, fmt: fQty }, { key: 'cq', label: 'Cumulative, ' + S.base, fmt: fQty }, { key: 'cn', label: 'Cumulative value', fmt: fUsd },
  ], rows };
});
tableView(ofiCard, () => ({ cols: [
  { key: 't', label: 'Second (exchange time)', fmt: t => fmt.time(t) }, { key: 'ofi', label: 'Net buying (OFI), ' + S.base, fmt: x => fmt.signed(x, 4) },
  { key: 'dmid', label: 'Mid change, ' + S.quote, fmt: x => fmt.signed(x, pp() + 1) }, { key: 'n', label: 'Book events' }, { key: 'valid', label: 'In fit', fmt: x => x ? 'yes' : 'no' },
], rows: ofiRows().reverse() }));
tableView(siCard, () => ({ cols: [
  { key: 't', label: 'Time', fmt: fClock }, { key: 'spread', label: 'Gap, bps', fmt: x => fmt.sig(x, 3) }, { key: 'ticks', label: 'Gap, ticks' }, { key: 'imb', label: 'Bid share', fmt: x => fmt.fixed(x, 3) },
], rows: S.si.toArray().reverse() }));
tableView(flowCard, () => ({ cols: [
  { key: 'tip', label: 'Interval', left: true }, { key: 'buy', label: 'Bought, ' + S.base, fmt: fQty }, { key: 'sell', label: 'Sold, ' + S.base, fmt: fQty }, { key: 'n', label: 'Trades' },
], rows: flowCats(Date.now()).reverse() }));
tableView(sizesCard, () => ({ cols: [
  { key: 'label', label: 'Dollar value', left: true }, { key: 'buy', label: 'Buys' }, { key: 'sell', label: 'Sells' },
], rows: NOTIONAL_BINS.map((label, i) => ({ label, buy: S.tally.bins[i].buy, sell: S.tally.bins[i].sell })) }));
tableView(integCard, () => ({ cols: [
  { key: 't', label: 'Second (arrival time)', fmt: t => fmt.time(t) }, { key: 'p50', label: 'Delay p50', fmt: fMs }, { key: 'p95', label: 'Delay p95', fmt: fMs }, { key: 'n', label: 'Book updates' },
], rows: lagRows(Date.now()).reverse() }));

// ---------------------------------------------------------------- start
if (typeof WebSocket === 'undefined') feed.set('error', 'WebSocket unavailable in this browser');
else connect();
