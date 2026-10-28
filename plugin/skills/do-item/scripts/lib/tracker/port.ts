/**
 * The issue-tracker port: what the issue-pickup and PR-drive skills ask of an
 * issue tracker, independent of which tracker answers.
 *
 * Callers depend on this interface only. An adapter (one per tracker: Linear
 * in `linear.ts`, GitHub Issues in `github/`) implements it, and `index.ts`
 * picks the adapter the consumer names in `issue_tracker.adapter`. Adding a tracker means adding an
 * adapter and registering it; no caller changes.
 *
 * Every read either returns what it was asked for or throws with a reason. A
 * shorter population is never presented as complete: the fleet metrics built
 * on these reads would otherwise report a partial read as an improvement.
 */

/**
 * The workflow states the skills reason about, by role rather than by the
 * tracker's own name. `issue_tracker.states` maps each to the tracker's name.
 */
export const CANONICAL_STATES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "ops_pending",
  "done",
  "canceled",
  "duplicate",
] as const;

/** The state categories of an issue that is not finished: triaged, waiting or in progress. */
export const OPEN_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
] as const;

export type CanonicalState = (typeof CANONICAL_STATES)[number];

/**
 * A workflow state as the tracker reports it: its display name and its
 * category. Categories follow the common tracker vocabulary: `triage`,
 * `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`.
 * An empty `type` means the tracker reported no category.
 */
export interface IssueState {
  name: string;
  type: string;
}

/** A related issue as a listing returns it (a child, a parent). */
export interface IssueSummary {
  identifier: string;
  title: string;
  state: IssueState;
  /** Absent when the listing does not carry labels. */
  labels?: string[];
}

/** One issue with what issue pickup reads off it. */
export interface Issue {
  /** The tracker's own id (may equal `identifier`). */
  id: string;
  /** The human key: `<TEAM>-<n>` on Linear, `#<n>` on GitHub (`keys.ts`). */
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  updatedAt?: string;
  state: IssueState;
  labels: string[];
  /**
   * The tracker's own type for the issue (GitHub's issue types: `Bug`,
   * `Feature`, `Task`, or an organization's own), or `null` when the issue
   * has none or the tracker has no issue types (Linear).
   */
  nativeType: string | null;
  parent: { identifier: string; title?: string } | null;
  children: IssueSummary[];
  assignee: string | null;
  project: string | null;
}

export interface IssueComment {
  body: string;
  createdAt?: string;
}

// ── Facts the fleet metrics read ───────────────────────────────────────────

/** A window of time, half-open: `[sinceMs, untilMs)`. */
export interface WindowSpec {
  sinceMs: number;
  untilMs: number;
}

/** An issue with its parent chain, for epic attribution and follow-up walks. */
export interface IssueFact {
  /** The human key. */
  id: string;
  title: string;
  labels: string[];
  createdAt: string;
  completedAt: string | null;
  stateType: string;
  description: string;
  /** Parent chain, nearest first. */
  ancestors: Array<{ id: string; labels: string[] }>;
}

export interface CommentFact {
  body: string;
  createdAt: string;
  /**
   * The author is a real, non-guest member of the tracker workspace. Only a
   * trusted comment may carry a marker the metrics act on: anyone able to
   * comment could otherwise post a marker-shaped line.
   */
  trusted: boolean;
}

/** A comment found by a text search, with the issue it sits on. */
export interface FoundComment extends CommentFact {
  issue: string;
}

/** Every comment on one issue, and the tracker id to post a reply to. */
export interface IssueComments {
  uuid: string;
  comments: CommentFact[];
}

/**
 * A started issue of a label (an epic), who and what it belongs to, and the
 * state and last activity of each child.
 */
export interface StartedIssueActivity {
  epic: string;
  startedAt: string;
  /** The tracker project the epic sits in; `null` = none. */
  project: string | null;
  /** The epic's assignee; `null` = nobody. */
  assignee: string | null;
  labels: string[];
  children: Array<{ issue: string; updatedAt: string; stateType: string }>;
}

/** An issue in a debt ledger. */
export interface LedgerIssue {
  identifier: string;
  createdAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  stateType: string;
  /** 0 = none, then 1 (urgent) to 4 (low). */
  priority: number;
  parent: string | null;
  project: string | null;
  labels: string[];
  /** Nested lists the read could not take in full; non-empty means partial. */
  truncated: string[];
}

/** The state of one labelled issue (an epic), for completion counts. */
export interface LabelledIssueState {
  identifier: string;
  stateType: string;
  completedAt: string | null;
  /** The issue body; present only when the read asked for it. */
  description?: string | null;
}

// ── Candidate pools ────────────────────────────────────────────────────────

/** The state categories of an issue that is finished one way or another. */
export const CLOSED_STATE_TYPES = [
  "completed",
  "canceled",
  "duplicate",
] as const;

/**
 * An issue as a candidate pool reads it: what deciding whether it may join a
 * batch, and ranking it, takes. Ids sit beside names because a name can be
 * renamed or shared (two people with one display name, several workflow
 * states of one category), and a claim re-check compares ids.
 */
export interface PoolIssue {
  identifier: string;
  title: string;
  url: string | null;
  /** 0 = none, then 1 (urgent) to 4 (low). */
  priority: number;
  createdAt: string;
  state: IssueState & { id: string };
  assignee: { id: string; name: string } | null;
  labels: string[];
  /** The issue has at least one child that is not closed. */
  hasOpenChildren: boolean;
  /**
   * Nested lists the read could not take in full; non-empty means partial.
   * `labels` here means a label the caller tests for may be missing.
   */
  truncated: string[];
}

/** Which open issues a pool holds, by label. */
export interface PoolQuery {
  /** Each list must match: the issue carries at least one label of each. */
  withSomeOf: string[][];
  /** The issue carries none of these labels. */
  withNoneOf?: string[];
}

// ── Filing and planning ────────────────────────────────────────────────────

/**
 * A request refused before anything is written: input the operation cannot
 * take (`invalid`), or a name that resolves to no tracker resource or to
 * several (`unresolved`). Every adapter throws it for the same causes, so a
 * caller tells its own mistake from a tracker that failed.
 */
export class TrackerRequestError extends Error {
  // A declared field, not a parameter property: the repository's TypeScript
  // settings allow erasable syntax only.
  readonly code: "invalid" | "unresolved";
  constructor(code: "invalid" | "unresolved", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A new issue of this team. Labels are named; the adapter resolves each to
 * exactly one tracker label. `priority`: 0 = none, then 1 (urgent) to 4
 * (low). `parent` is an issue key; `project` a project's name.
 */
export interface NewIssue {
  title: string;
  description: string;
  labels: string[];
  priority?: number;
  parent?: string;
  project?: string;
}

/**
 * A change to an existing issue; an absent field stays as it is. `parent:
 * null` removes the parent. Labels are added and removed by name, the rest
 * of the issue's labels kept.
 */
export interface IssuePatch {
  title?: string;
  description?: string;
  priority?: number;
  parent?: string | null;
  project?: string;
  addLabels?: string[];
  removeLabels?: string[];
}

/** The relations an issue can be given to another. */
export const RELATION_TYPES = ["blocks", "related", "duplicate"] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * One relation of an issue, seen from that issue: `blocks` it blocks
 * `issue`, `blocked_by` `issue` blocks it; `duplicate` it is a duplicate of
 * `issue`, `duplicated_by` `issue` is a duplicate of it; `related` links the
 * two in either direction.
 */
export interface IssueRelation {
  type: RelationType | "blocked_by" | "duplicated_by";
  /** The other issue's key. */
  issue: string;
}

/** A label an issue can carry, with the group it belongs to; `null` = none. */
export interface TrackerLabel {
  name: string;
  group: string | null;
}

/**
 * One tracker as the skills use it. "This team" below is where the
 * configured issues live: a Linear team, or one GitHub repository.
 */
export interface Tracker {
  /** The adapter name, as `issue_tracker.adapter` spells it. */
  readonly adapter: string;
  /**
   * Where the issues live, for messages: the team key on Linear, the
   * repository (`owner/name`) on GitHub.
   */
  readonly team: string;
  /** The tracker's own name for a canonical state. */
  stateName(state: CanonicalState): string;
  /**
   * Resolves when the tracker answers for this team: the credential works and
   * the team (Linear) or repository (GitHub) exists. Reads no issue. An
   * aborted `signal` ends the request in flight.
   */
  reach(signal?: AbortSignal): Promise<void>;

  // ── Issue pickup ──
  /** One issue with its labels and children; `null` when it does not exist. */
  getIssue(key: string): Promise<Issue | null>;
  /** Every comment on an issue, oldest first. */
  listComments(key: string): Promise<IssueComment[]>;
  /** Every child of an issue. */
  listChildren(key: string): Promise<IssueSummary[]>;
  /** Move an issue to a canonical state. */
  transition(key: string, state: CanonicalState): Promise<void>;
  /**
   * Post a comment. `issue` is a key or the tracker's own id. An aborted
   * `signal` ends the request in flight and starts no further one.
   */
  postComment(issue: string, body: string, signal?: AbortSignal): Promise<void>;

  // ── Fleet metrics ──
  /** Issues of this team named by key; a key that resolves to nothing is absent. */
  issuesByKeys(keys: ReadonlyArray<string>): Promise<Map<string, IssueFact>>;
  /** Issues created (or completed) in a window, optionally of one label. */
  issuesInWindow(query: {
    label?: string;
    createdIn?: WindowSpec;
    completedIn?: WindowSpec;
  }): Promise<IssueFact[]>;
  /** Every started issue of a label, with each child's last update. */
  startedIssueActivity(
    label: string,
    signal?: AbortSignal,
  ): Promise<StartedIssueActivity[]>;
  /** Comments containing `text`, on this team's issues of a label, created in a window. */
  commentsContaining(query: {
    text: string;
    issueLabel: string;
    createdIn: WindowSpec;
  }): Promise<FoundComment[]>;
  /** Every comment on one issue, with its trust, and the issue's tracker id. */
  issueComments(key: string): Promise<IssueComments>;
  /**
   * The issues carrying `label`, or (when given) in `project`: the union, one
   * population. Throws when the label or project does not resolve to exactly
   * one tracker resource, since a mistyped name would silently halve it.
   */
  ledger(
    query: { label: string; project?: string },
    onPage?: (fetched: number) => void,
  ): Promise<LedgerIssue[]>;
  /**
   * Every issue of a label, with its state, and its description when
   * `withDescription` is set. An aborted `signal` ends the read in flight and
   * starts no further page.
   */
  labelledIssues(
    label: string,
    signal?: AbortSignal,
    withDescription?: boolean,
  ): Promise<LabelledIssueState[]>;

  // ── Candidate pools ──
  /**
   * This team's open issues matching `query`. Throws on an empty label list,
   * which would otherwise widen the pool to every open issue.
   */
  openIssues(query: PoolQuery): Promise<PoolIssue[]>;
  /** The open children, of this team, of one of this team's issues. */
  openChildren(key: string): Promise<PoolIssue[]>;
  /** One issue in pool form, whatever its state; `null` when it does not exist. */
  poolIssue(key: string): Promise<PoolIssue | null>;

  // ── Filing and planning ──
  /**
   * File an issue in this team. Throws before writing anything when a label,
   * the parent or the project does not resolve to exactly one tracker
   * resource, or the priority is not an integer from 0 to 4.
   */
  createIssue(
    issue: NewIssue,
  ): Promise<{ identifier: string; url: string | null }>;
  /** Change an issue. Throws on an empty patch, and as `createIssue` does. */
  updateIssue(key: string, patch: IssuePatch): Promise<void>;
  /** Every label an issue of this team can carry. */
  listLabels(): Promise<TrackerLabel[]>;
  /**
   * This team's issues whose title or description contains `text`, ignoring
   * case; open ones only unless `includeClosed` is set. A tracker whose
   * search matches words (GitHub) returns what its search matches.
   */
  searchIssues(
    text: string,
    opts?: { includeClosed?: boolean },
  ): Promise<IssueSummary[]>;
  /** Every relation of an issue, in both directions. */
  listRelations(key: string): Promise<IssueRelation[]>;
  /**
   * Record that `key` blocks `target`, relates to it, or is a duplicate of
   * it; for `duplicate`, `key` is the duplicate and `target` the issue that
   * stays, and the tracker may close `key`.
   */
  relate(key: string, type: RelationType, target: string): Promise<void>;
}
