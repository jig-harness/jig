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
import { HANDOFF_TELLS_REFUSED } from "./../state/ledger-mirror.ts";
import { driveState } from "./paths.ts";

/** A whole number a stored state holds, or `null`. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The pull request's head, or `null` when it did not read. */
async function currentHead(pr: string): Promise<string | null> {
  const res = await run(
    ["gh", "pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"],
    { stderr: "inherit", timeoutSec: Math.min(15, helperTimeoutSeconds()) },
  );
  const head = res.stdout.trim();
  return res.code === 0 && /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** The durable counters, read the way `readRoundBudget` reads them; an unreadable one stops the drive. */
async function spentRounds(pr: string, rearm: boolean): Promise<SpentRounds> {
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
  const stored = isRecord(state) ? count(state.attempts) : null;
  const granted = isRecord(state) ? count(state.roundsGranted ?? 0) : null;
  if (
    rounds.code !== 0 ||
    !isDigits(roundsRaw) ||
    stored === null ||
    granted === null
  )
    return fail(
      1,
      `cannot read the durable round budget for PR #${pr}; refusing to drive on an unknown round budget`,
    );
  // Passes count per head and restart at one on another head, as the round
  // gate reads them; an unreadable head keeps the stored figures.
  const head = rearm ? await currentHead(pr) : null;
  const rec = isRecord(state) ? state : {};
  const spentHeads = Number.parseInt(roundsRaw, 10);
  // A head already in the review history is not counted again, whether or
  // not it is the last counted one.
  let headCounted = head === null || rec.lastCountedHead === head;
  if (!headCounted && head !== null) {
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
    headCounted = answer === String(spentHeads);
  }
  return {
    rounds: spentHeads,
    attempts: head === null || rec.attemptsHead === head ? stored : 0,
    granted,
    headCounted,
    headKnown: head !== null || !rearm,
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

/** The limits a drive enforces on its two counters. */
export interface RoundLimits {
  /** Distinct reviewed heads: the base plus what re-arms granted. */
  rounds: number;
  /** Passes on one head: the base. */
  attempts: number;
}

/**
 * The budget this drive enforces. With `rearm`, a spent budget is extended
 * by `base` rounds, recorded durably (except on a dry run, which only says
 * what it would grant), published to the drive ledger so a takeover keeps it,
 * and announced.
 */
export async function roundBudget(
  pr: string,
  base: number,
  rearm: boolean,
  dryRun: boolean,
): Promise<RoundLimits> {
  const spent = await spentRounds(pr, rearm);
  const limits = (granted: number) => ({
    rounds: base + granted,
    attempts: base,
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
  const grant = rearmGrant(spent, base);
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
  const was = base + spent.granted;
  const budget = base + grant.granted;
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
    `re-arm: PR #${pr} had spent its round budget of ${was}; the budget is now ${budget} heads (${base} more, counting the head it resumes on) and ${base} passes on a head, and the drive stops on MAX_ROUNDS again when it spends them`,
  );
  return limits(grant.granted);
}
