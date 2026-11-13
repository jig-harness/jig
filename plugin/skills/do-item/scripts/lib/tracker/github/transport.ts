/**
 * GitHub's GraphQL API, for the GitHub tracker adapter and the GitHub
 * reflection store.
 *
 * Two transports exist. By default every request is `gh api graphql`, which
 * holds its own credential (`gh auth login`, or `GH_TOKEN` / `GITHUB_TOKEN`)
 * and knows the host. With `JIG_GITHUB_GRAPHQL_URL` set, requests go over
 * HTTPS to that endpoint with the token from `GH_TOKEN` or `GITHUB_TOKEN`
 * instead: a GitHub Enterprise endpoint `gh` is not signed in to, or a local
 * fake (plain `http` is accepted for a loopback address only). Tests of the
 * adapter pass a fake transport.
 *
 * A failure is a `GitHubApiError` whose code is its failure class
 * (`shared/outbound/failure.ts`), read from the answer's status, headers
 * and GraphQL error types by the library (`shared/outbound/github.ts`). A
 * request its builder marks as a read is sent once more after `unreachable`
 * or `server-fault`, inside the call's deadline (`shared/outbound/retry.ts`).
 */

import {
  type RunResult,
  ghCall,
} from "../../../../../drive-pr/scripts/lib/proc.ts";
import { swallow } from "../../../../../../shared/errors.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
import {
  type FailureClass,
  type OutboundFailure,
  OutboundError,
  outboundFailure,
} from "../../../../../../shared/outbound/failure.ts";
import {
  GITHUB,
  ghRunFailure,
  gitHubHttpFailure,
  graphQLErrorsClass,
} from "../../../../../../shared/outbound/github.ts";
import { guarded } from "../../../../../../shared/outbound/hold.ts";
import { retryRead } from "../../../../../../shared/outbound/retry.ts";
import { pager, postGraphQL, runClient } from "../graphql.ts";

export const GITHUB_TIMEOUT_MS = 30_000;

/**
 * A GraphQL request; resolves to the response's `data`. An aborted `signal`
 * ends the request in flight and refuses to start one. Builders mark queries
 * idempotent explicitly; unmarked requests and mutations never retry.
 */
export type GitHubTransport = (
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  idempotent?: boolean,
) => Promise<unknown>;

/**
 * GitHub answered with an error, or could not be asked. Its `code` is the
 * failure class (`invalid` when none is given). `notFound` is a `not-found`
 * answer, and `data` then holds whatever the rest of the request read;
 * `unavailable` a class that clears by waiting (no answer, a rate limit, a
 * server fault), which a caller may report as "try later".
 */
export class GitHubApiError extends OutboundError {
  override name = "GitHubApiError";
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only.
  readonly data: unknown;
  constructor(
    message: string,
    opts: {
      code?: FailureClass;
      data?: unknown;
      until?: number | null;
      sent?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(opts.code ?? "invalid", message, opts);
    this.data = opts.data ?? null;
  }
  get notFound(): boolean {
    return this.code === "not-found";
  }
  get unavailable(): boolean {
    return this.clearsByWaiting;
  }
  /** The seconds GitHub's `Retry-After` header asked to wait, when it sent one. */
  get retryAfterSec(): number | null {
    return this.retryAfterMs === null ? null : this.retryAfterMs / 1000;
  }
}

/** A failure as the adapter's error. */
function errorOf(failure: OutboundFailure, data?: unknown): GitHubApiError {
  return new GitHubApiError(failure.reason, {
    code: failure.code,
    data,
    until: failure.until ?? null,
    sent: failure.sent ?? false,
    retryAfterMs: failure.retryAfterMs ?? null,
  });
}

function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function abortedError(signal: AbortSignal): GitHubApiError {
  const reason: unknown = signal.reason;
  return new GitHubApiError(
    `GitHub request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
    { code: "unreachable" },
  );
}

/**
 * Turn a GraphQL response body into its `data`, or throw. `failure` is
 * that of a request that already failed (an error status or exit): its
 * class stands whatever the body's errors say, since GitHub answers a
 * query timeout with a 502 whose errors carry no type.
 */
export function unwrapResponse(
  body: unknown,
  failure: OutboundFailure | null = null,
): unknown {
  if (!isRecord(body))
    throw errorOf(
      failure ??
        outboundFailure("invalid", "GitHub returned a non-object body"),
    );
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const types = body.errors.map((e) =>
      isRecord(e) && typeof e.type === "string" ? e.type : "",
    );
    const message = `GitHub API errors: ${JSON.stringify(body.errors).slice(0, 500)}`;
    const code = failure?.code ?? graphQLErrorsClass(types);
    throw errorOf(
      outboundFailure(code, message, {
        until: failure?.until ?? null,
        retryAfterMs: failure?.retryAfterMs ?? null,
      }),
      body.data,
    );
  }
  if (!("data" in body))
    throw new GitHubApiError(
      `GitHub returned no data: ${JSON.stringify(body).slice(0, 300)}`,
    );
  return body.data;
}

/** The JSON `text` holds, or `null`. */
function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow(err, "an error response's body is not JSON; its status says why");
    return null;
  }
}

/** One request's answer: the response body, or the failure it met. */
type Answer = { body: unknown } | GitHubApiError;

const failureOfAnswer = (answer: Answer): OutboundFailure | null =>
  answer instanceof GitHubApiError ? answer.failure : null;

/**
 * One call: a read sent once more after a failure that may clear
 * (`retryRead`), a write once, both inside one `GITHUB_TIMEOUT_MS`
 * deadline, through the run's hold on GitHub. The data, or the failure
 * thrown.
 */
async function call(
  send: (bound: AbortSignal) => Promise<Answer>,
  signal: AbortSignal | undefined,
  read: boolean,
  hold: string | null,
): Promise<unknown> {
  if (cancelled(signal)) throw abortedError(signal);
  const deadline = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  const bound =
    signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const deadlineAt = Date.now() + GITHUB_TIMEOUT_MS;
  const retried = () =>
    retryRead(() => send(bound), {
      read,
      signal: bound,
      deadlineAt,
      failureOf: failureOfAnswer,
    }).catch((err: unknown): Answer => {
      if (cancelled(signal)) throw abortedError(signal);
      if (cancelled(bound)) return abortedError(bound);
      throw err;
    });
  // A `gh` run is held where every `gh` call is (`ghCall`); an HTTPS request here, under its endpoint's host.
  const answer =
    hold === null
      ? await retried()
      : await guarded(hold, retried, failureOfAnswer, (f) => errorOf(f));
  if (answer instanceof GitHubApiError) throw answer;
  return unwrapResponse(answer.body);
}

/** One `gh api graphql` run's answer, its body read with the status and headers `--include` prints. */
async function ghOnce(
  runner: typeof ghCall,
  payload: { query: string; variables: Record<string, unknown> },
  bound: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  const began = Date.now();
  const r = await runClient(
    runner,
    ["api", "graphql", "--include", "--input", "-"],
    {
      stdin: JSON.stringify(payload),
      timeoutMs: GITHUB_TIMEOUT_MS,
      signal: bound,
    },
  );
  if (cancelled(signal)) return abortedError(signal);
  return ghRunAnswer(r, Date.now() - began);
}

/** What a finished `gh api graphql` run that took `tookMs` answered. */
function ghRunAnswer(r: RunResult, tookMs: number): Answer {
  const run = ghRunFailure(r, tookMs);
  if (r.spawnFailed || r.timedOut || r.bufferExceeded)
    return errorOf(run ?? outboundFailure("invalid", "gh api graphql failed"));
  const parsed = ghHeaders(r.stdout);
  const body = parsedOrNull(parsed.body);
  if (r.code !== 0) return ghExitAnswer(r, parsed, body, run, tookMs);
  if (body === null && parsed.body.trim() !== "")
    return new GitHubApiError(
      `gh api graphql returned no JSON (exit 0): ${parsed.body.trim().slice(0, 300)}`,
    );
  return { body };
}

/**
 * A failed run is a failure even when its output parses: its status when
 * `--include` printed one, else what `gh` said, names the class, and the
 * GraphQL errors it carries name it where the status was a success.
 */
function ghExitAnswer(
  r: RunResult,
  parsed: { status: number; headers: Headers; body: string },
  body: unknown,
  run: OutboundFailure | null,
  tookMs: number,
): GitHubApiError {
  const answered = parsed.status !== 200;
  const failure =
    (answered
      ? gitHubHttpFailure(parsed.status, parsed.headers, parsed.body, tookMs)
      : null) ??
    run ??
    outboundFailure("invalid", `gh api graphql exited ${r.code}`);
  const named = errorsFailure(body, answered ? failure : null);
  if (named !== null) return named;
  const said = (r.stderr || parsed.body).trim().slice(0, 300);
  return errorOf({
    ...failure,
    reason: `gh api graphql exited ${r.code}: ${said}`,
  });
}

/** The failure the GraphQL errors of a failed answer name, `failure` standing over their types; `null` when it carries none. */
function errorsFailure(
  body: unknown,
  failure: OutboundFailure | null,
): GitHubApiError | null {
  if (
    !isRecord(body) ||
    !Array.isArray(body.errors) ||
    body.errors.length === 0
  )
    return null;
  try {
    unwrapResponse(body, failure);
  } catch (err) {
    if (err instanceof GitHubApiError) return err;
    throw err;
  }
  return null;
}

/**
 * Transport through `gh api graphql`, run through drive-pr's deadline
 * wrapper (`runClient`). The request travels on standard input as one JSON
 * body, so variables keep their types and nothing reaches the command line.
 */
export function ghTransport(runner: typeof ghCall = ghCall): GitHubTransport {
  return (query, variables, signal, idempotent = false) =>
    call(
      (bound) => ghOnce(runner, { query, variables }, bound, signal),
      signal,
      idempotent,
      null,
    );
}

/** `gh --include` prints the HTTP status and headers before the JSON body. */
function ghHeaders(stdout: string): {
  status: number;
  headers: Headers;
  body: string;
} {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (separator === null || separator.index === undefined)
    return { status: 200, headers: new Headers(), body: stdout };
  const headerLines = stdout.slice(0, separator.index).split(/\r?\n/);
  const statusLine = headerLines.shift() ?? "";
  const status = Number(statusLine.split(" ")[1]);
  if (!statusLine.startsWith("HTTP/") || !Number.isInteger(status))
    return { status: 200, headers: new Headers(), body: stdout };
  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return {
    status,
    headers,
    body: stdout.slice(separator.index + separator[0].length),
  };
}

/**
 * The credential the transport the environment asks for uses, by where it
 * comes from: never the token itself or the account it signs in as.
 */
export function credentialOf(env = process.env): string {
  const token = env.GH_TOKEN?.trim()
    ? "GH_TOKEN"
    : env.GITHUB_TOKEN?.trim()
      ? "GITHUB_TOKEN"
      : null;
  if (env.JIG_GITHUB_GRAPHQL_URL?.trim())
    return `${token ?? "no token"} at JIG_GITHUB_GRAPHQL_URL`;
  return token === null ? "gh's signed-in account" : `gh with ${token}`;
}

/** The token for the HTTPS transport, or `null`. */
export function resolveGitHubToken(env = process.env): string | null {
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || null;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

/** One HTTPS request's answer. */
async function postOnce(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: { query: string; variables: Record<string, unknown> },
  bound: AbortSignal,
): Promise<Answer> {
  const began = Date.now();
  let res: Response;
  try {
    res = await postGraphQL(fetchImpl, url, `bearer ${token}`, payload, {
      timeoutMs: GITHUB_TIMEOUT_MS,
      signal: bound,
    });
  } catch (err) {
    if (cancelled(bound)) return abortedError(bound);
    return new GitHubApiError(
      `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { code: "unreachable", sent: true },
    );
  }
  const text = await res.text().catch(() => "");
  if (cancelled(bound)) return abortedError(bound);
  const body = parsedOrNull(text);
  const failure = gitHubHttpFailure(
    res.status,
    res.headers,
    text,
    Date.now() - began,
  );
  if (failure === null) return { body };
  return errorsFailure(body, failure) ?? errorOf(failure);
}

/** HTTPS transport to `url` with `token`; each call bounded by `GITHUB_TIMEOUT_MS`. */
export function httpTransport(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): GitHubTransport {
  if (!url.startsWith("https://") && !LOOPBACK.test(url))
    throw new GitHubApiError(
      `JIG_GITHUB_GRAPHQL_URL must be an https address, or http on a loopback address (got ${url})`,
    );
  return (query, variables, signal, idempotent = false) =>
    call(
      (bound) => postOnce(fetchImpl, url, token, { query, variables }, bound),
      signal,
      idempotent,
      `${GITHUB}:${new URL(url).host}`,
    );
}

/**
 * The transport the environment asks for: HTTPS to `JIG_GITHUB_GRAPHQL_URL`
 * when it is set (a token is then required), else `gh`.
 */
export function defaultTransport(env = process.env): GitHubTransport {
  const url = env.JIG_GITHUB_GRAPHQL_URL?.trim();
  if (url === undefined || url === "") return ghTransport();
  const token = resolveGitHubToken(env);
  if (token === null)
    throw new GitHubApiError(
      "JIG_GITHUB_GRAPHQL_URL is set, so GH_TOKEN or GITHUB_TOKEN must hold a token for it",
      { code: "unauthorized" },
    );
  return httpTransport(url, token);
}

/**
 * The token the transport the environment asks for signs in with, for a
 * fingerprint only: `GH_TOKEN` or `GITHUB_TOKEN`, else what `gh auth token`
 * prints; `null` when there is none to read.
 */
export function credentialToken(
  env = process.env,
): (signal?: AbortSignal) => Promise<string | null> {
  return async (signal) => {
    const own = resolveGitHubToken(env);
    if (own !== null) return own;
    if (env.JIG_GITHUB_GRAPHQL_URL?.trim()) return null;
    try {
      const r = await runClient(ghCall, ["auth", "token"], {
        timeoutMs: 10_000,
        signal,
      });
      const token = r.stdout.trim();
      return r.code === 0 && token !== "" ? token : null;
    } catch (err) {
      swallow(err, "with no token to fingerprint, detection is not cached");
      return null;
    }
  };
}

/** Read every page of one connection (`pager`); nodes are told apart by id. */
export const pageAll = pager({
  idOf: (node) => node.id,
  fail: (message) => new GitHubApiError(message),
});
