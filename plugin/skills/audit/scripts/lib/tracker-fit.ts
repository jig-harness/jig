/**
 * What config-fit asks the configured tracker: whether it answers for the
 * audited repository, whether configured facet stores are usable, and, on
 * GitHub Issues, where each facet the configuration leaves to the default
 * is kept (design/tracker-facets.md,
 * "No store moves by itself"). A facet that relies on the default waits on
 * detection before every read and write, and a store the default selected
 * changes only by what the tracker shows; naming it in `issue_tracker.facets`
 * commits it, so every facet without a named store is reported with the line
 * that names the store in force.
 */

import { JIRA_TIMEOUT_MS } from "../../../do-item/scripts/lib/tracker/jira/transport.ts";
import type { Tracker } from "../../../do-item/scripts/lib/tracker/port.ts";
import type { Finding } from "./schema.ts";

/**
 * How long one question to the tracker may take: longer than one request's
 * own deadline, so an adapter that stalls on its credential (a token command
 * that prints nothing) reports that itself before this deadline ends the wait
 * with a bare refusal that names no cause.
 */
export const ANSWER_MS = JIRA_TIMEOUT_MS + 5_000;

/** `ask`'s answer, or a refusal once it has given none within the time allowed. */
async function within<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(new Error(`no answer within ${ANSWER_MS / 1000} seconds`)),
    ANSWER_MS,
  );
  timer.unref();
  try {
    return await ask(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves when the tracker answers for the team or repository; reads no issue. */
export function reachTracker(tracker: Tracker): Promise<void> {
  return within((signal) => tracker.reach(signal));
}

/** Where a store keeps a facet, for a message. */
const STORE: Record<string, string> = {
  label: "labels",
  native: "the tracker's own field",
  field: "an issue field",
};

/**
 * Report failed configured stores for every adapter. On GitHub Issues, also
 * report conflicts and unchecked detection, and offer the line that names a
 * default store. Other adapters do not detect their defaults.
 */
export async function facetFindings(tracker: Tracker): Promise<Finding[]> {
  let stores: Awaited<ReturnType<Tracker["facetStores"]>>;
  try {
    stores = await within((signal) =>
      tracker.facetStores({ discovery: false, signal }),
    );
  } catch (e) {
    return [
      {
        id: "unchecked:issue_tracker.facets",
        severity: "warning",
        message: `where type, priority and size are kept is unchecked: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  return stores.facets.flatMap((f): Finding[] => {
    const at = `issue_tracker.facets.${f.facet}`;
    if (f.health?.status === "failed" && f.health.unavailable === true)
      return [
        {
          id: `unchecked:${at}`,
          severity: "warning",
          message: `whether ${f.facet}'s configured store can be used is unchecked: ${f.health.error}`,
        },
      ];
    if (f.health?.status === "failed")
      return [
        {
          id: `derivation:${at}`,
          severity: "error",
          message: `${f.facet}'s configured store cannot be used: ${f.health.error}; ${f.health.fails ?? "its reads and writes fail"}`,
        },
      ];
    if (
      tracker.adapter !== "github" ||
      f.why === "configured" ||
      f.why === "no facet"
    )
      return [];
    if (f.store === null)
      return [
        {
          id: `derivation:${at}`,
          severity: "error",
          message: `${f.problem ?? `${f.facet} has no store`}; until then every read and write of an issue fails`,
        },
      ];
    if (f.detection?.status === "failed")
      return [
        {
          id: `unchecked:${at}`,
          severity: "warning",
          message: `where ${f.facet} is kept is unchecked: ${f.detection.error}; every read and write of an issue fails until detection answers, or until ${at} names its store`,
        },
      ];
    const where =
      f.field === undefined ? STORE[f.store] : `the ${f.field} field`;
    return [
      {
        id: `suggestion:${at}`,
        severity: "suggestion",
        message: `${f.facet} is kept in ${where} (${f.why}), which no setting names, so every read and write of an issue waits on detecting it first; commit it: ${f.pin}`,
      },
    ];
  });
}

/** Open population counts, where the adapter can compare its configured scope. */
export async function poolScopeFindings(tracker: Tracker): Promise<Finding[]> {
  const read = tracker.poolScopeCounts?.bind(tracker);
  if (read === undefined) return [];
  try {
    const counts = await within(read);
    const scope = counts.scoped
      ? `${counts.pool} within the configured pool issue-type scope`
      : "no pool issue-type scope is configured";
    return [
      {
        id: "info:issue_tracker.pool_scope",
        severity: "info",
        message: `open population${counts.approximate ? " (approximate)" : ""}: ${counts.project} issues in the project; ${scope}`,
      },
    ];
  } catch (e) {
    return [
      {
        id: "unchecked:issue_tracker.pool_scope",
        severity: "warning",
        message: `open population counts are unchecked: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
}

/** Store health and default selection, followed by the adapter's population counts. */
export async function trackerFindings(tracker: Tracker): Promise<Finding[]> {
  return [
    ...(await facetFindings(tracker)),
    ...(await poolScopeFindings(tracker)),
  ];
}
