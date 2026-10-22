import type { AscensionSummary } from './types';
import type { VariantKey } from '@/stores/autoPlanner';

/**
 * Multi-ascension path optimizer.
 *
 * Searches over which intermediate TE stops to ascend at ("bank 204, then 220, then 250") so the
 * chain reaches its goal as early as possible (or reaches the most TE by a deadline), honoring a
 * shift budget. The expensive part of simulating an ascension is its build phase (C1–K3), which
 * depends only on where the ascension starts (TE + start time), not on its target; the TE-wait
 * phase for any target is cheap. So the search is a label-setting DP over TE levels where each
 * *expansion* (one build simulation) produces outgoing legs to every possible target at once.
 *
 * Expansions run concurrently (up to `sim.concurrency`, e.g. one per Web Worker), and every
 * expansion's outcomes are cached by start node, so refinement passes only pay for start points
 * they haven't seen before.
 *
 * This module is pure: all simulation goes through the injected `OptimizerSimulator`, which keeps it
 * testable without Pinia, workers or real game data.
 */

/** The parts of a leg's end state the next ascension's start state is derived from. */
export type LegEndState = Pick<AscensionSummary, 'finalTE' | 'eggsDelivered' | 'endSoulEggs' | 'endShiftCount'>;

/** One ascension (or the "continue current farm" leg) in a candidate path. Kept small on purpose:
 * thousands of these are cached during a long search. */
export interface LegOutcome {
  variantKey: VariantKey;
  /** The TE goal the leg was simulated with. */
  targetTE: number;
  /** TE actually reached — can overshoot `targetTE` (e.g. K3 riding out the build-phase sale). */
  endTE: number;
  endTime: number;
  /** Shifts this leg spends. */
  shifts: number;
  endSoulEggs: number;
  end: LegEndState;
  /** For checking that two simulations of the same leg agree (see verifyOptimizerPath). */
  diag?: { maxELR: number; buildPhaseEnd: number; artifactSets: string; preC3Seconds?: number };
}

export interface StartNode {
  te: number;
  startTime: number;
  /** End state of the leg that led here, or null for the plan's first ascension. */
  prev: LegEndState | null;
}

export interface OptimizerSimulator {
  /** Simulates a fresh ascension from `node` once, then returns the best variant's outcome for
   * each requested target (targets it can't produce are simply omitted). */
  freshLegs(node: StartNode, targets: number[]): Promise<LegOutcome[]>;
  /** Outcomes of continuing the player's current farm (first leg only), or null if unavailable. */
  continueLegs: ((targets: number[]) => Promise<LegOutcome[]>) | null;
  /** How many `freshLegs` calls may run at once. */
  readonly concurrency: number;
  /** Number of build-phase simulations actually run. */
  readonly buildCount: number;
}

export type OptimizerGoal = { type: 'te'; targetTE: number } | { type: 'deadline'; deadline: number };

export interface OptimizerOptions {
  startTE: number;
  startTime: number;
  goal: OptimizerGoal;
  /** Maximum shifts the whole plan may spend (from max lifetime shifts and min SE to keep). */
  shiftBudget: number;
  /** Minimum TE a fresh ascension must gain. Continuing the current farm is exempt. */
  minGain: number;
  /** Intermediate stops are first searched on multiples of this, then refined around the winner. */
  step: number;
  /** No ascension continues from a stop above this (the final one can still end anywhere). Past
   * full research, another ascension only adds a rebuild, so higher stops just cost search time. */
  maxStopTE?: number;
  /** Continue only from the highest-TE stops per sale the next build can catch (see `runPass`),
   * instead of from every stop on the grid. */
  saleAlignedStops?: { nextSaleEnd: (timestamp: number) => number; keepPerSale: number };
  maxTE?: number;
  onProgress?: (message: string) => void;
  /** Live view of the search for the UI: called whenever a build starts or finishes. */
  onStatus?: (status: OptimizerStatus) => void;
  shouldCancel?: () => boolean;
}

/** One complete plan: its ascensions and where it ends up. */
export interface OptimizerPlan {
  legs: LegOutcome[];
  endTE: number;
  arrival: number;
  shiftsUsed: number;
  endSoulEggs: number;
}

/** The overall best plan (spread in), plus the best plan per number of ascensions. */
export interface OptimizerResult extends OptimizerPlan {
  /** By ascension count, ascending; a count appears only if it beats every count below it (by more
   * than the tie tolerance toward a TE goal, or with more TE by a deadline). Last = the best plan. */
  byAscensions: OptimizerPlan[];
  /** True when only the best plan was refined (coarse grids): the other rows are fastest on the grid. */
  refinedOnlyBest: boolean;
  buildCount: number;
  expansions: number;
  elapsedMs: number;
}

/** What the search is doing right now — plain data, safe to hand straight to the UI. */
export interface OptimizerStatus {
  pass: string;
  buildCount: number;
  /** TE the remaining legs may target (the goal, or the TE cap by a deadline). */
  goalTE: number;
  /** One entry per expansion in flight: the start point being built from, and the stops before it. */
  running: { fromTE: number; ascension: number; startTime: number; stops: number[] }[];
  /** Best complete plan found so far, across passes. */
  best: { stops: number[]; endTE: number; arrival: number } | null;
}

export class OptimizerCancelled extends Error {
  constructor() {
    super('Optimization cancelled');
  }
}

/** Finishing within this much of the fastest plan counts as a tie, which goes to fewer ascensions. */
export const TIE_TOLERANCE_SECONDS = 6 * 3600;

/** Refinement explores stops within this many TE of the current winner's, re-centering on the new
 * winner until it stops moving (or `MAX_REFINE_ROUNDS` is hit). */
const REFINE_RADIUS = 2;
const MAX_REFINE_ROUNDS = 4;

/** Per TE level and number of ascensions, at most this many non-dominated arrivals are kept (the
 * earliest), so egg-count-aware dominance can't let a level's label set grow without bound. */
const MAX_LABELS_PER_LEVEL = 6;

interface Label {
  te: number;
  /** When this label's TE is reached, which is also when the next ascension starts. */
  arrival: number;
  shifts: number;
  legs: LegOutcome[];
  /** Lifetime eggs delivered per egg at arrival (null for the plan's start). */
  eggs: Record<string, number> | null;
  /** Sale-aligned stops only: end of the first sale the next build from here can catch. */
  saleKey?: number;
}

/**
 * `a` makes `b` redundant only if it is at least as good in every way that carries forward: not
 * later, no more shifts or ascensions spent, and at least as many eggs delivered on every egg.
 * Ignoring the eggs was wrong: partial progress toward each egg's next TE carries into the next
 * ascension (about one TE's wait per ascension), so a later arrival with more eggs can still win.
 */
function dominates(a: Label, b: Label): boolean {
  if (a.arrival > b.arrival || a.shifts > b.shifts || a.legs.length > b.legs.length) return false;
  if (!a.eggs || !b.eggs) return a.eggs === b.eggs;
  return Object.keys(b.eggs).every(egg => (a.eggs![egg] ?? 0) >= b.eggs![egg]);
}

/** Within one ascension count: is finished plan `a` better than `b`? */
function betterFinal(a: Label, b: Label, goal: OptimizerGoal): boolean {
  if (goal.type === 'te') return a.arrival < b.arrival || (a.arrival === b.arrival && a.shifts < b.shifts);
  return a.te > b.te || (a.te === b.te && (a.arrival < b.arrival || (a.arrival === b.arrival && a.shifts < b.shifts)));
}

/**
 * Collects finished plans: the best one per number of ascensions. Its `frontier` is the list worth
 * showing — each extra ascension must earn its place: finish more than the tie tolerance sooner
 * (TE goal) or reach more TE (deadline) than every plan with fewer ascensions. Its last entry is the
 * overall answer, which matches "earliest, with near-ties going to fewer ascensions".
 */
class FinalSet {
  readonly byCount = new Map<number, Label>();

  constructor(
    private goal: OptimizerGoal,
    seed: Iterable<Label> = []
  ) {
    for (const label of seed) this.add(label);
  }

  add(label: Label) {
    const current = this.byCount.get(label.legs.length);
    if (!current || betterFinal(label, current, this.goal)) this.byCount.set(label.legs.length, label);
  }

  /** Earliest finish among plans with at most `count` ascensions (Infinity if none yet). */
  earliestWithin(count: number): number {
    let earliest = Infinity;
    for (const [n, label] of this.byCount) if (n <= count) earliest = Math.min(earliest, label.arrival);
    return earliest;
  }

  frontier(): Label[] {
    const rows: Label[] = [];
    for (const label of [...this.byCount.values()].sort((a, b) => a.legs.length - b.legs.length)) {
      const previous = rows[rows.length - 1];
      const earnsPlace =
        !previous ||
        (this.goal.type === 'te'
          ? label.arrival < Math.min(...rows.map(r => r.arrival)) - TIE_TOLERANCE_SECONDS
          : label.te > Math.max(...rows.map(r => r.te)));
      if (earnsPlace) rows.push(label);
    }
    return rows;
  }

  best(): Label | null {
    const rows = this.frontier();
    return rows[rows.length - 1] ?? null;
  }
}

function nodeKey(node: StartNode): string {
  return node.prev
    ? `${node.startTime}|${node.prev.endShiftCount}|${JSON.stringify(node.prev.eggsDelivered)}`
    : `${node.startTime}|root`;
}

/** Outcomes per start node, shared by every pass. In-flight requests are cached too, so two labels
 * that start from the very same node never trigger two builds. */
class ExpansionCache {
  private fresh = new Map<string, Promise<LegOutcome[]>>();
  private continued: Promise<LegOutcome[]> | null = null;

  constructor(
    private sim: OptimizerSimulator,
    private allTargets: (fromTE: number, gain: number) => number[],
    private minGain: number
  ) {}

  freshLegs(node: StartNode): Promise<LegOutcome[]> {
    const key = nodeKey(node);
    let outcomes = this.fresh.get(key);
    if (!outcomes) {
      outcomes = this.sim.freshLegs(node, this.allTargets(node.te, this.minGain));
      this.fresh.set(key, outcomes);
    }
    return outcomes;
  }

  continueLegs(fromTE: number): Promise<LegOutcome[]> {
    if (!this.sim.continueLegs) return Promise.resolve([]);
    this.continued ??= this.sim.continueLegs(this.allTargets(fromTE, 1));
    return this.continued;
  }
}

async function runPass(
  sim: OptimizerSimulator,
  cache: ExpansionCache,
  opts: OptimizerOptions,
  isStop: (t: number) => boolean,
  passLabel: string,
  counters: { expansions: number },
  /** Finished plans from earlier passes: they keep pruning valid and "best so far" from regressing. */
  priorFinals: Iterable<Label> = []
): Promise<FinalSet> {
  const maxTE = opts.maxTE ?? 490;
  const goal = opts.goal;
  const goalTE = goal.type === 'te' ? goal.targetTE : maxTE;

  const root: Label = { te: opts.startTE, arrival: opts.startTime, shifts: 0, legs: [], eggs: null };
  const maxStopTE = opts.maxStopTE ?? Infinity;
  const byLevel = new Map<number, Label[]>();
  const open: Label[] = [root];
  const finals = new FinalSet(goal, priorFinals);
  // Expansions in flight, with the label each one expands (for the live status).
  const inFlight = new Map<Promise<void>, Label>();

  // Sale-aligned stops: per (ascension count, sale the next build can catch), the labels still kept.
  const bySale = new Map<string, Label[]>();
  const saleGroupKey = (label: Label) => `${label.legs.length}|${label.saleKey}`;

  const remove = (label: Label) => {
    const idx = open.indexOf(label);
    if (idx !== -1) open.splice(idx, 1);
    const level = byLevel.get(label.te);
    if (level) byLevel.set(label.te, level.filter(l => l !== label));
    if (label.saleKey !== undefined) {
      const group = bySale.get(saleGroupKey(label));
      if (group) bySale.set(saleGroupKey(label), group.filter(l => l !== label));
    }
  };

  const insert = (label: Label) => {
    const level = byLevel.get(label.te) ?? [];
    if (level.some(l => dominates(l, label))) return;
    level.filter(l => dominates(label, l)).forEach(remove);
    byLevel.set(label.te, [...(byLevel.get(label.te) ?? []), label]);
    open.push(label);

    // Cap each (level, ascension count) at its earliest arrivals.
    const sameCount = byLevel
      .get(label.te)!
      .filter(l => l.legs.length === label.legs.length)
      .sort((a, b) => a.arrival - b.arrival);
    sameCount.slice(MAX_LABELS_PER_LEVEL).forEach(remove);

    // Sale-aligned stops, across every path at once: arrivals whose next build would catch the same
    // sale share the same build deadline, so only the highest-TE few are worth continuing from,
    // whichever path produced them.
    const sale = opts.saleAlignedStops;
    if (sale && label.saleKey !== undefined && byLevel.get(label.te)!.includes(label)) {
      const key = saleGroupKey(label);
      const group = [...(bySale.get(key) ?? []), label].sort((a, b) => b.te - a.te || a.arrival - b.arrival);
      bySale.set(key, group);
      group.slice(sale.keepPerSale).forEach(remove);
    }
  };

  // A label with k ascensions only leads to plans with more than k, and such a plan is only worth
  // anything if it beats every plan with fewer ascensions by more than the tie tolerance — so once
  // the label itself arrives within that tolerance of the earliest plan with at most k ascensions,
  // nothing it leads to can make the list.
  const isPruned = (label: Label) =>
    (goal.type === 'te' && label.arrival >= finals.earliestWithin(label.legs.length) - TIE_TOLERANCE_SECONDS) ||
    (goal.type === 'deadline' && label.arrival >= goal.deadline) ||
    label.shifts >= opts.shiftBudget;

  const expand = async (label: Label) => {
    counters.expansions++;
    const node: StartNode = {
      te: label.te,
      startTime: label.arrival,
      prev: label.legs.length > 0 ? label.legs[label.legs.length - 1].end : null,
    };
    const fresh = await cache.freshLegs(node);
    const outcomes = [...fresh];
    if (label.legs.length === 0) outcomes.push(...(await cache.continueLegs(label.te)));

    const stops: Label[] = [];
    for (const leg of outcomes) {
      if (leg.endTE <= label.te) continue;
      const shifts = label.shifts + leg.shifts;
      if (shifts > opts.shiftBudget) continue;
      if (goal.type === 'deadline' && leg.endTime > goal.deadline) continue;

      const next: Label = {
        te: leg.endTE,
        arrival: leg.endTime,
        shifts,
        legs: [...label.legs, leg],
        eggs: leg.end.eggsDelivered,
      };

      if (goal.type === 'te' && leg.endTE >= goalTE) {
        // Toward a TE goal, only legs aimed at the goal itself count as finishing: a nearer target
        // that merely overshoots it would be the same plan with a misleading final stop.
        if (leg.targetTE === goalTE) finals.add(next);
        continue;
      }
      if (goal.type === 'deadline') finals.add(next);
      if (isStop(leg.targetTE) && leg.targetTE <= maxStopTE) stops.push(next);
    }

    // Sale-aligned stops: the next ascension's build is decided by the first sale it can still use.
    // "Can catch" is judged with this build's own C1–R1 time: the next build starts at higher TE, so
    // its opening is if anything shorter, making the estimate safe. `insert` does the keeping.
    const sale = opts.saleAlignedStops;
    if (sale) {
      const opening = fresh[0]?.diag?.preC3Seconds ?? 0;
      for (const stop of stops) stop.saleKey = sale.nextSaleEnd(stop.arrival + opening);
    }
    stops.forEach(insert);
  };

  const emitStatus = () => {
    if (!opts.onStatus) return;
    const best = finals.best();
    opts.onStatus({
      pass: passLabel,
      buildCount: sim.buildCount,
      goalTE,
      running: [...inFlight.values()].map(l => ({
        fromTE: l.te,
        ascension: l.legs.length + 1,
        startTime: l.arrival,
        stops: l.legs.map(leg => leg.targetTE),
      })),
      best: best && { stops: best.legs.map(leg => leg.targetTE), endTE: best.te, arrival: best.arrival },
    });
  };

  for (;;) {
    if (opts.shouldCancel?.()) throw new OptimizerCancelled();

    // Lowest TE first: every leg goes strictly upward, so labels at low levels are the ones least
    // likely to still be dominated by something not yet produced. Running several at once is
    // speculative — one may later turn out dominated — but never wrong: its children are still
    // valid plans that the dominance and final checks treat like any other.
    while (open.length > 0 && inFlight.size < sim.concurrency) {
      open.sort((a, b) => a.te - b.te || a.arrival - b.arrival);
      const label = open.shift()!;
      if (isPruned(label)) continue;
      const task: Promise<void> = expand(label).finally(() => inFlight.delete(task));
      inFlight.set(task, label);
    }

    if (inFlight.size === 0) break;
    opts.onProgress?.(
      `${passLabel} · ${sim.buildCount} builds simulated · ${inFlight.size} running · ` +
        `lowest open ${open.length > 0 ? Math.min(...open.map(l => l.te)) : '—'} TE`
    );
    emitStatus();
    try {
      await Promise.race(inFlight.keys());
    } catch (err) {
      await Promise.allSettled(inFlight.keys());
      throw err;
    }
  }

  return finals;
}

export async function optimizeAscensionPath(
  sim: OptimizerSimulator,
  opts: OptimizerOptions
): Promise<OptimizerResult | null> {
  const t0 = performance.now();
  const counters = { expansions: 0 };
  const step = Math.max(1, Math.floor(opts.step));
  const goalTE = opts.goal.type === 'te' ? opts.goal.targetTE : (opts.maxTE ?? 490);

  // Every expansion evaluates every target that could ever be used from it, not just the current
  // grid, so refinement never has to rebuild a start point it has already seen just to try a nearby
  // stop. Toward a TE goal that's every stop up to the stop cap plus the goal itself — targets in
  // between can be neither continued from nor finished at, and evaluating them was most of a 490
  // run's time (each target re-runs the K3–H2 tail for every build variant: ~48 s of every ~52 s
  // expansion). By a deadline any target can be the answer, so all of them are evaluated.
  const lastStop = Math.min(goalTE - 1, opts.maxStopTE ?? Infinity);
  const allTargets = (fromTE: number, gain: number) => {
    const targets: number[] = [];
    const last = opts.goal.type === 'te' ? lastStop : goalTE;
    for (let t = fromTE + gain; t <= last; t++) targets.push(t);
    if (opts.goal.type === 'te' && fromTE + gain <= goalTE) targets.push(goalTE);
    return targets;
  };
  const cache = new ExpansionCache(sim, allTargets, opts.minGain);

  // Sale-aligned stops already pick run ends on every TE, so they skip the grid and refinement.
  const firstLabel = opts.saleAlignedStops ? 'Searching (sale-aligned stops)' : step > 1 ? 'Coarse search' : 'Searching';
  let finals = await runPass(sim, cache, opts, t => t % step === 0, firstLabel, counters);

  // Refine around the winner's stops, re-centering until no stop sits on the edge of its window.
  // Only the overall winner is refined; the other rows stay fastest-on-the-grid.
  if (step > 1 && !opts.saleAlignedStops) {
    const near = new Set<number>();
    for (let round = 1; round <= MAX_REFINE_ROUNDS; round++) {
      const best = finals.best();
      if (!best || best.legs.length <= 1) break;
      const before = near.size;
      for (const stop of best.legs.slice(0, -1).map(l => l.targetTE)) {
        for (let d = -REFINE_RADIUS; d <= REFINE_RADIUS; d++) near.add(stop + d);
      }
      if (near.size === before) break; // Every stop already has its full window explored.

      finals = await runPass(
        sim, cache, opts, t => t % step === 0 || near.has(t), `Refining (round ${round})`, counters,
        finals.byCount.values()
      );
    }
  }

  const toPlan = (label: Label): OptimizerPlan => ({
    legs: label.legs,
    endTE: label.te,
    arrival: label.arrival,
    shiftsUsed: label.shifts,
    endSoulEggs: label.legs[label.legs.length - 1].endSoulEggs,
  });
  const rows = finals.frontier();
  const best = finals.best();
  if (!best) return null;
  return {
    ...toPlan(best),
    byAscensions: rows.map(toPlan),
    refinedOnlyBest: step > 1 && !opts.saleAlignedStops,
    buildCount: sim.buildCount,
    expansions: counters.expansions,
    elapsedMs: performance.now() - t0,
  };
}
