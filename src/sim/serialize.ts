// Saving and restoring a whole world as plain JSON (typed arrays are base64-encoded).
import { Archetype, Genome, NALLOC, NI, NO, NodeGene } from './genome';
import { Organism } from './organism';
import { AIR_NX, AIR_NY, GodParams, NX, NY, defaultParams, setWorldWidth } from './params';
import { Species } from './species';
import { ROCK_TYPES } from './terrain';
import { World } from './world';

export const SAVE_VERSION = 4;

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
  sx?: number;
  ln?: number;
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
    sx: r5(g.sex),
    ln: r5(g.learn),
    n: g.nodes.map((n) => [n.id, r5(n.order), r5(n.bias), n.act]),
    c: g.conns.map((c) => (c.p ? [c.from, c.to, r5(c.w), c.on, r5(c.p)] : [c.from, c.to, r5(c.w), c.on])),
    ni: g.nextId,
    b: g.body.map((c) => [c.parent, r5(c.angle), c.type, r5(c.size)]),
  };
}

/** Renumber a genome's neurons (inputs come first, so new senses shift everything after them). */
function renumber(j: GenomeJSON, shift: (id: number) => number, grow: number): GenomeJSON {
  return {
    ...j,
    n: j.n.map(([id, order, bias, act]) => [shift(id), order, bias, act]),
    c: j.c.map(([from, to, ...rest]) => [shift(from as number), shift(to as number), ...rest]),
    ni: j.ni + grow,
  };
}

/**
 * Version 2 had 29 senses (3 were added in version 3); version 3 had 32 senses and 5 actions
 * (version 4 added 7 senses and 2 actions: pheromones, kin glow, mating).
 */
function migrateGenome(j: GenomeJSON, version: number): GenomeJSON {
  if (version < 3) j = renumber(j, (id) => (id >= 29 ? id + 3 : id), 3);
  if (version < 4) j = renumber(j, (id) => (id < 32 ? id : id < 37 ? id + 7 : id + 9), 9);
  return j;
}

export function decodeGenome(j: GenomeJSON, version = SAVE_VERSION): Genome {
  j = migrateGenome(j, version);
  const alloc = j.a.slice();
  while (alloc.length < NALLOC) alloc.push(0.01);
  return {
    alloc,
    divMass: j.d,
    tempOpt: j.t,
    tempTol: j.tt,
    lifespan: j.l,
    hue: j.h,
    sig: j.s,
    mutRate: j.m,
    oscFreq: j.o,
    toxinRes: j.x,
    sex: j.sx ?? 0,
    learn: j.ln ?? 0,
    nodes: withOutputs(j.n.map(([id, order, bias, act]) => ({ id, order, bias, act }))),
    conns: j.c.map(([from, to, w, on, p]) => ({ from: from as number, to: to as number, w: w as number, on: !!on, p: (p as number) ?? 0 })),
    nextId: j.ni,
    body: (j.b ?? []).map(([parent, angle, type, size]) => ({ parent, angle, type, size })),
  };
}

/** Output neurons first, in order (actions added since the save was made start unconnected). */
function withOutputs(nodes: NodeGene[]): NodeGene[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outs: NodeGene[] = [];
  for (let k = 0; k < NO; k++) outs.push(byId.get(NI + k) ?? { id: NI + k, order: 1, bias: 0, act: 0 });
  return outs.concat(nodes.filter((n) => n.id >= NI + NO));
}

// ---------------------------------------------------------------------------

export interface SaveMeta {
  version: number;
  seed: number;
  /** World width (version 4; older worlds are 1920 wide). */
  width?: number;
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
    width: w.width,
    savedAt: new Date().toISOString(),
    day: w.days + 1,
    population: w.orgs.length,
    species: w.species.alive().length,
  };
  return {
    meta,
    params: w.params,
    clock: { tick: w.tick, dayPhase: w.dayPhase, days: w.days, rng: w.rng.state, envRng: w.envRng },
    world: {
      nextOrgId: w.nextOrgId,
      eventSeq: w.eventSeq,
      sediment: w.sediment,
      totalBorn: w.totalBorn,
      totalDied: w.totalDied,
      totalMatings: w.totalMatings,
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
      sigA: b64(F.sigA.subarray(0, N)),
      sigB: b64(F.sigB.subarray(0, N)),
      light: b64(F.light.subarray(0, N)),
      atmO2: F.atmO2,
      atmCO2: F.atmCO2,
      eddies: F.eddies,
    },
    air: {
      u: b64(w.atmosphere.u.subarray(0, AIR_NX * AIR_NY)),
      v: b64(w.atmosphere.v.subarray(0, AIR_NX * AIR_NY)),
      temp: b64(w.atmosphere.temp.subarray(0, AIR_NX * AIR_NY)),
      hum: b64(w.atmosphere.hum.subarray(0, AIR_NX * AIR_NY)),
      cloud: b64(w.atmosphere.cloud.subarray(0, AIR_NX * AIR_NY)),
      rain: b64(w.atmosphere.rain),
      weatherPhase: w.atmosphere.weatherPhase,
      stormTimer: w.atmosphere.stormTimer,
    },
    soil: {
      moisture: b64(w.soil.moisture),
      nutrient: b64(w.soil.nutrient),
      organic: b64(w.soil.organic),
      temp: b64(w.soil.temp),
      snow: b64(w.soil.snow),
    },
    terrain: {
      landRight: w.terrain.landRight,
      coastX: w.terrain.coastX,
      shores: w.terrain.shores,
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
      hy: r5(o.hydration),
      bv: Array.from(o.brain.values, r5),
      // sex and learning (version 4): courting, since mating, father, mates, expected intake, learned weights
      x4: [o.courting, Math.min(o.sinceMating, 1e6), o.father, o.mates, o.gainSlow].map(r5),
      bw: o.genome.learn > 0 && o.brain.plasticCount > 0 ? Array.from(o.brain.cW, r5) : undefined,
    })),
    stats: w.stats.samples,
  };
}

export function deserializeWorld(d: any): World {
  if (!d || !d.meta || typeof d.meta.version !== 'number') throw new Error('This is not a Primordial save file.');
  if (d.meta.version > SAVE_VERSION) throw new Error('This save was made by a newer version of Primordial.');
  const params: GodParams = { ...defaultParams(), ...d.params };
  setWorldWidth(d.meta.width ?? 1920);
  const w = new World(d.meta.seed, params, true);
  const version: number = d.meta.version;
  const N = NX * NY;

  w.tick = d.clock.tick;
  w.dayPhase = d.clock.dayPhase;
  w.days = d.clock.days;
  w.rng.state = d.clock.rng;
  if (d.clock.envRng) w.envRng = d.clock.envRng;

  // terrain
  w.terrain.floor.set(unb64(d.terrain.floor));
  w.terrain.nextId = d.terrain.nextId;
  w.terrain.rocks = d.terrain.rocks.map((r: any) => ({
    ...r,
    type: ROCK_TYPES.find((t) => t.key === r.type) ?? ROCK_TYPES[0],
    solidR: r.r,
  }));
  w.terrain.vents = d.terrain.vents;
  if (d.terrain.coastX !== undefined) {
    w.terrain.landRight = d.terrain.landRight;
    w.terrain.coastX = d.terrain.coastX;
    w.terrain.shores = d.terrain.shores ?? [{ x: w.terrain.coastX, dir: w.terrain.landRight ? 1 : -1 }];
  } else {
    // a version-2 world is all ocean
    w.terrain.landRight = true;
    w.terrain.coastX = 1e6;
  }
  w.updateSun();

  // water (version 2 grids started at y = 0: three rows lower)
  const F = w.fields;
  const sl = w.tideLevel();
  F.init(w.terrain, sl);
  const rowShift = version >= 3 ? 0 : 3;
  const fset = (dst: Float32Array, src: string) => {
    const a = unb64(src);
    if (!rowShift) dst.set(a.subarray(0, N));
    else {
      const oldN = a.length;
      dst.set(a.subarray(0, Math.min(oldN, N - rowShift * NX)), rowShift * NX);
      for (let k = 0; k < rowShift * NX; k++) dst[k] = a[k % NX];
    }
  };
  fset(F.u, d.fields.u);
  fset(F.v, d.fields.v);
  fset(F.temp, d.fields.temp);
  fset(F.o2, d.fields.o2);
  fset(F.co2, d.fields.co2);
  fset(F.nut, d.fields.nut);
  fset(F.sulf, d.fields.sulf);
  if (d.fields.sigA) fset(F.sigA, d.fields.sigA);
  if (d.fields.sigB) fset(F.sigB, d.fields.sigB);
  fset(F.light, d.fields.light);
  F.atmO2 = d.fields.atmO2;
  F.atmCO2 = d.fields.atmCO2;
  F.eddies = d.fields.eddies ?? [];

  // air and soil
  const A = w.atmosphere;
  A.init(w.terrain, sl, 16 + params.tempOffset);
  if (d.air) {
    const n = AIR_NX * AIR_NY;
    A.u.set(unb64(d.air.u).subarray(0, n));
    A.v.set(unb64(d.air.v).subarray(0, n));
    A.temp.set(unb64(d.air.temp).subarray(0, n));
    A.hum.set(unb64(d.air.hum).subarray(0, n));
    A.cloud.set(unb64(d.air.cloud).subarray(0, n));
    A.rain.set(unb64(d.air.rain).subarray(0, AIR_NX));
    A.weatherPhase = d.air.weatherPhase;
    A.stormTimer = d.air.stormTimer;
  }
  if (d.soil) {
    w.soil.moisture.set(unb64(d.soil.moisture));
    w.soil.nutrient.set(unb64(d.soil.nutrient));
    w.soil.organic.set(unb64(d.soil.organic));
    w.soil.temp.set(unb64(d.soil.temp));
    w.soil.snow.set(unb64(d.soil.snow));
  } else w.initSoil();

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
    const sp: Species = { ...s, founder: decodeGenome(s.founder, version), count: 0 };
    w.species.all.push(sp);
    w.species.byId.set(sp.id, sp);
  }

  // organisms
  for (const j of d.orgs) {
    const [x, y, vx, vy, heading, mass, energy, nutrient, health, age, inflate, digesting] = j.s;
    const o = new Organism(j.id, decodeGenome(j.g, version), j.sp, j.gen, j.par, j.born, mass, energy, nutrient);
    Object.assign(o, { x, y, vx, vy, heading, health, age, inflate, digesting });
    [o.eLight, o.eChem, o.eFood, o.ePrey, o.kills, o.children, o.travelled] = j.r;
    if (j.nc) o.setDeveloped(j.nc);
    if (typeof j.hy === 'number') o.hydration = j.hy;
    o.onLand = !(o.y > F.seaLevel && w.terrain.floorY(o.x) > F.seaLevel);
    if (Array.isArray(j.bv) && j.bv.length === o.brain.values.length) o.brain.values.set(j.bv);
    if (Array.isArray(j.x4)) [o.courting, o.sinceMating, o.father, o.mates, o.gainSlow] = j.x4;
    if (Array.isArray(j.bw)) o.brain.setWeights(j.bw);
    o.intakeMark = o.eLight + o.eChem + o.eFood + o.ePrey;
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
  w.totalMatings = ws.totalMatings ?? 0;
  w.deathCauses = new Map(ws.deathCauses);
  w.archSpecies = new Map(ws.archSpecies as [Archetype, number][]);
  w.events = ws.events ?? [];
  w.stats.samples = d.stats ?? [];
  w.log(`World restored: day ${w.days + 1}, ${w.orgs.length} organisms.`, 'info');
  return w;
}
