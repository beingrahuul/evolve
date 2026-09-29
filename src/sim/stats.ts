import { A } from './genome';
import type { World } from './world';

export interface Sample {
  tick: number;
  pop: number;
  particles: number;
  species: [id: number, count: number][];
  speciesAlive: number;
  atmO2: number;
  atmCO2: number;
  meanTemp: number;
  biomass: number;
  photo: number;
  chemo: number;
  hetero: number;
}

export class Stats {
  samples: Sample[] = [];
  readonly max = 1200;

  record(w: World) {
    const counts = new Map<number, number>();
    let biomass = 0;
    let photo = 0;
    let chemo = 0;
    let hetero = 0;
    for (const o of w.orgs) {
      counts.set(o.species, (counts.get(o.species) ?? 0) + 1);
      biomass += o.mass;
      const f = o.frac;
      const p = f[A.chloro];
      const c = f[A.chemo];
      const m = f[A.mouth];
      if (m >= p && m >= c) hetero++;
      else if (p >= c) photo++;
      else chemo++;
    }
    const species = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    this.samples.push({
      tick: w.tick,
      pop: w.orgs.length,
      particles: w.particles.n,
      species,
      speciesAlive: species.length,
      atmO2: w.fields.atmO2,
      atmCO2: w.fields.atmCO2,
      meanTemp: w.fields.meanTemp,
      biomass,
      photo,
      chemo,
      hetero,
    });
    if (this.samples.length > this.max) this.samples.splice(0, this.samples.length - this.max);
  }

  last(): Sample | undefined {
    return this.samples[this.samples.length - 1];
  }
}
