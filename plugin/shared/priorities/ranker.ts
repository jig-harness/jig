/**
 * The mechanical ranker
 * ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)):
 * a pure function of an immutable tracker snapshot, the effective priorities
 * revisions, the lane weights read this tick, a capacity snapshot, the
 * persisted lane epochs, the week's charges and an explicit `asOf`. It makes
 * no model call and reads nothing else, so equal inputs give equal output.
 * The shortlist is a proposal only: dispatch's selection does not read it.
 *
 * Urgent work comes first, then High bugs; neither counts toward `N`. The
 * remaining prospective starts go to the weighted lanes: when the peripheral
 * floor is owed a whole start (`D0 + E + fNext - P >= 1`) the choice is
 * restricted to peripheral work, lent and reported when none is ready;
 * otherwise the ready lane with the largest deficit `share * (N[l] + 1) -
 * n[l]` wins, ties to core, tactical, peripheral, then bug-other. Within an
 * objective lane the ready objective with the largest deficit
 * `share[o] * (n[l] + 1) - n[o]` wins.
 */
import { type Classified, classify, type Placement } from "./classify.ts";
import { hashOf } from "./hash.ts";
import {
  laneShares,
  type Lane,
  WEIGHTED_LANES,
  type WeightedLane,
} from "./lanes.ts";
import { type Level, type PrioritiesRecord, refKey } from "./record.ts";
import type { SnapshotItem, TrackerSnapshot } from "./snapshot.ts";
import { clean, isWeighted, type WeekCharge } from "./week.ts";
import type { LaneWeights } from "./weights.ts";

const ALGORITHM_VERSION = "priorities-ranker/1";
const EPSILON = 1e-9;

/** Each weighted lane's epoch: the week's weighted-start count when it last became ready after having no ready work. */
export interface LaneEpochs {
  revision: number;
  startN: Partial<Record<WeightedLane, number>>;
}

/** This week's counters as the ranker reads them. */
export interface WeekState {
  week: string;
  /** The opening debt, written once by the week's first tick. */
  d0: number;
  /** Why the opening debt is what it is, when there was nothing to derive it from. */
  d0Reason: string | null;
  /** This week's charges, in claim order. */
  charges: WeekCharge[];
}

export interface RankerInput {
  asOf: string;
  snapshot: TrackerSnapshot;
  /** The effective revisions, the allocating level first. */
  records: PrioritiesRecord[];
  /** Why objective allocation is blocked (an infeasible newest revision), or `null`. */
  allocationBlocked: string | null;
  weights: LaneWeights;
  capacity: { starts: number };
  epochs: LaneEpochs;
  week: WeekState;
}

export interface Position {
  position: number;
  scope: string;
  key: string;
  title: string;
  lane: Lane;
  objective: string | null;
  owners: Partial<Record<Level, string>>;
  alsoIn: string[];
  /** Whether a start may be proposed for it; an Urgent item is listed even when it may not. */
  eligible: boolean;
  reason: string;
  gaps: string[];
}

export interface LaneReport {
  lane: WeightedLane;
  weight: number | null;
  share: number;
  inRotation: boolean;
  ready: number;
  /** Starts charged this week. */
  weekStarts: number;
  /** Starts this shortlist proposes. */
  proposed: number;
}

export interface Disagreement {
  objective: string;
  ahead: { key: string; epic: string | null; priority: number | null };
  behind: { key: string; epic: string | null; priority: number | null };
  rule: string;
}

export interface RankerOutput {
  algorithm: string;
  asOf: string;
  inputHash: string;
  inputHashes: Record<string, string>;
  shortlist: Position[];
  lanes: LaneReport[];
  floor: { d0: number; d0Reason: string | null; owed: number; lent: number };
  disagreements: Disagreement[];
  excluded: { key: string; reason: string }[];
  unallocated: { key: string; reason: string }[];
  problems: string[];
}

/** The lanes with ready work in `input`'s snapshot, for the tick's epoch record. */
export function readyLanes(
  input: Pick<RankerInput, "snapshot" | "records" | "allocationBlocked">,
): Set<WeightedLane> {
  const out = new Set<WeightedLane>();
  for (const c of classify(
    input.snapshot.items,
    input.records,
    input.allocationBlocked,
  ))
    if (
      isReady(c.item) &&
      (WEIGHTED_LANES as readonly string[]).includes(c.lane)
    )
      out.add(c.lane as WeightedLane);
  return out;
}

/** Rank `input` into a shortlist. */
export function rank(input: RankerInput): RankerOutput {
  const inputHashes = hashesOf(input);
  const classified = classify(
    input.snapshot.items,
    input.records,
    input.allocationBlocked,
  );
  const shares = laneShares(input.weights.weights);
  const { pools, excluded, unallocated } = partition(classified);
  for (const [lane, pool] of pools) pools.set(lane, order(lane, pool));
  const shortlist: Position[] = [];
  const place = placer(shortlist);
  let capacity = placeFront(
    pools,
    Math.max(0, Math.floor(input.capacity.starts)),
    place,
  );
  const state = counters(input);
  const proposed: Record<WeightedLane, number> = {
    core: 0,
    tactical: 0,
    peripheral: 0,
    "bug-other": 0,
  };
  const owedNow = clean(state.d0 + state.e + shares.peripheral - state.p);
  let lent = 0;
  const disagreements = disagreementsOf(pools);
  for (; capacity > 0; capacity--) {
    const owed = state.d0 + state.e + shares.peripheral - state.p;
    const readyLanes = WEIGHTED_LANES.filter(
      (l) => shares[l] > 0 && (pools.get(l)?.length ?? 0) > 0,
    );
    if (readyLanes.length === 0) break;
    const pick = chooseLane(readyLanes, shares, state, owed);
    const chosen = takeFrom(pick.lane, pools, state, input.records);
    if (chosen === null) break;
    if (pick.lent) lent++;
    place(
      chosen.item,
      pick.lane,
      true,
      `${pick.reason} (N ${state.N}, P ${state.p}, owed ${fmt(owed)})${chosen.why}`,
    );
    advance(state, pick.lane, chosen.objective, shares.peripheral);
    proposed[pick.lane]++;
  }
  excluded.push(...outOfRotation(pools, shortlist, shares));
  const lanes: LaneReport[] = WEIGHTED_LANES.map((lane) => ({
    lane,
    weight: input.weights.weights[lane],
    share: clean(shares[lane]),
    inRotation: shares[lane] > 0,
    ready: classified.filter((c) => c.lane === lane && isReady(c.item)).length,
    weekStarts: input.week.charges.filter((c) => c.lane === lane).length,
    proposed: proposed[lane],
  }));
  const output: Omit<RankerOutput, "inputHash"> = {
    algorithm: ALGORITHM_VERSION,
    asOf: input.asOf,
    inputHashes,
    shortlist,
    lanes,
    floor: {
      d0: input.week.d0,
      d0Reason: input.week.d0Reason,
      owed: owedNow,
      lent,
    },
    disagreements,
    excluded,
    unallocated,
    problems: [
      ...input.weights.problems,
      ...(input.allocationBlocked === null ? [] : [input.allocationBlocked]),
    ],
  };
  return {
    ...output,
    inputHash: hashOf({ algorithm: ALGORITHM_VERSION, inputHashes }),
  };
}

function hashesOf(input: RankerInput): Record<string, string> {
  return {
    snapshot: hashOf(input.snapshot),
    records: hashOf({
      records: input.records,
      blocked: input.allocationBlocked,
    }),
    weights: hashOf({
      weights: input.weights.weights,
      problems: input.weights.problems,
    }),
    capacity: hashOf(input.capacity),
    epochs: hashOf(input.epochs),
    week: hashOf(input.week),
    asOf: hashOf(input.asOf),
  };
}

/** The classified items split into lane pools, the excluded and the unallocated. */
function partition(classified: Classified[]): {
  pools: Map<Lane, Classified[]>;
  excluded: RankerOutput["excluded"];
  unallocated: RankerOutput["unallocated"];
} {
  const excluded: RankerOutput["excluded"] = [];
  const unallocated: RankerOutput["unallocated"] = [];
  const pools = new Map<Lane, Classified[]>();
  for (const c of classified) {
    const ready = isReady(c.item);
    if (c.lane === "excluded") {
      excluded.push({ key: c.item.key, reason: c.why });
    } else if (c.lane === "unallocated" && ready) {
      unallocated.push({ key: c.item.key, reason: c.why });
    } else if (c.lane === "unallocated" || (c.lane !== "urgent" && !ready)) {
      excluded.push({ key: c.item.key, reason: notReady(c.item) });
    } else pools.set(c.lane, [...(pools.get(c.lane) ?? []), c]);
  }
  return { pools, excluded, unallocated };
}

type Place = (
  c: Classified,
  lane: Lane,
  eligible: boolean,
  reason: string,
) => void;

function placer(shortlist: Position[]): Place {
  return (c, lane, eligible, reason) => {
    shortlist.push({
      position: shortlist.length + 1,
      scope: c.item.scope,
      key: c.item.key,
      title: c.item.title,
      lane,
      objective: c.placement?.objective ?? null,
      owners: c.owners,
      alsoIn: c.alsoIn,
      eligible,
      reason,
      gaps: c.item.gaps.filter(
        (g) => g === "priority" || g === "type" || g === "assignee",
      ),
    });
  };
}

function urgentReason(c: Classified, startable: boolean): string {
  if (!isReady(c.item))
    return `Urgent: listed though not eligible (${notReady(c.item)})`;
  return startable
    ? "Urgent: first; not counted in N"
    : "Urgent: first; no start capacity left";
}

/** Place the urgent items, then the high bugs, ahead of the weighted lanes; returns the capacity left. */
function placeFront(
  pools: Map<Lane, Classified[]>,
  start: number,
  place: Place,
): number {
  let capacity = start;
  for (const c of pools.get("urgent") ?? []) {
    const startable = isReady(c.item) && capacity > 0;
    if (startable) capacity--;
    place(c, "urgent", isReady(c.item), urgentReason(c, startable));
  }
  for (const c of pools.get("bug-high") ?? [])
    if (capacity > 0) {
      capacity--;
      place(
        c,
        "bug-high",
        true,
        "High bug: ahead of the weighted lanes; not counted in N",
      );
    }
  return capacity;
}

/** The lane that takes the next start: the owed peripheral start, else the largest deficit. */
function chooseLane(
  readyLanes: WeightedLane[],
  shares: Record<WeightedLane, number>,
  state: Counters,
  owed: number,
): { lane: WeightedLane; reason: string; lent: boolean } {
  const floorOwed = owed >= 1 - EPSILON;
  if (floorOwed && readyLanes.includes("peripheral"))
    return {
      lane: "peripheral",
      reason: "owed a whole start",
      lent: false,
    };
  let best: WeightedLane = "core";
  let bestDeficit = Number.NEGATIVE_INFINITY;
  for (const l of readyLanes) {
    const d = shares[l] * (state.N - (state.startN[l] ?? 0) + 1) - state.n[l];
    if (d > bestDeficit + EPSILON) {
      best = l;
      bestDeficit = d;
    }
  }
  const deficit = `largest deficit, ${fmt(bestDeficit)}`;
  return floorOwed
    ? {
        lane: best,
        reason: `floor owed, no peripheral work ready: lent; ${deficit}`,
        lent: true,
      }
    : { lane: best, reason: deficit, lent: false };
}

/** Count one placed start into the week's counters. */
function advance(
  state: Counters,
  lane: WeightedLane,
  objective: string | null,
  peripheralShare: number,
): void {
  state.N++;
  state.n[lane]++;
  if (objective !== null)
    state.nObjective.set(objective, (state.nObjective.get(objective) ?? 0) + 1);
  state.e += peripheralShare;
  if (lane === "peripheral") state.p++;
}

/** The unplaced items of lanes that carry no share. */
function outOfRotation(
  pools: Map<Lane, Classified[]>,
  shortlist: Position[],
  shares: Record<WeightedLane, number>,
): RankerOutput["excluded"] {
  const out: RankerOutput["excluded"] = [];
  for (const lane of WEIGHTED_LANES) {
    if (shares[lane] !== 0) continue;
    for (const c of pools.get(lane) ?? [])
      if (
        !shortlist.some((p) => p.key === c.item.key && p.scope === c.item.scope)
      )
        out.push({
          key: c.item.key,
          reason: `its lane ${lane} is out of rotation`,
        });
  }
  return out;
}

interface Counters {
  N: number;
  p: number;
  e: number;
  d0: number;
  startN: Partial<Record<WeightedLane, number>>;
  n: Record<WeightedLane, number>;
  nObjective: Map<string, number>;
}

/** The week's counters from its charges, each lane's counted from its epoch. */
function counters(input: RankerInput): Counters {
  const startN = input.epochs.startN;
  const n: Record<WeightedLane, number> = {
    core: 0,
    tactical: 0,
    peripheral: 0,
    "bug-other": 0,
  };
  const nObjective = new Map<string, number>();
  let N = 0;
  let p = 0;
  let e = 0;
  for (const charge of input.week.charges) {
    if (!isWeighted(charge)) continue;
    const lane = charge.lane as WeightedLane;
    if (N >= (startN[lane] ?? 0)) {
      n[lane]++;
      if (charge.objective !== null)
        nObjective.set(
          charge.objective,
          (nObjective.get(charge.objective) ?? 0) + 1,
        );
    }
    if (lane === "peripheral") p++;
    e += charge.peripheralShare;
    N++;
  }
  return { N, p, e, d0: input.week.d0, startN, n, nObjective };
}

/** Take the next item of `lane`: within an objective lane, from the objective with the largest deficit. */
function takeFrom(
  lane: WeightedLane,
  pools: Map<Lane, Classified[]>,
  state: Counters,
  records: readonly PrioritiesRecord[],
): { item: Classified; objective: string | null; why: string } | null {
  const pool = pools.get(lane) ?? [];
  if (lane === "bug-other") {
    const item = pool.shift();
    return item === undefined ? null : { item, objective: null, why: "" };
  }
  const { chosen, why } = pickObjective(lane, pool, state, records[0]);
  const index = pool.findIndex((c) => c.placement?.objective === chosen);
  const [item] = pool.splice(Math.max(index, 0), 1);
  if (item === undefined) return null;
  const placed = item.placement;
  return {
    item,
    objective:
      placed === null
        ? null
        : refKey(placed.level, placed.scope, placed.objective),
    why,
  };
}

/** The objective of `lane` with the largest deficit among those with ready work; the first one, lent, when none is owed. */
function pickObjective(
  lane: WeightedLane,
  pool: Classified[],
  state: Counters,
  record: PrioritiesRecord | undefined,
): { chosen: string | null; why: string } {
  const objectives = (record?.objectives ?? []).filter((o) => o.class === lane);
  const explicit = objectives.reduce((s, o) => s + (o.share ?? 0), 0);
  const unshared = objectives.filter((o) => o.share === undefined).length;
  const residual = Math.max(0, 1 - explicit);
  const ready = objectives.filter((o) =>
    pool.some((c) => c.placement?.objective === o.id),
  );
  let chosen: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const o of ready) {
    const share = o.share ?? (unshared > 0 ? residual / unshared : 0);
    const counted =
      record === undefined
        ? 0
        : (state.nObjective.get(refKey(record.level, record.scope, o.id)) ?? 0);
    const d = share * (state.n[lane] + 1) - counted;
    if (d > EPSILON && d > best + EPSILON) {
      chosen = o.id;
      best = d;
    }
  }
  const first = ready[0];
  if (chosen === null && first !== undefined)
    return { chosen: first.id, why: `; lent to ${first.id} in record order` };
  return { chosen, why: "" };
}

/** A lane's pool in its deterministic order. */
function order(lane: Lane, pool: Classified[]): Classified[] {
  const byKey = (a: Classified, b: Classified): number =>
    a.item.scope.localeCompare(b.item.scope) ||
    a.item.key.localeCompare(b.item.key, undefined, { numeric: true });
  if (lane === "urgent" || lane === "bug-high") return [...pool].sort(byKey);
  if (lane === "bug-other")
    return [...pool].sort((a, b) => prio(a.item) - prio(b.item) || byKey(a, b));
  return [...pool].sort(
    (a, b) =>
      placementOrder(a.placement, b.placement) ||
      prio(a.item) - prio(b.item) ||
      byKey(a, b),
  );
}

function placementOrder(a: Placement | null, b: Placement | null): number {
  if (a === null || b === null) return 0;
  return a.objectiveIndex - b.objectiveIndex || a.epicPosition - b.epicPosition;
}

/** A priority for ordering: unknown sorts after Low. */
function prio(item: SnapshotItem): number {
  return item.priority ?? 5;
}

/** Comparable ready work whose inherited position and tracker Priority disagree: reported, never edited. */
function disagreementsOf(pools: Map<Lane, Classified[]>): Disagreement[] {
  const out: Disagreement[] = [];
  for (const lane of ["core", "tactical", "peripheral"] as const) {
    const pool = pools.get(lane) ?? [];
    for (const [i, a] of pool.entries()) {
      for (const b of pool.slice(i + 1)) {
        const found = disagreement(a, b);
        if (found === null) continue;
        out.push(found);
        break;
      }
    }
  }
  return out;
}

function disagreement(
  a: Classified,
  b: Classified | undefined,
): Disagreement | null {
  if (b === undefined || a.placement === null || b.placement === null)
    return null;
  if (a.placement.objective !== b.placement.objective) return null;
  if (a.placement.epic === b.placement.epic) return null;
  if (a.item.priority === null || b.item.priority === null) return null;
  if (b.item.priority >= a.item.priority) return null;
  return {
    objective: a.placement.objective,
    ahead: {
      key: a.item.key,
      epic: a.placement.epic,
      priority: a.item.priority,
    },
    behind: {
      key: b.item.key,
      epic: b.placement.epic,
      priority: b.item.priority,
    },
    rule: "an epic's declared position orders its children before their own tracker Priority",
  };
}

/** Whether an item may be proposed for a start. */
function isReady(item: SnapshotItem): boolean {
  return (
    item.state === "ready" &&
    item.excluded === null &&
    item.blockers.length === 0 &&
    !item.gaps.includes("blockers")
  );
}

function notReady(item: SnapshotItem): string {
  if (item.excluded !== null) return item.excluded;
  if (item.gaps.includes("blockers"))
    return "its blockers could not be read, so it is not confirmed unblocked";
  if (item.blockers.length > 0) return `waiting on ${item.blockers.join(", ")}`;
  return `its state is ${item.state ?? "unknown"}, not ready`;
}

function fmt(n: number): string {
  return String(clean(n));
}
