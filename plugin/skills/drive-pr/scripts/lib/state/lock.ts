/**
 * A per-PR mutex around the whole read-modify-write, because the atomic
 * rename in `store.ts` makes each write complete but does NOT serialise the
 * transaction around it. Two drivers reading the same state, each adding a
 * different parked item, both rename: the later one wins outright and the
 * earlier parked decision is gone — a HITL decision forgotten, or a durable
 * round bound weakened, with no error anywhere. Conductor runs many worktrees
 * against one clone, and the state dir is the git dir, so concurrent drivers
 * are the normal case here rather than an exotic one.
 *
 * `mkdir` is the mutex: it is atomic on every filesystem this runs on, unlike
 * `flock`, which macOS does not ship (and Windows never did). A lock left
 * behind by a killed driver would block every later one forever, so one older
 * than the staleness window is broken rather than waited on.
 */

import { poll, PollTimeoutError } from "../../../../../shared/retry.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { registerCleanup } from "../../../../../shared/cleanup.ts";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ExitError, sleep, testDelaySeconds, testPacing } from "../cli.ts";

/**
 * The hard ceiling on how long ONE `acquire()` may wait, whatever
 * `DRIVE_PR_LOCK_TIMEOUT` asks for — see the clamp in `acquire` for why an
 * unbounded value is refused rather than honoured.
 *
 * Exported because it is not only a lock concern: it is the longest a command
 * can sit ADMITTED-but-waiting between `claimLease` returning and its mutation
 * running, so `lease.ts` floors its staleness window above it. Dependency runs
 * one way only — `lease.ts` imports this, never the reverse.
 */
export const LOCK_ACQUIRE_MAX_SEC = 300;

/**
 * Recovery dances (both `acquire`'s stale-break and `release`'s quarantine-
 * and-maybe-restore) are a handful of synchronous syscalls with no `await`
 * in between outside tests, so anything holding `.recovering` past this age
 * cannot be a live dance — it is one abandoned mid-flight by a crash.
 * Deliberately generous relative to the microsecond-scale real duration: a
 * false break only reopens the narrow window this gate exists to close, for
 * one attempt, which is never worse than not having the gate at all.
 *
 * Exported (not merely local to `createLock`'s closure) so a foreign, read-only
 * observer of the SAME `.recovering` gate — `migrate-legacy- state.ts`'s own
 * quiescence scans, which never acquire this lock at all — can apply the
 * identical staleness policy instead of hand-rolling a second magic number that
 * could silently drift from this one (`references/consistency.md`).
 */
export const RECOVERING_STALE_MS = 5_000;

/**
 * The generation grammar `generationOf` (below) actually produces: either an
 * owner marker's basename — `owner.<hex>`, `randomBytes(12).toString('hex')`,
 * always exactly 24 characters — or, when a displaced holder left no marker
 * to read, its `unowned-<mtime>` stand-in (`Math.trunc(statSync(dir)
 * .mtimeMs)`, genuinely unbounded, hence `[0-9]+` rather than a pinned
 * length).
 *
 * Exported so `sweepLockQuarantine` (this file) and `reap-state.ts`'s
 * classifier match the SAME grammar the producer emits — a producer and a
 * matcher maintained as two independent copies is exactly what drifted apart
 * (`reap-state.ts`'s own copy briefly went unbounded, then had to be pinned
 * back to 24 hex chars once a narrower variant of the same over-match
 * recurred). Single source of truth here instead.
 */
export const LOCK_GENERATION_RE = /(?:owner\.[0-9a-f]{24}|unowned-[0-9]+)/
  .source;

/**
 * `acquire` throws plain `ExitError(1)` for TWO different reasons: genuine
 * contention it gave up waiting on, and an infrastructure failure (could not
 * create the ownership marker after winning the `mkdir` — `EACCES`, `ENOSPC`, a
 * read-only filesystem) that has nothing to do with a rival holder. A caller
 * that blanket-converts every `ExitError` from `acquire` into "another worktree
 * is busy, retry" (as `claimPrLease`'s own gate first did) relabels the second
 * case as the first, hiding a broken state directory behind a message that
 * tells a human or an orchestrator to wait it out.
 *
 * This subclass marks ONLY the two deadline-exceeded throw sites — never the
 * marker-creation failure — so a caller that wants to react differently to
 * "timed out waiting" than to "acquire itself is broken" can `instanceof`
 * this specific class rather than the generic `ExitError` every other
 * `acquire` failure also is. Extending `ExitError` (not replacing it) means
 * every EXISTING `e instanceof ExitError` check anywhere in this codebase
 * keeps matching unchanged — this is additive, not a narrowing of that type.
 */
export class LockAcquireTimeoutError extends ExitError {
  constructor() {
    super(1);
  }
}

/**
 * `DRIVE_PR_LOCK_STALE_MIN`'s parsed value (default 10, minutes) — the same
 * parse `acquire()` runs internally, pulled out so `lockHeartbeatMs()` below
 * can share it rather than drift from a second copy.
 */
function lockStaleMinutes(): number {
  const raw = process.env.DRIVE_PR_LOCK_STALE_MIN ?? "10";
  return /^-?[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : 10;
}

/** Never heartbeat slower than this, however large the staleness window is. */
const LOCK_HEARTBEAT_MAX_MS = 120_000;

/**
 * How often a caller holding a `PathLock` across a long critical section —
 * `guarded-push.ts`'s `git push`, which can legitimately run for the whole of
 * `$DRIVE_PR_PUSH_TIMEOUT` (an hour by default, pre-push hooks included) —
 * must call `touch()` to keep the hold from LOOKING stale to a contending
 * `acquire()` elsewhere. Mirrors `lease.ts`'s own `renewAfterMs`: a quarter of
 * the staleness window, capped, so a heartbeat is always many times more
 * frequent than the expiry it defends against and a single missed tick is
 * never fatal. Floored at one second so a hostile override (the test suite's
 * `DRIVE_PR_LOCK_STALE_MIN=-1` "always stale" window) cannot produce a zero
 * or negative `setInterval` delay.
 */
export function lockHeartbeatMs(): number {
  const staleMs = lockStaleMinutes() * 60_000;
  const derived = Math.max(
    1_000,
    Math.min(LOCK_HEARTBEAT_MAX_MS, Math.floor(staleMs / 4)),
  );
  // Test pacing seam: a test that watches a heartbeat refresh a held lock
  // would otherwise sleep through at least one whole derived interval (15s at
  // the smallest staleness window).
  return testPacing("DRIVE_PR_LOCK_HEARTBEAT_MS", derived, 100);
}

export interface PathLock extends Disposable {
  /**
   * @param maxWaitSec optional cap on THIS call's wait, applied on top of the
   * configured timeout (never above it). For a caller waiting through many
   * locks under one deadline — `clearAllLeases`'s sweep — so N locks cannot
   * cost N × the per-lock bound.
   */
  acquire(maxWaitSec?: number): Promise<void>;
  release(): void;
  /** Release this lock and remove its process cleanup registration. Idempotent. */
  dispose(): void;
  /**
   * Refresh this lock directory's mtime so a hold that legitimately outlives
   * `DRIVE_PR_LOCK_STALE_MIN` never reads as abandoned to a contending
   * `acquire()` — see `lockHeartbeatMs()`. A no-op unless this process
   * currently holds the lock; best-effort otherwise (a failed touch just
   * means the next heartbeat tries again, and if the lock is genuinely gone
   * this process's own eventual `release()` — not `touch()` — is what
   * discovers that).
   */
  touch(): void;
}

/**
 * Create the lock for one state file. `label` names the owning script in the
 * lock's own diagnostics; `prLabel` names the PR in the timeout message.
 *
 * Release runs on process exit and on SIGINT/SIGTERM (the bash `trap
 * release_lock EXIT INT TERM`), and releases only the lock INSTANCE this
 * process acquired, identified by a uniquely named file placed inside it. A
 * held-flag alone records that we once acquired the path, which is not the
 * same claim: an updater suspended past the stale threshold has its lock
 * broken and replaced by another driver, and on resuming would delete that
 * driver's live lock — letting a third in concurrently, which is the lost
 * parked decision the mutex exists to prevent, reached through the mutex
 * itself.
 *
 * Both `acquire`'s stale-break and `release` quarantine through the SAME path
 * scheme, `quarantinePath` below, keyed to the GENERATION being displaced (the
 * owner marker's own name) rather than to the acting process's identity. A
 * private, pid-keyed destination is not a fence at all — it is always free, so
 * the rename onto it always succeeds regardless of what is actually at the
 * canonical path, and a check-then-restore cannot make up for that afterwards:
 * the restore renames the (possibly wrong) directory back onto the canonical
 * path BARE, and `rename(2)` onto an empty directory succeeds and silently
 * replaces it, so a third contender that took the path in the meantime is the
 * one that vanishes (this is the exact design `drive.ts` tried and rejected,
 * see its `release`).
 *
 * A generation-keyed destination is what makes rename itself the PRIMARY
 * fence for the case that matters: two operations that would each displace
 * the SAME generation through THIS protocol — a breaker recovering it as
 * stale, or its own owner releasing it — necessarily aim at the identical
 * `<lock>.stale.<generation>` path, and `rename(2)` refuses a non-empty
 * destination, so whichever runs second fails outright, before it can move
 * anything, and the check-then-restore step below is never even reached.
 * That covers every REAL race, because every contender in this codebase
 * goes through this same protocol.
 *
 * It does not cover a directory that arrives at the canonical path by some
 * OTHER means entirely — a raw filesystem operation, or an older, unpatched
 * driver process from a rolling deploy — which never claimed this
 * generation's slot and so does not collide with it. For that, `release`
 * still verifies what it moved by checking for its own marker afterwards,
 * and restores it if the check fails.
 *
 * That restore is itself a rename OUT (already happened) followed by a rename
 * BACK IN, and between the two, the canonical `lock` path genuinely does not
 * exist — a window a completely unrelated, gate-unaware fresh `mkdirSync(lock)`
 * could win, believing the path legitimately free, while the generation this
 * process is trying to give BACK still believes it holds the mutex. Two
 * believed-holders at once is exactly the lost-parked- decision failure this
 * whole file exists to prevent (`acquire`'s own stale-break restore has the
 * identical gap for the symmetric reason — it can grab a FRESH replacement by
 * mistake in the same kind of syscall-gap already covered for the async case,
 * and must then give it back the same way).
 *
 * `${lock}.recovering` closes it: a second, short-lived mkdir-based gate that
 * BOTH `release`'s quarantine-and-maybe-restore dance and `acquire`'s
 * stale-break dance must hold for their entire rename-out-through-maybe-
 * restore sequence, and that a fresh `mkdirSync(lock)` success checks before
 * treating itself as final. A fresh acquirer that lands in someone else's held
 * vacancy window backs off — `rmdirSync` on its own directory, which only
 * succeeds while it is still genuinely empty, so it can never clobber content a
 * concurrent restore already placed there — and retries, rather than believing
 * it holds the mutex. `.recovering` gates every canonical-path mutation
 * (`release`'s and `acquire`'s stale-break dances) and the FINALIZE half of a
 * fresh claim (the vacancy-recheck through the marker write) — but not the
 * fresh claim's own initial `mkdirSync(lock)`, which happens before this
 * process ever attempts `.recovering`'s gate at all and so is NOT itself
 * covered by any of this. For the mutations and finalize sequences that ARE
 * gated, the restore's own rename is guaranteed a destination that is either
 * vacant or still the backing-off acquirer's own (always-empty-until- cleared)
 * directory, never a foreign live one, so it never has anything real left to
 * fail against. A gate abandoned by a crashed holder is broken on sight —
 * everything it protects is a handful of synchronous syscalls with no `await`
 * in between outside tests, so anything older than `RECOVERING_STALE_MS` cannot
 * be a live hold.
 *
 * Which makes the marker a PRECONDITION of holding the lock, not a decoration
 * on it: a lock taken without one can never be released by the process that
 * took it, so `acquire` gives the directory back and fails rather than hold
 * something it cannot let go of.
 */
export function createLock(
  file: string,
  label: string,
  prLabel: string,
): PathLock {
  const lock = `${file}.lock`;
  let lockHeld = false;
  let owner = "";

  /** Where generation `generation` goes when displaced from `lock`. */
  function quarantinePath(generation: string): string {
    return `${lock}.stale.${generation}`;
  }

  /**
   * Mark a quarantined directory permanently non-empty, so no later
   * contender that still holds an observation of this same generation can
   * ever rename onto it. Never swept — see `createLock`'s own doc comment
   * above: emptying it reopens exactly the window this quarantine exists to
   * close, and nothing can prove no such observer remains. Permanence is
   * why the owner marker's name (this function's implicit key, via its
   * caller) needs real entropy — see where it is generated, below.
   *
   * A marker-owning quarantine is already non-empty regardless of this
   * write's outcome, so a failure there only costs the diagnostic. An
   * OWNERLESS quarantine (the abandoned-marker cleanup path below) is
   * different: the directory it moved was itself empty, so if the primary
   * write fails, `doomed` stays genuinely empty — and an empty directory is
   * exactly what a later `rename(2)` onto this same generation-keyed path
   * is free to silently replace, reopening the fence this function exists
   * to make permanent. Fall back to a different syscall class (directory
   * creation instead of file creation) before giving up, since a failure
   * specific to one is not guaranteed to hit the other.
   */
  function tombstone(doomed: string, how: string): void {
    const payload = `${how} by pid ${process.pid}\n`;
    try {
      writeFileSync(join(doomed, "tombstone"), payload);
      return;
    } catch {
      // Fall through to the fallback below.
    }
    try {
      mkdirSync(join(doomed, "tombstone"));
    } catch {
      // Both mechanisms failed (e.g. ENOSPC) — the same failure would also
      // block the state-file write this lock guards, so the fence is moot
      // in that scenario.
    }
  }

  /**
   * The generation currently occupying `lock` — the owner marker's own file
   * name, or an `unowned-<mtime>` stand-in when it has none. Two contenders
   * that observed the SAME generation this way are guaranteed to compute the
   * same key, which is the entire mechanism above.
   */
  function generationOf(dir: string): string | null {
    try {
      const marker = readdirSync(dir).find((f) => f.startsWith("owner."));
      return marker ?? `unowned-${Math.trunc(statSync(dir).mtimeMs)}`;
    } catch {
      return null; // already gone
    }
  }

  const recovering = `${lock}.recovering`;
  /** Where holder `generation` goes when displaced from `.recovering`. */
  function recoveringQuarantinePath(generation: string): string {
    return `${recovering}.stale.${generation}`;
  }
  // How long a contender will wait for `.recovering` to free up before
  // giving up on THIS attempt (acquire's stale-break falls through to its
  // normal retry loop; `release` does nothing rather than mutate ungated —
  // see its own comment). Small relative to the outer acquire timeout,
  // since genuine contention on this gate is expected to clear in well
  // under a millisecond.
  const RECOVERING_GATE_WAIT_MS = 1_000;
  // Paced backoff between gate-acquisition retries under live contention — a
  // genuine synchronous BLOCK (Atomics.wait, portable across Node and Bun,
  // unlike `Bun.sleepSync`), not a busy spin: a zero-delay retry loop pegs a
  // CPU core for up to a second under contention.
  const RECOVERING_GATE_BACKOFF_MS = 5;
  const recoveringBackoffFlag = new Int32Array(new SharedArrayBuffer(4));
  function recoveringGateBackoff(): void {
    Atomics.wait(recoveringBackoffFlag, 0, 0, RECOVERING_GATE_BACKOFF_MS);
  }

  // Test-only concurrency hook for `recoveringIsLive`'s own staleness-check-
  // to-removal gap, mirroring `testAcquireStall` above — SYNC, because
  // `recoveringIsLive` must stay callable from `release`'s signal-handler
  // path. Proving the identity-verified removal actually refuses a fresh
  // replacement needs a way to STALL
  // right there deterministically while a test swaps `.recovering` out.
  function testRecoveringStall(): void {
    const delaySec = testDelaySeconds(
      "DRIVE_PR_LOCK_RECOVERING_TEST_DELAY",
      "recovering",
    );
    const signal = process.env.DRIVE_PR_LOCK_RECOVERING_TEST_SIGNAL;
    if (signal) writeFileSync(signal, "");
    if (delaySec > 0) {
      Atomics.wait(recoveringBackoffFlag, 0, 0, delaySec * 1000);
    }
  }

  /**
   * Is `.recovering` a live hold? Breaks it — verified by IDENTITY, not by
   * blind removal-by-path — and reports `false` if it is older than
   * `RECOVERING_STALE_MS`.
   *
   * A bare `rmSync(recovering, ...)` after this mtime check is the SAME
   * path-keyed TOCTOU class this whole file exists to fix, reintroduced one
   * level down: between the check and the removal, another contender can
   * legitimately replace `.recovering` with a fresh hold (or a long- suspended
   * TRUE holder can resume and have ITS OWN `releaseRecoveringGate` delete a
   * successor's gate the same way). Keying the removal to the observed holder
   * marker, through the same generation-keyed rename
   * `quarantinePath`/`generationOf` already use for `lock` itself, makes two
   * contenders that would displace the SAME holder collide instead of one
   * silently destroying the other's live gate.
   */
  function recoveringIsLive(): boolean {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(recovering).mtimeMs;
    } catch {
      return false; // already gone
    }
    if (Date.now() - mtimeMs <= RECOVERING_STALE_MS) return true;
    testRecoveringStall();
    const holder = generationOf(recovering);
    if (holder === null) {
      // Either already gone, or a malformed non-directory node sitting at this
      // exact path — `generationOf`'s `readdirSync` throws ENOTDIR against a
      // plain file the same way it throws ENOENT against nothing at all, and
      // this branch used to report `false` WITHOUT ever removing it: a leftover
      // file here reads as freshly-stale on every later check forever (nothing
      // ever touches its mtime), so `acquireRecoveringGate`'s own
      // `mkdirSync(recovering)` can never succeed over it either — permanently
      // blocking every later `release()` from ever getting the gate. `rmSync`
      // here is a no-op when it is genuinely already gone, and a real cleanup
      // when it is junk — nothing valid is ever at this path without a readable
      // generation marker.
      try {
        rmSync(recovering, { recursive: true, force: true });
      } catch {
        // best effort
      }
      return false;
    }
    const doomed = recoveringQuarantinePath(holder);
    let moved = true;
    try {
      renameSync(recovering, doomed);
    } catch {
      // Someone else is already breaking (or released) this exact holder —
      // nothing of ours moved.
      moved = false;
    }
    if (!moved) return existsSync(recovering);
    // Distinguish "the stale holder originally observed above" from "a
    // FRESH replacement that appeared in the syscall gap `testRecoveringStall`
    // exists to widen for tests" — exactly the question `acquire`'s own
    // `actuallyStale` answers for `lock`, and the same reason it answers it
    // the same way: `holder` was read from whatever is CURRENTLY at
    // `recovering` right before this rename, so a marker-identity check
    // here would always trivially match regardless of whether a
    // replacement happened — only the moved copy's OWN mtime, which
    // travels with the directory through the rename, can tell a genuinely
    // old hold apart from one that only LOOKS old because it was renamed
    // moments after being (re)created.
    let actuallyStale = false;
    try {
      actuallyStale =
        Date.now() - statSync(doomed).mtimeMs > RECOVERING_STALE_MS;
    } catch {
      actuallyStale = false;
    }
    if (actuallyStale) {
      // Permanent, like `lock`'s own tombstones — NOT "single-use and
      // therefore safe to delete": the
      // ORIGINAL holder can be merely SUSPENDED, not dead, and resume to
      // call `releaseRecoveringGate` with this SAME holder name later.
      // Deleting this path would reopen it for that late call to rename a
      // THEN-live, unrelated gate onto — the post-rename identity check
      // there usually (not always: an accepted residual) catches it, but
      // the PRIMARY fence — a later rename onto a still-occupied
      // destination failing outright, before it can move anything — is
      // what actually closes it, exactly the way it already does for
      // `lock` itself.
      tombstone(doomed, "recovering-broken");
      return false; // genuinely broken
    }
    // Grabbed a FRESH replacement by mistake — restore it. `.recovering`
    // carries no state worth preserving beyond its own exclusivity, but
    // discarding it here would silently strip the fresh holder of the
    // gate it believes it holds, letting whatever it is protecting overlap
    // with a second dance — worse than the accepted, narrow residual a bare
    // restore leaves (a fourth-order compounded race landing in THIS
    // restore's own vacancy window).
    try {
      renameSync(doomed, recovering);
    } catch {
      console.error(
        `${label}: broke a .recovering hold that turned out to belong to another driver, and it could not be restored (it is at ${doomed}).`,
      );
    }
    return true;
  }

  /**
   * Claim `.recovering` for the caller's own rename-out-through-maybe-
   * restore sequence, breaking an abandoned hold on sight. Returns the
   * holder marker (pass to `releaseRecoveringGate`) or `null` on a bounded
   * timeout against genuine (non-stale) contention — the caller decides
   * what "could not get the gate this attempt" means for its own protocol;
   * this function never waits unboundedly.
   */
  function acquireRecoveringGate(): string | null {
    // `performance.now()`, not `Date.now()` — the outer `acquireDeadline`
    // already switched for exactly this reason:
    // a wall-clock adjustment mid-contention (or a persistent EACCES/EROFS
    // failure) can make a `Date.now()`-based deadline unreachable, and the
    // outer, monotonic deadline can't regain control while THIS inner loop
    // is the one stuck.
    const deadline = performance.now() + RECOVERING_GATE_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(recovering);
      } catch {
        // Check the deadline unconditionally, BEFORE branching on
        // `recoveringIsLive()` — a `mkdirSync` failure that is not genuine
        // contention (EACCES, EROFS, a vanished parent directory) also fails
        // `statSync(recovering)` inside `recoveringIsLive()`, which reads as
        // "already gone" and used to `continue` straight back to the top with
        // no deadline check at all: an unbounded spin on an error this gate can
        // never clear. Bounding first makes every non-contention failure return
        // within one `RECOVERING_GATE_WAIT_MS` window regardless of what
        // `recoveringIsLive()` reports.
        if (performance.now() > deadline) return null;
        // Pace EVERY failed attempt, not just the ones `recoveringIsLive()`
        // reports as live contention — a persistent, uncleanable failure
        // (EACCES, EROFS, a vanished parent) makes both `mkdirSync` and
        // `recoveringIsLive()`'s own `statSync` fail identically on every
        // iteration, and without backoff on THIS branch too the loop still
        // hot-spins the full `RECOVERING_GATE_WAIT_MS` window even though
        // it is now correctly bounded.
        recoveringIsLive();
        recoveringGateBackoff();
        continue;
      }
      const holder = `owner.${randomBytes(12).toString("hex")}`;
      try {
        writeFileSync(join(recovering, holder), "", { flag: "wx" });
      } catch {
        // Could not mark ownership — give the gate back rather than hold
        // something this process could never prove is its own at release
        // time, mirroring `acquire`'s own abandoned-marker handling below.
        try {
          rmSync(recovering, { recursive: true, force: true });
        } catch {
          // best effort
        }
        return null;
      }
      return holder;
    }
  }

  /** Release a gate this process proved it holds via `acquireRecoveringGate`. */
  function releaseRecoveringGate(holder: string): void {
    const doomed = recoveringQuarantinePath(holder);
    try {
      renameSync(recovering, doomed);
    } catch {
      // Someone else's breaker already reclaimed this exact holder (this
      // process was suspended past RECOVERING_STALE_MS) — not ours to
      // touch anymore.
      return;
    }
    if (existsSync(join(doomed, holder))) {
      // Permanent for the identical reason `recoveringIsLive`'s own break
      // path is (see there): THIS call can itself be the late half of a
      // race against a breaker reclaiming the same holder concurrently,
      // and deleting the destination either one lands on reopens it for
      // whichever runs second to rename a then-live, unrelated gate onto.
      tombstone(doomed, "recovering-released");
      return;
    }
    // Grabbed a successor's gate by mistake (rare — requires this process
    // to have been suspended long enough for a breaker to reclaim its
    // holder AND a fresh acquirer to land, both before this call) — restore
    // it rather than leave that successor believing it holds something that
    // no longer exists.
    try {
      renameSync(doomed, recovering);
    } catch {
      console.error(
        `${label}: released .recovering but it belonged to another driver, and it could not be restored (it is at ${doomed}).`,
      );
    }
  }

  // Test-only concurrency hook, unset (no-op) by default — the sibling of
  // `store.ts`'s `DRIVE_PR_UPDATE_TEST_DELAY` pair, and live in the shipped
  // script for the same reason: proving the re-verification below actually
  // catches a replacement that lands in the gap between the staleness check
  // and the generation read needs a way to STALL right there deterministically
  // while a test swaps the directory out — real concurrency happens between
  // separate OS processes on a timescale no test should wait for.
  async function testAcquireStall(): Promise<void> {
    const delaySec = testDelaySeconds(
      "DRIVE_PR_LOCK_ACQUIRE_TEST_DELAY",
      "acquire",
    );
    const signal = process.env.DRIVE_PR_LOCK_ACQUIRE_TEST_SIGNAL;
    if (signal) writeFileSync(signal, "");
    if (delaySec > 0) await sleep(delaySec);
  }

  function release(): void {
    if (!lockHeld) return;
    lockHeld = false;
    if (owner === "") return;
    const ownerMarker = basename(owner);
    const doomed = quarantinePath(ownerMarker);
    // Hold `.recovering` for the whole rename-out-through-maybe-restore
    // sequence below, exactly like `acquire`'s stale-break does — without
    // it, a fresh `mkdirSync(lock)` could win the vacancy window this
    // creates and this restore would have a foreign occupant to fail
    // against.
    const gateHolder = acquireRecoveringGate();
    if (gateHolder === null) {
      // Could not get the gate within the bound — genuine, sustained contention
      // on it is itself an extreme scenario. Performing the
      // rename-out/verify/restore sequence UNGATED would reopen exactly the
      // vacancy window this gate exists to close (as a fallback, that defeats
      // the whole gate). Do nothing instead: `lock` stays held from every other
      // contender's point of view until the normal staleness window recovers it
      // — worse for liveness, never worse for correctness. `release` runs from
      // signal handlers, which must not block indefinitely to avoid this in the
      // first place.
      console.error(
        `${label}: could not release ${lock} — the recovery gate stayed contended; it will be recovered as stale after the normal staleness window.`,
      );
      return;
    }
    try {
      try {
        renameSync(lock, doomed);
      } catch {
        // This generation's slot is already claimed — by a breaker that went
        // through the SAME quarantine protocol to recover it as stale, or
        // because it was already released. Either way the canonical path is
        // not this generation's to touch anymore, and nothing moved.
        return;
      }
      // The rename above succeeded, which proves the canonical path held
      // THIS generation at that instant — UNLESS whatever replaced it
      // arrived by some means outside this protocol entirely (a raw
      // filesystem swap, or an older, unpatched driver from a rolling
      // deploy), in which case that replacement never claimed this
      // generation's slot and the rename still succeeded, moving it by
      // mistake. Verify before declaring it ours.
      if (existsSync(join(doomed, ownerMarker))) {
        tombstone(doomed, "released");
        return;
      }
      try {
        renameSync(doomed, lock);
      } catch {
        console.error(
          `${label}: released ${lock} but it belonged to another driver, and it could not be restored (it is at ${doomed}).`,
        );
      }
    } finally {
      releaseRecoveringGate(gateHolder);
    }
  }
  const cleanup = registerCleanup(release);
  function dispose(): void {
    cleanup[Symbol.dispose]();
  }

  // Test-only concurrency hook for `touch()`'s own existence-check-to-
  // mtime-write gap, the same shape as `testAcquireStall`/
  // `testRecoveringStall` above. SYNC, like `testRecoveringStall`: `touch()`
  // must stay fully synchronous (it runs from a heartbeat timer with no
  // `await` anywhere in it, the same invariant every OTHER `.recovering`
  // gate holder in this file relies on), so proving the gate actually closes
  // this gap needs a way to stall right here deterministically while a
  // SEPARATE OS process attempts to interleave — a same-thread synchronous
  // block cannot be preempted by anything else in this single-threaded
  // runtime.
  function testTouchStall(): void {
    const delaySec = testDelaySeconds(
      "DRIVE_PR_LOCK_TOUCH_TEST_DELAY",
      "touch",
    );
    const signal = process.env.DRIVE_PR_LOCK_TOUCH_TEST_SIGNAL;
    if (signal) writeFileSync(signal, "");
    if (delaySec > 0) {
      Atomics.wait(recoveringBackoffFlag, 0, 0, delaySec * 1000);
    }
  }

  // Refreshes ONLY `lock`'s own mtime — the directory `acquire`'s staleness
  // check stats — never anything inside it, so the owner marker `release`
  // identifies this hold by is untouched. `lockHeld` guards it the same way
  // `release` guards itself: a caller that holds no lock has nothing to
  // heartbeat, and touching a path this process does not own would be
  // heartbeating a stranger's hold (or a stale directory nobody has claimed
  // yet) rather than its own.
  function touch(): void {
    // `lockHeld` alone is stale evidence, not proof: if this process is
    // suspended (a long GC pause, a swapped-out machine) past the staleness
    // window, a contender's `acquire()` can quarantine THIS generation and
    // install a fresh one at the canonical `lock` path before this process ever
    // wakes to notice. `lockHeld` was set true at OUR acquisition and nothing
    // ever clears it on takeover, so touching by path alone would then refresh
    // the SUCCESSOR's directory indefinitely — the exact generation-identity
    // bypass `release()` already guards against via its own owner-marker check,
    // reproduced here as an existence check on `owner` (the specific marker
    // THIS hold created) rather than a blind path touch.
    //
    // That check and the mtime write it guards are still two separate
    // syscalls (`existsSync` then `utimesSync`), which reopens the identical
    // gap one level down: a takeover landing in THAT window —
    // the same class of suspension this whole function exists to survive —
    // can quarantine this generation and install a successor AFTER the
    // check passes but BEFORE the write runs, making the write land on the
    // successor's directory instead of being the safe no-op it should be.
    // Every OTHER dance in this file that can displace `lock` (`release`'s
    // quarantine-and-maybe-restore, `acquire`'s stale-break) holds
    // `.recovering` for its ENTIRE rename-out-through-maybe-restore
    // sequence — reusing that same gate here, rather than inventing a
    // second mechanism, serializes this check-and-write against both of
    // them: neither can start displacing this generation while `touch()`
    // holds it, so nothing can land between the two calls below. It does
    // NOT cover a wholly fresh `mkdirSync(lock)` finalizing a brand-new
    // claim — but that can only succeed once `lock` is vacant, which
    // requires this generation to already be displaced, which in turn
    // requires the SAME gate this call now holds first.
    //
    // The remaining residual is `RECOVERING_STALE_MS` wide, not merely
    // "whatever `acquireRecoveringGate`'s own bounded wait leaves" — a
    // suspension of THIS process while it holds `.recovering` (between
    // acquiring it below and releasing it in `finally`) that outlasts
    // `RECOVERING_STALE_MS` lets a contender's `recoveringIsLive()` read
    // our hold as abandoned, break it, and race ahead with its own
    // quarantine dance before this process ever wakes — the same
    // stale-takeover gap, one level up. Closing THAT would need
    // `.recovering`'s own removal to go through the same atomic-claim-plus-
    // identity protocol canonical `lock` itself already does. As it stands,
    // this narrows the window from "any suspension past the LOCK's own
    // staleness window" (whatever `DRIVE_PR_LOCK_STALE_MIN` is, default 10
    // minutes) down to "a suspension past `RECOVERING_STALE_MS`" (5
    // seconds) — mirroring how this file documents its other accepted
    // residuals rather than overclaiming full atomicity.
    //
    // Cost of reusing this gate rather than inventing a lighter one: every
    // `touch()` call that reaches the mtime write now also leaves a
    // PERMANENT tombstone under `.recovering.stale.<holder>` behind, like
    // every other `releaseRecoveringGate` caller already does (see
    // `tombstone`'s own doc comment) — one per heartbeat tick for the life
    // of a held lock, not just once per acquire/release cycle. Bounding
    // this family's growth in general is not this function's job; it is
    // not swept here for the identical reason no other caller sweeps its
    // own.
    if (!lockHeld || owner === "") return;
    const gateHolder = acquireRecoveringGate();
    if (gateHolder === null) {
      // Could not confirm exclusivity within the bound — best effort, like
      // every other outcome of this function: the next heartbeat tries
      // again.
      return;
    }
    try {
      if (!existsSync(owner)) return;
      try {
        testTouchStall();
      } catch {
        // `testTouchStall` can only throw on a malformed test-only env var
        // (`testDelaySeconds`'s own validation) — unset, hence unreachable,
        // outside this suite's own tests. `touch()` is called from a bare
        // `setInterval` with no handler of its own (`guarded-push.ts`), so
        // best-effort here means never letting a test-hook misconfiguration
        // crash a live push over what is, at worst, one missed heartbeat.
      }
      try {
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {
        // Best effort — see the `touch()` doc comment on `PathLock`.
      }
    } finally {
      releaseRecoveringGate(gateHolder);
    }
  }

  /** A failed marker write must not leave a lock this process cannot release. */
  function abandonUnmarkedLock(error: unknown): never {
    const generation = generationOf(lock);
    owner = "";
    if (generation !== null) {
      const doomed = quarantinePath(generation);
      try {
        renameSync(lock, doomed);
        tombstone(doomed, "abandoned");
      } catch {
        // A rename loser has moved nothing.
      }
    }
    console.error(
      `${label}: took ${lock} but could not create its ownership marker —`,
    );
    console.error(
      `released it rather than hold a lock this process cannot release:`,
    );
    console.error(
      `  ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ExitError(1);
  }

  /** Finalize only under the recovery gate, closing its restore-to-publication gap. */
  function finalizeAcquisition(): boolean {
    const gateHolder = acquireRecoveringGate();
    if (gateHolder === null) {
      try {
        // Only return an empty directory: an intervening restore may own it.
        rmdirSync(lock);
      } catch {
        // A restore already reclaimed this path.
      }
      return false;
    }
    try {
      // Each hold needs its own permanent quarantine generation, even on reuse.
      owner = join(lock, `owner.${randomBytes(12).toString("hex")}`);
      try {
        writeFileSync(owner, "", { flag: "wx" });
      } catch (error) {
        abandonUnmarkedLock(error);
      }
      lockHeld = true;
      return true;
    } finally {
      releaseRecoveringGate(gateHolder);
    }
  }

  function olderThan(path: string, ageMs: number): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs > ageMs;
    } catch (error) {
      swallow(error, "lock age is unavailable; leave the entry untouched");
      return false;
    }
  }

  /** Claim before checking identity; restore any fresh generation caught in the gap. */
  function recoverStaleLock(staleMs: number, staleMinutes: number): boolean {
    const gateHolder = acquireRecoveringGate();
    if (gateHolder === null) return false;
    try {
      const generation = generationOf(lock);
      // Missing or malformed entries remain untouched: a path deletion could
      // remove a fresh generation appearing between this read and the deletion.
      if (generation === null) return false;
      const doomed = quarantinePath(generation);
      try {
        renameSync(lock, doomed);
      } catch (error) {
        swallow(
          error,
          "lock generation was already claimed or vanished during recovery",
        );
        return false;
      }
      // The directory's own mtime travels through rename. A fresh replacement
      // appearing since the outer staleness check must be restored, never broken.
      if (olderThan(doomed, staleMs)) {
        console.error(
          `${label}: broke a stale lock (>${staleMinutes}m old) at ${lock}`,
        );
        tombstone(doomed, "broken");
        return true;
      }
      try {
        renameSync(doomed, lock);
      } catch {
        console.error(
          `${label}: quarantined ${lock} but it was not actually stale, and it could not be restored (it is at ${doomed}).`,
        );
      }
      return false;
    } finally {
      releaseRecoveringGate(gateHolder);
    }
  }

  function attemptAcquisition(): "occupied" | "recovering" | "held" {
    try {
      mkdirSync(lock);
    } catch {
      return "occupied";
    }
    return finalizeAcquisition() ? "held" : "recovering";
  }

  async function acquire(maxWaitSec?: number): Promise<void> {
    // Signed integers, not digits-only: the test suite arms an always-stale
    // window with `DRIVE_PR_LOCK_STALE_MIN=-1`, which the bash `find -mmin
    // +-1` honoured — every lock is older than minus one minute.
    const parseSigned = (raw: string, def: number): number =>
      /^-?[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : def;
    // Clamped, not just parsed: an unvalidated `DRIVE_PR_LOCK_TIMEOUT` — a
    // digit string long enough for `Number.parseInt` to overflow to
    // `Infinity`, or merely a very large finite value — would make
    // `acquireDeadline` below effectively unreachable, polling a wedged
    // lock forever instead of failing closed within a bounded time.
    const limit = Math.min(
      LOCK_ACQUIRE_MAX_SEC,
      Math.max(0, parseSigned(process.env.DRIVE_PR_LOCK_TIMEOUT ?? "30", 30)),
      // A caller-supplied cap only ever LOWERS the bound — it is a share of an
      // aggregate deadline, not a way to ask for longer than the clamp above.
      ...(maxWaitSec === undefined ? [] : [Math.max(0, maxWaitSec)]),
    );
    // Elapsed time against the moment this call started, not an iteration
    // counter — a fresh-acquisition attempt can now itself block for up to
    // `RECOVERING_GATE_WAIT_MS` before the outer backoff sleep runs, so
    // counting loop passes as if each were ~1s made a nominal 30s bound run for
    // roughly twice that, and made the `within ${limit}s` message false.
    // `performance.now()`, not `Date.now()`: this measures ELAPSED duration,
    // and `Date.now()` is wall-clock — an NTP or administrator clock adjustment
    // can move it backward mid-acquire, making `> acquireDeadline` stay false
    // well past the configured bound and defeating it entirely.
    // `performance.now()` is monotonic and immune to that; every OTHER
    // deadline/staleness comparison in this file stays on `Date.now()`
    // deliberately, because those compare against filesystem mtimes, which are
    // themselves wall-clock and have no monotonic equivalent to compare
    // against.
    const acquireDeadline = performance.now() + limit * 1000;
    // Pacing between acquire attempts. This is a POLLING mutex — a waiter only
    // notices a release on its next attempt — so this interval is the lock's
    // handoff latency, and with N contenders the serialized cost is ~N × this.
    // Production keeps the 1s default: real cross-worktree contention is
    // seconds-to-minutes scale and a slower poll costs nearly nothing there.
    // `DRIVE_PR_LOCK_RETRY_MS` exists for the TEST SUITE:
    // its concurrency probes spawn many real claimant subprocesses whose
    // wall-clock is dominated by this interval, and under machine load the
    // 1s quantum amplified into per-test-budget blowups that read as failures
    // (a 5.45s-in-isolation probe measured at 20.7 minutes under load ~9).
    // Injecting a shorter poll compresses exactly that amplification without
    // touching what the probes verify — atomicity is in mkdir/rename/O_EXCL
    // syscalls, not in how often a loser retries. Clamped to [10, 1000]:
    // never slower than the default, never a busy-spin.
    const retryMs = Math.min(
      1_000,
      Math.max(
        10,
        parseSigned(process.env.DRIVE_PR_LOCK_RETRY_MS ?? "1000", 1_000),
      ),
    );
    // Shared with `lockHeartbeatMs()` above, so the two can never read this
    // override differently.
    const staleMinutes = lockStaleMinutes();
    const staleMs = staleMinutes * 60_000;
    // The caller is always entitled to try once, no matter how long that one
    // attempt's own internal contention takes — `DRIVE_PR_LOCK_TIMEOUT=0` is a
    // documented, test-relied-on value meaning "one immediate attempt, don't
    // retry" rather than "fail unless already held". `acquireDeadline` at
    // `limit=0` equals this call's own start time, so ANY elapsed time — even
    // an uncontended success's own marker write — reads as "already past
    // deadline"; gating the very first attempt's success on that check rejected
    // a lock nobody was contending for. Only a SECOND OR LATER attempt's
    // success is deadline-checked.
    let firstAttempt = true;
    function acceptAcquisition(): true {
      // Finalization must give the recovery gate back before releasing a hold
      // that consumed the remaining deadline. The first attempt is exempt.
      if (!firstAttempt && performance.now() > acquireDeadline) {
        release();
        throw new PollTimeoutError();
      }
      return true;
    }
    try {
      await poll(
        async () => {
          const result = attemptAcquisition();
          if (result === "held") return acceptAcquisition();
          if (result === "occupied" && olderThan(lock, staleMs)) {
            await testAcquireStall();
            const recovered = recoverStaleLock(staleMs, staleMinutes);
            // A successful stale break opened a vacancy. Claim it immediately
            // while budget remains, rather than sleeping through that budget.
            if (recovered && performance.now() <= acquireDeadline) {
              firstAttempt = false;
              if (attemptAcquisition() === "held") return acceptAcquisition();
            }
          }
          firstAttempt = false;
          return false;
        },
        {
          everyMs: retryMs,
          until: (acquired) => acquired,
          deadlineMs: acquireDeadline,
          immediate: true,
          clock: {
            now: () => performance.now(),
            sleep: (ms) => sleep(ms / 1000),
          },
        },
      );
    } catch (error) {
      if (!(error instanceof PollTimeoutError)) throw error;
      console.error(`${label}: could not acquire ${lock} within ${limit}s.`);
      console.error(
        `Another driver is updating PR #${prLabel}'s state, or the lock is wedged.`,
      );
      throw new LockAcquireTimeoutError();
    }
  }

  return { acquire, release, dispose, touch, [Symbol.dispose]: dispose };
}

/**
 * Shrink every quarantine directory `file`'s lock has ever produced — the
 * canonical lock's own `${lock}.stale.*` tombstones and `.recovering`'s own
 * `${lock}.recovering.stale.*` tombstones — down to a single
 * empty marker FILE at the same path. Never a delete: `tombstone` above
 * marks each of these permanent by design, precisely because "emptying it
 * reopens exactly the window this quarantine exists to close, and nothing
 * can prove no such observer remains" — see its own doc comment — and that
 * turns out to hold even at PR retirement. `drive-state.ts reset`'s own
 * preconditions (no live foreign lease, no live claim) were the first draft
 * of this function's safety argument and do NOT establish it:
 * `claimLease`/`claimTreeLease` (`lease.ts`) take this exact state lock
 * BEFORE writing any lease file, so a process suspended in that window
 * leaves no lease for `reset` to see; and `reset`'s own opening
 * `store.locked` can itself be the acquire that breaks a wedged holder's
 * lock as stale — minting the very tombstone that fences that holder off —
 * moments before this function would have deleted it, on the exact PR a
 * human ran `reset` against because it looked wedged. A suspended-not-dead
 * holder resuming after either is not a remote edge case; it is this file's
 * entire stated threat model.
 *
 * Compaction sidesteps that instead of re-deriving it: a bare `rename(2)`
 * of a directory onto an EXISTING REGULAR FILE fails with `ENOTDIR`, the
 * identical hard failure a rename onto a non-empty directory already gets
 * from `tombstone`'s own marker file — so replacing a tombstoned
 * directory's contents with a zero-byte file at the same path preserves the
 * fence against every DIRECTORY source, which is every in-protocol rename
 * this file ever performs onto a quarantine path (both `release`'s and
 * `acquire`'s stale-break always rename a directory — `lock` or
 * `.recovering` — never a file). It narrows, not vanishes: a file-onto-file
 * rename would silently replace this destination, but nothing in this
 * file's own protocol ever does that; only a raw, out-of-protocol actor
 * could, which `release`'s post-rename identity check already exists to
 * catch regardless (`createLock`'s own doc comment). Cost drops from a
 * directory (its own inode, plus the tombstone/owner file inside it) to one
 * empty file. Because the fence is never removed, this needs no
 * precondition from its caller at all — unlike a delete, it is safe to call
 * for any PR, at any point, whether or not that PR's drive is finished;
 * running it from `reset` is a convenient trigger, not a requirement.
 *
 * Never `statSync`-then-delete-by-canonical-path — this file's own established
 * reasoning for why that is unsafe elsewhere (`acquire`'s own malformed-entry
 * handling: "the read and any act on [path] are two separate syscalls, and
 * nothing closes the gap where a legitimate fresh generation appears in
 * between; deleting by canonical path there destroys it outright") applies
 * identically here. Instead, `compactQuarantineEntry` below claims each entry
 * via a private, uniquely-named staging `rename(2)` FIRST, mirroring the
 * rename-first idiom `release`/`recoveringIsLive` already use throughout this
 * file, rather than deleting the canonical path directly. `rename(2)` is atomic
 * on identity as well as content: whatever it moves is guaranteed to be exactly
 * what sat AT that path at that instant, so the private copy needs no further
 * identity check — unlike `release`, which verifies identity because it moves
 * the LIVE canonical `lock` path (whose content can legitimately change), this
 * instead claims an ALREADY quarantined path, which by construction never holds
 * anything but a superseded generation placed there by this file's own
 * generation-keyed rename protocol. Every deletion then runs against the
 * PRIVATE staging copy, never the canonical path — nothing else can ever
 * reference the staging name, so nothing this function does can destroy content
 * it did not itself successfully claim.
 *
 * The claiming rename still opens a brief window at the CANONICAL path
 * between it and the `writeFileSync` that recreates the compacted marker
 * there — POSIX has no atomic rename between object types, so there is no
 * way to replace "vacant" with "an empty file" in one syscall. Only a
 * rename targeting this EXACT generation-keyed name could land there,
 * which is by construction the narrow "two operations displacing the same
 * generation" race `quarantinePath`'s own doc comment already describes as
 * this scheme's normal, self-fencing contention. Landing there is NOT
 * free, though: it downgrades that one generation from the PRIMARY fence
 * (a non-empty destination, rename fails outright, nothing moves) to the
 * SECONDARY one (a post-rename identity check plus a bare restore) this
 * same file's own comments already rate as incomplete elsewhere
 * (`createLock`'s doc comment; `recoveringIsLive`'s "usually (not always:
 * an accepted residual)" catch). Accepted as a residual for the SAME reason
 * those are: the window here is two back-to-back synchronous syscalls with no
 * `await` between them, the identical bounded-by-construction argument
 * `RECOVERING_STALE_MS` relies on elsewhere in this file, not an argument
 * that nothing can go wrong.
 *
 * A `writeFileSync` failure after the claim already succeeded is NOT always "a
 * legitimate late arrival already occupies the path" (`EEXIST`, genuinely
 * harmless — some renamer won the window and is now this generation's new,
 * valid occupant). It can also mean the fence is simply GONE with no error
 * anyone will see — `ENOSPC`/`EDQUOT`/`EIO`, or this process being killed
 * between the two calls, both leave the path vacant, not occupied.
 * `compactQuarantineEntry` tells these apart by re-checking `existsSync` and,
 * only when genuinely vacant, restores SOME fence via a different syscall class
 * — a NON-empty directory (`mkdirSync(join(path, 'tombstone'), { recursive:
 * true })`, mirroring `tombstone`'s own EEXIST-vs-other fallback AND its exact
 * marker-subdirectory shape) rather than silently leaving nothing. A bare
 * `mkdirSync(path)` would not do: an EMPTY directory is not a fence, since
 * `rename(2)` may silently replace it — the identical mistake `tombstone`'s own
 * design already rejects. This cannot close the process-killed-mid-syscall case
 * — no userland code can — only the killed process's own next start (or another
 * driver's stale-break) would ever revisit this path again, same as any other
 * interrupted syscall in this file.
 *
 * `lock` and `.recovering` themselves — the LIVE paths, not their `.stale.*`
 * history — are deliberately untouched: those remain owned by
 * `createLock`'s own acquire/release protocol regardless of whether this PR
 * is being retired, and a lock in the middle of the very reset that calls
 * this is exactly such a live path.
 *
 * `onEntry`, when given, is called once per directory entry visited — before
 * this function decides whether the entry is even a quarantine member. A
 * single anchor can carry a large backlog (reap-state.ts's own header cites
 * 112k entries measured in nine days on one machine), and every step in the
 * loop below is a synchronous syscall with no `await` anywhere in it, so a
 * caller heartbeating some OTHER lock across this call (`reap-state.ts`'s
 * delete lock, held for the whole read-verdict-mutate-publish sequence this
 * sweep is one step of) cannot rely on a background `setInterval` firing
 * partway through — nothing yields the event loop until this function
 * returns. The callback is the caller's own throttled heartbeat, not a raw
 * `touch`: calling `PathLock.touch` once per entry would itself mint a
 * fresh permanent `.recovering.stale.*` tombstone per call (`touch`'s own
 * doc comment), inflating the exact quarantine growth this sweep exists to
 * shrink.
 */
export function sweepLockQuarantine(file: string, onEntry?: () => void): void {
  const lock = `${file}.lock`;
  const dir = dirname(lock);
  const lockBase = basename(lock);
  // Escaped because `lockBase` is caller-controlled data (a state-file name,
  // e.g. `drive-pr-4197.json.lock`), not a regex fragment — interpolating it
  // raw would turn every `.` into a wildcard, silently re-widening the exact
  // over-match this grammar restriction exists to close.
  const escapedLockBase = lockBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches ONLY a name `generationOf` (above) could actually have produced
  // for THIS lock — not a bare prefix. A foreign sibling sharing the anchor's
  // stale prefix (`<lockBase>.stale.manual-backup`, a human poking at the
  // state dir while debugging a wedged lock) no longer matches, where a plain
  // `startsWith` check let `compactQuarantineEntry` destroy it outright.
  const quarantineRe = new RegExp(
    `^${escapedLockBase}(?:\\.recovering)?\\.stale\\.${LOCK_GENERATION_RE}$`,
  );
  // `compactQuarantineEntry` scopes its staging name to THIS lock's own
  // basename (`.compacting.${basename(path)}.<hex>`, and `path` already
  // starts with `lockBase`), so matching on that full, lock-scoped prefix
  // — not the bare `.compacting.` — is what keeps this retry pass from
  // ever touching a DIFFERENT lock's staging copy. `dir` is the shared
  // state directory, home to every PR's lock files side by side; a bare
  // `.compacting.` prefix would delete another PR's active or failed
  // staging copy too, widening the exact unfenced interval this protocol
  // bounds.
  //
  // The payload capture (group 1) must itself be a genuine quarantine name —
  // not `(.+)` — because the capture, when it exists, is only ever used to
  // decide whether to restore a fence at the canonical path; when the whole
  // entry still starts with `.compacting.<lockBase>.` but the payload is
  // foreign (`.compacting.<lockBase>.manual-backup`), the unconditional
  // `rmSync` below used to run anyway with no `canonicalPath` guard at all —
  // deleting a directory OR FILE this protocol never staged, worse than the
  // `.stale.` branch's bypass since it has no `isDirectory` check either. The
  // claim-instance suffix is always a pure hex string
  // (`randomBytes(12).toString('hex')`, 24 chars, no dots), so it is always
  // exactly the trailing segment after the last dot.
  const compactingEntryPattern = new RegExp(
    `^\\.compacting\\.(${escapedLockBase}(?:\\.recovering)?\\.stale\\.${LOCK_GENERATION_RE})\\.[0-9a-f]{24}$`,
  );
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // the state dir itself is already gone — nothing to sweep
  }
  for (const entry of entries) {
    onEntry?.();
    // The capture group is mandatory, so the name is present exactly when the
    // entry matches at all.
    const canonicalName = compactingEntryPattern.exec(entry)?.[1];
    if (canonicalName !== undefined) {
      const staging = join(dir, entry);
      // A staging copy an EARLIER call claimed but never finished with.
      // Two distinct reasons this can still be sitting here, and they need
      // OPPOSITE handling before it is safe to delete:
      //
      //  1. `compactQuarantineEntry`'s `rmSync(staging)` threw AFTER it had
      //     already restored a fence at the canonical path (that function's
      //     own comment). The canonical path exists; this leftover is pure
      //     debris and deleting it costs nothing.
      //  2. The process was killed between the claim rename and EITHER of
      //     `rmSync`/`writeFileSync` — `staging` is the ONLY remaining copy of
      //     this generation's fence, and the canonical path is genuinely
      //     vacant. Deleting it outright here would destroy the last copy of
      //     the fence with nothing left to restore it, re-opening the exact
      //     unfenced-generation window the whole tombstone mechanism exists to
      //     close.
      //
      // The two are told apart by whether the canonical path exists. Case 2
      // restores a fence there FIRST — the same non-empty-directory marker
      // `compactQuarantineEntry`'s own EEXIST/failure fallback uses — before
      // this leftover is removed.
      const canonicalPath = join(dir, canonicalName);
      if (!existsSync(canonicalPath)) {
        try {
          mkdirSync(join(canonicalPath, "tombstone"), { recursive: true });
        } catch {
          // Could not restore a fence — leave the leftover for the next
          // sweep rather than delete the only remaining copy of it.
          continue;
        }
      }
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // still stuck — leave it for the next sweep
      }
      continue;
    }
    if (!quarantineRe.test(entry)) {
      continue;
    }
    compactQuarantineEntry(join(dir, entry));
  }
}

/** Compact one quarantine entry at `path` — see `sweepLockQuarantine`. */
function compactQuarantineEntry(path: string): void {
  let alreadyCompact = false;
  try {
    alreadyCompact = !statSync(path).isDirectory();
  } catch {
    return; // already gone — nothing to compact
  }
  if (alreadyCompact) return;

  // Staged as a SIBLING with a `.compacting.` prefix on the whole entry name,
  // not appended after `path` — appending would still start with
  // `${lockBase}.stale.`/`${lockBase}.recovering.stale.` (since `path` itself
  // already does), so a CONCURRENT `sweepLockQuarantine` call would match this
  // in-flight staging directory as another quarantine entry of its own and race
  // to compact it too, leaving permanent `.compacting.*` debris neither call
  // ever cleans up. Prefixing instead of appending guarantees the staging name
  // can never start with either scanned prefix.
  const staging = join(
    dirname(path),
    `.compacting.${basename(path)}.${randomBytes(12).toString("hex")}`,
  );
  try {
    renameSync(path, staging);
  } catch {
    // Lost a race to claim this exact entry — most likely a concurrent
    // sweep already did (or is doing) the identical compaction — nothing
    // of ours to do.
    return;
  }
  try {
    // Safe to delete outright: `staging`'s name is unique to this call, so
    // nothing else can ever reference it — this is the private copy `rename`
    // just proved was, at that instant, exactly what sat at `path`. Both calls
    // share one `try` — not just the `writeFileSync` — so a THROW from this
    // `rmSync` (EACCES/EIO) still falls through to the fence-restore fallback
    // below instead of leaving `path` permanently vacant with no fence at all
    // and no error anyone sees: `path` was already claimed away by the rename
    // above, so skipping the fallback here is exactly as unfenced as
    // `writeFileSync` itself failing.
    rmSync(staging, { recursive: true, force: true });
    writeFileSync(path, "", { flag: "wx" });
  } catch {
    if (!existsSync(path)) {
      try {
        mkdirSync(join(path, "tombstone"), { recursive: true });
      } catch {
        // Both mechanisms failed (e.g. ENOSPC) — the same failure would
        // also block the state-file write this lock guards, so the fence
        // is moot in that scenario, same as `tombstone()`'s own doc
        // comment already accepts.
      }
    }
  }
}
