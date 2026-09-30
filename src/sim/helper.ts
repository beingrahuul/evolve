/// <reference lib="webworker" />
// A helper thread of the simulation worker (see threads.ts and helperCore.ts).
import { runHelper } from './helperCore';
import type { HelperSetup } from './threads';

self.onmessage = (e: MessageEvent<HelperSetup>) =>
  runHelper(e.data, () => new Worker(new URL('./helper.ts', import.meta.url), { type: 'module' }));
