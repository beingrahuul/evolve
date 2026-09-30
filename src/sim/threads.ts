// Running the simulation on several cores.
//
// Helper threads share the work with the simulation thread, through shared memory
// (SharedArrayBuffers; browsers allow them only on cross-origin-isolated pages):
//
// - A pool (pool.ts) that the simulation thread splits loops over: each tick the organisms' senses
//   (board.ts), and at each environment step the merge of its result.
// - An environment thread. The sea, air and soil step (every FIELD_EVERY ticks) runs on its own
//   core, one step behind life: at each step the simulation thread merges in the result of the
//   step it started last time (plus whatever life and the player changed meanwhile), then hands
//   over a snapshot for the next one. Nothing is lost; the environment just lags by one step. It
//   has a pool of its own for the water's heavy loops.
import type { Environment } from './environment';
import { GodParams, DT, FIELD_EVERY, NFLOOR, defaultParams } from './params';
import { LifeBoard, SenseSource, senseRange, thinkRange } from './board';
import { SLOT_WORDS } from './brain';
import { KernelRunner, Pool } from './pool';
import { ROCK_TYPES } from './terrain';
import type { World, WorldThreads } from './world';

// ---------------------------------------------------------------------------
// Shared control block (Int32Array)

export const C = {
  ENV_EPOCH: 0,
  ENV_DONE: 1,
  /** 1 once the environment thread is up. */
  READY: 2,
  SIZE: 4,
} as const;

/** The simulation thread's pool jobs. */
export const J = { SENSE: 1, MERGE: 2 } as const;
/** Organisms per sensing slice; array elements per merge slice. */
export const CHUNK = 24;
const MERGE_CHUNK = 16384;

// ---------------------------------------------------------------------------
// The environment's state, and how each part merges back

type EnvArray = Float32Array | Uint8Array | Int16Array;

/**
 * 'add': the environment's result plus whatever life and the player changed while it ran.
 * 'take': the environment's result (only it changes these).
 * 'acc': accumulated by life for the environment to consume (the simulation thread keeps its own).
 */
type Merge = 'add' | 'take' | 'acc';

export const ENV_ARRAYS: [string, (e: Environment) => EnvArray, Merge][] = [
  ['u', (e) => e.fields.u, 'add'],
  ['v', (e) => e.fields.v, 'add'],
  ['temp', (e) => e.fields.temp, 'add'],
  ['o2', (e) => e.fields.o2, 'add'],
  ['co2', (e) => e.fields.co2, 'add'],
  ['nut', (e) => e.fields.nut, 'add'],
  ['sulf', (e) => e.fields.sulf, 'add'],
  ['sigA', (e) => e.fields.sigA, 'add'],
  ['sigB', (e) => e.fields.sigB, 'add'],
  ['light', (e) => e.fields.light, 'take'],
  ['shade', (e) => e.fields.shade, 'acc'],
  ['air.u', (e) => e.atmosphere.u, 'add'],
  ['air.v', (e) => e.atmosphere.v, 'add'],
  ['air.temp', (e) => e.atmosphere.temp, 'add'],
  ['air.hum', (e) => e.atmosphere.hum, 'add'],
  ['air.cloud', (e) => e.atmosphere.cloud, 'add'],
  ['air.surfaceT', (e) => e.atmosphere.surfaceT, 'take'],
  ['air.rain', (e) => e.atmosphere.rain, 'take'],
  ['air.rainStep', (e) => e.atmosphere.rainStep, 'take'],
  ['air.shade', (e) => e.atmosphere.shade, 'take'],
  ['air.evap', (e) => e.atmosphere.evap, 'take'],
  ['soil.moisture', (e) => e.soil.moisture, 'add'],
  ['soil.nutrient', (e) => e.soil.nutrient, 'add'],
  ['soil.organic', (e) => e.soil.organic, 'add'],
  ['soil.temp', (e) => e.soil.temp, 'take'],
  ['soil.snow', (e) => e.soil.snow, 'take'],
  ['soil.land', (e) => e.soil.land, 'take'],
  ['soil.canopy', (e) => e.soil.canopy, 'take'],
  ['soil.canopyTop', (e) => e.soil.canopyTop, 'take'],
  ['soil.wetness', (e) => e.soil.wetness, 'take'],
  ['soil.cover', (e) => e.soil.cover, 'acc'],
  ['soil.coverTop', (e) => e.soil.coverTop, 'acc'],
];

/** The water mask and friends, which only the environment computes (never loaded into it). */
export const ENV_MASKS: [string, (e: Environment) => EnvArray][] = [
  ['solid', (e) => e.fields.solid],
  ['ground', (e) => e.fields.ground],
  ['rockAt', (e) => e.fields.rockAt],
  ['floorCell', (e) => e.fields.floorCell],
  ['surfRow', (e) => e.fields.surfRow],
];

/** Scalars into the environment thread. */
export const EI = {
  DTF: 0,
  SUN: 1,
  TIDE: 2,
  TERRAIN_VERSION: 3,
  ROCKS: 4,
  VENTS: 5,
  SEA_LEVEL: 6,
  ATM_O2: 7,
  ATM_CO2: 8,
  MEAN_TEMP: 9,
  SHADE_TICKS: 10,
  COVER_TICKS: 11,
  CLIMATE_T: 12,
  WEATHER_PHASE: 13,
  STORM_TIMER: 14,
  PARAMS: 16,
} as const;

/** Scalars out of the environment thread. */
export const EO = {
  SEA_LEVEL: 0,
  ATM_O2: 1,
  ATM_CO2: 2,
  MEAN_TEMP: 3,
  AIR_TEMP: 4,
  FLUID_COUNT: 5,
  CLIMATE_T: 6,
  WEATHER_PHASE: 7,
  STORM_TIMER: 8,
  RNG: 9,
  STRIKE: 10,
  STRIKE_X: 11,
  STRIKE_Y: 12,
  BOLT: 13,
  BOLT_AGE: 14,
  BOLT_X: 15,
  BOLT_Y: 16,
  BOLT_N: 17,
  EDDIES: 18,
  /** Time the environment thread spent (ms): the step itself, and copying in and out. */
  STEP_MS: 19,
  IO_MS: 20,
  /** Pool threads helping the environment thread with the water. */
  KERNELS: 21,
  SIZE: 24,
} as const;

export const PARAM_KEYS = Object.keys(defaultParams()) as (keyof GodParams)[];
export const MAX_ROCKS = 512;
export const MAX_VENTS = 64;
export const ROCK_IN = 9; // id, type, x, y, r, r0, seed, released, solidR
export const ROCK_OUT = 3; // r, released, solidR
export const MAX_EDDIES = 16;
export const BOLT_FLOATS = 64;

/** Shared buffers between the simulation thread and the environment thread. */
export interface EnvLink {
  in: Record<string, EnvArray>;
  out: Record<string, EnvArray>;
  masks: Record<string, EnvArray>;
  inScalars: Float64Array;
  outScalars: Float64Array;
  floor: Float32Array;
  rocksIn: Float64Array;
  rocksOut: Float64Array;
  vents: Float64Array;
  eddies: Float64Array;
  bolt: Float32Array;
}

function sharedLike<T extends EnvArray>(a: T): T {
  const C = a.constructor as new (b: ArrayBufferLike) => T;
  return new C(new SharedArrayBuffer(a.byteLength));
}

const sharedF64 = (n: number) => new Float64Array(new SharedArrayBuffer(n * 8));

function makeLink(e: Environment): EnvLink {
  const link: EnvLink = {
    in: {},
    out: {},
    masks: {},
    inScalars: sharedF64(EI.PARAMS + PARAM_KEYS.length),
    outScalars: sharedF64(EO.SIZE),
    floor: new Float32Array(new SharedArrayBuffer(NFLOOR * 4)),
    rocksIn: sharedF64(MAX_ROCKS * ROCK_IN),
    rocksOut: sharedF64(MAX_ROCKS * ROCK_OUT),
    vents: sharedF64(MAX_VENTS * 4),
    eddies: sharedF64(MAX_EDDIES * 6),
    bolt: new Float32Array(new SharedArrayBuffer(BOLT_FLOATS * 4)),
  };
  for (const [name, get] of ENV_ARRAYS) {
    link.in[name] = sharedLike(get(e));
    link.out[name] = sharedLike(get(e));
  }
  for (const [name, get] of ENV_MASKS) link.masks[name] = sharedLike(get(e));
  return link;
}

/** The typed arrays sensing reads, by the path of the object that holds them in a world. */
export function senseViews(w: World): Record<string, ArrayBufferView> {
  const b = w.board;
  return {
    'fields.temp': w.fields.temp,
    'fields.o2': w.fields.o2,
    'fields.nut': w.fields.nut,
    'fields.sulf': w.fields.sulf,
    'fields.light': w.fields.light,
    'fields.sigA': w.fields.sigA,
    'fields.sigB': w.fields.sigB,
    'soil.temp': w.soil.temp,
    'soil.nutrient': w.soil.nutrient,
    'soil.moisture': w.soil.moisture,
    'soil.canopy': w.soil.canopy,
    'soil.canopyTop': w.soil.canopyTop,
    'atmosphere.temp': w.atmosphere.temp,
    'atmosphere.groundRow': w.atmosphere.groundRow,
    'atmosphere.surfaceT': w.atmosphere.surfaceT,
    'atmosphere.rain': w.atmosphere.rain,
    'atmosphere.shade': w.atmosphere.shade,
    'particles.x': w.particles.x,
    'particles.y': w.particles.y,
    'particles.c': w.particles.c,
    'orgGrid.start': w.orgGrid.start,
    'orgGrid.items': w.orgGrid.items,
    'partGrid.start': w.partGrid.start,
    'partGrid.items': w.partGrid.items,
    'board.x': b.x,
    'board.y': b.y,
    'board.r': b.r,
    'board.glow': b.glow,
    'board.sig': b.sig,
    'board.threat': b.threat,
    'board.green': b.green,
    'board.alive': b.alive,
    'board.court': b.court,
    'board.heading': b.heading,
    'board.range': b.range,
    'board.near': b.near,
    'board.nEyes': b.nEyes,
    'board.eyes': b.eyes,
    'board.wet': b.wet,
    'board.topY': b.topY,
    'board.leaf': b.leaf,
    'board.acuity': b.acuity,
    'board.tempOpt': b.tempOpt,
    'board.tempTol': b.tempTol,
    'board.inp': b.inp,
    'board.touch': b.touch,
    'board.slot': b.slot,
    'board.reward': b.reward,
    'board.learnRate': b.learnRate,
  };
}

/** Arrays that may go negative (velocities, temperatures); all other amounts are clamped at 0. */
const SIGNED = new Set(['u', 'v', 'temp', 'air.u', 'air.v', 'air.temp']);

/** One 'add' array to merge: where it starts in the merge job's combined index space. */
interface MergeSegment {
  cur: Float32Array;
  out: Float32Array;
  inp: Float32Array;
  clamp: boolean;
  start: number;
}

/** The 'add' arrays, laid end to end (the same order on every thread). */
export function mergeSegments(cur: (name: string) => Float32Array, L: EnvLink): MergeSegment[] {
  const segs: MergeSegment[] = [];
  let start = 0;
  for (const [name, , mode] of ENV_ARRAYS) {
    if (mode !== 'add') continue;
    const c = cur(name);
    segs.push({ cur: c, out: L.out[name] as Float32Array, inp: L.in[name] as Float32Array, clamp: !SIGNED.has(name), start });
    start += c.length;
  }
  return segs;
}

/**
 * cur = out + (cur − in) over part [from, to) of the segments: the environment's step plus what life
 * and the player changed meanwhile. Amounts cannot go negative (life may have used what the
 * currents carried away meanwhile). The result is also the next step's snapshot, so it goes into
 * `inp` too.
 */
function mergeRange(segs: MergeSegment[], from: number, to: number) {
  for (const sg of segs) {
    const a = Math.max(from, sg.start) - sg.start;
    const b = Math.min(to, sg.start + sg.cur.length) - sg.start;
    const { cur, out, inp, clamp } = sg;
    for (let i = a; i < b; i++) {
      let v = out[i] + (cur[i] - inp[i]);
      if (clamp && v < 0) v = 0;
      cur[i] = v;
      inp[i] = v;
    }
  }
}

/** The simulation thread's pool jobs, as any of its threads runs them. */
export class SimKernels implements KernelRunner {
  constructor(
    private src: SenseSource,
    private board: LifeBoard,
    private segs: MergeSegment[],
    /** Sea level, sun, atmospheric O₂ and CO₂ for sensing (a helper's view of the world has no clock). */
    private args: Float64Array | null,
    /** The brain arena, as floats and ints. */
    private brainF: Float32Array,
    private brainI: Int32Array,
  ) {}

  kernel(job: number, from: number, to: number) {
    if (job === J.SENSE) {
      const a = this.args;
      if (a) {
        this.src.fields.seaLevel = a[0];
        this.src.sunNow = a[1];
        this.src.fields.atmO2 = a[2];
        this.src.fields.atmCO2 = a[3];
      }
      senseRange(this.src, this.board, from, to);
      thinkRange(this.board, this.brainF, this.brainI, SLOT_WORDS, from, to);
    } else if (job === J.MERGE) mergeRange(this.segs, from, to);
  }
}

// ---------------------------------------------------------------------------
// Messages to helpers

export type HelperSetup =
  | { role: 'sim'; width: number; pool: Int32Array; args: Float64Array; views: Record<string, ArrayBufferView>; link: EnvLink }
  | { role: 'env'; width: number; ctrl: Int32Array; link: EnvLink; rng: number; kernels: number }
  | { role: 'kernel'; width: number; ctrl: Int32Array; views: Record<string, ArrayBufferView> };

/** A helper thread, as the simulation thread sees it (a Web Worker, or a Node worker thread). */
export interface HelperHandle {
  postMessage(m: HelperSetup): void;
  terminate(): void;
}

// ---------------------------------------------------------------------------
// Simulation-thread side

/** Give up on the helpers if they do not answer for this long (a crashed helper must not hang the world). */
const STALL_MS = 3000;

export class Threads implements WorldThreads {
  private ctrl = new Int32Array(new SharedArrayBuffer(C.SIZE * 4));
  private args = new Float64Array(new SharedArrayBuffer(8 * 8));
  private pool: Pool;
  private segs: MergeSegment[];
  private mergeTotal: number;
  private helpers: HelperHandle[] = [];
  private link: EnvLink;
  private envEpoch = 0;
  private envPending = false;
  private sentTerrain = -1;
  private broken = false;
  /** Where the simulation thread's time goes (ms, cumulative): sensing, the environment. */
  readonly timing = { sense: 0, envWait: 0, envSync: 0, envStep: 0, envIO: 0, envSteps: 0 };

  /**
   * `w` must have been created with shared memory (shareMemory(true)). `spawn` starts one helper
   * thread: `poolHelpers` of them join the simulation thread's pool, and one more runs the
   * environment, which starts `kernelHelpers` of its own to share the water's heavy loops.
   */
  constructor(
    w: World,
    spawn: () => HelperHandle,
    poolHelpers: number,
    kernelHelpers = 0,
  ) {
    this.link = makeLink(w);
    const L = this.link;
    const cur = (name: string) => ENV_ARRAYS.find(([n]) => n === name)![1](w) as Float32Array;
    this.segs = mergeSegments(cur, L);
    this.mergeTotal = this.segs.reduce((t, sg) => t + sg.cur.length, 0);
    const arena = w.brainArena!;
    this.pool = new Pool(new SimKernels(w, w.board, this.segs, null, arena.f, arena.i), true);
    const views = senseViews(w);
    views['brains.f'] = arena.f;
    views['brains.i'] = arena.i;
    for (const [name, , mode] of ENV_ARRAYS) if (mode === 'add') views[`cur.${name}`] = cur(name);
    for (let k = 0; k < poolHelpers; k++) {
      const h = spawn();
      h.postMessage({ role: 'sim', width: w.width, pool: this.pool.ctrl, args: this.args, views, link: L });
      this.helpers.push(h);
    }
    const env = spawn();
    env.postMessage({ role: 'env', width: w.width, ctrl: this.ctrl, link: L, rng: w.envRng, kernels: kernelHelpers });
    this.helpers.push(env);
  }

  /** Helper threads that are up: the pool's, the environment thread, and the environment's pool. */
  get helping(): number {
    return this.pool.helpers + Atomics.load(this.ctrl, C.READY) + this.link.outScalars[EO.KERNELS];
  }

  dispose() {
    for (const h of this.helpers) h.terminate();
    this.helpers = [];
    this.broken = true;
  }

  private fail(w: World, why: string) {
    console.error(`Simulation helper threads stopped responding (${why}); carrying on with one thread.`);
    this.dispose();
    w.threads = null;
  }

  sense(w: World, n: number) {
    const t0 = performance.now();
    const a = this.args;
    a[0] = w.fields.seaLevel;
    a[1] = w.sunNow;
    a[2] = w.fields.atmO2;
    a[3] = w.fields.atmCO2;
    if (!this.pool.run(J.SENSE, n, CHUNK)) this.fail(w, 'sensing');
    this.timing.sense += performance.now() - t0;
  }

  environment(w: World): boolean {
    if (this.broken) return false;
    // is the environment thread up yet? (until then the world steps it itself)
    if (!this.envPending && Atomics.load(this.ctrl, C.READY) === 0) return false;
    const t0 = performance.now();
    if (this.envPending) {
      if (!this.merge(w)) return false;
    } else this.snapshotArrays(w);
    this.snapshot(w);
    this.timing.envSync += performance.now() - t0;
    Atomics.store(this.ctrl, C.ENV_EPOCH, ++this.envEpoch);
    Atomics.notify(this.ctrl, C.ENV_EPOCH);
    this.envPending = true;
    return true;
  }

  /** Copy the environment's arrays into the snapshot (merge() does this as it goes, after the first step). */
  private snapshotArrays(w: World) {
    const L = this.link;
    for (const [name, get, mode] of ENV_ARRAYS) {
      const a = get(w);
      if (mode === 'take') continue;
      L.in[name].set(a);
      if (mode === 'acc') a.fill(name === 'soil.coverTop' ? 1e9 : 0);
    }
  }

  /** Hand the environment thread a snapshot of the environment for its next step. */
  private snapshot(w: World) {
    const L = this.link;
    const F = w.fields;
    const A = w.atmosphere;
    const s = L.inScalars;
    s[EI.DTF] = DT * FIELD_EVERY;
    s[EI.SUN] = w.sunNow;
    s[EI.TIDE] = w.tideLevel();
    s[EI.SEA_LEVEL] = F.seaLevel;
    s[EI.ATM_O2] = F.atmO2;
    s[EI.ATM_CO2] = F.atmCO2;
    s[EI.MEAN_TEMP] = F.meanTemp;
    s[EI.SHADE_TICKS] = F.shadeTicks;
    s[EI.COVER_TICKS] = w.soil.coverTicks;
    F.shadeTicks = 0;
    w.soil.coverTicks = 0;
    s[EI.CLIMATE_T] = A.climateT;
    s[EI.WEATHER_PHASE] = A.weatherPhase;
    s[EI.STORM_TIMER] = A.stormTimer;
    PARAM_KEYS.forEach((k, i) => (s[EI.PARAMS + i] = Number(w.params[k])));
    // the ground: its shape when it changed, the rocks and vents every step
    const T = w.terrain;
    if (T.version !== this.sentTerrain) {
      L.floor.set(T.floor);
      this.sentTerrain = T.version;
      s[EI.TERRAIN_VERSION] = T.version;
    }
    const nr = Math.min(MAX_ROCKS, T.rocks.length);
    s[EI.ROCKS] = nr;
    for (let k = 0; k < nr; k++) {
      const r = T.rocks[k];
      L.rocksIn.set([r.id, Math.max(0, ROCK_TYPES.indexOf(r.type)), r.x, r.y, r.r, r.r0, r.seed, r.released, r.solidR], k * ROCK_IN);
    }
    const nv = Math.min(MAX_VENTS, T.vents.length);
    s[EI.VENTS] = nv;
    for (let k = 0; k < nv; k++) {
      const v = T.vents[k];
      L.vents.set([v.id, v.x, v.y, v.power], k * 4);
    }
  }

  /** Wait for the environment thread's step and merge it in. False if it never came. */
  private merge(w: World): boolean {
    const c = this.ctrl;
    const t0 = performance.now();
    while (Atomics.load(c, C.ENV_DONE) !== this.envEpoch) {
      Atomics.wait(c, C.ENV_DONE, Atomics.load(c, C.ENV_DONE), 20);
      if (performance.now() - t0 > STALL_MS) {
        this.fail(w, 'environment');
        return false;
      }
    }
    this.timing.envWait += performance.now() - t0;
    this.timing.envStep += this.link.outScalars[EO.STEP_MS];
    this.timing.envIO += this.link.outScalars[EO.IO_MS];
    this.timing.envSteps++;
    this.envPending = false;
    const L = this.link;
    // in one pass: merge the step in, and hand over the result as the next step's snapshot
    if (!this.pool.run(J.MERGE, this.mergeTotal, MERGE_CHUNK)) {
      this.fail(w, 'merging');
      return false;
    }
    for (const [name, get, mode] of ENV_ARRAYS) {
      const a = get(w);
      if (mode === 'take') a.set(L.out[name]);
      else if (mode === 'acc') {
        L.in[name].set(a);
        a.fill(name === 'soil.coverTop' ? 1e9 : 0);
      }
    }
    for (const [name, get] of ENV_MASKS) get(w).set(L.masks[name]);
    const F = w.fields;
    const o = L.outScalars;
    const s = L.inScalars;
    F.seaLevel = o[EO.SEA_LEVEL];
    F.atmO2 = Math.max(0, o[EO.ATM_O2] + (F.atmO2 - s[EI.ATM_O2]));
    F.atmCO2 = Math.max(0, o[EO.ATM_CO2] + (F.atmCO2 - s[EI.ATM_CO2]));
    F.meanTemp = o[EO.MEAN_TEMP];
    F.airTemp = o[EO.AIR_TEMP];
    F.fluidCount = o[EO.FLUID_COUNT];
    const A = w.atmosphere;
    A.climateT = o[EO.CLIMATE_T];
    A.weatherPhase = o[EO.WEATHER_PHASE];
    A.stormTimer = o[EO.STORM_TIMER];
    A.rebuild(w.terrain, F.seaLevel);
    w.envRng = o[EO.RNG] >>> 0;
    F.eddies = [];
    for (let k = 0; k < o[EO.EDDIES]; k++) {
      const e = L.eddies.subarray(k * 6, k * 6 + 6);
      F.eddies.push({ x: e[0], y: e[1], r: e[2], s: e[3], life: e[4], age: e[5] });
    }
    // lightning: the environment thread's bolt, or one the player called down (aged here)
    if (o[EO.BOLT]) {
      A.bolt = { pts: Array.from(L.bolt.subarray(0, o[EO.BOLT_N])), age: o[EO.BOLT_AGE], x: o[EO.BOLT_X], y: o[EO.BOLT_Y] };
    } else if (A.bolt) {
      A.bolt.age += s[EI.DTF];
      if (A.bolt.age > 0.5) A.bolt = null;
    }
    // rocks worn by the water
    const T = w.terrain;
    for (let k = 0; k < s[EI.ROCKS]; k++) {
      const rock = T.rocks.find((r) => r.id === L.rocksIn[k * ROCK_IN]);
      if (!rock) continue;
      rock.r = L.rocksOut[k * ROCK_OUT];
      rock.released = L.rocksOut[k * ROCK_OUT + 1];
      rock.solidR = L.rocksOut[k * ROCK_OUT + 2];
    }
    if (o[EO.STRIKE]) w.lightningStrike(o[EO.STRIKE_X], o[EO.STRIKE_Y]);
    return true;
  }
}
