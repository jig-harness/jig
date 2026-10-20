/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { execFileSync } from "node:child_process";

import {
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

import { hostname } from "node:os";

import { join, resolve } from "node:path";

import { cloneKey } from "../scripts/lib/state/clone-key";

import {
  assertLeaseUnchanged,
  leasePathFor,
  readLease,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  ACTOR,
  suiteHome,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateSessionLeaseFixtures } from "./drive-pr-state-session-lease-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const {
    stateDirFor,
    state,
    twoDrivers,
    drive,
    liveSession,
    awaitPidGone,
    awaitLockedSection,
  } = stateDurabilityFixtures;
  describe("the session lease over one working tree", () => {
    const stateSessionLeaseFixtures = createStateSessionLeaseFixtures(
      stateDurabilityFixtures,
    );
    const { A_URL } = stateSessionLeaseFixtures;

    it("refuses the SECOND of two SESSIONLESS trees — neither has a pid, both have a tree", async () => {
      // The residual lease-derived refusal cannot close: the refusal is
      // derived from lease files, so it needed ONE SIDE to have left one, and
      // two sessionless resolvers left none between them. Both passed the gate
      // and could then put two outcome replies on every thread they both
      // reached — the exact damage the gate exists to prevent, surviving on
      // the one path.
      //
      // Closed by giving tier 3 a record whose holder is the TREE. No pid is
      // invented for it; `actor.ts` already identifies a working tree without
      // one, and a working tree is the only thing the PR-wide gate asks about.
      const { a, b, env } = twoDrivers("lease-cross-tree-both-sessionless");
      // `twoDrivers` already pins both variables empty. Restated here because
      // this probe's entire subject is that neither side has an identity: were
      // that helper ever to stop pinning them, this would silently become a
      // test of the ordinary two-session case, which passes for a different
      // reason.
      //
      // The staleness window is PINNED rather than left to the default,
      // because the ageing step near the end of this probe has to produce a
      // record that is unambiguously stale and a hardcoded age cannot promise
      // that against a window the environment sets. `1` does not mean one
      // minute — `leaseStaleMs` floors every configured value at
      // `leaseStaleFloorMs` (LOCK_ACQUIRE_MAX_SEC + RENEW_AFTER_MAX_MS, ~5.5m)
      // — which is exactly why it is safe in BOTH directions here: far above
      // the seconds-old record the refusal below turns on, and far below the
      // age applied later.
      const sessionless = {
        ...env,
        DRIVE_PR_SESSION: "",
        CLAUDE_PID: "",
        DRIVE_PR_LEASE_STALE_MIN: "1",
      };

      expect(
        drive(a, sessionless, ["phase", "999", "--set", "triage"]).exitCode,
      ).toBe(0);
      const fromB = drive(b, sessionless, [
        "bump-round",
        "999",
        "--head",
        "aaa",
      ]);
      expect(fromB.exitCode).toBe(13);
      expect(fromB.stderr).toContain("ANOTHER working tree");
      // The refusal names what it can and does NOT fabricate what it cannot: a
      // tree-held record has no session, and a message saying "pid 0" would
      // send the reader to check their own process group.
      expect(fromB.stderr).toContain("sessionless resolver");
      expect(fromB.stderr).not.toContain("pid 0");
      expect(fromB.stderr).toContain("clear-lease 999 --all");

      // A's record is what did it, and it is a `worktree` holder.
      const leases = JSON.parse(
        drive(a, sessionless, ["lease", "999", "--all"]).stdout,
      );
      expect(leases).toHaveLength(1);
      expect({ holder: leases[0].holder, pid: leases[0].pid }).toEqual({
        holder: "worktree",
        pid: 0,
      });

      // And it is SELF-CLEARING, which is the property that makes the whole
      // thing safe to have: with no pid there is nothing to liveness-test, so
      // if freshness did not expire it, a sessionless resolver that died
      // mid-drive would wedge the PR for every other tree — strictly worse
      // than the race it prevents. Aged past the window by hand, because the
      // window is hours and its floor (`leaseStaleFloorMs`) puts even the
      // smallest configurable one well past a test's patience.
      //
      // Both worktrees land on the SAME state dir because they share one
      // clone (`twoDrivers` leaves $DRIVE_PR_STATE_DIR unset so they resolve
      // it themselves) — the default, `~/.local/state/jig/drive-pr/
      // <cloneKey>/`, keyed off `--git-common-dir` rather than the common
      // dir itself.
      const commonDir = resolve(
        a,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: a,
          env: sessionless,
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
        cloneKey(commonDir),
      );
      const own = readdirSync(stateDir).filter(
        (n) => n.startsWith("pr-drive-lease-999-") && n.endsWith(".json"),
      );
      // Asserted, not assumed: an empty glob here would age NOTHING and the
      // admission below would then pass for the wrong reason entirely (a check
      // that inspected nothing must fail, not pass).
      expect(own).toHaveLength(1);
      const path = join(stateDir, own[0] as string);
      const rec = JSON.parse(readFileSync(path, "utf8"));
      // Past the window pinned above by orders of magnitude, so this step
      // cannot depend on which value the environment chose.
      rec.lastSeen = new Date(Date.now() - 400 * 60_000).toISOString();
      writeFileSync(path, JSON.stringify(rec));
      expect(
        drive(b, sessionless, ["bump-round", "999", "--head", "aaa"]).exitCode,
      ).toBe(0);
    });

    it("does NOT refuse a sibling invocation in its OWN tree — tier 3 excludes trees, not calls", async () => {
      // The reason tier 3 refused to invent a pid in the first place: under an
      // agent that spawns a fresh shell per tool call, any per-INVOCATION
      // identity makes two concurrent calls from ONE agent refuse each other,
      // and a false refusal wedges work that was never in conflict.
      //
      // A tree-scoped record cannot reproduce that, and this is the probe that
      // says so rather than leaving it to the argument: every invocation from
      // one tree resolves the same actor, so the second is the FIRST's own
      // record — renewed, never refused. Without it, a future change that
      // narrowed `isMine`'s tree branch would pass every cross-tree test above
      // while breaking the one harness this tier exists for.
      const d = stateDirFor("lease-tier3-same-tree");
      const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
      expect(
        (await state(d, ["phase", "999", "--set", "triage"], sessionless))
          .exitCode,
      ).toBe(0);
      expect(
        (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
          .exitCode,
      ).toBe(0);
      expect(
        (await state(d, ["bump-round", "999", "--head", "bbb"], sessionless))
          .exitCode,
      ).toBe(0);
      // One record, still the tree's — not one per invocation.
      const all = JSON.parse(
        (await state(d, ["lease", "999", "--all"], sessionless)).stdout,
      );
      expect(all).toHaveLength(1);
      expect(all[0].holder).toBe("worktree");
    });

    it("an IDENTIFIED session upgrades its own tree’s tier-3 record instead of refusing itself over it", async () => {
      // A sessionless caller leaves a tree-held record, so a Claude Code
      // session starting in the same tree meets that record rather than an
      // empty slot — and if that record refused it, the cost of closing a
      // cross-tree hole would be a NEW intra-tree refusal, on a path a human
      // clears only with `clear-lease` or by waiting out a window measured in
      // hours.
      //
      // So the record is upgraded in place: same tree, better identity. What
      // other trees see afterwards is a SESSION lease, which is strictly more
      // than they had — it carries a pid they can liveness-test.
      const d = stateDirFor("lease-tier3-upgrade");
      const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
      expect(
        (await state(d, ["phase", "999", "--set", "triage"], sessionless))
          .exitCode,
      ).toBe(0);
      const s = liveSession();
      try {
        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(s.pid),
        });
        expect(r.exitCode).toBe(0);
        const now = readLease(leasePathFor(d, "999", ACTOR));
        expect({ holder: now?.holder, pid: now?.pid }).toEqual({
          holder: "session",
          pid: s.pid,
        });
      } finally {
        s.stop();
      }
    });

    it("FENCES a command admitted on the tree-held record when a session upgrades it", async () => {
      // The upgrade preserves `generation` — it is the same tree, continuously
      // present, so no new admission epoch is minted. That looks like a hole
      // and is not one, and this probe is here because the reading that makes
      // it look like one is easy to arrive at: a
      // sessionless command admitted on the tree-held record, paused before its
      // mutation while a session upgrades, would pass a generation-only fence
      // and mutate beside it.
      //
      // `assertLeaseUnchanged` is not generation-only. It compares (pid, host,
      // generation), and the upgrade is precisely the write that moves `pid`
      // off 0 — so the stale command is refused by the field the holder change
      // necessarily touches. Pinned here so a later change that drops the pid
      // comparison, or that mints a session lease carrying pid 0, fails on the
      // reason rather than somewhere downstream.
      const d = stateDirFor("lease-upgrade-fences-admitted");
      const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
      expect(
        (await state(d, ["phase", "999", "--set", "triage"], sessionless))
          .exitCode,
      ).toBe(0);
      const admitted = readLease(leasePathFor(d, "999", ACTOR));
      // The precondition, asserted rather than assumed: without a tree-held
      // record to be admitted on, everything below would pass vacuously.
      expect(admitted?.holder).toBe("worktree");

      const s = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(s.pid),
            })
          ).exitCode,
        ).toBe(0);
        const upgraded = readLease(leasePathFor(d, "999", ACTOR));
        // The upgrade really did preserve the generation — otherwise this
        // probe would be exercising an ordinary takeover, which is a different
        // (and already covered) path.
        expect({
          holder: upgraded?.holder,
          sameGeneration: upgraded?.generation === admitted?.generation,
        }).toEqual({ holder: "session", sameGeneration: true });

        // And the earlier command's fence refuses anyway.
        expect(() =>
          assertLeaseUnchanged(
            d,
            "999",
            admitted as NonNullable<typeof admitted>,
          ),
        ).toThrow();
      } finally {
        s.stop();
      }
    });

    it("re-checks under the STATE MUTEX for a sessionless caller, not only at admission", async () => {
      // The preflight in `claimLease` runs outside every mutex and then returns
      // without writing anything, so on its own it is a check that is not part
      // of the protocol it guards: an identified resolver can take the state
      // mutex and write its lease the instant after the preflight passes, and
      // the sessionless command then takes the same mutex and mutates beside it
      //. The fence is what makes admission and
      // mutation one continuous decision.
      //
      // Probed where the race actually lives rather than by racing two
      // processes: a lease that appears AFTER admission but BEFORE the locked
      // section is exactly the state the fence exists to catch, and writing it
      // in that window is deterministic while a real race is not.
      //
      // The path probed here is the ONE tier-3 case that claims nothing: this
      // tree already holds a live SESSION lease, so it is represented in the
      // PR-wide gate already and the sessionless caller
      // deliberately leaves it alone (overwriting it would be a takeover it
      // cannot justify — see `clearAllLeases`). That is exactly
      // the case with no lease of its own to fence on, so
      // `assertNoForeignDriveNow` remains its fence and this probe remains its
      // regression test. The tier-3 path that DOES claim is fenced by
      // `assertLeaseUnchanged` like every other claim, and has its own probe
      // below.
      const d = stateDirFor("lease-sessionless-fence");
      const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
      const foreign = leasePathFor(d, "999", "wt-00000000000000fe");
      const holder = liveSession();
      const ownSession = liveSession();
      try {
        // This tree's own live SESSION lease — the precondition for the
        // claims-nothing path. Written directly because the point is the state,
        // not how it was reached.
        writeFileSync(
          leasePathFor(d, "999", ACTOR),
          JSON.stringify({
            holder: "session",
            pid: ownSession.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/this/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "hold",
            generation: "d".repeat(32),
            sessionStarted: "",
          }),
        );
        // `DRIVE_PR_UPDATE_TEST_SIGNAL`/`_DELAY` hold the locked section open,
        // which is the same hook the takeover probes use.
        const signal = join(d, "in-locked-section");
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
        // Wait until it is INSIDE the locked section — past admission, so its
        // preflight has already passed and seen an empty PR.
        await awaitLockedSection(signal, proc);
        // Now a foreign tree takes the PR. Under the old preflight-only code
        // this landed unseen and both mutated.
        writeFileSync(
          foreign,
          JSON.stringify({
            holder: "session",
            pid: holder.pid,
            host: hostname(),
            platform: process.platform,
            actor: "wt-00000000000000fe",
            worktree: "/somewhere/else",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "hold",
            generation: "e".repeat(32),
            sessionStarted: "",
          }),
        );
        const code = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        expect({ code, saw: stderr.includes("ANOTHER working tree") }).toEqual({
          code: 13,
          saw: true,
        });
        // And it mutated NOTHING: the fence aborts before the write.
        expect(
          JSON.parse((await state(d, ["get", "999"], sessionless)).stdout)
            .phase,
        ).not.toBe("triage");
      } finally {
        holder.stop();
        ownSession.stop();
      }
    });

    it("fences the CLAIMING tier-3 path on its own record, like every other claim", async () => {
      // The other half of the sessionless fence. A tier-3 caller that found
      // nothing in its tree writes a `worktree` record and is therefore
      // admitted on a lease like anybody else — so its fence is
      // `assertLeaseUnchanged`, and what it has to catch is that record being
      // revoked between admission and the mutation it was admitted for.
      //
      // Worth a probe of its own rather than trusting the shared code path:
      // the record's generation is the only thing tying the two moments
      // together, and a `worktree` record is the one kind whose holder cannot
      // be checked any other way — if the fence did not compare it, nothing
      // else about the record would notice a `clear-lease` in the gap.
      const d = stateDirFor("lease-sessionless-claim-fence");
      const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
      const signal = join(d, "in-locked-section");
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
      // It IS holding a record by now — that is the whole difference from the
      // probe above, and asserting it here is what keeps this test from
      // passing vacuously if tier 3 ever stops claiming again.
      const admitted = readLease(leasePathFor(d, "999", ACTOR));
      expect(admitted?.holder).toBe("worktree");
      // Revoked mid-flight, exactly as `clear-lease` would.
      rmSync(leasePathFor(d, "999", ACTOR), { force: true });
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect({ code, saw: stderr.includes("taken over") }).toEqual({
        code: 11,
        saw: true,
      });
      expect(
        JSON.parse((await state(d, ["get", "999"], sessionless)).stdout).phase,
      ).not.toBe("triage");
    });

    it("the TREE lease claim treats a recycled pid as a takeover, not a live rival", async () => {
      // The per-PR claim (`claimPrLease`) already has `isRecycledPid` — the
      // tree-lease claim (`claimTreeLease`) did not, so once the OS handed a
      // dead predecessor's exact pid to THIS caller, `isMine` correctly said
      // "not mine" but `leaseAlive` kept saying "and it's still out there"
      // (it's asking whether this process is running, which is trivially
      // true), blocking every PR in the checkout until the stale lease aged
      // out instead of recognizing the takeover it actually was.
      //
      // A DIFFERENT pr than the seeded lease's own (777 vs 999) is what
      // proves this is a genuine TAKEOVER rather than the same-pr fast path:
      // only `mintsNewGeneration`'s locked path rewrites the record with a
      // new pr/generation/token.
      const d = stateDirFor("lease-tree-recycled-pid");
      const old = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        treeLeasePathFor(d, ACTOR),
        `${JSON.stringify(
          {
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "",
            startedAt: old,
            lastSeen: old,
            command: "bump-round",
            generation: "g-dead-predecessor",
            sessionStarted: old,
            pr: "777",
            revision: "r-dead-predecessor",
          },
          null,
          2,
        )}\n`,
      );
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: new Date().toISOString(),
      });
      expect(r.exitCode).toBe(0);
      const written = JSON.parse(
        readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
      );
      // Asserted independently, not as one `not.toEqual` — that would pass
      // on a one-line regression that writes the requested pr but leaves the
      // dead predecessor's OWN generation in place, which is not a genuine
      // takeover.
      expect(written.pr).toBe("999");
      expect(written.generation).not.toBe("g-dead-predecessor");
    });

    it("refuses on a foreign lease file it cannot READ, rather than counting it absent", async () => {
      // `readLease` answers null for both "absent" and "unreadable", which is
      // right where it was written and wrong for an admission decision: a lease
      // file exists because some tree wrote one, so skipping the ones that fail
      // to parse makes "no live foreign lease" a claim about the subset that
      // happened to parse. The general form: a check that cannot read part of
      // its input fails closed.
      const d = stateDirFor("lease-unreadable-foreign");
      // Window pinned for the same reason its sibling above pins it: the ageing
      // step below is only meaningful against a KNOWN window, and a hardcoded
      // age silently stops proving anything under a larger configured one. Same
      // class as the finding raised on that probe, fixed here too rather than
      // left as the next round's copy.
      const me = {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_LEASE_STALE_MIN: "1",
      };
      const foreign = leasePathFor(d, "999", "wt-00000000000000cd");
      writeFileSync(foreign, "{ this is not a lease");

      const r = await state(d, ["phase", "999", "--set", "triage"], me);
      expect(r.exitCode).toBe(13);
      expect(r.stderr).toContain("cannot be read as a lease");
      expect(r.stderr).toContain(foreign);

      // Bounded by MTIME so failing closed cannot wedge the PR forever: an
      // unreadable file has no lastSeen to age out and no pid to test, so its
      // mtime is the only property that can speak for it.
      const old = Date.now() - 400 * 60_000; // >> the pinned window
      utimesSync(foreign, new Date(old), new Date(old));
      expect(
        (await state(d, ["phase", "999", "--set", "triage"], me)).exitCode,
      ).toBe(0);
    });

    it("a DEAD holder does not wedge the PR for the other worktree", async () => {
      // The property that makes a PR-wide gate safe to have at all. A per-tree
      // lease already self-clears on a dead pid and a staleness window; a
      // PR-wide one that did not would let a crashed Conductor worktree hold a
      // PR hostage from every other tree — strictly worse than the race it
      // prevents. It is free here because the gate is DERIVED from the same
      // `leaseAlive` test rather than stored: nothing has to expire, because
      // nothing was recorded.
      const { a, b, env } = twoDrivers("lease-cross-tree-dead");
      const sessionA = liveSession();
      // try/finally like every sibling that takes a `liveSession`, and not
      // merely for symmetry: `stop()` is what reaps the `sleep 600` child, so
      // an assertion that throws before the inline stop leaves that process
      // alive for ten minutes — one orphan per failing run, contaminating the
      // rest of the suite. The stop stays in the body too, since
      // this probe needs the pid GONE mid-test; `stop()` is idempotent, so the
      // finally is a backstop rather than a second kill.
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);
        // Refused while A lives — the control, so the pass below cannot be the
        // gate simply never firing in this fixture.
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          13,
        );

        sessionA.stop();
        await awaitPidGone(sessionA.pid);

        // …and admitted the moment it is gone, with no clear-lease, no reset
        // and no waiting out a window.
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          0,
        );
      } finally {
        sessionA.stop();
      }
    });

    it("a STALE holder does not wedge it either — the same window as the session lease", async () => {
      // The other half of self-clearing: a session whose pid still ANSWERS but
      // which has stopped driving. `leaseAlive` is a conjunction, and a gate
      // built on only the pid half would wedge the PR for a full staleness
      // window every time a driver was killed and its number recycled.
      const { a, b, env } = twoDrivers("lease-cross-tree-stale");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          13,
        );

        // A's pid still answers; only its RENEWAL has stopped. Backdated past
        // the window rather than waited out, which is the only way to probe a
        // six-hour default.
        //
        // Both trees land on the same state dir because they share one clone —
        // these probes deliberately leave $DRIVE_PR_STATE_DIR unset so that
        // both resolve it themselves. The default,
        // `~/.local/state/jig/drive-pr/<cloneKey>/`, is keyed off
        // `--git-common-dir` rather than the common dir itself.
        const commonDir = resolve(
          a,
          execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: a,
            env: ea,
          })
            .toString()
            .trim(),
        );
        const held = JSON.parse(drive(a, ea, ["lease", "999"]).stdout);
        writeFileSync(
          leasePathFor(
            join(
              suiteHome,
              ".local",
              "state",
              "jig",
              "drive-pr",
              cloneKey(commonDir),
            ),
            "999",
            held.actor,
          ),
          JSON.stringify({
            ...held,
            lastSeen: new Date(Date.now() - 8 * 60 * 60_000).toISOString(),
          }),
        );
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          0,
        );
      } finally {
        sessionA.stop();
      }
    });

    it("leaves the refused WORKTREE every read, and every OTHER PR", async () => {
      // "Whatever lands must keep a second worktree useful for everything that
      // is not posting outcome replies to this PR". Two claims, and
      // both are the actual contract rather than a nicety: the refused tree is
      // the one that most needs to see WHY, and a gate that spread to other PRs
      // would break the Conductor topology outright.
      const { a, b, env } = twoDrivers("lease-cross-tree-reads");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };
        expect(
          drive(a, ea, [
            "hold",
            "999",
            "--key",
            "PRRT_a",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            A_URL,
          ]).exitCode,
        ).toBe(0);
        // The refusal is REAL in this fixture — asserted, not assumed. Without
        // this line every assertion below holds just as well with the gate
        // removed entirely, and the probe would read as coverage while proving
        // only that reads are reads.
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          13,
        );

        for (const cmd of [
          ["get", "999"],
          ["rounds", "999"],
          ["held", "999"],
          ["held-keys", "999"],
          ["parked-keys", "999"],
          ["verified", "999"],
          ["lease", "999"],
          ["lease", "999", "--all"],
        ]) {
          expect({
            cmd: cmd.join(" "),
            code: drive(b, eb, cmd).exitCode,
          }).toEqual({ cmd: cmd.join(" "), code: 0 });
        }
        // The refused tree can see the whole held batch, including the hold it
        // was refused permission to add to.
        expect(
          JSON.parse(drive(b, eb, ["held", "999"]).stdout).map(
            (h: { key: string }) => h.key,
          ),
        ).toEqual(["PRRT_a"]);

        // A DIFFERENT PR from the same second tree is untouched — the gate is
        // per-PR, so the supported "two worktrees, two PRs" topology is exactly
        // as free as it was.
        expect(
          drive(b, eb, ["bump-round", "1000", "--head", "bbb"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
      }
    });
  });
});
