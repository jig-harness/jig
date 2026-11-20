/**
 * `process.env` with `GH_REPO` removed — the `gh` CLI's equivalent of `GIT_DIR`
 * above: `gh` gives `GH_REPO` precedence over the repository it would otherwise
 * detect from the current directory, ahead even of an explicit `cwd`. Pass as
 * `env:` to any `cwd`-anchored `gh` call whose answer must be about the
 * repository AT that `cwd` — an inherited `GH_REPO` from the ambient
 * environment would otherwise silently redirect it to a different repository
 * regardless of `cwd`. `GH_HOST` is left alone: it selects which host's
 * credentials to use, never which repository, so it carries none of this
 * hazard.
 *
 * Windows environment-variable names are case-insensitive (`gitIdentityEnv()`
 * above documents the same trap), so an exact-match delete leaves an inherited
 * `Gh_Repo` in place there, still honored by `gh`.
 */
export function ghRepoEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "gh_repo") delete env[key];
    }
  } else {
    delete env.GH_REPO;
  }
  return env;
}

/**
 * `ghRepoEnv()` with `GH_REPO` naming `repository` (`owner/name`), for a `gh`
 * call about that repository made outside its checkout: whatever picks the
 * account `gh` runs as (a wrapper that routes by the repository's owner, the
 * governed quota's owner) then sees which repository the call is about.
 * `null` names none, and is `ghRepoEnv()`.
 */
export function ghRepoEnvFor(
  repository: string | null,
): Record<string, string | undefined> {
  const env = ghRepoEnv();
  if (repository !== null) env.GH_REPO = repository;
  return env;
}
