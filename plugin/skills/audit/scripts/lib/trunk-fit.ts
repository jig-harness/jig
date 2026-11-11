/**
 * What the integration branch's history shows about the configuration: how
 * far the checkout is behind it, and whether its recent subjects follow
 * `pull_requests.title_pattern`. Both read the clone's own refs as of its
 * last fetch; the audit never fetches.
 */
import { run } from "../../../../shared/detect.ts";
import { swallow } from "../../../../shared/errors.ts";
import {
  type KeyForm,
  keyIsAmbiguous,
  TITLE_SHARE,
  titlePatternShare,
  validateTitlePattern,
} from "../../../../shared/title-pattern.ts";
import { at, type Finding } from "./schema.ts";

/** How many recent subjects the title pattern is judged from. */
const TITLE_HISTORY = 30;

/**
 * How many commits of the integration branch HEAD lacks, from the clone's
 * own refs as of its last fetch (the audit never fetches). An audit of a
 * checkout behind it describes a commit the team has moved past.
 */
export function behindIntegrationBranch(
  root: string,
  report: { facts: Record<string, string> },
): Finding[] {
  const branch = report.facts.integration_branch;
  if (branch === undefined) return [];
  if (run("git", ["remote", "get-url", "origin"], { cwd: root }).code !== 0)
    return [];
  const ref = `refs/remotes/origin/${branch}`;
  const known =
    run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root })
      .code === 0;
  if (!known)
    return report.facts.integration_branch_source === "repository.base_branch"
      ? []
      : [
          {
            id: "unchecked:behind-integration-branch",
            severity: "info",
            message: `this clone has no origin/${branch} (fetch it), so whether HEAD lacks its commits is unchecked`,
          },
        ];
  const count = run("git", ["rev-list", "--count", `HEAD..${ref}`], {
    cwd: root,
  });
  const behind = Number(count.stdout.trim());
  if (count.code !== 0 || !Number.isInteger(behind)) return [];
  report.facts.behind_integration_branch = `${behind} commit(s) of origin/${branch} not in HEAD, as of the last fetch`;
  if (behind === 0) return [];
  return [
    {
      id: "fact:behind-integration-branch",
      severity: "warning",
      message: `HEAD lacks ${behind} commit(s) of origin/${branch} (as of the last fetch): the audit would describe a stale commit. Fetch, then check out or rebase onto origin/${branch} before scoring`,
    },
  ];
}

/**
 * `pull_requests.title_format: pattern` against the integration branch's
 * last thirty non-merge subjects. With squash merges a pull request's title
 * is the subject, so a pattern most recent subjects do not follow is a
 * declaration the history contradicts (or a convention not yet adopted).
 */
export function titlePatternFindings(
  config: Record<string, unknown>,
  root: string,
  branch: string | undefined,
): Finding[] {
  const pattern = at(config, "pull_requests.title_pattern");
  if (
    at(config, "pull_requests.title_format") !== "pattern" ||
    typeof pattern !== "string"
  )
    return [];
  try {
    validateTitlePattern(pattern);
  } catch (e) {
    // the skills' own validation reports a refused pattern
    swallow(e, "pull_requests.title_pattern is refused; not judged");
    return [];
  }
  // GitHub Issues is the adapter when none is named.
  const form: KeyForm =
    (at(config, "issue_tracker.adapter") ?? "github") === "github"
      ? "hash"
      : "prefixed";
  if (keyIsAmbiguous(pattern, form))
    return [
      {
        id: "unchecked:title-pattern",
        severity: "info",
        message: `pull_requests.title_pattern ${JSON.stringify(pattern)} ends with the key in parentheses, which a squash merge's (#n) suffix looks like on GitHub Issues: whether recent subjects follow it is unchecked`,
      },
    ];
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
      : null;
  if (ref === null)
    return [
      {
        id: "unchecked:title-pattern",
        severity: "info",
        message: `the integration branch's history is unavailable, so whether recent subjects follow pull_requests.title_pattern ${JSON.stringify(pattern)} is unchecked`,
      },
    ];
  const log = run(
    "git",
    [
      "log",
      "--no-merges",
      "--format=%s",
      "-n",
      String(TITLE_HISTORY),
      ref,
      "--",
    ],
    { cwd: root },
  );
  const share =
    log.code === 0
      ? titlePatternShare(pattern, log.stdout.split("\n"), form)
      : null;
  if (share === null)
    return [
      {
        id: "unchecked:title-pattern",
        severity: "info",
        message: `${ref} has too few commit subjects to judge pull_requests.title_pattern ${JSON.stringify(pattern)} from`,
      },
    ];
  if (share.matching / share.total >= TITLE_SHARE) return [];
  return [
    {
      id: "contradiction:pull_requests.title_pattern",
      severity: "warning",
      message: `${share.matching} of the last ${share.total} commit subjects on ${ref} follow pull_requests.title_pattern ${JSON.stringify(pattern)}: with squash merges the pull request title is the subject, so either the history predates the pattern or the pattern is not the repository's convention`,
    },
  ];
}
