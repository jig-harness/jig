/**
 * What `jig dispatch dashboard`'s server and its page say to each other: the
 * tick's snapshot of the line and the two answers the page reads. Types only,
 * so the page's bundle (`dashboard/`) takes nothing from the
 * server's code with them.
 *
 * Every panel above the log reads one `LineSnapshot`: the facts as the newest
 * tick found them, written to the state database beside its receipt. A record
 * no tick holds is left out rather than guessed.
 */
import type { LaunchAction, ThreadSample } from "./launches.ts";
import type { LogRow } from "./log.ts";
import type {
  FailureCause,
  LaunchOutcome,
  NotifyCause,
  NotifyOutcome,
} from "./types.ts";
import type {
  Act,
  Lane,
  Placement,
} from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import type { NeedAct } from "../../shared/acts.ts";

/** One option of a framed decision, as the drive recorded it. */
export interface LineOption {
  details?: import("../../shared/decisions/model.ts").OptionDetail[];
  name: string;
  /** Its `Changes:`; `null` when the record gives none. */
  changes: string | null;
  /** Its `Costs:`; `null` when the record gives none. */
  costs: string | null;
  /** Whether the record's `## Recommended` names it. */
  recommended: boolean;
}

/** One decision a parked drive waits on, as the drive framed it. */
export interface LineDecision {
  digest?: string;
  /** When this park of the item was made: a park made again of the same item has another time, so a pick kept for the earlier one is not carried to it. Absent on a park that records none, and from a line written before it was kept. */
  parkedAt?: string;
  decision?: import("../../shared/decisions/park.ts").ParkedDecision;
  /** The named person; absent on older parks. Routing does not restrict answers. */
  person?: string;
  /** The thread or finding the answer goes to: `answer <key>: …`. */
  key: string;
  kind: "thread" | "finding";
  /** The decision as the drive recorded it, one entry per line: Markdown with `## Question`, `## Options`, `## Recommended` and so on, or a sentence for a park from before parks were framed. */
  lines: string[];
  /** Its first line's question; `null` when the lines hold none in the drive's form. */
  question: string | null;
  /** Its recommendation line; `null` when it has none. */
  recommendation: string | null;
  /** The class the drive filed it under (`scope`, `destructive`, …); `null` when it names none. */
  decisionClass: string | null;
  /** Its options, in the record's order; empty for a park from before parks were framed. Absent from a line written before it was kept. */
  options?: LineOption[];
  /** The record's steps for a person, each a command or a named action; empty for `None.`. Absent from a line written before it was kept. */
  steps?: string[];
}

/** How a cause's notification went, at the newest tick. */
export interface LineNotified {
  /** When it was delivered; `null` while it has not been. */
  at: string | null;
  outcome: NotifyOutcome["outcome"];
  workspace: string | null;
}

/**
 * Causes that wait on a person and on nothing else: what the tick notifies,
 * and an item assigned by someone who cannot write, which it only reports.
 * The failure ledger's causes are about the dispatcher, not a piece of work,
 * and are on the receipt instead.
 */
export type NeedCause =
  | Exclude<NotifyCause, "waiting" | "drifting" | "ready" | FailureCause>
  | "assigner-cannot-write";

/** One thing the line waits on a person for. */
export interface LineNeed {
  cause: NeedCause;
  /** What the person does about it (`shared/acts.ts`). Absent from a line written before it was kept; a reader then derives it the same way. */
  act?: NeedAct;
  /** The stage it is about. */
  stage: LaunchAction | "steer";
  repo: string;
  /** `PR #7`, `ENG-4`. */
  target: string;
  pr: number | null;
  item: string | null;
  /** Where to act on it; `null` when no record gives a link. */
  url: string | null;
  title: string | null;
  /** When the cause began, as far as the records say: a stop's last ledger write, else its first notification, else this tick. */
  since: string;
  /** The tick's reason, verbatim. */
  reason: string;
  /** The question a stage stopped on for a person, such as a follow-up's `Question:` line; `null` when it stated none. A park's questions are its decisions'. */
  question?: string | null;
  /** For a park: the decisions still unanswered, oldest first. */
  decisions: LineDecision[];
  notified: LineNotified | null;
  /** The workspace holding this work; null when no record identifies one. Older version-1 snapshots may omit it. Independent of the notification destination. */
  workspace?: string | null;
  /** For a double claim: the workspaces that hold the item. */
  workspaces: string[];
  /** For a stuck launch record: its id, which `jig dispatch clear` takes. */
  stuckRecord?: string | null;
}

/** An account's wall as the newest tick read it. */
export interface LineWall {
  /** When it lifts. */
  resetAt: string;
  /** Where the reset came from: the drive's record, or the backoff. */
  source: string;
}

/** One account on this machine. */
export interface LineAccount {
  name: string;
  vendor: string;
  /** Sessions the dispatcher may hold on it at once. */
  cap: number;
  /** Launch records holding one of its slots. A takeover and the record it replaces count once. */
  held: number;
  wall: LineWall | null;
  /** A launch ended on this account's wall and the wall was never recorded: no launch is admitted until a person clears that record. */
  wallUnrecorded: boolean;
  /** Why a drive's pass is never admitted on it; `null` when it is. */
  notAdmitted: string | null;
}

/** An agent's state as the runtime reports it, for an interactive session. */
export interface LineAgent {
  /** The runtime's own word: `working`, `waiting`, `blocked`, `done`, … */
  state: string;
  /** When it entered that state; `null` when the runtime does not say. */
  since: string | null;
}

/** A session that holds a slot. */
export interface LineSession {
  record: string;
  account: string;
  vendor: string;
  repo: string;
  stage: LaunchAction;
  target: string;
  pr: number | null;
  item: string | null;
  url: string | null;
  title: string | null;
  createdAt: string;
  /** The launch record's state. `unknown`: its claim is from another boot or does not read; it holds its slot until a person clears it. */
  launch: "pending" | "alive" | "unknown";
  /** Why the state is `unknown`; `null` otherwise. */
  launchReason: string | null;
  /** Set when the record is pending and no tick launches it again (both launches unanswered, or a follow-up's replay not provably safe): why. It needs a person, and holds its slot until they clear it. Absent from a line written before it was kept. */
  stuck?: string | null;
  /** `null` for a drive's headless pass, whose process is the only runtime record. */
  agent: LineAgent | null;
  /** A drive's ledger round; `null` for any other stage or when it does not read. */
  round: number | null;
  /** A drive's unresolved threads, the first time a tick saw each round. Unseen rounds are gaps. */
  samples: ThreadSample[];
  /** A drive's last ledger write; `null` when it does not read. */
  heartbeat: string | null;
  /** The pass deadline a drive runs under, in seconds; `0` for none, `null` when not recorded. */
  passTimeoutSec: number | null;
  workspace: string | null;
  /** For a takeover: the record it replaces. */
  replaces: string | null;
  /** The usage-limit wall an interactive session last met; `null` when it has met none. */
  episode: {
    observedAt: string;
    resetAt: string | null;
    /** The vendor's own words, on one line. */
    evidence: string;
    /** Whether the wall was still the session's last record at the newest read. */
    last: boolean;
  } | null;
  /** The nudge sent for that wall; `null` when none was. */
  nudge: { at: string; delivery: string; detail: string } | null;
  /** Set when the stage breaks its expectation: the tick's reason, verbatim. */
  drifting: string | null;
  /** Set when the session has waited past `blocked_after`: the tick's reason, verbatim. */
  waiting: string | null;
}

/** Where a queued target came from: the record that wants it. */
export type QueueSource =
  | "re-armable"
  | "label drive"
  | "held"
  | "assigned"
  | "merged";

/**
 * What will happen to a queued target, which is how the page orders them:
 * `starts` when a tick finds a free slot; `held` behind a serialized leader or
 * a person's label; `reported` and not started, whatever waiting; `never`
 * refused by a check it will fail again.
 */
export type QueueGroup = "starts" | "held" | "reported" | "never";

export interface LineQueued {
  source: QueueSource;
  group: QueueGroup;
  repo: string;
  target: string;
  pr: number | null;
  item: string | null;
  url: string | null;
  title: string | null;
  /** The record's own reason, verbatim. */
  why: string;
  /** Whether a converged drive went stale: finished well once, and the world moved. */
  stale: boolean;
  /** For an assigned item: who assigned it. */
  assignedBy: string | null;
  /** For a pull request held behind a serialized leader. */
  hold: { leader: number; area: string; since: string } | null;
  /** What the newest tick's launch of it did, and, for a follow-up that waits for its lane, what it waits on; `null` when it did not try. */
  launch: {
    outcome: LaunchOutcome["outcome"];
    detail: string;
    waitsOn?: LaunchOutcome["waitsOn"];
  } | null;
}

/** One repository the machine file lists. */
export interface LineRepo {
  /** `null` when the forge could not say which repository the path is. */
  slug: string | null;
  path: string;
  /** The stages the machine file enables for it. */
  stages: string[];
  /** Why nothing could be dispatched for it; `null` when it was read. */
  refused: string | null;
  /** The records that did not read at the newest tick. */
  failedReads: Array<{ record: string; source: string; detail: string }>;
  /** What each record's read said about what this repository has, such as no pickups. */
  notes: string[];
  /** Why the board read did not place its converged pull requests at the newest tick; `null` when it did, absent when it did not run. */
  boardUnread?: string | null;
  /** Cards beyond the line's per-repository bound; absent before Ready was read. */
  readyOmitted?: number;
}

/**
 * One converged pull request as the tick's board read placed it: in a lane
 * of Ready to merge (merge now, approve first, update next), or wherever its
 * reason says, with the act that settles it or what it waits for.
 */
export interface LineReady {
  repo: string;
  pr: number;
  url: string;
  /** Its title: text the pull request's author wrote, shown as quoted text. */
  title: string;
  /** The head the drive verified. */
  head: string;
  place: Placement;
  /** Its lane, for a pull request in Ready to merge; `null` elsewhere. */
  lane: Lane | null;
  /** What the card says, in the board's own words. */
  says: string;
  /** The person's act that settles it, or `null` when it settles by waiting. */
  act: Act | null;
  /** What it waits for, when it settles by waiting; `null` when it waits on a person. */
  waitingFor: string | null;
  /** For merge now: the merge command pinned to the verified head; `null` when withheld or not in merge now. */
  command: string | null;
  /** Which value withheld the command; `null` when none did. */
  withheld: string | null;
  /** The reviewers or teams a review is requested from, as requested: logins the forge gives. */
  requested: string[];
  /** The checks failing on its head, by name: text the checks' apps wrote, at most `MAX_FAILING`. */
  failing: string[];
  /** Failing check names beyond this card's bound. */
  failingOmitted: number;
  /** The Ready conditions, each met (`true`), not (`false`) or not read (`null`). */
  conditions: Array<{ name: string; met: boolean | null; fact: string }>;
  /** The pull requests that wait behind it in a serialized area. */
  unblocks: number[];
  /** When it converged, as its ledger last wrote. */
  since: string;
}

/** One repository's turn in a recent tick. */
export interface LineTickRepo {
  /** Its slug; its path when the forge could not say which repository it is. */
  repo: string;
  /** The milliseconds its phases took, added up: phases run beside each other count each. */
  ms: number;
  /** Milliseconds per phase of its turn (`open`, `tracker`, `forge`, …); empty for a turn that timed none. */
  phasesMs: Record<string, number>;
  /** The phase a defect stopped its turn in; `null` when none did. */
  defect: string | null;
}

/** How one recent tick ran, as its receipt recorded it (`tick-health.ts`). */
export interface LineTick {
  runId: string;
  startedAt: string;
  /** From its start to the write of the line. */
  tookMs: number;
  exitStatus: number;
  /** Whether it read every repository the machine file lists, rather than a wake-up's few. */
  sweep: boolean;
  /** Milliseconds per phase of the tick itself (`start`, `repos` or `observe`, `wait` and `act`, then `close` up to the line's write); empty for a receipt that timed none. */
  phasesMs: Record<string, number>;
  repos: LineTickRepo[];
  /** The forge's rate budget, as the tick read it; `null` when it read none. */
  budget: { remaining: number; limit: number } | null;
  /** The paths of the repositories another tick held, which this one neither read nor acted on. */
  busy: string[];
  /** The optional reads it skipped because the forge's budget was low; `null` when it skipped none. */
  lowBudget: string[] | null;
  /** The defects it recorded: its own, its repositories' and their stages'. */
  defects: number;
}

/** The host's gauges the load factor reads (`load.ts`). */
export type LoadGauge =
  | "memory"
  | "processors"
  | "test-lock"
  | "disk"
  | "forge"
  | "accounts";

/** The kinds of launch, each with its own memory reservation. */
export type LoadKind = "pickup" | "drive" | "followup" | "steward";

/** One gauge as the tick read it, under the act lock. */
export interface LineLoadGauge {
  gauge: LoadGauge;
  /** Its fill against its line: `1` at the line; `null` when the host cannot read it. */
  fill: number | null;
  /** What it read, for a person ("12.3 GiB available of 62.5 GiB"); why not, when it read nothing. */
  reads: string;
  /** Its line, for a person ("15% of memory kept free"). */
  line: string;
}

/** A launch a gauge refused: held when enforcement is on, else started and reported as one it would hold. */
export interface LineLoadHold {
  repo: string;
  target: string;
  kind: LoadKind;
  gauge: LoadGauge;
  detail: string;
  /** Whether it was held (`load.enforce: true`) rather than started. */
  held: boolean;
}

/** What the load factor read and decided in a tick. */
export interface LineLoad {
  /** Whether it holds the launches a gauge refuses (`load.enforce`). */
  enforce: boolean;
  /** The fullest gauge's fill; `null` when no gauge read. */
  factor: number | null;
  /** The gauge whose fill is the factor. */
  binds: LoadGauge | null;
  gauges: LineLoadGauge[];
  /** Each kind's reservation: its 90th percentile once it has five samples, else its default. */
  reservations: Array<{
    kind: LoadKind;
    bytes: number;
    samples: number;
    measured: boolean;
  }>;
  holds: LineLoadHold[];
}

/** The line as one tick found it. */
export interface LineSnapshot {
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  exitStatus: number;
  /** Whether the tick launched what the machine file enables. */
  apply: boolean;
  /** Why `--apply` was asked for and nothing was started; `null` when not withheld. */
  applyWithheld: string | null;
  /** How often the timer ticks. */
  intervalMs: number;
  /** The longest of the recent ticks, so a long tick does not read as a stopped timer. */
  longestTickMs: number;
  /** The recent ticks' durations, which each tick carries on to the next. */
  recentTicksMs?: number[];
  /** How the recent ticks ran, the oldest first, this one last; a tick that does not replace the line still adds its entry. Absent from a line written before ticks were kept. */
  ticks?: LineTick[];
  /** The plugin version the tick ran. */
  plugin: string | null;
  /** The host's IANA time zone, which a server on a copy of the database may not share. */
  timeZone?: string;
  accounts: LineAccount[];
  /** The account of the last launch, which the next admission rotates from; `null` before any. */
  lastAccount: string | null;
  sessions: LineSession[];
  needs: LineNeed[];
  queue: LineQueued[];
  /** The converged pull requests the board read placed, Ready to merge first in its order; absent from a line written before the board read. */
  ready?: LineReady[];
  /** The host's load as the tick read it, and what it held or would hold; absent from a line written before the load factor. */
  load?: LineLoad;
  repos: LineRepo[];
}

/** `GET /state`. */
export interface StateAnswer {
  /** The server's clock, so ages hold on a device whose clock is off. */
  now: string;
  /** The host's IANA time zone, in which every time on the page is shown: the tick's, else the server's own. */
  timeZone: string;
  /** The server's plugin version and the database's schema. */
  plugin: string | null;
  schema: number;
  /** `null` until a tick from the machine file has written one. */
  line: LineSnapshot | null;
}

/** The windows the page names. `range` is `from` and `to`. */
export type WindowName = "today" | "yesterday" | "7d" | "30d" | "range";

/** A bad class that recurs on one stage of a repository: on at least three of the last seven host days (`recurring.ts`). */
export interface RecurringClass {
  class: string;
  repo: string;
  stage: string;
  /** Whether it occurred each host day, the oldest first, seven entries. */
  nights: boolean[];
  /** How many rows over those seven days. */
  rows: number;
}

/** `GET /rows`. */
export interface RowsAnswer {
  window: WindowName;
  from: string;
  to: string;
  /** Rows the filter keeps per class, ignoring the class filter so another class can still be chosen. */
  counts: Record<string, number>;
  /** Rows the whole filter keeps. */
  total: number;
  /** The newest rows of those, at most `MAX_ROWS`, newest first. */
  rows: LogRow[];
  truncated: boolean;
  /** The values each filter takes in the window. */
  options: {
    repo: string[];
    stage: string[];
    account: string[];
    class: string[];
  };
  /** Bad classes that recur per repository and stage, over the seven host days to now, whatever the window. */
  recurring: RecurringClass[];
  /** Whether the log holds any row at all, in any window. */
  logHasRows: boolean;
}

/** What a read answers with: the value, or a coded failure and a reason for a person. */
export type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; failure: { code: string; reason: string } };
