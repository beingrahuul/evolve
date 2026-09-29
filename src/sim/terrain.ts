import { Rng } from './rng';
import { Noise1D } from './noise';
import { WORLD_W, WORLD_H, FLOOR_RES, NFLOOR, SKY_H } from './params';

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
  landRight = true;
  coastX = WORLD_W * 0.65;
  /** Bumped whenever the ground changes shape (the renderer re-uploads it). */
  version = 0;

  generate(rng: Rng) {
    const n1 = new Noise1D(rng);
    const n2 = new Noise1D(rng);
    // one side of the world rises out of the sea: continental shelf → beach → hills → mountains
    const n3 = new Noise1D(rng);
    this.landRight = rng.chance(0.5);
    this.coastX = this.landRight ? rng.range(0.6, 0.7) * WORLD_W : rng.range(0.3, 0.4) * WORLD_W;
    const SHELF = 820;
    const peak = rng.range(230, 330);
    for (let i = 0; i < NFLOOR; i++) {
      const x = i * FLOOR_RES;
      const inland = this.landRight ? x - this.coastX : this.coastX - x;
      let ocean = WORLD_H - 95 - 60 * n1.fbm(x / 420, 4) - 18 * n2.fbm(x / 70, 3);
      // the far ocean wall still curves up gently so the basin reads as a basin
      const seaEdge = (this.landRight ? x : WORLD_W - x) / WORLD_W;
      ocean -= Math.max(0, 0.1 - seaEdge) * 500;
      ocean = Math.max(WORLD_H - 230, Math.min(WORLD_H - 25, ocean));
      let y: number;
      if (inland < -SHELF) y = ocean;
      else if (inland < 0) {
        // continental slope, then a sunlit shelf, then the shallows
        const t = (inland + SHELF) / SHELF;
        const shelf = 150 + 25 * n3.at(x / 90);
        if (t < 0.55) {
          const k = t / 0.55;
          const s = k * k * (3 - 2 * k);
          y = ocean + (shelf - ocean) * s;
        } else {
          const k = (t - 0.55) / 0.45;
          const s = k * k * (3 - 2 * k);
          y = shelf + (14 + 6 * n3.at(x / 40) - shelf) * s;
        }
      } else if (inland < 100) {
        // beach: gently rising sand through the tidal zone
        y = 14 - inland * 0.36 + 2 * n3.at(x / 30);
      } else {
        // hills and mountains
        const t = Math.min(1, (inland - 100) / 520);
        const k = t * t * (3 - 2 * t);
        y = -22 - peak * k - 45 * k * n1.fbm(x / 180 + 7, 4) - 12 * n2.fbm(x / 40 + 3, 3);
      }
      this.floor[i] = Math.max(-SKY_H + 90, Math.min(WORLD_H - 25, y));
    }

    // hydrothermal vents
    const ventCount = 2 + rng.int(2);
    for (let tries = 0; this.vents.length < ventCount && tries < 400; tries++) {
      const x = rng.range(160, WORLD_W - 160);
      if (this.floorY(x) < WORLD_H * 0.6) continue;
      if (this.vents.some((v) => Math.abs(v.x - x) < 300)) continue;
      this.addVent(x, rng.range(0.8, 1.2));
    }

    // boulders
    const nRocks = 9 + rng.int(5);
    for (let tries = 0; this.rocks.length < nRocks && tries < 400; tries++) {
      const x = rng.range(40, WORLD_W - 40);
      const r = rng.range(16, 52);
      if (this.floorY(x) < 120) continue;
      if (this.vents.some((v) => Math.abs(v.x - x) < r + 60)) continue;
      if (this.rocks.some((k) => Math.hypot(k.x - x, k.y - this.floorY(x)) < (k.r + r) * 0.8)) continue;
      const type = rng.chance(0.18) ? ROCK_TYPES[4] : rng.pick(ROCK_TYPES.slice(0, 4));
      this.addRock(x, this.floorY(x) + r * 0.35, r, type, rng);
    }
    // a couple of rock spires reaching up into the water column
    for (let s = 0; s < 2; s++) {
      const x = rng.range(200, WORLD_W - 200);
      if (this.floorY(x) < WORLD_H * 0.6) continue;
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

  /** Is there open water at x (sea floor well below the given sea level)? */
  isOcean(x: number, seaLevel = 0, margin = 30): boolean {
    return this.floorY(x) > seaLevel + margin;
  }

  /** God power: raise (dy < 0) or lower (dy > 0) the ground around x. */
  terraform(x: number, r: number, dy: number) {
    const i0 = Math.max(0, Math.floor((x - r) / FLOOR_RES));
    const i1 = Math.min(NFLOOR - 1, Math.ceil((x + r) / FLOOR_RES));
    for (let i = i0; i <= i1; i++) {
      const d = Math.abs(i * FLOOR_RES - x) / r;
      if (d >= 1) continue;
      const fall = 0.5 + 0.5 * Math.cos(d * Math.PI);
      this.floor[i] = Math.max(-SKY_H + 60, Math.min(WORLD_H - 20, this.floor[i] + dy * fall));
    }
    for (const v of this.vents) v.y = this.floorY(v.x);
    this.version++;
  }

  floorY(x: number): number {
    const fx = Math.max(0, Math.min(NFLOOR - 1.001, x / FLOOR_RES));
    const i = Math.floor(fx);
    const f = fx - i;
    return this.floor[i] * (1 - f) + this.floor[i + 1] * f;
  }
}
