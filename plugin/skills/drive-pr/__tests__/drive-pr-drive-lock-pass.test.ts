/**
 * drive-pr suite: drive.ts single-instance lock around a running pass — the
 * clone-wide PR lock, takeover mid-pass and mid-quota-sleep, and signals.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { MAILBOX_STOPPED_EXIT, QUOTA_PARKED_EXIT } from "../scripts/drive";
import { DRIVER_LOG_MAX_BYTES } from "../scripts/lib/driver-log.ts";
import { claudeAdapter } from "../scripts/lib/quota/claude.ts";
import { appendDirective } from "../scripts/lib/state/mailbox";

import {
  SCRIPTS,
  binDir,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  PASS_LOUD,
  lockDirs,
  plantClaim,
  pollUntil,
  awaitFixtureMarker,
  simulateTakeover,
} from "./drive-loop-harness.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import {
  captureProcessTree,
  identityTargetsGone,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";
import { requestDriverStop } from "../scripts/lib/stop-request.ts";
import { readdirSync } from "node:fs";

useDrivePrSuite();

describe("drive.ts loop control", () => {
  describe("single-instance lock", () => {
    // Three failure modes, each modelled by planting
    // the exact directory state the racing driver would have left behind.

    it("refuses when a LIVE driver holds the clone-wide PR lock from another worktree", async () => {
      // Separate worktrees never cross-ship edits, but they race pushes to one
      // head branch and share the clone-wide durable state.
      const { dir, stateDir } = writeFixture({ threads: [] });
      const { pr, worktree } = lockDirs(dir, stateDir);
      plantClaim(pr, {
        pid: process.pid,
        host: hostname(),
        nonce: "prlock001",
      });

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            // Nobody holds the worktree lock, so it is taken and only the PR
            // lock can refuse this. (The handoff dir is deliberately a
            // different one, but that is no longer what frees the worktree
            // lock: it is keyed by the TREE and lives in the state dir.)
            DRIVE_PR_HANDOFF_DIR: join(dir, "other-worktree-handoff"),
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
      expect(stderr).toContain("PR #999");
      expect(stderr).not.toContain("RAN_THE_PASS");
      // And the first lock it DID take is released on the way out, rather
      // than left behind to be recovered as stale by the next start. Asserted
      // through `lockDirs`, the same resolver drive.ts uses: a hand-written
      // path here named a lock that has not existed since the worktree lock
      // was keyed by the tree, so the check could only ever pass.
      expect(existsSync(worktree)).toBe(false);
    });

    /**
     * A pass that outlives the claim it is working under.
     *
     * Announces itself, then leaves a GRANDCHILD to write a second marker
     * `LATE_GRANDCHILD_SECONDS` later. The grandchild is what makes the
     * assertion about the process GROUP rather than about the pass process:
     * signalling the pass alone leaves it running, and it writes `late`
     * regardless. The driver stops the group within a heartbeat (100ms) or
     * on the test's own signal, so two seconds is a wide margin for the
     * group to be stopped while the grandchild still sleeps.
     */
    const LATE_GRANDCHILD_SECONDS = 2;
    const passWithLateGrandchild = (dir: string) =>
      byPlatform(
        "Windows tree termination is witnessed by captured identities; POSIX also checks the late write",
        { windows: "captured", posix: "late-write" },
      ) === "captured"
        ? portablePassTree(dir)
        : [
            "sh",
            "-c",
            `: pass for 999; : > ${JSON.stringify(join(dir, "pass-started"))}; ` +
              `(sleep ${LATE_GRANDCHILD_SECONDS}; : > ${JSON.stringify(join(dir, "pass-late"))}) & wait`,
          ];

    /**
     * Poll for the pass's own announcement, so the window is not guessed.
     * Returns when it was seen, the clock `outwaitGrandchild` counts from.
     */
    async function awaitPassStart(dir: string): Promise<number> {
      const started = join(dir, "pass-started");
      expect(await awaitFixtureMarker(started)).toBe(true);
      return performance.now();
    }

    /**
     * Wait until a grandchild that started sleeping when the pass announced
     * itself would have written its marker had it survived, plus half a
     * second for a slow fork. Counted from the announcement rather than from
     * the driver's exit, so the wait covers the grandchild's sleep and no
     * more.
     */
    async function outwaitGrandchild(startedAt: number, seconds: number) {
      await Bun.sleep(
        Math.max(0, startedAt + (seconds + 0.5) * 1000 - performance.now()),
      );
    }

    it("stops the RUNNING pass when the lock is recovered mid-pass", async () => {
      // The loop reads `compromised` only at a round boundary, and a pass
      // already running does not pause at one — so a takeover detected mid-pass
      // let it go on editing, committing and pushing under a claim another
      // driver held.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...passWithLateGrandchild(dir),
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const startedAt = await awaitPassStart(dir);
      const native =
        byPlatform(
          "native Windows teardown requires creation-bound descendant witnesses",
          { windows: "true", posix: "false" },
        ) === "true";
      const captured = native
        ? await captureProcessTree(
            Number(readFileSync(join(dir, "pass-started"), "utf8")),
          )
        : null;
      if (native) expect(captured).not.toBeNull();
      // A successor recovering this lock is indistinguishable, from here, from
      // the generation simply no longer being ours — which is exactly what the
      // heartbeat checks.
      simulateTakeover(worktree, "successor01");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("stopping the active pass");
      expect(stderr).toContain("recovered by another driver");
      // Past the grandchild's own sleep: nothing in the pass tree survived.
      if (captured !== null)
        expect(await identityTargetsGone(captured)).toBe(true);
      else {
        await outwaitGrandchild(startedAt, LATE_GRANDCHILD_SECONDS);
        expect(existsSync(join(dir, "pass-late"))).toBe(false);
      }
    }, 60000);

    it("stops rotating the driver log once another driver recovers the lock", async () => {
      // Rotation is the current owner's alone: a driver whose lock was
      // recovered keeps writing its shutdown lines, and renaming the file
      // then would race the successor's own rotation and lose history.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const logPath = join(stateDir, "drive-pr-999.log");
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...passWithLateGrandchild(dir),
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const startedAt = await awaitPassStart(dir);
      const native =
        byPlatform(
          "native Windows teardown requires creation-bound descendant witnesses",
          { windows: "true", posix: "false" },
        ) === "true";
      const captured = native
        ? await captureProcessTree(
            Number(readFileSync(join(dir, "pass-started"), "utf8")),
          )
        : null;
      if (native) expect(captured).not.toBeNull();
      // Full, so the next line the old driver writes would rotate the file.
      // Filled BEFORE the takeover is published: once it is, the driver's
      // heartbeat may notice and write its shutdown lines at any moment, and
      // a truncation after them would erase what this test asserts on. The
      // driver writes nothing while its pass runs, so it cannot rotate first.
      truncateSync(logPath, DRIVER_LOG_MAX_BYTES);
      simulateTakeover(worktree, "successor01");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(stderr).toContain("recovered by another driver");
      expect(existsSync(`${logPath}.1`)).toBe(false);
      expect(statSync(logPath).size).toBeGreaterThan(DRIVER_LOG_MAX_BYTES);
      if (captured !== null)
        expect(await identityTargetsGone(captured)).toBe(true);
      else await outwaitGrandchild(startedAt, LATE_GRANDCHILD_SECONDS);
    }, 60000);

    it("does not attribute a PRE-EXISTING session's wall to the pass it spawned", async () => {
      // The WIRING, not the adapter: that `drive.ts` actually takes a
      // snapshot and threads it into `detectQuotaBlock`, which no adapter
      // unit test can observe. A transcript that already exists when the
      // drive starts — a human's chat in this same worktree, the normal
      // condition while a drive runs — must not park or sleep a pass that
      // failed for its own reasons.
      //
      // What this test does NOT bind is the ORDERING (snapshot before
      // spawn): the fixture exists both before and after, so a snapshot
      // taken after `run()` returned would contain it too and this test
      // would still pass. The ordering is bound by the test below,
      // whose pass CREATES its transcript mid-pass and asserts the drive
      // sleeps on it — which only holds if the snapshot was taken before
      // that file existed.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      lockDirs(dir, stateDir);
      // Same reasoning as the test below: the spawned child's own
      // `process.cwd()` is what `belongsToWorktree` compares against, and it
      // does no symlink resolution of its own.
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const projDir = join(claudeProjectsDir, "proj");
      mkdirSync(projDir, { recursive: true });

      // The fixture must satisfy EVERY other clause, so the snapshot is the
      // sole decider — a record tripping the `since` floor or the cwd check
      // would pass this test whether or not the snapshot exists at all.
      // `since` is the instant of the spawn, which is necessarily LATER than
      // this write, so the record is dated slightly into the future: still
      // well inside the adapter's `MAX_CLOCK_SKEW_MS` (5 min) upper bound,
      // but above the floor the drive will apply.
      const wallAt = new Date(Date.now() + 30_000);
      const preexisting = join(projDir, "human-chat.jsonl");
      writeFileSync(
        preexisting,
        `${JSON.stringify({
          type: "assistant",
          cwd: cwdDir,
          timestamp: wallAt.toISOString(),
          error: "rate_limit",
          isApiErrorMessage: true,
          apiErrorStatus: 429,
          sessionId: "a-human-chat-session",
          message: {
            content: [
              {
                type: "text",
                text: "You've hit your session limit \u00b7 resets 11:59pm (UTC)",
              },
            ],
          },
        })}\n`,
      );

      // CONTROL, in-process: prove the fixture is genuinely detectable, so
      // the e2e assertion below cannot pass vacuously because the record was
      // malformed, mis-timed or in the wrong worktree.
      const savedProjects = process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
      process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = claudeProjectsDir;
      try {
        const seen = claudeAdapter.detect({
          cwd: cwdDir,
          since: new Date(Date.now() - 60_000),
          now: new Date(),
        });
        expect(seen?.window).toBe("short");
        // ...and that the ONLY thing that changes the answer is the snapshot.
        expect(
          claudeAdapter.detect({
            cwd: cwdDir,
            since: new Date(Date.now() - 60_000),
            now: new Date(),
            preexistingSessions: new Set([preexisting]),
          }),
        ).toBeNull();
      } finally {
        if (savedProjects === undefined)
          delete process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
        else process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR = savedProjects;
      }

      // A pass that fails without writing any transcript of its own. The only
      // wall on disk is the pre-existing one.
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          "-e",
          "process.exit(1)",
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // Reported as what it is — an ordinary failed pass — rather than as
      // somebody else's quota wall.
      expect(stderr).toContain("pass failed on round 1");
      expect(stderr).not.toContain("hit a quota wall");
      expect(stderr).not.toContain("SLEEPING");
      expect(exitCode).not.toBe(QUOTA_PARKED_EXIT);
    });

    it("spawns the AMENDED argv and matches the wall on the id it injected", async () => {
      // Binds the two halves to each other. `prepareSpawn` minting an id and
      // `detect` filtering on one are unit-tested separately, but nothing
      // asserted drive.ts injects the SAME id it then filters on — and the
      // failure is silent and total: drop the amendment and Claude Code
      // picks its own session id, every record fails the correlation clause,
      // and Claude quota detection returns null forever while the suite
      // stays green.
      //
      // The pass command is a stub literally named `claude`, invoked by
      // absolute path — `isClaudeCli` compares the BASENAME, so this is
      // claimed exactly as the real CLI would be, with no PATH shimming to
      // leak into other tests. It writes its wall under whichever session id
      // it was GIVEN, or mints its own when it was given none, which is what
      // the real CLI does.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      lockDirs(dir, stateDir);
      const claudeProjectsDir = join(dir, "claude-projects");
      mkdirSync(join(claudeProjectsDir, "proj"), { recursive: true });

      const stubPath = join(dir, "claude");
      writeFakeProgram(
        stubPath,
        [
          "#!/usr/bin/env bun",
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "import { randomUUID } from 'node:crypto';",
          "const argv = process.argv.slice(2);",
          "const i = argv.indexOf('--session-id');",
          // No `--session-id` reaching the stub is exactly the mutation case:
          // the real CLI would mint its own, so the stub does too.
          "const sid = i >= 0 && i + 1 < argv.length ? argv[i + 1] : randomUUID();",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: process.cwd(),",
          "  timestamp: new Date().toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  sessionId: sid,",
          // Deliberately NOT the session-limit wording: an unrecognised
          // phrase classifies `unknown`, which the driver treats like weekly
          // and PARKS on. That keeps this test deterministic and instant —
          // no sleeping, no clock arithmetic.
          "  message: { content: [{ type: 'text', text: 'Usage limit reached (test fixture wording).' }] },",
          "};",
          "writeFileSync(",
          "  join(process.env.DRIVE_PR_TEST_PROJ_DIR, `${sid}.jsonl`),",
          "  `${JSON.stringify(record)}\n`,",
          ");",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          stubPath,
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_TEST_PROJ_DIR: join(claudeProjectsDir, "proj"),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // The driver announces the rewrite it performed...
      expect(stderr).toContain("pass argv amended for quota attribution");
      // ...and then recognises the wall that rewrite made attributable.
      expect(stderr).toContain("hit a quota wall");
      expect(exitCode).toBe(QUOTA_PARKED_EXIT);
    });

    /**
     * One full attempt at the quota-wall-sleep-interrupt scenario: write a
     * fresh fixture, spawn `drive.ts` against a pass that writes a
     * recognisable quota-wall transcript record, and race a live stderr read
     * against the process's own exit to catch the "SLEEPING" marker while
     * the sleep is actually in progress. Returns what happened rather than
     * asserting on it, so the caller (below) can retry a genuine miss
     * without asserting on a not-yet-final attempt.
     */
    async function attemptQuotaWallSleepInterrupt(
      interrupt: "takeover" | "mailbox-stop" = "takeover",
    ): Promise<{
      passRan: boolean;
      takeoverFired: boolean;
      stopFired: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      // The heartbeat's takeover signal (`compromised`) had nothing to
      // interrupt during a quota-wall sleep: `stopActivePass` is a no-op
      // with no active pass, and nothing else watched `compromised` until
      // the loop's NEXT round-boundary check — up to `maxSleepMs()` (six
      // hours by default) later, all the while still refreshing the
      // compromised lock's claim. A pass command writes a recognisable
      // Claude rate-limit transcript record and exits non-zero, driving the
      // loop into its sleep-and-resume branch; a takeover fired once that
      // sleep has visibly started must end the drive almost immediately
      // instead of after the full wait.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const mailboxDir = join(dir, "mailbox");
      const { worktree } = lockDirs(dir, stateDir);
      // Deliberately NOT overridden for the spawn below: `WORKTREE_LOCK`
      // (what `lockDirs`/`simulateTakeover` address) was derived once, at
      // import time, from THIS process's own ambient cwd — the real repo
      // checkout `bun test` runs from, which is already a git worktree.
      // Pointing the child at any other `cwd` (a plain fixture tmp dir, or
      // even `scratchClean.dir`) makes it compute a DIFFERENT worktree
      // lock name than the constant this test addresses.
      // Realpath'd so the `cwd` this test writes into the transcript
      // record matches what the SPAWNED process reports as its own
      // `process.cwd()` bit for bit — `belongsToWorktree` is a
      // prefix/equality test with no symlink resolution of its own, and a
      // bare tmp dir can differ from its realpath (e.g. macOS's `/tmp` →
      // `/private/tmp`).
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      // A standalone helper FILE, not an inline `sh -c`/`bun -e` one-liner:
      // the transcript record embeds a real apostrophe and a middle-dot
      // separator, and nesting those inside a shell-quoted argument is
      // exactly the multi-layer-quoting hazard — a file has no delimiter to
      // collide with.
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // Comfortably beyond any realistic spawn/poll overhead, but small
          // enough that a REGRESSION (the sleep not interrupted) fails via
          // this test's own timeout rather than a multi-minute hang.
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          // >1: round 1 hitting the wall must still have a FURTHER round
          // to sleep for — at `round >= maxRoundsN` the loop short-circuits
          // straight to the non-convergence report instead of sleeping at
          // all, which is a different branch than the one this test means
          // to exercise.
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          // Satisfies the mis-targeting guard: the pass argv must itself
          // name the PR the driver was given, or drive.ts refuses to run
          // it at all.
          "--pr-999",
        ),
        {
          // No `cwd` override — see the comment on `cwdDir` above.
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        await awaitFixtureMarker(passDonePath);
        const passRan = existsSync(passDonePath);

        // Read stderr live rather than waiting for the process to exit —
        // the whole point is to fire the takeover WHILE the sleep is in
        // progress, not after. The "SLEEPING" line prints synchronously
        // with no `await` before `quotaSleepAbort` is assigned, so by the
        // time it is observable here the controller this test is about to
        // abort already exists.
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let takeoverFired = false;
        let stopFired = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (!takeoverFired && !stopFired && allStderr.includes("SLEEPING")) {
            if (interrupt === "takeover") {
              takeoverFired = true;
              simulateTakeover(worktree, "successor02");
            } else {
              stopFired = true;
              await appendDirective(mailboxDir, "999", "test", "stop");
            }
          }
          if (done) break;
        }

        const exitCode = await proc.exited;
        return {
          passRan,
          takeoverFired,
          stopFired,
          exitCode,
          allStderr,
          stateDir,
        };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME quota-wall scenario as `attemptQuotaWallSleepInterrupt`, but
     * racing the takeover into the narrower, earlier window that sibling
     * function cannot reach at all: WHILE `recordQuotaPark`'s own subprocess
     * is still in flight, before `quotaSleepAbort` even exists.
     * `attemptQuotaWallSleepInterrupt`'s own comment records why
     * its trigger point — right as "SLEEPING" appears — lands AFTER that
     * subprocess has already resolved in practice: the controller it aborts
     * already exists by the time its takeover fires. That leaves the earlier
     * window provably untested, and it is exactly the window a takeover
     * detected there used to be silently swallowed in (`touchLock`'s own
     * `if (compromised !== '') return;` guard skips firing the abort again
     * on every later heartbeat tick, so a controller created AFTER the
     * takeover was already lost never receives one).
     *
     * `DRIVE_PR_QUOTA_PARK_TEST_DELAY` forces the overlap deterministically
     * — the same reasoning `DRIVE_PR_CLAIM_HELD_TEST_DELAY` documents for
     * its own caller: two events merely close together race real scheduling
     * jitter and, on a fast machine, may simply not overlap. Held well under
     * the 5s test cap and comfortably above the 100ms heartbeat interval, so
     * the heartbeat is guaranteed at least one tick while the subprocess is
     * still sleeping.
     */
    async function attemptQuotaWallTakeoverDuringRecordQuotaPark(): Promise<{
      passRan: boolean;
      takeoverFired: boolean;
      exitCode: number;
      elapsedMs: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // 90s, not the sibling fixtures' 20s: the transcript's reset
          // clause is minute-granular (seconds are dropped), so the
          // reparsed `plan.ms` can be up to 59s SHORTER than the nominal
          // offset depending on which second within the minute `now` lands
          // on. A 20s nominal offset can therefore reparse to
          // approximately zero, which made an earlier version of this
          // fixture unable to distinguish the fixed and unfixed code (both
          // exited near-instantly regardless). 90s keeps the worst-case
          // reparsed `plan.ms` comfortably above 10s even under maximum
          // truncation loss, which is what this test's elapsedMs bound
          // below relies on.
          "const target = new Date(now.getTime() + 90_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_QUOTA_PARK_TEST_DELAY: "1",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      let takeoverAt = 0;
      try {
        await awaitFixtureMarker(passDonePath);
        const passRan = existsSync(passDonePath);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let takeoverFired = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          // Fired the instant "SLEEPING" appears — BEFORE `recordQuotaPark`
          // is even awaited, let alone resolved — so the injected 1s delay
          // guarantees the heartbeat observes `compromised` while that
          // subprocess is still in flight, not after.
          if (!takeoverFired && allStderr.includes("SLEEPING")) {
            takeoverAt = Date.now();
            takeoverFired = true;
            simulateTakeover(worktree, "successor03");
          }
          if (done) break;
        }

        const exitCode = await proc.exited;
        const elapsedMs = Date.now() - takeoverAt;
        return {
          passRan,
          takeoverFired,
          exitCode,
          elapsedMs,
          allStderr,
          stateDir,
        };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME quota-wall fixture `attemptQuotaWallSleepInterrupt` builds,
     * without racing a concurrent takeover against it — for a caller that
     * wants to observe the driver's OWN write (`recordQuotaPark`) landing
     * under ordinary circumstances, not under the artificial, sub-100ms-
     * heartbeat interrupt race that sibling function exists to exercise.
     */
    async function attemptQuotaWallSleepStart(): Promise<{
      passRan: boolean;
      sleeping: boolean;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        await awaitFixtureMarker(passDonePath);
        const passRan = existsSync(passDonePath);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let sleeping = false;
        // Bounded read loop, NOT "until the stream closes" — this process
        // is deliberately left running (a 20s sleep), so waiting for `done`
        // here would wait out the whole sleep. Stop the instant "SLEEPING"
        // appears; the `finally` below kills the process either way.
        while (!sleeping) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (allStderr.includes("SLEEPING")) sleeping = true;
          if (done) break;
        }
        // The "SLEEPING" lines print BEFORE `recordQuotaPark` is awaited
        // (drive.ts: the logs, then the record, then the sleep itself) — the
        // opposite of what one might assume — so
        // the record is still IN FLIGHT when this reader observes them: a
        // spawned `bun drive-state.ts quota-park` that must claim the
        // session lease and queue for the per-PR state mutex before it
        // writes anything. Poll for the write rather than guessing a settle
        // interval a loaded CI machine can exceed.
        const stateFile = join(stateDir, "drive-pr-999.json");
        for (let i = 0; i < 200; i++) {
          try {
            const s = JSON.parse(readFileSync(stateFile, "utf8")) as {
              quotaPark: unknown;
            };
            if (s.quotaPark !== null) break;
          } catch {
            // Mid-write or not yet created — retry.
          }
          await Bun.sleep(25);
        }
        return { passRan, sleeping, stateDir };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME sleep-eligible quota-wall fixture as
     * {@link attemptQuotaWallSleepStart}, but with `--max-rounds 1` so THIS
     * round is already the last one allowed — the branch that returns exit
     * `6` immediately instead of sleeping (that branch must not return
     * before `recordQuotaPark` runs). Waits for the whole
     * process to EXIT rather than stopping at "SLEEPING", since this path
     * never sleeps at all.
     */
    async function attemptQuotaWallOnFinalRound(): Promise<{
      passRan: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        await awaitFixtureMarker(passDonePath);
        const passRan = existsSync(passDonePath);
        const [allStderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { passRan, exitCode, allStderr, stateDir };
      } finally {
        proc.kill();
      }
    }

    /**
     * The SAME last-round quota-wall scenario as {@link attemptQuotaWallOnFinalRound},
     * but with `DRIVE_PR_PROGRESS_TEST_DELAY` holding the `pass-spawned`
     * progress stamp's own write open for a couple of seconds — long enough
     * that, WITHOUT `drive.ts` joining that write before interpreting the
     * pass result, `recordQuotaPark`'s write lands first and the delayed
     * `pass-spawned` stamp then completes afterwards and clobbers
     * `quotaPark` back to `null` via `withProgress`'s own unconditional
     * clear. The pass itself exits almost instantly (it
     * only writes a transcript file and returns), so without the join there
     * is nothing else in this round to make `recordQuotaPark` wait for the
     * delayed stamp.
     */
    async function attemptQuotaWallOnFinalRoundWithDelayedProgress(): Promise<{
      passRan: boolean;
      exitCode: number;
      allStderr: string;
      stateDir: string;
    }> {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const cwdDir = realpathSync(process.cwd());
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, cwdArg, doneMarker] = process.argv;",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          "const target = new Date(now.getTime() + 20_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: cwdArg,",
          "  timestamp: now.toISOString(),",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          "bun",
          helperPath,
          join(claudeProjectsDir, "proj"),
          cwdDir,
          passDonePath,
          "--pr-999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
            DRIVE_PR_PROGRESS_TEST_DELAY: "2",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        await awaitFixtureMarker(passDonePath);
        const passRan = existsSync(passDonePath);
        const [allStderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { passRan, exitCode, allStderr, stateDir };
      } finally {
        proc.kill();
      }
    }

    /** Read `quotaPark` back out of a completed attempt's durable state. */
    function readQuotaPark(stateDir: string): { vendor: string } | null {
      return (
        JSON.parse(
          readFileSync(join(stateDir, "drive-pr-999.json"), "utf8"),
        ) as { quotaPark: { vendor: string } | null }
      ).quotaPark;
    }

    it("interrupts a quota-wall sleep when the lock is recovered mid-sleep", async () => {
      let attempt = await attemptQuotaWallSleepInterrupt();
      if (attempt.passRan && !attempt.takeoverFired) {
        // This exact scenario has been observed to fail on GitHub
        // Actions (Blacksmith runners) — the driver's pass ran and exited as
        // expected, but the process went on to exit WITHOUT ever printing
        // "SLEEPING", so `takeoverFired` never got a chance to fire. It has
        // never reproduced locally (including under heavy artificial spawn
        // contention) or on the dedicated remote-gates host across repeated
        // runs, which is the signature of a CI-runner-only timing margin
        // rather than a logic bug in `drive.ts` — see the issue for the full
        // investigation. One retry with a COMPLETELY FRESH fixture absorbs a
        // transient environment miss without weakening what a genuine
        // regression still has to prove: a second consecutive miss still
        // fails the assertions below for real.
        attempt = await attemptQuotaWallSleepInterrupt();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.takeoverFired).toBe(true);
      expect(attempt.exitCode).toBe(11);
      expect(attempt.allStderr).toContain("recovered by another driver");
    }, 30000);

    it("honors a mailbox stop during quota sleep without waiting for the quota window", async () => {
      let attempt = await attemptQuotaWallSleepInterrupt("mailbox-stop");
      if (attempt.passRan && !attempt.stopFired) {
        attempt = await attemptQuotaWallSleepInterrupt("mailbox-stop");
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.stopFired).toBe(true);
      expect(attempt.exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(attempt.allStderr).toContain("stop requested");
    }, 120000);

    it("a takeover detected WHILE recordQuotaPark is still in flight ends the drive promptly, not after the full sleep", async () => {
      // Without the fix this reproduces: `quotaSleepAbort` did not exist
      // yet when `touchLock` observed the takeover, so the abort it fired
      // was a no-op, and `touchLock`'s own `if (compromised !== '') return;`
      // guard meant it never fired again on a later heartbeat tick against
      // the FRESH controller created once `recordQuotaPark` resolved. The
      // drive would then sleep for the full ~20s the transcript's `resetAt`
      // describes before its post-sleep check ever saw `compromised`. The
      // fix re-checks immediately after that await, so a takeover landing
      // in this window ends the drive in roughly the 1s injected delay,
      // not the ~20s wall.
      let attempt = await attemptQuotaWallTakeoverDuringRecordQuotaPark();
      for (
        let retriesLeft = 2;
        attempt.passRan && !attempt.takeoverFired && retriesLeft > 0;
        retriesLeft--
      ) {
        // The same CI-runner-only timing margin documented on the
        // sibling `attemptQuotaWallSleepInterrupt` test above — the driver's
        // pass ran and exited as expected, but the process went on to exit
        // without ever printing "SLEEPING", so `takeoverFired` never got a
        // chance to fire. Never reproduced locally (5/5 local runs pass). A
        // single retry itself missed twice in a row on two independent,
        // unrelated CI runs (neither touching drive.ts's
        // quota-wall/takeover code at all) — direct measured evidence the
        // CI-runner's margin has tightened further, not a hypothesis. Two
        // retries with a COMPLETELY FRESH fixture each time absorb that
        // without weakening what a genuine regression still has to prove: a
        // THIRD consecutive miss (three independent fixtures, three
        // independent spawns) still fails the assertions below for real.
        attempt = await attemptQuotaWallTakeoverDuringRecordQuotaPark();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.takeoverFired).toBe(true);
      expect(attempt.exitCode).toBe(11);
      expect(attempt.allStderr).toContain("recovered by another driver");
      // Measured from the takeover, excluding CLI startup. Comfortably above
      // the injected delay and below the ≥~30s full sleep a regression would
      // take (see the fixture's own comment on the 90s nominal target and
      // its minute-truncation floor) — a REGRESSION fails this bound long
      // before the test's outer timeout would.
      expect(attempt.elapsedMs).toBeLessThan(10_000);
    }, 120000);

    it("recordQuotaPark writes the park on the SLEEP path, observed WITHOUT racing a concurrent takeover", async () => {
      // Deliberately uses `attemptQuotaWallSleepStart`, NOT the sibling
      // `attemptQuotaWallSleepInterrupt` above — an earlier version of this
      // test reused that racier fixture and reproducibly (2/2 remote-gates
      // runs) observed `quotaPark: null` immediately after a takeover-forced
      // exit, even with a retry. Reusing the interrupt race conflated two
      // different questions: "does the write happen at all" (this test) and
      // "does an interrupt reach the driver correctly" (the sibling test,
      // which passed reliably in the SAME remote runs). This fixture asks
      // only the first question, so it has nothing to race against a fast
      // heartbeat's takeover detection.
      let attempt = await attemptQuotaWallSleepStart();
      if (attempt.passRan && !attempt.sleeping) {
        // The same CI-runner-only timing margin documented on the
        // sleep-interrupt/takeover/final-round siblings elsewhere in this
        // describe block — the pass ran and exited as expected, but the
        // stderr reader closed (`done`) without this attempt ever observing
        // "SLEEPING". Never reproduced locally. One retry with a COMPLETELY
        // FRESH fixture absorbs a transient environment miss without
        // weakening what a genuine regression still has to prove: a second
        // consecutive miss still fails the assertions below for real.
        attempt = await attemptQuotaWallSleepStart();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.sleeping).toBe(true);
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("recordQuotaPark ALSO writes the park when the wall lands on the LAST allowed round, which never sleeps", async () => {
      // This branch used to `return 6` before either `recordQuotaPark` call
      // could run — a normal exit, so `process.on('exit')` rmdirs the lock
      // slot on the way out, leaving `--doctor` a state-only row with no
      // quota evidence at all (UNKNOWN instead of QUOTA_PARKED for a drive
      // that hit a genuine, real wall — see `lib/doctor.ts`'s own precedence
      // header for why that distinction matters).
      let attempt = await attemptQuotaWallOnFinalRound();
      if (attempt.passRan && attempt.exitCode !== 6) {
        // The same CI-runner-only timing margin documented on the
        // sleep-interrupt/takeover siblings above, one detection stage
        // earlier — the pass ran and wrote its transcript, but
        // `detectQuotaBlock` did not see it in time on THIS attempt (the
        // driver falls through to an ordinary `exit 1` pass failure
        // instead of the quota-park `exit 6`), so `attempt.exitCode` never
        // gets a chance to be 6. Never reproduced locally (10/10 local runs
        // pass) and passed on the immediately preceding CI run of this same
        // suite against unchanged production code — the signature of a
        // transient environment miss, not a logic regression. One retry
        // with a COMPLETELY FRESH fixture absorbs it without weakening what
        // a genuine regression still has to prove: a second consecutive
        // miss still fails the assertions below for real.
        attempt = await attemptQuotaWallOnFinalRound();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.exitCode).toBe(6);
      expect(attempt.allStderr).toContain(
        "was already the last of --max-rounds",
      );
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("a delayed pass-spawned progress stamp does not clobber recordQuotaPark, because drive.ts joins it first", async () => {
      // Without the join, this reproduces: the pass exits almost instantly
      // (it only writes the quota transcript), so `recordQuotaPark`'s write
      // lands well before the artificially delayed `pass-spawned` stamp
      // does. That stamp then completes afterwards and, via `withProgress`'s
      // own unconditional `quotaPark: null`, erases the park this same
      // round just recorded — the drive exits 6 with a state file that
      // shows no quota evidence at all for a genuine wall.
      let attempt = await attemptQuotaWallOnFinalRoundWithDelayedProgress();
      if (attempt.passRan && attempt.exitCode !== 6) {
        // Same CI-runner-only detection-timing margin as the
        // sibling fixture's retry immediately above — see that comment for
        // the full diagnosis. One retry with a COMPLETELY FRESH fixture; a
        // second consecutive miss still fails for real.
        attempt = await attemptQuotaWallOnFinalRoundWithDelayedProgress();
      }
      expect(attempt.passRan).toBe(true);
      expect(attempt.exitCode).toBe(6);
      expect(attempt.allStderr).toContain(
        "was already the last of --max-rounds",
      );
      const park = readQuotaPark(attempt.stateDir);
      expect(park).not.toBeNull();
      expect(park?.vendor).toBe("claude");
    }, 30000);

    it("aborts a quota-wall sleep when refreshAccountIdentity notices a COEXISTING claim, not just the removal touchLock already catches", async () => {
      // "interrupts a quota-wall sleep when the lock is recovered mid-sleep"
      // covers `touchLock`'s own takeover signal aborting a quota-wall
      // sleep — but that signal fires only when
      // OUR claim is REMOVED (`utimesSync` on our exact filename throws
      // ENOENT). A resurrection that leaves a SECOND, coexisting claim
      // alongside ours (see "heals a resurrected claim at the pass-exit
      // rewrite" above) never removes our file at all, so `touchLock` never
      // notices it — only `refreshAccountIdentity`'s own post-rewrite
      // `claimWasTakenOver` check does, and it must abort the sleep as well
      // as set `compromised`. Plant the coexisting
      // claim directly (deterministic, no timing race) during a quota-wall
      // sleep, trigger a rewrite via a file-backed identity change, and
      // confirm the sleep ends almost immediately rather than running its
      // full bound.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      // Same reasoning as `attemptQuotaWallSleepInterrupt`: no `cwd`
      // override, since `WORKTREE_LOCK`/`lockDirs()` addresses the lock
      // name derived from this process's own ambient cwd.
      const claudeProjectsDir = join(dir, "claude-projects");
      const passDonePath = join(dir, "quota-pass-done");
      // A standalone helper FILE, not an inline stub body — same
      // multi-layer-quoting reasoning as `attemptQuotaWallSleepInterrupt`'s
      // own helper: the transcript record embeds a real apostrophe and a
      // middle-dot separator.
      const helperPath = join(dir, "write-quota-transcript.mjs");
      writeFileSync(
        helperPath,
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const [, , projDir, doneMarker, ...passArgs] = process.argv;",
          // `prepareQuotaSpawn` injects `--session-id <uuid>` into
          // this pass's own argv, and the quota adapter discards any
          // transcript record whose `sessionId` does not match it — so the
          // record has to carry whatever value was actually injected, not a
          // fixed or absent one.
          "const sessionIdFlagIndex = passArgs.indexOf('--session-id');",
          "const sessionId =",
          "  sessionIdFlagIndex === -1 ? null : passArgs[sessionIdFlagIndex + 1];",
          "mkdirSync(projDir, { recursive: true });",
          "const now = new Date();",
          // The quota parser reads minute precision. Keep its rounded reset
          // at least 20 seconds away even when the pass runs just before a
          // minute boundary; the test timeout still catches a missed abort.
          "const target = new Date(now.getTime() + 80_000);",
          "const h = target.getUTCHours();",
          "const m = target.getUTCMinutes();",
          "const h12 = h % 12 === 0 ? 12 : h % 12;",
          "const ampm = h < 12 ? 'am' : 'pm';",
          "const resetClause = `resets ${h12}:${String(m).padStart(2, '0')}${ampm} (UTC)`;",
          "const record = {",
          "  type: 'assistant',",
          "  cwd: process.cwd(),",
          "  timestamp: now.toISOString(),",
          "  sessionId,",
          "  error: 'rate_limit',",
          "  isApiErrorMessage: true,",
          "  apiErrorStatus: 429,",
          "  message: {",
          "    content: [",
          "      { type: 'text', text: `You've hit your session limit \\u00b7 ${resetClause}` },",
          "    ],",
          "  },",
          "};",
          "writeFileSync(join(projDir, 'session.jsonl'), `${JSON.stringify(record)}\\n`);",
          "writeFileSync(doneMarker, String(Date.now()));",
          "process.exit(1);",
        ].join("\n"),
      );

      // A `claude`-named stub is required here (unlike
      // `attemptQuotaWallSleepInterrupt`'s plain `bun helperPath` pass
      // command): vendor resolution keys off argv[0]
      // literally naming `claude`/`codex`, and this test needs the
      // FILE-BACKED identity path genuinely active so a change to it makes
      // `refreshAccountIdentity` attempt a real rewrite.
      const claudeStubDir = mkdtempSync(
        join(tmpdir(), "drive-pr-claude-stub-"),
      );
      writeFakeProgram(
        join(claudeStubDir, "claude"), // `candidateFiles` (`lib/quota/claude.ts`) scans `root/<subdir>/*.jsonl`
        // — a `.jsonl` sitting directly in the root itself is never found —
        // so the transcript is written one level under `claudeProjectsDir`,
        // matching `attemptQuotaWallSleepInterrupt`'s own
        // `join(claudeProjectsDir, 'proj')`.
        // `"$@"` forwarded so the helper sees the `--session-id <uuid>`
        // `prepareQuotaSpawn` injects into this pass's own argv —
        // without it the transcript record carries no `sessionId` at all and
        // the quota adapter discards it as unattributable to this pass.
        `#!/bin/sh\nexec bun ${JSON.stringify(helperPath)} ${JSON.stringify(join(claudeProjectsDir, "proj"))} ${JSON.stringify(passDonePath)} "$@"\n`,
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
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          // Same reasoning as `attemptQuotaWallSleepInterrupt`: round 1 hits
          // the wall, round 2 is the further round the drive sleeps in order
          // to reach.
          "--max-rounds",
          "2",
          "--",
          "claude",
          "-p",
          "/drive-pr 999",
        ),
        {
          env: {
            ...process.env,
            PATH: `${claudeStubDir}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            CLAUDE_CODE_OAUTH_TOKEN: "",
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
            DRIVE_PR_CLAUDE_PROJECTS_DIR: claudeProjectsDir,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );

      try {
        await awaitFixtureMarker(passDonePath);
        expect(existsSync(passDonePath)).toBe(true);

        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let allStderr = "";
        let sleepingSeen = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (value) allStderr += decoder.decode(value, { stream: true });
          if (!sleepingSeen && allStderr.includes("SLEEPING")) {
            sleepingSeen = true;
            // Plant the coexisting claim directly — the resurrection
            // race's end state, reached deterministically instead of by
            // timing a microsecond gap — then trigger the rewrite attempt
            // that has to notice it.
            plantClaim(worktree, {
              pid: 999999,
              host: "ghost-host",
              nonce: "ghost02",
            });
            writeFileSync(
              claudeJsonPath,
              JSON.stringify({
                oauthAccount: { emailAddress: "after@example.com" },
              }),
            );
          }
          if (done) break;
        }
        expect(sleepingSeen).toBe(true);

        const exitCode = await proc.exited;
        expect(exitCode).toBe(11);
        expect(allStderr).toContain("recovered by another driver");
      } finally {
        proc.kill();
        await proc.exited;
        rmSync(claudeStubDir, { recursive: true, force: true });
        rmSync(claudeConfigDir, { recursive: true, force: true });
      }
    }, 15000);

    function portablePassTree(dir: string): string[] {
      const childCode = `setInterval(() => {}, 1000);`;
      const code = `import {writeFileSync} from 'node:fs'; const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(childCode)}], {stdout:'inherit',stderr:'inherit'}); writeFileSync(${JSON.stringify(join(dir, "pass-started"))}, String(process.pid)); setInterval(() => {}, 1000);`;
      return [process.execPath, "-e", code, "999"];
    }

    function requestHeldDriverStop(prLock: string): void {
      const claim = readdirSync(prLock).find((name) =>
        name.startsWith("claim."),
      );
      expect(claim).toBeDefined();
      if (claim !== undefined)
        requestDriverStop(prLock, claim.slice("claim.".length));
    }

    it.each(["SIGTERM", "SIGHUP"] as const)(
      "stops the pass BEFORE releasing the locks on %s",
      async (signal) => {
        // A signal delivered to the driver pid alone — a supervisor, `kill
        // <pid>`, a harness shutting a worker down — does not reach the pass. The
        // old handler released both locks and exited anyway, so the next driver
        // acquired a free lock on a tree that was still being written.
        const { dir, stateDir } = writeFixture({
          threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        });
        const { worktree, pr } = lockDirs(dir, stateDir);
        const proc = Bun.spawn(
          scriptArgv(
            join(SCRIPTS, "drive.ts"),
            "999",
            "--no-head-sync",
            "--max-rounds",
            "1",
            "--",
            ...portablePassTree(dir),
          ),
          {
            env: {
              ...process.env,
              PATH: `${binDir}${delimiter}${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              DRIVE_PR_STATE_DIR: stateDir,
              DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        await awaitPassStart(dir);
        const captured = await captureProcessTree(
          Number(readFileSync(join(dir, "pass-started"), "utf8")),
        );
        expect(captured).not.toBeNull();
        const mode = byPlatform(
          "Windows uses the cooperative channel because native signals terminate the driver immediately",
          { windows: "request", posix: "signal" },
        );
        // The DRIVER only. The pass runs in its own process group precisely so
        // this signal cannot reach it by accident, which is what leaves the
        // handler as the only thing that can end it.
        if (mode === "request") requestHeldDriverStop(pr);
        else proc.kill(signal);
        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(
          mode === "request" ? 143 : signal === "SIGHUP" ? 129 : 143,
        );
        expect(stderr).toContain("stopping the active pass");
        expect(stderr).toContain(
          `received ${mode === "request" ? "stop request" : signal}`,
        );
        // Both locks released — the pass was provably gone first, so releasing
        // them is safe and the next driver need not recover them as stale.
        expect(existsSync(worktree)).toBe(false);
        expect(existsSync(pr)).toBe(false);
        if (captured !== null)
          expect(await identityTargetsGone(captured)).toBe(true);
      },
      60000,
    );

    it("kills the pass GROUP even when the leader closes first", async () => {
      // `settle` clears the stop's escalation timer, so a leader that exits on
      // the SIGTERM cancels the scheduled group SIGKILL — and a descendant that
      // IGNORES SIGTERM then survives while `exited` resolves, telling the
      // driver the pass is gone.
      // The leader here exits promptly; the grandchild traps TERM and would
      // write its marker four seconds later if only the timer stood behind it
      // — longer than the stop's two-second escalation grace, so a group
      // SIGKILL that does fire lands while it still sleeps.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree } = lockDirs(dir, stateDir);
      const mode = byPlatform(
        "POSIX proves escalation after a leader exits on TERM; native Windows proves captured descendant termination",
        { windows: "captured", posix: "leader-first" },
      );
      const command =
        mode === "captured"
          ? portablePassTree(dir)
          : [
              "sh",
              "-c",
              `: pass for 999; sh -c 'trap "" TERM; sleep 4; : > ${JSON.stringify(join(dir, "pass-late"))}' & : > ${JSON.stringify(join(dir, "pass-started"))}; wait`,
            ];
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...command,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const startedAt = await awaitPassStart(dir);
      const captured =
        mode === "captured"
          ? await captureProcessTree(
              Number(readFileSync(join(dir, "pass-started"), "utf8")),
            )
          : null;
      if (mode === "captured") expect(captured).not.toBeNull();
      simulateTakeover(worktree, "successor02");
      const [, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      if (mode === "leader-first") {
        await outwaitGrandchild(startedAt, 4);
        expect(existsSync(join(dir, "pass-late"))).toBe(false);
      } else if (captured !== null)
        expect(await identityTargetsGone(captured)).toBe(true);
    }, 60000);

    it("forced or repeated shutdown retains the locks while cancellation settles", async () => {
      // A repeated signal conservatively retains claims while the coordinator
      // still waits for every cancellation. A forced native exit cannot run
      // that coordinator and must likewise leave its claims behind.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const { worktree, pr } = lockDirs(dir, stateDir);
      const mode = byPlatform(
        "native Windows forced termination has no signal handler; POSIX repeats the signal during graceful teardown",
        { windows: "forced", posix: "repeated" },
      );
      const command =
        mode === "forced"
          ? portablePassTree(dir)
          : [
              "sh",
              "-c",
              `: pass for 999; trap "" TERM; : > ${JSON.stringify(join(dir, "pass-started"))}; n=0; while [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done`,
            ];
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--",
          ...command,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          // Not piped: the pass ignores SIGTERM and inherits the driver's
          // output, so a pipe stays open until the pass's own loop ends —
          // on a slow runner, past this test's timeout — although the driver
          // itself has long exited. Only the exit code and the locks matter.
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await awaitPassStart(dir);
      const captured = await captureProcessTree(proc.pid);
      expect(captured).not.toBeNull();
      proc.kill("SIGTERM");
      if (mode === "repeated") {
        expect(
          await pollUntil(
            () =>
              readFileSync(join(stateDir, "drive-pr-999.log"), "utf8").includes(
                "received SIGTERM",
              ),
            100,
            10,
          ),
        ).toBe(true);
        proc.kill("SIGTERM");
      }
      const exitCode = await proc.exited;
      expect(exitCode).toBe(143);
      // Repeated cancellation and forced native exit both preserve the claims.
      expect(existsSync(worktree)).toBe(true);
      expect(existsSync(pr)).toBe(true);
      if (captured !== null) {
        expect(await identityTargetsGone(captured)).toBe(mode === "repeated");
        await signalIdentityTargets(captured, "SIGKILL");
      }
      // The pass's own loop can spin for up to 10s (100 x 0.1s)
      // before the escalation SIGKILL lands, on top of spawn/IO overhead —
      // comfortably past bun:test's 5000ms default even without contention.
    }, 20000);
  });
});
