/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it, spyOn } from "bun:test";

import { execFileSync } from "node:child_process";

import { hostname } from "node:os";

import { join, resolve } from "node:path";

import { cloneKey } from "../scripts/lib/state/clone-key";

import {
  assertRemoteMutationAllowed,
  type FenceContext,
  remoteLockName,
  type Session,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease";

import { createLock } from "../scripts/lib/state/lock";

import {
  SCRIPTS,
  ACTOR,
  suiteHome,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { lockRow } from "./state-rows.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, twoDrivers, drive } = stateDurabilityFixtures;

  /** This process as the session a fence judges, in clone `d`. */
  function contextIn(d: string): FenceContext {
    const session: Session = {
      pid: process.pid,
      host: hostname(),
      source: "DRIVE_PR_SESSION",
      sessionStarted: "",
    };
    return {
      stateDir: d,
      actor: ACTOR,
      session,
      instance: stateDirIdentityToken(d),
    };
  }

  /**
   * The state directory both worktrees of `a`'s clone share: the default
   * root under the suite's home, keyed by the clone (the
   * `--git-common-dir`), not by either tree.
   */
  function sharedStateDir(a: string, env: Record<string, string>): string {
    const commonDir = resolve(
      a,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: a,
        env,
      })
        .toString()
        .trim(),
    );
    return join(
      suiteHome,
      ".local",
      "state",
      "jig",
      "drive-pr",
      cloneKey(commonDir),
    );
  }

  describe("the PR-wide remote-mutation lock spans the push/POST", () => {
    it("assertRemoteMutationAllowed HOLDS the PR-wide lock, not just checks it", async () => {
      // A fence that only READ the lease set and returned would let a
      // DIFFERENT worktree's admission land in the exact window between the
      // check and `git push` (or the POST) completing. Proven directly at the
      // lock level, independent of `guarded-push.ts`'s own subprocess
      // plumbing: a second acquirer of the SAME PR-wide lock row must stay
      // BLOCKED for as long as the returned lock is held.
      const d = stateDirFor("remote-lock-held");
      // No lease seeded — the fence's own per-PR enumeration finds nothing,
      // so the lock is the only thing left to prove.
      const lock = await assertRemoteMutationAllowed(
        contextIn(d),
        "999",
        "test",
      );
      expect(lock).not.toBeNull();
      expect(lockRow(d, remoteLockName("999"))).not.toBeNull();
      let released = false;
      try {
        const rival = createLock(
          d,
          remoteLockName("999"),
          "drive-state.ts (pr remote mutation)",
          "999",
        );
        let rivalAcquired = false;
        const rivalPromise = rival
          .acquire(5)
          .then(() => {
            rivalAcquired = true;
          })
          .finally(() => {
            rival.release();
            rival.dispose();
          });
        await new Promise((res) => setTimeout(res, 300));
        // Still held 300ms later — the rival must not have gotten in while
        // this lock was live, which is the whole property under test.
        expect(rivalAcquired).toBe(false);
        lock?.release();
        lock?.dispose();
        released = true;
        await rivalPromise;
        expect(rivalAcquired).toBe(true);
      } finally {
        if (!released) {
          lock?.release();
          lock?.dispose();
        }
      }
    });

    it("returns null, and touches nothing, with no PR named", async () => {
      // `assert-post-allowed.ts`'s standalone actor-wide path — there is no
      // single PR this call is protecting, so there is nothing for a lock
      // keyed by PR to guard.
      const d = stateDirFor("remote-lock-nopr");
      const ctx = contextIn(d);
      // A before/after look at the lock table cannot see an acquire-then-
      // release, and a listener-COUNT snapshot cannot see a construct-then-
      // DISPOSE, since `dispose()` removes the exact listener `createLock`
      // added. So this spies on the GLOBAL seam every lock construction
      // calls — `process.on('exit', ...)`, through `registerCleanup` — and
      // records every CALL, not the net listener count afterward: there is no
      // way to construct a `PathLock` without this call firing first, and no
      // way for a later `dispose()` to erase the fact that it fired. The spy
      // goes through the EventEmitter view (same object, same seam): bun-types'
      // `process.on` overloads collapse so `spyOn` would infer the
      // 'memoryPressure' signature, making `event === 'exit'` below a
      // no-overlap type error.
      const onSpy = spyOn(
        process as unknown as import("node:events").EventEmitter,
        "on",
      );
      let lock: Awaited<ReturnType<typeof assertRemoteMutationAllowed>>;
      try {
        lock = await assertRemoteMutationAllowed(ctx, null, "test");
      } finally {
        onSpy.mockRestore();
      }
      expect(lock).toBeNull();
      expect(onSpy.mock.calls.some(([event]) => event === "exit")).toBe(false);
      expect(lockRow(d, remoteLockName("999"))).toBeNull();
    });

    it("refuses a DIFFERENT worktree claiming this PR while the lock is held mid-push, and admits it once released", async () => {
      // The acceptance criterion this issue was filed against: worktree A
      // holds the fence and is mid-push when worktree B claims the PR's
      // per-PR lease and attempts a mutation — B must be refused until A's
      // push completes. Two REAL worktrees, for the same reason every other
      // cross-tree probe in this file uses them: the actor is derived and
      // deliberately not overridable, so a stand-in would prove the refusal
      // fires on a value the test chose rather than on the topology.
      //
      // A never actually claims a per-PR lease of its own here — the lock
      // ALONE (guarded-push.ts's or answer-summary-finding.ts's hold across
      // their own mutation) must block a fresh claim regardless of whether
      // the pusher's own lease still looks alive, which is exactly the case a
      // point-in-time check of the leases could not see at all (nothing
      // renews A's lease mid-push). Holding the lock directly,
      // the way a real push does via `assertRemoteMutationAllowed`, is what
      // this probe is actually proving — spawning a real `guarded-push.ts`
      // would additionally exercise its own subprocess plumbing, which the
      // unit-level test above already covers on its own.
      const { a, b, env } = twoDrivers("remote-mutation-lock-pr-wide");
      // Both worktrees land on the SAME clone's rows because they share one
      // clone.
      const stateDir = sharedStateDir(a, env);
      const holdLock = createLock(
        stateDir,
        remoteLockName("999"),
        "drive-state.ts (pr remote mutation)",
        "999",
      );
      await holdLock.acquire();
      let released = false;
      // Hoisted above the `try` so the `finally` below can see and clean
      // them up on EVERY exit path, not just the happy one — a `const`/`let`
      // declared inside the `try` block is out of scope in its own `finally`.
      let proc: ReturnType<typeof Bun.spawn> | undefined;
      let exitCode: number | null = null;
      let exitedPromise: Promise<number> | undefined;
      try {
        proc = Bun.spawn(
          scriptArgv(
            join(SCRIPTS, "drive-state.ts"),
            "hold",
            "999",
            "--key",
            "PRRT_b",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/thread-b-reply",
          ),
          {
            cwd: b,
            env: { ...env, DRIVE_PR_SESSION: String(process.pid) },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        exitedPromise = proc.exited.then((code) => {
          exitCode = code;
          return code;
        });
        await new Promise((res) => setTimeout(res, 500));
        // Still blocked half a second later — B's claim must not have gone
        // through while A's (simulated) push holds the PR-wide lock, which
        // is the whole property this issue was filed over.
        expect(exitCode).toBeNull();
        holdLock.release();
        holdLock.dispose();
        released = true;
        // Bounded, not a bare `await`:
        // if the admission path regressed into an indefinite wait, an
        // unbounded await here would hang this ENTIRE test suite rather
        // than fail this one test — the `finally` below still kills the
        // child on any exit path, but the failure itself needs to surface
        // promptly, not after the suite's own outer runner eventually gives
        // up. Generous relative to the 500ms already waited above: B should
        // be admitted within milliseconds of the lock releasing.
        const AWAIT_EXITED_TIMEOUT_MS = 15_000;
        // The timer is cleared as soon as the race settles either way — a
        // `setTimeout` that outlives the `Promise.race` it was created for
        // keeps its closure (and the timer itself) alive for the rest of
        // this timeout's duration even after the normal, fast path has
        // already won.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          exitedPromise.then(() => false),
          new Promise<boolean>((resolve) => {
            timeoutHandle = setTimeout(
              () => resolve(true),
              AWAIT_EXITED_TIMEOUT_MS,
            );
          }),
        ]);
        clearTimeout(timeoutHandle);
        if (timedOut) {
          throw new Error(
            `B's 'hold' subprocess did not exit within ${AWAIT_EXITED_TIMEOUT_MS}ms of the lock releasing — the admission path may be hanging rather than genuinely refusing or succeeding.`,
          );
        }
        // Admitted the instant the lock clears — nothing else in this test
        // stood in B's way, so a non-zero exit here would mean the new gate
        // is refusing more than the in-flight mutation it exists to guard.
        // Compared via `===` rather than `expect(exitCode).toBe(0)`:
        // `exitCode` is mutated inside the closure above, so TypeScript never
        // narrows it past its declared `number | null` at any later read —
        // bun-types' generic `toBe<X = T>` overload then fails to resolve
        // against a `null`-inclusive `T`. A boolean comparison sidesteps that
        // inference entirely rather than fighting it with a cast.
        expect(exitCode === 0).toBe(true);
        const held = JSON.parse(
          drive(b, { ...env, DRIVE_PR_SESSION: String(process.pid) }, [
            "held",
            "999",
          ]).stdout,
        );
        expect(held.map((h: { key: string }) => h.key)).toEqual(["PRRT_b"]);
      } finally {
        if (!released) {
          holdLock.release();
          holdLock.dispose();
        }
        // Terminate and join the child on EVERY exit path, not just the
        // happy one: an assertion throwing above (e.g. the `toBeNull()`
        // check) would otherwise leave the child running, unkilled and
        // unjoined. `exitCode` is only ever set by the `.then()` above, so
        // it being still `null` here means the child has not reported an
        // exit yet.
        if (
          proc !== undefined &&
          exitedPromise !== undefined &&
          exitCode === null
        ) {
          try {
            proc.kill();
          } catch {
            // Already gone — nothing left to signal.
          }
          await exitedPromise.catch(() => {
            // Best-effort join; this cleanup must not itself throw and mask
            // whatever error is already propagating out of this `finally`.
          });
        }
      }
    });

    it("reports a genuinely-exceeded wait as exit 11, not acquire()'s own generic exit 1", async () => {
      // `claimPrLease`'s gate waits out an in-flight hold only up to
      // whatever THIS process's own acquire() bound resolves to
      // (`Math.min(LOCK_ACQUIRE_MAX_SEC, $DRIVE_PR_LOCK_TIMEOUT ?? 30)`,
      // `lock.ts`'s own arithmetic — never longer, whatever this call
      // passes, since a caller-supplied cap can only lower that bound, not
      // raise it). `$DRIVE_PR_LOCK_TIMEOUT` pinned to 1s here is a realistic
      // OPERATOR configuration, not a bypass attempt — proving that when a
      // hold genuinely outlasts it, B is refused with the purpose-built
      // exit 11, not `acquire`'s own generic exit 1
      // "could not acquire … or the lock is wedged" message, which would
      // misreport an entirely ordinary long-running push as a stuck lock.
      const { a, b, env } = twoDrivers("remote-mutation-lock-exceeds-wait");
      const stateDir = sharedStateDir(a, env);
      const holdLock = createLock(
        stateDir,
        remoteLockName("999"),
        "drive-state.ts (pr remote mutation)",
        "999",
      );
      await holdLock.acquire();
      try {
        const r = drive(
          b,
          {
            ...env,
            DRIVE_PR_SESSION: String(process.pid),
            DRIVE_PR_LOCK_TIMEOUT: "1",
          },
          [
            "hold",
            "999",
            "--key",
            "PRRT_b2",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/thread-b2-reply",
          ],
        );
        // `lock.ts`'s own `acquire()` still prints ITS generic diagnostic to
        // stderr before throwing — that is unavoidable from the caller side
        // and harmless (extra context, not a conflicting claim) — so this
        // asserts on the EXIT CODE (11, not `acquire()`'s own generic 1) and
        // on the refusal's OWN message being present, not on the absence of
        // `acquire()`'s.
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain("irreversible remote mutation");
        expect(r.stderr).toContain("in flight from another worktree");
        expect(r.stderr).toContain("not necessarily wedged");
      } finally {
        holdLock.release();
        holdLock.dispose();
      }
    });
  });
});
