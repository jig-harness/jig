/**
 * The Linear tracker: read one issue with everything an agent needs to start
 * work on it, and assign it to the person opening it.
 *
 * Reads are best-effort and fail closed per field. A connection (comments,
 * sub-issues) that cannot be read in full is left out of the cache rather than
 * written truncated: the skill treats a missing `comments` array as "not
 * cached" and fetches it itself, whereas a truncated array would look complete
 * and silently hide the newest comment. Relations are the exception, because
 * the skill uses them only as background and has no refetch path for them; the
 * valid ones are kept.
 *
 * Every node is checked against its connection's field shape where the
 * connection is read, so nothing downstream meets a node it would have to
 * reject or silently skip: a node of the wrong shape makes the connection
 * incomplete, and for relations it is dropped while its valid siblings stay.
 * An incomplete connection other than relations hands on no nodes at all, so
 * an issue whose labels were not read in full is left unrouted.
 *
 * Reads tolerate partial GraphQL errors so usable data is not thrown away, but
 * an error's `path` is kept: a field Linear reports it could not resolve, or
 * one missing from the response or of the wrong type, is treated as unread,
 * never as read and empty.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContextCache,
  type FallbackEnvironment,
  isIssueKey,
} from "../cache.ts";
import { isRecord } from "../../../lib/record.ts";
import type { AssignResult, Tracker, TrackerOptions } from "../tracker.ts";

export const LINEAR_API = "https://api.linear.app/graphql";

/** Bounds the whole fetch: the first page and every follow-up page together. */
export const FETCH_BUDGET_MS = 30_000;
/** Assignment is a write after the reads, so it has a budget of its own. */
export const ASSIGN_BUDGET_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Raw body cap, applied before parsing, so a misbehaving peer cannot fill memory. */
export const MAX_RESPONSE_BYTES = 5_000_000;
/** Per-connection page ceiling: far beyond any real issue, but finite. */
export const MAX_PAGES_PER_CONNECTION = 40;

/** Each connection's selection; the first page and follow-up pages share it. */
const CONNECTIONS = {
  labels: "nodes{name parent{name}}",
  comments: "nodes{body user{id} createdAt}",
  children: "nodes{identifier}",
  // A relation the issue owns names the other issue as `relatedIssue`; one the
  // other issue owns (it blocks this one, say) is an inverse relation and names
  // it as `issue`.
  relations: "nodes{relatedIssue{identifier}}",
  inverseRelations: "nodes{issue{identifier}}",
} as const;

/** The issue's own text fields, as the first page selects them. */
const TEXT_FIELDS = ["title", "branchName", "description"] as const;

type Connection = keyof typeof CONNECTIONS;
const CONNECTION_KEYS = Object.keys(CONNECTIONS) as Connection[];

const page = (key: Connection, after: string) =>
  `${key}(first:250${after}){${CONNECTIONS[key]} pageInfo{hasNextPage endCursor}}`;

const FIRST_PAGE_QUERY = `query($id:String!){issue(id:$id){
  identifier ${TEXT_FIELDS.join(" ")} assignee{id}
  ${CONNECTION_KEYS.map((key) => page(key, "")).join("\n  ")}
} viewer{id}}`;

const nextPageQuery = (key: Connection) =>
  `query($id:String!,$after:String!){issue(id:$id){${page(key, ",after:$after")}}}`;

/** What an incomplete connection costs, for the launch warning. */
const INCOMPLETE_EFFECT: Record<Connection, string> = {
  labels: "issue left unrouted",
  comments: "cache field omitted",
  children: "cache field omitted",
  relations: "linked_issue_ids holds only what was read",
  inverseRelations: "linked_issue_ids holds only what was read",
};

const ASSIGN_MUTATION = `mutation($id:String!,$assigneeId:String!){
  issueUpdate(id:$id,input:{assigneeId:$assigneeId}){success}
}`;

type Json = Record<string, unknown>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The API key from the environment, else the private key file. Throws when the file cannot be read. */
export function resolveApiKey(
  home: string,
  env: Record<string, string | undefined>,
): string {
  const fromEnv = env.LINEAR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = join(home, ".linear", "api-key");
  return existsSync(file) ? readFileSync(file, "utf8").replace(/\s/g, "") : "";
}

export interface LinearClientOptions {
  fetchImpl?: typeof fetch;
  /** Milliseconds on a monotonic-enough clock; tests replace it. */
  now?: () => number;
}

export interface QueryOptions {
  /** Reject any GraphQL `errors`, not only a missing `data`. */
  strict?: boolean;
  /** Absolute time (on `now`) by which the call must finish. */
  deadline: number;
  /** The caller's cancellation; the call stops at whichever comes first. */
  signal: AbortSignal;
}

export interface QueryResult {
  data: Json;
  /** The `path` of every GraphQL error that carried one. */
  errorPaths: unknown[][];
}

export interface LinearClient {
  now(): number;
  /** Resolves to the response's `data`; throws on transport or shape failure. */
  query(
    query: string,
    variables: Json,
    options: QueryOptions,
  ): Promise<QueryResult>;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response exceeded byte cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** HTTPS client for Linear's API with a personal API key. A write passes `strict`. */
export function linearClient(
  apiKey: string,
  { fetchImpl = fetch, now = Date.now }: LinearClientOptions = {},
): LinearClient {
  return {
    now,
    async query(query, variables, { strict = false, deadline, signal }) {
      signal.throwIfAborted();
      const budget = deadline - now();
      if (budget <= 0) throw new Error("fetch exceeded overall deadline");
      const res = await fetchImpl(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        // One signal bounds connect, headers and the body read together.
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(budget, REQUEST_TIMEOUT_MS)),
        ]),
      });
      const payload: unknown = JSON.parse(await readCapped(res));
      if (!isRecord(payload)) throw new Error("response is not an object");
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      if (strict && errors.length > 0)
        throw new Error("Linear returned GraphQL errors");
      if (!isRecord(payload.data))
        throw new Error("response has no usable data");
      const errorPaths = errors.flatMap((e) =>
        isRecord(e) && Array.isArray(e.path) ? [e.path as unknown[]] : [],
      );
      return { data: payload.data, errorPaths };
    },
  };
}

interface Page {
  nodes: Json[] | null;
  pageInfo: Json;
  malformed: boolean;
}

const isOptional = (v: unknown, check: (v: unknown) => boolean) =>
  v === undefined || v === null || check(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isKey = (v: unknown) => isString(v) && isIssueKey(v);
const isKeyAt = (v: unknown) => isRecord(v) && isKey(v.identifier);

/**
 * The field shape a node of each connection must have. An identifier must be
 * an issue key, since the skill fetches the issue by it and a cache path is
 * built from it.
 */
const NODE_SHAPE: Record<Connection, (node: Json) => boolean> = {
  labels: (n) =>
    isString(n.name) &&
    // The query selects `parent`, so it must be present: null for a label in
    // no group, otherwise the group, which routing checks against.
    (n.parent === null || (isRecord(n.parent) && isString(n.parent.name))),
  comments: (n) =>
    isString(n.body) &&
    isOptional(n.createdAt, isString) &&
    isOptional(n.user, isRecord),
  children: (n) => isKey(n.identifier),
  relations: (n) => isKeyAt(n.relatedIssue),
  inverseRelations: (n) => isKeyAt(n.issue),
};

/**
 * Connections whose valid nodes are kept when others are malformed: the cache
 * writes them best-effort, so dropping a valid link with a bad neighbour would
 * lose it for good. Every other connection is all or nothing.
 */
const BEST_EFFORT: ReadonlySet<Connection> = new Set([
  "relations",
  "inverseRelations",
]);

/**
 * Coerce a connection to its nodes and page info. `nodes` is null only when the
 * nodes themselves are unusable; for a best-effort connection a malformed node
 * (one that is not an object or does not fit `NODE_SHAPE`) is dropped instead.
 * A missing `pageInfo` or non-boolean `hasNextPage` does
 * not mean "no more pages", only that the response never said: it is returned
 * as a stop. Either is reported `malformed`, which marks the connection
 * incomplete; only `pageInfo` decides whether reading continues.
 */
function cleanConnection(raw: unknown, key: Connection): Page {
  const stop = { hasNextPage: false };
  if (!isRecord(raw)) return { nodes: null, pageInfo: stop, malformed: true };
  const all = raw.nodes;
  if (!Array.isArray(all))
    return { nodes: null, pageInfo: stop, malformed: true };
  const nodes = all.filter((n): n is Json => isRecord(n) && NODE_SHAPE[key](n));
  const dropped = nodes.length !== all.length;
  if (dropped && !BEST_EFFORT.has(key))
    return { nodes: null, pageInfo: stop, malformed: true };
  const pageInfo = raw.pageInfo;
  if (!isRecord(pageInfo) || typeof pageInfo.hasNextPage !== "boolean")
    return { nodes, pageInfo: stop, malformed: true };
  return { nodes, pageInfo, malformed: dropped };
}

/** The issue field an error path points into, or null. */
function issueFieldOf(path: unknown[]): string | null {
  return path[0] === "issue" && typeof path[1] === "string" ? path[1] : null;
}

function isConnection(field: string): field is Connection {
  return Object.hasOwn(CONNECTIONS, field);
}

export interface IssueContext {
  /** The issue as fetched; read connections from `nodes`. */
  issue: Json;
  /** Linear's id of the API key's owner. */
  viewerId: string | null;
  /** Connections that were not read in full. */
  incomplete: Set<string>;
  /** Scalar issue fields Linear reported an error for. */
  unreadable: Set<string>;
  /**
   * Nodes of each connection that were read, in order. An incomplete
   * connection holds none, relations excepted; check `incomplete` before
   * reading an empty list as an empty connection.
   */
  nodes: Record<Connection, Json[]>;
}

/** The first page of the issue; throws when it cannot be read. */
async function readFirstPage(
  client: LinearClient,
  issueId: string,
  signal: AbortSignal,
  deadline: number,
): Promise<{ first: QueryResult; issue: Json }> {
  try {
    const first = await client.query(
      FIRST_PAGE_QUERY,
      { id: issueId },
      { deadline, signal },
    );
    if (!isRecord(first.data.issue)) throw new Error("issue not found");
    return { first, issue: first.data.issue };
  } catch (error) {
    throw new Error(`the first page cannot be read: ${describe(error)}`, {
      cause: error,
    });
  }
}

/** What the first page reported as not read: connections Linear errored on, and scalar fields. */
function firstPageGaps(
  errorPaths: unknown[][],
  issue: Json,
): { incomplete: Set<string>; unreadable: Set<string> } {
  const incomplete = new Set<string>();
  const unreadable = new Set<string>();
  for (const path of errorPaths) {
    const field = issueFieldOf(path);
    if (field === null) continue;
    if (isConnection(field)) incomplete.add(field);
    else unreadable.add(field);
  }
  // A text field is read only when it came back as text or as an explicit
  // null (no description); absent or of another type, it was not read, which
  // is the same as an error for it.
  for (const field of TEXT_FIELDS) {
    const value = issue[field];
    if (value !== null && typeof value !== "string") unreadable.add(field);
  }
  return { incomplete, unreadable };
}

/** One further page of a connection: its cleaned nodes and page info, and whether it was a partial page. */
async function readNextPage(
  client: LinearClient,
  issueId: string,
  key: Connection,
  after: string,
  seen: ReadonlySet<string>,
  deadline: number,
  signal: AbortSignal,
): Promise<{ nodes: Json[]; pageInfo: Json; partial: boolean }> {
  const reply = await client.query(
    nextPageQuery(key),
    { id: issueId, after },
    { deadline, signal },
  );
  // A field error on a page is a partial page: a best-effort connection
  // keeps its readable nodes, as on the first page; any other ends here.
  const pageErrors = reply.errorPaths.some(
    (path) => issueFieldOf(path) === key,
  );
  if (pageErrors && !BEST_EFFORT.has(key))
    throw new Error("page carries errors");
  const issueReply = isRecord(reply.data.issue) ? reply.data.issue : {};
  const more = cleanConnection(issueReply[key], key);
  if (more.nodes === null) throw new Error("malformed connection shape");
  // Under Relay semantics `after: C` returns items strictly after C, so
  // an `endCursor` already seen means the server looped back and this
  // page carries nothing new.
  const next = more.pageInfo.endCursor;
  if (typeof next === "string" && seen.has(next))
    throw new Error("cursor cycled back to one already seen");
  // A dropped node marks the connection incomplete but does not end it:
  // the cursor is still usable, and the links after it are still worth
  // reading. Unusable page info has already become a stop.
  return {
    nodes: more.nodes,
    pageInfo: more.pageInfo,
    partial: more.malformed || pageErrors,
  };
}

/** Whether the connection cannot take another page: no usable cursor, a cursor seen before, or the page ceiling. */
function cannotContinue(
  after: unknown,
  seen: ReadonlySet<string>,
  pages: number,
): boolean {
  return (
    typeof after !== "string" ||
    after === "" ||
    seen.has(after) ||
    pages >= MAX_PAGES_PER_CONNECTION
  );
}

/**
 * Read one connection from its first page on: its nodes, and whether it was
 * read in full (a key left in `incomplete` when it was not).
 */
async function readConnection(
  client: LinearClient,
  issueId: string,
  key: Connection,
  raw: unknown,
  incomplete: Set<string>,
  deadline: number,
  signal: AbortSignal,
): Promise<Json[]> {
  const firstPage = cleanConnection(raw, key);
  if (firstPage.malformed) incomplete.add(key);
  const nodes = firstPage.nodes ?? [];
  let pageInfo = firstPage.pageInfo;
  let pages = 1;
  // A server that re-serves the same page keeps `hasNextPage` true while the
  // cursor repeats; the page ceiling bounds the loop but not the duplicates
  // appended, so a repeated cursor ends the connection as incomplete.
  const seen = new Set<string>();
  while (pageInfo.hasNextPage === true) {
    const after = pageInfo.endCursor;
    if (typeof after !== "string" || cannotContinue(after, seen, pages)) {
      incomplete.add(key);
      break;
    }
    seen.add(after);
    try {
      const page = await readNextPage(
        client,
        issueId,
        key,
        after,
        seen,
        deadline,
        signal,
      );
      nodes.push(...page.nodes);
      if (page.partial) incomplete.add(key);
      pageInfo = page.pageInfo;
      pages += 1;
    } catch {
      incomplete.add(key);
      break;
    }
  }
  return nodes;
}

/**
 * Read the issue and follow each connection's own cursor until exhausted, so an
 * issue with more than 250 comments does not lose the remainder. Throws when
 * the first page cannot be read; a later page failing degrades only that
 * connection.
 */
export async function fetchIssueContext(
  client: LinearClient,
  issueId: string,
  signal: AbortSignal,
  deadline = client.now() + FETCH_BUDGET_MS,
): Promise<IssueContext> {
  const { first, issue } = await readFirstPage(
    client,
    issueId,
    signal,
    deadline,
  );
  const { incomplete, unreadable } = firstPageGaps(first.errorPaths, issue);

  const nodes = Object.fromEntries(
    CONNECTION_KEYS.map((key) => [key, []]),
  ) as unknown as Record<Connection, Json[]>;
  for (const key of CONNECTION_KEYS)
    nodes[key] = await readConnection(
      client,
      issueId,
      key,
      issue[key],
      incomplete,
      deadline,
      signal,
    );

  // An all-or-nothing connection that was not read in full exposes none of
  // what was read, so no consumer can act on part of it: a repository label on
  // an early page must not route an issue whose later labels went unread.
  for (const key of incomplete)
    if (isConnection(key) && !BEST_EFFORT.has(key)) nodes[key] = [];

  const viewer = isRecord(first.data.viewer) ? first.data.viewer.id : null;
  return {
    issue,
    viewerId: typeof viewer === "string" && viewer !== "" ? viewer : null,
    incomplete,
    unreadable,
    nodes,
  };
}

/**
 * Assign the issue to the API key's owner (the person opening it), unless it is
 * already theirs. Returns whether the issue now belongs to them, and why not
 * when it does not; the caller warns and carries on, so a failed write never
 * blocks the launch.
 */
export async function assignToViewer(
  client: LinearClient,
  issueId: string,
  context: IssueContext,
  signal: AbortSignal,
): Promise<AssignResult> {
  try {
    if (context.viewerId === null)
      throw new Error("missing authenticated user");
    const assignee = context.issue.assignee;
    if (isRecord(assignee) && assignee.id === context.viewerId)
      return { assigned: true };
    const { data } = await client.query(
      ASSIGN_MUTATION,
      { id: issueId, assigneeId: context.viewerId },
      { strict: true, deadline: client.now() + ASSIGN_BUDGET_MS, signal },
    );
    const update = data.issueUpdate;
    return isRecord(update) && update.success === true
      ? { assigned: true }
      : { assigned: false, reason: "the tracker did not confirm the update" };
  } catch (error) {
    return { assigned: false, reason: describe(error) };
  }
}

/**
 * The name of the label the issue carries under `group` (Linear's label group),
 * or null. Only the first label of the group is considered: a group is meant to
 * hold one value, and a second one must not silently pick a different route.
 */
export function labelInGroup(labels: Json[], group: string): string | null {
  for (const label of labels) {
    if (isRecord(label.parent) && label.parent.name === group)
      return isString(label.name) ? label.name : null;
  }
  return null;
}

/** Comments in the cache's form; the nodes already fit `NODE_SHAPE.comments`. */
function commentsOf(list: Json[]): NonNullable<ContextCache["comments"]> {
  const out: NonNullable<ContextCache["comments"]> = [];
  for (const { body, createdAt, user } of list) {
    const author = isRecord(user) && isString(user.id) ? user.id : null;
    // Absent, never `null`: the reader accepts a string or no property.
    out.push({
      body: body as string,
      author_id: author,
      ...(isString(createdAt) ? { created_at: createdAt } : {}),
    });
  }
  // The cache promises oldest first, which the API's page order does not. A
  // comment without a readable time cannot be placed, so then the API's order
  // stands.
  const times = out.map((c) => Date.parse(c.created_at ?? ""));
  if (times.every(Number.isFinite)) {
    const order = out.map((_, i) => i);
    order.sort((a, b) => (times[a] as number) - (times[b] as number) || a - b);
    return order.map((i) => out[i] as (typeof out)[number]);
  }
  return out;
}

/** The linked issue's key; the node already fits its `NODE_SHAPE`. */
function identifierOf(node: Json, key: string): string {
  return (node[key] as Json).identifier as string;
}

/**
 * Build the cache from a fetched context. A connection in `context.incomplete`
 * is left out (relations excepted); every node it does hold already fits
 * `NODE_SHAPE`.
 */
export function buildCache(
  issueId: string,
  context: IssueContext,
  env: FallbackEnvironment,
  nowSeconds: number,
): ContextCache {
  const { issue, incomplete, unreadable, nodes } = context;
  const text = (key: string) => {
    const v = issue[key];
    return !unreadable.has(key) && typeof v === "string" ? v : "";
  };
  const cache: ContextCache = {
    identifier: issueId,
    title: text("title"),
    // The tracker's own description stands in only for one that could not be
    // read: an issue whose description was removed has an empty one.
    description: unreadable.has("description")
      ? (env.prompt ?? "")
      : text("description"),
    // The API's branch name is always present; the environment is the fallback.
    branch_name: text("branchName") || env.branch || "",
    cached_at: nowSeconds,
    linked_issue_ids: [],
  };
  if (!incomplete.has("comments")) {
    cache.comments = commentsOf(nodes.comments);
    cache.comments_cached = true;
  }
  // Children are all or nothing: a non-empty list is what the reader trusts
  // instead of fetching children, so a filtered one would hide a dropped child.
  if (!incomplete.has("children"))
    cache.sub_issue_ids = nodes.children.map((c) => c.identifier as string);
  // Best-effort and always written: see the module comment.
  const linked = new Set<string>();
  for (const r of nodes.relations) linked.add(identifierOf(r, "relatedIssue"));
  for (const r of nodes.inverseRelations) linked.add(identifierOf(r, "issue"));
  cache.linked_issue_ids = [...linked];
  return cache;
}

export function linearTracker(
  { home, env }: TrackerOptions,
  options: LinearClientOptions = {},
): Tracker {
  return {
    name: "linear",
    launchEnvironment: {
      prompt: env.LINEAR_PROMPT,
      branch: env.LINEAR_ISSUE_BRANCH_NAME,
    },
    async read({ issue, repoLabelGroup, fallback, nowSeconds, signal }) {
      let apiKey: string;
      try {
        apiKey = resolveApiKey(home, env);
      } catch (error) {
        return {
          unavailable: `Could not read the Linear API key (${error instanceof Error ? error.message : String(error)})`,
        };
      }
      if (apiKey === "") return { unavailable: "No Linear API key" };
      const client = linearClient(apiKey, options);
      let context: IssueContext;
      try {
        context = await fetchIssueContext(client, issue, signal);
      } catch (error) {
        return { unavailable: `Could not fetch ${issue} (${describe(error)})` };
      }

      const warnings: string[] = [];
      // The skill takes a fresh cache's description as read; an unreadable one
      // with nothing to stand in for it must not be written as an empty one.
      const cache =
        context.unreadable.has("description") && !fallback.prompt
          ? null
          : buildCache(issue, context, fallback, nowSeconds);
      if (cache === null)
        warnings.push(
          `description unreadable for ${issue}; context cache not refreshed`,
        );
      for (const key of context.incomplete)
        warnings.push(
          `${key} incomplete for ${issue} (page ceiling, deadline, malformed API shape, a field error or a transport failure); ${isConnection(key) ? INCOMPLETE_EFFECT[key] : "left out"}`,
        );
      return {
        cache,
        repoLabel: labelInGroup(context.nodes.labels, repoLabelGroup),
        warnings,
        assignToOpener: (assignSignal) =>
          assignToViewer(client, issue, context, assignSignal),
      };
    },
  };
}
