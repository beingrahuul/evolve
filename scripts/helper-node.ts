// A simulation helper thread under Node (for scripts/bench.ts); the browser uses src/sim/helper.ts.
import { Worker, parentPort } from 'node:worker_threads';
import { runHelper } from '../src/sim/helperCore';
import type { HelperHandle, HelperSetup } from '../src/sim/threads';

parentPort!.on('message', (m: HelperSetup) =>
  runHelper(m, () => new Worker(new URL('./helper-node.mjs', import.meta.url)) as unknown as HelperHandle),
);
