/**
 * What `ci-hold.ts ensure` does while the checks the hold waits for have not
 * completed on the head: recover a cancelled run, park a required check no
 * workflow run ever reported, or tell the caller to wait.
 */
import { recoverCancelledOnHead } from "./cancelled-recovery-live.ts";
import { recoveryExit } from "./cancelled-recovery-reads.ts";
import type { CheckRunLite } from "./ci-hold.ts";
import { stopOnMissingRequiredRun } from "./missing-required-run-live.ts";
import { MISSING_RUN_PARK_KEY } from "./missing-required-run.ts";
import { DRIVE_EXIT } from "./status/terminal-states.ts";

/** `ensure`'s exit code (and stdout outcome) for a head whose required checks are not all in. */
export async function waitOnUnobserved(
  pr: string,
  head: string,
  required: readonly string[],
  runs: readonly CheckRunLite[],
  afterUnlabel: boolean,
): Promise<number> {
  const recovery = await recoverCancelledOnHead(pr, head, required, true);
  const stop = recoveryExit(recovery);
  if (stop !== null) return stop;
  // A required check with no run at all never completes: past the grace
  // from the head's push it parks for a person instead of waiting.
  if (recovery === "none") {
    const missing = await stopOnMissingRequiredRun(pr, head, required, runs);
    if (missing === "parked") {
      process.stdout.write(`${MISSING_RUN_PARK_KEY}\n`);
      return DRIVE_EXIT.HITL_PARKED;
    }
    if (missing === "workflow-change") {
      process.stdout.write("workflow-change\n");
      return 0;
    }
  }
  console.error(
    afterUnlabel
      ? "ci-hold: the required checks triggered by the latest unlabel have not completed on this head; refusing to re-add the hold yet"
      : "ci-hold: the initial required checks have not completed on this head; waiting before suppressing intermediate CI",
  );
  return 4;
}
