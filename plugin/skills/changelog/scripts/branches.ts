// Which branch is which: the integration branch (where releases are made) and
// the base a branch is checked against. The check's base comes from a source
// the branch cannot change, never from the branch's own configuration.
import { existsSync, readFileSync } from "node:fs";
import { swallow } from "../../../shared/errors.ts";
import { isMapping, valueAt } from "../../../shared/config-layers.ts";
import { layeredConfig } from "../../../shared/consumer.ts";
import { type Hosting, hostingFor } from "./hosting.ts";
import { tryGit } from "./notes-dir.ts";

type Env = Record<string, string | undefined>;

/** The event that started a CI job, when this is one and its payload can be read. */
function event(env: Env): Record<string, unknown> | null {
  const path = env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return null;
  try {
    const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(payload) ? payload : null;
  } catch (error) {
    swallow(error, "the CI event payload is not readable JSON");
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The branch a pull-request event started from merges into; null outside one. */
function eventBase(env: Env): string | null {
  const pullRequest = event(env)?.pull_request;
  const base = isMapping(pullRequest) ? pullRequest.base : undefined;
  return (isMapping(base) ? text(base.ref) : null) ?? text(env.GITHUB_BASE_REF);
}

/** The repository's default branch as the event that started the job names it. */
function eventDefault(env: Env): string | null {
  const repository = event(env)?.repository;
  return isMapping(repository) ? text(repository.default_branch) : null;
}

/** The hosting service's default branch: `origin/HEAD` of the clone, then the service. */
export function defaultBranch(
  root: string,
  hosting: Hosting | null = hostingFor(root),
): string | null {
  const head = tryGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])?.trim();
  if (head?.startsWith("origin/")) return head.slice("origin/".length);
  return hosting?.defaultBranch() ?? null;
}

/** The revision for branch `name`: its remote-tracking branch when the clone has one. */
export function remoteRef(root: string, name: string): string {
  const exists = (ref: string) =>
    tryGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;
  if (exists(`origin/${name}`)) return `origin/${name}`;
  return exists(name) ? name : `origin/${name}`;
}

/**
 * The integration branch, where releases are made and read: the repository's
 * `repository.base_branch`, else the default branch of the hosting service
 * (in CI from the event that started the job; elsewhere from `origin/HEAD`,
 * then the service).
 */
export function integrationBranch(
  root: string,
  env: Env = process.env,
  hosting: Hosting | null = hostingFor(root),
): string | null {
  const configured = valueAt(
    layeredConfig(root, env).values,
    "repository.base_branch",
  );
  if (typeof configured === "string" && configured) return configured;
  return eventDefault(env) ?? defaultBranch(root, hosting);
}

/**
 * The revision a branch is compared with, from a source the branch cannot
 * change: `explicit` (`--base`), else the base of the pull request that
 * started the CI job, else the default branch the event names (a push), else
 * the hosting service's default branch. It is never
 * `repository.base_branch`, which the branch's own tree could point at a
 * weaker revision. Null when none answers.
 */
export function checkBase(
  root: string,
  explicit: string | null,
  env: Env = process.env,
  hosting: Hosting | null = hostingFor(root),
): string | null {
  if (explicit) return explicit;
  const name =
    eventBase(env) ?? eventDefault(env) ?? defaultBranch(root, hosting);
  return name === null ? null : remoteRef(root, name);
}
