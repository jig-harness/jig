/**
 * The AI reviewers Jig knows by their GitHub App slug. Profiles are shared
 * because configuration readers must remain runnable without drive-pr.
 */
export const REVIEWER_EVIDENCE = ["sticky", "review_object"] as const;
export type ReviewerEvidence = (typeof REVIEWER_EVIDENCE)[number];

/** The review-body formats Jig reads findings from. */
export type ReviewBodyFormat = "coderabbit";

/** What Jig knows of one reviewer. */
export interface ReviewerProfile {
  botLogin: string;
  checkPattern: string;
  evidence: ReviewerEvidence;
  skipsDrafts: boolean;
  bodyFormat?: ReviewBodyFormat;
}

/** Built-in reviewer profiles. */
const REVIEWER_PROFILES: Readonly<Record<string, ReviewerProfile>> = {
  coderabbitai: {
    botLogin: "coderabbitai[bot]",
    checkPattern: "^CodeRabbit$",
    evidence: "review_object",
    skipsDrafts: true,
    bodyFormat: "coderabbit",
  },
};

/** The built-in profile of the app `app`, if Jig knows it. */
export function reviewerProfile(app: string): ReviewerProfile | undefined {
  return Object.hasOwn(REVIEWER_PROFILES, app)
    ? REVIEWER_PROFILES[app]
    : undefined;
}

/** The forge login that supplies an app's review evidence. */
export function reviewerBotLogin(app: string): string {
  return reviewerProfile(app)?.botLogin ?? `${app}[bot]`;
}

/** Why the reviewer evidence configuration cannot be read, or `null`. */
export function evidenceProblem(
  app: string,
  evidence: ReviewerEvidence,
): string | null {
  if (evidence === "review_object" && app === "")
    return "review.reviewer_evidence is review_object, which reads the pull-request reviews of the reviewer app's bot account, but no review.reviewer_app names that app";
  if (
    evidence === "sticky" &&
    reviewerProfile(app)?.evidence === "review_object"
  )
    return `review.reviewer_evidence is sticky, but '${app}' submits pull-request reviews and never writes a summary comment with a reviewed-SHA stamp: remove review.reviewer_evidence, or set it to review_object`;
  return null;
}

export type RunTitleSays = "paused" | "draft-skip" | "skipped" | null;

/** What a review-object check-run title says it did. */
export function runTitleSays(title: string): RunTitleSays {
  const t = title.trim();
  if (/^review paused\b/i.test(t)) return "paused";
  if (/^review skipped:\s*draft\b/i.test(t)) return "draft-skip";
  if (/^review skipped\b/i.test(t)) return "skipped";
  return null;
}

/** Whether CodeRabbit's comment-only draft skip template is present. */
export function commentSaysDraftSkip(app: string, body: string): boolean {
  if (app !== "coderabbitai") return false;
  const lines = body
    .split(/\r?\n/u)
    .filter((line) => !/^\s*<!--(?:(?!-->).)*-->\s*$/u.test(line));
  if (lines.some((line) => /(?:^ {0,3}~{3,}|`|<[!/?a-z])/iu.test(line)))
    return false;
  return lines.some((line) =>
    /^ {0,3}(?:#{1,6}\s+Draft PR not reviewed(?:\s+#+)?|\*\*Draft PR not reviewed\*\*)\s*$/u.test(
      line,
    ),
  );
}
