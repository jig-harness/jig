/** Bounded recovery of accidental stops, from durable local launches and shared claims. */
import {
  type SharedClaim,
  readable,
  unreadable,
  winners,
} from "../../shared/records/shared.ts";
import type { ReadRecord } from "./launches.ts";
import { isDrive } from "./launches.ts";
import type { DriveClaims } from "./shared-launches.ts";
import type { Outcome } from "../../shared/outcome.ts";
import type { LaunchRecord } from "./launches.ts";
import type { DrivenPr } from "./types.ts";

const NO_CAUSE_LIMIT = 3;
export const NO_CAUSE_WINDOW_MS = 60 * 60_000;
export const NO_CAUSE_FACTS = "no-cause: ";

/** One old ledger receives at most one attempt, even beyond the rolling window. */
export function settleNoCauseStops(
  drives: readonly DrivenPr[],
  records: readonly ReadRecord[],
  claims: DriveClaims,
  nowMs: number,
): DrivenPr[] {
  return drives.map((pr) => {
    if (pr.evidence.noCause !== true) return pr;
    const fault = claimsFault(claims, pr.number);
    if (fault !== null) return { ...pr, class: "unplaced", why: fault };
    const attempts = attemptsOf(pr, records, claims);
    const why = limitReason(
      noCauseFacts(pr),
      pr.evidence.legacyNoCause === true,
      attempts,
      nowMs,
    );
    return why === null ? pr : { ...pr, class: "stopped-unknown", why };
  });
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
      isDrive(r.record) &&
      r.record.pr === pr.number &&
      (!losingRecords.has(r.record.id) || executed(r))
    )
      attempts.set(r.record.id, {
        facts: r.record.facts,
        at: r.record.createdAt,
      });
  for (const c of won) {
    const s = c.says.value;
    if (s.facts !== null && !attempts.has(String(s.record)))
      attempts.set(String(s.record), { facts: s.facts, at: s.at });
  }
  return attempts;
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
      a.facts.startsWith(NO_CAUSE_FACTS) &&
      (!Number.isFinite(Date.parse(a.at)) || Date.parse(a.at) > nowMs),
  );
  const count = [...attempts.values()].filter(
    (a) =>
      a.facts.startsWith(NO_CAUSE_FACTS) &&
      Date.parse(a.at) > nowMs - NO_CAUSE_WINDOW_MS,
  ).length;
  return oldAttempt || invalid || count >= NO_CAUSE_LIMIT
    ? `repeated no-cause stops: needs a person; ${invalid ? "a recovery attempt has an unreadable or future time" : oldAttempt ? "this legacy no-exit ledger already received its one recovery attempt" : `${count} recovery attempts within one hour (budget ${NO_CAUSE_LIMIT})`}; read the drive's handoff`
    : null;
}

/** Re-read after winning a reservation: only earlier claims can have consumed its budget. */
export function recoveryReservationRefusal(
  record: Pick<LaunchRecord, "id" | "facts">,
  own: number,
  history: Outcome<SharedClaim[], "unreadable">,
  nowMs: number,
): string | null {
  if (!record.facts.startsWith(NO_CAUSE_FACTS)) return null;
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
  for (const claim of winners(history.value)) {
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
