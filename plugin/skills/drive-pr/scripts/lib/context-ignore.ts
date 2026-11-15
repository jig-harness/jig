/**
 * Keep the drive's own `.context/` files out of every cleanliness check.
 *
 * The drive writes its handoff, mailbox, foreground-wait state and procedure
 * scratch under `.context/`, and every check of a clean tree reads
 * `git status --untracked-files=normal`. In a repository whose ignore rules
 * do not cover `.context/`, those files are untracked changes, and the drive
 * refuses to attach, push or certify convergence on files it wrote itself.
 * The clone's local exclude file (`info/exclude`, never committed) is where
 * the drive says `.context/` is its own, leaving the repository's
 * `.gitignore` and every file outside `.context/` judged as before.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { errnoCode } from "../../../../shared/errors.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "./proc.ts";

/** The drive's working directory, as the path git is asked about. */
export const CONTEXT_PATH = ".context/";

/** The exclude pattern for it, anchored: only the root `.context/` is the drive's. */
export const CONTEXT_PATTERN = "/.context/";

export type ContextIgnore =
  | { kind: "ignored" }
  | { kind: "excluded"; file: string }
  | { kind: "failed"; reason: string };

function readExclude(file: string): { text: string } | { error: string } {
  try {
    return { text: readFileSync(file, "utf8") };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { text: "" };
    return { error: errnoCode(error) ?? String(error) };
  }
}

/**
 * Make sure `.context/` is ignored in the working tree at `tree`: nothing
 * changes when the repository's rules already ignore it or the exclude file
 * already names it; otherwise `.context/` is appended to the clone's
 * `info/exclude`, every line already there kept.
 */
export async function ensureContextIgnored(
  tree: string,
): Promise<ContextIgnore> {
  const opts = {
    cwd: tree,
    env: gitIdentityEnv(),
    timeoutSec: gitCallTimeoutSeconds(),
    stderr: "pipe" as const,
  };
  // `--no-index`: a tracked file under `.context/` must not hide the rule.
  const probe = await git(
    ["check-ignore", "-q", "--no-index", CONTEXT_PATH],
    opts,
  );
  if (probe.code === 0) return { kind: "ignored" };
  if (probe.code !== 1)
    return {
      kind: "failed",
      reason: `git check-ignore exited ${probe.code}: ${probe.stderr.trim()}`,
    };
  const where = await git(["rev-parse", "--git-path", "info/exclude"], opts);
  const relative = where.stdout.trim();
  if (where.code !== 0 || relative === "")
    return {
      kind: "failed",
      reason: `cannot locate the clone's exclude file: ${where.stderr.trim()}`,
    };
  const file = resolve(tree, relative);
  const read = readExclude(file);
  if ("error" in read)
    return { kind: "failed", reason: `cannot read ${file}: ${read.error}` };
  const current = read.text;
  const present = current
    .split("\n")
    .some((line) => line.replace(/\r$/, "") === CONTEXT_PATTERN);
  if (!present) {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${separator}${CONTEXT_PATTERN}\n`);
    } catch (error) {
      return {
        kind: "failed",
        reason: `cannot write ${file}: ${errnoCode(error) ?? String(error)}`,
      };
    }
  }
  // The rule's presence is not its effect: a later negation can defeat it.
  const after = await git(
    ["check-ignore", "-q", "--no-index", CONTEXT_PATH],
    opts,
  );
  if (after.code !== 0)
    return {
      kind: "failed",
      reason: `${CONTEXT_PATTERN} is in ${file}, but git still does not ignore ${CONTEXT_PATH} (a negation in a higher-priority rule?)`,
    };
  return present ? { kind: "ignored" } : { kind: "excluded", file };
}

/**
 * `ensureContextIgnored` for the drive and its attach: report what it did on
 * standard error under `who`, never stop. A dry run, which moves nothing,
 * writes nothing here either.
 */
export async function ignoreDriveContext(
  tree: string,
  dryRun: boolean,
  who = "drive.ts",
): Promise<void> {
  if (dryRun || tree === "") return;
  const outcome = await ensureContextIgnored(tree);
  if (outcome.kind === "excluded")
    console.error(
      `${who}: the repository does not ignore ${CONTEXT_PATTERN}; added it to ${outcome.file} so the drive's own files leave the tree clean`,
    );
  else if (outcome.kind === "failed")
    console.error(
      `${who}: could not make sure ${CONTEXT_PATTERN} is ignored (${outcome.reason}); the drive's own files there may make the tree read as unclean`,
    );
}
