import { runUntilShift, deriveNextStartState, runContinueCurrent } from './ascension';
import { evaluateTail, prepareTail, type PreparedTail, type TailResult } from './fastTail';
import { runC3Variants } from './shifts/c3';
import type { EngineState, SimulationContext, AscensionSummary } from './types';
import type { Action } from '@/types/actions/meta';
import type { UpdateArtifactSetPayload } from '@/types/actions/artifacts';
import type { VariantKey } from '@/stores/autoPlanner';
import type { LegOutcome, OptimizerSimulator, StartNode } from './optimizer';

// Must match useAscensionGenerator's own threshold so optimizer predictions equal generated plans.
export const TIER_13_MIN_STARTING_TE = 190;

/** Everything needed to simulate fresh ascensions — plain data, so it can be posted to a worker. */
export interface FreshLegDeps {
  /** Simulation context template; `ascensionStartTime`/`planStartOffset` are set per ascension. */
  context: SimulationContext;
  /** Start state for a fresh first ascension. */
  rootFreshState: EngineState;
  /** Permanent-upgrades state that `deriveNextStartState` layers each next ascension onto. */
  baseBackupState: EngineState;
}

/** The player's current farm, for the "continue current" first leg. */
export interface ContinueStart {
  state: EngineState;
  elr: number;
  startTime: number;
}

/** Compact fingerprint of the artifact sets a leg chose (C1's earnings set, H1's ELR set), so two
 * simulations of the same leg can be compared for diverging artifact choices. */
function artifactSetsFingerprint(actions: Action[]): string {
  return actions
    .filter(a => a.type === 'update_artifact_set')
    .map(a => {
      const { setName, newLoadout } = a.payload as UpdateArtifactSetPayload;
      const slots = newLoadout.map(s => [s.artifactId ?? '-', ...(s.stones ?? []).map(st => st ?? '-')].join('+'));
      return `${setName}[${slots.join(',')}]`;
    })
    .join(' ');
}

function toLeg(
  variantKey: VariantKey,
  targetTE: number,
  summary: AscensionSummary,
  actions: Action[],
  withArtifactSets = false,
  preC3Seconds?: number
): LegOutcome {
  return {
    diag: {
      maxELR: summary.maxELR,
      buildPhaseEnd: summary.buildPhaseEndTime,
      preC3Seconds,
      // Opt-in: a few hundred bytes per outcome adds up to tens of MB over a long search.
      artifactSets: withArtifactSets ? artifactSetsFingerprint(actions) : '',
    },
    variantKey,
    targetTE,
    endTE: summary.endTE,
    endTime: summary.endTime,
    shifts: summary.endShiftCount - summary.startShiftCount,
    endSoulEggs: summary.endSoulEggs,
    end: {
      finalTE: summary.finalTE,
      eggsDelivered: summary.eggsDelivered,
      endSoulEggs: summary.endSoulEggs,
      endShiftCount: summary.endShiftCount,
    },
  };
}

function tailToLeg(
  variantKey: VariantKey,
  targetTE: number,
  prep: PreparedTail,
  tail: TailResult,
  withArtifactSets: boolean,
  preC3Seconds: number
): LegOutcome {
  return {
    diag: {
      maxELR: tail.maxELR,
      buildPhaseEnd: prep.variant.buildPhaseEnd,
      preC3Seconds,
      artifactSets: withArtifactSets ? artifactSetsFingerprint(prep.buildActions) : '',
    },
    variantKey,
    targetTE,
    endTE: tail.endTE,
    endTime: tail.endTime,
    shifts: tail.shifts,
    endSoulEggs: tail.endSoulEggs,
    end: {
      finalTE: tail.finalTE,
      eggsDelivered: tail.eggsDelivered,
      endSoulEggs: tail.endSoulEggs,
      endShiftCount: tail.endShiftCount,
    },
  };
}

function isBetter(a: LegOutcome, b: LegOutcome | undefined): boolean {
  return !b || a.endTime < b.endTime || (a.endTime === b.endTime && a.shifts < b.shifts);
}

/**
 * Simulates one fresh ascension's build phase from `node`, then the best build variant's outcome
 * for each target. Nothing is retained afterwards: the (large) build state is dropped as soon as
 * every target has been evaluated.
 */
export function computeFreshLegs(
  deps: FreshLegDeps,
  node: StartNode,
  targets: number[],
  withArtifactSets = false
): LegOutcome[] {
  if (targets.length === 0) return [];
  const startState = node.prev ? deriveNextStartState(node.prev, deps.baseBackupState) : deps.rootFreshState;
  const context: SimulationContext = { ...deps.context, ascensionStartTime: node.startTime, planStartOffset: 0 };

  const t0 = performance.now();
  const precomputed = runUntilShift(startState, context, 'C3');
  const preC3 = { actions: precomputed.actions, state: precomputed.state, elapsedSeconds: precomputed.elapsedSeconds };
  const variants = runC3Variants(precomputed.state, context, 3, node.te < TIER_13_MIN_STARTING_TE).filter(
    v => !v.impossible
  );
  // H1 and K3's purchases don't depend on the target: run them once per variant (see fastTail.ts).
  const tails = variants.map(variant => ({
    key: (variant.attemptTier13Unlock ? `${variant.saleCount}-sale-tier13` : `${variant.saleCount}-sale`) as VariantKey,
    prep: prepareTail(startState, preC3, variant, context, node.startTime),
  }));
  const buildMs = performance.now() - t0;

  const legs: LegOutcome[] = [];
  for (const target of targets) {
    let best: LegOutcome | undefined;
    for (const { key, prep } of tails) {
      const leg = tailToLeg(key, target, prep, evaluateTail(prep, target), withArtifactSets, preC3.elapsedSeconds);
      if (isBetter(leg, best)) best = leg;
    }
    if (best) legs.push(best);
  }

  console.log(
    `[optimizer] build from ${node.te} TE at ${new Date(node.startTime * 1000).toISOString()}: ` +
      `${buildMs.toFixed(0)}ms build + ${(performance.now() - t0 - buildMs).toFixed(0)}ms for ${targets.length} targets`
  );
  return legs;
}

export function computeContinueLegs(
  deps: FreshLegDeps,
  start: ContinueStart,
  targets: number[],
  withArtifactSets = false
): LegOutcome[] {
  const context: SimulationContext = { ...deps.context, ascensionStartTime: start.startTime, planStartOffset: 0 };
  return targets.map(target => {
    const { summary, actions } = runContinueCurrent(start.state, context, start.startTime, start.elr, target, 'opt_continue');
    return toLeg('continue', target, summary, actions, withArtifactSets);
  });
}

/** Runs everything on the calling thread, one build at a time — the fallback when workers aren't
 * available, and what the tests use. */
export function createMainThreadSimulator(deps: FreshLegDeps, continueStart: ContinueStart | null): OptimizerSimulator {
  let buildCount = 0;
  // Let the UI repaint between builds, since each one blocks this thread for seconds.
  const breathe = () => new Promise(resolve => setTimeout(resolve, 15));
  return {
    concurrency: 1,
    get buildCount() {
      return buildCount;
    },
    async freshLegs(node, targets) {
      await breathe();
      buildCount++;
      return computeFreshLegs(deps, node, targets);
    },
    continueLegs: continueStart ? async targets => computeContinueLegs(deps, continueStart, targets) : null,
  };
}
