/** The environment a `git` call needs to answer for the repository at its working directory. */

/**
 * Every environment variable that overrides git's own `cwd`-based repository
 * discovery. Any of these exported into this process — a lefthook hook exports
 * `GIT_DIR` and `GIT_WORK_TREE` together, but nothing guarantees only that
 * shape reaches here — silently redirects a `cwd`-anchored `git` call at a
 * DIFFERENT repository than the caller is reasoning about.
 *
 * `GIT_DIR` alone, with no `GIT_WORK_TREE`, is the sharpest case: git then
 * treats the CURRENT DIRECTORY as the work tree while resolving refs from the
 * leaked dir, so `rev-parse --show-toplevel` reports `cwd` — matching whatever
 * anchor a caller checks it against — while `rev-parse HEAD` answers for
 * another repository entirely. `cwd` alone was never sufficient against any of
 * these. `GIT_NAMESPACE` is the same hazard through ref resolution
 * (`refs/namespaces/<ns>/…`) without touching which worktree is reported.
 *
 * ONE list and ONE scrubber, here, rather than a copy per entrypoint: a fix
 * that reaches one copy leaves every other copy open to the hazard it closed.
 * `proc.ts` and drive-pr's `lib/proc.ts` re-export them; the forge client's
 * governance, which `proc.ts` itself loads, imports them from here.
 */
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
];

/**
 * `process.env` with every entry in `GIT_LOCATION_VARS` removed — pass as
 * `env:` to any `cwd`-anchored `git` call whose answer must be about the
 * repository at that `cwd`.
 *
 * Windows environment-variable names are case-INSENSITIVE, but a JS object's
 * property deletion is not: an inherited spelling like `Git_Dir` survives an
 * exact-match delete and is still read by git as `GIT_DIR`, reopening the leak
 * this exists to close. POSIX
 * names ARE case-sensitive, so the exact-match form stays correct and cheaper
 * there.
 */
export function gitIdentityEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const targets = new Set(GIT_LOCATION_VARS.map((k) => k.toLowerCase()));
    for (const key of Object.keys(env)) {
      if (targets.has(key.toLowerCase())) delete env[key];
    }
  } else {
    for (const key of GIT_LOCATION_VARS) delete env[key];
  }
  return env;
}
