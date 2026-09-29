import { Genome, NALLOC, effectiveFractions, genomeDistance, genomeRole } from './genome';
import { BIO } from './params';
import { Rng } from './rng';

export interface Species {
  id: number;
  name: string;
  hue: number;
  color: string;
  founder: Genome;
  parentId: number;
  born: number; // tick
  extinct: number; // tick, -1 while alive
  count: number;
  peak: number;
  total: number;
  role: string;
  announced: boolean;
}

const GENUS: string[][] = [
  ['Phyto', 'Chloro', 'Viridi', 'Helio', 'Lumi'], // chloro
  ['Thermo', 'Sulfo', 'Chemo', 'Pyro', 'Hydro'], // chemo
  ['Phago', 'Vora', 'Rapto', 'Lyco', 'Dino'], // mouth
  ['Mastigo', 'Flagello', 'Cursi', 'Veloci', 'Nauta'], // flagella
  ['Theca', 'Scuto', 'Lorica', 'Ostraco', 'Petro'], // armor
  ['Ophthal', 'Aistho', 'Ocello', 'Senso', 'Noö'], // sensor
  ['Aero', 'Physo', 'Vesi', 'Pneumo', 'Bullo'], // vacuole
  ['Lipo', 'Sacco', 'Nutri', 'Amylo', 'Pinguo'], // storage
  ['Rhizo', 'Terra', 'Xero', 'Geo', 'Humi'], // roots & cuticle
];
const SUFFIX = ['monas', 'coccus', 'bacter', 'zoon', 'cystis', 'phyta', 'plasma', 'ella', 'opsis', 'myces', 'nema', 'phora'];
const EP1 = ['vel', 'mar', 'ist', 'lor', 'cae', 'run', 'tal', 'phi', 'nox', 'sil', 'ver', 'amb', 'ori', 'qua', 'dra', 'sub', 'gel'];
const EP2 = ['is', 'a', 'um', 'ens', 'ata', 'ii', 'ica', 'ella', 'osa', 'ina', 'aris', 'ax'];

const tmp = new Float32Array(NALLOC);

const MULTI_SUFFIX = ['zoa', 'soma', 'colonia', 'phyton', 'derma', 'plax', 'sphaera'];

function makeName(g: Genome, rng: Rng): string {
  effectiveFractions(g, tmp);
  let best = 0;
  for (let i = 1; i < NALLOC; i++) if (tmp[i] > tmp[best]) best = i;
  const genus = rng.pick(GENUS[best]) + rng.pick(g.body.length >= 2 ? MULTI_SUFFIX : SUFFIX);
  const epithet = rng.pick(EP1) + (rng.chance(0.4) ? rng.pick(EP1) : '') + rng.pick(EP2);
  return `${genus} ${epithet}`;
}

export function hueColor(h: number, s = 0.62, l = 0.62): string {
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export class SpeciesRegistry {
  all: Species[] = [];
  byId = new Map<number, Species>();
  nextId = 1;

  create(founder: Genome, parentId: number, tick: number, rng: Rng): Species {
    effectiveFractions(founder, tmp);
    // daughter species get a colour near their parent's, so related lineages look related but distinct
    const parent = this.byId.get(parentId);
    const hue = parent ? (parent.hue + (rng.chance(0.5) ? 1 : -1) * rng.range(0.05, 0.13) + 1) % 1 : founder.hue;
    const sat = rng.range(0.5, 0.75);
    const light = rng.range(0.55, 0.7);
    const sp: Species = {
      id: this.nextId++,
      name: makeName(founder, rng),
      hue,
      color: hueColor(hue, sat, light),
      founder,
      parentId,
      born: tick,
      extinct: -1,
      count: 0,
      peak: 0,
      total: 0,
      role: founder.body.length >= 2 ? `Multicellular ${genomeRole(tmp).toLowerCase()}` : genomeRole(tmp),
      announced: false,
    };
    this.all.push(sp);
    this.byId.set(sp.id, sp);
    return sp;
  }

  /** Species for a newborn: its parent's, unless it has drifted too far from that species' founder. */
  assign(g: Genome, parentSpecies: number, tick: number, rng: Rng): Species {
    const parent = this.byId.get(parentSpecies);
    if (parent && genomeDistance(g, parent.founder) < BIO.SPECIES_THRESHOLD) return parent;
    return this.create(g, parent ? parent.id : 0, tick, rng);
  }

  alive(): Species[] {
    return this.all.filter((s) => s.count > 0);
  }

  get(id: number): Species | undefined {
    return this.byId.get(id);
  }
}

