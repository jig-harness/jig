/**
 * How a call to GitHub failed, read once for every caller: a run of the
 * `gh` command-line client (the forge client's `ghCall` wrappers, the
 * GitHub tracker adapter through `gh api graphql`), an HTTP answer, and the
 * error types of a GraphQL answer. Each says which failure class
 * (`failure.ts`) the call met; nobody else reads `gh`'s error output or a
 * status to tell a spent rate limit from a server fault.
 */
import {
  answerClass,
  type FailureClass,
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
  TIMEOUT_FLOOR_MS,
} from "./failure.ts";

/** The system the forge's calls are held under in a run (`hold.ts`). */
export const GITHUB = "github";

/**
 * How long a refusal that named no reset holds: GitHub's secondary limits
 * name none, and its primary limit resets within the hour.
 */
export const FORGE_FALLBACK_LIMIT_MS = 15 * 60_000;

/** What a run of `gh` left that tells how it failed. */
export interface GhRun {
  code: number;
  stderr: string;
  timedOut: boolean;
  spawnFailed?: boolean;
  bufferExceeded?: boolean;
}

/** GitHub refused the credential for a rate limit, primary or secondary. */
const RATE_LIMITED =
  /rate limit|secondary rate|abuse detection|HTTP 429|\bRATE_LIMITED\b/i;

/** No answer came: the request may not have left. */
const NOT_SENT =
  /could not resolve host|no such host|connection refused|network is unreachable|dial tcp/i;

/** No answer came after the request left. */
const LOST =
  /connection reset|i\/o timeout|TLS handshake timeout|unexpected EOF|\bEOF\b|timed? ?out/i;

/** GitHub answered with a fault of its own. */
const SERVER = /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out/i;

/** GitHub ran out of time on the request. */
const OUT_OF_TIME = /\bHTTP 50[24]\b/;

const UNAUTHORIZED =
  /HTTP 401|HTTP 403|bad credentials|gh auth login|not logged in|authentication|Resource not accessible|must have (admin|push|write)|forbidden/i;

const NOT_FOUND =
  /HTTP 404|HTTP 410|Not Found|Could not resolve to|no pull requests found|no commit found|not found/i;

/** The last line of `gh`'s error output, as a reason names it. */
function tail(stderr: string): string {
  return stderr.trim().split("\n").at(-1)?.trim() ?? "";
}

/**
 * The failure a finished run of `gh` met; `null` when it exited 0.
 * `tookMs`, where the caller timed the run, tells a query GitHub ran out of
 * time on (`too-costly`) from a fault it answered at once.
 */
export function ghRunFailure(
  r: GhRun,
  tookMs?: number,
  now: () => number = Date.now,
): OutboundFailure | null {
  if (r.code === 0) return null;
  const said = tail(r.stderr);
  const reason = `gh exited ${r.code}${said === "" ? "" : `: ${said}`}`;
  if (r.spawnFailed === true)
    return outboundFailure(
      "unauthorized",
      `the GitHub command-line client \`gh\` could not start: install it and sign in with \`gh auth login\` (${said})`,
    );
  // A request the forge is still working on at the deadline asked too much
  // of it: the forge's own readers ask again for less (`paging.ts`).
  if (r.timedOut)
    return outboundFailure(
      "too-costly",
      "gh did not answer within its deadline",
      { sent: true },
    );
  if (r.bufferExceeded === true)
    return outboundFailure(
      "invalid",
      "gh printed more output than can be held; stopped it",
    );
  const code = classOfText(r.stderr, tookMs);
  return outboundFailure(code, reason, {
    ...(code === "rate-limited"
      ? { until: now() + FORGE_FALLBACK_LIMIT_MS }
      : {}),
    ...(code === "unreachable" && !NOT_SENT.test(r.stderr)
      ? { sent: true }
      : {}),
  });
}

/** The class `gh`'s error output names. */
function classOfText(stderr: string, tookMs: number | undefined): FailureClass {
  if (RATE_LIMITED.test(stderr)) return "rate-limited";
  if (NOT_SENT.test(stderr)) return "unreachable";
  if (SERVER.test(stderr))
    return tookMs !== undefined &&
      tookMs >= TIMEOUT_FLOOR_MS &&
      OUT_OF_TIME.test(stderr)
      ? "too-costly"
      : "server-fault";
  if (LOST.test(stderr)) return "unreachable";
  if (UNAUTHORIZED.test(stderr)) return "unauthorized";
  if (NOT_FOUND.test(stderr)) return "not-found";
  return "invalid";
}

/**
 * The failure an HTTP answer from GitHub stands for; `null` for a success.
 * A 403 or 429 that says the limit is spent (no requests remaining, a
 * `Retry-After`, or "rate limit" in its body) is `rate-limited` until the
 * reset it names; any other 403 is a refused credential.
 */
export function gitHubHttpFailure(
  status: number,
  headers: Headers,
  text: string,
  tookMs = 0,
  now: () => number = Date.now,
): OutboundFailure | null {
  const code = answerClass(status, tookMs);
  if (code === null) return null;
  const reason = `GitHub API HTTP ${status}: ${text.slice(0, 300)}`;
  const wait = retryAfterMs(headers, now);
  const spent =
    (status === 403 || status === 429) &&
    (headers.get("x-ratelimit-remaining") === "0" ||
      wait !== null ||
      /rate limit/i.test(text));
  if (spent || status === 429)
    return outboundFailure("rate-limited", reason, {
      until: resetOf(headers, wait, now),
      retryAfterMs: wait,
    });
  return outboundFailure(code, reason, { retryAfterMs: wait });
}

/** When a spent limit clears: the reset GitHub names, else its `Retry-After`, else the fallback. */
function resetOf(
  headers: Headers,
  wait: number | null,
  now: () => number,
): number {
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset * 1000 > now()) return reset * 1000;
  return now() + (wait ?? FORGE_FALLBACK_LIMIT_MS);
}

/**
 * The class a GraphQL answer's errors name, from each error's `type`:
 * `not-found` when every error is `NOT_FOUND`, else the first of a spent
 * limit, a query that may return more nodes than one request may, an
 * unavailable service and a refusal; any other error is the request's own
 * (`invalid`).
 */
export function graphQLErrorsClass(types: readonly string[]): FailureClass {
  if (types.length > 0 && types.every((t) => t === "NOT_FOUND"))
    return "not-found";
  if (types.includes("RATE_LIMITED")) return "rate-limited";
  if (types.includes("MAX_NODE_LIMIT_EXCEEDED")) return "too-costly";
  if (types.includes("SERVICE_UNAVAILABLE")) return "server-fault";
  if (types.includes("FORBIDDEN")) return "unauthorized";
  return "invalid";
}
