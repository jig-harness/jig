/**
 * drive-pr suite: drive.ts single-instance lock — claims, staleness and
 * recovery, staging-directory reclaim, and the account-identity rewrite.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  SCRIPTS,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  scratchClean,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  FAILING_RUN,
  PASS_LOUD,
  claimsIn,
  lockDirs,
  plantClaim,
  pollUntil,
  simulateTakeover,
  worktreeLockNameFor,
} from "./drive-loop-harness.ts";

useDrivePrSuite();

describe("drive.ts loop control", () => {
  describe("single-instance lock", () => {
    // Three failure modes, each modelled by planting
    // the exact directory state the racing driver would have left behind.

    it("refuses when a LIVE driver holds the worktree lock — whatever PR it drives", async () => {
      // Keyed by worktree, not by PR: two drivers in one worktree cross-ship
      // each other's uncommitted edits regardless of target.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // This process is unquestionably alive, and on this host.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // Refused WITHOUT stealing it.
      expect(readFileSync(join(worktree, "claim.live0001"), "utf8")).toContain(
        `${process.pid}`,
      );
    });

    it("treats a FOREIGN-HOST owner as alive — its pid says nothing here", async () => {
      // `process.kill(pid, 0)` on another machine's pid answers a question
      // about an unrelated local process. Fail closed.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // pid 999999 is almost certainly dead HERE; the hostname is what must
      // stop the takeover.
      plantClaim(worktree, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreign01",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("some-other-host");
      expect(existsSync(join(worktree, "claim.foreign01"))).toBe(true);
    });

    it("a LIVE pid that stopped refreshing is a recycled pid, not a driver", async () => {
      // `process.kill(pid, 0)` answers "some process holds this pid", not "the
      // driver is still running". After a driver dies the OS can hand its pid
      // to any unrelated long-lived process, and every later start then refuses
      // forever with no way out but a manual `rm`. A real driver refreshes each
      // round; a recycled pid never does, so an unrefreshed claim is
      // recoverable.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      // This process is unquestionably alive and on this host — exactly the
      // shape the refusal test above plants. The refresh age is what differs.
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "stale0001",
        staleMs: 20 * 60_000,
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // 5 minutes is the floor the clamp allows; the planted claim is
            // older than that and younger than the 6-hour default, so this
            // asserts the knob AND that the default would still have refused.
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      expect(stderr).toContain("recovered a stale");
    });

    it("a FRESH heartbeat on a live pid is still honoured", async () => {
      // The other half of the knob: recovery must key on "stopped refreshing",
      // never on age alone, or a long round hands a second driver the worktree.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "fresh0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("refusing to start a second loop");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("an OWNERLESS lock is debris, taken over without a wall-clock guess", async () => {
      // The old code called an ownerless lock "probably a starting winner" if
      // its mtime was under 2s — a guess a shared or network-backed handoff
      // dir does not honour, and the one that let a contender delete a live
      // winner's lock. Publication is atomic now, so an ownerless lock can
      // only be debris and is taken over on its emptiness, not its age.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      mkdirSync(worktree, { recursive: true });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      // Taken AND released: nothing debris-shaped is left for the next start.
      expect(existsSync(worktree)).toBe(false);
    });

    it("releases only the lock INSTANCE it acquired", async () => {
      // After a stale recovery the directory belongs to the NEW owner. An
      // unconditional exit-time `rmSync` deletes that live lock and hands a
      // third driver the same worktree. Modelled by letting a drive take the
      // lock, then replacing it with a foreign one before the drive exits —
      // the pass command is what does the replacing, mid-run.
      //
      // This is also the release interleaving at full strength: the releasing
      // process is arbitrarily behind, its own generation long retired, and it
      // still cannot reach the successor, because the only name it removes is
      // its own claim and the `rmdir` behind it refuses a directory that is
      // not empty.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const q = JSON.stringify;
      const swap = [
        "sh",
        "-c",
        // pid 1 is alive and is definitively not this drive. 999 in the text
        // satisfies drive.ts's pass-targeting guard.
        `: pass for 999; rm -rf ${q(worktree)} && mkdir -p ${q(worktree)} && printf '1 %s\\n' ${q(hostname())} > ${q(join(worktree, "claim.successor1"))}; exit 0`,
      ];
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...swap,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The replacement survives the original owner's exit handler — claim and
      // directory both.
      expect(claimsIn(worktree)).toEqual(["claim.successor1"]);
      expect(
        readFileSync(join(worktree, "claim.successor1"), "utf8").trim(),
      ).toStartWith("1 ");
    });

    /**
     * Plant a lock whose owner is alive but has stopped refreshing — the shape
     * every stale-recovery test needs. Returns the generation it carries.
     */
    function plantStaleLock(dirPath: string, nonce: string): string {
      plantClaim(dirPath, {
        pid: process.pid,
        host: hostname(),
        nonce,
        staleMs: 20 * 60_000,
      });
      return nonce;
    }

    /** Everything in the state dir derived from `lock` — the lock itself, and
     * any sibling a quarantine, tombstone or staging directory would occupy. */
    function lockResidue(lock: string): string[] {
      const base = basename(lock);
      return readdirSync(dirname(lock)).filter(
        (n) => n === base || n.startsWith(`${base}.`),
      );
    }

    it("recovers a stale lock and leaves NO quarantine behind", async () => {
      // The fence used to be a quarantine that had to stay permanently
      // non-empty, because a contender still holding an observation of
      // generation N aimed a `rename` at `<lock>.stale.<N>` and an empty one
      // is a destination `rename` accepts. So every recovery — and every
      // release — left a directory nothing could ever reclaim, two per drive
      // run, growing with lifetime invocations.
      //
      // Retirement names the generation it removes rather than the path it
      // sits at, so a stale actor's removal is a no-op instead of something
      // that has to be fenced, and there is nothing left to keep.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantStaleLock(worktree, "stale0001");

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).toContain("recovered a stale");
      // The retired generation is gone, and so is everything else the recovery
      // could have left standing.
      expect(lockResidue(worktree)).toEqual([]);
    });

    // `mkfifo` is a POSIX utility with no Windows equivalent, and the skill's
    // own runtime contract states Windows support (SKILL.md's runtime
    // section) — so this one test, which needs a FIFO to force the
    // rename interleaving deterministically, cannot run there without
    // failing the suite before it exercises anything. Skipped rather than
    // reimplemented
    // on a cross-platform primitive: every OTHER test in this file is
    // already portable, and the interleaving this one exists to force can
    // still be reasoned about from the code's own generation-naming
    // argument (see `retire`'s doc) even where it cannot be reproduced.
    (process.platform === "win32" ? it.skip : it)(
      "retires the generation it OBSERVED, never the path it sits at",
      async () => {
        // The rename interleaving, made deterministic. Contender A quarantined
        // a stale lock by PATH and installed a live replacement; contender B,
        // still holding its observation of the same stale generation, renamed by
        // path too — and what it moved was A's live lock, so both drove.
        // Fencing the rename's DESTINATION closes that at the price of a
        // tombstone nothing can reclaim. Naming the SOURCE closes it with
        // nothing left over, and this is the property that makes it work: a
        // retirement removes what the observation listed and NOTHING else.
        //
        // Observing and retiring are normally two adjacent syscalls, which is
        // why the interleaving could not be hit from outside before. A FIFO in
        // the claim's place opens the gap arbitrarily wide: the listing is taken
        // first, then the record's read blocks until this test writes to it. A
        // successor planted while the drive is parked there is in the directory
        // and absent from the observation — exactly the asymmetry a path-keyed
        // retirement erases.
        const { dir, stateDir } = writeFixture({ threads: [] });
        const { worktree } = lockDirs(dir, stateDir);
        mkdirSync(worktree, { recursive: true });
        const fifo = join(worktree, "claim.stale0001");
        execFileSync("mkfifo", [fifo]);

        const proc = Bun.spawn(
          [
            join(SCRIPTS, "drive.ts"),
            "999",
            "--no-head-sync",
            "--",
            ...PASS_LOUD,
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              DRIVE_PR_STATE_DIR: stateDir,
              DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        // A non-blocking open for writing succeeds only once a reader holds the
        // FIFO, which is strictly after the drive listed the directory.
        let fd = -1;
        for (let i = 0; i < 400 && fd < 0; i++) {
          try {
            fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
          } catch {
            await Bun.sleep(25);
          }
        }
        expect(fd).toBeGreaterThan(0);
        writeFileSync(join(worktree, "claim.successor3"), `1 ${hostname()}\n`);
        // pid 999999 is dead on THIS host, so the observed generation reads as
        // recoverable and the drive goes on to retire it.
        writeSync(fd, `999999 ${hostname()}\n`);
        closeSync(fd);

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        // Retiring what it observed leaves the successor's claim in place, so
        // the lock is not an empty slot and this drive loses the race rather
        // than joining it.
        expect(claimsIn(worktree)).toEqual(["claim.successor3"]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("recovered the same stale lock first");
        expect(stderr).not.toContain("RAN_THE_PASS");
      },
    );

    it("leaves no lock residue however many times it runs", async () => {
      // The bound has to be structural, not a sweep: growth used to be
      // proportional to lifetime drive invocations, two directories at a time,
      // with no reclamation. Three consecutive drives are enough to
      // show accumulation if anything accumulates at all.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree, pr } = lockDirs(dir, stateDir);
      for (let round = 0; round < 3; round++) {
        const proc = Bun.spawn(
          [
            join(SCRIPTS, "drive.ts"),
            "999",
            "--no-head-sync",
            "--",
            ...PASS_LOUD,
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              DRIVE_PR_STATE_DIR: stateDir,
              DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).not.toBe(11);
        // BOTH locks, every round: a drive holds one per worktree and one per
        // PR, and the old design left a tombstone for each.
        expect(lockResidue(worktree)).toEqual([]);
        expect(lockResidue(pr)).toEqual([]);
      }
    });

    it("reclaims a staging directory orphaned by a crash before the publishing rename", async () => {
      // `takeLock` publishes into `<lock>.<pid>.<host>.staging` before the
      // rename that installs it. A crash in that window used to be bounded
      // only by "that exact pid retries this exact lock" — on a long-lived
      // clone a pid is not guaranteed to be reused for the same lock ever
      // again, so the artifact was unbounded in practice, contradicting the
      // "creates no artifact it does not remove" acceptance criterion.
      // `sweepStaleStaging` closes it: ANY later acquire on this lock, by any
      // pid, reclaims a sibling staging directory once its recorded owner is
      // confirmed gone — modelled here by planting one under a pid that is
      // dead on this host, WITH its claim file written (the crash landed
      // between writeFileSync and renameSync).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const orphanedStaging = `${worktree}.999999.${hostname()}.staging`;
      plantClaim(orphanedStaging, {
        pid: 999999,
        host: hostname(),
        nonce: "orphaned1",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      // The orphan is gone, and so is this run's own lock — nothing left
      // standing under either name.
      expect(existsSync(orphanedStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("reclaims a staging directory crashed BEFORE its claim was ever written", async () => {
      // The narrower gap `sweepStaleStaging`'s claim-file read cannot answer
      // for: a crash between `mkdirSync(staging)` and `writeFileSync` leaves
      // an EMPTY staging directory, with no claim inside to read pid/host
      // from. `stagingDirFor` encodes both into the directory's own NAME,
      // independent of whether the write inside it ever completed, which is
      // what closes this gap too.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const emptyStaging = `${worktree}.999999.${hostname()}.staging`;
      mkdirSync(emptyStaging, { recursive: true }); // no claim file inside

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(emptyStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("reclaims a staging directory whose pid merely READS as alive — pid reuse cannot make it immortal", async () => {
      // `pidAlive` alone is not enough for staging the way it is for the main
      // lock: the main lock falls back to heartbeat staleness when a pid
      // answers but the OWNER never refreshes, closing the pid-reuse hazard
      // `HEARTBEAT_STALE_MIN_DEFAULT` documents. Staging has no heartbeat to
      // fall back to — so without an age-based fallback of its own, a
      // recycled pid makes the sweep's liveness check say "alive" forever,
      // and the directory is never reclaimed: the exact unbounded-artifact
      // failure this whole mechanism exists to close, just via pid reuse
      // instead of "no one ever retries." Modelled with this test's own
      // (unquestionably alive) pid, backdated well past `STAGING_STALE_MS`.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const recycledStaging = `${worktree}.${process.pid}.${hostname()}.staging`;
      plantClaim(recycledStaging, {
        pid: process.pid,
        host: hostname(),
        nonce: "recycled1",
      });
      const oldMs = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(recycledStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(recycledStaging)).toBe(false);
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("leaves a FRESH staging directory alone even though its pid is unrelated to this drive", async () => {
      // The other half of the age fallback: a staging directory that is
      // merely YOUNG must not be swept just because SOME live pid happens to
      // own it — only age is what distinguishes "legitimately mid-publish"
      // from "recycled pid, actually abandoned." Modelled the same way as the
      // pid-reuse test above, minus the backdating.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const freshStaging = `${worktree}.${process.pid}.${hostname()}.staging`;
      plantClaim(freshStaging, {
        pid: process.pid,
        host: hostname(),
        nonce: "fresh02",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(freshStaging)).toBe(true);
    });

    it("leaves a FOREIGN-HOST staging directory alone — its pid says nothing here", async () => {
      // The same fail-closed rule `claimAlive` applies to a real lock: a pid
      // from another host is unanswerable, so sweeping it on liveness alone
      // would risk destroying a live contender's in-flight publish on a
      // shared or network-backed state dir.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const foreignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(foreignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreign02",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(foreignStaging)).toBe(true);
    });

    it("leaves a MERELY-OLD FOREIGN-HOST staging directory alone — clock skew must not delete it", async () => {
      // `pidAlive` returns `true` for a foreign host as a fail-OPEN default
      // for an unanswerable question, not as confirmed evidence the age
      // fallback may then override. An earlier cut applied the age check to
      // every entry `pidAlive` didn't positively rule dead using the SAME
      // short `STAGING_STALE_MS` window as the same-host case — so a foreign
      // publisher merely slow for a few minutes, or a shared mount with
      // ordinary clock skew, would have its live staging directory deleted.
      // Modelled with a foreign-host directory backdated past
      // `STAGING_STALE_MS` but well inside the default `heartbeatStaleMs()`
      // window the fix now uses for a foreign host instead.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const oldForeignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(oldForeignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreignold1",
      });
      const oldMs = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(oldForeignStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(oldForeignStaging)).toBe(true);
    });

    it("eventually reclaims a foreign-host staging directory — cross-host residue is bounded, not permanent", async () => {
      // Leaving EVERY foreign-host entry unreclaimed forever would close the
      // clock-skew guess but reopen the unboundedness this
      // whole mechanism exists to close, just scoped to cross-host residue —
      // every crashed foreign publisher would leave a permanent directory,
      // contradicting the PR's own structural-bound claim. The fix reuses
      // the SAME mechanism the main lock already relies on for the SAME
      // cross-host/clock-skew uncertainty: `heartbeatStaleMs()`, far longer
      // than `STAGING_STALE_MS` but finite. Modelled the same way the main
      // lock's own staleness test is (`DRIVE_PR_LOCK_HEARTBEAT_MIN` at the
      // 5-minute floor), backdated past it.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      const oldForeignStaging = `${worktree}.999999.some-other-host.staging`;
      plantClaim(oldForeignStaging, {
        pid: 999999,
        host: "some-other-host",
        nonce: "foreignold2",
      });
      const oldMs = (Date.now() - 20 * 60_000) / 1000;
      utimesSync(oldForeignStaging, oldMs, oldMs);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(existsSync(oldForeignStaging)).toBe(false);
    });

    it("retires a lock left behind by a drive.ts older than the claim protocol", async () => {
      // `pid` + `heartbeat` is the shape the tombstone-era lock had. It names
      // no generation, so it is debris — and debris that nothing removes would
      // wedge the slot for ever, since `rename` refuses a non-empty
      // destination. Retirement removes exactly the entries it observed, which
      // is what keeps a lock recoverable from ANY state a crash or an older
      // version can leave it in. Unconditionally: backward compatibility is
      // deferred pre-GA, so this file owes the old
      // format no liveness check either — a legacy `pid`/`heartbeat` pair is
      // debris whether its recorded pid is dead (999999, planted here) or, in
      // principle, still running (a liveness check for this exact shape would
      // add the second lock-format parser deferring backward compatibility
      // exists to avoid).
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, "pid"), `999999 ${hostname()} legacy01\n`);
      writeFileSync(
        join(worktree, "heartbeat"),
        `999999 ${hostname()} legacy01\n`,
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).not.toBe(11);
      expect(stderr).not.toContain("refusing to start a second loop");
      // Taken over AND released — the legacy entries are gone, not wedging the
      // slot as a destination `rename` would refuse.
      expect(lockResidue(worktree)).toEqual([]);
    });

    it("refuses a lock holding two claims rather than guessing which is live", async () => {
      // Unreachable by construction — an instance is installed whole, by
      // rename — but retirement removes what it observed, so a wrong guess
      // here would remove a LIVE claim and hand out the worktree twice. The
      // fail-closed direction costs a refusal a human clears in one command.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantStaleLock(worktree, "stale0001");
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "stale0002",
        staleMs: 20 * 60_000,
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_MIN: "5",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("2 claims at once");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // And it removed neither.
      expect(claimsIn(worktree).sort()).toEqual([
        "claim.stale0001",
        "claim.stale0002",
      ]);
    });

    it("a release cannot reach the generation that RECOVERED it", async () => {
      // Release used to move the lock to a private `.releasing.<nonce>` name.
      // A private destination is always free, so the rename always succeeded —
      // and a process suspended past the staleness window, its lock recovered
      // and the path now holding a SUCCESSOR's live lock, moved that successor
      // aside and left the canonical path briefly empty for a third driver.
      //
      // The read-to-rename gap is two adjacent syscalls, so it cannot be hit
      // deterministically from outside the process — and it no longer has to
      // be, because there is no longer a read. Release removes one NAME, its
      // own, so what a suspended releaser can reach is decided by the state of
      // the directory rather than by how recently it ran. The pass therefore
      // plants exactly what a recovery leaves — this generation's claim gone,
      // a successor's in its place — and the release runs against that.
      //
      // `rm -rf` is deliberately NOT used: the directory itself has to survive
      // too, or the `rmdir` behind the removal empties the slot a live driver
      // is holding.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const q = JSON.stringify;
      const plant = [
        "sh",
        "-c",
        // 999 in the text satisfies drive.ts's pass-targeting guard. pid 1 is
        // alive and is definitively not this drive.
        `: pass for 999; rm -f ${q(worktree)}/claim.*; printf '1 %s\\n' ${q(hostname())} > ${q(join(worktree, "claim.successor2"))}; exit 0`,
      ];
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...plant,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      // The successor still holds the canonical path. Under `.releasing.
      // <nonce>` this directory was gone — precisely the moment a third driver
      // walks in.
      expect(claimsIn(worktree)).toEqual(["claim.successor2"]);
    });

    it("keys the WORKTREE lock by the tree, not by $DRIVE_PR_HANDOFF_DIR", async () => {
      // The worktree lock hung off `dirname(handoffPath())`, which that
      // variable moves. Two drivers in ONE checkout that set it differently —
      // or one that set it and one that did not — therefore computed different
      // worktree locks, and their per-PR locks did not collide either when
      // they drove different PRs, so both ran and cross-shipped each other's
      // uncommitted edits.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { worktree } = lockDirs(dir, stateDir);
      plantClaim(worktree, {
        pid: process.pid,
        host: hostname(),
        nonce: "live0001",
      });

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            // A DIFFERENT handoff dir from the one the live holder used. Under
            // the old derivation this drive looked for its lock in here, found
            // nothing, and started a second loop in the same tree.
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff-elsewhere"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("worktree lock");
      expect(stderr).not.toContain("RAN_THE_PASS");
    });

    it("renews a held claim DURING a pass, not only between rounds", async () => {
      // Refreshing once per round made a claim only as fresh as the round was
      // short — and a round runs an agent pass, the gates and sometimes a
      // Testbox. A pass that outlasts the window let another start quarantine
      // a demonstrably live driver.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      // The loop still touches every lock once at the round boundary, just
      // before the pass. Sampling across THAT would pass with no timer at all
      // — measured: removing `startHeartbeat` left this test green. So the
      // pass announces itself, and the first sample is taken strictly after
      // the announcement, leaving the timer as the only thing that can move
      // the heartbeat inside the window.
      const started = join(dir, "pass-started");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "sh",
          "-c",
          `: pass for 999; : > ${JSON.stringify(started)}; sleep 5; exit 0`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            // The renewal period is derived from the staleness window, whose
            // floor is five minutes; this seam is what makes the mechanism
            // observable in a test rather than in five minutes' time.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(started);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);
        // The claim IS the heartbeat: its mtime is what the renewal moves,
        // and its name is what makes the renewal unable to touch a
        // successor.
        const held = claimsIn(worktree);
        expect(held.length).toBe(1);
        const beat = join(worktree, held[0] as string);
        const first = statSync(beat).mtimeMs;
        // Well inside the pass's own sleep, so no round boundary falls here.
        await Bun.sleep(800);
        const second = statSync(beat).mtimeMs;
        expect(second).toBeGreaterThan(first);
      } finally {
        // Same discipline as the sibling test below: a failed poll or
        // assertion above must not skip the kill and leave a live driver
        // running past this test.
        proc.kill();
        await proc.exited;
      }
    });

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
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      // A stub `claude` binary on PATH — argv[0] must literally be `claude`
      // for `passVendor` to resolve the Claude branch at all, and the round
      // loop really does execve this (drive.ts spawns argv directly, never
      // through a shell), so a real binary — not a `sh -c` wrapper — has to
      // exist to be found.
      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 5\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        const readAccount = (): unknown => {
          const held = claimsIn(worktree);
          expect(held.length).toBe(1);
          const text = readFileSync(join(worktree, held[0] as string), "utf8");
          const secondLine = text.split("\n")[1] ?? "";
          return (JSON.parse(secondLine) as { account: unknown }).account;
        };

        // The claim's SECOND line (the diagnostics JSON) is torn/absent for a
        // moment right after `takeLock`'s own staging+rename before this
        // process appends the diag on the NEXT write in real drive.ts —
        // here, though, `formatClaim` writes pid/host and diag together in
        // one call, so by the time the pass's own marker file exists the
        // claim is already fully diagnosed.
        expect(readAccount()).toEqual({
          account: "before@example.com",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        });

        // Simulate a login swap: the file changes in place, independent of
        // this driver process's own environment — but the pass is still
        // actively running (asleep, well inside its own 5s sleep) and already
        // holds the OLD identity.
        writeFileSync(
          claudeJsonPath,
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
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("does not resurrect a recovered claim via the account-identity rewrite", async () => {
      // An earlier revision called `refreshAccountIdentity` BEFORE
      // `touchLock` on each heartbeat tick. If a successor recovered this
      // generation's lock (deleted its claim file) in the same window a
      // file-backed identity change made `refreshAccountIdentity` want to
      // rewrite it, the rename recreated a file at THIS generation's own
      // claim path before `touchLock` ever got a chance to notice the
      // absence — republishing an obsolete claim and defeating takeover
      // detection outright: `touchLock`'s own contract is that the only
      // thing that removes `claim.<ours>` is a recovery of this generation,
      // so a claim that exists again reads as "still ours".
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 5\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Both land on disk together, with no await between them, so the very
        // next heartbeat tick sees an account change AND a missing claim in
        // the same tick — the exact race the ordering fix closes.
        writeFileSync(
          claudeJsonPath,
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

        // Only the successor's claim exists — the account-identity rewrite
        // never recreated this generation's own claim path after the
        // recovery deleted it.
        expect(claimsIn(worktree)).toEqual(["claim.successor01"]);
      } finally {
        // Not protected by `try/finally` before this fix — see the sibling
        // test above.
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("refreshes a FILE-BACKED account identity synchronously the moment a pass exits, not only on the next heartbeat tick", async () => {
      // Clearing `activePass` reopens the exact window `refreshAccountIdentity`'s
      // own gate exists for. Refreshing only on the heartbeat's OWN timer
      // would leave a credential file that changed mid-pass stale until the
      // next tick fired, and the loop could spawn the very next pass against
      // it first if it moved fast enough. The
      // heartbeat interval below is deliberately far longer than this test's
      // own lifetime, so a refreshed claim here can only be the pass-exit
      // refresh, never the timer.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — isolates the pass-exit
            // refresh from the heartbeat's own.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Change the file-backed identity while the pass is still asleep —
        // the running pass keeps billing to the OLD one regardless.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const readAccount = (): { account: unknown } | undefined => {
          try {
            const held = claimsIn(worktree);
            if (held.length !== 1) return undefined;
            const text = readFileSync(
              join(worktree, held[0] as string),
              "utf8",
            );
            const secondLine = text.split("\n")[1] ?? "";
            return JSON.parse(secondLine) as { account: unknown };
          } catch {
            // Unreadable, absent, or torn — including the lock directory
            // itself having been removed already (e.g. an unfixed driver
            // releasing the lock right after the pass exits, having never
            // refreshed it) — never a reason to crash the poll loop below.
            return undefined;
          }
        };

        // Poll well past the pass's own 1s sleep but far short of the 60s
        // heartbeat configured above: a refresh observed here is the
        // pass-exit path, not the timer.
        let refreshed = false;
        for (let i = 0; i < 400 && !refreshed; i++) {
          const diag = readAccount();
          refreshed =
            (diag?.account as { account?: string } | undefined)?.account ===
            "after@example.com";
          if (!refreshed) await Bun.sleep(25);
        }
        expect(refreshed).toBe(true);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

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
      // polling the claim file for the swapped value after the FIRST pass
      // exits: `runRepairPass` returning is not the same instant as the
      // driver's own subsequent lock release on exit, and polling after the
      // fact can lose that race under load without the code being wrong.
      // `runRepairPass` calls `refreshAccountIdentity` and returns
      // SYNCHRONOUSLY before the caller ever re-gates and dispatches a second
      // pass, so the second pass's own marker appearing is proof the refresh
      // already landed — no polling race against process teardown required.
      const { dir, stateDir } = writeFixture({
        threads: [],
        head: scratchClean.head,
        reviewedSha: scratchClean.head,
        checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
      });
      // NOT `lockDirs(dir, stateDir).worktree`: the driver below runs with
      // `cwd: scratchClean.dir`, so its own worktree-lock name is keyed off
      // THAT tree, not the suite's own cwd `WORKTREE_LOCK` was memoised
      // against — see `worktreeLockNameFor`'s own comment.
      const worktree = join(
        stateDir,
        await worktreeLockNameFor(scratchClean.dir),
      );

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const firstMarker = join(dir, "claude-pass-started-1");
      const secondMarker = join(dir, "claude-pass-started-2");
      // First invocation touches `firstMarker`; every invocation after that
      // touches `secondMarker` — so the SECOND marker's existence is proof a
      // second pass was actually dispatched, not merely that the script ran
      // twice for some other reason.
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\nif [ -e ${JSON.stringify(firstMarker)} ]; then : > ${JSON.stringify(secondMarker)}; else : > ${JSON.stringify(firstMarker)}; fi\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
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
        ],
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
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
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
            // timing race, a permanent path mismatch. Every other test in
            // this file that overrides `cwd` to a scratch tree pairs it with
            // this same anchor (e.g. the `$DRIVE_PR_WORKTREE` measurement
            // tests above).
            DRIVE_PR_WORKTREE: scratchClean.dir,
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
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
          claudeJsonPath,
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
        // second, so waiting for the SECOND marker first (as an earlier
        // revision of this test did) means the read arrives after the
        // driver, and every lock it held, is already gone: the claim
        // directory itself has been rmdir'd by then, not merely mid-write.
        // Polling from here catches the value while the first pass's own
        // return is the freshest thing that happened. The claim file is
        // still rewritten by every intervening `touchLock` heartbeat tick
        // (though the 60s interval above makes that irrelevant here), so
        // the read stays retry-safe regardless.
        const readAccount = (): { account?: string } | undefined => {
          try {
            const held = claimsIn(worktree);
            if (held.length !== 1) return undefined;
            const text = readFileSync(
              join(worktree, held[0] as string),
              "utf8",
            );
            const secondLine = text.split("\n")[1] ?? "";
            const diag = JSON.parse(secondLine) as {
              account: { account?: string };
            };
            return diag.account;
          } catch {
            // Unreadable, absent, or torn — a write in flight, never a
            // reason to fail the poll loop below.
            return undefined;
          }
        };
        const seenValues: unknown[] = [];
        const refreshed = await pollUntil(() => {
          const v = readAccount();
          seenValues.push(v?.account);
          return v?.account === "after@example.com";
        }, 400);
        if (!refreshed) {
          console.error("DEBUG seenValues (unique):", [...new Set(seenValues)]);
          console.error("DEBUG worktree dir exists:", existsSync(worktree));
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
        // and never cleaned up by the stub, so — unlike the claim file — it
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
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
      // Explicit, matching the CI-repair block's own convention (e.g. line
      // ~20765): two repair-pass round-trips, each with its own generous
      // poll budget, can approach the suite's default per-test budget under
      // load, and a bare `bun test` invocation elsewhere defaults to bun's
      // own 5s, not this file's `--timeout 30000`.
    }, 45000);

    it("spawns the next pass anyway once every pre-spawn identity-rewrite retry is exhausted, warning about a possibly-stale display rather than blocking on a DISPLAY value", async () => {
      // This is deliberate (see the pre-spawn retry loop's own
      // comment in drive.ts): a filesystem stuck longer than the bounded
      // retries must not stop the drive from ever spawning another pass over
      // what is only ever a DISPLAY value. This test covers the fall-through
      // that decision actually produces — every retry exhausted, and the pass
      // spawns anyway with the stale-display warning on stderr. Simulate a
      // stuck filesystem by chmod'ing both lock directories read-only from
      // INSIDE round 1's own stub pass — deterministic, no timing race against
      // a live process required — then confirm round 2 still spawns.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const passCountFile = join(dir, "pass-count");
      const round2Marker = join(dir, "round2-started");

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh
n=$(( $(cat ${JSON.stringify(passCountFile)} 2>/dev/null || echo 0) + 1 ))
echo "$n" > ${JSON.stringify(passCountFile)}
if [ "$n" = "1" ]; then
  printf '%s' '{"oauthAccount":{"emailAddress":"after@example.com"}}' > ${JSON.stringify(claudeJsonPath)}
  chmod 0555 ${JSON.stringify(worktree)} ${JSON.stringify(pr)}
else
  : > ${JSON.stringify(round2Marker)}
  chmod 0755 ${JSON.stringify(worktree)} ${JSON.stringify(pr)}
fi
exit 0
`,
        { mode: 0o755 },
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — only the pre-spawn
            // retry loop and the pass-exit refresh should ever touch the
            // now-read-only lock directories, never the heartbeat timer.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
            // The single fixture thread is never resolved by either stub
            // invocation, so both rounds report an identical fingerprint —
            // disabled here because this probe's subject is the identity
            // fallback, not the (separately covered) stall-stop behavior.
            DRIVE_PR_STALL_ROUNDS: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
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
        // Best-effort: the stub itself restores write permission before its
        // round-2 exit, and a normal drive exit then retires (removes) both
        // lock directories on its way out — so neither path here is
        // guaranteed to still exist by the time a failed assertion above
        // lands here instead.
        for (const d of [worktree, pr]) {
          try {
            chmodSync(d, 0o755);
          } catch {
            // Already gone (normal release) or never existed this run.
          }
        }
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("heals a resurrected claim at the pass-exit rewrite instead of trusting `touchLock`'s own next tick, which cannot see it", async () => {
      // Narrowing the check-to-rename gap cannot close it, and `touchLock`'s
      // own next tick cannot backstop the remainder: a resurrected claim
      // carries THIS generation's own name, so `touchLock`'s exact-name
      // `utimesSync` check succeeds against it forever, permanently masking the
      // takeover instead of catching it. Reproduce the state a resurrection
      // race would leave behind directly — a second, unrelated claim already
      // sitting in the same directory — instead of racing the exact microsecond
      // gap by timing alone, and confirm the very next rewrite attempt notices
      // and heals it.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Far longer than this test ever runs — the pass-exit rewrite is
            // what has to find and heal the ghost claim, not a timer tick.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "60000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        let running = false;
        for (let i = 0; i < 400 && !running; i++) {
          running = existsSync(startedMarker);
          if (!running) await Bun.sleep(25);
        }
        expect(running).toBe(true);

        // Plant a SECOND claim directly, without touching the real one — the
        // same end state a resurrection race leaves behind (this
        // generation's own claim recreated ALONGSIDE a successor's), reached
        // deterministically instead of by timing a microsecond gap.
        plantClaim(worktree, {
          pid: 999999,
          host: "ghost-host",
          nonce: "ghost01",
        });

        // Trigger the rewrite the ghost claim needs to be noticed by.
        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(11);
        expect(stderr).toContain("recovered by another driver");

        // This generation's own (just-rewritten) claim is removed again;
        // only the other claim survives.
        expect(claimsIn(worktree)).toEqual(["claim.ghost01"]);
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });

    it("retries every held lock independently, not just the first one to reach `fresh`", async () => {
      // An earlier revision compared `fresh` against only the FIRST lock
      // with a diag (`locks.find(...)`) and returned once THAT ONE matched
      // — so once one lock's rewrite succeeded, a sibling lock's own
      // transient write failure went permanently unretried: the next
      // tick's shared check saw the first lock already agreeing with
      // `fresh` and never looked at the second lock again. Block the PR
      // lock's own directory (a permission failure stands in for any
      // transient write failure) while the worktree lock stays writable,
      // trigger a real account change, and confirm the PR lock's claim
      // still catches up once unblocked — the old code could never do that
      // once the worktree lock got there first.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);

      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      const startedMarker = join(dir, "claude-pass-started");
      writeFileSync(
        join(claudeStubDir, "claude"),
        `#!/bin/sh\n: > ${JSON.stringify(startedMarker)}\nsleep 1\nexit 0\n`,
        { mode: 0o755 },
      );

      const claudeConfigDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-config-"),
      );
      const claudeJsonPath = join(claudeConfigDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { emailAddress: "before@example.com" },
        }),
      );

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ],
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}:${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            // Short enough that several ticks land in the window between
            // the pass exiting and this process deciding it has hit
            // --max-rounds — the retry has to survive more than one tick.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "10",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      let prBlocked = false;
      try {
        const running = await pollUntil(() => existsSync(startedMarker), 400);
        expect(running).toBe(true);

        // Block the PR lock directory's writes while the pass sleeps — a
        // stand-in for a transient write failure specifically on this lock.
        chmodSync(pr, 0o500);
        prBlocked = true;

        // Confirm the permission bits actually block a write in THIS
        // environment before trusting them as the failure injection below —
        // a privileged (e.g. root) test process ignores file-mode write
        // permission entirely, which would let both claims catch up
        // immediately and leave every assertion past this point vacuously
        // true regardless of whether the per-lock retry fix below is even
        // present.
        const writeProbe = join(pr, `write-probe.${process.pid}`);
        let probeBlocked = false;
        try {
          writeFileSync(writeProbe, "x");
          rmSync(writeProbe, { force: true });
        } catch {
          probeBlocked = true;
        }
        expect(probeBlocked).toBe(true);

        writeFileSync(
          claudeJsonPath,
          JSON.stringify({
            oauthAccount: { emailAddress: "after@example.com" },
          }),
        );

        const readAccountEmail = (dirPath: string): string | undefined => {
          try {
            const held = claimsIn(dirPath);
            if (held.length !== 1) return undefined;
            const text = readFileSync(join(dirPath, held[0] as string), "utf8");
            const secondLine = text.split("\n")[1] ?? "";
            const parsed = JSON.parse(secondLine) as {
              account?: { account?: string };
            };
            return parsed.account?.account;
          } catch {
            return undefined;
          }
        };

        // The worktree lock is writable throughout, so it should catch up
        // even though the PR lock cannot.
        const worktreeCaughtUp = await pollUntil(
          () => readAccountEmail(worktree) === "after@example.com",
          400,
          10,
        );
        expect(worktreeCaughtUp).toBe(true);

        // Unblock the PR lock and confirm it ALSO eventually catches up —
        // the fix's whole point: a lock that missed one rewrite keeps
        // retrying on every later tick rather than being masked by a
        // sibling lock that already agrees with `fresh`.
        chmodSync(pr, 0o700);
        prBlocked = false;

        const prCaughtUp = await pollUntil(
          () => readAccountEmail(pr) === "after@example.com",
          400,
          10,
        );
        expect(prCaughtUp).toBe(true);
      } finally {
        if (prBlocked) {
          try {
            chmodSync(pr, 0o700);
          } catch {
            // best-effort — nothing further to clean up if this itself fails
          }
        }
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    });
  });
});
