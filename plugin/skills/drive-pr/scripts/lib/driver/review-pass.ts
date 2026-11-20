/** Interpret one review pass only after process cleanup and ownership checks settle. */
import type { DriveRoundContext } from "./round-context.ts";

import { prepareReviewPass, dispatchReviewPass } from "./review-dispatch.ts";

import { passExitDisposition } from "./settings.ts";

import { handleFailedReviewPass } from "./review-failure.ts";

import { reportPassLeftovers } from "./restart.ts";

import { clearPendingVerdicts } from "./../state/pass-handoff.ts";

import { resolveStateDir } from "./../state/store.ts";
import { clearPassFinish, readPassFinish } from "./../state/pass-finish.ts";
import type { Report } from "./../finish-round-report.ts";
import { launchOf } from "../../../../../shared/launched-session.ts";
import { CHECK_RUNS_UNREADABLE_EXIT } from "./settings.ts";
import { driverRuntime } from "./runtime.ts";
import { incompletePassExit } from "./incomplete-pass.ts";
import { measureStop } from "./stop-measure.ts";

/** A launch-bound finish result outranks an arbitrary pass wrapper's exit. */
export function hasCheckRunsUnreadableFinish(
  finish: Report | null,
  timedOut: boolean,
): finish is Report & { state: "CHECK_RUNS_UNREADABLE" } {
  // A driver-enforced timeout proves the pass did not complete; a report left
  // by an earlier finish attempt must not mask that cancellation.
  return !timedOut && finish?.state === "CHECK_RUNS_UNREADABLE";
}

export async function runReviewPassPhase(
  context: DriveRoundContext,
  apiHead: string,
  round: number,
): Promise<number | "continue" | "passed"> {
  const prepareReviewPassResult = await prepareReviewPass(context, round);
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
  // A record from an earlier attempt of this launch and round (a deadline
  // restart on the same head) must not answer for this one.
  clearPassFinish(await resolveStateDir(), context.pr);
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
  const stateDir = await resolveStateDir();
  const finish = readPassFinish(
    stateDir,
    context.pr,
    launchOf(process.env) ?? "",
    round,
  );
  if (hasCheckRunsUnreadableFinish(finish, passRes.timedOut)) {
    // The pass process can be an agent or an arbitrary wrapper, so its exit
    // code does not attest to finish-round's result. The report is bound to
    // this launch and round, and a later successful finish overwrites it.
    const mailboxAfterListingStop = await context.mailboxCheckpoint();
    if (typeof mailboxAfterListingStop === "number")
      return mailboxAfterListingStop;
    // The record is read from a file: a count that is not a whole number is
    // unknown, as an absent one is.
    const pages = finish.listingPagesRead;
    driverRuntime.stopListingPages =
      typeof pages === "number" && Number.isSafeInteger(pages) && pages >= 0
        ? pages
        : null;
    const read =
      driverRuntime.stopListingPages === null
        ? ""
        : ` after ${driverRuntime.stopListingPages} page(s)`;
    console.error(
      `pass reported CHECK_RUNS_UNREADABLE${read} on round ${round}; stopping`,
    );
    await reportPassLeftovers("What the pass left in the tree:");
    driverRuntime.stopLeftWork = await measureStop();
    return CHECK_RUNS_UNREADABLE_EXIT;
  }
  const disposition = passExitDisposition(passRes.code);
  // A pass that completed has acted on what it was carried. Until one does (a
  // quota wall retried, say), every pass is told again. Whether it pushed what
  // it inherited is not taken on its word: the next gate measures the tree
  // again (`unpushed.ts`) and hands on any commit it left unpushed.
  if (disposition.kind === "ok") {
    const incomplete = await incompletePassExit(context.pr);
    if (incomplete !== null) return incomplete;
    context.settleWorktree = false;
    context.passNotice = "";
    context.carriedNotice = "";
    clearPendingVerdicts(await resolveStateDir(), context.pr);
    context.inheritedHead = "";
    // Edits the tree held before this pass ran are not its to hand on.
    context.uncommittedBeforePass = context.uncommittedMeasured;
    context.inheritsOperation = false;
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
