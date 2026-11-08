/**
 * drive-pr suite: drive.ts single-instance lock — lock rows, staleness and
 * recovery, release, and the account-identity rewrite.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { lockIdentity } from "../../../shared/liveness.ts";
import { driveDb } from "../scripts/lib/state/db.ts";
import {
  readLockRow,
  renewLockRow,
  takeLockRow,
} from "../scripts/lib/state/lock.ts";

import {
  SCRIPTS,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  gitCleanEnv,
  scratchClean,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  FAILING_RUN,
  type LockSlot,
  PASS_LOUD,
  claimsIn,
  lockHeld,
  plantClaim,
  pollUntil,
  awaitFixtureMarker,
  blockedPassScript,
  refuseDiagWrites,
  simulateTakeover,
  worktreeLockNameFor,
} from "./drive-loop-harness.ts";
import {
  deadPid,
  loginEnv,
  useTrackedTree,
} from "./drive-pr-pickup-fixtures.ts";
import { lockNames, lockRow } from "./state-rows.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

/** The account a driver lock's diagnostics name; `undefined` while it is not held or carries none. */
function lockAccount(slot: LockSlot): unknown {
  const row = lockRow(slot.stateDir, slot.name);
  if (row === null || row.detail === null) return undefined;
  return (JSON.parse(row.detail) as { account?: unknown }).account;
}

/** The account email a driver lock's diagnostics name, or `undefined`. */
function lockAccountEmail(slot: LockSlot): string | undefined {
  return (lockAccount(slot) as { account?: string } | undefined)?.account;
}

useDrivePrSuite();
const tree = useTrackedTree("drive-lock");

/** A file-backed login and a Claude executable the test controls. */
function accountDriverFixture() {
  const bin = mkdtempSync(join(tmpdir(), "drive-pr-claude-stub-"));
  const login = loginEnv("before@example.com");
  const config = login.CLAUDE_CONFIG_DIR;
  return {
    bin,
    login,
    config,
    path: join(config, ".claude.json"),
    writePass: (script: string) =>
      writeFakeProgram(join(bin, "claude"), script),
    blockUntilReleased: (dir: string) => {
      const startedMarker = join(dir, "claude-pass-started");
      const releaseMarker = join(dir, "claude-pass-release");
      writeFakeProgram(
        join(bin, "claude"),
        `#!/bin/sh\n${blockedPassScript(startedMarker, releaseMarker)}\n`,
      );
      return { startedMarker, releaseMarker };
    },
    spawn: (
      dir: string,
      stateDir: string,
      rounds: number,
      env: Record<string, string>,
    ) =>
      tree.spawn(
        dir,
        stateDir,
        [
          "--no-head-sync",
          "--max-rounds",
          String(rounds),
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          PATH: `${bin}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
          ...login,
          ...env,
        },
      ),
    cleanup: () => {
      rmSync(bin, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    },
  };
}

/** Run the pass until its release marker is written. */
function spawnBlockedPass(
  dir: string,
  stateDir: string,
  started: string,
  release: string,
  env: Record<string, string> = {},
) {
  return tree.spawn(
    dir,
    stateDir,
    [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      "sh",
      "-c",
      `: pass for 999\n${blockedPassScript(started, release)}`,
    ],
    env,
  );
}

/** Start a file-backed login's Claude pass and hold it at a release marker. */
function blockedAccountDriver(heartbeat: string) {
  const fixture = tree.fixture({
    threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
  });
  const account = accountDriverFixture();
  const markers = account.blockUntilReleased(fixture.dir);
  const proc = account.spawn(fixture.dir, fixture.stateDir, 1, {
    DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: heartbeat,
  });
  return { ...fixture, account, proc, ...markers };
}

describe("drive.ts loop control", () => {
  it("keeps suite transcript roots in scrubbed child environments", () => {
    const env = gitCleanEnv();
    for (const key of [
      "DRIVE_PR_CLAUDE_PROJECTS_DIR",
      "DRIVE_PR_CODEX_SESSIONS_DIR",
    ]) {
      const root = env[key];
      expect(root).toBe(process.env[key]);
      expect(typeof root).toBe("string");
      if (root === undefined) throw new Error(`missing suite root: ${key}`);
      expect(readdirSync(root)).toEqual([]);
    }
    expect(env.DRIVE_PR_TARGET).toBeUndefined();
  });

  describe("single-instance lock", () => {
    // Each failure mode is modelled by planting the exact lock row the
    // racing driver would have left behind.

    it("refuses when a LIVE driver holds the worktree lock — whatever PR it drives", async () => {
      // Keyed by worktree, not by PR: two drivers in one worktree cross-ship
      // each other's uncommitted edits regardless of target.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      // This process is unquestionably alive, and on this host.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const { stderr, exitCode } = await tree.run(dir, stateDir, [
        "--no-head-sync",
        "--",
        ...PASS_LOUD,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // Refused WITHOUT stealing it.
      expect(claimsIn(worktree)).toEqual(["claim.live0001"]);
      expect(lockRow(stateDir, worktree.name)?.pid).toBe(process.pid);
    });

    it("treats a FOREIGN-HOST owner as alive — its pid says nothing here", async () => {
      // `process.kill(pid, 0)` on another machine's pid answers a question
      // about an unrelated local process. Fail closed.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      // pid 999999 is almost certainly dead HERE; the hostname is what must
      // stop the takeover.
      plantClaim(worktree, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreign01",
      });

      const { stderr, exitCode } = await tree.run(dir, stateDir, [
        "--no-head-sync",
        "--",
        ...PASS_LOUD,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("some-other-host");
      expect(claimsIn(worktree)).toEqual(["claim.foreign01"]);
    });

    it("a LIVE pid that stopped refreshing is a recycled pid, not a driver", async () => {
      // `process.kill(pid, 0)` answers "some process holds this pid", not "the
      // driver is still running". After a driver dies the OS can hand its pid
      // to any unrelated long-lived process, and every later start then refuses
      // forever with no way out but a manual `rm`. A real driver refreshes each
      // round; a recycled pid never does, so an unrefreshed claim is
      // recoverable.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      // This process is unquestionably alive and on this host — exactly the
      // shape the refusal test above plants. The refresh age is what differs.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "stale0001",
        staleMs: 20 * 60_000,
      });

      const { stderr, exitCode } = await tree.run(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        {
          env: {
            // 5 minutes is the floor the clamp allows; the planted claim is
            // older than that and younger than the 6-hour default, so this
            // asserts the knob AND that the default would still have refused.
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
        },
      );
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      expect(stderr).toContain("recovered a stale");
    });

    it("a FRESH heartbeat on a live pid is still honoured", async () => {
      // The other half of the knob: recovery must key on "stopped refreshing",
      // never on age alone, or a long round hands a second driver the worktree.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "fresh0001",
      });

      const { stderr, exitCode } = await tree.run(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        {
          env: {
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
        },
      );
      expect(exitCode).toBe(11);
      expect(stderr).toContain("refusing to start a second loop");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("a lock whose holder is DEAD is recovered at once, without a wall-clock guess", async () => {
      // A holder whose pid is gone on this host cannot be driving, however
      // recently it renewed, so its lock is recovered on that evidence rather
      // than on its age: no staleness window has to pass first.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      // A fresh heartbeat, so only the holder's death can free the lock.
      plantClaim(worktree, {
        pid: await deadPid(),
        host: hostname(),
        nonce: "dead0001",
      });

      const { stderr, exitCode } = await tree.run(dir, stateDir, [
        "--no-head-sync",
        "--",
        ...PASS_LOUD,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      expect(stderr).toContain("recovered a stale");
      // Taken AND released: nothing is left for the next start.
      expect(lockHeld(worktree)).toBe(false);
    });

    it("releases only the lock INSTANCE it acquired", async () => {
      // After a stale recovery the lock belongs to the NEW owner. An
      // unconditional exit-time removal deletes that live lock and hands a
      // third driver the same worktree. Modelled by letting a drive take the
      // lock, then replacing its row with a successor's while the pass runs.
      //
      // This is also the release interleaving at full strength: the releasing
      // process is arbitrarily behind, its own acquisition long replaced, and
      // it still cannot reach the successor, because its release deletes the
      // row only while it carries this acquisition's token.
      const { dir, stateDir, worktree } = tree.fixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const started = join(dir, "pass-started");
      const release = join(dir, "pass-release");
      const proc = spawnBlockedPass(dir, stateDir, started, release, {});
      try {
        expect(await awaitFixtureMarker(started)).toBe(true);
        // pid 1 is alive and is definitively not this drive.
        plantClaim(worktree, { pid: 1, host: hostname(), nonce: "successor1" });
      } finally {
        writeFileSync(release, "");
      }
      await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The replacement survives the original owner's exit handler.
      expect(claimsIn(worktree)).toEqual(["claim.successor1"]);
      expect(lockRow(stateDir, worktree.name)?.pid).toBe(1);
    });

    /**
     * Plant a lock whose owner is alive but has stopped refreshing — the shape
     * every stale-recovery test needs. Returns the token it carries.
     */
    function plantStaleLock(slot: LockSlot, nonce: string): string {
      plantClaim(slot, {
        pid: process.pid,
        host: hostname(),
        nonce,
        staleMs: 20 * 60_000,
      });
      return nonce;
    }

    /** Everything left of `lock`: its row, and any file in the clone's state
     * directory named after it (a driver's process registry is one). */
    function lockResidue(lock: LockSlot): string[] {
      const files = existsSync(lock.stateDir)
        ? readdirSync(lock.stateDir).filter(
            (n) => n === lock.name || n.startsWith(`${lock.name}.`),
          )
        : [];
      return [
        ...lockNames(lock.stateDir).filter((n) => n === lock.name),
        ...files,
      ];
    }

    it("recovers a stale lock and leaves nothing behind", async () => {
      // A recovery replaces the stale holder's row in one statement, and the
      // release that follows deletes it: no quarantine, tombstone or sibling
      // file is left for anything to reclaim, however many recoveries a clone
      // sees.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      plantStaleLock(worktree, "stale0001");

      const { stderr, exitCode } = await tree.run(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        {
          env: {
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
        },
      );
      expect(exitCode).not.toBe(11);
      expect(stderr).toContain("recovered a stale");
      // The stale holder's row is gone, and so is everything else the
      // recovery could have left standing.
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("replaces only the holder it OBSERVED: of two contenders that saw one stale holder, one wins", () => {
      // Recovering a stale lock is a read, then a replace. Between the two,
      // another contender that saw the same stale holder can replace it
      // first; a replace that then went by the lock's NAME would overwrite
      // that live successor, and both would drive. The replace names the
      // token it observed, so the second contender finds a token it did not
      // see, takes nothing, and refuses rather than drives.
      const { stateDir, worktree } = tree.fixture({ threads: [] });
      plantStaleLock(worktree, "stale0001");
      const drive = driveDb(stateDir);
      const seen = readLockRow(drive, worktree.name);
      expect(seen?.token).toBe("stale0001");
      const take = (token: string) =>
        takeLockRow(drive, worktree.name, seen, {
          token,
          label: "drive.ts",
          holder: lockIdentity(),
          detail: null,
        });
      expect(take("successor3")).toBe(true);
      expect(take("latecomer1")).toBe(false);
      expect(claimsIn(worktree)).toEqual(["claim.successor3"]);
    });

    it("does not replace a holder that renewed after the decision to replace it", () => {
      const { stateDir, worktree } = tree.fixture({ threads: [] });
      plantStaleLock(worktree, "stale0002");
      const drive = driveDb(stateDir);
      const seen = readLockRow(drive, worktree.name);
      expect(renewLockRow(drive, worktree.name, "stale0002")).toBe(true);
      // The renewal may land in the same millisecond as the plant.
      drive.db.run(
        "UPDATE locks SET renewed_at = '2999-01-01T00:00:00.000Z' WHERE clone = ? AND name = ?",
        [drive.clone, worktree.name],
      );
      const took = takeLockRow(drive, worktree.name, seen, {
        token: "latecomer2",
        label: "drive.ts",
        holder: lockIdentity(),
        detail: null,
      });
      expect(took).toBe(false);
      expect(readLockRow(drive, worktree.name)?.token).toBe("stale0002");
    });

    it("leaves no lock residue however many times it runs", async () => {
      // The bound has to be structural, not a sweep. Three consecutive drives
      // are enough to show accumulation if anything accumulates at all.
      const { dir, stateDir, worktree, pr } = tree.fixture({ threads: [] });
      for (let round = 0; round < 3; round++) {
        const { exitCode } = await tree.run(dir, stateDir, [
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ]);
        expect(exitCode).not.toBe(11);
        // BOTH locks, every round: a drive holds one per worktree and one per
        // PR.
        expect(lockResidue(worktree)).toEqual([]);
        expect(lockResidue(pr)).toEqual([]);
      }
    });

    it("keys the WORKTREE lock by the tree, not by $DRIVE_PR_HANDOFF_DIR", async () => {
      // The worktree lock hung off `dirname(handoffPath())`, which that
      // variable moves. Two drivers in ONE checkout that set it differently —
      // or one that set it and one that did not — therefore computed different
      // worktree locks, and their per-PR locks did not collide either when
      // they drove different PRs, so both ran and cross-shipped each other's
      // uncommitted edits.
      const { dir, stateDir, worktree } = tree.fixture({ threads: [] });
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const { stderr, exitCode } = await tree.run(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        {
          env: {
            // A DIFFERENT handoff dir from the one the live holder used. Under
            // the old derivation this drive looked for its lock in here, found
            // nothing, and started a second loop in the same tree.
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff-elsewhere"),
          },
        },
      );
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree lock");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("renews a held claim DURING a pass, not only between rounds", async () => {
      // Refreshing once per round made a claim only as fresh as the round was
      // short — and a round runs an agent pass, the gates and sometimes a
      // Testbox. A pass that outlasts the window would let another start
      // recover the lock of a demonstrably live driver.
      const { dir, stateDir, worktree } = tree.fixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      // The loop still touches every lock once at the round boundary, just
      // before the pass. Sampling across THAT would pass with no timer at all
      // — measured: removing `startHeartbeat` left this test green. So the
      // pass announces itself, and the first sample is taken strictly after
      // the announcement, leaving the timer as the only thing that can move
      // the heartbeat inside the window.
      const started = join(dir, "pass-started");
      const release = join(dir, "pass-release");
      const proc = spawnBlockedPass(dir, stateDir, started, release, {
        // The renewal period is derived from the staleness window, whose
        // floor is five minutes; this seam is what makes the mechanism
        // observable in a test rather than in five minutes' time.
        DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
      });
      try {
        expect(await awaitFixtureMarker(started)).toBe(true);
        // The lock row's heartbeat is what the renewal moves, and its token
        // is what makes the renewal unable to touch a successor.
        const first = lockRow(stateDir, worktree.name);
        expect(first).not.toBeNull();
        // The pass stays running until released, so no round boundary falls
        // here.
        await Bun.sleep(800);
        const second = lockRow(stateDir, worktree.name);
        expect(second?.token).toBe(first?.token);
        expect(Date.parse(second?.renewed_at ?? "")).toBeGreaterThan(
          Date.parse(first?.renewed_at ?? ""),
        );
      } finally {
        // Same discipline as the sibling test below: a failed poll or
        // assertion above must not skip the kill and leave a live driver
        // running past this test.
        writeFileSync(release, "");
        proc.kill();
        await proc.exited;
      }
    }, 120000);

    it("holds a FILE-BACKED account identity steady for an ACTIVE pass, never overwriting it mid-pass with the account the next pass would use", async () => {
      // A resolved-once-at-arm-time account is correct for
      // CLAUDE_CODE_OAUTH_TOKEN (this process's own environment, fixed for
      // the drive's life) but wrong for oauthAccount/CODEX_HOME auth — LIVE
      // FILE CONTENT the pass re-reads on every fresh spawn. A login swap
      // mid-drive (an account-switching wrapper, or a manual /login) must not
      // leave the claim reporting the OLD account for the rest of the drive's
      // life — but neither may the claim be rewritten on a heartbeat tick
      // while a pass is running. The already-running child inherited the OLD
      // identity at its own spawn and keeps billing to it regardless of what
      // the file says now, so such a rewrite would display the NEXT pass's
      // account while the CURRENT one is still active. The claim must hold
      // the identity the running pass actually has.
      const { account, proc, startedMarker, releaseMarker, worktree } =
        blockedAccountDriver("100");

      try {
        expect(await awaitFixtureMarker(startedMarker)).toBe(true);

        const readAccount = (): unknown => {
          expect(lockHeld(worktree)).toBe(true);
          return lockAccount(worktree);
        };

        // The lock row is written with its diagnostics in one statement, so
        // by the time the pass's own marker file exists the lock is already
        // fully diagnosed.
        expect(readAccount()).toEqual({
          account: "before@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        });

        // Simulate a login swap: the file changes in place, independent of
        // this driver process's own environment — but the pass is still
        // actively running (blocked until the test releases it) and already
        // holds the OLD identity.
        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // Several heartbeat ticks past the 100ms refresh period above —
        // enough for the OLD, buggy code to have rewritten the claim already.
        await Bun.sleep(800);

        // Still the account the running pass actually inherited: the
        // heartbeat's account-refresh is gated on no pass being active, so a
        // file-backed change mid-pass does not touch the claim until this
        // pass exits.
        expect(readAccount()).toEqual({
          account: "before@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        });
      } finally {
        // Not protected by `try/finally` before this fix: a failed poll or
        // assertion above skipped both the kill and the cleanup below,
        // leaving a live driver plus its temp dirs to contaminate later
        // suite cases.
        writeFileSync(releaseMarker, "");
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    }, 120000);

    it("does not write a recovered lock via the account-identity rewrite", async () => {
      // A successor recovers this driver's lock in the same heartbeat tick a
      // file-backed identity change makes the driver want to rewrite its
      // diagnostics. The renewal finds the row no longer carries this
      // acquisition's token and stops the drive; the rewrite, addressed to the
      // same token, cannot write the successor's row either.
      const {
        account,
        proc,
        startedMarker,
        releaseMarker,
        stateDir,
        worktree,
      } = blockedAccountDriver("100");

      try {
        expect(await awaitFixtureMarker(startedMarker)).toBe(true);

        // Both land together, with no await between them, so the very next
        // heartbeat tick sees an account change AND a replaced lock.
        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );
        simulateTakeover(worktree, "successor01");

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("stopping the active pass");
        expect(stderr).toContain("recovered by another driver");

        // Only the successor holds the lock, and its row carries none of
        // this driver's diagnostics: the rewrite never landed on it.
        expect(claimsIn(worktree)).toEqual(["claim.successor01"]);
        expect(lockRow(stateDir, worktree.name)?.detail).toBeNull();
      } finally {
        writeFileSync(releaseMarker, "");
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    }, 120000);

    it("refreshes a FILE-BACKED account identity synchronously the moment a pass exits, not only on the next heartbeat tick", async () => {
      // Clearing `activePass` reopens the exact window `refreshAccountIdentity`'s
      // own gate exists for. Refreshing only on the heartbeat's OWN timer
      // would leave a credential file that changed mid-pass stale until the
      // next tick fired, and the loop could spawn the very next pass against
      // it first if it moved fast enough. The
      // heartbeat interval below is deliberately far longer than this test's
      // own lifetime, so a refreshed claim here can only be the pass-exit
      // refresh, never the timer.
      const { dir, stateDir, worktree } = tree.fixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });

      const account = accountDriverFixture();
      const startedMarker = join(dir, "claude-pass-started");
      account.writePass(
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
      );

      const proc = account.spawn(dir, stateDir, 1, {
        // Far longer than this test ever runs — isolates the pass-exit
        // refresh from the heartbeat's own.
        DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "600000",
      });

      try {
        expect(await awaitFixtureMarker(startedMarker)).toBe(true);

        // Change the file-backed identity while the pass is still asleep —
        // the running pass keeps billing to the OLD one regardless.
        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // Poll well past the pass's own 1s sleep but far short of the
        // heartbeat configured above: a refresh observed here is the
        // pass-exit path, not the timer. A lock already released (a driver
        // that never refreshed it) reads as no account, never as a crash.
        let refreshed = false;
        for (let i = 0; i < 400 && !refreshed; i++) {
          refreshed = lockAccountEmail(worktree) === "after@example.com";
          if (!refreshed) await Bun.sleep(25);
        }
        expect(refreshed).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    }, 120000);

    it("refreshes a FILE-BACKED account identity after a CI-repair pass too, not only after an ordinary one", async () => {
      // `runRepairPass` must call `refreshAccountIdentity` once its own
      // spawned pass exits, not only touch the locks — the same post-pass
      // window the sibling test above covers for the ORDINARY pass path. The
      // CI-repair budget (2 here) lets the loop re-gate and dispatch a SECOND
      // repair pass well inside one heartbeat interval, so a login swap
      // during the first repair pass could bill the second one to the stale
      // account. The heartbeat interval below is far longer than this test
      // ever runs, so a refreshed claim here can only be the post-repair-pass
      // call.
      //
      // Synchronized on the SECOND pass's own start marker rather than on
      // polling the lock for the swapped value after the FIRST pass
      // exits: `runRepairPass` returning is not the same instant as the
      // driver's own subsequent lock release on exit, and polling after the
      // fact can lose that race under load without the code being wrong.
      // `runRepairPass` calls `refreshAccountIdentity` and returns
      // SYNCHRONOUSLY before the caller ever re-gates and dispatches a second
      // pass, so the second pass's own marker appearing is proof the refresh
      // already landed — no polling race against process teardown required.
      const { dir, stateDir } = writeFixture(
        {
          threads: [],
          head: scratchClean.head,
          reviewedSha: scratchClean.head,
          checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
        },
        scratchClean.dir,
      );
      // The driver below runs with `cwd: scratchClean.dir`, so its own
      // worktree-lock name is keyed off THAT tree — see
      // `worktreeLockNameFor`'s own comment.
      const worktree: LockSlot = {
        stateDir,
        name: await worktreeLockNameFor(scratchClean.dir),
      };

      const account = accountDriverFixture();
      const firstMarker = join(dir, "claude-pass-started-1");
      const secondMarker = join(dir, "claude-pass-started-2");
      // First invocation touches `firstMarker`; every invocation after that
      // touches `secondMarker` — so the SECOND marker's existence is proof a
      // second pass was actually dispatched, not merely that the script ran
      // twice for some other reason.
      account.writePass(
        `#!/bin/sh\nif [ -e ${JSON.stringify(firstMarker)} ]; then : > ${JSON.stringify(secondMarker)}; else : > ${JSON.stringify(firstMarker)}; fi\nsleep 1\nexit 0\n`,
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--keep-draft",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ),
        {
          // The fixture's `reviewedSha`/`head` are `scratchClean.head` — a
          // real SHA in the SCRATCH repo, not this test process's own cwd.
          // `certifyFinalWorktree`'s post-convergence `git rev-parse HEAD`
          // reads whatever `cwd` the driver runs in, so without this it
          // reads the ACTUAL repo checkout the suite itself is running from
          // and refuses on a HEAD mismatch before ever reaching the
          // CI-repair branch below.
          cwd: scratchClean.dir,
          env: {
            ...gitCleanEnv(),
            PATH: `${account.bin}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // `worktreeLockName()`/`worktreeKey()` fall back to the ambient
            // cwd's own `git --show-toplevel` when this is unset — which
            // for this spawn is `scratchClean.dir`, NOT the real repo this
            // test file's own `WORKTREE_LOCK` constant was computed against
            // at module load. Without this, `lockDirs()`'s `worktree` path
            // names a lock the driver never creates, and every claim read
            // against it fails closed to "absent" for the whole run — not a
            // timing race, a permanent path mismatch.
            DRIVE_PR_WORKTREE: scratchClean.dir,
            ...account.login,
            DRIVE_PR_CI_REPAIR_ROUNDS: "2",
            // Far longer than this test ever runs — isolates the post-repair
            // refresh from the heartbeat's own, same as the sibling test above.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        // Generous relative to local timings (a few hundred ms per gate
        // round-trip): this fixture's CONVERGED path runs several subprocess
        // round-trips (a real `certifyFinalWorktree` git call, mark-ready.ts,
        // a CI-verdict check) before EACH repair pass, remote-host load
        // included.
        const started = await pollUntil(() => existsSync(firstMarker), 800);
        expect(started).toBe(true);

        // Change the file-backed identity while the first repair pass is
        // still asleep — the running pass keeps billing to the OLD one
        // regardless.
        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // Poll for the refreshed claim RIGHT AWAY, rather than waiting for
        // the second pass's own marker first: `runRepairPass` calls
        // `refreshAccountIdentity` and returns synchronously as soon as the
        // FIRST repair pass exits (~1s away, its own sleep), and the driver
        // dispatches the second repair pass only AFTER that return — so the
        // refreshed value is live, and the lock is still held, in the window
        // between the first pass exiting and the second one starting. That
        // window is real but narrow: in this fixture (stubbed `gh`/`git`,
        // no network) the whole remaining run — second pass, re-gate, budget
        // exhaustion, exit, lock release — completes in well under a
        // second, so waiting for the SECOND marker first means the read
        // arrives after the driver, and every lock it held, is already gone.
        // Polling from here catches the value while the first pass's own
        // return is the freshest thing that happened.
        const seenValues: unknown[] = [];
        const refreshed = await pollUntil(() => {
          const v = lockAccountEmail(worktree);
          seenValues.push(v);
          return v === "after@example.com";
        }, 400);
        if (!refreshed) {
          console.error("DEBUG seenValues (unique):", [...new Set(seenValues)]);
          console.error("DEBUG worktree lock held:", lockHeld(worktree));
          console.error(
            "DEBUG claimsIn now:",
            (() => {
              try {
                return claimsIn(worktree);
              } catch (e) {
                return String(e);
              }
            })(),
          );
          console.error(
            "DEBUG stderr:",
            await new Response(proc.stderr).text(),
          );
        }
        expect(refreshed).toBe(true);

        // The second repair pass's own marker is written at process start
        // and never cleaned up by the stub, so — unlike the lock row — it
        // is safe to check after the fact, however far the driver has since
        // progressed: it proves the CI-repair loop actually dispatched a
        // second pass (consuming the refreshed identity just observed)
        // rather than the fix being exercised by a path that never re-spawns.
        const secondStarted = await pollUntil(
          () => existsSync(secondMarker),
          400,
        );
        expect(secondStarted).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
      // Explicit, matching the CI-repair block's own convention (e.g. line
      // ~20765): two repair-pass round-trips, each with its own generous
      // poll budget, can approach the suite's default per-test budget under
      // load, and a bare `bun test` invocation elsewhere defaults to bun's
      // own 5s, not this file's `--timeout 30000`.
    }, 45000);

    it("spawns the next pass anyway once every pre-spawn identity-rewrite retry is exhausted, warning about a possibly-stale display rather than blocking on a DISPLAY value", async () => {
      // This is deliberate (see the pre-spawn retry loop's own comment in
      // drive.ts): a store stuck longer than the bounded retries must not stop
      // the drive from ever spawning another pass over what is only ever a
      // DISPLAY value. This test covers the fall-through that decision
      // actually produces — every retry exhausted, and the pass spawns anyway
      // with the stale-display warning on stderr. A stuck store is modelled by
      // making both locks refuse their diagnostics rewrite while round 1's
      // pass is still running — the pass waits for it, so there is no timing
      // race against the driver — then round 2 must still spawn.
      const { dir, stateDir, worktree, pr } = tree.fixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });

      const account = accountDriverFixture();
      const passCountFile = join(dir, "pass-count");
      const round1Marker = join(dir, "round1-started");
      const blockedMarker = join(dir, "rewrites-refused");
      const round2Marker = join(dir, "round2-started");

      // Round 1 changes the login, announces itself and waits (bounded) for
      // the test to refuse the rewrites before it exits; round 2 announces
      // itself.
      account.writePass(
        `#!/bin/sh
n=$(( $(cat ${JSON.stringify(passCountFile)} 2>/dev/null || echo 0) + 1 ))
echo "$n" > ${JSON.stringify(passCountFile)}
if [ "$n" = "1" ]; then
  printf '%s' '{"oauthAccount":{"emailAddress":"after@example.com"}}' > ${JSON.stringify(account.path)}
  : > ${JSON.stringify(round1Marker)}
  i=0
  while [ ! -e ${JSON.stringify(blockedMarker)} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
else
  : > ${JSON.stringify(round2Marker)}
fi
exit 0
`,
      );

      const proc = account.spawn(dir, stateDir, 2, {
        // Far longer than this test ever runs — only the pre-spawn retry
        // loop and the pass-exit refresh should ever try the refused
        // rewrite, never the heartbeat timer.
        DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
        // The single fixture thread is never resolved by either stub
        // invocation, so both rounds report an identical fingerprint —
        // disabled here because this probe's subject is the identity
        // fallback, not the (separately covered) stall-stop behavior.
        DRIVE_PR_STALL_ROUNDS: "0",
      });

      const allow: (() => void)[] = [];
      try {
        expect(await awaitFixtureMarker(round1Marker)).toBe(true);
        allow.push(refuseDiagWrites(worktree), refuseDiagWrites(pr));
        writeFileSync(blockedMarker, "");
        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(6);
        expect(stderr).toContain(
          "the account-identity claim rewrite did not land before this spawn — proceeding with a possibly-stale display",
        );
        // The exhausted retries did not block the round loop: round 2 still
        // spawned its own pass.
        expect(existsSync(round2Marker)).toBe(true);
      } finally {
        for (const lift of allow) lift();
        writeFileSync(blockedMarker, "");
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    }, 60000);

    it("notices at the pass-exit rewrite a takeover that landed during the pass, and leaves the successor's lock alone", async () => {
      // With the heartbeat timer far out of reach, nothing ticks while the
      // pass runs, so a successor that recovers this driver's lock during the
      // pass is first met by the rewrite that runs the moment the pass exits.
      // That rewrite is addressed to this acquisition's token: it must read
      // the replaced row as the takeover it is, stop the drive, and write
      // nothing into the successor's row.
      const {
        account,
        proc,
        startedMarker,
        releaseMarker,
        stateDir,
        worktree,
      } = blockedAccountDriver("60000");

      try {
        expect(await awaitFixtureMarker(startedMarker)).toBe(true);

        // A successor on another host recovers the lock while the pass runs.
        plantClaim(worktree, {
          pid: 999999,
          host: "ghost-host",
          nonce: "ghost01",
        });

        // Give the pass-exit rewrite something to write.
        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );
        // Only now may the pass exit: its exit is what runs the rewrite.
        writeFileSync(releaseMarker, "");

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("recovered by another driver");

        // The successor still holds the lock, its row untouched by the
        // rewrite and by this driver's release.
        expect(claimsIn(worktree)).toEqual(["claim.ghost01"]);
        const row = lockRow(stateDir, worktree.name);
        expect(row?.host).toBe("ghost-host");
        expect(row?.detail).toBeNull();
      } finally {
        writeFileSync(releaseMarker, "");
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    }, 120000);

    it("retries every held lock independently, not just the first one to reach `fresh`", async () => {
      // Comparing `fresh` against only the FIRST lock with a diag, and
      // returning once THAT ONE matched, would leave a sibling lock's own
      // failed rewrite permanently unretried: the next tick's shared check
      // sees the first lock already agreeing with `fresh` and never looks at
      // the second lock again. Make the PR lock refuse its diagnostics
      // rewrite (a stand-in for any write that fails on that lock alone)
      // while the worktree lock stays writable, trigger a real account
      // change, and confirm the PR lock still catches up once the refusal is
      // lifted.
      const { dir, stateDir, worktree, pr } = tree.fixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });

      const account = accountDriverFixture();
      const startedMarker = join(dir, "claude-pass-started");
      account.writePass(
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
      );

      const proc = account.spawn(dir, stateDir, 1, {
        // Short enough that several ticks land in the window between
        // the pass exiting and this process deciding it has hit
        // --max-rounds — the retry has to survive more than one tick.
        DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "10",
      });

      let allowPr: (() => void) | null = null;
      try {
        const running = await pollUntil(() => existsSync(startedMarker), 400);
        expect(running).toBe(true);

        // Refuse the PR lock's rewrite while the pass sleeps.
        allowPr = refuseDiagWrites(pr);

        // Confirm the refusal actually fails the driver's own rewrite
        // statement before trusting it as the failure injection below, or
        // both locks would catch up at once and every assertion past this
        // point would hold whether or not each lock retries on its own.
        const held = lockRow(stateDir, pr.name);
        expect(held).not.toBeNull();
        expect(() =>
          renewLockRow(
            driveDb(stateDir),
            pr.name,
            held?.token ?? "",
            held?.detail ?? "{}",
          ),
        ).toThrow();

        writeFileSync(
          account.path,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        // The worktree lock is writable throughout, so it should catch up
        // even though the PR lock cannot.
        const worktreeCaughtUp = await pollUntil(
          () => lockAccountEmail(worktree) === "after@example.com",
          400,
          10,
        );
        expect(worktreeCaughtUp).toBe(true);
        expect(lockAccountEmail(pr)).toBe("before@example.com");

        // Lift the refusal and confirm the PR lock ALSO catches up: a lock
        // that missed one rewrite keeps retrying on every later tick rather
        // than being masked by a sibling lock that already agrees with
        // `fresh`.
        allowPr();
        allowPr = null;

        const prCaughtUp = await pollUntil(
          () => lockAccountEmail(pr) === "after@example.com",
          400,
          10,
        );
        expect(prCaughtUp).toBe(true);
      } finally {
        allowPr?.();
        proc.kill();
        await proc.exited;
        account.cleanup();
      }
    });
  });
});
