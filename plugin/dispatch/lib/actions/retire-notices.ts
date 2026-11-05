/**
 * `--apply` for the repository's notices workspace once the tick's
 * notifications are sent: the workspace exists to carry a message, so the
 * tick removes it once that job is done, and the next message that needs
 * it opens it again.
 *
 * - **Read.** A workspace not unread is removed once it has stayed read for
 *   `dispatch.notices_linger` (`0s`: at the first tick that finds it read).
 *   The runtime does not say when it was read, so the first tick that finds
 *   it read records the time (the state database's `notices_read` table);
 *   the record goes when it is unread again or removed.
 * - **Unread, every cause gone.** An unread workspace is removed when none
 *   of the causes it carries still stands: on a tick that read every record
 *   whole, no cause this tick names is in its comment, and no suppression
 *   record that names it remains (`prune` keeps a record whose target the
 *   tick could not place or read).
 * - **Never a person's.** A workspace written this tick, or holding a
 *   comment that is not the dispatcher's, an agent, a terminal the runtime
 *   cannot read, changes git reports or a commit no remote branch holds, is
 *   left in place, the last four reported as refused.
 *
 * The suppression records stay as they are: removing the workspace never
 * sends a cause again.
 */
import type { Database } from "bun:sqlite";
import { run } from "../../../shared/proc.ts";
import { carries } from "../notices.ts";
import type { Workspace } from "../runtime/port.ts";
import { stateDb } from "../state.ts";
import type { RepoReport, RetireOutcome } from "../types.ts";
import { type ApplyState, outOfTime } from "./launch.ts";

/** Seconds each git call that proves the checkout holds nothing of a person's may take. */
const GIT_TIMEOUT_SEC = 30;

/** What the retire step reads from the tick's notifications. */
export interface RetireInput {
  /** The repository's slug, which keys its `notices_read` record. */
  repo: string;
  /** The repository's notices workspace as the tick listed it; `null` when none is open. */
  workspace: Workspace | null;
  /** Whether the dispatcher may write its comment (`takesComment`). */
  takesComment: boolean;
  /** The workspaces this tick wrote or opened. */
  written: ReadonlySet<string>;
  /** The keys of every cause this tick names. */
  causes: readonly string[];
  /** The suppression records left after `prune`, by the workspace each went to. */
  records: ReadonlyArray<{ key: string; workspace: string; lasting: boolean }>;
  lingerMs: number;
  nowMs: number;
  root: string;
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

function clearRead(db: Database, repo: string): void {
  db.query("DELETE FROM notices_read WHERE repo = ?").run(repo);
}

/** When the tick first found `path` read; recorded now when no record names it. */
function readSince(db: Database, repo: string, path: string, now: number) {
  const row = db
    .query("SELECT workspace, since FROM notices_read WHERE repo = ?")
    .get(repo) as { workspace: string; since: number } | null;
  if (row !== null && row.workspace === path) return row.since;
  db.query(
    `INSERT INTO notices_read (repo, workspace, since) VALUES (?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET workspace = excluded.workspace, since = excluded.since`,
  ).run(repo, path, now);
  return now;
}

/** Why the workspace holds something of a person's; `null` when it holds only the dispatcher's. */
function personal(w: Workspace, takesComment: boolean): string | null {
  if (!takesComment) return "its comment is not the dispatcher's";
  if (w.agents.length > 0) return "an agent runs in it";
  if (w.unverifiableTerminals > 0)
    return "it has a terminal the runtime cannot read";
  return null;
}

/** The cause the unread workspace still carries; `null` when every one is gone. */
function standing(report: RepoReport, input: RetireInput): string | null {
  const w = input.workspace as Workspace;
  if (!report.records.every((r) => r.ok))
    return "the tick did not read every record whole";
  const named = input.causes.find((k) => carries(w.comment, k));
  if (named !== undefined) return `${named} still stands`;
  const kept = input.records.find((r) => r.workspace === w.path && !r.lasting);
  return kept === undefined ? null : `${kept.key} still has its record`;
}

/** Why git shows something of a person's in the checkout; `null` when it shows none. */
async function gitHolds(path: string): Promise<string | null> {
  const git = (args: string[]) =>
    run(["git", "-C", path, "-c", "core.fsmonitor=false", ...args], {
      timeoutSec: GIT_TIMEOUT_SEC,
    });
  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) return `git status failed there (exit ${status.code})`;
  if (status.stdout.trim() !== "") return "git reports changes in it";
  const held = await git(["branch", "-r", "--contains", "HEAD"]);
  if (held.code !== 0)
    return `git could not tell whether a remote branch holds its commit (exit ${held.code})`;
  return held.stdout.trim() === "" ? "its commit is on no remote branch" : null;
}

/** Why the workspace stays, or the reason it is removed. */
function decide(
  report: RepoReport,
  input: RetireInput,
  db: Database,
): { keep: string } | { remove: string } {
  const w = input.workspace as Workspace;
  if (w.unread) {
    clearRead(db, input.repo);
    const why = standing(report, input);
    return why === null
      ? { remove: "unread, and every cause it carried is gone" }
      : { keep: `unread: ${why}` };
  }
  const since = readSince(db, input.repo, w.path, input.nowMs);
  const read = input.nowMs - since;
  return read >= input.lingerMs
    ? { remove: `read, and kept ${minutes(read)} since` }
    : {
        keep: `read; removed once read for ${minutes(input.lingerMs)} (dispatch.notices_linger), ${minutes(input.lingerMs - read)} from now`,
      };
}

/** `--apply` for the repository's notices workspace; nothing when it has none. */
export async function retireNotices(
  state: ApplyState,
  report: RepoReport,
  input: RetireInput,
): Promise<void> {
  const db = stateDb(input.root);
  const repo = input.repo;
  const w = input.workspace;
  if (w === null) {
    clearRead(db, repo);
    return;
  }
  const outcome = (
    o: RetireOutcome["outcome"],
    detail: string,
  ): RetireOutcome => ({ workspace: w.path, outcome: o, detail });
  if (input.written.has(w.path)) {
    clearRead(db, repo);
    report.noticesWorkspace = outcome("kept", "written this tick");
    return;
  }
  const mine = personal(w, input.takesComment);
  if (mine !== null) {
    report.noticesWorkspace = outcome("refused", `${mine}; left for a person`);
    return;
  }
  const decided = decide(report, input, db);
  if ("keep" in decided) {
    report.noticesWorkspace = outcome("kept", decided.keep);
    return;
  }
  const late = outOfTime(state);
  if (late !== null) {
    report.noticesWorkspace = outcome("kept", late);
    return;
  }
  const held = await gitHolds(w.path);
  if (held !== null) {
    report.noticesWorkspace = outcome("refused", `${held}; left for a person`);
    return;
  }
  const receipt = await state.runtime
    .retire(
      { id: w.id, path: w.path },
      { comment: w.comment, unread: w.unread },
    )
    .catch((error: unknown) => ({
      ok: false,
      lost: true,
      detail: error instanceof Error ? error.message : String(error),
    }));
  if (receipt.ok) clearRead(db, repo);
  report.noticesWorkspace = receipt.ok
    ? outcome("retired", `${decided.remove}: ${receipt.detail}`)
    : outcome(receipt.lost === true ? "lost" : "kept", receipt.detail);
}
