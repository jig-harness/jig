/**
 * Whether the AI reviewer a repository's configuration names fits it: the
 * reviewer's evidence is one drive-pr can read, and the reviewer shows on the
 * recent merged pull requests (or, with none named, a reviewer-looking check
 * that ran is one the drive will not wait for). Read by `config-fit.ts`.
 */
import { swallow } from "../../../../shared/errors.ts";
import { normalLogin, type Pull } from "../../../../shared/detect.ts";
import {
  evidenceProblem,
  REVIEWER_EVIDENCE,
  type ReviewerEvidence,
  reviewerProfile,
} from "../../../drive-pr/scripts/lib/reviewer-profiles.ts";
import { at, type Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/** A nonempty string field of `config`, if set. */
function value(config: Config, path: string): string | undefined {
  const v = at(config, path);
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * The evidence of the named reviewer that drive-pr cannot read, as the error
 * its `arm-drive.ts` refuses with: `review_object` with no app, or `sticky`
 * for an app known to submit pull-request reviews. A malformed
 * `review.reviewer_evidence` is the schema check's to report.
 */
export function reviewerEvidenceRule(config: Config): Finding[] {
  const app = value(config, "review.reviewer_app");
  if (
    app === undefined &&
    value(config, "review.reviewer_check_pattern") === undefined
  )
    return [];
  const set = value(config, "review.reviewer_evidence");
  if (
    set !== undefined &&
    !(REVIEWER_EVIDENCE as readonly string[]).includes(set)
  )
    return [];
  const evidence =
    (set as ReviewerEvidence | undefined) ??
    reviewerProfile(app ?? "")?.evidence ??
    "sticky";
  const problem = evidenceProblem(app ?? "", evidence);
  return problem === null
    ? []
    : [
        {
          id: "rule:review.reviewer_evidence",
          severity: "error",
          message: problem,
        },
      ];
}

/** drive-pr's default name for the AI reviewer's check run, used once a repository names a reviewer that is not a known app. */
const FORMER_REVIEWER_CHECK = /^ai[ _-]?review(\s*\(.+\))?$/i;
/** Check names that look like an AI reviewer's. */
const REVIEWER_LIKE =
  /(^|[^a-z])(ai|llm|claude|codex|gpt|copilot)[ _-]?(code[ _-]?)?review/i;

/** The checks that ran on a pull request: a skipped one did not. */
function ranChecks(pull: Pull): string[] {
  return (pull.statusCheckRollup ?? [])
    .filter((c) => c.conclusion?.toUpperCase() !== "SKIPPED")
    .map((c) => c.name ?? c.context ?? "")
    .filter((name) => name !== "");
}

/**
 * Whether the configured AI reviewer fits the recent merged pull requests:
 * with none named, a reviewer-looking check that ran is one the drive will
 * not wait for; a named one that posted on none of them is one the drive
 * waits for until its timeout.
 */
export function reviewerFindings(config: Config, pulls: Pull[]): Finding[] {
  const app = value(config, "review.reviewer_app");
  const pattern = value(config, "review.reviewer_check_pattern");
  if (app === undefined && pattern === undefined) return unnamedReviewer(pulls);
  let check: RegExp;
  try {
    const known = reviewerProfile(app ?? "")?.checkPattern;
    check =
      pattern !== undefined
        ? new RegExp(pattern, "i")
        : known !== undefined
          ? new RegExp(known, "i")
          : FORMER_REVIEWER_CHECK;
  } catch (error) {
    swallow(error, "the schema check reports a malformed reviewer pattern");
    return [];
  }
  const posted = pulls.filter(
    (p) =>
      ranChecks(p).some((name) => check.test(name)) ||
      (app !== undefined &&
        [...(p.reviews ?? []), ...(p.comments ?? [])].some(
          (r) => normalLogin(r.author?.login ?? "") === normalLogin(app),
        )),
  );
  if (posted.length > 0) return [];
  const fields = [
    ...(app === undefined ? [] : [`review.reviewer_app (${app})`]),
    ...(pattern === undefined
      ? []
      : [`review.reviewer_check_pattern (${pattern})`]),
  ];
  return [
    {
      id: "contradiction:review.reviewer",
      severity: "warning",
      message: `${fields.join(" and ")} name${fields.length === 1 ? "s" : ""} an AI reviewer, but none of the last ${pulls.length} merged pull requests shows it: no check matching ${check.source} ran${app === undefined ? "" : `, and ${app} neither reviewed nor commented`}. A drive waits for it until its timeout: correct the name, or remove the field${fields.length === 1 ? "" : "s"} if the repository has no AI reviewer`,
    },
  ];
}

/**
 * A reviewer-looking check that ran on recent pull requests while no reviewer
 * is named. It warns even when drive-pr's default check pattern matches the
 * check: the drive applies that default only once a reviewer is named, so
 * with neither field set it waits for no reviewer. The warning says whether
 * the default matches, which decides what naming the reviewer takes.
 */
function unnamedReviewer(pulls: Pull[]): Finding[] {
  const names = new Set<string>();
  let count = 0;
  for (const p of pulls) {
    const looking = ranChecks(p).filter(
      (name) => FORMER_REVIEWER_CHECK.test(name) || REVIEWER_LIKE.test(name),
    );
    for (const name of looking) names.add(name);
    if (looking.length > 0) count++;
  }
  if (count < 2) return [];
  const listed = [...names].slice(0, 3);
  const quote = (list: string[]) => list.map((n) => `"${n}"`).join(", ");
  const matching = listed.filter((n) => FORMER_REVIEWER_CHECK.test(n));
  const others = listed.filter((n) => !FORMER_REVIEWER_CHECK.test(n));
  const pattern = `the default review.reviewer_check_pattern (${FORMER_REVIEWER_CHECK.source}, matched case-insensitively)`;
  const naming =
    others.length === 0
      ? `${pattern} matches ${listed.length === 1 ? "it" : "them"}, so if a drive should wait for its findings, setting review.reviewer_app to the app that posts it is enough`
      : `${pattern} ${matching.length > 0 ? `matches ${quote(matching)} but ` : ""}does not match ${quote(others)}, so if a drive should wait for its findings, set review.reviewer_check_pattern to a pattern its check name matches, and review.reviewer_app to the app that posts it to count only that app's check`;
  return [
    {
      id: "contradiction:review.reviewer-unnamed",
      severity: "warning",
      message: `${quote(listed)} ran on ${count} of the last ${pulls.length} merged pull requests and looks like an AI reviewer's check, but neither review.reviewer_app nor review.reviewer_check_pattern names a reviewer, so drive-pr will not wait for it: it applies its default check pattern only once a reviewer is named. ${naming[0]?.toUpperCase()}${naming.slice(1)}`,
    },
  ];
}
