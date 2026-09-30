// Keeping a copy of the world on the main thread in step with the one simulated in the worker.
//
// The worker owns the real world. Every frame it packs what the renderer and the panels read into
// typed arrays (transferred, not copied) plus the few things that are new since the last frame
// (organisms born, species formed, events, stats samples). The main thread unpacks this into a
// "mirror" World that is never stepped, so the renderer and UI can keep reading a World as before.
import type { Command } from './commands';
import type { Genome } from './genome';
import { Organism } from './organism';
import { AIR_NX, AIR_NY, FIELD_EVERY, GodParams, NSOIL, NX, NY } from './params';
import type { Bolt } from './atmosphere';
import type { Species } from './species';
import type { Sample } from './stats';
import { ROCK_TYPES } from './terrain';
import type { World, WorldEvent } from './world';

// ---------------------------------------------------------------------------
// Messages

export type ToWorker =
  | { type: 'threads'; pool: number; kernels: number }
  | { type: 'new'; seed: number; width: number; params?: GodParams }
  | { type: 'load'; id: number; blob: Blob }
  | { type: 'save'; id: number }
  | { type: 'cmd'; gen: number; cmd: Command }
  | { type: 'frame'; speed: number; paused: boolean; selected: number; returned: ArrayBuffer[] }
  | { type: 'step' };

export type FromWorker =
  | { type: 'reset'; gen: number; seed: number; width: number; params: GodParams; snap: Snapshot }
  | { type: 'frame'; snap: Snapshot }
  | { type: 'saved'; id: number; blob?: Blob; error?: string }
  | { type: 'loaded'; id: number; error?: string }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Snapshot layout

/** Floats per organism (see packOrg / unpackOrg). */
const ORG_F = 35;
/** Water fields sent: u, v, temp, o2, co2, nut, sulf, light, sigA, sigB. */
const WATER_K = 10;
/** Air fields: u, v, temp, hum, cloud (per cell), then rain and shade (per column). */
const AIR_K = 5;
/** Soil fields: moisture, nutrient, organic, temp, snow, canopy, land, wetness. */
const SOIL_K = 8;
const ROCK_F = 8;
const SPECIES_F = 6;

interface BornRecord {
  id: number;
  genome: Genome;
  species: number;
  generation: number;
  parent: number;
  father: number;
  born: number;
}

interface EnvSnapshot {
  water: Float32Array;
  /** seaLevel, atmO2, atmCO2, meanTemp */
  sea: number[];
  air: Float32Array;
  /** weatherPhase, stormTimer, climateT */
  sky: number[];
  soil: Float32Array;
  rocks: number[];
  terrainVersion: number;
  floor?: Float32Array;
  coast?: { landRight: boolean; coastX: number; shores: { x: number; dir: number }[]; nextId: number };
}

export interface Snapshot {
  gen: number;
  /** tick, dayPhase, days, sunNow, sunElev */
  clock: number[];
  /** ticks per real second, ms per tick, threads simulating (measured in the worker) */
  perf: number[];
  /** totalBorn, totalDied, totalMatings, sediment carbon, sediment nutrients, nextOrgId */
  totals: number[];
  env?: EnvSnapshot;
  /** id, x, y, power for each vent */
  vents: number[];
  bolt: Bolt | null;
  particles?: { n: number; nextUid: number; f: Float32Array; uid: Int32Array };
  orgs?: { n: number; f: Float32Array; ids: Int32Array; born: BornRecord[]; genomes: [number, Genome][] };
  species: { add: Species[]; upd: number[] };
  stats: Sample[];
  events: WorldEvent[];
  /** The organism the player is looking at: live brain activity and learned weights, or how it died. */
  sel?: { id: number; values?: Float32Array; weights?: Float32Array; cause?: string };
  /** Ask the UI to select this organism (one the player just created). */
  select?: number;
}

// ---------------------------------------------------------------------------
// Worker side

/** Recycles the buffers the main thread sends back, so frames do not churn the garbage collector. */
class BufferPool {
  private free = new Map<number, ArrayBuffer[]>();

  private buffer(bytes: number): ArrayBuffer {
    let size = 1024;
    while (size < bytes) size *= 2;
    return this.free.get(size)?.pop() ?? new ArrayBuffer(size);
  }

  f32(n: number): Float32Array {
    return new Float32Array(this.buffer(n * 4), 0, n);
  }

  i32(n: number): Int32Array {
    return new Int32Array(this.buffer(n * 4), 0, n);
  }

  give(bufs: ArrayBuffer[]) {
    for (const b of bufs) {
      const list = this.free.get(b.byteLength) ?? [];
      if (list.length < 6) list.push(b);
      this.free.set(b.byteLength, list);
    }
  }
}

export interface BuildOptions {
  gen: number;
  /** Everything, for a world the main thread has not seen yet. */
  full: boolean;
  /** Anything changed since the last snapshot (ticks ran or commands were applied)? */
  changed: boolean;
  selected: number;
  perf: number[];
  select?: number;
}

/** Builds snapshots of a world for the main thread, remembering what it has already sent. */
export class SyncSource {
  readonly pool = new BufferPool();
  /** Set when a command may have changed the environment (terrain, fields, rocks…). */
  envDirty = true;
  private envStep = -1;
  private terrainVersion = -1;
  private species = new Map<number, string>();
  /** Extinct species already sent in their final state (skipped until they come back). */
  private settled = new Set<number>();
  private statTick = -1;
  private eventSeq = 0;

  /** Forget what was sent (a new world). */
  reset() {
    this.envDirty = true;
    this.envStep = -1;
    this.terrainVersion = -1;
    this.species.clear();
    this.settled.clear();
    this.statTick = -1;
    this.eventSeq = 0;
  }

  build(w: World, opt: BuildOptions): { snap: Snapshot; transfer: ArrayBuffer[] } {
    const transfer: ArrayBuffer[] = [];
    const f32 = (n: number) => {
      const a = this.pool.f32(n);
      transfer.push(a.buffer as ArrayBuffer);
      return a;
    };
    const snap: Snapshot = {
      gen: opt.gen,
      clock: [w.tick, w.dayPhase, w.days, w.sunNow, w.sunElev],
      perf: opt.perf,
      totals: [w.totalBorn, w.totalDied, w.totalMatings, w.sediment.c, w.sediment.nu, w.nextOrgId],
      vents: w.terrain.vents.flatMap((v) => [v.id, v.x, v.y, v.power]),
      bolt: w.atmosphere.bolt,
      species: this.speciesChanges(w),
      stats: [],
      events: [],
      select: opt.select,
    };
    for (const s of w.stats.samples) if (s.tick > this.statTick) snap.stats.push(s);
    if (snap.stats.length) this.statTick = snap.stats[snap.stats.length - 1].tick;
    for (const e of w.events) if (e.seq > this.eventSeq) snap.events.push(e);
    if (snap.events.length) this.eventSeq = snap.events[snap.events.length - 1].seq;

    const envStep = Math.floor(w.tick / FIELD_EVERY);
    if (opt.full || this.envDirty || envStep !== this.envStep) {
      snap.env = this.env(w, f32, opt.full);
      this.envDirty = false;
      this.envStep = envStep;
    }
    if (opt.full || opt.changed) {
      snap.particles = this.particles(w, f32, transfer);
      snap.orgs = this.orgs(w, f32, transfer);
    }
    const sel = opt.selected;
    if (sel > 0) {
      const o = w.orgById.get(sel);
      if (o) snap.sel = { id: sel, values: Float32Array.from(o.brain.values), weights: Float32Array.from(o.brain.cW) };
      else if (w.recentDeaths.has(sel)) snap.sel = { id: sel, cause: w.recentDeaths.get(sel) };
    }
    return { snap, transfer };
  }

  private env(w: World, f32: (n: number) => Float32Array, full: boolean): EnvSnapshot {
    const F = w.fields;
    const N = NX * NY;
    const water = f32(N * WATER_K);
    [F.u, F.v, F.temp, F.o2, F.co2, F.nut, F.sulf, F.light, F.sigA, F.sigB].forEach((a, k) => water.set(a.subarray(0, N), k * N));
    const A = w.atmosphere;
    const AN = AIR_NX * AIR_NY;
    const air = f32(AN * AIR_K + AIR_NX * 2);
    [A.u, A.v, A.temp, A.hum, A.cloud].forEach((a, k) => air.set(a.subarray(0, AN), k * AN));
    air.set(A.rain, AN * AIR_K);
    air.set(A.shade, AN * AIR_K + AIR_NX);
    const S = w.soil;
    const soil = f32(NSOIL * SOIL_K);
    [S.moisture, S.nutrient, S.organic, S.temp, S.snow, S.canopy, S.land, S.wetness].forEach((a, k) => soil.set(a, k * NSOIL));
    const T = w.terrain;
    const env: EnvSnapshot = {
      water,
      sea: [F.seaLevel, F.atmO2, F.atmCO2, F.meanTemp],
      air,
      sky: [A.weatherPhase, A.stormTimer, A.climateT],
      soil,
      rocks: T.rocks.flatMap((r) => [r.id, Math.max(0, ROCK_TYPES.indexOf(r.type)), r.x, r.y, r.r, r.r0, r.seed, r.released]),
      terrainVersion: T.version,
    };
    if (full || T.version !== this.terrainVersion) {
      env.floor = f32(T.floor.length);
      env.floor.set(T.floor);
      this.terrainVersion = T.version;
    }
    if (full) env.coast = { landRight: T.landRight, coastX: T.coastX, shores: T.shores, nextId: T.nextId };
    return env;
  }

  private particles(w: World, f32: (n: number) => Float32Array, transfer: ArrayBuffer[]) {
    const P = w.particles;
    const n = P.n;
    const f = f32(n * 6);
    [P.x, P.y, P.c, P.nu, P.age, P.rest].forEach((a, k) => f.set(a.subarray(0, n), k * n));
    const uid = this.pool.i32(n);
    uid.set(P.uid.subarray(0, n));
    transfer.push(uid.buffer as ArrayBuffer);
    return { n, nextUid: P.nextUid, f, uid };
  }

  private orgs(w: World, f32: (n: number) => Float32Array, transfer: ArrayBuffer[]) {
    const n = w.orgs.length;
    const f = f32(n * ORG_F);
    const ids = this.pool.i32(n * 2);
    transfer.push(ids.buffer as ArrayBuffer);
    const born: BornRecord[] = [];
    const genomes: [number, Genome][] = [];
    for (let i = 0; i < n; i++) {
      const o = w.orgs[i];
      if (!o.synced) {
        o.synced = true;
        o.genomeDirty = false;
        born.push({ id: o.id, genome: o.genome, species: o.species, generation: o.generation, parent: o.parent, father: o.father, born: o.born });
      } else if (o.genomeDirty) {
        o.genomeDirty = false;
        genomes.push([o.id, o.genome]);
      }
      ids[i * 2] = o.id;
      ids[i * 2 + 1] = o.species;
      packOrg(o, f, i * ORG_F);
    }
    return { n, f, ids, born, genomes };
  }

  private speciesChanges(w: World) {
    const add: Species[] = [];
    const upd: number[] = [];
    for (const sp of w.species.all) {
      if (sp.count === 0 && this.settled.has(sp.id)) continue;
      const key = `${sp.count},${sp.peak},${sp.total},${sp.extinct},${sp.announced ? 1 : 0}`;
      const prev = this.species.get(sp.id);
      if (prev !== key) {
        if (prev === undefined) add.push(sp);
        else upd.push(sp.id, sp.count, sp.peak, sp.total, sp.extinct, sp.announced ? 1 : 0);
        this.species.set(sp.id, key);
      }
      if (sp.count === 0 && sp.extinct >= 0) this.settled.add(sp.id);
      else this.settled.delete(sp.id);
    }
    return { add, upd };
  }
}

function packOrg(o: Organism, f: Float32Array, b: number) {
  f[b] = o.x;
  f[b + 1] = o.y;
  f[b + 2] = o.vx;
  f[b + 3] = o.vy;
  f[b + 4] = o.heading;
  f[b + 5] = o.mass;
  f[b + 6] = o.energy;
  f[b + 7] = o.nutrient;
  f[b + 8] = o.health;
  f[b + 9] = o.age;
  f[b + 10] = o.hydration;
  f[b + 11] = (o.onLand ? 1 : 0) + (o.eating ? 2 : 0);
  f[b + 12] = o.thrust;
  f[b + 13] = o.turn;
  f[b + 14] = o.glow;
  f[b + 15] = o.touching;
  f[b + 16] = o.pain;
  f[b + 17] = o.digesting;
  f[b + 18] = o.inflate;
  f[b + 19] = o.nCells;
  f[b + 20] = o.topY;
  f[b + 21] = o.eLight;
  f[b + 22] = o.eChem;
  f[b + 23] = o.eFood;
  f[b + 24] = o.ePrey;
  f[b + 25] = o.kills;
  f[b + 26] = o.children;
  f[b + 27] = o.travelled;
  f[b + 28] = o.courting;
  f[b + 29] = Math.min(o.sinceMating, 1e9);
  f[b + 30] = o.mates;
  f[b + 31] = o.emitA;
  f[b + 32] = o.emitB;
  f[b + 33] = o.reward;
  f[b + 34] = o.gainSlow;
}

function unpackOrg(o: Organism, f: Float32Array, b: number) {
  o.x = f[b];
  o.y = f[b + 1];
  o.vx = f[b + 2];
  o.vy = f[b + 3];
  o.heading = f[b + 4];
  const mass = f[b + 5];
  o.energy = f[b + 6];
  o.nutrient = f[b + 7];
  o.health = f[b + 8];
  o.age = f[b + 9];
  o.hydration = f[b + 10];
  const flags = f[b + 11];
  o.onLand = (flags & 1) !== 0;
  o.eating = (flags & 2) !== 0;
  o.thrust = f[b + 12];
  o.turn = f[b + 13];
  o.glow = f[b + 14];
  o.touching = f[b + 15];
  o.pain = f[b + 16];
  o.digesting = f[b + 17];
  o.inflate = f[b + 18];
  const nCells = f[b + 19];
  o.topY = f[b + 20];
  o.eLight = f[b + 21];
  o.eChem = f[b + 22];
  o.eFood = f[b + 23];
  o.ePrey = f[b + 24];
  o.kills = f[b + 25];
  o.children = f[b + 26];
  o.travelled = f[b + 27];
  o.courting = f[b + 28];
  o.sinceMating = f[b + 29];
  o.mates = f[b + 30];
  o.emitA = f[b + 31];
  o.emitB = f[b + 32];
  o.reward = f[b + 33];
  o.gainSlow = f[b + 34];
  if (mass !== o.mass) {
    o.mass = mass;
    o.updateSize();
  }
  if (nCells !== o.nCells) o.setDeveloped(nCells);
}

// ---------------------------------------------------------------------------
// Main-thread side

let syncFrame = 0;

/**
 * Bring a mirror world up to date. Returns the buffers it has finished with (to hand back to the
 * worker for reuse).
 */
export function applySnapshot(w: World, s: Snapshot): ArrayBuffer[] {
  const done: ArrayBuffer[] = [];
  [w.tick, w.dayPhase, w.days, w.sunNow, w.sunElev] = s.clock;
  [w.totalBorn, w.totalDied, w.totalMatings, w.sediment.c, w.sediment.nu, w.nextOrgId] = s.totals;

  const T = w.terrain;
  if (s.env) {
    const e = s.env;
    const F = w.fields;
    [F.seaLevel, F.atmO2, F.atmCO2, F.meanTemp] = e.sea;
    const N = NX * NY;
    [F.u, F.v, F.temp, F.o2, F.co2, F.nut, F.sulf, F.light, F.sigA, F.sigB].forEach((a, k) => a.set(e.water.subarray(k * N, (k + 1) * N)));
    if (e.coast) {
      T.landRight = e.coast.landRight;
      T.coastX = e.coast.coastX;
      T.shores = e.coast.shores;
      T.nextId = e.coast.nextId;
    }
    if (e.floor) {
      T.floor.set(e.floor);
      T.version = e.terrainVersion;
      done.push(e.floor.buffer as ArrayBuffer);
    }
    const rocks = [];
    for (let i = 0; i < e.rocks.length; i += ROCK_F) {
      const [id, type, x, y, r, r0, seed, released] = e.rocks.slice(i, i + ROCK_F);
      rocks.push({ id, type: ROCK_TYPES[type] ?? ROCK_TYPES[0], x, y, r, r0, seed, released, solidR: r });
    }
    T.rocks = rocks;
    const A = w.atmosphere;
    const AN = AIR_NX * AIR_NY;
    [A.u, A.v, A.temp, A.hum, A.cloud].forEach((a, k) => a.set(e.air.subarray(k * AN, (k + 1) * AN)));
    A.rain.set(e.air.subarray(AN * AIR_K, AN * AIR_K + AIR_NX));
    A.shade.set(e.air.subarray(AN * AIR_K + AIR_NX, AN * AIR_K + AIR_NX * 2));
    [A.weatherPhase, A.stormTimer, A.climateT] = e.sky;
    A.rebuild(T, F.seaLevel);
    const S = w.soil;
    [S.moisture, S.nutrient, S.organic, S.temp, S.snow, S.canopy, S.land, S.wetness].forEach((a, k) =>
      a.set(e.soil.subarray(k * NSOIL, (k + 1) * NSOIL)),
    );
    done.push(e.water.buffer as ArrayBuffer, e.air.buffer as ArrayBuffer, e.soil.buffer as ArrayBuffer);
  }
  const vents = [];
  for (let i = 0; i < s.vents.length; i += 4) vents.push({ id: s.vents[i], x: s.vents[i + 1], y: s.vents[i + 2], power: s.vents[i + 3] });
  T.vents = vents;
  w.atmosphere.bolt = s.bolt;

  if (s.particles) {
    const p = s.particles;
    const P = w.particles;
    const n = Math.min(p.n, P.cap);
    P.n = n;
    P.nextUid = p.nextUid;
    [P.x, P.y, P.c, P.nu, P.age, P.rest].forEach((a, k) => a.set(p.f.subarray(k * p.n, k * p.n + n)));
    P.uid.set(p.uid.subarray(0, n));
    done.push(p.f.buffer as ArrayBuffer, p.uid.buffer as ArrayBuffer);
  }

  // species before organisms, so newborns find theirs
  for (const sp of s.species.add) {
    const have = w.species.get(sp.id);
    if (have) Object.assign(have, sp);
    else {
      w.species.all.push(sp);
      w.species.byId.set(sp.id, sp);
    }
  }
  const u = s.species.upd;
  for (let i = 0; i < u.length; i += SPECIES_F) {
    const sp = w.species.get(u[i]);
    if (!sp) continue;
    sp.count = u[i + 1];
    sp.peak = u[i + 2];
    sp.total = u[i + 3];
    sp.extinct = u[i + 4];
    sp.announced = u[i + 5] === 1;
  }
  if (w.species.all.length) w.species.nextId = Math.max(w.species.nextId, w.species.all[w.species.all.length - 1].id + 1);

  if (s.orgs) {
    const r = s.orgs;
    for (const b of r.born) {
      const o = new Organism(b.id, b.genome, b.species, b.generation, b.parent, b.born, 1, 0, 0);
      o.father = b.father;
      w.orgById.set(o.id, o);
    }
    for (const [id, g] of r.genomes) w.orgById.get(id)?.setGenome(g);
    const mark = ++syncFrame;
    const next: Organism[] = [];
    for (let i = 0; i < r.n; i++) {
      const o = w.orgById.get(r.ids[i * 2]);
      if (!o) continue;
      o.species = r.ids[i * 2 + 1];
      unpackOrg(o, r.f, i * ORG_F);
      o.syncMark = mark;
      next.push(o);
    }
    for (const o of w.orgs) {
      if (o.syncMark === mark) continue;
      o.dead = true;
      if (!o.cause) o.cause = s.sel && s.sel.id === o.id && s.sel.cause ? s.sel.cause : 'Died';
      w.orgById.delete(o.id);
    }
    w.orgs = next;
    done.push(r.f.buffer as ArrayBuffer, r.ids.buffer as ArrayBuffer);
  }

  if (s.sel) {
    const o = w.orgById.get(s.sel.id);
    if (o && s.sel.values) {
      if (s.sel.values.length === o.brain.values.length) o.brain.values.set(s.sel.values);
      if (s.sel.weights) o.brain.setWeights(s.sel.weights);
    }
  }

  for (const smp of s.stats) w.stats.samples.push(smp);
  if (w.stats.samples.length > w.stats.max) w.stats.samples.splice(0, w.stats.samples.length - w.stats.max);
  for (const ev of s.events) w.events.push(ev);
  if (w.events.length > 200) w.events.splice(0, w.events.length - 200);
  if (s.events.length) w.eventSeq = s.events[s.events.length - 1].seq;
  return done;
}
