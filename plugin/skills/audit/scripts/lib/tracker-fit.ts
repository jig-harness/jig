/**
 * What config-fit asks the configured tracker: whether it answers for the
 * audited repository, and, on GitHub Issues, where each facet the
 * configuration leaves to the default is kept (design/tracker-facets.md,
 * "No store moves by itself"). A facet that relies on the default waits on
 * detection before every read and write, and a store the default selected
 * changes only by what the tracker shows; naming it in `issue_tracker.facets`
 * commits it, so every facet without a named store is reported with the line
 * that names the store in force.
 */

import type { Tracker } from "../../../do-item/scripts/lib/tracker/port.ts";
import type { Finding } from "./schema.ts";

/** How long one question to the tracker may take. */
const ANSWER_MS = 30_000;

/** `ask`'s answer, or a refusal once it has given none within the time allowed. */
async function within<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${ANSWER_MS / 1000} seconds`));
      deadline.abort();
    }, ANSWER_MS);
    timer.unref();
  });
  try {
    return await Promise.race([ask(deadline.signal), timeout]);
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
 * On GitHub Issues, a finding for each facet whose store the configuration
 * does not name: a conflict or a refused default is an error, a detection
 * that could not be read is unchecked, and a store in force is offered as
 * the line that names it. Other adapters keep a facet the configuration does
 * not name where they always have, so they are not asked.
 */
export async function facetFindings(tracker: Tracker): Promise<Finding[]> {
  if (tracker.adapter !== "github") return [];
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
    if (f.why === "configured" || f.why === "no facet") return [];
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
