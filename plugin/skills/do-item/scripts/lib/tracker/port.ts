/**
 * The issue-tracker port: what the issue-pickup and PR-drive skills ask of an
 * issue tracker, independent of which tracker answers.
 *
 * Callers depend on this interface only. An adapter (one per tracker: Linear
 * in `linear.ts`, GitHub Issues in `github/`, Jira Cloud in `jira/`) implements it, and `index.ts`
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

// ── Issue facets ───────────────────────────────────────────────────────────

/**
 * The facts every issue carries beside its labels: what kind of work it is,
 * how soon it matters and how much work it is (design/tracker-facets.md in
 * the Jig repository). The interface holds each as a canonical value; where
 * the tracker keeps it (its store) is configuration, `issue_tracker.facets`.
 */
export const FACETS = ["type", "priority", "size"] as const;

export type Facet = (typeof FACETS)[number];

/**
 * An issue's facets. `type` is a type name of the repository's label
 * taxonomy (or, with none, a work type) and `size` a label of its size
 * group, each `null` for none; `priority` is 0 (none), then 1 (urgent) to 4
 * (low).
 */
export interface FacetValues {
  type: string | null;
  priority: number;
  size: string | null;
}

/** One issue with what issue pickup reads off it. */
export interface Issue extends FacetValues {
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
   * has none or the tracker has no issue types (Linear). Read-only: the type
   * facet (`type`) is the value callers decide with.
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
  /** The type facet; `null` = none. */
  type: string | null;
  /** The size facet; `null` = none. */
  size: string | null;
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

/**
 * Who made an issue's current assignment, as `assignedBy` reads it from the
 * tracker's history. `trusted` is set when that user may start work on the
 * team's issues: a non-guest member of the team (Linear), or someone with
 * write access to the repository (GitHub).
 */
export interface Assigner {
  id: string;
  name: string;
  trusted: boolean;
}

/** A user of the tracker: its own id, and the name it shows (a GitHub login, a Linear or Jira display name). */
export interface TrackerUser {
  id: string;
  name: string;
}

/** Which open issues a pool holds, by label and by facet. */
export interface PoolQuery {
  /** Each list must match: the issue carries at least one label of each. */
  withSomeOf: string[][];
  /** The issue carries none of these labels. */
  withNoneOf?: string[];
  /**
   * Narrowed by facet, wherever each is kept: `oneOf` keeps an issue whose
   * value of each facet named is in its list; `missing` keeps an issue that
   * has no value for at least one facet listed.
   */
  facets?: {
    oneOf?: Partial<Record<"type" | "size", string[]>>;
    missing?: Facet[];
  };
}

/** Which page of the incomplete open issues `incompleteIssues` reads. */
export interface IncompleteQuery {
  /** The facets an issue must carry; one lacking any of them is incomplete. */
  missing: Facet[];
  /** Labels a facet's store has retired; an issue carrying one is listed too. */
  retired: string[];
  /** The cursor a previous page returned; absent for the first page. */
  after?: string | null;
  /** The most issues one page holds, 1 to 100. */
  limit: number;
}

/** An open issue `incompleteIssues` lists, by key, never by its content. */
export interface IncompleteIssue {
  identifier: string;
  url: string | null;
  state: IssueState;
  /** The listed facets it has no value for. */
  missing: Facet[];
  /** The retired labels it carries. */
  retired: string[];
}

/**
 * One page of `incompleteIssues`, and the tracker's counts over every open
 * issue outside triage, never over the page: per facet, how many must carry
 * it (an epic is not counted for size) and how many of those lack it.
 */
export interface IncompletePage {
  issues: IncompleteIssue[];
  /** The cursor of the next page; `null` after the last. */
  next: string | null;
  counts: Partial<Record<Facet, { required: number; lacking: number }>>;
}

/** Where a tracker keeps a facet. */
export type FacetStoreKind = "native" | "field" | "label";

/**
 * How long a facet read may run, and how its caller stops it: an aborted
 * `signal`, or a `deadline` passed, ends the request in flight, starts no
 * further request or page, and fails the read.
 */
export interface FacetReadOptions {
  signal?: AbortSignal;
  /** Epoch milliseconds. */
  deadline?: number;
  /** `facetStores` only: read the organization's issue types and fields; default true. */
  discovery?: boolean;
}

/** One facet's store as `facetStores` reports it. */
export interface FacetStoreReport {
  facet: Facet;
  /** `null` when the repository has no such facet (no size group). */
  store: FacetStoreKind | null;
  /**
   * Why: named by `issue_tracker.facets` (`configured`); kept in labels by
   * one of today's keys or by the labels its issues carry (`kept in
   * labels`); selected by the GitHub default from what detection read
   * (`detected`); the adapter's default; or in `conflict`, with labels and
   * native values both present and no store named, so its reads and writes
   * fail closed (`store` is then `null`, and `problem` names both stores).
   */
  why:
    | "configured"
    | "kept in labels"
    | "detected"
    | "default"
    | "conflict"
    | "no facet";
  /** The field a `field` store keeps the facet in; native priority on GitHub is its `Priority` field. */
  field?: string;
  /** The canonical values, and the tracker value or label each is kept as. */
  values?: Record<string, string>;
  /**
   * A configured native or field store: whether it resolves with the access
   * its own reads and writes use. A failed store fails its reads and writes.
   */
  health?: { status: "ok" } | { status: "failed"; error: string };
  /** What detection saw for a facet whose store is not named; it chooses nothing. */
  detection?: FacetDetection;
  /** The configuration line that names the store in force, for a facet that does not name one. */
  pin?: string;
  /**
   * For a facet kept in labels: the tracker's own field it could move to,
   * from detection or the organization's discovery; `null` for none.
   */
  moveTo?: { store: FacetStoreKind; field?: string } | null;
  /** Why the facet cannot be read or written, such as a taxonomy that fails its lint. */
  problem?: string;
}

/**
 * Detection's evidence for one facet: whether issues carry its labels, or a
 * value in the tracker's own field, and the field the repository could move
 * to. A read that failed is an error, never an absent field.
 */
export type FacetDetection =
  | {
      status: "read";
      labelEvidence: boolean;
      nativeEvidence: boolean;
      /** The store the facet could move to, or `null` for none. */
      candidate: { store: FacetStoreKind; field?: string } | null;
      /** Why the tracker's own field does not qualify, when it does not. */
      candidateProblem?: string;
      /** What the GitHub default selects from this evidence. */
      wouldSelect: FacetStoreKind | "conflict";
      /** Whether this answer came from the machine-local detection cache. */
      cached?: boolean;
    }
  | { status: "failed"; error: string; unavailable: boolean };

/** Every facet's store, and what the tracker's organization offers. */
export interface FacetStores {
  facets: FacetStoreReport[];
  /**
   * The optional read of the organization's issue types and fields. Denied,
   * it is `unavailable` and fails nothing.
   */
  discovery:
    | {
        status: "read";
        credential: string;
        issueTypes: string[];
        fields: Array<{ name: string; dataType: string; options: string[] }>;
      }
    | { status: "unavailable"; credential: string; error: string }
    | { status: "none"; reason: string };
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
 * (low). `type` and `size` are facet values, written to the store each is
 * kept in. `parent` is an issue key; `project` a project's name.
 */
export interface NewIssue {
  title: string;
  description: string;
  labels: string[];
  type?: string;
  priority?: number;
  size?: string;
  parent?: string;
  project?: string;
}

/**
 * A change to an existing issue; an absent field stays as it is. `parent:
 * null` removes the parent, and `type: null` or `size: null` the facet's
 * value. Labels are added and removed by name, the rest of the issue's labels
 * kept.
 */
export interface IssuePatch {
  title?: string;
  description?: string;
  type?: string | null;
  priority?: number;
  size?: string | null;
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
  /**
   * This team's issues assigned to `identity` (a GitHub login; a Linear
   * user's email or display name) in one of `states`. An empty `states`
   * throws, since it would read no state the caller meant. `options` bound
   * the settlement of the facets the read waits on, as for `facetStores`.
   */
  assignedIssues(
    identity: string,
    states: ReadonlyArray<CanonicalState>,
    options?: FacetReadOptions,
  ): Promise<PoolIssue[]>;
  /**
   * Who made the assignment of `assignee` (default: the issue's current
   * assignee) to the issue, from the tracker's history. Throws with the
   * reason when the history cannot be read in full or holds no such
   * assignment, so an unknown assigner is never read as a trusted one.
   */
  assignedBy(key: string, assignee?: string): Promise<Assigner>;
  /**
   * One page of this team's open issues not in triage and not yet started
   * that lack a value for a facet of `missing` (no size asked of an epic) or
   * carry a `retired` label, oldest first, with the cursor of the next page
   * and the counts over every open issue outside triage. The one read that
   * returns part of a population on purpose: a started issue is never
   * listed. Throws on an unknown facet, a facet the repository has no store
   * for, or a `limit` outside 1 to 100.
   */
  incompleteIssues(
    query: IncompleteQuery,
    options?: FacetReadOptions,
  ): Promise<IncompletePage>;

  // ── Facets ──
  /**
   * Where each facet is kept and why, each configured native or field
   * store's health, and what detection and the organization's discovery
   * saw. A failed read is reported in its place; this report never moves a
   * facet to another store. `discovery: false` skips the organization read.
   */
  facetStores(options?: FacetReadOptions): Promise<FacetStores>;

  // ── Claiming ──
  /** The user this tracker's credential acts as: who "yourself" is. */
  viewer(): Promise<TrackerUser>;
  /** Every user the issue is assigned to; empty when nobody. */
  assignees(key: string): Promise<TrackerUser[]>;
  /** Assign the issue to `user` alone, replacing any other assignee. */
  assign(key: string, user: TrackerUser): Promise<void>;
  /**
   * The user an identity names, in the form `dispatch.identity` takes (a
   * GitHub login; a Linear user's email or display name; a Jira account
   * id, or an email or display name that matches one user). Throws a
   * `TrackerRequestError` (`unresolved`) when it names no user or several.
   */
  user(identity: string): Promise<TrackerUser>;

  // ── Filing and planning ──
  /**
   * File an issue in this team. Throws before writing anything when a label,
   * the parent or the project does not resolve to exactly one tracker
   * resource, the priority is not an integer from 0 to 4, or a type or size
   * is no value of its facet or names nothing in the facet's store.
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
