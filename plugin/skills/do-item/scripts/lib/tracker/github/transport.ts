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
 */

import { retryAfterSeconds, retryRead } from "../read-retry.ts";
import {
  type RunResult,
  ghCall,
} from "../../../../../drive-pr/scripts/lib/proc.ts";
import { swallow } from "../../../../../../shared/errors.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
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
 * GitHub answered with an error. `notFound` is set when every error says the
 * thing asked for does not exist (or is not visible), and `data` then holds
 * whatever the rest of the request read; `unavailable` when the request
 * could not be made or answered at all (no credential, the network, a rate
 * limit, a server error), which a caller may report as "try later".
 */
export class GitHubApiError extends Error {
  // Declared fields, not parameter properties: the repository's TypeScript
  // settings allow erasable syntax only.
  readonly notFound: boolean;
  readonly unavailable: boolean;
  readonly data: unknown;
  /** The seconds GitHub's `Retry-After` header asked to wait, when it sent one. */
  readonly retryAfterSec: number | null;
  constructor(
    message: string,
    opts: {
      notFound?: boolean;
      unavailable?: boolean;
      data?: unknown;
      retryAfterSec?: number | null;
    } = {},
  ) {
    super(message);
    this.notFound = opts.notFound ?? false;
    this.unavailable = opts.unavailable ?? false;
    this.data = opts.data ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }
}

function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function abortedError(signal: AbortSignal): GitHubApiError {
  const reason: unknown = signal.reason;
  return new GitHubApiError(
    `GitHub request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
}

const UNAVAILABLE_TYPES = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

/**
 * Turn a GraphQL response body into its `data`, or throw. `failure`
 * describes a request that already failed (an error status or exit): what
 * makes it unavailable stays so whatever the body's errors say, since
 * GitHub answers a query timeout with a 502 whose errors carry no type.
 */
export function unwrapResponse(
  body: unknown,
  failure: { unavailable: boolean; retryAfterSec?: number | null } = {
    unavailable: false,
  },
): unknown {
  if (!isRecord(body))
    throw new GitHubApiError("GitHub returned a non-object body", failure);
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const types = body.errors.map((e) =>
      isRecord(e) && typeof e.type === "string" ? e.type : "",
    );
    throw new GitHubApiError(
      `GitHub API errors: ${JSON.stringify(body.errors).slice(0, 500)}`,
      {
        notFound: types.every((t) => t === "NOT_FOUND"),
        unavailable:
          failure.unavailable || types.some((t) => UNAVAILABLE_TYPES.has(t)),
        data: body.data,
        retryAfterSec: failure.retryAfterSec ?? null,
      },
    );
  }
  if (!("data" in body))
    throw new GitHubApiError(
      `GitHub returned no data: ${JSON.stringify(body).slice(0, 300)}`,
    );
  return body.data;
}

/** Why a finished `gh` run cannot be read as a response, if it cannot. */
function ghFailure(r: RunResult): GitHubApiError | null {
  if (r.spawnFailed)
    return new GitHubApiError(
      "the GitHub command-line client `gh` could not start: install it and sign in with `gh auth login`",
      { unavailable: true },
    );
  if (r.timedOut)
    return new GitHubApiError("gh api graphql timed out", {
      unavailable: true,
    });
  if (r.bufferExceeded)
    return new GitHubApiError(
      "gh api graphql printed more output than can be held; stopped it",
    );
  return null;
}

/** Signs that `gh` could not reach GitHub or was not allowed to ask. */
const GH_UNAVAILABLE =
  /not logged in|auth login|authentication|bad credentials|HTTP 401|HTTP 5\d\d|rate limit|could not resolve host|connection (refused|reset)|timeout/i;

/** The JSON a `gh` run printed, or the reason it printed none. */
function ghBody(r: RunResult): unknown {
  try {
    return JSON.parse(r.stdout);
  } catch {
    const said = (r.stderr || r.stdout).trim().slice(0, 300);
    throw new GitHubApiError(
      `gh api graphql returned no JSON (exit ${r.code}): ${said}`,
      { unavailable: GH_UNAVAILABLE.test(said) },
    );
  }
}

/**
 * A failed run is a failure even when its output parses: report the errors
 * it carries, else its exit status.
 */
function ghExitFailure(
  r: RunResult,
  body: unknown,
  response?: { status: number; headers: Headers },
): GitHubApiError {
  const unavailable =
    GH_UNAVAILABLE.test(r.stderr) ||
    response?.status === 429 ||
    (response?.status !== undefined && response.status >= 500);
  const retryAfterSec =
    response === undefined ? null : retryAfterSeconds(response.headers);
  if (isRecord(body) && Array.isArray(body.errors))
    unwrapResponse(body, { unavailable, retryAfterSec });
  const said = (r.stderr || r.stdout).trim().slice(0, 300);
  return new GitHubApiError(`gh api graphql exited ${r.code}: ${said}`, {
    unavailable: unavailable || GH_UNAVAILABLE.test(said),
    retryAfterSec,
  });
}

/**
 * Transport through `gh api graphql`, run through drive-pr's deadline
 * wrapper (`runClient`). The request travels on standard input as one JSON
 * body, so variables keep their types and nothing reaches the command line.
 */
export function ghTransport(runner: typeof ghCall = ghCall): GitHubTransport {
  return async (query, variables, signal, idempotent = false) => {
    const deadline = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const bound =
      signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    const answer = await retryRead(
      async () => {
        if (cancelled(bound)) throw abortedError(bound);
        const r = await runClient(
          runner,
          ["api", "graphql", "--include", "--input", "-"],
          {
            stdin: JSON.stringify({ query, variables }),
            timeoutMs: GITHUB_TIMEOUT_MS,
            signal: bound,
          },
        );
        if (cancelled(signal)) throw abortedError(signal);
        const failure = ghFailure(r);
        if (failure !== null) throw failure;
        const parsed = ghHeaders(r.stdout);
        return { ...parsed, result: { ...r, stdout: parsed.body } };
      },
      idempotent,
      bound,
    );
    const body =
      answer.result.code === 0
        ? ghBody(answer.result)
        : parsedOrNull(answer.result.stdout);
    if (answer.result.code !== 0)
      throw ghExitFailure(answer.result, body, answer);
    return unwrapResponse(body);
  };
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
  return async (query, variables, signal, idempotent = false) => {
    const deadline = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const bound =
      signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
    if (cancelled(bound)) throw abortedError(bound);
    let res: Response;
    try {
      res = await retryRead(
        () =>
          postGraphQL(
            fetchImpl,
            url,
            `bearer ${token}`,
            { query, variables },
            { timeoutMs: GITHUB_TIMEOUT_MS, signal: bound },
          ),
        idempotent,
        bound,
      );
    } catch (err) {
      if (cancelled(signal)) throw abortedError(signal);
      throw new GitHubApiError(
        `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { unavailable: true },
      );
    }
    const text = await res.text().catch(() => "");
    if (cancelled(bound)) throw abortedError(bound);
    const body = parsedOrNull(text);
    if (!res.ok) throw httpFailure(res, text, body);
    return unwrapResponse(body);
  };
}

/** `text` as JSON, or `null` when it is not JSON. */
function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow(err, "an error response's body is not JSON; its status says why");
    return null;
  }
}

/** Whether an error status means "try later": no credential, a limit, a server error. */
function statusUnavailable(status: number, text: string): boolean {
  if (status === 401 || status === 429 || status >= 500) return true;
  return status === 403 && /rate limit/i.test(text);
}

/** The seconds a `Retry-After` header asks to wait, or `null`. */
function retryAfterOf(headers: Headers): number | null {
  return retryAfterSeconds(headers);
}

/** What an error status means: whether to try later, and when. */
function httpFailure(
  res: Response,
  text: string,
  body: unknown,
): GitHubApiError {
  const failure = {
    unavailable: statusUnavailable(res.status, text),
    retryAfterSec: retryAfterOf(res.headers),
  };
  if (isRecord(body) && Array.isArray(body.errors))
    unwrapResponse(body, failure);
  return new GitHubApiError(
    `GitHub API HTTP ${res.status}: ${text.slice(0, 300)}`,
    failure,
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
      { unavailable: true },
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
