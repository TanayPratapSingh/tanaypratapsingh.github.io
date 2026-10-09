// Streaming sketches for the Wikipedia edit stream dashboard. Pure logic, no
// DOM: the node suite in live/tests/wiki.test.mjs imports this file directly.
//
// Every sketch here runs in the page beside an exact counter, so the error it
// reports can be checked against the bound below rather than assumed.
import { EWMA } from '../assets/util.js';

// ------------------------------------------------------------------ hashing
const enc = new TextEncoder();
export const toBytes = x => (x instanceof Uint8Array ? x : enc.encode(String(x)));

// MurmurHash3, x86 32 bit variant (Appleby). Strings are hashed as UTF-8.
// Returns an unsigned 32 bit integer.
export function murmur3_32(key, seed = 0) {
  const b = toBytes(key), n = b.length, nb = n >>> 2;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  let h = seed >>> 0, k;
  for (let i = 0; i < nb; i++) {
    const j = i << 2;
    k = b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const t = nb << 2;
  k = 0;
  switch (n & 3) {
    case 3: k ^= b[t + 2] << 16; // falls through
    case 2: k ^= b[t + 1] << 8;  // falls through
    case 1: k ^= b[t];
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= n;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// A 53 bit key from two seeded hashes, used by the exact sets so that a user
// name is never stored. Collision chance for n keys is about n^2 / 2^54.
export function hash53(key) {
  const b = toBytes(key);
  return (murmur3_32(b, 0x5bd1e995) >>> 11) * 4294967296 + murmur3_32(b, 0x27d4eb2f);
}

// ------------------------------------------------------------------ HyperLogLog
// Flajolet, Fusy, Gandouet, Meunier (2007), with the small and large range
// corrections from that paper. m = 2^p one byte registers.
export class HyperLogLog {
  constructor(p = 12, seed = 0) {
    if (p < 4 || p > 16) throw new RangeError('p must be in [4, 16]');
    this.p = p; this.m = 1 << p; this.seed = seed;
    this.M = new Uint8Array(this.m);
    this.alpha = 0.7213 / (1 + 1.079 / this.m);
  }
  get bytes() { return this.m; }
  get stdError() { return 1.04 / Math.sqrt(this.m); }
  // rank of the bits left after the index: leading zeros plus one, capped at 32 - p + 1
  addHash(x) {
    const p = this.p, j = x >>> (32 - p), w = (x << p) >>> 0;
    const r = w === 0 ? 32 - p + 1 : Math.clz32(w) + 1;
    if (r > this.M[j]) { this.M[j] = r; return true; }
    return false;
  }
  add(key) { return this.addHash(murmur3_32(key, this.seed)); }
  // returns the estimate and which regime produced it
  detail() {
    const m = this.m, M = this.M;
    let sum = 0, V = 0;
    for (let j = 0; j < m; j++) { sum += 2 ** -M[j]; if (M[j] === 0) V++; }
    const raw = this.alpha * m * m / sum;
    let E = raw, regime = 'raw';
    if (raw <= 2.5 * m && V > 0) { E = m * Math.log(m / V); regime = 'linear'; }
    else if (raw > 4294967296 / 30) { E = -4294967296 * Math.log(1 - raw / 4294967296); regime = 'large'; }
    return { estimate: E, raw, zeros: V, regime };
  }
  estimate() { return this.detail().estimate; }
  clear() { this.M.fill(0); }
}

// ------------------------------------------------------------------ Count-Min
// Cormode and Muthukrishnan (2005), standard update (every row is incremented),
// so the textbook bound applies: est >= true always, and est <= true + eps N
// with probability at least 1 - delta, where eps = e / width, delta = e^-depth.
// The proof assumes pairwise independent row hashes; seeded MurmurHash3 is not
// provably that, which is one more reason the page measures the error.
export class CountMinSketch {
  constructor(width = 1024, depth = 4, seed = 0x9747b28c) {
    this.width = width; this.depth = depth; this.N = 0;
    this.seeds = Array.from({ length: depth }, (_, i) => (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    this.t = new Float64Array(width * depth);
  }
  get eps() { return Math.E / this.width; }
  get delta() { return Math.exp(-this.depth); }
  get bytes() { return this.t.byteLength; }
  cols(key) { const b = toBytes(key); return this.seeds.map((s, i) => i * this.width + murmur3_32(b, s) % this.width); }
  add(key, w = 1) {
    if (!(w >= 0)) throw new RangeError('weights must be non negative');
    for (const c of this.cols(key)) this.t[c] += w;
    this.N += w;
  }
  estimate(key) { let e = Infinity; for (const c of this.cols(key)) e = Math.min(e, this.t[c]); return e; }
  bound() { return this.eps * this.N; }
}

// ------------------------------------------------------------------ Space-Saving
// Metwally, Agrawal, El Abbadi (2005). k counters {item, count, error}. A hit
// increments its counter; a miss replaces the minimum counter, taking count =
// min + w and error = min. Guarantees, for every tracked item:
//   count - error <= true frequency <= count
// and the minimum counter is at most N / k, so any item whose true frequency
// exceeds N / k is tracked. The counters live in an indexed binary min heap.
export class SpaceSaving {
  constructor(k = 200) { this.k = k; this.heap = []; this.pos = new Map(); this.N = 0; }
  get size() { return this.heap.length; }
  get threshold() { return this.N / this.k; }
  has(item) { return this.pos.has(item); }
  get(item) { const i = this.pos.get(item); return i === undefined ? undefined : this.heap[i]; }
  minCount() { return this.heap.length < this.k ? 0 : this.heap[0].count; }
  add(item, w = 1) {
    this.N += w;
    const i = this.pos.get(item);
    if (i !== undefined) { this.heap[i].count += w; this.down(i); return this.heap[this.pos.get(item)]; }
    if (this.heap.length < this.k) {
      const c = { item, count: w, error: 0 };
      this.heap.push(c); this.pos.set(item, this.heap.length - 1); this.up(this.heap.length - 1);
      return c;
    }
    const root = this.heap[0];
    this.pos.delete(root.item);
    const c = { item, count: root.count + w, error: root.count };
    this.heap[0] = c; this.pos.set(item, 0); this.down(0);
    return c;
  }
  // tracked counters, highest count first
  top(n = this.k) { return this.heap.slice().sort((a, b) => b.count - a.count || a.error - b.error).slice(0, n); }
  swap(i, j) { const h = this.heap; [h[i], h[j]] = [h[j], h[i]]; this.pos.set(h[i].item, i); this.pos.set(h[j].item, j); }
  up(i) { const h = this.heap; while (i > 0) { const p = (i - 1) >> 1; if (h[p].count <= h[i].count) break; this.swap(i, p); i = p; } }
  down(i) {
    const h = this.heap, n = h.length;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let s = i;
      if (l < n && h[l].count < h[s].count) s = l;
      if (r < n && h[r].count < h[s].count) s = r;
      if (s === i) return;
      this.swap(i, s); i = s;
    }
  }
}

// ------------------------------------------------------------------ dedupe
// Bounded set of recently seen ids: a ring of `cap` ids plus a Set for lookup.
// add() returns false when the id was already present.
export class RecentIds {
  constructor(cap = 5000) { this.cap = cap; this.ring = new Array(cap); this.i = 0; this.set = new Set(); }
  get size() { return this.set.size; }
  has(id) { return this.set.has(id); }
  add(id) {
    if (this.set.has(id)) return false;
    const old = this.ring[this.i];
    if (old !== undefined) this.set.delete(old);
    this.ring[this.i] = id; this.i = (this.i + 1) % this.cap; this.set.add(id);
    return true;
  }
}

// ------------------------------------------------------------------ bursts
// Flag a completed second when its count is far above an exponentially
// weighted baseline of earlier seconds: x > mean + k std and x >= mean + minExcess.
// The baseline is the state before the second is added; flagged seconds still
// update it. Nothing is flagged until `warmup` seconds have been seen.
export class BurstDetector {
  constructor({ halfLife = 60, k = 4, minExcess = 10, warmup = 30 } = {}) {
    this.ew = new EWMA(halfLife); this.k = k; this.minExcess = minExcess; this.warmup = warmup; this.n = 0;
  }
  get ready() { return this.n >= this.warmup; }
  push(x, tSec) {
    const mean = this.ew.mean, std = this.ew.std, ready = this.ready;
    const flag = ready && x > mean + this.k * std && x >= mean + this.minExcess;
    this.ew.update(x, tSec); this.n++;
    return { flag, mean, std, ready };
  }
}

// ------------------------------------------------------------------ edit size bins
// Signed order of magnitude bins of the byte delta. Each label is the bin's edge
// nearest zero: +100 holds +100 to +999 bytes, +10k holds +10,000 and above.
export const SIZE_BINS = [
  { label: '−10k', tip: '−10,000 bytes or more removed' },
  { label: '−1k', tip: '−1,000 to −9,999 bytes' },
  { label: '−100', tip: '−100 to −999 bytes' },
  { label: '−10', tip: '−10 to −99 bytes' },
  { label: '−1', tip: '−1 to −9 bytes' },
  { label: '0', tip: 'no change in size' },
  { label: '+1', tip: '+1 to +9 bytes' },
  { label: '+10', tip: '+10 to +99 bytes' },
  { label: '+100', tip: '+100 to +999 bytes' },
  { label: '+1k', tip: '+1,000 to +9,999 bytes' },
  { label: '+10k', tip: '+10,000 bytes or more added' },
];
export function sizeBin(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return -1;
  if (d === 0) return 5;
  const a = Math.abs(d);
  const m = a < 10 ? 0 : a < 100 ? 1 : a < 1000 ? 2 : a < 10000 ? 3 : 4;
  return d > 0 ? 6 + m : 4 - m;
}

// ------------------------------------------------------------------ scopes
export const SCOPES = [
  { id: 'all', label: 'All projects', test: () => true },
  { id: 'wikipedia', label: 'Wikipedia', test: e => typeof e.server_name === 'string' && e.server_name.endsWith('wikipedia.org') },
  { id: 'wikidata', label: 'Wikidata', test: e => e.wiki === 'wikidatawiki' },
  { id: 'commons', label: 'Commons', test: e => e.wiki === 'commonswiki' },
  { id: 'enwiki', label: 'English Wikipedia', test: e => e.wiki === 'enwiki' },
];

// Wikimedia publishes synthetic canary events for its own monitoring; they are
// not edits and are discarded before anything is counted.
export const isCanary = e => !!(e && e.meta && e.meta.domain === 'canary');

// Expected share of keys whose Count-Min estimate is inflated at all, assuming
// uniform hashing: a key escapes collision in a row with chance (1 - 1/w)^(K - 1),
// and it is inflated only if it collides in every one of the d rows.
export function cmsCollisionShare(K, width, depth) {
  if (K <= 1) return 0;
  return (1 - (1 - 1 / width) ** (K - 1)) ** depth;
}

// ------------------------------------------------------------------ edit river helpers
// Dot radius for a byte change: area grows with 1 + 1.5 log10(1 + |bytes|), so a
// 10,000 byte edit has about 7 times the area of a zero byte one.
export function dotRadius(delta, base = 2) {
  const a = typeof delta === 'number' && Number.isFinite(delta) ? Math.abs(delta) : 0;
  return base * Math.sqrt(1 + 1.5 * Math.log10(1 + a));
}

// The n busiest keys, in order, with hysteresis so the order does not flap: a key
// takes a place, or passes the key above it, only when its count exceeds that
// key's count by `margin` (a share) plus `slack`. `prev` is the last order.
export function rankLanes(prev, counts, n, margin = 0.1, slack = 1) {
  const c = k => counts.get(k) || 0;
  const beats = (a, b) => c(a) > c(b) * (1 + margin) + slack;
  let order = prev.filter(k => counts.has(k)).slice(0, n);
  const sorted = [...counts.keys()].sort((a, b) => c(b) - c(a));
  for (const k of sorted) {
    if (order.includes(k)) continue;
    if (order.length < n) { order.push(k); continue; }
    let weak = 0;
    for (let i = 1; i < order.length; i++) if (c(order[i]) < c(order[weak])) weak = i;
    if (beats(k, order[weak])) order[weak] = k; else break;
  }
  // adjacent swaps under the same rule until nothing moves
  for (let pass = 0, moved = true; moved && pass < n * n; pass++) {
    moved = false;
    for (let i = 1; i < order.length; i++) if (beats(order[i], order[i - 1])) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; moved = true; }
  }
  return order;
}

// Short display name for a wiki from its server name: en.wikipedia.org -> en.wikipedia
export function wikiLabel(serverName, fallback) {
  if (typeof serverName !== 'string' || !serverName) return fallback;
  return serverName.replace(/\.org$/, '').replace(/^www\./, '');
}
