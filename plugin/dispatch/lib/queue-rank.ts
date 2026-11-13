/** The queue's hold and ordering rules, independent of the tracker and runtime. */
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";

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

export function queueHold(
  item: QueueItem,
  policy: { hitl?: string | undefined; manualOps?: string | undefined } = {},
): string | null {
  if (item.issue.truncated.length > 0) return "the tracker read is incomplete";
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

/** A tie under the queue's rules, before the stable identifier fallback. */
export function compareQueue(a: QueueItem, b: QueueItem): number {
  const values = {
    priority: (a.issue.priority || 5) - (b.issue.priority || 5),
    unblocks: b.unblocks - a.unblocks,
    epicOrder:
      (a.epicOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.epicOrder ?? Number.MAX_SAFE_INTEGER),
    size:
      (SIZE[a.issue.size?.toLowerCase() ?? ""] ?? 5) -
      (SIZE[b.issue.size?.toLowerCase() ?? ""] ?? 5),
    createdAt: Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt),
  };
  for (const key of QUEUE_ORDER)
    if (values[key] && Number.isFinite(values[key])) return values[key];
  return 0;
}
