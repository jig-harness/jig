/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  leaseFilesFor,
  leasePathFor,
  readLease,
} from "../scripts/lib/state/lease";

import {
  ACTOR,
  OLDER_SESSION_TOKEN,
  NEWER_SESSION_TOKEN,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateSessionLeaseFixtures } from "./drive-pr-state-session-lease-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const {
    stateDirFor,
    state,
    gitPathOf,
    twoDrivers,
    drive,
    liveSession,
    awaitPidGone,
  } = stateDurabilityFixtures;
  describe("the session lease over one working tree", () => {
    const stateSessionLeaseFixtures = createStateSessionLeaseFixtures(
      stateDurabilityFixtures,
    );
    const { A_URL, holdAs } = stateSessionLeaseFixtures;

    it("lease --all reports every live tree with a self flag, and [] for none", async () => {
      // The foreign-lease READ surface. Before it there was no way
      // for a resolver to detect another live worktree, and the near-miss is
      // why this is a lease read and not a hold read: the durable per-hold
      // `actor` proves a hold was MADE elsewhere, never that anyone is still
      // driving, because a hold deliberately outlives its driver so a successor
      // can finish it. Stopping on a foreign actor wedges that successor.
      const { a, b, env } = twoDrivers("lease-all-report");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };

        // `[]`, not a blank line: an empty answer here is load-bearing, and a
        // caller must be able to tell "enumerated, found none" from "printed
        // nothing".
        expect(
          JSON.parse(drive(b, eb, ["lease", "999", "--all"]).stdout),
        ).toEqual([]);

        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // Read from the tree that does NOT hold it — the only tree that needs
        // to ask, and the exact read `lease` (no flag) cannot perform, since it
        // resolves the caller's own actor.
        const fromB = JSON.parse(
          drive(b, eb, ["lease", "999", "--all"]).stdout,
        ) as { pid: number; worktree: string; self: boolean }[];
        expect(fromB).toHaveLength(1);
        expect(fromB[0]?.pid).toBe(sessionA.pid);
        expect(fromB[0]?.worktree).toBe(gitPathOf(a));
        expect(fromB[0]?.self).toBe(false);

        // …and the same read from A calls it its own.
        const fromA = JSON.parse(
          drive(a, ea, ["lease", "999", "--all"]).stdout,
        ) as { self: boolean }[];
        expect(fromA).toHaveLength(1);
        expect(fromA[0]?.self).toBe(true);
      } finally {
        sessionA.stop();
      }
    });

    it("clear-lease --all is the cross-tree override, and reports what it overrode", async () => {
      // The takeover path. Plain `clear-lease` resolves the CALLER's actor, so
      // it cannot reach a lease held by a tree the operator is not standing in
      // — one that was deleted, or lives on another machine. A PR-wide refusal
      // whose only remedy must be run from the refusing tree is not a remedy.
      const { a, b, env } = twoDrivers("lease-clear-all");
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

        // Plain clear-lease from B clears B's own (there is none) and changes
        // nothing — the gap `--all` exists to close.
        expect(drive(b, eb, ["clear-lease", "999"]).exitCode).toBe(0);
        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          13,
        );

        const cleared = drive(b, eb, ["clear-lease", "999", "--all"]);
        expect(cleared.exitCode).toBe(0);
        // The operator is overruling a LIVE claim, so the record they are
        // overruling is the evidence for whether that was right.
        expect(cleared.stderr).toContain(`pid ${sessionA.pid}`);
        expect(cleared.stderr).toContain(gitPathOf(a));

        expect(drive(b, eb, ["phase", "999", "--set", "triage"]).exitCode).toBe(
          0,
        );
      } finally {
        sessionA.stop();
      }
    });

    it("renews its own lease when it has gone quiet, and skips the write when it has not", async () => {
      // Both halves matter. Renewal is what keeps a long drive's lease alive —
      // without it the session goes stale mid-drive and another one may take
      // the PR over. Skipping the write when the lease was just renewed is
      // what keeps one session's legitimately concurrent commands (claim-held
      // fans out one process per key) from serialising on a mutex to push the
      // same timestamp forward; the "only one of many concurrent
      // claimants wins" probe above times out when they do.
      const d = stateDirFor("lease-renewal");
      const me = { DRIVE_PR_SESSION: String(process.pid) };
      await state(d, ["bump-round", "999", "--head", "aaa"], me);
      const path = leasePathFor(d, "999", ACTOR);
      const first = JSON.parse(readFileSync(path, "utf8"));

      // Immediately after: nothing to decide, so nothing is written.
      await state(d, ["phase", "999", "--set", "triage"], me);
      expect(JSON.parse(readFileSync(path, "utf8")).lastSeen).toBe(
        first.lastSeen,
      );

      // Quiet for longer than the renewal interval: the next command renews,
      // and keeps the original `startedAt` so the refusal can still say how
      // long this session has been driving.
      const quiet = {
        ...first,
        lastSeen: new Date(Date.now() - 60_000).toISOString(),
      };
      writeFileSync(path, JSON.stringify(quiet, null, 2));
      await state(d, ["phase", "999", "--set", "fix"], me);
      const renewed = JSON.parse(readFileSync(path, "utf8"));
      expect(Date.parse(renewed.lastSeen)).toBeGreaterThan(
        Date.parse(quiet.lastSeen),
      );
      expect(renewed.startedAt).toBe(first.startedAt);
      expect(renewed.command).toBe("phase");
    });

    it("refuses a $DRIVE_PR_SESSION that is not a pid rather than falling through", async () => {
      // Falling back would silently adopt a DIFFERENT identity than the caller
      // set — the exact confusion this whole mechanism exists to end.
      const d = stateDirFor("lease-bad-session");
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: "session-7",
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("must be a process id");
    });

    it("refuses a $DRIVE_PR_SESSION that is digits but not a usable pid", async () => {
      // `0` and a digit string too long to parse exactly are both `isDigits`-
      // clean, so they used to sail through into a lease file that `readLease`
      // then bounced right back off — `0` fails its `> 0` test, and the 400-
      // nines case parses to `Infinity` and serialises as JSON `null`. The
      // session then held NO lease while believing it held one, and the next
      // session was free to mutate alongside it: the concurrency this module
      // exists to refuse, reached by a path that reported nothing.
      const d = stateDirFor("lease-unusable-pid");
      for (const bad of ["0", "9".repeat(400)]) {
        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: bad,
        });
        const at = `${bad.slice(0, 4)}(${bad.length})`;
        expect({ at, code: r.exitCode }).toEqual({ at, code: 2 });
      }
      // Neither left a phantom lease behind, and neither counted a round.
      expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(false);

      // `$CLAUDE_PID` is the harness's to set, not the caller's, so the same
      // unusable value there falls THROUGH to ladder tier 3 — admitted, not
      // refused — rather than failing a command nobody can fix.
      const viaHarness = await state(
        d,
        ["bump-round", "999", "--head", "aaa"],
        {
          DRIVE_PR_SESSION: "",
          CLAUDE_PID: "0",
        },
      );
      expect(viaHarness.exitCode).toBe(0);
      // What tier 3 writes is a record whose holder is the WORKING TREE, not a
      // session: it carries no pid, because none could be
      // identified, and that is exactly what distinguishes it from the refused
      // `$DRIVE_PR_SESSION` values above — those named a session and got it
      // wrong, this one names none and says so.
      //
      // Asserted on the CONTENT rather than on the file's existence, which is
      // what this line used to check. "No file" was never the property that
      // mattered; "no exclusion taken under an identity that does not exist"
      // was, and a tree-scoped record does not take one — see `isMine`.
      const written = readLease(leasePathFor(d, "999", ACTOR));
      expect({ holder: written?.holder, pid: written?.pid }).toEqual({
        holder: "worktree",
        pid: 0,
      });
    });

    it("reset is refused while another session holds the lease, and keeps only its own", async () => {
      // `reset` is what a human reaches for to unwedge a drive, and the tree
      // holding the wedged lease need not be the tree they are standing in.
      const d = stateDirFor("lease-reset");
      const a = liveSession();
      try {
        const b = { DRIVE_PR_SESSION: String(process.pid) };
        await holdAs(d, a.pid, A_URL);
        expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(true);
        expect((await state(d, ["reset", "999"], b)).exitCode).toBe(11);
        // Refused, because reset is itself a mutation — so the documented order
        // is clear-lease first.
        await state(d, ["clear-lease", "999"]);
        expect((await state(d, ["reset", "999"], b)).exitCode).toBe(0);
        // A's lease went with everything else. What is left is the RESET's OWN,
        // live and this session's: dropping it would open this tree to a second
        // session beside a same-session command `reset` may have been racing —
        // the in-flight case its own state-mutex hold cannot see.
        expect(
          JSON.parse((await state(d, ["lease", "999"], b)).stdout),
        ).toMatchObject({ pid: process.pid });
      } finally {
        a.stop();
      }
    });

    it("every *-ready-mark command is refused while another session holds the lease", async () => {
      // These four mutate a DIFFERENT lease (the ready-mark claim,
      // `readyClaimPath` — cross-WORKTREE, guarding the draft→Ready
      // transition), but that does not exempt them from THIS one, which
      // guards against a second SESSION in the same tree. Left off
      // LEASED_COMMANDS, `release-ready-mark`'s tokenless recovery path let a
      // second session delete the first session's live ready-mark claim and
      // take the transition itself, without ever reaching this refusal.
      const d = stateDirFor("lease-ready-mark");
      const a = liveSession();
      try {
        const b = { DRIVE_PR_SESSION: String(process.pid) };
        await holdAs(d, a.pid, A_URL);
        expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(true);
        for (const args of [
          ["claim-ready-mark", "999"],
          ["renew-ready-mark", "999", "--token", "x"],
          ["commit-ready-mark", "999", "--token", "x"],
          ["release-ready-mark", "999", "--token", "x"],
        ]) {
          expect((await state(d, args, b)).exitCode).toBe(11);
        }
      } finally {
        a.stop();
      }
    });

    it("reset REFUSES across trees while a foreign lease is live, then succeeds once it is gone", async () => {
      // Preserving the foreign lease is necessary but not sufficient: the
      // state file and the CLAIM files are shared by every tree driving the
      // PR, so continuing would let this tree delete a live session's
      // in-flight claim and re-dispatch a non-idempotent answer it had already
      // claimed. `reset` refuses outright, deleting nothing.
      //
      // The refusal comes from the PR-wide gate: `reset` is a leased command,
      // and this tree holds no lease yet, so its claim is a fresh admission
      // and meets the gate first — exit 13, naming the same holder, before
      // `reset`'s own exit-9 branch is reached.
      //
      // `reset` is deliberately NOT exempted from that gate, and the reason is
      // the fast path: a command exempted here would still take a lease on its
      // way to being refused, and this session's NEXT command would fast-path
      // off that lease without ever meeting the gate. An exemption for the one
      // command an operator runs when things are already wrong is exactly the
      // bypass that would make the admission model decorative. The exit-9
      // branch remains reachable — see the `reset-refuses-live` probe above,
      // where this tree was admitted BEFORE the foreign lease existed.
      //
      // The second half is unchanged and is the reason refusing is safe: once
      // that session is GONE its lease is exactly the wedge `reset` exists to
      // clear, so the next attempt sweeps it and completes.
      const { a, b, env } = twoDrivers("lease-reset-cross-tree");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        const reset = drive(b, eb, ["reset", "999"]);
        expect(reset.exitCode).toBe(13);
        expect(reset.stderr).toContain("ANOTHER working tree");
        expect(reset.stderr).toContain(`pid ${sessionA.pid}`);
        // A's lease is untouched, and B took NONE — a refusal that installed
        // one would leave a live lease B's next command fast-paths off.
        expect(JSON.parse(drive(a, ea, ["lease", "999"]).stdout)).toMatchObject(
          { pid: sessionA.pid },
        );
        expect(drive(b, eb, ["lease", "999"]).stdout.trim()).toBe("");
        // …and NOTHING was reset, which is the half of the contract that has
        // never changed.
        expect(drive(b, eb, ["rounds", "999"]).stdout.trim()).toBe("1");

        // Once A's session is GONE its lease is exactly the wedge `reset`
        // exists to clear, so the next one sweeps it and completes — silently.
        sessionA.stop();
        await awaitPidGone(sessionA.pid);
        const second = drive(b, eb, ["reset", "999"]);
        expect(second.exitCode).toBe(0);
        expect(second.stderr).not.toContain("refusing to reset");
        expect(drive(a, ea, ["lease", "999"]).stdout.trim()).toBe("");
        expect(drive(b, eb, ["rounds", "999"]).stdout.trim()).toBe("0");
      } finally {
        sessionA.stop();
      }
    });

    it("the PR-wide gate does not refuse a working tree whose pid the OS recycled from a dead tree elsewhere (exit 13)", () => {
      // The cross-tree counterpart of the same-tree probe in "the session
      // lease over one working tree" above: tree A's session dies and the OS
      // hands its EXACT pid to a brand-new session in tree B. `isMine` proves
      // B is not A (the `sessionStarted` tokens differ) — so
      // `assertNoForeignDrive` must not trust `leaseAlive`'s "yes" for A's
      // recycled pid: once that pid is B's OWN, `leaseAlive` answers "yes"
      // trivially, and B would be refused exit 13 for a full staleness
      // window over a rival that cannot exist (two processes cannot share one
      // pid on one host).
      const { a, b, env } = twoDrivers("pid-reuse-pr-wide-gate");
      const ea = {
        ...env,
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
      };
      expect(
        drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
      ).toBe(0);

      const eb = {
        ...env,
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
      };
      const r = drive(b, eb, ["bump-round", "999", "--head", "bbb"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("ANOTHER working tree");
    });

    it("reset admits and SWEEPS a foreign lease that merely shares this session’s recycled pid, instead of refusing or preserving it as live", () => {
      // End-to-end through BOTH call sites: `reset` is a leased command,
      // so tree B's claim meets the PR-wide gate first (as above), and only
      // then reaches `clearAllLeases`'s own `leaseAlive` check on tree A's
      // now-doubly-stale record. Either one alone trusting the recycled pid
      // would leave tree A's lease standing — refused at admission (exit 13),
      // or admitted and then reported as a live foreign lease to preserve.
      const { a, b, env } = twoDrivers("pid-reuse-reset-sweeps-recycled");
      const ea = {
        ...env,
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
      };
      expect(
        drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
      ).toBe(0);

      const eb = {
        ...env,
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
      };
      const r = drive(b, eb, ["reset", "999"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("ANOTHER working tree");
      expect(r.stderr).not.toContain("refusing to reset");

      // Tree A's lease is gone — recognized as dead, not preserved.
      expect(drive(a, ea, ["lease", "999"]).stdout.trim()).toBe("");
    });

    it("surfaces a failed lease enumeration instead of answering “no leases”", () => {
      // `[]` from `leaseFilesFor` is indistinguishable from "swept everything",
      // so swallowing an EACCES/EMFILE there would let `reset` report success
      // while every lease file stayed put — refusing later mutations for a
      // whole staleness window with nothing said about why.
      //
      // Staged as ENOTDIR — a state directory path that is a FILE — rather
      // than with `chmod 000`. Mode bits do not bite for root, so a
      // permission-based probe asserts nothing on a runner that happens to be
      // root: a one-line regression catching the error and returning `[]`
      // would stay green there. ENOTDIR needs no privilege to provoke and no
      // privilege to escape, so this reddens for every runner.
      const d = stateDirFor("lease-enum-fail");
      const notADir = join(d, "state-dir-is-a-file");
      writeFileSync(notADir, "not a directory\n");
      expect(() => leaseFilesFor(notADir, "999")).toThrow(/ENOTDIR/);
      // An ABSENT directory is a confirmed empty answer, not a failure.
      expect(leaseFilesFor(join(d, "nope"), "999")).toEqual([]);
    });
  });
});
