import { toRaw } from 'vue';
import { ei } from 'lib';
import { sanitizeLongs } from '@/lib/artifacts/utils';
import { computeContinueLegs, type ContinueStart, type FreshLegDeps } from './optimizerSimulator';
import type { LegOutcome, OptimizerSimulator, StartNode } from './optimizer';
import type { OptimizerWorkerRequest, OptimizerWorkerResponse } from '@/workers/optimizer.protocol';

export interface WorkerPoolSimulator extends OptimizerSimulator {
  freshLegs(node: StartNode, targets: number[], withArtifactSets?: boolean): Promise<LegOutcome[]>;
  /** Stops every worker at once (mid-build included); anything still pending is rejected. */
  terminate(): void;
}

interface Task {
  node: StartNode;
  targets: number[];
  withArtifactSets?: boolean;
  resolve: (legs: LegOutcome[]) => void;
  reject: (err: Error) => void;
}

const FIRST_WORKER_TIMEOUT_MS = 60_000;

/**
 * A plain copy of the whole backup that reads exactly like the original. Workers used to get
 * `redactBackupForStorage`'s reduced copy, and on a real save that made H1 pick a much weaker ELR set
 * than Generate did (bug: 2026-10-22, worker ELR less than half of Generate's), so the full backup is
 * sent instead. It's converted with `toObject({ defaults: true })` rather than copied field by field:
 * a decoded protobufjs message keeps fields absent from the wire at their default (0: COMMON rarity,
 * the first tier, LUNAR_TOTEM) on its prototype, which any own-property copy (sanitizeLongs,
 * structuredClone) would silently turn into `undefined`.
 */
export function backupForWorker(backup: ei.IBackup | null | undefined): ei.IBackup | undefined {
  if (!backup) return undefined;
  const raw = toRaw(backup);
  if (raw instanceof ei.Backup) {
    return ei.Backup.toObject(raw, { longs: Number, enums: Number, defaults: true, arrays: true, objects: true });
  }
  // Already plain (e.g. restored from a saved plan): nothing hidden on a prototype to lose.
  return sanitizeLongs(raw);
}

/** Logical cores the browser reports (it can't tell performance from efficiency cores apart). */
export function availableCores(): number {
  return typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
}

/** Default worker count: half the cores, leaving the rest for the page and the OS. Each worker holds
 * its own copy of the engine and the save data, so more isn't free; the player can raise it. */
export function defaultPoolSize(): number {
  return Math.max(1, Math.floor(availableCores() / 2));
}

/** A requested worker count (null = default), kept between 1 and the core count. */
export function resolvePoolSize(requested: number | null): number {
  return Math.min(availableCores(), Math.max(1, requested ?? defaultPoolSize()));
}

/**
 * Starts `size` optimizer workers and resolves once the first is ready (the rest join as they load),
 * or rejects (after terminating them) if none starts — the caller then falls back to the main-thread
 * simulator.
 */
export async function createWorkerPoolSimulator(
  deps: FreshLegDeps,
  continueStart: ContinueStart | null,
  size: number = defaultPoolSize()
): Promise<WorkerPoolSimulator> {
  // Store state can still be Vue reactive Proxies and the backup holds protobufjs Longs; neither
  // survives postMessage (see useResearchCalcWorker.ts). sanitizeLongs rebuilds everything as plain
  // data — except the backup, which needs the protobuf-aware copy below.
  const workerDeps: FreshLegDeps = sanitizeLongs({ ...deps, context: { ...deps.context, rawBackup: undefined } });
  workerDeps.context.rawBackup = backupForWorker(deps.context.rawBackup);

  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const running = new Map<Worker, Task>();
  const queue: Task[] = [];
  let buildCount = 0;
  let stopped = false;
  let nextRequestId = 0;

  const pump = () => {
    while (!stopped && idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()!;
      const task = queue.shift()!;
      running.set(worker, task);
      buildCount++;
      const message: OptimizerWorkerRequest = {
        kind: 'freshLegs',
        requestId: ++nextRequestId,
        node: sanitizeLongs(task.node),
        targets: task.targets,
        withArtifactSets: task.withArtifactSets,
      };
      worker.postMessage(message);
    }
  };

  const terminate = () => {
    if (stopped) return;
    stopped = true;
    for (const worker of workers) worker.terminate();
    const err = new Error('Optimizer workers stopped');
    for (const task of [...running.values(), ...queue]) task.reject(err);
    running.clear();
    queue.length = 0;
  };

  // Workers that have finished loading and can take builds.
  const ready = new Set<Worker>();

  const starting = Array.from({ length: size }, () => {
    const worker = new Worker(new URL('../workers/optimizer.worker.ts', import.meta.url), { type: 'module' });
    workers.push(worker);
    return new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<OptimizerWorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          ready.add(worker);
          idle.push(worker);
          resolve();
          pump();
          return;
        }
        const task = running.get(worker);
        running.delete(worker);
        idle.push(worker);
        if (task) {
          if (msg.type === 'error') task.reject(new Error(msg.message));
          else task.resolve(msg.legs);
        }
        pump();
      };
      // A worker-level failure (e.g. the bundle failing to load) has no request to route to. The
      // worker is dropped; its build, if it had one, fails the search.
      worker.onerror = (event: ErrorEvent) => {
        const err = new Error(event.message || 'Optimizer worker failed');
        reject(err);
        ready.delete(worker);
        const idleIdx = idle.indexOf(worker);
        if (idleIdx !== -1) idle.splice(idleIdx, 1);
        running.get(worker)?.reject(err);
        running.delete(worker);
      };
      const init: OptimizerWorkerRequest = { kind: 'init', deps: workerDeps };
      worker.postMessage(init);
    });
  });

  // A worker that fails after the search has started is just dropped (see onerror), not an error.
  for (const promise of starting) promise.catch(() => {});

  // Start as soon as one worker is ready; the rest join as they finish loading (the search reads
  // `concurrency` each time it hands out work). Loading can be slow — on the dev server each worker
  // fetches hundreds of unbundled modules, and every worker receives its own copy of the backup — so
  // waiting for all of them made a slow straggler push the whole search onto the main thread.
  try {
    await Promise.race([
      Promise.any(starting),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('no optimizer worker started within 60 seconds')), FIRST_WORKER_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    terminate();
    throw err instanceof AggregateError ? (err.errors[0] ?? err) : err;
  }

  return {
    get concurrency() {
      return Math.max(1, ready.size);
    },
    get buildCount() {
      return buildCount;
    },
    freshLegs(node, targets, withArtifactSets) {
      if (stopped) return Promise.reject(new Error('Optimizer workers stopped'));
      return new Promise<LegOutcome[]>((resolve, reject) => {
        queue.push({ node, targets, withArtifactSets, resolve, reject });
        pump();
      });
    },
    // Cheap (no build phase), so it simply runs here with the full, unreduced inputs.
    continueLegs: continueStart ? async targets => computeContinueLegs(deps, continueStart, targets) : null,
    terminate,
  };
}
