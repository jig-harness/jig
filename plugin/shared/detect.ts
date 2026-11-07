/**
 * The detector: the configuration values a repository already implies, read
 * from the repository itself, so a skill derives them rather than asking.
 * The audit's configuration fit offers them as suggestions and judges the
 * configuration against them; setting a repository up writes them.
 *
 * Each value comes back as a fact, `{ field, value, evidence }` ({@link Fact}):
 * the dotted `.config/jig.yaml` field, the value, and the observations it was
 * read from, each naming the file or the command it comes from. What is
 * detected, and from where:
 *
 *   - `gates.command`: a gate script CI runs, else a package script (run
 *     with the package manager the lockfile names), else a make target, else
 *     a gate script CI does not run ({@link gateCommand});
 *   - `review.bots`: the review bots among the recent merged pull requests'
 *     reviewers and commenters ({@link reviewBots});
 *   - `review.repo_slug`: the repository the forge names ({@link repoSlug});
 *   - `pull_requests.stacking`: open pull requests based on another open
 *     pull request's branch ({@link stackedPulls}, {@link stacking});
 *   - `issue_tracker.team`: the issue-key prefix the merged pull requests'
 *     titles and branches, the commit subjects and the remote branch names
 *     carry most ({@link issueKeySources}, {@link issueKeyTeam});
 *   - `drive.change_areas_catalog`: a tracked file named like a change-area
 *     catalog ({@link changeAreasCatalog});
 *   - `repository.base_branch`: the integration branch the clone's
 *     origin/HEAD names ({@link originHead}); the forge's default branch is
 *     in {@link forgeRepo}'s answer;
 *   - the package manager, from the lockfile ({@link detectPackageManager}).
 *
 * {@link draftConfig} turns facts into a starter configuration, each value
 * under its evidence as comments. The readers the detection rests on (CI's
 * jobs and their command lines, the forge's pull requests) are exported too,
 * for the skills that judge a configuration against the same readings.
 *
 * Read-only: it reads tracked files and runs `git` and read-only `gh` calls.
 * It holds no state of the skill calling it: the caller passes the
 * repository's root and its tracked files, and decides what a fact means
 * for a configuration that already sets the field.
 */
import { run } from "./detect/read.ts";
import type { Fact } from "./detect/fact.ts";

export { type CiJob, ciJobs } from "./detect/ci-jobs.ts";
export {
  ASSIGNMENT,
  commandSegments,
  commandWords,
  scan,
  withoutAssignments,
} from "./detect/command-line.ts";
export { draftConfig } from "./detect/draft.ts";
export type { Fact } from "./detect/fact.ts";
export {
  type ForgeRepo,
  forgeRepo,
  mergedPulls,
  normalLogin,
  OPEN_PULL_LIMIT,
  type OpenPull,
  openPulls,
  type Pull,
  repoSlug,
  reviewBots,
  reviewerCounts,
  stackedPulls,
  stacking,
} from "./detect/forge.ts";
export { gateCommand, makefileOf } from "./detect/gate.ts";
export {
  issueKeySources,
  issueKeyTeam,
  type KeySource,
} from "./detect/issue-keys.ts";
export { detectPackageManager } from "./detect/package-manager.ts";
export {
  ghJson,
  packageScripts,
  run,
  texts,
} from "./detect/read.ts";

/** `drive.change_areas_catalog`: a tracked file named like a change-area catalog. */
export function changeAreasCatalog(
  files: string[],
): (Fact & { value: string }) | null {
  const catalog = files.find(
    (f) =>
      /(^|\/)change[-_]?areas?\.ya?ml$/i.test(f) &&
      !/(^|\/)(fixtures?|templates?)\//.test(f),
  );
  if (catalog === undefined) return null;
  return {
    field: "drive.change_areas_catalog",
    value: catalog,
    evidence: [`${catalog} is tracked and named like a change-area catalog`],
  };
}

/**
 * `repository.base_branch` as the clone's origin/HEAD names it, or null
 * when the clone has none.
 */
export function originHead(root: string): (Fact & { value: string }) | null {
  const head = run(
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    {
      cwd: root,
    },
  );
  const name = head.stdout.trim();
  if (head.code !== 0 || !name.startsWith("origin/")) return null;
  return {
    field: "repository.base_branch",
    value: name.slice("origin/".length),
    evidence: [`this clone's origin/HEAD names ${name}`],
  };
}
