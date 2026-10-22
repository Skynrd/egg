import type { CalculationsSnapshot, VehicleSlot, ResearchLevels, ArtifactSlotPayload, VirtueEgg } from '@/types';
import type { Modifiers as ColleggtibleModifiers } from 'lib/collegtibles';

/**
 * The daily window (wall-clock, in `timezone`) during which the player is available to shift.
 * `start`/`end` are "HH:MM"; an `end` earlier than `start` means the window wraps past midnight
 * (e.g. 14:00 → 02:00). Helpers live in auto/awakeHours.ts.
 */
export interface AwakeHours {
  start: string;
  end: string;
  timezone: string;
}

/**
 * The minimal mutable state required to compute the next state.
 * This corresponds to the "input" fields of CalculationsSnapshot.
 */
export interface EngineState {
  // Virtue State
  currentEgg: VirtueEgg;
  shiftCount: number;
  te: number;
  soulEggs: number;
  bankValue: number;

  // Farm State
  habIds: (number | null)[];
  vehicles: VehicleSlot[];
  researchLevels: ResearchLevels;
  siloCount: number;
  tankLevel: number;

  // Artifacts
  artifactLoadout: ArtifactSlotPayload[];
  activeArtifactSet: import('@/types').ArtifactSetName | null;
  artifactSets: Record<import('@/types').ArtifactSetName, ArtifactSlotPayload[] | null>;

  // Progress State
  fuelTankAmounts: Record<VirtueEgg, number>;
  eggsDelivered: Record<VirtueEgg, number>;
  teEarned: Record<VirtueEgg, number>;

  population: number;
  lastStepTime: number;

  activeSales: {
    research: boolean;
    hab: boolean;
    vehicle: boolean;
  };
  earningsBoost: {
    active: boolean;
    multiplier: number;
  };
  maxELR?: number;
}

/**
 * Context that remains constant during a simulation run.
 */
export interface SimulationContext {
  epicResearchLevels: ResearchLevels;
  colleggtibleModifiers: ColleggtibleModifiers;
  ascensionStartTime: number; // Unix timestamp in seconds
  planStartOffset: number; // Seconds since ascension start at which planning begins
  assumeDoubleEarnings: boolean;
  rawBackup?: any; // ei.IBackup
  deferForEarningsMode: boolean;
  /** When set, the auto planner schedules TE-earning shifts (and each ascension's end) inside this
   * daily window — see `planAwakeTEWaits` in auto/shifts/te-wait.ts. */
  awakeHours?: AwakeHours | null;
  // TODO: Add any other global context needed (e.g. events?)
}

/**
 * Result of a simulation step.
 * Using existing types to minimize friction.
 */
export type SimulationResult = CalculationsSnapshot;
