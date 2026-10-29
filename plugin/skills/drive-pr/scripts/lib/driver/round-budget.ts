/** Read durable budgets, detect stalls and arm reflection without spending an undispatched attempt. */
import type { DriveRoundContext } from "./round-context.ts";

import {
  roundFingerprint,
  advanceStallStreak,
  STALLED_EXIT,
  MAX_ROUNDS_EXIT,
  reflectDutyArmed,
} from "./settings.ts";

import { loopEconomy, leftoverReport, severityWarnings } from "./reports.ts";

import { run, tsArgv } from "./../proc.ts";

import { fail, isDigits } from "./../cli.ts";

import { driveState } from "./paths.ts";

import { reflectDepthPastLast } from "./../state/schema.ts";

import { prepareQuotaSpawn } from "./../quota/index.ts";

import { passEnv } from "./repair.ts";

import { recordedDecisions, stallNotice } from "./restart.ts";

export async function checkRoundStall(
  status: Record<string, unknown>,
  context: DriveRoundContext,
  stallRounds: number,
): Promise<number | "continue" | null> {
  // The stall check runs HERE — after the gate said ROUND_READY, before this
  // gate spends anything (the pre-pass Ready record, the durable attempt
  // bump, the pass itself). The first iteration has no previous fingerprint,
  // and the only way back to this point is a completed pass, so an unchanged
  // fingerprint always indicts the pass that just ran. An unmeasurable gate
  // (null fingerprint) resets the streak rather than extending it — the
  // detector may only ever stop on positive evidence of sameness; anything
  // less falls through to the --max-rounds bound exactly as before.
  const fingerprint = roundFingerprint(status);
  context.noopRounds = advanceStallStreak(
    context.prevFingerprint,
    fingerprint,
    context.noopRounds,
  );
  context.prevFingerprint = fingerprint;
  if (context.noopRounds === 0) context.stallExtraRound = false;
  if (stallRounds > 0 && context.noopRounds >= stallRounds) {
    const diagnostics = stallDiagnostics(status, context);
    for (const line of diagnostics) console.error(line);
    // One more round before the stop, with these diagnostics in the pass's
    // notice: a pass that stood down for a reason it can see past once told
    // is the measured case, and a second identical gate after it stops.
    if (!context.stallExtraRound) {
      context.stallExtraRound = true;
      context.passNotice = stallNotice(diagnostics);
      console.error(
        "  Running ONE more round with these diagnostics in the pass notice before stopping.",
      );
      return null;
    }
    console.error(
      `  The extra round changed nothing either. Stopping rather than spending the rest of --max-rounds (${context.maxRoundsN})`,
    );
    console.error(
      `  on no-ops; fix why the passes did not act, then re-arm. ($DRIVE_PR_STALL_ROUNDS=${stallRounds}; 0 disables this stop.)`,
    );
    const decided = await recordedDecisions(context.pr);
    console.error(
      decided.length === 0
        ? "  What the passes decided: nothing recorded in the handoff narrative — read the pass output."
        : "  What the passes decided (the end of the handoff narrative):",
    );
    for (const line of decided) console.error(`    ${line}`);
    // WHY it stopped is above; WHAT it left behind is here. A pass can make
    // substantive, correct edits and still trip this stop by standing down
    // before committing them — the stall predicate keys on what the loop can
    // observe (head, threads, findings), and an uncommitted edit moves none
    // of those. `loopEconomy()` runs before `leftoverReport()` although it
    // prints after it, so the worktree is certified last, right before the
    // exit, and an edit landing during the network work is not missed.
    const economyReport = await loopEconomy(context.pr);
    process.stderr.write(await leftoverReport());
    process.stderr.write(economyReport);
    return STALLED_EXIT;
  }

  return null;
}

/** What the stalled passes left unchanged, as the stop and the notice print it. */
function stallDiagnostics(
  status: Record<string, unknown>,
  context: DriveRoundContext,
): string[] {
  const work = (status.work ?? {}) as Record<string, unknown>;
  // A count can be null per-field while the fingerprint still matched on
  // the other one; "?" reads as "unmeasured", which is what null means.
  const count = (v: unknown) => (typeof v === "number" ? String(v) : "?");
  const apiHeadShort = String(
    (status.head as Record<string, unknown> | undefined)?.api ?? "",
  ).slice(0, 12);
  return [
    `the last ${context.noopRounds} completed pass(es) on PR #${context.pr} changed NOTHING this loop can observe:`,
    `  head ${apiHeadShort} unmoved, ${count(work.unresolvedThreads)} unresolved thread(s) and`,
    `  ${count(work.summaryUnaddressed)} unaddressed summary finding(s), with ${count(work.parkedThreads)} thread(s)`,
    `  and ${count(work.parkedSummaryFindings)} summary finding(s) parked — identical before and after.`,
    "  The SAME thread ids and finding fingerprints, not merely the same totals —",
    "  nothing was resolved, addressed, parked or replaced, and local HEAD did not",
    "  move. A pass that exits 0 without acting — e.g. one that stood down after",
    "  mistaking its own parent driver for a competing drive — looks exactly like this.",
  ];
}

async function peekRoundState(
  peekRes: Awaited<ReturnType<typeof run>>,
  apiHead: string,
  context: DriveRoundContext,
): Promise<
  | number
  | "continue"
  | {
      peekedAttempts: number;
      peekedLastReflectedRound: number | undefined;
      peekedLastReflectedAttempts: number | undefined;
    }
> {
  let peekedAttempts = 0;
  let peekedLastReflectedRound: number | undefined | undefined;
  let peekedLastReflectedAttempts: number | undefined | undefined;
  try {
    const peeked = JSON.parse(peekRes.stdout) as {
      attempts?: unknown;
      attemptsHead?: unknown;
      lastReflectedRound?: unknown;
      lastReflectedAttempts?: unknown;
    };
    const priorAttempts =
      typeof peeked.attempts === "number" &&
      Number.isInteger(peeked.attempts) &&
      peeked.attempts >= 0
        ? peeked.attempts
        : null;
    peekedAttempts =
      peeked.attemptsHead === apiHead && priorAttempts !== null
        ? priorAttempts + 1
        : 1;
    // `lastReflectedRound` is untouched by a head change — `rounds` is
    // cumulative, not per-head, so no reset applies here.
    peekedLastReflectedRound =
      typeof peeked.lastReflectedRound === "number"
        ? peeked.lastReflectedRound
        : undefined;
    // `lastReflectedAttempts`, unlike `lastReflectedRound`, IS reset by a
    // head change — `bump-attempt`'s own head-change branch zeroes it in
    // the SAME atomic update that resets `attempts` to 1. Reading the
    // stored value unconditionally here left a stale baseline from the
    // PREVIOUS head in place after a head change — e.g. `peekedAttempts`
    // correctly reset to 1 while this stayed at 8 from the old head, so
    // `reflectDepthPastLast`'s `attempts - lastReflectedAttempts` computed
    // `1 - 8` instead of `1 - 0`, delaying the /reflect duty by however
    // many passes the old head had already reflected past.
    peekedLastReflectedAttempts =
      peeked.attemptsHead === apiHead &&
      typeof peeked.lastReflectedAttempts === "number"
        ? peeked.lastReflectedAttempts
        : undefined;
  } catch {
    // Fail closed: this `get` call already succeeded (checked above), so a
    // JSON parse failure here means drive-state.ts returned malformed
    // output for a request that otherwise worked — not an absence of
    // evidence to fail open on, the way an unreadable READ is treated
    // elsewhere. Leaving `peekedAttempts` at 0 let a
    // malformed-but-successful response under-count the round/max-rounds
    // check and dispatch another pass past the budget instead of enforcing
    // it.
    fail(1, `cannot parse durable state for PR #${context.pr}; stopping`);
  }

  return {
    peekedAttempts,
    peekedLastReflectedRound,
    peekedLastReflectedAttempts,
  };
}

export async function readRoundBudget(
  status: Record<string, unknown>,
  context: DriveRoundContext,
  reasonLine: string,
): Promise<
  | number
  | "continue"
  | {
      counted: number;
      peekedAttempts: number;
      peekedLastReflectedRound: number | undefined;
      peekedLastReflectedAttempts: number | undefined;
      round: number;
      apiHead: string;
    }
> {
  const apiHead = String(
    (status.head as Record<string, unknown> | undefined)?.api ?? "",
  );
  const countedRes = await run(tsArgv(driveState, ["rounds", context.pr]), {
    stderr: "inherit",
  });
  if (countedRes.code !== 0) {
    fail(
      1,
      `cannot read the durable round count for PR #${context.pr}; stopping`,
    );
  }
  // A NON-MUTATING peek at what this round's attempt count WOULD become.
  // The durable `bump-attempt` commit itself now happens only immediately
  // before the pass is actually dispatched, several awaits below — nothing
  // here may charge the budget yet, because everything between here and
  // dispatch can still abort without a pass ever running. An earlier
  // revision charged here and refunded on abort; that compensating refund
  // had its own correctness gaps (an ABA case on its compare-and-swap)
  // that a "never charge until certain" design does not need to defend
  // against at all. `get`, not `attempts` alone, because the peek must
  // know whether THIS head still matches the stored `attemptsHead` — a
  // head change resets the count to 1, exactly like `bump-attempt`'s own
  // reset branch. Also carries
  // `lastReflectedRound`/`lastReflectedAttempts` for the reflect-duty
  // check below, in the SAME read: a separate, later `get` call would
  // still be reading state from BEFORE this round's commit, understating
  // `reflectDepthPastLast` by exactly one round every time (caught in
  // testing after the restructuring away from charge-then-refund).
  const peekRes = await run(tsArgv(driveState, ["get", context.pr]), {
    stderr: "inherit",
  });
  if (peekRes.code !== 0) {
    fail(1, `cannot read durable state for PR #${context.pr}; stopping`);
  }
  const peekRoundStateResult = await peekRoundState(peekRes, apiHead, context);
  if (peekRoundStateResult === "continue") return "continue";
  if (typeof peekRoundStateResult !== "object") return peekRoundStateResult;
  const {
    peekedAttempts,
    peekedLastReflectedRound,
    peekedLastReflectedAttempts,
  } = peekRoundStateResult;
  const countedRaw = countedRes.stdout.trim();
  const counted = isDigits(countedRaw) ? Number.parseInt(countedRaw, 10) : 0;
  const round = Math.max(counted, peekedAttempts);
  if (counted > context.maxRoundsN || peekedAttempts > context.maxRoundsN) {
    console.error(
      `hit --max-rounds (${context.maxRoundsN}) on PR #${context.pr} without converging`,
    );
    console.error("This is a NON-CONVERGENCE report, not a quiet stop:");
    console.error(reasonLine);
    // The exhausted-budget exit is exactly where the economy matters most:
    // whatever the loop spent, it spent without finishing.
    process.stderr.write(await loopEconomy(context.pr));
    return MAX_ROUNDS_EXIT;
  }

  console.error(
    `--- round ${round}/${context.maxRoundsN} on PR #${context.pr} ---`,
  );
  console.error(reasonLine);
  process.stderr.write(await severityWarnings(context.pr));

  return {
    counted,
    peekedAttempts,
    peekedLastReflectedRound,
    peekedLastReflectedAttempts,
    round,
    apiHead,
  };
}

export async function prepareRoundPass(
  counted: number,
  peekedAttempts: number,
  peekedLastReflectedRound: number | undefined,
  peekedLastReflectedAttempts: number | undefined,
  round: number,
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  // Past the third round, a `/reflect` pass is due: rounds that keep
  // producing findings are evidence of a scaffolding or
  // reviewer-configuration gap, and the round that discovers it is worth
  // more than the round that patches one more instance. Waiting for
  // --max-rounds is too late — that is the bound, not the signal.
  //
  // A control loop cannot invoke a slash command, so this arms the PASS,
  // which can: the flag is exported into its environment (SKILL.md § 3
  // makes acting on it part of the round) and announced on stderr for the
  // human watching. It is a duty, not a gate — blocking here would strand
  // an unattended drive on a step only an agent can perform.
  const reflectAfterRaw = process.env.DRIVE_PR_REFLECT_AFTER ?? "3";
  const reflectAfter = isDigits(reflectAfterRaw)
    ? Number.parseInt(reflectAfterRaw, 10)
    : 3;
  // Measured forward from where a /reflect was LAST RECORDED
  // (drive-state.ts set-reflected), not from zero: a duty keyed on the
  // absolute round re-arms every round forever against a reflect that
  // already happened. `reflectDepthPastLast` is the shared predicate —
  // drive-status.ts derives the `reflectDue` report field from the same
  // function over the same durable state, which is what makes the duty fire
  // on interactive runs too and what stops the two answering differently
  // (this env var is the legacy transport for passes driven from here).
  //
  // Built from the EARLY peek above, not a fresh `get` here: a separate
  // read at this point would still be reading state from BEFORE this
  // round's own `bump-attempt` commit, which now happens only right before
  // dispatch — understating depth by exactly one round, every round, and
  // silently delaying the duty past its own threshold. `rounds` comes from
  // `countedRes` above for the same reason: it is already this round's
  // accurate value, read once.
  const depth = reflectDepthPastLast({
    rounds: counted,
    attempts: peekedAttempts,
    ...(peekedLastReflectedRound === undefined
      ? {}
      : { lastReflectedRound: peekedLastReflectedRound }),
    ...(peekedLastReflectedAttempts === undefined
      ? {}
      : { lastReflectedAttempts: peekedLastReflectedAttempts }),
  });
  if (reflectDutyArmed(depth, reflectAfter)) {
    process.env.DRIVE_PR_REFLECT_DUE = String(round);
    console.error(
      `  ⚠ round ${round} is ${Number.isFinite(depth) ? depth : "an unreadable distance"} past the last recorded reflection (threshold ${reflectAfter}): /jig:reflect is DUE before triaging this round.`,
    );
    console.error(
      "    Repeat findings at this depth are a scaffolding gap, not reviewer noise.",
    );
  } else {
    delete process.env.DRIVE_PR_REFLECT_DUE;
  }

  if (context.dryRun) {
    {
      const stage = await previewRoundPass(context);
      if (stage !== null) return stage;
    }
  }

  return null;
}

async function previewRoundPass(
  context: DriveRoundContext,
): Promise<number | "continue" | null> {
  // Reports the AMENDED command, because that is the one a real round
  // would spawn. Printing the argv as typed would hide the one
  // modification this driver makes to it — so an operator whose CLI
  // rejects the injected flag would see, in the surface built for
  // exactly that question, a command that works.
  const dryPrepared = prepareQuotaSpawn(context.agent, passEnv());
  const dryArgv = dryPrepared?.argv ?? context.agent;
  console.error(
    `(dry-run) would run: ${dryArgv.length > 0 ? dryArgv.join(" ") : "<no pass command given>"}`,
  );
  if (dryPrepared !== null) {
    // Mirrors the real-run branch below: `--resume <id>`, `--continue`
    // and a bare `--resume` are all correlated WITHOUT amending argv
    // (`dryArgv` above already shows that faithfully), so a message
    // claiming `--session-id` was added would be false for every one of
    // them. Distinguish by the same length check the real-run branch
    // uses, not by whether a correlation exists at all.
    const amended = dryPrepared.argv.length !== context.agent.length;
    console.error(
      amended
        ? `  (--session-id ${dryPrepared.correlation.sessionId} is added by this driver to bind quota evidence to the pass; DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables it.)`
        : `  (correlated for quota attribution without amending argv: ${dryPrepared.correlation.vendor} session ${dryPrepared.correlation.sessionId ?? "(no exact id — a deliberately resumed/continued session)"}; DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables it.)`,
    );
  }
  return 0;
}
