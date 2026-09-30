import { defineConfig } from 'vite';

// The simulation shares memory between its threads (SharedArrayBuffer), which browsers allow only
// on cross-origin-isolated pages. Without these headers it still runs, on one simulation thread.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  // workers start workers of their own (the simulation's helper threads)
  worker: { format: 'es' },
});
