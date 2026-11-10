/**
 * The records registry: every kind of record the plugin keeps, one entry
 * each. A record is what one process writes for another, or for a later run
 * of itself, to read back. For each kind the registry declares its medium,
 * the plugin file that writes it, where it lives (a path, or the hidden
 * markers it carries on the forge or tracker, or the drive state family or
 * the table it is), and the schema version writers write now.
 *
 * The registry declares and `scripts/check-records-registry.ts` derives: the
 * gate fails a hidden-marker literal, a drive state-file family or a SQLite
 * table under `plugin/` that no entry here holds, and an entry whose marker,
 * family, table or owner the code no longer has. The view a person reads,
 * with each record's format and what keeps two writers apart, is
 * [plugin/RECORDS.md](../../RECORDS.md).
 *
 * A kind another design adds registers when it is built: the dispatch
 * board's `board_seen` table is a `table` entry beside the dispatcher's, and
 * its "became ready" and "left ready" rows are rows of the outcome log
 * (`dispatch-outcome`), not kinds of their own.
 */
import type { Medium } from "./writer.ts";

export interface RecordKind {
  /** Its registered name: what a record's envelope says as its `kind`. */
  readonly name: string;
  readonly medium: Medium;
  /**
   * The plugin file, from `plugin/`, that writes it; for a kind written
   * outside Jig (`foreign`), the one that reads it.
   */
  readonly owner: string;
  /** Who writes a kind Jig only reads: another tool, or a person. */
  readonly foreign?: string;
  /**
   * Where it lives: a path on the machine (from `~`, or `<tmp>`), in the
   * working tree (from its root, or `<git dir>`), or the place on the forge
   * or the tracker.
   */
  readonly at: string;
  /** The hidden markers it carries, each as written after `<!--`. */
  readonly markers?: readonly string[];
  /** The family the drive's state library tags its file patterns with. */
  readonly stateFamily?: string;
  /** The SQLite table it is. */
  readonly table?: string;
  /** The schema version writers write now; `0` when it carries none. */
  readonly version: number;
  /** For a kind whose records carry the envelope, its key's whole shape. */
  readonly key?: RegExp;
}

/** A hidden-marker literal in the plugin that is not a record, and why. */
export interface NotARecord {
  readonly marker: string;
  readonly why: string;
}

/** A pull request's number: the key of a record about one pull request. */
const PR_NUMBER = /^[1-9]\d*$/;

/**
 * The keys of the claims on the forge (`forge-claims.ts`): what is claimed on
 * the pull request the claim's comment is on.
 */
const TAKEOVER_KEY = /^takeover:\d+$/;
/** A follow-up claim's key; one written before claims (version 1) is its pull request's number. */
const FOLLOWUP_KEY = /^(?:followup|[1-9]\d*)$/;
/** A launch claim's key: a launch of the drive of the pull request it is on; its generation is the attempt. */
const LAUNCH_KEY = /^drive$/;
const MERGE_READY_KEY = /^merge-ready:[0-9a-f]{7,64}$/;
/** A sent answer's key: the parked item it answers, on the pull request its comment is on. */
const ANSWER_KEY = /^answer:\S+$/;

/** A worktree's key in the Orca guard record: the SHA-256 of its path as Orca reports it. */
const ORCA_GUARD_KEY = /^[0-9a-f]{64}$/;
const ORCA_GUARD_HEARTBEAT_KEY = /^heartbeat$/;
const ORCA_GUARD_DIR = "~/.local/state/jig/orca-guard/";
const ORCA_PLUGIN = "Jig's plugin for Orca";

const DRIVE = "skills/drive-pr/scripts/";
const STATE = `${DRIVE}lib/state/`;
const STATE_DIR = "~/.local/state/jig/drive-pr/<clone>/";
const DRIVE_DB_FILE = "~/.local/state/jig/drive-pr/state.sqlite";
const DISPATCH_DIR = "~/.local/state/jig/dispatch/";
/** The dispatcher's database schema version (`dispatch/lib/state.ts`'s `SCHEMA_VERSION`). */
const DISPATCH_DB = 18;
/** The drive's database schema version (`skills/drive-pr/scripts/lib/state/db.ts`'s `DRIVE_DB_VERSION`). */
const DRIVE_DB = 5;
const RRC = "skills/resolve-review-comments/scripts/";
const REFLECT = "skills/reflect/scripts/";

/** A kind that is only its medium, name, owner, place and version. */
function plain(
  medium: Medium,
  name: string,
  owner: string,
  at: string,
  version: number,
): RecordKind {
  return { name, medium, owner, at, version };
}

/** A file in a drive's per-clone state directory, of one state family. */
function driveFile(
  name: string,
  owner: string,
  file: string,
  stateFamily?: string,
): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: `${STATE_DIR}${file}`,
    ...(stateFamily === undefined ? {} : { stateFamily }),
    version: 0,
  };
}

/** A table of the drive's database. */
function driveTable(name: string, owner: string, table: string): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: DRIVE_DB_FILE,
    table,
    version: DRIVE_DB,
  };
}

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

const DRIVE_STATE: RecordKind[] = [
  driveTable("drive-state", `${STATE}store.ts`, "drive_state"),
  driveTable("drive-lock", `${STATE}lock.ts`, "locks"),
  driveTable("drive-pr-lease", `${STATE}lease-admission.ts`, "leases"),
  driveTable("drive-tree-lease", `${STATE}lease-tree.ts`, "tree_leases"),
  driveTable("drive-claim", `${STATE}claims.ts`, "claims"),
  // No longer written: kept in the schema so an earlier release still opens
  // the database. A stop is now a mailbox directive (`drive-mailbox`).
  driveTable("drive-stop", `${STATE}db.ts`, "stops"),
  driveTable(
    "drive-ledger-driver",
    `${DRIVE}lib/ledger-stop.ts`,
    "driver_records",
  ),
  {
    ...driveFile(
      "drive-observation",
      `${DRIVE}lib/driver-observation.ts`,
      "drive-observation-<PR>-<acquisition hash>.json",
      "driver-observation",
    ),
    version: 1,
  },
  driveTable("drive-state-import", `${STATE}import.ts`, "imports"),
  driveTable("drive-counter", `${STATE}db.ts`, "counters"),
  driveTable(
    "drive-cancelled-ci",
    `${DRIVE}lib/cancelled-recovery-state.ts`,
    "cancelled_ci",
  ),
  driveTable(
    "review-round-counter",
    `${STATE}review-rounds.ts`,
    "review_rounds",
  ),
  driveFile(
    "drive-log",
    `${DRIVE}lib/driver-log.ts`,
    "drive-pr-<PR>.log",
    "log",
  ),
  driveFile(
    "drive-arm-output",
    `${STATE}artifacts.ts`,
    "drive-arm-<PR>.out",
    "arm-output",
  ),
  driveFile(
    "drive-pass-handoff",
    `${STATE}pass-handoff.ts`,
    "drive-pr-<PR>.answers.json, drive-pr-<PR>.notice.md",
    "pass-handoff",
  ),
  driveFile(
    "drive-report-memory",
    `${DRIVE}lib/morning-report.ts`,
    "drives-report.json",
  ),
  plain(
    "machine",
    "drive-clone-id",
    `${STATE}clone-key.ts`,
    "<git common dir>/drive-pr-clone-id",
    0,
  ),
];

const DISPATCHER: RecordKind[] = [
  dispatchTable("dispatch-launch", "dispatch/lib/launches.ts", "launches"),
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
    "dispatch-load-sample",
    "dispatch/lib/load-samples.ts",
    "load_samples",
  ),
  dispatchTable("dispatch-failure", "dispatch/lib/failures.ts", "failures"),
  plain(
    "machine",
    "dispatch-receipt",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}receipts/<date>/<run id>.json`,
    1,
  ),
  plain(
    "machine",
    "dispatch-tick-lock",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}tick.lock, observe/<16 hex>.lock, tick-index`,
    0,
  ),
  plain(
    "machine",
    "dispatch-wall",
    "dispatch/lib/walls.ts",
    `${DISPATCH_DIR}walls/<account>/<ms>-<8 hex>.json`,
    0,
  ),
  plain(
    "machine",
    "dispatch-wake",
    "shared/wake.ts",
    `${DISPATCH_DIR}wake/<digest>/pending/<request>, waiter, started, last-run.log`,
    0,
  ),
  plain(
    "machine",
    "dispatch-probe",
    "dispatch/lib/change-probe.ts",
    `${DISPATCH_DIR}probe/state.json`,
    1,
  ),
  plain(
    "machine",
    "dispatch-outcome-log",
    "dispatch/lib/log-export.ts",
    `${DISPATCH_DIR}log-<year>-<month>.jsonl`,
    0,
  ),
  plain(
    "machine",
    "dispatch-workspace-note",
    "dispatch/lib/runtime/orca-comment.ts",
    "the session runtime's workspace name and comment: the dispatched mark and each notification's key line",
    0,
  ),
];

const MACHINE: RecordKind[] = [
  {
    name: "db-meta",
    medium: "machine",
    owner: "shared/records/db.ts",
    at: "every component's database (the drive's and the dispatcher's): its instance id and minimum reader",
    table: "db_meta",
    version: 1,
  },
  plain(
    "machine",
    "gc-receipt",
    "gc/receipts.ts",
    "~/.local/state/jig/gc/<date>/<run id>.json",
    1,
  ),
  plain(
    "machine",
    "gc-admission",
    "shared/gc-lock.ts",
    "~/.local/state/jig/gc-locks/<kind>/writer, reader-<pid>-<id>, install/writer-takeover.<hash>.lock",
    0,
  ),
  plain(
    "machine",
    "gc-scratch-owner",
    "shared/scratch-owner.ts",
    "<scratch folder>/.jig-scratch-owner.json",
    1,
  ),
  plain(
    "machine",
    "gc-machine-entry",
    "gc/install.ts",
    "~/.jig/jig.yaml, its gc section",
    0,
  ),
  plain(
    "machine",
    "upgrade-setting",
    "runtime/upgrade-record.ts",
    "~/.jig/jig.yaml, its upgrade section",
    0,
  ),
  plain(
    "machine",
    "upgrade-stamp",
    "runtime/upgrade-stamp.ts",
    "~/.local/state/jig/upgrade/last.json",
    1,
  ),
  plain(
    "machine",
    "upgrade-claim-lock",
    "runtime/scheduled-upgrade.ts",
    "~/.local/state/jig/upgrade/claim.<hash>.lock",
    0,
  ),
  plain(
    "machine",
    "scheduled-job",
    "runtime/scheduler.ts",
    "a systemd user timer, a launchd job or a crontab line per component job, and its launcher copy under ~/.local/state/jig/<component>/launcher/ (the dispatcher's change probe: ~/.local/state/jig/dispatch/probe/launcher/)",
    0,
  ),
  plain(
    "machine",
    "path-command",
    "runtime/path-command.ts",
    "~/.local/bin/jig, and its launcher copy under ~/.local/state/jig/launcher/",
    0,
  ),
  plain(
    "machine",
    "evidence-record",
    "shared/evidence.ts",
    "~/.local/state/jig/evidence/<repo>/<tree>/<command>/<run id>.json",
    1,
  ),
  plain(
    "machine",
    "host-id",
    "shared/liveness.ts",
    "~/.local/state/jig/host-id",
    0,
  ),
  plain(
    "machine",
    "verification-fit-log",
    `${DRIVE}verification-fit.ts`,
    "~/.local/state/jig/verification-fit.jsonl",
    1,
  ),
  plain(
    "machine",
    "trace",
    "shared/trace.ts",
    "~/.local/state/jig/traces/<date>/<trace id>.jsonl",
    0,
  ),
  plain(
    "machine",
    "orca-card-lock",
    "shared/orca-card-lock.ts",
    "~/.local/state/jig/orca-card-locks/orca-card.<hash>.lock",
    0,
  ),
  plain(
    "machine",
    "orca-run-tab",
    "shared/orca-tabs.ts",
    "~/.local/state/jig/orca-tabs/<handle>.json",
    1,
  ),
  {
    name: "orca-guard-admission",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    at: `${ORCA_GUARD_DIR}admissions/<key>.json`,
    version: 1,
    key: ORCA_GUARD_KEY,
  },
  {
    name: "orca-guard-launch",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    foreign: ORCA_PLUGIN,
    at: `${ORCA_GUARD_DIR}launches/<key>.json`,
    version: 1,
    key: ORCA_GUARD_KEY,
  },
  {
    name: "orca-guard-heartbeat",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    foreign: ORCA_PLUGIN,
    at: `${ORCA_GUARD_DIR}heartbeat.json`,
    version: 1,
    key: ORCA_GUARD_HEARTBEAT_KEY,
  },
  plain(
    "machine",
    "orca-board-card",
    "shared/orca-board.ts",
    "the session runtime's card for a workspace: its column and comment",
    0,
  ),
  plain(
    "machine",
    "gh-cache",
    "shared/gh-cache-storage.ts",
    "~/.cache/jig/gh-cache/<hash>.json",
    1,
  ),
  {
    name: "process-registry",
    medium: "machine",
    owner: "shared/process-registry.ts",
    at: "<tmp>/jig-processes-<id>/<entry>.json; a driver's on Windows, ~/.local/state/jig/drive-pr/<clone>/pr-drive-<PR>.processes.<token>/",
    stateFamily: "process-registry",
    version: 0,
  },
  plain(
    "machine",
    "resource-lock",
    "shared/resource-lock.ts",
    "<tmp>/jig-lock.<name>, its slots <tmp>/jig-lock.<name>-slot-<n>, and <tmp>/jig-lock.<name>.admission and .exclusive",
    0,
  ),
  plain(
    "machine",
    "turn-budget-state",
    "hooks/turn-budget-guard.ts",
    "<tmp>/jig-turn-budget/<session>/state.json",
    0,
  ),
  plain(
    "machine",
    "reflection-pending",
    `${REFLECT}lib/journal.ts`,
    "~/.jig/pending/<repo>-<hash>/<time>-<16 hex>.jsonl",
    1,
  ),
  plain(
    "machine",
    "reflection-file-store",
    `${REFLECT}filesystem-store.ts`,
    "~/.jig/reflections/<year>-<month>/<time>-<16 hex>.jsonl",
    1,
  ),
  plain(
    "machine",
    "reflection-notion-cache",
    `${REFLECT}lib/notion/store.ts`,
    "~/.jig/cache/notion/<database>.json",
    0,
  ),
  {
    name: "fleet-health-snapshot",
    medium: "machine",
    owner: `${DRIVE}lib/fleet-health-advisory.ts`,
    foreign: "the repository's own dashboard",
    at: "<fleet_health.snapshot_dir>/fleet-health.json",
    version: 1,
  },
];

const TREE: RecordKind[] = [
  {
    name: "drive-handoff",
    medium: "tree",
    owner: `${STATE}handoff.ts`,
    at: ".context/pr-drive-<PR>.md",
    markers: [
      "machine block",
      "narrative below this line is agent-authored and preserved",
    ],
    version: 0,
  },
  plain(
    "tree",
    "drive-mailbox",
    `${STATE}mailbox.ts`,
    ".context/drive-mailbox/inbox.jsonl, outbox.jsonl",
    0,
  ),
  {
    name: "intent-chain",
    medium: "tree",
    owner: "skills/do-item/scripts/intent-chain.ts",
    at: ".context/intent-chain/<stem>.md, pickups/<hash>.json, pr.<PR>.md",
    markers: ["refocus-arm"],
    version: 0,
  },
  plain(
    "tree",
    "foreground-wait",
    `${DRIVE}foreground-wait.ts`,
    ".context/foreground-wait/gen-<n>/",
    0,
  ),
  plain(
    "tree",
    "red-team-run",
    "skills/red-team/scripts/lib/plan.ts",
    ".context/red-team/<slug>/plan.json and each persona's files",
    0,
  ),
  plain(
    "tree",
    "audit-record",
    "skills/audit/scripts/record.ts",
    ".config/jig-audit.yaml",
    0,
  ),
  plain(
    "tree",
    "facet-move-record",
    "skills/file-issue/scripts/lib/move-record.ts",
    "the file `check-fields.ts move --record` names (`.context/facet-move/record.json` in file-issue's procedure)",
    1,
  ),
  plain(
    "tree",
    "driven-tree",
    "shared/driven-tree.ts",
    "<git dir>/jig-driven-pr.json",
    0,
  ),
  plain(
    "tree",
    "reflection-journal",
    `${REFLECT}lib/journal.ts`,
    "<git dir>/jig/reflection-journal.jsonl",
    1,
  ),
  plain(
    "tree",
    "conflict-snapshot",
    "skills/resolve-conflicts/scripts/lib/snapshot.ts",
    "<git dir>/jig/conflicts.json, jig/pending/<kind>-<head>-<incoming>.json",
    1,
  ),
  plain(
    "tree",
    "conflict-events",
    "skills/resolve-conflicts/scripts/lib/events.ts",
    "<git common dir>/jig/conflict-events.jsonl",
    0,
  ),
];

const FORGE: RecordKind[] = [
  {
    name: "drive-ledger",
    medium: "forge",
    owner: `${STATE}ledger-mirror.ts`,
    at: "one comment on the pull request",
    markers: ["drive-pr-ledger", "drive-pr-ledger-data"],
    version: 2,
    key: PR_NUMBER,
  },
  {
    name: "drive-takeover-claim",
    medium: "forge",
    owner: `${STATE}ledger-forge.ts`,
    at: "a claim comment on the pull request per takeover (`forge-claims.ts`)",
    markers: ["drive-pr-takeover-claim", "drive-pr-takeover-claim-data"],
    version: 1,
    key: TAKEOVER_KEY,
  },
  {
    name: "dispatch-followup",
    medium: "forge",
    owner: "shared/records/launch-claims.ts",
    at: "a claim comment on the merged pull request (`forge-claims.ts`), a shared record (`shared.ts`)",
    markers: ["jig-dispatch-followup", "jig-dispatch-followup-data"],
    version: 2,
    key: FOLLOWUP_KEY,
  },
  {
    name: "dispatch-launch-claim",
    medium: "forge",
    owner: "shared/records/launch-claims.ts",
    at: "a claim comment on the pull request per drive launch (`forge-claims.ts`), a shared record (`shared.ts`)",
    markers: ["jig-dispatch-launch-claim", "jig-dispatch-launch-claim-data"],
    version: 1,
    key: LAUNCH_KEY,
  },
  {
    name: "drive-merge-ready",
    medium: "forge",
    owner: `${DRIVE}lib/announce.ts`,
    at: "a claim comment on the pull request per verified head (`forge-claims.ts`)",
    markers: ["drive-pr-merge-ready", "drive-pr-merge-ready-data"],
    version: 1,
    key: MERGE_READY_KEY,
  },
  {
    name: "summary-answer",
    medium: "forge",
    owner: `${DRIVE}answer-summary-finding.ts`,
    at: "a comment on the pull request answering a summary finding",
    markers: ["drive-pr-addressed"],
    version: 0,
  },
  {
    name: "thread-reply",
    medium: "forge",
    owner: `${RRC}reply-to-thread.ts`,
    at: "a reply on a review thread, its last line a marker where it has one (and the repository's own `reply.marker` on a declined finding)",
    markers: [
      "triage-thread:leave-open",
      "reply-to-thread:no-outcome",
      "reply-to-thread:provisional",
    ],
    version: 0,
  },
  {
    name: "deferred-section",
    medium: "forge",
    owner: `${RRC}lib/pr-body.ts`,
    at: "the pull request body, between its two markers, one entry per deferred finding",
    markers: ["jig-deferred", "deferred-entry"],
    version: 0,
  },
  plain(
    "forge",
    "scanner-finding-reply",
    `${RRC.replace("scripts/", "")}SKILL.md`,
    "a comment on the pull request answering a scanner's finding, one `scanner-finding: <fingerprint>` marker line per finding, written by the session the skill instructs",
    0,
  ),
  plain(
    "forge",
    "ci-hold-label",
    `${DRIVE}ci-hold.ts`,
    "the label `ci.hold_label` names, on the pull request",
    0,
  ),
  {
    name: "drive-answer",
    medium: "forge",
    owner: `${DRIVE}lib/answer-comment.ts`,
    at: "a comment on the pull request answering one parked item, written by `jig send`",
    markers: ["jig-send-answer"],
    version: 1,
    key: ANSWER_KEY,
  },
  plain(
    "forge",
    "dispatch-command-label",
    "dispatch/lib/requests.ts",
    "a command label on the pull request (`jig:drive`, `jig:hold`), which a person writes by hand or with `jig send`",
    0,
  ),
  plain(
    "forge",
    "dispatch-state-label",
    "dispatch/lib/actions/labels.ts",
    "a state label on the pull request (`jig:driving`, `jig:parked`, …)",
    0,
  ),
  {
    name: "ai-review-summary",
    medium: "forge",
    owner: `${DRIVE}lib/overlay.ts`,
    foreign: "the repository's AI reviewer",
    at: "the reviewer's sticky comment, and the reviewed commit and any skip notice marked in it (`review.sticky_marker`, `review.reviewed_sha_marker`, `review.skip_notice_marker`)",
    markers: ["ai-code-review"],
    version: 0,
  },
  {
    name: "ai-review-round",
    medium: "forge",
    owner: `${DRIVE}summary-findings.ts`,
    foreign: "the repository's AI reviewer",
    at: "a marker in the reviewer's comments naming its round, and its backlog",
    markers: ["ai-review-round", "ai-review-backlog"],
    version: 0,
  },
  {
    name: "coderabbit-comment",
    medium: "forge",
    owner: `${DRIVE}lib/bot-confirmation.ts`,
    foreign: "CodeRabbit",
    at: "the markers in CodeRabbit's comments",
    markers: [
      "coderabbit-ai-generated:v1",
      "coderabbit-skip-review-comment-follow-up",
    ],
    version: 0,
  },
];

const TRACKER: RecordKind[] = [
  plain(
    "tracker",
    "tracker-claim",
    "skills/do-item/scripts/lib/claim.ts",
    "the item's assignee and its in-progress state",
    0,
  ),
  plain(
    "tracker",
    "dispatch-pickup-assignment",
    "dispatch/lib/requests.ts",
    "the item assigned to the factory identity in a dispatch state, which a person writes by hand or with `jig send`",
    0,
  ),
  plain(
    "tracker",
    "deferred-issue",
    `${RRC}file-deferred.ts`,
    "an issue whose description names the deferred finding",
    0,
  ),
  {
    name: "deferred-batch",
    medium: "tracker",
    owner: `${RRC}defer-batch.ts`,
    at: "the first line of a batch issue's description",
    markers: ["defer-batch-key"],
    version: 0,
  },
  {
    name: "tracker-related",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/tracker/github/tracker.ts",
    at: "a comment on a GitHub issue relating it to another",
    markers: ["jig:related"],
    version: 0,
  },
  {
    name: "issue-fields-sweep",
    medium: "tracker",
    owner: "skills/file-issue/scripts/lib/sweep.ts",
    at: "a comment on an issue the weekly sweep moved back to triage, naming what it lacks",
    markers: ["jig:issue-fields"],
    version: 0,
  },
  {
    name: "reflection-github-store",
    medium: "tracker",
    owner: `${REFLECT}lib/github/store.ts`,
    at: "an issue per change in the reflection repository, and comments holding its events",
    markers: ["jig-reflection-change", "jig-reflection-events"],
    version: 1,
  },
  plain(
    "tracker",
    "reflection-escalation",
    `${REFLECT}lib/escalation.ts`,
    "an issue labelled with the finding's class, its owner on one line of its description",
    0,
  ),
  {
    name: "fleet-health-suspicion",
    medium: "tracker",
    owner: `${DRIVE}fleet-health.ts`,
    at: "a comment on an epic",
    markers: ["fleet-health"],
    version: 0,
  },
  {
    name: "epic-acceptance-verdict",
    medium: "tracker",
    owner: `${DRIVE}lib/fleet-health-sources.ts`,
    foreign: "a person accepting an epic",
    at: "a line in a comment on an epic",
    markers: ["epic-acceptance-verdict"],
    version: 0,
  },
];

/** Every kind of record the plugin keeps, on every medium. */
export const RECORD_KINDS: readonly RecordKind[] = [
  ...DRIVE_STATE,
  ...DISPATCHER,
  ...MACHINE,
  ...TREE,
  ...FORGE,
  ...TRACKER,
];

/** The hidden-marker literals in the plugin that are not records. */
export const NOT_RECORDS: readonly NotARecord[] = [
  {
    marker: "deferral-ok",
    why: "a waiver a person writes in a document, which the docs skill's deferral check reads",
  },
  {
    marker: "Generated from",
    why: "the banner the change-areas skill writes at the top of a file it generates",
  },
  {
    marker: "AUTO-GENERATED by generate-index.ts",
    why: "the banner the docs skill writes at the top of an index it generates",
  },
];

const BY_NAME = new Map(RECORD_KINDS.map((kind) => [kind.name, kind]));

/** The registered kind of that name. */
export function recordKind(name: string): RecordKind | undefined {
  return BY_NAME.get(name);
}
