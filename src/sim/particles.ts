import { MAX_PARTICLES } from './params';
import { f32, i32 } from './shared';

/** Detritus: dead organic matter (marine snow). Structure-of-arrays for speed. */
export class Particles {
  n = 0;
  readonly cap = MAX_PARTICLES;
  x = f32(MAX_PARTICLES);
  y = f32(MAX_PARTICLES);
  c = f32(MAX_PARTICLES); // carbon (food energy)
  nu = f32(MAX_PARTICLES); // nutrients
  age = f32(MAX_PARTICLES);
  rest = f32(MAX_PARTICLES); // seconds resting on the floor
  uid = i32(MAX_PARTICLES);
  nextUid = 1;

  add(x: number, y: number, c: number, nu: number): boolean {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.c[i] = c;
    this.nu[i] = nu;
    this.age[i] = 0;
    this.rest[i] = 0;
    this.uid[i] = this.nextUid++;
    return true;
  }

  remove(i: number) {
    const last = --this.n;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.c[i] = this.c[last];
      this.nu[i] = this.nu[last];
      this.age[i] = this.age[last];
      this.rest[i] = this.rest[last];
      this.uid[i] = this.uid[last];
    }
  }

  indexOfUid(uid: number): number {
    for (let i = 0; i < this.n; i++) if (this.uid[i] === uid) return i;
    return -1;
  }
}
