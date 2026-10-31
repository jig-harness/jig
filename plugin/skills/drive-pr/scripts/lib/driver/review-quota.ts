/** Retain ownership while sleeping through short quota windows, or record a terminal quota park. */
import type { QuotaPlan, QuotaBlock } from "../quota/index.ts";

import type { DriveRoundContext } from "./round-context.ts";

import { driverRuntime } from "./runtime.ts";

import { sleep } from "./../cli.ts";

import { reportPassLeftovers } from "./restart.ts";

import {
  MAILBOX_POLL_SECONDS,
  MAX_ROUNDS_EXIT,
  QUOTA_PARKED_EXIT,
} from "./settings.ts";

import { recordQuotaPark } from "./repair.ts";

import { ledgerRenewal } from "./ledger.ts";

import { driveState, driveTs } from "./paths.ts";

import { armCommand, passBotsOnly } from "./rearm.ts";

import {
  type AccountIdentity,
  accountHash,
  formatAccountIdentity,
  resolveAccountIdentity,
} from "./../identity.ts";

import { loopEconomy } from "./reports.ts";

import { planFor, describe as describeQuota } from "./../quota/index.ts";

/**
 * The account the pass that met the wall billed: the identity resolved as it
 * was spawned, not the credentials as they read now, which a login during the
 * pass can have changed.
 */
function wallIdentity(context: DriveRoundContext): AccountIdentity {
  return context.passIdentity ?? resolveAccountIdentity(context.agent);
}

/** The hashed account the wall belongs to (`accountHash`). */
function wallAccount(context: DriveRoundContext): string | null {
  return accountHash(wallIdentity(context));
}

async function waitThroughQuotaWindow(
  plan: Extract<QuotaPlan, { action: "sleep" }>,
  context: DriveRoundContext,
): Promise<number | "continue"> {
  driverRuntime.quotaSleepAbort = new AbortController();
  try {
    const quotaWaitStartedAt = performance.now();
    // A sleep can outlast the ledger's lease window: the heartbeat is
    // rewritten as the sleep starts and well inside the window after, so
    // another clone never takes over a sleeping driver; a newer claim from
    // another clone ends the sleep. A mailbox pause inside the checkpoint
    // below renews it the same way.
    const renewLedger = ledgerRenewal(context.pr);
    while (performance.now() - quotaWaitStartedAt < plan.ms) {
      const takenOver = await renewLedger();
      if (takenOver !== null) return takenOver;
      // Quota waiting is between passes, so a mailbox stop must not
      // sit behind this potentially multi-hour sleep. Keep the
      // takeover abort on each short sleep as before.
      const mailboxDuringQuota = await context.mailboxCheckpoint();
      if (typeof mailboxDuringQuota === "number") return mailboxDuringQuota;
      if (driverRuntime.compromised !== "") break;
      const remainingMs = plan.ms - (performance.now() - quotaWaitStartedAt);
      if (remainingMs > 0) {
        await sleep(
          Math.min(MAILBOX_POLL_SECONDS, remainingMs / 1000),
          driverRuntime.quotaSleepAbort.signal,
        );
      }
    }
  } finally {
    driverRuntime.quotaSleepAbort = null;
  }
  if (driverRuntime.compromised !== "") {
    // The loop's own top-of-iteration check reports and returns 11 —
    // nothing to add here beyond not claiming a resumption that
    // never happened.
    return "continue";
  }
  // Deliberately does NOT name the next round number. `continue`
  // re-enters the gate, which re-derives the round from durable state —
  // and hours have passed, so the head may well have moved under us.
  // Printing `round + 1` here would be this loop's guess, contradicted
  // by the very next line the gate prints.
  console.error(
    `quota window reopened; resuming the drive of PR #${context.pr}.`,
  );
  return "continue";
}

async function handleSleepableQuota(
  round: number,
  context: DriveRoundContext,
  plan: Extract<QuotaPlan, { action: "sleep" }>,
  block: QuotaBlock,
): Promise<number | "continue"> {
  // This round's attempt is already durably counted and is not
  // refunded — so if it was also the LAST one `--max-rounds`
  // permits, resuming after the sleep re-enters the gate on an
  // unchanged head, `bump-attempt` advances past the limit, and the
  // driver exits 6 having run no further pass. Sleeping first would
  // hold its locks for hours to reach that same exit
  // — check now instead.
  if (round >= context.maxRoundsN) {
    console.error(
      `  round ${round} was already the last of --max-rounds (${context.maxRoundsN}) — not sleeping ${Math.ceil(plan.ms / 60000)} minute(s) for an attempt that cannot happen.`,
    );
    console.error(
      `hit --max-rounds (${context.maxRoundsN}) on PR #${context.pr} without converging`,
    );
    console.error("This is a NON-CONVERGENCE report, not a quiet stop:");
    console.error(
      `  pass on round ${round} hit a quota wall and no further attempt remains`,
    );
    await reportPassLeftovers("What the killed pass left in the tree:");
    // Recorded even though nothing will sleep or resume: this exit is
    // NORMAL (not a crash), so `process.on('exit')` releases and
    // `rmdir`s the lock slot on the way out, same as the standalone
    // QUOTA_PARKED_EXIT path below. Without this, `--doctor` would
    // see a state-only row with no quota evidence at all and report
    // UNKNOWN instead of QUOTA_PARKED for a drive that hit a real,
    // genuine wall — the exact distinction this record exists to draw
    // (see `recordQuotaPark`'s own callers for why every other
    // quota-wall exit already does this).
    await recordQuotaPark(driveState, context.pr, block, wallAccount(context));
    process.stderr.write(await loopEconomy(context.pr));
    // A directive sent WHILE the killed pass ran must still be
    // honored, same as the non-quota failure branch below:
    // `clear`/`resumed` both fall through to this same
    // non-convergence report — the budget is exhausted either way, a
    // resumed pause grants no further rounds — while
    // `stopped`/`pause-timeout`/`unreadable` return their own exit
    // code in its place.
    const mailboxAtQuotaMaxRounds = await context.mailboxCheckpoint();
    if (typeof mailboxAtQuotaMaxRounds === "number")
      return mailboxAtQuotaMaxRounds;
    return MAX_ROUNDS_EXIT;
  }
  const minutes = Math.ceil(plan.ms / 60000);
  console.error(
    `  SLEEPING ${minutes} minute(s) until ${plan.until.toISOString()}, then resuming.`,
  );
  console.error(
    "  The locks stay held and keep refreshing: this drive is still the one driving",
  );
  console.error(
    "  this PR, and releasing them here would invite a second driver into the tree.",
  );
  // The round this wall consumed is NOT refunded. It was counted before
  // the pass ran, and unwinding a durable counter from here would mean
  // a failure path that mutates the very state the loop's bounds are
  // read from. Burning one of --max-rounds on a wall is the cheap
  // direction; an unbounded loop is not.
  //
  // Raced against a lock takeover, not merely timed: sleeping this
  // long unconditionally left `touchLock`'s takeover signal
  // (`compromised`) unobserved for up to `maxSleepMs()` — six hours
  // by default — because nothing between here and the loop's next
  // round-boundary check reads it while this `await` is in flight.
  // `quotaSleepAbort` is what `touchLock` fires the moment it
  // notices; this wakes on whichever comes first.
  // Recorded BEFORE the sleep, not after: the whole interval this
  // call describes is the one during which `--doctor` would
  // otherwise misread this drive (see `recordQuotaPark`). Cleared by
  // the next genuine progress event — the `progress` stamp the
  // resumed round takes before it spawns its pass.
  await recordQuotaPark(driveState, context.pr, block, wallAccount(context));
  // Re-check BEFORE creating the controller: a takeover detected by
  // `touchLock` WHILE the await above was in flight called
  // `quotaSleepAbort?.abort()` against a controller that did not
  // exist yet — a no-op — and set `compromised`, so `touchLock`'s
  // own `if (compromised !== '') return;` guard skips firing it
  // again on every later heartbeat tick. Without this check, the
  // controller created next would never receive an abort at all, and
  // the sleep below would run for the FULL `plan.ms` (up to
  // `maxSleepMs()`, six hours) before the after-sleep check further
  // down ever saw the takeover.
  if (driverRuntime.compromised !== "") {
    return "continue";
  }
  return await waitThroughQuotaWindow(plan, context);
}

export async function handleQuotaBlock(
  block: QuotaBlock,
  now: Date,
  round: number,
  context: DriveRoundContext,
): Promise<number | "continue"> {
  const plan = planFor(block, now);
  console.error(`pass on round ${round} hit a quota wall.`);
  console.error(`  ${describeQuota(block)}`);
  console.error(`  evidence read from ${block.source}`);
  if (plan.action === "sleep") {
    return await handleSleepableQuota(round, context, plan, block);
  }
  console.error(`  NOT sleeping: ${plan.why}.`);
  console.error(
    "  Stopping rather than holding this PR's locks through a wall nothing here can",
  );
  console.error(
    "  wait out. Re-arm the drive once the window reopens; nothing about the PR, the",
  );
  console.error("  tree or the pass needs fixing first.");
  await reportPassLeftovers("What the killed pass left in the tree:");
  const identity = wallIdentity(context);
  const account = accountHash(identity);
  console.error(
    `  The wall belongs to ${formatAccountIdentity(identity)}${account === null ? "" : ` (${account})`}.`,
  );
  console.error(
    "  Do not re-arm on that account before the reset; a pass billing ANOTHER account may pick it up now:",
  );
  console.error(
    `    ${armCommand(driveTs, context.pr, passBotsOnly(context.agent), "", context.agent)}`,
  );
  // Record the park BEFORE this process exits: once this
  // returns, nothing refreshes this drive's claim any further, and
  // `release()` (`process.on('exit')`) `rmdir`s the lock slot on the
  // way out — a NORMAL exit, not a crash, so a later `--doctor` sweep
  // finds NO lock directory here at all. Without this record it would
  // therefore see NOTHING for this PR — not even a stale claim to
  // report — and could not tell a drive that parked ON PURPOSE from one
  // that never existed. `listStateOnlyRows` (`drives.ts`) is what makes
  // the record findable despite the missing lock: it sweeps
  // `drive-pr-<PR>.json` directly, so this write is what `--doctor`
  // actually reads to draw the `QUOTA_PARKED` distinction
  // (`lib/doctor.ts`). Best-effort, same reasoning as the pre-spawn
  // stamp above: the wall itself is the fact worth acting on, and
  // refusing to park cleanly over a bookkeeping failure would strand
  // the drive here instead.
  await recordQuotaPark(driveState, context.pr, block, account);
  // Same as the sleep-branch max-rounds report above, and the
  // non-quota failure branch below: a directive sent WHILE the killed
  // pass ran must still be honored.
  // `clear`/`resumed` both fall through to parking — this wall cannot
  // be slept through either way — while `stopped`/`pause-timeout`/
  // `unreadable` return their own exit code in its place.
  const mailboxAtQuotaPark = await context.mailboxCheckpoint();
  if (typeof mailboxAtQuotaPark === "number") return mailboxAtQuotaPark;
  return QUOTA_PARKED_EXIT;
}
