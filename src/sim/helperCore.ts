// What a helper thread does (see threads.ts): sense for chunks of organisms, or step the environment.
// A helper gets one setup message, then works only through shared memory, forever.
import { Atmosphere } from './atmosphere';
import { LifeBoard, SenseSource, senseRange } from './board';
import { Environment, stepEnvironment } from './environment';
import { Fields } from './fields';
import { GRID_TOP, GodParams, SKY_H, WORLD_H, WORLD_W, setWorldWidth } from './params';
import { Particles } from './particles';
import { Pool, servePool } from './pool';
import { Rng } from './rng';
import { shareMemory } from './shared';
import { Soil } from './soil';
import { SpatialGrid } from './spatial';
import { ROCK_TYPES, Terrain } from './terrain';
import {
  BOLT_FLOATS,
  C,
  EI,
  ENV_ARRAYS,
  ENV_MASKS,
  EO,
  HelperHandle,
  HelperSetup,
  MAX_EDDIES,
  PARAM_KEYS,
  ROCK_IN,
  ROCK_OUT,
  SimKernels,
  mergeSegments,
} from './threads';

/** `spawn` starts another helper thread (the environment thread starts a pool of its own). */
export function runHelper(setup: HelperSetup, spawn: () => HelperHandle) {
  setWorldWidth(setup.width);
  if (setup.role === 'sim') runSimPool(setup);
  else if (setup.role === 'kernel') runKernels(setup);
  else runEnvironment(setup, spawn);
}

/** The typed arrays of an object, by property name. */
function arraysOf(o: object): Record<string, ArrayBufferView> {
  const out: Record<string, ArrayBufferView> = {};
  for (const [k, v] of Object.entries(o)) if (ArrayBuffer.isView(v)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------

/** A pool thread of the environment thread: runs slices of the water's kernels (Fields.kernel). */
function runKernels(s: Extract<HelperSetup, { role: 'kernel' }>) {
  const fields = new Fields();
  Object.assign(fields, s.views);
  servePool(s.ctrl, fields);
}

// ---------------------------------------------------------------------------

/** A pool thread of the simulation thread: senses for slices of the organisms, merges the environment. */
function runSimPool(s: Extract<HelperSetup, { role: 'sim' }>) {
  // local objects whose arrays are replaced by views of the simulation thread's shared ones
  const src: SenseSource = {
    fields: new Fields(),
    soil: new Soil(),
    atmosphere: new Atmosphere(),
    particles: new Particles(),
    orgGrid: new SpatialGrid(WORLD_W, WORLD_H, 40, 1, -SKY_H),
    partGrid: new SpatialGrid(WORLD_W, WORLD_H, 30, 1, GRID_TOP),
    sunNow: 0,
  };
  const board = new LifeBoard();
  const owners: Record<string, object> = {
    fields: src.fields,
    soil: src.soil,
    atmosphere: src.atmosphere,
    particles: src.particles,
    orgGrid: src.orgGrid,
    partGrid: src.partGrid,
    board,
  };
  for (const [path, view] of Object.entries(s.views)) {
    const [owner, key] = path.split('.');
    if (owners[owner]) (owners[owner] as Record<string, unknown>)[key] = view;
  }
  const segs = mergeSegments((name) => s.views[`cur.${name}`] as Float32Array, s.link);
  const kernels = new SimKernels(src, board, segs, s.args, s.views['brains.f'] as Float32Array, s.views['brains.i'] as Int32Array);
  servePool(s.pool, kernels);
}

// ---------------------------------------------------------------------------

function runEnvironment(s: Extract<HelperSetup, { role: 'env' }>, spawn: () => HelperHandle) {
  // the water lives in shared memory here too, so a pool of threads can share its heavy loops
  shareMemory(s.kernels > 0);
  const env: Environment = { fields: new Fields(), atmosphere: new Atmosphere(), soil: new Soil(), terrain: new Terrain() };
  if (s.kernels > 0) {
    try {
      const pool = new Pool(env.fields, true);
      const views = arraysOf(env.fields);
      for (let k = 0; k < s.kernels; k++) spawn().postMessage({ role: 'kernel', width: s.width, ctrl: pool.ctrl, views });
      env.fields.pool = pool;
    } catch (err) {
      // no pool for the water: the environment thread does it alone
      console.warn('The environment thread could not start its helpers:', err);
    }
  }
  const rng = new Rng(1);
  rng.state = s.rng;
  const ctrl = s.ctrl;
  const L = s.link;
  let terrainVersion = -1;
  let rockKey = '';
  // A thread's own helpers start through its event loop, so wait (yielding) for them before
  // settling into the loop below, which never yields; then tell the simulation thread we are ready.
  const t0 = performance.now();
  const whenHelpersUp = () => {
    const pool = env.fields.pool;
    if (pool && pool.helpers < s.kernels && performance.now() - t0 < 5000) setTimeout(whenHelpersUp, 10);
    else serve();
  };
  whenHelpersUp();

  function serve() {
    Atomics.add(ctrl, C.READY, 1);
    let seen = Atomics.load(ctrl, C.ENV_EPOCH);
    for (;;) {
      const e = Atomics.load(ctrl, C.ENV_EPOCH);
      if (e === seen) {
        Atomics.wait(ctrl, C.ENV_EPOCH, e, 1000);
        continue;
      }
      seen = e;
      step();
      Atomics.store(ctrl, C.ENV_DONE, e);
      Atomics.notify(ctrl, C.ENV_DONE);
    }
  }

  function step() {
    const { fields: F, atmosphere: A, soil, terrain: T } = env;
    const si = L.inScalars;
    const t0 = performance.now();
    // the snapshot: the simulation thread's environment, with everything life and the player did to it
    for (const [name, get] of ENV_ARRAYS) get(env).set(L.in[name]);
    F.seaLevel = si[EI.SEA_LEVEL];
    F.atmO2 = si[EI.ATM_O2];
    F.atmCO2 = si[EI.ATM_CO2];
    F.meanTemp = si[EI.MEAN_TEMP];
    F.shadeTicks = si[EI.SHADE_TICKS];
    soil.coverTicks = si[EI.COVER_TICKS];
    A.climateT = si[EI.CLIMATE_T];
    A.weatherPhase = si[EI.WEATHER_PHASE];
    A.stormTimer = si[EI.STORM_TIMER];
    // the ground: rebuild the water and air masks when its shape or the rocks change
    let rebuild = false;
    if (si[EI.TERRAIN_VERSION] !== terrainVersion) {
      terrainVersion = si[EI.TERRAIN_VERSION];
      T.floor.set(L.floor);
      T.version++;
      rebuild = true;
    }
    const nr = si[EI.ROCKS];
    T.rocks = [];
    let key = '';
    for (let k = 0; k < nr; k++) {
      const r = L.rocksIn.subarray(k * ROCK_IN, k * ROCK_IN + ROCK_IN);
      T.rocks.push({ id: r[0], type: ROCK_TYPES[r[1]] ?? ROCK_TYPES[0], x: r[2], y: r[3], r: r[4], r0: r[5], seed: r[6], released: r[7], solidR: r[8] });
      // which rocks there are and where (erosion rebuilds the masks itself, in the water step)
      key += `${r[0]}:${r[2]}:${r[3]},`;
    }
    if (key !== rockKey) {
      rockKey = key;
      rebuild = true;
    }
    T.vents = [];
    for (let k = 0; k < si[EI.VENTS]; k++) {
      const v = L.vents.subarray(k * 4, k * 4 + 4);
      T.vents.push({ id: v[0], x: v[1], y: v[2], power: v[3] });
    }
    if (rebuild) {
      F.rebuildSolid(T);
      A.rebuild(T, F.seaLevel, true);
    }
    const P = {} as Record<string, number | boolean>;
    PARAM_KEYS.forEach((k, i) => (P[k] = k === 'autoSeed' ? si[EI.PARAMS + i] !== 0 : si[EI.PARAMS + i]));

    const t1 = performance.now();
    const strike = stepEnvironment(env, si[EI.DTF], P as unknown as GodParams, si[EI.SUN], si[EI.TIDE], rng);
    const t2 = performance.now();

    // the result
    for (const [name, get, mode] of ENV_ARRAYS) if (mode !== 'acc') L.out[name].set(get(env));
    for (const [name, get] of ENV_MASKS) L.masks[name].set(get(env));
    const o = L.outScalars;
    o[EO.SEA_LEVEL] = F.seaLevel;
    o[EO.ATM_O2] = F.atmO2;
    o[EO.ATM_CO2] = F.atmCO2;
    o[EO.MEAN_TEMP] = F.meanTemp;
    o[EO.AIR_TEMP] = F.airTemp;
    o[EO.FLUID_COUNT] = F.fluidCount;
    o[EO.CLIMATE_T] = A.climateT;
    o[EO.WEATHER_PHASE] = A.weatherPhase;
    o[EO.STORM_TIMER] = A.stormTimer;
    o[EO.RNG] = rng.state >>> 0;
    o[EO.STRIKE] = strike ? 1 : 0;
    o[EO.STRIKE_X] = strike ? strike.x : 0;
    o[EO.STRIKE_Y] = strike ? strike.y : 0;
    const bolt = A.bolt;
    o[EO.BOLT] = bolt ? 1 : 0;
    if (bolt) {
      const n = Math.min(BOLT_FLOATS, bolt.pts.length);
      L.bolt.set(bolt.pts.slice(0, n));
      o[EO.BOLT_N] = n;
      o[EO.BOLT_AGE] = bolt.age;
      o[EO.BOLT_X] = bolt.x;
      o[EO.BOLT_Y] = bolt.y;
    }
    const ne = Math.min(MAX_EDDIES, F.eddies.length);
    o[EO.EDDIES] = ne;
    for (let k = 0; k < ne; k++) {
      const ed = F.eddies[k];
      L.eddies.set([ed.x, ed.y, ed.r, ed.s, ed.life, ed.age], k * 6);
    }
    for (let k = 0; k < nr; k++) {
      const r = T.rocks[k];
      L.rocksOut.set([r.r, r.released, r.solidR], k * ROCK_OUT);
    }
    o[EO.STEP_MS] = t2 - t1;
    o[EO.KERNELS] = F.pool ? F.pool.helpers : 0;
    o[EO.IO_MS] = t1 - t0 + (performance.now() - t2);
  }
}
