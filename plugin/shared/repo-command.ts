/**
 * A command a repository supplies, run under the rules every such command
 * shares (design/tracker-facets.md § Later: the command store):
 *
 * - **Only the repository sets it, from its default branch.** The setting is
 *   read from `.config/jig.yaml` as the default branch holds it
 *   (`defaultBranchSetting`), never from the user layer, an environment
 *   variable, an overlay file or a working tree on another branch. Its field
 *   is listed in `REPOSITORY_ONLY_FIELDS` as well.
 * - **Its environment is scrubbed** of the tracker and forge tokens the
 *   adapters read (`SCRUBBED_ENV`), so they stay out of its environment and
 *   its logs. That is not containment: it runs as the same user, so what
 *   bounds it is the review of the default branch that names it.
 * - **It is bounded**: a deadline, and at most `MAX_OUTPUT_BYTES` of
 *   standard output.
 * - **Its failures are redacted** to one bounded line (`oneLine`).
 *
 * The caller reads the exit code and the output; what they mean is the
 * caller's contract (a preflight's exit 3, a facet store's JSON).
 */
import { OVERLAY_RELPATH, isMapping } from "./config-layers.ts";
import { remoteName } from "./consumer.ts";
import { failed, ok, type Outcome } from "./outcome.ts";
import { git, run } from "./proc.ts";
import { load } from "./yaml.ts";

/** The tokens a repository's command never sees. */
export const SCRUBBED_ENV: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_BEARER_TOKEN",
  "JIRA_TOKEN_COMMAND",
  "LINEAR_API_KEY",
  "LINEAR_API_TOKEN",
];

/** The most standard output a command may write; more fails the run. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** How long the default branch's fetch may take before its last-fetched copy is read. */
const FETCH_TIMEOUT_SEC = 30;
/** How many characters of a reason or a failure's output a line keeps. */
const LINE_CHARS = 300;

/** One line of at most `chars`, with control characters made spaces. */
export function oneLine(text: string, chars = LINE_CHARS): string {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length > chars ? `${line.slice(0, chars)}…` : line;
}

export type RepoCommandResult =
  | { kind: "exited"; code: number; stdout: string; stderrTail: string }
  /** It did not answer: still running at the deadline, could not start, or wrote too much. */
  | { kind: "failed"; reason: string };

export interface RepoCommand {
  /** The command line, as the repository wrote it; it runs through the platform shell. */
  command: string;
  /** Where it runs: the repository root. */
  cwd: string;
  /** Text on its standard input. */
  stdin?: string;
  timeoutSec: number;
  /** How a reason names it, such as `do_item.preflight_command`. */
  name: string;
}

/** The environment a repository's command runs in. */
export function scrubbedEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  // Windows reads environment names case-insensitively, so match likewise.
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SCRUBBED_ENV.includes(key.toUpperCase())) out[key] = value;
  }
  return out;
}

/** Run a repository's command and read how it ended. */
export async function runRepoCommand(
  spec: RepoCommand,
): Promise<RepoCommandResult> {
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", spec.command]
      : ["sh", "-c", spec.command];
  const result = await run(argv, {
    cwd: spec.cwd,
    env: scrubbedEnv(),
    timeoutSec: spec.timeoutSec,
    maxBufferBytes: MAX_OUTPUT_BYTES,
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
  });
  if (result.timedOut)
    return {
      kind: "failed",
      reason: `${spec.name} was still running after ${spec.timeoutSec}s and was stopped`,
    };
  if (result.spawnFailed)
    return {
      kind: "failed",
      reason: `${spec.name} could not start: ${oneLine(result.stderr)}`,
    };
  if (
    result.bufferExceeded ||
    Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES
  )
    return {
      kind: "failed",
      reason: `${spec.name} wrote more than ${MAX_OUTPUT_BYTES / 1024} KiB of output`,
    };
  return {
    kind: "exited",
    code: result.code,
    stdout: result.stdout,
    stderrTail: oneLine(result.stderrTail),
  };
}

/** The default branch, as `<remote>/HEAD` names it in this clone; `null` when it names none. */
async function defaultBranchRef(
  root: string,
  remote: string,
): Promise<string | null> {
  const head = await git(
    [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ],
    { stderr: "pipe", timeoutSec: FETCH_TIMEOUT_SEC },
  );
  const name = head.stdout.trim();
  return head.code === 0 && name.startsWith(`${remote}/`) ? name : null;
}

/** The remote this clone fetches from, or why it cannot be named. */
function remoteOf(root: string): Outcome<string, "unreadable"> {
  try {
    return ok(remoteName(root));
  } catch (error) {
    return failed(
      "unreadable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `.config/jig.yaml` as the default branch holds it, parsed; `null` when
 * that branch has no such file. The branch is fetched first, within a
 * deadline; when the fetch fails, the copy this clone fetched last is read.
 */
async function defaultBranchConfig(
  root: string,
): Promise<Outcome<{ ref: string; config: unknown }, "unreadable">> {
  const remote = remoteOf(root);
  if (!remote.ok) return remote;
  const ref = await defaultBranchRef(root, remote.value);
  if (ref === null)
    return failed(
      "unreadable",
      `this clone names no default branch (${remote.value}/HEAD is unset; git remote set-head ${remote.value} --auto sets it)`,
    );
  await git(
    [
      "-C",
      root,
      "fetch",
      "--quiet",
      remote.value,
      ref.slice(remote.value.length + 1),
    ],
    { stderr: "pipe", timeoutSec: FETCH_TIMEOUT_SEC },
  );
  const show = await git(["-C", root, "show", `${ref}:${OVERLAY_RELPATH}`], {
    stderr: "pipe",
    timeoutSec: FETCH_TIMEOUT_SEC,
  });
  // A default branch with no configuration file sets nothing.
  if (
    show.code !== 0 &&
    /does not exist|exists on disk, but not in/.test(show.stderr)
  )
    return ok({ ref, config: null });
  if (show.code !== 0)
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${ref} could not be read: ${oneLine(show.stderrTail || show.stderr)}`,
    );
  try {
    return ok({ ref, config: load(show.stdout) });
  } catch (error) {
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${ref} does not parse: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/**
 * Fields of `.config/jig.yaml` as the repository's default branch holds
 * them (`section.field`), each `null` when that branch does not set it, all
 * from one fetch and one parse, so they answer together or fail together. A
 * clone with no default branch to read (`<remote>/HEAD` unset), or a file
 * there that does not parse, is a failure: the caller decides whether that
 * refuses.
 */
export async function defaultBranchSettings(
  root: string,
  section: string,
  fields: readonly string[],
): Promise<Outcome<Record<string, unknown>, "unreadable">> {
  const read = await defaultBranchConfig(root);
  if (!read.ok) return read;
  const { ref, config } = read.value;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = null;
  if (config === null || config === undefined) return ok(out);
  if (!isMapping(config))
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${ref} is not a mapping`,
    );
  const part = config[section];
  if (part === undefined || part === null) return ok(out);
  if (!isMapping(part))
    return failed(
      "unreadable",
      `${section} in ${OVERLAY_RELPATH} on ${ref} is not a mapping`,
    );
  for (const field of fields) out[field] = part[field] ?? null;
  return ok(out);
}

/** One field of `.config/jig.yaml` as the default branch holds it; see `defaultBranchSettings`. */
export async function defaultBranchSetting(
  root: string,
  section: string,
  field: string,
): Promise<Outcome<unknown, "unreadable">> {
  const read = await defaultBranchSettings(root, section, [field]);
  return read.ok ? ok(read.value[field]) : read;
}
