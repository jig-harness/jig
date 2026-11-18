/**
 * A stopped drive the tick would launch again, held only by a launch nobody
 * can show running: this machine's launch record whose state is unknown, or
 * another host's launch claim with no end. The hold keeps every launch off
 * the drive and nothing ends it by itself, so it is **stranded** once it has
 * outlived `STRANDED_HOLD_MS`, counted from the later of the launch and the
 * drive's stop: a launch that ran for hours before the drive stopped has
 * held the stopped drive only since then.
 *
 * A stranded hold is notified to a person (cause `needs-person`, once, then
 * on `dispatch.renotify_after`) while the plan goes on reporting the drive
 * as held. A pending record is not read here: `stuck-launches.ts` says when
 * one is stuck. Nothing is raised while the runtime cannot say which
 * sessions run; a session joined to the target is carried in the evidence,
 * for the person who checks it before settling the hold.
 */
import { parseMs, isoFromMs } from "../../shared/time.ts";
import type { ReadClaim } from "../../shared/records/shared.ts";
import { holding, liveAgents } from "./holding.ts";
import { holds, isDrive, type ReadRecord } from "./launches.ts";
import { strandedHoldNotice } from "./notices.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import { durationText, joinedTo } from "./stuck-launches.ts";
import type { Action, DrivenPr, LedgerClass } from "./types.ts";

/** How long a launch nobody can show running may hold a stopped drive before a person hears of it: six ticks at the default interval, and far past the seconds a wrapper takes to record its exit. */
export const STRANDED_HOLD_MS = 30 * 60_000;

/** The bound as a person reads it. */
export const STRANDED_HOLD_TEXT = durationText(STRANDED_HOLD_MS);

/** The stopped ledgers the tick would launch from, which a hold therefore keeps waiting. */
const HELD_UP: ReadonlySet<LedgerClass> = new Set<LedgerClass>([
  "re-armable",
  "stale",
  "stopped-unknown",
]);

/** Whether a launch holding a drive of this class is what keeps it from going on. */
export function heldUpByLaunch(cls: LedgerClass): boolean {
  return HELD_UP.has(cls);
}

/** Since when a launch from `heldFrom` has held a drive that stopped at `stoppedAt`; `NaN` when neither time reads. */
export function heldStopSinceMs(heldFrom: string, stoppedAt: string): number {
  const times = [parseMs(heldFrom), parseMs(stoppedAt)].filter(Number.isFinite);
  return times.length === 0 ? Number.NaN : Math.max(...times);
}

/** What the plan's clock and the runtime say. */
export interface HoldClock {
  nowMs: number;
  sessions: SessionsReport;
}

/** The moment the hold began, once past the bound; `null` inside it or when no time reads. */
function strandedSince(
  pr: DrivenPr,
  heldFrom: string,
  nowMs: number,
): number | null {
  if (!heldUpByLaunch(pr.class)) return null;
  const since = heldStopSinceMs(heldFrom, String(pr.evidence.heartbeat ?? ""));
  return Number.isFinite(since) && nowMs - since >= STRANDED_HOLD_MS
    ? since
    : null;
}

/** The evidence of running sessions joined to the target, `{}` when none; `null` when the runtime cannot say. */
function sessionEvidence(
  sessions: SessionsReport,
  joined: (w: Workspace) => boolean,
): { runningSessions?: string } | null {
  const held = holding(sessions, joined);
  if (held.kind === "unknown") return null;
  return held.kind === "running"
    ? { runningSessions: liveAgents(held.workspaces) }
    : {};
}

/** The need of a stopped drive that only this machine's launch records of unknown state hold; none while any holder is otherwise. */
export function strandedByRecord(
  slug: string,
  pr: DrivenPr,
  launches: readonly ReadRecord[],
  clock: HoldClock,
): Action[] {
  const holders = launches
    .filter(
      (r) => isDrive(r.record) && r.record.pr === pr.number && holds(r.state),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  const read = holders.at(-1);
  if (read === undefined || holders.some((r) => r.state.kind !== "unknown"))
    return [];
  const { record, state } = read;
  if (state.kind !== "unknown") return [];
  const since = strandedSince(pr, record.createdAt, clock.nowMs);
  if (since === null) return [];
  const sessions = sessionEvidence(clock.sessions, joinedTo(record));
  if (sessions === null) return [];
  const heldSince = isoFromMs(since);
  const target = `PR #${pr.number}`;
  const workspace = record.workspace?.path ?? null;
  return [
    {
      stage: "notify",
      target,
      record: "runtime",
      reason: `launch record ${record.id} holds the stopped drive and whether its process runs is unknown (${state.reason}); it has held it since ${heldSince}, past ${STRANDED_HOLD_TEXT}, and no tick launches the drive until a person settles it (jig dispatch clear ${record.id})`,
      evidence: {
        url: pr.url,
        head: pr.head,
        ...pr.evidence,
        ...sessions,
        record: record.id,
        stage: record.action,
        account: record.account,
        stuck: state.reason,
        heldSince,
      },
      cause: "needs-person",
      notice: strandedHoldNotice(slug, pr, {
        key: `launch record ${record.id}`,
        holder: `the ${record.action} launch record ${record.id}`,
        why: state.reason,
        heldSince,
        settle: `Look for a session it started${workspace === null ? "" : ` in its workspace (${workspace})`}; once none runs for it, run \`jig dispatch clear ${record.id}\`, and the next tick re-arms the drive.`,
        acts: [`jig dispatch clear ${record.id}`],
      }),
      ...(workspace === null ? {} : { workspace }),
    },
  ];
}

/** The need of a stopped drive another host's open launch claim holds. */
export function strandedByClaim(
  slug: string,
  pr: DrivenPr,
  claim: ReadClaim,
  clock: HoldClock,
): Action[] {
  const says = claim.says.value;
  const since = strandedSince(pr, says.at, clock.nowMs);
  if (since === null) return [];
  const sessions = sessionEvidence(clock.sessions, (w) =>
    w.prs.includes(pr.number),
  );
  if (sessions === null) return [];
  const heldSince = isoFromMs(since);
  const host = String(says.host);
  const why = "that host has not written its end";
  return [
    {
      stage: "notify",
      target: `PR #${pr.number}`,
      record: "forge",
      reason: `host ${host}'s launch claim ${claim.id} holds the stopped drive (${why}); it has held it since ${heldSince}, past ${STRANDED_HOLD_TEXT}, and no tick launches the drive until that host or a person settles it`,
      evidence: {
        url: pr.url,
        head: pr.head,
        ...pr.evidence,
        ...sessions,
        heldClaim: String(claim.id),
        host,
        stage: says.action,
        heldSince,
      },
      cause: "needs-person",
      notice: strandedHoldNotice(slug, pr, {
        key: `launch claim ${claim.id} of host ${host}`,
        holder: `host ${host}'s ${says.action} launch claim ${claim.id}`,
        why,
        heldSince,
        settle: `Check that host: once no session runs for its launch record ${String(says.record)}, settle the record there, and a tick re-arms the drive.`,
        acts: [],
      }),
    },
  ];
}
