import { spawnSync } from "../../../../plugin/shared/guarded-git-spawn.ts";
import type {
  GhApi,
  GhResult,
} from "../../../../plugin/skills/changelog/scripts/github-rules.ts";
import { gitEnv } from "../../../../plugin/skills/changelog/scripts/notes-dir.ts";

/** When each live operation signal's deadline falls, on `performance.now()`. */
const dues = new WeakMap<AbortSignal, number>();

/**
 * Bound one adapter operation. The work receives a signal that aborts at the
 * deadline; the caller stops waiting then even if the work ignores the signal,
 * so a stalled adapter cannot hold back the rest of the run. Synchronous work
 * blocks the timer, so a result that arrives after the deadline is rejected as
 * late rather than counted: overrunning work never succeeds, it only delays the
 * failure until it yields.
 */
export async function withDeadline<T>(
  ms: number,
  what: string,
  work: (signal: AbortSignal) => T | Promise<T>,
  timeoutError: (message: string) => Error,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0)
    throw timeoutError(`invalid deadline for ${what}: ${ms}`);
  const controller = new AbortController();
  const expiredError = () =>
    timeoutError(`${what} did not finish within ${ms} ms`);
  const due = performance.now() + ms;
  dues.set(controller.signal, due);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = expiredError();
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      expired,
    ]);
    if (performance.now() >= due) {
      const error = expiredError();
      controller.abort(error);
      throw error;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Milliseconds left on `signal`'s operation deadline; unbounded for any other signal. */
export function remainingMs(signal: AbortSignal | undefined): number {
  const due = signal && dues.get(signal);
  return due === undefined ? Infinity : Math.max(0, due - performance.now());
}

/** One `gh api` request bounded to `timeoutMs`; tests inject a fake. */
export type GhTransport = (args: string[], timeoutMs: number) => GhResult;

/** The ceiling on one request, whatever budget its operation has left. */
export const GH_REQUEST_MS = 30_000;

/** `gh api` as a child process, with a clean environment plus `env`. */
export function ghProcess(env: Record<string, string> = {}): GhTransport {
  return (args, timeoutMs) => {
    const result = spawnSync("gh", ["api", ...args], {
      env: { ...gitEnv(), ...env },
      timeout: timeoutMs,
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout ?? "",
      stderr:
        result.stderr ||
        (result.error ? String(result.error.message) : "") ||
        (result.status === null ? "gh api timed out" : ""),
    };
  };
}

/**
 * The transport as the shared synchronous reader expects it, held to the
 * operation's deadline: no request starts once the deadline has passed, even
 * while synchronous work keeps the timer from firing, and each request runs at
 * most until the deadline.
 */
export function withinDeadline(
  gh: GhTransport,
  signal: AbortSignal | undefined,
  timeoutError: (message: string) => Error,
): GhApi {
  return (args) => {
    const left = remainingMs(signal);
    if (signal?.aborted || left <= 0)
      throw timeoutError(
        `operation did not finish within its deadline; ${args[0] ?? "gh api"} not requested`,
      );
    return gh(args, Math.min(GH_REQUEST_MS, left));
  };
}
