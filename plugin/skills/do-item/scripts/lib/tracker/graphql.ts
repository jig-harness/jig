/**
 * What every tracker adapter's GraphQL transport does alike: read a
 * connection to its end, run a command-line client under a deadline, and
 * post a request over HTTPS. Each adapter supplies its own error, so a
 * failure keeps the adapter's type and fields.
 */

import type {
  RunHandle,
  RunResult,
} from "../../../../drive-pr/scripts/lib/proc.ts";
import { registerCancellationGroup } from "../../../../../shared/proc.ts";
import { isRecord } from "../../../../../shared/guards.ts";

/** One page of a connection: the response's `data` for the cursor `after`. */
export type PageReader = (after: string | null) => Promise<unknown>;

/** How an adapter reads its connections. */
export interface PageRules {
  /** The connection in a page's data. */
  pick: (data: Record<string, unknown>) => unknown;
  /** The id a node is told apart by, if it has one. */
  idOf: (node: Record<string, unknown>) => unknown;
  /** Names the read in messages. */
  where: string;
  /** The adapter's error for an unreadable page. */
  fail: (message: string) => Error;
}

/** The nodes of one page, refusing a node seen on an earlier page. */
function pageNodes(
  conn: Record<string, unknown>,
  ids: Set<string>,
  rules: PageRules,
): unknown[] {
  const nodes = conn.nodes as unknown[];
  for (const node of nodes) {
    const id = isRecord(node) ? rules.idOf(node) : undefined;
    if (typeof id !== "string") continue;
    if (ids.has(id))
      throw rules.fail(`${rules.where}: ${id} repeated across pages`);
    ids.add(id);
  }
  return nodes;
}

/** The cursor of the next page, `null` at the end; a missing or seen one throws. */
function nextCursor(
  pageInfo: Record<string, unknown>,
  seen: Set<string>,
  rules: PageRules,
): string | null {
  if (typeof pageInfo.hasNextPage !== "boolean")
    throw rules.fail(`${rules.where}: pageInfo.hasNextPage is not a boolean`);
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || seen.has(cursor))
    throw rules.fail(`${rules.where}: pagination cursor missing or repeated`);
  seen.add(cursor);
  return cursor;
}

/**
 * Read every page of one connection. A cursor seen twice, or a node repeated
 * across pages (the list moved under the read), is an incomplete read, not a
 * result.
 */
export async function readConnection(
  read: PageReader,
  rules: PageRules,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  let after: string | null = null;
  do {
    const data = await read(after);
    if (!isRecord(data))
      throw rules.fail(`${rules.where}: response is not an object`);
    const conn = rules.pick(data);
    if (
      !isRecord(conn) ||
      !Array.isArray(conn.nodes) ||
      !isRecord(conn.pageInfo)
    )
      throw rules.fail(`${rules.where}: unexpected connection shape`);
    out.push(...pageNodes(conn, ids, rules));
    after = nextCursor(conn.pageInfo, seen, rules);
  } while (after !== null);
  return out;
}

/** A GraphQL request resolving to the response's `data`. */
export type Transport = (
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * An adapter's `pageAll`: read every page of the connection `pick` finds in
 * a query's data (`readConnection`), passing each cursor as `after`. An
 * aborted `signal` ends the read in flight and starts no further page.
 */
export function pager(rules: Pick<PageRules, "idOf" | "fail">) {
  return (
    transport: Transport,
    query: string,
    variables: Record<string, unknown>,
    pick: (data: Record<string, unknown>) => unknown,
    where: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> =>
    readConnection(
      (after) => transport(query, { ...variables, after }, signal),
      { ...rules, pick, where },
    );
}

/** A runner with drive-pr's deadline and process-group handling. */
export type Runner = (
  argv: string[],
  opts: {
    stdin?: string;
    timeoutSec: number;
    onSpawn: (handle: RunHandle) => void;
  },
) => Promise<RunResult>;

/**
 * Run a command-line client through `runner`, which puts it in its own
 * process group and ends that group at `timeoutMs` or when `signal` aborts.
 * Taking the run's handle makes ending the group this caller's job, so the
 * group is also registered with the shared signal forwarder while it runs: a
 * SIGINT, SIGTERM or SIGHUP to this process ends the client too.
 */
export async function runClient(
  runner: Runner,
  argv: string[],
  opts: { stdin?: string; timeoutMs: number; signal: AbortSignal | undefined },
): Promise<RunResult> {
  let handle: RunHandle | undefined;
  let release: (() => void) | undefined;
  const stop = () => void handle?.stop();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    return await runner(argv, {
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      timeoutSec: opts.timeoutMs / 1000,
      onSpawn: (spawned) => {
        handle = spawned;
        if (spawned.pid !== undefined)
          release = registerCancellationGroup(spawned.pid, undefined, () =>
            spawned.stop(),
          );
        if (opts.signal?.aborted === true) stop();
      },
    });
  } finally {
    release?.();
    opts.signal?.removeEventListener("abort", stop);
  }
}

/**
 * POST a GraphQL request as JSON, bounded by `timeoutMs` and ended early by
 * `signal`. Resolves to the response whatever its status; a request that
 * could not be made rejects with what `fetch` threw.
 */
export function postGraphQL(
  fetchImpl: typeof fetch,
  url: string,
  authorization: string,
  payload: { query: string; variables: Record<string, unknown> },
  opts: { timeoutMs: number; signal: AbortSignal | undefined },
): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify(payload),
    signal:
      opts.signal === undefined
        ? timeout
        : AbortSignal.any([timeout, opts.signal]),
  });
}
