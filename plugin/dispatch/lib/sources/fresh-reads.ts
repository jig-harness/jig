/**
 * The fresh reads of a launch's parent check: straight from the tracker, with
 * nothing kept from the tick, but with the keys one step of the walk asks for
 * together (a parent plan's steps) read in one batch rather than one request
 * each.
 */
import { isRateLimited } from "../../../shared/outbound/budget.ts";
import type {
  DispatchRawIssue,
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
function readEach(tracker: Tracker, batch: Batch): Promise<unknown> {
  return Promise.all(
    [...batch].map(([key, waiter]) =>
      tracker
        .poolIssue(key)
        .then((pool) => waiter.resolve({ pool, raw: null }), waiter.reject),
    ),
  );
}

/** A way of reading a whole batch: its rows, or `null` when it cannot answer every key. */
type Way = (
  tracker: Tracker,
  keys: string[],
) => Promise<Map<string, Row> | null>;

/** The batch as native rows, each projected as the tracker projects its pool issues. */
const readNative: Way = async (tracker, keys) => {
  const source = tracker.dispatchSource;
  if (source?.issues === undefined) return null;
  const rows = await source.issues(keys);
  if (!keys.every((key) => rows.has(key))) return null;
  return new Map(
    await Promise.all(
      [...rows].map(
        async ([key, raw]) =>
          [key, { pool: await source.project(raw), raw }] as const,
      ),
    ),
  );
};

/** The batch through the tracker's own batched pool read. */
const readPooled: Way = async (tracker, keys) => {
  if (tracker.poolIssues === undefined) return null;
  const read = await tracker.poolIssues(keys);
  return new Map(
    keys.map((key) => [key, { pool: read.get(key) ?? null, raw: null }]),
  );
};

/**
 * Settle the batch by the first way that answers it whole: native rows, the
 * tracker's batched pool read, else each key alone. A refusal by the rate
 * limit refuses every key; any other failure tries the next way.
 */
async function settle(tracker: Tracker, batch: Batch): Promise<void> {
  const keys = [...batch.keys()];
  for (const way of [readNative, readPooled]) {
    let rows: Map<string, Row> | null;
    try {
      rows = await way(tracker, keys);
    } catch (error) {
      if (!isRateLimited(error)) continue;
      for (const waiter of batch.values()) waiter.reject(error);
      return;
    }
    if (rows === null) continue;
    for (const [key, waiter] of batch) {
      const row = rows.get(key);
      if (row !== undefined) waiter.resolve(row);
    }
    return;
  }
  await readEach(tracker, batch);
}

/**
 * Reads for one fresh parent check. Every key is read once in the check, and
 * the keys asked for in one turn of the event loop leave in one batch.
 */
export function freshReads(tracker: Tracker): ParentReads {
  const memo = new Map<string, Promise<Row>>();
  const reads = new Map<string, Promise<unknown>>();
  let queued: Batch = new Map();
  const flush = () => {
    const batch = queued;
    queued = new Map();
    void settle(tracker, batch).catch((error: unknown) => {
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
