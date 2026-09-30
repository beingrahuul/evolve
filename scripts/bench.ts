// Speed of the simulation on one thread vs several (helper threads over shared memory).
// Usage (bundle both files first, into the same folder; helpers sense, kernels help the water):
//   npx esbuild scripts/bench.ts --bundle --platform=node --format=esm --outfile=/tmp/bench.mjs
//   npx esbuild scripts/helper-node.ts --bundle --platform=node --format=esm --outfile=/tmp/helper-node.mjs
//   node /tmp/bench.mjs [seconds=120] [seed=42] [width=3840] [helpers=2] [kernels=2]
import { Worker } from 'node:worker_threads';
import { shareMemory } from '../src/sim/shared';
import { HelperHandle, Threads } from '../src/sim/threads';
import { makeWorld } from '../src/sim/world';
import { TPS } from '../src/sim/params';

const seconds = Number(process.argv[2] ?? 120);
const seed = Number(process.argv[3] ?? 42);
const width = Number(process.argv[4] ?? 3840);
const helpers = Number(process.argv[5] ?? 2);
const kernels = Number(process.argv[6] ?? 2);

shareMemory(helpers > 0);
const w = makeWorld(seed, undefined, width);
let threads: Threads | null = null;
if (helpers > 0) {
  threads = new Threads(w, () => new Worker(new URL('./helper-node.mjs', import.meta.url)) as unknown as HelperHandle, helpers, kernels);
  w.threads = threads;
  // let the helpers start (yielding, so Node can start the threads)
  const t = Date.now();
  while (threads.helping < helpers + 1 && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
}
// time the environment when it runs inline
let envInline = 0;
let envCalls = 0;
const origEnv = w.stepEnvironment.bind(w);
w.stepEnvironment = (dtf: number) => {
  const t = performance.now();
  origEnv(dtf);
  envInline += performance.now() - t;
  envCalls++;
};
console.log(`width ${width}, ${helpers ? `a pool of ${helpers} + an environment thread with a pool of ${kernels}` : 'one thread'}`);
const t0 = performance.now();
let last = t0;
let lastTick = 0;
let orgTicks = 0;
for (let s = 1; s <= seconds * TPS; s++) {
  orgTicks += w.orgs.length;
  w.step();
  if (s % (TPS * 20) === 0) {
    const now = performance.now();
    console.log(`t=${String(w.time.toFixed(0)).padStart(4)} pop=${String(w.orgs.length).padStart(5)} species=${w.species.alive().length} ms/tick=${((now - last) / (w.tick - lastTick)).toFixed(3)}`);
    last = now;
    lastTick = w.tick;
  }
}
const ms = (performance.now() - t0) / (seconds * TPS);
console.log(`mean ${ms.toFixed(3)} ms/tick = ${(1000 / ms / TPS).toFixed(1)}× real time; ${(((performance.now() - t0) * 1000) / orgTicks).toFixed(3)} µs per organism per tick (mean population ${Math.round(orgTicks / (seconds * TPS))})`);
if (envCalls) console.log(`environment step inline: ${(envInline / envCalls).toFixed(3)} ms per step (${envCalls} steps)`);
if (threads) {
  const t = threads.timing;
  const ticks = seconds * TPS;
  console.log(
    `per tick: sense ${(t.sense / ticks).toFixed(3)} ms, ` +
      `environment sync ${(t.envSync / ticks).toFixed(3)} ms (waiting ${(t.envWait / ticks).toFixed(3)}); ` +
      `environment thread per step: ${(t.envStep / t.envSteps).toFixed(3)} ms stepping, ${(t.envIO / t.envSteps).toFixed(3)} ms copying`,
  );
}
threads?.dispose();
process.exit(0);
