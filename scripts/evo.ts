// Long-run evolution check: prints population, diversity and trait/brain drift.
// Usage: npx tsx scripts/evo.ts [seconds=3600] [seed=42]
import { World } from '../src/sim/world';
import { A } from '../src/sim/genome';
import { TPS } from '../src/sim/params';
const seconds = Number(process.argv[2] ?? 3600);
const w = new World(Number(process.argv[3] ?? 42));
const t0 = performance.now();
for (let s = 1; s <= seconds * TPS; s++) {
  w.step();
  if (s % (TPS * 150) === 0) {
    const n = w.orgs.length || 1;
    let gen = 0, maxGen = 0, hid = 0, con = 0, ph = 0, ch = 0, het = 0, multi = 0, cells = 0, maxCells = 0;
    const fr = new Float64Array(8);
    for (const o of w.orgs) {
      gen += o.generation; maxGen = Math.max(maxGen, o.generation);
      hid += o.brain.hiddenCount; con += o.brain.connCount;
      if (o.targetCells > 1) { multi++; cells += o.nCells; maxCells = Math.max(maxCells, o.nCells); }
      for (let i = 0; i < 8; i++) fr[i] += o.frac[i];
      const f = o.frac;
      if (f[A.mouth] >= f[A.chloro] && f[A.mouth] >= f[A.chemo]) het++; else if (f[A.chloro] >= f[A.chemo]) ph++; else ch++;
    }
    const alive = w.species.alive().length;
    console.log(`t=${String(w.time.toFixed(0)).padStart(5)} pop=${String(w.orgs.length).padStart(4)} (P${ph}/C${ch}/H${het}) multi=${multi} cells=${(cells / Math.max(1, multi)).toFixed(1)}/${maxCells} sp=${alive} spTotal=${w.species.all.length} gen=${(gen/n).toFixed(1)}/${maxGen} hidden=${(hid/n).toFixed(2)} conns=${(con/n).toFixed(1)} part=${w.particles.n} O2=${w.fields.atmO2.toFixed(3)} T=${w.fields.meanTemp.toFixed(1)} frac=[${Array.from(fr).map(x => (x/n).toFixed(2)).join(',')}] ${((performance.now()-t0)/1000).toFixed(0)}s`);
  }
}
console.log('deaths', Object.fromEntries(w.deathCauses));
