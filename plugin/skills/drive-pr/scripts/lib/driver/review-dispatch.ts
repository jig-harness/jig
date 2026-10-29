/** Prepare quota attribution, charge the attempt at dispatch and join all post-pass acquisition work. */
import type { DriveRoundContext } from "./round-context.ts";

import type { PreparedSpawn, QuotaSnapshot } from "../quota/index.ts";

import { passTimeoutSeconds, SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";

import {
  refreshAccountIdentityBeforeSpawn,
  refreshAccountIdentity,
} from "./identity.ts";

import { driverRuntime } from "./runtime.ts";

import { snapshotQuotaSessions, prepareQuotaSpawn } from "./../quota/index.ts";

import { resolveAccountIdentity } from "./../identity.ts";

import { passEnv } from "./repair.ts";

import { run, tsArgv, helperTimeoutSeconds } from "./../proc.ts";

import type { RunHandle } from "../proc.ts";

import { driveState } from "./paths.ts";

import { DRIVE_HELD_ELSEWHERE_EXIT } from "./../state/lease.ts";

import { boundPassNotice } from "./../state/pass-handoff.ts";

import { resolveStateDir } from "./../state/store.ts";

import { fail } from "./../cli.ts";

import { span } from "./../../../../../shared/trace.ts";

import { requireDriverPassRegistrations } from "./lifecycle.ts";

export async function prepareReviewPass(context: DriveRoundContext): Promise<
  | number
  | "continue"
  | {
      prepared: PreparedSpawn | null;
      baseEnv: NodeJS.ProcessEnv;
      passDeadlineSec: number;
      passStartedAt: Date;
      preexistingSessions: ReadonlySet<string>;
      preexistingSnapshot: QuotaSnapshot;
    }
> {
  const passStartedAt = new Date();
  // Progress, not merely a claim heartbeat. `startHeartbeat`'s
  // timer refreshes the CLAIM on a schedule independent of anything
  // happening in this round, so a driver that hit a quota wall, exhausted
  // its pass's context, or wedged on a head-sync wait heartbeats
  // IDENTICALLY to a healthy one; six drives were observed live at once
  // with two silently stale locks nobody had reported. "A pass was
  // spawned" is the one genuine progress event `drive.ts` itself
  // originates (the other three — a round advancing, a push landing, a
  // held batch draining — are stamped inside `drive-state.ts` by the verbs
  // that already do that work), so it goes through the same named
  // `progress` verb rather than a bespoke write here.
  //
  // Stamped from `onSpawn`, not before this call, so a missing or invalid
  // pass executable never records an event that did not occur: `onSpawn`
  // fires only once `run()`'s internal `spawn()` has actually produced a
  // child process, whereas a stamp issued before this call would fire
  // unconditionally, including when `run(agent, …)` goes on to fail at the
  // synchronous spawn step and never starts anything.
  //
  // Best-effort, deliberately, and now fire-and-forget rather than
  // awaited: a failure to record the stamp must not fail the ROUND — the
  // pass is the actual work, and refusing to run it over an observability
  // write would let `--doctor`'s own accounting break the drive it exists
  // only to watch. Losing a stamp costs a `--doctor` verdict that degrades
  // to UNKNOWN (fail-closed; see `lib/doctor.ts`), never a false HEALTHY,
  // so the failure mode of skipping this check is bounded.
  // `timeoutSec`, per `references/consistency.md`: an undeadlined
  // `run()` here could outlive the driver, and this one queues for the state
  // mutex — which a concurrent driver on the same PR can legitimately hold
  // for the length of its own write. `helperTimeoutSeconds()` is the
  // accessor for exactly this (one spawned helper, whole-invocation bound,
  // 120s default); expiring it is the same bounded loss as any other
  // failure on this best-effort path.
  const passDeadlineSec = passTimeoutSeconds();
  // One more refresh, immediately before THIS spawn — not only at the
  // PRIOR pass's exit. The exit-time call closes the gap up to that
  // instant, but everything between it and here (triage, fixes, the full
  // gate suite, a push, sometimes a Testbox) can take a while, and a
  // file-backed login change landing in that window would otherwise still
  // hand this pass a stale claim for its own entire life — the same
  // failure `refreshAccountIdentity` exists to close, just at the one
  // remaining call site that had no guaranteed pre-spawn read of its own.
  // Bounded-retried by `refreshAccountIdentityBeforeSpawn` — see its own
  // header for why a merely-transient failure here cannot be left
  // unretried.
  const identitySynced = await refreshAccountIdentityBeforeSpawn(
    context.held,
    context.agent,
  );
  // Checked IMMEDIATELY after: that call can itself detect a resurrection
  // (its own post-rename `claimNames.length > 1` check) and set
  // `compromised` — and unlike the post-pass check below, nothing here
  // was watching for it before now, because no pass was running for the
  // heartbeat timer to stop. Falling through into `run()` regardless
  // would spawn a NEW pass alongside a successor that already believes it
  // holds this lock: `touchLock` returns early once `compromised` is set,
  // so no LATER heartbeat tick can stop it either — the two-drivers state
  // every lock in this file exists to prevent, self-inflicted by this
  // driver's own refresh call.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver — not starting another pass.`,
    );
    return SINGLE_INSTANCE_LOCK_EXIT;
  }
  if (!identitySynced) {
    // Not a takeover — an ordinary, still-unresolved transient failure
    // after every retry. Spawning anyway rather than stopping the drive
    // over a DISPLAY value: the heartbeat resumes retrying the moment
    // this pass exits, same as it always has for any other transient
    // failure.
    console.error(
      "drive.ts: the account-identity claim rewrite did not land before this spawn — proceeding with a possibly-stale display; the heartbeat retries once this pass exits.",
    );
  }
  // The other half of binding evidence to THIS pass, and the reason both of
  // these sit immediately above the spawn rather than at the top of the
  // round. `cwd` + `since` alone cannot separate this pass from a human's
  // interactive session sitting in the same worktree — the normal condition
  // while a drive runs, since the drive locks exclude other DRIVERS, not a
  // chat — so that session's wall could park this pass and its healthy
  // telemetry could clear this pass's real wall.
  //
  // `snapshotQuotaSessions()` records what already exists, so anything that
  // appears afterwards is a session started during the pass;
  // `prepareQuotaSpawn()` goes further where the vendor allows it, giving
  // the pass an identity chosen HERE so its evidence can be matched
  // exactly. The window between these two calls and the spawn is the
  // residual, which is why nothing is interposed between them.
  const preexistingSnapshot = snapshotQuotaSessions();
  const preexistingSessions = preexistingSnapshot.files;
  const baseEnv = passEnv();
  // A stop the driver recovered from (a killed pass, a stall, a takeover, a
  // re-arm with answers) is told to every review pass until one completes. One
  // environment string has an OS limit, so a long notice reaches the pass
  // through a file the variable names.
  const stateDir = await resolveStateDir();
  let notice: string;
  try {
    notice = boundPassNotice(
      stateDir,
      context.pr,
      [context.passNotice, context.carriedNotice]
        .filter((part) => part !== "")
        .join("\n\n"),
    );
  } catch (err) {
    return fail(
      1,
      `cannot keep PR #${context.pr}'s pass notice whole in ${stateDir} (${String(err)}); stopping rather than dispatching a pass without it`,
    );
  }
  if (notice !== "") baseEnv.DRIVE_PR_PASS_NOTICE = notice;
  const prepared = prepareQuotaSpawn(context.agent, baseEnv);
  if (prepared !== null) {
    // Said out loud, once per round. This is the only place the driver
    // rewrites a command the caller gave it, and an operator whose CLI
    // does not understand the injected flag sees the round die instantly
    // with a usage error for a command they never typed — with nothing
    // anywhere connecting the two, or naming the way out.
    //
    // Two shapes, told apart by argv length rather than the correlation's
    // own `sessionId` being non-null: a minted or exact-resume-value
    // correlation both leave `sessionId` a real string, but only the
    // MINTED one actually injects `--session-id` into argv — an
    // exact-resume-value or a vendor-confirmed-no-id correlation (a
    // deliberate `--continue`/`-c`/ambiguous `--resume`) leaves argv
    // unchanged, so describing either of those as an "amended" flag
    // injection would name a mutation that never happened.
    const amended = prepared.argv.length !== context.agent.length;
    console.error(
      amended
        ? `pass argv amended for quota attribution: --session-id ${prepared.correlation.sessionId} (DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables)`
        : `pass correlated for quota attribution without amending argv: ${prepared.correlation.vendor} session ${prepared.correlation.sessionId ?? "(no exact id — a deliberately resumed/continued session)"} (DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 disables)`,
    );
  }

  return {
    prepared,
    baseEnv,
    passDeadlineSec,
    passStartedAt,
    preexistingSessions,
    preexistingSnapshot,
  };
}

export async function dispatchReviewPass(
  context: DriveRoundContext,
  apiHead: string,
  round: number,
  prepared: PreparedSpawn | null,
  baseEnv: NodeJS.ProcessEnv,
  passDeadlineSec: number,
): Promise<
  | number
  | "continue"
  | { passRes: Awaited<ReturnType<typeof run>>; passHandle: RunHandle | null }
> {
  // Populated by `onSpawn` below with the fire-and-forget `pass-spawned`
  // stamp's own promise, so it can be joined once the pass itself has
  // finished — see the comment at that join point for why this ordering
  // is load-bearing.
  let passSpawnProgressStamp: Promise<unknown> | null = null;
  // Several awaited state/account reads separate the earlier round check
  // from this spawn, and a directive sent during one of them must still
  // prevent a new pass — this checkpoint is the LAST await before the
  // charge below and the spawn that follows it, and it reads the ledger's
  // claims too.
  const mailboxAtSpawn = await context.mailboxCheckpoint({ beforePass: true });
  if (typeof mailboxAtSpawn === "number") return mailboxAtSpawn;
  if (mailboxAtSpawn === "resumed") return "continue";
  // Commit the durable charge and the local pass counter HERE, not
  // earlier: everything above this line can still abort without a pass
  // running, so nothing above it may spend real budget. This replaced an
  // earlier charge-then-refund design whose compensating refund had its
  // own correctness gap (an ABA case on its compare-and-swap) — "never
  // charge until certain" needs no compensating action at all. The one
  // irreducible residual is the `bump-attempt` call's own round-trip
  // immediately below: a directive landing in that single await is not
  // caught before this dispatch, only at the next checkpoint — accepted
  // deliberately, because closing it would need the charge and the spawn
  // to be literally the same operation, which they cannot be.
  context.passes += 1;
  const bump = await run(
    tsArgv(driveState, ["bump-attempt", context.pr, "--head", apiHead]),
    { stderr: "inherit" },
  );
  // A PR-wide refusal is not a persistence fault, and flattening it into
  // one costs exactly what the gate provides. `drive.ts`'s own
  // per-PR lock does NOT cover this case: that lock is only ever held by
  // another `drive.ts`, so an INTERACTIVE pass in another worktree — an
  // agent walking SKILL.md by hand, which takes no lock at all — is
  // invisible to it, and this is the first call that meets that session's
  // lease. Propagated with its own code so a log reads as "another tree is
  // driving this PR" rather than "the state dir is unwritable"; the child's
  // stderr is already inherited and names the tree, its session and how to
  // check it.
  if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT) {
    fail(
      DRIVE_HELD_ELSEWHERE_EXIT,
      `PR #${context.pr} is being driven from another working tree; stopping rather than becoming the second resolver`,
    );
  }
  if (bump.code !== 0) {
    fail(
      1,
      `cannot record this pass against PR #${context.pr}'s head; stopping rather than driving unbounded`,
    );
  }
  context.passIdentity = resolveAccountIdentity(context.agent);
  const passRes = await span("pass", { round }, () =>
    run(prepared?.argv ?? context.agent, {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
      env: prepared?.env ?? baseEnv,
      // `0` disables, matching every other deadline knob in this skill; `run()`
      // takes the absence of the field as "no deadline" rather than a zero.
      ...(passDeadlineSec > 0 ? { timeoutSec: passDeadlineSec } : {}),
      onSpawn: (handle) => {
        driverRuntime.activePass = handle;
        passSpawnProgressStamp = run(
          tsArgv(driveState, [
            "progress",
            context.pr,
            "--phase",
            "pass-spawned",
          ]),
          { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
        ).then((progressStamp) => {
          if (progressStamp.code !== 0) {
            console.error(
              `drive.ts: could not stamp progress for round ${round}'s pass (drive-state.ts exited ${progressStamp.code}) — continuing anyway.`,
            );
          }
        });
      },
    }),
  );
  // Captured before `activePass` is cleared: the PASS_DEADLINE branch below
  // needs it to witness the pass tree's termination, which happens after
  // this point.
  const passHandle = driverRuntime.activePass;
  await requireDriverPassRegistrations(context.held);
  driverRuntime.activePass = null;
  // Joined here, before the pass result is interpreted or anything below
  // writes state again — not to make the write itself fatal (a failed or
  // slow stamp is still swallowed by the `.then()` above), but to ORDER
  // it: this write queues on the same state mutex as everything else, and
  // being fire-and-forget from `onSpawn`'s perspective let it complete
  // AFTER a later write in this same round (`recordQuotaPark()`, several
  // hundred lines below) rather than before it. A `pass-spawned` stamp
  // that lands after a quota-park write refreshes `lastProgressAt` and
  // clears `quotaPark`, so `--doctor` reads recent HEALTHY progress or
  // loses the QUOTA_PARKED verdict for a pass that has already stopped.
  // The pass itself has already finished by this point, so joining here
  // adds no latency to its own critical path.
  if (passSpawnProgressStamp !== null) {
    await passSpawnProgressStamp;
  }
  // Checked BEFORE the exit code is interpreted: a pass this process killed
  // for a takeover exits non-zero, and reporting that as "your pass is
  // failing, look at it" would bury the actual event. `release` is
  // nonce-checked, so the way out touches no successor's lock.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver mid-pass — the pass was stopped; not driving further.`,
    );
    // The takeover's stop ran from a timer, which could not wait — so re-join
    // its witness here. The COMPROMISED lock is not ours to release either
    // way (its nonce check fails), but the other one still is, and releasing
    // it while a descendant of the pass survives is the same two-drivers-one-
    // tree state this whole path exists to avoid.
    if (
      driverRuntime.passStopWitness !== null &&
      !(await driverRuntime.passStopWitness)
    ) {
      context.held.length = 0;
    }
    return SINGLE_INSTANCE_LOCK_EXIT;
  }
  // Refresh synchronously HERE too, not only on the heartbeat timer.
  // `activePass` just went back to `null`, which is the exact window
  // `refreshAccountIdentity`'s own gate exists for — but the heartbeat's
  // own next tick can be up to `heartbeatRefreshMs()` away, and this loop
  // may spawn the very next pass before it ever fires. A credential file
  // that changed while this pass ran would otherwise hand that next pass a
  // stale claim for its own entire life, the same failure mode
  // `refreshAccountIdentity` exists to close for the file-backed identity
  // path.
  refreshAccountIdentity(context.held, context.agent);
  // Checked immediately after, same as the pre-spawn call site: this
  // refresh can itself detect a resurrection and set `compromised`, and
  // falling through to interpret `passRes.code` regardless would let the
  // loop keep going with no claim protecting the tree — including into
  // the quota-sleep path below, which can hold what it believes is a
  // live lock for HOURS after the takeover, and into a Ready-mark
  // transition neither of which re-checks this before the next loop
  // boundary.
  if (driverRuntime.compromised !== "") {
    console.error(
      `drive.ts: the ${driverRuntime.compromised} lock was recovered by another driver — not continuing.`,
    );
    return SINGLE_INSTANCE_LOCK_EXIT;
  }

  return { passRes, passHandle };
}
