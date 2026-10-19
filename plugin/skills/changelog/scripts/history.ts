// What the repository's own history says about a note, for the formats that
// credit a change: the pull request (or commit) that brought it to the
// integration branch and the people who wrote it. Git alone answers; the
// hosting service is never asked.
import type { Credit } from "./common-changelog.ts";
import { landings, tryGit } from "./notes-dir.ts";
import { type HostLinks, hostLinks } from "./remote.ts";

/** The links the `origin` remote's host gives the repository; null without one Jig knows. */
export function originLinks(root: string): HostLinks | null {
  const address = tryGit(root, ["remote", "get-url", "origin"])?.trim();
  return address ? hostLinks(address) : null;
}

/** Whether a commit author is an automated account: the name ends in `[bot]`. */
export const isBot = (name: string): boolean => /\[bot\]$/i.test(name.trim());

/**
 * The pull request a commit subject names: `Title (#12)` from a squash
 * merge, `Merge pull request #12 from …` from a merge commit.
 */
export function pullRequestOf(subject: string): number | null {
  const found =
    /\(#(\d+)\)\s*$/.exec(subject)?.[1] ??
    /^Merge pull request #(\d+) from /.exec(subject)?.[1];
  return found === undefined ? null : Number(found);
}

/**
 * The authors of the commits in `range` that touched `path`, oldest first and
 * each once, bots included; mailmap names are used.
 */
export function authorsIn(root: string, range: string, path: string): string[] {
  const out = tryGit(root, [
    "log",
    "--no-merges",
    "--reverse",
    "--format=%aN",
    range,
    "--",
    path,
  ]);
  return [...new Set((out ?? "").split("\n").filter(Boolean))];
}

/**
 * What the history says about the note at `path`: the reference to the change
 * and the people who wrote it. A note that is not committed yet has neither.
 */
export function creditOf(
  root: string,
  path: string,
): Credit & { committed: boolean; bots: boolean } {
  const landing = landings(root, [path]).get(path) ?? null;
  // Every commit that touched the file since it was last added: those of the
  // merged branch and any that changed the note afterwards.
  const hasParent =
    landing !== null &&
    tryGit(root, ["rev-parse", "--verify", "-q", `${landing}^`]) !== null;
  const names = authorsIn(root, hasParent ? `${landing}^..HEAD` : "HEAD", path);
  const people = names.filter((name) => !isBot(name));
  if (landing === null)
    return { reference: null, authors: people, committed: false, bots: false };
  const subject =
    tryGit(root, ["log", "-1", "--format=%s", landing])?.trim() ?? "";
  const pullRequest = pullRequestOf(subject);
  const commit =
    tryGit(root, ["rev-parse", "--short=7", landing])?.trim() ??
    landing.slice(0, 7);
  return {
    reference: pullRequest === null ? { commit } : { pullRequest },
    authors: people,
    committed: true,
    bots: names.length > people.length,
  };
}
