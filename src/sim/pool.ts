// A fork-join pool: the thread that owns it splits a loop into chunks, which it and its helper
// threads run together (the helpers see the same shared arrays). Without helpers the chunks simply
// run in turn on the owner, so code that uses a pool behaves the same either way.

/** Runs a slice of a job; chunk numbers let a job keep per-chunk partial results (sums). */
export interface KernelRunner {
  kernel(job: number, from: number, to: number, chunk: number): void;
}

/** Shared control block (Int32Array). */
export const PC = {
  EPOCH: 0,
  JOB: 1,
  COUNT: 2,
  CHUNK: 3,
  CHUNKS: 4,
  NEXT: 5,
  DONE: 6,
  READY: 7,
  SIZE: 8,
} as const;

/** The owner spins this many checks for its helpers to finish before sleeping. */
const SPIN = 20000;
/**
 * After each job a helper stays awake this long (ms) before it sleeps, in case another follows at
 * once. Kept short: a spinning thread takes a core from threads with real work when cores are
 * scarce (a background tab, hyper-threads, other programs), which costs far more than waking up.
 */
const STAY_AWAKE_MS = 0.05;
/** A helper that has not finished its slice after this long has died: stop using helpers. */
const STALL_MS = 3000;

export class Pool {
  /** The control block, shared with the helper threads. */
  readonly ctrl: Int32Array;

  constructor(
    private runner: KernelRunner,
    shared: boolean,
  ) {
    this.ctrl = shared ? new Int32Array(new SharedArrayBuffer(PC.SIZE * 4)) : new Int32Array(PC.SIZE);
  }

  private stalled = false;

  /** Helper threads that are up. */
  get helpers(): number {
    return this.stalled ? 0 : Atomics.load(this.ctrl, PC.READY);
  }

  /**
   * Run `job` over [0, count) in chunks of `chunk`. Returns how many chunks it was split into, or 0
   * if a helper died on its slice (the pool then works alone).
   */
  run(job: number, count: number, chunk: number): number {
    const chunks = Math.max(1, Math.ceil(count / chunk));
    if (chunks === 1 || this.helpers === 0) {
      for (let k = 0; k < chunks; k++) this.runner.kernel(job, k * chunk, Math.min(count, (k + 1) * chunk), k);
      return chunks;
    }
    const c = this.ctrl;
    // the job first, then the counters (a helper reads the job only after taking a chunk)
    Atomics.store(c, PC.JOB, job);
    Atomics.store(c, PC.COUNT, count);
    Atomics.store(c, PC.CHUNK, chunk);
    Atomics.store(c, PC.CHUNKS, chunks);
    Atomics.store(c, PC.DONE, 0);
    Atomics.store(c, PC.NEXT, 0);
    Atomics.add(c, PC.EPOCH, 1);
    Atomics.notify(c, PC.EPOCH);
    for (;;) {
      const k = Atomics.add(c, PC.NEXT, 1);
      if (k >= chunks) break;
      this.runner.kernel(job, k * chunk, Math.min(count, (k + 1) * chunk), k);
      Atomics.add(c, PC.DONE, 1);
    }
    let spins = 0;
    let t0 = 0;
    for (;;) {
      const d = Atomics.load(c, PC.DONE);
      if (d >= chunks) break;
      if (++spins > SPIN) {
        Atomics.wait(c, PC.DONE, d, 5);
        if (!t0) t0 = performance.now();
        else if (performance.now() - t0 > STALL_MS) {
          this.stalled = true;
          return 0;
        }
      }
    }
    return chunks;
  }
}

/**
 * A helper thread's side of a pool: run chunks of whatever job the owner posts, forever. While jobs
 * come thick and fast (a fast simulation, or the ~30 jobs of one water step) it stays awake, since
 * waking a sleeping thread takes longer than the jobs themselves; otherwise it sleeps.
 */
export function servePool(ctrl: Int32Array, runner: KernelRunner) {
  Atomics.add(ctrl, PC.READY, 1);
  let seen = Atomics.load(ctrl, PC.EPOCH);
  let lastJob = performance.now();
  for (;;) {
    let e = Atomics.load(ctrl, PC.EPOCH);
    if (e === seen) {
      const until = lastJob + STAY_AWAKE_MS;
      while (e === seen && performance.now() < until) {
        for (let s = 0; s < 64 && e === seen; s++) e = Atomics.load(ctrl, PC.EPOCH);
      }
      if (e === seen) {
        Atomics.wait(ctrl, PC.EPOCH, seen, 1000);
        continue;
      }
    }
    seen = e;
    for (;;) {
      const k = Atomics.add(ctrl, PC.NEXT, 1);
      const chunks = Atomics.load(ctrl, PC.CHUNKS);
      if (k >= chunks) break;
      const chunk = Atomics.load(ctrl, PC.CHUNK);
      const count = Atomics.load(ctrl, PC.COUNT);
      runner.kernel(Atomics.load(ctrl, PC.JOB), k * chunk, Math.min(count, (k + 1) * chunk), k);
      if (Atomics.add(ctrl, PC.DONE, 1) + 1 >= chunks) Atomics.notify(ctrl, PC.DONE);
    }
    lastJob = performance.now();
  }
}
