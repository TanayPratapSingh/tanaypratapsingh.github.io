// Order book maintenance and microstructure statistics for the Kraken v2
// WebSocket feed. Pure logic: no DOM and no socket, so the node test suite and
// the live verification script run exactly the code the page runs.
import { ols, isNum } from '../assets/util.js';

// ---------------------------------------------------------------- CRC32
// IEEE 802.3 polynomial, reflected (0xEDB88320), table driven. The checksum
// input is a string of ASCII digits, so the fast path reads char codes; any
// other string is UTF-8 encoded first.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(input) {
  let c = 0xFFFFFFFF;
  if (typeof input === 'string') {
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code > 0x7F) return crc32(new TextEncoder().encode(input));
      c = CRC_TABLE[(c ^ code) & 0xFF] ^ (c >>> 8);
    }
  } else {
    for (let i = 0; i < input.length; i++) c = CRC_TABLE[(c ^ input[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------- checksum
// One field of the checksum string: the number printed with the instrument's
// precision, decimal point removed, leading zeros stripped. 81452.0 at
// precision 1 becomes "814520"; 0.0157 at precision 8 becomes "1570000".
export function checksumField(x, prec) {
  return x.toFixed(prec).replace('.', '').replace(/^0+/, '');
}

// asks and bids are arrays of [price, qty], best level first. Only the top 10
// of each side enter the checksum: asks ascending, then bids descending.
export function checksumString(asks, bids, pricePrec, qtyPrec) {
  let s = '';
  const na = Math.min(10, asks.length), nb = Math.min(10, bids.length);
  for (let i = 0; i < na; i++) s += checksumField(asks[i][0], pricePrec) + checksumField(asks[i][1], qtyPrec);
  for (let i = 0; i < nb; i++) s += checksumField(bids[i][0], pricePrec) + checksumField(bids[i][1], qtyPrec);
  return s;
}

// ---------------------------------------------------------------- book side
// Parallel sorted arrays of price and size, best level first: bids descending,
// asks ascending. Lookup is a binary search; at depth 100 a splice moves at
// most 100 numbers, which is cheaper than any tree at this size.
export class BookSide {
  constructor(side) { this.side = side; this.desc = side === 'bid'; this.px = []; this.qty = []; }
  get length() { return this.px.length; }
  clear() { this.px.length = 0; this.qty.length = 0; }
  // insertion point: index of the first level that is not strictly better than p
  search(p) {
    const a = this.px; let lo = 0, hi = a.length;
    if (this.desc) while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] > p) lo = m + 1; else hi = m; }
    else while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < p) lo = m + 1; else hi = m; }
    return lo;
  }
  // size 0 removes the level; otherwise insert or overwrite
  set(p, q) {
    const i = this.search(p), hit = i < this.px.length && this.px[i] === p;
    if (q === 0) { if (hit) { this.px.splice(i, 1); this.qty.splice(i, 1); } return; }
    if (hit) this.qty[i] = q;
    else { this.px.splice(i, 0, p); this.qty.splice(i, 0, q); }
  }
  get(p) { const i = this.search(p); return i < this.px.length && this.px[i] === p ? this.qty[i] : 0; }
  truncate(depth) { if (this.px.length > depth) { this.px.length = depth; this.qty.length = depth; } }
  top(n = this.px.length) {
    const k = Math.min(n, this.px.length), out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = [this.px[i], this.qty[i]];
    return out;
  }
  // worst price still held (the far end of the subscribed depth)
  edge() { return this.px.length ? this.px[this.px.length - 1] : NaN; }
}

// ---------------------------------------------------------------- order book
export class OrderBook {
  constructor({ depth = 100, pricePrec = NaN, qtyPrec = NaN } = {}) {
    this.depth = depth; this.pricePrec = pricePrec; this.qtyPrec = qtyPrec;
    this.bids = new BookSide('bid'); this.asks = new BookSide('ask');
  }
  clear() { this.bids.clear(); this.asks.clear(); }
  applyLevels(side, levels) { if (levels) for (const l of levels) side.set(+l.price, +l.qty); }
  applySnapshot(d) {
    this.clear();
    this.applyLevels(this.bids, d.bids); this.applyLevels(this.asks, d.asks);
    this.bids.truncate(this.depth); this.asks.truncate(this.depth);
  }
  // Apply every level in the message, then cut each side back to the
  // subscribed depth: the exchange stops sending updates for levels that fall
  // off the end, so keeping them would leave stale sizes in the book.
  applyUpdate(d) {
    this.applyLevels(this.bids, d.bids); this.applyLevels(this.asks, d.asks);
    this.bids.truncate(this.depth); this.asks.truncate(this.depth);
  }
  checksumString() { return checksumString(this.asks.top(10), this.bids.top(10), this.pricePrec, this.qtyPrec); }
  checksum() { return crc32(this.checksumString()); }
  verify(expected) { return this.checksum() === (Number(expected) >>> 0); }
  // best bid and offer, or null while either side is empty
  bbo() {
    if (!this.bids.length || !this.asks.length) return null;
    return { pb: this.bids.px[0], qb: this.bids.qty[0], pa: this.asks.px[0], qa: this.asks.qty[0] };
  }
}

// ---------------------------------------------------------------- top of book
export const midOf = b => (b.pb + b.pa) / 2;
export const spreadOf = b => b.pa - b.pb;
export const spreadBps = b => (b.pa - b.pb) / midOf(b) * 1e4;
// size weighted toward the side with less resting size: a heavy bid pulls the
// microprice toward the ask
export const microprice = b => (b.pb * b.qa + b.pa * b.qb) / (b.qa + b.qb);
export const imbalance = b => b.qb / (b.qb + b.qa);

// ---------------------------------------------------------------- order flow imbalance
// Cont, Kukanov and Stoikov (2014), one event between consecutive best quotes
// (prev is the earlier state):
//   e = 1{Pb >= Pb'} qb - 1{Pb <= Pb'} qb' - 1{Pa <= Pa'} qa + 1{Pa >= Pa'} qa'
// An unchanged quote contributes its size change; a bid that moves up adds its
// whole new size; an ask that moves down subtracts its whole new size.
export function ofiEvent(prev, cur) {
  let e = 0;
  if (cur.pb >= prev.pb) e += cur.qb;
  if (cur.pb <= prev.pb) e -= prev.qb;
  if (cur.pa <= prev.pa) e -= cur.qa;
  if (cur.pa >= prev.pa) e += prev.qa;
  return e;
}

// Per second bins of OFI and the last mid, keyed by whole exchange second.
// reset() breaks the chain after a snapshot, so no OFI event is computed
// across a resync and the second that contains it is excluded from fits.
export class FlowSeconds {
  constructor(keep = 900) { this.keep = keep; this.bins = new Map(); this.prev = null; this.first = NaN; this.last = NaN; }
  clear() { this.bins.clear(); this.prev = null; this.first = NaN; this.last = NaN; }
  reset() { this.prev = null; }
  add(tMs, bbo) {
    const s = Math.floor(tMs / 1000);
    let b = this.bins.get(s);
    if (!b) {
      b = { ofi: 0, n: 0, mid: NaN, gap: false };
      this.bins.set(s, b);
      if (this.bins.size > this.keep + 10) for (const k of this.bins.keys()) if (k < s - this.keep) this.bins.delete(k);
    }
    if (this.prev) b.ofi += ofiEvent(this.prev, bbo); else b.gap = true;
    b.n++; b.mid = midOf(bbo);
    this.prev = bbo;
    if (!(s <= this.last)) this.last = s;
    if (!isNum(this.first)) this.first = s;
  }
  // Rows for the n complete seconds before endSec (the newest second is still
  // filling, so it is left out). Seconds with no event carry the mid forward
  // with zero OFI. dmid is the change in mid over the second; a row is valid
  // when both ends are known and no snapshot reset fell inside it.
  rows(n, endSec = this.last) {
    const out = [];
    if (!isNum(endSec)) return out;
    // the mid in force before the window: the last bin at or before its start
    let prevMid = NaN;
    for (let s = endSec - n - 1; s >= endSec - n - 1 - this.keep && isNum(this.first) && s >= this.first; s--) {
      const b = this.bins.get(s);
      if (b && isNum(b.mid)) { prevMid = b.mid; break; }
    }
    for (let s = endSec - n - 1; s < endSec; s++) {
      const b = this.bins.get(s);
      const mid = b && isNum(b.mid) ? b.mid : prevMid;
      if (s >= endSec - n) out.push({ s, t: s * 1000, ofi: b ? b.ofi : 0, n: b ? b.n : 0, mid, dmid: mid - prevMid, valid: isNum(mid) && isNum(prevMid) && !(b && b.gap) });
      prevMid = mid;
    }
    return out;
  }
  // complete seconds observed so far
  span(endSec = this.last) { return isNum(this.first) ? Math.max(0, endSec - this.first) : 0; }
}

// OLS of the mid change on OFI over the valid rows: dmid = a + b ofi.
export function ofiRegression(rows) {
  const xs = [], ys = [];
  for (const r of rows) if (r.valid) { xs.push(r.ofi); ys.push(r.dmid); }
  return ols(xs, ys);
}

// ---------------------------------------------------------------- realized volatility
// mids: mid at the end of each second on a 1 s grid, oldest first. Sampling
// every `step` seconds walks back from the newest point, so both samplings
// end at the same instant. RV = sqrt(sum r^2) with r the log return.
export function realizedVol(mids, step = 1) {
  let ss = 0, n = 0;
  for (let i = mids.length - 1; i - step >= 0; i -= step) {
    const a = mids[i - step], b = mids[i];
    if (a > 0 && b > 0) { const r = Math.log(b / a); ss += r * r; n++; }
  }
  return { rv: Math.sqrt(ss), ss, n, windowSec: n * step };
}
export const YEAR_SECONDS = 365 * 86400;   // crypto trades every day of the year
export function annualize(rv, windowSec) { return windowSec > 0 ? rv * Math.sqrt(YEAR_SECONDS / windowSec) : NaN; }
// Relative standard error of an RV estimate from n returns, if returns are iid
// Gaussian: Var(RV^2) = 2 n sigma^4, so sd(RV)/RV is about 1/sqrt(2n).
export const rvRelSE = n => n > 0 ? 1 / Math.sqrt(2 * n) : NaN;

// ---------------------------------------------------------------- trades
// Log10 bins of trade notional in quote currency: [1, 10), [10, 100), ...
export const NOTIONAL_BINS = ['< $10', '$10', '$100', '$1k', '$10k', '$100k', '$1M+'];
export function notionalBin(usd) {
  if (!(usd > 0)) return 0;
  return Math.max(0, Math.min(NOTIONAL_BINS.length - 1, Math.floor(Math.log10(usd))));
}
export class TradeTally {
  constructor() { this.clear(); }
  clear() {
    this.n = 0; this.buyVol = 0; this.sellVol = 0; this.pq = 0; this.q = 0;
    this.bins = NOTIONAL_BINS.map(() => ({ buy: 0, sell: 0 }));
  }
  add(t) {
    const q = +t.qty, p = +t.price;
    if (!(q > 0) || !(p > 0)) return;
    this.n++; this.pq += p * q; this.q += q;
    if (t.side === 'buy') this.buyVol += q; else this.sellVol += q;
    this.bins[notionalBin(p * q)][t.side === 'buy' ? 'buy' : 'sell']++;
  }
  vwap() { return this.q > 0 ? this.pq / this.q : NaN; }
  buyShare() { const v = this.buyVol + this.sellVol; return v > 0 ? this.buyVol / v : NaN; }
}

// ---------------------------------------------------------------- timestamps
// RFC 3339 with up to nanosecond fractions, to fractional milliseconds. Written
// out by hand so microseconds survive and every engine parses it the same way.
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
export function parseTs(s) {
  const m = TS.exec(s);
  if (!m) return NaN;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return m[7] ? base + Number('0.' + m[7]) * 1000 : base;
}

// ---------------------------------------------------------------- session
// Protocol state for one Kraken v2 connection carrying book and trades for one
// symbol. The caller owns the socket and passes `send`; this class decides what
// to subscribe, keeps the book, verifies every checksum, and resyncs on a
// mismatch by unsubscribing and resubscribing the book channel.
export class BookSession {
  constructor({ symbol = 'BTC/USD', depth = 100, send, onBook, onTrade, onSnapshot, onError, onMismatch } = {}) {
    this.symbol = symbol; this.depth = depth; this.send = send || (() => {});
    this.onBook = onBook || (() => {}); this.onTrade = onTrade || (() => {});
    this.onSnapshot = onSnapshot || (() => {}); this.onError = onError || (() => {});
    this.onMismatch = onMismatch || (() => {});
    this.precision = new Map();   // symbol -> { pricePrec, qtyPrec, pair }
    this.book = new OrderBook({ depth });
    this.state = 'idle';          // idle, instrument, syncing, live
    this.stats = BookSession.blankStats();
  }
  static blankStats() {
    return { msgs: 0, bytes: 0, byType: {}, snapshots: 0, updates: 0, verified: 0, mismatched: 0, resyncs: 0, ignored: 0, trades: 0, errors: 0 };
  }
  resetStats() { this.stats = BookSession.blankStats(); }
  // call when the socket opens: precision first, then the data channels
  start() {
    this.state = 'instrument';
    this.send({ method: 'subscribe', params: { channel: 'instrument', snapshot: true } });
  }
  // call when the socket closes, so a stale book is never verified against
  closed() { this.state = 'idle'; this.book.clear(); }
  subscribeData() {
    const p = this.precision.get(this.symbol);
    if (!p) { this.onError('no precision for ' + this.symbol); return false; }
    this.book = new OrderBook({ depth: this.depth, pricePrec: p.pricePrec, qtyPrec: p.qtyPrec });
    this.state = 'syncing';
    this.send({ method: 'subscribe', params: { channel: 'book', symbol: [this.symbol], depth: this.depth } });
    this.send({ method: 'subscribe', params: { channel: 'trade', symbol: [this.symbol], snapshot: false } });
    return true;
  }
  // switch symbol on a live connection: drop the old subscriptions, start over
  setSymbol(sym) {
    const old = this.symbol;
    this.symbol = sym;
    if (this.state === 'idle' || this.state === 'instrument') return;
    this.send({ method: 'unsubscribe', params: { channel: 'book', symbol: [old], depth: this.depth } });
    this.send({ method: 'unsubscribe', params: { channel: 'trade', symbol: [old] } });
    this.subscribeData();
  }
  resync() {
    this.stats.resyncs++;
    this.state = 'syncing';
    this.send({ method: 'unsubscribe', params: { channel: 'book', symbol: [this.symbol], depth: this.depth } });
    this.send({ method: 'subscribe', params: { channel: 'book', symbol: [this.symbol], depth: this.depth } });
  }
  count(k) { this.stats.byType[k] = (this.stats.byType[k] || 0) + 1; }
  handle(m, arrivalMs = Date.now(), bytes = 0) {
    const st = this.stats;
    st.msgs++; st.bytes += bytes;
    if (m.method) {
      this.count('ack');
      if (m.success === false) { st.errors++; this.onError(String(m.error || 'request failed')); }
      return;
    }
    const ch = m.channel;
    if (ch === 'heartbeat' || ch === 'status') { this.count(ch); return; }
    if (ch === 'instrument') {
      this.count('instrument');
      if (m.type !== 'snapshot' || this.state !== 'instrument') return;
      for (const p of (m.data && m.data.pairs) || []) {
        if (isNum(p.price_precision) && isNum(p.qty_precision)) this.precision.set(p.symbol, { pricePrec: p.price_precision, qtyPrec: p.qty_precision, pair: p });
      }
      this.send({ method: 'unsubscribe', params: { channel: 'instrument' } });
      this.subscribeData();
      return;
    }
    if (ch === 'book') {
      const d = m.data && m.data[0];
      if (!d || d.symbol !== this.symbol) { st.ignored++; return; }
      if (m.type === 'snapshot') {
        this.count('snapshot'); st.snapshots++;
        this.book.applySnapshot(d);
        if (!this.book.verify(d.checksum)) { st.mismatched++; this.onMismatch(d, 'snapshot'); this.resync(); return; }
        st.verified++;
        this.state = 'live';
        this.onSnapshot(this.book, parseTs(d.timestamp), arrivalMs);
        return;
      }
      this.count('update');
      if (this.state !== 'live') { st.ignored++; return; }
      st.updates++;
      this.book.applyUpdate(d);
      if (!this.book.verify(d.checksum)) { st.mismatched++; this.onMismatch(d, 'update'); this.resync(); return; }
      st.verified++;
      this.onBook(this.book, parseTs(d.timestamp), arrivalMs);
      return;
    }
    if (ch === 'trade') {
      this.count('trade');
      for (const t of m.data || []) {
        if (t.symbol !== this.symbol) { st.ignored++; continue; }
        st.trades++;
        this.onTrade(t, parseTs(t.timestamp), arrivalMs);
      }
      return;
    }
    this.count(ch || 'other');
  }
}
