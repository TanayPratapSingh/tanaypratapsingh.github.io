// Tests for live/quakes/seismo.js. Run: node --test live/tests/quakes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from '../assets/util.js';
import {
  binIndex, maxc, completeness, akiUtsu, bootstrapB, gutenbergRichter, fmd,
  gkWindow, haversine, findSequence, omoriFit, omoriIntegral, logBinnedRate,
  createCatalog, mergeCatalog, describeChange, hourlyCounts, burstFlags,
  REGIONS, regionByKey, inRegion, analyze, HOUR, DAY, MIN,
} from '../quakes/seismo.js';

// Gutenberg-Richter magnitudes: exponential above mMin - dM/2, binned to 0.1.
function grCatalog(n, b, mMin, seed) {
  const r = rng(seed), beta = b * Math.LN10, out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((mMin - 0.05 + -Math.log(1 - r()) / beta) * 10) / 10);
  return out;
}

test('binIndex rounds to the nearest 0.1 bin and ignores float noise', () => {
  assert.equal(binIndex(1.24), 12);
  assert.equal(binIndex(1.25), 13);
  assert.equal(binIndex(2.0000000000000004), 20);
  assert.equal(binIndex(1.4999999999999998), 15);
  assert.equal(binIndex(-0.3), -3);
});

test('Aki-Utsu recovers b = 1 on a synthetic catalog (n = 5000) and the bootstrap interval covers 1', () => {
  const mags = grCatalog(5000, 1, 1.0, 1);
  const known = akiUtsu(mags, 1.0);
  assert.ok(Math.abs(known.b - 1) < 0.05, 'b at the true Mc = ' + known.b);
  assert.equal(known.n, 5000);
  const gr = gutenbergRichter(mags, { seed: 3 });
  assert.equal(gr.ok, true);
  assert.equal(gr.maxc, 1.0);
  assert.ok(Math.abs(gr.mc - 1.2) < 1e-9, 'Mc is MAXC + 0.2');
  assert.ok(Math.abs(gr.b - 1) < 0.05, 'b with MAXC + 0.2 = ' + gr.b);
  assert.equal(gr.boot.n + gr.boot.dropped, 200);
  assert.ok(gr.boot.lo <= 1 && gr.boot.hi >= 1, `bootstrap [${gr.boot.lo}, ${gr.boot.hi}]`);
  assert.ok(gr.boot.hi - gr.boot.lo < 0.2);
});

// A single seeded catalog can land outside its own 95% interval (seed 7 does,
// at 2.4 sigma), so coverage is also checked over several catalogs.
test('bootstrap 95% interval covers b = 1 in at least 16 of 20 synthetic catalogs', () => {
  let cover = 0;
  for (let s = 1; s <= 20; s++) {
    const gr = gutenbergRichter(grCatalog(5000, 1, 1.0, 1000 + s), { seed: s });
    if (gr.boot.lo <= 1 && gr.boot.hi >= 1) cover++;
  }
  assert.ok(cover >= 16, 'covered ' + cover + ' of 20');
});

test('Shi and Bolt sigma matches its formula and shrinks like 1 / sqrt(n)', () => {
  const mags = grCatalog(4000, 1, 2.0, 11);
  const f = akiUtsu(mags, 2.0);
  const above = mags.filter(m => m >= 2.0 - 1e-9), mean = above.reduce((s, x) => s + x, 0) / above.length;
  const ss = above.reduce((s, x) => s + (x - mean) ** 2, 0);
  const want = 2.30 * f.b ** 2 * Math.sqrt(ss / (above.length * (above.length - 1)));
  assert.ok(Math.abs(f.sigma - want) < 1e-12);
  assert.ok(Math.abs(f.sigma - f.b / Math.sqrt(f.n)) < 0.01, 'close to b / sqrt(n) for b near 1');
  assert.ok(Math.abs(f.a - (Math.log10(f.n) + f.b * 2.0)) < 1e-12, 'a = log10 N(>= Mc) + b Mc');
});

test('MAXC finds a known Mc +- 0.1 under tapered incompleteness, before the correction', () => {
  const r = rng(21), mags = [];
  const MC = 2.0;
  // complete above MC; below it the detection probability tapers smoothly to zero
  for (const m of grCatalog(40000, 1, 0.5, 5)) {
    const q = m >= MC ? 1 : Math.exp(-(((MC - m) / 0.15) ** 2));
    if (r() < q) mags.push(m);
  }
  const m = maxc(mags);
  assert.ok(Math.abs(m.mc - MC) <= 0.1 + 1e-9, 'MAXC ' + m.mc);
  const c = completeness(mags);
  assert.ok(Math.abs(c.mc - (m.mc + 0.2)) < 1e-9, 'correction is +0.2');
  assert.equal(c.correction, 0.2);
});

test('completeness and b-value refuse small catalogs with the count and threshold', () => {
  const few = grCatalog(30, 1, 1.0, 2);
  const g = gutenbergRichter(few);
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'few');
  assert.equal(g.n, 30);
  assert.equal(g.need, 50);
  const some = grCatalog(70, 1, 1.0, 2);
  const g2 = gutenbergRichter(some);
  assert.equal(g2.ok, false);
  assert.equal(g2.reason, 'fewAbove');
  assert.ok(g2.nAbove < 50 && g2.nAbove > 0);
});

test('fmd counts per bin and cumulative counts agree', () => {
  const h = fmd([1.0, 1.0, 1.1, 1.3, 1.34]);
  assert.deepEqual(h.map(b => b.count), [2, 1, 0, 2]);
  assert.deepEqual(h.map(b => b.k), [10, 11, 12, 13]);
  assert.deepEqual(h.map(b => b.cum), [5, 3, 2, 2]);
  const z = fmd([1.0, 1.3]);
  assert.deepEqual(z.map(b => b.count), [1, 0, 0, 1]);
  assert.deepEqual(z.map(b => b.cum), [2, 1, 1, 1]);
});

test('bootstrap is reproducible for a fixed seed', () => {
  const mags = grCatalog(800, 1, 1.0, 9);
  const a = bootstrapB(mags, { seed: 4 }), b = bootstrapB(mags, { seed: 4 });
  assert.deepEqual(a.values, b.values);
});

test('Gardner-Knopoff windows: M 5 is about 40 km; time switches branch at M 6.5', () => {
  const w5 = gkWindow(5);
  assert.ok(Math.abs(w5.km - 40) < 1, 'd(5) = ' + w5.km);
  assert.ok(Math.abs(w5.days - 143.7) < 0.5, 't(5) = ' + w5.days);
  assert.ok(Math.abs(gkWindow(6.5).days - 10 ** (0.032 * 6.5 + 2.7389)) < 1e-9);
  assert.ok(Math.abs(gkWindow(6.4).days - 10 ** (0.5409 * 6.4 - 0.547)) < 1e-9);
});

test('haversine: one degree of latitude is about 111.2 km', () => {
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111.19) < 0.05);
  assert.ok(Math.abs(haversine(10, 179.5, 10, -179.5) - 109.5) < 0.5, 'crosses the antimeridian');
});

// Inverse CDF draw of Omori-Utsu times over [0, T].
function omoriTimes(n, p, c, T, seed) {
  const r = rng(seed), a = c ** (1 - p), z = (T + c) ** (1 - p), out = [];
  for (let i = 0; i < n; i++) out.push((a - r() * (a - z)) ** (1 / (1 - p)) - c);
  return out;
}

test('Omori-Utsu MLE recovers p = 1.1 and c = 0.05 from synthetic times', () => {
  const T = 10, ts = omoriTimes(1000, 1.1, 0.05, T, 13);
  assert.ok(ts.every(t => t >= 0 && t <= T));
  const f = omoriFit(ts, T);
  assert.ok(Math.abs(f.p - 1.1) < 0.1, 'p = ' + f.p);
  assert.ok(f.c > 0.01 && f.c < 0.25, 'c = ' + f.c);
  assert.ok(f.pLo <= 1.1 && f.pHi >= 1.1, `profile range [${f.pLo}, ${f.pHi}]`);
  // K is profiled: the fitted rate integrates to n over [0, T]
  assert.ok(Math.abs(f.K * omoriIntegral(f.c, f.p, T) - f.n) < 1e-6);
  assert.equal(f.n, 1000);
});

test('Omori integral is continuous through p = 1', () => {
  const a = omoriIntegral(0.05, 1, 7), b = omoriIntegral(0.05, 1 + 1e-6, 7), c = omoriIntegral(0.05, 1 - 1e-6, 7);
  assert.ok(Math.abs(a - b) < 1e-4 && Math.abs(a - c) < 1e-4);
});

test('log binned rates conserve the event count', () => {
  const ts = omoriTimes(500, 1.1, 0.05, 7, 3);
  const bins = logBinnedRate(ts, 7);
  const k = bins.reduce((s, b) => s + b.k, 0);
  assert.equal(k, ts.filter(t => t > 0).length);
  for (const b of bins) assert.ok(Math.abs(b.rate * (b.t1 - b.t0) - b.k) < 1e-9);
});

test('findSequence picks the mainshock with the most aftershocks and skips foreshocks', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const ev = [];
  // M 5.5 at (35, -118) with 40 aftershocks within 10 km
  ev.push({ id: 'main', mag: 5.5, time: t0, lat: 35, lon: -118 });
  for (let i = 0; i < 40; i++) ev.push({ id: 'a' + i, mag: 2 + (i % 10) / 10, time: t0 + (i + 1) * HOUR, lat: 35 + 0.01 * (i % 5), lon: -118 });
  // M 4.2 foreshock one hour before, 1 km away: its window contains the larger event
  ev.push({ id: 'fore', mag: 4.2, time: t0 - HOUR, lat: 35.01, lon: -118 });
  // unrelated M 4.5 far away with 3 aftershocks
  ev.push({ id: 'far', mag: 4.5, time: t0, lat: 60, lon: -150 });
  for (let i = 0; i < 3; i++) ev.push({ id: 'f' + i, mag: 2, time: t0 + (i + 1) * HOUR, lat: 60, lon: -150 });
  const s = findSequence(ev);
  assert.equal(s.main.id, 'main');
  assert.equal(s.after.length, 40);
  assert.ok(Math.abs(s.window.km - gkWindow(5.5).km) < 1e-9);
});

// --------------------------------------------------------------- catalog merge
function feat(id, { mag = 2, time, updated, status = 'automatic', depth = 10, lon = -118, lat = 35, place = 'somewhere', ids, type = 'earthquake', magType = 'ml' }) {
  return { type: 'Feature', id, properties: { mag, magType, place, time, updated: updated ?? time, status, type, ids: ids ?? ',' + id + ',', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/' + id }, geometry: { type: 'Point', coordinates: [lon, lat, depth] } };
}

test('merge detects a magnitude revision and a deletion in the day feed', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  const day1 = [feat('a', { time: now - 2 * HOUR, mag: 2.3 }), feat('b', { time: now - 3 * HOUR }), feat('c', { time: now - 5 * HOUR })];
  const r1 = mergeCatalog(st, day1, { window: { key: 'day', span: DAY, end: now }, initial: true });
  assert.equal(r1.added.length, 3);
  assert.equal(r1.added[0].isNew, false);
  // five minutes later: a is revised (2.3 to 2.1, reviewed), b is gone, d is new
  const t2 = now + 5 * MIN;
  const day2 = [
    feat('a', { time: now - 2 * HOUR, mag: 2.1, status: 'reviewed', updated: t2 - MIN }),
    feat('c', { time: now - 5 * HOUR }),
    feat('d', { time: t2 - MIN }),
  ];
  const r2 = mergeCatalog(st, day2, { window: { key: 'day', span: DAY, end: t2 } });
  assert.equal(r2.revised.length, 1);
  assert.deepEqual(r2.revised[0].fields, ['mag', 'status']);
  assert.equal(r2.revised[0].before.mag, 2.3);
  assert.equal(r2.revised[0].after.mag, 2.1);
  assert.deepEqual(describeChange(r2.revised[0]), ['M 2.3 to 2.1', 'automatic to reviewed']);
  assert.equal(r2.deleted.length, 1);
  assert.equal(r2.deleted[0].id, 'b');
  assert.deepEqual(describeChange(r2.deleted[0]), ['deleted']);
  assert.equal(r2.added.length, 1);
  assert.equal(r2.added[0].isNew, true);
  assert.equal(st.events.has('b'), false);
  assert.equal(st.log.length, 2);
  // a stale cached copy that still holds b does not bring it back
  const r3 = mergeCatalog(st, [feat('b', { time: now - 3 * HOUR })], {});
  assert.equal(r3.added.length, 0);
});

test('a deleted event returns only in a newer response or with a newer version', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  const x = feat('x', { time: now - HOUR }), y = feat('y', { time: now - 2 * HOUR });
  mergeCatalog(st, [x, y], { window: { key: 'day', span: DAY, end: now }, initial: true });
  const r1 = mergeCatalog(st, [y], { window: { key: 'day', span: DAY, end: now + 5 * MIN } });
  assert.equal(r1.deleted.length, 1);
  // a stale hour feed built before the deletion still carries x: ignored
  assert.equal(mergeCatalog(st, [x], { window: { span: HOUR, end: now + 2 * MIN } }).revised.length, 0);
  assert.equal(st.events.has('x'), false);
  // the next day response, built after the deletion, has x again: restored and logged
  const r3 = mergeCatalog(st, [x, y], { window: { key: 'day', span: DAY, end: now + 10 * MIN } });
  assert.equal(r3.added.length, 0);
  assert.equal(r3.revised.length, 1);
  assert.deepEqual(r3.revised[0].fields, ['restored']);
  assert.deepEqual(describeChange(r3.revised[0]), ['back after a deletion']);
  assert.equal(st.events.has('x'), true);
});

test('an event aging out of the day window is not a deletion', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('old', { time: now - DAY + 5 * MIN })], { window: { key: 'day', span: DAY, end: now }, initial: true });
  const r = mergeCatalog(st, [], { window: { key: 'day', span: DAY, end: now + 6 * MIN } });
  assert.equal(r.deleted.length, 0);
});

test('a response older than the previous one is never compared for deletions', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('x', { time: now - HOUR }), feat('y', { time: now - 2 * HOUR })], { window: { key: 'day', span: DAY, end: now }, initial: true });
  const r = mergeCatalog(st, [feat('y', { time: now - 2 * HOUR })], { window: { key: 'day', span: DAY, end: now - MIN } });
  assert.equal(r.deleted.length, 0);
  assert.equal(st.prev.day.end, now);
});

test('a change of preferred id is a revision, not a deletion plus an addition', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('ak1', { time: now - HOUR, mag: 3.1, magType: 'ml' })], { window: { key: 'day', span: DAY, end: now }, initial: true });
  const r = mergeCatalog(st, [feat('us9', { time: now - HOUR, mag: 3.3, magType: 'mb', ids: ',ak1,us9,', updated: now + MIN })], { window: { key: 'day', span: DAY, end: now + 5 * MIN } });
  assert.equal(r.added.length, 0);
  assert.equal(r.deleted.length, 0);
  assert.equal(r.revised.length, 1);
  assert.deepEqual(r.revised[0].fields, ['id', 'mag', 'magType']);
  assert.equal(st.events.size, 1);
  assert.ok(st.events.has('us9'));
  // the old id arriving again from a stale hour feed is recognised and ignored
  const r2 = mergeCatalog(st, [feat('ak1', { time: now - HOUR, mag: 3.1 })], {});
  assert.equal(r2.added.length, 0);
  assert.equal(st.events.size, 1);
});

test('merge ignores same or older versions and keeps the catalog to seven days', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('e', { time: now - HOUR, updated: now }), feat('ancient', { time: now - 8 * DAY })], { now, initial: true });
  assert.equal(st.events.size, 1);
  const r = mergeCatalog(st, [feat('e', { time: now - HOUR, updated: now - MIN, mag: 9 })], { now });
  assert.equal(r.revised.length, 0);
  assert.equal(st.events.get('e').mag, 2);
  mergeCatalog(st, [], { now: now + 7 * DAY });
  assert.equal(st.events.size, 0);
});

test('an update that changes no tracked field is counted as touched, not logged', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('e', { time: now - HOUR })], { now, initial: true });
  const r = mergeCatalog(st, [feat('e', { time: now - HOUR, updated: now + MIN })], { now });
  assert.equal(r.touched, 1);
  assert.equal(r.revised.length, 0);
  assert.equal(st.log.length, 0);
});

test('status deleted in the feed removes the event', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const st = createCatalog();
  mergeCatalog(st, [feat('e', { time: now - HOUR })], { now, initial: true });
  const r = mergeCatalog(st, [feat('e', { time: now - HOUR, status: 'deleted', updated: now + MIN })], { now });
  assert.equal(r.deleted.length, 1);
  assert.equal(st.events.size, 0);
});

// --------------------------------------------------------------- bursts
test('Poisson burst rule flags a clear spike against the trailing median', () => {
  const counts = new Array(48).fill(3);
  counts[40] = 20;
  const f = burstFlags(counts);
  assert.equal(f[10].tested, false, 'first 24 hours are not tested');
  assert.equal(f[40].flag, true);
  assert.equal(f[40].lambda, 3);
  assert.equal(f[39].flag, false);
  assert.equal(f.filter(x => x.flag).length, 1);
});

test('burst baseline falls back to the mean, then the floor, when the median is zero', () => {
  const counts = new Array(30).fill(0);
  counts[2] = 3; counts[5] = 3;            // median 0, mean 0.25 over the first 24
  const f = burstFlags(counts);
  assert.equal(f[24].rule, 'mean');
  assert.ok(Math.abs(f[24].lambda - 0.25) < 1e-12);
  const g = burstFlags(new Array(30).fill(0).map((_, i) => (i === 28 ? 2 : 0)));
  assert.equal(g[28].rule, 'floor');
  assert.ok(Math.abs(g[28].lambda - 1 / 24) < 1e-12);
  assert.equal(g[28].flag, true, 'two events against one a day is p < 0.001');
});

test('hourly counts bin by UTC hour and the last bin is the current hour', () => {
  const end = Date.UTC(2026, 9, 8, 12, 30);
  const { start, counts } = hourlyCounts([end - 10 * MIN, end - 40 * MIN, end - 167.5 * HOUR, end - 200 * HOUR], end, 168);
  assert.equal(start, Date.UTC(2026, 9, 8, 12) - 167 * HOUR);
  assert.equal(counts.length, 168);
  assert.equal(counts[167], 1);
  assert.equal(counts[166], 1);
  assert.equal(counts[0], 1);
  assert.equal(counts.reduce((s, x) => s + x, 0), 3);
});

// --------------------------------------------------------------- regions
test('regions: Alaska spans the antimeridian, Global needs M 4.5', () => {
  const ak = regionByKey('ak');
  assert.equal(inRegion(ak, { lon: 175, lat: 52, mag: 3 }), true);
  assert.equal(inRegion(ak, { lon: -150, lat: 61, mag: 1 }), true);
  assert.equal(inRegion(ak, { lon: -120, lat: 61, mag: 1 }), false);
  assert.equal(inRegion(regionByKey('m45'), { lon: 0, lat: 0, mag: 4.4 }), false);
  assert.equal(inRegion(regionByKey('m45'), { lon: 0, lat: 0, mag: 4.5 }), true);
  assert.equal(inRegion(regionByKey('ca'), { lon: -118, lat: 34, mag: 1 }), true);
  assert.equal(inRegion(regionByKey('hi'), { lon: -155.3, lat: 19.4, mag: 1 }), true);
  assert.equal(inRegion(regionByKey('pr'), { lon: -66, lat: 18, mag: 1 }), true);
  assert.equal(REGIONS.length, 6);
});

// --------------------------------------------------------------- one region end to end
test('analyze scopes by region, excludes non earthquakes, and fits a synthetic sequence', () => {
  const now = Date.UTC(2026, 9, 8, 12), r = rng(5), t0 = now - 3 * DAY, ev = [];
  ev.push({ id: 'main', mag: 5.6, magType: 'mw', type: 'earthquake', time: t0, lat: 35.6, lon: -117.5, depth: 8 });
  const T = 3, p = 1.1, c = 0.05, a = c ** (1 - p), z = (T + c) ** (1 - p);
  for (let i = 0; i < 120; i++) {
    const t = (a - r() * (a - z)) ** (1 / (1 - p)) - c;
    ev.push({ id: 'a' + i, mag: 1 + Math.round(20 * r()) / 10, magType: 'ml', type: 'earthquake', time: t0 + t * DAY, lat: 35.6 + (r() - 0.5) * 0.1, lon: -117.5 + (r() - 0.5) * 0.1, depth: 5 });
  }
  ev.push({ id: 'blast', mag: 1.5, magType: 'ml', type: 'quarry blast', time: now - HOUR, lat: 34, lon: -117, depth: 0 });
  ev.push({ id: 'ak', mag: 3, magType: 'ml', type: 'earthquake', time: now - 2 * HOUR, lat: 61, lon: -150, depth: 40 });
  const A = analyze(ev, regionByKey('ca'), now);
  assert.equal(A.quakes.length, 121);
  assert.deepEqual(A.excluded, [{ type: 'quarry blast', k: 1 }]);
  assert.equal(A.seq.main.id, 'main');
  assert.equal(A.seq.after.length, 120);
  // with 120 aftershocks over 3 days the spread of p across catalogs is about 0.2,
  // so the check is that the 95% profile range covers the true value
  assert.ok(A.omori && A.omori.pLo <= 1.1 && A.omori.pHi >= 1.1, `p = ${A.omori.p}, range [${A.omori.pLo}, ${A.omori.pHi}]`);
  assert.equal(A.hourly.flags.length, 168);
  assert.ok(A.hourly.flags.some(f => f.flag), 'the sequence start is a flagged hour');
  const B = analyze(ev, regionByKey('ak'), now);
  assert.equal(B.quakes.length, 1);
  assert.equal(B.gr.ok, false);
  assert.equal(B.seq.main, null);
});
