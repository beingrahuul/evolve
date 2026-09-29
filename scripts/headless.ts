// Runs the simulation without graphics and prints ecosystem vitals — used for tuning.
// Usage: npx tsx scripts/headless.ts [seconds=600] [seed=42]
import { World } from '../src/sim/world';
import { A } from '../src/sim/genome';
import { TPS } from '../src/sim/params';

const seconds = Number(process.argv[2] ?? 600);
const seed = Number(process.argv[3] ?? 42);
const w = new World(seed);
const t0 = performance.now();
let lastPrint = performance.now();
let lastTick = 0;

const fmt = (x: number, d = 1) => x.toFixed(d).padStart(7);

console.log(
  '   sim s    pop  photo  chemo hetero  spec   part   biomass  nutW  atmO2 atmCO2  temp  ms/tick',
);
for (let s = 1; s <= seconds * TPS; s++) {
  w.step();
  if (s % (TPS * 20) === 0) {
    const now = performance.now();
    const msPerTick = (now - lastPrint) / (w.tick - lastTick);
    lastPrint = now;
    lastTick = w.tick;
    let photo = 0;
    let chemo = 0;
    let het = 0;
    let bio = 0;
    for (const o of w.orgs) {
      bio += o.mass;
      const f = o.frac;
      if (f[A.mouth] >= f[A.chloro] && f[A.mouth] >= f[A.chemo]) het++;
      else if (f[A.chloro] >= f[A.chemo]) photo++;
      else chemo++;
    }
    const tot = w.fields.totals();
    console.log(
      `${fmt(w.time, 0)} ${fmt(w.orgs.length, 0)}${fmt(photo, 0)}${fmt(chemo, 0)}${fmt(het, 0)}${fmt(
        w.species.alive().length,
        0,
      )}${fmt(w.particles.n, 0)}${fmt(bio, 0).padStart(10)}${fmt(tot.nut, 0)}${fmt(w.fields.atmO2, 3)}${fmt(
        w.fields.atmCO2,
        3,
      )}${fmt(tot.meanTemp)}${fmt(msPerTick, 2)}`,
    );
  }
}
const elapsed = (performance.now() - t0) / 1000;
console.log(`\nsimulated ${seconds}s in ${elapsed.toFixed(1)}s real  (${((seconds * TPS) / elapsed).toFixed(0)} ticks/s)`);
console.log('death causes:', Object.fromEntries(w.deathCauses));
const top = w.species
  .alive()
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);
for (const sp of top) console.log(`  ${sp.name.padEnd(28)} ${String(sp.count).padStart(5)}  ${sp.role}`);
const gens = w.orgs.map((o) => o.generation);
console.log('max generation:', Math.max(0, ...gens), ' mean:', (gens.reduce((a, b) => a + b, 0) / Math.max(1, gens.length)).toFixed(1));
