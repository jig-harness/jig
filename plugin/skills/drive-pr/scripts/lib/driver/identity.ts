/** Refresh account diagnostics only while the driver still owns its claims and no pass is running. */
import { isDigits, sleep } from "./../cli.ts";

import {
  heartbeatStaleMs,
  type ClaimDiag,
  claimName,
  formatClaim,
} from "./../claim.ts";

import { type AccountIdentity, resolveAccountIdentity } from "./../identity.ts";

import { type DriveLock, inspect, claimWasTakenOver } from "./locks.ts";

import { join } from "node:path";

import { writeFileSync, existsSync, rmSync } from "node:fs";

import { hostname } from "node:os";

import { renameWithRetry } from "./../../../../../shared/rename-with-retry.ts";

import { noteTakeover, touchLock } from "./lifecycle.ts";

import { driverRuntime } from "./runtime.ts";

// The staleness window itself — HEARTBEAT_STALE_MIN_DEFAULT and
// heartbeatStaleMs — lives in `lib/claim.ts` with the rest of the claim's
// interpretation, so `drives.ts` judges live-vs-stale by exactly the rule
// recovery uses here. This is not the `mtime < 2000ms` publication guess that
// was rightly rejected above: that one tried to resolve a race in the
// millisecond a lock was being created, on a filesystem whose timestamp
// granularity is of the same order, while the window bounds a LIVENESS signal
// at a scale where no filesystem's granularity or a shared mount's latency is
// material. Renewal runs on `startHeartbeat`'s own timer at a sixth of the
// window, so even the five-minute floor is refreshed every fifty seconds
// regardless of what the pass is doing.

/**
 * How often a held claim is renewed. A sixth of the staleness window, capped:
 * frequent enough that several consecutive failed refreshes still leave the
 * claim fresh, cheap enough to ignore. The explicit override exists so the
 * mechanism can be exercised in a test at a scale a human would not wait for,
 * and so an operator running a deliberately short window can match it.
 */
function heartbeatRefreshMs(): number {
  const raw = process.env.DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS ?? "";
  if (isDigits(raw)) return Math.max(50, Number.parseInt(raw, 10));
  return Math.max(1_000, Math.min(60_000, Math.floor(heartbeatStaleMs() / 6)));
}

/**
 * Do two identities disagree in any way a display should care about?
 * `reason` IS compared, not excluded. An earlier revision excluded it on the
 * theory that a resolver "can retry the identical failure with
 * differently-worded prose across ticks" — but every resolver in
 * `lib/identity.ts` returns a deterministic template string per cause, never
 * free-form wording, so a retried, unchanged failure always compares equal
 * here regardless. What excluding it actually did was collapse distinct
 * causes: `resolveCodexIdentity`'s unreadable-file, invalid-JSON, and
 * missing-identity outcomes all share `{account:null, vendor:'codex',
 * provenance:'CODEX_HOME auth.json'}` and differ only by `reason`, so once
 * one was stamped, a transition to a DIFFERENT cause never rewrote the
 * claim — an operator's exit-11 diagnostic or `drives.ts` listing kept
 * reporting an obsolete cause indefinitely. `reason` is user-visible through
 * `formatAccountIdentity`, so a changed cause is exactly the kind of
 * disagreement a display should care about.
 */
function accountChanged(a: AccountIdentity, b: AccountIdentity): boolean {
  return (
    a.account !== b.account ||
    a.vendor !== b.vendor ||
    a.provenance !== b.provenance ||
    a.reason !== b.reason
  );
}

/**
 * Re-resolve the billing account identity, while no pass is actively
 * running, and rewrite every held claim's diagnostics if it changed.
 *
 * WHY THIS EXISTS. `lib/identity.ts` resolves a
 * Claude identity two different ways: `CLAUDE_CODE_OAUTH_TOKEN`, which is
 * THIS PROCESS's own environment and therefore genuinely fixed for the
 * drive's whole life — resolving it once at arm time is correct, and this
 * function's own re-resolution of it will simply keep agreeing forever,
 * confirmed by `accountChanged` returning `false` every tick. But the
 * file-backed path (`oauthAccount` / `CODEX_HOME` auth, i.e. no token set)
 * is LIVE FILE CONTENT the pass re-reads on every fresh spawn — an operator's
 * `/login`, or an account-switching wrapper's own login swap, mid-drive changes
 * which account the NEXT pass actually bills against, while a diag resolved
 * only once at arm time would keep reporting the OLD one for the rest of the
 * drive's life, defeating the whole point of reporting the account in exactly
 * the scenario it exists for.
 *
 * WHY THE CALLER GATES THIS ON "NO ACTIVE PASS". An earlier revision called
 * this unconditionally on every tick, including while a pass was already
 * running. `run` spawns the pass with whatever the environment held AT THAT
 * MOMENT — an already-running child's own billing account does not move — so
 * rewriting the claim mid-pass displayed the account the NEXT pass would
 * use, not the one the CURRENT pass was actually billing against, for the
 * pass's entire remaining life.
 * `startHeartbeat` below only calls this while `activePass` is `null`, so
 * the diag holds steady for an active pass and only moves between passes —
 * exactly the window in which "the next pass's account" and "the account a
 * reader should expect" are the same claim.
 *
 * Piggybacks on the EXISTING heartbeat timer rather than a second one: the
 * same cadence that already proves this driver alive is a fine cadence to
 * notice an identity change at, and it keeps every claim-file write behind
 * the one place that already owns "when does a held claim get touched".
 *
 * RETURNS whether every lock's diag agrees with the freshly-resolved
 * identity by the time this call returns — `false` on a transient rewrite
 * failure (a lock left retryable, `compromised` untouched) OR a detected
 * takeover (`compromised` set). The heartbeat-timer and post-pass callers
 * ignore this: a `false` there just means the NEXT tick or the pre-spawn
 * call retries. The pre-spawn call site cannot afford to ignore it — see
 * its own comment for why.
 */
export function refreshAccountIdentity(
  locks: DriveLock[],
  passArgv: readonly string[],
): boolean {
  if (locks.every((l) => l.diag === undefined)) return true; // never taken, or diag never stamped — nothing to synchronize
  const fresh = resolveAccountIdentity(passArgv);
  let allSynced = true;
  for (const lock of locks) {
    if (lock.diag === undefined || lock.nonce === undefined) continue;
    // Checked PER LOCK, not once up front against a single shared `current`:
    // a shared check against only the FIRST lock with a diag would, on a
    // match, skip the others. A transient failure rewriting one lock (caught by
    // `rewriteAccountIdentity`, `lock.diag` left unchanged) while another rewrite
    // succeeded would then go permanently unretried — the next tick sees the
    // first lock already agreeing with `fresh` and skips the loop entirely,
    // stranding the failed lock on the stale account until some LATER
    // identity change happens to give it another chance. Each lock instead
    // retries independently until ITS OWN diag agrees with `fresh`.
    if (!accountChanged(fresh, lock.diag.account)) continue;
    const result = rewriteAccountIdentity(
      lock,
      { ...lock.diag, account: fresh },
      lock.nonce,
    );
    if (result !== "synced") allSynced = false;
    if (result === "taken-over") break;
    // A failed rewrite can also discover takeover during cleanup. Proceeding
    // to the next lock once this one is known compromised
    // risks the identical resurrection race, whichever of the two paths
    // above is what set it.
    if (driverRuntime.compromised !== "") break;
  }
  return allSynced;
}

type AccountRewriteResult = "synced" | "retry" | "taken-over";

/** Confirm the published generation before advancing its in-memory diagnostics. */
function confirmAccountRewrite(
  lock: DriveLock,
  dest: string,
  updated: ClaimDiag,
  nonce: string,
): AccountRewriteResult {
  const afterRewrite = inspect(lock.dir);
  if (afterRewrite.unreadable) {
    // The publishing rename succeeded, so this generation's claim is on
    // disk; a `readdirSync` failure right afterward proves nothing about
    // takeover (see `Occupant.unreadable`). Treat it as the same
    // best-effort transient failure the outer `catch` below handles:
    // leave `lock.diag` unadvanced so a later tick retries and actually
    // confirms which case this was.
    return "retry";
  } else if (
    // See `claimWasTakenOver`'s own comment for why this covers both
    // coexistence AND a full successor-only transition, not just the
    // former.
    claimWasTakenOver(afterRewrite.claimNames, claimName(nonce))
  ) {
    // First, before the cleanup below can print anything.
    noteTakeover(lock);
    if (afterRewrite.claimNames.length > 1) {
      try {
        rmSync(dest, { force: true });
      } catch {
        // NOT harmless if this fails. `inspect()` reads
        // `claim: null` for a directory holding more than one `claim.*`
        // entry, and `acquire()` refuses outright rather than guess which
        // one is real — so a resurrected entry that survives this removal
        // wedges the lock PERMANENTLY: no future driver, this generation's
        // takeover included, can ever auto-recover `lock.dir` again. This
        // generation is about to stop (via `compromised`, set above) either
        // way, so print the one thing an operator needs and cannot
        // otherwise discover on their own: which directory needs manual
        // cleanup, and why automatic recovery will never happen for it.
        console.error(
          `drive.ts: could not remove the resurrected claim at ${dest} — ${lock.dir} now permanently holds more than one claim and no driver can auto-recover it. Manual fix required: inspect the directory and remove the stale entry by hand.`,
        );
      }
    }
    // A successor-only transition (exactly one claim, not ours) and a
    // vanished claim set (zero claims — the successor removed ours but
    // had not yet installed its own when this landed) both hit this
    // branch too, but `dest` (our own name) is already gone by then —
    // either the successor's `retire()` removed it and rebuilt
    // `lock.dir` from scratch, or that rebuild simply had not happened
    // yet — so there is nothing of OURS left to remove either way. Any
    // claim present now belongs to someone else; touching it would be
    // exactly the destructive cross-driver mutation this generation
    // exists to avoid, so both cases only ever stop driving, never
    // mutate the directory.

    // Stop entirely, not just this lock: `held` is ordered worktree lock
    // first, PR lock second, so a `continue` here would proceed straight
    // into the rewrite path for the NEXT lock while this generation is
    // already known to have lost one — potentially resurrecting a claim
    // beside a successor that is concurrently acquiring it and
    // permanently wedging that lock.
    return "taken-over";
  } else {
    // Advanced only NOW, after the rewrite is actually on disk AND
    // confirmed unchallenged. An earlier revision set `lock.diag =
    // updated` before attempting the write — so a failed
    // `writeFileSync`/`renameSync` still left the in-memory diag
    // pointing at `updated`, and the NEXT tick's `accountChanged`
    // compared a fresh read against that already-advanced value, saw no
    // difference, and never retried — stranding one or all persisted
    // claims on the stale account for the rest of the drive.
    lock.diag = updated;
    return "synced";
  }
}

/** Atomically publish one account update, retaining retry and takeover evidence. */
function rewriteAccountIdentity(
  lock: DriveLock,
  updated: ClaimDiag,
  nonce: string,
): AccountRewriteResult {
  const dest = join(lock.dir, claimName(nonce));
  // Deliberately OUTSIDE the `claim.` namespace `CLAIM_PREFIX` names — a
  // name like `${dest}.rewrite-${pid}` still STARTS WITH `claim.`, so
  // between this write and the rename below the directory would briefly
  // hold two entries `inspect()`'s `claimNames` scan both counts
  // as generations. That reads as debris to every concurrent reader:
  // `drives.ts --json` reports `contested` instead of `live`, and a
  // concurrent `acquire()` sees more-than-one claim and refuses outright.
  // A name that never matches `CLAIM_PREFIX` is invisible to that scan for
  // the whole window, so exactly one claim is ever visible until the
  // atomic rename installs the new one.
  const tmp = join(lock.dir, `rewrite.${nonce}.${process.pid}`);
  try {
    writeFileSync(tmp, formatClaim(process.pid, hostname(), updated));
    // Re-confirmed IMMEDIATELY before the rename, not assumed from
    // `touchLock` having run earlier this same tick: `writeFileSync` above
    // is real disk I/O, wide enough for a concurrent recovery to delete
    // `dest` and install a successor's own claim while it runs. Renaming
    // over that regardless would still republish this generation's
    // obsolete claim ALONGSIDE the successor's — both now reading as valid
    // — even with `touchLock` correctly ordered first. This does not make
    // the check and the rename atomic with each other — no POSIX primitive
    // here does — but it narrows the exposure from the full write's
    // duration down to the gap between a stat and a rename. The
    // post-rename check below is what actually closes the remainder —
    // `touchLock`'s own next tick cannot.
    if (!existsSync(dest)) {
      throw new Error("claim recovered mid-rewrite");
    }
    // `rename(2)` is what makes THIS step atomic from a reader's
    // perspective — never a torn write of this call's own making: a
    // concurrent reader of `dest` sees either the complete old content or
    // the complete new content, nothing in between.
    renameWithRetry(tmp, dest);
    // The `existsSync` check above narrows the exposure but does not close
    // it: a recovery can still land in the gap between that check and this
    // rename, retiring `lock.dir` (removing `dest`, then `rmdirSync`-ing the
    // directory itself) and reinstalling it fresh with the SUCCESSOR's own
    // differently-named claim — after which THIS rename recreates `dest`
    // regardless, republishing our now-obsolete generation ALONGSIDE the
    // successor's, both reading as valid. `touchLock`'s own next tick is NOT
    // a backstop for this: it addresses `dest` by the same fixed name, so a
    // resurrected file there makes its `utimesSync` succeed and permanently
    // masks the takeover instead of catching it. Detect it here instead, the
    // only place that still knows a rewrite just happened: a directory
    // holding more than one claim is exactly what `acquire` already treats
    // as unreachable-by-construction, so treat it as this generation's own
    // takeover signal and repair it immediately rather than leaving a ghost
    // for the next reader to trip on.
    return confirmAccountRewrite(lock, dest, updated, nonce);
  } catch {
    // Best-effort: a later tick retries — `lock.diag` is left unchanged
    // above precisely so that retry actually fires. Not this tick's job
    // to force — same posture `touchLock` already takes on its own
    // refresh failures.
    //
    // But an ordinary transient write failure (permissions, a full disk,
    // a slow filesystem) is not the only way to land here: `writeFileSync`
    // itself throws ENOENT when a contender has ALREADY retired `lock.dir`
    // before this call ever ran, and the `!existsSync(dest)` check above
    // throws for the narrower race it exists to catch. The resurrection
    // check further up only runs on the SUCCESS path (after a completed
    // rename), so a failure that stems from `dest` genuinely being gone
    // needs its own check here — otherwise this generation's claim can
    // vanish with `compromised` never set, and this driver keeps going
    // with no claim protecting the tree at all.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Leftover tmp file; harmless — the next successful tick's rename
      // overwrites its own tmp path, and this one shares no name with it.
    }
    if (!existsSync(dest)) {
      noteTakeover(lock);
    }
    return "retry";
  }
}

/**
 * `refreshAccountIdentity`, retried a bounded few times when the rewrite
 * merely failed transiently (a full disk, a slow filesystem) rather than
 * detecting a takeover — the last chance to close the staleness window
 * before a pass spawns, same reasoning as the ordinary-pass spawn site that
 * introduced this retry:
 * active-pass gating suppresses the heartbeat's own retries the moment a
 * pass starts, so a rewrite left unretried here would strand a stale claim
 * for that whole pass's life. Bounded rather than looped until success — a
 * filesystem stuck longer than this must not block the drive from ever
 * spawning another pass over a DISPLAY value.
 *
 * Stops retrying immediately once `compromised` is set: sleeping further
 * would only delay the caller's own takeover handling, never change it.
 *
 * Shared by both spawn sites:
 * the repair-pass spawn used to call `refreshAccountIdentity` directly and
 * discard its result, so a transient failure there went unretried right up
 * to the next repair spawn — the same gap this retry closed for the
 * ordinary-pass spawn, just never generalized to the second call site.
 */
export async function refreshAccountIdentityBeforeSpawn(
  locks: DriveLock[],
  passArgv: readonly string[],
): Promise<boolean> {
  let identitySynced = refreshAccountIdentity(locks, passArgv);
  for (
    let attempt = 1;
    !identitySynced && driverRuntime.compromised === "" && attempt < 3;
    attempt++
  ) {
    // `sleep()` (`lib/cli.ts`) takes SECONDS, not milliseconds — `sleep(200)`
    // waited 200 SECONDS per retry, not 200ms, holding the driver's locks
    // without launching a pass for up to ~6m40s across both retries.
    await sleep(0.2);
    identitySynced = refreshAccountIdentity(locks, passArgv);
  }
  return identitySynced;
}

/**
 * Renew every held claim on a timer of its OWN, independent of the round loop.
 *
 * Refreshing once per round made a claim only as fresh as the round was short,
 * and a round is not short: one runs an agent pass, the fixes it decides on,
 * the full gate suite and sometimes a Testbox. A single ordinary pass can
 * outlast the staleness window, and another start would then quarantine the
 * locks of a driver that is demonstrably alive and working — reintroducing the
 * concurrent editing and pushes the lock exists to prevent. A lease has to be
 * renewed WHILE the work happens, not between units of it.
 *
 * `run()` spawns asynchronously, so the event loop stays live for the whole
 * pass and this timer fires during it. `unref` keeps the timer from holding
 * the process open on its own account.
 *
 * `touchLock` runs FIRST, every tick, unconditionally — `refreshAccountIdentity`
 * runs after, and only when this tick found no takeover and no pass is
 * currently running. Both restrictions close a real defect:
 *
 * - **Takeover ordering.** The reverse order let `refreshAccountIdentity`'s
 *   rename RECREATE a claim file a recovering driver had just removed,
 *   before `touchLock` ever got to notice the absence — republishing this
 *   generation's now-obsolete claim and defeating `touchLock`'s takeover
 *   detection outright (its own comment: "the only thing that removes
 *   `claim.<ours>` is a recovery of this generation"). Detecting the
 *   takeover first, and skipping the rewrite once `compromised` is set,
 *   means nothing this tick ever recreates a claim a recovery just deleted.
 * - **Active-pass gating.** See `refreshAccountIdentity`'s own comment for
 *   why rewriting mid-pass showed the NEXT pass's account while the CURRENT
 *   one was still running.
 */
export function startHeartbeat(
  locks: DriveLock[],
  passArgv: readonly string[],
): void {
  const timer = setInterval(() => {
    for (const lock of locks) touchLock(lock);
    if (driverRuntime.compromised === "" && driverRuntime.activePass === null) {
      refreshAccountIdentity(locks, passArgv);
    }
  }, heartbeatRefreshMs());
  timer.unref?.();
}
