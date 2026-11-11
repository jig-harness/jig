/**
 * What one tick reads, plans and reports. Every record is read fresh each
 * tick; nothing here is kept between ticks except what the receipt says.
 */
import type {
  Facet,
  FacetStoreKind,
  FacetStoreReport,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { SharedBudget, SharedOp } from "../../shared/records/shared.ts";
import type { BoardRead } from "./board.ts";
import type { SerialReport } from "./contention.ts";
import type { LabelConfig } from "./labels.ts";
import type { StandingAnswer } from "./routine-questions.ts";

/** The records a tick reads, by who owns them. */
export type RecordName = "tracker" | "forge" | "runtime";

/** The stages a tick can start, as the plan names them. */
export type Stage =
  | "pickup"
  | "rearm"
  | "followup"
  | "notify"
  | "steer"
  | "steward";

/** Evidence as the report prints it: field, value. */
export type Evidence = Record<string, string | number | boolean | null>;

/** What a repository's dispatch section says (`.config/jig.yaml`). */
export interface DispatchSection {
  /** The factory identity: whose assigned items are pickups; `null` = none. */
  identity: string | null;
  /** The canonical states that mean "ready to pick up". */
  states: string[];
  /** The command a follow-up runs; `null` = no follow-ups. */
  followupCommand: string | null;
  /** How long a claimed item may have no running session before it is reported stalled. */
  stalledAfterMs: number;
  /** How long a dispatched session may wait before it is reported. */
  blockedAfterMs: number;
  /** A drive drifts when its unresolved threads at the latest recorded round are not below the count this many recorded rounds earlier. */
  driveRoundsFlat: number;
  /** How long a pickup may run before it has opened a pull request. */
  pickupWithinMs: number;
  /** The deadline a pickup's headless pass runs under (`pickup_deadline`), after which its wrapper stops it. */
  pickupDeadlineMs: number;
  /** How long a follow-up may run before it has ended. */
  followupWithinMs: number;
  /** How old a follow-up claim with no done mark and no session joined to it may grow before the tick releases it, once (`followup_stale_after`). */
  followupStaleAfterMs: number;
  /** How long the notices workspace stays once read before the tick removes it; `0s` removes it at the first tick that finds it read. */
  noticesLingerMs: number;
  /** The branch of the workspace every notice goes to (`notices_branch`); `null` for the repository's notices workspace, which the tick opens and removes. */
  noticesBranch: string | null;
  /** How long a notice that still stands waits before it is sent again (`renotify_after`); `0` sends it once. */
  renotifyAfterMs: number;
  /** The dispatch labels (`dispatch.labels`): off by default. */
  labels: LabelConfig;
  /** The adoption rule (`dispatch.adopt`): off by default. */
  adopt: AdoptRule;
}

/** `dispatch.adopt`: which open pull requests with no drive ledger the tick drives as if labelled `drive`. */
export interface AdoptRule {
  /** Machine-only served logins, added after resolving the default author. */
  servedAuthors?: string[];
  enabled: boolean;
  /** The authors it adopts; `null` for the login the dispatcher reads the forge as. */
  authors: string[] | null;
  /** How recently a pull request must have been updated. */
  withinMs: number;
}

/** One repository as the tick dispatches for it. */
export interface RepoTarget {
  /** The local checkout `--repo` named. */
  path: string;
  /** `owner/name` on the forge. */
  slug: string;
  defaultBranch: string;
}

/** An item the factory identity claimed (in its in-progress state), watched for stalls and double claims. */
export interface ClaimedItem {
  key: string;
  title: string;
  /** Its link as the tracker listing gave it; absent where a reader gives none. */
  url?: string | null;
  state: string;
}

/** An item the tracker wants picked up, with the evidence for it. */
export interface WantedItem {
  key: string;
  title: string;
  url: string | null;
  state: string;
  assignee: string;
  assignedBy: string;
  servedPerson?: string;
  ancestorEpic?: string;
  batchAllowed?: boolean;
  queueIssue?: import("../../skills/do-item/scripts/lib/tracker/port.ts").PoolIssue;
  queueRank?: { unblocks: number; epicOrder?: number };
}

/** How a drive ledger reads, per the design's ledger-to-class table; the state label projection reads it too. */
export type { LedgerClass } from "../../shared/pr-labels/projection.ts";
import type { LedgerClass } from "../../shared/pr-labels/projection.ts";

/** How a pickup that needs nothing reads: its last session ended, or its claimed item is idle but not yet stalled. */
export type PickupClass = "pickup-ended" | "claimed-idle" | "claimed";

/** How a merged pull request whose follow-up needs nothing reads: done, or held by a run a person started. */
export type FollowupClass = "followup-done" | "followup-held";

/** A parked decision still waiting on its answer, as the drive framed it. */
export interface WaitingPark {
  digest?: string;
  stale?: import("../../skills/drive-pr/scripts/lib/state/pass-handoff.ts").PendingAnswer[];
  /** The latest answers that disagree, which keep the item waiting. */
  disputed?: import("../../skills/drive-pr/scripts/lib/state/pass-handoff.ts").PendingAnswer[];
  /** Every person's latest answer to it, stale ones included; absent when it has none. */
  answers?: import("../../skills/drive-pr/scripts/lib/state/pass-handoff.ts").PendingAnswer[];
  decision?: import("../../shared/decisions/park.ts").ParkedDecision;
  person?: string;
  key: string;
  kind: "thread" | "finding";
  /** The framed decision, as the drive prints it (`framedDecisionLines`). */
  lines: string[];
}

/**
 * Why a drive's stop no longer settles its pull request: `cause` in words, for
 * the report and the outcome log; `change` names the state that made it so,
 * for which a re-drive is launched once: for a converged drive its head and
 * whether it conflicts, for a stop on a conflict (`conflictStop`: stopped `9`,
 * or parked on a pull request that conflicts) its head and its base branch's
 * head.
 */
export interface StaleCause {
  cause: string;
  change: string;
  /**
   * The drive stopped `9`, stopped `1` while its pull request conflicts with
   * its base, or parked (`8`) on a pull request that conflicts: a re-drive
   * that leaves it so at this change is a person's to settle.
   */
  conflictStop?: true;
  /** Exit 12 recovery must settle the original tree, once per head. */
  uncleanTree?: true;
  /**
   * The drive stopped on a cause its own next step settles: a stall (`14`),
   * a spent CI-repair budget (`21`), a pass deadline with its restarts
   * spent (`15`), or checks still failing on the infrastructure through
   * their re-runs (`23`, `ci-infra`). Re-driven once per head commit, a
   * `ci-infra` stop once per stop after its backoff; a re-drive that leaves
   * the same stop standing is a person's.
   */
  mechanicalStop?: "stall" | "ci-repair" | "deadline" | "ci-infra";
  /** When the re-drive may start: a `ci-infra` stop's backoff end (`infra-backoff.ts`). */
  notBefore?: string;
  /**
   * The re-drive draws on the pull request's recovery budget, which the
   * re-arms of stops with no recorded cause share (`no-cause-stops.ts`): a
   * pass deadline, and a failure on a conflicting pull request.
   */
  recovery?: true;
  /**
   * For a stall or a pass deadline that left work in its tree: that tree, as the ledger names it
   * (`wt-<key>`), and whether it is on this host. The re-drive runs there,
   * never in a fresh tree, which would not carry the work.
   */
  tree?: { actor: string; here: boolean };
  /** Changes an earlier launch of the same record may have acted on before a replay moved `change` on; each counts as re-driven. */
  earlier?: string[];
}

/** What the repository clone's drive doctor (`drives.ts --doctor`) reads of a pull request's lock holder. */
export interface HolderReading {
  /** The doctor's verdict: `WEDGED`, `DEAD`, `HEALTHY`, `UNKNOWN`, … */
  verdict: string;
  reason: string;
  /** The lock's state: `live`, `stale`, `empty`, … */
  lock: string;
}

/** One open pull request whose comments hold a drive ledger. */
export interface DrivenPr {
  number: number;
  url: string;
  title: string;
  head: string;
  class: LedgerClass;
  /** Why the ledger reads as its class, in one sentence. */
  why: string;
  evidence: Evidence;
  /** For a `parked` ledger: the decisions still unanswered. */
  waiting?: WaitingPark[];
  /** For a ledger that read: every park it holds and the receipts of those re-arms unparked (`park-events.ts`). */
  parks?: import("./park-events.ts").LedgerParks;
  /** For a `stale` ledger: what its stop does not settle. */
  stale?: StaleCause;
  /** Its labels, read only where the repository turns dispatch labels on. */
  labels?: string[];
  /** For an `unplaced` ledger: its comments or its ledger did not read, as against a state the forge leaves undecided. */
  readFailed?: true;
  /** The pull request's head commit and its branch's head on the forge, read only where a failed re-arm is weighed (`failed-rearms.ts`). */
  heads?: RearmHeads;
}

/** A pull request's head commit, as the forge reports it with the pull request, and its branch's head on the forge. */
export interface RearmHeads {
  pr: string;
  branch: string;
}

/** One pull request merged since the follow-up stage's start. */
export interface MergedPr {
  number: number;
  url: string;
  title: string;
  head: string;
  mergedAt: string;
  createdAt?: string;
  /** When it last changed, as the listing gives it: a new comment or an edit of one moves it. */
  updatedAt?: string;
  /** Its labels, read only where the repository turns dispatch labels on. */
  labels?: string[];
  /** Its description, read with its labels. */
  body?: string;
}

/** A follow-up marker comment on a merged pull request, as the tick reads it. */
export interface FollowupMarker {
  /** The comment's id: the lower id is the earlier comment. */
  id: number;
  login: string;
  createdAt: string;
  /** Written by the dispatcher's own login or by an owner, member or collaborator. */
  trusted: boolean;
  /**
   * `tick`: posted by a tick, naming its launch record, the host that made
   * it where it says (the dispatcher's digest), and the follow-up's answer
   * once that host wrote it; `manual`: posted by a follow-up a person ran,
   * carrying its own outcome; `unreadable`: a marker whose body this reader
   * cannot read.
   */
  run:
    | {
        kind: "tick";
        record: string;
        host?: string;
        /** Whether that host says it owns the repository. */
        owner?: boolean;
        outcome?: "done" | "failed";
      }
    | { kind: "manual"; done: boolean }
    | { kind: "unreadable"; reason: string };
}

/** A merged pull request with its follow-up markers, or why they could not be read. */
export type MarkedPr = MergedPr & {
  markers: FollowupMarker[] | { unreadable: string };
};

/** A record the tick could not read, or a part of one it cannot place. */
export interface Unplaced {
  target: string;
  record: RecordName;
  reason: string;
  /** For an item the tracker listing returned: its title and link, which the line and the outcome log show beside its key. */
  title?: string;
  url?: string | null;
  /**
   * Set for an item only a person can settle: assigned by someone who cannot
   * write, or placed in no repository by its labels and no default.
   */
  cause?: "assigner-cannot-write" | "needs-repository-label";
  /** Set when reading the record failed (a comment listing, an unreadable ledger), as against a state the record legitimately leaves unplaced. */
  readFailed?: true;
  /** Internal tracker namespace used to keep identical issue keys distinct across trackers. */
  source?: string;
}

/** What a notification is about. */
export type NotifyCause =
  | "double-claim"
  | "stalled"
  | "waiting"
  | "parked"
  | "needs-person"
  | "stopped-unknown"
  | "followup-failed"
  | "followup-stale"
  | "drifting"
  | "nudge-unanswered"
  | "pickup-question"
  | "ready"
  | FailureCause;

/**
 * The causes of the failure ledger (`failures.ts`): an action that failed
 * `failures.notify_after` times in a row, a repository whose turn did, and
 * this host's ticks of one scope that exited 1 as often.
 */
export type FailureCause =
  | "action-failing"
  | "repository-failing"
  | "ticks-failing";

/** A follow-up claim past `followup_stale_after` with no done mark and no session joined to it: the marker the tick releases, and whose claim it was. */
export interface StaleClaim {
  /** The marker's comment id. */
  marker: number;
  /** Who wrote the marker. */
  login: string;
  /** Whose run claimed it, in the report's words: `maintainer's /followup run`, `host <h>'s launch record <r>`. */
  claimant: string;
  /** When the marker was posted. */
  claimedAt: string;
}

/**
 * A notification's message: `key` names the facts its suppression record
 * is keyed by, and is carried in the text so a read of the target's comment
 * shows whether it arrived.
 */
export interface Notice {
  key: string;
  text: string;
}

/** One action the tick would take: the stage, its target and why. */
export interface Action {
  steward?: { id: number; facts: string };
  stage: Stage;
  /** `#12`, `ENG-4`, `PR #7`. */
  target: string;
  /** The record that wants it. */
  record: RecordName;
  reason: string;
  evidence: Evidence;
  /** For a drive: the ledger facts it acts on (generation, exit, heartbeat). */
  facts?: string;
  /** For a takeover: the launch record whose driver it replaces. */
  takeover?: string;
  /** For a takeover of a driver another host started: that host's launch claim, which names the launch. */
  takeoverClaim?: { id: number; host: string; record: string };
  /** For a takeover of a driver no launch started: what this clone's drive doctor read of its holder. */
  takeoverHolder?: HolderReading;
  /** For a takeover of a driver no launch started, whose run this host shows ended: what showed it. */
  takeoverGone?: string;
  /** For a re-drive: why the drive's stop no longer settles its pull request. */
  redrive?: StaleCause;
  /** For a notification: its cause. */
  cause?: NotifyCause;
  /** For a notification: the message, with the key that suppresses a repeat. */
  notice?: Notice;
  /** For a notification: the workspace path a launch record names, when the target joins no workspace by itself. */
  workspace?: string;
  /** For a notification about a stage this machine launched, whose ended row the outcome log already holds: no event row is written for it. */
  launched?: true;
  /** For a nudge: the launch record, the agent it goes to, and the waiting episode it answers. */
  nudge?: { record: string; agent: string; episode: string; account: string };
  /** For a follow-up: the stale claim the tick releases, rather than a launch. */
  release?: StaleClaim;
  /** For a follow-up's routine run again: the earlier question and the classes whose standing answers its prompt gives. */
  standing?: StandingAnswer;
}

/** What `--apply` did with one stale follow-up claim. */
export interface ReleaseOutcome {
  target: string;
  marker: number;
  claimant: string;
  /** `released`: the marker was deleted and the release recorded; `waits`: the fresh read changed, or the tick ran out of time; `refused`: the forge did not delete it. */
  outcome: "released" | "waits" | "refused";
  detail: string;
}

/** A checkout the runtime does not list that holds a launch's branch and is in use: where it is, the branch, and what keeps it busy. */
export interface BusyHolder {
  path: string;
  branch: string;
  reasons: string[];
}

/** What `--apply` did with one planned launch. */
export interface LaunchOutcome {
  target: string;
  action: "rearm" | "takeover" | "pickup" | "followup" | "steward";
  /**
   * `launched`: the runtime started the wrapper; `retried`: a pending
   * record's launch was called again under its own key; `lost`: no answer
   * in time, so the record holds its slot; `failed`: the runtime answered
   * that it started nothing; `waits`: no account admits it, or the fresh
   * read changed; `refused`: the identity check, the workspace or a record
   * stopped it before any launch; `reported`: the runtime cannot bind the
   * session to its account, so it is reported and never started.
   */
  outcome:
    | "launched"
    | "retried"
    | "lost"
    | "failed"
    | "waits"
    | "refused"
    | "reported";
  account: string | null;
  record: string | null;
  detail: string;
  /**
   * For a follow-up that waits for its lane: what it waits on. `lane-budget`:
   * the tick spent `followup_opens_per_tick`; `lane-cap`: the host runs
   * `followup_concurrency` follow-ups already; `accounts`: no admitted
   * account has a free slot.
   */
  waitsOn?: LaneWait;
  /** For a launch refused because a busy checkout the runtime does not list holds its branch: that checkout, which the tick notifies a person of. */
  holder?: BusyHolder;
}

/** What a follow-up that waits for its lane waits on. */
export type LaneWait = "lane-budget" | "lane-cap" | "accounts";

/** What `--apply` did with one notification. */
export interface NotifyOutcome {
  target: string;
  cause: NotifyCause;
  key: string;
  /**
   * `sent`: the target's comment now carries it; `already`: the comment
   * carried it before this tick, so it was recorded as sent; `suppressed`: an
   * earlier tick sent it; `lost`: the runtime's answer did not show it
   * arrived; `waits`: no target could be reached this tick.
   */
  outcome: "sent" | "already" | "suppressed" | "lost" | "waits";
  /** The workspace it went to; `null` when none was reached. */
  workspace: string | null;
  detail: string;
}

/** What `--apply` did with the repository's notices workspace once its notifications were sent. */
export interface RetireOutcome {
  workspace: string;
  /**
   * `retired`: removed, its message read or every cause it carries gone;
   * `kept`: it still has a job (unread with a cause standing, read within
   * `dispatch.notices_linger`, or written this tick); `refused`: something
   * in it is not the dispatcher's, so it is left for a person; `lost`: the
   * removal's answer did not come back.
   */
  outcome: "retired" | "kept" | "refused" | "lost";
  detail: string;
}

/** What `--apply` did with one nudge (the `steer` stage). */
export interface SteerOutcome {
  target: string;
  record: string;
  /** The waiting episode it answers: the wall's observation time. */
  episode: string;
  /**
   * `sent`: the runtime's receipt shows the text was delivered;
   * `unknown`: a send was attempted and its answer is lost; `refused`: a
   * check before the send failed or could not be read, so nothing was
   * sent; `reported`: the runtime cannot steer, so the nudge is reported
   * and not sent.
   */
  outcome: "sent" | "unknown" | "refused" | "reported";
  detail: string;
}

/** A wanted stage the runtime reports already running. */
export interface Running {
  target: string;
  stage: Stage;
  reason: string;
  evidence: Evidence;
  /** Set when it runs past its expectation and a waiting notification stands, so it is reported rather than notified. */
  drifting?: true;
}

/** How one record read for one repository. */
export interface RecordRead {
  record: RecordName;
  source: string;
  ok: boolean;
  detail: string;
  /** The tracker's record only: where each issue facet is kept, and the assigned items lacking one. */
  facets?: FacetRecord;
}

/** One issue facet's store as the tick's tracker record shows it. */
export interface FacetStoreLine {
  facet: Facet;
  /** `null`: the repository has no such facet, or it is in conflict. */
  store: FacetStoreKind | null;
  why: FacetStoreReport["why"];
  /** Detection answered from the machine-local cache. */
  cached?: true;
  /** One line: why the store, its detection or its taxonomy fails. */
  error?: string;
}

/**
 * The issue facets in the tick's tracker record: each facet's store and why,
 * or why the tracker did not say (`failed`, one line), and the assigned
 * items that lack a facet the repository keeps, by key and facet only.
 */
export interface FacetRecord {
  stores?: FacetStoreLine[];
  failed?: string;
  gaps?: Array<{ key: string; missing: Facet[] }>;
}

/** One repository's part of a tick's report. */
/**
 * The phases of one repository's turn, in their order (`tick-repo.ts`):
 * opening it, reading the tracker, the forge and every host's launch claims,
 * joining the runtime's sessions, Control's reads (`observe`), the plan, the
 * outcome log, the act phase of `--apply`, the label projection and the
 * shared records' report.
 */
export type RepoPhase =
  | "open"
  | "tracker"
  | "forge"
  | "claims"
  | "runtime"
  | "observe"
  | "board"
  | "plan"
  | "log"
  | "apply"
  | "labels"
  | "shared";

/**
 * The stages of a repository's `--apply`, each its own defect boundary:
 * its launch stages, its nudges, its notifications, and the close that
 * projects its labels and reports its shared records.
 */
export type ApplyStage =
  | "steward"
  | "rearm"
  | "pickup"
  | "followup"
  | "steer"
  | "notify"
  | "close";

/**
 * A defect: something no code expected threw (a bug, or a write the platform
 * refused where nothing turns the refusal into a value), caught once at the
 * boundary around the work it stopped
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)).
 */
export interface Defect {
  /** For code and tests: always `defect`, so a reader tells it from a refusal without parsing the reason. */
  code: "defect";
  /** The phase it was thrown in. */
  phase: string;
  /** The stage of a repository's `--apply` it was thrown in, for a defect that stage's boundary caught. */
  stage?: ApplyStage;
  /** For a person: what was thrown, in which phase, and the error's first line. Its stack goes to the tick's error output, never here. */
  reason: string;
}

export interface RepoReport {
  steward?: { status: string; hash?: string; records?: number };
  path: string;
  slug: string | null;
  /** Set when the repository could not be dispatched at all, or a defect stopped its turn. */
  refused: string | null;
  /** The defect that stopped the repository's turn; what its earlier phases did stays on the report. */
  defect?: Defect;
  /** The defects a stage of `--apply` caught, each of which stopped its own stage only; absent when there were none. */
  stageDefects?: Defect[];
  /** Milliseconds each phase of the repository's turn took; absent from a receipt written before phases were timed. */
  phasesMs?: Partial<Record<RepoPhase, number>>;
  section: DispatchSection | null;
  followupSince: string | null;
  records: RecordRead[];
  actions: Action[];
  running: Running[];
  unplaced: Unplaced[];
  /** Targets whose actions a hold label or `only_labeled` withheld this tick: their notice records stand. */
  withheld?: string[];
  /** Under `only_labeled`: the pull requests read and found labelled; a notice record for any other pull request stands. */
  inScope?: number[];
  /** What `--apply` launched, retried or held back; empty without it. */
  launches: LaunchOutcome[];
  /** What `--apply` notified, where the machine file enables `notify`; empty otherwise. */
  notifications: NotifyOutcome[];
  /** What `--apply` did with the repository's notices workspace, where the machine file enables `notify` and one is open. */
  noticesWorkspace?: RetireOutcome;
  /** What `--apply` nudged, where the machine file enables `steer`; empty otherwise. */
  steers?: SteerOutcome[];
  /** What `--apply` did with the stale follow-up claims it released, where the machine file enables `followup`; absent when there were none. */
  releases?: ReleaseOutcome[];
  /** The dispatch labels' part, where the repository turns them on. */
  labels?: LabelReport;
  /** Serialization's part, where the change-area catalog serializes an area. */
  serialized?: SerialReport;
  /** The board read's part: its converged pull requests placed in Ready to merge or wherever their reason says, or why it did not read; absent when it did not run. */
  board?: BoardRead;
  /** The shared records' part: which host owns the repository, and each read and write this tick made. */
  shared?: SharedReport;
  /** Targets that need nothing from the tick, by class: a pull request's ledger class, a pickup's, or a follow-up's. */
  quiet: Array<{
    target: string;
    class: LedgerClass | PickupClass | FollowupClass;
    why: string;
  }>;
}

/** A command label a pull request carries, and what the tick made of it. */
export interface LabelCommand {
  target: string;
  command: "drive" | "rearm" | "hold";
  note: string;
}

/** What the projection did with one pull request whose labels disagreed with its ledger. */
export interface LabelWrite {
  target: string;
  add: string[];
  remove: string[];
  /**
   * `written`: the forge took the change; `failed`: it refused it (a label
   * that does not exist, no permission), reported and tried again at the
   * next tick; `would`: a run without `--apply`, for a repository the
   * machine file does not list, or on a host that does not own it, writes
   * nothing; `waits`: the tick's time
   * was spent.
   */
  outcome: "written" | "failed" | "would" | "waits";
  detail: string;
}

/** One repository's dispatch labels in a tick. */
export interface LabelReport {
  prefix: string;
  onlyLabeled: boolean;
  /** Under `only_labeled`: the open pull requests left unread, which carry no label of the set. */
  unlabeled: number;
  /** Each pull request the projection manages, and the state its ledger maps to (`null`: none; `unknown`: left as it is). */
  states: Array<{ target: string; state: string | null }>;
  commands: LabelCommand[];
  /** The stages a `hold` label kept off. */
  held: Array<{
    target: string;
    stage: Stage;
    reason: string;
    /** For a notification the hold kept off: its cause. */
    cause?: NotifyCause;
  }>;
  writes: LabelWrite[];
}

/** One repository's shared records in a tick (`shared-launches.ts`). */
export interface SharedReport {
  /** The medium, as the machine file's `records.shared` names it. */
  medium: "forge";
  /** This host, as its claims name it: a digest of its dispatcher's database. */
  host: string;
  /** Whether this host owns the repository's board, notifications and history rows (`owner` in the machine file). */
  owner: boolean;
  /** The other hosts whose claims this tick read say they own the repository. */
  owners: string[];
  /** Each read and write this tick made through the shared records. */
  ops: SharedOp[];
  reads: number;
  writes: number;
  /** What was left of the forge's budget as the tick started, or why it did not read. */
  budget: SharedBudget | { unreadable: string } | null;
}
