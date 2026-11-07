/**
 * What this machine's launch records say about one driven pull request,
 * read before the plan wants a re-arm or a takeover for it:
 *
 * - a record that holds its stage (pending, alive, unknown) holds the
 *   pull request: nothing else is launched for it;
 * - a record that ended on a refusal `drive.ts` gives a second driver
 *   (`DRIVER_REFUSAL_EXITS` in drive-pr's terminal-state registry), on the
 *   same ledger facts as now, is the stage's answer and is never fought: the
 *   pull request is reported, not launched again. A `QUOTA_PARKED` stop is
 *   the account's wall instead (see walls.ts), which keeps that account out
 *   of admission until its reset;
 * - a `stale` ledger this machine already re-drove for the same change, however
 *   that launch ended, is not launched again: a re-drive is launched once per
 *   change, so a drive that stops the same way again does not start a loop. A
 *   converged one is reported; one that stopped on a conflict is a person's to
 *   settle (`settleConflictStops`);
 * - a pull request with no ledger that its `drive` label asks to arm, which
 *   this machine already armed at the same head commit, is reported, not
 *   armed again: an arm that ended without leaving a ledger would otherwise
 *   be launched at every tick;
 * - a `silent` ledger whose driver this machine's record started (the
 *   driver's run began while the record's wrapper was running, and the record
 *   did not end on a refusal) is a takeover of that record, even while the
 *   record is alive: a wedged driver stays alive by definition, and
 *   `drive.ts --take-over` decides whether it is admitted. A record that
 *   holds its stage and has not yet produced a driver (pending, unknown, or
 *   acting on the ledger facts as they still are) holds the pull request
 *   first, so a lost launch stays visible and a takeover in flight is not
 *   stacked on.
 */
import { noCauseFacts } from "../no-cause-stops.ts";
import { DRIVER_REFUSAL_EXITS } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  holds,
  isDrive,
  type ReadRecord,
  redrivenChanges,
  UNARMED_FACTS,
} from "../launches.ts";
import type { DrivenPr } from "../types.ts";

export type DriveHold =
  | { kind: "none" }
  | { kind: "held"; record: ReadRecord; why: string }
  | { kind: "refused"; record: ReadRecord; why: string }
  | { kind: "redriven"; record: ReadRecord; why: string }
  | { kind: "armed"; record: ReadRecord; why: string }
  | { kind: "takeover"; record: ReadRecord };

/** The ledger facts a launch acts on; a refusal on the same facts is final. */
export function factsOf(pr: DrivenPr): string {
  const e = pr.evidence;
  if (e.noCause === true) return noCauseFacts(pr);
  if (pr.class === "unarmed") return `${UNARMED_FACTS}${String(e.headSha)}`;
  return `generation ${String(e.generation)}, exit ${String(e.exit)}, heartbeat ${String(e.heartbeat)}`;
}

function describe(r: ReadRecord): string {
  const s = r.state;
  const what = `launch record ${r.record.id} (${r.record.action} on ${r.record.account})`;
  if (s.kind === "unknown") return `${what} is unknown: ${s.reason}`;
  if (s.kind === "alive") return `${what} is running, pid ${s.process.pid}`;
  if (s.kind === "pending") {
    const last = r.record.attempts.at(-1);
    return `${what} is pending${last === undefined ? ", its launch not yet answered" : `, its last launch ${last.outcome}: ${last.detail}`}`;
  }
  return what;
}

/** How a record that no longer holds its stage ended, in words. */
function endOf(r: ReadRecord): string {
  const s = r.state;
  if (s.kind === "died") return `died (${s.reason})`;
  if (s.kind !== "ended") return `is ${s.kind}`;
  return `ended ${String(s.exit.code ?? s.exit.signal)}`;
}

function refusalOf(r: ReadRecord): number | null {
  if (r.state.kind !== "ended") return null;
  const code = r.state.exit.code;
  return code !== null && DRIVER_REFUSAL_EXITS.has(code) ? code : null;
}

/**
 * Whether the record started the driver whose run the ledger shows: that run
 * began after the wrapper was claimed, and before it ended when it has.
 */
function startedDriver(r: ReadRecord, started: string | null): boolean {
  const s = r.state;
  // A wrapper that died without an exit has no end to bound its driver's start by.
  if (s.kind !== "alive" && s.kind !== "ended") return false;
  if (s.process === null || refusalOf(r) !== null || started === null)
    return false;
  const claimed = Date.parse(s.process.claimedAt);
  const run = Date.parse(started);
  const end = s.kind === "ended" ? Date.parse(s.exit.at) : Infinity;
  return (
    Number.isFinite(claimed) &&
    Number.isFinite(run) &&
    !Number.isNaN(end) &&
    claimed <= run &&
    run <= end
  );
}

/** The pull request's latest record, when it ended on a second driver's refusal on the ledger facts as they are now. */
function standingRefusal(pr: DrivenPr, mine: ReadRecord[]): DriveHold | null {
  const latest = mine.at(-1);
  const refused = latest === undefined ? null : refusalOf(latest);
  if (
    latest === undefined ||
    refused === null ||
    latest.record.facts !== factsOf(pr)
  )
    return null;
  return {
    kind: "refused",
    record: latest,
    why: `launch record ${latest.record.id} ended ${refused}, drive.ts's refusal, on these same ledger facts; it is not launched again until they change`,
  };
}

export function driveHold(pr: DrivenPr, records: ReadRecord[]): DriveHold {
  const mine = records
    .filter((r) => isDrive(r.record) && r.record.pr === pr.number)
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  if (pr.class === "silent") {
    const inFlight = mine.find(
      (r) =>
        holds(r.state) &&
        (r.state.kind !== "alive" || r.record.facts === factsOf(pr)),
    );
    if (inFlight !== undefined)
      return { kind: "held", record: inFlight, why: describe(inFlight) };
    // An older owner must not be taken over again behind a later refusal.
    const standing = standingRefusal(pr, mine);
    if (standing !== null) return standing;
    const started =
      typeof pr.evidence.started === "string" ? pr.evidence.started : null;
    const owner = mine.findLast((r) => startedDriver(r, started));
    return owner === undefined
      ? { kind: "none" }
      : { kind: "takeover", record: owner };
  }
  const holding = mine.find((r) => holds(r.state));
  if (holding !== undefined)
    return { kind: "held", record: holding, why: describe(holding) };
  if (pr.class === "unarmed") return armed(pr, mine) ?? { kind: "none" };
  return standingRefusal(pr, mine) ?? redriven(pr, mine) ?? { kind: "none" };
}

/** Whether the launch acts on a pull request with no ledger, which its `drive` label asked to arm. */
export function armsUnarmed(facts: string | null | undefined): boolean {
  return facts?.startsWith(UNARMED_FACTS) ?? false;
}

/**
 * The record that already armed a pull request with no ledger at its head
 * commit, if any: the arm ended without leaving a ledger (a refusal, a
 * crash), so it is not launched again until the head moves, and a person
 * reads why from that record.
 */
function armed(pr: DrivenPr, mine: ReadRecord[]): DriveHold | null {
  const facts = factsOf(pr);
  const earlier = mine.findLast((r) => r.record.facts === facts);
  if (earlier === undefined) return null;
  return {
    kind: "armed",
    record: earlier,
    why: `launch record ${earlier.record.id} armed it at this head and ${endOf(earlier)} without a drive ledger; it is not armed again until its head moves`,
  };
}

/** The record that already re-drove a stale ledger for the change it shows now, if any. */
function redriven(pr: DrivenPr, mine: ReadRecord[]): DriveHold | null {
  const stale = pr.class === "stale" ? pr.stale : undefined;
  if (stale === undefined) return null;
  const earlier = mine.findLast(
    (r) =>
      r.record.redrive != null &&
      redrivenChanges(r.record.redrive).includes(stale.change),
  );
  return earlier === undefined
    ? null
    : {
        kind: "redriven",
        record: earlier,
        why: `stale (${stale.cause}), and launch record ${earlier.record.id} already re-drove it for this change; it is not launched again until its head or its mergeability changes`,
      };
}

/**
 * Each drive as the plan and the labels read it once this machine's launch
 * records are read beside it: a ledger that stopped `PR_CONFLICTING`, this
 * machine already having re-driven the change it shows now, is a person's to
 * settle, however
 * that re-drive ended (a stop of its own, or a refusal or a crash that left the
 * older stop standing), since nothing else will drive it until its head or its
 * base moves. While a record still holds it, or another driver's refusal
 * stands, it reads as the ledger alone says.
 */
export function settleConflictStops(
  drives: readonly DrivenPr[],
  records: ReadRecord[],
): DrivenPr[] {
  return drives.map((pr) => {
    if (pr.stale?.conflictStop !== true) return pr;
    const hold = driveHold(pr, records);
    if (hold.kind !== "redriven") return pr;
    const { stale: _settled, ...rest } = pr;
    return {
      ...rest,
      class: "needs-person",
      why: `stopped 9, and launch record ${hold.record.record.id} already re-drove it for this change and ${endOf(hold.record)}: only a person settles it until its head or its base moves (see the drive's handoff)`,
    };
  });
}
