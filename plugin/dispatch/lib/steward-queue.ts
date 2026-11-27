/** The steward breaks ties without overriding the queue's own precedence. */
import {
  queueDifference,
  queueHold,
  QUEUE_KEY_WORDS,
  type QueueItem,
} from "./queue-rank.ts";
import type { WantedItem } from "./types.ts";
import { parseMs } from "../../shared/time.ts";

interface OrderRecord {
  kind: "order";
  targets: string[];
  reason: string;
}

/**
 * Why the queue cannot take an order of `targets` on this tick, or `null`
 * when every target is wanted, ranked and tied with the others on every
 * ranking key, creation time included.
 */
export function orderRefusal(
  items: readonly WantedItem[],
  targets: readonly string[],
): string | null {
  if (new Set(targets).size !== targets.length)
    return "the order names an item more than once";
  const ranked: Array<{ key: string; rank: QueueItem }> = [];
  for (const key of targets) {
    const item = items.find((i) => i.key === key);
    if (item === undefined)
      return `${key} is not among the items this tick wants`;
    const rank = rankOf(item);
    if (rank === null)
      return `${key} has no complete queue rank, or a hold keeps it out of the queue`;
    ranked.push({ key, rank });
  }
  const [first, ...rest] = ranked;
  if (first === undefined) return null;
  for (const other of rest) {
    const differs = queueDifference(first.rank, other.rank);
    if (differs !== null)
      return `${first.key} and ${other.key} do not tie: their ${QUEUE_KEY_WORDS[differs]} differ`;
  }
  return null;
}

/** The facts an order's targets read with on this tick: a refusal stands while they are unchanged. */
export function orderFacts(
  items: readonly WantedItem[],
  targets: readonly string[],
): string {
  return JSON.stringify(
    targets.map((key) =>
      factsOf(
        key,
        items.find((i) => i.key === key),
      ),
    ),
  );
}

/** One target's ranking facts, or that the tick does not want it. */
function factsOf(key: string, item: WantedItem | undefined): unknown[] {
  if (item === undefined) return [key, null];
  const { queueIssue: issue, queueRank: rank } = item;
  return [
    key,
    issue?.priority,
    rank?.unblocks,
    rank?.epicOrder,
    issue?.size,
    issue?.createdAt,
    rankOf(item) !== null,
  ].map((v) => v ?? null);
}

/** Only records whose targets all tie (`orderRefusal`) exchange those targets' existing slots. */
export function applyStewardOrder<T extends WantedItem>(
  items: readonly T[],
  records: readonly OrderRecord[],
): T[] {
  const out = [...items];
  for (const record of records) {
    if (orderRefusal(out, record.targets) !== null) continue;
    const members = record.targets.flatMap((key) => {
      const found = out.find((i) => i.key === key);
      return found === undefined ? [] : [found];
    });
    exchange(out, members);
  }
  return out;
}

function exchange<T>(out: T[], members: readonly T[]): void {
  const named = new Set(members);
  const slots = out.flatMap((item, index) => (named.has(item) ? [index] : []));
  for (let n = 0; n < slots.length; n++) {
    const slot = slots[n];
    const next = members[n];
    if (slot !== undefined && next !== undefined) out[slot] = next;
  }
}

function rankOf(item: WantedItem): QueueItem | null {
  const issue = item.queueIssue;
  const rank = item.queueRank;
  if (!issue || !rank || !Number.isFinite(parseMs(issue.createdAt)))
    return null;
  const value: QueueItem = { issue, blockers: [], ...rank };
  return queueHold(value) === null ? value : null;
}
