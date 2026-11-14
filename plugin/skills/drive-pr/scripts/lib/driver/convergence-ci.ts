import { specialCiDisposition } from "./special-ci.ts";
/** Release held CI, establish fresh evidence, repair actionable failures and bound witness polling. */

import type { DriveRoundContext } from "./round-context.ts";
import { recoverCancelledOnHead } from "../cancelled-recovery-live.ts";

import {
  run,
  tsArgv,
  ciHoldTimeoutSeconds,
  driveStatusOnceTimeoutSeconds,
} from "./../proc.ts";

import { ciHold, driveStatus } from "./paths.ts";

import { sleep } from "./../cli.ts";

import {
  CI_REPAIR_SPENT_EXIT,
  UNLABEL_SETTLE_SECONDS,
  FINAL_CI_POLL_SECONDS,
} from "./settings.ts";

import { span } from "./../../../../../shared/trace.ts";

import { ciPolicy } from "./../ci-policy.ts";

import { failedRunsToTell, failedStatusesToTell } from "./failed-runs.ts";
import { ciRepairSkillSetting } from "./../overlay.ts";

import { type RepairCi, runRepairPass } from "./repair.ts";
import { announcePolicyBase } from "./policy-base.ts";

import type { FailingChecks } from "./infra-recovery.ts";

import { driverRuntime } from "./runtime.ts";
import { attemptsFor, chargeRepair, repairSelection } from "./ci-attempts.ts";
import {
  beforeRepairRecovery,
  pendingRetryDisposition,
} from "./ci-recovery.ts";
import { recordCiAttempt } from "./ci-attempt-record.ts";

export async function releaseAndReadFinalCi(
  context: DriveRoundContext,
  reviewedHead: string,
): Promise<
  | number
  | "continue"
  | {
      finalStatus: Record<string, unknown>;
      finalStatusRes: Awaited<ReturnType<typeof run>>;
      finalVerdict: string;
      finalCi: Awaited<ReturnType<typeof run>>;
      finalCiSignals: Awaited<
        ReturnType<DriveRoundContext["finalCiWait"]["prime"]>
      >;
    }
> {
  // Intermediate synchronize pushes ran under the CI hold, when the
  // repository has one (`ci.hold_label`; without it `release` prints
  // `disabled` and nothing below waits on an unlabel). Release only
  // after convergence, the clean-tree certification, and the Ready
  // transition above have all settled. `ci-hold.ts` compares the
  // persisted labelled timeline-event id before removing anything, and
  // adopts a live label it holds no record of, then removes it.
  const finalCiSignals = await context.finalCiWait.prime();
  const release = await run(
    tsArgv(ciHold, ["release", context.pr, "--expect-head", reviewedHead]),
    { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
  );
  if (release.code === 5) return 5;
  if (release.code === 4) {
    console.error(
      "review converged, but the head moved or the CI hold label changed during its release; not reporting merge-ready",
    );
    return 4;
  }
  if (release.code !== 0) {
    console.error(
      `review converged, but releasing the CI hold label failed (exit ${release.code})`,
    );
    return 1;
  }
  if (release.stdout.trim() === "removed") {
    // The current status snapshot predates the `unlabeled` event. It may
    // still call old skipped runs green, so it cannot participate in the
    // final decision. Let GitHub schedule the unlabel-triggered workflows
    // and re-read all evidence from the top.
    console.error(
      "CI hold label removed; waiting for full CI on the converged head",
    );
    await sleep(UNLABEL_SETTLE_SECONDS);
    return "continue";
  }

  const finalCi = await span("ci.wait", {}, () =>
    run(
      tsArgv(ciHold, [
        "final-ready",
        context.pr,
        "--expect-head",
        reviewedHead,
      ]),
      { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
    ),
  );
  if (finalCi.code === 5) return 5;
  // What used to stand here read `status.ci` — the PRE-UNLABEL
  // snapshot, which the comment forty lines above this one already
  // declares unusable for the final decision ("cannot participate") —
  // and retried on it. `final-ready` returns 4 for BOTH "the fresh
  // required check has not landed yet" and "it landed and is settled
  // red", because it does not distinguish them: a post-unlabel
  // `detect-changes` failure cascades `code-quality-and-build`/`tests`
  // into `skipped`, which `completedRequiredCi()` correctly refuses to
  // accept as fresh evidence. So a genuinely-red converged head slept
  // ten seconds and looped, forever, never reaching the fresh
  // `finalVerdict` branch below that would have decided it correctly.
  //
  // Exit 4 therefore no longer decides anything on its own. It FALLS
  // THROUGH to the fresh evidence, and only re-takes the wait once that
  // evidence has positively ruled out a failure — see the deferred
  // `finalCi.code === 4` check below `finalVerdict`.
  if (finalCi.code !== 0 && finalCi.code !== 4) {
    console.error(
      `could not establish final CI freshness (exit ${finalCi.code})`,
    );
    return 1;
  }
  const finalStatusRes = await run(
    tsArgv(driveStatus, [context.pr, "--json", "--once", "--no-count"]),
    { stderr: "inherit", timeoutSec: driveStatusOnceTimeoutSeconds() },
  );
  let finalStatus: Record<string, unknown> = {};
  try {
    finalStatus = JSON.parse(finalStatusRes.stdout) as Record<string, unknown>;
  } catch {
    finalStatus = {};
  }
  const finalVerdict = String(finalStatus.ci ?? "");
  // A fresh witness was just confirmed: `witnessWaits` is documented as
  // counting a CONSECUTIVE unwitnessed streak on one head, but used to
  // reset only on a head change. A same-head sequence — several `finalCi.code === 4`
  // polls, then `code === 0` while an unrelated non-required check is
  // still pending (the branch below loops on it), then a required
  // check rerun returns `code === 4` again — resumed the earlier
  // count instead of starting a fresh streak, so the bound could trip
  // well short of its configured duration. `finalCi.code === 0` at
  // this point means final-ready positively established a fresh
  // required witness, so the streak is broken here regardless of
  // which head it is on. Except on a `cancelled:` verdict: without a hold,
  // final-ready counts a cancelled required check as completed, so its
  // `code === 0` witnesses nothing and must not restart the bound on it.
  if (finalCi.code === 0 && !finalVerdict.startsWith("cancelled:")) {
    context.witnessWaits = 0;
  }

  return { finalStatus, finalStatusRes, finalVerdict, finalCi, finalCiSignals };
}

export async function checkFinalCiStatus(
  finalStatus: Record<string, unknown>,
  reviewedHead: string,
  finalStatusRes: Awaited<ReturnType<typeof run>>,
  finalVerdict: string,
  finalCi: Awaited<ReturnType<typeof run>>,
  context: DriveRoundContext,
  finalCiSignals: Awaited<
    ReturnType<DriveRoundContext["finalCiWait"]["prime"]>
  >,
): Promise<
  | number
  | "continue"
  | {
      finalFailingNames: string[] | null;
      finalFailingCheckRunNames: string[] | null;
      finalFailingStatusNames: string[] | null;
    }
> {
  // The STRUCTURED counterpart to `finalVerdict`: `finalVerdict` is a
  // rendered, delimiter-joined string, so re-splitting it on `,`/`;`
  // cannot round-trip a check name that itself contains either
  // character. `Array.isArray` here is the same defensive read every
  // other array field off this JSON boundary uses (see
  // `roundFingerprint` above) — an absent or malformed field degrades
  // to `null`, never to a guessed `[]` that would silently read as
  // "nothing failing".
  const finalFailingNamesRaw = finalStatus.failingCheckNames;
  const finalFailingNames = Array.isArray(finalFailingNamesRaw)
    ? finalFailingNamesRaw.filter(
        (name): name is string => typeof name === "string",
      )
    : null;
  // The CHECK-RUN-ONLY subset:
  // `completedRequiredCi()` (ci-hold.ts) establishes freshness from
  // check-runs alone — it has no notion of a commit status at all — so
  // the ambiguity `finalCi.code === 4` encodes can only ever apply to a
  // name in THIS array. `finalFailingNames` above merges in legacy
  // commit-status contexts with no provenance, so testing a required
  // name against IT ALONE would let a genuinely fresh, currently
  // failing legacy status context that happens to share a required
  // check's name be misclassified as merely "possibly stale" below.
  const finalFailingCheckRunNamesRaw = finalStatus.failingCheckRunNames;
  const finalFailingCheckRunNames = Array.isArray(finalFailingCheckRunNamesRaw)
    ? finalFailingCheckRunNamesRaw.filter(
        (name): name is string => typeof name === "string",
      )
    : null;
  // The COMMIT-STATUS-ONLY complement: `finalFailingNames` merges
  // check-run and commit-status names with no per-entry provenance, so
  // a required name that fails in BOTH sources under the identical
  // name — e.g. a check-run named `Schema gate` whose freshness
  // `finalCi.code === 4` cannot confirm, alongside a legacy commit
  // status ALSO named `Schema gate` that is unambiguously fresh —
  // would satisfy `finalFailingCheckRunNames.includes(name)` for every
  // merged occurrence of that name, including the status-sourced one,
  // and read as wholly stale. Only a name ABSENT from this array
  // can safely be treated as purely check-run-sourced.
  const finalFailingStatusNamesRaw = finalStatus.failingStatusNames;
  const finalFailingStatusNames = Array.isArray(finalFailingStatusNamesRaw)
    ? finalFailingStatusNamesRaw.filter(
        (name): name is string => typeof name === "string",
      )
    : null;
  const finalRemoteHead = String(
    (finalStatus.head as Record<string, unknown> | undefined)?.api ?? "",
  );
  if (finalRemoteHead !== reviewedHead) {
    console.error(
      "review/head evidence changed while final CI freshness was established; re-gating",
    );
    return "continue";
  }
  // MUST be checked before interpreting or repairing the CI verdict
  // below: a live finding can land between the original convergence
  // decision and this re-read, which flips `finalStatus.state` off
  // `CONVERGED` while CI is still red from the held period. Checking
  // this only at the bottom of the verdict-handling chain (as before)
  // let a `failing:` verdict dispatch a `ci-repair` pass — whose
  // documented contract skips triage — over a head that actually has a
  // fresh, untriaged finding on it, leaving that finding unanswered.
  if (finalStatusRes.code !== 3 || finalStatus.state !== "CONVERGED") {
    console.error(
      "review evidence changed while final CI freshness was established; re-gating",
    );
    return "continue";
  }
  // Only the CONFIRMED-fresh case takes this short, unbounded poll:
  // `finalCi.code === 4` means final-ready could not yet witness a
  // fresh, completed REQUIRED check, and a `pending:` verdict under
  // that code is exactly the ambiguous state the bounded witness-wait
  // below exists for — a required check that never leaves
  // queued/in-progress must still trip
  // `DRIVE_PR_FINAL_CI_WITNESS_POLLS`, the same as a `skipped` one
  // does. Falling through here (rather than looping forever on this
  // branch) is what lets it reach that bound. `finalCi.code === 0`
  // means a fresh required witness already exists, so a `pending:`
  // verdict there names only an unrelated, non-required check still
  // running — genuinely unbounded polling is correct for that case,
  // unchanged.
  if (finalVerdict.startsWith("pending:") && finalCi.code !== 4) {
    console.error(
      `review converged; waiting for exact-head full CI (current verdict: ${finalVerdict})`,
    );
    context.finalCiWait.remember(reviewedHead, finalCiSignals, false);
    await sleep(FINAL_CI_POLL_SECONDS);
    return "continue";
  }

  return {
    finalFailingNames,
    finalFailingCheckRunNames,
    finalFailingStatusNames,
  };
}

export async function requiredFailureMayBeStale(
  context: DriveRoundContext,
  finalCi: Awaited<ReturnType<typeof run>>,
  finalFailingNames: string[] | null,
  finalFailingCheckRunNames: string[] | null,
  finalFailingStatusNames: string[] | null,
): Promise<number | "continue" | { staleRequiredFailure: boolean }> {
  // A REQUIRED check: `finalStatus.ci` is `ciVerdictOf()`'s "latest run
  // per check name", with no notion of the unlabel-event watermark
  // `final-ready` itself applies. Right after `ci:hold` is removed —
  // before any post-unlabel run has even STARTED — the newest run on
  // record for a required check can still be its deliberately-red
  // held-period one, and this would read that as a fresh `failing:`
  // verdict. `finalCi.code === 4` is exactly "final-ready could not
  // positively confirm freshness", which includes this case, so a
  // required check named in the verdict under that code is not yet
  // trustworthy either way — fall through to the SAME bounded
  // witness-wait below rather than repairing a
  // possibly-imaginary failure or stopping the drive over one. A
  // NON-required check in the same verdict (a `detect-changes` failure
  // cascading its dependents into `skipped`, the typical
  // case) carries no such ambiguity — final-ready says nothing
  // about it either way — so it is trusted immediately, unchanged.
  //
  // "The verdict is stale" therefore has to mean EVERY failing name is
  // a required one — `.every()`, not `.some()`. A `.some` would
  // treat a MIXED verdict (a stale required check alongside a
  // genuinely fresh non-required one, e.g. `failing: Schema gate,
  // detect-changes`) as wholly unreliable the moment any required name
  // appears in it, deferring the actionable non-required failure to
  // the witness wait right along with the ambiguous one — exactly the
  // case the comment above says must be trusted immediately. `length >
  // 0` guards the vacuous-truth trap: `.every()` on an empty array is
  // `true`, which would wrongly mark a verdict with no failing names
  // at all as "stale".
  //
  // Read from `failingCheckNames` — the structured array `evaluate.ts`
  // now publishes alongside the rendered `ci` string — never by
  // re-splitting `finalVerdict` on `,`/`;`: a failing check whose own
  // name contains either delimiter cannot round-trip through that
  // split, so a fragment of it could coincidentally match a required
  // name exactly.
  //
  // Every entry must ALSO be present in `finalFailingCheckRunNames`:
  // membership in the required checks alone is a name test, blind to
  // whether the entry came from a check-run or a legacy commit status,
  // but `finalCi.code === 4`'s ambiguity is a check-run-freshness fact
  // only — `completedRequiredCi()` never reads a commit status. A
  // required name failing ONLY as a commit status (absent from the
  // check-run list) is therefore not stale-by-ambiguity at all, and
  // must not satisfy this predicate.
  //
  // And it must ALSO be ABSENT from `finalFailingStatusNames`: the
  // check above tests membership BY NAME, blind to provenance, so a
  // required name failing as BOTH a check-run AND a legacy commit
  // status under the identical name would otherwise satisfy it for
  // every merged occurrence — including the status-sourced one, which
  // carries no freshness ambiguity at all and must be treated as an
  // actionable failure regardless of what the check-run side is doing.
  let requiredChecks: readonly string[];
  try {
    requiredChecks = (await ciPolicy(context.pr)).requiredChecks;
  } catch (error) {
    console.error(
      `could not read the required checks: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const staleRequiredFailure =
    finalCi.code === 4 &&
    finalFailingNames !== null &&
    finalFailingCheckRunNames !== null &&
    finalFailingStatusNames !== null &&
    finalFailingNames.length > 0 &&
    finalFailingNames.every(
      (name) =>
        requiredChecks.includes(name) &&
        finalFailingCheckRunNames.includes(name) &&
        !finalFailingStatusNames.includes(name),
    );

  return { staleRequiredFailure };
}

/**
 * What a CI-repair pass is told beside its detail: the failed runs, the
 * failing commit statuses and the repository's CI-repair skill. `null` once
 * an invalid `ci.repair_skill` has been reported: the drive stops.
 */
async function repairChannel(
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
async function afterTakeover(context: DriveRoundContext): Promise<"continue"> {
  if (
    driverRuntime.passStopWitness !== null &&
    !(await driverRuntime.passStopWitness)
  )
    context.held.length = 0;
  return "continue";
}

async function repairConvergedCi(
  finalVerdict: string,
  context: DriveRoundContext,
  failing: FailingChecks,
  head: string,
): Promise<number | "continue"> {
  const attempts = attemptsFor(context);
  const selection = repairSelection(
    head,
    failing,
    attempts,
    context.ciRepairBudget,
  );
  failing = selection.failing;
  if (selection.names.length === 0) return CI_REPAIR_SPENT_EXIT;
  finalVerdict = `failing: ${selection.names.join(", ")}`;
  const failingNames = finalVerdict.slice("failing:".length).trim();
  if (context.dryRun || context.agent.length === 0) {
    console.error(
      `(dry-run) would run a CI-repair pass for: ${failingNames || "<unnamed checks>"}`,
    );
    return 1;
  }
  const mailboxBeforeCiRepair = await context.mailboxCheckpoint();
  if (typeof mailboxBeforeCiRepair === "number") return mailboxBeforeCiRepair;
  if (mailboxBeforeCiRepair === "resumed") return "continue";
  console.error(
    `review converged, but the fresh non-reviewer CI verdict is '${finalVerdict}'.`,
  );
  console.error(
    // A peek, not a charge — `ciRepairs` is committed only once
    // `runRepairPass` confirms it actually dispatched, below: an
    // earlier revision charged before the call and refunded on an
    // abort path, which is exactly the charge-then-compensate shape
    // whose ABA gap this class of finding kept re-finding on the
    // durable `attempts` counter.
    // "Never charge until certain" needs no compensating action at
    // all — this line only has to DISPLAY the attempt number the
    // dispatch below, if it happens, will actually become.
    `  Running CI-repair pass ${selection.used + 1}/${context.ciRepairBudget} for ${selection.names.join(", ")} on head ${head} (DRIVE_PR_CI_REPAIR_ROUNDS=${context.ciRepairBudget}; 0 stops here instead).`,
  );
  // The repair dispatches ahead of the round's own refresh: resolve the
  // policy base again, for a pull request retargeted since.
  await announcePolicyBase(context.pr);
  const told = await repairChannel(context.pr, failing);
  if (told === null) return 1;
  const repair = await runRepairPass(
    context.agent,
    context.held,
    "ci-repair",
    failingNames,
    context.mailboxCheckpoint,
    told,
  );
  if (!repair.dispatched) {
    // The repair pass's OWN pre-spawn checkpoint (inside
    // runRepairPass, after its identity refresh) resumed a pause
    // without ever dispatching — re-gate from the top rather than
    // trusting this branch's now-stale snapshot.
    // Nothing to refund: `ciRepairs` was never charged for this
    // attempt in the first place.
    if (repair.resumed) return "continue";
    // Same checkpoint reporting stop/pause-timeout/unreadable/a lock
    // takeover: those are driver-ending answers, not repair-pass
    // failures, so return them as-is rather than falling into the
    // generic "pass failed" branch below.
    return repair.code;
  }
  // Confirmed dispatch — NOW commit the charge.
  context.ciRepairs += 1;
  const charges = chargeRepair(head, failing, attempts);
  const charged = `head ${head}: ${charges.map((charge) => `${charge}/${context.ciRepairBudget}`).join(", ")}`;
  console.error(`  Charged CI repair for ${charged}.`);
  await recordCiAttempt(context.pr, "repair", charged);
  const repairCode = repair.code;
  // Checked before `postPassMailboxExit` — a lock takeover means
  // this driver has already lost authority over the PR, which
  // outranks any exit code the mailbox checkpoint might report.
  if (driverRuntime.compromised !== "") return await afterTakeover(context);
  // A directive observed immediately after this pass completed —
  // outranks reporting the pass's own result, same as the
  // ordinary-pass path's own post-pass checkpoint. The charge above
  // already stands: the pass DID run.
  if (repair.postPassMailboxExit !== null) return repair.postPassMailboxExit;
  // Preserve PR_NOT_OPEN: `guarded-push.ts` exits 5 inside the pass
  // exactly like the ordinary-pass path's own push does, and
  // reporting a CI stop over a PR that already merged or closed sends
  // an operator to fix code nobody can push to anymore —
  // `passExitDisposition` exists to prevent exactly this for the
  // ordinary path, so the repair path must not silently drop the same
  // signal.
  if (repairCode === 5) {
    console.error(
      `PR #${context.pr} stopped being open during the CI-repair pass; stopping.`,
    );
    return 5;
  }
  if (repairCode !== 0) {
    console.error("the CI-repair pass failed; stopping for /fix-ci by hand.");
    return 1;
  }
  // Re-gate rather than re-check CI here. A repair that pushed moved
  // the head, which makes `reviewedHead` — and every piece of
  // evidence gathered under it, including the reviewer's own stamp —
  // stale. The top of the loop is the only place entitled to rebuild
  // all of it. A repair that pushed NOTHING lands back on this same
  // branch with the same verdict and spends the next unit of budget,
  // which is what the budget is for.
  return "continue";
}

/** Count one poll against the witness bound; `true` once it has run out. */
function witnessBoundSpent(
  reviewedHead: string,
  context: DriveRoundContext,
): boolean {
  // CONSECUTIVE ON ONE HEAD, not cumulative across the drive. A long
  // drive can legitimately reach this wait on several different heads
  // — once per convergence attempt — and a counter that never reset
  // would spend the budget a few polls at a time and then trip on a
  // later head that had barely waited at all. Keying the reset to the
  // head is what makes the bound mean "this head has been unwitnessed
  // for 30 minutes", which is the claim the give-up message makes.
  if (reviewedHead !== context.witnessWaitHead) {
    context.witnessWaitHead = reviewedHead;
    context.witnessWaits = 0;
  }
  context.witnessWaits += 1;
  // `0` means "wait forever", the older behaviour — so the
  // bound is checked only when one was actually asked for. Without
  // this guard `0` would read as the TIGHTEST possible bound and stop
  // on the first poll, inverting the knob.
  return (
    context.witnessWaitLimit > 0 &&
    context.witnessWaits > context.witnessWaitLimit
  );
}

/**
 * Recover an orphaned cancellation through the shared durable budget. A dry
 * run or a stale verdict without a current cancelled workflow uses the witness
 * bound; cancellation itself is never a code repair or passing evidence.
 */
async function waitForReplacement(
  reviewedHead: string,
  context: DriveRoundContext,
  finalVerdict: string,
  finalCiSignals: Awaited<
    ReturnType<DriveRoundContext["finalCiWait"]["prime"]>
  >,
): Promise<number | "continue"> {
  if (!context.dryRun) {
    const recovery = await recoverCancelledOnHead(context.pr, reviewedHead);
    if (recovery === "parked") return 8;
    if (recovery === "unknown") return 1;
    if (recovery === "wait") {
      await sleep(FINAL_CI_POLL_SECONDS);
      return "continue";
    }
  }
  if (witnessBoundSpent(reviewedHead, context)) {
    console.error(
      `review converged, but the verdict has stayed '${finalVerdict}': no run replaced the cancelled check(s) in ${Math.round((context.witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`,
    );
    console.error(
      "  A cancelled check is unknown: not a failure to repair, and not a pass. Run the workflow or build",
    );
    console.error(
      `  again on this head (the CI hold's release does; 'gh run rerun' of a run started under the hold replays its label),`,
    );
    console.error(
      `  then re-arm. ($DRIVE_PR_FINAL_CI_WITNESS_POLLS=${context.witnessWaitLimit}; 0 waits forever.)`,
    );
    return 4;
  }
  console.error(
    `review converged; waiting for a run to replace the cancelled check(s) (current verdict '${finalVerdict}')`,
  );
  context.finalCiWait.remember(reviewedHead, finalCiSignals, true);
  await sleep(FINAL_CI_POLL_SECONDS);
  return "continue";
}

async function waitForCiWitness(
  reviewedHead: string,
  context: DriveRoundContext,
  staleRequiredFailure: boolean,
  finalVerdict: string,
  finalVerdictPending: boolean,
  finalCiSignals: Awaited<
    ReturnType<DriveRoundContext["finalCiWait"]["prime"]>
  >,
): Promise<number | "continue"> {
  if (witnessBoundSpent(reviewedHead, context)) {
    console.error(
      staleRequiredFailure
        ? `review converged, but the only failing check(s) reported ('${finalVerdict}') are required checks final-ready could not confirm are fresh, and no fresh exact-head witness appeared in ${Math.round((context.witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`
        : finalVerdictPending
          ? `review converged, but the verdict has stayed '${finalVerdict}' with no fresh exact-head required-check witness for ${Math.round((context.witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`
          : `review converged and nothing is failing, but no fresh exact-head required-check witness appeared in ${Math.round((context.witnessWaitLimit * FINAL_CI_POLL_SECONDS) / 60)} minute(s).`,
    );
    console.error(
      "  A required check whose fresh run completed SKIPPED reads as passing to the aggregate",
    );
    console.error(
      "  verdict and as no witness at all here, and nothing later turns it into a success —",
    );
    console.error(
      "  so this can never resolve by waiting. Re-run the required checks on this head",
    );
    console.error(
      `  (a fresh run, NOT 'gh run rerun' of the old one — that replays the original payload),`,
    );
    console.error(
      `  then re-arm. ($DRIVE_PR_FINAL_CI_WITNESS_POLLS=${context.witnessWaitLimit}; 0 waits forever, as before.)`,
    );
    return 4;
  }
  console.error(
    staleRequiredFailure
      ? `review converged; waiting for a fresh exact-head required-check witness (current verdict '${finalVerdict}' names only a required check final-ready has not yet confirmed fresh)`
      : finalVerdictPending
        ? `review converged; waiting for a fresh exact-head required-check witness (current verdict '${finalVerdict}')`
        : "review converged; waiting for a fresh exact-head required-check witness (aggregate verdict is green)",
  );
  context.finalCiWait.remember(reviewedHead, finalCiSignals, true);
  await sleep(FINAL_CI_POLL_SECONDS);
  return "continue";
}

export async function evaluateFinalCi(
  finalVerdict: string,
  staleRequiredFailure: boolean,
  context: DriveRoundContext,
  finalCi: Awaited<ReturnType<typeof run>>,
  reviewedHead: string,
  finalCiSignals: Awaited<
    ReturnType<DriveRoundContext["finalCiWait"]["prime"]>
  >,
  failing: FailingChecks,
): Promise<number | "continue" | null> {
  const pending = await pendingRetryDisposition(context, reviewedHead);
  if (pending !== null) return pending;
  const special = await specialCiDisposition(
    finalVerdict,
    staleRequiredFailure,
    context,
    reviewedHead,
    failing,
    (verdict, ctx, failures) =>
      repairConvergedCi(verdict, ctx, failures, reviewedHead),
  );
  if (typeof special !== "object") return special;
  ({ finalVerdict, failing } = special);
  if (finalVerdict.startsWith("cancelled:"))
    return await waitForReplacement(
      reviewedHead,
      context,
      finalVerdict,
      finalCiSignals,
    );
  // POSITIVELY-NAMED failing checks, not merely "not green".
  // `unknown:` (commit statuses unreadable) and `''` (the status report
  // did not parse) are absences of evidence, not evidence of failure,
  // and a `/fix-ci` pass handed neither a run nor a check name has
  // nothing to work from. Those keep today's stop verbatim, below.
  //
  // A failure every one of whose checks failed on the infrastructure is
  // re-run first, whatever the repair budget: no code change fixes it, so it
  // spends no repair pass (`infra-recovery.ts`).
  const recovered = await beforeRepairRecovery(
    finalVerdict,
    staleRequiredFailure,
    context,
    reviewedHead,
    failing,
  );
  if (recovered !== null) return recovered;
  const selection = repairSelection(
    reviewedHead,
    failing,
    attemptsFor(context),
    context.ciRepairBudget,
  );
  if (
    finalVerdict.startsWith("failing:") &&
    !staleRequiredFailure &&
    selection.names.length > 0
  ) {
    return await repairConvergedCi(
      finalVerdict,
      context,
      failing,
      reviewedHead,
    );
  }
  // A `pending:` verdict is never a stop condition: it reaches here
  // only when `finalCi.code === 4` (the branch above let it through
  // deliberately), and it names a required check still
  // queued/in-progress, not a failure — the witness-wait branch just
  // below is what bounds the wait on it.
  const finalVerdictPending = finalVerdict.startsWith("pending:");
  if (
    finalVerdict !== "green" &&
    !staleRequiredFailure &&
    !finalVerdictPending
  ) {
    console.error(
      `review converged and the required checks ran, but the fresh non-reviewer CI verdict is '${finalVerdict || "unknown"}'; stopping for /fix-ci`,
    );
    // A spent budget is its own stop: the fix is a CI repair, which a
    // re-armed drive starts with a fresh budget, not a decision for a
    // person, and a caller reading the exit alone must tell it from a crash.
    if (finalVerdict.startsWith("failing:") && context.ciRepairBudget > 0) {
      console.error(
        `  (${selection.used} of ${context.ciRepairBudget} CI-repair pass(es) already run per failing check on head ${reviewedHead} — the budget is spent: exit ${CI_REPAIR_SPENT_EXIT}, CI_REPAIR_SPENT.)`,
      );
      return CI_REPAIR_SPENT_EXIT;
    }
    return 1;
  }
  // DEFERRED from above (widened by the required-check handling
  // above): either the aggregate verdict is green with nothing
  // failing, or it names only a REQUIRED check whose freshness this
  // same `finalCi.code === 4` already couldn't confirm — and either
  // way, `final-ready` could not witness a fresh, completed,
  // successful REQUIRED check on this exact head. That is the genuine
  // "the unlabel-triggered run has not landed yet" wait the old exit-4
  // branch was trying to express — reached now only once the fresh
  // evidence has positively ruled out a NON-required failure, rather
  // than standing in front of it.
  //
  // BOUNDED, unlike the branch it replaces. There is one state this
  // wait cannot escape on its own: a required check whose fresh run
  // completed `skipped` is PASSING to the aggregate verdict
  // (`PASSING_CONCLUSIONS` in `lib/status/evidence.ts` — deliberately,
  // a skipped job is not a failure) and NOT a witness to
  // `completedRequiredCi`, which wants a success. Nothing later turns a
  // skipped run into a successful one, so the two disagree forever and
  // the loop sleeps forever. The typical shape is a `detect-changes`
  // failure cascading its dependents into `skipped`; its RED half is
  // handled above by the fall-through, and this is the other
  // half, where nothing NON-required is red and there is
  // still no witness (a required check's OWN staleness is the other
  // way this can arrive here, per `staleRequiredFailure` above).
  //
  // Exit `4`, not a terminal code: the state is genuinely "not
  // judgeable yet", it is retry-safe, and an unattended wrapper's plain
  // re-run is the right response — a later drive re-reads CI from
  // scratch and may well find a witness a rerun produced. The bound is
  // generous (30 minutes by default) because a legitimately slow
  // unlabel-triggered run must never reach it.
  if (finalCi.code === 4) {
    return await waitForCiWitness(
      reviewedHead,
      context,
      staleRequiredFailure,
      finalVerdict,
      finalVerdictPending,
      finalCiSignals,
    );
  }

  return null;
}
