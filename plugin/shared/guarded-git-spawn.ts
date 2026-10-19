/**
 * The one path back to `node:child_process` for anything that might resolve to
 * `git`. A hook manager runs hooks with `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_INDEX_FILE` exported and pointing at the REAL shared repository (see
 * `LEAKY_GIT_ENV` for the full set refused). A
 * scratch git call that inherits them mutates that repository instead of its
 * own throwaway one: `git init` inheriting a linked worktree's `GIT_DIR` sets
 * `core.bare = true` in the shared common config, affecting every worktree.
 *
 * Every spawn through this module must pass an explicit env free of those
 * variables, regardless of what the immediate `command` is. A name-based
 * classifier ("is this git?") stays one layer of indirection behind: matching
 * `git`, `/usr/bin/git` or any path ending in `/git` still misses
 * `spawnSync("/usr/bin/env", ["git", "init"])` and
 * `spawnSync("bash", ["-c", "git init"])`, whose immediate command does not
 * look like git but which inherit the leaking ambient env all the same.
 * Requiring an explicit, leak-free env for every spawn closes the whole class
 * at once.
 *
 * The raw import lives only here and only the guarded wrappers are exported,
 * so no other file has an import path back to the unguarded primitive.
 * (Aliasing a wrapper in the same file does not close that: the raw import
 * would sit next to it, callable by anything added later.)
 */
import {
  type ChildProcess,
  spawn as rawSpawn,
  spawnSync as rawSpawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

/**
 * The variables that route git at a repository other than the scratch one.
 * The first three are what a hook manager exports; the rest redirect where the
 * shared config/refs (`GIT_COMMON_DIR`) or objects (`GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`) are read from or written to, and
 * `GIT_CONFIG` makes `git config` write to the named file instead of the
 * scratch repository's, which defeats isolation just as well when set alone.
 * This is the set the guard knows about, not a proof that no other variable
 * can reroute git.
 */
export const LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
] as const;

/** `env` without the variables in {@link LEAKY_GIT_ENV}, for an explicit spawn env. */
export function withoutLeakyGitEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase())
    )
      clean[key] = value;
  return clean;
}

function requireSafeEnv(env: SpawnSyncOptions["env"] | undefined): void {
  if (!env)
    throw new Error(
      "raw spawn with no explicit env: it inherits the ambient one, which a git hook may point at the real repository. Pass an explicit safe env even for a command that does not look like git, since it may launch git indirectly (env, bash -c, a wrapper script)",
    );
  // Matched case-insensitively on every platform: Windows environments are
  // case-insensitive, so `{ Git_Dir }` reaches the child as GIT_DIR there, and
  // rejecting the odd spelling on POSIX too costs nothing and keeps the guard
  // testable without a Windows host.
  const present = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key.toUpperCase()),
  );
  const leaked = LEAKY_GIT_ENV.filter((key) => present.has(key));
  if (leaked.length > 0)
    throw new Error(
      `raw spawn whose env leaks ${leaked.join(", ")}: build an explicit env without them`,
    );
}

export function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string> {
  requireSafeEnv(options?.env);
  return rawSpawnSync(command, (args ?? []) as string[], {
    ...options,
    encoding: "utf8",
  });
}

/**
 * The asynchronous half, held to the identical requirement. A test that must
 * signal the process under test (the only way to exercise cancellation) cannot
 * use `spawnSync`, and reaching for the raw `spawn` would reopen the class the
 * header describes closing.
 */
export function spawn(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  requireSafeEnv(options?.env);
  return rawSpawn(command, (args ?? []) as string[], options ?? {});
}
