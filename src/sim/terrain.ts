import { Rng } from './rng';
import { Noise1D } from './noise';
import { WORLD_W, WORLD_H, FLOOR_RES, NFLOOR } from './params';

export interface Minerals {
  iron: number;
  calcium: number;
  silica: number;
  phosphate: number;
}

export interface RockType {
  key: string;
  name: string;
  color: [number, number, number];
  hardness: number;
  minerals: Minerals;
  desc: string;
}

export const ROCK_TYPES: RockType[] = [
  {
    key: 'basalt',
    name: 'Basalt',
    color: [0.24, 0.24, 0.27],
    hardness: 0.8,
    minerals: { iron: 0.35, calcium: 0.1, silica: 0.45, phosphate: 0.1 },
    desc: 'Dark volcanic rock, rich in iron. Weathers slowly.',
  },
  {
    key: 'limestone',
    name: 'Limestone',
    color: [0.66, 0.62, 0.52],
    hardness: 0.35,
    minerals: { iron: 0.05, calcium: 0.8, silica: 0.1, phosphate: 0.05 },
    desc: 'Soft calcium carbonate. Dissolves faster in CO₂-rich (acidic) water.',
  },
  {
    key: 'granite',
    name: 'Granite',
    color: [0.55, 0.49, 0.48],
    hardness: 0.92,
    minerals: { iron: 0.1, calcium: 0.1, silica: 0.7, phosphate: 0.1 },
    desc: 'Hard, crystalline, mostly silica. Barely erodes.',
  },
  {
    key: 'sandstone',
    name: 'Sandstone',
    color: [0.64, 0.47, 0.31],
    hardness: 0.45,
    minerals: { iron: 0.15, calcium: 0.03, silica: 0.8, phosphate: 0.02 },
    desc: 'Compacted sand grains held together by iron oxides.',
  },
  {
    key: 'phosphorite',
    name: 'Phosphorite',
    color: [0.36, 0.43, 0.34],
    hardness: 0.4,
    minerals: { iron: 0.05, calcium: 0.3, silica: 0.1, phosphate: 0.55 },
    desc: 'Phosphate-rich sediment rock. A fertiliser for life when it weathers.',
  },
];

export interface Rock {
  id: number;
  type: RockType;
  x: number;
  y: number;
  r: number;
  r0: number;
  seed: number;
  released: number; // total nutrients leached so far
  solidR: number; // radius last used for the solid mask
}

export interface Vent {
  id: number;
  x: number;
  y: number;
  power: number;
}

/** Nutrient content of a rock's minerals, relative. */
export const richness = (m: Minerals) => m.phosphate + 0.35 * m.iron + 0.15 * m.calcium + 0.05;

export class Terrain {
  floor = new Float32Array(NFLOOR);
  rocks: Rock[] = [];
  vents: Vent[] = [];
  nextId = 1;

  generate(rng: Rng) {
    const n1 = new Noise1D(rng);
    const n2 = new Noise1D(rng);
    for (let i = 0; i < NFLOOR; i++) {
      const x = i * FLOOR_RES;
      let y = WORLD_H - 95 - 60 * n1.fbm(x / 420, 4) - 18 * n2.fbm(x / 70, 3);
      // gentle raise towards the walls so the basin reads as a basin
      const edge = Math.min(x, WORLD_W - x) / WORLD_W;
      y -= Math.max(0, 0.12 - edge) * 500;
      this.floor[i] = Math.max(WORLD_H - 230, Math.min(WORLD_H - 25, y));
    }

    // hydrothermal vents
    const ventCount = 2 + rng.int(2);
    for (let tries = 0; this.vents.length < ventCount && tries < 200; tries++) {
      const x = rng.range(220, WORLD_W - 220);
      if (this.vents.some((v) => Math.abs(v.x - x) < 420)) continue;
      this.addVent(x, rng.range(0.8, 1.2));
    }

    // boulders
    const nRocks = 9 + rng.int(5);
    for (let tries = 0; this.rocks.length < nRocks && tries < 400; tries++) {
      const x = rng.range(40, WORLD_W - 40);
      const r = rng.range(16, 52);
      if (this.vents.some((v) => Math.abs(v.x - x) < r + 60)) continue;
      if (this.rocks.some((k) => Math.hypot(k.x - x, k.y - this.floorY(x)) < (k.r + r) * 0.8)) continue;
      const type = rng.chance(0.18) ? ROCK_TYPES[4] : rng.pick(ROCK_TYPES.slice(0, 4));
      this.addRock(x, this.floorY(x) + r * 0.35, r, type, rng);
    }
    // a couple of rock spires reaching up into the water column
    for (let s = 0; s < 2; s++) {
      const x = rng.range(200, WORLD_W - 200);
      if (this.vents.some((v) => Math.abs(v.x - x) < 140)) continue;
      const type = rng.pick(ROCK_TYPES.slice(0, 4));
      let y = this.floorY(x);
      let r = rng.range(40, 55);
      for (let k = 0; k < 3; k++) {
        this.addRock(x + rng.range(-12, 12), y, r, type, rng);
        y -= r * 1.1;
        r *= 0.72;
      }
    }
  }

  addRock(x: number, y: number, r: number, type: RockType, rng: Rng): Rock {
    const rock: Rock = { id: this.nextId++, type, x, y, r, r0: r, seed: rng.next() * 100, released: 0, solidR: r };
    this.rocks.push(rock);
    return rock;
  }

  addVent(x: number, power: number): Vent {
    const v: Vent = { id: this.nextId++, x, y: this.floorY(x), power };
    this.vents.push(v);
    return v;
  }

  floorY(x: number): number {
    const fx = Math.max(0, Math.min(NFLOOR - 1.001, x / FLOOR_RES));
    const i = Math.floor(fx);
    const f = fx - i;
    return this.floor[i] * (1 - f) + this.floor[i + 1] * f;
  }
}
