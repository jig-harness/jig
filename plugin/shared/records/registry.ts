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

const DRIVE = "skills/drive-pr/scripts/";
const STATE = `${DRIVE}lib/state/`;
const STATE_DIR = "~/.local/state/jig/drive-pr/<clone>/";
const DISPATCH_DIR = "~/.local/state/jig/dispatch/";
/** The dispatcher's database schema version (`dispatch/lib/state.ts`'s `SCHEMA_VERSION`). */
const DISPATCH_DB = 4;
const RRC = "skills/resolve-review-comments/scripts/";
const REFLECT = "skills/reflect/scripts/";

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

const DRIVE_STATE_DIR: RecordKind[] = [
  driveFile("drive-state", `${STATE}store.ts`, "drive-pr-<PR>.json", "state"),
  driveFile(
    "drive-pr-lease",
    `${STATE}lease-admission.ts`,
    "pr-drive-lease-<PR>-wt-<16 hex>.json",
    "pr-lease",
  ),
  driveFile(
    "drive-tree-lease",
    `${STATE}lease-tree.ts`,
    "drive-tree-lease-wt-<16 hex>.json",
    "tree-lease",
  ),
  driveFile(
    "drive-remote-lock",
    `${STATE}lease-files.ts`,
    "drive-pr-remote-lock-<PR>.lock/",
    "remote-mutation-lock",
  ),
  driveFile(
    "drive-stop-completion",
    `${DRIVE}lib/stop-request.ts`,
    "drive-pr-<PR>.stop-complete.<24 hex>.json",
    "stop-completion",
  ),
  driveFile(
    "drive-log",
    `${DRIVE}lib/driver-log.ts`,
    "drive-pr-<PR>.log",
    "log",
  ),
  driveFile(
    "drive-ready-claim",
    `${STATE}claims.ts`,
    "drive-pr-<PR>.ready-claim",
    "ready-claim",
  ),
  driveFile(
    "drive-held-claim",
    `${STATE}claims.ts`,
    "drive-pr-<PR>.held-claim.<key>.<16 hex>",
    "held-claim",
  ),
  driveFile(
    "drive-arm-output",
    `${STATE}state-file-patterns.ts`,
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
    "drive-orphan-marker",
    `${STATE}orphans.ts`,
    ".drive-pr-<PR>.orphan-warned",
    "orphan-marker",
  ),
  driveFile(
    "drive-reaper-snapshot",
    `${DRIVE}reap-state.ts`,
    ".reap-state-snapshot.json",
    "reaper-snapshot",
  ),
  driveFile(
    "drive-reaper-lock",
    `${DRIVE}reap-state.ts`,
    ".reap-state-delete.lock/",
    "reaper-delete-lock",
  ),
  driveFile(
    "drive-legacy-migration",
    `${STATE}legacy-state.ts`,
    ".migrated-from-legacy",
    "legacy-migration-marker",
  ),
  driveFile(
    "drive-pr-lock",
    `${DRIVE}lib/driver/locks.ts`,
    "pr-drive-<PR>.lock/",
    "driver-pr-lock",
  ),
  driveFile(
    "drive-worktree-lock",
    `${DRIVE}lib/driver/locks.ts`,
    "pr-drive-worktree-<16 hex>.lock/",
    "driver-worktree-lock",
  ),
  driveFile(
    "drive-ledger-driver",
    `${DRIVE}lib/ledger-stop.ts`,
    "ledger-driver-<PR>.json",
  ),
  driveFile(
    "drive-report-memory",
    `${DRIVE}lib/morning-report.ts`,
    "drives-report.json",
  ),
  {
    name: "drive-clone-id",
    medium: "machine",
    owner: `${STATE}clone-key.ts`,
    at: "<git common dir>/drive-pr-clone-id",
    version: 0,
  },
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
  dispatchTable("dispatch-nudge", "dispatch/lib/actions/steer.ts", "nudges"),
  dispatchTable(
    "dispatch-followup-outcome",
    "dispatch/lib/followup-outcomes.ts",
    "followup_outcomes",
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
  {
    name: "dispatch-receipt",
    medium: "machine",
    owner: "dispatch/receipts.ts",
    at: `${DISPATCH_DIR}receipts/<date>/<run id>.json`,
    version: 1,
  },
  {
    name: "dispatch-tick-lock",
    medium: "machine",
    owner: "dispatch/receipts.ts",
    at: `${DISPATCH_DIR}tick.lock, tick-index`,
    version: 0,
  },
  {
    name: "dispatch-wall",
    medium: "machine",
    owner: "dispatch/lib/walls.ts",
    at: `${DISPATCH_DIR}walls/<account>/<ms>-<8 hex>.json`,
    version: 0,
  },
  {
    name: "dispatch-outcome-log",
    medium: "machine",
    owner: "dispatch/lib/log-export.ts",
    at: `${DISPATCH_DIR}log-<year>-<month>.jsonl`,
    version: 0,
  },
  {
    name: "dispatch-workspace-note",
    medium: "machine",
    owner: "dispatch/lib/runtime/orca-comment.ts",
    at: "the session runtime's workspace name and comment: the dispatched mark and each notification's key line",
    version: 0,
  },
];

const MACHINE: RecordKind[] = [
  {
    name: "gc-receipt",
    medium: "machine",
    owner: "gc/receipts.ts",
    at: "~/.local/state/jig/gc/<date>/<run id>.json",
    version: 1,
  },
  {
    name: "gc-admission",
    medium: "machine",
    owner: "shared/gc-lock.ts",
    at: "~/.local/state/jig/gc-locks/<kind>/writer, reader-<pid>-<id>",
    version: 0,
  },
  {
    name: "gc-scratch-owner",
    medium: "machine",
    owner: "shared/scratch-owner.ts",
    at: "<scratch folder>/.jig-scratch-owner.json",
    version: 1,
  },
  {
    name: "gc-machine-entry",
    medium: "machine",
    owner: "gc/install.ts",
    at: "~/.jig/jig.yaml, its gc section",
    version: 0,
  },
  {
    name: "scheduled-job",
    medium: "machine",
    owner: "runtime/scheduler.ts",
    at: "a systemd user timer, a launchd job or a crontab line per component, and its launcher copy under ~/.local/state/jig/<component>/launcher/",
    version: 0,
  },
  {
    name: "path-command",
    medium: "machine",
    owner: "runtime/path-command.ts",
    at: "~/.local/bin/jig, and its launcher copy under ~/.local/state/jig/launcher/",
    version: 0,
  },
  {
    name: "evidence-record",
    medium: "machine",
    owner: "shared/evidence.ts",
    at: "~/.local/state/jig/evidence/<repo>/<tree>/<command>/<run id>.json",
    version: 1,
  },
  {
    name: "verification-fit-log",
    medium: "machine",
    owner: `${DRIVE}verification-fit.ts`,
    at: "~/.local/state/jig/verification-fit.jsonl",
    version: 1,
  },
  {
    name: "trace",
    medium: "machine",
    owner: "shared/trace.ts",
    at: "~/.local/state/jig/traces/<date>/<trace id>.jsonl",
    version: 0,
  },
  {
    name: "orca-card-lock",
    medium: "machine",
    owner: "shared/orca-card-lock.ts",
    at: "~/.local/state/jig/orca-card-locks/orca-card.<hash>.lock",
    version: 0,
  },
  {
    name: "orca-run-tab",
    medium: "machine",
    owner: "shared/orca-tabs.ts",
    at: "~/.local/state/jig/orca-tabs/<handle>.json",
    version: 1,
  },
  {
    name: "orca-board-card",
    medium: "machine",
    owner: "shared/orca-board.ts",
    at: "the session runtime's card for a workspace: its column and comment",
    version: 0,
  },
  {
    name: "gh-cache",
    medium: "machine",
    owner: "shared/gh-cache-storage.ts",
    at: "~/.cache/jig/gh-cache/<hash>.json",
    version: 1,
  },
  {
    name: "process-registry",
    medium: "machine",
    owner: "shared/process-registry.ts",
    at: "<tmp>/jig-processes-<id>/<entry>.json",
    version: 0,
  },
  {
    name: "resource-lock",
    medium: "machine",
    owner: "shared/resource-lock.ts",
    at: "<tmp>/jig-lock.<name>",
    version: 0,
  },
  {
    name: "turn-budget-state",
    medium: "machine",
    owner: "hooks/turn-budget-guard.ts",
    at: "<tmp>/jig-turn-budget/<session>/state.json",
    version: 0,
  },
  {
    name: "reflection-pending",
    medium: "machine",
    owner: `${REFLECT}lib/journal.ts`,
    at: "~/.jig/pending/<repo>-<hash>/<time>-<16 hex>.jsonl",
    version: 1,
  },
  {
    name: "reflection-file-store",
    medium: "machine",
    owner: `${REFLECT}filesystem-store.ts`,
    at: "~/.jig/reflections/<year>-<month>/<time>-<16 hex>.jsonl",
    version: 1,
  },
  {
    name: "reflection-notion-cache",
    medium: "machine",
    owner: `${REFLECT}lib/notion/store.ts`,
    at: "~/.jig/cache/notion/<database>.json",
    version: 0,
  },
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
  {
    name: "drive-mailbox",
    medium: "tree",
    owner: `${STATE}mailbox.ts`,
    at: ".context/drive-mailbox/inbox.jsonl, outbox.jsonl",
    version: 0,
  },
  {
    name: "intent-chain",
    medium: "tree",
    owner: "skills/do-item/scripts/intent-chain.ts",
    at: ".context/intent-chain/<stem>.md, pickups/<hash>.json, pr.<PR>.md",
    markers: ["refocus-arm"],
    version: 0,
  },
  {
    name: "foreground-wait",
    medium: "tree",
    owner: `${DRIVE}foreground-wait.ts`,
    at: ".context/foreground-wait/gen-<n>/",
    version: 0,
  },
  {
    name: "red-team-run",
    medium: "tree",
    owner: "skills/red-team/scripts/lib/plan.ts",
    at: ".context/red-team/<slug>/plan.json and each persona's files",
    version: 0,
  },
  {
    name: "audit-record",
    medium: "tree",
    owner: "skills/audit/scripts/record.ts",
    at: ".config/jig-audit.yaml",
    version: 0,
  },
  {
    name: "driven-tree",
    medium: "tree",
    owner: "shared/driven-tree.ts",
    at: "<git dir>/jig-driven-pr.json",
    version: 0,
  },
  {
    name: "review-round-counter",
    medium: "tree",
    owner: `${RRC}await-round.ts`,
    at: "<git dir>/resolve-review-rounds-<PR>, and .head",
    version: 0,
  },
  {
    name: "reflection-journal",
    medium: "tree",
    owner: `${REFLECT}lib/journal.ts`,
    at: "<git dir>/jig/reflection-journal.jsonl",
    version: 1,
  },
  {
    name: "conflict-snapshot",
    medium: "tree",
    owner: "skills/resolve-conflicts/scripts/lib/snapshot.ts",
    at: "<git dir>/jig/conflicts.json, jig/pending/<kind>-<head>-<incoming>.json",
    version: 1,
  },
  {
    name: "conflict-events",
    medium: "tree",
    owner: "skills/resolve-conflicts/scripts/lib/events.ts",
    at: "<git common dir>/jig/conflict-events.jsonl",
    version: 0,
  },
];

const FORGE: RecordKind[] = [
  {
    name: "drive-ledger",
    medium: "forge",
    owner: `${STATE}ledger-mirror.ts`,
    at: "one comment on the pull request",
    markers: ["drive-pr-ledger", "drive-pr-ledger-data"],
    version: 1,
    key: PR_NUMBER,
  },
  {
    name: "drive-takeover-claim",
    medium: "forge",
    owner: `${STATE}ledger-forge.ts`,
    at: "a comment on the pull request per claim",
    markers: ["drive-pr-takeover-claim", "drive-pr-takeover-claim-data"],
    version: 0,
  },
  {
    name: "dispatch-followup",
    medium: "forge",
    owner: "dispatch/lib/followup-marker.ts",
    at: "a comment on the merged pull request",
    markers: ["jig-dispatch-followup", "jig-dispatch-followup-data"],
    version: 1,
    key: PR_NUMBER,
  },
  {
    name: "drive-merge-ready",
    medium: "forge",
    owner: `${DRIVE}announce-merge-ready.ts`,
    at: "a comment on the pull request, per verified head",
    markers: ["drive-pr-merge-ready"],
    version: 0,
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
  {
    name: "scanner-finding-reply",
    medium: "forge",
    owner: `${RRC.replace("scripts/", "")}SKILL.md`,
    at: "a comment on the pull request answering a scanner's finding, one `scanner-finding: <fingerprint>` marker line per finding, written by the session the skill instructs",
    version: 0,
  },
  {
    name: "ci-hold-label",
    medium: "forge",
    owner: `${DRIVE}ci-hold.ts`,
    at: "the label `ci.hold_label` names, on the pull request",
    version: 0,
  },
  {
    name: "dispatch-state-label",
    medium: "forge",
    owner: "dispatch/lib/actions/labels.ts",
    at: "a state label on the pull request (`jig:driving`, `jig:parked`, …)",
    version: 0,
  },
  {
    name: "ai-review-summary",
    medium: "forge",
    owner: `${DRIVE}lib/overlay.ts`,
    foreign: "the repository's AI reviewer",
    at: "the reviewer's sticky comment, and the reviewed commit marked in it (`review.sticky_marker`, `review.reviewed_sha_marker`)",
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
  {
    name: "tracker-claim",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/claim.ts",
    at: "the item's assignee and its in-progress state",
    version: 0,
  },
  {
    name: "deferred-issue",
    medium: "tracker",
    owner: `${RRC}file-deferred.ts`,
    at: "an issue whose description names the deferred finding",
    version: 0,
  },
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
    name: "reflection-github-store",
    medium: "tracker",
    owner: `${REFLECT}lib/github/store.ts`,
    at: "an issue per change in the reflection repository, and comments holding its events",
    markers: ["jig-reflection-change", "jig-reflection-events"],
    version: 1,
  },
  {
    name: "reflection-escalation",
    medium: "tracker",
    owner: `${REFLECT}lib/escalation.ts`,
    at: "an issue labelled with the finding's class, its owner on one line of its description",
    version: 0,
  },
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
  ...DRIVE_STATE_DIR,
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
