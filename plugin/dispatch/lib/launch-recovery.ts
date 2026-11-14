/** Which launch records a death keeps and how a supervised one is read: the recovery of a follow-up whose result or exit the host could not write. */
import type { LaunchRecord, LaunchState, ReadRecord } from "./launches.ts";
import { UNCONFIRMED_CLEANUP } from "./launch-supervision.ts";
import {
  diedWithoutResult,
  isRerun,
  retryableStartup,
} from "./session-startup.ts";
import { unwrittenExitWitness } from "./unwritten-result.ts";
import { idsOf, latestBy } from "./launch-keep.ts";

/**
 * The latest follow-up of each pull request, kept while it is a first death
 * the next launch runs again: its record is what recognises that launch as
 * the recovery, so it stays until a later record of the pull request exists.
 */
export function latestDeaths(records: ReadRecord[]): Set<string> {
  const latest = latestBy(records, (r) =>
    r.record.action === "followup" && !retryableStartup(r)
      ? `${r.record.repo}#${String(r.record.pr)}`
      : null,
  );
  return idsOf(
    latest,
    (r) =>
      r.record.rerunDied !== 0 && diedWithoutResult(r) && !isRerun(r.record),
  );
}

/**
 * A supervised launch whose wrapper ended with no exit written is held for
 * want of a cleanup witness; the wrapper's own evidence that it could not
 * write the exit, kept only after it confirmed the stage's processes ended,
 * is that witness, and the record is then a death a follow-up runs again.
 */
export function witnessedState(
  state: LaunchState,
  record: LaunchRecord,
  root: string,
): LaunchState {
  if (
    state.kind === "unknown" &&
    state.reason === UNCONFIRMED_CLEANUP &&
    state.liveProcess === undefined &&
    unwrittenExitWitness(root, record.id, record.token)
  )
    return {
      kind: "died",
      reason: "its exit could not be written after its cleanup was confirmed",
      process: state.process,
    };
  return state;
}
