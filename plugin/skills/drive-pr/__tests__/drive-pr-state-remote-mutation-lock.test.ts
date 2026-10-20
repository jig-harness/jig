/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it, spyOn } from "bun:test";

import { execFileSync } from "node:child_process";

import { createHash } from "node:crypto";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join, resolve } from "node:path";

import { ExitError } from "../scripts/lib/cli";

import { cloneKey } from "../scripts/lib/state/clone-key";

import {
  assertRemoteMutationAllowed,
  leasePathFor,
  prRemoteMutationLockPathFor,
  type Session,
} from "../scripts/lib/state/lease";

import { createLock } from "../scripts/lib/state/lock";

import { defaultStateDirFor } from "../scripts/lib/state/store";

import {
  SCRIPTS,
  ACTOR,
  suiteHome,
  gitCleanEnv,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { twoDrivers, drive } = stateDurabilityFixtures;

  describe("the PR-wide remote-mutation lock spans the push/POST", () => {
    it("assertRemoteMutationAllowed HOLDS the PR-wide lock, not just checks it", async () => {
      // The gap this closes: before this fix, the fence read the per-PR
      // lease set and returned `void` — the underlying PR-wide lock was
      // never taken at all, so a DIFFERENT worktree's admission could land
      // in the exact window between the check and `git push` (or the POST)
      // completing. Proven directly at the lock level, independent of
      // `guarded-push.ts`'s own subprocess plumbing — the same shape as the
      // tree lock's own proof above: a second acquirer of the SAME
      // PR-remote-mutation-lock path — via the identical `createLock(path,
      // ...)` call `prRemoteMutationLockPathFor` resolves to — must stay
      // BLOCKED for as long as the returned lock is held.
      const d = mkdtempSync(join(tmpdir(), "drive-pr-remote-lock-held-"));
      const path = prRemoteMutationLockPathFor(d, "999");
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      // No lease seeded — the fence's own per-PR enumeration finds nothing,
      // so the lock is the only thing left to prove.
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir: d,
          actor: ACTOR,
          session,
          fromOverride: false,
          legacyStateDirForFallback: d,
        },
        "999",
        "test",
      );
      expect(lock).not.toBeNull();
      let released = false;
      try {
        const rival = createLock(
          path,
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

    it("re-resolves the legacy-fallback directory LIVE, catching a drive admitted after the snapshot decision (TOCTOU)", async () => {
      // The race this closes: `resolveFenceContext` decides `legacyDir` vs
      // its relocation ONCE, as a snapshot — an empty, unmarked
      // legacy directory at that instant resolves to `legacyDir`. If a
      // concurrent current-code `drive.ts` is admitted into the relocated
      // directory (creates it, writes its lease) any time between that
      // snapshot and this fence's own check, a fence that trusted the stale
      // snapshot would enumerate the wrong directory and miss that lease
      // entirely — an exact fail-open.
      //
      // Reproduced directly at the `ctx` level, the same way the override
      // path's rename-and-recreate races are proven elsewhere in this file:
      // hand-build a `ctx` that matches what `resolveFenceContext` would
      // have returned from a genuinely empty legacy directory (`stateDir`
      // pinned to `legacyDir`, `fromOverride: false`), THEN — simulating the
      // concurrent admission — write a live foreign lease into
      // `defaultStateDirFor(legacyDir)`, and only THEN call
      // `assertRemoteMutationAllowed` with the stale `ctx`. It must still
      // refuse: that is only possible if the fence re-derives the directory
      // choice live, rather than trusting `ctx.stateDir` as resolved.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "drive-pr-legacy-fallback-race-"),
      );
      // `defaultStateDirFor` resolves under the REAL `os.homedir()` — this
      // legacyDir mints a fresh, random clone identity, so the resulting
      // `newDir` is a unique, never-otherwise-touched path (never collides
      // with the developer's own real drive-pr state), but it is still a
      // real write outside this test's own tmpdir and must be cleaned up
      // explicitly — nothing removes it automatically, and leaving one behind
      // on every run accumulates without bound.
      const newDir = defaultStateDirFor(legacyDir);
      try {
        mkdirSync(newDir, { recursive: true });
        const foreignActor = "wt-00000000deadbeef";
        // `holder: 'worktree'` — `isMine` decides a tree-held record purely
        // by `actor` (never pid/host, see its own comment), so this is
        // genuinely foreign as long as `foreignActor` differs from the
        // caller's own `ACTOR` below, with no need to spawn a separate live
        // process just to get a pid `isMine`'s (pid, host) branch would not
        // treat as ours. `leaseAlive` for this holder kind checks only
        // `lastSeen` freshness.
        writeFileSync(
          leasePathFor(newDir, "999", foreignActor),
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: foreignActor,
            worktree: "/some/other/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        let threw: unknown;
        try {
          await assertRemoteMutationAllowed(
            {
              // The STALE snapshot decision — what `resolveFenceContext`
              // would have returned before the concurrent admission above
              // landed.
              stateDir: legacyDir,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: legacyDir,
            },
            "999",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("never mints a clone identity for a genuinely fresh legacy dir", async () => {
      // This fence is documented as lightweight and read-only, but the
      // original `resolveLegacyFallbackDir` called `defaultStateDirFor`
      // unconditionally, which calls `cloneKey` — durably minting and
      // persisting a fresh clone identity (`drive-pr-clone-id`) the first
      // time it runs on a legacy dir that has none. A read-only check must
      // not have that side effect. `legacyDir` here has no such file at all
      // (a genuinely never-driven clone), so `peekDefaultStateDirFor` must
      // return `null` and the fence must fall back to `legacyDir` WITHOUT
      // minting anything.
      const legacyDir = mkdtempSync(join(tmpdir(), "drive-pr-no-mint-legacy-"));
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      expect(existsSync(join(legacyDir, "drive-pr-clone-id"))).toBe(false);
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir: legacyDir,
          actor: ACTOR,
          session,
          fromOverride: false,
          legacyStateDirForFallback: legacyDir,
        },
        "999",
        "test",
      );
      try {
        expect(existsSync(join(legacyDir, "drive-pr-clone-id"))).toBe(false);
      } finally {
        lock?.release();
        lock?.dispose();
      }
    });

    it("prefers an empty, not-yet-created newDir over acquiring the PR-wide lock in legacyDir when legacyDir holds nothing", async () => {
      // Two things proven together: the lock is acquired against the SAME
      // directory `resolveLegacyFallbackDir` would resolve to fresh (a lock
      // built from the STALE `ctx.stateDir` before any live refresh ran would
      // target the wrong directory), and that fresh resolution avoids
      // `legacyDir` entirely when it holds no real footprint (every acquire/
      // release leaves a permanent quarantine tombstone in whatever
      // directory it targets, which `legacyFootprint()` then reads back as
      // "unmigrated state", manufacturing a spurious migration refusal).
      //
      // `legacyDir` carries a PRE-EXISTING clone identity (so `newDir`'s path
      // is knowable via `peekDefaultStateDirFor` without this call minting
      // one) but is otherwise completely empty — no drive-pr footprint of
      // any kind — and `newDir` does not exist yet either. The stale `ctx`
      // handed to the fence still names `legacyDir` (as if resolved before
      // this state existed), mirroring the exact snapshot-then-check gap
      // enumeration guards against; this test is the same gap for the LOCK.
      //
      // Run as a SUBPROCESS, not in-process like the sibling tests above:
      // `peekDefaultStateDirFor`/`defaultStateDirFor` resolve `newDir` under
      // `os.homedir()`, and under Bun (unlike Node) `os.homedir()` does NOT
      // re-read `$HOME` from `process.env` after startup — an in-process
      // `process.env.HOME = fakeHome` before calling the fence is silently
      // ineffective, and the fence resolves and mutates the REAL developer's
      // `~/.local/state/jig` instead (measured while writing this test: it did).
      // Only a genuinely separate process picks up a faked `$HOME` cold, the
      // same reason `suiteHome`/`gitCleanEnv()` above route every
      // `homedir()`-sensitive probe in this file through a subprocess rather
      // than an in-process env mutation.
      const probeDir = mkdtempSync(
        join(tmpdir(), "drive-pr-empty-legacy-prefers-new-probe-"),
      );
      const legacyDir = join(probeDir, "legacy");
      const fakeHome = join(probeDir, "home");
      mkdirSync(legacyDir, { recursive: true });
      mkdirSync(fakeHome, { recursive: true });
      // A real, persisted clone identity — written the same way
      // `cloneKey`/`defaultStateDirFor` would, but without invoking either,
      // so this fixture does not itself depend on the code path under test.
      // UUID-shaped (never a bare label) so it survives `clone-key.ts`'s own
      // validation, which refuses anything `randomUUID()` would not have
      // minted — the same fixed value `migrate-legacy-state.test.ts` uses for
      // the identical reason.
      const cloneId = "4c1d2e3f-1a2b-4c3d-8e4f-0123456789ab";
      writeFileSync(join(legacyDir, "drive-pr-clone-id"), `${cloneId}\n`);
      const newDir = join(
        fakeHome,
        ".local",
        "state",
        "jig",
        "drive-pr",
        createHash("sha256").update(cloneId).digest("hex").slice(0, 16),
      );
      const leaseTsPath = join(SCRIPTS, "lib", "state", "lease.ts");
      const probeScript = join(probeDir, "probe.ts");
      writeFileSync(
        probeScript,
        [
          `import { existsSync, readdirSync } from 'node:fs';`,
          `import { hostname } from 'node:os';`,
          `import { assertRemoteMutationAllowed, prRemoteMutationLockPathFor } from ${JSON.stringify(leaseTsPath)};`,
          `const legacyDir = ${JSON.stringify(legacyDir)};`,
          `const newDir = ${JSON.stringify(newDir)};`,
          `const session = { pid: process.pid, host: hostname(), source: 'DRIVE_PR_SESSION', sessionStarted: '' };`,
          `const lock = await assertRemoteMutationAllowed(`,
          `  { stateDir: legacyDir, actor: 'wt-probe', session, fromOverride: false, legacyStateDirForFallback: legacyDir },`,
          `  '999', 'test',`,
          `);`,
          `console.log(JSON.stringify({`,
          `  lockAtNewDir: existsSync(prRemoteMutationLockPathFor(newDir, '999') + '.lock'),`,
          `  legacyDirEntries: readdirSync(legacyDir),`,
          `}));`,
          `lock?.release();`,
          `lock?.dispose();`,
        ].join("\n"),
      );
      try {
        expect(existsSync(newDir)).toBe(false);
        const r = Bun.spawnSync([process.execPath, probeScript], {
          // Windows' home directory is USERPROFILE, not HOME.
          env: { ...gitCleanEnv(), HOME: fakeHome, USERPROFILE: fakeHome },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(r.stderr.toString()).toBe("");
        const result = JSON.parse(r.stdout.toString());
        expect(result.lockAtNewDir).toBe(true);
        // legacyDir must show NOTHING drive-pr related beyond the
        // pre-seeded clone-id fixture itself — no lock, no quarantine.
        expect(result.legacyDirEntries).toEqual(["drive-pr-clone-id"]);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
        rmSync(newDir, { recursive: true, force: true });
      }
    });

    it("does NOT trust an existing newDir as migration proof when legacyDir still holds a live lease", async () => {
      // The gap the "prefer empty newDir" rule leaves open: `newDir`
      // existing was still, on its own, sufficient to select it — and
      // `ensureMigratedFromLegacy`/`migrate-legacy-state.ts --apply` both
      // `mkdirSync(newDir)` BEFORE scanning `legacyDir` and possibly
      // refusing, so an empty `newDir` is exactly as consistent with a
      // FAILED admission attempt as with a genuine one. `legacyDir` here
      // holds a real, live foreign lease — the marker is absent and
      // `newDir` exists-but-empty, simulating exactly that failed-attempt
      // debris. The fence must still find and refuse on the live lease in
      // `legacyDir`, not silently trust the empty `newDir`.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "drive-pr-newdir-not-proof-legacy-"),
      );
      const newDir = defaultStateDirFor(legacyDir);
      const foreignActor = "wt-00000000deadbeef";
      try {
        // `newDir` exists (as `ensureMigratedFromLegacy` would leave it
        // after a refused attempt) but is otherwise completely empty — no
        // marker, no lease.
        mkdirSync(newDir, { recursive: true });
        // `legacyDir` holds a genuinely LIVE lease — the content a failed
        // migration attempt would have refused on, and exactly what this
        // fence must not miss.
        writeFileSync(
          leasePathFor(legacyDir, "999", foreignActor),
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: foreignActor,
            worktree: "/some/other/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        let threw: unknown;
        try {
          await assertRemoteMutationAllowed(
            {
              stateDir: legacyDir,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: legacyDir,
            },
            "999",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("returns null, and touches nothing, with no PR named", async () => {
      // `assert-post-allowed.ts`'s standalone actor-wide path — there is no
      // single PR this call is protecting, so there is nothing for a lock
      // keyed by PR to guard.
      const d = mkdtempSync(join(tmpdir(), "drive-pr-remote-lock-nopr-"));
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      // Three rounds of observational fixes here (readdirSync name-list,
      // fs.watch, then a listenerCount snapshot) were each correctly found
      // insufficient in turn: a before/after snapshot cannot see a
      // create-then-remove, fs.watch's OS-level delivery is best-effort and
      // can coalesce or drop events, and a listener-COUNT snapshot cannot
      // see a construct-then-DISPOSE, since `dispose()` removes the exact
      // listener `createLock` added. The actual structural fix: spy on the
      // GLOBAL seam `createLock` unconditionally calls at construction —
      // `process.on('exit', ...)` — and record every CALL, not the net listener
      // count afterward. This captures the ATTEMPT itself, synchronously,
      // before any filesystem I/O, and survives any later `dispose()`
      // un-registering it — there is no way to construct a `PathLock` without
      // this call firing first, and no way for a subsequent `dispose()` to
      // erase the fact that it fired. bun-types 1.4.0 regression: the
      // process.on overloads collapse so `spyOn` infers the 'memoryPressure'
      // signature, making `event === 'exit'` below a no-overlap type error. Spy
      // through the EventEmitter view — same object, same seam, honest event
      // type — matching the cast lib/state/lock.ts already carries for the
      // mirror-image process.off collapse.
      const onSpy = spyOn(
        process as unknown as import("node:events").EventEmitter,
        "on",
      );
      let lock: Awaited<ReturnType<typeof assertRemoteMutationAllowed>>;
      try {
        lock = await assertRemoteMutationAllowed(
          {
            stateDir: d,
            actor: ACTOR,
            session,
            fromOverride: false,
            legacyStateDirForFallback: d,
          },
          null,
          "test",
        );
      } finally {
        onSpy.mockRestore();
      }
      expect(lock).toBeNull();
      expect(onSpy.mock.calls.some(([event]) => event === "exit")).toBe(false);
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
      // A never actually claims a per-PR lease of its own here — the race
      // this closes is that the lock ALONE (guarded-push.ts's or
      // answer-summary-finding.ts's hold across their own mutation) must
      // block a fresh claim regardless of whether the pusher's own lease
      // still looks alive, which is exactly the case where the OLD,
      // point-in-time-only check could not have seen the conflict at all
      // (nothing had renewed A's lease mid-push). Holding the lock directly,
      // the way a real push does via `assertRemoteMutationAllowed`, is what
      // this probe is actually proving — spawning a real `guarded-push.ts`
      // would additionally exercise its own subprocess plumbing, which the
      // unit-level test above already covers on its own.
      const { a, b, env } = twoDrivers("remote-mutation-lock-pr-wide");
      // Both worktrees land on the SAME state dir because they share one
      // clone (mirrors the stale-lease probe above) — the default,
      // `~/.local/state/jig/drive-pr/<cloneKey>/`, keyed off `--git-common-dir`
      // rather than the common dir itself.
      const commonDirRemoteLock = resolve(
        a,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: a,
          env,
        })
          .toString()
          .trim(),
      );
      const stateDir = join(
        suiteHome,
        ".local",
        "state",
        "jig",
        "drive-pr",
        cloneKey(commonDirRemoteLock),
      );
      // A real caller only ever reaches `createLock()` after `resolveStateDir()`
      // has guaranteed this directory exists (via `ensureMigratedFromLegacy`'s
      // own `mkdirSync`, or `openStore()`'s) — this test constructs the lock
      // path directly, bypassing both, so it has to establish the same
      // precondition itself. Without it, `createLock`'s `acquire()` sees
      // `mkdirSync(lock)` fail with ENOENT (missing parent) and retries
      // indefinitely, identically to how it treats an already-held lock
      // (`lock.ts`'s blanket `catch` does not distinguish the two) — a real
      // hang, not a flake.
      mkdirSync(stateDir, { recursive: true });
      const holdLock = createLock(
        prRemoteMutationLockPathFor(stateDir, "999"),
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
        // happy one: an earlier
        // assertion throwing above (e.g. the `toBeNull()` check) left the
        // child running, unkilled and unjoined, in the original version of
        // this test. `exitCode` is only ever set by the `.then()` above, so
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
      // See the previous test's comment: both worktrees share one clone's
      // default state dir, keyed off `--git-common-dir`, not that dir itself.
      const commonDirExceedsWait = resolve(
        a,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: a,
          env,
        })
          .toString()
          .trim(),
      );
      const stateDir = join(
        suiteHome,
        ".local",
        "state",
        "jig",
        "drive-pr",
        cloneKey(commonDirExceedsWait),
      );
      // See the previous test's comment: `createLock()` here bypasses
      // `resolveStateDir()`'s own guarantee that this directory exists.
      mkdirSync(stateDir, { recursive: true });
      const holdLock = createLock(
        prRemoteMutationLockPathFor(stateDir, "999"),
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
        // on this fix's OWN message being present, not on the absence of
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
