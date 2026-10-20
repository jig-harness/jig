/** Record existing Ready state before a pass and settle a completed pass’s Ready obligation. */
import type { DriveRoundContext } from "./round-context.ts";

import { run, tsArgv, markReadyTimeoutSeconds } from "./../proc.ts";

import { markReady } from "./paths.ts";

import { MARK_READY_OUTCOMES, SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";

import { driverRuntime } from "./runtime.ts";

import { touchLock } from "./lifecycle.ts";

async function recordReadyBeforePass(
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  const rc = await run(
    tsArgv(markReady, [
      context.pr,
      "--record-only",
      "--reason",
      "already Ready at round start",
    ]),
    { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
  );
  if (rc.code === 5) {
    console.error(
      `PR #${context.pr} stopped being open while recording its already-Ready state; stopping`,
    );
    return 5;
  }
  const outcome = rc.code === 0 ? rc.stdout.trim() : null;
  // REQUIRE CONFIRMATION before the pass starts, rather than proceeding
  // on an unconfirmed result: this
  // record is the ONLY thing that closes the mid-pass draft-flip race, so
  // continuing hopefully on a failed or malformed record reopens exactly
  // that race for the whole (possibly multi-minute) pass about to run.
  //
  // `claimed-by-other` and `still-draft` are BOTH deliberately NOT
  // sufficient confirmation,
  // even though both are recognized, exit-0 outcomes: neither writes a
  // durable record.
  //
  // `claimed-by-other` means another driver holds the lease and may
  // record it, or may die holding it — proceeding on that basis reopens
  // the mid-pass draft-flip race this call exists to close.
  //
  // `still-draft` was wrongly treated as sufficient in an earlier version
  // of this fix, on the reasoning that "the race window already closed
  // before this read" — that reasoning had a hole: the PR was Ready at
  // `status.draft === false` above (the guard for even calling this),
  // and if the owner converted it to draft in the window before this
  // call's own read, `--record-only` sees the draft and correctly
  // records NOTHING — but that leaves no evidence anywhere that this was
  // a Ready→draft conversion rather than an ordinary never-marked draft.
  // The pass then runs, and the post-round call sees
  // `readyMarkedRound === 0` plus `isDraft === true` — indistinguishable
  // from a PR that was simply always a draft — and fires `gh pr ready`,
  // undoing the very conversion this whole mechanism exists to respect.
  if (
    outcome === null ||
    !MARK_READY_OUTCOMES.has(outcome) ||
    outcome === "claimed-by-other" ||
    outcome === "still-draft"
  ) {
    console.error(
      `could not confirm PR #${context.pr}'s already-Ready state before this round's pass`,
    );
    console.error(
      `  (exit ${rc.code}${outcome === null ? "" : `, outcome '${outcome}'`}) — stopping rather than`,
    );
    console.error(
      "  running the pass unprotected against a mid-pass draft flip. Re-run the drive.",
    );
    return 1;
  }

  return null;
}

export async function markReadyAfterRound(
  context: DriveRoundContext,
  round: number,
): Promise<number | "continue" | null> {
  const rc = await run(
    tsArgv(markReady, [context.pr, "--reason", `round ${round} completed`]),
    { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
  );
  // Rechecked HERE, immediately after the await, same reasoning as every
  // other `compromised` guard in this file: `touchLock` runs on its own
  // timer and can set it at any point during the wait above, and this
  // driver has no claim protecting the tree from that moment on.
  // Proceeding to interpret `rc` regardless would let a compromised
  // drive still perform the Ready transition (or count its outcome
  // toward `readyMarkFailures`) with no lock behind it.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver — not processing the Ready-mark outcome.`,
    );
    return SINGLE_INSTANCE_LOCK_EXIT;
  }
  // A recognized outcome requires BOTH exit 0 AND stdout being one of the
  // words in `MARK_READY_OUTCOMES` — exit 0 with anything else (empty,
  // truncated, garbled) is a malformed protocol response, not progress, and is
  // routed into the same failure-counting path as a nonzero exit rather
  // than silently resetting `readyMarkFailures`.
  const outcome = rc.code === 0 ? rc.stdout.trim() : null;
  const validOutcome = outcome !== null && MARK_READY_OUTCOMES.has(outcome);
  if (validOutcome) {
    {
      const stage = await processRecognizedReadyOutcome(
        outcome,
        context,
        round,
      );
      if (stage !== null) return stage;
    }
  } else if (rc.code !== 5) {
    {
      const stage = await processFailedReadyOutcome(
        context,
        rc,
        round,
        outcome,
      );
      if (stage !== null) return stage;
    }
  }

  return null;
}

async function processRecognizedReadyOutcome(
  outcome: string | null,
  context: DriveRoundContext,
  round: number,
): Promise<number | "continue" | null> {
  // `claimed-by-other` is exit 0 and is NOT progress. The case that
  // makes the distinction load-bearing is the one this round's own
  // helper deadline creates: if the timeout fires after `mark-ready.ts`
  // won its lease, the helper is killed before its cleanup can release
  // it, so the NEXT round meets an orphaned lease, is told
  // `claimed-by-other`. Leaving `readyMarkFailures` merely UNCHANGED
  // here (rather than counting it as another unsuccessful attempt) meant
  // it could never reach the `>= 2` stop condition on its own — a
  // repeatedly orphaned lease would keep reporting `claimed-by-other`
  // every round without ever tripping the stop, and the drive would
  // exhaust `--max-rounds` with the PR still a draft.
  if (outcome !== "claimed-by-other") {
    context.readyMarkFailures = 0;
  } else {
    context.readyMarkFailures += 1;
    console.error(
      `round ${round} completed, but PR #${context.pr}'s Ready-mark lease is held elsewhere —`,
    );
    console.error(
      "  no transition made. If no other driver is running, this is an orphaned lease",
      `\n  (a killed helper); it ages out after $DRIVE_PR_CLAIM_STALE_MIN.`,
    );
    if (context.readyMarkFailures >= 2) {
      console.error(
        `  That is ${context.readyMarkFailures} in a row, so it is not a blip — stopping rather than`,
      );
      console.error(
        `  driving to --max-rounds on a PR that stays a draft. If no other driver is`,
      );
      console.error(
        `  running, break the lease by hand (drive-state.ts release-ready-mark ${context.pr})`,
      );
      console.error(
        "  and re-run the drive — NOT `gh pr ready` directly, which fires the remote",
      );
      console.error(
        "  transition but leaves this local lease in place, so a later round can still",
      );
      console.error("  see it as held and report the same contention.");
      // A directive sent WHILE this (successful) pass ran must still
      // be honored before this terminal return: a repeated Ready-mark
      // failure is the one path past a successful pass that does NOT
      // loop back to the next iteration's own checkpoint.
      // `clear`/`resumed` fall through to reporting the
      // repeated-failure stop unchanged;
      // `stopped`/`pause-timeout`/`unreadable` return their own exit
      // code in its place.
      const mailboxAtReadyStop = await context.mailboxCheckpoint();
      if (typeof mailboxAtReadyStop === "number") return mailboxAtReadyStop;
      return 1;
    }
  }
  if (outcome === "marked") context.markedReadyThisRun = true;

  return null;
}

async function processFailedReadyOutcome(
  context: DriveRoundContext,
  rc: Awaited<ReturnType<typeof run>>,
  round: number,
  outcome: string | null,
): Promise<number | "continue" | null> {
  context.readyMarkFailures += 1;
  if (rc.code === 0) {
    console.error(
      `round ${round} completed, but mark-ready.ts reported exit 0 with an unrecognized`,
    );
    console.error(
      `  outcome ('${outcome}') — not one of ${[...MARK_READY_OUTCOMES].join(", ")}.`,
    );
  } else {
    console.error(
      `round ${round} completed, but marking PR #${context.pr} Ready for review failed (exit ${rc.code}).`,
    );
  }
  if (context.readyMarkFailures >= 2) {
    console.error(
      `  That is ${context.readyMarkFailures} in a row, so it is not a blip — stopping rather than`,
    );
    console.error(
      `  driving to --max-rounds on a PR that stays a draft. Mark it by hand`,
    );
    console.error(
      `  (gh pr ready ${context.pr}), fix what made this fail, and re-run the drive.`,
    );
    // Same as the claimed-by-other stop above — see its own comment for
    // why.
    const mailboxAtReadyFailStop = await context.mailboxCheckpoint();
    if (typeof mailboxAtReadyFailStop === "number")
      return mailboxAtReadyFailStop;
    return 1;
  }
  console.error(
    "  The next round retries — either the lease was released, or an ambiguous outcome",
  );
  console.error(
    "  left it held on purpose until it can be confirmed or goes stale — stopping only",
  );
  console.error("  if it fails again.");

  return null;
}

export async function preparePassBoundary(
  status: Record<string, unknown>,
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  // A PR that is ALREADY Ready when this round starts needs the same
  // durable "nothing owed" record the post-round call gives it — but
  // recorded NOW, before the pass runs.
  // Without it, `readyMarkedRound` stays 0 for the whole pass, which can run
  // several minutes; if the owner converts the PR back to draft while it is
  // running, the post-round call below sees `readyMarkedRound === 0` PLUS
  // the now-draft flag and fires `gh pr ready`, reversing a decision this
  // whole mechanism exists not to undo.
  //
  // `--record-only` — this call may NEVER fire `gh pr ready` itself.
  // Without it, this call uses the GENERAL mark-ready.ts path, which — if
  // the owner converts the PR back to draft in the window between
  // drive-status.ts's read above and mark-ready.ts's OWN live re-read —
  // would see a draft and immediately dispatch the transition itself,
  // undoing the very decision this pre-pass record exists to protect.
  // `--record-only` makes that structurally impossible: it can only record
  // an already-Ready observation or report `still-draft` with no side
  // effect, never claim the lease or call `gh pr ready`. It does not touch
  // the "not at the start" ordering documented at the post-round call
  // below, which is about spending CodeRabbit's one pass on a cleaned-up
  // head, a different concern.
  //
  // NOT gated on `!keepDraft`:
  // `--keep-draft` exists to suppress the outward draft→Ready DISPATCH,
  // which this call structurally cannot perform. Skipping it under
  // `--keep-draft` left `readyMarkedRound` at 0 for a PR this drive
  // observed as already Ready, so a LATER ordinary (non-`--keep-draft`)
  // drive — after a human converts that PR to draft — could not tell a
  // deliberate Ready→draft conversion from a PR that was simply never
  // marked, and would fire `gh pr ready` on it.
  if (status.draft === false) {
    {
      const stage = await recordReadyBeforePass(context);
      if (stage === "continue") return "continue";
      if (stage !== null) return stage;
    }
  }

  const mailboxBeforePass = await context.mailboxCheckpoint();
  if (typeof mailboxBeforePass === "number") return mailboxBeforePass;
  if (mailboxBeforePass === "resumed") return "continue";

  // `passes` itself is incremented only at the actual dispatch point,
  // several awaits below — not here: this is one round-boundary checkpoint
  // among several before the pass is certain to run, and counting here
  // would double-count against the late increment.
  // A round boundary is a cheap extra renewal, not the mechanism: the timer
  // started above is what keeps the claim fresh through a long pass. Nothing
  // else distinguishes this driver from a stranger that inherited its pid
  // after it died, and a lock that stops being refreshed is what lets a
  // later start recover one.
  for (const lock of context.held) touchLock(lock);

  return null;
}
