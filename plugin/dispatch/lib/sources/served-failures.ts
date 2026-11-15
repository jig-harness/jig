/** What a served queue's failed reads leave: the rows they report and what fails the record. */
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import type { TrackerRateLimited } from "../../../shared/outbound/budget.ts";
import { isoFromMs } from "../../../shared/time.ts";
import { failureText } from "../text.ts";
import type { Unplaced } from "../types.ts";
import { scopeFailureRow } from "./scope-failures.ts";
import type { ServedView } from "./served-reads.ts";

/** The single row a rate-limited tracker leaves on the receipt. */
export function limitedRow(
  tracker: Pick<Tracker, "adapter" | "team">,
  limited: TrackerRateLimited,
  view: Pick<ServedView, "readAt" | "scope"> | null = null,
): Unplaced {
  const until = isoFromMs(limited.resetAt);
  const row: Unplaced = {
    target: `${tracker.adapter} ${tracker.team}`,
    record: "tracker",
    reason: `the tracker is rate limited until ${until}: pickups wait for the reset, and no request is sent before it`,
  };
  return view === null ? row : scopeFailureRow(tracker, view, row.reason);
}

/** The one unplaced row an identity's failed read leaves. */
export function readFailureRow(
  tracker: Tracker,
  identity: string,
  view: ServedView | null,
  error: unknown,
): Unplaced {
  const reason = `the served assignments could not be read: ${failureText(error)}`;
  return view?.scope !== undefined && isUnavailable(error)
    ? scopeFailureRow(tracker, view, reason)
    : { target: identity, record: "tracker", reason };
}

/**
 * An item's read failed: the claims below it are unknown. A thrown failure
 * fails the record, with its class; an item no read threw for (an answer that
 * names no assigner, a read the tracker cut short, a missing description) is
 * its row alone. A cause is passed only when a read threw, so a rejection
 * whose value is `undefined` still fails the record.
 */
export function itemFailed(
  found: { failures: unknown[]; partial: boolean },
  ...thrown: [] | [cause: unknown]
): void {
  found.partial = true;
  if (thrown.length > 0) found.failures.push(thrown[0]);
}
