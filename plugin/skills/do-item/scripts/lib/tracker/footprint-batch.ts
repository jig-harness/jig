/** Alias bounded simultaneous footprint comment queries; each adapter still parses its own response. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "../../../../../shared/guards.ts";
import { OutboundError } from "../../../../../shared/outbound/failure.ts";
import type { Transport } from "./graphql.ts";

export const FOOTPRINT_BATCH_SIZE = 5;
interface Pending {
  query: string;
  variables: Record<string, unknown>;
  signal: AbortSignal | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
const scope = new AsyncLocalStorage<Map<Transport, Pending[]>>();

/** Only the footprint port enables batching; other tracker reads are unchanged. */
export function withFootprintBatch<T>(fn: () => T): T {
  return scope.run(new Map(), fn);
}

/** The fixed adapter query's variables and root, renamed without touching its inline fragments. */
function aliasRequest(p: Pending, i: number) {
  const match =
    /^\s*query\s+TrackerComments\(([\s\S]*?)\)\s*\{\s*([A-Za-z][A-Za-z0-9_]*)/.exec(
      p.query,
    );
  if (match === null)
    throw new OutboundError(
      "invalid",
      "footprint comment query has an unreadable root",
    );
  const rename = (text: string) =>
    text.replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_all, name: string) => `$b${i}_${name}`,
    );
  const body = p.query
    .slice(p.query.indexOf("{", p.query.indexOf(")")) + 1)
    .trim()
    .replace(/\}\s*$/, "");
  return {
    definition: rename(match[1] as string),
    root: match[2] as string,
    field: `b${i}: ${rename(body)}`,
    variables: Object.fromEntries(
      Object.entries(p.variables).map(([name, value]) => [
        `b${i}_${name}`,
        value,
      ]),
    ),
  };
}
function batchDocument(pending: Pending[]) {
  const aliased = pending.map((request, index) => aliasRequest(request, index));
  return {
    definitions: aliased.map((p) => p.definition),
    fields: aliased.map((p) => p.field),
    roots: aliased.map((p) => p.root),
    variables: Object.assign({}, ...aliased.map((p) => p.variables)) as Record<
      string,
      unknown
    >,
  };
}

async function flush(transport: Transport, pending: Pending[]): Promise<void> {
  if (pending.length === 1) {
    const p = pending[0] as Pending;
    try {
      p.resolve(await transport(p.query, p.variables, p.signal, true));
    } catch (error) {
      p.reject(error);
    }
    return;
  }
  try {
    const { definitions, fields, roots, variables } = batchDocument(pending);
    // Five roots, each at most 100 comments and their bounded author fields:
    // at most 2,005 returned objects, below the tracker query ceiling of 3,000.
    const query = `query footprint(${definitions.join(", ")}) { ${fields.join("\n")} }`;
    const signal = pending[0]?.signal;
    const answer = await transport(query, variables, signal, true);
    if (!isRecord(answer))
      throw new OutboundError("invalid", "footprint batch is not an object");
    for (const [i, p] of pending.entries()) {
      const alias = `b${i}`;
      if (!(alias in answer))
        p.reject(
          new OutboundError("invalid", "footprint batch is missing an item"),
        );
      else p.resolve({ [roots[i] as string]: answer[alias] });
    }
  } catch (error) {
    for (const p of pending) p.reject(error);
  }
}

/** Called by the GraphQL pager, only for the adapters' fixed comment query. */
export function footprintCommentQuery(
  transport: Transport,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const queues = scope.getStore();
  if (queues === undefined || !/^\s*query\s+TrackerComments\(/.test(query))
    return transport(query, variables, signal, true);
  return new Promise((resolve, reject) => {
    let queue = queues.get(transport);
    if (queue === undefined) {
      queue = [];
      queues.set(transport, queue);
      const batch = queue;
      queueMicrotask(() => {
        if (queues.get(transport) === batch) queues.delete(transport);
        void flush(transport, batch);
      });
    }
    queue.push({ query, variables, signal, resolve, reject });
    if (queue.length === FOOTPRINT_BATCH_SIZE) queues.delete(transport);
  });
}
