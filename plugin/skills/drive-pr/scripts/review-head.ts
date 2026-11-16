#!/usr/bin/env bun
/** Current-head reviewer evidence for the standalone review loop. */
import { runMain } from "../../../shared/cli.ts";
import {
  reviewerApp,
  reviewerEvidence,
  reviewerExpected,
  reviewerLabel,
} from "./lib/overlay.ts";
import { ghCall } from "./lib/proc.ts";
import {
  checkRunsFor,
  reviewerRun,
  reviewerStickyMarkers,
} from "./lib/status/evidence.ts";
import {
  judgeReviewObject,
  latestReviewBy,
} from "./lib/status/review-object.ts";
import { commentDraftSkip } from "./lib/status/comment-draft-skip.ts";
import { resolveMarkerSha } from "./lib/status/reviewed-sha.ts";

// 0 witnessed; 4 waiting for this head; 1 unreadable, or a review that will
// not come (a paused or skipping reviewer, said on stderr); 2 invalid
// invocation.
async function main(): Promise<number> {
  const [pr = "", head = ""] = process.argv.slice(2);
  if (!/^\d+$/.test(pr) || !/^[0-9a-f]{40}$/.test(head)) return 2;
  if (!reviewerExpected()) return 0;
  const repo = await ghCall([
    "repo",
    "view",
    "--json",
    "owner,name",
    "-q",
    '.owner.login + "/" + .name',
  ]);
  if (repo.code !== 0) return 1;
  const [owner, name] = repo.stdout.trim().split("/");
  if (!owner || !name) return 1;
  if (reviewerEvidence() === "review_object")
    return byReviewObject(owner, name, pr, head);
  const [runs, sticky] = await Promise.all([
    checkRunsFor(owner, name, head),
    reviewerStickyMarkers(owner, name, pr),
  ]);
  if (runs === null || sticky === null) return 1;
  const run = reviewerRun(runs);
  if (run?.status !== "completed" || run.conclusion !== "success") return 4;
  if (sticky.sha === "" || (await resolveMarkerSha(sticky.sha)) !== head) {
    console.error(`reviewer has not recorded reviewing current head ${head}`);
    return 4;
  }
  return 0;
}

/**
 * A review-object reviewer's evidence for `head` (`review-object.ts`). A
 * draft it skips has nothing to wait for, as the drive treats it.
 */
async function byReviewObject(
  owner: string,
  name: string,
  pr: string,
  head: string,
): Promise<number> {
  const [runs, draft] = await Promise.all([
    checkRunsFor(owner, name, head),
    ghCall(["pr", "view", pr, "--json", "state,isDraft", "-q", ".isDraft"]),
  ]);
  if (runs === null || draft.code !== 0) return 1;
  const run = reviewerRun(runs);
  if (run === null) {
    const skip = await commentDraftSkip(owner, name, pr, reviewerApp());
    if (skip === null) return 1;
    return skip && draft.stdout.trim() === "true" ? 0 : 4;
  }
  const latest =
    run.status === "completed"
      ? await latestReviewBy(owner, name, pr, `${reviewerApp()}[bot]`)
      : { review: null };
  if (latest === null) return 1;
  const verdict = judgeReviewObject(
    run,
    latest.review,
    head,
    draft.stdout.trim() === "true",
    reviewerLabel(),
  );
  if (verdict.state === "witnessed" || verdict.state === "draft-skip") return 0;
  console.error(verdict.reason);
  return verdict.state === "AWAITING_REVIEWER" ||
    verdict.state === "STALE_REVIEW"
    ? 4
    : 1;
}

if (import.meta.main) runMain("review-head", main);
