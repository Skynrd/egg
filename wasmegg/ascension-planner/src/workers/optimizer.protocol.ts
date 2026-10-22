/**
 * Message protocol between the main thread (auto/optimizerWorkerPool.ts) and optimizer.worker.ts,
 * which simulates fresh-ascension build phases for the Path Optimizer in parallel.
 */
import type { FreshLegDeps } from '@/auto/optimizerSimulator';
import type { LegOutcome, StartNode } from '@/auto/optimizer';

/** Sent once per worker. `deps` must already be plain, Proxy-free and Long-free data (see
 * optimizerWorkerPool.ts), with `context.rawBackup` reduced to what artifact selection reads. */
export interface InitRequest {
  kind: 'init';
  deps: FreshLegDeps;
}

export interface FreshLegsRequest {
  kind: 'freshLegs';
  requestId: number;
  node: StartNode;
  targets: number[];
  /** Include artifact-set fingerprints in each outcome's `diag` (diagnostics only). */
  withArtifactSets?: boolean;
}

export type OptimizerWorkerRequest = InitRequest | FreshLegsRequest;

export type OptimizerWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; requestId: number; legs: LegOutcome[] }
  | { type: 'error'; requestId: number | null; message: string };
