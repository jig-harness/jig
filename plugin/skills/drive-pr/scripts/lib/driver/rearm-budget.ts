/**
 * The round budget a drive enforces: `--max-rounds` (or `drive.max_rounds`)
 * plus the rounds a re-arm granted (`lib/state/round-grant.ts`). A drive
 * started with `--rearm-budget` whose durable counters have spent that
 * budget grants one more first, so a re-arm of a `MAX_ROUNDS` stop runs
 * passes instead of stopping on its first check.
 */
import { fail, isDigits } from "./../cli.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { rearmGrant, type SpentRounds } from "./../state/round-grant.ts";
import { driveState } from "./paths.ts";

/** A whole number a stored state holds, or `null`. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The durable counters, read the way `readRoundBudget` reads them; an unreadable one stops the drive. */
async function spentRounds(pr: string): Promise<SpentRounds> {
  const opts = {
    stderr: "inherit" as const,
    timeoutSec: helperTimeoutSeconds(),
  };
  const rounds = await run(tsArgv(driveState, ["rounds", pr]), opts);
  const got = await run(tsArgv(driveState, ["get", pr]), opts);
  let state: unknown = null;
  try {
    state = got.code === 0 ? JSON.parse(got.stdout) : null;
  } catch (error) {
    swallow(error, "drive-state.ts get printed no JSON");
    state = null;
  }
  const roundsRaw = rounds.stdout.trim();
  const attempts = isRecord(state) ? count(state.attempts) : null;
  const granted = isRecord(state) ? count(state.roundsGranted ?? 0) : null;
  if (
    rounds.code !== 0 ||
    !isDigits(roundsRaw) ||
    attempts === null ||
    granted === null
  )
    return fail(
      1,
      `cannot read the durable round budget for PR #${pr}; refusing to drive on an unknown round budget`,
    );
  return { rounds: Number.parseInt(roundsRaw, 10), attempts, granted };
}

/**
 * The budget this drive enforces. With `rearm`, a spent budget is extended
 * by `base` rounds past what the drive spent, recorded durably (except on a
 * dry run, which only says what it would grant) and announced.
 */
export async function roundBudget(
  pr: string,
  base: number,
  rearm: boolean,
  dryRun: boolean,
): Promise<number> {
  const spent = await spentRounds(pr);
  if (!rearm) return base + spent.granted;
  const granted = rearmGrant(spent, base);
  if (granted === spent.granted) return base + granted;
  const was = base + spent.granted;
  const budget = base + granted;
  if (dryRun) {
    console.error(
      `re-arm: PR #${pr} has spent its round budget of ${was}; a re-arm would grant ${base} more rounds (budget ${budget}) [dry run: not recorded]`,
    );
    return budget;
  }
  const res = await run(
    tsArgv(driveState, ["grant-rounds", pr, "--set", String(granted)]),
    { stdout: "ignore", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (res.code !== 0)
    return fail(
      1,
      `drive.ts: could not record the re-arm's round grant for PR #${pr} (drive-state.ts exited ${res.code}); the drive would stop on its spent budget`,
    );
  console.error(
    `re-arm: PR #${pr} had spent its round budget of ${was}; granted ${base} more rounds: the budget is now ${budget}, and the drive stops on MAX_ROUNDS again when it spends them`,
  );
  return budget;
}
