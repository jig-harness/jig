/** Read the converged round's final status with the gate's view, and bound the re-gates its disagreements take. */
import type { DriveRoundContext } from "./round-context.ts";

/** The forwarded flags that only pace `drive-status.ts`'s polling, each with its value. */
const POLL_FLAGS = new Set(["--timeout", "--interval"]);

/**
 * The drive's forwarded status flags that shape what `drive-status.ts` judges:
 * `--bots-only` (which threads count) and `--no-head-sync` (whether the local
 * head is compared at all). `--timeout` and `--interval` are left out: they
 * pace a polling read, and a `--once` read never sleeps, while a `--timeout`
 * shorter than one evaluation would let the read skip its own steps and report
 * `INDETERMINATE`, a disagreement that is not evidence. The re-read's own
 * deadline is the caller's (`driveStatusOnceTimeoutSeconds`).
 */
export function statusViewFlags(forward: readonly string[]): string[] {
  const view: string[] = [];
  for (let index = 0; index < forward.length; index++) {
    const flag = forward[index] as string;
    if (POLL_FLAGS.has(flag)) index += 1;
    else view.push(flag);
  }
  return view;
}

/**
 * The final re-read's arguments: one evaluation that counts no round, seen
 * through the same view as the round gate, the inherited head included. A
 * thread the view leaves out (a person's, under `--bots-only`) is then outside
 * both reads, so it can never read as a change between them.
 */
export function finalReadArgs(context: DriveRoundContext): string[] {
  const inherited =
    context.inheritedHead === ""
      ? []
      : ["--inherited-head", context.inheritedHead];
  return [
    context.pr,
    "--json",
    "--once",
    "--no-count",
    ...context.statusView,
    ...inherited,
  ];
}

/** The re-read agreed with the gate: a later disagreement starts a new streak. */
export function finalReadAgrees(context: DriveRoundContext): void {
  context.finalRegates = 0;
  context.finalRegateKey = "";
}

/**
 * Count one disagreement against the bound; `true` once it is spent. The
 * streak is CONSECUTIVE on one head with no pass between: a new head, or a
 * pass that ran on a finding the gate then saw, starts it again, so only a
 * re-read that keeps seeing what the gate does not, round after round, reaches
 * the bound. `0` re-gates none.
 */
function finalRegateSpent(
  context: DriveRoundContext,
  reviewedHead: string,
): boolean {
  const key = `${reviewedHead} after ${context.passes} pass(es)`;
  if (key !== context.finalRegateKey) {
    context.finalRegateKey = key;
    context.finalRegates = 0;
  }
  context.finalRegates += 1;
  return context.finalRegates > context.finalRegateLimit;
}

/**
 * The re-read on the reviewed head (or one whose head did not read) did not
 * report `CONVERGED`: re-gate, as evidence that changed after the gate is
 * owed a round, until the bound is spent. Then stop with `1` (`INDETERMINATE`):
 * two reads of one head keep disagreeing, so the drive cannot tell which
 * holds, and another re-gate would only repeat them.
 */
export function finalReadDisagrees(
  context: DriveRoundContext,
  reviewedHead: string,
  finalStatus: Record<string, unknown>,
  finalCode: number,
): "continue" | number {
  const state = String(finalStatus.state ?? "") || "no readable state";
  const reason = String(finalStatus.reason ?? "") || "(no reason given)";
  const saw = `${state} (exit ${finalCode}): ${reason}`;
  if (!finalRegateSpent(context, reviewedHead)) {
    console.error(
      `review evidence changed while final CI freshness was established: the re-read saw ${saw}; re-gating (${context.finalRegates} of ${context.finalRegateLimit} on head ${reviewedHead})`,
    );
    return "continue";
  }
  console.error(
    `review converged, but the final status re-read disagreed with the round gate on head ${reviewedHead} ${context.finalRegates} time(s) in a row; stopping instead of another re-gate.`,
  );
  console.error(`  The round gate read CONVERGED; the re-read saw ${saw}`);
  console.error(
    "  Both reads judge one view (the drive's own --bots-only and --no-head-sync, and its inherited head), so what differs is the evidence on the pull request, or a read that keeps failing.",
  );
  console.error(
    `  Run 'drive-status.ts ${finalReadArgs(context).join(" ")}' to see what it names; answer or resolve that (a thread, a finding, a parked item), or repair the read, then re-arm. ($DRIVE_PR_FINAL_REGATE_LIMIT=${context.finalRegateLimit} re-gates per head.)`,
  );
  return 1;
}
