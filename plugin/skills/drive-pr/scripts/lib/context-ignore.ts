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

/** The directory the drive's working files live in, as an exclude pattern. */
export const CONTEXT_PATTERN = ".context/";

export type ContextIgnore =
  | { kind: "ignored" }
  | { kind: "excluded"; file: string }
  | { kind: "failed"; reason: string };

function readExclude(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "";
    return null;
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
    ["check-ignore", "-q", "--no-index", CONTEXT_PATTERN],
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
  const current = readExclude(file);
  if (current === null)
    return { kind: "failed", reason: `cannot read ${file}` };
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(CONTEXT_PATTERN)) return { kind: "ignored" };
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
  return { kind: "excluded", file };
}

/**
 * `ensureContextIgnored` for the driver: report what it did, never stop. A
 * dry run, which moves nothing, writes nothing here either.
 */
export async function ignoreDriveContext(
  tree: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun || tree === "") return;
  const outcome = await ensureContextIgnored(tree);
  if (outcome.kind === "excluded")
    console.error(
      `drive.ts: the repository does not ignore ${CONTEXT_PATTERN}; added it to ${outcome.file} so the drive's own files leave the tree clean`,
    );
  else if (outcome.kind === "failed")
    console.error(
      `drive.ts: could not make sure ${CONTEXT_PATTERN} is ignored (${outcome.reason}); the drive's own files there may make the tree read as unclean`,
    );
}
