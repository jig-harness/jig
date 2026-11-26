/**
 * The round budget a drive enforces: `--max-rounds` (or `drive.max_rounds`)
 * plus the rounds a re-arm granted (`lib/state/round-grant.ts`), capped by
 * the pull request's round ceiling (`circuit-breaker.ts`). A drive started
 * with `--rearm-budget` whose durable counters have spent that budget grants
 * one more first, so a re-arm of a `MAX_ROUNDS` stop runs passes instead of
 * stopping on its first check; a re-arm that finds the ceiling spent parks
 * `round-ceiling` instead, unless a person's override (`--past-ceiling`, or
 * the park's override answer) raises the ceiling by one block.
 */
import { fail, isDigits } from "./../cli.ts";
import { ghCall, helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { rearmGrant, type SpentRounds } from "./../state/round-grant.ts";
import { HANDOFF_TELLS_REFUSED } from "./../state/ledger-mirror.ts";
import { driveState } from "./paths.ts";
import { openStore } from "./../state/store.ts";
import { driverRuntime } from "./runtime.ts";
import { isWorkOwningStop } from "./stop-pickup.ts";
import {
  type CircuitLimits,
  clearCircuitStop,
  drivenHours,
  personsCircuitStop,
  pastCeilingAnswered,
  pastCeilingIdentity,
  readCircuitSettings,
  recordFirstDriven,
  stopAtCeiling,
  storeRaise,
  wallClockReached,
} from "./circuit-breaker.ts";
import {
  atRoundCeiling,
  raisedCeiling,
  raisedWallClock,
  roundCeiling,
} from "./../state/circuit-breaker.ts";

/** A whole number a stored state holds, or `null`. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The pull request's head, or `null` when it did not read. */
async function currentHead(pr: string): Promise<string | null> {
  const res = await ghCall(
    ["pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"],
    { stderr: "inherit", timeoutSec: Math.min(15, helperTimeoutSeconds()) },
  );
  const head = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

type RunOpts = { stderr: "inherit"; timeoutSec: number };

/** The stored drive state as a record, or `null` when it did not read as JSON. */
function parseState(got: { code: number; stdout: string }): unknown {
  if (got.code !== 0) return null;
  try {
    return JSON.parse(got.stdout);
  } catch (error) {
    swallow(error, "drive-state.ts get printed no JSON");
    return null;
  }
}

/** The head's review round answer: whether it is already counted, or a refusal. */
async function headCountedFor(
  pr: string,
  head: string,
  spentHeads: number,
  opts: RunOpts,
): Promise<boolean> {
  const next = await run(
    tsArgv(driveState, ["prospective-round", pr, "--head", head]),
    opts,
  );
  const answer = next.stdout.trim();
  // Only the head's current round (already counted) or the next one (new)
  // is an answer; a failed or malformed probe proves neither.
  if (
    next.code !== 0 ||
    !isDigits(answer) ||
    ![spentHeads, spentHeads + 1].includes(Number.parseInt(answer, 10))
  )
    return fail(
      1,
      `cannot read the review round of PR #${pr}'s head; refusing to grant rounds on an unknown head history; re-arm again`,
    );
  return answer === String(spentHeads);
}

/** The durable counters, read the way `readRoundBudget` reads them; an unreadable one stops the drive. */
async function spentRounds(
  pr: string,
  rearm: boolean,
): Promise<SpentRounds & { raised: number; raisedHours: number }> {
  const opts: RunOpts = {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  };
  const rounds = await run(tsArgv(driveState, ["rounds", pr]), opts);
  const got = await run(tsArgv(driveState, ["get", pr]), opts);
  const state = parseState(got);
  const rec = isRecord(state) ? state : {};
  const roundsRaw = rounds.stdout.trim();
  const stored = count(rec.attempts);
  const granted = count(rec.roundsGranted ?? 0);
  const raised = count(rec.ceilingRaised ?? 0);
  const raisedHours = rec.wallClockRaisedHours ?? 0;
  if (
    rounds.code !== 0 ||
    !isDigits(roundsRaw) ||
    !isRecord(state) ||
    stored === null ||
    granted === null ||
    raised === null ||
    typeof raisedHours !== "number"
  )
    return fail(
      1,
      `cannot read the durable round budget for PR #${pr}; refusing to drive on an unknown round budget`,
    );
  // Passes count per head and restart at one on another head, as the round
  // gate reads them; an unreadable head keeps the stored figures.
  const head = rearm ? await currentHead(pr) : null;
  const spentHeads = Number.parseInt(roundsRaw, 10);
  // A head already in the review history is not counted again, whether or
  // not it is the last counted one.
  const headCounted =
    head === null ||
    rec.lastCountedHead === head ||
    (await headCountedFor(pr, head, spentHeads, opts));
  return {
    rounds: spentHeads,
    attempts: head === null || rec.attemptsHead === head ? stored : 0,
    granted,
    headCounted,
    headKnown: head !== null || !rearm,
    raised,
    raisedHours,
  };
}

/** Publishes the stored grant to the drive ledger, so a takeover keeps it; a refusal stops the drive. */
async function publishGrant(pr: string, required = true): Promise<void> {
  const published = await run(tsArgv(driveState, ["handoff", pr]), {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    // A drive run without the ledger has nothing to publish to, so a
    // refused write is not a failure there.
    env:
      (process.env.DRIVE_PR_LEDGER ?? "") === "off"
        ? process.env
        : { ...process.env, [HANDOFF_TELLS_REFUSED]: "1" },
  });
  if (published.code !== 0 && !required)
    console.error(
      `drive.ts: could not publish PR #${pr}'s stored round state to the drive ledger (exit ${published.code}); the drive retries at its round boundaries`,
    );
  else if (published.code !== 0)
    fail(
      1,
      `drive.ts: could not publish the re-arm's round grant for PR #${pr} to the drive ledger (drive-state.ts handoff exited ${published.code}, a refused write included); re-arm again`,
    );
}

/**
 * A re-arm refused at the ceiling parks again before any pass runs, so its
 * stop measures nothing of its own. It carries the word on the work in its
 * tree of the stop immediately before it, when that stop measured one, so
 * the next arm reads the work the earlier stop left from the last stop
 * alone (`stop-pickup.ts`). A later stop that measured nothing supersedes
 * an older measurement: it is never reached past. Only the measurement of a stop
 * that owns its unfinished work is carried (a ceiling stop, `PASS_DEADLINE`,
 * `STALLED`, `CHECK_RUNS_UNREADABLE`): another stop's (a `WORKTREE_UNCLEAN`
 * one asking a person to finish the edits) is not evidence of a kill, so a
 * circuit stop after it records no measurement of its own.
 */
async function carryStopMeasure(pr: string): Promise<void> {
  const events = (await openStore(pr)).read().state.events ?? [];
  const measured = events.findLast((e) => e.kind === "stop");
  if (
    measured !== undefined &&
    isWorkOwningStop(measured) &&
    measured.leftWork !== undefined &&
    measured.tree !== undefined
  )
    driverRuntime.stopLeftWork = {
      leftWork: measured.leftWork,
      tree: measured.tree,
    };
}

/** The limits a drive enforces on its two counters. */
export interface RoundLimits {
  /** Distinct reviewed heads: the base plus what re-arms granted. */
  rounds: number;
  /** Passes on one head: the base. */
  attempts: number;
  /** The round ceiling and wall-clock cap the rounds check. */
  circuit: CircuitLimits;
}

/** How this launch was asked to treat a spent budget. */
export interface BudgetLaunch {
  /** `--rearm-budget`: grant one more budget once the counters spent it. */
  rearm: boolean;
  /** `--past-ceiling`: a person's override of a spent round ceiling. */
  pastCeiling: boolean;
  dryRun: boolean;
}

/** What a re-arm that finds the round ceiling or wall-clock cap spent needs to settle it. */
interface CeilingReached {
  pr: string;
  base: number;
  launch: BudgetLaunch;
  /** A person's override is in force. */
  override: boolean;
  spent: Awaited<ReturnType<typeof spentRounds>>;
  stoppedAt: CircuitLimits;
  settings: ReturnType<typeof readCircuitSettings>;
  circuitAt: (raised: number, raisedHours: number) => CircuitLimits;
}

/** The exit a re-arm stops with at the spent ceiling, or the limits its person's override raised. */
async function atTheCeiling(
  c: CeilingReached,
): Promise<CircuitLimits | number> {
  const { pr, base, launch, override, spent, stoppedAt, settings, circuitAt } =
    c;
  const { dryRun } = launch;
  const atCeiling = atRoundCeiling(spent, stoppedAt.ceiling);
  const cause = atCeiling ? "rounds" : "wall-clock";
  const before = spent.rounds - (spent.headCounted ? 1 : 0);
  if (!override) {
    console.error(
      `re-arm: PR #${pr} has spent its ${atCeiling ? `round ceiling of ${stoppedAt.ceiling}` : "wall-clock cap"}; a re-arm grants nothing past it without a person's override (--past-ceiling, or the round-ceiling park's override answer).`,
    );
    await carryStopMeasure(pr);
    return await stopAtCeiling(stoppedAt, cause, before, dryRun);
  }
  if (spent.headKnown === false)
    return fail(
      1,
      `drive.ts: cannot read the head of PR #${pr}, so the override's ceiling cannot be fixed; re-arm again`,
    );
  const circuit = circuitAt(
    raisedCeiling(spent, settings.maxTotal.value, spent.raised, base),
    raisedWallClock(
      settings.wallClock?.value ?? null,
      spent.raisedHours,
      drivenHours(stoppedAt),
    ),
  );
  if (!dryRun)
    await storeRaise(
      pr,
      circuit.raised,
      circuit.raisedHours,
      pastCeilingIdentity(),
    );
  console.error(
    `re-arm: a person's override raised PR #${pr}'s round ceiling to ${circuit.ceiling} (${circuit.raised} added to ${settings.maxTotal.value})${settings.wallClock === null ? "" : ` and its wall-clock cap to ${Math.round((settings.wallClock.value + circuit.raisedHours) * 10) / 10}h`}${dryRun ? " [dry run: not recorded]" : ""}`,
  );
  return circuit;
}

/** What a re-arm's round grant needs: the counters, the ceiling and the limits it answers with. */
interface GrantInputs {
  pr: string;
  base: number;
  dryRun: boolean;
  spent: Awaited<ReturnType<typeof spentRounds>>;
  /** The round ceiling before any override of this launch. */
  ceiling: number;
  circuit: CircuitLimits;
  limits: (granted: number) => RoundLimits;
}

/** Grant, record and publish the re-arm's extra rounds, and the limits the drive then enforces. */
async function grantRearm(g: GrantInputs): Promise<RoundLimits | number> {
  const { pr, base, dryRun, spent, ceiling, circuit, limits } = g;
  const grant = rearmGrant(
    spent,
    base,
    Math.min(base + spent.granted, ceiling),
  );
  if (grant.granted === spent.granted && !grant.resetAttempts) {
    // A grant applied by an earlier launch whose publication failed is
    // published again before this drive relies on it.
    // A re-arm publishes whatever an earlier launch left, an attempt-only
    // reset included, which no counter shows.
    if (!dryRun) await publishGrant(pr);
    return limits(spent.granted);
  }
  if (spent.headKnown === false)
    return fail(
      1,
      `drive.ts: cannot read the head of PR #${pr}, so the re-arm's round grant cannot be fixed; re-arm again`,
    );
  const was = Math.min(base + spent.granted, ceiling);
  const budget = limits(grant.granted).rounds;
  if (dryRun) {
    console.error(
      `re-arm: PR #${pr} has spent its round budget of ${was}; a re-arm would grant ${base} more rounds (budget ${budget}) [dry run: not recorded]`,
    );
    return limits(grant.granted);
  }
  const res = await run(
    tsArgv(driveState, [
      "grant-rounds",
      pr,
      "--set",
      String(grant.granted),
      ...(grant.resetAttempts ? ["--reset-attempts"] : []),
    ]),
    { stdout: "ignore", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (res.code !== 0)
    return fail(
      1,
      `drive.ts: could not record the re-arm's round grant for PR #${pr} (drive-state.ts exited ${res.code}); the drive would stop on its spent budget`,
    );
  await publishGrant(pr);
  console.error(
    `re-arm: PR #${pr} had spent its round budget of ${was}; the budget is now ${budget} heads (${budget === base + grant.granted ? `${base} more, counting the head it resumes on` : `held to the round ceiling of ${circuit.ceiling}`}) and ${base} passes on a head, and the drive stops on MAX_ROUNDS again when it spends them`,
  );
  return limits(grant.granted);
}

/**
 * The budget this drive enforces, or the exit it stops with when a re-arm
 * finds the round ceiling spent without a person's override. With `rearm`,
 * a spent budget is extended by `base` rounds, recorded durably (except on a
 * dry run, which only says what it would grant), published to the drive
 * ledger so a takeover keeps it, and announced; the budget enforced never
 * reaches past the ceiling. A person's override raises the ceiling (and a
 * spent wall-clock cap) first, and implies the re-arm.
 */
export async function roundBudget(
  pr: string,
  base: number,
  launch: BudgetLaunch,
): Promise<RoundLimits | number> {
  const { dryRun } = launch;
  const settings = readCircuitSettings();
  // A person's answer that kept the drive stopped holds until their own
  // override; no launch asks the same question again.
  if (launch.pastCeiling && !dryRun) await clearCircuitStop(pr);
  const personStop = await personsCircuitStop(pr);
  if (personStop !== null && !(launch.pastCeiling && dryRun)) {
    // This no-pass exit measures nothing of its own: carry the work the
    // stop before it left, so a later override still inherits it.
    await carryStopMeasure(pr);
    return personStop;
  }
  const override = launch.pastCeiling || pastCeilingAnswered();
  const rearm = launch.rearm || override;
  const spent = await spentRounds(pr, rearm);
  const firstDrivenAt = await recordFirstDriven(pr, dryRun);
  const circuitAt = (raised: number, raisedHours: number): CircuitLimits => ({
    pr,
    maxTotal: settings.maxTotal,
    raised,
    ceiling: roundCeiling(settings.maxTotal.value, raised),
    wallClock: settings.wallClock,
    raisedHours,
    firstDrivenAt,
    block: base,
  });
  const stoppedAt = circuitAt(spent.raised, spent.raisedHours);
  let circuit = stoppedAt;
  const limits = (granted: number) => ({
    rounds: Math.min(base + granted, circuit.ceiling),
    attempts: base,
    circuit,
  });
  if (!rearm) {
    // A plain restart relies on what an earlier re-arm stored (a grant, or an
    // attempt-only reset no counter shows) only once it is published.
    // Nothing visible to preserve means a failed publication is retried at
    // the round boundaries, as the startup publication is; a stored grant
    // is relied on only once published.
    if (!dryRun) await publishGrant(pr, spent.granted > 0);
    return limits(spent.granted);
  }
  if (atRoundCeiling(spent, stoppedAt.ceiling) || wallClockReached(stoppedAt)) {
    const reached = await atTheCeiling({
      pr,
      base,
      launch,
      override,
      spent,
      stoppedAt,
      settings,
      circuitAt,
    });
    if (typeof reached === "number") return reached;
    circuit = reached;
  }
  return await grantRearm({
    pr,
    base,
    dryRun,
    spent,
    ceiling: stoppedAt.ceiling,
    circuit,
    limits,
  });
}
