/**
 * Pending launch records that no tick will launch again. A pending record
 * (no wrapper claimed it, no exit) holds its stage and its account's slot,
 * and its launch is replayed under its own record and key while that can
 * still settle it (`replayable` in `actions/launch.ts`, `retryMarked` in
 * `actions/followup.ts`). A pending record is **stuck** once nothing will:
 *
 * | Record | Why it is stuck |
 * | --- | --- |
 * | both of its launches answered as not started or not answered at all, one at least unanswered | an unanswered launch may have started a session, so a third is never called |
 * | a follow-up whose replay the fresh read could not prove safe (`noReplay`) | its marker is gone, no longer the earliest or answered, or a session is joined to its pull request |
 * | no workspace | there is nowhere to launch it |
 * | its last launch was answered as started longer ago than the machine file's `unclaimed_after`, and no wrapper claimed it | the wrapper claims the record before anything else, seconds after its terminal starts, so a claim that late is not coming |
 *
 * A stuck record is notified to a person (cause `needs-person`, once, then
 * on `dispatch.renotify_after`, through the notifications' suppression
 * records), and the dashboard shows it as needing a person. It holds its
 * stage and slot until a person clears it (`jig dispatch clear`). A launch
 * answered as started is not stuck within `unclaimed_after`, since a wrapper
 * slow to start still claims it, nor while the runtime cannot say which
 * sessions run. Past it, a session the runtime joins to the record's target
 * is named in why the record is stuck: that wrapper may have started its
 * stage without claiming the record, so the record still holds its slot,
 * and a person checks that session before clearing it.
 */
import type { LaunchRecord, ReadRecord } from "./launches.ts";
import { pullUrl } from "./forge.ts";
import { holding, liveAgents } from "./holding.ts";
import { targetOf } from "./launches.ts";
import { stuckNotice } from "./notices.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import type { Action } from "./types.ts";
import { parseMs } from "../../shared/time.ts";

/** A pending record's launch is retried once, under its own key. */
const MAX_ATTEMPTS = 2;

/** Whether a pending record's launch can still be replayed: it has a workspace, its last attempt got no answer, an attempt remains, and no replay was found unsafe. */
export function retryable(record: LaunchRecord): boolean {
  return (
    record.noReplay == null &&
    record.workspace !== null &&
    record.attempts.at(-1)?.outcome !== "sent" &&
    record.attempts.length < MAX_ATTEMPTS
  );
}

/** What tells a launch answered as started from one whose wrapper is slow: the tick's clock, `unclaimed_after` and the sessions the runtime reports. */
export interface UnclaimedClock {
  nowMs: number;
  unclaimedAfterMs: number;
  sessions: SessionsReport;
}

/** `ms` as the machine file writes a duration. */
function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

/** Whether a workspace is the record's own, or joined to its pull request or item. */
export function joinedTo(record: LaunchRecord): (w: Workspace) => boolean {
  return (w) =>
    (record.workspace !== null &&
      (w.id === record.workspace.id || w.path === record.workspace.path)) ||
    (record.pr !== null && w.prs.includes(record.pr)) ||
    (record.item !== null && w.items.includes(record.item));
}

/** Why a launch answered as started at `at` is stuck unclaimed; `null` while its wrapper may still claim it or the runtime cannot say what runs. */
function unclaimedWhy(
  record: LaunchRecord,
  at: string,
  clock: UnclaimedClock,
): string | null {
  const sentMs = parseMs(at);
  if (!Number.isFinite(sentMs)) return null;
  if (clock.nowMs - sentMs < clock.unclaimedAfterMs) return null;
  const held = holding(clock.sessions, joinedTo(record));
  if (held.kind === "unknown") return null;
  const late = `the runtime answered its launch as started at ${at} and no wrapper claimed it within unclaimed_after (${durationText(clock.unclaimedAfterMs)})`;
  return held.kind === "running"
    ? `${late}, but a session is joined to its target (${liveAgents(held.workspaces)}): that wrapper may have started its stage without claiming the record, so the record keeps its slot`
    : `${late}, and no session is joined to its target`;
}

/**
 * Why a record is stuck pending, in a clause; `null` when it is not.
 * Without `clock`, a launch answered as started is never stuck.
 */
export function stuckWhy(
  read: Pick<ReadRecord, "record" | "state">,
  clock?: UnclaimedClock,
): string | null {
  const { record, state } = read;
  if (state.kind !== "pending" || retryable(record)) return null;
  if (record.noReplay != null) return record.noReplay;
  const last = record.attempts.at(-1);
  if (last?.outcome === "sent")
    return clock === undefined ? null : unclaimedWhy(record, last.at, clock);
  if (record.workspace === null) return "it names no workspace to launch into";
  const outcomes = record.attempts.map((a) => a.outcome).join(", ");
  return `none of its ${record.attempts.length} launches was answered as started (${outcomes}) and no wrapper claimed it, so whether a session started cannot be told`;
}

/** The notification of one stuck record, with `why` it is stuck. */
export function stuckAction(
  slug: string,
  read: ReadRecord,
  why: string,
): Action {
  const { record } = read;
  const target = targetOf(record);
  const workspace = record.workspace?.path ?? null;
  return {
    stage: "notify",
    target,
    record: "runtime",
    reason: `launch record ${record.id} is pending and no tick launches it again: ${why}; it holds its stage and a slot of ${record.account} until a person clears it (jig dispatch clear ${record.id})`,
    evidence: {
      record: record.id,
      stage: record.action,
      account: record.account,
      stuck: why,
      ...(record.marker === null ? {} : { marker: record.marker }),
    },
    cause: "needs-person",
    notice: stuckNotice(slug, {
      target,
      action: record.action,
      record: record.id,
      account: record.account,
      workspace,
      marker: record.marker,
      url: record.pr === null ? null : pullUrl(slug, record.pr),
      why,
    }),
    ...(workspace === null ? {} : { workspace }),
  };
}

/** The notifications of `slug`'s stuck records; without `clock`, none for a launch answered as started. */
export function planStuck(
  slug: string,
  launches: ReadRecord[],
  clock?: UnclaimedClock,
): Action[] {
  const actions: Action[] = [];
  for (const read of launches) {
    if (read.record.repo !== slug) continue;
    const why = stuckWhy(read, clock);
    if (why !== null) actions.push(stuckAction(slug, read, why));
  }
  return actions;
}
