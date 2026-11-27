/** The queue's hold and ordering rules, independent of the tracker and runtime. */
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { parseMs } from "../../shared/time.ts";

/** Rules in precedence order; an unset priority follows low. */
const QUEUE_ORDER = [
  "priority",
  "unblocks",
  "epicOrder",
  "size",
  "createdAt",
] as const;
const SIZE: Record<string, number> = {
  xs: 0,
  small: 1,
  s: 1,
  medium: 2,
  m: 2,
  large: 3,
  l: 3,
  xl: 4,
};
export interface QueueItem {
  issue: PoolIssue;
  blockers: string[];
  unblocks: number;
  epicOrder?: number;
}
/** Why an item a person's label holds (`jig:hold`, the human-in-the-loop or manual-operations label) starts nothing. */
export const PERSON_HOLD = "needs a person to start";

/** Whether an unplaced row's reason is a person's hold, bare or as the ready pool words it (`in the ready pool (…), but <hold>`). */
export function isPersonHold(reason: string): boolean {
  return reason === PERSON_HOLD || reason.endsWith(`, but ${PERSON_HOLD}`);
}

export interface QueueHoldPolicy {
  hitl?: string | undefined;
  manualOps?: string | undefined;
  personHold?: (key: string) => string | null;
}

export function queueHold(
  item: QueueItem,
  policy: QueueHoldPolicy = {},
): string | null {
  const person = policy.personHold?.(item.issue.identifier);
  if (person != null) return person;
  if (item.issue.truncated.length > 0) return "the issue read is incomplete";
  if (
    item.issue.labels.some(
      (l) =>
        l === (policy.hitl ?? "hitl") ||
        l.startsWith(`${policy.hitl ?? "hitl"}:`) ||
        l === (policy.manualOps ?? "manual-ops") ||
        l === "jig:hold",
    )
  )
    return PERSON_HOLD;
  return item.blockers.length > 0
    ? `waiting on ${item.blockers.join(", ")}`
    : null;
}
export function rankQueue<T extends QueueItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      compareQueue(a, b) ||
      a.issue.identifier.localeCompare(b.issue.identifier),
  );
}

/** Each ranking key as a reason names it. */
export const QUEUE_KEY_WORDS: Record<QueueKey, string> = {
  priority: "priorities",
  unblocks: "counts of items they unblock",
  epicOrder: "places in their epic's order",
  size: "sizes",
  createdAt: "creation times",
};

/** The first ranking key on which `a` and `b` differ, or `null` when they tie on every one. */
export function queueDifference(a: QueueItem, b: QueueItem): QueueKey | null {
  return firstDiffering(rankDeltas(a, b));
}

/** A tie under the queue's rules, before the stable identifier fallback. */
function compareQueue(a: QueueItem, b: QueueItem): number {
  const values = rankDeltas(a, b);
  const key = firstDiffering(values);
  return key === null ? 0 : values[key];
}

type QueueKey = (typeof QUEUE_ORDER)[number];

function firstDiffering(values: Record<QueueKey, number>): QueueKey | null {
  for (const key of QUEUE_ORDER)
    if (values[key] && Number.isFinite(values[key])) return key;
  return null;
}

function rankDeltas(a: QueueItem, b: QueueItem): Record<QueueKey, number> {
  return {
    priority: (a.issue.priority || 5) - (b.issue.priority || 5),
    unblocks: b.unblocks - a.unblocks,
    epicOrder:
      (a.epicOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.epicOrder ?? Number.MAX_SAFE_INTEGER),
    size:
      (SIZE[a.issue.size?.toLowerCase() ?? ""] ?? 5) -
      (SIZE[b.issue.size?.toLowerCase() ?? ""] ?? 5),
    createdAt: parseMs(a.issue.createdAt) - parseMs(b.issue.createdAt),
  };
}

/** Whether a walk met the item already, or a person holds it. */
export function seenOrHeld(
  issue: { identifier: string },
  policy: QueueHoldPolicy,
  seen: ReadonlySet<string>,
): boolean {
  return (
    seen.has(issue.identifier) || policy.personHold?.(issue.identifier) != null
  );
}
