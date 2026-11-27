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
 * For `NOT_SETTLED` the machine file sets the first backoff and the cap
 * (`not_settled`, `not-settled-config.ts`), and the wait ends early when
 * the tick observes what the stop waited for: a review of the head
 * submitted after the last end (`not-settled-reviews.ts`, read only for a
 * drive that waits), or mergeability the forge has settled after a stop on
 * `MERGEABILITY_UNKNOWN`. The run still counts on, so a drive that keeps
 * stopping on one head reaches its cap all the same. The reasons name the
 * states the stops reported (`HEAD_LAG`, `AWAITING_REVIEWER` and the rest
 * of exit `4`'s family), read from each launch's recorded probe, else from
 * the ledger.
 * A record of any other kind, a launch a person's rearm request made, a new
 * head or moved ledger facts ends the run, so the count starts again and
 * normal recovery proceeds. A takeover killed by a signal counts as failed.
 */
import { readProbeStop } from "../../skills/drive-pr/scripts/lib/status/probe-stop.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import { driveHold, drivesOf, factsOf } from "./actions/drive-hold.ts";
import { prHeadOf } from "./failed-rearms.ts";
import type { ReadRecord } from "./launches.ts";
import {
  NOT_SETTLED_DEFAULTS,
  type NotSettledSettings,
} from "./not-settled-config.ts";
import { sameFacts } from "./recovery-facts.ts";
import type { DrivenPr } from "./types.ts";
import { FAILED_TAKEOVERS, failedTakeoverExit } from "./repeated-end-caps.ts";

export { FAILED_TAKEOVERS, NOT_SETTLED_REARMS } from "./repeated-end-caps.ts";
/** The wait after the first failed takeover on the same facts, doubling with each. */
const TAKEOVER_BACKOFF_MS = 10 * 60_000;

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

/** When `last` ended. An end time that does not read is not an ended backoff: its launch time, else now. */
function endedMs(last: ReadRecord): number {
  const ended = last.state.kind === "ended" ? parseMs(last.state.exit.at) : NaN;
  const created = parseMs(last.record.createdAt);
  return Number.isFinite(ended)
    ? ended
    : Number.isFinite(created)
      ? created
      : currentMs();
}

/** When the backoff after `count` such ends, the last at `last`, ends. */
function notBefore(last: ReadRecord, count: number, baseMs: number): string {
  return isoFromMs(endedMs(last) + baseMs * 2 ** Math.max(count - 1, 0));
}

/** Whether a person's rearm request launched it: such a launch starts the count again. */
function fromRequest(r: ReadRecord): boolean {
  return r.record.rearmRequestId != null;
}

/** The head a head that did not read stands for: unread heads count as one head, so the cap still bounds them. */
const UNREAD_HEAD = "";

/** A re-arm that stopped `NOT_SETTLED` at `head` (`UNREAD_HEAD` when neither it nor the launch read one). */
function notSettledAt(head: string): (r: ReadRecord) => boolean {
  return (r) =>
    r.record.action === "rearm" &&
    !fromRequest(r) &&
    endCode(r) === DRIVE_EXIT.NOT_SETTLED &&
    (prHeadOf(r.record.heads) ?? UNREAD_HEAD) === head;
}

/** A takeover that failed on `facts` without a cause answered elsewhere. */
function takeoverFailedOn(facts: string): (r: ReadRecord) => boolean {
  return (r) =>
    r.record.action === "takeover" &&
    r.state.kind === "ended" &&
    failedTakeoverExit(r.state.exit.code, r.state.exit.signal) &&
    !fromRequest(r) &&
    !endedOnWall(r) &&
    sameFacts(r.record.facts, facts);
}

/** Whether the launch ended on the account's wall, as its wrapper recorded it apart from the exit. */
function endedOnWall(r: ReadRecord): boolean {
  return (
    r.state.kind === "ended" &&
    (r.state.exit.startup === "quota" || r.state.exit.wallUnrecorded === true)
  );
}

function ids(run: readonly ReadRecord[]): string {
  return run
    .map((r) => r.record.id)
    .reverse()
    .join(", ");
}

/** The head a `NOT_SETTLED` ledger shows now, and the re-arms at the tail of its drive records that stopped `NOT_SETTLED` there, newest first; `null` for any other drive, one with no such re-arm, and a person's rearm request. */
function notSettledRun(
  pr: DrivenPr,
  own: readonly ReadRecord[],
): { head: string; run: ReadRecord[] } | null {
  if (
    pr.class !== "re-armable" ||
    pr.evidence.exit !== DRIVE_EXIT.NOT_SETTLED ||
    pr.evidence.rearm === true
  )
    return null;
  const listed = pr.evidence.headSha;
  const head = typeof listed === "string" ? listed : UNREAD_HEAD;
  const run = trailing(drivesOf(pr, own), notSettledAt(head));
  return run.length === 0 ? null : { head, run };
}

/** Whether a `NOT_SETTLED` drive is under its cap and inside its backoff at `nowMs`: the only drives whose head's reviews the tick reads. */
export function notSettledWaiting(
  pr: DrivenPr,
  own: readonly ReadRecord[],
  settings: NotSettledSettings,
  nowMs: number,
): boolean {
  const found = notSettledRun(pr, own);
  const last = found?.run[0];
  if (found == null || last === undefined || found.head === UNREAD_HEAD)
    return false;
  const count = found.run.length;
  return (
    count < settings.notifyAfter &&
    parseMs(notBefore(last, count, settings.backoffMs)) > nowMs
  );
}

/** The `NOT_SETTLED` state a stop's launch recorded from its status probe; `null` when it recorded none. */
function recordedState(r: ReadRecord): string | null {
  const context = r.state.kind === "ended" ? r.state.exit.context : undefined;
  const probe = readProbeStop(context ?? "");
  return probe?.code === DRIVE_EXIT.NOT_SETTLED ? probe.state : null;
}

/** The states the run's stops reported, oldest first, each once: each launch's recorded probe, else the ledger's. */
function reportedStates(pr: DrivenPr, run: readonly ReadRecord[]): string[] {
  const states = new Set<string>();
  for (const r of [...run].reverse()) {
    const state = recordedState(r);
    if (state !== null) states.add(state);
  }
  const ledger = pr.evidence.probeState;
  if (states.size === 0 && typeof ledger === "string") states.add(ledger);
  return [...states];
}

const SETTLED_MERGEABILITY: ReadonlySet<unknown> = new Set([
  "MERGEABLE",
  "CONFLICTING",
]);

/** What the tick observed since `last` ended that its stop waited for; `null` for nothing. */
function changeSince(pr: DrivenPr, last: ReadRecord): string | null {
  const reviewed = pr.evidence.headReviewedAt;
  if (typeof reviewed === "string" && parseMs(reviewed) > endedMs(last))
    return `a review of that head was submitted at ${reviewed}`;
  const state = recordedState(last) ?? pr.evidence.probeState;
  const mergeable = pr.evidence.mergeable;
  if (state === "MERGEABILITY_UNKNOWN" && SETTLED_MERGEABILITY.has(mergeable))
    return `the forge has since settled its mergeability (${String(mergeable)})`;
  return null;
}

/**
 * Each `NOT_SETTLED` ledger whose latest re-arms stopped `NOT_SETTLED` again
 * at the head it shows now: waiting out its backoff under the cap unless the
 * tick observed what it waited for, a person's at the cap.
 */
export function settleRepeatedNotSettled(
  drives: readonly DrivenPr[],
  own: readonly ReadRecord[],
  settings: NotSettledSettings = NOT_SETTLED_DEFAULTS,
): DrivenPr[] {
  return drives.map((pr) => {
    const found = notSettledRun(pr, own);
    const last = found?.run[0];
    if (found == null || last === undefined) return pr;
    const { head, run } = found;
    const cap = settings.notifyAfter;
    const short = head === UNREAD_HEAD ? "(unread)" : head.slice(0, 12);
    const states = reportedStates(pr, run);
    const reporting =
      states.length === 0 ? "" : `, reporting ${states.join(", ")}`;
    const evidence = {
      ...pr.evidence,
      notSettledRearms: run.length,
      notSettledRecord: last.record.id,
      notSettledState: states.length === 0 ? null : states.join(", "),
    };
    if (run.length >= cap)
      return {
        ...pr,
        class: "needs-person",
        why: `stopped ${DRIVE_EXIT.NOT_SETTLED} (not judgeable yet) again after ${run.length} re-arms in a row at the same pull request head ${short}${reporting} (launch records ${ids(run)}): waiting on this head has not settled it (for example, a reviewer that does not review this head, or a required check that completed skipped or was cancelled and left no fresh exact-head witness), so it is not re-armed again until its head changes; a person settles what the drive kept waiting for and re-arms it, or pushes a commit (see the drive's handoff)`,
        evidence,
      };
    const stopped = `re-arm ${run.length} of ${cap} at head ${short} also stopped ${DRIVE_EXIT.NOT_SETTLED}${reporting}`;
    const change = changeSince(pr, last);
    if (change !== null)
      return {
        ...pr,
        why: `${pr.why}; ${stopped}, and ${change}, so it is re-armed now`,
        evidence,
      };
    const until = notBefore(last, run.length, settings.backoffMs);
    const unread =
      typeof pr.evidence.headReviewsUnread === "string"
        ? ` (its head's reviews did not read this tick: ${pr.evidence.headReviewsUnread})`
        : "";
    const signals =
      (recordedState(last) ?? pr.evidence.probeState) === "MERGEABILITY_UNKNOWN"
        ? "a review of that head, a new head or settled mergeability"
        : "a review of that head or a new head";
    return {
      ...pr,
      why: `${pr.why}; ${stopped}, so it is not re-armed until ${until}, or until ${signals} arrives${unread}`,
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
    const exit =
      last.state.kind === "ended"
        ? (last.state.exit.code ?? last.state.exit.signal)
        : null;
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
