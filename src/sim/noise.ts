import { Rng } from './rng';

/** Seeded 1D value noise in [-1, 1], used for terrain. */
export class Noise1D {
  private v: Float32Array;
  private mask: number;

  constructor(rng: Rng, size = 512) {
    this.v = new Float32Array(size);
    this.mask = size - 1;
    for (let i = 0; i < size; i++) this.v[i] = rng.next() * 2 - 1;
  }

  at(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.v[i & this.mask];
    const b = this.v[(i + 1) & this.mask];
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  }

  fbm(x: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.at(x * freq + o * 17.3) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
