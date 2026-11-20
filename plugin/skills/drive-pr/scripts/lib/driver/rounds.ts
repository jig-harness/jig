/** Initialize per-drive counters and repeat the round coordinator until it returns a terminal verdict. */
import type { DriveLock } from "./locks.ts";

import type { MarkReady } from "./../pr-policy.ts";

import { isDigits } from "./../cli.ts";

import {
  ciRepairRounds,
  finalCiWitnessPolls,
  FINAL_CI_POLL_SECONDS,
  finalRegateLimit,
  releaseProofAttempts,
} from "./settings.ts";

import { FinalCiWait } from "./../final-ci-wait.ts";

import { statusViewFlags } from "./final-regate.ts";

import { infraRecoveryBudget } from "./infra-recovery.ts";

import { mailboxCheckpointOrExit } from "./mailbox.ts";

import type { DriveRoundContext } from "./round-context.ts";

import { runRoundIteration } from "./round-step.ts";

import { clearDeadlineRetries, prReadsClosed } from "./restart.ts";

import { ledgerRenewal } from "./ledger.ts";
import {
  roundBoundaryTakeoverCheck,
  standDownOnNewerClaim,
} from "./takeover-check.ts";

interface DriverRoundOptions {
  pr: string;
  mailboxDir: string;
  /** This driver's generation, which an addressed mailbox `stop` names. */
  generation: number;
  keepDraft: boolean;
  dryRun: boolean;
  agent: string[];
  held: DriveLock[];
  maxRoundsN: number;
  forward: string[];
  probeFlags: string[];
  markReadyPolicy: MarkReady;
  /** `drive.pass_deadline_retries`, resolved before the locks were taken. */
  deadlineRetryBudget: number;
  /** What the first pass is told: a takeover, the answers a re-arm read, the stop it was armed after. */
  firstPassNotice: string;
  settleWorktree?: boolean;
  /** The tree's edits at arm are a stalled or deadline-stopped drive's, which this drive finishes (`stop-pickup.ts`). */
  inheritsEdits?: boolean;
}

export async function runDriverRounds({
  pr,
  mailboxDir,
  generation,
  keepDraft,
  dryRun,
  agent,
  held,
  maxRoundsN,
  forward,
  probeFlags,
  markReadyPolicy,
  deadlineRetryBudget,
  firstPassNotice,
  settleWorktree = false,
  inheritsEdits = false,
}: DriverRoundOptions): Promise<number> {
  const passes = 0;
  // Whether THIS run fired the draft→Ready transition. Not the durable claim —
  // that answers "has it ever been marked", which is the wrong question for a
  // convergence report. What the operator needs to know is that the reviewers
  // which skip drafts were summoned moments ago and have not answered yet, and
  // that is true only of the run that did the summoning.
  const markedReadyThisRun = false;
  // Whether the transition was left in ANOTHER driver's hands. Reported
  // separately from `markedReadyThisRun` because it is a different fact with a
  // different consequence: nobody has been summoned yet, and whether they ever
  // are depends on a driver this one cannot see.
  const readyLeftToOtherDriver = false;
  // Whether the owner converted an already-Ready PR to draft in the window
  // before this drive's own --record-only read — a DIFFERENT unsettled shape
  // than `readyLeftToOtherDriver`: no other driver is involved, so the
  // "another driver holds the lease" message would be wrong here. Reported
  // separately so each gets its own accurate stderr line while both share the
  // same non-terminal exit.
  const readyFlippedToDraftBeforeRecord = false;
  // Whether the CONVERGED-with-no-round-to-run branch has already re-gated
  // once for a STABLE mark-ready.ts outcome (`already-ready` /
  // `already-marked`). That branch never runs a round, so it never touches
  // `passes`/`--max-rounds` the way case 0 (ROUND_READY) does — nothing else
  // bounds a loop that keeps re-entering it. A genuinely unmoved head
  // answers CONVERGED with the same stable outcome every time, so one extra
  // gate call closes the TOCTOU window this re-gate exists for; a second
  // `continue` from this exact spot would buy nothing further and spin
  // forever on a head that never changes.
  const reGatedForStableMarkReadyOutcome = false;
  // Consecutive post-round transitions that failed. A single failure is not a
  // reason to abandon a productive drive — the lease is released, so the next
  // round retries — but a PERMANENTLY failing one (an unwritable state store, a
  // revoked token) would otherwise run silently to `--max-rounds` with the PR
  // still a draft — the gap of ignoring `rc.code` entirely.
  const readyMarkFailures = 0;
  // Stall guard: consecutive
  // ROUND_READY gates reading an identical fingerprint mean the passes between
  // them completed (exit 0) while changing nothing — the exact shape of a pass
  // that stands down every round, which no other counter here distinguishes
  // from progress. `counted` never grows on an unmoved head, `attempts` only
  // bounds it at the full --max-rounds budget, and the round headers look
  // healthy throughout (measured: five wasted rounds on one PR, ten on
  // another — and the first then merged over six live findings because the
  // log read as driven).
  // The threshold is deliberately small: ONE no-op round can be a legitimate
  // blip, but a second identical one will not improve by itself, because the
  // next pass is the same command against the same world.
  const stallRoundsRaw = process.env.DRIVE_PR_STALL_ROUNDS ?? "2";
  const stallRounds = isDigits(stallRoundsRaw)
    ? Number.parseInt(stallRoundsRaw, 10)
    : 2;
  const prevFingerprint: string | null = null;
  const noopRounds = 0;
  // Repair-round budgets. In-memory for the reason `ciRepairRounds`
  // documents — a new `DriveState` field would refuse every stored state written
  // before it existed, stopping the whole fleet's in-flight drives — and on
  // the `noopRounds` precedent directly above, whose reset-across-restarts
  // semantics operators already know from the skill's `README.md`.
  //
  // The CI budget is read ONCE, here, rather than per-iteration: the "how many
  // have I spent" counter and the bound it is compared against must come from
  // the same reading, or an operator editing the environment mid-drive could
  // move the goalposts under a partially-spent budget. (The conflict budget is
  // read at its own single use site, which is reached at most once per
  // iteration and compared against its counter in the same expression.)
  const ciRepairBudget = ciRepairRounds();
  const ciRepairs = 0;
  const ciInfra = infraRecoveryBudget();
  const conflictRepairs = 0;
  // Consecutive "converged, nothing failing, but no fresh required-check
  // witness" polls — bounded for the reason that branch documents. `0`
  // disables the bound and restores the unbounded wait.
  const witnessWaitLimit = finalCiWitnessPolls();
  const witnessWaits = 0;
  // The head `witnessWaits` is counting against — see the reset at its own
  // branch for why the count is per-head rather than per-drive.
  const witnessWaitHead = "";
  // A successful unlabel whose timeline witness stays unreadable otherwise
  // re-enters convergence forever without charging a round or witness poll.
  const releaseProofWaits = 0;
  const releaseProofKey = "";
  const releaseProofWaitLimit = releaseProofAttempts();
  const finalCiWait = new FinalCiWait(
    pr,
    undefined,
    undefined,
    FINAL_CI_POLL_SECONDS * 1000,
  );
  const mailboxOnly = (): Promise<"clear" | "resumed" | number> =>
    mailboxCheckpointOrExit(
      { dir: mailboxDir, pr, generation },
      ledgerRenewal(pr),
    );
  // The claim check only before a pass, not on every checkpoint: a quota
  // wait polls the mailbox every few seconds for hours, and the claims are a
  // forge read.
  const mailboxCheckpoint = async (opts?: {
    beforePass?: boolean;
  }): Promise<"clear" | "resumed" | number> => {
    const outcome = await mailboxOnly();
    if (outcome !== "clear" || opts?.beforePass !== true) return outcome;
    return (await standDownOnNewerClaim(pr)) ?? outcome;
  };
  const context: DriveRoundContext = {
    settleWorktree,
    prevFingerprint,
    noopRounds,
    readyMarkFailures,
    passes,
    conflictRepairs,
    pr,
    keepDraft,
    markedReadyThisRun,
    reGatedForStableMarkReadyOutcome,
    readyLeftToOtherDriver,
    readyFlippedToDraftBeforeRecord,
    finalCiWait,
    witnessWaits,
    releaseProofWaits,
    releaseProofKey,
    releaseProofWaitLimit,
    ciRepairs,
    ciRepairBudget,
    ciInfra,
    dryRun,
    agent,
    passIdentity: null,
    mailboxCheckpoint,
    roundBoundaryTakeoverCheck: roundBoundaryTakeoverCheck(pr),
    held,
    witnessWaitHead,
    witnessWaitLimit,
    statusView: statusViewFlags(forward),
    finalRegates: 0,
    finalRegateKey: "",
    finalRegateLimit: finalRegateLimit(),
    maxRoundsN,
    deadlineRetryBudget,
    stallExtraRound: false,
    stallNarrative: null,
    passNotice: "",
    carriedNotice: firstPassNotice,
    inheritedHead: "",
    unpushedNotice: "",
    uncommittedMeasured: null,
    // Edits found at arm are left alone as a person's, unless the drive is
    // armed after a stall that left them: then none were there before it.
    uncommittedBeforePass: inheritsEdits ? "" : null,
    inheritsOperation: inheritsEdits,
  };
  for (;;) {
    {
      const stage = await runRoundIteration(
        context,
        forward,
        probeFlags,
        stallRounds,
        markReadyPolicy,
      );
      if (stage === "continue") continue;
      if (stage === null) continue;
      return dryRun ? stage : await endDrive(pr, stage);
    }
  }
}

/**
 * The drive is over once it converged or the PR closed: its pass-deadline
 * restarts stop counting against a later drive. A stop 5 clears the count only
 * when a read confirms the closure, since a pass can exit 5 on its own. A count
 * that could not be cleared ends the drive as a failure, so it is not reported
 * over as an ordinary end.
 */
async function endDrive(pr: string, stage: number): Promise<number> {
  if (stage !== 0 && stage !== 5) return stage;
  if (stage === 5 && !(await prReadsClosed(pr))) return stage;
  return (await clearDeadlineRetries(pr)) ? stage : 1;
}
