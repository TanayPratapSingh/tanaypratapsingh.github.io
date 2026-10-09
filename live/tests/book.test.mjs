// Tests for live/book/book.js. Run: node --test live/tests/book.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  crc32, checksumField, checksumString, BookSide, OrderBook, BookSession,
  midOf, spreadBps, microprice, imbalance, ofiEvent, FlowSeconds, ofiRegression,
  realizedVol, annualize, rvRelSE, YEAR_SECONDS, TradeTally, notionalBin, parseTs,
} from '../book/book.js';
import { rng } from '../assets/util.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kraken-book-btcusd.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- CRC32
test('crc32 matches the standard check value', () => {
  assert.equal(crc32('123456789'), 0xCBF43926);
  assert.equal(crc32(''), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  // non ASCII input is UTF-8 encoded, so string and bytes agree
  assert.equal(crc32('é'), crc32(new Uint8Array([0xC3, 0xA9])));
});

test('checksum fields: precision formatting, point removed, leading zeros stripped', () => {
  assert.equal(checksumField(81452.0, 1), '814520');
  assert.equal(checksumField(0.0157, 8), '1570000');
  assert.equal(checksumField(0.000051, 8), '5100');
  assert.equal(checksumField(3.06929585, 8), '306929585');
  assert.equal(checksumField(1e-8, 8), '1');
  assert.equal(checksumField(2450.05, 2), '245005');
  // only the top 10 of each side are used, asks first
  const asks = Array.from({ length: 12 }, (_, i) => [100.5 + i, 1]);
  const bids = Array.from({ length: 12 }, (_, i) => [100 - i, 2]);
  const s = checksumString(asks, bids, 1, 0);
  assert.ok(s.startsWith('10051'));
  assert.ok(s.endsWith('9102'));                  // bid 91.0 prints as 910, size 2 as 2
  assert.equal(s.length, 10 * 5 + 5 + 9 * 4);     // asks 1005..1095 plus 1; bids 1000 plus 2, then 990..910 plus 2
});

// ---------------------------------------------------------------- captured fixture
test('fixture: snapshot plus every captured update matches the exchange checksum', () => {
  assert.equal(fixture.symbol, 'BTC/USD');
  assert.ok(Number.isInteger(fixture.price_precision) && Number.isInteger(fixture.qty_precision));
  const book = new OrderBook({ depth: fixture.depth, pricePrec: fixture.price_precision, qtyPrec: fixture.qty_precision });
  const [snap, ...updates] = fixture.messages;
  assert.equal(snap.type, 'snapshot');
  assert.ok(updates.length >= 300, 'at least 300 updates in the fixture');
  book.applySnapshot(snap.data[0]);
  assert.equal(book.bids.length, fixture.depth);
  assert.equal(book.asks.length, fixture.depth);
  assert.ok(book.verify(snap.data[0].checksum), 'snapshot checksum');
  let ok = 0;
  const bad = [];
  for (const m of updates) {
    assert.equal(m.type, 'update');
    book.applyUpdate(m.data[0]);
    if (book.verify(m.data[0].checksum)) ok++; else bad.push(m.data[0].timestamp);
    assert.ok(book.bids.length <= fixture.depth && book.asks.length <= fixture.depth);
  }
  assert.deepEqual(bad, []);
  assert.equal(ok, updates.length);
  // the book never crosses
  const b = book.bbo();
  assert.ok(b.pb < b.pa);
});

test('fixture: a one unit size error or the wrong precision breaks the checksum', () => {
  const d = fixture.messages[0].data[0];
  const good = new OrderBook({ depth: 100, pricePrec: fixture.price_precision, qtyPrec: fixture.qty_precision });
  good.applySnapshot(d);
  good.bids.qty[3] += Math.pow(10, -fixture.qty_precision);
  assert.equal(good.verify(d.checksum), false);
  const wrong = new OrderBook({ depth: 100, pricePrec: fixture.price_precision + 1, qtyPrec: fixture.qty_precision });
  wrong.applySnapshot(d);
  assert.equal(wrong.verify(d.checksum), false);
});

test('fixture: without truncation, stale levels pile up past the subscribed depth', () => {
  // The exchange stops updating a level once it falls past the subscribed
  // depth. A book that never truncates keeps those levels with stale sizes.
  // The checksum only covers the top 10, so it cannot catch this: truncation
  // has to be right on its own, and it matters for the depth chart.
  const deep = new OrderBook({ depth: Infinity, pricePrec: fixture.price_precision, qtyPrec: fixture.qty_precision });
  const trunc = new OrderBook({ depth: fixture.depth, pricePrec: fixture.price_precision, qtyPrec: fixture.qty_precision });
  let deepOk = 0;
  for (const m of fixture.messages) {
    const fn = m.type === 'snapshot' ? 'applySnapshot' : 'applyUpdate';
    deep[fn](m.data[0]); trunc[fn](m.data[0]);
    if (deep.verify(m.data[0].checksum)) deepOk++;
  }
  assert.ok(deep.bids.length > fixture.depth || deep.asks.length > fixture.depth);
  assert.equal(trunc.bids.length, fixture.depth);
  assert.equal(trunc.asks.length, fixture.depth);
  assert.equal(deepOk, fixture.messages.length);
});

// ---------------------------------------------------------------- session
test('session: replays the fixture, then resyncs on a corrupted update', () => {
  const sent = [];
  let books = 0, snaps = 0, mism = 0;
  const s = new BookSession({ symbol: 'BTC/USD', depth: 100, send: o => sent.push(o), onBook: () => books++, onSnapshot: () => snaps++, onMismatch: () => mism++ });
  s.start();
  assert.equal(sent[0].params.channel, 'instrument');
  s.handle({ channel: 'instrument', type: 'snapshot', data: { pairs: [fixture.instrument] } });
  assert.equal(s.state, 'syncing');
  assert.deepEqual(sent.slice(1).map(o => o.method + ' ' + o.params.channel), ['unsubscribe instrument', 'subscribe book', 'subscribe trade']);
  assert.equal(sent[2].params.depth, 100);
  for (const m of fixture.messages) s.handle(m);
  assert.equal(s.state, 'live');
  assert.equal(snaps, 1);
  assert.equal(books, fixture.messages.length - 1);
  assert.equal(s.stats.verified, fixture.messages.length);
  assert.equal(s.stats.mismatched, 0);
  // an update whose checksum cannot match
  const last = fixture.messages[fixture.messages.length - 1];
  const bad = JSON.parse(JSON.stringify(last));
  bad.data[0].checksum = (bad.data[0].checksum + 1) >>> 0;
  sent.length = 0;
  s.handle(bad);
  assert.equal(mism, 1);
  assert.equal(s.stats.resyncs, 1);
  assert.equal(s.state, 'syncing');
  assert.deepEqual(sent.map(o => o.method + ' ' + o.params.channel), ['unsubscribe book', 'subscribe book']);
  // updates before the new snapshot are ignored, the snapshot restores live state
  s.handle(fixture.messages[1]);
  assert.equal(s.state, 'syncing');
  s.handle(fixture.messages[0]);
  assert.equal(s.state, 'live');
  // messages for another symbol are dropped
  const other = JSON.parse(JSON.stringify(fixture.messages[1]));
  other.data[0].symbol = 'ETH/USD';
  const before = s.stats.verified;
  s.handle(other);
  assert.equal(s.stats.verified, before);
});

// ---------------------------------------------------------------- book side
test('book side keeps best first order through inserts, updates and deletes', () => {
  const r = rng(7);
  const bids = new BookSide('bid'), asks = new BookSide('ask');
  for (let i = 0; i < 400; i++) {
    const p = Math.round(1000 + r() * 200) / 10, q = r() < 0.2 ? 0 : Math.round(r() * 1e4) / 1e4;
    bids.set(p, q); asks.set(p, q);
  }
  for (let i = 1; i < bids.length; i++) assert.ok(bids.px[i - 1] > bids.px[i]);
  for (let i = 1; i < asks.length; i++) assert.ok(asks.px[i - 1] < asks.px[i]);
  const p = bids.px[5];
  bids.set(p, 9.5); assert.equal(bids.get(p), 9.5);
  bids.set(p, 0); assert.equal(bids.get(p), 0);
  assert.ok(!bids.px.includes(p));
  bids.set(12345, 0);   // deleting a missing level is a no op
});

test('truncate keeps the best levels on each side', () => {
  const bids = new BookSide('bid'), asks = new BookSide('ask');
  for (let i = 0; i < 105; i++) { bids.set(100 - i, 1); asks.set(101 + i, 1); }
  bids.truncate(100); asks.truncate(100);
  assert.equal(bids.length, 100); assert.equal(asks.length, 100);
  assert.equal(bids.px[0], 100); assert.equal(bids.edge(), 1);
  assert.equal(asks.px[0], 101); assert.equal(asks.edge(), 200);
  // an update that inserts a better level pushes the worst one out
  const ob = new OrderBook({ depth: 3, pricePrec: 1, qtyPrec: 0 });
  ob.applySnapshot({ bids: [{ price: 10, qty: 1 }, { price: 9, qty: 1 }, { price: 8, qty: 1 }], asks: [{ price: 11, qty: 1 }] });
  ob.applyUpdate({ bids: [{ price: 10.5, qty: 2 }], asks: [] });
  assert.deepEqual(ob.bids.px, [10.5, 10, 9]);
});

// ---------------------------------------------------------------- top of book
test('microprice, imbalance and spread', () => {
  const b = { pb: 100, qb: 3, pa: 101, qa: 1 };
  assert.equal(midOf(b), 100.5);
  assert.equal(microprice(b), (100 * 1 + 101 * 3) / 4);   // 100.75: heavy bid pulls toward the ask
  assert.equal(imbalance(b), 0.75);
  assert.ok(Math.abs(spreadBps(b) - 1 / 100.5 * 1e4) < 1e-9);
  const eq = { pb: 100, qb: 2, pa: 101, qa: 2 };
  assert.equal(microprice(eq), midOf(eq));
  assert.equal(imbalance(eq), 0.5);
});

// ---------------------------------------------------------------- OFI
test('OFI events by hand (Cont, Kukanov and Stoikov 2014)', () => {
  const prev = { pb: 100, qb: 2, pa: 101, qa: 3 };
  // bid price up: the whole new bid size counts as buy pressure
  assert.equal(ofiEvent(prev, { pb: 100.5, qb: 1, pa: 101, qa: 3 }), 1);
  // bid price down: the whole old bid size counts against
  assert.equal(ofiEvent(prev, { pb: 99.5, qb: 4, pa: 101, qa: 3 }), -2);
  // ask price down: the whole new ask size counts as sell pressure
  assert.equal(ofiEvent(prev, { pb: 100, qb: 2, pa: 100.5, qa: 1 }), -1);
  // ask price up: the old ask size is removed, which is buy pressure
  assert.equal(ofiEvent(prev, { pb: 100, qb: 2, pa: 101.5, qa: 5 }), 3);
  // unchanged prices: only the size changes count, bid +3 and ask -2
  assert.equal(ofiEvent(prev, { pb: 100, qb: 5, pa: 101, qa: 1 }), 3 + 2);
  // no change
  assert.equal(ofiEvent(prev, { ...prev }), 0);
});

test('OFI per second bins, carry forward, and reset exclusion', () => {
  const f = new FlowSeconds();
  const t0 = 1_000_000_000;   // a whole second in ms
  f.add(t0 + 100, { pb: 100, qb: 2, pa: 101, qa: 3 });    // first event: no prior state, gap
  f.add(t0 + 1100, { pb: 100, qb: 5, pa: 101, qa: 3 });   // +3
  f.add(t0 + 1500, { pb: 100.5, qb: 1, pa: 101, qa: 3 }); // +1, mid 100.75
  f.add(t0 + 4200, { pb: 100.5, qb: 1, pa: 101, qa: 3 }); // newest second, still filling
  const rows = f.rows(3);
  assert.deepEqual(rows.map(r => r.s), [1_000_001, 1_000_002, 1_000_003]);
  assert.equal(rows[0].ofi, 4);
  assert.equal(rows[0].dmid, 100.75 - 100.5);
  assert.ok(rows[0].valid);
  assert.equal(rows[1].ofi, 0); assert.equal(rows[1].dmid, 0); assert.equal(rows[1].mid, 100.75);
  f.reset();
  f.add(t0 + 5300, { pb: 99, qb: 1, pa: 100, qa: 1 });
  f.add(t0 + 6000, { pb: 99, qb: 1, pa: 100, qa: 1 });
  const r2 = f.rows(2);
  assert.equal(r2[1].s, 1_000_005);
  assert.equal(r2[1].valid, false, 'the second with the reset is excluded');
  assert.equal(r2[0].valid, true);
});

test('OFI regression recovers a known linear impact', () => {
  const r = rng(3), rows = [];
  for (let i = 0; i < 300; i++) { const x = (r() - 0.5) * 10; rows.push({ ofi: x, dmid: 0.8 * x + (r() - 0.5) * 0.5, valid: true }); }
  rows.push({ ofi: 1000, dmid: -1000, valid: false });
  const fit = ofiRegression(rows);
  assert.equal(fit.n, 300);
  assert.ok(Math.abs(fit.b - 0.8) < 4 * fit.se);
  assert.ok(fit.r2 > 0.9);
});

// ---------------------------------------------------------------- realized volatility
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

test('realized volatility on a random walk with known variance, at 1 s and 10 s', () => {
  const r = rng(11), sigma = 2e-4, N = 3000;   // per second log return sd
  const mids = [50000];
  for (let i = 0; i < N; i++) mids.push(mids[i] * Math.exp(sigma * gauss(r)));
  const r1 = realizedVol(mids, 1), r10 = realizedVol(mids, 10);
  assert.equal(r1.n, N); assert.equal(r10.n, N / 10);
  assert.equal(r1.windowSec, N); assert.equal(r10.windowSec, N);
  const truth = sigma * Math.sqrt(N);
  assert.ok(Math.abs(r1.rv / truth - 1) < 4 * rvRelSE(r1.n), `1 s: ${r1.rv} vs ${truth}`);
  assert.ok(Math.abs(r10.rv / truth - 1) < 4 * rvRelSE(r10.n), `10 s: ${r10.rv} vs ${truth}`);
  // annualized: per second sd times sqrt(seconds in a year)
  const annTruth = sigma * Math.sqrt(YEAR_SECONDS);
  assert.ok(Math.abs(annualize(r1.rv, r1.windowSec) / annTruth - 1) < 4 * rvRelSE(r1.n));
  assert.equal(annualize(0.01, 300), 0.01 * Math.sqrt(365 * 86400 / 300));
});

test('measurement noise inflates fine sampling more than coarse sampling', () => {
  const r = rng(5), sigma = 1e-4, eta = 2e-4, N = 3000;
  let x = Math.log(30000);
  const mids = [];
  for (let i = 0; i <= N; i++) { mids.push(Math.exp(x + eta * gauss(r))); x += sigma * gauss(r); }
  const r1 = realizedVol(mids, 1), r10 = realizedVol(mids, 10);
  // E[RV^2] = n_steps * step * sigma^2 + 2 * n_returns * eta^2
  const e1 = N * sigma ** 2 + 2 * N * eta ** 2, e10 = N * sigma ** 2 + 2 * (N / 10) * eta ** 2;
  assert.ok(r1.rv > 1.5 * r10.rv);
  assert.ok(Math.abs(r1.ss / e1 - 1) < 0.15);
  assert.ok(Math.abs(r10.ss / e10 - 1) < 0.3);
});

// ---------------------------------------------------------------- trades and time
test('trade tally: VWAP, buy share, notional bins', () => {
  const t = new TradeTally();
  t.add({ side: 'buy', price: 100, qty: 1 });
  t.add({ side: 'sell', price: 110, qty: 3 });
  t.add({ side: 'buy', price: 0, qty: 3 });   // ignored
  assert.equal(t.n, 2);
  assert.equal(t.vwap(), (100 + 330) / 4);
  assert.equal(t.buyShare(), 0.25);
  assert.equal(t.bins[notionalBin(100)].buy, 1);
  assert.equal(t.bins[notionalBin(330)].sell, 1);
  assert.equal(notionalBin(5), 0); assert.equal(notionalBin(10), 1); assert.equal(notionalBin(99.9), 1);
  assert.equal(notionalBin(2e7), 6);
});

test('timestamps keep microseconds', () => {
  const t = parseTs('2026-10-08T18:58:43.200546Z');
  assert.equal(Math.floor(t), Date.UTC(2026, 9, 8, 18, 58, 43, 200));
  assert.ok(Math.abs(t - Math.floor(t) - 0.546) < 1e-3);   // a double near 1.8e12 resolves about 0.25 us
  assert.equal(parseTs('2026-10-08T18:58:43Z'), Date.UTC(2026, 9, 8, 18, 58, 43));
  assert.ok(Number.isNaN(parseTs('nope')));
});
