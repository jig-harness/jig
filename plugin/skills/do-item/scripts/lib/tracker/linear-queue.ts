/**
 * The Linear adapter's reads for a served queue, each in as few requests as
 * Linear allows:
 *
 * - `poolIssues`: several issues by key in one paged request, by team key
 *   and number (Linear's `issue(id:)` takes one key per request). A key the
 *   list does not hold (an archived issue, one moved to another team) is
 *   read on its own, so a missing issue is never mistaken for one that
 *   does not exist.
 * - `queueIssues`: the issues assigned to a user, each with its relations
 *   (both directions, the other issue's state with each) and its parent
 *   (its pool form, description and own parent's key), in one paged request.
 * - `changedSince`: the tracker change probe, one request: how many of the
 *   issues assigned to the user, of the issues named, and of their children
 *   were updated after a time.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import type {
  CoreQueueIssue,
  CorePoolIssue,
  CoreTracker,
} from "./facets/tracker.ts";
import type { WithEstimate } from "./linear-facets.ts";
import { poolQueries, poolFields } from "./linear-pool.ts";
import { dispatchCredential, dispatchPersistent } from "./linear-transport.ts";
import type { LinearTransport } from "./linear-transport.ts";
import { record, ShapeError, str } from "./linear-shapes.ts";
import type {
  CanonicalState,
  FacetReadOptions,
  ChangeAnswer,
  ChangeQuery,
  IssueRelation,
  QueueRelation,
  StateNames,
  DispatchRawIssue,
} from "./port.ts";
import { readSignal, refuseStopped } from "./facets/bounds.ts";

type Pager = (
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => unknown,
  where: string,
  signal?: AbortSignal,
) => Promise<unknown[]>;

export interface QueueOptions {
  team: string;
  states: StateNames;
  transport: LinearTransport;
  pageAll: Pager;
  /** The estimate field, where size is kept in it. */
  extra: string;
  parsePool: (raw: unknown) => WithEstimate<CorePoolIssue>;
  /** One relation node; `other` is the field holding the other issue. */
  parseRelation: (
    raw: unknown,
    where: string,
    other: "relatedIssue" | "issue",
  ) => IssueRelation[];
  /** One issue alone, for a key the batch did not hold. */
  poolIssue: (
    key: string,
    signal?: AbortSignal,
  ) => Promise<WithEstimate<CorePoolIssue> | null>;
}

const KEY = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

/**
 * Keys by team, as Linear filters them: per team, `{ and: [team, number in
 * [...]] }`. The `and` is load-bearing: inside an `or`, Linear drops the
 * `number` clause of an element that holds a bare `{ team, number }` and
 * matches the whole team, which a batch read would then page through.
 */
export function keyGroups(
  keys: ReadonlyArray<string>,
): Array<Record<string, unknown>> {
  const byTeam = new Map<string, number[]>();
  for (const key of keys) {
    const m = KEY.exec(key);
    if (m === null) continue;
    const team = (m[1] as string).toUpperCase();
    byTeam.set(team, [...(byTeam.get(team) ?? []), Number(m[2])]);
  }
  return [...byTeam].map(([team, numbers]) => ({
    and: [
      { team: { key: { eq: team } } },
      { number: { in: [...new Set(numbers)] } },
    ],
  }));
}

const RELATED = "identifier state { type }";

/** The issues one batch page holds, matching the `first` of `batchQuery`. */
const BATCH_PAGE = 50;

/**
 * `transport` for one batch read of `count` keys: a read that asks for more
 * pages than the keys can fill is not selecting them (the filter matched more
 * than the keys named), so it stops instead of reading on.
 */
function boundedBatch(
  transport: LinearTransport,
  count: number,
  pageSize: number,
): LinearTransport {
  const allowed = Math.ceil(count / pageSize) + 1;
  let sent = 0;
  return async (query, variables, signal) => {
    if (++sent > allowed)
      throw new ShapeError(
        `${count} issue(s) by key: the read is paging past its keys`,
      );
    return transport(query, variables, signal);
  };
}

/**
 * The queue's page sizes, kept so one page stays under Linear's complexity
 * limit for a single query (10,000 points, a connection multiplying its
 * nodes' cost by its page size): 25 issues, each with its labels, up to 20
 * relations each way and its parent, cost about 9,000. An issue with more
 * relations is read with `listRelations` instead.
 */
const QUEUE_PAGE = 25;
const RELATION_PAGE = 20;

function queueQuery(extra: string): string {
  return queueQueryOf("TrackerQueue", extra, "");
}

/** The queue's fields for issues named by key: archived ones included, as `batchQuery` reads them. */
function queueByKeyQuery(extra: string): string {
  return queueQueryOf("TrackerQueueByKey", extra, "includeArchived: true, ");
}

function queueQueryOf(name: string, extra: string, args: string): string {
  const fields = poolFields(extra);
  return `
query ${name}($filter: IssueFilter!, $after: String) {
  issues(first: ${QUEUE_PAGE}, after: $after, ${args}filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ${fields}
      relations(first: ${RELATION_PAGE}) { pageInfo { hasNextPage } nodes { type relatedIssue { ${RELATED} } } }
      inverseRelations(first: ${RELATION_PAGE}) { pageInfo { hasNextPage } nodes { type issue { ${RELATED} } } }
      parent { ${fields} description parent { identifier } }
    }
  }
}`;
}

function batchQuery(extra: string): string {
  return `
query TrackerPoolIssues($filter: IssueFilter!, $after: String) {
  issues(first: ${BATCH_PAGE}, after: $after, includeArchived: true, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${poolFields(extra)} }
  }
}`;
}

const CHANGES_QUERY = `
query TrackerChanges($filter: IssueFilter!) {
  issues(first: 50, filter: $filter) {
    pageInfo { hasNextPage }
    nodes { identifier updatedAt }
  }
}`;

function assigneeClause(identity: string): Record<string, unknown> {
  return {
    assignee: {
      or: [
        { email: { eqIgnoreCase: identity } },
        { displayName: { eqIgnoreCase: identity } },
      ],
    },
  };
}

/** One direction of an issue's relations, with each other issue's state; `null` when the page did not hold them all. */
function relationsOf(
  conn: unknown,
  where: string,
  other: "relatedIssue" | "issue",
  parse: QueueOptions["parseRelation"],
): QueueRelation[] | null {
  const c = record(conn, where);
  if (
    !Array.isArray(c.nodes) ||
    !isRecord(c.pageInfo) ||
    typeof c.pageInfo.hasNextPage !== "boolean"
  )
    throw new ShapeError(`${where}: unreadable`);
  if (c.pageInfo.hasNextPage) return null;
  return c.nodes.flatMap((raw, i) => {
    const node = record(raw, `${where}[${i}]`);
    const related = record(node[other], `${where}[${i}].${other}`);
    const state = isRecord(related.state) ? related.state.type : null;
    return parse(raw, `${where}[${i}]`, other).map((r) => ({
      ...r,
      state: typeof state === "string" ? state : null,
    }));
  });
}

function parseQueueIssue(
  raw: unknown,
  opts: QueueOptions,
): WithEstimate<CoreQueueIssue> {
  const n = record(raw, "queue issue");
  const issue = opts.parsePool(n);
  const where = `queue issue ${issue.identifier}`;
  const out = relationsOf(
    n.relations,
    `${where}.relations`,
    "relatedIssue",
    opts.parseRelation,
  );
  const into = relationsOf(
    n.inverseRelations,
    `${where}.inverseRelations`,
    "issue",
    opts.parseRelation,
  );
  let parent: CoreQueueIssue["parent"] = null;
  if (n.parent !== null && n.parent !== undefined) {
    const p = record(n.parent, `${where}.parent`);
    parent = {
      issue: opts.parsePool(p),
      description: typeof p.description === "string" ? p.description : "",
      parent: isRecord(p.parent)
        ? str(p.parent.identifier, `${where}.parent.parent.identifier`)
        : null,
    };
  }
  return {
    ...issue,
    relations: out === null || into === null ? null : [...out, ...into],
    parent,
  };
}

/**
 * The issues named by `wanted`, read in pages of `read.query` and parsed by
 * `parse`, by upper-case key; one the list does not hold (archived, or moved
 * to another team) is absent.
 */
async function readByKey<T extends { identifier: string }>(
  opts: QueueOptions,
  read: { query: string; size: number; what: string },
  wanted: ReadonlyArray<string>,
  parse: (node: unknown) => T,
  signal?: AbortSignal,
): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const groups = keyGroups(wanted);
  if (groups.length === 0) return found;
  const nodes = await opts.pageAll(
    boundedBatch(opts.transport, wanted.length, read.size),
    read.query,
    { filter: { or: groups } },
    (d) => d.issues,
    `${wanted.length} issue(s) by key ${read.what}`.trim(),
    signal,
  );
  for (const node of nodes) {
    const issue = parse(node);
    found.set(issue.identifier.toUpperCase(), issue);
  }
  return found;
}

type QueueOperations = Required<
  Pick<
    CoreTracker,
    | "dispatchSource"
    | "queueIssues"
    | "queueIssuesByKey"
    | "poolIssues"
    | "changedSince"
  >
>;

export function queueOperations(opts: QueueOptions): QueueOperations {
  const { team, states, transport, pageAll } = opts;
  const queue = queueQuery(opts.extra);
  const queueByKey = queueByKeyQuery(opts.extra);
  const batch = batchQuery(opts.extra);
  const rawOptions = { ...opts, extra: "estimate" };
  const requirements = [
    "triage",
    "backlog",
    "todo",
    "blocked",
    "in_progress",
    "pr_open",
  ]
    .map((state) => states[state as CanonicalState])
    .filter((name): name is string => name != null)
    .map((name) => `queue-state:${name}`);
  let demanded = new Set(requirements);
  const rawQuery = queueQuery("estimate").replace(
    "query TrackerQueue(",
    "query TrackerNativeQueue(",
  );
  const rawOf = (node: unknown): DispatchRawIssue => {
    const read = parseQueueIssue(node, rawOptions);
    return {
      identifier: read.identifier,
      value: read,
      relations: read.relations,
      parent:
        read.parent === null
          ? null
          : {
              ...read.parent,
              issue: {
                identifier: read.parent.issue.identifier,
                value: read.parent.issue,
              },
            },
    };
  };
  return {
    dispatchSource: {
      persistent: dispatchPersistent(transport),
      requirements,
      configure(union) {
        demanded = new Set([...demanded, ...union]);
      },
      get shape() {
        return JSON.stringify([...demanded].sort((a, b) => a.localeCompare(b)));
      },
      credential: async (options?: FacetReadOptions) => {
        const signal = readSignal(options);
        refuseStopped(signal);
        const credential = await dispatchCredential(transport);
        refuseStopped(signal);
        return credential;
      },
      async queue(identity: string, options?: FacetReadOptions) {
        const signal = readSignal(options);
        refuseStopped(signal);
        const nodes = await pageAll(
          transport,
          rawQuery,
          {
            filter: {
              and: [
                { team: { key: { eq: team } } },
                assigneeClause(identity),
                {
                  state: {
                    name: {
                      in: [...demanded]
                        .filter((name) => name.startsWith("queue-state:"))
                        .map((name) => name.slice(12)),
                    },
                  },
                },
              ],
            },
          },
          (d) => d.issues,
          `the native queue of ${identity}`,
          signal,
        );
        return nodes.map(rawOf);
      },
      async issue(key: string, options?: FacetReadOptions) {
        const signal = readSignal(options);
        refuseStopped(signal);
        const found = await readByKey(
          rawOptions,
          {
            query: queueByKeyQuery("estimate"),
            size: QUEUE_PAGE,
            what: "with their native fields",
          },
          [key],
          rawOf,
          signal,
        );
        return found.get(key.toUpperCase()) ?? null;
      },
      async issues(keys: ReadonlyArray<string>, options?: FacetReadOptions) {
        const signal = readSignal(options);
        refuseStopped(signal);
        return readByKey(
          rawOptions,
          {
            query: queueByKeyQuery("estimate"),
            size: QUEUE_PAGE,
            what: "with their native fields",
          },
          keys,
          rawOf,
          signal,
        );
      },
      async children(key: string, options?: FacetReadOptions) {
        const signal = readSignal(options);
        refuseStopped(signal);
        const query = poolQueries("estimate").openChildren;
        const nodes = await pageAll(
          transport,
          query,
          {
            id: key,
            filter: {
              and: [
                { team: { key: { eq: team } } },
                {
                  state: {
                    type: { nin: ["completed", "canceled", "duplicate"] },
                  },
                },
              ],
            },
          },
          (d) => record(d.issue, `issue ${key}`).children,
          `native children of ${key}`,
          signal,
        );
        return nodes.map((value) => {
          const read = opts.parsePool(value);
          return { identifier: read.identifier, value: read };
        });
      },
      project: async (raw: DispatchRawIssue, options?: FacetReadOptions) => {
        refuseStopped(readSignal(options));
        return raw.value as WithEstimate<CorePoolIssue>;
      },
    },
    async queueIssues(
      identity: string,
      wanted: ReadonlyArray<CanonicalState>,
      signal?: AbortSignal,
    ): Promise<WithEstimate<CoreQueueIssue>[]> {
      if (wanted.length === 0)
        throw new ShapeError("a queue read needs at least one state");
      const filter = {
        and: [
          { team: { key: { eq: team } } },
          assigneeClause(identity),
          { state: { name: { in: wanted.map((s) => states[s]) } } },
        ],
      };
      const nodes = await pageAll(
        transport,
        queue,
        { filter },
        (d) => d.issues,
        `the queue of ${identity}`,
        signal,
      );
      return nodes.map((n) => parseQueueIssue(n, opts));
    },

    async queueIssuesByKey(
      keys: ReadonlyArray<string>,
      signal?: AbortSignal,
    ): Promise<Map<string, WithEstimate<CoreQueueIssue>>> {
      const wanted = [...new Set(keys)];
      const found = await readByKey(
        opts,
        { query: queueByKey, size: QUEUE_PAGE, what: "with their relations" },
        wanted,
        (node) => parseQueueIssue(node, opts),
        signal,
      );
      const out = new Map<string, WithEstimate<CoreQueueIssue>>();
      for (const key of wanted) {
        const hit = found.get(key.toUpperCase());
        if (hit !== undefined) out.set(key, hit);
      }
      return out;
    },

    async poolIssues(
      keys: ReadonlyArray<string>,
      signal?: AbortSignal,
    ): Promise<Map<string, WithEstimate<CorePoolIssue> | null>> {
      const wanted = [...new Set(keys)];
      const found = await readByKey(
        opts,
        { query: batch, size: BATCH_PAGE, what: "" },
        wanted,
        opts.parsePool,
        signal,
      );
      const out = new Map<string, WithEstimate<CorePoolIssue> | null>();
      for (const key of wanted) {
        const hit = found.get(key.toUpperCase());
        out.set(key, hit ?? (await opts.poolIssue(key, signal)));
      }
      return out;
    },

    async changedSince(
      query: ChangeQuery,
      signal?: AbortSignal,
    ): Promise<ChangeAnswer> {
      const groups = keyGroups(query.keys);
      const filter = {
        and: [
          { updatedAt: { gt: query.since } },
          {
            or: [
              {
                and: [
                  { team: { key: { eq: team } } },
                  {
                    assignee: {
                      or: (query.identities ?? [query.identity]).flatMap(
                        (identity) => [
                          { email: { eqIgnoreCase: identity } },
                          { displayName: { eqIgnoreCase: identity } },
                        ],
                      ),
                    },
                  },
                ],
              },
              ...groups,
              ...groups.map((g) => ({ parent: g })),
            ],
          },
        ],
      };
      const data = record(
        await transport(CHANGES_QUERY, { filter }, signal),
        "data",
      );
      const conn = record(data.issues, "changed issues");
      const nodes = conn.nodes;
      if (
        !Array.isArray(nodes) ||
        !isRecord(conn.pageInfo) ||
        typeof conn.pageInfo.hasNextPage !== "boolean"
      )
        throw new ShapeError("changed issues: unreadable");
      const changed = nodes.map((n, i) => record(n, `changed issues[${i}]`));
      // ISO 8601 UTC timestamps order by code unit, so the latest is the max.
      const latest = changed
        .map((n) => n.updatedAt)
        .filter((t): t is string => typeof t === "string")
        .reduce<string | null>(
          (max, t) => (max === null || t > max ? t : max),
          null,
        );
      return {
        keys: changed.map((n, i) => str(n.identifier, `changed issues[${i}]`)),
        complete: !conn.pageInfo.hasNextPage,
        latest,
      };
    },
  };
}
