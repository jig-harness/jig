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

import { spawnSync } from "node:child_process";
import type {
  CanonicalState,
  CommentFact,
  FoundComment,
  Issue,
  IssueComment,
  IssueComments,
  IssueFact,
  IssueState,
  IssueSummary,
  LabelledIssueState,
  LedgerIssue,
  StartedIssueActivity,
  Tracker,
  WindowSpec,
} from "./port.ts";

export const LINEAR_API = "https://api.linear.app/graphql";
export const LINEAR_TIMEOUT_MS = 30_000;

/** A GraphQL request; resolves to the response's `data`. */
export type LinearTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Linear answered with an error. `notFound` is set when the answer is that the
 * entity does not exist (or is not visible), which a read reports as absent.
 */
export class LinearApiError extends Error {
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only, and parameter properties generate code.
  readonly status: number | null;
  readonly notFound: boolean;
  constructor(message: string, status: number | null, notFound = false) {
    super(message);
    this.status = status;
    this.notFound = notFound;
  }
}

/** The credential from the environment, or `null`. */
export function resolveLinearToken(env = process.env): string | null {
  return env.LINEAR_API_KEY?.trim() || env.LINEAR_API_TOKEN?.trim() || null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Turn a GraphQL response body into its `data`, or throw. */
export function unwrapResponse(body: unknown, status: number | null): unknown {
  if (!isRecord(body))
    throw new LinearApiError("Linear returned a non-object body", status);
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const notFound = body.errors.every(
      (e) =>
        isRecord(e) &&
        typeof e.message === "string" &&
        e.message.startsWith("Entity not found"),
    );
    throw new LinearApiError(
      `Linear API errors: ${JSON.stringify(body.errors).slice(0, 500)}`,
      status,
      notFound,
    );
  }
  return body.data;
}

/** HTTPS transport with an API key; each call is bounded by `LINEAR_TIMEOUT_MS`. */
export function httpTransport(
  token: string,
  fetchImpl: typeof fetch = fetch,
): LinearTransport {
  return async (query, variables) => {
    let res: Response;
    try {
      res = await fetchImpl(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LinearApiError(
        `Linear API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Linear answers a missing entity with HTTP 200 and an errors array, but
      // an error status may carry the same body.
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      if (isRecord(body) && Array.isArray(body.errors))
        unwrapResponse(body, res.status);
      throw new LinearApiError(
        `Linear API HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    return unwrapResponse(await res.json(), res.status);
  };
}

/**
 * Transport through the `linear` command-line client (`linear api`), which
 * keeps its own credential. Variables travel as JSON so a string that looks
 * like a number stays a string.
 */
export function cliTransport(bin = "linear"): LinearTransport {
  return async (query, variables) => {
    const r = spawnSync(
      bin,
      ["api", query, "--variables-json", JSON.stringify(variables)],
      { encoding: "utf8", timeout: LINEAR_TIMEOUT_MS },
    );
    if (r.error !== undefined) {
      const code = (r.error as NodeJS.ErrnoException).code;
      throw new LinearApiError(
        code === "ENOENT"
          ? "no Linear credential: set LINEAR_API_KEY (or LINEAR_API_TOKEN), or install and log in to the `linear` command-line client"
          : `linear api failed: ${r.error.message}`,
        null,
      );
    }
    if (r.signal !== null)
      throw new LinearApiError("linear api timed out", null);
    let body: unknown;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      throw new LinearApiError(
        `linear api returned no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 300)}`,
        null,
      );
    }
    // A failed invocation is a failure even when its output parses: report
    // the errors it carries, else its exit status.
    if (r.status !== 0) {
      if (isRecord(body) && Array.isArray(body.errors))
        unwrapResponse(body, null);
      throw new LinearApiError(
        `linear api exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`,
        null,
      );
    }
    return unwrapResponse(body, null);
  };
}

/** The transport the environment supports: an API key first, else the CLI. */
export function defaultTransport(env = process.env): LinearTransport {
  const token = resolveLinearToken(env);
  return token === null ? cliTransport() : httpTransport(token);
}

// ── Shape helpers ──────────────────────────────────────────────────────────

class ShapeError extends Error {}

function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ShapeError(`${where}: expected an object`);
  return v;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string")
    throw new ShapeError(`${where}: expected a string`);
  return v;
}

function optStr(v: unknown, where: string): string | null {
  return v === null || v === undefined ? null : str(v, where);
}

function timestamp(v: unknown, where: string): string {
  const s = str(v, where);
  if (!Number.isFinite(Date.parse(s)))
    throw new ShapeError(`${where}: not a timestamp`);
  return s;
}

function optTimestamp(v: unknown, where: string): string | null {
  return v === null ? null : timestamp(v, where);
}

/** Does the connection positively say there is no next page? */
function complete(conn: Record<string, unknown>): boolean {
  return isRecord(conn.pageInfo) && conn.pageInfo.hasNextPage === false;
}

/**
 * Label names off a label connection. Strict: a missing or truncated
 * connection read as "no labels" would silently erase an epic attribution.
 */
export function labelNames(v: unknown, where: string): string[] {
  if (!isRecord(v) || !Array.isArray(v.nodes))
    throw new ShapeError(`${where}: labels connection missing or malformed`);
  if (!complete(v))
    throw new ShapeError(
      `${where}: labels list is truncated or its pageInfo is unreadable`,
    );
  return v.nodes.map((n) => {
    if (!isRecord(n) || typeof n.name !== "string")
      throw new ShapeError(`${where}: a label node is malformed`);
    return n.name;
  });
}

function stateOf(v: unknown, where: string): IssueState {
  const s = record(v, where);
  return {
    name: typeof s.name === "string" ? s.name : "",
    type: typeof s.type === "string" ? s.type : "",
  };
}

/**
 * Read every page of one connection. `pick` finds the connection in a page's
 * data. A cursor seen twice, or an issue repeated across pages (the list moved
 * under the read), is an incomplete read, not a result.
 */
export async function pageAll(
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => unknown,
  where: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data = await transport(query, { ...variables, after });
    if (!isRecord(data))
      throw new ShapeError(`${where}: response is not an object`);
    const conn = pick(data);
    if (
      !isRecord(conn) ||
      !Array.isArray(conn.nodes) ||
      !isRecord(conn.pageInfo)
    )
      throw new ShapeError(`${where}: unexpected connection shape`);
    for (const node of conn.nodes) {
      const id = isRecord(node) ? (node.identifier ?? node.id) : undefined;
      if (typeof id !== "string") continue;
      if (ids.has(id))
        throw new ShapeError(`${where}: ${id} repeated across pages`);
      ids.add(id);
    }
    out.push(...conn.nodes);
    if (typeof conn.pageInfo.hasNextPage !== "boolean")
      throw new ShapeError(`${where}: pageInfo.hasNextPage is not a boolean`);
    if (!conn.pageInfo.hasNextPage) return out;
    const cursor = conn.pageInfo.endCursor;
    if (typeof cursor !== "string" || seen.has(cursor))
      throw new ShapeError(`${where}: pagination cursor missing or repeated`);
    seen.add(cursor);
    after = cursor;
  }
}

// ── Issue pickup ───────────────────────────────────────────────────────────

const NESTED = 250;
const LABELS = "labels(first: 100) { pageInfo { hasNextPage } nodes { name } }";

const ISSUE_QUERY = `
query TrackerIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url updatedAt
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

/** Parse one `issue` node of `ISSUE_QUERY`. */
export function parseIssue(v: unknown): Issue {
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

/**
 * Linear reports `success: false` without a GraphQL error, so an unchecked
 * payload would report a write that did not happen.
 */
function assertMutationOk(payload: unknown, what: string): void {
  if (!isRecord(payload) || payload.success !== true)
    throw new LinearApiError(
      `Linear reported that ${what} did not succeed; nothing was written`,
      200,
    );
}

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
    nodes { id identifier startedAt updatedAt state { type } }
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
  const labels = record(n.labels, `${where}.labels`);
  if (!Array.isArray(labels.nodes))
    throw new ShapeError(`${where}.labels: nodes missing`);
  if (
    !isRecord(labels.pageInfo) ||
    typeof labels.pageInfo.hasNextPage !== "boolean"
  )
    throw new ShapeError(`${where}.labels.pageInfo: unreadable`);
  const truncated = labels.pageInfo.hasNextPage ? ["labels"] : [];
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
    labels: labels.nodes.map((l) =>
      str(record(l, `${where}.labels[]`).name, `${where}.labels[].name`),
    ),
    truncated,
  };
}

const LABELLED_QUERY = `
query TrackerLabelled($teamKey: String!, $label: String!, $after: String) {
  issues(first: 250, after: $after, includeArchived: true,
         filter: { team: { key: { eq: $teamKey } }, labels: { name: { eq: $label } } }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier completedAt state { type } }
  }
}`;

/** Every issue of a label with its state; a completed one must carry its completion time. */
export function parseLabelledNode(raw: unknown): LabelledIssueState {
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
  return { identifier: n.identifier, stateType: state.type, completedAt };
}

function isoRange(w: WindowSpec): { gte: string; lt: string } {
  return {
    gte: new Date(w.sinceMs).toISOString(),
    lt: new Date(w.untilMs).toISOString(),
  };
}

function trustedUser(u: unknown): boolean {
  return isRecord(u) && typeof u.id === "string" && u.guest === false;
}

export interface LinearTrackerOptions {
  team: string;
  states: Record<CanonicalState, string>;
  transport: LinearTransport;
}

/** The Linear implementation of the tracker port. */
export function linearTracker(opts: LinearTrackerOptions): Tracker {
  const { team, states, transport } = opts;
  const keyRe = new RegExp(
    `^(${team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})-(\\d+)$`,
  );

  async function issueIdAndTeam(
    key: string,
  ): Promise<{ id: string; teamId: string }> {
    const data = record(await transport(ISSUE_ID_QUERY, { id: key }), "data");
    const issue = record(data.issue, `issue ${key}`);
    return {
      id: str(issue.id, `issue ${key}.id`),
      teamId: str(
        record(issue.team, `issue ${key}.team`).id,
        `issue ${key}.team.id`,
      ),
    };
  }

  const tracker: Tracker = {
    adapter: "linear",
    team,
    stateName: (state) => states[state],

    async getIssue(key) {
      let data: unknown;
      try {
        data = await transport(ISSUE_QUERY, { id: key });
      } catch (err) {
        if (err instanceof LinearApiError && err.notFound) return null;
        throw err;
      }
      const issue = record(data, "data").issue;
      return issue === null || issue === undefined ? null : parseIssue(issue);
    },

    async listComments(key) {
      const nodes = await pageAll(
        transport,
        COMMENTS_QUERY,
        { id: key },
        (d) => record(d.issue, `issue ${key}`).comments,
        `comments of ${key}`,
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

    async transition(key, state) {
      const name = states[state];
      const { id, teamId } = await issueIdAndTeam(key);
      const data = record(await transport(STATES_QUERY, { teamId }), "data");
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
        await transport(UPDATE_MUTATION, { id, input: { stateId } }),
        "data",
      );
      assertMutationOk(result.issueUpdate, `moving ${key} to ${name}`);
    },

    async postComment(issue, body) {
      const issueId = UUID.test(issue)
        ? issue
        : (await issueIdAndTeam(issue)).id;
      const data = record(
        await transport(COMMENT_MUTATION, { issueId, body }),
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
        out.push({
          epic: raw.identifier,
          startedAt: raw.startedAt,
          children: children.map((c) => {
            if (
              !isRecord(c) ||
              typeof c.identifier !== "string" ||
              typeof c.updatedAt !== "string" ||
              !Number.isFinite(Date.parse(c.updatedAt))
            )
              throw new ShapeError(
                `Unreadable child activity on ${raw.identifier}`,
              );
            return { issue: c.identifier, updatedAt: c.updatedAt };
          }),
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
      const comments = nodes.map((c): CommentFact => {
        // A dropped comment could be the one carrying a marker.
        if (
          !isRecord(c) ||
          typeof c.body !== "string" ||
          typeof c.createdAt !== "string" ||
          !Number.isFinite(Date.parse(c.createdAt))
        )
          throw new ShapeError(`issue ${key}: an unreadable comment node`);
        return {
          body: c.body,
          createdAt: c.createdAt,
          trusted: trustedUser(c.user),
        };
      });
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

    async labelledIssues(label) {
      const nodes = await pageAll(
        transport,
        LABELLED_QUERY,
        { teamKey: team, label },
        (d) => d.issues,
        `'${label}' issues`,
      );
      return nodes.map(parseLabelledNode);
    },
  };
  return tracker;
}
