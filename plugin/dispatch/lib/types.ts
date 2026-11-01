/**
 * What one tick reads, plans and reports. Every record is read fresh each
 * tick; nothing here is kept between ticks except what the receipt says.
 */

/** The records a tick reads, by who owns them. */
export type RecordName = "tracker" | "forge" | "runtime";

/** The stages a tick can start, as the plan names them. */
export type Stage = "pickup" | "rearm" | "followup" | "notify" | "steer";

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
  /** How long a follow-up may run before it has ended. */
  followupWithinMs: number;
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
}

/** How a drive ledger reads, per the design's ledger-to-class table. */
export type LedgerClass =
  | "driven"
  | "silent"
  | "done"
  | "stopped-by-person"
  | "stopped-unknown"
  | "re-armable"
  | "parked"
  | "refused"
  | "needs-person"
  | "unplaced";

/** How a pickup that needs nothing reads: its last session ended, or its claimed item is idle but not yet stalled. */
export type PickupClass = "pickup-ended" | "claimed-idle" | "claimed";

/** How a merged pull request whose follow-up needs nothing reads: done, or held by a run a person started. */
export type FollowupClass = "followup-done" | "followup-held";

/** A parked decision still waiting on its answer, as the drive framed it. */
export interface WaitingPark {
  key: string;
  kind: "thread" | "finding";
  /** The framed decision, as the drive prints it (`framedDecisionLines`). */
  lines: string[];
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
}

/** One pull request merged since the follow-up stage's start. */
export interface MergedPr {
  number: number;
  url: string;
  title: string;
  head: string;
  mergedAt: string;
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
   * `tick`: posted by a tick, naming its launch record; `manual`: posted by
   * a follow-up a person ran, carrying its own outcome; `unreadable`: a
   * marker whose body this reader cannot read.
   */
  run:
    | { kind: "tick"; record: string }
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
  | "drifting"
  | "nudge-unanswered";

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
}

/** What `--apply` did with one planned launch. */
export interface LaunchOutcome {
  target: string;
  action: "rearm" | "takeover" | "pickup" | "followup";
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
}

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
}

/** How one record read for one repository. */
export interface RecordRead {
  record: RecordName;
  source: string;
  ok: boolean;
  detail: string;
}

/** One repository's part of a tick's report. */
export interface RepoReport {
  path: string;
  slug: string | null;
  /** Set when the repository could not be dispatched at all. */
  refused: string | null;
  section: DispatchSection | null;
  followupSince: string | null;
  records: RecordRead[];
  actions: Action[];
  running: Running[];
  unplaced: Unplaced[];
  /** What `--apply` launched, retried or held back; empty without it. */
  launches: LaunchOutcome[];
  /** What `--apply` notified, where the machine file enables `notify`; empty otherwise. */
  notifications: NotifyOutcome[];
  /** What `--apply` nudged, where the machine file enables `steer`; empty otherwise. */
  steers?: SteerOutcome[];
  /** Targets that need nothing from the tick, by class: a pull request's ledger class, a pickup's, or a follow-up's. */
  quiet: Array<{
    target: string;
    class: LedgerClass | PickupClass | FollowupClass;
    why: string;
  }>;
}
