// Phase 3 diagnostics: tides, weather, soil and life on land.
// Usage: npx tsx scripts/weather.ts [seconds=600] [seed=42]
import { World } from '../src/sim/world';
import { A } from '../src/sim/genome';
import { TPS } from '../src/sim/params';
const seconds = Number(process.argv[2] ?? 600);
const w = new World(Number(process.argv[3] ?? 42));
const t0 = performance.now();
let last = performance.now();
let lastTick = 0;
console.log(`coast x=${w.terrain.coastX.toFixed(0)} land ${w.terrain.landRight ? 'right' : 'left'}`);
for (let s = 1; s <= seconds * TPS; s++) {
  w.step();
  if (s % (TPS * 30) === 0) {
    const ms = (performance.now() - last) / (w.tick - lastTick);
    last = performance.now();
    lastTick = w.tick;
    const air = w.atmosphere.summary();
    const soil = w.soil;
    let landCols = 0, moist = 0, nut = 0, org = 0, stemp = 0;
    for (let i = 0; i < soil.land.length; i++) if (soil.land[i]) { landCols++; moist += soil.moisture[i]; nut += soil.nutrient[i]; org += soil.organic[i]; stemp += soil.temp[i]; }
    const land = w.orgs.filter((o) => o.onLand);
    const rooted = land.filter((o) => o.frac[A.root] > 0.12).length;
    const inland = land.filter((o) => w.terrain.floorY(o.x) < w.seaLevel - 25).length;
    let ph = 0, het = 0;
    for (const o of w.orgs) { const f = o.frac; if (f[A.mouth] >= f[A.chloro] && f[A.mouth] >= f[A.chemo]) het++; else ph++; }
    console.log(
      `t=${w.time.toFixed(0).padStart(4)} sea=${w.seaLevel.toFixed(1).padStart(6)} pop=${String(w.orgs.length).padStart(4)} ph=${ph} het=${het} land=${land.length} (rooted ${rooted}, inland ${inland}) ` +
        `hum=${air.humidity.toFixed(2)} cloud=${air.cloud.toFixed(3)} cover=${(air.cover * 100).toFixed(0)}% rain=${air.rain.toFixed(3)} ` +
        `soil m=${(moist / Math.max(1, landCols)).toFixed(2)} n=${(nut / Math.max(1, landCols)).toFixed(2)} org=${(org / Math.max(1, landCols)).toFixed(2)} T=${(stemp / Math.max(1, landCols)).toFixed(1)} ` +
        `seaT=${w.fields.meanTemp.toFixed(1)} O2=${w.fields.atmO2.toFixed(3)} ${ms.toFixed(2)}ms`,
    );
  }
}
console.log('deaths', Object.fromEntries(w.deathCauses), `${((performance.now() - t0) / 1000).toFixed(0)}s`);
