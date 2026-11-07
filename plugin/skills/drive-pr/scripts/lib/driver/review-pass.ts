/** Interpret one review pass only after process cleanup and ownership checks settle. */
import type { DriveRoundContext } from "./round-context.ts";

import { prepareReviewPass, dispatchReviewPass } from "./review-dispatch.ts";

import { passExitDisposition } from "./settings.ts";

import { handleFailedReviewPass } from "./review-failure.ts";

import { reportPassLeftovers } from "./restart.ts";

import { clearPendingVerdicts } from "./../state/pass-handoff.ts";

import { resolveStateDir } from "./../state/store.ts";

export async function runReviewPassPhase(
  context: DriveRoundContext,
  apiHead: string,
  round: number,
): Promise<number | "continue" | "passed"> {
  const prepareReviewPassResult = await prepareReviewPass(context);
  if (typeof prepareReviewPassResult !== "object")
    return prepareReviewPassResult;
  const {
    prepared,
    baseEnv,
    passDeadlineSec,
    passStartedAt,
    preexistingSessions,
    preexistingSnapshot,
  } = prepareReviewPassResult;
  const dispatchReviewPassResult = await dispatchReviewPass(
    context,
    apiHead,
    round,
    prepared,
    baseEnv,
    passDeadlineSec,
  );
  if (typeof dispatchReviewPassResult !== "object")
    return dispatchReviewPassResult;
  const { passRes, passHandle } = dispatchReviewPassResult;
  const disposition = passExitDisposition(passRes.code);
  // A pass that completed has acted on what it was carried. Until one does (a
  // quota wall retried, say), every pass is told again. Whether it pushed what
  // it inherited is not taken on its word: the next gate measures the tree
  // again (`unpushed.ts`) and hands on any commit it left unpushed.
  if (disposition.kind === "ok") {
    context.passNotice = "";
    context.carriedNotice = "";
    clearPendingVerdicts(await resolveStateDir(), context.pr);
    context.inheritedHead = "";
    // Edits the tree held before this pass ran are not its to hand on.
    context.uncommittedBeforePass = context.uncommittedMeasured;
  }
  // A directive sent WHILE this pass ran must still be honored before a
  // non-success terminal result for it is reported, PR_NOT_OPEN included.
  // NOT extended to the
  // SUCCESS path below (no `disposition.kind === 'ok'` branch exists here
  // — the function falls through to mark-ready and the held-batch drain
  // instead): checking unconditionally, before `disposition` is computed,
  // would break the documented "a running pass is allowed to complete,
  // including its post-round Ready transition, before the next
  // checkpoint" guarantee.
  // A round that succeeded reaches mark-ready regardless of a directive
  // that arrived while it ran; it already re-checks the mailbox at the top
  // of the next iteration in the ordinary course of looping.
  // `clear`/`resumed` both fall through to reporting PR_NOT_OPEN — the
  // pass already found this out, so a live pause only delays WHEN it is
  // reported, never what it was; `stopped`/`pause-timeout`/`unreadable`
  // return their own exit code in its place.
  if (disposition.kind === "not-open") {
    const mailboxAfterNotOpen = await context.mailboxCheckpoint();
    if (typeof mailboxAfterNotOpen === "number") return mailboxAfterNotOpen;
    console.error(
      `pass reported the PR is no longer open on round ${round}; stopping`,
    );
    await reportPassLeftovers("What the pass left in the tree:");
    return disposition.exit;
  }
  if (disposition.kind === "failed") {
    return await handleFailedReviewPass(
      passRes,
      passDeadlineSec,
      round,
      passHandle,
      context,
      passStartedAt,
      preexistingSessions,
      prepared,
      preexistingSnapshot,
      disposition,
    );
  }

  return "passed";
}
