/**
 * Values the forge's answers already prove, as starter-configuration
 * suggestions: each is offered only when the repository's file leaves the
 * field unset, and each carries the answer it came from.
 */
import { at } from "./schema.ts";
import type { Suggestion } from "./draft.ts";

/**
 * With `review.repo_slug` unset, the repository the forge names. The field has
 * no default: without it, filing a deferred finding needs `--repo-slug`.
 */
export function repoSlugSuggestion(
  config: Record<string, unknown>,
  slug: string,
): Suggestion[] {
  if (at(config, "review.repo_slug") !== undefined) return [];
  const evidence = `the forge names this repository ${slug}`;
  return [
    {
      field: "review.repo_slug",
      value: slug,
      evidence,
      message: `${evidence}: set review.repo_slug: ${slug} so resolve-review-comments files deferred findings against it without --repo-slug`,
    },
  ];
}

/** An open pull request's number, the branch it targets and its own branch. */
export interface OpenPull {
  number: number;
  baseRefName: string;
  headRefName: string;
}

/**
 * With `pull_requests.stacking` unset, `branch`: open pull requests based on
 * another open pull request's branch are base-branch chaining, which is what
 * `branch` declares. A pull request into a release or backport branch is not:
 * no open pull request has that branch as its own. Whether they also form a GitHub stack, which
 * `native` declares, the open pull requests do not show, so the evidence says
 * so. The value answers the finding that reports the unset field, and keeps
 * its id and message.
 */
export function stackingSuggestion(
  base: string,
  stacked: OpenPull[],
  finding: { id: string; message: string },
): Suggestion {
  const examples = stacked
    .slice(0, 5)
    .map((p) => `#${p.number} → ${p.baseRefName}`)
    .join(", ");
  return {
    field: "pull_requests.stacking",
    value: "branch",
    evidence: `${stacked.length} open pull request(s) are based on another open pull request's branch, not ${base} (${examples}): base-branch chaining; native instead if they are linked as a GitHub stack`,
    message: finding.message,
    id: finding.id,
  };
}

/** Where issue keys were read, and the key each entry carries, if any. */
export interface KeySource {
  /** How the evidence names the source, as in "of the last 20 merged pull requests". */
  label: string;
  /** One entry per pull request, commit or branch: its issue key's team, or undefined. */
  keys: (string | undefined)[];
}

/** The team of an issue key in a title or commit subject (`ENG-12`), if any. */
export function keyInText(text: string): string | undefined {
  return /\b([A-Z][A-Z0-9]+)-\d+\b/.exec(text)?.[1];
}

/**
 * The team of an issue key a branch name starts with, after an optional
 * prefix (`eng-12-fix`, `feature/ENG-12`). Dependency-update branches carry
 * version numbers, not keys.
 */
export function keyInBranch(branch: string): string | undefined {
  if (/^(dependabot|renovate)\//i.test(branch)) return undefined;
  return /^(?:[A-Za-z]+\/)?([A-Za-z][A-Za-z0-9]+)-\d+(?:[-_/]|$)/
    .exec(branch)?.[1]
    ?.toUpperCase();
}

/**
 * With `issue_tracker.team` unset, the team whose issue keys the repository's
 * history carries most: merged pull requests, commit subjects on the
 * integration branch and branch names, counted per source. None for a
 * GitHub tracker, whose keys are issue numbers with no team; with the adapter
 * unset the tracker is GitHub, so the suggestion names the adapter too. A team is offered
 * when it has at least 3 keys and more than half of all keys found, and the
 * evidence states its count in each source that has it, and how many keys
 * name other teams, so a person can weigh it.
 */
export function trackerTeamSuggestion(
  config: Record<string, unknown>,
  sources: KeySource[],
): Suggestion[] {
  if (at(config, "issue_tracker.team") !== undefined) return [];
  if (at(config, "issue_tracker.adapter") === "github") return [];
  const totals = new Map<string, number>();
  for (const source of sources)
    for (const key of source.keys)
      if (key !== undefined) totals.set(key, (totals.get(key) ?? 0) + 1);
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  const [team, count] = [...totals].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!team || !count || count < 3 || count * 2 <= all) return [];
  const counts = sources
    .map((s) => [s.keys.filter((k) => k === team).length, s.label] as const)
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} of ${label}`);
  const others = all - count;
  const evidence = `${team}-<n> issue keys in ${counts.join(", ")}${
    others > 0 ? ` (${others} key(s) of other teams)` : ""
  }`;
  // An empty `adapter:` (null) is no adapter: the default, which refuses a team.
  const adapter: Suggestion[] =
    at(config, "issue_tracker.adapter") == null
      ? [
          {
            field: "issue_tracker.adapter",
            value: "linear",
            evidence,
            message: `${evidence}: set issue_tracker.adapter: linear, since the default adapter is github and a team is Linear's`,
          },
        ]
      : [];
  return [
    ...adapter,
    {
      field: "issue_tracker.team",
      value: team,
      evidence,
      message: `${evidence}: set issue_tracker.team: ${team} so the skills recognise them, once you have confirmed it is the tracker's team`,
    },
  ];
}
