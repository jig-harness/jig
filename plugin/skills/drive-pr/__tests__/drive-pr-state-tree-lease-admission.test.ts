/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  leasePathFor,
  readTreeLease,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  ACTOR,
  gitCleanEnv,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const {
    stateDirFor,
    state,
    twoDrivers,
    drive,
    liveSession,
    awaitLockedSection,
  } = stateDurabilityFixtures;
  describe("the tree-wide session lease across PRs", () => {
    // The per-PR lease is scoped to (working tree, PR): two interactive
    // sessions in ONE tree driving TWO DIFFERENT PRs resolve two different
    // `leasePathFor` files, so on their own neither refuses the other and both
    // would be admitted into the SAME checkout — free to edit, commit, and
    // push over one another. `drive.ts` closes the analogous unattended-path
    // gap with a worktree-wide single-instance lock; the tree-wide session
    // lease is the interactive counterpart.

    it("refuses a second live session in the same tree driving a DIFFERENT PR", async () => {
      const d = stateDirFor("lease-tree-cross-pr");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);

        // Session B — a DIFFERENT PR, so its per-PR lease file never collides
        // with A's, but it shares the SAME working tree, which is exactly what
        // the tree-wide lease refuses.
        const second = await state(d, ["bump-round", "888", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(second.exitCode).toBe(11);
        expect(second.stderr).toContain(`pid ${a.pid}`);
        expect(second.stderr).toContain("PR #999");
        expect(second.stderr).toContain("clear-lease 888");

        // B never wrote a per-PR lease of its own — the refusal came before
        // that, exactly like the per-PR case.
        expect(existsSync(leasePathFor(d, "888", ACTOR))).toBe(false);
      } finally {
        a.stop();
      }
    });

    it("one session driving TWO PRs from one tree is not refused by itself", async () => {
      const d = stateDirFor("lease-tree-same-session-two-prs");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);
        // Same session, a DIFFERENT PR — must renew its own tree lease
        // without ever reading as a foreign session.
        expect(
          (
            await state(d, ["bump-round", "888", "--head", "bbb"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);
        // The fast renewal path must report THIS call's pr, not the
        // previous one it fast-pathed over without a write — this call is well
        // within `renewAfterMs()`, so without the `seen.pr === canonicalPr`
        // check the tree lease would still say '999' here.
        expect(
          JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).pr,
        ).toBe("888");
        // …and back to the first PR again.
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "ccc"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);
        expect(
          JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).pr,
        ).toBe("999");
      } finally {
        a.stop();
      }
    });

    it("two DIFFERENT worktrees stay fully independent — the tree lease does not span worktrees", async () => {
      // Two DIFFERENT PRs so the PR-wide gate has nothing to say — this probes
      // only whether the tree lease (keyed by actor) leaks across actors,
      // which it must not: two Conductor worktrees are two different trees BY
      // DESIGN, whatever lease files this module keeps.
      const { a, b, env } = twoDrivers("lease-tree-cross-worktree");
      const sessionA = liveSession();
      const sessionB = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(sessionB.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);
        expect(
          drive(b, eb, ["bump-round", "888", "--head", "bbb"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
        sessionB.stop();
      }
    });

    it("two SESSIONLESS worktrees driving the SAME PR EXCLUDE each other", async () => {
      // Tier 3 writes a per-PR lease (`holder: 'worktree'`, keyed by actor
      // rather than pid), because two sessionless resolvers on one PR could
      // otherwise both post `**accepted**` to the same thread. The SECOND
      // worktree here hits the PR-wide gate (exit 13, `assertNoForeignDrive`)
      // via the presence lease the first one wrote, the identical refusal an
      // IDENTIFIED session gets in `REFUSES a second WORKTREE driving one PR`.
      const { a, b, env } = twoDrivers("lease-tree-same-pr-both-admitted");
      expect(
        drive(a, env, ["bump-round", "999", "--head", "aaa"]).exitCode,
      ).toBe(0);
      expect(
        drive(b, env, ["bump-round", "999", "--head", "bbb"]).exitCode,
      ).toBe(13);
    });

    describe("the sessionless tier claims the tree lease too", () => {
      it("two sessionless resolvers in ONE tree driving DIFFERENT PRs refuse each other", async () => {
        // Ladder tier 3 CLAIMS the tree lease, not only checks it. A tier that
        // only checked would let two sessionless resolvers on different PRs
        // from the SAME tree both pass admission — free to edit, commit, and
        // push over one another in the same checkout, the exact
        // cross-shipping hazard the tree lease closes for identified sessions.
        const d = stateDirFor("lease-tree-cross-pr-sessionless");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const second = await state(
          d,
          ["bump-round", "888", "--head", "bbb"],
          sessionless,
        );
        expect(second.exitCode).toBe(11);
        expect(second.stderr).toContain("sessionless resolver");
        expect(second.stderr).toContain("PR #999");
        expect(second.stderr).toContain("clear-lease 888");
        // No pid to name — the refusal must not fabricate one (mirrors the
        // per-PR presence record's own assertion).
        expect(second.stderr).not.toContain("pid 0");

        // B never wrote a per-PR lease of its own — refused before that,
        // exactly like the identified-session case.
        expect(existsSync(leasePathFor(d, "888", ACTOR))).toBe(false);

        // A's claim is a real `holder: 'worktree'` TREE lease, not merely a
        // per-PR presence record — the whole point of this fix.
        const tree = JSON.parse(
          readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
        );
        expect({ holder: tree.holder, pid: tree.pid, pr: tree.pr }).toEqual({
          holder: "worktree",
          pid: 0,
          pr: "999",
        });
      });

      it("one sessionless resolver working multiple PRs from one tree is not refused by itself, via clear-lease", async () => {
        // Tier 3 has no identity to distinguish "the same resolver moved on
        // to a new PR" from "a second resolver started on a new PR while the
        // first is still working" — that is the stated, costed trade in
        // `claimSessionlessTreeLease`'s own comment. `clear-lease` already
        // drops the tree lease unconditionally regardless of which pr it
        // names, so it is the documented, working
        // remedy for a deliberate hand-off between PRs — mirrors the
        // identified-session probe just above ("clear-lease also drops the
        // TREE lease…") for the sessionless tier.
        const d = stateDirFor("lease-tree-sessionless-multi-pr-clear");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const refused = await state(
          d,
          ["bump-round", "888", "--head", "bbb"],
          sessionless,
        );
        expect(refused.exitCode).toBe(11);

        expect(
          (await state(d, ["clear-lease", "888"], sessionless)).exitCode,
        ).toBe(0);

        const admitted = await state(
          d,
          ["bump-round", "888", "--head", "bbb"],
          sessionless,
        );
        expect(admitted.exitCode).toBe(0);
        expect(
          JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).pr,
        ).toBe("888");
      });

      it("renews its own tree presence record across repeated calls for the SAME pr, never refusing itself", async () => {
        const d = stateDirFor("lease-tree-sessionless-same-pr-renew");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);
        // A second call for the SAME pr must renew, not refuse — the
        // `samePr` branch in `claimSessionlessTreeLease`.
        expect(
          (await state(d, ["bump-round", "999", "--head", "bbb"], sessionless))
            .exitCode,
        ).toBe(0);
        expect(
          JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).pr,
        ).toBe("999");
      });

      it("takes over an abandoned TREE presence record for a DIFFERENT pr once staleness passes", async () => {
        // Self-clearing, exactly like the per-PR presence record:
        // with no pid there is nothing to liveness-test but freshness, so a
        // sessionless resolver that stops mid-drive keeps other PRs in this
        // tree out for at most one staleness window, never forever.
        const d = stateDirFor("lease-tree-sessionless-stale-takeover");
        const sessionless = {
          DRIVE_PR_SESSION: "",
          CLAUDE_PID: "",
          // Pinned for the identical reason the cross-tree probe
          // pins it: the ageing step below must land unambiguously past the
          // window, and a hardcoded age cannot promise that against
          // whatever the environment's default happens to be. `1` is floored
          // at `leaseStaleFloorMs` (~5.5m) by `leaseStaleMs`, far below the
          // age applied below.
          DRIVE_PR_LEASE_STALE_MIN: "1",
        };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const path = treeLeasePathFor(d, ACTOR);
        const rec = JSON.parse(readFileSync(path, "utf8"));
        rec.lastSeen = new Date(Date.now() - 400 * 60_000).toISOString();
        writeFileSync(path, JSON.stringify(rec));

        const taken = await state(
          d,
          ["bump-round", "888", "--head", "bbb"],
          sessionless,
        );
        expect(taken.exitCode).toBe(0);
        expect(taken.stderr).toContain("abandoned TREE presence record");
        expect(JSON.parse(readFileSync(path, "utf8")).pr).toBe("888");
      });

      it("a live SESSION-held tree lease on a DIFFERENT pr refuses a sessionless claim, naming the session", async () => {
        // The narrower case `checkNoForeignSessionInTree` always covered,
        // now reached through the WRITE-capable `claimSessionlessTreeLease`
        // instead: an identified session already owns this tree (on a
        // different pr than the sessionless caller wants), so the
        // sessionless claim must refuse rather than overwrite a live
        // session's record with a downgraded presence one.
        const d = stateDirFor("lease-tree-sessionless-vs-live-session");
        const holder = liveSession();
        try {
          expect(
            (
              await state(d, ["bump-round", "999", "--head", "aaa"], {
                DRIVE_PR_SESSION: String(holder.pid),
              })
            ).exitCode,
          ).toBe(0);

          const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
          const refused = await state(
            d,
            ["bump-round", "888", "--head", "bbb"],
            sessionless,
          );
          expect(refused.exitCode).toBe(11);
          expect(refused.stderr).toContain(`pid ${holder.pid}`);
          expect(refused.stderr).toContain("PR #999");
          expect(existsSync(leasePathFor(d, "888", ACTOR))).toBe(false);
          // The tree lease is still the session's own — a sessionless claim
          // must never overwrite it.
          expect(
            JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).holder,
          ).toBe("session");
        } finally {
          holder.stop();
        }
      });

      it("fences the CLAIMING tier-3 path on its own TREE record too, not only its per-PR one", async () => {
        // `assertLeaseUnchanged` (the per-PR fence) already has its own probe
        // above ("fences the CLAIMING tier-3 path on its own record, like
        // every other claim"). This is its counterpart: the fence
        // now also runs `assertTreeLeaseUnchanged` (via
        // `acquireIdentifiedTreeGuardNow`, shared with the identified path)
        // over the TREE record tier 3 claims — so revoking THAT record
        // alone, leaving the per-PR one untouched, must still be caught.
        const d = stateDirFor("lease-tree-sessionless-tree-claim-fence");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        const signal = join(d, "in-locked-section-tree-fence");
        const proc = Bun.spawn(
          scriptArgv(
            join(SCRIPTS, "drive-state.ts"),
            "phase",
            "999",
            "--set",
            "triage",
          ),
          {
            env: {
              ...process.env,
              ...sessionless,
              DRIVE_PR_STATE_DIR: d,
              DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
              DRIVE_PR_UPDATE_TEST_DELAY: "1.5",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        await awaitLockedSection(signal, proc);
        const admittedTree = readTreeLease(treeLeasePathFor(d, ACTOR));
        expect(admittedTree?.holder).toBe("worktree");
        expect(admittedTree?.pr).toBe("999");
        // Revoke ONLY the tree record — the per-PR one is left intact, so
        // `assertLeaseUnchanged` alone would wave this through.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });
        const code = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        expect({ code, saw: stderr.includes("taken over") }).toEqual({
          code: 11,
          saw: true,
        });
        expect(
          JSON.parse((await state(d, ["get", "999"], sessionless)).stdout)
            .phase,
        ).not.toBe("triage");
      });

      it("rolls back a freshly-created SESSIONLESS tree claim when the per-PR claim fails afterward", async () => {
        // `claimSessionlessTreeLease` writes BEFORE `claimPrLease`'s own
        // checks run — the tier-3 mirror of the identified path's own
        // "rolls back a freshly-created tree lease…" probe above. A failure
        // there (a PR-wide refusal from ANOTHER tree, in this probe) must not
        // leave the tree claim it just minted behind,
        // wedging this tree for any OTHER pr this actor might claim next.
        const { a, b, env } = twoDrivers("lease-tree-rollback-sessionless");
        const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };

        // Tree A takes PR 999 first.
        expect(
          drive(a, sessionless, ["bump-round", "999", "--head", "aaa"])
            .exitCode,
        ).toBe(0);

        // Tree B: `claimSessionlessTreeLease` succeeds — tree B has never
        // held any tree-wide claim — but `claimPrLease` then hits the
        // cross-tree gate on PR 999 (tree A already holds it) and refuses.
        expect(
          drive(b, sessionless, ["bump-round", "999", "--head", "bbb"])
            .exitCode,
        ).toBe(13);

        // A DIFFERENT pr from tree B: if the failed claim above had left its
        // tree-wide record on disk, this would be refused (exit 11) by a
        // record pointing at a pr that was never actually admitted.
        expect(
          drive(b, sessionless, ["bump-round", "888", "--head", "ccc"])
            .exitCode,
        ).toBe(0);
      });
    });

    describe("release-sessionless-lease.ts — completion releases a tier-3 record", () => {
      // The asymmetry this closes: a `holder: 'session'` lease is released for
      // free (its pid stops answering), while a `holder: 'worktree'` presence
      // record has no pid to test and so went on refusing every OTHER working
      // tree for a whole staleness window after its resolver finished CLEANLY.
      // `converge.ts` — the loop that spawns those sessionless passes — is the
      // one process that knows when the work is over, and it reaches this
      // script by SPAWNING it (see /resolve-review-comments' own suite for that
      // wiring; this block covers what the script itself may and may not drop).

      /** The release CLI against an explicit state dir, like `state()` above. */
      async function release(
        dir: string,
        args: string[],
        env: Record<string, string> = {},
      ) {
        const proc = Bun.spawn(
          scriptArgv(join(SCRIPTS, "release-sessionless-lease.ts"), ...args),
          {
            // gitCleanEnv() for the reason `state()` gives: the script resolves
            // the actor through `git rev-parse`, and an inherited GIT_DIR would
            // resolve a DIFFERENT tree than the ACTOR these assertions name.
            env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: dir, ...env },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout: stdout.trim(), stderr, exitCode };
      }

      /** The release CLI from a NAMED working tree, like `drive()` above. */
      function releaseIn(
        cwd: string,
        env: Record<string, string>,
        args: string[],
      ) {
        const p = Bun.spawnSync(
          scriptArgv(join(SCRIPTS, "release-sessionless-lease.ts"), ...args),
          { cwd, env, stdout: "pipe", stderr: "pipe" },
        );
        return {
          exitCode: p.exitCode,
          stdout: p.stdout.toString(),
          stderr: p.stderr.toString(),
        };
      }

      it("releases this tree’s tier-3 records, and ANOTHER working tree is admitted immediately", () => {
        // Acceptance criterion 1, and asserted through ADMISSION rather than
        // through file absence: the cross-tree refusal is DERIVED from live
        // lease files, so "the file is gone" is a proxy and admission is the
        // property. Mirrors how every other cross-tree probe in this file
        // proves itself.
        const { a, b, env } = twoDrivers("lease-sessionless-release");
        const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };

        expect(
          drive(a, sessionless, ["bump-round", "999", "--head", "aaa"])
            .exitCode,
        ).toBe(0);
        // The older state: B is refused, and would stay refused for a
        // whole staleness window even though A has finished.
        expect(
          drive(b, sessionless, ["bump-round", "999", "--head", "bbb"])
            .exitCode,
        ).toBe(13);

        const released = releaseIn(a, sessionless, ["--pr", "999"]);
        expect(released.exitCode).toBe(0);
        expect(released.stderr).toContain("released");

        // Nobody holds the PR now — read through the same surface a human
        // would use, since these two worktrees share the clone-wide state dir
        // `twoDrivers` deliberately leaves unset.
        expect(
          JSON.parse(drive(a, sessionless, ["lease", "999", "--all"]).stdout),
        ).toEqual([]);
        // And B is admitted WITHOUT waiting anything out.
        expect(
          drive(b, sessionless, ["bump-round", "999", "--head", "bbb"])
            .exitCode,
        ).toBe(0);
      });

      it("never touches a holder: SESSION lease, even for the same (tree, PR)", () => {
        // The discriminant is the RECORD's own holder, not the caller's
        // identity — so this releases from a SESSIONLESS invocation against a
        // session-held lease, which is the shape that would actually occur (a
        // codex converge loop in a tree where a Claude session is driving).
        // A session lease self-releases with its pid, so there is no asymmetry
        // here to close, and dropping one would put this cleanup path inside
        // the pid-recycling reasoning `lease.ts`'s header carries.
        const { a, b, env } = twoDrivers("lease-sessionless-release-session");
        const holder = liveSession();
        try {
          const identified = { ...env, DRIVE_PR_SESSION: String(holder.pid) };
          expect(
            drive(a, identified, ["bump-round", "999", "--head", "aaa"])
              .exitCode,
          ).toBe(0);

          const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
          const r = releaseIn(a, sessionless, ["--pr", "999"]);
          // Exit 0 — nothing to release is not an error — but nothing released.
          expect(r.exitCode).toBe(0);
          expect(r.stderr).not.toContain("released");

          const leases = JSON.parse(
            drive(a, identified, ["lease", "999", "--all"]).stdout,
          );
          expect(leases).toHaveLength(1);
          expect(leases[0].holder).toBe("session");
          // The protection is intact, not merely the file: B is still refused.
          expect(
            drive(b, sessionless, ["bump-round", "999", "--head", "bbb"])
              .exitCode,
          ).toBe(13);
        } finally {
          holder.stop();
        }
      });

      it("leaves a TREE record that has moved on to a DIFFERENT pr alone, and that pr keeps its protection", async () => {
        // `treeLeasePathFor` is ONE file per working tree, naming whichever PR
        // the tree is CURRENTLY driving. A release for the PR that just
        // finished must not strip the record a LATER sessionless resolver in
        // this same tree is driving a different PR under — that would be a new
        // hazard rather than a leftover one, which is exactly why `clearLease`
        // (unconditional by design, a human override) is not reused here.
        const d = stateDirFor("lease-sessionless-release-other-pr");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        // A release naming a DIFFERENT PR than the tree record does.
        const r = await release(d, ["--pr", "888"], sessionless);
        expect(r.exitCode).toBe(0);
        // Presence asserted BEFORE reading it, so removing the pr-match guard
        // reddens with the finding rather than with an ENOENT from the reader.
        expect(existsSync(treeLeasePathFor(d, ACTOR))).toBe(true);
        expect(
          JSON.parse(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).pr,
        ).toBe("999");

        // And the record still EXCLUDES, which is the point of keeping it: a
        // second sessionless resolver in this tree on a third PR is refused.
        const refused = await state(
          d,
          ["bump-round", "777", "--head", "ccc"],
          sessionless,
        );
        expect(refused.exitCode).toBe(11);
        expect(refused.stderr).toContain("PR #999");
      });

      it("cannot land while a sessionless command is INSIDE its locked section", async () => {
        // Acceptance criterion 2, probed rather than argued. The call-site
        // placement in converge.ts is one half; this is the mechanical half.
        // A release that took no state mutex could delete the lease of a
        // command that is already ADMITTED and mid-locked-section, and that
        // command's own admission fence would then refuse a mutation nothing
        // was ever in conflict with (exit 11, phase unset) — the identical
        // hazard `drive-state.ts`'s `clear-lease` takes the state mutex for.
        // Holding it means a release lands only BETWEEN locked sections.
        const d = stateDirFor("lease-sessionless-release-locked-section");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        const signal = join(d, "in-locked-section-release");
        const proc = Bun.spawn(
          scriptArgv(
            join(SCRIPTS, "drive-state.ts"),
            "phase",
            "999",
            "--set",
            "triage",
          ),
          {
            env: {
              ...process.env,
              ...sessionless,
              DRIVE_PR_STATE_DIR: d,
              DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
              DRIVE_PR_UPDATE_TEST_DELAY: "5",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        await awaitLockedSection(signal, proc);

        // Fired at the worst possible moment — while the resolver is still
        // driving. It must WAIT, not interleave.
        const released = await release(d, ["--pr", "999"], sessionless);
        expect(released.exitCode).toBe(0);

        const code = await proc.exited;
        expect(code).toBe(0);
        expect(
          JSON.parse((await state(d, ["get", "999"], sessionless)).stdout)
            .phase,
        ).toBe("triage");
        // The release still happened — it was ordered, not skipped.
        expect(existsSync(treeLeasePathFor(d, ACTOR))).toBe(false);
      });

      it("is a harmless, idempotent no-op with nothing to release — and creates no state", async () => {
        // It is called speculatively, on every converge.ts loop exit, in trees
        // that may never have driven anything. Every one of those is exit 0.
        const d = stateDirFor("lease-sessionless-release-noop");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect((await release(d, ["--pr", "999"], sessionless)).exitCode).toBe(
          0,
        );

        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);
        expect((await release(d, ["--pr", "999"], sessionless)).exitCode).toBe(
          0,
        );
        // Twice over the same PR: the second call has nothing left to find.
        const again = await release(d, ["--pr", "999"], sessionless);
        expect(again.exitCode).toBe(0);
        expect(again.stderr).not.toContain("released");

        // A state dir that does not exist is answered, not CREATED — this runs
        // on every converge exit and must not leave a directory behind.
        const missing = join(d, "no-such-state-dir");
        expect(
          (await release(missing, ["--pr", "999"], sessionless)).exitCode,
        ).toBe(0);
        expect(existsSync(missing)).toBe(false);
      });

      it("reserves non-zero for usage alone", async () => {
        const d = stateDirFor("lease-sessionless-release-usage");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect((await release(d, [], sessionless)).exitCode).toBe(2);
        expect((await release(d, ["--pr"], sessionless)).exitCode).toBe(2);
        expect((await release(d, ["--pr", "x"], sessionless)).exitCode).toBe(2);
        expect((await release(d, ["--nope"], sessionless)).exitCode).toBe(2);
      });
    });
  });
});
