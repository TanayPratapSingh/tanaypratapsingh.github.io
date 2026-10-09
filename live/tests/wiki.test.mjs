// Tests for live/wiki/sketch.js. Run: node --test live/tests/wiki.test.mjs
// Every stream below is generated from util.rng, so a failure reproduces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from '../assets/util.js';
import {
  murmur3_32, hash53, HyperLogLog, CountMinSketch, SpaceSaving, RecentIds,
  BurstDetector, sizeBin, SIZE_BINS, SCOPES, isCanary, cmsCollisionShare,
  dotRadius, rankLanes, wikiLabel,
} from '../wiki/sketch.js';

// Zipf(s) sampler over ranks 1..n by inverse CDF.
function zipf(n, s, rand) {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += 1 / Math.pow(i + 1, s); cdf[i] = acc; }
  for (let i = 0; i < n; i++) cdf[i] /= acc;
  return () => {
    const u = rand();
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
    return lo;
  };
}
function zipfStream(N, n, s, seed) {
  const draw = zipf(n, s, rng(seed)), keys = new Array(N), exact = new Map();
  for (let i = 0; i < N; i++) { const k = 'page/' + draw(); keys[i] = k; exact.set(k, (exact.get(k) || 0) + 1); }
  return { keys, exact };
}

// ------------------------------------------------------------------ murmur3
test('murmur3_32 matches the published x86 32 bit test vectors', () => {
  assert.equal(murmur3_32('', 0), 0);
  assert.equal(murmur3_32('', 1), 0x514E28B7);
  assert.equal(murmur3_32('hello', 0), 0x248BFA47);
  assert.equal(murmur3_32('The quick brown fox jumps over the lazy dog', 0), 0x2E4FF723);
});

test('murmur3_32 passes the SMHasher verification value 0xB0F57EE3', () => {
  // SMHasher VerificationTest: hash keys {0}, {0,1}, ... of length 0..255 with
  // seed 256 - len, concatenate the 32 bit results little endian, hash with seed 0.
  const key = new Uint8Array(256), out = new Uint8Array(1024), dv = new DataView(out.buffer);
  for (let i = 0; i < 256; i++) { key[i] = i; dv.setUint32(i * 4, murmur3_32(key.subarray(0, i), 256 - i), true); }
  assert.equal(murmur3_32(out, 0), 0xB0F57EE3);
});

test('murmur3_32 hashes strings as UTF-8 and returns unsigned 32 bit values', () => {
  const s = 'Zoë Ångström 東京';
  assert.equal(murmur3_32(s, 7), murmur3_32(new TextEncoder().encode(s), 7));
  const r = rng(3);
  for (let i = 0; i < 1000; i++) {
    const h = murmur3_32('k' + r(), i);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xFFFFFFFF);
  }
});

test('hash53 is a stable 53 bit integer', () => {
  const a = hash53('Example user'), b = hash53('Example user'), c = hash53('Example user 2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(Number.isSafeInteger(a) && a >= 0);
});

// ------------------------------------------------------------------ HyperLogLog
test('HyperLogLog p = 12 has 4,096 one byte registers and SE 1.04 / 64', () => {
  const h = new HyperLogLog(12);
  assert.equal(h.m, 4096);
  assert.equal(h.bytes, 4096);
  assert.ok(h.M instanceof Uint8Array);
  assert.ok(Math.abs(h.stdError - 0.01625) < 1e-12);
  assert.equal(h.estimate(), 0);
});

test('HyperLogLog rank uses the bits below the index, capped at 32 - p + 1', () => {
  const h = new HyperLogLog(12);
  h.addHash(0xFFF00000);           // index 4095, remaining bits all zero
  assert.equal(h.M[4095], 21);
  h.addHash(0x00080000);           // index 0, remaining bits 1000 0000 0000 0000 0000
  assert.equal(h.M[0], 1);
  h.addHash(0x00100001);           // index 1, remaining bits have 19 leading zeros
  assert.equal(h.M[1], 20);
});

test('HyperLogLog ignores repeats', () => {
  const h = new HyperLogLog(12);
  for (let i = 0; i < 500; i++) h.add('u' + i);
  const e = h.estimate();
  for (let r = 0; r < 5; r++) for (let i = 0; i < 500; i++) h.add('u' + i);
  assert.equal(h.estimate(), e);
});

test('HyperLogLog on 100,000 distinct keys is within 3 standard errors', () => {
  const h = new HyperLogLog(12), r = rng(42), n = 100000;
  for (let i = 0; i < n; i++) h.add('user:' + i + ':' + Math.floor(r() * 1e9));
  const d = h.detail(), rel = (d.estimate - n) / n;
  assert.equal(d.regime, 'raw');
  assert.ok(Math.abs(rel) <= 3 * h.stdError, `relative error ${(rel * 100).toFixed(2)}% exceeds ${(300 * h.stdError).toFixed(2)}%`);
});

test('HyperLogLog on 100 distinct keys uses linear counting and is within 3', () => {
  const h = new HyperLogLog(12), r = rng(7), n = 100;
  for (let i = 0; i < n; i++) h.add('editor-' + i + '-' + Math.floor(r() * 1e9));
  const d = h.detail();
  assert.equal(d.regime, 'linear');
  assert.ok(Math.abs(d.estimate - n) <= 3, `estimate ${d.estimate.toFixed(2)} for ${n} keys`);
});

// ------------------------------------------------------------------ Count-Min
test('Count-Min parameters: eps = e / width, delta = e^-depth', () => {
  const c = new CountMinSketch(1024, 4);
  assert.ok(Math.abs(c.eps - Math.E / 1024) < 1e-15);
  assert.ok(Math.abs(c.delta - Math.exp(-4)) < 1e-15);
  assert.equal(new Set(c.seeds).size, 4);
  c.add('a', 3); c.add('b');
  assert.equal(c.N, 4);
  assert.throws(() => c.add('a', -1));
});

test('Count-Min never underestimates, and the share over eps N is below delta (Zipf stream)', () => {
  const c = new CountMinSketch(1024, 4);
  const { keys, exact } = zipfStream(200000, 50000, 1.1, 11);
  for (const k of keys) c.add(k);
  assert.equal(c.N, 200000);
  const bound = c.eps * c.N;
  let under = 0, over = 0;
  for (const [k, f] of exact) {
    const e = c.estimate(k);
    if (e < f) under++;
    if (e - f > bound) over++;
  }
  assert.equal(under, 0);
  const share = over / exact.size;
  assert.ok(share < c.delta, `share over bound ${share} is not below delta ${c.delta}`);
});

test('cmsCollisionShare matches its closed form at the edges', () => {
  assert.equal(cmsCollisionShare(1, 1024, 4), 0);
  const K = 500, p = 1 - (1 - 1 / 1024) ** (K - 1);
  assert.ok(Math.abs(cmsCollisionShare(K, 1024, 4) - p ** 4) < 1e-15);
});

// ------------------------------------------------------------------ Space-Saving
test('Space-Saving keeps k counters whose counts sum to N', () => {
  const s = new SpaceSaving(200), { keys } = zipfStream(50000, 20000, 1.0, 5);
  for (const k of keys) s.add(k);
  assert.equal(s.size, 200);
  let sum = 0; for (const c of s.heap) sum += c.count;
  assert.equal(sum, s.N);
  assert.ok(s.minCount() <= s.N / s.k);
  const t = s.top(15);
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].count >= t[i].count);
});

test('Space-Saving bounds hold for every tracked item and every item above N / k is present (Zipf stream)', () => {
  const s = new SpaceSaving(200), { keys, exact } = zipfStream(200000, 50000, 1.1, 23);
  for (const k of keys) s.add(k);
  let bad = 0;
  for (const c of s.heap) {
    const f = exact.get(c.item) || 0;
    if (!(c.count - c.error <= f && f <= c.count)) bad++;
  }
  assert.equal(bad, 0);
  const thr = s.N / s.k;
  let heavy = 0, missing = 0;
  for (const [k, f] of exact) if (f > thr) { heavy++; if (!s.has(k)) missing++; }
  assert.ok(heavy > 0, 'the stream should contain items above N / k');
  assert.equal(missing, 0);
});

test('Space-Saving bounds also hold on a stream of mostly distinct items', () => {
  const s = new SpaceSaving(50), r = rng(99), exact = new Map();
  for (let i = 0; i < 20000; i++) {
    const k = r() < 0.2 ? 'hot' + Math.floor(r() * 5) : 'cold' + i;
    exact.set(k, (exact.get(k) || 0) + 1); s.add(k);
  }
  for (const c of s.heap) { const f = exact.get(c.item) || 0; assert.ok(c.count - c.error <= f && f <= c.count); }
  for (const [k, f] of exact) if (f > s.N / s.k) assert.ok(s.has(k), k + ' missing');
});

// ------------------------------------------------------------------ dedupe
test('RecentIds drops repeats and forgets ids older than its capacity', () => {
  const r = new RecentIds(3);
  assert.equal(r.add('a'), true);
  assert.equal(r.add('a'), false);
  r.add('b'); r.add('c'); r.add('d');      // 'a' falls out
  assert.equal(r.size, 3);
  assert.equal(r.has('a'), false);
  assert.equal(r.add('a'), true);
  assert.equal(r.add('c'), false);
});

// ------------------------------------------------------------------ bursts
test('BurstDetector waits for warm up, ignores ordinary noise, flags a spike', () => {
  const b = new BurstDetector({ halfLife: 60, k: 4, minExcess: 10, warmup: 30 }), r = rng(4);
  let flags = 0;
  // roughly 25 per second with noise, never far from the mean
  for (let s = 0; s < 120; s++) { const x = 20 + Math.floor(r() * 11); if (b.push(x, s).flag) flags++; }
  assert.equal(flags, 0);
  const res = b.push(90, 120);
  assert.equal(res.ready, true);
  assert.equal(res.flag, true);
  const early = new BurstDetector({ warmup: 30 });
  for (let s = 0; s < 10; s++) early.push(25, s);
  assert.equal(early.push(500, 10).flag, false, 'no flags before warm up');
});

test('BurstDetector needs both the sigma rule and the absolute excess', () => {
  const b = new BurstDetector({ halfLife: 60, k: 4, minExcess: 10, warmup: 5 });
  for (let s = 0; s < 50; s++) b.push(2, s);        // zero variance baseline at 2
  assert.equal(b.push(8, 50).flag, false);           // far in sigma, but only 6 above
  assert.equal(b.push(30, 51).flag, true);
});

// ------------------------------------------------------------------ bins and scopes
test('sizeBin puts byte deltas in signed order of magnitude bins', () => {
  const cases = [[-50000, 0], [-10000, 0], [-9999, 1], [-1000, 1], [-999, 2], [-100, 2], [-99, 3], [-10, 3],
    [-9, 4], [-1, 4], [0, 5], [1, 6], [9, 6], [10, 7], [99, 7], [100, 8], [999, 8], [1000, 9], [9999, 9], [10000, 10], [123456, 10]];
  for (const [d, bin] of cases) assert.equal(sizeBin(d), bin, 'delta ' + d);
  assert.equal(sizeBin(NaN), -1);
  assert.equal(sizeBin(undefined), -1);
  assert.equal(SIZE_BINS.length, 11);
});

test('scopes and canary filter', () => {
  const by = Object.fromEntries(SCOPES.map(s => [s.id, s.test]));
  const en = { wiki: 'enwiki', server_name: 'en.wikipedia.org' };
  const wd = { wiki: 'wikidatawiki', server_name: 'www.wikidata.org' };
  const cm = { wiki: 'commonswiki', server_name: 'commons.wikimedia.org' };
  assert.ok(by.all(wd) && by.wikipedia(en) && !by.wikipedia(wd) && by.wikidata(wd) && by.commons(cm) && by.enwiki(en) && !by.enwiki(cm));
  assert.ok(isCanary({ meta: { domain: 'canary' } }));
  assert.ok(!isCanary({ meta: { domain: 'en.wikipedia.org' } }));
});

// ------------------------------------------------------------------ edit river helpers
test('dotRadius: area grows with 1 + 1.5 log10(1 + |bytes|)', () => {
  assert.equal(dotRadius(0), 2);
  assert.equal(dotRadius(NaN), 2);
  assert.equal(dotRadius(-1000), dotRadius(1000));
  const area = d => dotRadius(d) ** 2;
  assert.ok(Math.abs(area(9999) / area(0) - (1 + 1.5 * 4)) < 1e-9);
  assert.ok(dotRadius(10) < dotRadius(100) && dotRadius(100) < dotRadius(1e5));
});

test('rankLanes picks the busiest keys and resists small fluctuations', () => {
  const m = o => new Map(Object.entries(o));
  assert.deepEqual(rankLanes([], m({ a: 5, b: 9, c: 1 }), 2), ['b', 'a']);
  // c is only slightly ahead of a: no change
  assert.deepEqual(rankLanes(['b', 'a'], m({ a: 50, b: 90, c: 52 }), 2), ['b', 'a']);
  // c is well ahead: it takes a's place, then passes b
  assert.deepEqual(rankLanes(['b', 'a'], m({ a: 50, b: 90, c: 200 }), 2), ['c', 'b']);
  // near equal neighbours keep their order, a clear lead swaps them
  assert.deepEqual(rankLanes(['a', 'b'], m({ a: 100, b: 105 }), 2), ['a', 'b']);
  assert.deepEqual(rankLanes(['a', 'b'], m({ a: 100, b: 130 }), 2), ['b', 'a']);
  // fewer keys than lanes
  assert.deepEqual(rankLanes([], m({ x: 1 }), 6), ['x']);
});

test('rankLanes converges to the true order on a growing Zipf stream', () => {
  const r = rng(8), draw = zipf(40, 1.2, r), counts = new Map();
  let order = [];
  for (let i = 0; i < 20000; i++) {
    const k = 'w' + draw(); counts.set(k, (counts.get(k) || 0) + 1);
    if (i % 100 === 0) order = rankLanes(order, counts, 6);
  }
  order = rankLanes(order, counts, 6);
  assert.deepEqual(order, ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
});

test('wikiLabel shortens server names', () => {
  assert.equal(wikiLabel('en.wikipedia.org', 'enwiki'), 'en.wikipedia');
  assert.equal(wikiLabel('www.wikidata.org', 'wikidatawiki'), 'wikidata');
  assert.equal(wikiLabel(undefined, 'enwiki'), 'enwiki');
});
