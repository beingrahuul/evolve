// Where the simulation runs. Normally in a Web Worker, so the main thread only draws and handles
// the UI; if workers are unavailable (or ?worker=0 is in the URL) it runs here, between frames.
import { Command, applyCommand } from './sim/commands';
import { GodParams, TPS, setWorldWidth } from './sim/params';
import { blobToWorld, worldToBlob } from './sim/savefile';
import { FromWorker, ToWorker, applySnapshot } from './sim/sync';
import { World, makeWorld } from './sim/world';

export interface SimHost {
  readonly kind: 'worker' | 'local';
  /** The world to draw and inspect: the live one, or the main thread's mirror of the worker's. */
  readonly world: World;
  /** False until the first world exists. */
  readonly ready: boolean;
  /** Simulation ticks per real second, and milliseconds per tick. */
  readonly tps: number;
  readonly stepMs: number;
  /** Threads simulating: 1, or more when helper threads share the work. */
  readonly threads: number;
  /** Called once per animation frame: advance the simulation by `dt` real seconds at `speed`. */
  frame(dt: number, speed: number, paused: boolean, selected: number): void;
  step(): void;
  cmd(c: Command): void;
  newWorld(seed: number, width: number, params: GodParams): void;
  save(): Promise<Blob>;
  load(blob: Blob): Promise<void>;
  /** A different world replaced the current one. */
  onReset: (w: World) => void;
  /** The simulation asks the UI to select an organism (one the player just made). */
  onSelect: (id: number) => void;
  /** The worker failed; the app falls back to simulating on the main thread. */
  onFail: (message: string) => void;
}

// ---------------------------------------------------------------------------

export class LocalHost implements SimHost {
  readonly kind = 'local';
  world: World;
  readonly ready = true;
  tps = 0;
  stepMs = 0;
  readonly threads = 1;
  private acc = 0;
  onReset = (_w: World) => {};
  onSelect = (_id: number) => {};
  onFail = (_m: string) => {};

  constructor(seed: number, width: number, params?: GodParams, world?: World) {
    this.world = world ?? makeWorld(seed, params ? { ...params } : undefined, width);
  }

  frame(dtReal: number, speed: number, paused: boolean) {
    if (paused) {
      this.tps = 0;
      return;
    }
    const budget = speed === Infinity ? 26 : 16;
    let wanted: number;
    if (speed === Infinity) wanted = 100000;
    else {
      this.acc = Math.min(this.acc + dtReal * TPS * speed, TPS * speed * 0.25);
      wanted = Math.floor(this.acc);
      this.acc -= wanted;
    }
    const t0 = performance.now();
    let n = 0;
    while (n < wanted) {
      this.world.step();
      n++;
      if (performance.now() - t0 > budget) {
        this.acc = 0;
        break;
      }
    }
    if (n > 0) this.stepMs = (performance.now() - t0) / n;
    this.tps = this.tps * 0.9 + (n / Math.max(1e-3, dtReal)) * 0.1;
  }

  step() {
    this.world.step();
  }

  cmd(c: Command) {
    const r = applyCommand(this.world, c);
    if (r.select) this.onSelect(r.select);
  }

  newWorld(seed: number, width: number, params: GodParams) {
    this.world = makeWorld(seed, { ...params }, width);
    this.onReset(this.world);
  }

  save(): Promise<Blob> {
    return worldToBlob(this.world);
  }

  async load(blob: Blob) {
    this.world = await blobToWorld(blob);
    this.onReset(this.world);
  }
}

// ---------------------------------------------------------------------------

export class WorkerHost implements SimHost {
  readonly kind = 'worker';
  world: World;
  ready = false;
  tps = 0;
  stepMs = 0;
  threads = 1;
  onReset = (_w: World) => {};
  onSelect = (_id: number) => {};
  onFail = (_m: string) => {};
  private worker: Worker;
  private gen = 0;
  private inFlight = false;
  private sentAt = 0;
  private returned: ArrayBuffer[] = [];
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(seed: number, width: number, params?: GodParams) {
    // a blank stand-in until the worker's world arrives
    setWorldWidth(width);
    this.world = new World(seed, params ? { ...params } : undefined, true);
    this.worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
    // helper threads for the simulation, if the page asks for a particular number (?pool=2&kernels=1)
    const q = new URLSearchParams(location.search);
    if (q.has('pool') || q.has('kernels')) {
      this.post({ type: 'threads', pool: Number(q.get('pool') ?? 2), kernels: Number(q.get('kernels') ?? 1) });
    }
    this.worker.onerror = (e) => {
      e.preventDefault();
      // before the first world exists, fall back to the main thread; afterwards keep the world going
      if (!this.ready) this.fail(e.message || 'The simulation worker failed to start.');
      else console.error('Simulation worker error:', e.message);
    };
    this.post({ type: 'new', seed, width, params });
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private fail(message: string) {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error(message));
    this.waiting.clear();
    this.onFail(message);
  }

  private receive(m: FromWorker) {
    switch (m.type) {
      case 'reset': {
        setWorldWidth(m.width);
        const w = new World(m.seed, m.params, true);
        this.returned.push(...applySnapshot(w, m.snap));
        this.world = w;
        this.gen = m.gen;
        this.ready = true;
        this.inFlight = false;
        this.onReset(w);
        break;
      }
      case 'frame': {
        const s = m.snap;
        if (s.gen === this.gen) {
          this.returned.push(...applySnapshot(this.world, s));
          [this.tps, this.stepMs, this.threads] = s.perf;
          if (s.select) this.onSelect(s.select);
        }
        this.inFlight = false;
        break;
      }
      case 'saved':
      case 'loaded': {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (!w) break;
        if (m.error) w.reject(new Error(m.error));
        else w.resolve(m.type === 'saved' ? m.blob : undefined);
        break;
      }
      case 'error':
        console.error('Simulation error:', m.message);
        if (!this.ready) this.fail(m.message);
        this.inFlight = false;
        break;
    }
  }

  frame(_dt: number, speed: number, paused: boolean, selected: number) {
    // the worker keeps its own clock; a frame request just asks for the latest state
    // (one at a time, unless an answer seems lost)
    if (!this.ready || (this.inFlight && performance.now() - this.sentAt < 3000)) return;
    this.inFlight = true;
    this.sentAt = performance.now();
    const returned = this.returned;
    this.returned = [];
    this.post({ type: 'frame', speed, paused, selected, returned }, returned);
  }

  step() {
    this.post({ type: 'step' });
  }

  cmd(c: Command) {
    this.post({ type: 'cmd', gen: this.gen, cmd: c });
  }

  newWorld(seed: number, width: number, params: GodParams) {
    this.post({ type: 'new', seed, width, params: { ...params } });
  }

  private request<T>(m: ToWorker & { id: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(m.id, { resolve: resolve as (v: unknown) => void, reject });
      this.post(m);
    });
  }

  save(): Promise<Blob> {
    return this.request<Blob>({ type: 'save', id: this.nextId++ });
  }

  async load(blob: Blob) {
    await this.request<void>({ type: 'load', id: this.nextId++, blob });
  }
}

/** A simulation host: a worker when the browser allows it. */
export function createHost(seed: number, width: number, params?: GodParams): SimHost {
  const noWorker = new URLSearchParams(location.search).get('worker') === '0';
  if (!noWorker && typeof Worker !== 'undefined') {
    try {
      return new WorkerHost(seed, width, params);
    } catch (e) {
      console.warn('Could not start the simulation worker; simulating on the main thread.', e);
    }
  }
  return new LocalHost(seed, width, params);
}
