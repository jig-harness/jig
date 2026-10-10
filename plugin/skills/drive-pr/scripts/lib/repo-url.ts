#!/usr/bin/env bun
/**
 * `owner/name` out of any of git's URL forms — scp-like
 * (`git@host:owner/repo.git`), https, ssh://, with or without a `.git`
 * suffix, embedded credentials or a port.
 *
 * The HOST is deliberately NOT compared. It cannot be: `git@github-docomply:…`
 * is a perfectly ordinary `~/.ssh/config` alias for github.com, and this
 * repository's own developer clones use one — comparing hosts would refuse
 * every real push on those machines while catching only the exotic case of an
 * identical `owner/name` existing on a second forge. Owner and name are what
 * distinguish a fork, a mis-pointed `origin` and a `gh`/git disagreement,
 * which are the reachable failures.
 *
 * Shared by `guarded-push.ts` (is `origin` the PR's head repository?) and
 * `lib/base-drift.ts` (is `origin` the PR's base repository?) — the same
 * owner/name extraction, the same reachable failures, on opposite sides of
 * one PR.
 *
 * Runs under Bun and under Node >= 22.18: only `node:` APIs, no `Bun.*`
 * globals, erasable-syntax-only TypeScript, explicit `.ts` import specifiers.
 */
export function repoOfUrl(url: string): string {
  const stripped = url
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/^[^/@]*@/, "")
    .replace(/:[0-9]+\//, "/")
    .replace(":", "/");
  const parts = stripped.split("/");
  if (parts.length < 2) return "";
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
