/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  clearAllLeases,
  leaseFilesFor,
  leasePathFor,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateSessionLeaseFixtures } from "./drive-pr-state-session-lease-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state, liveSession, awaitPidGone } =
    stateDurabilityFixtures;
  describe("the session lease over one working tree", () => {
    const stateSessionLeaseFixtures = createStateSessionLeaseFixtures(
      stateDurabilityFixtures,
    );
    const { A_URL, B_URL, holdAs, backdateSessionLeases, stalledMutation } =
      stateSessionLeaseFixtures;

    it("refuses a second live session in the same tree — and the first session’s hold survives intact", async () => {
      const d = stateDirFor("lease-collision");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);
        expect((await holdAs(d, a.pid, A_URL)).exitCode).toBe(0);

        // Session B — a forked/background agent in the SAME tree, so it derives
        // the SAME actor and its `hold` would upsert straight over A's record.
        const second = await holdAs(d, process.pid, B_URL);
        expect(second.exitCode).toBe(11);

        // The damage the refusal prevents, asserted directly rather than
        // inferred from the exit code: A's record is untouched, so A's reply is
        // still the one its hold represents. Without the lease this reads B_URL
        // and A's promise is gone with no error anywhere.
        expect(
          JSON.parse((await state(d, ["held", "999"])).stdout),
        ).toMatchObject([{ key: "PRRT_x", commentUrl: A_URL }]);
      } finally {
        a.stop();
      }
    });

    it("names the live holder and how to verify it", async () => {
      const d = stateDirFor("lease-diagnostic");
      const a = liveSession();
      try {
        await state(
          d,
          ["park", "999", "--key", "k", "--kind", "thread", "--reason", "r"],
          {
            DRIVE_PR_SESSION: String(a.pid),
          },
        );
        const refused = await state(d, ["phase", "999", "--set", "triage"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(refused.exitCode).toBe(11);
        // A refusal that cannot be checked is a refusal a human has to guess
        // about, so the pid, the liveness probe and the way out are all part of
        // the contract — not decoration.
        expect(refused.stderr).toContain(`pid ${a.pid}`);
        expect(refused.stderr).toContain(
          // Windows has no ps; the refusal names its own process probe there.
          byPlatform("Windows has no ps", {
            windows: `powershell.exe -NoProfile -Command "Get-Process -Id ${a.pid}"`,
            posix: `ps -p ${a.pid}`,
          }),
        );
        expect(refused.stderr).toContain("clear-lease 999");
      } finally {
        a.stop();
      }
    });

    it("self-recovers from a session that is GONE — a crashed driver never wedges the PR", async () => {
      // The lease is taken by a session that is ALIVE and only then dies. That
      // is both the real crash sequence and the only way to reach this state
      // now: admission refuses an already-dead `$DRIVE_PR_SESSION` outright
      // (see the sibling test), so seeding with a dead pid would no longer
      // produce a lease to recover from at all.
      const d = stateDirFor("lease-dead");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });
      a.stop();
      // Wait for the pid to actually stop answering, or this races the takeover
      // it is setting up.
      await awaitPidGone(a.pid);

      const next = await state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(next.exitCode).toBe(0);
      expect(next.stderr).toContain("took over an abandoned drive lease");
      expect(next.stdout).toBe("2");
    });

    it("expires a lease whose pid still answers but which stopped driving", async () => {
      // The recycled-pid hazard: after a session dies the OS hands its number
      // to an unrelated long-lived process, and a liveness check alone would
      // then refuse every later session forever. A real session renews on every
      // mutating command; a recycled pid never does.
      const d = stateDirFor("lease-recycled");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        // Backdated past the staleness FLOOR (330s — see `leaseStaleFloorMs`),
        // not merely past the 1-minute env value: the window can no longer be
        // configured below the longest a command can sit admitted-but-waiting,
        // so a 5-minute-old lease is deliberately still live here.
        backdateSessionLeases(d, "999", 10 * 60_000);
        // …and the TREE lease is then dropped entirely: since
        // `claimTreeLease` runs BEFORE the per-PR claim, a tree lease that is
        // ALSO still alive would refuse first, on its own account, and the
        // check below would prove nothing about the PER-PR staleness logic
        // this test is actually about — it would just be re-proving the tree
        // layer's refusal, which has its own dedicated coverage. Removing it
        // isolates: `claimTreeLease` sees no tree lease at all here, so it
        // CREATES one silently (no refusal), and whatever happens next is
        // decided by `claimPrLease` alone.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });

        // Still refused inside the window, even though it has gone quiet…
        const stillRefused = await state(
          d,
          ["bump-round", "999", "--head", "bbb"],
          {
            DRIVE_PR_SESSION: String(process.pid),
            DRIVE_PR_LEASE_STALE_MIN: "60",
          },
        );
        expect(stillRefused.exitCode).toBe(11);
        // Per-PR-specific wording — proves THIS layer refused, not merely
        // that SOME layer did.
        expect(stillRefused.stderr).toContain(
          "PR #999 is already being driven from this working tree",
        );
        // …and recoverable once it has been quiet longer than the window.
        const took = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(took.exitCode).toBe(0);
        expect(took.stderr).toContain("took over an abandoned drive lease");
      } finally {
        a.stop();
      }
    });

    it("floors the staleness window above the longest admitted-but-waiting wait", async () => {
      // `clearAllLeases` preserves a live foreign lease so that a second
      // session in that tree cannot claim an absent one and mutate beside a
      // command that is already ADMITTED — past `claimLease`, waiting on the
      // state mutex `reset` holds. That preservation is decided by
      // wall-clock liveness, so a staleness window shorter than the wait itself
      // would let `reset` sweep the lease of a command that has not run yet,
      // reopening the same-actor concurrency this module exists to close.
      //
      // The window is therefore floored at `LOCK_ACQUIRE_MAX_SEC` + the renewal
      // cap (330s): a lease is at most 30s old on admission and the wait is
      // capped at 300s, so it cannot expire mid-flight however small the env
      // var asks the window to be.
      const d = stateDirFor("lease-stale-floor");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        // Inside the 330s floor, but far outside the 1-minute window the env
        // var asks for — the floor is the only thing keeping this lease live.
        backdateSessionLeases(d, "999", 300_000);
        // The TREE lease is then dropped, isolating the per-PR floor this
        // probe names — see the identical step in `expires a lease whose pid
        // still answers…` for why: `claimTreeLease` runs first and, left in
        // place, would refuse (or not) on its OWN floor before ever reaching
        // the per-PR one this test is about.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });

        const refused = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(refused.exitCode).toBe(11);
        expect(refused.stderr).toContain(`pid ${a.pid}`);
        expect(refused.stderr).toContain(
          "PR #999 is already being driven from this working tree",
        );
      } finally {
        a.stop();
      }
    });

    it("fences a command admitted before its lease disappeared", async () => {
      // The fence's "lease is gone" branch, which is what stands between an
      // admitted command and a revocation that did NOT go through the state
      // mutex.
      //
      // Note what this deliberately no longer models: an operator's
      // `clear-lease` racing INTO a locked section. That is unreachable now —
      // `clear-lease` takes the state mutex itself, so it can only land between
      // locked sections, which the sibling `clear-lease takes the state mutex`
      // test pins from the other side. Removing the file directly is the
      // general case that mutex ordering cannot reach: a crash-leftover
      // cleanup, an out-of-band sweep, anything that deletes a lease without
      // holding the state lock. The fence is the last line for all of them.
      const d = stateDirFor("fence-lease-gone");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        const before = await state(d, ["get", "999"]);

        const running = await stalledMutation(d, a.pid, "gone", () => {
          rmSync(leasePathFor(d, "999", ACTOR), { force: true });
        });

        const r = await running;
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain("taken over while this command waited");
        expect(r.stderr).toContain("is gone");
        // Fails CLOSED: the mutation must not have landed.
        expect((await state(d, ["get", "999"])).stdout).toBe(before.stdout);
      } finally {
        a.stop();
      }
    });

    it("a dead-pid takeover cannot land while a command holds the state mutex", async () => {
      // This used to be a FENCE test — the takeover raced into the stalled
      // command's window and the fence caught it on the way out. It is now an
      // ORDERING test, because the race is gone: a takeover is a revocation,
      // and every revocation coordinates with the state mutex, so it can only
      // land BETWEEN locked sections. The window the fence was catching no
      // longer opens, which is strictly better than catching it afterwards —
      // the admitted command completes instead of being refused.
      //
      // The fence still has its own coverage: `fences a command admitted before
      // its lease disappeared` exercises the branch for revocations that do not
      // go through the state mutex at all.
      const d = stateDirFor("deadpid-ordering");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });

      // Asserted as completion ORDER rather than as elapsed time. The
      // guarantee is "the takeover cannot land while the mutex is held", and a
      // wall-clock probe on that is fragile — how long the killed session takes
      // to stop answering is not ours to control. Order is exact: with the
      // coordination the taker can only finish after the holder releases;
      // without it the taker needs no state lock at all and finishes FIRST.
      const done: string[] = [];
      const signal = join(d, "deadpid-is-holding");
      const running = state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(a.pid),
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "3",
      }).then((r) => {
        done.push("holder");
        return r;
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      // The owning session dies while its child holds the state mutex…
      a.stop();
      // Until the pid actually stops answering, the replacement sees a LIVE
      // foreign lease and refuses outright — a different outcome entirely,
      // which would make this test measure nothing.
      await awaitPidGone(a.pid);

      // …and a replacement tries to take the now-dead lease over.
      const taker = state(d, ["bump-round", "999", "--head", "ccc"], {
        DRIVE_PR_SESSION: String(process.pid),
      }).then((r) => {
        done.push("taker");
        return r;
      });

      const [r, t] = await Promise.all([running, taker]);
      expect(done).toEqual(["holder", "taker"]);
      // The admitted command is NOT refused — its lease was never revoked out
      // from under it, which is the whole point of ordering over fencing.
      expect(r.exitCode).toBe(0);
      // And the replacement then takes over legitimately, once the mutex frees.
      expect(t.exitCode).toBe(0);
      expect(t.stderr).toContain("took over an abandoned drive lease");
    });

    it("sweeping many leases leaves no process listeners behind", async () => {
      // `clearAllLeases` makes one lock per lease FILE, and every `createLock`
      // registers exit/SIGINT/SIGTERM handlers. Nothing removed them, so a PR
      // driven from more than ten trees pushed Node past its default
      // `maxListeners` and printed a leak warning on stderr — the same stream
      // `reset`'s preserved-lease report uses, so it landed in the middle of
      // the diagnostic an operator has to read (the threshold is 11 locks, not
      // 4 — the three handlers are on three
      // DIFFERENT events, so each lock adds one per event).
      //
      // Asserted as listener COUNT rather than as the warning text: the suite
      // runs under Bun, which does not emit the warning at all, so a probe on
      // the message would pass here while the leak stayed live on the Node
      // path the scripts also advertise.
      const d = stateDirFor("lease-listener-leak");
      for (let i = 0; i < 14; i++) {
        const actor = `wt-${String(i).padStart(16, "0")}`;
        writeFileSync(
          leasePathFor(d, "999", actor),
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
      }
      // All THREE events `createLock` registers, not just `exit`: the claim
      // is that disposal detaches everything it added, and a probe on one
      // event stays green while a regression leaks the other two.
      const events = ["exit", "SIGINT", "SIGTERM"] as const;
      const before = events.map((e) => process.listenerCount(e));
      await clearAllLeases(d, "999", null);
      expect(leaseFilesFor(d, "999")).toEqual([]);
      expect(events.map((e) => process.listenerCount(e))).toEqual(before);
    });

    it("the generation token survives renewal but not a same-tuple recreate", async () => {
      // The fence compares a random `generation`, not `startedAt`. An ISO
      // timestamp resolves to the millisecond, so a `clear-lease` plus a
      // same-session reclaim inside one millisecond can reproduce the exact
      // `(pid, host, startedAt)` tuple and would be waved through as "my lease,
      // renewed". Asserted structurally rather than
      // by racing a millisecond: a renewal must PRESERVE the token, and a
      // clear-then-reclaim must MINT a new one even when every other field is
      // identical.
      const d = stateDirFor("lease-generation");
      const path = leasePathFor(d, "999", ACTOR);

      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const first = JSON.parse(readFileSync(path, "utf8"));
      // Pinned as a RANDOM nonce, not merely "some string that changes".
      // "Changes after a clear" is satisfied by a timestamp too, as long as the
      // test does not happen to race a millisecond — so a value-inequality
      // assertion alone would stay green against exactly the clock-derived
      // identity this finding was about. The representation is the claim.
      expect(first.generation).toMatch(/^[0-9a-f]{32}$/);
      expect(first.generation).not.toBe(first.startedAt);
      expect(first.generation).not.toBe(first.lastSeen);

      // A renewal by the SAME session keeps it — sibling commands admitted
      // under it must stay admitted.
      await state(d, ["bump-attempt", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const renewed = JSON.parse(readFileSync(path, "utf8"));
      expect(renewed.generation).toBe(first.generation);

      // Cleared and reclaimed by the same session: same pid, same host, and
      // `startedAt` is the only thing distinguishing it — which a fast enough
      // clock cannot. The token must differ regardless.
      expect((await state(d, ["clear-lease", "999"])).exitCode).toBe(0);
      await state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const reclaimed = JSON.parse(readFileSync(path, "utf8"));
      expect(reclaimed.pid).toBe(first.pid);
      expect(reclaimed.host).toBe(first.host);
      expect(reclaimed.generation).not.toBe(first.generation);
    });
  });
});
