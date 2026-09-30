// Load a save file (any version) and run it for a while: a migration check.
// Usage: npx tsx scripts/loadsave.ts file.json [seconds=60]
import { readFileSync } from 'fs';
import { deserializeWorld } from '../src/sim/serialize';
const w = deserializeWorld(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const hidden = w.orgs.reduce((a, o) => a + o.brain.hiddenCount, 0);
console.log(`loaded: width ${w.width}, tick ${w.tick}, ${w.orgs.length} organisms, ${hidden} hidden neurons, ${w.species.all.length} species`);
// every genome must compile into a brain whose outputs come first
for (const o of w.orgs) {
  for (let k = 0; k < 7; k++) if (o.genome.nodes[k].id !== 39 + k) throw new Error(`organism ${o.id}: output ${k} misplaced`);
}
for (let i = 0; i < 60 * Number(process.argv[3] ?? 60); i++) w.step();
console.log(`after: tick ${w.tick}, ${w.orgs.length} organisms, ${w.species.alive().length} species alive`);
