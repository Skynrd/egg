import { describe, expect, test } from 'vitest';
import {
  optimizeAscensionPath,
  OptimizerCancelled,
  TIE_TOLERANCE_SECONDS,
  type LegEndState,
  type LegOutcome,
  type OptimizerOptions,
  type OptimizerSimulator,
  type OptimizerStatus,
  type StartNode,
} from './optimizer';

const DAY = 86400;

/**
 * Toy model with the same shape as the real one: a fixed build phase (longer when it starts on a
 * "bad" weekday), then a wait whose per-TE cost shrinks as starting TE grows.
 */
interface ToyModel {
  buildDays: number;
  badDayPenaltyDays: number;
  waitDaysPerTE: (startTE: number) => number;
  shiftsPerAscension: number;
}

const DEFAULT_MODEL: ToyModel = {
  buildDays: 7,
  badDayPenaltyDays: 3,
  waitDaysPerTE: te => 3 * Math.pow(0.95, te - 100),
  shiftsPerAscension: 13,
};

function legEnd(model: ToyModel, startTE: number, startTime: number, target: number) {
  const badDay = Math.floor(startTime / DAY) % 7 === 5;
  return startTime + (model.buildDays + (badDay ? model.badDayPenaltyDays : 0) + (target - startTE) * model.waitDaysPerTE(startTE)) * DAY;
}

function toySim(model: ToyModel = DEFAULT_MODEL, concurrency = 1): OptimizerSimulator & { builds: number } {
  let builds = 0;
  const leg = (node: StartNode, target: number): LegOutcome => {
    const endTime = legEnd(model, node.te, node.startTime, target);
    const endShiftCount = (node.prev?.endShiftCount ?? 0) + model.shiftsPerAscension;
    const end = { endShiftCount, endSoulEggs: 0, finalTE: {}, eggsDelivered: { curiosity: target } } as LegEndState;
    return { variantKey: '1-sale', targetTE: target, endTE: target, endTime, shifts: model.shiftsPerAscension, endSoulEggs: 0, end };
  };
  return {
    concurrency,
    get buildCount() {
      return builds;
    },
    get builds() {
      return builds;
    },
    async freshLegs(node, targets) {
      builds++;
      // In parallel, finish out of order like real workers do.
      if (concurrency > 1) for (let i = Math.floor(Math.random() * 4); i > 0; i--) await null;
      return targets.map(t => leg(node, t));
    },
    continueLegs: null,
  };
}

function baseOptions(overrides: Partial<OptimizerOptions> = {}): OptimizerOptions {
  return {
    startTE: 100,
    startTime: 0,
    goal: { type: 'te', targetTE: 150 },
    shiftBudget: 10_000,
    minGain: 10,
    step: 1,
    ...overrides,
  };
}

/** Exhaustive reference: every increasing sequence of stops with gains >= minGain. */
function bruteForce(model: ToyModel, startTE: number, goalTE: number, minGain: number, shiftBudget: number) {
  let best = { arrival: Infinity, legs: Infinity };
  const recurse = (te: number, time: number, legs: number) => {
    if (legs * model.shiftsPerAscension > shiftBudget) return;
    if (te === goalTE) {
      if (time < best.arrival) best = { arrival: time, legs };
      return;
    }
    for (let t = te + minGain; t <= goalTE; t++) {
      if (t !== goalTE && goalTE - t < minGain) continue;
      recurse(t, legEnd(model, te, time, t), legs + 1);
    }
  };
  recurse(startTE, 0, 0);
  return best;
}

describe.each([1, 4])('optimizeAscensionPath (%i at a time)', concurrency => {
  const sim = (model: ToyModel = DEFAULT_MODEL) => toySim(model, concurrency);

  test('matches exhaustive search', async () => {
    const result = await optimizeAscensionPath(sim(), baseOptions());
    const reference = bruteForce(DEFAULT_MODEL, 100, 150, 10, 10_000);
    expect(result).not.toBeNull();
    expect(result!.arrival).toBeLessThanOrEqual(reference.arrival + TIE_TOLERANCE_SECONDS);
    expect(result!.endTE).toBe(150);
  });

  test('uses intermediate stops when they pay off, respecting the minimum gain', async () => {
    const result = (await optimizeAscensionPath(sim(), baseOptions()))!;
    expect(result.legs.length).toBeGreaterThan(1);
    let te = 100;
    for (const leg of result.legs) {
      expect(leg.endTE - te).toBeGreaterThanOrEqual(10);
      te = leg.endTE;
    }
  });

  test('goes direct when builds are too expensive to be worth extra ascensions', async () => {
    const model = { ...DEFAULT_MODEL, buildDays: 400 };
    const result = (await optimizeAscensionPath(sim(model), baseOptions()))!;
    expect(result.legs.map(l => l.targetTE)).toEqual([150]);
  });

  test('shift budget caps the number of ascensions', async () => {
    const result = (await optimizeAscensionPath(sim(), baseOptions({ shiftBudget: 26 })))!;
    expect(result.legs.length).toBeLessThanOrEqual(2);
    expect(result.shiftsUsed).toBeLessThanOrEqual(26);
    const reference = bruteForce(DEFAULT_MODEL, 100, 150, 10, 26);
    expect(result.arrival).toBeLessThanOrEqual(reference.arrival + TIE_TOLERANCE_SECONDS);
  });

  test('returns null when even one ascension exceeds the budget', async () => {
    expect(await optimizeAscensionPath(sim(), baseOptions({ shiftBudget: 5 }))).toBeNull();
  });

  test('near-ties go to fewer ascensions', async () => {
    // Waiting cost barely improves with TE, so extra ascensions save almost nothing.
    const model = { ...DEFAULT_MODEL, buildDays: 0, badDayPenaltyDays: 0, waitDaysPerTE: () => 1 };
    const result = (await optimizeAscensionPath(sim(model), baseOptions()))!;
    expect(result.legs.length).toBe(1);
  });

  test('coarse search plus refinement is close to exhaustive with fewer builds', async () => {
    const fine = sim();
    const coarse = sim();
    const fineResult = (await optimizeAscensionPath(fine, baseOptions()))!;
    const coarseResult = (await optimizeAscensionPath(coarse, baseOptions({ step: 5 })))!;
    expect(coarse.builds).toBeLessThan(fine.builds);
    expect(coarseResult.arrival).toBeLessThanOrEqual(fineResult.arrival + 2 * DAY);
  });

  test('deadline mode maximizes TE reached by the deadline', async () => {
    const deadline = 200 * DAY;
    const result = (await optimizeAscensionPath(sim(), baseOptions({ goal: { type: 'deadline', deadline } })))!;
    expect(result.arrival).toBeLessThanOrEqual(deadline);
    // One more TE than found must not be reachable by going direct either.
    expect(legEnd(DEFAULT_MODEL, 100, 0, result.endTE + 1)).toBeGreaterThan(deadline);
    expect(result.endTE).toBeGreaterThan(110);
  });

  test('live status: never more running than the concurrency, and best so far ends at the answer', async () => {
    const statuses: OptimizerStatus[] = [];
    const result = (await optimizeAscensionPath(sim(), baseOptions({ step: 5, onStatus: s => statuses.push(s) })))!;
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(s => s.running.length <= concurrency)).toBe(true);
    const lastBest = statuses[statuses.length - 1].best!;
    expect(lastBest.arrival).toBeLessThanOrEqual(result.arrival);
    // "Best so far" never gets worse once found.
    const arrivals = statuses.filter(s => s.best).map(s => s.best!.arrival);
    expect(arrivals.every((a, i) => i === 0 || a <= arrivals[i - 1] + TIE_TOLERANCE_SECONDS)).toBe(true);
  });

  test('can be cancelled', async () => {
    await expect(
      optimizeAscensionPath(sim(), baseOptions({ shouldCancel: () => true }))
    ).rejects.toBeInstanceOf(OptimizerCancelled);
  });
});

/** A simulator from a hand-written table: `legs(node)` lists the outcomes offered from a start. */
function scriptedSim(legs: (node: StartNode) => Array<{ target: number; endTE?: number; days: number; eggs: number }>) {
  const expandedFrom: number[] = [];
  const sim: OptimizerSimulator = {
    concurrency: 1,
    buildCount: 0,
    async freshLegs(node, targets) {
      expandedFrom.push(node.te);
      return legs(node)
        .filter(l => targets.includes(l.target))
        .map(l => {
          const end = { endShiftCount: 0, endSoulEggs: 0, finalTE: {}, eggsDelivered: { curiosity: l.eggs } } as LegEndState;
          const endTime = node.startTime + l.days * DAY;
          return { variantKey: '1-sale', targetTE: l.target, endTE: l.endTE ?? l.target, endTime, shifts: 13, endSoulEggs: 0, end };
        });
    },
    continueLegs: null,
  };
  return { sim, expandedFrom };
}

describe('optimizeAscensionPath: what carries between ascensions', () => {
  test('a later arrival with more eggs delivered is kept, and can win', async () => {
    // Two ways to reach 112: day 10 with no extra eggs, or day 11 (aiming at 111, overshooting)
    // with eggs that save 5 days on the next leg. 11 + 15 = 26 beats 10 + 20 = 30.
    const { sim } = scriptedSim(node =>
      node.te === 100
        ? [
            { target: 112, days: 10, eggs: 0 },
            { target: 111, endTE: 112, days: 11, eggs: 5 },
            { target: 130, days: 40, eggs: 0 },
          ]
        : [{ target: 130, days: 20 - ((node.prev?.eggsDelivered as Record<string, number>).curiosity ?? 0), eggs: 0 }]
    );
    const result = (await optimizeAscensionPath(sim, baseOptions({ goal: { type: 'te', targetTE: 130 } })))!;
    expect(result.arrival).toBe(26 * DAY);
    expect(result.legs.map(l => l.targetTE)).toEqual([111, 130]);
  });

  test('no ascension continues from above the stop cap, but the final one can end above it', async () => {
    const { sim, expandedFrom } = scriptedSim(node =>
      node.te === 100
        ? [
            { target: 115, days: 10, eggs: 0 },
            { target: 125, days: 12, eggs: 0 },
            { target: 150, days: 60, eggs: 0 },
          ]
        : [{ target: 150, days: node.te === 125 ? 5 : 20, eggs: 0 }]
    );
    const result = (await optimizeAscensionPath(sim, baseOptions({ goal: { type: 'te', targetTE: 150 }, maxStopTE: 120 })))!;
    expect(expandedFrom.every(te => te <= 120)).toBe(true);
    // 100 → 125 → 150 (17 days) would be fastest, but 125 is above the cap.
    expect(result.legs.map(l => l.targetTE)).toEqual([115, 150]);
    expect(result.endTE).toBe(150);
  });
});

describe('optimizeAscensionPath: fastest plan per number of ascensions', () => {
  test('each row is the fastest plan with that many ascensions, and earns its place', async () => {
    const result = (await optimizeAscensionPath(toySim(), baseOptions()))!;
    const rows = result.byAscensions;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 1].arrival).toBe(result.arrival);
    for (const [i, row] of rows.entries()) {
      // No plan with at most this many ascensions is faster (exhaustive check).
      const reference = bruteForce(DEFAULT_MODEL, 100, 150, 10, row.legs.length * DEFAULT_MODEL.shiftsPerAscension);
      expect(row.arrival).toBeLessThanOrEqual(reference.arrival + TIE_TOLERANCE_SECONDS);
      if (i > 0) {
        expect(row.legs.length).toBeGreaterThan(rows[i - 1].legs.length);
        expect(row.arrival).toBeLessThan(rows[i - 1].arrival - TIE_TOLERANCE_SECONDS);
      }
    }
  });
});

describe('optimizeAscensionPath: sale-aligned stops', () => {
  test('continues only from the highest-TE stops per catchable sale', async () => {
    // From 100, stops 110–119 arrive one per day; "sales" end every 7 days. With a 1-day opening,
    // days 10–12 catch the sale ending on day 14 and days 13–19 the one on day 21.
    const { sim, expandedFrom } = scriptedSim(node =>
      node.te === 100
        ? [
            ...Array.from({ length: 10 }, (_, i) => ({ target: 110 + i, days: 10 + i, eggs: 0 })),
            { target: 140, days: 60, eggs: 0 },
          ]
        : [{ target: 140, days: 30, eggs: 0 }]
    );
    const withOpening: OptimizerSimulator = {
      ...sim,
      freshLegs: async (node, targets) =>
        (await sim.freshLegs(node, targets)).map(l => ({ ...l, diag: { maxELR: 0, buildPhaseEnd: 0, artifactSets: '', preC3Seconds: DAY } })),
    };
    const nextSaleEnd = (t: number) => Math.ceil((t + 1) / (7 * DAY)) * 7 * DAY;
    await optimizeAscensionPath(
      withOpening,
      baseOptions({ goal: { type: 'te', targetTE: 140 }, saleAlignedStops: { nextSaleEnd, keepPerSale: 2 } })
    );
    // Day-14 sale: arrivals on days 10–12 (TE 110–112) → keep 112, 111. Day-21 sale: days 13–19
    // (TE 113–119) → keep 119, 118.
    expect(expandedFrom.slice(1).sort()).toEqual([111, 112, 118, 119]);
  });
});

test('sale-aligned stops: the per-sale limit applies across paths, not per starting point', async () => {
  // Two A1 stops (110, 112) each offer two A2 stops; all four arrive on days 15–18, before the same
  // day-21 sale. Only the two highest overall (122, 123) are worth continuing from.
  const { sim, expandedFrom } = scriptedSim(node => {
    if (node.te === 100) return [{ target: 110, days: 10, eggs: 0 }, { target: 112, days: 12, eggs: 0 }, { target: 140, days: 90, eggs: 0 }];
    if (node.te === 110) return [{ target: 120, days: 5, eggs: 0 }, { target: 121, days: 6, eggs: 0 }, { target: 140, days: 60, eggs: 0 }];
    if (node.te === 112) return [{ target: 122, days: 5, eggs: 0 }, { target: 123, days: 6, eggs: 0 }, { target: 140, days: 60, eggs: 0 }];
    return [{ target: 140, days: 30, eggs: 0 }];
  });
  const nextSaleEnd = (t: number) => Math.ceil((t + 1) / (7 * DAY)) * 7 * DAY;
  await optimizeAscensionPath(
    sim,
    baseOptions({ goal: { type: 'te', targetTE: 140 }, saleAlignedStops: { nextSaleEnd, keepPerSale: 2 } })
  );
  expect(expandedFrom.filter(te => te >= 120).sort()).toEqual([122, 123]);
});

test('toward a TE goal, only stops up to the cap and the goal itself are evaluated', async () => {
  const requested = new Set<number>();
  const base = toySim();
  const recording: OptimizerSimulator = {
    ...base,
    concurrency: 1,
    get buildCount() {
      return base.buildCount;
    },
    freshLegs: (node, targets) => {
      targets.forEach(t => requested.add(t));
      return base.freshLegs(node, targets);
    },
  };
  await optimizeAscensionPath(recording, baseOptions({ maxStopTE: 125 }));
  expect([...requested].every(t => t <= 125 || t === 150)).toBe(true);
  expect(requested.has(150)).toBe(true);
});
