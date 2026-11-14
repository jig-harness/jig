/** Durable handoff for a wrapper's supervisor and the stage it starts. */
import { isMapping } from "../../shared/config-layers.ts";
import {
  decodeIdentity,
  judge,
  type HostIdentity,
  type ProcessIdentity,
} from "../../shared/liveness.ts";
import type { ProcessRow } from "../../shared/process-table.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { LaunchClaim, LaunchState } from "./launches.ts";
import { stateDb } from "./state.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";

export interface StageSupervision {
  /** null is a handoff not yet acknowledged; it holds after wrapper death. */
  supervisor: ProcessIdentity | null;
  child: ProcessIdentity | null;
  uncertain?: true;
}

/** Legacy wrapper-only claims still read; a malformed handoff never becomes legacy. */
export function asClaim(value: unknown): LaunchClaim | null {
  const identity = decodeIdentity(value);
  if (
    identity === null ||
    !isMapping(value) ||
    typeof value.claimedAt !== "string"
  )
    return null;
  const supervision = value.supervision;
  if (supervision === undefined)
    return { ...identity, claimedAt: value.claimedAt };
  if (
    !isMapping(supervision) ||
    (supervision.uncertain !== undefined && supervision.uncertain !== true)
  )
    return null;
  const supervisor =
    supervision.supervisor === null
      ? null
      : decodeIdentity(supervision.supervisor);
  const child =
    supervision.child === null ? null : decodeIdentity(supervision.child);
  if (
    (supervision.supervisor !== null && supervisor === null) ||
    (supervision.child !== null && child === null)
  )
    return null;
  return {
    ...identity,
    claimedAt: value.claimedAt,
    supervision: {
      supervisor,
      child,
      ...(supervision.uncertain === true ? { uncertain: true } : {}),
    },
  };
}

/** A known-live wrapper or stage identity, independent of unresolved handoffs. */
function liveStageProcess(
  claim: LaunchClaim,
  rows: ProcessRow[] | null,
  here: HostIdentity,
): ProcessIdentity | undefined {
  const identities = [
    claim,
    claim.supervision?.supervisor,
    claim.supervision?.child,
  ];
  return identities.find((identity): identity is ProcessIdentity => {
    if (identity == null) return false;
    const verdict = judge(identity, rows, here);
    return verdict.ok && verdict.value.state === "alive";
  });
}

/** A cleanup uncertainty survives process death, but not a proved restart of its host. */
export function uncertainCleanupState(
  claim: LaunchClaim | null | undefined,
  rows: ProcessRow[] | null,
  here: HostIdentity,
): LaunchState | null {
  if (claim?.supervision?.uncertain !== true) return null;
  const verdict = judge(claim, rows, here);
  if (
    verdict.ok &&
    verdict.value.state === "dead" &&
    claim.bootId !== here.bootId
  )
    return null;
  const liveProcess = liveStageProcess(claim, rows, here);
  return {
    kind: "unknown",
    reason: "the stage cleanup could not be confirmed",
    process: claim,
    ...(liveProcess === undefined ? {} : { liveProcess }),
  };
}

/** A supervised launch without a cleanup witness holds after wrapper death. */
export function claimState(
  claim: LaunchClaim,
  rows: ProcessRow[] | null,
  here: HostIdentity,
): LaunchState {
  const wrapper = judge(claim, rows, here);
  const liveProcess = liveStageProcess(claim, rows, here);
  if (!wrapper.ok)
    return {
      kind: "unknown",
      reason: wrapper.failure.reason,
      process: claim,
      ...(liveProcess === undefined ? {} : { liveProcess }),
    };
  if (wrapper.value.state === "alive") return { kind: "alive", process: claim };
  const handoff = claim.supervision;
  if (handoff !== undefined) {
    // A reboot proves even an unacknowledged launch on this host is gone.
    if (claim.bootId !== here.bootId)
      return { kind: "died", reason: wrapper.value.reason, process: claim };
    if (liveProcess !== undefined)
      return {
        kind: "unknown",
        reason: "the wrapper ended while a supervised stage process still runs",
        process: claim,
        liveProcess,
      };
    if (handoff.supervisor === null || handoff.child === null)
      return {
        kind: "unknown",
        reason: "the supervised stage launch handoff was not acknowledged",
        process: claim,
      };
    return {
      kind: "unknown",
      reason: "the supervised stage ended without confirmed cleanup",
      process: claim,
    };
  }
  return { kind: "died", reason: wrapper.value.reason, process: claim };
}

function same(a: ProcessIdentity | null, b: ProcessIdentity): boolean {
  return (
    a !== null &&
    a.pid === b.pid &&
    a.start === b.start &&
    a.bootId === b.bootId &&
    a.hostId === b.hostId &&
    a.host === b.host
  );
}

/** Each acknowledgement fills only its pending identity, under the launch token and expected owner. */
export function registerStageProcess(
  id: string,
  token: string,
  role: "supervisor" | "child",
  identity: ProcessIdentity,
  owner: ProcessIdentity,
  root = stateRoot(),
): Outcome<void, "registration"> {
  const result = attempt(
    "registration",
    "the stage identity could not be recorded",
    () => {
      const db = stateDb(root);
      const row = db
        .query(
          "SELECT claim FROM launches WHERE id = ? AND json_extract(record, '$.token') = ? AND exit IS NULL",
        )
        .get(id, token) as { claim: string } | null;
      if (row === null) return false;
      const claim = asClaim(JSON.parse(row.claim));
      if (claim?.supervision === undefined || claim.supervision[role] !== null)
        return false;
      if (
        !same(
          role === "supervisor" ? claim : claim.supervision.supervisor,
          owner,
        )
      )
        return false;
      claim.supervision[role] = identity;
      return (
        db
          .query(
            "UPDATE launches SET claim = ? WHERE id = ? AND claim = ? AND exit IS NULL",
          )
          .run(JSON.stringify(claim), id, row.claim).changes === 1
      );
    },
  );
  if (!result.ok) return result;
  return result.value
    ? ok(undefined)
    : failed(
        "registration",
        "the stage identity handoff no longer belongs to this process",
      );
}

/** Unconfirmed observed cleanup keeps the slot even after both supervisors exit. */
export function uncertainStage(id: string, root = stateRoot()): void {
  stateDb(root)
    .query(
      "UPDATE launches SET claim = json_set(claim, '$.supervision.uncertain', json('true')) WHERE id = ? AND json_type(claim, '$.supervision') = 'object'",
    )
    .run(id);
}

/** The token-bound claim the supervisor acknowledges before it starts a stage. */
export function readStageClaim(
  id: string,
  token: string,
  root = stateRoot(),
): LaunchClaim | null {
  const row = stateDb(root)
    .query(
      "SELECT claim FROM launches WHERE id = ? AND json_extract(record, '$.token') = ? AND exit IS NULL",
    )
    .get(id, token) as { claim: string } | null;
  if (row === null) return null;
  const parsed = attempt("registration", "the claim does not read", () =>
    JSON.parse(row.claim),
  );
  if (parsed.ok) return asClaim(parsed.value);
  swallow(parsed.failure.cause, parsed.failure.reason);
  return null;
}
