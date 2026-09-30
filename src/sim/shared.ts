// Typed arrays that other threads can read. When the simulation runs on several cores (see
// threads.ts), the world's arrays live in SharedArrayBuffers so helper threads can see them without
// copying. Call shareMemory(true) before creating such a world; otherwise these are ordinary arrays.

let shared = false;

/** Can this thread create shared memory? (Browsers allow it only on cross-origin-isolated pages.) */
export function canShareMemory(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  const g = globalThis as { crossOriginIsolated?: boolean };
  return g.crossOriginIsolated !== false;
}

/** Allocate the arrays of worlds created from now on in shared memory (or not). */
export function shareMemory(on: boolean) {
  shared = on && canShareMemory();
}

export function isSharing(): boolean {
  return shared;
}

function buffer(bytes: number): ArrayBuffer {
  return shared ? (new SharedArrayBuffer(bytes) as unknown as ArrayBuffer) : new ArrayBuffer(bytes);
}

export const f32 = (n: number) => new Float32Array(buffer(n * 4));
export const f64 = (n: number) => new Float64Array(buffer(n * 8));
export const i32 = (n: number) => new Int32Array(buffer(n * 4));
export const i16 = (n: number) => new Int16Array(buffer(n * 2));
export const u8 = (n: number) => new Uint8Array(buffer(n));
