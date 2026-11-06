/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync } from "node:fs";

import { hostname } from "node:os";

import { join } from "node:path";

import { ExitError } from "../scripts/lib/cli";

import {
  assertTreeMutationAllowed,
  leaseRef,
  type Session,
  stateDirIdentityToken,
  treeLeaseRef,
} from "../scripts/lib/state/lease";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { putTreeLease, readLease, readTreeLease } from "./state-rows.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state, twoDrivers, drive, liveSession, awaitPidGone } =
    stateDurabilityFixtures;
  describe("the tree-wide session lease across PRs", () => {
    /** A live sessionless resolver's tree lease, for `pr`. */
    function putSessionlessTreeLease(d: string, pr: string): void {
      putTreeLease(treeLeaseRef(d, ACTOR), {
        holder: "worktree",
        pid: 0,
        host: hostname(),
        worktree: "/this/tree",
        command: "bump-round",
        pr,
      });
    }

    describe("`treeIsMine` — the tree lease is not session-exclusive", () => {
      // `isMine`'s `holder === 'worktree'` branch answers pure actor
      // equality, correct for the PER-PR presence record (already scoped to
      // (tree, pr) by its own key) but wrong for a `holder: 'worktree'`
      // record in the TREE lease, which a sessionless resolver also writes:
      // every caller in this tree, whichever pr it names, would read it as
      // "mine". These probes pin both directions.

      it("an identified session claiming a DIFFERENT pr refuses on a live sessionless tree claim, rather than silently overwriting it", async () => {
        const d = stateDirFor("lease-tree-treeismine-cross-pr");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const holder = liveSession();
        try {
          const refused = await state(
            d,
            ["bump-round", "888", "--head", "bbb"],
            { DRIVE_PR_SESSION: String(holder.pid) },
          );
          expect(refused.exitCode).toBe(11);
          expect(refused.stderr).toContain("sessionless resolver");
          expect(refused.stderr).toContain("PR #999");
          expect(readLease(leaseRef(d, "888", ACTOR))).toBeNull();
          // The tree record is still the sessionless resolver's own — an
          // identified session must never silently overwrite it.
          const tree = readTreeLease(treeLeaseRef(d, ACTOR));
          expect({ holder: tree?.holder, pr: tree?.pr }).toEqual({
            holder: "worktree",
            pr: "999",
          });
        } finally {
          holder.stop();
        }
      });

      it("an identified session claiming the SAME pr upgrades a live sessionless tree claim smoothly, no refusal", async () => {
        // The deliberate, intentional counterpart of the probe above — a
        // matching pr is a legitimate resolver-lifetime handoff, mirroring
        // the per-PR rule that an identified session may take over its own
        // tree's presence record freely.
        const d = stateDirFor("lease-tree-treeismine-same-pr-upgrade");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const holder = liveSession();
        try {
          const upgraded = await state(
            d,
            ["bump-round", "999", "--head", "bbb"],
            { DRIVE_PR_SESSION: String(holder.pid) },
          );
          expect(upgraded.exitCode).toBe(0);
          const tree = readTreeLease(treeLeaseRef(d, ACTOR));
          expect({
            holder: tree?.holder,
            pid: tree?.pid,
            pr: tree?.pr,
          }).toEqual({
            holder: "session",
            pid: holder.pid,
            pr: "999",
          });
        } finally {
          holder.stop();
        }
      });

      it("the irreversible-post fence (assertTreeMutationAllowed) refuses a post under a live sessionless tree claim on a DIFFERENT pr", async () => {
        const d = stateDirFor("tree-post-fence");
        putSessionlessTreeLease(d, "999");
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        // `fail()` throws an `ExitError` whose MESSAGE is just `exit ${code}`
        // — the descriptive text goes to `console.error` (stderr), not the
        // exception — so the outcome to assert on is the code, mirroring
        // every other in-process fence probe in this suite.
        let threw: unknown;
        try {
          await assertTreeMutationAllowed(
            {
              stateDir: d,
              actor: ACTOR,
              session,
              instance: stateDirIdentityToken(d),
            },
            "888",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      });

      it("the irreversible-post fence (assertTreeMutationAllowed) allows a post under a live sessionless tree claim on the SAME pr", async () => {
        const d = stateDirFor("tree-post-fence-same");
        putSessionlessTreeLease(d, "999");
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        const lock = await assertTreeMutationAllowed(
          {
            stateDir: d,
            actor: ACTOR,
            session,
            instance: stateDirIdentityToken(d),
          },
          "999",
          "test",
        );
        lock.release();
        lock.dispose();
      });
    });

    it("clear-lease also drops the TREE lease, so the refusal's own remedy actually works", async () => {
      const d = stateDirFor("lease-tree-clear-drops-tree");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);

        // A live session, a DIFFERENT PR — refused, per the primary probe
        // above.
        const refused = await state(d, ["bump-round", "888", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(refused.exitCode).toBe(11);

        // The refusal names the REFUSED command's own PR (888) as the
        // remedy — `clear-lease ${pr}` uses `claimTreeLease`'s own `pr`
        // parameter, which is the PR this command asked for, not the one the
        // holder is on. Followed exactly as printed: running it must
        // actually free the tree, not just the (never-written) PR-888
        // per-PR record, or the documented remedy is a dead end.
        expect(refused.stderr).toContain("clear-lease 888");
        expect(
          (
            await state(d, ["clear-lease", "888"], {
              DRIVE_PR_SESSION: String(process.pid),
            })
          ).exitCode,
        ).toBe(0);

        expect(
          (
            await state(d, ["bump-round", "888", "--head", "bbb"], {
              DRIVE_PR_SESSION: String(process.pid),
            })
          ).exitCode,
        ).toBe(0);
      } finally {
        a.stop();
      }
    });

    it("self-recovers from a session that is GONE, whichever PR it was on", async () => {
      const d = stateDirFor("lease-tree-dead");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });
      a.stop();
      await awaitPidGone(a.pid);

      // A DIFFERENT PR than the one the dead session was on.
      const next = await state(d, ["bump-round", "888", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(next.exitCode).toBe(0);
      expect(next.stderr).toContain("took over an abandoned TREE lease");
    });

    it("assertTreeLeaseUnchanged fences the documented residual — a takeover for a DIFFERENT pr races an in-flight command", async () => {
      // `claimTreeLease`'s own takeover only coordinates with the state mutex
      // of the PR IT is claiming — a deliberate, documented boundary (see its
      // comment): a takeover for pr 888 does not wait out a command already
      // mid-mutation on pr 999. That leaves a window only the admission
      // fence can close: the pr-999 command was admitted BEFORE the pr-888
      // takeover happened, so it must be refused on its way out rather than
      // let to write beside a tree the takeover has already reassigned.
      const d = stateDirFor("lease-tree-fence-residual");
      const a = liveSession();
      let running: ReturnType<typeof state> | undefined;
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });

        // Session `a`'s SECOND pr-999 command stalls inside its locked
        // section, holding pr 999's state mutex.
        const signal = join(d, "fence-residual-is-holding");
        running = state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(a.pid),
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "3",
        });
        const deadline = Date.now() + 8000;
        while (!existsSync(signal)) {
          if (Date.now() > deadline) throw new Error("never signalled");
          await new Promise((r) => setTimeout(r, 10));
        }

        // `a` dies while `running` is still mid-mutation on pr 999…
        a.stop();
        await awaitPidGone(a.pid);

        // …and a REPLACEMENT session takes the tree over for a DIFFERENT pr
        // (888). Nothing orders this against `running`'s pr-999 mutex, so it
        // completes immediately rather than queuing behind it.
        const taker = await state(d, ["bump-round", "888", "--head", "ccc"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(taker.exitCode).toBe(0);
        expect(taker.stderr).toContain("took over an abandoned TREE lease");

        // `running` now finishes its stall and reaches the fence — the tree
        // lease it was admitted under is gone, taken by `taker`, so it must
        // be refused rather than write PR 999's state beside a tree that no
        // longer believes `a` is driving it.
        const r = await running;
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain(
          "TREE lease (admitted for PR #999) was taken over while this command waited",
        );
      } finally {
        a.stop();
        // If an assertion above threw, `running`'s stalled child still holds
        // PR 999's state lock — leaving the promise unobserved surfaces its
        // eventual settlement as a second, misleading unhandled-rejection
        // failure rather than just the original assertion.
        await running?.catch(() => {});
      }
    });

    it("rolls back a freshly-created tree lease when the per-PR claim fails afterward", async () => {
      // `claimTreeLease` writes BEFORE `claimPrLease`'s own checks run — so a
      // failure there (a PR-wide refusal from ANOTHER tree, in this probe)
      // must not leave the tree lease it just minted behind, wedging
      // this tree for any OTHER identified session on a PR that was never
      // actually admitted.
      const { a, b, env } = twoDrivers("lease-tree-rollback");
      const sessionA = liveSession();
      const sessionB = liveSession();
      const sessionC = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(sessionB.pid) };
        const ec = { ...env, DRIVE_PR_SESSION: String(sessionC.pid) };

        // Tree A takes PR 999 first.
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // Tree B, session B: `claimTreeLease` succeeds — tree B has never
        // held any lease — but `claimPrLease` then hits the cross-tree gate on
        // PR 999 (tree A already holds it) and refuses.
        expect(
          drive(b, eb, ["bump-round", "999", "--head", "bbb"]).exitCode,
        ).toBe(13);

        // A DIFFERENT session in tree B, a DIFFERENT PR. Session B's own tree
        // lease would trivially self-renew (`isMine`), so it cannot detect a
        // leftover lease — session C can: if session B's failed claim had
        // left its tree lease behind, THIS would be refused (exit 11) by a
        // lease pointing at a PR that was never actually admitted.
        expect(
          drive(b, ec, ["bump-round", "888", "--head", "ccc"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
        sessionB.stop();
        sessionC.stop();
      }
    });

    it("a sibling's failed claim does not destroy this session's own successful admission", async () => {
      // Two commands from the SAME session share `(pid, host, generation)`
      // whenever a renewal preserves the generation, DELIBERATELY, since that
      // is what lets one session juggle several PRs without refusing itself.
      // A rollback keyed on that identity alone could restore a stale
      // snapshot over — or delete — a successful FIRST claim by the exact
      // same session. So the rollback is a compare-and-swap on the revision
      // token every tree-lease write mints, with the "before" snapshot taken
      // under the SAME lock as the write: a later claim's rollback can only
      // ever undo what THAT claim itself wrote.
      const { a, b, env } = twoDrivers("lease-tree-sibling-clobber");
      const sessionShared = liveSession();
      const sessionOther = liveSession();
      try {
        const eShared = { ...env, DRIVE_PR_SESSION: String(sessionShared.pid) };
        const eOther = { ...env, DRIVE_PR_SESSION: String(sessionOther.pid) };

        // Tree B, a DIFFERENT session, holds PR 777 first.
        expect(
          drive(b, eOther, ["bump-round", "777", "--head", "xxx"]).exitCode,
        ).toBe(0);

        // Tree A, sessionShared: successfully admits PR 999 — the successful
        // sibling write whose survival this probe checks.
        expect(
          drive(a, eShared, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // Tree A, sessionShared AGAIN, a DIFFERENT PR: `claimTreeLease`
        // succeeds (a renewal — same session), but `claimPrLease` then hits
        // the cross-tree gate (tree B already holds 777) and fails.
        // Its rollback must not destroy the tree lease that still
        // legitimately admits this session for PR 999.
        expect(
          drive(a, eShared, ["bump-round", "777", "--head", "yyy"]).exitCode,
        ).toBe(13);

        // A THIRD, different session in tree A: still refused — proof the
        // tree lease SURVIVED sessionShared's failed second claim, rather
        // than being deleted or rewound to a stale pre-PR-999 snapshot.
        const sessionThird = liveSession();
        try {
          const eThird = { ...env, DRIVE_PR_SESSION: String(sessionThird.pid) };
          expect(
            drive(a, eThird, ["bump-round", "999", "--head", "zzz"]).exitCode,
          ).toBe(11);
        } finally {
          sessionThird.stop();
        }
      } finally {
        sessionShared.stop();
        sessionOther.stop();
      }
    });

    it("clear-lease reports the TREE lease it drops, not just the per-PR one", async () => {
      // The common real-world shape of this call: an operator follows a
      // cross-PR refusal's own `clear-lease <requested-pr>` suggestion,
      // where there is normally NO per-PR lease for that pr at all. A report
      // of only that (empty) half would leave the live tree lease it
      // overrode unreported.
      const d = stateDirFor("lease-tree-clear-reports-both");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);

        // No per-PR lease exists for 888 — clear-lease must still report the
        // TREE lease it drops, and NOT the "nothing to clear" message
        // (something genuinely was).
        const cleared = await state(d, ["clear-lease", "888"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(cleared.exitCode).toBe(0);
        expect(cleared.stderr).not.toContain("nothing to clear");
        expect(cleared.stderr).toContain(
          `cleared this working tree's TREE lease`,
        );
        expect(cleared.stderr).toContain(`pid ${a.pid}`);
        expect(cleared.stderr).toContain("was on PR #999");
      } finally {
        a.stop();
      }
    });

    it("clear-lease reports genuinely nothing when neither lease exists", async () => {
      const d = stateDirFor("lease-tree-clear-nothing");
      const cleared = await state(d, ["clear-lease", "999"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(cleared.exitCode).toBe(0);
      expect(cleared.stderr).toContain(
        "no drive lease on PR #999 from this working tree — nothing to clear",
      );
    });
  });
});
