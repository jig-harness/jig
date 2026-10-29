/** Spend the conflict-repair budget before reporting a base-merge stop. */
import {
  conflictFixCommands,
  conflictRepairRounds,
  fixRemote,
} from "./settings.ts";

import { driverRuntime } from "./runtime.ts";

import type { DriveRoundContext } from "./round-context.ts";

import { runRepairPass } from "./repair.ts";

export async function runConflictPhase(
  context: DriveRoundContext,
  status: Record<string, unknown>,
  reasonLine: string,
): Promise<number | "continue"> {
  // Deliberately NOT flattened into the generic propagation below. A
  // conflict is the one stop-state whose fix is a concrete git command
  // rather than a decision, and the whole failure this exists to end is
  // an operator being told "waiting for the reviewer" about a PR that
  // needs a merge. Name the fix.
  //
  // It is no longer terminal ON ARRIVAL, though. The earlier
  // reasoning here ("drive-status.ts only emits this state when the work
  // enumeration is EMPTY, so there is nothing for a triage pass to do
  // with it") conflated TRIAGE with the PASS. There is nothing to
  // triage, and there is plenty to do: merge the base, resolve, run the
  // round's validation plan, push — which `base-sync.ts`'s own exit-9
  // row already spells out for a pass to follow. The tell was the
  // asymmetry: a conflict that still HAS findings arrives as
  // ROUND_READY (the live reviewer is a poller and reviews conflicting
  // heads) and that same merge happens inside the round. Only the
  // no-work case was handed back, and only because no triage came with
  // it.
  //
  // So: spend the conflict-repair budget first, and fall through to the
  // original stop — message unchanged — once it is gone.
  //
  // Read the base name out of the STATUS REPORT drive-status.ts already
  // fetched, rather than a second, ungated `gh pr view` call. Two
  // problems with that second call: it carries no deadline of its own,
  // so a stalled connection could keep this script from ever emitting
  // the fix and exiting 9 — the one thing this branch exists to
  // guarantee; and a failed/timed-out read silently fell back to a
  // guessed default, handing an operator a concrete `git merge` command
  // for the WRONG branch on a release or stacked PR.
  // Reusing the report needs no network call at all, so there is
  // nothing left to fail.
  const base = String(
    (status.base as Record<string, unknown> | undefined)?.refName ?? "",
  );
  const conflictBudget = conflictRepairRounds();
  if (
    context.conflictRepairs < conflictBudget &&
    // An unreadable base name does NOT spend repair budget — the same
    // fail-closed rule the CI side applies to a verdict naming no
    // failing check. This branch exists precisely because guessing
    // `develop` handed an operator a concrete, wrong command on a
    // release or stacked PR; dispatching a pass with an empty base
    // would make the same guess one level further away, where the
    // operator cannot see it being made.
    base !== ""
  ) {
    const repairExit = await attemptConflictRepair(
      context,
      base,
      conflictBudget,
      reasonLine,
    );
    if (repairExit !== undefined) return repairExit;
  }
  console.error(
    `PR #${context.pr} conflicts with its base and has nothing left to work — stopping.`,
  );
  console.error(reasonLine);
  if (base !== "") {
    console.error(
      `  Fix: ${conflictFixCommands(base)}, resolve, run the gates, push.`,
    );
  } else {
    console.error(
      "  Fix: merge this PR’s base branch in, resolve, run the gates, push. (base branch name unavailable from the status report — check the PR directly rather than guessing one)",
    );
  }
  return 9;
}

async function attemptConflictRepair(
  context: DriveRoundContext,
  base: string,
  conflictBudget: number,
  reasonLine: string,
): Promise<number | "continue" | undefined> {
  if (context.dryRun || context.agent.length === 0) {
    console.error(
      `(dry-run) would run a conflict-resolution pass against ${fixRemote()}/${base}`,
    );
    return 9;
  }
  const mailboxBeforeConflictRepair = await context.mailboxCheckpoint();
  if (typeof mailboxBeforeConflictRepair === "number")
    return mailboxBeforeConflictRepair;
  if (mailboxBeforeConflictRepair === "resumed") return "continue";
  console.error(
    `PR #${context.pr} conflicts with its base and has nothing left to work.`,
  );
  console.error(reasonLine);
  console.error(
    // A peek, not a charge — see the CI-repair call site's own
    // comment for why.
    `  Running conflict-resolution pass ${context.conflictRepairs + 1}/${conflictBudget} (DRIVE_PR_CONFLICT_REPAIR_ROUNDS=${conflictBudget}; 0 stops here instead).`,
  );
  const resolve = await runRepairPass(
    context.agent,
    context.held,
    "conflict-resolve",
    base,
    context.mailboxCheckpoint,
  );
  // Same mailbox handling as the CI-repair call site above — see its
  // own comments for why.
  if (!resolve.dispatched) {
    if (resolve.resumed) return "continue";
    return resolve.code;
  }
  // Confirmed dispatch — NOW commit the charge.
  context.conflictRepairs += 1;
  const resolveCode = resolve.code;
  if (driverRuntime.compromised !== "") {
    await rejoinConflictTakeover(context);
    return "continue";
  }
  // Same post-pass mailbox precedence as the CI-repair call site
  // above — see its own comment for why.
  if (resolve.postPassMailboxExit !== null) return resolve.postPassMailboxExit;
  // Same PR_NOT_OPEN preservation as the CI-repair call site above —
  // see its own comment for why.
  if (resolveCode === 5) {
    console.error(
      `PR #${context.pr} stopped being open during the conflict-resolution pass; stopping.`,
    );
    return 5;
  }
  if (resolveCode === 0) return "continue";
  console.error(
    "the conflict-resolution pass failed; stopping with the manual fix below.",
  );
  return undefined;
}

async function rejoinConflictTakeover(
  context: DriveRoundContext,
): Promise<void> {
  // Rejoin the takeover stop before continuing to the next round gate.
  if (
    driverRuntime.passStopWitness !== null &&
    !(await driverRuntime.passStopWitness)
  ) {
    context.held.length = 0;
  }
}
