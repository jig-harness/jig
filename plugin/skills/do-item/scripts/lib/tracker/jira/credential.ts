/**
 * The Jira adapter's credential and the `Authorization` header each request
 * carries. A credential comes from the environment only, never from the
 * repository's configuration, and the first of these that is set is used:
 *
 * 1. `JIRA_BEARER_TOKEN`: an OAuth 2.0 access token, sent as
 *    `Authorization: Bearer`.
 * 2. `JIRA_TOKEN_COMMAND`: a command that prints such a token on standard
 *    output, as a git credential helper or `gh auth token` does, so a
 *    credential broker holds the secret and the environment holds only the
 *    command. It runs once for the process, under a deadline; after a 401 it
 *    runs once more and the request is sent again once with the new token.
 * 3. `JIRA_EMAIL` and `JIRA_API_TOKEN`: an Atlassian account's email and an
 *    API token (scoped or not), sent as HTTP Basic authentication.
 *
 * The command is split into words without a shell (`splitCommandWords`):
 * nothing in it is expanded, it reads alike on every operating system, and
 * the variable cannot smuggle a pipeline or a redirection past the adapter.
 * A broker that needs a shell is named as one (`sh -c "..."`) by whoever
 * sets the variable. Only the token crosses back: the adapter keeps the
 * host check, the refusal to follow redirects, TLS and the request deadline,
 * which a command that made the requests itself would take over.
 *
 * Failures are values here; the transport turns one into its own error. No
 * reason ever carries a token or the command's standard output.
 */

import { splitCommandWords } from "../../../../../../shared/command-words.ts";
import { failed, ok, type Outcome } from "../../../../../../shared/outcome.ts";
import { run } from "../../../../../drive-pr/scripts/lib/proc.ts";
import { runClient } from "../graphql.ts";

/** How long `JIRA_TOKEN_COMMAND` may run before it is stopped. */
export const JIRA_TOKEN_COMMAND_TIMEOUT_MS = 30_000;

export type JiraCredential =
  | { kind: "basic"; email: string; token: string }
  | { kind: "bearer"; token: string }
  | { kind: "command"; argv: string[] };

export type CredentialCode =
  | "no-credential"
  | "bearer-token"
  | "token-command"
  | "cancelled";

const NO_CREDENTIAL =
  "no Jira credential: set JIRA_BEARER_TOKEN to an OAuth access token, JIRA_TOKEN_COMMAND to a command that prints one, or JIRA_EMAIL and JIRA_API_TOKEN to an Atlassian account's email and API token";

/** The credential the environment holds, the first of the three that is set. */
export function resolveJiraCredential(
  env: Record<string, string | undefined> = process.env,
): Outcome<JiraCredential, CredentialCode> {
  const bearer = env.JIRA_BEARER_TOKEN?.trim();
  if (bearer) {
    // A header holds no line break, and a token holds no space.
    if (/[\s\p{Cc}]/u.test(bearer))
      return failed(
        "bearer-token",
        "JIRA_BEARER_TOKEN must hold the token alone, without a space or a line break",
      );
    return ok({ kind: "bearer", token: bearer });
  }
  const line = env.JIRA_TOKEN_COMMAND?.trim();
  if (line) {
    const words = splitCommandWords(line);
    if (!words.ok)
      return failed(
        "token-command",
        `JIRA_TOKEN_COMMAND cannot be read as a command: ${words.failure.reason}`,
      );
    return ok({ kind: "command", argv: words.value });
  }
  const email = env.JIRA_EMAIL?.trim();
  const token = env.JIRA_API_TOKEN?.trim();
  return email && token
    ? ok({ kind: "basic", email, token })
    : failed("no-credential", NO_CREDENTIAL);
}

/** The `Authorization` header of each request, and its renewal after a 401. */
export interface JiraAuthorization {
  header: (signal?: AbortSignal) => Promise<Outcome<string, CredentialCode>>;
  /**
   * A fresh header after the site refused `refused` with a 401, to send the
   * request again once; `null` when this credential cannot be renewed.
   */
  renew: (
    refused: string,
    signal?: AbortSignal,
  ) => Promise<Outcome<string, CredentialCode> | null>;
}

/** What a run of the token command left: its exit, output and deadline. */
export interface TokenRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
}

/** Runs the token command's words under a deadline. */
export type TokenRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<TokenRun>;

const runToken: TokenRunner = (argv, timeoutMs) =>
  runClient(run, argv, { timeoutMs, signal: undefined });

/** The token command authorizations of this process, by the command's words. */
const SHARED = new Map<string, JiraAuthorization>();

export interface AuthorizationOptions {
  runner?: TokenRunner;
  timeoutMs?: number;
}

/** The header `credential` signs every request with. */
export function jiraAuthorization(
  credential: JiraCredential,
  opts: AuthorizationOptions = {},
): JiraAuthorization {
  if (credential.kind === "command") {
    const timeoutMs = opts.timeoutMs ?? JIRA_TOKEN_COMMAND_TIMEOUT_MS;
    if (opts.runner !== undefined)
      return commandAuthorization(credential.argv, opts.runner, timeoutMs);
    // Every tracker a process opens shares the token, so the command runs
    // once for the process, not once for each tracker.
    const key = JSON.stringify(credential.argv);
    let shared = SHARED.get(key);
    if (shared === undefined) {
      shared = commandAuthorization(credential.argv, runToken, timeoutMs);
      SHARED.set(key, shared);
    }
    return shared;
  }
  const value =
    credential.kind === "bearer"
      ? `Bearer ${credential.token}`
      : `Basic ${Buffer.from(`${credential.email}:${credential.token}`).toString("base64")}`;
  return {
    header: async () => ok(value),
    renew: async () => null,
  };
}

/** The last line of the command's error output, bounded, for its failure. */
function said(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return line === "" ? "" : `: ${line.slice(0, 200)}`;
}

/** The token a finished run printed, or why it gave none. */
function tokenOf(
  argv: string[],
  r: TokenRun,
  timeoutMs: number,
): Outcome<string, CredentialCode> {
  const program = `JIRA_TOKEN_COMMAND (${argv[0]?.split(/[\\/]/).pop() ?? ""})`;
  const fail = (why: string) => failed("token-command", `${program} ${why}`);
  if (r.spawnFailed) return fail(`could not start${said(r.stderr)}`);
  if (r.timedOut)
    return fail(`printed no token within ${timeoutMs / 1000} seconds`);
  if (r.code !== 0) return fail(`exited ${r.code}${said(r.stderr)}`);
  const token = r.stdout.trim();
  if (token === "") return fail("printed no token");
  // A header holds no line break, and a token holds no space.
  if (/[\s\p{Cc}]/u.test(token))
    return fail("printed more than a token; it must print the token alone");
  return ok(token);
}

/**
 * Ends the wait for `pending` when `signal` aborts; the run it waits on goes
 * on, for the other requests that share it.
 */
function until<T>(
  pending: Promise<Outcome<T, CredentialCode>>,
  signal: AbortSignal | undefined,
): Promise<Outcome<T, CredentialCode>> {
  if (signal === undefined) return pending;
  const stop = failed("cancelled", "cancelled while waiting for a token");
  if (signal.aborted) return Promise.resolve(stop);
  return new Promise((resolve) => {
    const onAbort = () => resolve(stop);
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/**
 * The token command's header. One run serves every request until a 401:
 * concurrent requests wait on the run in flight, and the requests a token
 * was refused for share the one run that replaces it. A failed run is not
 * kept, so the next request runs the command again.
 */
function commandAuthorization(
  argv: string[],
  runner: TokenRunner,
  timeoutMs: number,
): JiraAuthorization {
  let current: Promise<Outcome<string, CredentialCode>> | null = null;
  const start = () => {
    const pending = runner(argv, timeoutMs).then(
      (r) => tokenOf(argv, r, timeoutMs),
      (err: unknown) =>
        failed(
          "token-command",
          `JIRA_TOKEN_COMMAND could not be run: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
    const header = pending.then((t) => (t.ok ? ok(`Bearer ${t.value}`) : t));
    current = header;
    void header.then((h) => {
      if (!h.ok && current === header) current = null;
    });
    return header;
  };
  return {
    header: (signal) => until(current ?? start(), signal),
    renew: async (refused, signal) => {
      const seen = current;
      if (seen !== null) {
        const latest = await until(seen, signal);
        if (!latest.ok || latest.value !== refused) return latest;
      }
      return until(current === seen ? start() : (current ?? start()), signal);
    },
  };
}
