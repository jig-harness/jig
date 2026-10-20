/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join } from "node:path";

import { ExitError } from "../scripts/lib/cli";

import {
  assertTreeMutationAllowed,
  leasePathFor,
  type Session,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";

import { defaultStateDirFor } from "../scripts/lib/state/store";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state, twoDrivers, drive, liveSession, awaitPidGone } =
    stateDurabilityFixtures;
  describe("the tree-wide session lease across PRs", () => {
    describe("`treeIsMine` — the tree-wide file is no longer session-exclusive", () => {
      // `isMine`'s `holder === 'worktree'` branch answers pure actor
      // equality, correct for the PER-PR presence record (already scoped to
      // (tree, pr) by its own filename) but silently wrong once a sessionless
      // resolver can ALSO write a `holder: 'worktree'` record to the
      // TREE-WIDE file: every caller in this tree, whichever pr it names,
      // would read it as "mine". Caught in review before shipping — these
      // probes reproduce both directions the hole opened.

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
          expect(existsSync(leasePathFor(d, "888", ACTOR))).toBe(false);
          // The tree record is still the sessionless resolver's own — an
          // identified session must never silently overwrite it.
          const tree = JSON.parse(
            readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
          );
          expect({ holder: tree.holder, pr: tree.pr }).toEqual({
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
          const tree = JSON.parse(
            readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
          );
          expect({ holder: tree.holder, pid: tree.pid, pr: tree.pr }).toEqual({
            holder: "session",
            pid: holder.pid,
            pr: "999",
          });
        } finally {
          holder.stop();
        }
      });

      it("the irreversible-post fence (assertTreeMutationAllowed) refuses a post under a live sessionless tree claim on a DIFFERENT pr", async () => {
        const d = mkdtempSync(join(tmpdir(), "drive-pr-tree-post-fence-"));
        const path = treeLeasePathFor(d, ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/this/tree",
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
        // `fail()` throws an `ExitError` whose MESSAGE is just `exit ${code}`
        // — the descriptive text goes to `console.error` (stderr), not the
        // exception — so the outcome to assert on is the code, mirroring
        // every other in-process fence probe in this file (e.g.
        // `assertLeaseUnchanged`'s own "alternation hazard" probe above).
        let threw: unknown;
        try {
          await assertTreeMutationAllowed(
            {
              stateDir: d,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: d,
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
        const d = mkdtempSync(join(tmpdir(), "drive-pr-tree-post-fence-same-"));
        const path = treeLeasePathFor(d, ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/this/tree",
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
        const lock = await assertTreeMutationAllowed(
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
        lock.release();
        lock.dispose();
      });

      it("re-resolves the legacy-fallback directory LIVE before acquiring, catching a tree lease written after the snapshot decision", async () => {
        // The tree-fence counterpart of the TOCTOU fix and the matching
        // lock-ordering fix for `assertRemoteMutationAllowed`: a
        // stale `ctx.stateDir` (as `resolveFenceContext` would have snapshot-
        // decided from a genuinely empty legacy directory) must not make
        // this fence lock and check the WRONG directory once a concurrent
        // admission has since written into the relocated one.
        const legacyDir = mkdtempSync(
          join(tmpdir(), "drive-pr-tree-legacy-fallback-race-"),
        );
        const newDir = defaultStateDirFor(legacyDir);
        try {
          mkdirSync(newDir, { recursive: true });
          // A live tree lease for a DIFFERENT pr, in the RELOCATED
          // directory — exactly what a concurrent `drive.ts` admitted after
          // the snapshot would have written.
          writeFileSync(
            treeLeasePathFor(newDir, ACTOR),
            JSON.stringify({
              holder: "worktree",
              pid: 0,
              host: hostname(),
              platform: process.platform,
              actor: ACTOR,
              worktree: "/this/tree",
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
            await assertTreeMutationAllowed(
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
              "888",
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

    it("refuses to treat an unreadable-but-fresh TREE lease as absent", async () => {
      // A file that EXISTS but cannot be parsed is evidence some session
      // wrote it — treating that as absent would mint a new generation over
      // a possibly-still-live foreign session on the strength of a record
      // nobody could actually read, the exact gap `unreadableLeaseFilesFor`
      // already closes for the PR-wide gate.
      const d = stateDirFor("lease-tree-unreadable");
      writeFileSync(treeLeasePathFor(d, ACTOR), "not valid json{{{");
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      // 11, not a generic 1 — the same exit this same check's own
      // confirmed-live-foreign-session case uses.
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("could not be read as one");
      // Nothing was written over it.
      expect(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).toBe(
        "not valid json{{{",
      );
    });

    it("the SESSIONLESS tier also refuses to treat an unreadable-but-fresh TREE lease as absent", async () => {
      // The identified claim path closes this
      // (`claimTreeLease`'s own writer); the sessionless preflight and fence
      // read the SAME file through plain `readTreeLease`, which collapses
      // "absent" and "unreadable" to the identical `null` — so a sessionless
      // command was still admitted past a record a live session might still
      // own, on the strength of a file nobody could actually parse.
      const d = stateDirFor("lease-tree-unreadable-sessionless");
      writeFileSync(treeLeasePathFor(d, ACTOR), "not valid json{{{");
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: "",
        CLAUDE_PID: "",
      });
      // 11, matching the identified path's own fix above.
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("could not be read as one");
      expect(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).toBe(
        "not valid json{{{",
      );
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
        // left its tree lease on disk, THIS would be refused (exit 11) by a
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
      // A rollback comparing identity `(pid, host, generation)` alone
      // — which two commands from the SAME session share identically
      // whenever a renewal preserves the generation, DELIBERATELY, since
      // that is what lets one session juggle several PRs without refusing
      // itself. So a failed SECOND claim's rollback could restore a stale
      // snapshot over — or delete — a successful FIRST claim by the exact
      // same session. The fix is a raw-string compare-and-swap, with the
      // "before" snapshot captured under the SAME lock as the write, so a
      // later claim's rollback can only ever undo what THAT claim itself
      // wrote.
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
      // where there is normally NO per-PR lease for that pr at all — round
      // 1's `Lease | null` return reported only that (empty) half, so the
      // live tree lease it silently overrode went unreported.
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
