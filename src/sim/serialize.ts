// Saving and restoring a whole world as plain JSON (typed arrays are base64-encoded).
import { Archetype, Genome } from './genome';
import { Organism } from './organism';
import { GodParams, NX, NY, defaultParams } from './params';
import { Species } from './species';
import { ROCK_TYPES } from './terrain';
import { World } from './world';

export const SAVE_VERSION = 2;

// ---------------------------------------------------------------------------
// helpers

function b64(a: Float32Array): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

function unb64(s: string): Float32Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

type GenomeJSON = {
  a: number[];
  d: number;
  t: number;
  tt: number;
  l: number;
  h: number;
  s: number[];
  m: number;
  o: number;
  x: number;
  n: number[][];
  c: (number | boolean)[][];
  ni: number;
  b: number[][];
};

export function encodeGenome(g: Genome): GenomeJSON {
  return {
    a: g.alloc.map(r5),
    d: r5(g.divMass),
    t: r5(g.tempOpt),
    tt: r5(g.tempTol),
    l: r5(g.lifespan),
    h: r5(g.hue),
    s: g.sig.map(r5),
    m: r5(g.mutRate),
    o: r5(g.oscFreq),
    x: r5(g.toxinRes),
    n: g.nodes.map((n) => [n.id, r5(n.order), r5(n.bias), n.act]),
    c: g.conns.map((c) => [c.from, c.to, r5(c.w), c.on]),
    ni: g.nextId,
    b: g.body.map((c) => [c.parent, r5(c.angle), c.type, r5(c.size)]),
  };
}

export function decodeGenome(j: GenomeJSON): Genome {
  return {
    alloc: j.a,
    divMass: j.d,
    tempOpt: j.t,
    tempTol: j.tt,
    lifespan: j.l,
    hue: j.h,
    sig: j.s,
    mutRate: j.m,
    oscFreq: j.o,
    toxinRes: j.x,
    nodes: j.n.map(([id, order, bias, act]) => ({ id, order, bias, act })),
    conns: j.c.map(([from, to, w, on]) => ({ from: from as number, to: to as number, w: w as number, on: !!on })),
    nextId: j.ni,
    body: (j.b ?? []).map(([parent, angle, type, size]) => ({ parent, angle, type, size })),
  };
}

// ---------------------------------------------------------------------------

export interface SaveMeta {
  version: number;
  seed: number;
  savedAt: string;
  day: number;
  population: number;
  species: number;
}

export function serializeWorld(w: World): Record<string, unknown> {
  const F = w.fields;
  const N = NX * NY;
  const P = w.particles;
  const n = P.n;
  const meta: SaveMeta = {
    version: SAVE_VERSION,
    seed: w.seed,
    savedAt: new Date().toISOString(),
    day: w.days + 1,
    population: w.orgs.length,
    species: w.species.alive().length,
  };
  return {
    meta,
    params: w.params,
    clock: { tick: w.tick, dayPhase: w.dayPhase, days: w.days, rng: w.rng.state },
    world: {
      nextOrgId: w.nextOrgId,
      eventSeq: w.eventSeq,
      sediment: w.sediment,
      totalBorn: w.totalBorn,
      totalDied: w.totalDied,
      deathCauses: [...w.deathCauses.entries()],
      archSpecies: [...w.archSpecies.entries()],
      events: w.events.slice(-60),
    },
    fields: {
      u: b64(F.u.subarray(0, N)),
      v: b64(F.v.subarray(0, N)),
      temp: b64(F.temp.subarray(0, N)),
      o2: b64(F.o2.subarray(0, N)),
      co2: b64(F.co2.subarray(0, N)),
      nut: b64(F.nut.subarray(0, N)),
      sulf: b64(F.sulf.subarray(0, N)),
      light: b64(F.light.subarray(0, N)),
      atmO2: F.atmO2,
      atmCO2: F.atmCO2,
      windPhase: F.windPhase,
      eddies: F.eddies,
    },
    terrain: {
      floor: b64(w.terrain.floor),
      nextId: w.terrain.nextId,
      rocks: w.terrain.rocks.map((r) => ({ id: r.id, type: r.type.key, x: r.x, y: r.y, r: r.r, r0: r.r0, seed: r.seed, released: r.released })),
      vents: w.terrain.vents,
    },
    particles: {
      n,
      nextUid: P.nextUid,
      x: b64(P.x.subarray(0, n)),
      y: b64(P.y.subarray(0, n)),
      c: b64(P.c.subarray(0, n)),
      nu: b64(P.nu.subarray(0, n)),
      age: b64(P.age.subarray(0, n)),
      rest: b64(P.rest.subarray(0, n)),
      uid: Array.from(P.uid.subarray(0, n)),
    },
    species: {
      nextId: w.species.nextId,
      all: w.species.all.map((s) => ({
        id: s.id,
        name: s.name,
        hue: s.hue,
        color: s.color,
        founder: encodeGenome(s.founder),
        parentId: s.parentId,
        born: s.born,
        extinct: s.extinct,
        peak: s.peak,
        total: s.total,
        role: s.role,
        announced: s.announced,
      })),
    },
    orgs: w.orgs.map((o) => ({
      id: o.id,
      g: encodeGenome(o.genome),
      sp: o.species,
      gen: o.generation,
      par: o.parent,
      born: o.born,
      s: [o.x, o.y, o.vx, o.vy, o.heading, o.mass, o.energy, o.nutrient, o.health, o.age, o.inflate, o.digesting].map(r5),
      r: [o.eLight, o.eChem, o.eFood, o.ePrey, o.kills, o.children, o.travelled].map(r5),
      nc: o.nCells,
      bv: Array.from(o.brain.values, r5),
    })),
    stats: w.stats.samples,
  };
}

export function deserializeWorld(d: any): World {
  if (!d || !d.meta || typeof d.meta.version !== 'number') throw new Error('This is not a Primordial save file.');
  if (d.meta.version > SAVE_VERSION) throw new Error('This save was made by a newer version of Primordial.');
  const params: GodParams = { ...defaultParams(), ...d.params };
  const w = new World(d.meta.seed, params, true);
  const N = NX * NY;

  w.tick = d.clock.tick;
  w.dayPhase = d.clock.dayPhase;
  w.days = d.clock.days;
  w.rng.state = d.clock.rng;

  // terrain
  w.terrain.floor.set(unb64(d.terrain.floor));
  w.terrain.nextId = d.terrain.nextId;
  w.terrain.rocks = d.terrain.rocks.map((r: any) => ({
    ...r,
    type: ROCK_TYPES.find((t) => t.key === r.type) ?? ROCK_TYPES[0],
    solidR: r.r,
  }));
  w.terrain.vents = d.terrain.vents;

  // water
  const F = w.fields;
  F.rebuildSolid(w.terrain);
  const fset = (dst: Float32Array, src: string) => dst.set(unb64(src).subarray(0, N));
  fset(F.u, d.fields.u);
  fset(F.v, d.fields.v);
  fset(F.temp, d.fields.temp);
  fset(F.o2, d.fields.o2);
  fset(F.co2, d.fields.co2);
  fset(F.nut, d.fields.nut);
  fset(F.sulf, d.fields.sulf);
  fset(F.light, d.fields.light);
  F.atmO2 = d.fields.atmO2;
  F.atmCO2 = d.fields.atmCO2;
  F.windPhase = d.fields.windPhase;
  F.eddies = d.fields.eddies ?? [];

  // detritus
  const P = w.particles;
  const pn = Math.min(P.cap, d.particles.n);
  P.n = pn;
  P.nextUid = d.particles.nextUid;
  P.x.set(unb64(d.particles.x).subarray(0, pn));
  P.y.set(unb64(d.particles.y).subarray(0, pn));
  P.c.set(unb64(d.particles.c).subarray(0, pn));
  P.nu.set(unb64(d.particles.nu).subarray(0, pn));
  P.age.set(unb64(d.particles.age).subarray(0, pn));
  P.rest.set(unb64(d.particles.rest).subarray(0, pn));
  P.uid.set(d.particles.uid.slice(0, pn));

  // species
  w.species.nextId = d.species.nextId;
  for (const s of d.species.all) {
    const sp: Species = { ...s, founder: decodeGenome(s.founder), count: 0 };
    w.species.all.push(sp);
    w.species.byId.set(sp.id, sp);
  }

  // organisms
  for (const j of d.orgs) {
    const [x, y, vx, vy, heading, mass, energy, nutrient, health, age, inflate, digesting] = j.s;
    const o = new Organism(j.id, decodeGenome(j.g), j.sp, j.gen, j.par, j.born, mass, energy, nutrient);
    Object.assign(o, { x, y, vx, vy, heading, health, age, inflate, digesting });
    [o.eLight, o.eChem, o.eFood, o.ePrey, o.kills, o.children, o.travelled] = j.r;
    if (j.nc) o.setDeveloped(j.nc);
    if (Array.isArray(j.bv) && j.bv.length === o.brain.values.length) o.brain.values.set(j.bv);
    w.orgs.push(o);
    w.orgById.set(o.id, o);
    const sp = w.species.get(o.species);
    if (sp) sp.count++;
  }

  const ws = d.world;
  w.nextOrgId = ws.nextOrgId;
  w.eventSeq = ws.eventSeq;
  w.sediment = ws.sediment;
  w.totalBorn = ws.totalBorn;
  w.totalDied = ws.totalDied;
  w.deathCauses = new Map(ws.deathCauses);
  w.archSpecies = new Map(ws.archSpecies as [Archetype, number][]);
  w.events = ws.events ?? [];
  w.stats.samples = d.stats ?? [];
  w.updateSun();
  w.log(`World restored: day ${w.days + 1}, ${w.orgs.length} organisms.`, 'info');
  return w;
}
