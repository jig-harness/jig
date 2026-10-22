/**
 * The GitHub store's client: the tracker's GraphQL transport (`gh api
 * graphql`, or HTTPS to `JIG_GITHUB_GRAPHQL_URL` with `GH_TOKEN`), with the
 * store's retry and pacing rules on top.
 *
 * A read is retried while GitHub is unavailable or asks to wait. A write is
 * retried only when GitHub refused it for a rate limit, which means nothing
 * was done; after any other failure it may have been applied, so it is not
 * sent again and the caller's retry reads the store first. Writes start at
 * least `intervalMs` apart, as GitHub asks of requests that create content,
 * and every wait in one run together stays within `MAX_TOTAL_WAIT_MS`, so the
 * retries end well inside the caller's deadline.
 *
 * Failures carry the store contract's exit codes: 3 (unavailable) for a
 * missing or refused credential, the network, a rate limit or server error
 * that outlasts the retries, or a write that may have been applied; 1 for
 * anything GitHub refused.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  defaultTransport,
  GitHubApiError,
  type GitHubTransport,
  pageAll,
} from "../../../../do-item/scripts/lib/tracker/github/transport.ts";

export { GitHubApiError };

/**
 * GitHub asks for at least a second between requests that create content;
 * closer ones risk its secondary rate limit.
 */
export const DEFAULT_INTERVAL_MS = 1000;

/** Attempts at one request, the first included. */
const MAX_ATTEMPTS = 4;

/**
 * The longest one run waits in all, between attempts: half the default
 * store deadline, so a run that keeps being refused ends as unavailable
 * rather than being stopped part-way.
 */
export const MAX_TOTAL_WAIT_MS = 60_000;

/** GitHub's advice when a secondary rate limit names no wait: a minute. */
const RATE_LIMIT_WAIT_MS = 60_000;

/** The store contract's exit code for a failure. */
export function exitCodeOf(error: unknown): 1 | 3 {
  return error instanceof GitHubApiError && error.unavailable ? 3 : 1;
}

/**
 * Whether GitHub refused a request for a rate limit it will lift soon: a
 * secondary rate limit, or any refusal that said how long to wait. Nothing
 * was done, so even a write may be sent again.
 */
export function isRateLimited(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    (error.retryAfterSec !== null ||
      /secondary rate limit|abuse detection/i.test(error.message))
  );
}

/** Whether the credential is missing or refused: `check` reports it. */
export function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.unavailable &&
    /HTTP 401|bad credentials|not logged in|auth login|must hold a token/i.test(
      error.message,
    )
  );
}

export interface ClientOptions {
  transport: GitHubTransport;
  intervalMs?: number;
}

/** One run's connection to GitHub. */
export class GitHubClient {
  private readonly transport: GitHubTransport;
  private readonly intervalMs: number;
  private lastWrite = 0;
  private waited = 0;

  constructor(options: ClientOptions) {
    this.transport = options.transport;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /**
   * The client the environment describes: the tracker's transport, and
   * `JIG_GITHUB_INTERVAL_MS` for the least time between two writes.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubClient {
    const interval = env.JIG_GITHUB_INTERVAL_MS?.trim();
    if (interval !== undefined && interval !== "" && !/^\d+$/.test(interval))
      throw new GitHubApiError(
        "JIG_GITHUB_INTERVAL_MS must be a whole number of milliseconds",
      );
    return new GitHubClient({
      transport: defaultTransport(env),
      ...(interval === undefined || interval === ""
        ? {}
        : { intervalMs: Number(interval) }),
    });
  }

  /** A query, retried while GitHub is unavailable or asks to wait. */
  read(query: string, variables: Record<string, unknown>): Promise<unknown> {
    return this.attempt(
      query,
      variables,
      (error) => error instanceof GitHubApiError && error.unavailable,
    );
  }

  /** A mutation, paced, and retried only after a rate-limit refusal. */
  async write(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const wait = this.lastWrite + this.intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await this.attempt(query, variables, isRateLimited);
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.unavailable &&
        !isRateLimited(error)
      )
        throw new GitHubApiError(
          `${error.message}; the write may have been applied, so it is not sent again`,
          { unavailable: true },
        );
      throw error;
    } finally {
      this.lastWrite = Date.now();
    }
  }

  /** Every node of one connection, each page read with `read`'s retries. */
  readAll(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: Record<string, unknown>) => unknown,
    where: string,
  ): Promise<unknown[]> {
    return pageAll((q, v) => this.read(q, v), query, variables, pick, where);
  }

  private async attempt(
    query: string,
    variables: Record<string, unknown>,
    retried: (error: unknown) => boolean,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transport(query, variables);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !retried(error)) throw error;
        await this.backOff(error as GitHubApiError, attempt);
      }
    }
  }

  /** Wait before another attempt, or give up when the wait would overrun. */
  private async backOff(error: GitHubApiError, attempt: number): Promise<void> {
    const wait =
      error.retryAfterSec !== null
        ? error.retryAfterSec * 1000
        : isRateLimited(error)
          ? RATE_LIMIT_WAIT_MS
          : 1000 * 2 ** (attempt - 1);
    if (this.waited + wait > MAX_TOTAL_WAIT_MS)
      throw new GitHubApiError(
        `${error.message}; GitHub asked to wait ${Math.ceil(wait / 1000)}s, longer than this run waits`,
        { unavailable: true },
      );
    this.waited += wait;
    await sleep(wait);
  }
}
