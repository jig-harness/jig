/**
 * The AI reviewers Jig knows by their GitHub App slug, so a repository names
 * one with `review.reviewer_app` alone: the name of the reviewer's check run
 * and where it records the commit it reviewed. Each value was measured on the
 * reviewer's own output; a repository's explicit fields override any of them.
 *
 * Two kinds of reviewer evidence (`review.reviewer_evidence`):
 *
 * - `sticky`: the reviewer edits one summary comment carrying
 *   `review.sticky_marker` and stamps the commit it reviewed in it with
 *   `review.reviewed_sha_marker`. The default, and the protocol Jig documents
 *   for a reviewer a repository builds.
 * - `review_object`: the reviewer submits the forge's own pull-request
 *   reviews, each recording the commit it was submitted against, and posts
 *   nothing when a commit gives it nothing new to say. Its check run on the
 *   head says whether it reviewed, paused or skipped.
 */

/** How the AI reviewer records the commit it reviewed. */
export const REVIEWER_EVIDENCE = ["sticky", "review_object"] as const;
export type ReviewerEvidence = (typeof REVIEWER_EVIDENCE)[number];

/**
 * The review-body formats Jig reads findings from (`review-body.ts`): the
 * findings a review-object reviewer puts in its review's body and in no
 * thread.
 */
export type ReviewBodyFormat = "coderabbit";

/** What Jig knows of one reviewer. */
export interface ReviewerProfile {
  /** Its check run's name, as an anchored pattern. */
  checkPattern: string;
  evidence: ReviewerEvidence;
  /** Whether it skips draft pull requests by default. */
  skipsDrafts: boolean;
  /** The format of its review bodies' findings; none, its bodies are not read. */
  bodyFormat?: ReviewBodyFormat;
}

/**
 * The built-in profiles. CodeRabbit (`coderabbitai`, posting as
 * `coderabbitai[bot]`): one check run named `CodeRabbit` per head, reviews
 * as pull-request review objects, draft pull requests skipped unless its
 * own configuration says otherwise, and its outside-diff, nitpick, duplicate
 * and follow-up comments in its reviews' bodies.
 */
export const REVIEWER_PROFILES: Readonly<Record<string, ReviewerProfile>> = {
  coderabbitai: {
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

/**
 * Why a drive could not read the evidence of the reviewer app `app` (`""`
 * for none) with `evidence`, so that it would wait for it until its timeout;
 * `null` when it can. Shared by the drive's arm and the audit.
 */
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

/**
 * What a review-object reviewer's check-run title says it did instead of
 * reviewing, read from the title's opening words (CodeRabbit's
 * `Review paused…`, `Review skipped: draft pull request`, `Review skipped:
 * <reason>`); `null` for any other title.
 */
export type RunTitleSays = "paused" | "draft-skip" | "skipped" | null;

export function runTitleSays(title: string): RunTitleSays {
  const t = title.trim();
  if (/^review paused\b/i.test(t)) return "paused";
  if (/^review skipped:\s*draft\b/i.test(t)) return "draft-skip";
  if (/^review skipped\b/i.test(t)) return "skipped";
  return null;
}

/** CodeRabbit's comment-only draft skip, recognized from its current body. */
export function commentSaysDraftSkip(app: string, body: string): boolean {
  const draftNotice =
    /^\s*(?:>\s*)?(?:#{1,6}\s+)?(?:\*\*)?Draft PR not reviewed(?:\*\*)?\s*$/im.test(
      body,
    );
  return (
    app === "coderabbitai" &&
    // The generated marker labels CodeRabbit's generic skip template too.
    // Its presence alone therefore cannot prove this was a draft skip.
    draftNotice
  );
}
