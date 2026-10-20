/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { hostname } from "node:os";

import { join } from "node:path";

import { ExitError } from "../scripts/lib/cli";

import { pidCheckCommand } from "../scripts/lib/proc";

import { claimPathFor } from "../scripts/lib/state/claims";

import {
  assertLeaseUnchanged,
  clearAllLeases,
  leasePathFor,
} from "../scripts/lib/state/lease";

import { createLock } from "../scripts/lib/state/lock";

import {
  ACTOR,
  OLDER_SESSION_TOKEN,
  NEWER_SESSION_TOKEN,
  STALE_LASTSEEN,
  HELD_PUSH,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateSessionLeaseFixtures } from "./drive-pr-state-session-lease-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;
  describe("the session lease over one working tree", () => {
    const stateSessionLeaseFixtures = createStateSessionLeaseFixtures(
      stateDurabilityFixtures,
    );
    const { deadPid } = stateSessionLeaseFixtures;

    describe("OS pid reuse defeats (pid, host) alone", () => {
      // `isMine` alone cannot decide `claimLease`'s renewal-vs-takeover:
      // matching on (pid, host) and preserving the generation is defeated by
      // pid reuse. `$DRIVE_PR_SESSION_STARTED` covers that for `isMine` itself
      // (the "session-started token" suite above) — but `claimLease` also asks
      // `leaseAlive`, and once the OS has handed a dead predecessor's exact pid
      // to THIS session, `leaseAlive`'s pid half is asking whether the CALLER
      // is running, which is tautologically true. Trusting that answer keeps
      // the claim refused (not merged, but not admitted either) for a full
      // staleness window instead of minting the new generation the collision
      // requires.
      //
      // These probes fake OS pid reuse the same way the fence's own token
      // tests do: seed a lease under THIS TEST'S OWN pid (always alive, so
      // `pidAlive` cannot tell the fixture apart from a real collision) while
      // giving the CLAIMING call a DIFFERENT `$DRIVE_PR_SESSION_STARTED` than
      // the one on disk — the token `drive.ts` mints once per launch.

      function deadPredecessorLease(generation: string): string {
        return JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: ACTOR,
          worktree: "/tmp/dead-predecessor-tree",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          // Fresh — well inside the default staleness window — so a fix that
          // merely waits out `leaseAlive`'s staleness clock, rather than
          // recognizing the recycled pid, would still show this test red.
          lastSeen: new Date(Date.now() - 60_000).toISOString(),
          command: "hold",
          generation,
          sessionStarted: OLDER_SESSION_TOKEN,
        });
      }

      it("a reused pid inside the staleness window MINTS a new generation rather than being refused or renewed", async () => {
        const d = stateDirFor("pid-reuse-mints");
        const path = leasePathFor(d, "999", ACTOR);
        const oldGeneration = "a".repeat(32);
        writeFileSync(path, deadPredecessorLease(oldGeneration));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        // Not 11: a session whose pid the OS has recycled must be admitted as
        // a TAKEOVER, not stuck behind a "someone else is driving" refusal —
        // there is no one else; the predecessor is dead and this session
        // simply inherited its pid.
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain(
          "took over a drive lease on PR #999 whose pid",
        );

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.generation).not.toBe(oldGeneration);
        expect(after.sessionStarted).toBe(NEWER_SESSION_TOKEN);
      });

      it("a command admitted under the OLD generation is refused by assertLeaseUnchanged once the reused-pid takeover lands", async () => {
        const d = stateDirFor("pid-reuse-fences-old-admission");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("b".repeat(32)));
        // The lease shape a command admitted under the dead predecessor's
        // generation would have been handed — read back rather than
        // hand-built, so it is provably the same record `claimLease` would
        // have returned.
        const admittedUnderOldGeneration = JSON.parse(
          readFileSync(path, "utf8"),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(0);

        let threw: unknown;
        try {
          assertLeaseUnchanged(d, "999", admittedUnderOldGeneration);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      });

      it("a STALE pass carrying an OLDER inherited token must not take back a genuinely newer driver's lease (alternation hazard)", async () => {
        // Without an ordering check, `isRecycledPid` fires symmetrically: a
        // pass detached from a killed driver keeps identifying with that
        // driver's (pid, token) forever, and if the OS later recycles the
        // exact pid to a brand-new driver, EACH side reads the OTHER's lease
        // as "my own recycled pid" — the new driver correctly, the stale pass
        // wrongly — and the two would alternate takeovers instead of the
        // stale pass ever standing down. Seed a dead predecessor's lease, let
        // a new driver legitimately take it over (mirroring the "mints a new
        // generation" probe above), then have a pass carrying the ORIGINAL
        // dead predecessor's token try to mutate next.
        const d = stateDirFor("pid-reuse-stale-pass-cannot-take-back");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("c".repeat(32)));

        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        const takenOverByNewDriver = JSON.parse(readFileSync(path, "utf8"));
        expect(takenOverByNewDriver.sessionStarted).toBe(NEWER_SESSION_TOKEN);

        // The stale pass — same (pid, host) by construction, but the OLDER
        // token the dead predecessor minted — must be refused, not admitted
        // as a second "recycled pid" takeover.
        const r = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        // And the lease is untouched — still the live, newer driver's.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(NEWER_SESSION_TOKEN);
      });

      it("a TOKENLESS caller gets NO fast-path takeover of a FRESH token-bearing lease — no timestamp on its own side means no proof", async () => {
        // One criterion governs this predicate: `isRecycledPid` proves `l`'s
        // writer is dead only via a TEMPORAL argument, and a temporal argument
        // needs BOTH pid claims timestamped. A tokenless
        // (`$DRIVE_PR_SESSION`-only, no `$DRIVE_PR_SESSION_STARTED`) caller
        // carries no timestamp of its own, so — even though `l` here DOES carry
        // one — there is no pair to order, and no proof that `l`'s
        // token-bearing writer is dead rather than a live rival this caller's
        // pid merely coincides with. An identity-based fix is UNSOUND: the
        // argument it relies on ("a tokenless caller can never have written a
        // token-bearing lease, so the disk record must be a dead predecessor")
        // proves only that the two CLAIMS differ, never that the caller's own
        // claim is the newer, live one — `Session.pid` is an inherited value,
        // not proof of the caller's own actual OS pid (the mirror image of the
        // same flaw on the other side).
        //
        // This is not a dead end: see the companion probe below, where the
        // SAME fixture is admitted once it is genuinely stale — recognition
        // is downgraded from instant to staleness-gated, not lost.
        const d = stateDirFor(
          "pid-reuse-tokenless-caller-no-fastpath-fresh-lease",
        );
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("d".repeat(32)));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          // Deliberately no DRIVE_PR_SESSION_STARTED — tier 2, tokenless.
        });
        expect(r.exitCode).toBe(11);

        // Untouched — the fresh token-bearing lease still stands.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(OLDER_SESSION_TOKEN);
      });

      it("...but the SAME tokenless caller IS admitted once that lease is genuinely STALE — the fallback this predicate defers to, not a dead end", async () => {
        // Mirrors the probe immediately above with one field changed:
        // `lastSeen` is past `leaseStaleFloorMs()` rather than fresh. With no
        // token-based fast path available, `claimLease`'s own `!leaseAlive`
        // check is what admits this caller — proving the criterion is a
        // downgrade to the older staleness wait for this combination,
        // not a permanent refusal.
        const d = stateDirFor("pid-reuse-tokenless-caller-admitted-once-stale");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: STALE_LASTSEEN,
            lastSeen: STALE_LASTSEEN,
            command: "hold",
            generation: "i".repeat(32),
            sessionStarted: OLDER_SESSION_TOKEN,
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          // Deliberately no DRIVE_PR_SESSION_STARTED — tier 2, tokenless.
          // Requests the shortest window `leaseStaleMs()` allows — it floors
          // this at `leaseStaleFloorMs()` (5.5min) regardless, which is
          // exactly what `STALE_LASTSEEN` is computed to clear. Omitting this
          // would leave the DEFAULT 360min window active, under which
          // `STALE_LASTSEEN`'s 6 minutes is nowhere near stale.
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(r.exitCode).toBe(0);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("");
      });

      it("a malformed (non-ISO, or ISO-looking but non-round-tripping) CALLER token fails isRecycledPid CLOSED, not open", async () => {
        // `resolveSession` accepts `$DRIVE_PR_SESSION_STARTED` from the
        // environment with no format validation — a broken or
        // hostile harness could set anything. A predicate that authorizes a
        // takeover must not trust an unparseable ordering; it must refuse,
        // the same as it would for a genuinely live rival.
        const d = stateDirFor("pid-reuse-malformed-caller-token-fails-closed");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("e".repeat(32)));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: "not-a-real-timestamp",
        });
        expect(r.exitCode).toBe(11);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(OLDER_SESSION_TOKEN);
      });

      it("a malformed (non-ISO) ON-DISK LEASE token fails isRecycledPid CLOSED, not open", async () => {
        // The mirror of the probe above: the token that fails to parse can be
        // on either side. A tampered or pre-validation lease file with a
        // garbage `sessionStarted` must not be trusted as "provably older"
        // just because SOME ordering comparison happens to return true on it.
        // `'1999-01-01'` is deliberately chosen, not arbitrary garbage: it
        // parses via `Date.parse` (so it WOULD sort before a real ISO instant
        // under a validation-free comparison — exit 0, the wrong answer) but
        // fails the round-trip check `parseStrictIsoInstantMs` requires
        // (`new Date(...).toISOString()` produces
        // `'1999-01-01T00:00:00.000Z'`, not the original string), so this
        // probe actually distinguishes fail-closed from a merely-lucky
        // lexicographic comparison — unlike a value that sorts "after" any
        // real instant regardless of validation.
        const d = stateDirFor("pid-reuse-malformed-lease-token-fails-closed");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            lastSeen: new Date(Date.now() - 60_000).toISOString(),
            command: "hold",
            generation: "f".repeat(32),
            sessionStarted: "1999-01-01",
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("1999-01-01");
      });

      it("a TOKEN-BEARING caller gets NO fast-path takeover of a FRESH tokenless lease either — the mirror direction", async () => {
        // The mirror of the probe far above ("no timestamp on its own side
        // means no proof"): there `l` carried a token and `s` did not, here
        // it is reversed. Under that criterion the two are governed by
        // the IDENTICAL code path — `isRecycledPid` returns `false` whenever
        // EITHER side is empty, with no direction-dependent case split — so
        // this is the same invariant demonstrated from the other side, not a
        // logically distinct scenario.
        //
        // Historically this went through an intermediate "D2 (tokenless)
        // legitimately takes over from a token-bearing dead predecessor, THEN
        // a stale token-bearing pass tries to reclaim D2's fresh lease"
        // narrative — that story no longer applies as written, because the
        // same criterion also closes the FORWARD direction (a tokenless
        // caller's own fast-path takeover of a token-bearing lease, see the
        // probe far above), so there is no longer an instant "D2 takes over"
        // step to build on. The fresh, tokenless lease is constructed
        // directly instead; the invariant under test — a token-bearing
        // caller cannot fast-path a takeover of it — is unchanged.
        const d = stateDirFor(
          "pid-reuse-token-bearing-caller-no-fastpath-fresh-tokenless-lease",
        );
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            lastSeen: new Date(Date.now() - 60_000).toISOString(),
            command: "hold",
            generation: "g".repeat(32),
            sessionStarted: "",
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        // Untouched — the fresh tokenless lease still stands.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("");
      });

      it("a genuine renewal by the SAME session (matching token) still preserves its generation", async () => {
        // Every OTHER "renewal preserves the generation" probe in this file
        // (e.g. "the generation token survives renewal…" above) exercises
        // `isMine`'s TOKENLESS fallback branch — neither call sets
        // `$DRIVE_PR_SESSION_STARTED`, so both sides compare `''`. This is
        // the only one that drives `claimLease` itself (not just the
        // external-mutation fence, which the "session-started token" suite
        // above already covers) through `isMine`'s TOKEN-MATCH branch. A
        // regression there — say, a mutation that always returns `false` once
        // both tokens are non-empty — would make `isMine` misreport this
        // renewal as foreign. Under the FINAL `isRecycledPid` criterion this
        // does NOT also flip `isRecycledPid` true: both sides carry the
        // IDENTICAL token here, so the parsed instants are equal, and the
        // comparison is strict `<` — equal fails it either way. `leaseAlive`
        // still reads true (genuinely alive, fresh `lastSeen`), so the
        // regression is instead caught by `underLocks`'s own "already being
        // driven" `fail(11)` refusal (`leaseAlive(held) && !isRecycledPid(...)`,
        // a few lines above `mintsNewGeneration`) rather than by a generation
        // mismatch. Either mechanism makes this probe correctly redden under
        // that regression.
        const d = stateDirFor("pid-reuse-genuine-renewal");
        const path = leasePathFor(d, "999", ACTOR);

        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        const first = JSON.parse(readFileSync(path, "utf8"));
        expect(first.sessionStarted).toBe(NEWER_SESSION_TOKEN);

        const r = await state(d, ["bump-attempt", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(0);
        const renewed = JSON.parse(readFileSync(path, "utf8"));
        expect(renewed.generation).toBe(first.generation);
      });
    });

    it("clear-lease takes the state mutex, so it cannot land mid-mutation", async () => {
      // The fence and the write it guards are not atomic against a revocation
      // that needs only the LEASE mutex: clearing between the two let the
      // admitted command write anyway, and a successor could then claim the
      // absent lease and write under the same actor — the same corruption, in
      // a narrower window.
      //
      // `clear-lease` therefore takes the state mutex too, so it can only land
      // BETWEEN locked sections. Asserted as ordering: while a mutation holds
      // the lock, the clear must not complete.
      const d = stateDirFor("clear-lease-mutex");
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });

      const signal = join(d, "holding");
      const mutating = state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "3",
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      let clearFinished = false;
      const clearing = state(d, ["clear-lease", "999"]).then((r) => {
        clearFinished = true;
        return r;
      });
      // Still blocked a full second into the holder's 3s stall.
      await new Promise((r) => setTimeout(r, 1000));
      expect(clearFinished).toBe(false);

      // The mutation completes normally — it was never fenced out, because the
      // clear could not reach the lease while it held the mutex.
      expect((await mutating).exitCode).toBe(0);
      expect((await clearing).exitCode).toBe(0);
    });

    it("names a liveness check the HOLDER’s platform can run, not the reader’s", async () => {
      // The refusal promises a check the operator can execute, so the command
      // must match the machine the pid lives on. Inferring it from the local
      // platform handed a Windows holder `ssh <host> ps -p <pid>`, which that
      // host has no `ps` for. The lease records
      // `platform`, and this reads it back.
      const other = `${hostname()}-elsewhere`;
      expect(pidCheckCommand(42, other, "win32")).toBe(
        `ssh ${other} powershell.exe -NoProfile -Command "Get-Process -Id 42"`,
      );
      expect(pidCheckCommand(42, other, "linux")).toBe(`ssh ${other} ps -p 42`);
      // Unknown remote platform is answered honestly rather than guessed — a
      // fabricated command is exactly what this line exists not to produce.
      expect(pidCheckCommand(42, other, undefined)).toBeNull();
      expect(pidCheckCommand(42, other, "")).toBeNull();
      // Locally there is nothing to guess, so no `platform` is needed.
      const localExpected =
        // Windows has no ps, so the local probe there is Get-Process.
        byPlatform("Windows has no ps", {
          windows: 'powershell.exe -NoProfile -Command "Get-Process -Id 42"',
          posix: "ps -p 42",
        });
      expect(pidCheckCommand(42, hostname())).toBe(localExpected);
      expect(pidCheckCommand(42, "")).toBe(localExpected);
    });

    it("acquire honours a caller-supplied cap below the configured timeout", async () => {
      // The primitive behind `clearAllLeases`'s aggregate budget. `reset` holds
      // the PR's state mutex across the whole sweep, and each lease lock's
      // `acquire()` may wait up to the configured timeout — so a sweep that
      // waits per-lock costs N × that, growing with the number of trees that
      // have ever driven the PR. The sweep therefore
      // hands each `acquire()` the time REMAINING in one shared deadline.
      //
      // Tested here rather than end-to-end through `reset`, deliberately: the
      // sweep already aborts on the first lock it cannot take, so a reset over
      // unacquirable locks costs one timeout whether or not a budget exists,
      // and an end-to-end probe cannot tell the two apart. What the aggregate
      // budget actually changes is the case where each acquire SUCCEEDS after a
      // long wait, and the mechanism that bounds it is this cap.
      const d = stateDirFor("acquire-cap");
      const target = join(d, "capped.json");
      // A fresh, non-stale lock nothing will release.
      mkdirSync(`${target}.lock`, { recursive: true });
      writeFileSync(join(`${target}.lock`, "owner.someone-else"), "");

      const prev = {
        t: process.env.DRIVE_PR_LOCK_TIMEOUT,
        s: process.env.DRIVE_PR_LOCK_STALE_MIN,
      };
      process.env.DRIVE_PR_LOCK_TIMEOUT = "30";
      process.env.DRIVE_PR_LOCK_STALE_MIN = "60";
      try {
        const lock = createLock(target, "test", "999");
        const started = Date.now();
        await expect(lock.acquire(1)).rejects.toThrow();
        const elapsed = Date.now() - started;
        // Tight enough to actually guard the contract. A loose bound (the
        // first version allowed 15s against a 30s timeout) would stay green if
        // production turned a 1s cap into 10s — it would only have caught the
        // cap being ignored ENTIRELY. 4s leaves room
        // for spawn and poll granularity on a loaded machine without admitting
        // any plausible wrong multiplier.
        expect(elapsed).toBeLessThan(4_000);
        lock.dispose();
      } finally {
        // Assigning undefined would store the string "undefined".
        for (const [key, value] of [
          ["DRIVE_PR_LOCK_TIMEOUT", prev.t],
          ["DRIVE_PR_LOCK_STALE_MIN", prev.s],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it("fences claim-held --kind finding, which takes the lock directly", async () => {
      // `claimFinding` is the ONE path that calls `store.lock.acquire()` rather
      // than going through `store.locked`, so the fence installed at admission
      // never fired for it — and it is the path where that costs most: a
      // revoked session would validate the held record, return a claim token,
      // and dispatch a NON-idempotent summary answer beside its successor's,
      // leaving a duplicate standing claim on the PR.
      const d = stateDirFor("fence-claim-finding");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "FP",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        S,
        "reason",
      );
      await state(d, ["stamp-held", "999", "--sha", HELD_PUSH], S);

      // Hold the state lock open so the claim is admitted and then queues.
      const signal = join(d, "holding");
      const stalled = state(d, ["bump-round", "999", "--head", "aaa"], {
        ...S,
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "4",
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      const claiming = state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "FP",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        S,
      );
      // Long enough to be past `claimLease` and blocked on the state lock.
      await new Promise((r) => setTimeout(r, 800));
      rmSync(leasePathFor(d, "999", ACTOR), { force: true });

      const r = await claiming;
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("taken over while this command waited");
      // And the lock-free claim file it created moments earlier is cleaned up:
      // leaving it would wedge the key behind a claim no dispatch will follow.
      expect(existsSync(claimPathFor(d, "999", "FP"))).toBe(false);
      await stalled;
    });

    it("refuses a $DRIVE_PR_SESSION pid that is syntactically valid but dead", async () => {
      // `leaseAlive` fails on the pid half however young the lease, so a lease
      // written under a dead pid is takeover-able the instant it exists — it
      // reports an exclusion that excludes nobody. Reached when `drive.ts` is
      // killed and a detached pass outlives it still carrying the dead
      // driver's pid.
      const d = stateDirFor("dead-session-pid");
      const gone = await deadPid();
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(gone),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`pid ${gone}`);
      expect(r.stderr).toContain("not running");
      // Refused BEFORE anything was written — no phantom lease, no state.
      expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(false);
      expect((await state(d, ["get", "999"])).stdout).toContain('"rounds": 0');
    });

    it("reset does the fallible lease sweep BEFORE discarding durable state", async () => {
      // `reset` used to delete the state file, handoff, orphan marker and claim
      // files and only then sweep the leases — so a sweep that threw left
      // everything already gone, a prefix of leases swept, and a non-zero exit
      // indistinguishable from "changed nothing".
      //
      // Modelled with a lease whose lock can never be taken, which makes the
      // sweep throw: the state file must survive, so the retry a caller
      // reaches for is operating on the state they think it is.
      const d = stateDirFor("reset-order");
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);

      // A foreign lease file whose lock is held and not stale.
      const foreign = leasePathFor(d, "999", "wt-00000000000000ff");
      writeFileSync(
        foreign,
        JSON.stringify({
          holder: "session",
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          actor: "wt-00000000000000ff",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      mkdirSync(`${foreign}.lock`, { recursive: true });
      writeFileSync(join(`${foreign}.lock`, "owner.someone-else"), "");

      const r = await state(d, ["reset", "999"], {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_LOCK_TIMEOUT: "1",
        DRIVE_PR_LOCK_STALE_MIN: "60",
      });
      expect(r.exitCode).not.toBe(0);
      // The whole point: durable state is untouched, so the exit really does
      // mean "no change" and a retry is sound.
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);
    });

    it("a sweep that cannot take every lock deletes NO lease, not a prefix", async () => {
      // Ordering the sweep before `reset`'s state deletions made the state half
      // of "a non-zero exit means no change" true and left the LEASE half
      // false: the loop deleted each stale lease as it went, so a lock failure
      // partway through had already removed the earlier ones.
      //
      // Two sweepable leases either side of one whose lock cannot be taken —
      // the middle file's lock proves acquisition reaches it, and the last
      // proves the failure is not simply "we never got that far".
      const d = stateDirFor("sweep-all-or-nothing");
      const files: string[] = [];
      for (let i = 0; i < 3; i++) {
        const actor = `wt-${String(i).padStart(16, "0")}`;
        const f = leasePathFor(d, "999", actor);
        writeFileSync(
          f,
          JSON.stringify({
            holder: "session",
            pid: 999_999,
            host: "nowhere",
            platform: "linux",
            actor,
            worktree: "/tmp/probe-tree",
            startedAt: "2020-01-01T00:00:00.000Z",
            lastSeen: "2020-01-01T00:00:00.000Z",
            command: "hold",
            generation: String(i).padStart(32, "0"),
            sessionStarted: "",
          }),
        );
        files.push(f);
      }
      // Wedge exactly one lock. `leaseFilesFor` sorts by readdir order, so
      // wedging the MIDDLE one leaves sweepable files on both sides of it.
      const wedged = `${files[1]}.lock`;
      mkdirSync(wedged, { recursive: true });
      writeFileSync(join(wedged, "owner.someone-else"), "");

      const prev = {
        t: process.env.DRIVE_PR_LOCK_TIMEOUT,
        s: process.env.DRIVE_PR_LOCK_STALE_MIN,
      };
      process.env.DRIVE_PR_LOCK_TIMEOUT = "1";
      process.env.DRIVE_PR_LOCK_STALE_MIN = "60";
      try {
        await expect(clearAllLeases(d, "999", null)).rejects.toThrow();
        // Every lease still present — the sweep is all-or-nothing.
        for (const f of files) expect(existsSync(f)).toBe(true);
      } finally {
        // Assigning undefined would store the string "undefined".
        for (const [key, value] of [
          ["DRIVE_PR_LOCK_TIMEOUT", prev.t],
          ["DRIVE_PR_LOCK_STALE_MIN", prev.s],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
