/** Durable steward recovery witnesses at initial reservation and pending replay. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { Slots } from "./accounts.ts";
import {
  startRecord,
  waits,
  type ApplyState,
  type LaunchClaimer,
} from "./actions/launch.ts";
import type { LaunchRecord } from "./launches.ts";
import { stewardFresh } from "./steward-apply.ts";
import {
  claimStewardRecord,
  releaseStewardRecord,
  stewardRecords,
} from "./steward.ts";
import type { Action, DrivenPr, LaunchOutcome } from "./types.ts";

/** A current human stop or hold wins before the persisted recovery witness is considered. */
export function recoveryReplayReading(
  record: LaunchRecord,
  read: DrivenPr | null,
  held: (pr: DrivenPr) => boolean,
  root?: string,
): Outcome<DrivenPr, "refused"> {
  if (read === null)
    return failed("refused", "its ledger cannot be read again");
  if (held(read))
    return failed("refused", "a person's hold label is on it now");
  if (record.stewardDecision === undefined) return ok(read);
  const decision = stewardRecords(record.repo, root).find(
    (r) => r.id === record.stewardDecision && r.value.kind === "rearm",
  );
  if (
    decision?.value.kind !== "rearm" ||
    !decision.applied ||
    (decision.effect !== null && decision.effect !== record.id)
  )
    return failed("refused", "the steward recovery witness cannot be verified");
  const fresh = stewardFresh(
    read,
    { steward: { id: decision.id, facts: decision.value.facts } },
    false,
  );
  return fresh === null
    ? failed("refused", "the steward recovery no longer reads")
    : ok(fresh);
}

/** Admission waits leave authorization pending; a durable reservation claims it immediately before launch. */
export async function startCheckedRecovery(
  state: ApplyState,
  action: Action,
  record: LaunchRecord,
  slots: Slots,
  claimer?: LaunchClaimer,
): Promise<LaunchOutcome> {
  if (action.steward && !claimStewardRecord(action.steward.id, state.root))
    return waits(action, "the steward decision was already claimed");
  const result = await startRecord(state, record, slots, claimer);
  if (action.steward && result.record === null)
    releaseStewardRecord(action.steward.id, state.root);
  return result;
}
