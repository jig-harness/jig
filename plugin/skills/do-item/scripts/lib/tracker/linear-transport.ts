/**
 * The Linear adapter's transports: HTTPS to Linear's API with a personal API
 * key (`LINEAR_API_KEY`, or `LINEAR_API_TOKEN`), and, when no key is set, the
 * `linear` command-line client's `api` subcommand, which holds its own
 * credential.
 *
 * Both go through the machine's request budget (`shared/tracker-budget.ts`)
 * when given one, as `defaultTransport` does: a request is not sent while the
 * credential is rate limited, and every answer's rate-limit headers update
 * the budget. Linear refuses a spent credential with HTTP 400 or 429 and the
 * GraphQL error code `RATELIMITED`; that answer marks the credential limited
 * until the reset its headers name (`X-RateLimit-Requests-Reset` or the
 * complexity pair, epoch milliseconds), and the request fails with
 * `TrackerRateLimited`.
 */

import { type RunResult, run } from "../../../../drive-pr/scripts/lib/proc.ts";
import { postGraphQL, runClient } from "./graphql.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  type BudgetAnswer,
  type BudgetGovernor,
  type BudgetWindow,
  credentialKey,
  defaultGovernor,
  FALLBACK_LIMIT_MS,
  TrackerRateLimited,
} from "../../../../../shared/tracker-budget.ts";

export const LINEAR_API = "https://api.linear.app/graphql";
export const LINEAR_TIMEOUT_MS = 30_000;
/** How long Linear's rate limits take to refill from empty. */
const LINEAR_REFILL_MS = 3_600_000;

/**
 * A GraphQL request; resolves to the response's `data`. An aborted `signal`
 * ends the request in flight and refuses to start one.
 */
export type LinearTransport = (
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Has the caller cancelled? A function, not an inline test, so a check after
 * an `await` is not narrowed away by the one before it.
 */
function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

/** The error for a request the caller's signal ended. */
function abortedError(signal: AbortSignal): LinearApiError {
  const reason: unknown = signal.reason;
  return new LinearApiError(
    `Linear request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
    null,
  );
}

/**
 * Linear answered with an error. `notFound` is set when the answer is that the
 * entity does not exist (or is not visible), which a read reports as absent.
 */
export class LinearApiError extends Error {
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only, and parameter properties generate code.
  readonly status: number | null;
  readonly notFound: boolean;
  constructor(message: string, status: number | null, notFound = false) {
    super(message);
    this.status = status;
    this.notFound = notFound;
  }
}

/** The credential from the environment, or `null`. */
export function resolveLinearToken(env = process.env): string | null {
  return env.LINEAR_API_KEY?.trim() || env.LINEAR_API_TOKEN?.trim() || null;
}

/** Whether a response body is Linear's rate-limit refusal. */
export function rateLimitedBody(body: unknown): boolean {
  return (
    isRecord(body) &&
    Array.isArray(body.errors) &&
    body.errors.some(
      (e) =>
        isRecord(e) &&
        isRecord(e.extensions) &&
        e.extensions.code === "RATELIMITED",
    )
  );
}

/** Turn a GraphQL response body into its `data`, or throw. */
export function unwrapResponse(body: unknown, status: number | null): unknown {
  if (!isRecord(body))
    throw new LinearApiError("Linear returned a non-object body", status);
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const notFound = body.errors.every(
      (e) =>
        isRecord(e) &&
        typeof e.message === "string" &&
        e.message.startsWith("Entity not found"),
    );
    throw new LinearApiError(
      `Linear API errors: ${JSON.stringify(body.errors).slice(0, 500)}`,
      status,
      notFound,
    );
  }
  return body.data;
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function window(headers: Headers, kind: string): BudgetWindow | undefined {
  const limit = headerNumber(headers, `x-ratelimit-${kind}-limit`);
  const remaining = headerNumber(headers, `x-ratelimit-${kind}-remaining`);
  const resetAt = headerNumber(headers, `x-ratelimit-${kind}-reset`);
  // Linear's limits are leaky buckets: each refills over an hour, and the
  // reset it names is a full refill away from the answer.
  return limit === null && remaining === null && resetAt === null
    ? undefined
    : { limit, remaining, resetAt, refillMs: LINEAR_REFILL_MS };
}

/**
 * When a refused credential may send again: the spent window's reset, else
 * `Retry-After`, else the latest reset named, else the fallback.
 */
function limitedUntil(
  answer: BudgetAnswer,
  retryAfter: number | null,
  now: number,
): number {
  const windows = [answer.requests, answer.complexity].filter(
    (w): w is BudgetWindow => w !== undefined,
  );
  const spent = windows.find(
    (w) => w.remaining !== null && w.remaining <= 0 && (w.resetAt ?? 0) > now,
  );
  if (spent?.resetAt) return spent.resetAt;
  if (retryAfter !== null) return now + retryAfter * 1000;
  const resets = windows
    .map((w) => w.resetAt ?? 0)
    .filter((r) => r > now)
    .sort((a, b) => b - a);
  return resets[0] ?? now + FALLBACK_LIMIT_MS;
}

/** What an answer said of the budget, and whether it refused the credential. */
export function linearAnswer(
  headers: Headers,
  status: number,
  body: unknown,
  now = Date.now(),
): BudgetAnswer {
  const answer: BudgetAnswer = {};
  const requests = window(headers, "requests");
  const complexity = window(headers, "complexity");
  if (requests !== undefined) answer.requests = requests;
  if (complexity !== undefined) answer.complexity = complexity;
  if (status === 429 || rateLimitedBody(body)) {
    answer.limitedUntil = limitedUntil(
      answer,
      headerNumber(headers, "retry-after"),
      now,
    );
    answer.why = `Linear refused the request (HTTP ${status}, RATELIMITED)`;
  }
  return answer;
}

/** The budget a transport checks and updates, and the credential's key in it. */
interface Governed {
  governor: BudgetGovernor;
  key: string;
}

/** Record an answer; a refusal ends the request with `TrackerRateLimited`. */
function settle(
  governed: Governed | null,
  answer: BudgetAnswer,
  sentAt?: number,
): void {
  if (governed === null) return;
  governed.governor.observe(governed.key, answer, sentAt);
  if (answer.limitedUntil !== undefined)
    throw new TrackerRateLimited(
      "linear",
      answer.limitedUntil,
      answer.why ?? "Linear refused the request",
    );
}

/**
 * HTTPS transport with an API key; each call is bounded by
 * `LINEAR_TIMEOUT_MS`. With `governor`, a call is refused locally while the
 * credential is rate limited, and every answer updates the budget.
 */
export function httpTransport(
  token: string,
  fetchImpl: typeof fetch = fetch,
  governor?: BudgetGovernor,
): LinearTransport {
  const governed: Governed | null =
    governor === undefined
      ? null
      : { governor, key: credentialKey("linear", token) };
  return async (query, variables, signal) => {
    if (cancelled(signal)) throw abortedError(signal);
    const sentAt = governed?.governor.admit("linear", governed.key);
    let res: Response;
    try {
      res = await postGraphQL(
        fetchImpl,
        LINEAR_API,
        token,
        { query, variables },
        { timeoutMs: LINEAR_TIMEOUT_MS, signal },
      );
    } catch (err) {
      if (cancelled(signal)) throw abortedError(signal);
      throw new LinearApiError(
        `Linear API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Linear answers a missing entity with HTTP 200 and an errors array, but
      // an error status may carry the same body.
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON
      }
      settle(governed, linearAnswer(res.headers, res.status, body), sentAt);
      if (isRecord(body) && Array.isArray(body.errors))
        unwrapResponse(body, res.status);
      throw new LinearApiError(
        `Linear API HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const body: unknown = await res.json();
    settle(governed, linearAnswer(res.headers, res.status, body), sentAt);
    return unwrapResponse(body, res.status);
  };
}

/**
 * Runs the client through the shared runner (`runClient`), ended at
 * `LINEAR_TIMEOUT_MS` or when `signal` aborts.
 */
function runCli(
  argv: string[],
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  return runClient(run, argv, { timeoutMs: LINEAR_TIMEOUT_MS, signal });
}

/** Why a finished client run cannot be read as a response, if it cannot. */
function cliFailure(r: RunResult): LinearApiError | null {
  if (r.spawnFailed)
    return new LinearApiError(
      r.stderr.includes("ENOENT")
        ? "no Linear credential: set LINEAR_API_KEY (or LINEAR_API_TOKEN), or install and log in to the `linear` command-line client"
        : `linear api failed: ${r.stderr}`,
      null,
    );
  if (r.timedOut) return new LinearApiError("linear api timed out", null);
  if (r.bufferExceeded)
    return new LinearApiError(
      "linear api printed more output than can be held; stopped it",
      null,
    );
  return null;
}

/**
 * Transport through the `linear` command-line client (`linear api`), which
 * keeps its own credential. Variables travel as JSON so a string that looks
 * like a number stays a string. The client shows no headers, so with
 * `governor` only a refusal is recorded, for `FALLBACK_LIMIT_MS`. The record
 * is the executable's (`bin`), not an authenticated profile's: every profile
 * the client holds shares it, and it is not shared with a token's HTTP record.
 */
export function cliTransport(
  bin = "linear",
  governor?: BudgetGovernor,
): LinearTransport {
  const governed: Governed | null =
    governor === undefined
      ? null
      : { governor, key: credentialKey("linear", `cli:${bin}`) };
  return async (query, variables, signal) => {
    if (cancelled(signal)) throw abortedError(signal);
    governed?.governor.admit("linear", governed.key);
    const r = await runCli(
      [bin, "api", query, "--variables-json", JSON.stringify(variables)],
      signal,
    );
    if (cancelled(signal)) throw abortedError(signal);
    const failure = cliFailure(r);
    if (failure !== null) throw failure;
    let body: unknown;
    try {
      body = JSON.parse(r.stdout);
    } catch {
      throw new LinearApiError(
        `linear api returned no JSON (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 300)}`,
        null,
      );
    }
    if (rateLimitedBody(body))
      settle(governed, {
        limitedUntil: Date.now() + FALLBACK_LIMIT_MS,
        why: "Linear refused the request (RATELIMITED)",
      });
    // A failed invocation is a failure even when its output parses: report
    // the errors it carries, else its exit status.
    if (r.code !== 0) {
      if (isRecord(body) && Array.isArray(body.errors))
        unwrapResponse(body, null);
      throw new LinearApiError(
        `linear api exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`,
        null,
      );
    }
    return unwrapResponse(body, null);
  };
}

/**
 * The transport the environment supports, an API key first, else the CLI,
 * through the machine's request budget.
 */
export function defaultTransport(
  env = process.env,
  governor: BudgetGovernor = defaultGovernor(),
): LinearTransport {
  const token = resolveLinearToken(env);
  return token === null
    ? cliTransport("linear", governor)
    : httpTransport(token, fetch, governor);
}
