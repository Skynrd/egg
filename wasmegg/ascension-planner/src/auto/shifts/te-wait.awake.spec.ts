import { describe, expect, test } from 'vitest';
import { modifiersFromColleggtibleTiers } from 'lib/collegtibles';
import { countTEThresholdsPassed, getThresholdForTE } from '@/lib/truthEggs';
import { isAwake, nextAwakeTime, type AwakeHours } from '../awakeHours';
import { runContinueCurrent } from '../ascension';
import { distributeTargetTE, planAwakeTEWaits, type PlannedWait } from './te-wait';
import { timeToEarnTE } from '../te-thresholds';
import type { EngineState, SimulationContext } from '../types';
import type { VirtueEgg } from '@/types';

const EGGS: VirtueEgg[] = ['kindness', 'curiosity', 'integrity', 'resilience', 'humility'];
const AWAKE: AwakeHours = { start: '08:00', end: '23:00', timezone: 'UTC' };
const START = Date.parse('2026-10-24T09:00:00Z') / 1000;

// Every egg at 30 TE (just past the threshold); one more TE takes about 1.5 days.
const DELIVERED = Object.fromEntries(EGGS.map(e => [e, getThresholdForTE(30) * 1.001])) as Record<VirtueEgg, number>;
const ELR = (getThresholdForTE(31) - getThresholdForTE(30)) / (1.5 * 86400);
const START_TE = 150;

function replay(steps: PlannedWait[]) {
  const delivered = { ...DELIVERED };
  let time = START;
  const boundaries: number[] = [];
  for (const step of steps) {
    delivered[step.egg] += ELR * step.waitSeconds;
    time += step.waitSeconds;
    boundaries.push(time);
  }
  const te = EGGS.reduce((sum, e) => sum + countTEThresholdsPassed(delivered[e]), 0);
  return { te, end: time, boundaries };
}

/** Today's behavior plus the most naive fix: fixed order, greedy shares, each shift pushed to wake-up. */
function naiveEnd(targetTE: number, firstMinWait: number): number {
  const delivered = { ...DELIVERED };
  const locked: VirtueEgg[] = [];
  let time = START;
  for (const [i, egg] of EGGS.entries()) {
    const targets = distributeTargetTE(delivered, targetTE, locked);
    const need = targets[egg] - countTEThresholdsPassed(delivered[egg]);
    let wait = Math.max(i === 0 ? firstMinWait : 0, timeToEarnTE(delivered[egg], ELR, need));
    // +1s: the same float-safety margin the planner adds to wake-up shifts.
    if (wait > 0 && !isAwake(time + wait, AWAKE)) wait = nextAwakeTime(time + wait, AWAKE) + 1 - time;
    delivered[egg] += ELR * wait;
    time += wait;
    locked.push(egg);
  }
  return time;
}

describe('planAwakeTEWaits', () => {
  const input = (targetTE: number, firstMinWait = 0) => ({
    startTime: START,
    firstEgg: 'kindness' as VirtueEgg,
    firstMinWait,
    eggsDelivered: DELIVERED,
    peakELR: ELR,
    targetTE,
    awake: AWAKE,
  });

  test.each([START_TE + 3, START_TE + 7, START_TE + 12])('reaches %i TE with every shift while awake', target => {
    const plan = planAwakeTEWaits(input(target))!;
    expect(plan).not.toBeNull();
    const { te, boundaries } = replay(plan);
    expect(te).toBeGreaterThanOrEqual(target);
    for (const t of boundaries) expect(isAwake(t, AWAKE)).toBe(true);
  });

  test('never finishes later than shifting in a fixed order and waiting for wake-up', () => {
    for (let target = START_TE + 2; target <= START_TE + 12; target++) {
      const { end } = replay(planAwakeTEWaits(input(target))!);
      expect(end).toBeLessThanOrEqual(naiveEnd(target, 0));
    }
  });

  test('honors the mandatory first wait (K3 waits out the build-phase sale)', () => {
    const minWait = 3 * 86400;
    const plan = planAwakeTEWaits(input(START_TE + 5, minWait))!;
    expect(plan[0].egg).toBe('kindness');
    expect(plan[0].waitSeconds).toBeGreaterThanOrEqual(minWait);
  });

  test('never shifts to an egg it has nothing to earn on', () => {
    const plan = planAwakeTEWaits(input(START_TE + 2))!;
    expect(plan.length).toBeLessThanOrEqual(3);
  });
});

describe('runContinueCurrent with awake hours', () => {
  test('ends while awake and reaches the target', () => {
    const state = {
      currentEgg: 'kindness', shiftCount: 0, te: START_TE, soulEggs: 1e20, bankValue: 0,
      habIds: [0, null, null, null], vehicles: [{ vehicleId: 0, trainLength: 1 }], researchLevels: {},
      siloCount: 2, tankLevel: 0, artifactLoadout: [], activeArtifactSet: null,
      artifactSets: { earnings: null, elr: null }, fuelTankAmounts: {},
      eggsDelivered: { ...DELIVERED },
      teEarned: Object.fromEntries(EGGS.map(e => [e, 30])),
      population: 1e18, lastStepTime: 0,
      activeSales: { research: false, hab: false, vehicle: false },
      earningsBoost: { active: false, multiplier: 1 },
    } as unknown as EngineState;
    const context: SimulationContext = {
      epicResearchLevels: {},
      colleggtibleModifiers: modifiersFromColleggtibleTiers({}),
      ascensionStartTime: START,
      planStartOffset: 0,
      assumeDoubleEarnings: false,
      deferForEarningsMode: false,
      awakeHours: AWAKE,
    };

    const { summary, actions } = runContinueCurrent(state, context, START, ELR, START_TE + 7);
    expect(summary.endTE).toBeGreaterThanOrEqual(START_TE + 7);
    expect(isAwake(summary.endTime, AWAKE)).toBe(true);

    let t = START;
    for (const action of actions) {
      if (action.type === 'shift') expect(isAwake(t, AWAKE)).toBe(true);
      t += action.totalTimeSeconds || 0;
    }
  });
});
