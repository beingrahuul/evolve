/// <reference lib="webworker" />
// The simulation thread. It owns the world and runs it at the chosen speed on its own real-time
// clock (so slow drawing never slows the world), in short slices so frame requests and the
// player's commands are answered promptly. Each frame it sends the main thread a snapshot (see
// sync.ts) to draw. It keeps running while the page is in the background.
import { applyCommand } from './commands';
import { blobToWorld, worldToBlob } from './savefile';
import { TPS } from './params';
import { canShareMemory, isSharing, shareMemory } from './shared';
import { FromWorker, SyncSource, ToWorker } from './sync';
import { HelperHandle, Threads } from './threads';
import { World, makeWorld } from './world';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const sync = new SyncSource();

// On a cross-origin-isolated page with cores to spare, worlds live in shared memory so helper
// threads can share the work (threads.ts).
const cores = navigator.hardwareConcurrency || 2;
shareMemory(canShareMemory() && cores >= 3);
const spawnHelper = (): HelperHandle => new Worker(new URL('./helper.ts', import.meta.url), { type: 'module' });
let threads: Threads | null = null;
/** Helper threads to start (the page can override these: ?pool=…&kernels=…). */
let poolHelpers = cores >= 8 ? 2 : 1;
let kernelHelpers = cores >= 6 ? 1 : 0;

/** Start helper threads for a new world (sensing on one or more, the environment on another). */
function startThreads(w: World) {
  threads?.dispose();
  threads = null;
  if (!isSharing()) return;
  try {
    // a pool for sensing and merging, plus the environment thread and a pool for its water
    threads = new Threads(w, spawnHelper, poolHelpers, kernelHelpers);
    w.threads = threads;
  } catch (err) {
    console.warn('Could not start helper threads; simulating on one thread.', err);
  }
}

/** Threads working on the simulation now: this one plus the helpers that are up. */
function threadCount(w: World): number {
  return 1 + (w.threads && threads ? threads.helping : 0);
}

let world: World | null = null;
let gen = 0;
let speed = 1;
let paused = false;
/** Ticks the clock says are due. */
let owed = 0;
let clock = performance.now();
let wake: ReturnType<typeof setTimeout> | null = null;
let selected = -1;
let wantFrame = false;
let changed = true;
let pendingSelect: number | undefined;

// measured speed
let stepMs = 0;
let tps = 0;
let tpsTicks = 0;
let tpsT0 = performance.now();
let lastError = -1e9;

/** A slice of simulation per task; the rest of the time the thread answers messages. */
const SLICE_MS = 10;

const chan = new MessageChannel();
let scheduled = false;
chan.port1.onmessage = () => {
  scheduled = false;
  pump();
};
function schedule() {
  if (!scheduled) {
    scheduled = true;
    chan.port2.postMessage(null);
  }
}

function send(m: FromWorker, transfer: Transferable[] = []) {
  ctx.postMessage(m, transfer);
}

/** Advance the clock: real time passing at `speed` makes ticks due. */
function tickClock(now: number) {
  const dt = Math.min(1, (now - clock) / 1000);
  clock = now;
  if (paused || speed === Infinity) owed = 0;
  // at most a quarter of a second of backlog, so a busy moment does not cause a long catch-up
  else owed = Math.min(owed + dt * TPS * speed, Math.max(2, TPS * speed * 0.25));
}

function pump() {
  const w = world;
  if (!w) return;
  const max = speed === Infinity;
  const t0 = performance.now();
  tickClock(t0);
  let n = 0;
  if (!paused) {
    try {
      while ((max || owed >= 1) && performance.now() - t0 < SLICE_MS) {
        w.step();
        n++;
        if (!max) owed--;
      }
    } catch (err) {
      // report it (once in a while) and carry on: one bad tick should not end the world
      owed = 0;
      if (t0 - lastError > 2000) {
        lastError = t0;
        send({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
      }
    }
  }
  const now = performance.now();
  if (n > 0) changed = true;
  // cost per tick, from slices long enough to measure (a lone tick is dominated by timer noise)
  if (n >= 3) {
    const per = (now - t0) / n;
    stepMs = stepMs ? stepMs * 0.8 + per * 0.2 : per;
  }
  tpsTicks += n;
  if (now - tpsT0 > 400) {
    tps = (tpsTicks * 1000) / (now - tpsT0);
    tpsTicks = 0;
    tpsT0 = now;
  }
  if (wantFrame) {
    try {
      sendFrame(w);
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
    }
  }
  if (paused) return;
  if (max || owed >= 1) schedule();
  else if (!wake) {
    // sleep until the next tick is due
    const ms = ((1 - owed) / (TPS * speed)) * 1000;
    wake = setTimeout(() => {
      wake = null;
      schedule();
    }, Math.max(1, ms));
  }
}

function sendFrame(w: World) {
  wantFrame = false;
  const { snap, transfer } = sync.build(w, {
    gen,
    full: false,
    changed,
    selected,
    perf: [paused ? 0 : tps, stepMs, threadCount(w)],
    select: pendingSelect,
  });
  changed = false;
  pendingSelect = undefined;
  send({ type: 'frame', snap }, transfer);
}

function adopt(w: World) {
  world = w;
  startThreads(w);
  gen++;
  sync.reset();
  owed = 0;
  changed = true;
  pendingSelect = undefined;
  const { snap, transfer } = sync.build(w, { gen, full: true, changed: true, selected: -1, perf: [0, stepMs, 1] });
  send({ type: 'reset', gen, seed: w.seed, width: w.width, params: { ...w.params }, snap }, transfer);
  // the world runs from now on, whether or not anyone is watching
  clock = performance.now();
  schedule();
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'threads':
        poolHelpers = m.pool;
        kernelHelpers = m.kernels;
        break;
      case 'new':
        adopt(makeWorld(m.seed, m.params ? { ...m.params } : undefined, m.width));
        break;
      case 'load':
        try {
          adopt(await blobToWorld(m.blob));
          send({ type: 'loaded', id: m.id });
        } catch (err) {
          send({ type: 'loaded', id: m.id, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'save':
        if (!world) break;
        try {
          send({ type: 'saved', id: m.id, blob: await worldToBlob(world) });
        } catch (err) {
          send({ type: 'saved', id: m.id, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'cmd': {
        if (!world || m.gen !== gen) break;
        const r = applyCommand(world, m.cmd);
        if (r.select) pendingSelect = r.select;
        changed = true;
        sync.envDirty = true;
        break;
      }
      case 'frame':
        sync.pool.give(m.returned);
        if (m.speed !== speed || m.paused !== paused) tickClock(performance.now());
        speed = m.speed;
        paused = m.paused;
        selected = m.selected;
        wantFrame = true;
        schedule();
        break;
      case 'step':
        if (world) {
          world.step();
          changed = true;
        }
        break;
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
