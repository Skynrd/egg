import type { EngineState, SimulationContext, ShiftResult } from '../types';
import { computeSnapshot } from '../../engine/compute';
import { applyAction } from '../../engine/apply';
import { createSimAction } from '@/types/actions/meta';
import { computeRealisticELR } from '../../calculations/realisticELR';
import { calculateArtifactModifiers } from '@/lib/artifacts';
import { countTEThresholdsPassed } from '@/lib/truthEggs';
import { computeTEEarned, timeToEarnTE } from '../te-thresholds';
import { applyShiftAction } from './helpers/actionHelpers';
import { runMaxVehiclesPlan } from './helpers/vehicles';

/**
 * K3 Shift Strategy:
 * 1. Shift to Kindness.
 * 2. Buy any remaining vehicles/trains unlocked by C3.
 * 3. Compute peak ELR.
 * 4. Wait until buildPhaseEnd.
 *
 * @param maxWaitSeconds - Hard ceiling on step 4's own wait duration (see `runTEWaitShift`'s doc
 *   comment for the general mechanism). Defaults to unbounded, so every pre-existing caller is
 *   unaffected. Callers passing a finite value MUST ensure `buildPhaseEnd` itself is reachable
 *   within it (i.e. `buildPhaseEnd - startTime <= maxWaitSeconds`, roughly) — this clamp protects
 *   the deadline from being overrun by extra *TE-target-driven* waiting on top of the mandatory
 *   build-phase-end wait, but it does NOT know `buildPhaseEnd` is mandatory and would truncate that
 *   base wait too if the caller got the two out of sync (`runC3Variants`' own filtering, done before
 *   any variant reaches this shift, is what's expected to guarantee this).
 */
export function runK3(
  startState: EngineState,
  context: SimulationContext,
  buildPhaseEnd: number = 0,
  targetTEForEgg?: number,
  maxWaitSeconds: number = Infinity
): ShiftResult {
  const purchases = runK3Purchases(startState, context);
  const { endState: currentState, peakELR } = purchases;

  // 4. Wait
  let waitDuration = Math.max(0, buildPhaseEnd - purchases.absTimeAfterPurchases);

  if (targetTEForEgg !== undefined) {
    const currentEggsDelivered = currentState.eggsDelivered['kindness'] || 0;
    const currentTE = countTEThresholdsPassed(currentEggsDelivered);
    const neededTE = Math.max(0, targetTEForEgg - currentTE);

    if (neededTE > 0) {
      const teWaitTime = timeToEarnTE(currentEggsDelivered, peakELR, neededTE);
      // We wait until buildPhaseEnd (end of sale) but extend it if more TE is needed.
      waitDuration = Math.max(waitDuration, teWaitTime);
    }
  }

  // See this function's doc comment: callers passing a finite `maxWaitSeconds` are expected to have
  // already guaranteed `buildPhaseEnd` fits inside it, so this clamp only ever trims the
  // TE-target-driven extension above, never the mandatory build-phase wait itself.
  waitDuration = Math.min(waitDuration, maxWaitSeconds);

  return finishK3Wait(purchases, context, waitDuration);
}

export interface K3Purchases extends ShiftResult {
  peakELR: number;
  /** Wall-clock time once the purchases are done, i.e. when K3's wait begins. */
  absTimeAfterPurchases: number;
}

/**
 * K3 steps 1–3: shift to Kindness, buy the remaining vehicles/trains, and compute peak ELR. Split
 * from the wait (`finishK3Wait`) so awake-hours scheduling can plan the wait from this exact state.
 */
export function runK3Purchases(startState: EngineState, context: SimulationContext): K3Purchases {
  // 1. Shift to Kindness
  const shifted = applyShiftAction(startState, context, 'kindness');

  // 2. Buy any remaining vehicles/trains (unbounded, same as this shift's previous behavior)
  const vehiclePlan = runMaxVehiclesPlan(shifted.state, context, Infinity);

  const currentState = vehiclePlan.endState;
  const elapsedSeconds = vehiclePlan.elapsedSeconds;
  const actions = [shifted.action, ...vehiclePlan.actions];

  // 3. Compute peak ELR
  const artMods = calculateArtifactModifiers(currentState.artifactLoadout);
  const elrResult = computeRealisticELR(
    currentState.researchLevels,
    artMods,
    context.epicResearchLevels,
    context.colleggtibleModifiers
  );

  const peakELR = elrResult.effectiveRate;
  currentState.maxELR = peakELR;

  // Attach peakELR to the shift action (the first action) so the UI summary can find it easily
  if (actions.length > 0 && actions[0].type === 'shift') {
    actions[0].payload.peakELR = peakELR;
  }

  const absTimeAfterPurchases =
    context.ascensionStartTime + ((startState.lastStepTime || 0) - context.planStartOffset) + elapsedSeconds;

  return { actions, elapsedSeconds, endState: currentState, peakELR, absTimeAfterPurchases };
}

/** K3 step 4: wait exactly `waitDuration` seconds on Kindness after `runK3Purchases`. */
export function finishK3Wait(purchases: K3Purchases, context: SimulationContext, waitDuration: number): ShiftResult {
  let currentState = purchases.endState;
  let elapsedSeconds = purchases.elapsedSeconds;
  const actions = [...purchases.actions];
  const peakELR = purchases.peakELR;

  if (waitDuration > 0) {
    const currentEggsDelivered = currentState.eggsDelivered['kindness'] || 0;
    const currentTE = countTEThresholdsPassed(currentEggsDelivered);

    const teResult = computeTEEarned(currentEggsDelivered, peakELR, waitDuration);

    const waitAction = createSimAction('wait_for_te', {
      egg: 'kindness',
      targetTE: currentTE + teResult.teEarned,
      teGained: teResult.teEarned,
      eggsToLay: teResult.finalEggsDelivered - currentEggsDelivered,
      timeSeconds: waitDuration,
      startEggsDelivered: currentEggsDelivered,
      startTE: currentTE,
    });

    currentState = applyAction(currentState, waitAction);

    const snap = computeSnapshot(currentState, context, { skipGrowth: true });
    currentState.bankValue += snap.offlineEarnings * waitDuration;

    currentState.eggsDelivered = { ...currentState.eggsDelivered, kindness: teResult.finalEggsDelivered };
    currentState.teEarned = {
      ...currentState.teEarned,
      kindness: (currentState.teEarned['kindness'] || 0) + teResult.teEarned,
    };
    currentState.te = Object.values(currentState.teEarned).reduce((a, b) => (a as number) + (b as number), 0);

    // Decoration
    const finalSnap = computeSnapshot(currentState, context, { skipGrowth: true });
    waitAction.endState = finalSnap;
    waitAction.totalTimeSeconds = waitDuration;
    waitAction.bankDelta = snap.offlineEarnings * waitDuration;

    actions.push(waitAction);
    elapsedSeconds += waitDuration;
  }

  return {
    actions,
    elapsedSeconds,
    endState: currentState,
  };
}
