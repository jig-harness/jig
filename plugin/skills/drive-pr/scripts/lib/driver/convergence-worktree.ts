/** Certify the reviewed worktree before outward transitions and again before the final report. */
import type { DriveRoundContext } from "./round-context.ts";

import {
  gitCallTimeoutSeconds,
  git,
  unconcludedGitOpMarker,
  run,
  tsArgv,
  finalVerifyTimeoutSeconds,
} from "./../proc.ts";

import { WORKTREE_UNCLEAN_EXIT } from "./settings.ts";

import { loopEconomy, certifyFinalWorktree } from "./reports.ts";

import { driveState } from "./paths.ts";

import { reviewerLabel } from "./../overlay.ts";

export async function prepareConvergenceWorktree(
  status: Record<string, unknown>,
  context: DriveRoundContext,
): Promise<number | "continue" | { reviewedHead: string; economy: string }> {
  // Convergence is a remote fact — the reviewer stamped this head with
  // zero findings — so it says nothing about THIS worktree. Every
  // per-thread guard (answer-summary-finding.ts, resolve-held-thread.ts)
  // checks cleanliness only at its own moment: a round resolved entirely
  // with rejected/wont-fix/deferred outcomes never hits one, and dirt
  // created after the last resolution (gate re-runs, scratch probes, a
  // pass that died mid-edit before a resume) is invisible to all of
  // them. Exit 0 is the signal an operator merges on, so it must also
  // certify there is nothing left on the floor. Fail closed: an
  // unreadable tree gets the same refusal, not a shrug.
  //
  // Local HEAD must still be the reviewed head, checked before anything
  // else: a new local commit lands with an empty `git status` (nothing
  // uncommitted) and no unconcluded-op marker, so every check below
  // would pass over local HEAD having silently moved from the reviewed
  // commit to an unreviewed one that was never pushed. Same fix as
  // announce-merge-ready.ts's sibling check.
  const reviewedHead = String(
    (status.head as Record<string, unknown> | undefined)?.api ?? "",
  );
  const headTimeoutSec = gitCallTimeoutSeconds();
  const localHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (localHeadRes.code !== 0) {
    console.error(
      `review converged after ${context.passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
    return WORKTREE_UNCLEAN_EXIT;
  }
  const localHead = localHeadRes.stdout.trim();
  if (reviewedHead === "" || localHead !== reviewedHead) {
    console.error(
      `review converged after ${context.passes} round(s), but local HEAD is ${localHead || "<empty>"},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed here`,
    );
    console.error(
      "that was never pushed or reviewed. Push it, or reset to the reviewed head,",
    );
    console.error("then re-run.");
    return WORKTREE_UNCLEAN_EXIT;
  }

  // The economy block's NETWORK work happens HERE, ahead of every
  // worktree certification below rather than between them.
  //
  // It used to sit after the dirt and marker probes, on the reasoning
  // that work done BEFORE the final `rev-parse` re-read costs nothing.
  // That reasoning holds for HEAD alone, which IS re-read afterwards —
  // and fails for the other two, which are not: a `loopEconomy()` call
  // is up to 120s of elapsed time in which an uncommitted edit or a
  // fresh MERGE_HEAD can appear without moving HEAD, leaving the final
  // re-read satisfied and the drive exiting 0 over leftovers it had
  // certified two minutes earlier.
  // Moving the call above all three restores the narrow window rather
  // than duplicating the probes on both sides of it.
  const economy = await loopEconomy(context.pr);

  // A `git status --porcelain` predicate — however hardened — answers
  // "is anything uncommitted", not "is a git operation still open":
  // resolving a conflict back to a tree that matches what was already
  // committed leaves `MERGE_HEAD` behind while porcelain status reports
  // empty. Checked
  // next, same as announce-merge-ready.ts's sibling check.
  const opTimeoutSec = gitCallTimeoutSeconds();
  const op = await unconcludedGitOpMarker(opTimeoutSec);
  if (!op.ok) {
    console.error(
      `review converged after ${context.passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
    return WORKTREE_UNCLEAN_EXIT;
  }
  if (op.marker !== null) {
    console.error(
      `review converged after ${context.passes} round(s), but an unconcluded git operation is`,
    );
    console.error(
      `present (${op.marker}) — resolve or abort it (git merge/cherry-pick/revert`,
    );
    console.error("--abort), then re-run.");
    return WORKTREE_UNCLEAN_EXIT;
  }

  // `--untracked-files=normal` is explicit, not decorative: `--porcelain`
  // alone inherits `status.showUntrackedFiles` from repo or user config,
  // and `=no` there makes a plain `git status --porcelain` report an
  // untracked scratch file as a clean tree — silently certifying a
  // leftover as shipped (the same root cause as announce-merge-ready.ts's
  // sibling check). `--ignore-submodules=none` closes the same class one
  // level down: `submodule.<name>.ignore`/`.gitmodules` can set `ignore =
  // all` and hide modifications inside a tracked submodule regardless of
  // the untracked-files mode.
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    {
      stderr: "ignore",
      timeoutSec: gitCallTimeoutSeconds(),
    },
  );
  if (dirty.code !== 0) {
    console.error(
      `review converged after ${context.passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
    return WORKTREE_UNCLEAN_EXIT;
  }
  if (dirty.stdout !== "") {
    console.error(
      `review converged after ${context.passes} round(s), but this worktree still has uncommitted state:`,
    );
    process.stderr.write(dirty.stdout);
    console.error(
      "These edits shipped in no round — commit or discard them, then re-run.",
    );
    return WORKTREE_UNCLEAN_EXIT;
  }

  // Re-read local HEAD once more, immediately before reporting
  // converged. The check above narrows the window a commit can land in
  // undetected; it cannot close it, because the operation-marker and
  // status probes are themselves further elapsed time after that read
  // — a commit landing in that gap leaves `git status` reporting a
  // clean H2 while this branch was about to exit 0 for reviewed H1.
  // Same fix as announce-merge-ready.ts's sibling check.
  const finalHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (finalHeadRes.code !== 0) {
    console.error(
      `review converged after ${context.passes} round(s), but the working tree is UNREADABLE —`,
    );
    console.error(
      "cannot certify the worktree is clean, so not exiting 0 over unknown leftovers.",
    );
    return WORKTREE_UNCLEAN_EXIT;
  }
  const finalHead = finalHeadRes.stdout.trim();
  if (finalHead !== reviewedHead) {
    console.error(
      `review converged after ${context.passes} round(s), but local HEAD is ${finalHead},`,
    );
    console.error(
      `while the reviewed head is ${reviewedHead || "<empty>"} — a commit landed`,
    );
    console.error(
      "here during this check that was never pushed or reviewed. Push it, or reset",
    );
    console.error("to the reviewed head, then re-run.");
    return WORKTREE_UNCLEAN_EXIT;
  }

  return { reviewedHead, economy };
}

export async function finishConvergence(
  context: DriveRoundContext,
  reviewedHead: string,
  economy: string,
): Promise<number | "continue"> {
  const verified = await run(
    tsArgv(driveState, ["set-verified", context.pr, "--sha", reviewedHead]),
    { stderr: "inherit", timeoutSec: finalVerifyTimeoutSeconds() },
  );
  if (verified.code === 5) return 5;
  if (verified.code === 4) {
    console.error(
      "final verification became stale while it was recorded; re-gating",
    );
    return "continue";
  }
  if (verified.code !== 0) {
    console.error(
      `recording the final green-verified SHA failed (exit ${verified.code})`,
    );
    return 1;
  }

  if (!(await certifyFinalWorktree(reviewedHead, context.passes)))
    return WORKTREE_UNCLEAN_EXIT;

  const mailboxBeforeConvergence = await context.mailboxCheckpoint();
  if (typeof mailboxBeforeConvergence === "number")
    return mailboxBeforeConvergence;
  if (mailboxBeforeConvergence === "resumed") return "continue";

  console.error(`converged after ${context.passes} round(s) in this run`);
  if (context.markedReadyThisRun) {
    console.error(
      `  NOTE: this drive marked PR #${context.pr} Ready for review, which is what summons the`,
    );
    console.error(
      "  reviewers that skip drafts (CodeRabbit). Convergence here is against",
    );
    console.error(
      `  ${reviewerLabel()} only — anything they post lands after this drive ends, so re-run it.`,
    );
  }
  // Printing only — no I/O, so the re-read above is still the last thing
  // that could have changed this branch's answer.
  process.stderr.write(economy);
  return 0;
}
