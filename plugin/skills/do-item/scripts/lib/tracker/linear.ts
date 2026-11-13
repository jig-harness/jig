/**
 * The Linear adapter of the tracker port (`port.ts`).
 *
 * Every operation is a GraphQL request through a `LinearTransport`. Two
 * transports exist: HTTPS to Linear's API with a personal API key
 * (`LINEAR_API_KEY`, or `LINEAR_API_TOKEN`), and, when no key is set, the
 * `linear` command-line client's `api` subcommand, which holds its own
 * credential. Tests pass a fake transport.
 *
 * Reads are defensive: a page that cannot be read, a connection that reports
 * more pages than were read, or a node of the wrong shape throws. Linear pages
 * nested connections silently, so every nested read carries its `pageInfo`.
 */

import {
  ShapeError,
  record,
  str,
  optStr,
  timestamp,
  optTimestamp,
  complete,
  labelNames,
  labelPage,
  priorityOf,
  stateOf,
  assertMutationOk,
} from "./linear-shapes.ts";
import { linearAttachments, type LinearFiles } from "./linear-attachments.ts";
import { cancellableRequest } from "./cancellation.ts";
import { commentFacts, trustedUser } from "./linear-comments.ts";
import { pager } from "./graphql.ts";
import {
  assignedOperations,
  OPEN,
  parsePoolIssue,
  poolFilter,
  poolQueries,
} from "./linear-pool.ts";
import * as lf from "./linear-facets.ts";
import { queueOperations } from "./linear-queue.ts";
import { namedState } from "./config-error.ts";
import {
  type FoundComment,
  type IssueComment,
  type IssueComments,
  type IssueFact,
  type IssuePatch,
  type IssueRelation,
  type IssueSummary,
  type LabelledIssueState,
  type LedgerIssue,
  type StateNames,
  stateNameIn,
  type StartedIssueActivity,
  type Tracker,
  type TrackerLabel,
  TrackerRequestError,
  type WindowSpec,
} from "./port.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  checkPatch,
  checkPriority,
  checkRelation,
  requireTitle,
} from "./requests.ts";

export {
  cliTransport,
  defaultTransport,
  httpTransport,
  LINEAR_API,
  LINEAR_TIMEOUT_MS,
  LinearApiError,
  type LinearTransport,
  resolveLinearToken,
  unwrapResponse,
} from "./linear-transport.ts";
import { LinearApiError, type LinearTransport } from "./linear-transport.ts";

// ── Shape helpers ──────────────────────────────────────────────────────────

export { labelNames } from "./linear-shapes.ts";

/**
 * Read every page of one connection (`pager`): a node is told apart by its
 * key, else its id.
 */
export const pageAll = pager({
  idOf: (node) => node.identifier ?? node.id,
  fail: (message) => new ShapeError(message),
});

// ── Issue pickup ───────────────────────────────────────────────────────────

const NESTED = 250;
const LABELS = "labels(first: 100) { pageInfo { hasNextPage } nodes { name } }";

const issueQuery = (extra: string) => `
query TrackerIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url updatedAt priority${extra}
    state { name type }
    ${LABELS}
    parent { identifier title }
    children(first: ${NESTED}) {
      pageInfo { hasNextPage }
      nodes { identifier title state { name type } ${LABELS} }
    }
    assignee { name }
    project { name }
  }
}`;

function summaryOf(v: unknown, where: string): IssueSummary {
  const n = record(v, where);
  return {
    identifier: str(n.identifier, `${where}.identifier`),
    title: typeof n.title === "string" ? n.title : "",
    state: stateOf(n.state, `${where}.state`),
    ...(n.labels === undefined
      ? {}
      : { labels: labelNames(n.labels, `${where}.labels`) }),
  };
}

/** Parse one `issue` node of `issueQuery`. */
export function parseIssue(v: unknown): lf.WithEstimate<lf.CoreIssue> {
  const n = record(v, "issue");
  const where = `issue ${typeof n.identifier === "string" ? n.identifier : "?"}`;
  const children = record(n.children, `${where}.children`);
  if (!Array.isArray(children.nodes))
    throw new ShapeError(`${where}.children: nodes missing`);
  if (!complete(children))
    throw new ShapeError(
      `${where}: more than ${NESTED} children, so the child list would be partial`,
    );
  const parent =
    n.parent === null || n.parent === undefined
      ? null
      : record(n.parent, `${where}.parent`);
  const name = (x: unknown): string | null =>
    isRecord(x) && typeof x.name === "string" ? x.name : null;
  return {
    id: str(n.id, `${where}.id`),
    identifier: str(n.identifier, `${where}.identifier`),
    title: str(n.title, `${where}.title`),
    description: optStr(n.description, `${where}.description`) ?? "",
    url: optStr(n.url, `${where}.url`),
    ...(typeof n.updatedAt === "string" ? { updatedAt: n.updatedAt } : {}),
    state: stateOf(n.state, `${where}.state`),
    labels: labelNames(n.labels, where),
    priority: priorityOf(n.priority, where),
    ...lf.readEstimate(n, where),
    nativeType: null, // Linear has no issue types of its own
    parent:
      parent === null
        ? null
        : {
            identifier: str(parent.identifier, `${where}.parent.identifier`),
            ...(typeof parent.title === "string"
              ? { title: parent.title }
              : {}),
          },
    children: children.nodes.map((c, i) =>
      summaryOf(c, `${where}.children[${i}]`),
    ),
    assignee: name(n.assignee),
    project: name(n.project),
  };
}

const COMMENTS_QUERY = `
query TrackerComments($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id body createdAt user { id guest } }
    }
  }
}`;

const CHILDREN_QUERY = `
query TrackerChildren($id: String!, $after: String) {
  issue(id: $id) {
    children(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { identifier title state { name type } ${LABELS} }
    }
  }
}`;

const ISSUE_ID_QUERY = `
query TrackerIssueId($id: String!) { issue(id: $id) { id team { id key } } }`;

const STATES_QUERY = `
query TrackerStates($teamId: String!) {
  team(id: $teamId) {
    states(first: 100) { pageInfo { hasNextPage } nodes { id name type } }
  }
}`;

const UPDATE_MUTATION = `
mutation TrackerUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const COMMENT_MUTATION = `
mutation TrackerComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Fleet metrics ──────────────────────────────────────────────────────────

const PARENT_DEPTH = 5;

function parentFragment(depth: number): string {
  if (depth === 0) return "";
  return `parent { identifier ${LABELS} ${parentFragment(depth - 1)} }`;
}

const FACT_FIELDS = `
  identifier
  title
  createdAt
  completedAt
  description
  state { type }
  ${LABELS}
  ${parentFragment(PARENT_DEPTH + 1)}
`;

/** Parse one issue node into an `IssueFact`; fails the read on anything unreadable. */
export function parseIssueFact(raw: unknown): IssueFact {
  if (!isRecord(raw) || typeof raw.identifier !== "string")
    throw new ShapeError("issue node: missing identifier");
  const ancestors: IssueFact["ancestors"] = [];
  let p: unknown = raw.parent;
  while (p !== null && p !== undefined) {
    // A parent that is present but unreadable fails the read: ending the walk
    // here would return a truncated chain as complete and lose the epic.
    if (!isRecord(p) || typeof p.identifier !== "string")
      throw new ShapeError(
        `issue ${raw.identifier}: an ancestor node is malformed (no identifier)`,
      );
    ancestors.push({
      id: p.identifier,
      labels: labelNames(
        p.labels,
        `issue ${raw.identifier} ancestor ${p.identifier}`,
      ),
    });
    p = p.parent;
  }
  // One ancestor past PARENT_DEPTH is read only to detect a chain longer than
  // the attribution walk can see.
  if (ancestors.length > PARENT_DEPTH)
    throw new ShapeError(
      `issue ${raw.identifier}: more than ${PARENT_DEPTH} ancestors, so its epic may lie beyond the read`,
    );
  const labels = labelNames(raw.labels, `issue ${raw.identifier}`);
  if (typeof raw.createdAt !== "string" || raw.createdAt === "")
    throw new ShapeError(
      `issue ${raw.identifier}.createdAt: expected a non-empty string`,
    );
  if (!Number.isFinite(Date.parse(raw.createdAt)))
    throw new ShapeError(`issue ${raw.identifier}: createdAt is malformed`);
  if (!isRecord(raw.state) || typeof raw.state.type !== "string")
    throw new ShapeError(`issue ${raw.identifier}: no readable state.type`);
  // `completedAt` is requested, so it is a timestamp or explicit `null`; an
  // absent key is malformed, since coercing it to null drops a unit.
  if (
    raw.completedAt !== null &&
    (typeof raw.completedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.completedAt)))
  )
    throw new ShapeError(`issue ${raw.identifier}: completedAt is malformed`);
  // A present non-string title or description is malformed; coercing it to ''
  // would turn an unreadable source into a plausible empty one.
  for (const field of ["title", "description"] as const) {
    const v = raw[field];
    if (v !== null && v !== undefined && typeof v !== "string")
      throw new ShapeError(`issue ${raw.identifier}: ${field} is not a string`);
  }
  return {
    id: raw.identifier,
    title: typeof raw.title === "string" ? raw.title : "",
    labels,
    createdAt: raw.createdAt,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    stateType: raw.state.type,
    description: typeof raw.description === "string" ? raw.description : "",
    ancestors,
  };
}

const BY_NUMBER_QUERY = `
query TrackerIssuesByNumber($teamKey: String!, $numbers: [Float!], $after: String) {
  issues(first: 100, after: $after, includeArchived: true,
         filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }) {
    pageInfo { hasNextPage endCursor }
    nodes { ${FACT_FIELDS} }
  }
}`;

const FILTER_QUERY = `
query TrackerIssuesByFilter($filter: IssueFilter!, $after: String) {
  issues(first: 100, after: $after, includeArchived: true, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${FACT_FIELDS} }
  }
}`;

const ACTIVITY_QUERY = `
query TrackerActivity($filter: IssueFilter!, $after: String, $includeArchived: Boolean!) {
  issues(first: 100, after: $after, filter: $filter, includeArchived: $includeArchived) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier startedAt updatedAt state { type }
      project { name } assignee { name } ${LABELS}
    }
  }
}`;

const COMMENT_SEARCH_QUERY = `
query TrackerCommentSearch($filter: CommentFilter!, $after: String) {
  comments(first: 100, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { id body createdAt issue { identifier } user { id guest } }
  }
}`;

const LEDGER_PAGE = 250;

function ledgerQuery(withProject: boolean): string {
  const filter = withProject
    ? `or: [
        { labels: { name: { eq: $label } } }
        { project: { name: { eq: $project } } }
      ]`
    : "labels: { name: { eq: $label } }";
  const projectVar = withProject ? ", $project: String!" : "";
  // `includeArchived`: the tracker archives completed issues, and an archived
  // issue is still a close that happened; omitting them makes the close rate
  // fall as the pool ages.
  return `
query TrackerLedger($teamKey: String!, $label: String!${projectVar}, $after: String) {
  issues(first: ${LEDGER_PAGE}, after: $after, orderBy: createdAt, includeArchived: true,
         filter: { team: { key: { eq: $teamKey } } ${filter} }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier createdAt completedAt canceledAt priority
      state { type }
      labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
      parent { identifier }
      project { name }
    }
  }
}`;
}

const LEDGER_RESOURCES_QUERY = `
query TrackerLedgerResources($label: String!, $project: String!, $withProject: Boolean!) {
  issueLabels(first: 10, filter: { name: { eq: $label } }) {
    pageInfo { hasNextPage }
    nodes { id name }
  }
  projects(first: 10, filter: { name: { eq: $project } }) @include(if: $withProject) {
    pageInfo { hasNextPage }
    nodes { id name }
  }
}`;

/** Parse one ledger node; a truncated label page is recorded, not fatal. */
export function parseLedgerNode(raw: unknown): LedgerIssue {
  const n = record(raw, "ledger issue");
  const where = `ledger issue ${typeof n.identifier === "string" ? n.identifier : "?"}`;
  const labels = labelPage(n.labels, where);
  const truncated = labels.truncated ? ["labels"] : [];
  for (const key of ["completedAt", "canceledAt", "parent", "project"])
    if (!(key in n))
      throw new ShapeError(`${where}.${key}: missing from response`);
  if (typeof n.priority !== "number")
    throw new ShapeError(`${where}.priority: expected a number`);
  const parent =
    n.parent === null
      ? null
      : str(
          record(n.parent, `${where}.parent`).identifier,
          `${where}.parent.identifier`,
        );
  const project =
    n.project === null
      ? null
      : str(
          record(n.project, `${where}.project`).name,
          `${where}.project.name`,
        );
  return {
    identifier: str(n.identifier, `${where}.identifier`),
    createdAt: timestamp(n.createdAt, `${where}.createdAt`),
    completedAt: optTimestamp(n.completedAt, `${where}.completedAt`),
    canceledAt: optTimestamp(n.canceledAt, `${where}.canceledAt`),
    stateType: str(
      record(n.state, `${where}.state`).type,
      `${where}.state.type`,
    ),
    priority: n.priority,
    parent,
    project,
    labels: labels.names,
    truncated,
  };
}

/** What an epic belongs to: its project, its assignee and its labels. */
function parseEpicPlacement(
  raw: Record<string, unknown>,
  where: string,
): Pick<StartedIssueActivity, "project" | "assignee" | "labels"> {
  const named = (v: unknown, at: string): string | null =>
    v === null ? null : str(record(v, at).name, `${at}.name`);
  const labelPage = record(raw.labels, `${where}.labels`);
  // A truncated label list would read an epic that carries a repository label
  // as one that carries none.
  if (
    !Array.isArray(labelPage.nodes) ||
    record(labelPage.pageInfo, `${where}.labels`).hasNextPage !== false
  )
    throw new ShapeError(`Unreadable or truncated labels on ${where}`);
  return {
    project: named(raw.project, `${where}.project`),
    assignee: named(raw.assignee, `${where}.assignee`),
    labels: labelPage.nodes.map((l) =>
      str(record(l, `${where}.labels[]`).name, `${where}.labels[].name`),
    ),
  };
}

/** One child of a started epic: its state and its last update. */
function parseChildActivity(
  c: unknown,
  epic: string,
): StartedIssueActivity["children"][number] {
  if (
    !isRecord(c) ||
    typeof c.identifier !== "string" ||
    typeof c.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(c.updatedAt)) ||
    !isRecord(c.state) ||
    typeof c.state.type !== "string"
  )
    throw new ShapeError(`Unreadable child activity on ${epic}`);
  return {
    issue: c.identifier,
    updatedAt: c.updatedAt,
    stateType: c.state.type,
  };
}

const labelledQuery = (withDescription: boolean) => `
query TrackerLabelled($teamKey: String!, $label: String!, $after: String) {
  issues(first: 250, after: $after, includeArchived: true,
         filter: { team: { key: { eq: $teamKey } }, labels: { name: { eq: $label } } }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier completedAt${withDescription ? " description" : ""} state { type } }
  }
}`;

/**
 * Every issue of a label with its state; a completed one must carry its
 * completion time. With `withDescription`, the description must be a string
 * or an explicit null: an absent or malformed one would read as "no owner
 * marker" and let reflection file a duplicate of an issue it could not read.
 */
export function parseLabelledNode(
  raw: unknown,
  withDescription = false,
): LabelledIssueState {
  const n = record(raw, "labelled issue");
  const state = record(n.state, "labelled issue.state");
  if (typeof n.identifier !== "string" || typeof state.type !== "string")
    throw new ShapeError("labelled issue: missing identifier or state.type");
  const completedAt = typeof n.completedAt === "string" ? n.completedAt : null;
  // A completed issue without a readable timestamp would fall out of a
  // completed-in-window count and read as fewer completions.
  if (
    state.type === "completed" &&
    (completedAt === null || Number.isNaN(Date.parse(completedAt)))
  )
    throw new ShapeError(
      `labelled issue ${n.identifier}: completed but completedAt is missing or not a valid timestamp`,
    );
  const base = { identifier: n.identifier, stateType: state.type, completedAt };
  if (!withDescription) return base;
  if (typeof n.description !== "string" && n.description !== null)
    throw new ShapeError(
      `labelled issue ${n.identifier}: description was requested but is missing or not a string`,
    );
  return { ...base, description: n.description };
}

// ── Candidate pools ────────────────────────────────────────────────────────

// ── Filing and planning ────────────────────────────────────────────────────

const TEAM_QUERY = `
query TrackerTeam($key: String!) {
  teams(first: 10, filter: { key: { eq: $key } }) {
    pageInfo { hasNextPage }
    nodes { id key }
  }
}`;

const LABELS_QUERY = `
query TrackerLabels($filter: IssueLabelFilter!, $after: String) {
  issueLabels(first: 250, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { id name isGroup parent { name } }
  }
}`;

const PROJECT_QUERY = `
query TrackerProject($name: String!) {
  projects(first: 10, filter: { name: { eq: $name } }) {
    pageInfo { hasNextPage }
    nodes { id name }
  }
}`;

const CREATE_MUTATION = `
mutation TrackerCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;

// `includeArchived`: the tracker archives completed issues, so a search that
// asks for closed issues must ask for archived ones too.
const SEARCH_QUERY = `
query TrackerSearch($filter: IssueFilter!, $includeArchived: Boolean!, $after: String) {
  issues(first: 100, after: $after, filter: $filter, includeArchived: $includeArchived) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title state { name type } ${LABELS} }
  }
}`;

const RELATIONS_QUERY = `
query TrackerRelations($id: String!, $after: String) {
  issue(id: $id) {
    relations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id type relatedIssue { identifier } }
    }
  }
}`;

const INVERSE_RELATIONS_QUERY = `
query TrackerInverseRelations($id: String!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id type issue { identifier } }
    }
  }
}`;

const RELATE_MUTATION = `
mutation TrackerRelate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

/**
 * Linear's relation type that records no decision: a relation the tracker
 * suggests by likeness, which the port has no counterpart for.
 */
const SUGGESTED_RELATION = "similar";

/** A label as Linear lists it, with its id. */
interface LinearLabel extends TrackerLabel {
  id: string;
}

/** Parse one label node; a group's own label is marked by `isGroup`. */
function parseLabel(
  raw: unknown,
  where: string,
): LinearLabel & { isGroup: boolean } {
  const n = record(raw, where);
  if (typeof n.isGroup !== "boolean")
    throw new ShapeError(`${where}.isGroup: expected a boolean`);
  return {
    id: str(n.id, `${where}.id`),
    name: str(n.name, `${where}.name`),
    isGroup: n.isGroup,
    group:
      n.parent === null || n.parent === undefined
        ? null
        : str(record(n.parent, `${where}.parent`).name, `${where}.parent.name`),
  };
}

/**
 * The one node of a lookup connection whose `name` is `wanted`. A partial
 * page, or a name matching none or several, throws: a write must not land on
 * a guess.
 */
function onlyMatch(
  conn: unknown,
  wanted: string,
  field: "name" | "key",
  what: string,
): Record<string, unknown> {
  const c = record(conn, what);
  if (!complete(c) || !Array.isArray(c.nodes))
    throw new ShapeError(
      `${what}: more than one page of matches; refusing to resolve it from a partial view`,
    );
  const matches = c.nodes.filter((n) => isRecord(n) && n[field] === wanted);
  if (matches.length !== 1)
    throw new TrackerRequestError(
      "unresolved",
      `${what} matched ${matches.length} resources in the tracker, expected exactly 1`,
    );
  return record(matches[0], what);
}

/** The fields of a patch Linear takes as they are. */
function plainFields(patch: IssuePatch): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const f of ["title", "description", "priority"] as const)
    if (patch[f] !== undefined) input[f] = patch[f];
  return input;
}

/** One relation node, seen from the issue read; `[]` for a suggestion. */
function parseRelation(
  raw: unknown,
  where: string,
  other: "relatedIssue" | "issue",
): IssueRelation[] {
  const n = record(raw, where);
  const type = str(n.type, `${where}.type`);
  const issue = str(
    record(n[other], `${where}.${other}`).identifier,
    `${where}.${other}.identifier`,
  );
  if (type === SUGGESTED_RELATION) return [];
  const outgoing = other === "relatedIssue";
  if (type === "blocks")
    return [{ type: outgoing ? "blocks" : "blocked_by", issue }];
  // Linear's `duplicate` marks the relation's `issue` as the duplicate of its
  // `relatedIssue`.
  if (type === "duplicate")
    return [{ type: outgoing ? "duplicate" : "duplicated_by", issue }];
  if (type === "related") return [{ type, issue }];
  // A relation this port cannot name could be the one that blocks the issue,
  // so it fails the read rather than vanishing from it.
  throw new ShapeError(`${where}: unknown relation type '${type}'`);
}

function isoRange(w: WindowSpec): { gte: string; lt: string } {
  return {
    gte: new Date(w.sinceMs).toISOString(),
    lt: new Date(w.untilMs).toISOString(),
  };
}

export interface LinearTrackerOptions {
  team: string;
  states: StateNames;
  transport: LinearTransport;
  facets?: lf.Facets; // default: every facet at the adapter's default
  files?: LinearFiles; // default: Linear's file store with the environment's key
}

/** The Linear implementation of the tracker port. */
export function linearTracker(opts: LinearTrackerOptions): Tracker {
  const { team, states } = opts;
  const transport: LinearTransport = (query, variables, signal) =>
    cancellableRequest(signal, () => opts.transport(query, variables, signal));
  const estimates = lf.estimateStore(opts.facets, transport, team);
  const pools = poolQueries(estimates.fields);
  const keyRe = new RegExp(
    `^(${team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})-(\\d+)$`,
  );

  async function issueIdAndTeam(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; teamId: string }> {
    const data = record(
      await transport(ISSUE_ID_QUERY, { id: key }, signal),
      "data",
    );
    const issue = record(data.issue, `issue ${key}`);
    return {
      id: str(issue.id, `issue ${key}.id`),
      teamId: str(
        record(issue.team, `issue ${key}.team`).id,
        `issue ${key}.team.id`,
      ),
    };
  }

  /** The labels an issue of this team can carry: the workspace's and the team's. */
  async function assignableLabels(
    signal?: AbortSignal,
  ): Promise<LinearLabel[]> {
    const nodes = await pageAll(
      transport,
      LABELS_QUERY,
      {
        filter: {
          or: [{ team: { key: { eq: team } } }, { team: { null: true } }],
        },
      },
      (d) => d.issueLabels,
      `labels of ${team}`,
      signal,
    );
    return nodes
      .map((n, i) => parseLabel(n, `labels of ${team}[${i}]`))
      .filter((l) => !l.isGroup)
      .map(({ id, name, group }) => ({ id, name, group }));
  }

  /**
   * Label names to ids. Every name must match exactly one label this team's
   * issues can carry; the error names each that matches none or several.
   */
  async function labelIds(
    names: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (names.length === 0) return ids;
    const labels = await assignableLabels(signal);
    const problems: string[] = [];
    for (const name of new Set(names)) {
      const matches = labels.filter((l) => l.name === name);
      if (matches.length === 1) ids.set(name, (matches[0] as LinearLabel).id);
      else
        problems.push(
          matches.length === 0
            ? `'${name}' matches no label`
            : `'${name}' matches ${matches.length} labels`,
        );
    }
    if (problems.length > 0)
      throw new TrackerRequestError(
        "unresolved",
        `labels do not resolve to one label of ${team} each: ${problems.join("; ")}`,
      );
    return ids;
  }

  async function teamId(signal?: AbortSignal): Promise<string> {
    const data = record(
      await transport(TEAM_QUERY, { key: team }, signal),
      "data",
    );
    const node = onlyMatch(data.teams, team, "key", `team '${team}'`);
    return str(node.id, `team '${team}'.id`);
  }

  async function projectId(
    name: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const data = record(
      await transport(PROJECT_QUERY, { name }, signal),
      "data",
    );
    const node = onlyMatch(data.projects, name, "name", `project '${name}'`);
    return str(node.id, `project '${name}'.id`);
  }

  const tracker: lf.CoreTracker = {
    adapter: "linear",
    team,
    stateName: stateNameIn(states),

    async reach(signal) {
      await teamId(signal);
    },

    ...linearAttachments(
      transport,
      opts.files,
      async (key, signal) => (await issueIdAndTeam(key, signal)).id,
    ),

    async getIssue(key) {
      let data: unknown;
      try {
        data = await transport(issueQuery(estimates.fields), { id: key });
      } catch (err) {
        if (err instanceof LinearApiError && err.notFound) return null;
        throw err;
      }
      const issue = record(data, "data").issue;
      return issue === null ? null : parseIssue(issue);
    },

    async listComments(key, signal) {
      const nodes = await pageAll(
        transport,
        COMMENTS_QUERY,
        { id: key },
        (d) => record(d.issue, `issue ${key}`).comments,
        `comments of ${key}`,
        signal,
      );
      const out: IssueComment[] = nodes.map((c, i) => {
        const n = record(c, `comments of ${key}[${i}]`);
        return {
          body: str(n.body, `comments of ${key}[${i}].body`),
          ...(typeof n.createdAt === "string"
            ? { createdAt: n.createdAt }
            : {}),
        };
      });
      return out.sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      );
    },

    async listChildren(key) {
      const nodes = await pageAll(
        transport,
        CHILDREN_QUERY,
        { id: key },
        (d) => record(d.issue, `issue ${key}`).children,
        `children of ${key}`,
      );
      return nodes.map((c, i) => summaryOf(c, `children of ${key}[${i}]`));
    },

    async transition(key, state, signal) {
      const name = namedState(states[state], state);
      const { id, teamId } = await issueIdAndTeam(key, signal);
      const data = record(
        await transport(STATES_QUERY, { teamId }, signal),
        "data",
      );
      const conn = record(record(data.team, "team").states, "team.states");
      if (!complete(conn) || !Array.isArray(conn.nodes))
        throw new ShapeError("team.states: not readable in one page");
      const matches = conn.nodes.filter((n) => isRecord(n) && n.name === name);
      if (matches.length !== 1)
        throw new Error(
          `issue_tracker.states.${state} names '${name}', which matches ${matches.length} workflow states of the issue's team (expected 1)`,
        );
      const stateId = str(record(matches[0], "state").id, "state.id");
      const result = record(
        await transport(UPDATE_MUTATION, { id, input: { stateId } }, signal),
        "data",
      );
      assertMutationOk(result.issueUpdate, `moving ${key} to ${name}`);
    },

    async postComment(issue, body, signal) {
      const issueId = UUID.test(issue)
        ? issue
        : (await issueIdAndTeam(issue, signal)).id;
      const data = record(
        await transport(COMMENT_MUTATION, { issueId, body }, signal),
        "data",
      );
      assertMutationOk(data.commentCreate, `the comment on ${issue}`);
    },

    async issuesByKeys(keys) {
      const out = new Map<string, IssueFact>();
      const numbers = [
        ...new Set(
          keys.flatMap((k) => {
            const m = keyRe.exec(k);
            return m === null ? [] : [Number(m[2])];
          }),
        ),
      ];
      for (let i = 0; i < numbers.length; i += 50) {
        const nodes = await pageAll(
          transport,
          BY_NUMBER_QUERY,
          { teamKey: team, numbers: numbers.slice(i, i + 50) },
          (d) => d.issues,
          "issues by number",
        );
        for (const n of nodes) {
          const fact = parseIssueFact(n);
          out.set(fact.id, fact);
        }
      }
      return out;
    },

    async issuesInWindow(query) {
      const filter: Record<string, unknown> = { team: { key: { eq: team } } };
      if (query.label !== undefined)
        filter.labels = { name: { eq: query.label } };
      if (query.createdIn !== undefined)
        filter.createdAt = isoRange(query.createdIn);
      if (query.completedIn !== undefined)
        filter.completedAt = isoRange(query.completedIn);
      const what = [
        query.label === undefined ? "issues" : `'${query.label}' issues`,
        query.createdIn === undefined ? "" : "created in the window",
        query.completedIn === undefined ? "" : "completed in the window",
      ]
        .filter(Boolean)
        .join(" ");
      const nodes = await pageAll(
        transport,
        FILTER_QUERY,
        { filter },
        (d) => d.issues,
        what,
      );
      return nodes.map(parseIssueFact);
    },

    async startedIssueActivity(label, signal) {
      // The census pages every epic and every child; a caller's deadline stops
      // it before the next request, not after the whole population.
      const guarded: LinearTransport = async (q, v) => {
        if (signal?.aborted === true)
          throw new Error("the collector deadline passed");
        return transport(q, v);
      };
      const epics = await pageAll(
        guarded,
        ACTIVITY_QUERY,
        {
          includeArchived: false,
          filter: {
            team: { key: { eq: team } },
            labels: { name: { eq: label } },
            state: { type: { eq: "started" } },
          },
        },
        (d) => d.issues,
        `started '${label}' issues`,
      );
      const out: StartedIssueActivity[] = [];
      for (const raw of epics) {
        if (
          !isRecord(raw) ||
          typeof raw.id !== "string" ||
          typeof raw.identifier !== "string" ||
          !isRecord(raw.state) ||
          raw.state.type !== "started" ||
          typeof raw.startedAt !== "string" ||
          !Number.isFinite(Date.parse(raw.startedAt))
        )
          throw new ShapeError(`Unreadable started '${label}' issue`);
        const children = await pageAll(
          guarded,
          ACTIVITY_QUERY,
          { includeArchived: true, filter: { parent: { id: { eq: raw.id } } } },
          (d) => d.issues,
          `children of ${raw.identifier}`,
        );
        const epic = raw.identifier;
        out.push({
          epic,
          startedAt: raw.startedAt,
          ...parseEpicPlacement(raw, `started '${label}' issue ${epic}`),
          children: children.map((c) => parseChildActivity(c, epic)),
        });
      }
      return out;
    },

    async commentsContaining(query) {
      const nodes = await pageAll(
        transport,
        COMMENT_SEARCH_QUERY,
        {
          filter: {
            body: { contains: query.text },
            issue: {
              team: { key: { eq: team } },
              labels: { name: { eq: query.issueLabel } },
            },
            createdAt: isoRange(query.createdIn),
          },
        },
        (d) => d.comments,
        `comments containing '${query.text}'`,
      );
      return nodes.map((n): FoundComment => {
        // A skipped node could be the one that matters, so an unreadable one
        // fails the read.
        if (
          !isRecord(n) ||
          typeof n.body !== "string" ||
          !isRecord(n.issue) ||
          typeof n.issue.identifier !== "string" ||
          typeof n.createdAt !== "string"
        )
          throw new ShapeError(
            `comments containing '${query.text}': an unreadable node`,
          );
        return {
          issue: n.issue.identifier,
          body: n.body,
          createdAt: n.createdAt,
          trusted: trustedUser(n.user),
        };
      });
    },

    async issueComments(key) {
      if (keyRe.exec(key) === null)
        throw new Error(`not a ${team} issue id: ${key}`);
      let uuid = "";
      const nodes = await pageAll(
        transport,
        COMMENTS_QUERY,
        { id: key },
        (d) => {
          const issue = isRecord(d.issue) ? d.issue : null;
          if (issue === null || typeof issue.id !== "string")
            throw new ShapeError(`issue ${key}: comments could not be read`);
          uuid = issue.id;
          return issue.comments;
        },
        `comments of ${key}`,
      );
      const comments = commentFacts(nodes, key);
      return { uuid, comments } satisfies IssueComments;
    },

    async ledger(query, onPage) {
      const withProject = query.project !== undefined;
      const resources = record(
        await transport(LEDGER_RESOURCES_QUERY, {
          label: query.label,
          project: query.project ?? "",
          withProject,
        }),
        "data",
      );
      const checks: Array<[string, string, string]> = [
        ["issueLabels", query.label, `label '${query.label}'`],
      ];
      if (withProject)
        checks.push([
          "projects",
          query.project as string,
          `project '${query.project}'`,
        ]);
      for (const [field, wanted, what] of checks) {
        const conn = record(resources[field], `data.${field}`);
        if (!complete(conn) || !Array.isArray(conn.nodes))
          throw new ShapeError(
            `data.${field}: more than one page of matches for ${what}; refusing to resolve it from a partial view`,
          );
        const matches = conn.nodes.filter(
          (n) => isRecord(n) && n.name === wanted,
        );
        if (matches.length !== 1)
          throw new Error(
            `the configured ${what} matched ${matches.length} resources in the tracker, expected exactly 1; a name that resolves to nothing silently shrinks the ledger`,
          );
      }
      const variables: Record<string, unknown> = {
        teamKey: team,
        label: query.label,
      };
      if (withProject) variables.project = query.project;
      let fetched = 0;
      const nodes = await pageAll(
        async (q, v) => {
          const data = await transport(q, v);
          if (
            isRecord(data) &&
            isRecord(data.issues) &&
            Array.isArray(data.issues.nodes)
          ) {
            fetched += data.issues.nodes.length;
            onPage?.(fetched);
          }
          return data;
        },
        ledgerQuery(withProject),
        variables,
        (d) => d.issues,
        "ledger",
      );
      return nodes.map(parseLedgerNode);
    },

    async labelledIssues(label, signal, withDescription = false) {
      const nodes = await pageAll(
        transport,
        labelledQuery(withDescription),
        { teamKey: team, label },
        (d) => d.issues,
        `'${label}' issues`,
        signal,
      );
      return nodes.map((node) => parseLabelledNode(node, withDescription));
    },

    async openIssues(query) {
      const nodes = await pageAll(
        transport,
        pools.pool,
        { filter: poolFilter(team, query) },
        (d) => d.issues,
        "open issues of the pool",
      );
      return nodes.map(parsePoolIssue);
    },

    async openChildren(key) {
      if (keyRe.exec(key) === null)
        throw new Error(`not a ${team} issue id: ${key}`);
      const nodes = await pageAll(
        transport,
        pools.openChildren,
        { id: key, filter: { and: [{ team: { key: { eq: team } } }, OPEN] } },
        (d) => record(d.issue, `issue ${key}`).children,
        `open children of ${key}`,
      );
      return nodes.map(parsePoolIssue);
    },

    async poolIssue(key, signal) {
      let data: unknown;
      try {
        data = await transport(pools.poolIssue, { id: key }, signal);
      } catch (err) {
        if (err instanceof LinearApiError && err.notFound) return null;
        throw err;
      }
      const issue = record(data, "data").issue;
      return issue === null ? null : parsePoolIssue(issue);
    },
    ...assignedOperations({
      ...opts,
      pageAll,
      poolQuery: pools.pool,
      parsePool: parsePoolIssue,
    }),
    ...queueOperations({
      ...opts,
      pageAll,
      extra: estimates.fields,
      parsePool: parsePoolIssue,
      parseRelation,
      poolIssue: (key, signal) => tracker.poolIssue(key, signal),
    }),

    async createIssue(issue) {
      requireTitle(issue.title);
      checkPriority(issue.priority);
      const input: Record<string, unknown> = {
        teamId: await teamId(),
        title: issue.title,
        description: issue.description,
      };
      const ids = await labelIds(issue.labels);
      if (ids.size > 0) input.labelIds = [...new Set(ids.values())];
      if (issue.priority !== undefined) input.priority = issue.priority;
      Object.assign(input, await estimates.input(issue.size));
      if (issue.parent !== undefined)
        input.parentId = (await issueIdAndTeam(issue.parent)).id;
      if (issue.project !== undefined)
        input.projectId = await projectId(issue.project);
      const data = record(await transport(CREATE_MUTATION, { input }), "data");
      assertMutationOk(data.issueCreate, `filing '${issue.title}'`);
      const created = record(
        record(data.issueCreate, "issueCreate").issue,
        "issueCreate.issue",
      );
      return {
        identifier: str(created.identifier, "issueCreate.issue.identifier"),
        url: optStr(created.url, "issueCreate.issue.url"),
      };
    },

    async updateIssue(key, patch, signal) {
      signal?.throwIfAborted();
      checkPatch(key, patch);
      const add = patch.addLabels ?? [];
      const remove = patch.removeLabels ?? [];
      const input = plainFields(patch);
      Object.assign(input, await estimates.input(patch.size, signal));
      if (patch.parent !== undefined)
        input.parentId =
          patch.parent === null
            ? null
            : (await issueIdAndTeam(patch.parent, signal)).id;
      if (patch.project !== undefined)
        input.projectId = await projectId(patch.project, signal);
      // Labels change by id, added and removed, so a label another writer
      // set since this caller last read the issue is never dropped.
      if (add.length > 0 || remove.length > 0) {
        const ids = await labelIds([...add, ...remove], signal);
        const idsOf = (names: string[]) => [
          ...new Set(names.map((l) => ids.get(l) as string)),
        ];
        if (add.length > 0) input.addedLabelIds = idsOf(add);
        if (remove.length > 0) input.removedLabelIds = idsOf(remove);
      }
      const { id } = await issueIdAndTeam(key, signal);
      const result = record(
        await transport(UPDATE_MUTATION, { id, input }, signal),
        "data",
      );
      assertMutationOk(result.issueUpdate, `the update of ${key}`);
    },

    async listLabels() {
      return (await assignableLabels())
        .map(({ name, group }) => ({ name, group }))
        .sort(
          (a, b) =>
            (a.group ?? "").localeCompare(b.group ?? "") ||
            a.name.localeCompare(b.name),
        );
    },

    async searchIssues(text, opts = {}) {
      if (text.trim() === "")
        throw new TrackerRequestError(
          "invalid",
          "a search needs non-empty text; empty text would read every issue",
        );
      const nodes = await pageAll(
        transport,
        SEARCH_QUERY,
        {
          filter: {
            and: [
              { team: { key: { eq: team } } },
              {
                or: [
                  { title: { containsIgnoreCase: text } },
                  { description: { containsIgnoreCase: text } },
                ],
              },
              ...(opts.includeClosed === true ? [] : [OPEN]),
            ],
          },
          includeArchived: opts.includeClosed === true,
        },
        (d) => d.issues,
        `issues containing '${text}'`,
      );
      return nodes.map((n, i) =>
        summaryOf(n, `issues containing '${text}'[${i}]`),
      );
    },

    async listRelations(key) {
      const read = async (
        query: string,
        field: "relations" | "inverseRelations",
        other: "relatedIssue" | "issue",
      ) =>
        (
          await pageAll(
            transport,
            query,
            { id: key },
            (d) => record(d.issue, `issue ${key}`)[field],
            `${field} of ${key}`,
          )
        ).flatMap((raw, i) =>
          parseRelation(raw, `${field} of ${key}[${i}]`, other),
        );
      return [
        ...(await read(RELATIONS_QUERY, "relations", "relatedIssue")),
        ...(await read(INVERSE_RELATIONS_QUERY, "inverseRelations", "issue")),
      ];
    },

    async relate(key, type, target) {
      checkRelation(key, type, target);
      const issueId = (await issueIdAndTeam(key)).id;
      const relatedIssueId = (await issueIdAndTeam(target)).id;
      const data = record(
        await transport(RELATE_MUTATION, {
          input: { issueId, relatedIssueId, type },
        }),
        "data",
      );
      assertMutationOk(
        data.issueRelationCreate,
        `recording that ${key} ${type} ${target}`,
      );
    },
  };
  return lf.linearFacets(tracker, opts.facets, estimates);
}
