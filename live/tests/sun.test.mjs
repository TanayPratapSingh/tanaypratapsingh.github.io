// Tests for live/sun/helio.js. Run with: node --test live/tests/sun.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../sun/helio.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

test('parseUTC treats bare NOAA time tags as UTC', () => {
  assert.equal(H.parseUTC('2026-10-08T18:53:00'), Date.UTC(2026, 9, 8, 18, 53));
  assert.equal(H.parseUTC('2026-10-08T18:53:00Z'), Date.UTC(2026, 9, 8, 18, 53));
  assert.equal(H.parseUTC('2026-10-08 18:53:00'), Date.UTC(2026, 9, 8, 18, 53));
  assert.ok(Number.isNaN(H.parseUTC(null)));
  assert.ok(Number.isNaN(H.parseUTC('not a time')));
});

test('dynamic pressure for n = 5 cm^-3, v = 400 km/s is 1.338 nPa', () => {
  close(H.dynamicPressure(5, 400), 1.338, 0.0005);
  assert.ok(Number.isNaN(H.dynamicPressure(NaN, 400)));
  assert.ok(Number.isNaN(H.dynamicPressure(5, null)));
});

test('Shue r0 for Pd = 2 nPa, Bz = 0 matches the closed form (about 10.25 Re)', () => {
  const expect = (10.22 + 1.29 * Math.tanh(0.184 * 8.14)) * Math.pow(2, -1 / 6.6);
  close(H.shueR0(2, 0), expect, 1e-12);
  close(H.shueR0(2, 0), 10.25, 0.01);
  // flaring exponent and the curve: r at theta = 0 is r0, and it grows toward the flanks
  const a = H.shueAlpha(2, 0);
  close(a, 0.58 * (1 + 0.024 * Math.log(2)), 1e-12);
  close(H.shueR(0, 10, a), 10, 1e-12);
  close(H.shueR(Math.PI / 2, 10, a), 10 * Math.pow(2, a), 1e-9);
  assert.ok(Number.isNaN(H.shueR0(0, 0)), 'Pd must be positive');
  // higher pressure compresses the magnetopause
  assert.ok(H.shueR0(20, -10) < H.GEO_RE);
});

test('Newell coupling with Bz due south equals v^(4/3) Bt^(2/3)', () => {
  const v = 400, bz = -5;
  close(H.newell(v, 0, bz), Math.pow(v, 4 / 3) * Math.pow(5, 2 / 3), 1e-9);
  // due north gives zero, and the sign of By does not matter
  close(H.newell(v, 0, 5), 0, 1e-12);
  close(H.newell(v, 3, -4), H.newell(v, -3, -4), 1e-9);
  // clock angle convention: atan2(By, Bz), pi is due south
  close(H.clockAngle(0, -5), Math.PI, 1e-12);
  close(H.clockAngle(5, 0), Math.PI / 2, 1e-12);
});

test('ballistic delay for 1.5e6 km at 400 km/s is 3750 s', () => {
  assert.equal(H.ballisticDelay(1.5e6, -400, 410), 3750);
  assert.equal(H.ballisticDelay(1.5e6, NaN, 400), 3750, 'falls back to bulk speed');
  assert.equal(H.ballisticDelay(1.5e6, null, 400), 3750);
  assert.ok(Number.isNaN(H.ballisticDelay(NaN, -400, 400)));
});

test('flare classes', () => {
  assert.equal(H.flareClass(1.94e-6).label, 'C1.9');
  assert.equal(H.flareClass(3.2e-5).label, 'M3.2');
  assert.equal(H.flareClass(1.23e-3).label, 'X12.3');
  assert.equal(H.flareClass(4e-8).label, 'A4.0');
  assert.equal(H.flareClass(1e-6).label, 'C1.0', 'decade edge belongs to the upper class');
  assert.equal(H.flareClass(9.99e-6).label, 'C9.9', 'truncated, never rounded up to C10.0');
  assert.equal(H.flareClass(1e-4).label, 'X1.0');
  assert.equal(H.flareClass(0), null);
  assert.equal(H.flareClass(NaN), null);
});

test('G scale edges, strict threshold rule', () => {
  const g = kp => H.kpToG(kp, 'strict');
  assert.equal(g(0), 0);
  assert.equal(g(4.67), 0, '4.67 is below 5 under the strict rule');
  assert.equal(g(5), 1);
  assert.equal(g(5.67), 1);
  assert.equal(g(6), 2);
  assert.equal(g(7), 3);
  assert.equal(g(8), 4);
  assert.equal(g(8.67), 4);
  assert.equal(g(9), 5);
  assert.ok(Number.isNaN(g(NaN)));
  assert.equal(H.kpToG(4.67), 0, 'strict is the default');
});

test('G scale, NOAA rounding rule reproduces the labels in NOAA\'s own forecast file', () => {
  // (kp, noaa_scale) pairs as written in products/noaa-planetary-k-index-forecast.json,
  // captured 2026-10-08 18:57 UTC
  const pairs = [[4, null], [4.33, null], [4.67, 'G1'], [5, 'G1'], [5.33, 'G1'], [5.67, 'G2'], [3.67, null]];
  for (const [kp, lab] of pairs) {
    const g = H.kpToG(kp, 'noaa');
    assert.equal(g ? 'G' + g : null, lab, `kp ${kp}`);
  }
  assert.equal(H.kpToG(8.67, 'noaa'), 5);
  assert.equal(H.kpToG(6.33, 'noaa'), 2);
});

test('subsolar latitude at the 2026 equinox and solstice', () => {
  // March equinox 2026-03-20 14:46 UTC, June solstice 2026-06-21 08:24 UTC
  const eq = H.subsolarPoint(new Date(Date.UTC(2026, 2, 20, 14, 46)));
  close(eq.lat, 0, 1, 'equinox');
  close(eq.lat, 0, 0.05, 'equinox, tight');
  const so = H.subsolarPoint(new Date(Date.UTC(2026, 5, 21, 8, 24)));
  close(so.lat, 23.44, 1, 'solstice');
  close(so.lat, 23.44, 0.02, 'solstice, tight');
  // December solstice is the mirror image
  close(H.subsolarPoint(new Date(Date.UTC(2026, 11, 21, 20, 50))).lat, -23.44, 0.05);
});

test('equation of time and subsolar longitude', () => {
  // EoT is near its annual maximum (+16.4 min) in early November and its minimum (-14.2 min) mid February
  close(H.subsolarPoint(new Date(Date.UTC(2026, 10, 3, 12))).eotMin, 16.4, 0.5);
  close(H.subsolarPoint(new Date(Date.UTC(2026, 1, 11, 12))).eotMin, -14.2, 0.5);
  for (const d of [Date.UTC(2026, 0, 5, 12), Date.UTC(2026, 3, 15, 12), Date.UTC(2026, 9, 8, 12)]) {
    const s = H.subsolarPoint(d);
    close(s.lon, -s.eotMin / 4, 1e-9, 'at 12 UTC the subsolar longitude is minus the EoT in degrees');
    assert.ok(Math.abs(s.lon) < 4.5);
  }
  // the equation of time route and the sidereal time route agree
  for (let h = 0; h < 24; h += 5) {
    const s = H.subsolarPoint(Date.UTC(2026, 9, 8, h, 17));
    const d = ((s.lon - s.lonSidereal + 540) % 360) - 180;
    close(d, 0, 0.05, 'EoT vs GMST');
  }
  // six hours later the point has moved about 90 degrees west
  const a = H.subsolarPoint(Date.UTC(2026, 9, 8, 6)), b = H.subsolarPoint(Date.UTC(2026, 9, 8, 12));
  close(((a.lon - b.lon + 540) % 360) - 180, 90, 0.1);
});

test('join: active rows only, floored to the minute, sorted, source per row', () => {
  const T = m => `2026-10-08T12:${String(m).padStart(2, '0')}:00`;
  const wind = [], mag = [];
  // two spacecraft report every minute; only SOLAR1 is active. Rows arrive newest first.
  for (let m = 9; m >= 0; m--) {
    if (m === 4) continue; // one missing plasma minute
    wind.push({ time_tag: T(m), active: true, source: 'SOLAR1', proton_speed: 400 + m, proton_density: 5, proton_temperature: 1e5, proton_vx_gse: -(398 + m), overall_quality: 0 });
    wind.push({ time_tag: T(m), active: false, source: 'ACE', proton_speed: 999, proton_density: 99, proton_vx_gse: null });
  }
  for (let m = 0; m < 10; m++) {
    mag.push({ time_tag: T(m).replace(':00', ':00').slice(0, 17) + '07', active: true, source: 'SOLAR1', bt: 5, bx_gsm: 1, by_gsm: 3, bz_gsm: -4, overall_quality: 0 });
    mag.push({ time_tag: T(m), active: false, source: 'ACE', bt: 50, bx_gsm: 0, by_gsm: 0, bz_gsm: 40 });
  }
  const { rows, stats } = H.joinSolarWind(wind, mag);
  assert.equal(rows.length, 10);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].t > rows[i - 1].t, 'sorted ascending');
  assert.ok(rows.every(r => r.source === 'SOLAR1'), 'inactive ACE rows ignored');
  assert.ok(rows.every(r => r.t % 60000 === 0), 'floored to the minute');
  assert.equal(rows[0].v, 400);
  assert.equal(rows[0].bz, -4);
  const r4 = rows.find(r => r.t === H.parseUTC(T(4)));
  assert.ok(Number.isNaN(r4.v), 'missing plasma minute kept with NaN plasma');
  assert.equal(r4.bz, -4, 'but its field sample is kept');
  assert.equal(stats.matched, 9);
  assert.equal(stats.wind.count, 9);
  assert.equal(stats.wind.missing, 1);
  assert.equal(stats.mag.count, 10);
  assert.equal(stats.wind.changes.length, 0);
  assert.equal(stats.wind.longest.missing, 1);
  assert.equal(H.latestJoined(rows).t, H.parseUTC(T(9)));
});

test('join: reports gaps and a source change', () => {
  const T = m => new Date(Date.UTC(2026, 9, 8, 12, m)).toISOString().slice(0, 19);
  const wind = [], mag = [];
  for (let m = 0; m < 30; m++) {
    if (m >= 10 && m < 18) continue; // eight minute gap
    const src = m < 20 ? 'SOLAR1' : 'ACE';
    wind.push({ time_tag: T(m), active: true, source: src, proton_speed: 500, proton_density: 2, proton_vx_gse: -500 });
    mag.push({ time_tag: T(m), active: true, source: src, bt: 6, by_gsm: 0, bz_gsm: -6 });
  }
  const { stats } = H.joinSolarWind(wind, mag, { gapMs: 5 * 60e3 });
  assert.equal(stats.wind.gaps.length, 1);
  assert.equal(stats.wind.gaps[0].missing, 8);
  assert.deepEqual(stats.wind.changes.map(c => [c.from, c.to]), [['SOLAR1', 'ACE']]);
  assert.equal(stats.wind.source, 'ACE');
  assert.deepEqual(stats.mag.sources, ['SOLAR1', 'ACE']);
});

test('derive: delay from the ephemeris of the plasma spacecraft, and the sample arriving now', () => {
  const eph = H.indexEphemeris([
    { time_tag: '2026-10-08T12:00:00', active: true, source: 'SOLAR1', x_gse: 1.5e6, y_gse: 0, z_gse: 0 },
    { time_tag: '2026-10-08T12:00:00', active: false, source: 'ACE', x_gse: 1.4e6, y_gse: 0, z_gse: 0 },
  ]);
  assert.equal(H.activeEphemeris(eph).source, 'SOLAR1');
  const t0 = Date.UTC(2026, 9, 8, 12, 0);
  const rows = [];
  for (let m = 0; m < 120; m++) rows.push({ t: t0 + m * 60e3, windSource: 'SOLAR1', v: 400, vx: -400, n: 5, by: 0, bz: -5 });
  H.derive(rows, eph);
  assert.equal(rows[0].delay, 3750);
  assert.equal(rows[0].arrival, t0 + 3750e3);
  close(rows[0].pd, 1.338, 0.0005);
  close(rows[0].r0, H.shueR0(rows[0].pd, -5), 1e-12);
  const now = t0 + 100 * 60e3;
  const a = H.arrivingNow(rows, now);
  close(a.t, now - 3750e3, 60e3, 'sample measured one delay ago');
  assert.equal(H.arrivingNow(rows, t0 + 400 * 60e3), null, 'nothing arrives when data stopped long ago');
});

test('OVATION helpers: nearest cell and southernmost 10% latitude', () => {
  const coords = [];
  for (let lon = 0; lon < 360; lon++) for (let lat = -90; lat <= 90; lat++) {
    let p = 0;
    if (lat >= 60 && lat <= 70) p = lon === 284 && lat === 60 ? 8 : 25;
    coords.push([lon, lat, p]);
  }
  const o = H.ovationGrid({ 'Observation Time': '2026-10-08T18:50:00Z', 'Forecast Time': '2026-10-08T20:05:00Z', coordinates: coords });
  assert.equal(o.cells, 360 * 181);
  assert.equal(o.fc - o.obs, 75 * 60e3);
  assert.equal(H.ovationAt(o.grid, 43.04, -76.13), 0);
  assert.equal(H.ovationAt(o.grid, 65.2, 10.4), 25);
  assert.equal(H.ovationAt(o.grid, 60, -76.13), 8, 'longitude -76.13 maps to cell 284');
  assert.equal(H.auroraBoundary(o.grid, -76.13), 61, 'the 8% cell at 60 N does not count');
  assert.equal(H.auroraBoundary(o.grid, 18.96), 60);
  const empty = H.ovationGrid({ coordinates: coords.map(c => [c[0], c[1], 0]) });
  assert.ok(Number.isNaN(H.auroraBoundary(empty.grid, 0)));
});

test('Kp windows, window stats and chart rows', () => {
  const fc = [
    { time_tag: '2026-10-08T12:00:00', kp: 2, observed: 'observed', noaa_scale: null },
    { time_tag: '2026-10-08T15:00:00', kp: 1.33, observed: 'observed', noaa_scale: null },
    { time_tag: '2026-10-08T18:00:00', kp: 1.67, observed: 'estimated', noaa_scale: null },
    { time_tag: '2026-10-08T21:00:00', kp: 5.67, observed: 'predicted', noaa_scale: 'G2' },
  ];
  const w = H.kpWindows(fc);
  assert.equal(w.length, 4);
  const now = Date.UTC(2026, 9, 8, 18, 30);
  assert.equal(H.windowAt(w, now).kp, 1.67);
  const k1m = [];
  for (let m = 0; m <= 30; m++) k1m.push({ t: Date.UTC(2026, 9, 8, 18, m), kp: m < 20 ? 1 : 2 });
  k1m.push({ t: Date.UTC(2026, 9, 8, 17, 59), kp: 9 });
  const s = H.windowStats(k1m, w[2].t0, w[2].t1);
  assert.equal(s.n, 31);
  assert.equal(s.max, 2);
  close(s.mean, (20 * 1 + 11 * 2) / 31, 1e-12);
  const rows = H.kpChartRows(w, k1m, Date.UTC(2026, 9, 8, 12), Date.UTC(2026, 9, 9, 3));
  const at = t => rows.find(r => r.t === t);
  const b = at(Date.UTC(2026, 9, 8, 15));
  assert.equal(b.observed, 1.33, 'a boundary takes the starting window of the same type');
  const e = at(Date.UTC(2026, 9, 8, 18));
  assert.equal(e.observed, 1.33, 'observed step runs to the end of its window');
  assert.equal(e.estimated, 1.67, 'and the estimated step starts there');
  assert.equal(e.k1m, 1);
  const last = rows[rows.length - 1];
  assert.equal(last.t, Date.UTC(2026, 9, 9, 3));
  assert.ok(Number.isNaN(last.predicted), 'nothing past the last window');
  assert.equal(at(Date.UTC(2026, 9, 9, 0)).predicted, 5.67);
});

test('rolling mean needs enough samples', () => {
  const rows = [0, 1, 2, 3, 10, 11].map(m => ({ t: m * 60e3, x: m }));
  H.rollingMean(rows, 'x', 3 * 60e3, 2, 'm');
  assert.ok(Number.isNaN(rows[0].m));
  close(rows[1].m, 0.5, 1e-12);
  close(rows[3].m, 2, 1e-12);
  assert.ok(Number.isNaN(rows[4].m), 'isolated sample after a gap');
});

test('freshness thresholds', () => {
  const th = { fresh: 10, late: 30 };
  assert.equal(H.freshness(5, th), 'fresh');
  assert.equal(H.freshness(10, th), 'fresh');
  assert.equal(H.freshness(20, th), 'late');
  assert.equal(H.freshness(31, th), 'stale');
  assert.equal(H.freshness(NaN, th), 'unknown');
});

test('Sun distance near perihelion and aphelion 2026', () => {
  close(H.sunDistanceAU(Date.UTC(2026, 0, 3, 17)), 0.98330, 0.0005);
  close(H.sunDistanceAU(Date.UTC(2026, 6, 6, 18)), 1.01664, 0.0005);
});

test('stream progress is travelled distance over the spacecraft distance', () => {
  const now = Date.UTC(2026, 9, 8, 20, 0);
  const rows = [
    { t: now - 3750e3, v: 410, vx: -400, xKm: 1.5e6 },          // arriving now
    { t: now - 1875e3, v: 400, vx: NaN, xKm: 1.5e6 },           // halfway, bulk speed fallback
    { t: now - 3 * 3600e3, v: 400, vx: -400, xKm: 1.5e6 },      // older than 2 h, dropped
    { t: now - 60e3, v: 400, vx: -400, xKm: NaN },              // no ephemeris, dropped
  ];
  const s = H.streamProgress(rows, now);
  assert.equal(s.length, 2);
  close(s[0].progress, 1, 1e-12);
  close(s[1].progress, 0.5, 1e-12);
  assert.equal(s[1].u, 400);
});

test('Shue point at a given distance from the Sun Earth line', () => {
  const r0 = 10, a = 0.6;
  const nose = H.shueAtRho(r0, a, 0);
  assert.equal(nose.x, r0);
  const p = H.shueAtRho(r0, a, 4);
  close(H.shueR(p.theta, r0, a) * Math.sin(p.theta), 4, 1e-6, 'on the curve');
  assert.ok(p.x < r0 && p.x > 0, 'behind the nose, still sunward');
});
