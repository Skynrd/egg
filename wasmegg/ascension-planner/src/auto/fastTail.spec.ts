import { describe, expect, test } from 'vitest';
import { ei } from 'lib';
import { modifiersFromColleggtibleTiers } from 'lib/collegtibles';
import { getThresholdForTE } from '@/lib/truthEggs';
import { runUntilShift, runAscensionFromC3Variant } from './ascension';
import { runC3Variants } from './shifts/c3';
import { evaluateTail, prepareTail } from './fastTail';
import type { EngineState, SimulationContext } from './types';

const EGGS = ['curiosity', 'integrity', 'resilience', 'humility', 'kindness'] as const;
const { Name, Level, Rarity } = ei.ArtifactSpec;

function startState(te: number): EngineState {
  const per = te / 5;
  const eggsDelivered: Record<string, number> = {};
  const teEarned: Record<string, number> = {};
  for (const egg of EGGS) {
    eggsDelivered[egg] = getThresholdForTE(per) * 1.0001;
    teEarned[egg] = per;
  }
  return {
    currentEgg: 'curiosity', shiftCount: 120, te, soulEggs: 1e40, bankValue: 0,
    habIds: [0, null, null, null], vehicles: [{ vehicleId: 0, trainLength: 1 }], researchLevels: {},
    siloCount: 1, tankLevel: 0, artifactLoadout: [], activeArtifactSet: null,
    artifactSets: { earnings: null, elr: null }, fuelTankAmounts: {} as EngineState['fuelTankAmounts'],
    eggsDelivered: eggsDelivered as EngineState['eggsDelivered'], teEarned: teEarned as EngineState['teEarned'],
    population: 1, lastStepTime: 0,
    activeSales: { research: false, hab: false, vehicle: false },
    earningsBoost: { active: false, multiplier: 1 },
  };
}

// A small virtue inventory, so H1's artifact search has something real to choose.
const backup = ei.Backup.fromObject({
  game: { permitLevel: 1 },
  artifactsDb: {
    virtueAfxDb: {
      inventoryItems: [
        { itemId: 1, quantity: 1, artifact: { spec: { name: Name.QUANTUM_METRONOME, level: Level.GREATER, rarity: Rarity.EPIC } } },
        { itemId: 2, quantity: 1, artifact: { spec: { name: Name.INTERSTELLAR_COMPASS, level: Level.GREATER, rarity: Rarity.RARE } } },
        { itemId: 3, quantity: 2, artifact: { spec: { name: Name.TACHYON_STONE, level: Level.NORMAL, rarity: Rarity.COMMON } } },
      ],
    },
  },
});

const START = Date.UTC(2026, 9, 21, 20) / 1000;

function context(awake: SimulationContext['awakeHours']): SimulationContext {
  return {
    epicResearchLevels: { cheaper_research: 10, transportation_lobbyist: 30, silo_capacity: 20, epic_egg_laying: 20,
      cheaper_contractors: 10, bust_unions: 10, int_hatch_calm: 20, epic_internal_incubators: 20, cheaper_vehicles: 10 },
    colleggtibleModifiers: modifiersFromColleggtibleTiers({}),
    ascensionStartTime: START, planStartOffset: 0, assumeDoubleEarnings: false, deferForEarningsMode: false,
    rawBackup: backup,
    awakeHours: awake,
  };
}

const TARGETS = [...Array.from({ length: 30 }, (_, i) => 250 + i), 300, 330, 380, 450, 490];

describe('fast tail matches the full simulation exactly', () => {
  // The build (C1–C3) doesn't involve awake hours, so one serves both cases.
  const state = startState(240);
  const buildContext = context(null);
  const precomputed = runUntilShift(state, buildContext, 'C3');
  const preC3 = { actions: precomputed.actions, state: precomputed.state, elapsedSeconds: precomputed.elapsedSeconds };
  const variants = runC3Variants(precomputed.state, buildContext, 3, false).filter(v => !v.impossible);

  test.each([
    ['without awake hours', null],
    ['with awake hours', { start: '08:00', end: '23:00', timezone: 'America/Chicago' }],
  ] as const)('%s', (_label, awake) => {
    const ctx = context(awake);
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      const prep = prepareTail(state, preC3, variant, ctx, START);
      for (const target of TARGETS) {
        const { summary } = runAscensionFromC3Variant(state, preC3, variant, ctx, START, 'ref', target);
        const fast = evaluateTail(prep, target);
        const where = `${variant.saleCount}-sale${variant.attemptTier13Unlock ? '-tier13' : ''} → ${target}`;
        expect({ where, endTime: fast.endTime }).toEqual({ where, endTime: summary.endTime });
        expect({ where, endTE: fast.endTE, finalTE: fast.finalTE }).toEqual({ where, endTE: summary.endTE, finalTE: summary.finalTE });
        expect({ where, eggs: fast.eggsDelivered }).toEqual({ where, eggs: summary.eggsDelivered });
        expect({ where, shifts: fast.endShiftCount, se: fast.endSoulEggs }).toEqual({
          where, shifts: summary.endShiftCount, se: summary.endSoulEggs,
        });
        expect(fast.maxELR).toBe(summary.maxELR);
      }
    }
  });
}, 600_000);
