// Everything the player can do to the world, as plain data. The UI never changes the world
// directly: it sends commands, which run wherever the simulation lives (a worker or this thread).
import { BIO, GodParams } from './params';
import type { Archetype } from './genome';
import type { EventKind, FieldBrush, World } from './world';

export type GodAct = 'meteor' | 'eruption' | 'bloom' | 'thunderstorm' | 'drought' | 'extinction' | 'seed';

export type Command =
  | { type: 'params'; params: GodParams }
  | { type: 'log'; text: string; kind: EventKind }
  | { type: 'act'; act: GodAct }
  // tools
  | { type: 'spawn'; arch: Archetype; x: number; y: number; select: boolean }
  | { type: 'lightning'; x: number }
  | { type: 'rock'; x: number; y: number; r: number; rockType: number }
  | { type: 'vent'; x: number }
  | { type: 'smite'; x: number; y: number; r: number; announce: boolean }
  | { type: 'paint'; brush: FieldBrush; x: number; y: number; r: number; dt: number }
  | { type: 'food'; x: number; y: number; r: number; count: number }
  | { type: 'clouds'; x: number; y: number; r: number; dt: number }
  | { type: 'terraform'; x: number; r: number; amount: number }
  | { type: 'flow'; x: number; y: number; dx: number; dy: number; r: number }
  // things the inspector does
  | { type: 'removeRock'; id: number }
  | { type: 'removeVent'; id: number }
  | { type: 'ventPower'; id: number; power: number }
  | { type: 'clone'; id: number }
  | { type: 'feed'; id: number }
  | { type: 'mutate'; id: number }
  | { type: 'kill'; id: number };

export interface CommandResult {
  /** An organism the UI should select (one it just created). */
  select?: number;
}

export function applyCommand(w: World, c: Command): CommandResult {
  switch (c.type) {
    case 'params':
      Object.assign(w.params, c.params);
      break;
    case 'log':
      w.log(c.text, c.kind);
      break;
    case 'act':
      godAct(w, c.act);
      break;
    case 'spawn': {
      const o = w.spawn(c.arch, c.x, c.y);
      if (o && c.select) return { select: o.id };
      break;
    }
    case 'lightning':
      w.callLightning(c.x);
      break;
    case 'rock':
      w.placeRock(c.x, c.y, c.r, c.rockType);
      w.log('You raised a new rock from the depths.', 'god');
      break;
    case 'vent':
      w.placeVent(c.x);
      w.log('A new hydrothermal vent cracks open on the seafloor.', 'god');
      break;
    case 'smite': {
      const n = w.smite(c.x, c.y, c.r);
      if (n && c.announce) w.log(`You struck down ${n} organism${n > 1 ? 's' : ''}.`, 'god');
      break;
    }
    case 'paint':
      w.paintField(c.brush, c.x, c.y, c.r, c.dt);
      break;
    case 'food':
      w.addFood(c.x, c.y, c.r, c.count);
      break;
    case 'clouds':
      w.seedClouds(c.x, c.y, c.r, c.dt);
      break;
    case 'terraform':
      w.terraform(c.x, c.r, c.amount);
      break;
    case 'flow':
      w.pushFlow(c.x, c.y, c.dx, c.dy, c.r);
      break;
    case 'removeRock':
      w.removeRock(c.id);
      break;
    case 'removeVent':
      w.removeVent(c.id);
      break;
    case 'ventPower': {
      const v = w.terrain.vents.find((q) => q.id === c.id);
      if (v) v.power = c.power;
      break;
    }
    default: {
      const o = w.orgById.get(c.id);
      if (!o || o.dead) break;
      if (c.type === 'clone') {
        if (w.clone(o)) w.log(`You cloned organism #${o.id}.`, 'god');
      } else if (c.type === 'feed') {
        o.energy = o.ecap;
        o.health = 1;
        o.nutrient = o.mass * BIO.NUT_RATIO * 1.5;
      } else if (c.type === 'mutate') w.mutateOrganism(o, 5);
      else w.kill(o, 'Struck down by god');
    }
  }
  return {};
}

function godAct(w: World, act: GodAct) {
  switch (act) {
    case 'meteor':
      return w.meteor();
    case 'eruption':
      return w.volcanicEruption();
    case 'bloom':
      return w.nutrientBloom();
    case 'thunderstorm':
      return w.thunderstorm();
    case 'drought':
      return w.drought();
    case 'extinction':
      return w.massExtinction(0.9);
    case 'seed':
      w.seedLife(0.5);
      w.log('New protocells were scattered through the water.', 'god');
  }
}
