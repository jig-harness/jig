/** Settle the draft-to-Ready obligation before convergence can be reported. */
import type { DriveRoundContext } from "./round-context.ts";

import { run, tsArgv, markReadyTimeoutSeconds } from "./../proc.ts";

import { markReady } from "./paths.ts";

import { MARK_READY_OUTCOMES } from "./settings.ts";

async function markConvergedReady(
  status: Record<string, unknown>,
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  // `--record-only` when THIS gate's own snapshot already saw the PR
  // as Ready — mirroring the
  // round-loop's pre-pass call: a call that CAN dispatch is exactly
  // what let an earlier version of this branch fire `gh pr ready` on
  // a PR the owner converted to draft in the window before this
  // call's own live re-read, reversing that decision. When
  // `status.draft` is `true` here, this call is precisely the one
  // meant to dispatch the actual draft→Ready transition, so it does
  // NOT get `--record-only`.
  const recordOnly = status.draft === false;
  const rc = await run(
    tsArgv(markReady, [
      context.pr,
      ...(recordOnly ? ["--record-only"] : []),
      "--reason",
      "converged with no round to run",
    ]),
    { stderr: "inherit", timeoutSec: markReadyTimeoutSeconds() },
  );
  // LIVENESS FIRST, and it wins over the convergence this branch was
  // about to report. Exit 5 means `mark-ready.ts` re-read the PR —
  // AFTER the gate did — and found it merged or closed. That is a
  // fresher observation of the same fact `drive-status.ts` reports as
  // PR_NOT_OPEN, so it propagates as PR_NOT_OPEN rather than falling
  // through into an exit 0 that would tell an operator to merge a PR
  // that is already gone.
  if (rc.code === 5) {
    console.error(
      `PR #${context.pr} stopped being open while the converged drive was marking it Ready`,
    );
    console.error("  — reporting the newer observation, not the gate's.");
    return 5;
  }
  // STOP rather than re-gate when the transition FAILED. Its lease is
  // released on failure, so looping back would converge, fail, release
  // and converge again — an unbounded spin on a step that does not get
  // better by itself. Exit 1 is what it is: an action this drive owed
  // and could not complete.
  if (rc.code !== 0) {
    console.error(
      `converged on PR #${context.pr}, but marking it Ready for review failed — stopping rather than`,
    );
    console.error(
      `  re-gating in a loop. Mark it by hand (gh pr ready ${context.pr}) and re-run the drive.`,
    );
    return 1;
  }
  const outcome = rc.stdout.trim();
  if (!MARK_READY_OUTCOMES.has(outcome)) {
    console.error(
      `converged on PR #${context.pr}, but mark-ready.ts reported exit 0 with an unrecognized`,
    );
    console.error(
      `  outcome ('${outcome}') — not one of ${[...MARK_READY_OUTCOMES].join(", ")}.`,
    );
    console.error(
      `  Treating this as unsettled rather than converged. Mark it by hand`,
    );
    console.error(`  (gh pr ready ${context.pr}), and re-run the drive.`);
    return 1;
  }
  // `marked`, `already-ready`, and `already-marked` ALL re-gate:
  // this call is itself the slow, awaited step in this branch — up
  // to `markReadyTimeoutSeconds()` of real elapsed time — and
  // another clone can push a new head while it runs. `mark-ready.ts`
  // only re-reads PR state and draftness, never `headRefOid`, so
  // declaring convergence straight off this call's outcome vouches
  // for the head the OUTER gate verified minutes ago, not the one
  // live now. `markedReadyThisRun` is set only for `marked` itself:
  // the other two dispatched nothing this run.
  if (outcome === "marked") {
    context.markedReadyThisRun = true;
    return "continue";
  }
  // `already-ready` / `already-marked` are STABLE answers — an
  // unmoved head gives the identical one on every re-ask — so unlike
  // `marked` (a real state transition, safe to re-gate on
  // unconditionally) this re-gate is bounded to ONCE. Case 3
  // (CONVERGED) never touches `passes`/`--max-rounds` the way case 0
  // does, so nothing else would stop a head that genuinely never
  // changes from re-entering this exact branch forever. One extra
  // gate call closes the TOCTOU window the re-gate exists for; a
  // second one on the SAME stable outcome would learn nothing further
  // and spin.
  if (
    (outcome === "already-ready" || outcome === "already-marked") &&
    !context.reGatedForStableMarkReadyOutcome
  ) {
    context.reGatedForStableMarkReadyOutcome = true;
    return "continue";
  }
  // `claimed-by-other` is NOT proof the transition completed — another
  // driver holds the lease and may still be in flight, or may die
  // holding it. It is not a
  // reason to spin here either: re-gating would find the same lease
  // and converge into the same branch.
  if (outcome === "claimed-by-other") {
    context.readyLeftToOtherDriver = true;
  }
  // `still-draft` (only reachable via `--record-only`) means the
  // owner converted the PR to draft in the window before this call's
  // own live read — nothing was recorded, and dispatching was
  // structurally impossible, so there is nothing more this call could
  // have done. Reported separately from `readyLeftToOtherDriver`: no
  // other driver is involved here.
  if (outcome === "still-draft") {
    context.readyFlippedToDraftBeforeRecord = true;
  }

  return null;
}

export async function settleConvergedReady(
  context: DriveRoundContext,
  status: Record<string, unknown>,
): Promise<number | "continue" | null> {
  // Converged AND certified clean — but a drive that gets here while the
  // PR is still an UNMARKED DRAFT has not finished the job the transition
  // exists for. The in-house AI reviewer reviewed this head and had
  // nothing left to say; CodeRabbit never looked at it at all, and by
  // repo policy never will until someone marks the PR Ready. Returning 0
  // here would report "the review loop is done" about a PR whose external
  // review is pending by construction — the false-terminal shape this
  // skill exists to refuse, arrived at from the one direction the round
  // loop has no hook in, because a drive that converges on its first gate
  // never runs a pass and so never reaches the post-round transition
  // below.
  //
  // So: mark it Ready, then re-gate rather than returning. Bounded to ONE
  // extra iteration — `readyMarkedRound` is non-zero afterwards, so the
  // next CONVERGED falls straight through — and it is not a wait for
  // CodeRabbit, which this skill does not gate on either way.
  //
  // DELIBERATELY BEHIND the whole clean-worktree gate above, and the order
  // is the decision rather than an accident of the merge that put these
  // two together. `gh pr ready` fires `ready_for_review`, which spends the
  // external reviewer's one-pass-per-push budget on whatever head is
  // current at that instant. Over a dirty worktree — uncommitted leftovers,
  // an unconcluded merge, a local commit that outran the reviewed head —
  // that head is precisely the one about to change once the operator
  // resolves it, so marking first would spend the pass on a head nobody
  // intends to keep. That is the exact waste this transition exists to
  // avoid, so the drive earns the right to summon anyone only once it can
  // certify there is nothing left on the floor. Exit 12 therefore leaves
  // the PR a draft, and the retry after the operator cleans up marks it.
  // Gated on `--keep-draft` ALONE, not on `status.draft`. A draftness
  // gate here looks like an optimisation and is a hole: on an
  // ALREADY-Ready PR that converges before any pass runs, it skips
  // `mark-ready.ts` entirely, so `readyMarkedRound` stays 0 and this
  // drive keeps no record that it owed nothing. A human who later
  // converts that PR back to draft then meets the next drive reading 0,
  // seeing a draft, and marking it Ready again — undoing their decision,
  // which is the exact case the already-Ready recording path exists for
  // and the one place it was unreachable.
  //
  // `mark-ready.ts` is the right place for that decision anyway: it
  // reads the durable record first, and only then a live snapshot, so
  // the call costs one state read on every round after the first.
  //
  // NOT gated on `!keepDraft` ALONE: `--keep-draft` exists to suppress
  // the outward draft→Ready DISPATCH, not the harmless,
  // side-effect-free record of an already-Ready observation.
  // `status.draft === false` also runs this under `--keep-draft`, for
  // the same reason the pre-pass call does — skipping it left
  // `readyMarkedRound` at 0 for a PR this drive observed as already
  // Ready, so a later ordinary drive could not tell a deliberate
  // Ready→draft conversion from a never-marked draft.
  // `status.draft === true` still respects `--keep-draft`: that case is
  // the actual dispatch-capable call, which is exactly what the flag
  // exists to suppress.
  if (!context.keepDraft || status.draft === false) {
    {
      const stage = await markConvergedReady(status, context);
      if (stage !== null) return stage;
    }
  }

  // Neither a lease left to another driver NOR an unrecorded draft flip
  // is full convergence.
  // Returning exit 0 here claims "nothing left to do" and ends the
  // drive outright — for the lease case, a dead other-driver then
  // leaves the PR a draft forever with no external reviewer summoned
  // and nothing left to notice; for the draft-flip case, the PR is
  // genuinely a draft again by the owner's own deliberate action, and
  // this drive owes it nothing further right now.
  if (context.readyLeftToOtherDriver) {
    console.error(
      `converged against the reviewer after ${context.passes} round(s), but PR #${context.pr} is still a`,
    );
    console.error(
      "  draft and another driver holds the Ready-mark lease — not reporting full",
    );
    console.error(
      "  convergence. Whether the reviewers that skip drafts get summoned is that",
    );
    console.error(
      "  driver's call; if it died, the lease expires and a later drive takes the",
    );
    console.error("  transition over. Re-run the drive to retry.");
    // Exit 4 ("not yet judgeable"): genuinely retry-safe, since either
    // the other driver finishes the transition or its lease expires and
    // a later drive takes it over — nothing here needs a fresh look, an
    // unattended wrapper's plain retry is exactly the right response.
    return 4;
  }
  if (context.readyFlippedToDraftBeforeRecord) {
    console.error(
      `converged against the reviewer after ${context.passes} round(s), but PR #${context.pr} is still a`,
    );
    console.error(
      "  draft — the owner converted it back before this drive could record it was",
    );
    console.error(
      "  ever Ready. Not reporting full convergence, and NOT retrying automatically:",
    );
    console.error("  unlike the lease case above, nothing");
    console.error(
      "  durable was written here, so a blind retry that reaches this exact branch",
    );
    console.error(
      "  again would just repeat the race rather than resolve it. Re-run the drive",
    );
    console.error("  by hand to re-evaluate against the current state.");
    // Exit 1, not 4: an unattended wrapper's plain retry is the wrong
    // response to an observation that was never persisted anywhere —
    // this needs a fresh top-level look, not mechanical repetition.
    return 1;
  }

  return null;
}
