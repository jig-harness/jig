/** Dispatch one charged CI-repair pass on a converged head and read its end. */
import { recordCiAttempt } from "./ci-attempt-record.ts";
import {
  type CiAttempts,
  chargeRepair,
  repairSelection,
} from "./ci-attempts.ts";
import { failedRunsToTell, failedStatusesToTell } from "./failed-runs.ts";
import type { FailingChecks } from "./infra-recovery.ts";
import { ciRepairSkillSetting } from "./../overlay.ts";
import { type RepairCi, runRepairPass } from "./repair.ts";
import type { DriveRoundContext } from "./round-context.ts";
import { driverRuntime } from "./runtime.ts";

/**
 * What a CI-repair pass is told beside its detail: the failed runs, the
 * failing commit statuses and the repository's CI-repair skill. `null` once
 * an invalid `ci.repair_skill` has been reported: the drive stops.
 */
export async function repairChannel(
  pr: string,
  failing: FailingChecks,
): Promise<RepairCi | null> {
  const skill = ciRepairSkillSetting();
  if (!skill.ok) {
    console.error(
      `could not read the CI-repair skill: ${skill.failure.reason}`,
    );
    return null;
  }
  if (skill.value !== undefined)
    console.error(`  The pass loads the CI-repair skill ${skill.value}.`);
  return {
    failedRuns: await failedRunsToTell(pr, failing.runs),
    failedStatuses: failedStatusesToTell(failing.statuses),
    ...(skill.value === undefined ? {} : { repairSkill: skill.value }),
  };
}

/**
 * A lock takeover ended the repair pass. Re-join the SAME witness the
 * ordinary-pass path joins on its own `compromised` branch: the takeover
 * stopped this repair pass from a TIMER callback, which could not wait, so
 * `passStopWitness` is the only place that wait is still live. Clearing
 * `held` on an unwitnessed termination is what keeps the loop-top
 * `compromised` check from releasing a lock over a repair descendant that
 * may still be running.
 */
export async function afterTakeover(
  context: DriveRoundContext,
): Promise<"continue"> {
  if (
    driverRuntime.passStopWitness !== null &&
    !(await driverRuntime.passStopWitness)
  )
    context.held.length = 0;
  return "continue";
}

/**
 * Run the repair pass for `failing` and charge it once it dispatched: a
 * charge is committed only after `runRepairPass` confirms the dispatch, so no
 * abort path needs a refund.
 */
export async function runChargedRepair(
  context: DriveRoundContext,
  head: string,
  failing: FailingChecks,
  attempts: CiAttempts,
  failingNames: string,
  told: RepairCi,
): Promise<number | "continue"> {
  const repair = await runRepairPass(
    context.agent,
    context.held,
    "ci-repair",
    failingNames,
    context.mailboxCheckpoint,
    told,
  );
  // The pass's own pre-spawn checkpoint resumed a pause (re-gate from the
  // top) or ended the drive (stop, pause timeout, unreadable, a takeover):
  // nothing was dispatched, so nothing was charged.
  if (!repair.dispatched) return repair.resumed ? "continue" : repair.code;
  context.ciRepairs += 1;
  const charges = chargeRepair(head, failing, attempts);
  const charged = `head ${head}: ${charges.map((charge) => `${charge}/${context.ciRepairBudget}`).join(", ")}`;
  console.error(`  Charged CI repair for ${charged}.`);
  await recordCiAttempt(context.pr, "repair", charged);
  // A lock takeover outranks any exit the mailbox reports, and a directive
  // seen right after the pass outranks the pass's own result; the charge
  // stands either way, since the pass ran.
  if (driverRuntime.compromised !== "") return await afterTakeover(context);
  if (repair.postPassMailboxExit !== null) return repair.postPassMailboxExit;
  // `guarded-push.ts` exits 5 inside the pass when the pull request merged or
  // closed: report that, not a CI stop nobody can push a fix to.
  if (repair.code === 5) {
    console.error(
      `PR #${context.pr} stopped being open during the CI-repair pass; stopping.`,
    );
    return 5;
  }
  if (repair.code !== 0) {
    if (
      context.held.length > 0 &&
      repairSelection(head, failing, attempts, context.ciRepairBudget).names
        .length === 0
    )
      return "continue";
    console.error("the CI-repair pass failed; stopping for /fix-ci by hand.");
    return 1;
  }
  // Re-gate rather than re-check CI here: a repair that pushed moved the head,
  // which makes every piece of evidence gathered under `reviewedHead` stale,
  // and the top of the loop is the only place entitled to rebuild it. A
  // repair that pushed nothing lands back on the same verdict and spends the
  // next unit of budget, which is what the budget is for.
  return "continue";
}
