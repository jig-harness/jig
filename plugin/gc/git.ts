import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { run } from "../shared/proc.ts";
import {
  type ConfigurationCode,
  gcConfiguration,
  type Declaration,
  type RepositoryEntry,
} from "./config.ts";

/** Ignore inherited worktree identity and command-injected Git configuration. */
export function gitEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !name.startsWith("GIT_") &&
        !name.startsWith("DRIVE_PR_") &&
        !name.startsWith("JIG__") &&
        name !== "JIG_OVERLAY" &&
        name !== "GH_REPO"
      );
    }),
  );
}
/** A git command gc ran exited with a failure: `git <command>: <its error output>`. */
export type GitOutcome<T> = Outcome<T, "git-failed">;
/** Git's output, trailing whitespace trimmed, or why the command failed. */
export async function gcGit(
  root: string,
  args: string[],
): Promise<GitOutcome<string>> {
  // Observation must not refresh the index or execute a checkout's monitor,
  // and the base fetch must not run hooks, which a hooks path can place in
  // tracked files. Command-line configuration also reaches submodule children.
  const result = await run(
    [
      "git",
      "--no-optional-locks",
      // Replacement objects would show a commit other than the one asked for.
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    { timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code !== 0)
    return failed(
      "git-failed",
      `git ${args[0]}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  return ok(result.stdout.trimEnd());
}
/** Why the base branch's declaration cannot be read for a machine entry. */
export type BaseDeclarationCode =
  | "git-failed"
  | "remote-changed"
  | "remote-redirected"
  | ConfigurationCode;
/**
 * The declaration the entry's base branch holds, read from a private ref the
 * fetch writes and deleted afterwards. When that deletion fails, its failure
 * is the answer, whatever the read gave; what the read throws is a failure
 * too, so the deletion always runs.
 */
export async function baseDeclaration(
  entry: RepositoryEntry,
): Promise<
  Outcome<{ declaration: Declaration; source: string }, BaseDeclarationCode>
> {
  const url = await gcGit(entry.path, ["remote", "get-url", entry.remote]);
  if (!url.ok) return url;
  if (url.value.trim() !== entry.remote_url)
    return failed(
      "remote-changed",
      "Installed remote URL changed; run gc install again",
    );
  // The fetch below names the recorded URL, which a URL rewrite rule added
  // since installation could still redirect.
  const rewritten = await gcGit(entry.path, [
    "ls-remote",
    "--get-url",
    entry.remote_url,
  ]);
  if (!rewritten.ok) return rewritten;
  if (rewritten.value !== entry.remote_url)
    return failed(
      "remote-redirected",
      "A url.<base>.insteadOf rule redirects the installed remote URL; remove it or run gc install again",
    );
  const format = await gcGit(entry.path, [
    "check-ref-format",
    `refs/heads/${entry.base_branch}`,
  ]);
  if (!format.ok) return format;
  // FETCH_HEAD is shared with arbitrary fetches. Resolve the fetched object
  // from a unique private ref and read that immutable object instead.
  const ref = `refs/jig-gc/${process.pid}-${crypto.randomUUID()}`;
  let read: Awaited<ReturnType<typeof baseDeclaration>>;
  try {
    read = await fetchedDeclaration(entry, ref);
  } catch (error) {
    read = failed(
      "unreadable",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const deleted = await gcGit(entry.path, [
    "update-ref",
    "--no-deref",
    "-d",
    ref,
  ]);
  return deleted.ok ? read : deleted;
}
async function fetchedDeclaration(
  entry: RepositoryEntry,
  ref: string,
): Promise<
  Outcome<{ declaration: Declaration; source: string }, BaseDeclarationCode>
> {
  const fetched = await gcGit(entry.path, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    entry.remote_url,
    `refs/heads/${entry.base_branch}:${ref}`,
  ]);
  if (!fetched.ok) return fetched;
  const tip = await gcGit(entry.path, ["rev-parse", "--verify", ref]);
  if (!tip.ok) return tip;
  const text = await gcGit(entry.path, [
    "show",
    `${tip.value}:.config/jig.yaml`,
  ]);
  if (!text.ok) return text;
  // gcConfiguration reads the snapshot through the shared configuration
  // reader; checkout and environment declarations cannot replace this layer.
  const configuration = gcConfiguration(entry.path, text.value);
  if (!configuration.ok) return configuration;
  return ok({
    declaration: configuration.value.declaration,
    source: `${entry.remote_url} refs/heads/${entry.base_branch} @ ${tip.value}`,
  });
}
