/**
 * The tracker team a repository's history names (`issue_tracker.team`): the
 * prefix of the issue keys in its merged pull requests' titles and branches,
 * the commit subjects of its integration branch and its remote branch names.
 */
import type { Fact } from "./fact.ts";
import type { Pull } from "./forge.ts";
import { run } from "./read.ts";

/** Where issue keys were read, and the key each entry carries, if any. */
export interface KeySource {
  /** How the evidence names the source, as in "of the last 20 merged pull requests". */
  label: string;
  /** One entry per pull request, commit or branch: its issue key's team, or undefined. */
  keys: (string | undefined)[];
}

/** The team of an issue key in a title or commit subject (`ENG-12`), if any. */
function keyInText(text: string): string | undefined {
  return /\b([A-Z][A-Z0-9]+)-\d+\b/.exec(text)?.[1];
}

/**
 * The team of an issue key a branch name starts with, after an optional
 * prefix (`eng-12-fix`, `feature/ENG-12`). Dependency-update branches carry
 * version numbers, not keys.
 */
function keyInBranch(branch: string): string | undefined {
  if (/^(dependabot|renovate)\//i.test(branch)) return undefined;
  return /^(?:[A-Za-z]+\/)?([A-Za-z][A-Za-z0-9]+)-\d+(?:[-_/]|$)/
    .exec(branch)?.[1]
    ?.toUpperCase();
}

/** How many commit subjects and branch names the tracker-team count reads. */
const KEY_HISTORY_LIMIT = 200;

/** The nonempty lines of a command's output. */
function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Where issue keys can be read: the recent merged pull requests (title, else
 * head branch), the commit subjects of the integration branch `branch` (or
 * HEAD when the clone lacks it, or the branch is unknown) and the clone's
 * remote branch names.
 */
export function issueKeySources(
  root: string,
  branch: string | undefined,
  pulls: Pull[] | null,
): KeySource[] {
  const sources: KeySource[] = [];
  if (pulls !== null && pulls.length > 0)
    sources.push({
      label: `the last ${pulls.length} merged pull requests`,
      keys: pulls.map((p) => keyInText(p.title) ?? keyInBranch(p.headRefName)),
    });
  const ref =
    branch !== undefined &&
    run(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      {
        cwd: root,
      },
    ).code === 0
      ? `origin/${branch}`
      : "HEAD";
  const log = run(
    "git",
    ["log", "-n", String(KEY_HISTORY_LIMIT), "--format=%s", ref, "--"],
    { cwd: root },
  );
  const subjects = log.code === 0 ? lines(log.stdout) : [];
  if (subjects.length > 0)
    sources.push({
      label: `the last ${subjects.length} commit subjects on ${ref}`,
      keys: subjects.map(keyInText),
    });
  const refs = run(
    "git",
    [
      "for-each-ref",
      `--count=${KEY_HISTORY_LIMIT}`,
      "--sort=-committerdate",
      "--format=%(refname:lstrip=3)",
      "refs/remotes/origin/",
    ],
    { cwd: root },
  );
  const branches = (refs.code === 0 ? lines(refs.stdout) : []).filter(
    (b) => b !== "HEAD" && b !== branch,
  );
  if (branches.length > 0)
    sources.push({
      label: `the ${branches.length} most recent branches on origin`,
      keys: branches.map(keyInBranch),
    });
  return sources;
}

/**
 * The team whose issue keys the sources carry most, counted per source, or
 * null. A team is found when it has at least 3 keys and more than half of
 * all keys found, and the evidence states its count in each source that has
 * it, and how many keys name other teams, so a person can weigh it.
 */
export function issueKeyTeam(
  sources: KeySource[],
): (Fact & { value: string }) | null {
  const totals = new Map<string, number>();
  for (const source of sources)
    for (const key of source.keys)
      if (key !== undefined) totals.set(key, (totals.get(key) ?? 0) + 1);
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  const [team, count] = [...totals].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!team || !count || count < 3 || count * 2 <= all) return null;
  const counts = sources
    .map((s) => [s.keys.filter((k) => k === team).length, s.label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} of ${label}`);
  const others = all - count;
  return {
    field: "issue_tracker.team",
    value: team,
    evidence: [
      `${team}-<n> issue keys in ${counts.join(", ")}${
        others > 0 ? ` (${others} key(s) of other teams)` : ""
      }`,
    ],
  };
}
