/**
 * The review-object witness (`review.reviewer_evidence: review_object`): the
 * evidence of an AI reviewer that submits the forge's own pull-request
 * reviews instead of a summary comment with a reviewed-SHA stamp
 * (`reviewer-profiles.ts`; CodeRabbit's built-in profile). `evaluate.ts`
 * runs it where the reviewer gates apply and turns what it returns into a
 * state; `review-head.ts` asks it for the standalone review loop.
 *
 * Its two witnesses:
 *
 * - the reviewer's check run on the head (`reviewerRun`), whose title says
 *   when it paused or skipped instead of reviewing;
 * - the commit its newest pull-request review was submitted against
 *   (`commit_id`).
 *
 * A review object naming the head is a review of the head. A check run that
 * completed on the head with no review object naming it also is: such a
 * reviewer posts no review when a push gives it nothing new to say, so the
 * completed run is the only trace of that review. A review submitted after
 * that run completed, against another commit, makes the head's run stale.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { attempt } from "../../../../../shared/outcome.ts";
import { ghCall } from "../proc.ts";
import { runTitleSays } from "../reviewer-profiles.ts";
import type { CheckRun } from "./evidence.ts";
import { parseMs } from "../../../../../shared/time.ts";

/** One pull-request review: its id, the commit it reviewed, when, its body. */
export interface ReviewObject {
  id: number;
  commit: string;
  submittedAt: string;
  body: string;
}

/**
 * The newest review `login` submitted on PR `pr`: `{ review: null }` when it
 * submitted none, `null` when the reviews cannot be read or one of that
 * login's is malformed.
 */
export async function latestReviewBy(
  owner: string,
  repo: string,
  pr: string,
  login: string,
): Promise<{ review: ReviewObject | null } | null> {
  const reviews = await reviewsBy(owner, repo, pr, login);
  return reviews === null ? null : { review: reviews.at(-1) ?? null };
}

/**
 * Every review `login` submitted on PR `pr`, oldest first; `null` when the
 * reviews cannot be read or one of that login's is malformed. A pending
 * review is a draft only its author sees and is passed over.
 */
export async function reviewsBy(
  owner: string,
  repo: string,
  pr: string,
  login: string,
): Promise<ReviewObject[] | null> {
  const r = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`,
  ]);
  if (r.code !== 0) return null;
  const decoded = attempt("unreadable", "reviews JSON", (): unknown =>
    JSON.parse(r.stdout),
  );
  const pages = decoded.ok ? decoded.value : null;
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) return null;
  const reviews: ReviewObject[] = [];
  for (const raw of pages.flat() as unknown[]) {
    const review = reviewOf(raw, login);
    if (review === "malformed") return null;
    if (review !== null) reviews.push(review);
  }
  return reviews.sort((a, b) => a.id - b.id);
}

/**
 * One listed review as `login`'s `ReviewObject`; `null` for another author's
 * or a pending one, `"malformed"` for one that cannot be read.
 */
function reviewOf(
  raw: unknown,
  login: string,
): ReviewObject | null | "malformed" {
  if (!isRecord(raw)) return "malformed";
  const user = raw.user;
  if (!isRecord(user) || user.login !== login || raw.state === "PENDING")
    return null;
  const { id, commit_id: commit, submitted_at: at } = raw;
  if (typeof id !== "number" || typeof commit !== "string") return "malformed";
  if (!/^[0-9a-f]{40}$/.test(commit)) return "malformed";
  const body = raw.body ?? "";
  if (typeof body !== "string") return "malformed";
  return {
    id,
    commit,
    submittedAt: typeof at === "string" ? at : "",
    body,
  };
}

/** What the witness says of the head. */
export type ObjectVerdict =
  /** Reviewed: by a review object naming the head, or by its completed run. */
  | { state: "witnessed"; source: "review-object" | "review-check-run" }
  /** A draft the reviewer skips: nothing to wait for until it is marked Ready. */
  | { state: "draft-skip"; reason: string }
  | {
      state:
        | "AWAITING_REVIEWER"
        | "REVIEW_SKIPPED"
        | "REVIEWER_FAILED"
        | "STALE_REVIEW";
      reason: string;
    };

/**
 * Judge the reviewer's newest check run on `head` and its newest review.
 * `label` names the reviewer in the reasons (`reviewerLabel()`).
 */
export function judgeReviewObject(
  run: CheckRun,
  review: ReviewObject | null,
  head: string,
  isDraft: boolean,
  label: string,
): ObjectVerdict {
  const says = `its ${run.name} check run on ${head} reads "${run.title}"`;
  if (run.status !== "completed")
    return {
      state: "AWAITING_REVIEWER",
      reason: `${label} check-run on ${head} is '${run.status}'`,
    };
  switch (runTitleSays(run.title)) {
    case "paused":
      return {
        state: "REVIEW_SKIPPED",
        reason: `${label} paused its reviews of this pull request: ${says}, so it will not review this head and the drive cannot converge on it. Fix: resume its reviews (for CodeRabbit, comment \`@coderabbitai resume\`), then re-arm`,
      };
    case "draft-skip":
      return isDraft
        ? {
            state: "draft-skip",
            reason: `${label} skips drafts (${says}): it reviews this head once the pull request is marked Ready for review`,
          }
        : {
            state: "AWAITING_REVIEWER",
            reason: `${label}'s newest check run on ${head} is its draft skip ("${run.title}"), from before the pull request was marked Ready — waiting for it to review the Ready pull request`,
          };
    case "skipped":
      return {
        state: "REVIEW_SKIPPED",
        reason: `${label} skipped this head: ${says}, so no review of it will come and the drive cannot converge on it. Fix: have it review this head (for CodeRabbit, comment \`@coderabbitai review\`), or review the change yourself, then re-arm`,
      };
    default:
      break;
  }
  if (run.conclusion === "skipped")
    return {
      state: "AWAITING_REVIEWER",
      reason: `${label} check-run on ${head} was skipped — it never reviewed this head`,
    };
  if (run.conclusion !== "success" && run.conclusion !== "neutral")
    return {
      state: "REVIEWER_FAILED",
      reason: `${label} check-run on ${head} concluded '${run.conclusion}' — it may never have posted its findings, so a zero thread count would not mean the round was clean`,
    };
  if (review?.commit === head)
    return { state: "witnessed", source: "review-object" };
  if (review !== null) {
    const completed = parseMs(run.completed ?? "");
    const submitted = parseMs(review.submittedAt);
    // An unreadable time cannot order the two, and an unordered pair must not
    // certify the run as the review of this head.
    if (!Number.isFinite(completed) || !Number.isFinite(submitted))
      return {
        state: "AWAITING_REVIEWER",
        reason: `${label} last reviewed ${review.commit}, not ${head}, and the times of that review and of its ${run.name} check run on ${head} do not both read, so the order of the two is unknown`,
      };
    if (submitted > completed)
      return {
        state: "STALE_REVIEW",
        reason: `${label} last reviewed ${review.commit}, after its ${run.name} check run on ${head} completed, so that run does not stand for a review of this head`,
      };
  }
  return { state: "witnessed", source: "review-check-run" };
}
