/**
 * A pull request's recovery budget: the re-arms of stops with no recorded
 * cause and the re-drives of stops whose next step is mechanical (a pass
 * deadline, a failure on a conflicting pull request, a silent driver this
 * host shows gone), counted together from this host's launch records and
 * every host's launch claims by the tag on their facts
 * (`recovery-facts.ts`). Once a rolling hour holds `NO_CAUSE_LIMIT` of them,
 * the next such stop is a person's.
 */
import {
  type SharedClaim,
  readable,
  unreadable,
  winners,
} from "../../shared/records/shared.ts";
import type { ReadRecord } from "./launches.ts";
import { cancelledBeforeExecution, isDrive } from "./launches.ts";
import type { DriveClaims } from "./shared-launches.ts";
import type { Outcome } from "../../shared/outcome.ts";
import type { LaunchRecord } from "./launches.ts";
import {
  budgeted,
  isRecovery,
  NO_CAUSE_FACTS,
  RECOVERY_FACTS,
} from "./recovery-facts.ts";
import type { DrivenPr } from "./types.ts";

const NO_CAUSE_LIMIT = 3;
export const NO_CAUSE_WINDOW_MS = 60 * 60_000;

/**
 * Each drive the recovery budget bounds, read beside the attempts already
 * made: a stop with no recorded cause whose budget is spent is
 * `stopped-unknown`, and one old ledger receives at most one attempt, even
 * beyond the rolling window; a re-drive whose budget is spent is a person's,
 * a stale stop `needs-person` and a silent driver notified as silent.
 */
export function settleNoCauseStops(
  drives: readonly DrivenPr[],
  records: readonly ReadRecord[],
  claims: DriveClaims,
  nowMs: number,
): DrivenPr[] {
  return drives.map((pr) => {
    const kind = boundedKind(pr);
    if (kind === null) return pr;
    const fault = claimsFault(claims, pr.number);
    if (fault !== null) return { ...pr, class: "unplaced", why: fault };
    const recovery = kind === "recovery";
    const why = limitReason(
      recovery ? recoveryTag(pr) : noCauseFacts(pr),
      !recovery && pr.evidence.legacyNoCause === true,
      attemptsOf(pr, records, claims),
      nowMs,
    );
    if (why === null) return pr;
    return recovery
      ? spentRecovery(pr, why)
      : { ...pr, class: "stopped-unknown", why };
  });
}

/** Which launch of a drive the budget bounds: a no-cause re-arm, a recovery re-drive, or none. */
function boundedKind(pr: DrivenPr): "no-cause" | "recovery" | null {
  if (pr.evidence.noCause === true) return "no-cause";
  const launchable = pr.class === "stale" || pr.class === "silent";
  return launchable && isRecovery(pr) ? "recovery" : null;
}

/** The tag a re-drive's facts carry; only its prefix is read here. */
function recoveryTag(pr: DrivenPr): string {
  return `${RECOVERY_FACTS}generation ${String(pr.evidence.generation)}`;
}

/** A re-drive whose budget is spent: a stale stop a person settles, a silent driver notified as one. */
function spentRecovery(pr: DrivenPr, why: string): DrivenPr {
  const spent = `${pr.stale?.cause ?? pr.why}; ${why}`;
  if (pr.class === "silent")
    return {
      ...pr,
      why: spent,
      evidence: { ...pr.evidence, driverGone: false },
    };
  const { stale: _spent, ...rest } = pr;
  return { ...rest, class: "needs-person", why: spent };
}

export function noCauseFacts(pr: DrivenPr): string {
  const e = pr.evidence;
  return `${NO_CAUSE_FACTS}${e.legacyNoCause === true ? "legacy " : ""}generation ${String(e.generation)}, exit ${String(e.exit)}, heartbeat ${String(e.heartbeat)}`;
}

function attemptsOf(
  pr: DrivenPr,
  records: readonly ReadRecord[],
  claims: DriveClaims,
): Map<string, { facts: string; at: string }> {
  const attempts = new Map<string, { facts: string; at: string }>();
  const cancelled = new Set(
    records.filter(cancelledBeforeExecution).map((r) => r.record.id),
  );
  const shared = claims.get(pr.number);
  const won = shared?.ok ? winners(shared.value) : [];
  const winningIds = new Set(won.map((c) => c.id));
  const losingRecords = new Set(
    (shared?.ok ? readable(shared.value) : [])
      .filter((c) => !winningIds.has(c.id))
      .map((c) => c.says.value.record),
  );
  for (const r of records)
    if (
      !cancelled.has(r.record.id) &&
      (isDrive(r.record) || r.record.action === "followup") &&
      r.record.pr === pr.number &&
      (!losingRecords.has(r.record.id) || executed(r))
    )
      attempts.set(r.record.id, {
        facts: r.record.facts,
        at: r.record.createdAt,
      });
  for (const c of budgetClaims(shared?.ok ? shared.value : [])) {
    const s = c.says.value;
    if (
      s.facts !== null &&
      !cancelled.has(String(s.record)) &&
      !attempts.has(String(s.record))
    )
      attempts.set(String(s.record), { facts: s.facts, at: s.at });
  }
  return attempts;
}

/** Winners reserve allowance; ended losers retain spent allowance unless cancellation is proven. */
function budgetClaims(claims: SharedClaim[]) {
  const won = new Set(winners(claims).map((c) => c.id));
  return readable(claims).filter((c) => {
    const end = c.says.value.end;
    return (
      !(end?.state === "died" && end.executed === false) &&
      (won.has(c.id) || end !== null)
    );
  });
}

/** A losing reservation is excluded only while no execution evidence exists. */
function executed(r: ReadRecord): boolean {
  return (
    r.state.kind !== "pending" ||
    r.record.attempts.some((a) => a.outcome !== "failed")
  );
}

/** Recovery cannot be bounded from a partial history of trusted launches. */
function claimsFault(claims: DriveClaims, pr: number): string | null {
  const read = claims.get(pr);
  if (read === undefined) return "its recovery launch claims were not read";
  if (!read.ok)
    return `its recovery launch claims could not be read: ${read.failure.reason}`;
  const [bad] = unreadable(read.value);
  if (bad === undefined || bad.says.ok) return null;
  return `a trusted recovery launch claim (comment ${bad.id}) does not read: ${bad.says.failure.reason}`;
}

function limitReason(
  facts: string,
  legacy: boolean,
  attempts: ReadonlyMap<string, { facts: string; at: string }>,
  nowMs: number,
): string | null {
  const oldAttempt =
    legacy && [...attempts.values()].some((a) => a.facts === facts);
  const invalid = [...attempts.values()].some(
    (a) =>
      budgeted(a.facts) &&
      (!Number.isFinite(Date.parse(a.at)) || Date.parse(a.at) > nowMs),
  );
  const count = [...attempts.values()].filter(
    (a) => budgeted(a.facts) && Date.parse(a.at) > nowMs - NO_CAUSE_WINDOW_MS,
  ).length;
  const what = facts.startsWith(RECOVERY_FACTS)
    ? "repeated recovery re-drives"
    : "repeated no-cause stops";
  return oldAttempt || invalid || count >= NO_CAUSE_LIMIT
    ? `${what}: needs a person; ${invalid ? "a recovery attempt has an unreadable or future time" : oldAttempt ? "this legacy no-exit ledger already received its one recovery attempt" : `${count} recovery attempts within one hour (budget ${NO_CAUSE_LIMIT})`}; read the drive's handoff`
    : null;
}

/**
 * Why a pull request's recovery budget is spent by this host's own launch
 * records of it, of any stage; `null` while it is not. For a stage whose
 * attempts no other host's claims count, a follow-up's run again among them.
 */
export function localRecoverySpent(
  repo: string,
  pr: number,
  records: readonly ReadRecord[],
  nowMs: number,
): string | null {
  const attempts = new Map<string, { facts: string; at: string }>();
  for (const r of records)
    if (
      r.record.repo === repo &&
      r.record.pr === pr &&
      !cancelledBeforeExecution(r)
    )
      attempts.set(r.record.id, {
        facts: r.record.facts,
        at: r.record.createdAt,
      });
  return limitReason(RECOVERY_FACTS, false, attempts, nowMs);
}

/** Re-read after winning a reservation: only earlier claims can have consumed its budget. */
export function recoveryReservationRefusal(
  record: Pick<LaunchRecord, "id" | "facts">,
  own: number,
  history: Outcome<SharedClaim[], "unreadable">,
  nowMs: number,
): string | null {
  if (!budgeted(record.facts)) return null;
  const fault = claimsFault(new Map([[0, history]]), 0);
  if (fault !== null) return fault;
  if (!history.ok) return history.failure.reason;
  const reservation = winners(history.value).find((c) => c.id === own);
  if (
    reservation?.says.value.record !== record.id ||
    reservation.says.value.facts !== record.facts ||
    reservation.says.value.end !== null
  )
    return "the recovery reservation could not be verified in its latest claim history";
  const attempts = new Map<string, { facts: string; at: string }>();
  for (const claim of budgetClaims(history.value)) {
    const s = claim.says.value;
    if (claim.id >= own || s.record === record.id || s.facts === null) continue;
    attempts.set(String(s.record), { facts: s.facts, at: s.at });
  }
  return limitReason(
    record.facts,
    record.facts.startsWith(`${NO_CAUSE_FACTS}legacy `),
    attempts,
    nowMs,
  );
}
