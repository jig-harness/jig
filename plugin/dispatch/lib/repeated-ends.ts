/**
 * Launches of one drive that keep ending the same way, counted from this
 * host's launch records, backed off and capped so they never loop:
 *
 * - a re-arm of a ledger that stopped `NOT_SETTLED` (`4`) whose own run
 *   stopped `NOT_SETTLED` again, at the pull request head the ledger shows
 *   now. Each such run moves the ledger (its generation and heartbeat), so the
 *   failed re-arm rule (`failed-rearms.ts`), which waits for the ledger to
 *   move, never holds it; this rule keys on the pull request's head instead.
 *   A drive whose final CI wait found no fresh exact-head witness stops this
 *   way, and waiting again on the same head finds none either;
 * - a takeover of a silent driver a launch record of this host started that
 *   ended on a non-zero exit (`drive.ts --take-over` refusing to take over
 *   blind, a crash) without moving the ledger: the facts it acted on
 *   (`factsOf`) are the facts the ledger still shows. A takeover answered by
 *   a second driver's refusal (`DRIVER_REFUSAL_EXITS`), the usage error
 *   (`settleUsageRefusals`) or an account's or the forge's wall is answered
 *   elsewhere and breaks the count.
 *
 * The count is the run of such ends at the tail of the pull request's drive
 * records. While it is under its cap, the next launch waits a backoff from
 * the last end, doubling with each; at its cap the drive is a person's
 * (`needs-person`), notified once for the head or the ledger facts, and not
 * launched again until they change or a person's rearm request launches it.
 * A record of any other kind, a new head or moved ledger facts ends the run,
 * so the count starts again and normal recovery proceeds.
 */
import {
  DRIVE_EXIT,
  DRIVER_REFUSAL_EXITS,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import { driveHold, drivesOf, factsOf } from "./actions/drive-hold.ts";
import { prHeadOf } from "./failed-rearms.ts";
import type { ReadRecord } from "./launches.ts";
import { sameFacts } from "./recovery-facts.ts";
import type { DrivenPr } from "./types.ts";
import { FAILED_TAKEOVERS, NOT_SETTLED_REARMS } from "./repeated-end-caps.ts";

export { FAILED_TAKEOVERS, NOT_SETTLED_REARMS } from "./repeated-end-caps.ts";
/** The wait after the first `NOT_SETTLED` re-arm on a head, doubling with each. */
export const NOT_SETTLED_BACKOFF_MS = 15 * 60_000;
/** The wait after the first failed takeover on the same facts, doubling with each. */
export const TAKEOVER_BACKOFF_MS = 10 * 60_000;

/** The drive records at the tail of `mine` that `counts`, newest first. */
function trailing(
  mine: readonly ReadRecord[],
  counts: (r: ReadRecord) => boolean,
): ReadRecord[] {
  const run: ReadRecord[] = [];
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i];
    if (r === undefined || !counts(r)) break;
    run.push(r);
  }
  return run;
}

function endCode(r: ReadRecord): number | null {
  return r.state.kind === "ended" ? r.state.exit.code : null;
}

/** When the backoff after `count` such ends, the last at `last`, ends. */
function notBefore(last: ReadRecord, count: number, baseMs: number): string {
  const at = last.state.kind === "ended" ? parseMs(last.state.exit.at) : NaN;
  const from = Number.isFinite(at) ? at : 0;
  return isoFromMs(from + baseMs * 2 ** Math.max(count - 1, 0));
}

/** A re-arm that stopped `NOT_SETTLED` at `head`. */
function notSettledAt(head: string): (r: ReadRecord) => boolean {
  return (r) =>
    r.record.action === "rearm" &&
    endCode(r) === DRIVE_EXIT.NOT_SETTLED &&
    prHeadOf(r.record.heads) === head;
}

/** A takeover that failed on `facts` without a cause answered elsewhere. */
function takeoverFailedOn(facts: string): (r: ReadRecord) => boolean {
  return (r) => {
    const code = endCode(r);
    return (
      r.record.action === "takeover" &&
      r.state.kind === "ended" &&
      code !== null &&
      code !== 0 &&
      code !== DRIVE_EXIT.UNSUPPORTED_CLI &&
      code !== DRIVE_EXIT.QUOTA_PARKED &&
      code !== DRIVE_EXIT.FORGE_RATE_LIMITED &&
      r.state.exit.startup !== "quota" &&
      r.state.exit.wallUnrecorded !== true &&
      !DRIVER_REFUSAL_EXITS.has(code) &&
      sameFacts(r.record.facts, facts)
    );
  };
}

function ids(run: readonly ReadRecord[]): string {
  return run
    .map((r) => r.record.id)
    .reverse()
    .join(", ");
}

/**
 * Each `NOT_SETTLED` ledger whose latest re-arms stopped `NOT_SETTLED` again
 * at the head it shows now: waiting out its backoff under the cap, a
 * person's at it.
 */
export function settleRepeatedNotSettled(
  drives: readonly DrivenPr[],
  own: readonly ReadRecord[],
): DrivenPr[] {
  return drives.map((pr) => {
    const head = pr.evidence.headSha;
    if (
      pr.class !== "re-armable" ||
      pr.evidence.exit !== DRIVE_EXIT.NOT_SETTLED ||
      pr.evidence.rearm === true ||
      typeof head !== "string" ||
      head === ""
    )
      return pr;
    const run = trailing(drivesOf(pr, own), notSettledAt(head));
    const last = run[0];
    if (last === undefined) return pr;
    const short = head.slice(0, 12);
    const evidence = {
      ...pr.evidence,
      notSettledRearms: run.length,
      notSettledRecord: last.record.id,
    };
    if (run.length >= NOT_SETTLED_REARMS)
      return {
        ...pr,
        class: "needs-person",
        why: `stopped ${DRIVE_EXIT.NOT_SETTLED} (not judgeable yet) again after ${run.length} re-arms in a row at the same pull request head ${short} (launch records ${ids(run)}): waiting on this head has not settled it (a required check that completed SKIPPED or a cancelled check leaves no fresh exact-head witness), so it is not re-armed again until its head changes; a person re-runs the required checks on this head and re-arms it, or pushes a commit (see the drive's handoff)`,
        evidence,
      };
    const until = notBefore(last, run.length, NOT_SETTLED_BACKOFF_MS);
    return {
      ...pr,
      why: `${pr.why}; re-arm ${run.length} of ${NOT_SETTLED_REARMS} at head ${short} also stopped ${DRIVE_EXIT.NOT_SETTLED}, so the next waits until ${until}`,
      evidence,
      retryAfter: until,
    };
  });
}

/**
 * Each silent drive whose driver a launch record of this host started, and
 * whose latest takeovers failed on the ledger facts it shows now: waiting
 * out its backoff under the cap, a person's at it.
 */
export function settleFailedTakeovers(
  drives: readonly DrivenPr[],
  own: readonly ReadRecord[],
): DrivenPr[] {
  return drives.map((pr) => {
    if (
      pr.class !== "silent" ||
      pr.evidence.settled === true ||
      pr.evidence.rearm === true ||
      driveHold(pr, [...own]).kind !== "takeover"
    )
      return pr;
    const run = trailing(drivesOf(pr, own), takeoverFailedOn(factsOf(pr)));
    const last = run[0];
    if (last === undefined) return pr;
    const exit = endCode(last);
    const evidence = {
      ...pr.evidence,
      failedTakeovers: run.length,
      failedTakeover: last.record.id,
      takeoverExit: exit,
    };
    if (run.length >= FAILED_TAKEOVERS)
      return {
        ...pr,
        class: "needs-person",
        why: `${pr.why}; ${run.length} takeovers in a row (launch records ${ids(run)}) ended without moving its ledger, the last ${String(exit)}: it is not taken over again until its ledger moves, so a person reads the takeover's output (drive.ts --take-over says why it refused, such as a doctor reading it could not make) and settles the driver`,
        evidence: { ...evidence, driverGone: false, settled: true },
      };
    const until = notBefore(last, run.length, TAKEOVER_BACKOFF_MS);
    return {
      ...pr,
      why: `${pr.why}; takeover ${run.length} of ${FAILED_TAKEOVERS} on these ledger facts ended ${String(exit)} without moving its ledger, so the next waits until ${until}`,
      evidence,
      retryAfter: until,
    };
  });
}

/** Why a drive whose launches keep ending the same way is not launched yet: its backoff has not ended. `null` once it has, or for any other drive. */
export function retryWaiting(pr: DrivenPr, nowMs: number): string | null {
  if (pr.retryAfter === undefined || pr.evidence.rearm === true) return null;
  const at = parseMs(pr.retryAfter);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  return pr.why;
}
