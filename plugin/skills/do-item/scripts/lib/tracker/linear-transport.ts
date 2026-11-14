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
 *
 * Every other failure is a `LinearApiError` whose code is the failure class
 * (`shared/outbound/failure.ts`) this module reads from the answer: no
 * answer is `unreachable`, a 5xx `server-fault`, Linear's
 * `RATELIMITED` `rate-limited`, a refused key `unauthorized`, a missing
 * entity `not-found`, and any other error `invalid`. A query (any request
 * that is not a `mutation`) that met `unreachable` or `server-fault` is sent
 * once more inside its deadline (`shared/outbound/retry.ts`); a mutation is
 * never sent twice. In a run that holds the systems that do not answer
 * (`shared/outbound/hold.ts`), Linear is held after such a failure.
 */

import { randomUUID } from "node:crypto";
import { type RunResult, run } from "../../../../drive-pr/scripts/lib/proc.ts";
import { postGraphQL, runClient } from "./graphql.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  answerClass,
  type FailureClass,
  type OutboundFailure,
  OutboundError,
  retryAfterMs,
  statusClass,
} from "../../../../../shared/outbound/failure.ts";
import { guarded } from "../../../../../shared/outbound/hold.ts";
import { retryRead } from "../../../../../shared/outbound/retry.ts";
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

/** The error for a request the caller's signal ended: no answer came. */
function abortedError(signal: AbortSignal, sent = false): LinearApiError {
  const reason: unknown = signal.reason;
  return new LinearApiError(
    `Linear request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
    null,
    "unreachable",
    sent ? { sent: true } : {},
  );
}

/** The system Linear's requests are held under in a run that holds them. */
const LINEAR = "linear";

/**
 * Linear answered with an error, or could not be asked. Its `code` is the
 * failure class; when none is given it is read from `status`. `notFound` is
 * a `not-found` answer: the entity does not exist or is not visible, which
 * a read reports as absent.
 */
export class LinearApiError extends OutboundError {
  override name = "LinearApiError";
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only, and parameter properties generate code.
  readonly status: number | null;
  constructor(
    message: string,
    status: number | null,
    code: FailureClass = (status === null ? null : statusClass(status)) ??
      "invalid",
    extra: {
      until?: number | null;
      sent?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(code, message, extra);
    this.status = status;
  }
  get notFound(): boolean {
    return this.code === "not-found";
  }
}

/** Whether a GraphQL document is a mutation: anything else only reads. */
export function isMutation(query: string): boolean {
  return /^\s*mutation\b/.test(query.replace(/^\s*#.*$/gm, ""));
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

/** The class a body's errors name: a missing entity, a spent limit, a refused key, else the status's class or `invalid`. */
function errorsClass(errors: unknown[], status: number | null): FailureClass {
  const codes = errors.map((e) =>
    isRecord(e) && isRecord(e.extensions) ? e.extensions.code : undefined,
  );
  if (
    errors.every(
      (e) =>
        isRecord(e) &&
        typeof e.message === "string" &&
        e.message.startsWith("Entity not found"),
    )
  )
    return "not-found";
  if (codes.includes("RATELIMITED")) return "rate-limited";
  if (codes.includes("AUTHENTICATION_ERROR") || codes.includes("FORBIDDEN"))
    return "unauthorized";
  const byStatus = status === null ? null : statusClass(status);
  return byStatus === null || byStatus === "not-found" ? "invalid" : byStatus;
}

/** Turn a GraphQL response body into its `data`, or throw. */
export function unwrapResponse(
  body: unknown,
  status: number | null,
  retryAfter: number | null = null,
): unknown {
  if (!isRecord(body))
    throw new LinearApiError(
      "Linear returned a non-object body",
      status,
      status !== null && status >= 500 ? "server-fault" : "invalid",
    );
  if (Array.isArray(body.errors) && body.errors.length > 0)
    throw new LinearApiError(
      `Linear API errors: ${JSON.stringify(body.errors).slice(0, 500)}`,
      status,
      errorsClass(body.errors, status),
      { retryAfterMs: retryAfter },
    );
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

/** A request's answer: its data, or the failure it met, which the call throws once any retry is spent. */
type Answer = { data: unknown } | LinearApiError;

const failureOfAnswer = (answer: Answer): OutboundFailure | null =>
  answer instanceof LinearApiError ? answer.failure : null;

/** A request that a held run did not send. */
const heldAnswer = (failure: OutboundFailure): Answer =>
  new LinearApiError(failure.reason, null, failure.code);

/** Why a request `fetch` could not make was not answered: whether it left is unknown unless the name or the connection failed. */
function unreachable(err: unknown): LinearApiError {
  const said = err instanceof Error ? err.message : String(err);
  return new LinearApiError(
    `Linear API unreachable: ${said}`,
    null,
    "unreachable",
    {
      sent: !/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|Unable to connect/i.test(said),
    },
  );
}

/** One request's answer over HTTPS: its data, or its failure as a value; a governed refusal throws `TrackerRateLimited`. */
async function postOnce(
  fetchImpl: typeof fetch,
  token: string,
  governed: Governed | null,
  payload: { query: string; variables: Record<string, unknown> },
  signal: AbortSignal,
): Promise<Answer> {
  const sentAt = governed?.governor.admit("linear", governed.key);
  const began = Date.now();
  let res: Response;
  try {
    res = await postGraphQL(fetchImpl, LINEAR_API, token, payload, {
      timeoutMs: LINEAR_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (cancelled(signal)) return abortedError(signal, true);
    return unreachable(err);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (cancelled(signal)) return abortedError(signal, true);
    return new LinearApiError(
      `Linear API response lost: ${err instanceof Error ? err.message : String(err)}`,
      null,
      "unreachable",
      { sent: true },
    );
  }
  const body = jsonOrNull(text);
  const answer = linearAnswer(res.headers, res.status, body);
  settle(governed, answer, sentAt);
  // Linear answers a missing entity with HTTP 200 and an errors array, but
  // an error status may carry the same body.
  if (res.ok || errorsOf(body).length > 0)
    return unwrapped(body, res.status, answer, retryAfterMs(res.headers));
  return limited(
    new LinearApiError(
      `Linear API HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      answerClass(res.status, Date.now() - began) ?? "invalid",
      { retryAfterMs: retryAfterMs(res.headers) },
    ),
    answer,
  );
}

/** `text` as JSON, or `null` when it is not JSON. */
function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow(err, "an answer that is not JSON is read by its status or exit");
    return null;
  }
}

/** The errors a GraphQL body carries; none when it carries no list. */
function errorsOf(body: unknown): unknown[] {
  return isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
}

/** A body's data, or the failure its errors name, rate limited until `answer`'s reset when it refused the credential. */
function unwrapped(
  body: unknown,
  status: number | null,
  answer: BudgetAnswer,
  retryAfter: number | null,
): Answer {
  try {
    return { data: unwrapResponse(body, status, retryAfter) };
  } catch (err) {
    if (err instanceof LinearApiError) return limited(err, answer);
    throw err;
  }
}

/** An ungoverned refusal of a spent credential carries the time it clears. */
function limited(err: LinearApiError, answer: BudgetAnswer): LinearApiError {
  if (answer.limitedUntil === undefined) return err;
  return new LinearApiError(err.message, err.status, "rate-limited", {
    until: answer.limitedUntil,
  });
}

/**
 * One call: a query sent once more after a failure that may clear (`retryRead`),
 * a mutation once, both inside one `LINEAR_TIMEOUT_MS` deadline, through the
 * run's hold on Linear (`guarded`). Its data, or the failure thrown.
 */
async function call(
  send: (signal: AbortSignal) => Promise<Answer>,
  query: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (cancelled(signal)) throw abortedError(signal);
  const deadline = AbortSignal.timeout(LINEAR_TIMEOUT_MS);
  const bound =
    signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const deadlineAt = Date.now() + LINEAR_TIMEOUT_MS;
  // Once an attempt has begun, a cancellation may have cut a request that
  // landed: `retryRead` throws the bare reason, which carries no marker.
  let dispatched = false;
  const answer = await guarded(
    LINEAR,
    () =>
      retryRead(
        () => {
          dispatched = true;
          return send(bound);
        },
        {
          read: !isMutation(query),
          signal: bound,
          deadlineAt,
          failureOf: failureOfAnswer,
        },
      ).catch((err: unknown) => {
        const sent = dispatched || (err instanceof LinearApiError && err.sent);
        if (cancelled(signal)) throw abortedError(signal, sent);
        if (cancelled(bound)) return abortedError(bound, sent);
        throw err;
      }),
    failureOfAnswer,
    heldAnswer,
    bound,
  ).catch((err: unknown): Answer => {
    // A cancellation that met no request keeps nothing sent; one a dispatched
    // request met, or that an attempt already marked, keeps that fact.
    const sent = dispatched || (err instanceof LinearApiError && err.sent);
    if (cancelled(signal)) throw abortedError(signal, sent);
    if (cancelled(bound)) return abortedError(bound, sent);
    throw err;
  });
  if (answer instanceof LinearApiError) throw answer;
  return answer.data;
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
  return dispatchTagged(
    (query, variables, signal) =>
      call(
        (bound) =>
          postOnce(fetchImpl, token, governed, { query, variables }, bound),
        query,
        signal,
      ),
    credentialKey("linear", token),
    true,
  );
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
    return r.stderr.includes("ENOENT")
      ? new LinearApiError(
          "no Linear credential: set LINEAR_API_KEY (or LINEAR_API_TOKEN), or install and log in to the `linear` command-line client",
          null,
          "unauthorized",
        )
      : new LinearApiError(`linear api failed: ${r.stderr}`, null, "invalid");
  if (r.timedOut)
    return new LinearApiError("linear api timed out", null, "unreachable", {
      sent: true,
    });
  if (r.bufferExceeded)
    return new LinearApiError(
      "linear api printed more output than can be held; stopped it",
      null,
      "invalid",
    );
  return null;
}

/** The class a failed client run's own words name, when it printed no JSON. */
function cliClass(said: string): FailureClass {
  if (/rate.?limit/i.test(said)) return "rate-limited";
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(
      said,
    )
  )
    return "unreachable";
  if (/unauthori[sz]ed|authentication|not logged in|log ?in/i.test(said))
    return "unauthorized";
  return "invalid";
}

/** One request's answer through the client; a governed refusal throws `TrackerRateLimited`. */
async function cliOnce(
  bin: string,
  governed: Governed | null,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Answer> {
  governed?.governor.admit("linear", governed.key);
  const r = await runCli(
    [bin, "api", query, "--variables-json", JSON.stringify(variables)],
    signal,
  );
  if (cancelled(signal)) return abortedError(signal, true);
  return cliFailure(r) ?? cliAnswer(r, governed);
}

/** What a client run that finished answered. */
function cliAnswer(r: RunResult, governed: Governed | null): Answer {
  const said = (r.stderr || r.stdout).slice(0, 300);
  const body = jsonOrNull(r.stdout);
  if (body === null)
    return new LinearApiError(
      `linear api returned no JSON (exit ${r.code}): ${said}`,
      null,
      r.code === 0 ? "invalid" : cliClass(said),
    );
  const refused: BudgetAnswer = rateLimitedBody(body)
    ? {
        limitedUntil: Date.now() + FALLBACK_LIMIT_MS,
        why: "Linear refused the request (RATELIMITED)",
      }
    : {};
  if (refused.limitedUntil !== undefined) settle(governed, refused);
  // A failed invocation is a failure even when its output parses: report
  // the errors it carries, else its exit status.
  if (r.code !== 0 && errorsOf(body).length === 0)
    return new LinearApiError(
      `linear api exited ${r.code}: ${said}`,
      null,
      cliClass(said),
    );
  return unwrapped(body, null, refused, null);
}

/** A transport carrying the dispatch identity its snapshots are keyed by. */
function dispatchTagged(
  transport: LinearTransport,
  dispatchCredential: string,
  dispatchPersistent: boolean,
): LinearTransport {
  return Object.assign(transport, { dispatchCredential, dispatchPersistent });
}

/** The CLI hides its credential, so its dispatch snapshots live for this process only. */
const CLI_DISPATCH_SESSION = randomUUID();

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
  return dispatchTagged(
    (query, variables, signal) =>
      call(
        (bound) => cliOnce(bin, governed, query, variables, bound),
        query,
        signal,
      ),
    credentialKey("linear", `cli:${bin}:${CLI_DISPATCH_SESSION}`),
    false,
  );
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

const transportKeys = new WeakMap<LinearTransport, string>();
let nextTransportKey = 0;
/** The actual configured credential, or a test transport’s isolated identity. */
export function dispatchCredential(transport: LinearTransport): string {
  const supplied = (
    transport as LinearTransport & { dispatchCredential?: string }
  ).dispatchCredential;
  if (supplied !== undefined) return supplied;
  let key = transportKeys.get(transport);
  if (key === undefined) {
    key = `transport-${++nextTransportKey}`;
    transportKeys.set(transport, key);
  }
  return key;
}

/** An opaque CLI identity expires with this process and cannot key a durable snapshot. */
export function dispatchPersistent(transport: LinearTransport): boolean {
  return (
    (transport as LinearTransport & { dispatchPersistent?: boolean })
      .dispatchPersistent !== false
  );
}
