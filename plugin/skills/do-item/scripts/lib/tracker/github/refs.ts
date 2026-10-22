/**
 * Issue references for the GitHub adapter: which repository's issues it
 * works on, and how a key names an issue.
 *
 * An issue of the configured repository is `#123`; an issue of another
 * repository (a sub-issue or a blocker may live elsewhere) is
 * `owner/name#123`. Both forms, a bare number and an issue's web address
 * are accepted wherever a key is.
 */

import { swallow } from "../../../../../../shared/errors.ts";
import { TrackerConfigError } from "../config-error.ts";
import { TrackerRequestError } from "../port.ts";

export interface Repo {
  owner: string;
  name: string;
}

export interface IssueRef extends Repo {
  number: number;
}

export const slug = (r: Repo) => `${r.owner}/${r.name}`;

const sameRepo = (a: Repo, b: Repo) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.name.toLowerCase() === b.name.toLowerCase();

/** `owner/name` as a repository. */
export function repoOf(nameWithOwner: string): Repo {
  const [owner, name, ...rest] = nameWithOwner.split("/");
  if (owner === undefined || name === undefined || rest.length > 0)
    throw new TrackerRequestError(
      "invalid",
      `not a repository name: ${nameWithOwner}`,
    );
  return { owner, name };
}

/** The key of an issue, seen from `home`. */
export function keyOf(ref: IssueRef, home: Repo): string {
  return sameRepo(ref, home) ? `#${ref.number}` : `${slug(ref)}#${ref.number}`;
}

const NUMBER = "([1-9]\\d*)";
const LOCAL = new RegExp(`^#?${NUMBER}$`);
const QUALIFIED = new RegExp(`^([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)#${NUMBER}$`);
const WEB = new RegExp(
  `^https://github\\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/issues/${NUMBER}(?:[/?#].*)?$`,
  "i",
);

/** The issue a key names, or `null` when it is not a key. */
export function parseRef(input: string, home: Repo): IssueRef | null {
  const s = input.trim();
  const local = LOCAL.exec(s);
  if (local !== null) return { ...home, number: Number(local[1]) };
  const m = QUALIFIED.exec(s) ?? WEB.exec(s);
  if (m === null) return null;
  return {
    owner: m[1] as string,
    name: m[2] as string,
    number: Number(m[3]),
  };
}

/** `parseRef`, refusing input that is not a key. */
export function requireRef(input: string, home: Repo): IssueRef {
  const ref = parseRef(input, home);
  if (ref === null)
    throw new TrackerRequestError(
      "invalid",
      `not a GitHub issue key: ${JSON.stringify(input)} (expected #123, owner/name#123 or the issue's web address)`,
    );
  return ref;
}

/**
 * The repository a remote address points to on github.com, or `null`:
 * `git@github.com:owner/name.git`, `ssh://git@github.com/owner/name`,
 * `https://github.com/owner/name.git`.
 */
export function repoFromRemote(url: string): Repo | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m === null ? null : { owner: m[1] as string, name: m[2] as string };
}

/**
 * The `origin` remote's address in the working directory, or `null` when
 * there is none (git exits 1) or git cannot run: either way the repository
 * is not derivable, and `homeRepo` names the field to set.
 */
export function originUrl(): string | null {
  try {
    const r = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch (err) {
    swallow(err, "git could not run, so the origin remote is unknown");
    return null;
  }
}

/**
 * The repository whose issues the adapter works on: the configured one,
 * else the one the `origin` remote points to. Throws naming the field when
 * neither is known.
 */
export function homeRepo(
  configured: string | null,
  origin: () => string | null = originUrl,
): Repo {
  if (configured !== null) return repoOf(configured);
  const url = origin();
  const derived = url === null ? null : repoFromRemote(url);
  if (derived === null)
    throw new TrackerConfigError(
      "issue_tracker.github.repository",
      `issue_tracker.github.repository is not set and the origin remote (${url ?? "none"}) is not a github.com repository; set it to owner/name`,
    );
  return derived;
}
