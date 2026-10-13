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
