/**
 * The fresh reads of a launch's parent check: straight from the tracker, with
 * nothing kept from the tick, but with the keys one step of the walk asks for
 * together (a parent plan's steps) read in one batch rather than one request
 * each.
 */
import { failureOf } from "../../../shared/outbound/failure.ts";
import {
  readSignal,
  refuseStopped,
} from "../../../skills/do-item/scripts/lib/tracker/facets/bounds.ts";
import type {
  DispatchRawIssue,
  FacetReadOptions,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { ParentReads } from "./served-parents.ts";

/** One key's answer: the issue, and its native row where the batch carried one. */
interface Row {
  pool: PoolIssue | null;
  raw: DispatchRawIssue | null;
}

interface Waiter {
  resolve: (row: Row) => void;
  reject: (error: unknown) => void;
}

type Batch = Map<string, Waiter>;

/** Each key read on its own: one key the tracker cannot read fails only itself. */
function readEach(
  tracker: Tracker,
  batch: Batch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return Promise.all(
    [...batch].map(([key, waiter]) =>
      Promise.resolve()
        .then(() => {
          refuseStopped(signal);
          return tracker.poolIssue(key, signal);
        })
        .then((pool) => waiter.resolve({ pool, raw: null }), waiter.reject),
    ),
  );
}

/** A way of reading a batch: the rows it answered, or `null` where the tracker offers no such read. */
type Way = (
  tracker: Tracker,
  keys: string[],
  signal: AbortSignal | undefined,
) => Promise<Map<string, Row> | null>;

/**
 * The batch as native rows, each projected as the tracker projects its pool
 * issues: only where a row carries its description and parent (`describe`),
 * which spares the walk an issue read for each parent's plan. Elsewhere the
 * tracker's pool read is the lighter batch.
 */
const readNative: Way = async (tracker, keys, signal) => {
  const source = tracker.dispatchSource;
  if (source?.issues === undefined || source.describe === undefined)
    return null;
  refuseStopped(signal);
  const options: FacetReadOptions = signal === undefined ? {} : { signal };
  const rows = await source.issues(keys, options);
  return new Map(
    await Promise.all(
      [...rows].map(async ([key, raw]) => {
        refuseStopped(signal);
        return [
          key,
          { pool: await source.project(raw, options), raw },
        ] as const;
      }),
    ),
  );
};

/** The batch through the tracker's own batched pool read. */
const readPooled: Way = async (tracker, keys, signal) => {
  if (tracker.poolIssues === undefined) return null;
  refuseStopped(signal);
  const read = await tracker.poolIssues(keys, signal);
  const rows = new Map<string, Row>();
  // A key the batch left out stays unanswered, to be read alone; `null` is an answer.
  for (const key of keys) {
    const pool = read.get(key);
    if (pool !== undefined) rows.set(key, { pool, raw: null });
  }
  return rows;
};

/**
 * Whether a narrower read may answer what the batch could not: one key the
 * credential cannot see (`not-found`), or a batch too large to ask at once
 * (`too-costly`). Any other failure fails each key alike.
 */
function readsNarrower(error: unknown): boolean {
  const { code } = failureOf(error);
  return code === "not-found" || code === "too-costly";
}

/**
 * Settle the batch by the first way that answers it: native rows, the
 * tracker's batched pool read, else each key alone, which also reads a key a
 * way left unanswered. A failure a narrower read cannot clear (the rate
 * limit, no answer, a refused credential, a malformed answer) refuses every
 * key with that failure.
 */
async function settle(
  tracker: Tracker,
  batch: Batch,
  signal: AbortSignal | undefined,
): Promise<void> {
  const keys = [...batch.keys()];
  for (const way of [readNative, readPooled]) {
    let rows: Map<string, Row> | null;
    try {
      rows = await way(tracker, keys, signal);
    } catch (error) {
      if (signal?.aborted !== true && readsNarrower(error)) continue;
      for (const waiter of batch.values()) waiter.reject(error);
      return;
    }
    if (rows === null) continue;
    const unanswered: Batch = new Map();
    for (const [key, waiter] of batch) {
      const row = rows.get(key);
      if (row === undefined) unanswered.set(key, waiter);
      else waiter.resolve(row);
    }
    await readEach(tracker, unanswered, signal);
    return;
  }
  await readEach(tracker, batch, signal);
}

/**
 * Reads for one fresh parent check. Every key is read once in the check, and
 * the keys asked for in one turn of the event loop leave in one batch. The
 * check's `bounds` (a cancellation signal, an overall deadline) bind every
 * batch and every read alone: once they stop it, no further request starts.
 */
export function freshReads(
  tracker: Tracker,
  bounds?: FacetReadOptions,
): ParentReads {
  const signal = readSignal(bounds);
  const memo = new Map<string, Promise<Row>>();
  const reads = new Map<string, Promise<unknown>>();
  let queued: Batch = new Map();
  const flush = () => {
    const batch = queued;
    queued = new Map();
    void settle(tracker, batch, signal).catch((error: unknown) => {
      for (const waiter of batch.values()) waiter.reject(error);
    });
  };
  const load = (key: string): Promise<Row> => {
    const kept = memo.get(key);
    if (kept !== undefined) return kept;
    const read = new Promise<Row>((resolve, reject) => {
      if (queued.size === 0) setTimeout(flush, 0);
      queued.set(key, { resolve, reject });
    });
    memo.set(key, read);
    return read;
  };
  return {
    pool: async (key) => (await load(key)).pool,
    ...(tracker.dispatchSource?.describe === undefined
      ? {}
      : { raw: async (key: string) => (await load(key)).raw }),
    once<T>(key: string, read: () => Promise<T>): Promise<T> {
      const kept = reads.get(key);
      if (kept !== undefined) return kept as Promise<T>;
      const started = read();
      reads.set(key, started);
      return started;
    },
  };
}
