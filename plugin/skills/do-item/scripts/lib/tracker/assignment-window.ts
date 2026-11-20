/**
 * The creation window of a tracker's history: how long after an issue's
 * creation the history leaves out a change made to it. An assignment made
 * inside the window is never read by `Tracker.assignedBy`, so the dispatcher
 * cannot tell who made it and never starts the item. Linear leaves out
 * property changes made in an issue's first three minutes; GitHub Issues
 * and Jira record an assignment however soon it follows the creation.
 *
 * Every route that hands an issue to the line asks the tracker for its
 * window and writes the assignment only after it has passed.
 */
import { failed, ok, type Outcome } from "../../../../../shared/outcome.ts";
import { isoFromMs, parseMs } from "../../../../../shared/time.ts";

/** The part of a tracker that says how long its history's creation window lasts. */
export interface TrackerAssignmentWindow {
  /**
   * Milliseconds after an issue's creation during which its history leaves
   * out changes; absent or `0` when the history records every change.
   */
  readonly creationQuietMs?: number;
}

/** Linear's window: property changes in an issue's first three minutes are not in its history. */
export const LINEAR_CREATION_QUIET_MS = 180_000;

/**
 * Added past the window before an assignment is written, so a tracker
 * clock a few seconds behind this one still finds the write outside it.
 */
export const WINDOW_MARGIN_MS = 10_000;

/** The window, in words, for a message: `null` when the tracker has none. */
export function windowWords(
  tracker: TrackerAssignmentWindow & { adapter: string },
): string | null {
  const ms = tracker.creationQuietMs ?? 0;
  if (ms <= 0) return null;
  const minutes = ms / 60_000;
  const span = Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? "" : "s"}`
    : `${ms / 1000} seconds`;
  return `${tracker.adapter}'s history leaves out changes made in an issue's first ${span}, so an assignment made then is never seen by the dispatcher`;
}

/**
 * The earliest time, in milliseconds since the epoch, at which an
 * assignment of an issue created at `createdAt` is written so that its
 * history shows it: the creation plus the window and its margin. `null`
 * when the tracker has no window. Refused when the tracker has one and the
 * creation time does not read, since the write could then land inside it.
 */
export function assignableFromMs(
  tracker: TrackerAssignmentWindow,
  createdAt: string | undefined,
): Outcome<number | null, "refused"> {
  const ms = tracker.creationQuietMs ?? 0;
  if (ms <= 0) return ok(null);
  const created = createdAt === undefined ? Number.NaN : parseMs(createdAt);
  if (!Number.isFinite(created))
    return failed(
      "refused",
      `the issue's creation time did not read${createdAt === undefined ? "" : ` (${JSON.stringify(createdAt)})`}, so when its history starts recording an assignment is not known`,
    );
  return ok(created + ms + WINDOW_MARGIN_MS);
}

/**
 * How long to wait before writing an assignment, at `nowMs`: `0` when the
 * window has passed or the tracker has none. With the time it waits until.
 */
export function waitBeforeAssigning(
  from: number | null,
  nowMs: number,
): { waitMs: number; until: string | null } {
  if (from === null || from <= nowMs) return { waitMs: 0, until: null };
  return { waitMs: from - nowMs, until: isoFromMs(from) };
}
