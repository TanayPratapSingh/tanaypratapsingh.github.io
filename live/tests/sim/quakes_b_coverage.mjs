// Calibration check: bootstrap interval coverage and spread of b over 300 synthetic Gutenberg-Richter catalogs (true b = 1, n = 5000).
// Run: node live/tests/sim/quakes_b_coverage.mjs
import { rng } from '../../assets/util.js';
import { gutenbergRichter, akiUtsu } from '../../quakes/seismo.js';
function grCatalog(n, b, mMin, seed) {
  const r = rng(seed), beta = b * Math.LN10, out = [];
  for (let i = 0; i < n; i++) out.push(Math.round((mMin - 0.05 + -Math.log(1 - r()) / beta) * 10) / 10);
  return out;
}
const N = 300; let cover = 0, within = 0, sb = 0, sb2 = 0, sbs = 0, wide = 0;
for (let seed = 1; seed <= N; seed++) {
  const g = gutenbergRichter(grCatalog(5000, 1, 1.0, seed * 7919), { seed });
  if (g.boot.lo <= 1 && g.boot.hi >= 1) cover++;
  if (Math.abs(g.b - 1) < 0.05) within++;
  sb += g.b; sb2 += g.b * g.b; sbs += g.sigma; wide += g.boot.hi - g.boot.lo;
}
const m = sb / N, sd = Math.sqrt(sb2 / N - m * m);
console.log({ N, coverage: cover / N, within005: within / N, meanB: m.toFixed(4), sdB: sd.toFixed(4), meanShiBolt: (sbs / N).toFixed(4), meanWidth: (wide / N).toFixed(4) });
