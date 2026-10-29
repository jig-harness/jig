/**
 * Finishing an admitted `--take-over` once this driver holds the locks
 * (`takeover.ts` decides it and stops the holder), and picking the drive up
 * from its durable state.
 *
 * The takeover runs `reconcile-replied-threads.ts` before the first triage,
 * carries the held batch over, and records itself in the drive state. A hold
 * stamped with its pushed fix is left to the round's ordinary resolve. A hold
 * of the previous driver with no such stamp is not verified as pushed: it is
 * released and, for a thread, a superseding reply says so, and the first
 * passes are told to redo the fix and hold it again or triage it afresh. A
 * failed reconciliation is said in the notice and the record; the first
 * gate's own sweep runs it again.
 */
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import { accountHash, resolveAccountIdentity } from "./../identity.ts";

import type { DriveState, HeldItem } from "./../state/schema.ts";

import { driveState, reconcileRepliedThreads, replyToThread } from "./paths.ts";

import { admitAnsweredParks } from "./rearm.ts";

import { settleTakeover, type TakeoverPlan } from "./takeover.ts";

import { mirrorNow } from "./ledger.ts";

async function driveStateRun(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string }> {
  return run(tsArgv(driveState, args), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    ...(stdin === undefined ? {} : { stdin }),
  });
}

/** The superseding reply on a reopened held thread. */
export const REOPEN_REPLY =
  "Reopened: the driver that posted the reply above stopped before its promised fix was verified as pushed, and another driver has taken this pull request's drive over. It redoes the fix and holds this thread again, or triages the finding afresh.";

/**
 * Reopen one hold not stamped as pushed: a superseding reply on its thread,
 * then the hold released. Returns what the pass is told.
 */
async function reopenHold(pr: string, item: HeldItem): Promise<string> {
  let replied = "";
  if (item.kind === "thread") {
    const reply = await run(tsArgv(replyToThread, [item.key, "--no-outcome"]), {
      stdin: REOPEN_REPLY,
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
      env: { ...process.env, DRIVE_PR_TARGET: pr },
    });
    replied =
      reply.code === 0
        ? "; superseding reply posted"
        : `; the superseding reply FAILED (exit ${reply.code}) — post it yourself`;
  }
  const release = await driveStateRun([
    "release-held",
    pr,
    "--key",
    item.key,
    "--if-present",
    ...(item.commentUrl === undefined
      ? []
      : ["--if-comment-url", item.commentUrl]),
  ]);
  if (release.code !== 0)
    return `- [${item.kind}] ${item.key}: could NOT be released (exit ${release.code}); it stays held${replied}`;
  return `- [${item.kind}] ${item.key} (was ${item.outcome}, round ${item.round})${replied}`;
}

/**
 * Finish an admitted takeover: reconcile, carry the held batch over, record.
 * Returns the notice the first passes read in `$DRIVE_PR_PASS_NOTICE`.
 */
export async function completeTakeover(
  pr: string,
  plan: TakeoverPlan,
  agent: string[],
  botsOnly: boolean,
): Promise<string> {
  const reconcile = await run(
    tsArgv(reconcileRepliedThreads, [pr, ...(botsOnly ? ["--bots-only"] : [])]),
    { stdout: "pipe", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  const reconciled = reconcile.code === 0;
  console.error(
    `takeover: ran reconcile-replied-threads.ts before the first triage (exit ${reconcile.code}${reconciled ? "" : "; the first gate's own sweep runs it again"}).`,
  );
  const unverified = plan.held.filter(
    (h) =>
      h.verifiedSha === undefined &&
      (plan.fromActor === null || h.actor === plan.fromActor),
  );
  const reopened: string[] = [];
  const lines: string[] = [];
  for (const item of unverified) {
    lines.push(await reopenHold(pr, item));
    reopened.push(item.key);
  }
  const toAccount = accountHash(resolveAccountIdentity(agent));
  const record = await driveStateRun(
    ["takeover", pr],
    JSON.stringify({
      fromActor: plan.fromActor,
      fromAccount: plan.fromAccount,
      toAccount,
      verdict: plan.verdict,
      reopened,
      reconciled,
    }),
  );
  settleTakeover();
  console.error(
    record.code === 0
      ? `takeover: recorded in the drive state (from ${plan.fromActor ?? "an unnamed tree"}, account ${plan.fromAccount ?? "unknown"}, to account ${toAccount ?? "unknown"}, verdict ${plan.verdict}, ${reopened.length} hold(s) reopened).`
      : `takeover: could not record the takeover (drive-state.ts exited ${record.code}); driving on.`,
  );
  const from = {
    WEDGED: "a wedged driver",
    DEAD: "a dead driver",
    STALE:
      "another clone's driver whose ledger heartbeat was past the lease window",
  }[plan.verdict];
  const notice = [
    `TAKEN OVER: this drive was taken over from ${from} and resumes at its durable round.`,
  ];
  if (!reconciled)
    notice.push(
      `reconcile-replied-threads.ts FAILED before this pass (exit ${reconcile.code}); the gate's sweep runs it again, so read each thread's last reply before triaging it.`,
    );
  if (lines.length > 0)
    notice.push(
      "These holds' promised fixes are not verified as pushed, and they are reopened. For each, redo the fix and hold it again with a fresh outcome reply, or triage it afresh:",
      ...lines,
    );
  else notice.push("No held item was left without a verified push.");
  return notice.join("\n");
}

/**
 * Pick the drive up once this driver holds the locks: finish an admitted
 * takeover and unpark items a person has answered. Returns the notice the
 * first passes carry (`''` for none).
 */
export async function pickUpDrive(
  pr: string,
  plan: TakeoverPlan | null,
  state: DriveState | null,
  opts: { agent: string[]; botsOnly: boolean; dryRun: boolean },
): Promise<string> {
  const takeover =
    plan === null
      ? ""
      : await completeTakeover(pr, plan, opts.agent, opts.botsOnly);
  // A takeover is written to the drive ledger at once, not at the next boundary.
  if (plan !== null) await mirrorNow(pr);
  const notices = [
    takeover,
    state === null ? "" : await admitAnsweredParks(state, opts.dryRun),
  ];
  return notices.filter((part) => part !== "").join("\n\n");
}
