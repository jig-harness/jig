/** Validate driver options, acquire ownership and keep its resources alive through the round loop. */
import { fail, isDigits, shellQuote } from "./../cli.ts";
import { parseDriverOptions, applyPassTimeout } from "./options.ts";

import {
  resolveMaxRounds,
  resolveHandoffAt,
  resolvePassDeadlineRetries,
} from "./settings.ts";

import { type MarkReady, prPolicy } from "./../pr-policy.ts";

import {
  resolvePr,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  run,
  tsArgv,
  helperTimeoutSeconds,
} from "./../proc.ts";

import { resolveStateDir, worktreeLockName } from "./../state/store.ts";

import { resolveMailboxDir } from "./../state/mailbox.ts";

import { join } from "node:path";

import { startDriverLog } from "./log.ts";

import { resolveAccountIdentity } from "./../identity.ts";

import type { ClaimDiag } from "./../claim.ts";

import { type DriveLock, acquire, release } from "./locks.ts";

import {
  installDriverLifecycle,
  createDriverRegistry,
  driverStopCompletionCleanup,
} from "./lifecycle.ts";

import { registerCleanup } from "./../../../../../shared/cleanup.ts";

import { driverRuntime } from "./runtime.ts";

import { startHeartbeat } from "./identity.ts";

import { captureStateDirIdentityToken } from "./../state/lease.ts";

import { driveState, captureIntentChain, driveTs } from "./paths.ts";

import { runDriverRounds } from "./rounds.ts";

import { attachForDrive } from "./../attach.ts";

import {
  decideTakeover,
  explainingRefusal,
  holdTreeAroundTakeover,
} from "./takeover.ts";

import { pickUpDrive } from "./takeover-complete.ts";

import { armCommand, quotaRefusal, readDriveState } from "./rearm.ts";

import { armLedger, ledgerIdentity, ledgerSettlement } from "./ledger.ts";

import type { DriveState } from "./../state/schema.ts";

/**
 * Refuse a PR that is not a canonical number. Digits, checked here rather
 * than at the three places it lands: it is interpolated into a `new RegExp`,
 * so a metacharacter — `drive.ts '('` — throws a SyntaxError instead of a
 * usage error; and it is exported as $DRIVE_PR_TARGET, where drive-status.ts
 * and guarded-push.ts compare it as a string and refuse for a less obvious
 * reason. Canonical before anything is keyed by it: `042` is PR 42 to GitHub,
 * so a raw `042` would take `pr-drive-042.lock` beside a live #42 driver's
 * `pr-drive-42.lock` and write #42's state and log under a second name.
 * Refused rather than rewritten, because the pass names the PR in its own
 * argv and drive-status.ts compares that against $DRIVE_PR_TARGET verbatim.
 */
function requireCanonicalPr(pr: string): void {
  if (!isDigits(pr)) fail(2, `drive.ts: PR must be a number (got '${pr}')`);
  const canonicalPr = BigInt(pr).toString();
  if (canonicalPr !== pr)
    fail(
      2,
      `drive.ts: write PR #${canonicalPr} as ${canonicalPr} (got '${pr}')`,
    );
}

/**
 * The drive state read again once this driver holds the locks, and the
 * re-arm admission repeated against it: the read before the locks only
 * refuses early, and a holder that stopped since (a quota wall recorded, a
 * park added) changed what is admitted. An unreadable state refuses here:
 * picking the drive up without it would skip the answers a re-arm kept, and
 * the next completed pass would clear them unread.
 */
async function stateUnderLocks(
  pr: string,
  agent: string[],
  windowReopened: boolean,
): Promise<DriveState | number> {
  const state = await readDriveState(pr);
  if (state === null)
    return fail(
      1,
      `drive.ts: cannot read PR #${pr}'s drive state now that its locks are held; refusing to pick the drive up without it`,
    );
  return quotaRefusal(state, agent, windowReopened) ?? state;
}

export async function main(): Promise<number> {
  const options = parseDriverOptions(process.argv.slice(2));
  let { pr, keepDraft, handoffAt } = options;
  const { maxRounds, dryRun, botsOnly, passTimeout, forward, agent } = options;
  const { takeOver, windowReopened } = options;

  const maxRoundsN = resolveMaxRounds(maxRounds);
  const deadlineRetryBudget = resolvePassDeadlineRetries();

  // When a draft is marked Ready: `--keep-draft` wins, else the repository's
  // `pull_requests.mark_ready`. Read once, up front: an unreadable policy
  // stops the drive rather than guessing when to summon more reviewers.
  let markReadyPolicy: MarkReady = 1;
  try {
    markReadyPolicy = prPolicy().markReady;
  } catch (e) {
    fail(1, `drive.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (markReadyPolicy === "never") keepDraft = true;

  applyPassTimeout(passTimeout);

  handoffAt = resolveHandoffAt(handoffAt);

  if (!dryRun && agent.length === 0) {
    fail(
      2,
      "usage: drive.ts [PR] [flags] -- <command to run one pass> [args...]",
    );
  }

  const explicitPr = pr;
  pr = await resolvePr(pr);
  if (pr === "") fail(1, "drive.ts: could not resolve a PR number");
  requireCanonicalPr(pr);
  process.env.PR = pr;
  // The authoritative, out-of-band statement of which PR this drive is about.
  // drive-status.ts refuses to run when a pass resolves a different one, which
  // is what makes driver/pass agreement an assertion rather than an inference
  // from whatever the pass's prompt happens to contain. The argv check below
  // stays as a cheap early typo-catcher; this is the guarantee.
  process.env.DRIVE_PR_TARGET = pr;

  // Both shared resources, in a fixed order — see § Single-instance locking.
  // Both names live in the state dir: one keyed by PR, one by the working tree
  // — see `worktreeLockName` for why the latter may not be keyed by anything a
  // second driver in the same tree can be configured to compute differently.
  const stateDir = await resolveStateDir();
  const mailboxDir = await resolveMailboxDir();

  // The durable log. A drive is routinely armed as a background
  // child of a session that ends long before the drive does (do-item's
  // "Arm the drive" step), and its console output dies with that session — so
  // every line this process prints is ALSO appended here, beside the per-PR
  // state it belongs to. The PASS is deliberately not captured: it runs with
  // inherited stdio (see the spawn below), and routing it through a pipe
  // instead would change `run()`'s close semantics — a detached descendant of
  // the pass holding the pipe open past the leader's exit would wedge the
  // round. This log is the DRIVER's narrative: round decisions, refusals,
  // mark-Ready outcomes, and the terminal state.
  const logPath = join(stateDir, `drive-pr-${pr}.log`);
  startDriverLog(logPath);

  // Everything that can refuse from the arguments and the durable state runs
  // before any lock is taken and before a takeover stops anyone: the pass
  // command's target and scope, and a re-arm behind a quota wall. The state
  // check is repeated once the locks are held (`stateUnderLocks`).
  const state = await readDriveState(pr);
  const refusal =
    validatePassCommand(explicitPr, agent, botsOnly) ??
    quotaRefusal(state, agent, windowReopened);
  if (refusal !== undefined) return refusal;

  // What this driver publishes about itself into its lock claims — the answer
  // to "who is working my worktree, and on what?" that the exit-11 refusal
  // and the `drives.ts` listing surface. Advisory: lock liveness
  // never reads it (`lib/claim.ts`).
  // Deadlined like every other git call in main(): this runs before any
  // lock is acquired and only feeds the advisory worktree display string, so
  // a hung git must not stall the whole drive at startup.
  // The env is scrubbed of GIT_DIR / GIT_WORK_TREE: a hook-launched driver
  // inherits them for another checkout, and they outrank the cwd, so an
  // unscrubbed call would name THAT checkout in `diag.worktree` — which the
  // intent-chain capture spawn below then anchors its `cwd` to.
  const rootRes = await git(["rev-parse", "--show-toplevel"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
  });
  // Resolved once HERE for the FIRST pass, from THIS process's own
  // environment. `startHeartbeat` below re-resolves on its own timer, but
  // only between passes — see `refreshAccountIdentity`'s own comment for
  // why a token-backed identity never needs that (env vars are fixed for
  // this process's life) while a file-backed one does, and why the rewrite
  // is withheld while a pass is actively running (an operator's login swap
  // mid-drive changes which account the NEXT pass bills, and a diag resolved
  // only here would keep reporting the old one for the rest of the drive's
  // life).
  const account = resolveAccountIdentity(agent);
  const diag: ClaimDiag = {
    pr,
    worktree: rootRes.code === 0 ? rootRes.stdout.trim() : "",
    log: logPath,
    started: new Date().toISOString(),
    account,
  };
  const treeLock: DriveLock = {
    dir: join(stateDir, await worktreeLockName()),
    what: "worktree",
    diag,
  };
  const prLock: DriveLock = {
    dir: join(stateDir, `pr-drive-${pr}.lock`),
    what: `PR #${pr}`,
    diag,
  };
  // A takeover is decided before any lock is taken (`takeover.ts`); its
  // holder is stopped around this tree's lock. Across clones it is decided
  // by the pull request's drive ledger.
  const ledger = await ledgerIdentity(dryRun, stateDir, diag.started);
  const plan = takeOver ? await decideTakeover(pr, ledger) : null;
  const held: DriveLock[] = [];
  using lockResources = new DisposableStack();
  await using lifecycle = installDriverLifecycle(held);
  void lifecycle;
  const hold = async (lock: DriveLock): Promise<void> => {
    // A refusal names the holder's doctor verdict, and the takeover command
    // when a takeover would be admitted.
    await explainingRefusal(lock, driveTs, botsOnly, () => acquire(lock, pr));
    held.push(lock);
    lockResources.use(
      registerCleanup(() => {
        driverRuntime.driverLogRotates = false;
        // An unwitnessed pass termination deliberately abandons these locks.
        if (held.includes(lock)) release(lock);
      }),
    );
  };
  await holdTreeAroundTakeover(
    plan,
    pr,
    { tree: treeLock.dir, pr: prLock.dir },
    () => hold(treeLock),
    armCommand(driveTs, pr, botsOnly),
  );
  // Renewal starts the moment the first lock is held, and runs on its own
  // timer for the rest of the drive — a claim must stay fresh DURING the
  // attach and every pass, not only between them. It renews `held`, so the
  // PR's lock joins it once taken.
  startHeartbeat(held, agent);
  await hold(prLock);
  // Once both the tree and the PR are ours: the tree is put on the PR's head
  // (its branch, or the head commit detached when another working tree holds
  // the branch), so every round's commit lands on what the attach left, no
  // other driver's tree is ever moved, and no second driver of the PR, in
  // another tree, attaches beside this one.
  await attachForDrive(pr, dryRun);
  createDriverRegistry(held);
  lockResources.use(driverStopCompletionCleanup(held));
  driverRuntime.driverLogRotates = true;

  // The SESSION every drive-state mutation of this drive belongs to, exported
  // once the locks are actually held (`lease.ts`). This driver plus
  // every round's pass — each a separate agent process, each with an agent pid
  // of its own — must count as ONE session, or round 2's pass would read round
  // 1's lease as a stranger's; and the session has to stay live for the WHOLE
  // drive, so that an interactive session in this same tree is refused between
  // rounds rather than only during one. This process's own pid is the only id
  // that satisfies both: it spans every pass and dies exactly when the drive
  // does. The locks above stop a second DRIVER; this is what extends that
  // guarantee to a driver-by-hand, which takes no lock at all.
  process.env.DRIVE_PR_SESSION = String(process.pid);

  // The ACQUISITION token behind that pid, exported beside it so a pass can
  // bind "this lock claim" to "the driver that spawned me" rather than to a
  // number the OS reuses. A pid alone cannot: a dead driver's still-fresh
  // claim whose pid the OS then handed to THIS driver reads live (same-host,
  // alive) and self (pid matches), and the pass would wave through a lock its
  // parent never took. This file already treats
  // `diag.started` as the instance token when correlating a worktree lock to
  // a PR lock; `drives.ts` compares the same value against this variable.
  process.env.DRIVE_PR_SESSION_STARTED = diag.started;

  // The TREE this drive drives, so a pass measures local HEAD there rather
  // than wherever its shell happens to stand. A pass is an agent with a
  // persistent shell cwd, and the state dir it legitimately reads — the driver
  // log, the durable state — IS the git common dir: one `cd` there and every
  // later `git rev-parse HEAD` answers with the MAIN worktree's head, which in
  // a Conductor checkout is `develop`. Measured: the gate then reported
  // HEAD_LAG against a head that was never going to arrive, the pass did
  // nothing, and the driver counted the round. Empty when the driver could not
  // resolve its own root, in which case the pass keeps the old behaviour.
  if (diag.worktree !== "") process.env.DRIVE_PR_WORKTREE = diag.worktree;

  // DURABLE knowledge of where this drive's state lives, handed to every pass
  // so the fence never has to re-derive it from a `.git` marker that may be
  // gone by then.
  //
  // `resolveFenceContext` asks git where the state dir is, and falls back to
  // "is a repository in play at all" when git cannot say. That fallback reads
  // the filesystem, so it distinguishes a confirmed absence from an
  // unanswerable look — but a marker that was DELETED or RENAMED is a genuine
  // `ENOENT`, indistinguishable from a tree that never held a repository, and
  // the fence would allow the POST with a still-live lease sitting unread in
  // this directory. No probe can close that from the filesystem alone: the
  // question is not "is there a repository here now" but "was drive state ever
  // resolved here", which only something that remembers can answer.
  //
  // This is that memory, and it costs nothing: the driver already resolved the
  // directory above, the override short-circuits the probe entirely, and every
  // pass is a child of this process. A lease only exists because a drive wrote
  // one, and a drive spawns its own passes — so the path that can actually
  // race an outcome reply is covered.
  //
  // NOT covered, and deliberately not claimed: a purely INTERACTIVE session
  // that took a lease and then lost its `.git`. It has no driver to inherit
  // this from, and recovering the directory after the fact needs durable state
  // outside the repository that nothing here keeps. Named in the fence's own
  // residuals rather than papered over.
  process.env.DRIVE_PR_STATE_DIR = stateDir;

  // The directory's ON-DISK IDENTITY at the moment the driver resolved it —
  // device/inode, birth time, canonical target path and volume UUID — exported because the PATH is exactly
  // what a rename-and-recreate leaves unchanged.
  //
  // Without this, the fence's identity baseline can only be captured by the
  // fence itself, in the same breath as its own enumeration. That closes a
  // swap landing DURING the fence, but not one that completed BEFORE the pass
  // started: the fence would enumerate the empty replacement, capture ITS
  // identity, find that identity perfectly stable throughout, and authorize
  // the POST while the live lease sits in the directory that moved. Only
  // something that observed the directory before the swap can answer that,
  // and the driver is the one thing that did.
  //
  // FAIL CLOSED when it cannot be read, rather than omitting the variable.
  // An earlier revision omitted it, reasoning by analogy with
  // `Lease.sessionStarted`'s leniency — but the analogy does not hold, and the
  // difference is the whole point of this variable. A token-less session
  // genuinely HAS no token, so `''` is the truth about it. A driver that
  // cannot stat its own state directory has not learned "there is no
  // baseline"; it has FAILED TO READ ONE. Omitting the variable publishes the
  // first as though it were the second, and the pass then treats a failed
  // safety read as "no baseline inherited" — so a transient failure here,
  // followed by the directory being replaced before the pass starts, lands in
  // exactly the pre-pass swap window this baseline exists to close.
  //
  // This is the fail-closed rule for gates applied to the producer: a check
  // that cannot read its input has verified nothing, and must say so rather
  // than emit an empty answer. Refusing costs a drive that could not have
  // fenced its own passes anyway.
  const stateDirIdentity = await captureStateDirIdentityToken(stateDir);
  if (stateDirIdentity === "") {
    fail(
      1,
      `drive.ts: could not establish the identity of the drive state directory:`,
      `  ${stateDir}`,
      "",
      "Refusing to start. Every pass this drive spawns inherits that identity as",
      "the baseline proving the directory was not swapped before the pass began;",
      'without it a pass cannot tell a failed read from "no baseline", and would',
      "post unfenced through exactly that window.",
    );
  }
  process.env.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentity;

  // The dial reaches the pass the same way $DRIVE_PR_REFLECT_DUE does, and for
  // the same reason: nothing here can read a session's context usage, so this
  // is an INSTRUCTION to the agent, not a guard over it. SKILL.md § Handing
  // off before you degrade makes acting on it part of the round; a control
  // loop cannot.
  process.env.DRIVE_PR_HANDOFF_AT = handoffAt;

  await ensureContinuousHandoff(handoffAt, pr);

  // Picking the drive up from its durable state: a quota wall another
  // account may pass, a takeover, parked items a person has answered.
  const current = await stateUnderLocks(pr, agent, windowReopened);
  if (typeof current === "number") return current;
  // The pull request's drive ledger next: seed this clone's state from it,
  // refuse to drive beside another clone's driver, claim the drive where
  // this clone does not continue its own ledger.
  const pickup = await armLedger(
    pr,
    ledger,
    plan,
    current,
    armCommand(driveTs, pr, botsOnly, " --take-over"),
  );
  // From here the ledger says this driver is running, so whatever ends the
  // drive (an exit, a thrown refusal, a stop) marks it stopped.
  await using settlement = ledgerSettlement(pr);
  const firstPassNotice = await pickUpDrive(pr, plan, pickup, {
    agent,
    botsOnly,
    dryRun,
    windowReopened,
  });

  // A dry run inspects; it does not work a round. Counting it would inflate
  // the round total the bound is measured against.
  //
  // `--once` too: without it, drive-status.ts takes
  // its OWN internal polling path — up to its full `--timeout` (30 minutes by
  // default) — because `--no-count` marks the reconciliation sweep suppressed
  // (`sweepSuppressed`), and every UNRECONCILED_STOPPERS code (2/7/8/9/10,
  // which includes both repair states this drive can dispatch) can only be
  // CERTIFIED once that sweep has run and succeeded — never true
  // under suppression. So a dry run against a PR sitting in any of those
  // states, or simply not yet settled (case 4), used to block for minutes
  // before reporting anything, which defeats the entire point of a preview.
  // `--once` was already the correct pattern for exactly this shape of call —
  // see `announce-merge-ready.ts`'s own `--no-count` re-read — and this call
  // site is a "re-read" too: dry-run's whole premise is inspecting current
  // state without doing work, i.e. without a prior sweep of its own to lean
  // on either. It still cannot CERTIFY those codes (nothing short of running
  // the sweep can, and a dry run must not mutate GitHub thread state as a side
  // effect of a preview) — it now just says so immediately instead of after a
  // long, silent wait.
  const probeFlags = dryRun ? ["--no-count", "--once"] : [];

  await announceRoundBudget(pr, maxRoundsN, handoffAt);

  await capturePickup(pr, dryRun, diag);

  const roundsExit = await runDriverRounds({
    pr,
    mailboxDir,
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
  });
  return await settlement.done(roundsExit);
}

/** Refuse a pass whose declared target or thread scope differs from the driver. */
function validatePassCommand(
  explicitPr: string,
  agent: string[],
  botsOnly: boolean,
): number | undefined {
  // Guard the mis-targeting above. Only meaningful when the caller NAMED a PR:
  // with no argument the driver and the pass both resolve the current branch's
  // PR, so there is nothing to disagree about. A bare substring test would let
  // PR 12 satisfy a driver waiting on 123, so match the number as a delimited
  // token.
  if (explicitPr !== "" && agent.length > 0) {
    const token = new RegExp(`(?:^|[^0-9])${explicitPr}(?:[^0-9]|$)`);
    const found = agent.some((word) => token.test(word));
    if (!found) {
      console.error(
        `refusing to run: PR #${explicitPr} was given, but the pass command names no PR:`,
      );
      console.error(`  ${agent.map(shellQuote).join(" ")}`);
      console.error(
        "The pass would target the current branch’s PR instead — editing and",
      );
      console.error(
        "resolving threads on a different pull request. Name it explicitly, e.g.",
      );
      console.error(
        `  drive.ts ${explicitPr} -- claude -p "/jig:drive-pr ${explicitPr}"`,
      );
      return 2;
    }
  }

  // --bots-only scopes what the driver COUNTS. A pass that is not also scoped
  // resolves human threads the count never included, and the loop then
  // converges against a different set than the one it watched.
  if (botsOnly && agent.length > 0) {
    const found = agent.some((word) => word.includes("--bots-only"));
    if (!found) {
      fail(
        2,
        "refusing to run: --bots-only was given, but the pass command does not pass it.",
        "The pass would act on human threads the convergence count excludes.",
      );
    }
  }

  return undefined;
}

async function announceRoundBudget(
  pr: string,
  maxRoundsN: number,
  handoffAt: string,
): Promise<void> {
  // Separate bounds, each capped at --max-rounds, because they measure
  // different runaways and neither one covers the other:
  //
  //   `counted`   — the DURABLE count of distinct reviewed heads, bumped by
  //                 drive-status.ts. Blind to a pass that never pushes: the
  //                 head does not move, so this never grows.
  //   `attempts`  — the DURABLE count of passes made on the CURRENT head,
  //                 bumped below. Bounds exactly that case.
  //
  // Both are durable, and that is the correction. `attempts` used to be a
  // per-process counter, which bounded a non-pushing pass only within one
  // process: on an unchanged head `counted` stays flat, so every restart of
  // the driver started from zero and granted another full `--max-rounds`, and
  // a harness that restarts drive.ts ran unbounded passes against a "bounded"
  // loop. Keying `attempts` to the head is what keeps a genuine new round from
  // inheriting the previous head's exhausted budget.
  //
  // They stay SEPARATE counters, though. Seeding one from the other — one
  // counter doing both jobs — is what double-counted a head across a resume:
  // the over-limit head is persisted by drive-status.ts before being rejected
  // here, so an operator who raises the limit to that persisted count starts
  // at N, increments to N+1, and rejects the very round they raised the limit
  // to admit.
  //
  // An unreadable state file is a hard stop, not a zero. Defaulting it would
  // restore exactly the fresh-budget-per-restart hole this closes, on the one
  // path where the evidence has already been lost.
  const resumedRes = await run(tsArgv(driveState, ["rounds", pr]), {
    stderr: "inherit",
  });
  if (resumedRes.code !== 0) {
    fail(
      1,
      `cannot read the durable drive state for PR #${pr}; refusing to drive on an unknown round budget`,
    );
  }
  const resumedRaw = resumedRes.stdout.trim();
  const resumed = isDigits(resumedRaw) ? Number.parseInt(resumedRaw, 10) : 0;
  if (resumed > 0) {
    console.error(
      `resuming PR #${pr} at round ${resumed} of ${maxRoundsN} (from durable state)`,
    );
  }
  // Announced because it is unenforceable. Every other setting here is checked
  // by something; this one is only ever as real as the pass's own judgement,
  // so the human watching stderr is told what the pass was asked to do.
  if (handoffAt === "never") {
    console.error(
      "handoff: never (continuous) — the pass drives through compaction and leans on",
    );
    console.error(
      `  the durable held batch and .context/pr-drive-${pr}.md to survive it.`,
    );
  } else {
    console.error(
      `handoff: at ~${handoffAt}% context (agent-judged, not measured)`,
    );
  }
}

async function capturePickup(
  pr: string,
  dryRun: boolean,
  diag: ClaimDiag,
): Promise<void> {
  // Keep the PR pin captured from the explicit pickup token before arm.
  // Without an existing pin this helper refuses rather than inferring a source
  // from mutable aliases; rounds report missing scope. Best effort,
  // bounded by helperTimeoutSeconds(), and first-write-wins on every re-arm.
  if (!dryRun) {
    // Anchored to the tree this drive drives (`diag.worktree`), not the
    // ambient cwd: the capture CLI reads its PR lookup, intent-chain root and
    // checked-out branch from process.cwd(), so a driver started from a
    // subdirectory would otherwise verify against a different root.
    const cap = await run(tsArgv(captureIntentChain, [pr]), {
      stderr: "pipe",
      timeoutSec: helperTimeoutSeconds(),
      ...(diag.worktree === "" ? {} : { cwd: diag.worktree }),
      // `cwd` alone does not bind git to this worktree: an inherited GIT_DIR
      // (a hook-launched driver) outranks it, and the capture CLI's branch
      // check and chain-root lookup both go through git. The child inherits
      // this scrubbed environment for every git call it makes.
      env: gitIdentityEnv(),
    });
    const said = `${cap.stdout.trim()} ${cap.stderr.trim()}`.trim();
    console.error(
      `intent chain: ${cap.code === 0 ? "pinned" : cap.code === 3 ? "not pinned" : `capture failed (exit ${cap.code})`} for PR #${pr}${said === "" ? "" : ` — ${said}`}`,
    );
  }
}

async function ensureContinuousHandoff(
  handoffAt: string,
  pr: string,
): Promise<void> {
  // `never` is the one setting that expects a compaction to happen MID-ROUND,
  // and a compaction between the reply and the resolve drops the held
  // `accepted` batch unless that batch is durable. So it is gated on the
  // durable-hold backend actually being there rather than assumed: a vendored
  // or older drive-state with no `held-keys` command, or state this driver
  // cannot read, would run a continuous drive with exactly the protection
  // missing that makes it safe. The probe is read-only and returns empty on a
  // fresh drive.
  if (handoffAt === "never") {
    const probe = await run(tsArgv(driveState, ["held-keys", pr]), {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (probe.code !== 0) {
      fail(
        2,
        `refusing --handoff-at never: the durable held batch is unavailable for PR #${pr}.`,
        "That setting runs THROUGH compaction, and a compaction between replying",
        "'**accepted**' and resolving the thread drops the held batch — leaving a",
        "fixed finding re-triaged next round, or two outcome tokens on one thread.",
        `'drive-state.ts held-keys ${pr}' must work first. Either this drive-state.ts`,
        "predates the held batch, or the state file is unreadable — run it directly",
        "to see which. Until then use --handoff-at 50 (or 75).",
      );
    }
  }
}
