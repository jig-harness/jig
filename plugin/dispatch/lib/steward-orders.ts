/**
 * The tick judges each steward order record once: one whose targets are all
 * wanted and tied orders the queue for as long as they stay so, and any
 * other is refused for good with its reason and the facts it read, which
 * the next digest shows the steward while they hold.
 */
import { stateRoot } from "../receipts.ts";
import {
  applyStewardOrder,
  orderFacts,
  orderRefusal,
} from "./steward-queue.ts";
import {
  claimStewardRecord,
  markStewardEffect,
  readStewardDigest,
  recordBelongsToDigest,
  refuseStewardRecord,
  STEWARD_REFUSED,
  stewardRecords,
  type KeptStewardRecord,
  type RefusedOrder,
  type StewardRecord,
} from "./steward.ts";
import type { WantedItem } from "./types.ts";

type OrderRecord = Extract<StewardRecord, { kind: "order" }>;

/** The effect an order record the tick took keeps: it orders the queue while its targets stay tied. */
export const STEWARD_ORDERED = "ordered";

/**
 * Whether this tick keeps its verdict on an order: only a tick that applies,
 * and only against a complete read of the queue, since one the tracker left
 * short would refuse an order for a target it merely did not read.
 */
export function judgesOrders(
  apply: boolean,
  read: { claimed: unknown; partial?: boolean },
): boolean {
  return apply && read.claimed !== null && read.partial !== true;
}

/**
 * The wanted items in the order the repository's steward records give their
 * ties. With `write` (a tick that applies), an order judged for the first
 * time is kept as taken or refused; without it nothing is written.
 */
export function orderByStewardRecords<T extends WantedItem>(
  repo: string,
  items: readonly T[],
  write: boolean,
  root = stateRoot(),
): T[] {
  const taken = stewardRecords(repo, root).flatMap((kept) =>
    kept.value.kind === "order" && kept.effect !== STEWARD_REFUSED
      ? judgeOrder(kept, kept.value, items, write, root)
      : [],
  );
  return applyStewardOrder(items, taken);
}

/** The order when the queue takes it; an unjudged one is kept as taken or refused when the tick writes. */
function judgeOrder(
  kept: KeptStewardRecord,
  order: OrderRecord,
  items: readonly WantedItem[],
  write: boolean,
  root: string,
): OrderRecord[] {
  const digest = readStewardDigest(kept.run, root);
  if (!digest.ok) return [];
  const refusal = recordBelongsToDigest(order, digest.value)
    ? orderRefusal(items, order.targets)
    : "the order names an item outside its own digest";
  const first = write && kept.effect === null;
  if (refusal === null) {
    if (first && claimStewardRecord(kept.id, root))
      markStewardEffect(kept.id, STEWARD_ORDERED, root);
    return [order];
  }
  if (first)
    refuseStewardRecord(
      kept.id,
      { reason: refusal, facts: orderFacts(items, order.targets) },
      root,
    );
  return [];
}

/**
 * The refused order records whose targets still read as they did when the
 * tick refused them, and one of which is still wanted: one per list of
 * targets, the latest.
 */
export function refusedOrders(
  repo: string,
  items: readonly WantedItem[],
  root = stateRoot(),
): RefusedOrder[] {
  const byTargets = new Map<string, RefusedOrder>();
  for (const kept of stewardRecords(repo, root)) {
    if (
      kept.value.kind !== "order" ||
      kept.effect !== STEWARD_REFUSED ||
      kept.refusal === null ||
      !kept.value.targets.some((key) => items.some((i) => i.key === key)) ||
      kept.refusal.facts !== orderFacts(items, kept.value.targets)
    )
      continue;
    byTargets.set(JSON.stringify(kept.value.targets), {
      record: kept.id,
      kind: "order",
      targets: kept.value.targets,
      refusal: kept.refusal.reason,
    });
  }
  return [...byTargets.values()];
}
