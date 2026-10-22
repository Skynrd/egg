import type { Action } from '@/types/actions/meta';
import type { VirtueEgg } from '@/types';
import { TE_BREAKPOINTS, countTEThresholdsPassed } from '@/lib/truthEggs';
import { computeShiftCosts } from './se-tracker';
import { timeToEarnTE } from './te-thresholds';
import { runH1 } from './shifts/h1';
import { runK3Purchases, type K3Purchases } from './shifts/k3';
import { distributeTargetTE, planAwakeTEWaits } from './shifts/te-wait';
import type { C3Variant } from './shifts/c3';
import type { EngineState, SimulationContext } from './types';

/**
 * The optimizer's fast path for an ascension's TE-earning tail (K3's wait through H2).
 *
 * `runAscensionFromC3Variant` re-runs H1 (an artifact-set search over up to ~500 combinations), K3's
 * purchases and the whole tail — building action records and UI snapshots — for every target, while
 * the optimizer only needs where the ascension ends. H1 and K3's purchases don't depend on the
 * target, so `prepareTail` runs them once per build variant with the real shift code, and
 * `evaluateTail` then replays the tail's arithmetic for any target.
 *
 * `evaluateTail` mirrors `runAscension`'s TE-goal path step for step — the same functions, in the
 * same order, so floating-point results match exactly (fastTail.spec.ts holds it to that). Any
 * change to how `runAscension`, `runK3`/`finishK3Wait` or `runTEWaitShift` time the tail must be
 * mirrored here.
 */

export interface PreparedTail {
  startState: EngineState;
  variant: C3Variant;
  /** Wall-clock start of the ascension. */
  startTime: number;
  /** State after H1 — what the regular K3 path distributes its TE goal from. */
  preK3State: EngineState;
  /** Elapsed seconds once H1 is done (when K3 starts). */
  elapsedBeforeK3: number;
  purchases: K3Purchases;
  /** Shifts already spent before the TE-earning waits: the opening, C3, H1 and K3's own shift. */
  shiftsBeforeWaits: number;
  awake: SimulationContext['awakeHours'];
  /** Actions from C1 through H1, for artifact-set diagnostics only. */
  buildActions: Action[];
}

export interface TailResult {
  endTime: number;
  elapsedSeconds: number;
  endTE: number;
  finalTE: Record<VirtueEgg, number>;
  eggsDelivered: Record<VirtueEgg, number>;
  shifts: number;
  endShiftCount: number;
  endSoulEggs: number;
  maxELR: number;
}

const EGGS: VirtueEgg[] = ['curiosity', 'integrity', 'resilience', 'humility', 'kindness'];
// runAscension's fixed order for the regular (no awake hours) path.
const REGULAR_WAIT_ORDER: VirtueEgg[] = ['curiosity', 'integrity', 'resilience', 'humility'];
const MAX_TE_PER_EGG = TE_BREAKPOINTS.length;

const countShifts = (actions: Action[]) => actions.filter(a => a.type === 'shift').length;

/** Runs everything up to K3's wait once, exactly as `runAscension` does when resuming at H1. */
export function prepareTail(
  startState: EngineState,
  preC3: { actions: Action[]; elapsedSeconds: number },
  variant: C3Variant,
  context: SimulationContext,
  startTime: number
): PreparedTail {
  let state: EngineState = JSON.parse(JSON.stringify(variant.result.endState));
  let elapsed = preC3.elapsedSeconds + variant.result.elapsedSeconds;

  state.lastStepTime = elapsed;
  const h1 = runH1(state, context);
  state = h1.endState;
  elapsed += h1.elapsedSeconds;

  state.lastStepTime = elapsed;
  const purchases = runK3Purchases(state, context);

  return {
    startState,
    variant,
    startTime,
    preK3State: state,
    elapsedBeforeK3: elapsed,
    purchases,
    shiftsBeforeWaits:
      countShifts(preC3.actions) + countShifts(variant.result.actions) + countShifts(h1.actions) + countShifts(purchases.actions),
    awake: context.awakeHours,
    buildActions: [...preC3.actions, ...variant.result.actions, ...h1.actions],
  };
}

/** Where the ascension ends for `targetTE`, without building actions or snapshots. */
export function evaluateTail(prep: PreparedTail, targetTE: number): TailResult {
  const { purchases, variant } = prep;
  const peakELR = purchases.peakELR;
  const delivered = { ...purchases.endState.eggsDelivered } as Record<VirtueEgg, number>;
  let total = prep.elapsedBeforeK3;
  let waitShifts = 0;

  // runTEWaitShift's timing: skip (no shift) when the egg already has its target or there's no time;
  // otherwise shift, then wait min(time to target, maxWait) unless that's infinite.
  const waitOn = (egg: VirtueEgg, target: number, maxWait: number) => {
    const before = delivered[egg] || 0;
    const current = countTEThresholdsPassed(before);
    if (target <= current || maxWait <= 0) return;
    waitShifts++;
    const raw = timeToEarnTE(before, peakELR, target - current);
    const wait = raw === Infinity ? raw : Math.min(raw, maxWait);
    if (wait > 0 && wait !== Infinity) {
      delivered[egg] = before + peakELR * wait;
      total += wait;
    }
  };

  // finishK3Wait's timing: wait exactly `wait` seconds on kindness after the purchases.
  const k3Wait = (wait: number) => {
    let k3Elapsed = purchases.elapsedSeconds;
    if (wait > 0) {
      delivered.kindness = (delivered.kindness || 0) + peakELR * wait;
      k3Elapsed += wait;
    }
    total += k3Elapsed;
  };

  const plan = prep.awake
    ? planAwakeTEWaits({
        startTime: purchases.absTimeAfterPurchases,
        firstEgg: 'kindness',
        firstMinWait: Math.max(0, variant.buildPhaseEnd - purchases.absTimeAfterPurchases),
        eggsDelivered: purchases.endState.eggsDelivered,
        peakELR,
        targetTE,
        awake: prep.awake,
      })
    : null;

  if (plan) {
    k3Wait(plan[0]?.egg === 'kindness' ? plan[0].waitSeconds : 0);
    for (const step of plan) {
      if (step.egg !== 'kindness') waitOn(step.egg, MAX_TE_PER_EGG, step.waitSeconds);
    }
  } else {
    // runK3: the kindness share comes from the state *before* K3's purchases.
    const kindnessTarget = distributeTargetTE(prep.preK3State.eggsDelivered, targetTE, [])['kindness'];
    let wait = Math.max(0, variant.buildPhaseEnd - purchases.absTimeAfterPurchases);
    const kindnessNow = delivered.kindness || 0;
    const needed = Math.max(0, kindnessTarget - countTEThresholdsPassed(kindnessNow));
    if (needed > 0) wait = Math.max(wait, timeToEarnTE(kindnessNow, peakELR, needed));
    k3Wait(wait);

    const locked: VirtueEgg[] = ['kindness'];
    for (const egg of REGULAR_WAIT_ORDER) {
      waitOn(egg, distributeTargetTE(delivered, targetTE, locked)[egg], Infinity);
      locked.push(egg);
    }
  }

  const finalTE = Object.fromEntries(EGGS.map(egg => [egg, countTEThresholdsPassed(delivered[egg] || 0)])) as Record<
    VirtueEgg,
    number
  >;
  const shifts = prep.shiftsBeforeWaits + waitShifts;
  const se = computeShiftCosts(prep.startState.soulEggs, prep.startState.shiftCount, shifts);
  return {
    endTime: prep.startTime + total,
    elapsedSeconds: total,
    endTE: Object.values(finalTE).reduce((a, b) => a + b, 0),
    finalTE,
    eggsDelivered: delivered,
    shifts,
    endShiftCount: se.endingShiftCount,
    endSoulEggs: se.endingSE,
    maxELR: peakELR,
  };
}
