// Spread of the Omori-Utsu exponent p and profile likelihood coverage at two sample sizes (true p = 1.1, c = 0.05 d, T = 3 d, 200 sequences each).
// Run: node live/tests/sim/quakes_omori_spread.mjs
import { rng } from '../../assets/util.js';
import { omoriFit } from '../../quakes/seismo.js';
function times(n, p, c, T, seed) { const r = rng(seed), a = c ** (1 - p), z = (T + c) ** (1 - p), out = []; for (let i = 0; i < n; i++) out.push((a - r() * (a - z)) ** (1 / (1 - p)) - c); return out; }
for (const n of [120, 1000]) {
  let s = 0, s2 = 0, cover = 0; const N = 200;
  for (let k = 1; k <= N; k++) { const f = omoriFit(times(n, 1.1, 0.05, 3, k * 31), 3); s += f.p; s2 += f.p * f.p; if (f.pLo <= 1.1 && f.pHi >= 1.1) cover++; }
  const m = s / N; console.log({ n, meanP: m.toFixed(3), sdP: Math.sqrt(s2 / N - m * m).toFixed(3), profileCoverage: cover / N });
}
