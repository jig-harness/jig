/**
 * The GitHub store's operations over a repository: reading every event from
 * the comments of every issue carrying the store's label, appending events
 * to their change's issue, recomputing each issue's title and description,
 * and reporting what disagrees with the events.
 *
 * Only a comment whose author can write to the repository (an owner,
 * member or collaborator) is read as a record: an event-shaped comment by
 * anyone else is ignored, and `diagnose` reports it.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import {
  changeKey,
  changeKeyOf,
  eventsOn,
  planFindingsFirst,
  winnersOf,
} from "../change-view.ts";
import {
  computeState,
  type ComputedState,
  type DecisionEvent,
  distinctById,
  idConflicts,
  parseEvent,
  type ReflectionEvent,
} from "../events.ts";
import { type GitHubClient, GitHubApiError } from "./api.ts";
import {
  type Comment,
  commentsFor,
  isStoreComment,
  issueView,
  keyInBody,
  recordsIn,
  STORE_LABEL,
  UNFILED_KEY,
} from "./model.ts";
import { type Repository, stringOr } from "./repository.ts";

/** Author associations of people who can write to the repository. */
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Issues per page; each brings its first `COMMENT_PAGE` comments along. */
const ISSUE_PAGE = 25;
const COMMENT_PAGE = 25;

type Line = { event: ReflectionEvent; text: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One event's copy, where the store holds it. */
export interface Copy {
  id: string;
  text: string;
  event: ReflectionEvent;
  issue: string;
  /** The comment's link. */
  ref: string;
}

/** A store comment by someone who cannot write to the repository. */
export interface Ignored {
  ref: string;
  author: string | null;
  association: string;
}

export interface IssueRead {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  created: string;
  /** Its author can write to the repository. */
  trusted: boolean;
  /** The change its description names; only a trusted issue's counts. */
  key: string | null;
  /** In comment order. */
  copies: Copy[];
  ignored: Ignored[];
}

const COMMENT_FIELDS = `nodes { id url body authorAssociation author { login } }
      pageInfo { hasNextPage endCursor }`;

const ISSUES_QUERY = `query JigReflectionIssues($owner: String!, $name: String!, $labels: [String!], $first: Int!, $comments: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, labels: $labels, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id number url title body createdAt authorAssociation
        comments(first: $comments) {
      ${COMMENT_FIELDS}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const COMMENTS_QUERY = `query JigReflectionComments($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on Issue {
      comments(first: $first, after: $after) {
      ${COMMENT_FIELDS}
      }
    }
  }
}`;

/** The value at `path` in GitHub's data. */
function at(data: unknown, path: readonly string[]): unknown {
  let value = data;
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return value;
}

function picker(path: readonly string[]) {
  return (data: Record<string, unknown>): unknown => at(data, path);
}

/** Whether a connection says more follows, or null when it is malformed. */
function hasMore(connection: unknown): boolean | null {
  const more = at(connection, ["pageInfo", "hasNextPage"]);
  return typeof more === "boolean" ? more : null;
}

/** The first page of comments an issue came with, and whether more follow. */
function firstComments(
  issue: Record<string, unknown>,
  where: string,
): { nodes: unknown[]; more: boolean } {
  const nodes = at(issue, ["comments", "nodes"]);
  const more = hasMore(issue.comments);
  if (more === null || !Array.isArray(nodes))
    throw new GitHubApiError(`${where}: unexpected comments shape`);
  return { nodes, more };
}

/** Every comment of an issue: the first page it came with, or all pages. */
async function commentsOf(
  client: GitHubClient,
  issue: Record<string, unknown>,
  where: string,
): Promise<unknown[]> {
  const first = firstComments(issue, where);
  if (!first.more) return first.nodes;
  return client.readAll(
    COMMENTS_QUERY,
    { id: issue.id, first: COMMENT_PAGE },
    picker(["node", "comments"]),
    `the comments of ${where}`,
  );
}

interface CommentRead {
  body: string;
  ref: string;
  association: string;
  author: string | null;
}

function commentOf(node: Record<string, unknown>, where: string): CommentRead {
  const author = at(node, ["author", "login"]);
  return {
    body: stringOr(node.body, ""),
    ref: stringOr(node.url, where),
    association: stringOr(node.authorAssociation, "NONE"),
    author: typeof author === "string" ? author : null,
  };
}

/** A comment's record lines; one cut short fails the read, naming it. */
function recordsOf(comment: CommentRead): string[] {
  try {
    return recordsIn(comment.body) ?? [];
  } catch (error) {
    throw new GitHubApiError(`${comment.ref} holds ${messageOf(error)}`);
  }
}

function eventOf(text: string, ref: string): ReflectionEvent {
  try {
    return parseEvent(text);
  } catch (error) {
    throw new GitHubApiError(
      `${ref} holds a record that is not a reflection event: ${messageOf(error)}`,
    );
  }
}

function copiesIn(comment: CommentRead, issue: string): Copy[] {
  return recordsOf(comment).map((text) => {
    const event = eventOf(text, comment.ref);
    return { id: event.id, text, event, issue, ref: comment.ref };
  });
}

/** Take a comment in: its records when its author is trusted. */
function takeComment(issue: IssueRead, node: unknown): void {
  if (!isRecord(node)) return;
  const comment = commentOf(node, issue.url);
  if (TRUSTED.has(comment.association))
    issue.copies.push(...copiesIn(comment, issue.id));
  else if (isStoreComment(comment.body))
    issue.ignored.push({
      ref: comment.ref,
      author: comment.author,
      association: comment.association,
    });
}

function issueOf(node: unknown): IssueRead {
  if (!isRecord(node) || typeof node.id !== "string")
    throw new GitHubApiError("GitHub returned an issue without an id");
  const body = stringOr(node.body, "");
  const trusted = TRUSTED.has(stringOr(node.authorAssociation, ""));
  return {
    id: node.id,
    number: Number(node.number),
    url: stringOr(node.url, node.id),
    title: stringOr(node.title, ""),
    body,
    created: stringOr(node.createdAt, ""),
    trusted,
    key: trusted ? keyInBody(body) : null,
    copies: [],
    ignored: [],
  };
}

async function readIssue(
  client: GitHubClient,
  node: unknown,
): Promise<IssueRead> {
  const issue = issueOf(node);
  const comments = await commentsOf(
    client,
    node as Record<string, unknown>,
    issue.url,
  );
  for (const comment of comments) takeComment(issue, comment);
  return issue;
}

/**
 * Every issue carrying the store's label, open or closed, and every record
 * in its comments, through the repository's issue listing read page by page
 * to its end: never a search, whose results stop at a thousand.
 */
export async function readStore(
  client: GitHubClient,
  repo: Repository,
): Promise<IssueRead[]> {
  const nodes = await client.readAll(
    ISSUES_QUERY,
    {
      owner: repo.owner,
      name: repo.name,
      labels: [STORE_LABEL],
      first: ISSUE_PAGE,
      comments: COMMENT_PAGE,
    },
    picker(["repository", "issues"]),
    `the ${STORE_LABEL} issues of ${repo.nameWithOwner}`,
  );
  const issues: IssueRead[] = [];
  for (const node of nodes) issues.push(await readIssue(client, node));
  return issues;
}

export function allCopies(issues: readonly IssueRead[]): Copy[] {
  return issues.flatMap((issue) => issue.copies);
}

/** Older first: later writes for a change go to its oldest issue. */
function byAge(a: IssueRead, b: IssueRead): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.number - b.number;
}

/** The change an issue holds: the one its description names, else its findings'. */
function keyOf(issue: IssueRead): string {
  return issue.key ?? changeKeyOf(issue.copies, UNFILED_KEY);
}

// ── Appending ───────────────────────────────────────────────────────────────

/** An issue an append writes to: one the store holds, or one it creates. */
interface Target {
  key: string;
  issue: IssueRead | null;
  /** Created by this append: its id, link and the view it was created with. */
  created: { id: string; url: string; title: string; body: string } | null;
  lines: Line[];
  /** The comment each event's text went into. */
  refs: Map<string, string>;
}

function newTarget(key: string, issue: IssueRead | null): Target {
  return { key, issue, created: null, lines: [], refs: new Map() };
}

type Receipt =
  | { id: string; ref: string }
  | { id: string; target: Target; text: string };

/**
 * Where each event of one append goes. Every issue the store holds is a
 * target; a change's findings go to its oldest issue opened by a writer,
 * and a decision to the issue of its finding's copy that `list` returns.
 */
class AppendPlan {
  readonly targets: Target[] = [];
  readonly receipts: Receipt[] = [];
  private readonly stored = new Map<string, Copy>();
  private readonly byKey = new Map<string, Target>();
  private readonly homes = new Map<string, { text: string; target: Target }>();
  private readonly planned = new Map<string, Target>();

  constructor(issues: readonly IssueRead[]) {
    for (const issue of [...issues].sort(byAge)) this.hold(issue);
  }

  private hold(issue: IssueRead): void {
    const target = newTarget(keyOf(issue), issue);
    this.targets.push(target);
    if (issue.trusted && !this.byKey.has(target.key))
      this.byKey.set(target.key, target);
    for (const copy of issue.copies) this.holdCopy(copy, target);
  }

  private holdCopy(copy: Copy, target: Target): void {
    this.stored.set(copy.text, copy);
    if (copy.event.type === "finding") this.settle(copy.id, copy.text, target);
  }

  /** A finding's home is the issue of its copy whose text sorts first. */
  private settle(id: string, text: string, target: Target): void {
    const known = this.homes.get(id);
    if (known === undefined || text < known.text)
      this.homes.set(id, { text, target });
  }

  /** Plan one event: one already stored, or already planned, is not written twice. */
  add(event: ReflectionEvent, text: string): void {
    const copy = this.stored.get(text);
    this.receipts.push(
      copy === undefined
        ? { id: event.id, target: this.place(event, text), text }
        : { id: event.id, ref: copy.ref },
    );
  }

  private place(event: ReflectionEvent, text: string): Target {
    const known = this.planned.get(text);
    if (known !== undefined) return known;
    const target =
      event.type === "finding"
        ? this.targetFor(changeKey(event))
        : this.decisionTarget(event);
    target.lines.push({ event, text });
    this.planned.set(text, target);
    if (event.type === "finding") this.settle(event.id, text, target);
    return target;
  }

  private targetFor(key: string): Target {
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const target = newTarget(key, null);
    this.byKey.set(key, target);
    this.targets.push(target);
    return target;
  }

  private decisionTarget(event: DecisionEvent): Target {
    return this.homes.get(event.finding)?.target ?? this.targetFor(UNFILED_KEY);
  }
}

const CREATE_ISSUE = `mutation JigReflectionCreateIssue($input: CreateIssueInput!) {
  createIssue(input: $input) { issue { id url } }
}`;

const ADD_COMMENT = `mutation JigReflectionAddComment($input: AddCommentInput!) {
  addComment(input: $input) { commentEdge { node { id url } } }
}`;

const UPDATE_ISSUE = `mutation JigReflectionUpdateIssue($input: UpdateIssueInput!) {
  updateIssue(input: $input) { issue { id } }
}`;

/** A string GitHub must have returned at `path`. */
function returned(
  data: unknown,
  path: readonly string[],
  what: string,
): string {
  const value = at(data, path);
  if (typeof value !== "string")
    throw new GitHubApiError(`GitHub did not return the ${what}`);
  return value;
}

/** Open the target's issue, with the view of the events it is opened for. */
async function createIssue(
  client: GitHubClient,
  repo: Repository,
  target: Target,
  state: ComputedState,
): Promise<string> {
  const view = issueView(
    target.key,
    target.lines.map((line) => line.event),
    state,
  );
  const data = await client.write(CREATE_ISSUE, {
    input: {
      repositoryId: repo.id,
      title: view.title,
      body: view.body,
      labelIds: [repo.labelId],
    },
  });
  target.created = {
    id: returned(data, ["createIssue", "issue", "id"], "new issue's id"),
    url: returned(data, ["createIssue", "issue", "url"], "new issue's link"),
    ...view,
  };
  return target.created.id;
}

async function addComment(
  client: GitHubClient,
  subject: string,
  comment: Comment,
  target: Target,
): Promise<void> {
  const data = await client.write(ADD_COMMENT, {
    input: { subjectId: subject, body: comment.body },
  });
  const url = returned(
    data,
    ["addComment", "commentEdge", "node", "url"],
    "new comment's link",
  );
  for (const text of comment.texts) target.refs.set(text, url);
}

/** Write one target's comments, opening its issue first when it has none. */
async function writeTarget(
  client: GitHubClient,
  repo: Repository,
  target: Target,
  stamp: string,
  state: ComputedState,
): Promise<void> {
  if (target.lines.length === 0) return;
  // Laid out before anything is written, so an event too long is refused first.
  const comments = commentsFor(target.lines, stamp);
  const subject =
    target.issue === null
      ? await createIssue(client, repo, target, state)
      : target.issue.id;
  for (const comment of comments)
    await addComment(client, subject, comment, target);
}

/** An issue whose view an append or `repair` recomputes. */
interface ToSync {
  id: string;
  url: string;
  key: string;
  ids: string[];
  /** The title and description it has now. */
  title: string;
  body: string;
}

/** The issue a target stands for, with every event it now holds. */
function syncOf(target: Target): ToSync[] {
  const added = target.lines.map((line) => line.event.id);
  const { issue, created, key } = target;
  if (issue !== null)
    return [
      {
        id: issue.id,
        url: issue.url,
        key,
        ids: [...issue.copies.map((copy) => copy.id), ...added],
        title: issue.title,
        body: issue.body,
      },
    ];
  return created === null ? [] : [{ ...created, key, ids: added }];
}

/** Update an issue's view when it differs from the computed one; whether it did. */
async function syncView(
  client: GitHubClient,
  issue: ToSync,
  winners: ReadonlyMap<string, ReflectionEvent>,
  state: ComputedState,
): Promise<boolean> {
  // An issue without records is not the store's to describe.
  if (issue.ids.length === 0) return false;
  const view = issueView(issue.key, eventsOn(issue.ids, winners), state);
  if (view.title === issue.title && view.body === issue.body) return false;
  await client.write(UPDATE_ISSUE, { input: { id: issue.id, ...view } });
  return true;
}

/**
 * Recompute the title and description of every issue whose computed view,
 * from the whole store as `list` now returns it, differs from the one it
 * has; the failures, for the caller to report.
 */
async function syncViews(
  client: GitHubClient,
  issues: readonly ToSync[],
  copies: readonly Line[],
): Promise<{ synced: number; failures: string[] }> {
  const winners = winnersOf(copies);
  const state = computeState([...winners.values()]);
  const failures: string[] = [];
  let synced = 0;
  for (const issue of issues) {
    try {
      if (await syncView(client, issue, winners, state)) synced++;
    } catch (error) {
      failures.push(`${issue.url}: ${messageOf(error)}`);
    }
  }
  return { synced, failures };
}

function receiptOf(receipt: Receipt): { id: string; ref: string } {
  return "ref" in receipt
    ? receipt
    : { id: receipt.id, ref: receipt.target.refs.get(receipt.text) ?? "" };
}

export interface AppendResult {
  stored: Array<{ id: string; ref: string }>;
  /** Issues whose view could not be recomputed; a later write does it. */
  viewFailures: string[];
}

/**
 * Append events (already checked) to the issues of their changes. An event
 * whose exact text the store already holds is not written again.
 */
export async function appendEvents(
  client: GitHubClient,
  repo: Repository,
  lines: readonly Line[],
  now: Date,
): Promise<AppendResult> {
  const issues = await readStore(client, repo);
  const plan = new AppendPlan(issues);
  planFindingsFirst(lines, (event, text) => plan.add(event, text));
  const copies = [...allCopies(issues), ...lines];
  const state = computeState([...winnersOf(copies).values()]);
  const stamp = `${now.toISOString().slice(0, 19)}Z`;
  for (const target of plan.targets)
    await writeTarget(client, repo, target, stamp, state);
  const { failures } = await syncViews(
    client,
    plan.targets.flatMap(syncOf),
    copies,
  );
  return { stored: plan.receipts.map(receiptOf), viewFailures: failures };
}

// ── Repair and diagnose ─────────────────────────────────────────────────────

/** Recompute every issue's view from the events as `list` returns them. */
export async function repair(
  client: GitHubClient,
  repo: Repository,
): Promise<{ synced: number; failures: string[] }> {
  const issues = await readStore(client, repo);
  return syncViews(
    client,
    issues.flatMap((issue) => syncOf(newTarget(keyOf(issue), issue))),
    allCopies(issues),
  );
}

/** What the store holds that disagrees with the events, one notice each. */
export async function diagnose(
  client: GitHubClient,
  repo: Repository,
): Promise<Array<Record<string, unknown>>> {
  const issues = await readStore(client, repo);
  const conflicts = [...idConflicts(allCopies(issues))].map(([id, copies]) => ({
    kind: "id-conflict",
    id,
    copies: copies.map((copy) => ({ ref: copy.ref, text: copy.text })),
  }));
  const untrusted = issues.flatMap((issue) =>
    issue.ignored.map((ignored) => ({ kind: "untrusted-record", ...ignored })),
  );
  return [...conflicts, ...untrusted];
}

/** The whole events, for `list`, with `since` applied. */
export function listOutput(
  issues: readonly IssueRead[],
  since: string | null,
): string[] {
  return distinctById(allCopies(issues))
    .filter((stored) => since === null || stored.event.at >= since)
    .map((stored) => stored.text);
}
