/**
 * Web Worker entry point for the Path Optimizer: each instance simulates one fresh ascension's build
 * phase at a time (`computeFreshLegs`), so a pool of these runs builds on several cores at once.
 *
 * Thin dispatcher only, like researchCalc.worker.ts: everything Pinia-bound (building the context,
 * start states and continue-current leg) stays on the main thread, and this worker only ever
 * receives that already resolved, once, in its `init` message.
 *
 * Loaded via Vite's native worker support:
 *   new Worker(new URL('../workers/optimizer.worker.ts', import.meta.url), { type: 'module' })
 */
import { computeFreshLegs, type FreshLegDeps } from '@/auto/optimizerSimulator';
import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from './optimizer.protocol';

// Typed as `Worker` rather than `DedicatedWorkerGlobalScope` — see researchCalc.worker.ts for why.
const ctx = self as unknown as Worker;

function post(message: OptimizerWorkerResponse): void {
  ctx.postMessage(message);
}

let deps: FreshLegDeps | null = null;

ctx.onmessage = (event: MessageEvent<OptimizerWorkerRequest>) => {
  const msg = event.data;
  if (msg.kind === 'init') {
    deps = msg.deps;
    post({ type: 'ready' });
    return;
  }

  try {
    if (!deps) throw new Error('Optimizer worker used before init');
    const legs = computeFreshLegs(deps, msg.node, msg.targets, msg.withArtifactSets);
    post({ type: 'result', requestId: msg.requestId, legs });
  } catch (err) {
    post({ type: 'error', requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
  }
};
