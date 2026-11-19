/**
 * A drive the tick would act on, held only by a launch nobody can show
 * running: this machine's launch record whose state is unknown, or another
 * host's launch claim with no end. The hold keeps the tick off the drive and
 * nothing ends it by itself, so it is **stranded** once it has outlived
 * `STRANDED_HOLD_MS`, counted from the later of the launch and the drive's
 * stop: a launch that ran for hours before the drive stopped has held the
 * stopped drive only since then.
 *
 * A stranded hold is notified to a person (cause `needs-person`, once, then
 * on `dispatch.renotify_after`) while the plan goes on reporting the drive
 * as held. A pending record is not read here: `stuck-launches.ts` says when
 * one is stuck. The need of a record a person's answer may clear is framed as
 * that decision (`line-station.ts`); any other need says what to settle.
 */
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { ReadClaim } from "../../shared/records/shared.ts";
import {
  holds,
  isDrive,
  type LaunchState,
  type ReadRecord,
} from "./launches.ts";
import { strandedHoldNotice } from "./notices.ts";
import type { Workspace } from "./runtime/port.ts";
import { durationText, joinedTo } from "./stuck-launches.ts";
import type { Action, DrivenPr, LedgerClass } from "./types.ts";

/** How long a launch nobody can show running may hold a drive before a person hears of it: six ticks at the default interval, and far past the seconds a wrapper takes to record its exit. */
export const STRANDED_HOLD_MS = 30 * 60_000;

/** The bound as a person reads it. */
export const STRANDED_HOLD_TEXT = durationText(STRANDED_HOLD_MS);

/** The drives the tick would launch, or tell a person of, were no launch holding them. */
const HELD_UP: ReadonlySet<LedgerClass> = new Set<LedgerClass>([
  "re-armable",
  "stale",
  "stopped-unknown",
  "needs-person",
  "unarmed",
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

/** Why a person's answer may not clear a record of unknown state, which `jig dispatch clear` decides on its own terms; `null` when it may. */
export function clearBlock(
  state: Extract<LaunchState, { kind: "unknown" }>,
): string | null {
  if (state.liveProcess !== undefined)
    return `its supervised process ${state.liveProcess.pid} still runs: stop its session first`;
  if (state.unjudged === true)
    return `whether its processes run could not be judged (${state.reason})`;
  if (state.wallUnrecorded === true)
    return "it keeps its account closed for a wall that was never recorded: check the wall first";
  return null;
}

/** A stranded hold's need, and which sessions the runtime joins to it. */
export interface StrandedHold {
  action: Action;
  joined: (w: Workspace) => boolean;
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

/** The need of a drive that only this machine's launch records of unknown state hold; `null` while any holder is otherwise. */
export function strandedByRecord(
  slug: string,
  pr: DrivenPr,
  launches: readonly ReadRecord[],
  nowMs: number,
): StrandedHold | null {
  const holders = launches
    .filter(
      (r) => isDrive(r.record) && r.record.pr === pr.number && holds(r.state),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
  const read = holders.at(-1);
  if (read === undefined || holders.some((r) => r.state.kind !== "unknown"))
    return null;
  const { record, state } = read;
  if (state.kind !== "unknown") return null;
  const since = strandedSince(pr, record.createdAt, nowMs);
  if (since === null) return null;
  const heldSince = isoFromMs(since);
  const workspace = record.workspace?.path ?? null;
  const blocked = clearBlock(state);
  const clear = `jig dispatch clear ${record.id}`;
  const settle =
    blocked === null
      ? `Look for a session it started${workspace === null ? "" : ` in its workspace (${workspace})`}; once none runs for it, run \`${clear}\`, and the next tick acts on the drive.`
      : `Settle this first: ${blocked}. Then run \`${clear}\`, and the next tick acts on the drive.`;
  return {
    joined: joinedTo(record),
    action: {
      stage: "notify",
      target: `PR #${pr.number}`,
      record: "runtime",
      reason: `launch record ${record.id} holds the drive and whether its process runs is unknown (${state.reason}); it has held it since ${heldSince}, past ${STRANDED_HOLD_TEXT}, and no tick acts on the drive until a person settles it (${clear})`,
      evidence: {
        url: pr.url,
        head: pr.head,
        ...pr.evidence,
        record: record.id,
        stage: record.action,
        account: record.account,
        heldSince,
        ...(blocked === null ? { stuck: state.reason } : { blocked }),
      },
      cause: "needs-person",
      notice: strandedHoldNotice(slug, pr, {
        key: `launch record ${record.id}`,
        holder: `the ${record.action} launch record ${record.id}`,
        why: state.reason,
        heldSince,
        settle,
        acts: [clear],
      }),
      ...(workspace === null ? {} : { workspace }),
    },
  };
}

/** The need of a drive another host's open launch claim holds; `null` inside the bound. */
export function strandedByClaim(
  slug: string,
  pr: DrivenPr,
  claim: ReadClaim,
  nowMs: number,
): StrandedHold | null {
  const says = claim.says.value;
  const since = strandedSince(pr, says.at, nowMs);
  if (since === null) return null;
  const heldSince = isoFromMs(since);
  const host = String(says.host);
  const why = "that host has not written its end";
  return {
    joined: (w) => w.prs.includes(pr.number),
    action: {
      stage: "notify",
      target: `PR #${pr.number}`,
      record: "forge",
      reason: `host ${host}'s launch claim ${claim.id} holds the drive (${why}); it has held it since ${heldSince}, past ${STRANDED_HOLD_TEXT}, and no tick acts on the drive until that host or a person settles it`,
      evidence: {
        url: pr.url,
        head: pr.head,
        ...pr.evidence,
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
        settle: `Check that host: once no session runs for its launch record ${String(says.record)}, settle the record there, and a tick acts on the drive.`,
        acts: [],
      }),
    },
  };
}
