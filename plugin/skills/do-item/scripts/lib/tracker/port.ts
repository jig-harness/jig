/**
 * The issue-tracker port: what the issue-pickup and PR-drive skills ask of an
 * issue tracker, independent of which tracker answers.
 *
 * Callers depend on this interface only. An adapter (one per tracker; Linear
 * today, in `linear.ts`) implements it, and `index.ts` picks the adapter the
 * consumer names in `issue_tracker.adapter`. Adding a tracker means adding an
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
  /** The human key, `<TEAM>-<n>`. */
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  updatedAt?: string;
  state: IssueState;
  labels: string[];
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

/** A started issue of a label (an epic) and the last activity on each child. */
export interface StartedIssueActivity {
  epic: string;
  startedAt: string;
  children: Array<{ issue: string; updatedAt: string }>;
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
}

export interface Tracker {
  /** The adapter name, as `issue_tracker.adapter` spells it. */
  readonly adapter: string;
  /** The team key issue identifiers carry (`<TEAM>-<n>`). */
  readonly team: string;
  /** The tracker's own name for a canonical state. */
  stateName(state: CanonicalState): string;

  // ── Issue pickup ──
  /** One issue with its labels and children; `null` when it does not exist. */
  getIssue(key: string): Promise<Issue | null>;
  /** Every comment on an issue, oldest first. */
  listComments(key: string): Promise<IssueComment[]>;
  /** Every child of an issue. */
  listChildren(key: string): Promise<IssueSummary[]>;
  /** Move an issue to a canonical state. */
  transition(key: string, state: CanonicalState): Promise<void>;
  /** Post a comment. `issue` is a key or the tracker's own id. */
  postComment(issue: string, body: string): Promise<void>;

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
  /** Every issue of a label, with its state. */
  labelledIssues(label: string): Promise<LabelledIssueState[]>;
}
