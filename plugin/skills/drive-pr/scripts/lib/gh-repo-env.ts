import { ghRepoEnv } from "./proc.ts";

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
