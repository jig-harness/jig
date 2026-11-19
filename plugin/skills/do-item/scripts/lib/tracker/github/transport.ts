/**
 * GitHub's GraphQL API, for the GitHub tracker adapter and the GitHub
 * reflection store.
 *
 * Two transports exist. By default every request is `gh api graphql`, which
 * holds its own credential (`gh auth login`, or `GH_TOKEN` / `GITHUB_TOKEN`)
 * and knows the host; each run names the repository its request is about
 * (`requestRepository`: the one its variables name, else the repository the
 * transport serves) in `GH_REPO`, so whatever picks the account `gh` runs as
 * sees it. With `JIG_GITHUB_GRAPHQL_URL` set, requests go over
 * HTTPS to that endpoint with the token from `GH_TOKEN` or `GITHUB_TOKEN`
 * instead: a GitHub Enterprise endpoint `gh` is not signed in to, or a local
 * fake (plain `http` is accepted for a loopback address only). Tests of the
 * adapter pass a fake transport.
 *
 * Either way a request is admitted against the token's budget record and
 * its answer recorded there (`shared/outbound/github-budget.ts`): `gh` at
 * the forge client's wrapper, HTTPS here.
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
import { ghRepoEnvFor } from "../../../../../drive-pr/scripts/lib/gh-repo-env.ts";
import { unheldForm } from "../../../../../../shared/trace.ts";
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
  gitHubLimitReset,
  graphQLErrorsClass,
} from "../../../../../../shared/outbound/github.ts";
import { guarded } from "../../../../../../shared/outbound/hold.ts";
import { retryRead } from "../../../../../../shared/outbound/retry.ts";
import { credentialKey } from "../../../../../../shared/outbound/budget.ts";
import { admitPaced } from "../../../../../../shared/outbound/forge-pacing.ts";
import {
  type HttpsGovernance,
  httpsGovernance,
} from "../../../../../../shared/outbound/github-budget.ts";
import { operationName } from "../../../../../../shared/outbound/ledger.ts";
import { githubCost } from "../../../../../../shared/outbound/gh-ledger.ts";
import {
  recordAttempt,
  type Attempt,
} from "../../../../../../shared/outbound/record-attempt.ts";
import { pager, postGraphQL, runClient } from "../graphql.ts";
import { currentMs } from "../../../../../../shared/time.ts";

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
  /** `owner/name` the request is about, for a call whose variables name none (a mutation by node id). */
  repository?: string,
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
      account?: string | undefined;
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
    account: failure.account,
    until: failure.until ?? null,
    sent: failure.sent ?? false,
    retryAfterMs: failure.retryAfterMs ?? null,
  });
}

function cancelled(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

/** `sent`: the request had been dispatched, so a write may have landed. */
function abortedError(signal: AbortSignal, sent = false): GitHubApiError {
  const reason: unknown = signal.reason;
  return new GitHubApiError(
    `GitHub request cancelled: ${reason instanceof Error ? reason.message : String(reason)}`,
    { code: "unreachable", ...(sent ? { sent: true } : {}) },
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
  headers: Headers | null = null,
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
    // A spent limit named in a successful response still clears at the reset
    // its headers carry, else after the bounded fallback.
    const limit =
      code === "rate-limited" && headers !== null
        ? gitHubLimitReset(headers)
        : null;
    throw errorOf(
      outboundFailure(code, message, {
        account: failure?.account,
        until: failure?.until ?? limit?.until ?? null,
        retryAfterMs: failure?.retryAfterMs ?? limit?.retryAfterMs ?? null,
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

/** Answers made on this machine, which reached no GitHub: the run's hold neither settles on them nor takes them as a probe. */
const unsentAnswers = new WeakSet<GitHubApiError>();

/** `error`, marked as an answer no request reached GitHub for. */
function unsent(error: GitHubApiError): GitHubApiError {
  unsentAnswers.add(error);
  return error;
}

const failureOfAnswer = (answer: Answer): OutboundFailure | null =>
  answer instanceof GitHubApiError ? answer.failure : null;

/**
 * One call: a read sent once more after a failure that may clear
 * (`retryRead`), a write once, both inside one `GITHUB_TIMEOUT_MS`
 * deadline, through the run's hold on GitHub. The data, or the failure
 * thrown.
 */
async function call(
  send: (bound: AbortSignal, deadlineAt: number) => Promise<Answer>,
  signal: AbortSignal | undefined,
  read: boolean,
  hold: string | null,
): Promise<unknown> {
  if (cancelled(signal)) throw abortedError(signal);
  const deadline = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  const bound =
    signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const deadlineAt = currentMs() + GITHUB_TIMEOUT_MS;
  // Once a request has gone out, a cancellation may have cut one that
  // landed: `retryRead` throws the bare reason, which carries no marker. An
  // attempt answered as unsent (cancelled or refused before the send) is no
  // dispatch.
  let dispatched = false;
  const attempt = async (): Promise<Answer> => {
    let answer: Answer;
    try {
      answer = await send(bound, deadlineAt);
    } catch (err) {
      dispatched = true;
      throw err;
    }
    if (!(answer instanceof GitHubApiError && unsentAnswers.has(answer)))
      dispatched = true;
    return answer;
  };
  /** A cancellation as the call's answer or throw, keeping whether a request went out. */
  const cancelledAnswer = (err: unknown): Answer => {
    const sent = dispatched || (err instanceof GitHubApiError && err.sent);
    if (cancelled(signal)) {
      // Thrown inside the hold, a cancellation would settle it as a failure;
      // one that sent nothing is returned, marked unsent, and thrown after.
      if (sent) throw abortedError(signal, true);
      return unsent(abortedError(signal));
    }
    if (cancelled(bound))
      return sent ? abortedError(bound, true) : unsent(abortedError(bound));
    throw err;
  };
  const retried = () =>
    retryRead(attempt, {
      read,
      signal: bound,
      deadlineAt,
      failureOf: failureOfAnswer,
    }).catch(cancelledAnswer);
  // A `gh` run is held where every `gh` call is (`ghCall`); an HTTPS request here, under its endpoint's host.
  const answer =
    hold === null
      ? await retried()
      : await guarded(
          hold,
          retried,
          failureOfAnswer,
          (f) => errorOf(f),
          bound,
          (a) => a instanceof GitHubApiError && unsentAnswers.has(a),
        ).catch(cancelledAnswer);
  if (answer instanceof GitHubApiError) throw answer;
  return unwrapResponse(answer.body);
}

/** `owner/name` of each repository a request's variables name, told apart ignoring case. */
function namedRepositories(variables: Record<string, unknown>): string[] {
  const named = new Map<string, string>();
  for (const [key, owner] of Object.entries(variables)) {
    const suffix = /^owner(\d*)$/.exec(key)?.[1];
    const name = suffix === undefined ? undefined : variables[`name${suffix}`];
    if (typeof owner !== "string" || typeof name !== "string") continue;
    if (owner === "" || name === "") continue;
    const slug = `${owner}/${name}`;
    named.set(slug.toLowerCase(), slug);
  }
  return [...named.values()];
}

/**
 * The repository a request is about, as `owner/name`: the one its variables
 * name (`owner` and `name`, or each batched `owner<i>` and `name<i>`) when
 * they name exactly one, else `home`, the repository the transport serves.
 * A batch over several repositories gets `home`: one run has one account,
 * and the serving repository's owner is the likeliest to see them all.
 * `null` when neither says.
 */
export function requestRepository(
  variables: Record<string, unknown>,
  home: string | null,
): string | null {
  const named = namedRepositories(variables);
  return named.length === 1 ? (named[0] ?? home) : home;
}

/** One `gh api graphql` run's answer, its body read with the status and headers `--include` prints. */
async function ghOnce(
  runner: typeof ghCall,
  payload: { query: string; variables: Record<string, unknown> },
  repository: string | null,
  bound: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  const began = currentMs();
  const r = await runClient(
    runner,
    ["api", "graphql", "--include", "--input", "-"],
    {
      stdin: JSON.stringify(payload),
      timeoutMs: GITHUB_TIMEOUT_MS,
      signal: bound,
      ...(repository === null ? {} : { env: ghRepoEnvFor(repository) }),
    },
  );
  if (cancelled(signal)) return abortedError(signal, true);
  return ghRunAnswer(r, currentMs() - began);
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
  return answerOf(body, parsed.headers);
}

/**
 * A response body as the answer: GraphQL errors in a successful response are
 * classified here, inside the attempt, so the retry and the hold see them.
 */
function answerOf(body: unknown, headers: Headers | null): Answer {
  return errorsFailure(body, null, headers) ?? { body };
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
  const http = answered
    ? gitHubHttpFailure(parsed.status, parsed.headers, parsed.body, tookMs)
    : null;
  const base =
    http ??
    run ??
    outboundFailure("invalid", `gh api graphql exited ${r.code}`);
  // The status classifies the failure; the run still says whose credential it used.
  const account = base.account ?? run?.account;
  const failure =
    account === undefined || base.account === account
      ? base
      : { ...base, account };
  const named = errorsFailure(
    body,
    answered ? failure : null,
    parsed.headers,
    account,
  );
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
  headers: Headers | null = null,
  account?: string,
): GitHubApiError | null {
  if (
    !isRecord(body) ||
    !Array.isArray(body.errors) ||
    body.errors.length === 0
  )
    return null;
  try {
    unwrapResponse(body, failure, headers);
  } catch (err) {
    if (err instanceof GitHubApiError)
      // A success status leaves the class to the errors' types, but the run
      // still says whose credential it used.
      return err.account !== undefined || account === undefined
        ? err
        : new GitHubApiError(err.message, {
            code: err.code,
            data: err.data,
            account,
            until: err.until,
            sent: err.sent,
            retryAfterMs: err.retryAfterMs,
          });
    throw err;
  }
  return null;
}

/**
 * Transport through `gh api graphql`, run through drive-pr's deadline
 * wrapper (`runClient`). The request travels on standard input as one JSON
 * body, so variables keep their types and nothing reaches the command line.
 * `home` (`owner/name`) is the repository the transport serves: a run names
 * it in `GH_REPO` when its variables name no single repository. A run that
 * names none keeps the environment it inherits.
 */
export function ghTransport(
  runner: typeof ghCall = ghCall,
  home: string | null = null,
): GitHubTransport {
  // The shared runner is not held per run: the hold lands around the whole
  // call, after its retry. An injected runner is the caller's own.
  const unheld = unheldForm(runner);
  const hold = unheld === undefined ? null : GITHUB;
  return (query, variables, signal, idempotent = false, target) => {
    const repository = requestRepository(variables, target ?? home);
    return call(
      (bound) =>
        ghOnce(
          unheld ?? runner,
          { query, variables },
          repository,
          bound,
          signal,
        ),
      signal,
      idempotent,
      hold,
    );
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

/** One HTTPS request's answer, with the headers and the text it came with when it came. */
interface Posted {
  answer: Answer;
  headers: Headers | null;
  text: string;
}

/** A cancelled request that had been answered: the refusal it received, else the cancellation. */
function cutAnswer(
  refused: OutboundFailure | null,
  bound: AbortSignal,
): GitHubApiError {
  return refused === null
    ? abortedError(bound, true)
    : errorOf({ ...refused, sent: true });
}

/** A cancelled request whose response was read in full: the refusal it carried, a GraphQL one in a successful response included, else the cancellation. */
function receivedCutAnswer(
  res: Response,
  text: string,
  body: unknown,
  began: number,
  bound: AbortSignal,
): GitHubApiError {
  const status = gitHubHttpFailure(
    res.status,
    res.headers,
    text,
    currentMs() - began,
  );
  const named = errorsFailure(
    body,
    status,
    status === null ? res.headers : null,
  );
  return cutAnswer(named?.failure ?? status, bound);
}

/** One HTTPS request's answer. */
async function postOnce(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: { query: string; variables: Record<string, unknown> },
  bound: AbortSignal,
  observation: Attempt,
): Promise<Posted> {
  observation.requests = 1;
  const began = currentMs();
  const lost = (answer: Answer): Posted => ({
    answer,
    headers: null,
    text: "",
  });
  let res: Response;
  try {
    res = await postGraphQL(fetchImpl, url, `bearer ${token}`, payload, {
      timeoutMs: GITHUB_TIMEOUT_MS,
      signal: bound,
    });
  } catch (err) {
    if (cancelled(bound)) return lost(abortedError(bound, true));
    return lost(
      new GitHubApiError(
        `GitHub API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { code: "unreachable", sent: true },
      ),
    );
  }
  /** A body that could not be read: the headers GitHub sent still say its limits. */
  const unreadBody = (answer: Answer, got: Response): Posted => ({
    answer,
    headers: got.headers,
    text: "",
  });
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const reason = `GitHub API response lost: ${err instanceof Error ? err.message : String(err)}`;
    // A refusal's status and headers stand without its body, and through a cancellation.
    const refused = gitHubHttpFailure(
      res.status,
      res.headers,
      "",
      currentMs() - began,
    );
    if (cancelled(bound)) return unreadBody(cutAnswer(refused, bound), res);
    return unreadBody(
      refused === null
        ? new GitHubApiError(reason, { code: "unreachable", sent: true })
        : errorOf({
            ...refused,
            reason: `${reason}; ${refused.reason}`,
            sent: true,
          }),
      res,
    );
  }
  const body = parsedOrNull(text);
  if (cancelled(bound))
    return {
      answer: receivedCutAnswer(res, text, body, began, bound),
      headers: res.headers,
      text,
    };
  observation.cost = githubCost(body);
  const failure = gitHubHttpFailure(
    res.status,
    res.headers,
    text,
    currentMs() - began,
  );
  const answer =
    failure === null
      ? answerOf(body, res.headers)
      : (errorsFailure(body, failure) ?? errorOf(failure));
  return { answer, headers: res.headers, text };
}

/**
 * One HTTPS request under the credential's budget record (`governance`):
 * paced and admitted before it is sent, its answer recorded after. A request
 * the record refuses is not sent and answers `rate-limited` with the time
 * the record names; a refusal the request meets waits as long as the record
 * then holds the credential.
 */
async function governedPost(
  governance: HttpsGovernance | null,
  post: () => Promise<Posted>,
  bound: AbortSignal,
  deadlineAt: number,
): Promise<Answer> {
  if (governance === null) return (await post()).answer;
  const admitted = await admitPaced(governance, deadlineAt, bound);
  if ("failure" in admitted) return unsent(errorOf(admitted.failure));
  if ("refused" in admitted) return unsent(errorOf(admitted.refused));
  if (cancelled(bound)) {
    governance.release(admitted.sentAt);
    return unsent(abortedError(bound));
  }
  const { answer, headers, text } = await post();
  const failure = failureOfAnswer(answer);
  const until = governance.observe(headers, text, failure, admitted.sentAt);
  return until === null || !(answer instanceof GitHubApiError)
    ? answer
    : errorOf({ ...answer.failure, until }, answer.data);
}

/**
 * HTTPS transport to `url` with `token`; each call bounded by
 * `GITHUB_TIMEOUT_MS`, and governed by the budget record as `env` says.
 */
export function httpTransport(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): GitHubTransport {
  if (!url.startsWith("https://") && !LOOPBACK.test(url))
    throw new GitHubApiError(
      `JIG_GITHUB_GRAPHQL_URL must be an https address, or http on a loopback address (got ${url})`,
    );
  return (query, variables, signal, idempotent = false) =>
    call(
      (bound, deadlineAt) => {
        const governance = httpsGovernance(token, env);
        const observation: Attempt = {
          system: GITHUB,
          credential: credentialKey(GITHUB, token),
          operation: operationName(query),
          requests: 0,
          cost: null,
          unit: "points",
          estimated: false,
        };
        return recordAttempt(
          observation,
          () =>
            governedPost(
              governance,
              () =>
                postOnce(
                  fetchImpl,
                  url,
                  token,
                  { query, variables },
                  bound,
                  observation,
                ),
              bound,
              deadlineAt,
            ),
          (answer) => failureOfAnswer(answer)?.code ?? null,
        );
      },
      signal,
      idempotent,
      `${GITHUB}:${new URL(url).host}`,
    );
}

/**
 * The transport the environment asks for: HTTPS to `JIG_GITHUB_GRAPHQL_URL`
 * when it is set (a token is then required), else `gh` serving `home`
 * (`owner/name`, see `ghTransport`).
 */
export function defaultTransport(
  env = process.env,
  home: string | null = null,
): GitHubTransport {
  const url = env.JIG_GITHUB_GRAPHQL_URL?.trim();
  if (url === undefined || url === "") return ghTransport(ghCall, home);
  const token = resolveGitHubToken(env);
  if (token === null)
    throw new GitHubApiError(
      "JIG_GITHUB_GRAPHQL_URL is set, so GH_TOKEN or GITHUB_TOKEN must hold a token for it",
      { code: "unauthorized" },
    );
  return httpTransport(url, token, fetch, env);
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
