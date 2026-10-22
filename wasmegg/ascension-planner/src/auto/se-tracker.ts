import { shiftCost, parseValueWithUnit } from 'lib';

/**
 * Computes SE costs for a sequence of shifts.
 * 
 * Each shift's cost depends on the current SE and the shift count.
 * As we "pay" for each shift, the remaining SE decreases and the shift count increases,
 * which affects the cost of the next shift.
 */
export function computeShiftCosts(
  startingSE: number,
  startingShiftCount: number,
  numShifts: number
) {
  const costs: number[] = [];
  let currentSE = startingSE;
  let currentShiftCount = startingShiftCount;

  for (let i = 0; i < numShifts; i++) {
    const cost = shiftCost(currentSE, currentShiftCount);
    costs.push(cost);
    currentSE -= cost;
    currentShiftCount++;
  }

  return {
    costs,
    totalCost: costs.reduce((sum, cost) => sum + cost, 0),
    endingSE: currentSE,
    endingShiftCount: currentShiftCount,
  };
}

/**
 * Computes cumulative SE costs for multiple ascensions, each having 12 shifts.
 */
export function computeMultiAscensionSECost(
  startingSE: number,
  startingShiftCount: number,
  numAscensions: number
) {
  let totalCost = 0;
  let currentSE = startingSE;
  let currentShiftCount = startingShiftCount;
  const perAscension: { cost: number; endingSE: number }[] = [];

  for (let i = 0; i < numAscensions; i++) {
    const result = computeShiftCosts(currentSE, currentShiftCount, 12);
    perAscension.push({
      cost: result.totalCost,
      endingSE: result.endingSE,
    });
    totalCost += result.totalCost;
    currentSE = result.endingSE;
    currentShiftCount = result.endingShiftCount;
  }

  return {
    totalCost,
    endingSE: currentSE,
    endingShiftCount: currentShiftCount,
    perAscension,
  };
}

/**
 * How many more shifts can be taken before the SE balance would drop below `minSoulEggs`. Shift
 * cost depends only on the current SE balance and lifetime shift count, so this is fully
 * determined by the starting point — which is what lets the optimizer treat "min SE to keep" as
 * just another shift budget.
 */
export function maxShiftsKeepingSE(
  startingSE: number,
  startingShiftCount: number,
  minSoulEggs: number,
  cap = 2000
): number {
  let currentSE = startingSE;
  let shifts = 0;
  while (shifts < cap) {
    const cost = shiftCost(currentSE, startingShiftCount + shifts);
    if (currentSE - cost < minSoulEggs) break;
    currentSE -= cost;
    shifts++;
  }
  return shifts;
}

/** Parses an SE amount in EI notation ("5N", "1.2s") or plain/scientific notation ("1e40"). */
export function parseSoulEggs(input: string): number | null {
  const s = input.trim();
  if (s === '') return null;
  const plain = Number(s);
  if (!isNaN(plain)) return plain;
  return parseValueWithUnit(s, false);
}

export interface ShiftBudget {
  /** Shifts the plan may spend in total (Infinity when unconstrained). */
  budget: number;
  byLifetimeCap: number | null;
  bySoulEggs: number | null;
  error?: string;
}

/** Folds "max lifetime shifts" and "min SE to keep" into the single shift budget the optimizer uses. */
export function computeShiftBudget(
  currentShiftCount: number,
  soulEggs: number,
  maxLifetimeShifts: number | null,
  minSoulEggsInput: string
): ShiftBudget {
  const byLifetimeCap = maxLifetimeShifts !== null ? Math.max(0, maxLifetimeShifts - currentShiftCount) : null;

  let bySoulEggs: number | null = null;
  if (minSoulEggsInput.trim() !== '') {
    const minSoulEggs = parseSoulEggs(minSoulEggsInput);
    if (minSoulEggs === null) {
      return { budget: 0, byLifetimeCap, bySoulEggs, error: `Couldn't read "${minSoulEggsInput}" as an SE amount.` };
    }
    bySoulEggs = maxShiftsKeepingSE(soulEggs, currentShiftCount, minSoulEggs);
  }

  const budget = Math.min(byLifetimeCap ?? Infinity, bySoulEggs ?? Infinity);
  return { budget, byLifetimeCap, bySoulEggs };
}
