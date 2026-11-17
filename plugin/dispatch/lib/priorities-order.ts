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

/** One pickup in the enforced order: the lane and objective its start is charged to, and why it stands there. */
export interface OrderedStart {
  target: string;
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

/**
 * Reorder `actions`' pickups by `ranking`, keeping every other action where
 * it stands. `classes` is each item's lane as the ranking classified it.
 */
export function enforcePickupOrder(
  actions: readonly Action[],
  ranking: Pick<
    RankerOutput,
    "shortlist" | "unallocated" | "excluded" | "lanes"
  >,
  classes: Readonly<Record<string, ItemClass>>,
): { actions: Action[]; order: EnforcedOrder } {
  const positions = new Map(
    ranking.shortlist
      .filter((p) => p.eligible)
      .map((p, i) => [p.key, { at: i, p }] as const),
  );
  const unallocated = new Map(
    ranking.unallocated.map((u, i) => [u.key, { at: i, u }] as const),
  );
  const excluded = new Map(ranking.excluded.map((e) => [e.key, e.reason]));
  const paused = new Set<WeightedLane>(
    ranking.lanes.filter((l) => !l.inRotation).map((l) => l.lane),
  );
  const placed: Placed[] = [];
  const withheld: EnforcedOrder["withheld"] = [];
  actions.forEach((action, index) => {
    if (action.stage !== "pickup") return;
    const keys = membersOf(action);
    const ranked = best(keys, (k) => positions.get(k)?.at);
    const position = ranked === null ? undefined : positions.get(ranked);
    if (position !== undefined) {
      const { p } = position;
      placed.push({
        action,
        rank: [0, position.at],
        start: {
          target: action.target,
          lane: p.lane,
          objective: p.objective,
          why: `position ${p.position}: ${p.reason}`,
        },
      });
      return;
    }
    const loose = best(keys, (k) => unallocated.get(k)?.at);
    const free = loose === null ? undefined : unallocated.get(loose);
    if (free !== undefined) {
      placed.push({
        action,
        rank: [1, free.at],
        start: {
          target: action.target,
          lane: "unallocated",
          objective: null,
          why: `after the ranked work, unallocated: ${free.u.reason}`,
        },
      });
      return;
    }
    const lane = keys
      .map((k) => classes[k]?.lane)
      .find((l): l is WeightedLane => l !== undefined && isWeightedLane(l));
    if (lane !== undefined && paused.has(lane)) {
      withheld.push({
        target: action.target,
        lane,
        why: `its lane ${lane} is out of rotation (weight 0, or a weights file that does not read): it starts nothing while the ranking orders the starts`,
      });
      return;
    }
    const reason = keys
      .map((k) => excluded.get(k))
      .find((r) => r !== undefined);
    placed.push({
      action,
      rank: [2, index],
      start: {
        target: action.target,
        lane: "unallocated",
        objective: null,
        why: `after the ranked and unallocated work, not ranked: ${reason ?? "the ranking did not read it"}`,
      },
    });
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

/** The items a pickup starts: its target, and a batch's members. */
function membersOf(action: Action): string[] {
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
