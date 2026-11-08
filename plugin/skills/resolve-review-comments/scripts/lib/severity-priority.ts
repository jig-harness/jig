/**
 * The priority a deferred review finding is filed at, from its severity: the
 * one mapping every deferral path reads (`defer-batch.ts` on create and on
 * append, `file-deferred.ts` through the tracker interface), so no two paths
 * give one finding different priorities.
 *
 * Priorities are the tracker interface's: 0 none, then 1 (urgent) to 4
 * (low). A finding of `unknown` severity files as medium: a finding nothing
 * ranked is not low priority but unranked, and an unranked follow-up cannot
 * be worked in order (M9, priority and category at birth). Each severity is a
 * floor: a priority already more urgent stays, a weaker one (or none) is
 * raised to it, and nothing is ever lowered.
 */
import { CANONICAL_SEVERITIES, SEVERITY_UNKNOWN } from "./ladder.ts";

/**
 * The priority each severity token files at. A blocker is urgent, since
 * ranking it below high would understate the one severity that should never
 * have been deferred at all; `unknown` is medium.
 */
export const SEVERITY_TO_PRIORITY: Readonly<Record<string, number>> = {
  [SEVERITY_UNKNOWN]: 3, // Medium
  low: 4,
  medium: 3,
  high: 2,
  blocker: 1, // Urgent
};

// Fails closed at import time when the key set drifts from the severity
// vocabulary: a token with no row would file with no priority at all, the
// failure this mapping exists to prevent.
{
  const expected = new Set([...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]);
  const actual = new Set(Object.keys(SEVERITY_TO_PRIORITY));
  const missing = [...expected].filter((s) => !actual.has(s));
  const extra = [...actual].filter((s) => !expected.has(s));
  if (missing.length > 0 || extra.length > 0)
    throw new Error(
      `SEVERITY_TO_PRIORITY's keys no longer match the severity vocabulary` +
        `${missing.length > 0 ? `: missing [${missing.join(", ")}]` : ""}` +
        `${extra.length > 0 ? `: stale [${extra.join(", ")}]` : ""}`,
    );
}

/** The priorities by number, as a person reads them. */
const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];

/** A priority number as a person reads it: `3 (medium)`. */
export function priorityText(priority: number): string {
  return `${priority} (${PRIORITY_NAMES[priority] ?? "unknown"})`;
}

/**
 * How urgent a priority is, higher more urgent: none 0, low 1 up to urgent
 * 4. A priority number counts down with urgency except for 0 (none), so two
 * priorities are never compared by their numbers.
 */
export function urgency(priority: number): number {
  return Number.isInteger(priority) && priority >= 1 && priority <= 4
    ? 5 - priority
    : 0;
}

/** The priority `severity` files at; throws on a token outside the vocabulary. */
export function severityPriority(severity: string): number {
  const priority = Object.hasOwn(SEVERITY_TO_PRIORITY, severity)
    ? SEVERITY_TO_PRIORITY[severity]
    : undefined;
  if (priority === undefined) throw new Error(`Unknown severity '${severity}'`);
  return priority;
}

/** Whether `currentPriority` is already at least as urgent as `severity`'s floor. */
export function priorityReflectsSeverity(
  currentPriority: number,
  severity: string,
): boolean {
  return urgency(currentPriority) >= urgency(severityPriority(severity));
}

/**
 * The priority an issue at `currentPriority` should have once it also carries
 * a finding of `severity`: raised to the severity's floor, never lowered.
 */
export function priorityAfterSeverity(
  currentPriority: number,
  severity: string,
): number {
  return priorityReflectsSeverity(currentPriority, severity)
    ? currentPriority
    : severityPriority(severity);
}
