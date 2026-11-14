/**
 * The dispatcher's kinds in the records registry (`registry.ts`): the tables
 * of its state database and the files under its state directory.
 */
import type { RecordKind } from "./registry.ts";

const DISPATCH_DIR = "~/.local/state/jig/dispatch/";
/** The dispatcher's database schema version (`dispatch/lib/state.ts`'s `SCHEMA_VERSION`). */
const DISPATCH_DB = 28;

/** A table of the dispatcher's database. */
function dispatchTable(name: string, owner: string, table: string): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: `${DISPATCH_DIR}state.sqlite`,
    table,
    version: DISPATCH_DB,
  };
}

/** A record the dispatcher keeps on the machine outside its database: where it lives, and the version it carries (`0` for none). */
function dispatchFile(
  name: string,
  owner: string,
  at: string,
  version: number,
): RecordKind {
  return { name, medium: "machine", owner, at, version };
}

export const DISPATCHER: readonly RecordKind[] = [
  dispatchTable("dispatch-launch", "dispatch/lib/launches.ts", "launches"),
  dispatchTable(
    "dispatch-pickup-claim",
    "dispatch/lib/pickup-claim.ts",
    "pickup_claims",
  ),
  dispatchTable(
    "dispatch-thread-sample",
    "dispatch/lib/expectations.ts",
    "thread_samples",
  ),
  dispatchTable(
    "dispatch-waiting-episode",
    "dispatch/lib/session-walls.ts",
    "waiting_episodes",
  ),
  dispatchTable("dispatch-notice", "dispatch/lib/actions/notify.ts", "notices"),
  dispatchTable(
    "dispatch-notices-content",
    "dispatch/lib/actions/notices-content.ts",
    "notices_content",
  ),
  dispatchTable(
    "dispatch-notices-read",
    "dispatch/lib/actions/retire-notices.ts",
    "notices_read",
  ),
  dispatchTable("dispatch-nudge", "dispatch/lib/actions/steer.ts", "nudges"),
  dispatchTable(
    "dispatch-followup-outcome",
    "dispatch/lib/followup-outcomes.ts",
    "followup_outcomes",
  ),
  dispatchTable(
    "dispatch-followup-release",
    "dispatch/lib/followup-releases.ts",
    "followup_releases",
  ),
  dispatchTable("dispatch-idle", "dispatch/lib/idle.ts", "idle"),
  dispatchTable("dispatch-hold", "dispatch/lib/serial-holds.ts", "holds"),
  dispatchTable("dispatch-outcome", "dispatch/lib/log.ts", "log"),
  dispatchTable(
    "dispatch-log-cursor",
    "dispatch/lib/log-export.ts",
    "log_export",
  ),
  dispatchTable(
    "dispatch-tick-line",
    "dispatch/lib/line-store.ts",
    "tick_line",
  ),
  dispatchTable(
    "dispatch-settled-end",
    "dispatch/lib/launches.ts",
    "settled_ends",
  ),
  dispatchTable(
    "dispatch-reflection-finding",
    "dispatch/lib/reflection-findings.ts",
    "reflection_findings",
  ),
  dispatchTable(
    "dispatch-merge-read",
    "dispatch/lib/merge-reads.ts",
    "merge_reads",
  ),
  dispatchTable(
    "dispatch-pickup-read",
    "dispatch/lib/pickup-reads.ts",
    "pickup_reads",
  ),
  dispatchTable(
    "dispatch-load-sample",
    "dispatch/lib/load-samples.ts",
    "load_samples",
  ),
  dispatchTable("dispatch-failure", "dispatch/lib/failures.ts", "failures"),
  dispatchTable(
    "dispatch-station-answer",
    "dispatch/lib/station-answer-store.ts",
    "station_answers",
  ),
  dispatchTable(
    "dispatch-steward-run",
    "dispatch/lib/steward.ts",
    "steward_runs",
  ),
  dispatchTable(
    "dispatch-steward-record",
    "dispatch/lib/steward.ts",
    "steward_records",
  ),
  {
    name: "tracker-budget",
    medium: "machine",
    owner: "shared/tracker-budget.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "tracker_budget",
    version: 1,
  },
  dispatchFile(
    "dispatch-receipt",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}receipts/<date>/<run id>.json`,
    1,
  ),
  dispatchFile(
    "dispatch-tick-lock",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}tick.lock, observe/<16 hex>.lock, tick-index`,
    0,
  ),
  dispatchFile(
    "dispatch-wall",
    "dispatch/lib/walls.ts",
    `${DISPATCH_DIR}walls/<account>/<ms>-<8 hex>.json`,
    0,
  ),
  dispatchFile(
    "dispatch-unwritten-end",
    "dispatch/lib/unwritten-result.ts",
    `${DISPATCH_DIR}unwritten/<record>.json`,
    1,
  ),
  dispatchFile(
    "dispatch-wake",
    "shared/wake.ts",
    `${DISPATCH_DIR}wake/<digest>/pending/<request>, waiter, started, last-run.log`,
    0,
  ),
  dispatchFile(
    "dispatch-probe",
    "dispatch/lib/change-probe.ts",
    `${DISPATCH_DIR}probe/state.json`,
    1,
  ),
  dispatchFile(
    "dispatch-dashboard-install",
    "dispatch/dashboard-install.ts",
    `${DISPATCH_DIR}dashboard/enabled`,
    0,
  ),
  dispatchFile(
    "dispatch-dashboard-access",
    "dispatch/dashboard-reader.ts",
    `${DISPATCH_DIR}dashboard/access.json`,
    0,
  ),
  dispatchFile(
    "dispatch-dashboard-reader-lock",
    "shared/file-lock.ts",
    `${DISPATCH_DIR}dashboard/reader.<digest>.lock`,
    0,
  ),
  dispatchFile(
    "dispatch-outcome-log",
    "dispatch/lib/log-export.ts",
    `${DISPATCH_DIR}log-<year>-<month>.jsonl`,
    0,
  ),
  dispatchFile(
    "dispatch-workspace-note",
    "dispatch/lib/runtime/orca-comment.ts",
    "the session runtime's workspace name and comment: the dispatched mark and each notification's key line",
    0,
  ),
];
