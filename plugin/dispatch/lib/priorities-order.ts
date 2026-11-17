/**
 * The pickups' start order under the host's `priorities.enforce` opt-in
 * ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)):
 * each start the host's capacity allows goes to the pickup the ranking puts
 * first. The order is the shortlist's eligible positions, then the
 * unallocated work in the ranking's order, then any other pickup the ranking
 * did not place, in the plan's order. A pickup whose lane a weight of 0 took
 * out of rotation is withheld and reported, so a paused lane starts nothing.
 *
 * The order only says which work is owed the next start: capacity stays the
 * host's (load admission, each account's slots and walls), and each launch
 * still reads its item again and may wait. A pickup that cannot start passes
 * its start to the next in the order, so no lane keeps a slot free while
 * other ready work could take it.
 */
import {
  isWeightedLane,
  type Lane,
  type WeightedLane,
} from "../../shared/priorities/lanes.ts";
import type { RankerOutput } from "../../shared/priorities/ranker.ts";
import type { ItemClass } from "./allocation-store.ts";
import { batchItemsOf } from "./queue-batch.ts";
import type { Action } from "./types.ts";

/**
 * One pickup in the enforced order: the lane and objective of the member that
 * placed it (`orderedBy`, the target unless a batch member stands earlier in
 * the ranking), and why it stands there. A batch's claims each persist their
 * own member's charge; `why` lists the lanes the other members carry.
 */
export interface OrderedStart {
  target: string;
  orderedBy: string;
  lane: Lane | "unallocated";
  objective: string | null;
  why: string;
}

/** The pickups' start order the ranking set this tick, and the pickups it held back. */
export interface EnforcedOrder {
  starts: OrderedStart[];
  withheld: Array<{ target: string; lane: WeightedLane; why: string }>;
}

interface Placed {
  action: Action;
  start: OrderedStart;
  /** The tier (ranked, unallocated, other) and the place within it. */
  rank: [number, number];
}

type Ranking = Pick<
  RankerOutput,
  "shortlist" | "unallocated" | "excluded" | "lanes"
>;

/** Where the ranking put each item: its eligible shortlist position, its place in the unallocated work, or why it excluded it. */
interface Places {
  positions: Map<string, { at: number; p: RankerOutput["shortlist"][number] }>;
  unallocated: Map<string, { at: number; reason: string }>;
  excluded: Map<string, string>;
}

/**
 * Reorder `actions`' pickups by `ranking`, keeping every other action where
 * it stands. `classes` is each item's lane as the ranking classified it. A
 * batch member whose lane is out of rotation leaves the batch; a batch whose
 * lead is in such a lane is withheld whole, since its launch reads its items
 * through the lead.
 */
export function enforcePickupOrder(
  actions: readonly Action[],
  ranking: Ranking,
  classes: Readonly<Record<string, ItemClass>>,
): { actions: Action[]; order: EnforcedOrder } {
  const places = placesOf(ranking);
  const pausedLanes = new Set<WeightedLane>(
    ranking.lanes.filter((l) => !l.inRotation).map((l) => l.lane),
  );
  const paused = (key: string): WeightedLane | null => {
    const lane = classes[key]?.lane;
    return lane !== undefined && isWeightedLane(lane) && pausedLanes.has(lane)
      ? lane
      : null;
  };
  const placed: Placed[] = [];
  const withheld: EnforcedOrder["withheld"] = [];
  actions.forEach((action, index) => {
    if (action.stage !== "pickup") return;
    const kept = withoutPaused(action, paused, withheld);
    if (kept !== null) placed.push(place(kept, index, places, classes));
  });
  placed.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
  const queue = placed.map((p) => p.action);
  const out: Action[] = [];
  for (const action of actions)
    if (action.stage !== "pickup") out.push(action);
    else {
      const next = queue.shift();
      if (next !== undefined) out.push(next);
    }
  return {
    actions: out,
    order: { starts: placed.map((p) => p.start), withheld },
  };
}

function placesOf(ranking: Ranking): Places {
  return {
    positions: new Map(
      ranking.shortlist
        .filter((p) => p.eligible)
        .map((p, i) => [p.key, { at: i, p }] as const),
    ),
    unallocated: new Map(
      ranking.unallocated.map(
        (u, i) => [u.key, { at: i, reason: u.reason }] as const,
      ),
    ),
    excluded: new Map(ranking.excluded.map((e) => [e.key, e.reason])),
  };
}

const PAUSED =
  "is out of rotation (weight 0, or a weights file that does not read): it starts nothing while the ranking orders the starts";

/** The pickup without its paused-lane members, each recorded withheld; `null` when its lead's lane is paused. */
function withoutPaused(
  action: Action,
  paused: (key: string) => WeightedLane | null,
  withheld: EnforcedOrder["withheld"],
): Action | null {
  const lead = paused(action.target);
  const batch = batchItemsOf(action.evidence.batchItems);
  const members = batch.ok ? (batch.value ?? []) : [];
  if (lead !== null) {
    withheld.push({
      target: action.target,
      lane: lead,
      why: `its lane ${lead} ${PAUSED}`,
    });
    for (const m of members)
      if (m.key !== action.target)
        withheld.push({
          target: m.key,
          lane: paused(m.key) ?? lead,
          why: `batched behind ${action.target}, whose lane ${lead} ${PAUSED}`,
        });
    return null;
  }
  const out = members.filter((m) => paused(m.key) !== null);
  if (out.length === 0) return action;
  for (const m of out) {
    const lane = paused(m.key) as WeightedLane;
    withheld.push({
      target: m.key,
      lane,
      why: `its lane ${lane} ${PAUSED}; left out of ${action.target}'s batch`,
    });
  }
  const kept = members.filter((m) => paused(m.key) === null);
  const { batchItems: _, ...evidence } = action.evidence;
  return {
    ...action,
    reason: `${action.reason}; ${out.map((m) => m.key).join(", ")} left out: a lane out of rotation`,
    evidence:
      kept.length < 2
        ? evidence
        : { ...evidence, batchItems: JSON.stringify(kept) },
  };
}

/** Where one pickup stands in the enforced order, and the charge and reason its start carries. */
function place(
  action: Action,
  index: number,
  places: Places,
  classes: Readonly<Record<string, ItemClass>>,
): Placed {
  const keys = membersOf(action);
  const lanes = (by: string): string =>
    keys.length < 2
      ? ""
      : `; batch ordered by ${by}, members' lanes ${keys.map((k) => `${k} ${classes[k]?.lane ?? "unclassified"}`).join(", ")}`;
  const ranked = best(keys, (k) => places.positions.get(k)?.at);
  const position = ranked === null ? undefined : places.positions.get(ranked);
  if (position !== undefined)
    return {
      action,
      rank: [0, position.at],
      start: {
        target: action.target,
        orderedBy: ranked as string,
        lane: position.p.lane,
        objective: position.p.objective,
        why: `position ${position.p.position}: ${position.p.reason}${lanes(ranked as string)}`,
      },
    };
  const loose = best(keys, (k) => places.unallocated.get(k)?.at);
  const free = loose === null ? undefined : places.unallocated.get(loose);
  if (free !== undefined)
    return {
      action,
      rank: [1, free.at],
      start: {
        target: action.target,
        orderedBy: loose as string,
        lane: "unallocated",
        objective: null,
        why: `after the ranked work, unallocated: ${free.reason}${lanes(loose as string)}`,
      },
    };
  const reason = keys
    .map((k) => places.excluded.get(k))
    .find((r) => r !== undefined);
  return {
    action,
    rank: [2, index],
    start: {
      target: action.target,
      orderedBy: action.target,
      lane: "unallocated",
      objective: null,
      why: `after the ranked and unallocated work, not ranked: ${reason ?? "the ranking did not read it"}`,
    },
  };
}

/** The items a pickup starts: its target, and a batch's members. */
export function membersOf(action: Action): string[] {
  const batch = batchItemsOf(action.evidence.batchItems);
  const members = batch.ok ? (batch.value ?? []).map((m) => m.key) : [];
  return [action.target, ...members.filter((k) => k !== action.target)];
}

/** The key with the smallest place, or `null` when none has one. */
function best(
  keys: readonly string[],
  at: (key: string) => number | undefined,
): string | null {
  let found: string | null = null;
  let least = Number.POSITIVE_INFINITY;
  for (const k of keys) {
    const n = at(k);
    if (n !== undefined && n < least) {
      least = n;
      found = k;
    }
  }
  return found;
}
