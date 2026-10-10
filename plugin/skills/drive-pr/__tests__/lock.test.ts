/**
 * lock.test.ts — the path-keyed TOCTOU an earlier change fixed in `lib/state/lock.ts`.
 *
 * `store.ts`'s per-PR mutex used a destination keyed to the ACTING process's
 * own identity on both halves of its stale-lock protocol: `acquire`'s
 * stale-break renamed to `<lock>.stale.<pid>`, and `release` checked the
 * owner marker's existence and THEN renamed to `<lock>.released.<pid>`. Both
 * are the exact class PR #4031 found and fixed in `drive.ts` — a
 * pid-keyed (or check-then-act, private-destination) scheme fences nothing,
 * because the SOURCE every contender renames is the same live directory:
 * whichever rename runs second (or whichever restore runs last) moves
 * whatever is CURRENTLY there, not the generation it originally observed.
 *
 * Each test below plants the exact directory state a race would have left
 * behind and asserts the fixed code refuses to clobber it, mirroring the
 * `describe('single-instance lock')` tests PR #4031 added for `drive.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import { createLock, sweepLockQuarantine } from "../scripts/lib/state/lock.ts";

let dir: string;
let file: string;
let lock: string;

// Every test below depends on the DEFAULTS of these knobs (a 10-minute
// staleness window, a 30s timeout) unless it overrides one deliberately —
// save and restore the whole set so a prior test's override, or one already
// present in the ambient shell, can never leak into another.
const ENV_KEYS = [
  "DRIVE_PR_LOCK_TIMEOUT",
  "DRIVE_PR_LOCK_STALE_MIN",
  "DRIVE_PR_LOCK_ACQUIRE_TEST_DELAY",
  "DRIVE_PR_LOCK_ACQUIRE_TEST_SIGNAL",
  "DRIVE_PR_LOCK_RECOVERING_TEST_DELAY",
  "DRIVE_PR_LOCK_RECOVERING_TEST_SIGNAL",
  "DRIVE_PR_LOCK_TOUCH_TEST_DELAY",
  "DRIVE_PR_LOCK_TOUCH_TEST_SIGNAL",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-pr-lock-test-"));
  file = join(dir, "drive-pr-999.json");
  lock = `${file}.lock`;
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Age a lock directory past the staleness window used by these tests. */
function ageLock(dirPath: string, staleMin: number): void {
  const oldSec = (Date.now() - (staleMin + 1) * 60_000) / 1000;
  utimesSync(dirPath, oldSec, oldSec);
}

/** Poll until a signal file appears, or fail with a clear message. */
async function waitForSignal(signal: string, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(signal)) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never signalled`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("lock.ts single-instance mutex", () => {
  it("a stale lock whose generation is already quarantined must not be broken a second time", async () => {
    // Model the state left behind the instant a race is lost: this
    // generation's quarantine destination is ALREADY occupied by a
    // tombstone (some other driver won the race to break it first), while
    // the canonical path still carries the very same marker a stale-check
    // just observed as abandoned.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.deadbeef"), "");
    ageLock(lock, 10);
    const doomed = `${lock}.stale.owner.deadbeef`;
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, "tombstone"), "broken by pid 1\n");

    process.env.DRIVE_PR_LOCK_TIMEOUT = "0";
    const contender = createLock(file, "test", "999");
    await expect(contender.acquire()).rejects.toBeInstanceOf(ExitError);

    // `rename(2)` refused the non-empty destination, so NOTHING moved: the
    // stale lock this process observed is exactly where it was, and the
    // tombstone that beat it to the destination is untouched.
    expect(existsSync(join(lock, "owner.deadbeef"))).toBe(true);
    expect(readFileSync(join(doomed, "tombstone"), "utf8")).toBe(
      "broken by pid 1\n",
    );
  });

  it("a recovery leaves a non-empty tombstone at the generation-keyed path", async () => {
    // A genuinely abandoned lock: owned, but old enough to count as stale
    // and nobody contending for it.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.abandoned1"), "");
    ageLock(lock, 10);

    const contender = createLock(file, "test", "999");
    await contender.acquire();

    const doomed = `${lock}.stale.owner.abandoned1`;
    expect(existsSync(doomed)).toBe(true);
    expect(existsSync(join(doomed, "tombstone"))).toBe(true);
    // The original owner marker survives inside the quarantine — it is
    // moved, never deleted.
    expect(existsSync(join(doomed, "owner.abandoned1"))).toBe(true);
    // The canonical path now holds THIS process's fresh lock, not the one
    // that was just quarantined.
    const freshMarkers = readdirSync(lock).filter((f) =>
      f.startsWith("owner."),
    );
    expect(freshMarkers).toHaveLength(1);
    expect(freshMarkers[0]).not.toBe("owner.abandoned1");

    contender.release();
    // Tombstones are permanent: releasing the recovering process's own lock
    // must not sweep the quarantine left behind by the recovery.
    expect(existsSync(doomed)).toBe(true);
    expect(existsSync(join(doomed, "tombstone"))).toBe(true);
  });

  it("a stale-break race that lands on a fresh replacement restores it instead of tombstoning it", async () => {
    // The outer staleness check (mtime of `lock`) and the
    // generation read that follows it are two SEPARATE syscalls. If a
    // DIFFERENT contender replaces `lock` with a fresh, live one in that
    // gap, this process's rename moves the replacement, not the stale
    // directory it actually observed — it must detect that from the moved
    // copy's own (fresh) mtime and put it back rather than tombstone it.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.original1"), "");
    ageLock(lock, 10);

    const signal = join(dir, "about-to-read-generation");
    process.env.DRIVE_PR_LOCK_ACQUIRE_TEST_SIGNAL = signal;
    process.env.DRIVE_PR_LOCK_ACQUIRE_TEST_DELAY = "1";
    process.env.DRIVE_PR_LOCK_TIMEOUT = "2";
    const contender = createLock(file, "test", "999");
    const acquiring = contender.acquire();

    await waitForSignal(signal, "acquire() observing staleness");
    // Swap the lock out for a FRESH, live replacement — exactly what a
    // different contender's own recovery would leave behind — while this
    // process still believes it is about to break the stale one it saw.
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.fresh1"), "");
    // Only the FIRST stale observation should stall — clear the hook so a
    // later loop iteration (which will correctly see the replacement as
    // fresh, not stale) does not stop to signal again.
    delete process.env.DRIVE_PR_LOCK_ACQUIRE_TEST_SIGNAL;
    delete process.env.DRIVE_PR_LOCK_ACQUIRE_TEST_DELAY;

    // Nothing ever legitimately releases the planted replacement, so this
    // process can only time out — the assertion is about what survives.
    await expect(acquiring).rejects.toBeInstanceOf(ExitError);

    expect(existsSync(join(lock, "owner.fresh1"))).toBe(true);
    expect(readdirSync(lock)).toEqual(["owner.fresh1"]);
    // Restored, not left behind: no quarantine debris for the generation
    // this process wrongly grabbed and gave back.
    expect(existsSync(`${lock}.stale.owner.fresh1`)).toBe(false);
  });

  it("release refuses to touch a successor once its OWN generation is quarantined", async () => {
    // Simulate exactly what a breaker leaves behind while this process was
    // suspended: THIS process's own generation has already been quarantined
    // (recovered as stale by someone else), and a fresh, live successor now
    // occupies the canonical path.
    const holder = createLock(file, "test", "999");
    await holder.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    if (ownMarker === undefined) {
      throw new Error("acquire() did not leave an owner marker");
    }

    const alreadyQuarantined = `${lock}.stale.${ownMarker}`;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(alreadyQuarantined, { recursive: true });
    writeFileSync(join(alreadyQuarantined, "tombstone"), "broken by pid 1\n");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.successor1"), "");

    holder.release();

    // The rename this release attempts collides with the pre-existing
    // tombstone at the SAME generation-keyed path — it must fail, leaving
    // the live successor completely undisturbed.
    expect(existsSync(join(lock, "owner.successor1"))).toBe(true);
    expect(readdirSync(lock)).toEqual(["owner.successor1"]);
    expect(readFileSync(join(alreadyQuarantined, "tombstone"), "utf8")).toBe(
      "broken by pid 1\n",
    );
  });

  it("acquire then release round-trips, leaving a permanent tombstone behind", async () => {
    const solo = createLock(file, "test", "999");
    await solo.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    expect(ownMarker).toBeDefined();

    solo.release();

    // Released through the same generation-keyed quarantine an acquire-side
    // breaker would use — the canonical path is gone, and what took its
    // place is a permanent tombstone, not a clean deletion.
    expect(existsSync(lock)).toBe(false);
    const doomed = `${lock}.stale.${ownMarker}`;
    expect(existsSync(join(doomed, "tombstone"))).toBe(true);
  });

  it("touch refreshes a held lock's mtime so a contending acquire does not treat it as stale", async () => {
    // Models `guarded-push.ts` holding this same PathLock across a `git push`
    // that can legitimately run far longer than the default 10-minute
    // staleness window (chatgpt-codex-connector, a reference-implementation pull request): without a
    // heartbeat, ANY hold this old is broken outright by `acquire`'s own
    // stale-break dance — see 'a recovery leaves a non-empty tombstone...'
    // above, which ages a lock by the identical amount and asserts the
    // opposite outcome (a fresh reassignment) for an UNTOUCHED hold. touch()
    // must prevent that for a hold that is still genuinely alive.
    const holder = createLock(file, "test", "999");
    await holder.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    if (ownMarker === undefined) {
      throw new Error("acquire() did not leave an owner marker");
    }

    // Age the hold past the staleness window, then heartbeat it — exactly
    // what a long-running push's periodic touch() call does.
    ageLock(lock, 10);
    holder.touch();
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(5_000);

    process.env.DRIVE_PR_LOCK_TIMEOUT = "0";
    const contender = createLock(file, "test", "999");
    // A genuinely stale lock would have been broken and reassigned to the
    // contender within this single call; a freshly-touched one must instead
    // report ORDINARY contention and fail without disturbing the holder.
    await expect(contender.acquire()).rejects.toBeInstanceOf(ExitError);
    expect(existsSync(join(lock, ownMarker))).toBe(true);
    expect(readdirSync(lock)).toEqual([ownMarker]);

    holder.release();
  });

  it("touch() does not refresh a SUCCESSOR lock after this holder lost ownership (docomply-review round 13)", async () => {
    // `lockHeld` alone is stale evidence: if this process is suspended past
    // the staleness window, a contender's `acquire()` can quarantine this
    // hold's generation and install a fresh one at the canonical path before
    // this process ever wakes up — the identical fixture 'release refuses to
    // touch a successor once its OWN generation is quarantined' above plants.
    // `lockHeld` is never cleared on takeover, so a touch() that trusted it
    // alone would refresh the SUCCESSOR's directory indefinitely.
    const holder = createLock(file, "test", "999");
    await holder.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    if (ownMarker === undefined) {
      throw new Error("acquire() did not leave an owner marker");
    }

    const quarantined = `${lock}.stale.${ownMarker}`;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(quarantined, { recursive: true });
    writeFileSync(join(quarantined, "tombstone"), "broken by pid 1\n");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.successor1"), "");
    ageLock(lock, 10);
    const successorMtime = statSync(lock).mtimeMs;

    // `lockHeld` is still true from this process's own point of view — the
    // whole point of the bug. touch() must notice its OWN marker is gone and
    // refuse to touch the successor's directory.
    holder.touch();

    expect(statSync(lock).mtimeMs).toBe(successorMtime);
    expect(existsSync(join(lock, "owner.successor1"))).toBe(true);
  });

  it("touch does not let a takeover interleave BETWEEN its ownership check and its mtime write", async () => {
    // The round-13 fixture above ('does not refresh a SUCCESSOR lock...')
    // plants the post-takeover state directly — it proves `touch()` reacts
    // correctly to a takeover that already finished, not that a takeover
    // cannot land DURING `touch()`'s own existence-check-to-mtime-write gap.
    // This test forces that exact interleaving with the
    // `DRIVE_PR_LOCK_TOUCH_TEST_DELAY`/`_TEST_SIGNAL` stall hook, the same
    // way 'a stale-break race that lands on a fresh replacement...' above
    // forces one for `acquire()`.
    const holder = createLock(file, "test", "999");
    await holder.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    if (ownMarker === undefined) {
      throw new Error("acquire() did not leave an owner marker");
    }
    ageLock(lock, 10);

    const recovering = `${lock}.recovering`;
    const doomed = `${lock}.stale.${ownMarker}`;
    const signal = join(dir, "touch-about-to-write-mtime");
    const observedPath = join(dir, "takeover-observed.json");
    // A standalone process: the moment it sees `touch()`'s signal (written
    // right after `touch()` confirmed its own marker is still present, but
    // BEFORE the mtime write the fix now gates), it performs the EXACT
    // takeover dance a real `acquire()` stale-break would — quarantine this
    // generation, tombstone it, install a fresh successor — but, like every
    // real dance in this file, only after winning the SAME `.recovering`
    // gate `touch()` is holding through this whole window. If the gate
    // genuinely excludes it, this process cannot even START that rename
    // until `touch()` has released the gate — which only happens AFTER the
    // mtime write already landed on the correct, still-original directory,
    // so the takeover it performs afterward can only ever quarantine an
    // ALREADY-correctly-touched copy, never intercept the write itself.
    const swapper = Bun.spawn(
      [
        "bun",
        "-e",
        `const fs = require('fs');
         const path = require('path');
         const [signal, lockDir, recovering, doomed, ownMarker, observedPath] =
           process.argv.slice(1);
         const deadline = Date.now() + 5000;
         while (!fs.existsSync(signal)) {
           if (Date.now() > deadline) {
             console.error('signal never appeared');
             process.exit(1);
           }
           Bun.sleepSync(5);
         }
         // Race for the SAME gate touch() holds — a real takeover dance
         // would do exactly this, never bypass it.
         const gateDeadline = Date.now() + 3000;
         let gotGate = false;
         while (Date.now() < gateDeadline) {
           try {
             fs.mkdirSync(recovering);
             gotGate = true;
             break;
           } catch {
             Bun.sleepSync(5);
           }
         }
         if (!gotGate) {
           console.error('never got the .recovering gate');
           process.exit(1);
         }
         // Snapshot what this process observes the INSTANT it finally gets
         // in, THEN actually perform the takeover — quarantine this
         // generation and install a fresh successor, exactly like a real
         // stale-break would.
         const observed = {
           ownMarkerStillPresent: fs.existsSync(path.join(lockDir, ownMarker)),
           mtimeMsAtGateAcquisition: fs.existsSync(lockDir)
             ? fs.statSync(lockDir).mtimeMs
             : null,
         };
         try {
           fs.renameSync(lockDir, doomed);
           fs.writeFileSync(path.join(doomed, 'tombstone'), 'broken by pid <subprocess>\\n');
         } catch (e) {
           observed.renameError = String(e);
         }
         fs.mkdirSync(lockDir, { recursive: true });
         fs.writeFileSync(path.join(lockDir, 'owner.successor1'), '');
         fs.writeFileSync(observedPath, JSON.stringify(observed));
         fs.rmSync(recovering, { recursive: true, force: true });`,
        signal,
        lock,
        recovering,
        doomed,
        ownMarker,
        observedPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    process.env.DRIVE_PR_LOCK_TOUCH_TEST_SIGNAL = signal;
    process.env.DRIVE_PR_LOCK_TOUCH_TEST_DELAY = "1";
    const touchStart = Date.now();
    holder.touch();
    const touchElapsedMs = Date.now() - touchStart;
    delete process.env.DRIVE_PR_LOCK_TOUCH_TEST_SIGNAL;
    delete process.env.DRIVE_PR_LOCK_TOUCH_TEST_DELAY;

    // `touch()` itself must have actually stalled — otherwise the gate
    // exclusion below is untested by construction.
    expect(touchElapsedMs).toBeGreaterThanOrEqual(900);

    const [swapExitCode, swapStderr] = await Promise.all([
      swapper.exited,
      new Response(swapper.stderr).text(),
    ]);
    expect(swapStderr).toBe("");
    expect(swapExitCode).toBe(0);

    const observed = JSON.parse(readFileSync(observedPath, "utf8"));
    expect(observed.renameError).toBeUndefined();
    // The takeover could only get past the gate AFTER `touch()` released
    // it — by which point the mtime write had already landed on THIS
    // process's own, still-original directory. A version of `touch()` that
    // does not hold `.recovering` across the gap would let the swapper in
    // immediately once it saw the signal (well under the 1s stall), racing
    // it ahead of the write instead.
    expect(observed.ownMarkerStillPresent).toBe(true);
    expect(Date.now() - observed.mtimeMsAtGateAcquisition).toBeLessThan(5_000);

    // The takeover ran, so `lock` now holds the swapper's fresh successor —
    // but the mtime write landed on the quarantined ORIGINAL before that,
    // never on the successor it displaced afterward. Renaming a directory
    // does not disturb its own mtime, so the fresh timestamp `touch()` set
    // travels with it into quarantine.
    expect(existsSync(join(lock, "owner.successor1"))).toBe(true);
    expect(existsSync(doomed)).toBe(true);
    expect(Date.now() - statSync(doomed).mtimeMs).toBeLessThan(5_000);
  });

  it("touch() is a no-op when this process does not hold the lock", () => {
    const idle = createLock(file, "test", "999");
    expect(() => idle.touch()).not.toThrow();
    expect(existsSync(lock)).toBe(false);
  });

  it("the owner marker has enough entropy that a permanent tombstone cannot plausibly collide", async () => {
    // `tombstone` makes every quarantine permanent — never swept — so the
    // owner marker's name is a key that must stay unique for a PR's lock's
    // ENTIRE lifetime, not just for one hold. Unlike an ordinary short-lived
    // temp file (whose own 24-bit `tempSuffix()` just throws on collision
    // for a caller to retry), a marker collision HERE wedges the lock
    // permanently: release()'s rename lands on a stranger's old tombstone,
    // no-ops instead of freeing the canonical path, and every later
    // contender's acquire times out against a lock nobody can ever remove.
    // 24 bits collides with single-digit-percent probability well within
    // one actively-iterated PR's total acquire/release count — this pins
    // the wider generator that replaces it.
    const solo = createLock(file, "test", "999");
    await solo.acquire();
    const marker = readdirSync(lock).find((f) => f.startsWith("owner."));
    expect(marker).toMatch(/^owner\.[0-9a-f]{24}$/);
    solo.release();
  });

  it("a fresh mkdirSync landing on a LIVE `.recovering` gate backs off instead of finalizing", async () => {
    // The residual gap a restore's own vacancy window leaves open: while
    // some OTHER dance holds `.recovering` (mid rename-out-through-maybe-
    // restore), a completely unrelated fresh `mkdirSync(lock)` must not
    // believe it acquired the mutex just because the path was momentarily
    // free — it has to back off and keep retrying, exactly like ordinary
    // contention on `lock` itself (finalizing a fresh
    // acquisition — not just noticing the vacancy — is now ALSO gated by
    // `.recovering`, so this contention is real, not a same-instant race).
    mkdirSync(`${lock}.recovering`, { recursive: true });

    // `--timeout 0`: this fixture's gate is a plain `mkdirSync` with no
    // marker, never refreshed — a stand-in for "some other dance holds
    // it", not an actually-executing one. `recoveringGateBackoff` only
    // reads it as live within `RECOVERING_STALE_MS` (5s) of its OWN
    // creation; a bigger timeout here would let repeated
    // `acquireRecoveringGate` retry cycles run long enough for this
    // process's OWN staleness check to legitimately break the fixture out
    // from under itself, which is correct behavior for a REALLY-abandoned
    // gate but defeats what this specific test means to model. One
    // bounded `RECOVERING_GATE_WAIT_MS` cycle (~1s) plus the outer
    // `sleep(1)` comfortably clears `waited > 0` while staying well under
    // that 5s window.
    process.env.DRIVE_PR_LOCK_TIMEOUT = "0";
    const contender = createLock(file, "test", "999");
    await expect(contender.acquire()).rejects.toBeInstanceOf(ExitError);

    // Backed off every time, never left its own directory behind, and
    // never believed it held the lock: the gate it can never clear (never
    // released, never yet stale) is exactly what should have blocked it.
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.recovering`)).toBe(true);
  });

  it("a `.recovering` gate abandoned by a crashed recoverer is broken rather than blocking forever", async () => {
    // Model a crash between the gate's own mkdir+marker-write and its
    // cleanup: the gate carries a real holder marker (exactly what
    // `acquireRecoveringGate` always writes) but is old enough that no
    // live, synchronous dance could still be holding it.
    mkdirSync(`${lock}.recovering`, { recursive: true });
    writeFileSync(join(`${lock}.recovering`, "owner.deadbeef"), "");
    ageLock(`${lock}.recovering`, 1); // older than RECOVERING_STALE_MS

    const contender = createLock(file, "test", "999");
    await contender.acquire();

    // Reclaimed rather than left standing forever — a fresh acquisition
    // proceeded normally once it was gone. The abandoned holder's own
    // quarantine copy is kept as a PERMANENT tombstone (
    // matching `lock`'s own scheme): a suspended (not dead) original
    // holder can still call `releaseRecoveringGate` with this exact
    // holder name later, and a deleted destination would let that late
    // call rename a THEN-live, unrelated gate onto it.
    expect(existsSync(`${lock}.recovering`)).toBe(false);
    const doomedRecovering = `${lock}.recovering.stale.owner.deadbeef`;
    expect(existsSync(doomedRecovering)).toBe(true);
    expect(existsSync(join(doomedRecovering, "tombstone"))).toBe(true);
    expect(readdirSync(lock).some((f) => f.startsWith("owner."))).toBe(true);
    contender.release();
  });

  it("a `.recovering` gate that looks stale but is actually a FRESH replacement is not broken", async () => {
    // The gate's own path-keyed TOCTOU class, closed the same way `lock`
    // itself is: an old-mtime observation and the identity-verified removal
    // are two separate syscalls, and a genuinely fresh, live gate can
    // replace the stale one in between. The removal must detect that from
    // the moved copy's OWN identity and refuse to destroy it — the
    // regression docomply-review round 2 on #4050 found in the very first
    // draft of this gate.
    //
    // `recoveringIsLive` must stay fully SYNCHRONOUS — it is called from
    // `release()`'s SIGINT/SIGTERM handler, which cannot `await` — so its
    // test stall (`testRecoveringStall`) blocks via `Atomics.wait`, not an
    // async sleep. That blocks this test's own single JS thread too: unlike
    // the sibling `acquire()`-staleness test above (built on the genuinely
    // async `testAcquireStall`/`await sleep()`, which DOES yield to the
    // event loop), a same-process "swap after the signal fires" here would
    // only run AFTER `Atomics.wait` returns and `acquire()`'s own
    // microtask-only await-chain finally settles — never DURING the stall,
    // which defeats the point. The swap needs an actor on a genuinely
    // separate OS process instead, which this thread's `Atomics.wait`
    // cannot block.
    const recovering = `${lock}.recovering`;
    mkdirSync(recovering, { recursive: true });
    writeFileSync(join(recovering, "owner.stale1"), "");
    ageLock(recovering, 1); // older than RECOVERING_STALE_MS

    // A LIVE lock, so `acquire` reaches the stale-break path and calls
    // `recoveringIsLive` (rather than short-circuiting on the fresh-mkdir
    // branch, which never calls it at all).
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.holder1"), "");
    ageLock(lock, 10);

    const signal = join(dir, "about-to-remove-recovering");
    // A standalone `bun -e` process: it polls for the signal file on its
    // OWN OS thread and performs the swap the instant it appears, unaffected
    // by whatever this test's own thread is blocked on.
    const swapper = Bun.spawn(
      [
        "bun",
        "-e",
        `const fs = require('fs');
         const path = require('path');
         const [signal, recovering] = process.argv.slice(1);
         const deadline = Date.now() + 5000;
         while (!fs.existsSync(signal)) {
           if (Date.now() > deadline) {
             console.error('signal never appeared');
             process.exit(1);
           }
           Bun.sleepSync(5);
         }
         fs.rmSync(recovering, { recursive: true, force: true });
         fs.mkdirSync(recovering, { recursive: true });
         fs.writeFileSync(path.join(recovering, 'owner.fresh1'), '');`,
        signal,
        recovering,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    process.env.DRIVE_PR_LOCK_RECOVERING_TEST_SIGNAL = signal;
    process.env.DRIVE_PR_LOCK_RECOVERING_TEST_DELAY = "1";
    process.env.DRIVE_PR_LOCK_TIMEOUT = "2";
    const contender = createLock(file, "test", "999");
    const acquiring = contender.acquire();

    // Nothing ever legitimately releases the planted replacement — the
    // swapper process only ever creates it once — or the live `lock` this
    // contender can never get past while the gate stays occupied, so this
    // can only time out. The assertion is about what survives.
    await expect(acquiring).rejects.toBeInstanceOf(ExitError);
    delete process.env.DRIVE_PR_LOCK_RECOVERING_TEST_SIGNAL;
    delete process.env.DRIVE_PR_LOCK_RECOVERING_TEST_DELAY;

    const [swapExitCode, swapStderr] = await Promise.all([
      swapper.exited,
      new Response(swapper.stderr).text(),
    ]);
    expect(swapStderr).toBe("");
    expect(swapExitCode).toBe(0);

    // The fresh, live gate survived untouched — never destroyed, never
    // quarantined.
    expect(existsSync(join(recovering, "owner.fresh1"))).toBe(true);
    expect(readdirSync(recovering)).toEqual(["owner.fresh1"]);
    expect(existsSync(`${recovering}.stale.owner.fresh1`)).toBe(false);
  });

  it("a malformed `.recovering` entry is cleaned up rather than blocking every later acquisition forever", async () => {
    // Not every `.recovering` mkdir failure is genuine contention — a
    // vanished parent directory or EACCES are two real examples. Modelled
    // here portably (no permission juggling): a plain FILE occupying the
    // gate's path. `mkdirSync` throws EEXIST against it exactly like it
    // would against a live directory, but `recoveringIsLive`'s own
    // `generationOf` — a `readdirSync` — throws ENOTDIR against a file and
    // used to read that as "already gone" (`holder === null`, i.e.
    // `false`) WITHOUT ever removing it — so the file sat there forever,
    // its mtime never touched, permanently re-failing the exact same way
    // on every later `mkdirSync(recovering)` attempt from ANY process,
    // including this one's own eventual `release()` (docomply-review
    // round 3 on #4050). `recoveringIsLive` now removes an entry it
    // cannot read a generation from, so the SECOND attempt here succeeds.
    //
    // A second, independent fix bounds the FIRST attempt regardless: the
    // pre-fix loop only checked its deadline INSIDE the
    // `if (recoveringIsLive())` branch, so a `false` here `continue`d
    // straight back to the top with no bound at all — an unconditional
    // spin (chatgpt-codex-connector, a reference-implementation pull request round 2) that would have
    // starved this test even if nothing ever cleaned the file up.
    const recovering = `${lock}.recovering`;
    writeFileSync(recovering, "");
    ageLock(recovering, 1); // older than RECOVERING_STALE_MS

    // A LIVE lock, so `acquire` reaches the stale-break path and calls
    // `acquireRecoveringGate` at all.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.holder1"), "");
    ageLock(lock, 10);

    process.env.DRIVE_PR_LOCK_TIMEOUT = "2";
    const contender = createLock(file, "test", "999");
    const start = Date.now();
    await contender.acquire();
    // Bounded to a handful of `RECOVERING_GATE_WAIT_MS` windows, not
    // "however long the test runner is willing to wait" — the pre-fix spin
    // never returns at all within any reasonable bound.
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(existsSync(recovering)).toBe(false);
    expect(readdirSync(lock).some((f) => f.startsWith("owner."))).toBe(true);
    contender.release();
  });

  it("DRIVE_PR_LOCK_TIMEOUT=0 still allows one immediate, uncontended acquisition to succeed", async () => {
    // `acquireDeadline` at `limit=0` equals this call's own start time, so
    // ANY elapsed time — even an uncontended success's own marker write —
    // trivially reads as "already past deadline". A post-success deadline
    // check with no exemption for the first attempt (added round 6 to fix
    // a DIFFERENT bug — a contended acquisition silently succeeding late)
    // rejected even a lock nobody was contending for, breaking the
    // documented, test-relied-on meaning of a zero timeout: "one immediate
    // attempt, don't retry", not "fail unless already held"
    // (docomply-review round 7 on #4050).
    process.env.DRIVE_PR_LOCK_TIMEOUT = "0";
    const contender = createLock(file, "test", "999");
    await contender.acquire();
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(lock).some((f) => f.startsWith("owner."))).toBe(true);
    contender.release();
  });

  it("DRIVE_PR_LOCK_TIMEOUT=0 fails fast against real, non-stale contention rather than waiting a full backoff interval (docomply-review round 14)", async () => {
    // A held, NOT-stale lock forces the ordinary contention branch — no
    // staleness or `.recovering` machinery involved at all. That branch's
    // `sleep(1)` had no remaining-budget guard, unlike its two siblings
    // (fixed rounds 12/13), so `DRIVE_PR_LOCK_TIMEOUT=0` silently waited
    // ~1s before reporting failure instead of honoring the documented "one
    // immediate attempt, don't retry" contract the test above exercises for
    // the uncontended case.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.deadbeef"), "");

    process.env.DRIVE_PR_LOCK_TIMEOUT = "0";
    const contender = createLock(file, "test", "999");
    const start = performance.now();
    await expect(contender.acquire()).rejects.toBeInstanceOf(ExitError);
    expect(performance.now() - start).toBeLessThan(500);

    // This branch never renames or inspects the contended lock — untouched.
    expect(existsSync(join(lock, "owner.deadbeef"))).toBe(true);
  });
});

describe("sweepLockQuarantine", () => {
  it("compacts a tombstone left by a normal acquire/release round-trip into an empty file at the SAME path", async () => {
    const solo = createLock(file, "test", "999");
    await solo.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    solo.release();
    const doomed = `${lock}.stale.${ownMarker}`;
    expect(statSync(doomed).isDirectory()).toBe(true);
    expect(existsSync(join(doomed, "tombstone"))).toBe(true);

    sweepLockQuarantine(file);

    // Still present at the exact same path — the fence a foreign rename
    // would collide against is never removed, only shrunk.
    expect(existsSync(doomed)).toBe(true);
    expect(statSync(doomed).isDirectory()).toBe(false);
    expect(readFileSync(doomed, "utf8")).toBe("");
  });

  it("compacts a `.recovering` tombstone alongside a `lock` tombstone", () => {
    // Plant one of each family by hand — the same shapes `tombstone()`
    // itself produces for `lock`'s own stale-break and `.recovering`'s own
    // stale-break, respectively.
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");
    const recoveringDoomed = `${lock}.recovering.stale.owner.${"b".repeat(24)}`;
    mkdirSync(recoveringDoomed, { recursive: true });
    writeFileSync(join(recoveringDoomed, "tombstone"), "broken by pid 1\n");

    sweepLockQuarantine(file);

    expect(statSync(lockDoomed).isDirectory()).toBe(false);
    expect(statSync(recoveringDoomed).isDirectory()).toBe(false);
  });

  it("is idempotent — a second sweep leaves an already-compacted entry alone (the SAME file, not a fresh one)", () => {
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");

    sweepLockQuarantine(file);
    expect(statSync(lockDoomed).isDirectory()).toBe(false);
    const inoAfterFirstSweep = statSync(lockDoomed).ino;

    // A second pass must not throw trying to `rmSync`+recreate a path that
    // is already a plain file — it should recognise "not a directory" and
    // skip it outright, never reopening the brief remove-then-recreate
    // vacancy window for an entry that needs no more work. Asserting only
    // "still an empty file afterward" would pass even if the skip were
    // deleted (a naive re-run leaves an equally empty file behind) — the
    // inode is what actually distinguishes "left alone" from "removed and
    // recreated".
    expect(() => sweepLockQuarantine(file)).not.toThrow();
    expect(existsSync(lockDoomed)).toBe(true);
    expect(readFileSync(lockDoomed, "utf8")).toBe("");
    expect(statSync(lockDoomed).ino).toBe(inoAfterFirstSweep);
  });

  it("never touches the LIVE `lock` or `.recovering` directories, only their `.stale.*` history", () => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.live1"), "");
    const recovering = `${lock}.recovering`;
    mkdirSync(recovering, { recursive: true });
    writeFileSync(join(recovering, "owner.live2"), "");
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");

    sweepLockQuarantine(file);

    expect(existsSync(join(lock, "owner.live1"))).toBe(true);
    expect(existsSync(join(recovering, "owner.live2"))).toBe(true);
    expect(statSync(lockDoomed).isDirectory()).toBe(false);
  });

  it("leaves an unrelated file whose name merely shares the lock prefix alone", () => {
    // Must not match on a bare prefix without the trailing separator dot —
    // `${lockBase}.staleness` looks like it starts with `${lockBase}.stale`
    // but is not one of the two quarantine families at all.
    const decoy = `${lock}.staleness-report.txt`;
    writeFileSync(decoy, "unrelated");

    sweepLockQuarantine(file);

    expect(readFileSync(decoy, "utf8")).toBe("unrelated");
  });

  it("a rename onto a compacted entry still fails outright — the fence survives compaction", async () => {
    // The property this whole function depends on: `tombstone()` makes a
    // quarantine path permanently non-empty so `rename(2)` refuses to
    // replace it (`quarantinePath`'s own doc comment). Compacting the
    // directory into a file must preserve exactly that — a directory
    // renamed onto an existing regular file fails with ENOTDIR, not silent
    // replacement.
    const solo = createLock(file, "test", "999");
    await solo.acquire();
    const ownMarker = readdirSync(lock).find((f) => f.startsWith("owner."));
    if (ownMarker === undefined) throw new Error("no owner marker");
    solo.release();
    const doomed = `${lock}.stale.${ownMarker}`;
    sweepLockQuarantine(file);
    expect(statSync(doomed).isDirectory()).toBe(false);

    const impostor = `${dir}/impostor-dir`;
    mkdirSync(impostor);
    expect(() => renameSync(impostor, doomed)).toThrow();
    // Untouched by the failed attempt.
    expect(readFileSync(doomed, "utf8")).toBe("");
  });

  it("is a no-op when the state directory itself does not exist", () => {
    const missing = join(dir, "nowhere", "drive-pr-999.json");
    expect(() => sweepLockQuarantine(missing)).not.toThrow();
  });

  it("restores a fence at the canonical path even when deleting the claimed staging copy itself fails", async () => {
    // `path` has already been claimed away (renamed to a private staging
    // copy) by the time the staging copy's own deletion could fail
    // (EACCES/EIO) — skipping the fence-restore fallback in that case would
    // leave the canonical path permanently vacant with no error anyone
    // sees (docomply-review, a reference-implementation pull request round 2).
    //
    // Modelled portably via `mock.module`, not `chmodSync` — a permission
    // bit is not a reliable way to induce EACCES: running as root (the
    // reviewer's own sandbox, and plenty of CI/dev containers) bypasses
    // directory permission checks entirely, so the deletion would silently
    // SUCCEED and this test would fail to exercise the failure path at all
    // (chatgpt-codex-connector, a reference-implementation pull request round 3). Intercepting `rmSync`
    // itself reproduces the same observable failure — a throw out of the
    // staging deletion — independent of the user the suite runs as.
    const actualFs = await import("node:fs");
    // Snapshotted into a fresh plain object, and the real `rmSync` pulled
    // out as its own reference, BEFORE `mock.module` swaps the registry
    // entry below — `actualFs` itself is a LIVE module namespace object, so
    // both the mock's delegate-to-real branch AND the `finally` restore
    // would otherwise resolve back through `actualFs.rmSync`/`actualFs`,
    // which by then mock.module has already mutated to point at the mock.
    // The delegate branch would recurse into itself forever on every
    // non-matching path; the restore would silently re-register the SAME
    // still-overridden object, leaking the override into every later test.
    const realRmSync = actualFs.rmSync;
    const realFs = { ...actualFs };
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");

    mock.module("node:fs", () => ({
      ...realFs,
      rmSync: (path: string, options?: unknown) => {
        if (typeof path === "string" && path.includes(".compacting.")) {
          const err = new Error(
            "EACCES: permission denied, rmdir",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realRmSync(path, options as never);
      },
    }));

    let leftover: string | undefined;
    try {
      expect(() => sweepLockQuarantine(file)).not.toThrow();

      expect(existsSync(lockDoomed)).toBe(true);
      expect(statSync(lockDoomed).isDirectory()).toBe(true);
      expect(existsSync(join(lockDoomed, "tombstone"))).toBe(true);

      // The failed staging deletion above left a `.compacting.*` leftover
      // behind — proves it, so the assertions after the mock is lifted are
      // exercising a REAL leftover, not asserting a vacuous "already
      // empty" list.
      leftover = readdirSync(dir).find((f) => f.includes(".compacting."));
      expect(leftover).toBeDefined();
    } finally {
      // Always restore the real module — `mock.module` is process-global
      // and never torn down automatically, so leaving the override in
      // place would break every other file's `node:fs` usage for the rest
      // of this test run.
      mock.module("node:fs", () => realFs);
    }

    // The leftover is invisible to THIS call's own primary sweep (its name
    // is deliberately excluded from both scanned prefixes), but the next
    // sweep retries and cleans it up rather than leaving it as permanent
    // debris (docomply-review, a reference-implementation pull request round 3 summary finding).
    sweepLockQuarantine(file);
    expect(existsSync(join(dir, leftover as string))).toBe(false);
  });

  it("leaves no `.compacting.*` staging leftovers behind — the private claim is always cleaned up", () => {
    // `compactQuarantineEntry` claims each entry via `renameSync(path,
    // staging)` before deleting anything — proves the private staging
    // directory itself never survives as orphaned debris, which would
    // otherwise just relocate the exact unbounded-growth problem an earlier change
    // exists to fix rather than solve it.
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");
    const recoveringDoomed = `${lock}.recovering.stale.owner.${"b".repeat(24)}`;
    mkdirSync(recoveringDoomed, { recursive: true });
    writeFileSync(join(recoveringDoomed, "tombstone"), "broken by pid 1\n");

    sweepLockQuarantine(file);

    const leftovers = readdirSync(dir).filter((f) =>
      f.includes(".compacting."),
    );
    expect(leftovers).toEqual([]);
  });

  it("retries only THIS lock’s own `.compacting.*` leftovers — a different PR’s in the same shared state dir is left untouched", () => {
    // The state directory is shared by every PR's lock files side by side
    // (`lockBase` is how a caller tells them apart), so a bare
    // `.compacting.` prefix on the retry pass would delete another PR's
    // active or failed staging copy too — the exact regression
    // docomply-review caught in round 5 against the round-3 fix above.
    const otherFile = join(dir, "drive-pr-888.json");
    const otherLock = `${otherFile}.lock`;
    const foreignLeftover = join(
      dir,
      `.compacting.${basename(otherLock)}.stale.owner.${"c".repeat(24)}.${"d".repeat(24)}`,
    );
    mkdirSync(foreignLeftover, { recursive: true });
    writeFileSync(join(foreignLeftover, "tombstone"), "broken by pid 1\n");

    sweepLockQuarantine(file);

    expect(existsSync(foreignLeftover)).toBe(true);
    expect(existsSync(join(foreignLeftover, "tombstone"))).toBe(true);
  });

  it("restores a fence at the canonical path before deleting a staging leftover from a KILLED claim, rather than destroying the only remaining copy of it", () => {
    // Models a process killed between `renameSync(path, staging)` and
    // EITHER of `rmSync`/`writeFileSync` — the canonical path was never
    // touched again after the claim rename, so it is genuinely vacant, and
    // `staging` is the ONLY remaining copy of this generation's fence. The
    // retry-cleanup pass above must not delete it outright: that would
    // permanently remove the fence with nothing left to restore it
    // (docomply-review, a reference-implementation pull request round 5 — a fresh finding against the
    // round-3 retry fix, distinct from the already-covered
    // rmSync-already-ran case above).
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    const staging = join(
      dir,
      `.compacting.${basename(lockDoomed)}.deadbeefdeadbeefdeadbeef`,
    );
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "tombstone"), "broken by pid 1\n");
    // The canonical path was already renamed away by the killed claim and
    // never recreated — genuinely absent, not merely a different state.
    expect(existsSync(lockDoomed)).toBe(false);

    sweepLockQuarantine(file);

    expect(existsSync(lockDoomed)).toBe(true);
    expect(statSync(lockDoomed).isDirectory()).toBe(true);
    expect(existsSync(join(lockDoomed, "tombstone"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  it("never deletes by canonical path — an entry it fails to claim is left exactly as it was", () => {
    // Models a lost claim race (e.g. a concurrent sweep already renamed this
    // exact entry away moments before this call's own `renameSync`): the
    // canonical path no longer exists as a DIRECTORY by the time this
    // function would act on it — `statSync` inside `compactQuarantineEntry`
    // already sees "not a directory, nothing to do" and never attempts a
    // claim at all, so a genuinely foreign object sitting at a
    // `.stale.`-prefixed path (never legitimately reachable in practice —
    // only `tombstone()`'s own protocol ever populates one — but this
    // guards the "compact unconditionally, no identity check needed"
    // argument in the doc comment above: skip, don't destroy, whenever the
    // content is not the directory shape this function knows how to claim).
    // The generation is a fully grammatical `owner.<24 hex>` — not a decoy
    // string like `owner.not-a-directory` — so the tightened quarantine-name
    // match (chatgpt-codex-connector, a reference-implementation pull request round 18) is not what excludes
    // it; only the not-a-directory check is exercised, per this rule's own
    // fail-closed-conjunction requirement (document-scanning-gates.md § 5).
    const decoyFile = `${lock}.stale.owner.${"a".repeat(24)}`;
    writeFileSync(decoyFile, "not a lock quarantine directory");

    sweepLockQuarantine(file);

    expect(readFileSync(decoyFile, "utf8")).toBe(
      "not a lock quarantine directory",
    );
  });

  it("leaves a foreign `.stale.manual-backup` sibling untouched, contents intact — the reviewer’s own example of a name this protocol never produces", () => {
    // The exact gap chatgpt-codex-connector found in PR #4197 round 18: a
    // plain `startsWith(lockStalePrefix)` check matched ANY name sharing the
    // stale prefix, independent of `generationOf`'s actual grammar, so a
    // human's manual backup sitting next to a genuine quarantine entry was
    // compacted (and its contents destroyed) right along with it.
    const foreign = `${lock}.stale.manual-backup`;
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "notes.txt"), "human debugging notes");

    sweepLockQuarantine(file);

    expect(existsSync(foreign)).toBe(true);
    expect(statSync(foreign).isDirectory()).toBe(true);
    expect(readFileSync(join(foreign, "notes.txt"), "utf8")).toBe(
      "human debugging notes",
    );
  });

  it("leaves a foreign `.compacting.<lockBase>.manual-backup` sibling untouched — the payload capture must itself be a genuine quarantine name, not `(.+)`", () => {
    // The more severe half of the same finding: the `.compacting.` branch
    // used to `rmSync` the staging copy UNCONDITIONALLY once the entry
    // matched the bare `.compacting.<lockBase>.` prefix, regardless of
    // whether the payload after that prefix was a genuine quarantine name —
    // the payload capture only gated whether to restore a canonical fence,
    // never whether to delete. So a foreign FILE (not even a directory) sharing
    // this prefix was destroyed outright, with no `isDirectory` guard at all,
    // unlike the `.stale.` branch above.
    const lockBase = basename(lock);
    const foreign = join(dir, `.compacting.${lockBase}.manual-backup`);
    writeFileSync(foreign, "human debugging notes");

    sweepLockQuarantine(file);

    expect(existsSync(foreign)).toBe(true);
    expect(readFileSync(foreign, "utf8")).toBe("human debugging notes");
  });
});
