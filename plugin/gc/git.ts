import { GcError } from "../shared/gc-error.ts";
import { run } from "../shared/proc.ts";
import {
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
export async function gcGit(root: string, args: string[]): Promise<string> {
  // Observation must not refresh the index or execute a checkout's monitor.
  // Command-line configuration also propagates to Git's submodule children.
  const result = await run(
    [
      "git",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-C",
      root,
      ...args,
    ],
    { timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code !== 0)
    throw new GcError(
      `git ${args[0]}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  return result.stdout.trimEnd();
}
export async function baseDeclaration(
  entry: RepositoryEntry,
): Promise<{ declaration: Declaration; source: string }> {
  if (
    (await gcGit(entry.path, ["remote", "get-url", entry.remote])).trim() !==
    entry.remote_url
  )
    throw new GcError("Installed remote URL changed; run gc install again");
  await gcGit(entry.path, [
    "check-ref-format",
    `refs/heads/${entry.base_branch}`,
  ]);
  // FETCH_HEAD is shared with arbitrary fetches. Resolve the fetched object
  // from a unique private ref and read that immutable object instead.
  const ref = `refs/jig-gc/${process.pid}-${crypto.randomUUID()}`;
  try {
    await gcGit(entry.path, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      entry.remote_url,
      `refs/heads/${entry.base_branch}:${ref}`,
    ]);
    const tip = await gcGit(entry.path, ["rev-parse", "--verify", ref]);
    const text = await gcGit(entry.path, ["show", `${tip}:.config/jig.yaml`]);
    // gcConfiguration reads the snapshot through the shared configuration
    // reader; checkout and environment declarations cannot replace this layer.
    return {
      declaration: gcConfiguration(entry.path, text).declaration,
      source: `${entry.remote_url} refs/heads/${entry.base_branch} @ ${tip}`,
    };
  } finally {
    await gcGit(entry.path, ["update-ref", "--no-deref", "-d", ref]);
  }
}
