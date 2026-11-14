/** A tick's native metadata answers, shared only within one credential and scope. */
import { isUnavailable } from "./unavailable.ts";
const failures = new WeakMap<Map<string, Promise<unknown>>, unknown>();

/** The scope's synchronous wall, for reports after a later fact failed. */
export function dispatchScopeFailure(
  reads: Map<string, Promise<unknown>>,
): unknown | null {
  return failures.get(reads) ?? null;
}

/** All adapter readers and the dispatch view share the same wall. */
export function recordDispatchScopeFailure(
  reads: Map<string, Promise<unknown>>,
  error: unknown,
): void {
  failures.set(reads, error);
  reads.set("dispatch scope failure", Promise.resolve(error));
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, ordered(item)]),
    );
  return value;
}

/** Keep failures too: a second repository does not retry an offline scope in the same tick. */
export function sharedDispatchRead(
  reads: Map<string, Promise<unknown>> | undefined,
  request: unknown,
  send: () => Promise<unknown>,
): Promise<unknown> {
  if (reads === undefined) return send();
  const key = JSON.stringify(ordered(request));
  const previous = reads.get(key);
  if (previous !== undefined) return previous;
  const failure = reads.get("dispatch scope failure");
  const answer =
    failure === undefined
      ? send()
      : failure.then((error) => Promise.reject(error));
  const settled = answer.catch((error) => {
    if (isUnavailable(error)) recordDispatchScopeFailure(reads, error);
    return Promise.reject(error);
  });
  reads.set(key, settled);
  return settled;
}
