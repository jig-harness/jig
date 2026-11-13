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
 * - **A command that runs a program from the repository** is run from the
 *   default branch's files, not from the working tree of the branch being
 *   worked on (`withDefaultBranchTree`): the setting and the files it runs
 *   come from the same commit of the default branch.
 *
 * The caller reads the exit code and the output; what they mean is the
 * caller's contract (a preflight's exit 3, a facet store's JSON).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OVERLAY_RELPATH, isMapping } from "./config-layers.ts";
import { remoteName } from "./consumer.ts";
import { attempt, failed, ok, type Outcome } from "./outcome.ts";
import { git, gitIdentityEnv, run } from "./proc.ts";
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
/** How long copying the default branch's files may take. */
const EXPORT_TIMEOUT_SEC = 120;
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
): Promise<
  Outcome<{ ref: string; commit: string; config: unknown }, "unreadable">
> {
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
  const resolved = await git(
    ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { stderr: "pipe", timeoutSec: FETCH_TIMEOUT_SEC },
  );
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || commit === "")
    return failed("unreadable", `${ref} names no commit in this clone`);
  const show = await git(["-C", root, "show", `${commit}:${OVERLAY_RELPATH}`], {
    stderr: "pipe",
    timeoutSec: FETCH_TIMEOUT_SEC,
  });
  // A default branch with no configuration file sets nothing.
  if (
    show.code !== 0 &&
    /does not exist|exists on disk, but not in/.test(show.stderr)
  )
    return ok({ ref, commit, config: null });
  if (show.code !== 0)
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${ref} could not be read: ${oneLine(show.stderrTail || show.stderr)}`,
    );
  try {
    return ok({ ref, commit, config: load(show.stdout) });
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
 * from one fetch and one parse, so they answer together or fail together,
 * with the commit they were read from. A clone with no default branch to
 * read (`<remote>/HEAD` unset), or a file there that does not parse, is a
 * failure: the caller decides whether that refuses.
 */
async function defaultBranchSettingsAt(
  root: string,
  section: string,
  fields: readonly string[],
): Promise<
  Outcome<{ values: Record<string, unknown>; commit: string }, "unreadable">
> {
  const read = await defaultBranchConfig(root);
  if (!read.ok) return read;
  const { ref, commit, config } = read.value;
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field] = null;
  if (config === null || config === undefined) return ok({ values, commit });
  if (!isMapping(config))
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${ref} is not a mapping`,
    );
  const part = config[section];
  if (part === undefined || part === null) return ok({ values, commit });
  if (!isMapping(part))
    return failed(
      "unreadable",
      `${section} in ${OVERLAY_RELPATH} on ${ref} is not a mapping`,
    );
  for (const field of fields) values[field] = part[field] ?? null;
  return ok({ values, commit });
}

/** The fields of `defaultBranchSettingsAt`, without the commit. */
export async function defaultBranchSettings(
  root: string,
  section: string,
  fields: readonly string[],
): Promise<Outcome<Record<string, unknown>, "unreadable">> {
  const read = await defaultBranchSettingsAt(root, section, fields);
  return read.ok ? ok(read.value.values) : read;
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

/** One field as the default branch holds it, and the commit it was read from. */
export async function defaultBranchSettingAt(
  root: string,
  section: string,
  field: string,
): Promise<Outcome<{ value: unknown; commit: string }, "unreadable">> {
  const read = await defaultBranchSettingsAt(root, section, [field]);
  return read.ok
    ? ok({ value: read.value.values[field], commit: read.value.commit })
    : read;
}

/**
 * Run `use` in a directory holding the files of `commit` (a commit of the
 * default branch, as `defaultBranchSettingAt` names it), and remove the
 * directory afterwards, however `use` ends. The copy is made from a
 * temporary index, so the repository's own index, working tree and branches
 * are never touched, and nothing of the working tree reaches it: a command
 * run there executes the reviewed program, never a pull request's edit of
 * it. It holds tracked files only: nothing installed or generated beside
 * them (`node_modules`, build output) is in it.
 */
export async function withDefaultBranchTree<T>(
  root: string,
  commit: string,
  use: (dir: string) => Promise<T>,
): Promise<Outcome<T, "unreadable">> {
  let scratch: string;
  try {
    scratch = mkdtempSync(join(tmpdir(), "jig-default-branch-"));
  } catch (error) {
    return failed(
      "unreadable",
      `a copy of the default branch's files could not be started: ${oneLine(error instanceof Error ? error.message : String(error))}`,
    );
  }
  try {
    const tree = join(scratch, "tree");
    const made = attempt("unreadable", "the copy's directory", () =>
      mkdirSync(tree),
    );
    if (!made.ok) return made;
    const env = {
      ...gitIdentityEnv(),
      GIT_INDEX_FILE: join(scratch, "index"),
    };
    const options = {
      env,
      stderr: "pipe" as const,
      timeoutSec: EXPORT_TIMEOUT_SEC,
    };
    const read = await git(["-C", root, "read-tree", commit], options);
    const copy =
      read.code === 0
        ? await git(
            [
              "-C",
              root,
              "checkout-index",
              "--all",
              "--force",
              `--prefix=${tree.replaceAll("\\", "/")}/`,
            ],
            options,
          )
        : read;
    if (copy.code !== 0)
      return failed(
        "unreadable",
        `the default branch's files at ${commit.slice(0, 12)} could not be copied: ${oneLine(copy.stderrTail || copy.stderr)}`,
      );
    return ok(await use(tree));
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not the command's failure.
    }
  }
}
