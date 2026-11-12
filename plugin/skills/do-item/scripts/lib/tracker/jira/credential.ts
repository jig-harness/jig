/**
 * The Jira adapter's credential and the `Authorization` header each request
 * carries. A credential comes from the environment only, never from the
 * repository's configuration, and the first of these that is set is used:
 *
 * 1. `JIRA_BEARER_TOKEN`: an OAuth 2.0 access token, sent as
 *    `Authorization: Bearer`.
 * 2. `JIRA_TOKEN_COMMAND`: a command that prints such a token on standard
 *    output, as `gh auth token` does, so a
 *    credential broker holds the secret and the environment holds only the
 *    command. It runs once for the process, under a deadline; after a 401 it
 *    runs once more and the request is sent again once with the new token.
 *    A replacement refused in turn stops further command renewals.
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

import { homedir } from "node:os";

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
  | "token-command-unavailable"
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

/** A header and what to do when the site refuses it with a 401. */
export interface JiraLease {
  header: Outcome<string, CredentialCode>;
  /** Record that the header used by this lease was accepted. */
  accepted: () => void;
  /** Remember that Jira refused the replacement token too. */
  refuseRenewal: () => void;
  /**
   * A fresh header after the site refused this lease's with a 401, to send
   * the request again once; `null` when this credential cannot be renewed.
   */
  renew: (
    signal?: AbortSignal,
  ) => Promise<Outcome<string, CredentialCode> | null>;
}

/** The `Authorization` header of each request, and its renewal after a 401. */
export interface JiraAuthorization {
  lease: (signal?: AbortSignal) => Promise<JiraLease>;
  header: (signal?: AbortSignal) => Promise<Outcome<string, CredentialCode>>;
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

// The command runs from the home directory, never the consumer checkout: on
// Windows a bare program name is looked up in the working directory before
// `PATH`, and a checkout could then supply the "broker" that runs.
const runToken: TokenRunner = (argv, timeoutMs) =>
  runClient((a, o) => run(a, { ...o, cwd: homedir() }), argv, {
    timeoutMs,
    signal: undefined,
  });

/** The token command authorizations of this process, by the command's words. */
const SHARED = new Map<string, JiraAuthorization>();

/**
 * How many commands stay shared. The oldest-used is dropped past it; a
 * tracker holding a dropped one keeps it, and a later tracker runs the
 * command again.
 */
export const SHARED_COMMANDS_MAX = 8;

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
    const known = SHARED.get(key);
    const shared =
      known ?? commandAuthorization(credential.argv, runToken, timeoutMs);
    // Re-inserting keeps the map in order of use.
    SHARED.delete(key);
    SHARED.set(key, shared);
    for (const old of SHARED.keys()) {
      if (SHARED.size <= SHARED_COMMANDS_MAX) break;
      SHARED.delete(old);
    }
    return shared;
  }
  const value =
    credential.kind === "bearer"
      ? `Bearer ${credential.token}`
      : `Basic ${Buffer.from(`${credential.email}:${credential.token}`).toString("base64")}`;
  const lease: JiraLease = {
    header: ok(value),
    accepted: () => {
      // A fixed credential does not track renewal generations.
    },
    renew: async () => null,
    refuseRenewal: () => {
      // A fixed credential has no renewal to refuse.
    },
  };
  return { lease: async () => lease, header: async () => lease.header };
}

/** The last line of the command's error output, bounded, for its failure. */
function said(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return line === "" ? "" : `: ${line.slice(0, 200)}`;
}

/** How a failure names the token command: the variable and the program. */
function programOf(argv: string[]): string {
  return `JIRA_TOKEN_COMMAND (${argv[0]?.split(/[\\/]/).pop() ?? ""})`;
}

/** The token a finished run printed, or why it gave none. */
function tokenOf(
  argv: string[],
  r: TokenRun,
  timeoutMs: number,
): Outcome<string, CredentialCode> {
  const program = programOf(argv);
  const fail = (why: string) => failed("token-command", `${program} ${why}`);
  const unavailable = (why: string) =>
    failed("token-command-unavailable", `${program} ${why}`);
  if (r.spawnFailed) return fail(`could not start${said(r.stderr)}`);
  if (r.timedOut)
    return unavailable(`printed no token within ${timeoutMs / 1000} seconds`);
  if (r.code !== 0) return fail(`exited ${r.code}${said(r.stderr)}`);
  const token = r.stdout.trim();
  if (token === "") return fail("printed no token");
  // A header holds no line break, and a token holds no space.
  if (/[\s\p{Cc}]/u.test(token))
    return fail("printed more than a token; it must print the token alone");
  return ok(token);
}

/**
 * Why a wait ended early: the caller's cancellation, or the call's deadline
 * running out, which names the token command.
 */
function stopped<T>(
  signal: AbortSignal,
  program: string,
): Outcome<T, CredentialCode> {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError"
    ? failed(
        "token-command-unavailable",
        `${program} printed no token before the request's deadline`,
      )
    : failed("cancelled", "cancelled while waiting for a token");
}

/**
 * Ends the wait for `pending` when `signal` aborts; the run it waits on goes
 * on, for the other requests that share it.
 */
function until<T>(
  pending: Promise<Outcome<T, CredentialCode>>,
  signal: AbortSignal | undefined,
  program: string,
): Promise<Outcome<T, CredentialCode>> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.resolve(stopped(signal, program));
  return new Promise((resolve) => {
    const onAbort = () => resolve(stopped(signal, program));
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/**
 * The token command's header. One run serves every request until a 401:
 * concurrent requests wait on the run in flight. Each run is a generation,
 * and a lease belongs to the generation it was handed out under: the
 * requests refused under one generation share the one run that replaces it,
 * whatever token that run prints and however late their 401s arrive, and a
 * failed renewal stays the answer of the requests that waited for it. A
 * failed first run is not kept, so the next request runs the command again.
 */
function commandAuthorization(
  argv: string[],
  runner: TokenRunner,
  timeoutMs: number,
): JiraAuthorization {
  interface Run {
    generation: number;
    header: Promise<Outcome<string, CredentialCode>>;
    failed: boolean;
    refused: boolean;
    replacement: boolean;
    accepted: boolean;
  }
  const program = programOf(argv);
  let generation = 0;
  let current: Run | null = null;
  const start = (replacement = false): Run => {
    const pending = runner(argv, timeoutMs).then(
      (r) => tokenOf(argv, r, timeoutMs),
      (err: unknown) =>
        failed(
          "token-command-unavailable",
          `JIRA_TOKEN_COMMAND could not be run: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
    const run: Run = {
      generation: ++generation,
      header: pending.then((t) => (t.ok ? ok(`Bearer ${t.value}`) : t)),
      failed: false,
      refused: false,
      replacement,
      accepted: false,
    };
    current = run;
    void run.header.then((h) => {
      run.failed = !h.ok;
    });
    return run;
  };
  const leaseOf = async (
    run: Run,
    signal?: AbortSignal,
  ): Promise<JiraLease> => {
    let renewed: Run | null = null;
    return {
      header: await until(run.header, signal, program),
      accepted: () => {
        (renewed ?? run).accepted = true;
      },
      refuseRenewal: () => {
        if (renewed !== null) renewed.refused = true;
      },
      renew: (renewSignal) => {
        // A later generation already replaced the one this lease holds.
        if (current !== null && current.generation > run.generation) {
          renewed = current;
          return until(current.header, renewSignal, program);
        }
        // A replacement refused in turn stays refused for this process.
        if (run.refused || (run.replacement && !run.accepted)) {
          run.refused = true;
          return Promise.resolve(null);
        }
        // No one is waiting once the request has ended: start no new run.
        if (renewSignal?.aborted)
          return Promise.resolve(stopped(renewSignal, program));
        renewed = start(true);
        return until(renewed.header, renewSignal, program);
      },
    };
  };
  const lease = (signal?: AbortSignal) =>
    leaseOf(current !== null && !current.failed ? current : start(), signal);
  return {
    lease,
    header: async (signal) => (await lease(signal)).header,
  };
}
