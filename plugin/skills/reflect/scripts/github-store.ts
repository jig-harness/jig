#!/usr/bin/env bun
/**
 * The GitHub store: reflections as issues in a GitHub repository, behind
 * the store contract.
 *
 * Usage:
 *   bun github-store.ts --repository <owner/name> <check|append|list|diagnose|repair>
 *
 *   check     {"ok":true}, or {"ok":false,"reason":…,"fix":…}
 *   append    JSONL events on stdin → {"stored":[{"id":…,"ref":…}]}
 *   list      optional {"since":…} on stdin → JSONL events, each id once
 *   diagnose  JSONL notices: ids stored with different events, and records
 *             in comments by people who cannot write to the repository
 *   repair    recomputes every issue's title and description from the events
 *
 * One issue per change (its issue key, else its branch, per repository),
 * labelled `jig-reflection`; each event is one line in a JSON code block in
 * a comment on that issue, and `list` reads those comments, by people who
 * can write to the repository, and nothing else. The issue's title and
 * description are recomputed from the events after every write.
 *
 * Requests go through `gh api graphql`, signed in as `gh` is; with
 * JIG_GITHUB_GRAPHQL_URL set, over HTTPS to that endpoint with the token in
 * GH_TOKEN or GITHUB_TOKEN (http to a loopback address for a local fake).
 * JIG_GITHUB_INTERVAL_MS sets the least time between two writes (1000 by
 * default, as GitHub asks of requests that create content).
 *
 * Exit codes: 0 done; 1 failed (the reason on stderr); 2 usage; 3 GitHub is
 * unreachable, rate-limited past the retries, or the credential is missing
 * or refused.
 */
import { runMain } from "../../../shared/cli.ts";
import {
  exitCodeOf,
  GitHubApiError,
  GitHubClient,
  isAuthFailure,
} from "./lib/github/api.ts";
import {
  notVisible,
  openRepository,
  type Repository,
  type Unusable,
  unreadable,
  unwritable,
} from "./lib/github/repository.ts";
import {
  appendEvents,
  diagnose,
  listOutput,
  readStore,
  repair,
} from "./lib/github/store.ts";
import { githubSetting } from "./lib/settings.ts";
import { appendInput, sinceInput } from "./lib/store-io.ts";

const USAGE =
  "usage: github-store.ts --repository <owner/name> <check|append|list|diagnose|repair>";

const SIGN_IN_FIX =
  "sign in with `gh auth login` (or export a token as GH_TOKEN), with access to the repository";

function usage(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 2;
}

/** The repository, or a failure when it cannot be used as `problem` says. */
async function opened(
  client: GitHubClient,
  nameWithOwner: string,
  problem: (repo: Repository) => Unusable | null,
): Promise<Repository> {
  const repo = await openRepository(client, nameWithOwner);
  const unusable = repo === null ? notVisible(nameWithOwner) : problem(repo);
  if (unusable !== null)
    throw new GitHubApiError(`${unusable.reason}: ${unusable.fix}`);
  return repo as Repository;
}

/** What `check` says of a repository the account could ask about. */
async function checkResult(
  nameWithOwner: string,
): Promise<Record<string, unknown>> {
  const repo = await openRepository(GitHubClient.fromEnv(), nameWithOwner);
  const unusable = repo === null ? notVisible(nameWithOwner) : unwritable(repo);
  return unusable === null ? { ok: true } : { ok: false, ...unusable };
}

/** A missing or refused credential is `check`'s to report; anything else fails it. */
function signInProblem(error: unknown): Record<string, unknown> {
  if (!isAuthFailure(error)) throw error;
  return { ok: false, reason: (error as Error).message, fix: SIGN_IN_FIX };
}

async function check(nameWithOwner: string): Promise<number> {
  const result = await checkResult(nameWithOwner).catch(signInProblem);
  console.log(JSON.stringify(result));
  return 0;
}

async function append(nameWithOwner: string): Promise<number> {
  const input = await appendInput();
  if ("problem" in input) {
    console.error(input.problem);
    return 1;
  }
  if (input.events.length === 0) {
    console.log(JSON.stringify({ stored: [] }));
    return 0;
  }
  const client = GitHubClient.fromEnv();
  const repo = await opened(client, nameWithOwner, unwritable);
  const result = await appendEvents(client, repo, input.events, new Date());
  for (const failure of result.viewFailures)
    console.error(
      `the title and description of ${failure} were not updated; the events are stored, and a later write or github-store.ts repair recomputes them`,
    );
  console.log(JSON.stringify({ stored: result.stored }));
  return 0;
}

async function list(nameWithOwner: string): Promise<number> {
  const after = await sinceInput();
  const client = GitHubClient.fromEnv();
  const issues = await readStore(
    client,
    await opened(client, nameWithOwner, unreadable),
  );
  for (const text of listOutput(issues, after))
    process.stdout.write(`${text}\n`);
  return 0;
}

async function diagnoseOp(nameWithOwner: string): Promise<number> {
  const client = GitHubClient.fromEnv();
  const repo = await opened(client, nameWithOwner, unreadable);
  for (const notice of await diagnose(client, repo))
    process.stdout.write(`${JSON.stringify(notice)}\n`);
  return 0;
}

async function repairOp(nameWithOwner: string): Promise<number> {
  const client = GitHubClient.fromEnv();
  const repo = await opened(client, nameWithOwner, unwritable);
  const result = await repair(client, repo);
  console.log(
    JSON.stringify({ issues: result.synced, failed: result.failures }),
  );
  for (const failure of result.failures) console.error(failure);
  return result.failures.length === 0 ? 0 : 1;
}

/** The operations, by name. */
const OPERATIONS: Record<string, (repository: string) => Promise<number>> = {
  check,
  append,
  list,
  diagnose: diagnoseOp,
  repair: repairOp,
};

interface Scanned {
  op: string | undefined;
  /** The first argument that is neither the option nor the operation. */
  unknown: string | undefined;
  repository: string | undefined;
}

/**
 * The option and the other arguments, in order. The caller appends the
 * operation to the configured command, so it may come after the option.
 */
function scanArgs(argv: readonly string[]): Scanned {
  const rest: string[] = [];
  let repository: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repository" && i + 1 < argv.length)
      repository = argv[++i];
    else rest.push(argv[i] as string);
  }
  return { ...positional(rest), repository };
}

/** The operation, and the first argument after it or that is an unknown option. */
function positional(rest: readonly string[]): Pick<Scanned, "op" | "unknown"> {
  const unknown = rest.find((arg, i) => i > 0 || arg.startsWith("--"));
  return { op: unknown === rest[0] ? undefined : rest[0], unknown };
}

/** The same check the setting gets, so a bad value is refused alike. */
function repositoryProblem(repository: string | undefined): string | null {
  if (repository === undefined) return "--repository <owner/name> is required";
  try {
    githubSetting({ repository });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What is wrong with a command line, in the order it is reported. */
const COMMAND_RULES: Array<(c: Scanned) => string | null> = [
  (c) => (c.unknown === undefined ? null : `unknown argument: ${c.unknown}`),
  (c) => (c.op === undefined ? "missing operation" : null),
  (c) =>
    Object.hasOwn(OPERATIONS, c.op as string)
      ? null
      : `unknown operation: ${c.op}`,
  (c) => repositoryProblem(c.repository),
];

/** The operation and the repository, or the usage problem with them. */
function parseCommand(
  argv: readonly string[],
): { op: string; repository: string } | string {
  const scanned = scanArgs(argv);
  for (const rule of COMMAND_RULES) {
    const problem = rule(scanned);
    if (problem !== null) return problem;
  }
  return {
    op: scanned.op as string,
    repository: (scanned.repository as string).trim(),
  };
}

export async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  if (typeof command === "string") return usage(command);
  try {
    return await (OPERATIONS[command.op] as (r: string) => Promise<number>)(
      command.repository,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return exitCodeOf(error);
  }
}

if (import.meta.main)
  runMain("github-store.ts", () => main(process.argv.slice(2)));
