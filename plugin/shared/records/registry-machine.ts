/**
 * The records registry's kinds on the machine (`registry.ts`): the drive's
 * state, the dispatcher's, and every other component's files and tables
 * under the user's home or the temporary directory.
 */
import { plain, type RecordKind } from "./registry-kind.ts";
import rows from "./registry-machine-rows.json" with { type: "json" };

/** A worktree's key in the launch guard record: the SHA-256 of its path as Orca reports it. */
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
const DISPATCH_DB = 44;
/** The drive's database schema version (`skills/drive-pr/scripts/lib/state/db.ts`'s `DRIVE_DB_VERSION`). */
const DRIVE_DB = 9;
const REFLECT = "skills/reflect/scripts/";

/** A file in a drive's per-clone state directory, of one state family. */
function driveFile(
  name: string,
  owner: string,
  file: string,
  meaning: string,
  stateFamily?: string,
): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: `${STATE_DIR}${file}`,
    ...(stateFamily === undefined ? {} : { stateFamily }),
    version: 0,
    meaning,
  };
}

/** A table of the drive's database. */
function driveTable(
  name: string,
  owner: string,
  table: string,
  meaning: string,
): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: DRIVE_DB_FILE,
    table,
    version: DRIVE_DB,
    meaning,
  };
}

/** A table of the dispatcher's database. */
function dispatchTable(
  name: string,
  owner: string,
  table: string,
  meaning: string,
): RecordKind {
  return {
    name,
    medium: "machine",
    owner,
    at: `${DISPATCH_DIR}state.sqlite`,
    table,
    version: DISPATCH_DB,
    meaning,
  };
}

export const DRIVE_STATE: RecordKind[] = [
  // Optional ciActions telemetry is a bounded top-level tail, ignored by older readers.
  driveTable(
    "drive-state",
    `${STATE}store.ts`,
    "drive_state",
    "A drive's state for one pull request in one clone: its rounds, parked decisions, held batch and verified head. The driver and its passes read and write it under the store's lock; a person reads it through `drive-state.ts` or the handoff file.",
  ),
  driveTable(
    "drive-lock",
    `${STATE}lock.ts`,
    "locks",
    "A named lock in the drive's database around a read-modify-write or an act that must not run twice at once: the store's lock for a pull request, a driver's lock, the remote-mutation lock. A holder judged gone is replaced; anyone else waits or refuses, and only the holder's own token releases it.",
  ),
  driveTable(
    "drive-pr-lease",
    `${STATE}lease-admission.ts`,
    "leases",
    "The lease that admits one session per working tree and pull request to change a drive's state. A command checks that it still holds it, at the same generation, before it writes; a session that finds another live holder refuses (exit 11 in the same tree, 13 from another).",
  ),
  driveTable(
    "drive-tree-lease",
    `${STATE}lease-tree.ts`,
    "tree_leases",
    "The lease that admits one live session per working tree, whichever pull request it drives, so that two sessions never edit, commit and push one checkout over each other.",
  ),
  driveTable(
    "drive-claim",
    `${STATE}claims.ts`,
    "claims",
    "Who may carry out the act a held item stands for (posting its answer), or mark the pull request Ready: one row per item or Ready mark, created only when none exists, so that of two drivers exactly one acts.",
  ),
  // No longer written: kept in the schema so an earlier release still opens
  // the database. A stop is now a mailbox directive (`drive-mailbox`).
  driveTable(
    "drive-stop",
    `${STATE}db.ts`,
    "stops",
    "No longer written: a table kept so that an earlier release still opens the database. A stop is a directive in the drive's mailbox (`drive-mailbox`); nothing decides from this table.",
  ),
  driveTable(
    "drive-ledger-driver",
    `${DRIVE}lib/ledger-stop.ts`,
    "driver_records",
    "The driver a clone last started for a pull request, so that a stop from outside it (`drives.ts --stop`, `--doctor`, crash recovery) marks the ledger only while the ledger still names that driver, never a successor.",
  ),
  {
    ...driveFile(
      "drive-observation",
      `${DRIVE}lib/driver-observation.ts`,
      "drive-observation-<PR>-<acquisition hash>.json",
      "Evidence of a cooperative pass's process identities, written before the pass is spawned and at each sample, so that recovery after a crash marks a stopped driver's ledger from proof alone. Pending or uncertain evidence leaves the ledger running for a person to inspect.",
      "driver-observation",
    ),
    version: 1,
  },
  driveTable(
    "drive-state-import",
    `${STATE}import.ts`,
    "imports",
    "That a clone's state files from a release before the database were imported, once, at the database's first open for that clone: when, how many records, and the files that did not read. The old files stay for a person until the reaper retires them.",
  ),
  driveTable(
    "drive-counter",
    `${STATE}db.ts`,
    "counters",
    "A counter one statement raises and returns: the lease generations are drawn from it, so each admission is fenced by a number higher than any before it.",
  ),
  driveTable(
    "drive-cancelled-ci",
    `${DRIVE}lib/cancelled-recovery-state.ts`,
    "cancelled_ci",
    "A head's cancelled required check: when the drive first saw it, whether it has claimed the head's one re-run and which runs that re-run covers, how many further re-runs a person's answer granted, which answers the last was for and whether a grant waits for a young claim to age out, so the grace period, the re-run and each grant outlast a re-arm.",
  ),
  driveTable(
    "drive-cancelled-ci-label-rerun",
    `${DRIVE}lib/cancelled-recovery-state.ts`,
    "cancelled_ci_label_rerun",
    "A pull request's re-runs of cancellations a label write caused, and of failures in a run the converged label's write started, one per workflow run and attempt, requested outside the head's one re-run: the claim keeps a re-arm or a second caller from requesting the same attempt again.",
  ),
  driveTable(
    "review-round-counter",
    `${STATE}review-rounds.ts`,
    "review_rounds",
    "A pull request's review rounds, one row per head reviewed, which the drive and a hand-driven review loop share. The ledger's round is read from it; a head already counted adds nothing.",
  ),
  driveFile(
    "drive-log",
    `${DRIVE}lib/driver-log.ts`,
    "drive-pr-<PR>.log",
    "The driver's log for one pull request, each line stamped with its time and level, rotated at a bounded size. A person reads it to learn what a drive did; nothing decides from it.",
    "log",
  ),
  driveFile(
    "drive-arm-output",
    `${STATE}artifacts.ts`,
    "drive-arm-<PR>.out",
    "What a drive armed in the background printed while it started, for a person to read when an arm did not come up.",
    "arm-output",
  ),
  driveFile(
    "drive-pass-handoff",
    `${STATE}pass-handoff.ts`,
    "drive-pr-<PR>.answers.json, drive-pr-<PR>.notice.md",
    "What the driver hands a pass across driver processes: the verdicts a re-arm read for the items it unparked, kept until a pass succeeds with them, and a pass notice too long for an environment variable.",
    "pass-handoff",
  ),
  driveFile(
    "drive-round-report",
    `${STATE}round-report.ts`,
    "drive-pr-<PR>.round-report.json",
    "What a drive pass's round concluded, in the fields of a closing report, stamped with the pass's launch and round; each pass's replaces the one before it. The driver reads the last one of its own launch into the closing report it writes at its stop.",
    "round-report",
  ),
  driveFile(
    "drive-round-finish",
    `${STATE}round-finish.ts`,
    "drive-pr-<PR>.round-finish.json",
    "How each pass's `finish-round.ts` ended (its state, reason, head and time), the newest few kept for the driver's stall stop, which names the state that held the rounds when every stalled pass ended on the same one.",
    "round-finish",
  ),
  driveFile(
    "drive-report-memory",
    `${DRIVE}lib/morning-report.ts`,
    "drives-report.json",
    "When the morning report (`drives.ts --report`) last ran, so the next report starts from there.",
  ),
  plain(
    "machine",
    "drive-clone-id",
    `${STATE}clone-key.ts`,
    "<git common dir>/drive-pr-clone-id",
    0,
    "A clone's stable identity, kept in its git directory so that moving or renaming the checkout keeps it: it keys the clone's rows of the drive's database and names the clone in the ledger.",
  ),
];

export const DISPATCHER: RecordKind[] = [
  ...rows.dispatchTables.map(([name, owner, table, meaning]) =>
    dispatchTable(
      name as string,
      owner as string,
      table as string,
      meaning as string,
    ),
  ),
  {
    name: "tracker-budget",
    medium: "machine",
    owner: "shared/outbound/schema.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "tracker_budget",
    version: 1,
    meaning:
      "A tracker credential's request budget, shared by every process on the machine: while the tracker refuses the credential, no request is sent until the reset it named, and the dispatcher's reads stop at their share of each window.",
  },
  {
    name: "outbound-cost",
    medium: "machine",
    owner: "shared/outbound/schema.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "outbound_cost",
    version: 1,
    meaning:
      "What the calls to outside systems cost, summed per hour, system, credential, operation, caller and unit: the requests, their cost, how long they took and how they failed, kept for 7 days. Each dispatch tick and the budget answer read it to report what calls cost and which quotas are at risk; a call is never refused because the ledger cannot be written.",
  },
  {
    name: "forge-pacing",
    medium: "machine",
    owner: "shared/outbound/forge-pacing.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "forge_pacing",
    version: 3,
    meaning:
      "The next governed CLI send time per existing GitHub quota owner, claimed atomically without future queue reservations. A crashed sender holds others for at most 200 milliseconds.",
  },
  {
    name: "github-owner",
    medium: "machine",
    owner: "shared/outbound/schema.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "github_owner",
    version: 1,
    meaning:
      "Which quota owner a GitHub credential's runs are admitted against, per hashed credential (for a stored login, hashed with the repository a run addresses when it addresses one) and host: the hashed user or installation, whether it was verified, the login GitHub answered with, and when to ask again. Every process reads it, so a credential is asked who it is at most once a check period.",
  },
  {
    name: "outbound-cost-quota",
    medium: "machine",
    owner: "shared/outbound/schema.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "outbound_cost_quota",
    version: 1,
    meaning:
      "For each hourly cost-ledger row, the quota owner whose record it spent and the window it spent (core, GraphQL, search, none or unknown). The reports read it to match spending to the owner's balance and its window; a row without one is read with its window inferred.",
  },
  {
    name: "outbound-cost-not-modified",
    medium: "machine",
    owner: "shared/outbound/schema.ts",
    at: "~/.local/state/jig/tracker/budget.sqlite",
    table: "outbound_cost_not_modified",
    version: 1,
    meaning:
      "For each hourly cost-ledger row, how many of its requests a conditional request had answered 304 Not Modified. The reports read it to show a route's unchanged re-reads apart from its other requests; a row without one counts none.",
  },
  plain(
    "machine",
    "dispatch-receipt",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}receipts/<date>/<run id>.json`,
    1,
    "One tick's receipt: the records it read and from where, and each action it planned with its reason. A person reads it to learn why a tick acted; the next tick reads from it where each repository's follow-up window began.",
  ),
  plain(
    "machine",
    "dispatch-tick-lock",
    "dispatch/receipts.ts",
    `${DISPATCH_DIR}tick.lock, observe/<16 hex>.lock, tick-index`,
    0,
    "The locks that let one tick act on the machine at a time and one tick read and act on each repository at a time. A tick that cannot take a repository's lock leaves the repository to the tick that holds it.",
  ),
  plain(
    "machine",
    "dispatch-driver-report",
    "dispatch/lib/run-report.ts",
    `${DISPATCH_DIR}runs/<record>/drive-report.json`,
    0,
    "The closing report a dispatched drive's driver wrote at its stop, stamped with its launch record, for the wrapper to check and record under that record once the drive ended; the wrapper removes it then.",
  ),
  plain(
    "machine",
    "dispatch-process-output",
    "dispatch/lib/runtime/process-spool.ts",
    `${DISPATCH_DIR}runs/<record>/output.log`,
    0,
    "The last 4 MiB of a process run's output. The wrapper keeps it when the run leaves no closing report and removes it when the report is recorded.",
  ),
  plain(
    "machine",
    "dispatch-wall",
    "dispatch/lib/walls.ts",
    `${DISPATCH_DIR}walls/<account>/<ms>-<8 hex>.json`,
    0,
    "An account's usage-limit wall: the reset a drive recorded when it stopped at the limit. The latest reset of all of them is the wall, and admission launches nothing on the account before it.",
  ),
  plain(
    "machine",
    "dispatch-wake",
    "shared/wake.ts",
    `${DISPATCH_DIR}wake/<digest>/pending/<request>, waiter, started, last-run.log`,
    0,
    "A request that a repository's tick run soon, from a command that wrote a record and exited, and the one process that waits and runs it. A wake that is lost only delays the request to the next ordinary tick.",
  ),
  plain(
    "machine",
    "dispatch-probe",
    "dispatch/lib/change-probe.ts",
    `${DISPATCH_DIR}probe/state.json`,
    1,
    "What the change probe last saw on the forge for each repository it watches, so it wakes only the ticks of repositories where something changed.",
  ),
  plain(
    "machine",
    "dispatch-dashboard-install",
    "dispatch/dashboard-install.ts",
    `${DISPATCH_DIR}dashboard/enabled`,
    0,
    "That the dashboard is installed on this machine; its reader exits when the file changes or goes.",
  ),
  plain(
    "machine",
    "dispatch-dashboard-access",
    "dispatch/dashboard-reader.ts",
    `${DISPATCH_DIR}dashboard/access.json`,
    0,
    "The running dashboard reader's private address and process identity, which `jig dispatch dashboard` opens it through; an owner-only file, removed when the reader stops.",
  ),
  plain(
    "machine",
    "dispatch-dashboard-reader-lock",
    "shared/file-lock.ts",
    `${DISPATCH_DIR}dashboard/reader.<digest>.lock`,
    0,
    "The lock that keeps one dashboard reader per dashboard state directory.",
  ),
  plain(
    "machine",
    "dispatch-outcome-log",
    "dispatch/lib/log-export.ts",
    `${DISPATCH_DIR}log-<year>-<month>.jsonl`,
    0,
    "The outcome log's text copy, one file per month, which nothing removes: the archive that outlives any change to the database's schema.",
  ),
  plain(
    "machine",
    "dispatch-workspace-note",
    "dispatch/lib/runtime/orca-comment.ts",
    "the session runtime's workspace name and comment: the dispatched mark and each notification's key line",
    0,
    "What the dispatcher writes into a session runtime's workspace: the mark on a workspace it launched, and each notification with its key line, whose reading back tells the tick the notification was sent.",
  ),
];

export const MACHINE: RecordKind[] = [
  {
    name: "db-migration",
    medium: "machine",
    owner: "shared/records/migrations.ts",
    at: "every component's SQLite database: migration digests and whether each was applied or structurally baselined",
    table: "db_migrations",
    version: 1,
    meaning:
      "Which migrations a component's database applied, by digest, or took as the structure it started from. A database whose digest at a version differs from the code's is refused.",
  },
  {
    name: "db-meta",
    medium: "machine",
    owner: "shared/records/db.ts",
    at: "every component's database (the drive's and the dispatcher's): its instance id and minimum reader",
    table: "db_meta",
    version: 1,
    meaning:
      "A database's instance id and the oldest plugin release that may read it: an older copy refuses a database that needs a newer reader.",
  },
  ...rows.plainMachine.map(([name, owner, at, version, meaning]) =>
    plain(
      "machine",
      name as string,
      owner as string,
      at as string,
      version as number,
      meaning as string,
    ),
  ),
  plain(
    "machine",
    "evidence-record",
    "shared/evidence.ts",
    "~/.local/state/jig/evidence/<repo>/<tree>/<command>/<run id>.json",
    1,
    "Proof that a command ran against an exact tree: its exit, how long it took and the test cases it ran, so a reader checks a claim that a command passed against the record for that tree.",
  ),
  plain(
    "machine",
    "host-id",
    "shared/liveness.ts",
    "~/.local/state/jig/host-id",
    0,
    "This machine's identity, which outlasts a rename and a restart: every process identity Jig records names the machine by it.",
  ),
  plain(
    "machine",
    "verification-fit-log",
    `${DRIVE}verification-fit.ts`,
    "~/.local/state/jig/verification-fit.jsonl",
    1,
    "Verdicts on whether a round's demanded validation was worth its cost, which a calibration pass turns into edits of the change-area catalog; a verdict never changes what a round runs.",
  ),
  plain(
    "machine",
    "trace",
    "shared/trace.ts",
    "~/.local/state/jig/traces/<date>/<trace id>.jsonl",
    0,
    "Timing spans of a run, written only when tracing is on, for a person measuring where the time goes.",
  ),
  plain(
    "machine",
    "orca-card-lock",
    "shared/orca-card-lock.ts",
    "~/.local/state/jig/orca-card-locks/orca-card.<hash>.lock",
    0,
    "The lock over one Orca workspace card's comment, held across a read and a write so that two writers never drop each other's text.",
  ),
  plain(
    "machine",
    "orca-run-tab",
    "shared/orca-tabs.ts",
    "~/.local/state/jig/orca-tabs/<handle>.json",
    1,
    "A terminal tab Jig opened in Orca for a run, so the tab closes once the run ends, and a new run for the same subject closes the earlier run's tabs.",
  ),
  {
    name: "orca-guard-admission",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    at: `${ORCA_GUARD_DIR}admissions/<key>.json`,
    version: 2,
    key: ORCA_GUARD_KEY,
    meaning:
      "Written by `jig gc` while it collects a worktree: Jig's plugin for Orca refuses an agent launch into a worktree that has one.",
  },
  {
    name: "orca-guard-launch",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    foreign: ORCA_PLUGIN,
    at: `${ORCA_GUARD_DIR}launches/<key>.json`,
    version: 1,
    key: ORCA_GUARD_KEY,
    meaning:
      "Written by Jig's plugin for Orca before each agent launch it lets through, so `jig gc` sees the launch and keeps the worktree.",
  },
  {
    name: "orca-guard-heartbeat",
    medium: "machine",
    owner: "shared/orca-guard.ts",
    foreign: ORCA_PLUGIN,
    at: `${ORCA_GUARD_DIR}heartbeat.json`,
    version: 1,
    key: ORCA_GUARD_HEARTBEAT_KEY,
    meaning:
      "Rewritten by Jig's plugin for Orca about every minute while it runs. `jig gc` trusts the launch guard only while the heartbeat is fresh, and collects without it otherwise.",
  },
  plain(
    "machine",
    "orca-board-card",
    "shared/orca-board.ts",
    "the session runtime's card for a workspace: its column and comment",
    0,
    "A workspace's card on Orca's board: its column says where the work stands, and its comment what a person should know.",
  ),
  plain(
    "machine",
    "gh-cache",
    "shared/gh-cache-storage.ts",
    "~/.cache/jig/gh-cache/<hash>.json",
    1,
    "An answer of a GitHub read, kept owner-only and bounded in number, so a later read reuses it instead of sending the request again.",
  ),
  {
    name: "process-registry",
    medium: "machine",
    owner: "shared/process-registry.ts",
    at: "<tmp>/jig-processes-<id>/<entry>.json; a driver's on Windows, ~/.local/state/jig/drive-pr/<clone>/pr-drive-<PR>.processes.<token>/",
    stateFamily: "process-registry",
    version: 0,
    meaning:
      "The processes a run started, and the proof that each one's tree finished, so a run's processes are stopped and collected from proof; a missing entry never proves a tree gone.",
  },
  plain(
    "machine",
    "resource-lock",
    "shared/resource-lock.ts",
    "<tmp>/jig-lock.<name>, its slots <tmp>/jig-lock.<name>-slot-<n>, and <tmp>/jig-lock.<name>.admission and .exclusive",
    0,
    "A machine-wide lock with slots that bounds how many heavy commands (a build, a test run) run at once across worktrees: a holder runs, the others wait, and a dead holder's slot is reclaimed.",
  ),
  plain(
    "machine",
    "resource-lock-sample",
    "shared/resource-lock-samples.ts",
    "~/.local/state/jig/resource-lock-samples/<release ms>-<uuid>.json",
    1,
    "One completed run's lock name, working directory, request time, wait and hold durations. The dispatcher's validation gauge reads the last seven days to estimate the host's capacity.",
  ),
  plain(
    "machine",
    "turn-budget-state",
    "hooks/turn-budget-guard.ts",
    "<tmp>/jig-turn-budget/<session>/state.json",
    0,
    "How many turns an agent session has taken since its last prompt, so the turn-budget hook warns the agent before the runtime's turn cap aborts it.",
  ),
  plain(
    "machine",
    "reflection-pending",
    `${REFLECT}lib/journal.ts`,
    "~/.jig/pending/<repo>-<hash>/<time>-<16 hex>.jsonl",
    1,
    "Findings of a worktree removed before `reflect` sent them, moved here so a later reflection in the same repository adopts and sends them.",
  ),
  plain(
    "machine",
    "reflection-file-store",
    `${REFLECT}filesystem-store.ts`,
    "~/.jig/reflections/<year>-<month>/<time>-<16 hex>.jsonl",
    1,
    "The filesystem reflection store: the findings' events, one new file per append, never edited or removed, so copies synced between machines merge without conflicts.",
  ),
  plain(
    "machine",
    "reflection-notion-cache",
    `${REFLECT}lib/notion/store.ts`,
    "~/.jig/cache/notion/<database>.json",
    0,
    "A cache of a Notion reflection store's unchanged pages, so a read fetches only the pages that changed.",
  ),
  {
    name: "fleet-health-snapshot",
    medium: "machine",
    owner: `${DRIVE}lib/fleet-health-advisory.ts`,
    foreign: "the repository's own dashboard",
    at: "<fleet_health.snapshot_dir>/fleet-health.json",
    version: 1,
    meaning:
      "The fleet-health snapshot the repository's own dashboard publishes, from which a drive's round brief carries an advisory warning for its pull request; it never decides a state or an exit.",
  },
];
