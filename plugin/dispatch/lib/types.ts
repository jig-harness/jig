/**
 * What one tick reads, plans and reports. Every record is read fresh each
 * tick; nothing here is kept between ticks except what the receipt says.
 */

/** The records a tick reads, by who owns them. */
export type RecordName = "tracker" | "forge" | "runtime";

/** The stages a tick can start, as the plan names them. */
export type Stage = "pickup" | "rearm" | "followup" | "notify";

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
}

/** One pull request merged since the follow-up stage's start. */
export interface MergedPr {
  number: number;
  url: string;
  title: string;
  head: string;
  mergedAt: string;
}

/** A record the tick could not read, or a part of one it cannot place. */
export interface Unplaced {
  target: string;
  record: RecordName;
  reason: string;
}

/** What a notification is about, for the causes a pickup raises. */
export type NotifyCause = "double-claim" | "stalled" | "waiting";

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
  /** For a notification a pickup raises: its cause (sending it is a later step). */
  cause?: NotifyCause;
}

/** What `--apply` did with one planned launch. */
export interface LaunchOutcome {
  target: string;
  action: "rearm" | "takeover" | "pickup";
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
  /** Targets that need nothing from the tick, by class: a pull request's ledger class, or a pickup's. */
  quiet: Array<{
    target: string;
    class: LedgerClass | PickupClass;
    why: string;
  }>;
}
