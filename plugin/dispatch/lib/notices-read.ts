/**
 * The `notices_read` event: once per tick of the `notify` stage, on the host
 * that owns the repository, one event row in the outcome log (`log.ts`)
 * with the read state of the repository's notices destination (the
 * workspace on `dispatch.notices_branch`, else the notices workspace on
 * `NOTICES_BRANCH`) as the tick's session listing found it, before the
 * tick writes any notice of its own.
 *
 * The stage's retirement measure reads these rows
 * (design/dispatched-sessions.md § Notices): a need counts as answered
 * before its notice was read when its answer lands before the first tick
 * that recorded the destination read after its notice was written. The one
 * shared destination's read state is compared with each notice's write
 * time, never with a mark per need.
 *
 * The row's `read` is `true` for a destination the runtime reports read,
 * `false` for one it reports unread, and `null` when no destination is open,
 * the runtime reports no mark, or the listing did not read; its reason says
 * which. The dashboard's log leaves these rows out unless its class filter
 * names them (`dashboard-log.ts`), since one lands every tick.
 */
import { attempt } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import { stateRoot } from "../receipts.ts";
import { type EventRow, writeRow } from "./log.ts";
import { NOTICES_BRANCH, type SessionsReport } from "./runtime/port.ts";

/** The event's name, and the bucket its rows count under (`event: notices_read`). */
export const NOTICES_READ = "notices_read";

/** The read state and why, from the tick's listing of the repository's workspaces. */
function readState(
  sessions: SessionsReport,
  branch: string,
): { read: boolean | null; reason: string } {
  if (!sessions.ok)
    return {
      read: null,
      reason: `the session runtime's listing did not read, so the notices workspace's read state is not known: ${sessions.reason}`,
    };
  const found = sessions.workspaces.find((w) => w.branch === branch);
  if (found === undefined)
    return {
      read: null,
      reason: `no workspace on ${branch}, the notices destination, is open`,
    };
  if (found.unread === null)
    return {
      read: null,
      reason: `the session runtime reports no read mark for the notices workspace on ${branch} (${found.path})`,
    };
  return {
    read: !found.unread,
    reason: `the notices workspace on ${branch} (${found.path}) is ${found.unread ? "unread" : "read"}`,
  };
}

/** One tick's `notices_read` row for `repo`; `branch` is `dispatch.notices_branch`, `null` for the repository's notices workspace. */
export function noticesReadRow(
  repo: string,
  sessions: SessionsReport,
  branch: string | null,
  at: string,
): EventRow {
  const state = readState(sessions, branch ?? NOTICES_BRANCH);
  return {
    kind: "event",
    key: `${NOTICES_READ} ${repo} ${at}`,
    at,
    repo,
    stage: "notify",
    target: "",
    event: NOTICES_READ,
    account: null,
    class: null,
    reason: state.reason,
    read: state.read,
  };
}

/**
 * Write one tick's `notices_read` row for `repo`; true when this call wrote
 * it. A write that fails is said on the error output and stops nothing: the
 * notices still go.
 */
export function logNoticesRead(
  repo: string,
  sessions: SessionsReport,
  branch: string | null,
  at = currentIso(),
  root = stateRoot(),
): boolean {
  const written = attempt("unwritten", "the outcome log", () =>
    writeRow(noticesReadRow(repo, sessions, branch, at), root),
  );
  if (written.ok) return written.value;
  console.error(
    `jig dispatch: ${repo}'s notices_read event is not in the outcome log: ${written.failure.reason}`,
  );
  return false;
}
