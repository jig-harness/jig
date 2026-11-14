/** One tick's native item reads and failure wall, shared by every person in a scope. */
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
}
const states = new WeakMap<Map<string, Promise<unknown>>, ScopeState>();

function scopeRead<T>(
  reads: Map<string, Promise<unknown>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const kept = reads.get(key) as Promise<T> | undefined;
  if (kept !== undefined) return kept;
  const value = read();
  reads.set(key, value);
  return value;
}

/** Reads only; each adapter still owns the request and its interpretation. */
export function nativeFacts(
  source: DispatchSource,
  reads: Map<string, Promise<unknown>>,
  bound: FacetBound | undefined,
) {
  let state = states.get(reads);
  if (state === undefined) {
    state = { queues: Promise.resolve() };
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
    scopeRead(reads, rowKey(key), () =>
      guarded(() => source.issue(key, bound), true),
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
      scopeRead(reads, `dispatch fact ${key}`, () => guarded(read, true)),
  };
}
