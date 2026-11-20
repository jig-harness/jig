/** What a served queue's failed reads leave: the rows they report and what fails the record. */
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/outbound/budget.ts";
import { isoFromMs } from "../../../shared/time.ts";
import { failureText } from "../text.ts";
import type { Unplaced } from "../types.ts";
import { noCredentialFailure, scopeFailureRow } from "./scope-failures.ts";
import type { ServedView } from "./served-reads.ts";

/** How the row a rate-limited tracker leaves begins, which tells it from every other row. */
export const LIMITED_REASON = "the issue service is rate limited until";

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
    reason: `${LIMITED_REASON} ${until}: pickups wait for the reset, and no request is sent before it`,
  };
  // A rate limit retains its class as a deferral, without a failed read.
  return {
    ...(view === null ? row : scopeFailureRow(tracker, view, row.reason)),
    failure: { class: "rate-limited", until },
  };
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
    ? scopeFailureRow(tracker, view, reason, error)
    : {
        target: identity,
        record: "tracker",
        reason,
        ...noCredentialFailure(error),
      };
}

/**
 * Why a served queue's items in progress were not read, from its view or
 * from what was thrown before it had one; `null` when they were read. A
 * queue read the limit stopped or that failed leaves only a kept reading's
 * items in progress, which may no longer hold.
 */
export function claimsUnread(
  view: Pick<ServedView, "limited" | "unavailable"> | null,
  ...thrown: [] | [error: unknown]
): string | null {
  const limited =
    view?.limited ?? (isRateLimited(thrown[0]) ? thrown[0] : null);
  if (limited !== null)
    return `the tracker is rate limited until ${isoFromMs(limited.resetAt)}`;
  return view === null ? failureText(thrown[0]) : (view.unavailable ?? null);
}

/** A failed queue or item read makes the reading incomplete; every cause that fails the record is kept. */
export function noteFailure(
  out: { failures?: unknown[]; incomplete?: boolean },
  got: { failures: unknown[]; partial: boolean },
): void {
  if (got.failures.length === 0 && !got.partial) return;
  if (got.failures.length > 0)
    out.failures = [...(out.failures ?? []), ...got.failures];
  out.incomplete = true;
}

/**
 * The row a served queue whose items in progress were not read leaves: what
 * goes unchecked while its claims are unknown. The failure that stopped the
 * read is the queue's own row or the record's, so this row fails nothing.
 */
export function claimsUnreadRow(
  identity: string,
  why: string,
  cut: Pick<Unplaced, "failure"> = {},
): Unplaced {
  return {
    target: `the items ${identity} claimed`,
    record: "tracker",
    reason: `the items ${identity} claimed could not be read, so stalls, double claims and the questions of started pickups are not checked: ${why}`,
    ...cut,
  };
}

/**
 * An item's read failed: the items below it are unknown. A thrown failure
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
