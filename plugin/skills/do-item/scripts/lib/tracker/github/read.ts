/**
 * The GraphQL fields the GitHub adapter reads off an issue, and the strict
 * parse of each node into the adapter's own record. A node of the wrong
 * shape, or a nested list that reports more than was read, throws: a list
 * read in part is never presented as whole.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import type { GitHubModel, StateInput } from "./model.ts";
import { type IssueRef, keyOf, type Repo, repoOf } from "./refs.ts";
import { GitHubApiError } from "./transport.ts";
import type { IssueSummary } from "../port.ts";

// ── Shape helpers ──────────────────────────────────────────────────────────

export function shapeError(message: string): GitHubApiError {
  return new GitHubApiError(message);
}

export function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw shapeError(`${where}: expected an object`);
  return v;
}

export function str(v: unknown, where: string): string {
  if (typeof v !== "string") throw shapeError(`${where}: expected a string`);
  return v;
}

export function optStr(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : str(v, where);
}

export function timestamp(v: unknown, where: string): string {
  const s = str(v, where);
  if (!Number.isFinite(Date.parse(s)))
    throw shapeError(`${where}: not a timestamp`);
  return s;
}

function optTimestamp(v: unknown, where: string): string | null {
  return v === null ? null : timestamp(v, where);
}

/** The nodes of a nested connection read in one page; more pages throw. */
export function onePage(v: unknown, where: string): unknown[] {
  const conn = record(v, where);
  if (!Array.isArray(conn.nodes)) throw shapeError(`${where}: nodes missing`);
  if (!isRecord(conn.pageInfo) || conn.pageInfo.hasNextPage !== false)
    throw shapeError(
      `${where}: the list is longer than one page or its pageInfo is unreadable, so it would be partial`,
    );
  return conn.nodes;
}

// ── Fields ─────────────────────────────────────────────────────────────────

export const PAGE = 100;

const LABELS = `labels(first: ${PAGE}) { pageInfo { hasNextPage } nodes { name } }`;

/** What the adapter reads of the board an issue is on, in project mode. */
export interface Board {
  url: string;
  statusField: string;
}

function boardFields(board: Board | null): string {
  if (board === null) return "";
  return `projectItems(first: 20) {
    pageInfo { hasNextPage }
    nodes {
      id updatedAt project { url }
      fieldValueByName(name: ${JSON.stringify(board.statusField)}) {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }`;
}

/** The fields of one issue the adapter reads everywhere. */
export function issueFields(board: Board | null): string {
  return `
    id number title body url createdAt updatedAt closedAt state stateReason
    repository { nameWithOwner }
    ${LABELS}
    assignees(first: 1) { nodes { id login } }
    milestone { title }
    parent { number title repository { nameWithOwner } }
    ${boardFields(board)}`;
}

/**
 * The issue's type, read only where an issue is fetched alone: GraphQL's
 * `Issue.issueType`, an `IssueType` whose `name` is the type the repository's
 * organization defines (`Bug`, `Feature`, `Task` by default), or `null` when
 * the issue has none or its owner has no issue types.
 */
export const ISSUE_TYPE = "issueType { name }";

/** The issue type's name from a node read with `ISSUE_TYPE`, or `null`. */
export function nativeTypeOf(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  return str(record(v, `${where}.issueType`).name, `${where}.issueType.name`);
}

/** The parent chain of an issue, `depth` deep, with each ancestor's labels. */
export function ancestorFields(depth: number): string {
  if (depth === 0) return "";
  return `parent { number repository { nameWithOwner } ${LABELS} ${ancestorFields(depth - 1)} }`;
}

// ── Records ────────────────────────────────────────────────────────────────

/** One issue as the adapter holds it. */
export interface GhIssue extends StateInput {
  /** GitHub's node id. */
  id: string;
  ref: IssueRef;
  key: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** The label list had more than one page. */
  labelsTruncated: boolean;
  assignee: { id: string; login: string } | null;
  milestone: string | null;
  parent: { key: string; title: string } | null;
  /** The issue's item on the board (project mode), or `null`. */
  boardItem: { id: string; updatedAt: string } | null;
}

export interface ReadContext {
  home: Repo;
  board: Board | null;
}

function refOf(raw: Record<string, unknown>, where: string): IssueRef {
  const number = raw.number;
  if (typeof number !== "number" || !Number.isInteger(number))
    throw shapeError(`${where}.number: expected an integer`);
  const repo = repoOf(
    str(
      record(raw.repository, `${where}.repository`).nameWithOwner,
      `${where}.repository.nameWithOwner`,
    ),
  );
  return { ...repo, number };
}

const sameUrl = (a: string, b: string) =>
  a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/** An issue's labels, and whether the list had more pages. */
function labelsOf(
  v: unknown,
  where: string,
): { labels: string[]; truncated: boolean } {
  const conn = record(v, `${where}.labels`);
  if (!Array.isArray(conn.nodes))
    throw shapeError(`${where}.labels: nodes missing`);
  if (
    !isRecord(conn.pageInfo) ||
    typeof conn.pageInfo.hasNextPage !== "boolean"
  )
    throw shapeError(`${where}.labels.pageInfo: unreadable`);
  return {
    labels: conn.nodes.map((l, i) =>
      str(
        record(l, `${where}.labels[${i}]`).name,
        `${where}.labels[${i}].name`,
      ),
    ),
    truncated: conn.pageInfo.hasNextPage,
  };
}

function openOf(v: unknown, where: string): boolean {
  const state = str(v, `${where}.state`);
  if (state !== "OPEN" && state !== "CLOSED")
    throw shapeError(`${where}.state: unknown state '${state}'`);
  return state === "OPEN";
}

function assigneeOf(v: unknown, where: string): GhIssue["assignee"] {
  const assignees = record(v, `${where}.assignees`);
  if (!Array.isArray(assignees.nodes))
    throw shapeError(`${where}.assignees: nodes missing`);
  if (assignees.nodes[0] === undefined) return null;
  const first = record(assignees.nodes[0], `${where}.assignee`);
  return {
    id: str(first.id, `${where}.assignee.id`),
    login: str(first.login, `${where}.assignee.login`),
  };
}

function milestoneOf(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  return str(record(v, `${where}.milestone`).title, `${where}.milestone.title`);
}

function parentOf(
  v: unknown,
  ctx: ReadContext,
  where: string,
): GhIssue["parent"] {
  if (v === null || v === undefined) return null;
  const parent = record(v, `${where}.parent`);
  return {
    key: keyOf(refOf(parent, `${where}.parent`), ctx.home),
    title: str(parent.title, `${where}.parent.title`),
  };
}

/** The issue's item on the configured board and its option there, if any. */
function boardOf(
  v: unknown,
  board: Board,
  where: string,
): { status: string | null; boardItem: GhIssue["boardItem"] } {
  for (const [i, item] of onePage(v, `${where}.projectItems`).entries()) {
    const at = `${where}.projectItems[${i}]`;
    const it = record(item, at);
    const url = str(
      record(it.project, `${at}.project`).url,
      `${at}.project.url`,
    );
    if (!sameUrl(url, board.url)) continue;
    const value = it.fieldValueByName;
    return {
      status:
        isRecord(value) && typeof value.name === "string" ? value.name : null,
      boardItem: {
        id: str(it.id, `${at}.id`),
        updatedAt: timestamp(it.updatedAt, `${at}.updatedAt`),
      },
    };
  }
  return { status: null, boardItem: null };
}

/** Parse one node read with `issueFields`. */
export function parseIssue(raw: unknown, ctx: ReadContext): GhIssue {
  const n = record(raw, "issue");
  const where = `issue ${typeof n.number === "number" ? `#${n.number}` : "?"}`;
  const ref = refOf(n, where);
  const { labels, truncated } = labelsOf(n.labels, where);
  const onBoard =
    ctx.board === null
      ? { status: null, boardItem: null }
      : boardOf(n.projectItems, ctx.board, where);
  return {
    id: str(n.id, `${where}.id`),
    ref,
    key: keyOf(ref, ctx.home),
    title: str(n.title, `${where}.title`),
    body: optStr(n.body, `${where}.body`) ?? "",
    url: optStr(n.url, `${where}.url`),
    createdAt: timestamp(n.createdAt, `${where}.createdAt`),
    updatedAt: timestamp(n.updatedAt, `${where}.updatedAt`),
    closedAt: optTimestamp(n.closedAt ?? null, `${where}.closedAt`),
    open: openOf(n.state, where),
    stateReason: optStr(n.stateReason, `${where}.stateReason`),
    labels,
    labelsTruncated: truncated,
    assignee: assigneeOf(n.assignees, where),
    milestone: milestoneOf(n.milestone, where),
    parent: parentOf(n.parent, ctx, where),
    ...onBoard,
  };
}

/**
 * The labels of an issue, refusing a truncated list: a label missing from
 * it could be the epic label or a state label.
 */
export function wholeLabels(issue: GhIssue): string[] {
  if (issue.labelsTruncated)
    throw shapeError(
      `issue ${issue.key}: more than ${PAGE} labels, so its label list would be partial`,
    );
  return issue.labels;
}

/** An issue as a listing returns it. */
export function summaryOf(issue: GhIssue, model: GitHubModel): IssueSummary {
  return {
    identifier: issue.key,
    title: issue.title,
    state: model.issueState({ ...issue, labels: wholeLabels(issue) }),
    labels: model.visibleLabels(issue.labels),
  };
}

/**
 * The completion time of an issue in the port's sense: when it was closed
 * as completed. `null` while open or when closed for another reason.
 */
export function completedAt(issue: GhIssue, model: GitHubModel): string | null {
  return model.stateOf(issue) === "done" ? issue.closedAt : null;
}

/** The ancestors of a node read with `ancestorFields`, nearest first. */
export function parseAncestors(
  raw: Record<string, unknown>,
  ctx: ReadContext,
  model: GitHubModel,
  where: string,
): Array<{ id: string; labels: string[] }> {
  const out: Array<{ id: string; labels: string[] }> = [];
  let p: unknown = raw.parent;
  while (p !== null && p !== undefined) {
    const node = record(p, `${where} ancestor`);
    const key = keyOf(refOf(node, `${where} ancestor`), ctx.home);
    const labels = onePage(node.labels, `${where} ancestor ${key}.labels`).map(
      (l) =>
        str(
          record(l, `${where} ancestor label`).name,
          `${where} ancestor label`,
        ),
    );
    out.push({ id: key, labels: model.visibleLabels(labels) });
    p = node.parent;
  }
  return out;
}
