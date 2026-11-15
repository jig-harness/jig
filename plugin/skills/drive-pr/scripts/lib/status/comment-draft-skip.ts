/** Draft skips a reviewer records in its issue comment instead of a check. */
import { isRecord } from "../../../../../shared/guards.ts";
import { attempt } from "../../../../../shared/outcome.ts";
import {
  reviewerApp,
  reviewerEvidence,
  reviewerLabel,
  reviewsDrafts,
} from "../overlay.ts";
import { ghCall } from "../proc.ts";
import { commentSaysDraftSkip } from "../reviewer-profiles.ts";

/**
 * Read current bodies, never a remembered comment id: the reviewer may edit
 * its skip into its summary. Only the configured app's bot can attest a skip.
 * `null` means unreadable; false means no visible skip. A check run, when
 * present, takes precedence over this fallback in both callers.
 */
export async function commentDraftSkip(
  owner: string,
  repo: string,
  pr: string,
  app: string,
): Promise<boolean | null> {
  // No other profile defines a comment skip, so no extra read is needed.
  if (app !== "coderabbitai") return false;
  const r = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`,
  ]);
  if (r.code !== 0) return null;
  const decoded = attempt("unreadable", "issue comments JSON", (): unknown =>
    JSON.parse(r.stdout),
  );
  const pages = decoded.ok ? decoded.value : null;
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) return null;
  let skipped = false;
  for (const raw of pages.flat() as unknown[]) {
    if (!isRecord(raw)) return null;
    if (!isRecord(raw.user)) return null;
    if (raw.user.login !== `${app}[bot]`) continue;
    if (typeof raw.body !== "string") return null;
    skipped ||= commentSaysDraftSkip(app, raw.body);
  }
  return skipped;
}

/** Judge an absent review check without treating a draft skip as a review. */
export async function missingReviewerVerdict(
  owner: string,
  repo: string,
  pr: string,
  head: string,
  isDraft: boolean,
): Promise<{
  state: "draft-skip" | "INDETERMINATE" | "AWAITING_REVIEWER";
  reason: string;
}> {
  const label = reviewerLabel();
  const skip =
    reviewerEvidence() === "review_object"
      ? await commentDraftSkip(owner, repo, pr, reviewerApp())
      : false;
  if (skip === null)
    return {
      state: "INDETERMINATE",
      reason: `cannot read ${label}'s draft-skip comments on #${pr}`,
    };
  if (skip && isDraft)
    return { state: "draft-skip", reason: `${label} skips drafts` };
  return {
    state: "AWAITING_REVIEWER",
    reason: skip
      ? `${label}'s draft skip comment predates the Ready mark — waiting for it to review the Ready pull request`
      : missingReviewerReason(pr, head, isDraft, label),
  };
}

/** Explain an absent check without assuming every deployment skips drafts. */
function missingReviewerReason(
  pr: string,
  head: string,
  isDraft: boolean,
  label: string,
): string {
  let reason = `no check-run from ${label} on ${head} yet — other checks settling is not evidence it reviewed`;
  if (isDraft) {
    const drafts = reviewsDrafts();
    reason +=
      drafts === false
        ? `. NOTE: #${pr} is a draft, and this repository declares that ${label} does not review drafts (drive.reviews_drafts: false): mark it Ready for review, or this polls to --timeout`
        : drafts === true
          ? `. NOTE: #${pr} is a draft; this repository declares that ${label} reviews drafts (drive.reviews_drafts: true). If this polls to --timeout, check that the reviewer's draft setting is still on before assuming it is merely slow`
          : `. NOTE: #${pr} is a draft, and some reviewers skip drafts (drive.reviews_drafts is not set). If this polls to --timeout, check whether ${label} reviews drafts before assuming it is merely slow`;
  }
  return reason;
}
