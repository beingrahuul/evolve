// Phase 4 diagnostics: sexual reproduction, learning and signalling.
// Usage: npx tsx scripts/phase4.ts [seconds=900] [seed=42] [width=1920]
import { makeWorld } from '../src/sim/world';
import { INPUT_NAMES, NI, OUT } from '../src/sim/genome';
import { TPS } from '../src/sim/params';
const seconds = Number(process.argv[2] ?? 900);
const w = makeWorld(Number(process.argv[3] ?? 42), undefined, Number(process.argv[4] ?? 1920));
const t0 = performance.now();
let last = performance.now();
let lastTick = 0;
let lastMatings = 0;
let births = 0;
let sexual = 0;
for (let s = 1; s <= seconds * TPS; s++) {
  w.step();
  if (s % 60 === 0) {
    const smp = w.stats.last()!;
    births += smp.births ?? 0;
    sexual += (smp.births ?? 0) * (smp.sexual ?? 0);
  }
  if (s % (TPS * 60) === 0) {
    const ms = (performance.now() - last) / (w.tick - lastTick);
    last = performance.now();
    lastTick = w.tick;
    const n = Math.max(1, w.orgs.length);
    let sex = 0, courting = 0, learn = 0, learners = 0, drift = 0, plastic = 0, emitA = 0, emitB = 0, reward = 0, gen = 0;
    for (const o of w.orgs) {
      sex += o.genome.sex;
      if (o.courting > 0) courting++;
      learn += o.genome.learn;
      if (o.genome.learn > 0 && o.brain.plasticCount > 0) {
        learners++;
        drift += o.brain.learnedDrift();
        plastic += o.brain.plasticCount;
      }
      if (o.emitA > 0.05) emitA++;
      if (o.emitB > 0.05) emitB++;
      reward += Math.abs(o.reward);
      gen = Math.max(gen, o.generation);
    }
    console.log(
      `t=${w.time.toFixed(0).padStart(5)} pop=${String(w.orgs.length).padStart(5)} sp=${String(w.species.alive().length).padStart(3)} gen=${gen} ` +
        `births=${births} sexual=${((sexual / Math.max(1, births)) * 100).toFixed(0)}% matings=${w.totalMatings - lastMatings} courting=${courting} ` +
        `sex=${(sex / n).toFixed(3)} learn=${(learn / n).toFixed(3)} learners=${learners} plastic=${(plastic / Math.max(1, learners)).toFixed(1)} drift=${(drift / Math.max(1, learners)).toFixed(3)} ` +
        `|r|=${(reward / n).toFixed(2)} emitA=${emitA} emitB=${emitB} ${ms.toFixed(2)}ms`,
    );
    lastMatings = w.totalMatings;
    births = 0;
    sexual = 0;
  }
}
const top = w.species.alive().sort((a, b) => b.count - a.count).slice(0, 8);
for (const sp of top) {
  const members = w.orgs.filter((o) => o.species === sp.id);
  const sx = members.reduce((a, o) => a + o.genome.sex, 0) / members.length;
  const ln = members.reduce((a, o) => a + o.genome.learn, 0) / members.length;
  console.log(`  ${sp.name.padEnd(28)} ${String(sp.count).padStart(5)}  sex ${sx.toFixed(2)} learn ${ln.toFixed(2)}  ${sp.role}`);
}
// what drives the pheromones? direct synapses from senses into each emit output
for (const [name, out] of [['A', OUT.EmitA], ['B', OUT.EmitB]] as const) {
  const tally = new Map<string, { n: number; w: number }>();
  let emitting = 0;
  for (const o of w.orgs) {
    if ((out === OUT.EmitA ? o.emitA : o.emitB) > 0.05) emitting++;
    for (const c of o.genome.conns) {
      if (!c.on || c.to !== NI + out || Math.abs(c.w) < 0.3) continue;
      const src = c.from < NI ? INPUT_NAMES[c.from] : 'hidden';
      const t = tally.get(src) ?? { n: 0, w: 0 };
      t.n++;
      t.w += c.w;
      tally.set(src, t);
    }
  }
  const top = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  console.log(`pheromone ${name}: ${emitting} emitting now; driven by ${top.map(([k, v]) => `${k} ×${v.n} (w ${(v.w / v.n).toFixed(1)})`).join(', ')}`);
}
// and who listens? synapses from pheromone senses to actions
const listen = new Map<string, number>();
for (const o of w.orgs) {
  for (const c of o.genome.conns) {
    if (!c.on || c.from < 32 || c.from > 35 || Math.abs(c.w) < 0.3) continue;
    const k = `${INPUT_NAMES[c.from]}→${c.to >= NI && c.to < NI + 7 ? ['thrust', 'turn', 'eat', 'float', 'glow', 'emit A', 'emit B'][c.to - NI] : 'hidden'}`;
    listen.set(k, (listen.get(k) ?? 0) + 1);
  }
}
console.log('listening:', [...listen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ×${n}`).join(', '));
console.log('deaths', Object.fromEntries(w.deathCauses), `${((performance.now() - t0) / 1000).toFixed(0)}s`);
