/** One tick's native item reads and failure wall, shared by every person in a scope. */
import { coalesce } from "../../../shared/outbound/coalesce.ts";
import type {
  DispatchRawIssue,
  DispatchSource,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  dispatchScopeFailure,
  recordDispatchScopeFailure,
} from "../../../skills/do-item/scripts/lib/tracker/dispatch-shared.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import type { FacetBound } from "./tracker-facets.ts";

interface ScopeState {
  queues: Promise<unknown>;
  singles: ReturnType<typeof limiter>;
}
const states = new WeakMap<Map<string, Promise<unknown>>, ScopeState>();

/** Keep batch-recovery fallbacks from turning one failed batch into an unbounded fan-out. */
function limiter(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (running >= limit)
      await new Promise<void>((resume) => waiting.push(resume));
    running += 1;
    try {
      return await read();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

const SINGLE_READS_IN_FLIGHT = 6;

/** Reads only; each adapter still owns the request and its interpretation. */
export function nativeFacts(
  source: DispatchSource,
  reads: Map<string, Promise<unknown>>,
  bound: FacetBound | undefined,
) {
  let state = states.get(reads);
  if (state === undefined) {
    state = {
      queues: Promise.resolve(),
      singles: limiter(SINGLE_READS_IN_FLIGHT),
    };
    states.set(reads, state);
  }
  const scope = state;
  const guarded = async <T>(
    read: () => Promise<T>,
    onlyUnavailable = false,
  ): Promise<T> => {
    const failure = reads.get("dispatch scope failure");
    if (failure !== undefined) return Promise.reject(await failure);
    try {
      return await read();
    } catch (error) {
      if (!onlyUnavailable || isUnavailable(error))
        recordDispatchScopeFailure(reads, error);
      return Promise.reject(error);
    }
  };
  const rowKey = (key: string) => `dispatch raw issue ${key}`;
  const remember = (row: DispatchRawIssue) => {
    if (!reads.has(rowKey(row.identifier)))
      reads.set(rowKey(row.identifier), Promise.resolve(row));
    if (row.parent && !reads.has(rowKey(row.parent.issue.identifier)))
      reads.set(
        rowKey(row.parent.issue.identifier),
        Promise.resolve(row.parent.issue),
      );
  };
  const issue = (key: string) =>
    coalesce(reads, rowKey(key), () =>
      scope.singles(() => guarded(() => source.issue(key, bound), true)),
    );
  return {
    failure: () => dispatchScopeFailure(reads),
    guarded,
    async queue(identity: string): Promise<DispatchRawIssue[]> {
      const reading = scope.queues.then(() =>
        guarded(() => source.queue(identity, bound)),
      );
      scope.queues = reading.catch(() => undefined);
      const rows = await reading;
      rows.forEach(remember);
      return rows;
    },
    issue,
    async issues(
      keys: ReadonlyArray<string>,
    ): Promise<Map<string, DispatchRawIssue>> {
      const missing = keys.filter((key) => !reads.has(rowKey(key)));
      const batch = source.issues;
      if (batch !== undefined && missing.length > 0) {
        const reading = guarded(() => batch(missing, bound), true);
        for (const key of missing)
          reads.set(
            rowKey(key),
            reading.then(
              (found) =>
                found.get(key) ?? guarded(() => source.issue(key, bound), true),
              () => {
                // A malformed or inaccessible member makes the native batch
                // atomic, but must not poison readable siblings' per-key
                // fallback for the rest of this tick.
                const fallback = scope.singles(() =>
                  guarded(() => source.issue(key, bound), true),
                );
                reads.set(rowKey(key), fallback);
                return fallback;
              },
            ),
          );
      }
      const values = await Promise.all(
        keys.map(async (key) => [key, await issue(key)] as const),
      );
      return new Map(
        values.filter(
          (value): value is readonly [string, DispatchRawIssue] =>
            value[1] !== null,
        ),
      );
    },
    once: <T>(key: string, read: () => Promise<T>) =>
      coalesce(reads, `dispatch fact ${key}`, () => guarded(read, true)),
  };
}
