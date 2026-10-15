/**
 * drive-pr suite: drive.ts round control — the mailbox, the pass deadline,
 * --handoff-at, the session and state-dir exports, and the round budget.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAILBOX_PAUSE_TIMEOUT_EXIT,
  MAILBOX_STOPPED_EXIT,
  PASS_DEADLINE_EXIT,
  passTimeoutSeconds,
  QUOTA_PARKED_EXIT,
  resolveHandoffAt,
} from "../scripts/drive";
import { cloneKey } from "../scripts/lib/state/clone-key";
import { appendDirective } from "../scripts/lib/state/mailbox";

import {
  SCRIPTS,
  HEAD,
  PREV,
  binDir,
  suiteHome,
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  writeFixture,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import {
  DRIVE_PACING_ENV,
  PASS_LOUD,
  PASS_NOOP,
  runDrive,
  runDriveIn,
} from "./drive-loop-harness.ts";

useDrivePrSuite();

describe("drive.ts loop control", () => {
  describe("mailbox round control", () => {
    const work = {
      isDraft: true,
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    };

    it("stops before the first status gate or pass and releases its locks", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      await appendDirective(mailboxDir, "999", "test", "pause");
      await appendDirective(mailboxDir, "999", "test", "stop");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(r.stderr).not.toContain("RAN_THE_PASS");
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
    });

    it("times out a pause without spending a pass", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      await appendDirective(mailboxDir, "999", "test", "pause");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        {
          env: {
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
            DRIVE_PR_PAUSE_MAX_SEC: "1",
          },
        },
      );
      expect(r.exitCode).toBe(MAILBOX_PAUSE_TIMEOUT_EXIT);
      expect(r.stderr).not.toContain("RAN_THE_PASS");
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
    });

    it("fails closed on an unreadable directive state", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      mkdirSync(mailboxDir, { recursive: true });
      writeFileSync(join(mailboxDir, "inbox.jsonl"), "{broken json\n");
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--", ...PASS_LOUD],
        undefined,
        { env: { DRIVE_PR_MAILBOX_DIR: mailboxDir } },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("mailbox gate state unreadable");
      expect(r.stderr).not.toContain("RAN_THE_PASS");
    });

    it("resumes a paused drive, then accepts a stop after its active pass finishes", async () => {
      const { dir, stateDir } = writeFixture(work);
      const mailboxDir = join(dir, "mailbox");
      const passStarted = join(dir, "pass-started");
      const passFinished = join(dir, "pass-finished");
      // The pass runs until the test has sent its stop, so the stop always
      // lands while the pass is active. Bounded (200 × 50ms) so a test that
      // fails before releasing it does not leave the pass running.
      const passRelease = join(dir, "pass-release");
      await appendDirective(mailboxDir, "999", "test", "pause");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          "sh",
          "-c",
          `echo start > '${passStarted}'; n=0; while [ ! -e '${passRelease}' ] && [ $n -lt 200 ]; do sleep 0.05; n=$((n+1)); done; echo done > '${passFinished}'; echo 'pass for 999' >&2`,
        ],
        {
          cwd: scratchClean.dir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
            ...DRIVE_PACING_ENV,
            DRIVE_PR_MAILBOX_DIR: mailboxDir,
            // Must outlast every synchronization wait below it, not just the
            // pass itself: the first polling loop can spend
            // up to 100 * 100ms = 10s detecting "paused by mailbox" before
            // `resume` is even sent, plus one more mailbox poll for the
            // driver to notice it. An 8s bound could time the pause out before
            // `resume` ever lands under slow process startup or log
            // observation, failing the test for a reason that has nothing to
            // do with what it is testing.
            DRIVE_PR_PAUSE_MAX_SEC: "20",
            // Fast enough to observe a renewal well inside the sleeps below,
            // same seam the sibling 'renews a held claim DURING a pass' test
            // uses.
            DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const logPath = join(stateDir, "drive-pr-999.log");
      for (let n = 0; n < 100; n++) {
        if (
          existsSync(logPath) &&
          readFileSync(logPath, "utf8").includes("paused by mailbox")
        )
          break;
        await Bun.sleep(100);
      }
      expect(existsSync(passStarted)).toBe(false);

      // A post-exit check that the lock is gone proves the
      // pause eventually LETS GO — it says nothing about whether the lock
      // stayed HELD and FRESH while the pause was still active. Releasing
      // it at pause entry would satisfy every assertion above and below
      // just as well, despite breaking the single-driver guarantee a pause
      // must not weaken. Assert both directly, with the pause still live:
      const prLockDir = join(stateDir, "pr-drive-999.lock");
      const claimsInPrLock = () =>
        readdirSync(prLockDir).filter((n) => n.startsWith("claim."));
      const heldClaims = claimsInPrLock();
      expect(heldClaims.length).toBe(1);
      const claimPath = join(prLockDir, heldClaims[0] as string);
      const firstBeat = statSync(claimPath).mtimeMs;

      // A competing invocation against the SAME PR must still be refused —
      // a pause holds the lock, it does not release it.
      const competitor = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--",
          ...PASS_LOUD,
        ],
        {
          cwd: scratchClean.dir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [competitorStderr, competitorExit] = await Promise.all([
        new Response(competitor.stderr).text(),
        competitor.exited,
      ]);
      expect(competitorExit).toBe(11);
      expect(competitorStderr).not.toContain("RAN_THE_PASS");

      // And the lease must stay FRESH across a heartbeat interval — a
      // driver that stopped renewing while paused would eventually look
      // recoverable to exactly the competitor above.
      await Bun.sleep(500);
      const secondBeat = statSync(claimPath).mtimeMs;
      expect(secondBeat).toBeGreaterThan(firstBeat);

      await appendDirective(mailboxDir, "999", "test", "resume", {
        target: "pause",
      });
      for (let n = 0; n < 100 && !existsSync(passStarted); n++)
        await Bun.sleep(100);
      expect(existsSync(passStarted)).toBe(true);
      await appendDirective(mailboxDir, "999", "test", "stop");
      writeFileSync(passRelease, "");
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(MAILBOX_STOPPED_EXIT);
      expect(existsSync(passFinished)).toBe(true);
      expect(stderr).toContain("stop requested");
      expect(existsSync(join(dir, "ready-calls"))).toBe(true);
      expect(existsSync(join(stateDir, "pr-drive-999.lock"))).toBe(false);
      // 25s, not 20s: the added competing-invocation spawn and heartbeat
      // freshness wait above cost this test a little over half a second in
      // the common case, but leave the same worst-case synchronization
      // waits (up to 10s apiece) as before with less margin under the old
      // bound.
    }, 25000);
  });

  // ── The pass deadline ────────────────────────────────────────
  // The pass was the last undeadlined thing in this skill, and the gap it left
  // is not one any other stop here can reach: `--max-rounds`, the stall streak
  // and the status poll's `--timeout` all fire BETWEEN rounds, so a pass that
  // never returns outlives every one of them while the claim heartbeat keeps
  // reporting the driver LIVE.
  describe("passTimeoutSeconds", () => {
    const saved = process.env.DRIVE_PR_PASS_TIMEOUT;
    afterEach(() => {
      if (saved === undefined) delete process.env.DRIVE_PR_PASS_TIMEOUT;
      else process.env.DRIVE_PR_PASS_TIMEOUT = saved;
    });

    it("defaults to 90 minutes", () => {
      delete process.env.DRIVE_PR_PASS_TIMEOUT;
      expect(passTimeoutSeconds()).toBe(5400);
    });

    it("takes a whole number of seconds", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "120";
      expect(passTimeoutSeconds()).toBe(120);
    });

    it('treats 0 as "no deadline", matching every other knob in this skill', () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "0";
      expect(passTimeoutSeconds()).toBe(0);
    });

    // An unusable value in the ENVIRONMENT is inherited noise, not an
    // instruction: a drive must not refuse to start because some ancestor
    // shell exported junk. The FLAG is the front door and validates at exit 2
    // (see `--pass-timeout` in main), which is where a typo belongs.
    it.each(["", "abc", "-1", "12.5", " 120"])(
      "falls back to the default for the unusable value %p",
      (v) => {
        process.env.DRIVE_PR_PASS_TIMEOUT = v;
        expect(passTimeoutSeconds()).toBe(5400);
      },
    );

    // `run()` forwards this value to `setTimeout`, whose delay is a 32-bit
    // signed millisecond count: 2147483 is the last whole second under that
    // limit, 2147484 overflows it and fires immediately — so a caller asking
    // for a MORE generous deadline would silently get a pass killed at once.
    it("accepts the largest representable timeout in whole seconds", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "2147483";
      expect(passTimeoutSeconds()).toBe(2147483);
    });

    it("falls back to the default rather than overflowing setTimeout", () => {
      process.env.DRIVE_PR_PASS_TIMEOUT = "2147484";
      expect(passTimeoutSeconds()).toBe(5400);
    });
  });

  // The new stops must stay distinct from each other and from every
  // pre-existing code, because each one asks its reader for a different next
  // action: widen a deadline or hunt a hang (15), versus wait for a clock and
  // re-arm (16), versus read the pass output (1).
  it("keeps the deadline and quota-parked codes distinct and unclaimed", () => {
    expect(PASS_DEADLINE_EXIT).toBe(15);
    expect(QUOTA_PARKED_EXIT).toBe(16);
    const preexisting = [0, 1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];
    expect(preexisting).not.toContain(PASS_DEADLINE_EXIT);
    expect(preexisting).not.toContain(QUOTA_PARKED_EXIT);
    expect(PASS_DEADLINE_EXIT).not.toBe(QUOTA_PARKED_EXIT);
  });

  // ── Spawn-boundary integration floor ────────────────────────────────────
  // The mapping above is pure, so nothing in it shows that a REAL pass's exit
  // status is what reaches it, or that the flattened code is what the drive
  // itself exits with. One spawn covers that edge for the flattened branch;
  // `propagates a pass exit 5 as PR_NOT_OPEN` above is the same witness for
  // the propagated one. Both branches keep a subprocess probe deliberately —
  // a floor that covered only one of them would leave the other's wiring
  // asserted nowhere.
  // The deadline's own spawn-boundary floor. `passTimeoutSeconds` is pure and
  // `run()`'s deadline is covered by proc.ts's suite, but neither shows that
  // drive.ts actually WIRES one to the other — that the flag reaches the spawn,
  // that a detached pass tree is what gets killed, and that `timedOut` (not the
  // 124) is what selects exit 15. A unit seam cannot assert any of that, so
  // this one pays for a real drive.
  it("kills a pass that outlives --pass-timeout and exits PASS_DEADLINE", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      // The PR number has to appear: drive.ts asserts out-of-band that the
      // pass it launches names the PR it is driving. Then it hangs, which is
      // the whole point — this is the shape no other stop in the loop reaches.
      [
        "--no-head-sync",
        "--pass-timeout",
        "1",
        "--",
        "sh",
        "-c",
        ": pass for 999; sleep 60",
      ],
    );
    expect(r.exitCode).toBe(PASS_DEADLINE_EXIT);
    expect(r.stderr).toContain("deadline");
    // Not flattened to the generic failure, which is the distinction the
    // separate code exists to preserve.
    expect(r.stderr).not.toContain("not driving further");
    // And it names the recovery, because a killed pass is not rolled back.
    expect(r.stderr).toContain("git status --short");
  });

  it("refuses --pass-timeout above the setTimeout limit at exit 2, before spawning anything", async () => {
    // The env accessor `passTimeoutSeconds()` falls back to the default for
    // this value — correct for inherited noise, but a FLAG's typo must refuse
    // at the front door like every other bad flag, not silently substitute a
    // shorter deadline than the one requested.
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--pass-timeout", "2147484", "--", ...PASS_NOOP],
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(
      "--pass-timeout must be 0 or no greater than 2147483 seconds",
    );
  });

  it("exits 1 for a REAL pass that failed, naming the code it flattened", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      // The PR number has to appear: drive.ts asserts out-of-band that the
      // pass it launches names the PR it is driving.
      ["--no-head-sync", "--", "sh", "-c", ": pass for 999; exit 3"],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("exit 3");
  });

  it("arms $DRIVE_PR_REFLECT_DUE past the third round, and not before", async () => {
    // The /reflect obligation sits past three rounds: repeat findings at that
    // depth are a scaffolding gap, not reviewer noise. A shell script cannot
    // invoke a slash command, so the exported flag IS the mechanism — if it
    // never reaches the pass, the duty is back in session memory, which is what
    // this skill exists to end. Unbraced `$VAR` on purpose: `${VAR:-default}`
    // inside a plain JS string reads to biome as a mistyped template literal.
    // An unset variable echoes as empty, which is the assertion below anyway.
    const PASS_ECHO_FLAG = [
      "sh",
      "-c",
      'echo "pass for 999: REFLECT=[$DRIVE_PR_REFLECT_DUE]" >&2; exit 0',
    ];
    // Five deliberate no-op rounds — the reflect duty only arms past round 3,
    // so the stall stop (which would correctly end this drive at gate 3) is
    // disabled for the probe. The stall behaviour has its own probes.
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      ["--no-head-sync", "--max-rounds", "5", "--", ...PASS_ECHO_FLAG],
      undefined,
      { env: { DRIVE_PR_STALL_ROUNDS: "0", JIG__REFLECTION__ENABLED: "true" } },
    );
    // The stub pass never advances the head, so `passes` drives the count:
    // rounds 1-3 unset, rounds 4-5 armed.
    expect(r.stderr).toContain("REFLECT=[]");
    expect(r.stderr).toContain("REFLECT=[4]");
    expect(r.stderr).toContain("REFLECT=[5]");
    expect(r.stderr).not.toContain("REFLECT=[3]");
    expect(r.stderr).toContain("/jig:reflect is DUE");
  });

  it("never arms $DRIVE_PR_REFLECT_DUE while reflection is off", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--max-rounds",
        "5",
        "--",
        "sh",
        "-c",
        'echo "pass for 999: REFLECT=[$DRIVE_PR_REFLECT_DUE]" >&2; exit 0',
      ],
      undefined,
      { env: { DRIVE_PR_STALL_ROUNDS: "0" } },
    );
    expect(r.stderr).toContain("REFLECT=[]");
    expect(r.stderr).not.toContain("REFLECT=[4]");
    expect(r.stderr).not.toContain("is DUE");
  });

  describe("--handoff-at, the context-economy dial", () => {
    // Nothing here can read a session's context usage, so the dial is an
    // agent-side INSTRUCTION in the same shape as $DRIVE_PR_REFLECT_DUE. The
    // export is therefore the whole mechanism: if it never reaches the pass,
    // the setting does not exist.
    const PASS_ECHO_DIAL = [
      "sh",
      "-c",
      'echo "pass for 999: DIAL=[$DRIVE_PR_HANDOFF_AT]" >&2; exit 0',
    ];

    it("defaults to 50 and exports it to the pass", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        ["--no-head-sync", "--max-rounds", "1", "--", ...PASS_ECHO_DIAL],
      );
      expect(r.stderr).toContain("DIAL=[50]");
    });

    it("resolves each alias to the canonical value the pass reads", () => {
      // The pass must read a number or the literal `never` — never a
      // vocabulary. An alias arriving unresolved is a second taxonomy for the
      // pass to interpret, which is what the numeric flag exists to avoid.
      //
      // Asserted against the exported resolver rather than by spawning a whole
      // `drive.ts` per alias, which is what this used to do: one drive per
      // handoff value, each taking both locks, running a stubbed gate and a
      // pass, to read one string back out of the child's environment. It
      // measured 35.9s of a 733s suite — 4.9% of the whole file for a total
      // function of one string — and carried a
      // hand-raised 120s budget to survive that. The assertion is unchanged:
      // same pairs, same canonical values. What is gone is the machinery
      // between the table and the check, none of which this test names.
      //
      // The spawn it dropped is NOT unwitnessed. `exports a resolved ALIAS to
      // the pass` below still drives one alias end to end, so the one thing a
      // subprocess could see that this cannot — that the resolved value reaches
      // the pass as $DRIVE_PR_HANDOFF_AT at all — keeps a probe of its own.
      expect(
        ["75", "careful", "eager", "never", "continuous"].map((flag) => [
          flag,
          resolveHandoffAt(flag),
        ]),
      ).toEqual([
        ["75", "75"],
        ["careful", "50"],
        ["eager", "75"],
        ["never", "never"],
        ["continuous", "never"],
      ]);
    });

    // ── Spawn-boundary integration floor ──────────────────────────────────
    // The resolver above is pure, so no assertion over it can show that its
    // answer is EXPORTED. This drive is the witness for that edge, and it uses
    // an ALIAS deliberately: `defaults to 50` above already covers the
    // no-flag path, so a floor that also spelled a literal percent would leave
    // alias-resolution-then-export — the composition, which is where a
    // regression that resolves correctly and exports the raw word would live —
    // with no end-to-end probe at all.
    it("exports a resolved ALIAS to the pass", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        [
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--handoff-at",
          "eager",
          "--",
          ...PASS_ECHO_DIAL,
        ],
      );
      expect(r.stderr).toContain("DIAL=[75]");
      // The raw alias must not survive to the pass — the failure this whole
      // block exists to catch is the pass being handed a vocabulary.
      expect(r.stderr).not.toContain("DIAL=[eager]");
    });

    it("rejects a value that is neither a percent nor never", async () => {
      for (const bad of ["0", "101", "abc", "50.5", "relay", "-1"]) {
        const r = await runDrive({ threads: [] }, [
          "--no-head-sync",
          "--handoff-at",
          bad,
          "--",
          ...PASS_ECHO_DIAL,
        ]);
        expect({ bad, exit: r.exitCode }).toEqual({ bad, exit: 2 });
        expect(r.stderr).not.toContain("DIAL=");
      }
    });

    it("gates `never` on the durable held batch being available", async () => {
      // `never` is the one setting that EXPECTS a compaction mid-round, and a
      // compaction between the reply and the resolve drops the held batch
      // unless it is durable. Starting a continuous drive without the state
      // that makes it survivable is the failure, so the driver probes for it.
      // An unreadable state file models a drive-state.ts that cannot serve the
      // batch, whatever the reason.
      const { dir, stateDir } = writeFixture({ threads: [] });
      writeFileSync(join(stateDir, "drive-pr-999.json"), "not usable state");
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--handoff-at",
          "never",
          "--",
          ...PASS_ECHO_DIAL,
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
      expect(exitCode).toBe(2);
      expect(stderr).toContain("refusing --handoff-at never");
      expect(stderr).not.toContain("DIAL=");
    });

    it("announces the setting, because nothing enforces it", async () => {
      const r = await runDrive(
        { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
        [
          "--no-head-sync",
          "--max-rounds",
          "1",
          "--handoff-at",
          "75",
          "--",
          ...PASS_ECHO_DIAL,
        ],
      );
      expect(r.stderr).toContain("agent-judged, not measured");
    });
  });

  it("does NOT re-arm on HITL_PARKED", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [join(SCRIPTS, "drive.ts"), "999", "--no-head-sync", "--", ...PASS_LOUD],
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
    expect(exitCode).toBe(8);
    expect(stderr).not.toContain("RAN_THE_PASS");
    expect(stderr).toContain("arbiter escalated");
  });

  it("exports its OWN pid as the drive-state session, so a whole drive is one session", async () => {
    // The locks above keep a second DRIVER out of this tree; they do nothing
    // about a driver-by-hand, which takes no lock at all. What extends the
    // guarantee to that case is the session lease every mutating drive-state
    // command takes — and for it to cover a whole drive, this
    // driver plus every round's pass (each a separate agent process, each with
    // an agent pid of its own) must count as ONE session. Only this process's
    // pid does that: it spans every pass, and it dies exactly when the drive
    // does, so an interactive session in the same tree is refused BETWEEN
    // rounds and not merely during one.
    const marker = join(
      mkdtempSync(join(tmpdir(), "drive-session-")),
      "session",
    );
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        `: pass for 999; printf '%s %s' "$DRIVE_PR_SESSION" "$PPID" > ${JSON.stringify(marker)}`,
      ],
    );
    expect(r.exitCode).toBeDefined();
    // `$PPID` inside the pass IS the driver: the pass is spawned by this
    // process (detached into its own process group, but still its child). So
    // asserting the two are equal pins "the exported session is the DRIVER's
    // pid", not merely "something numeric was exported".
    const [session, parent] = readFileSync(marker, "utf8").split(" ");
    expect(session).toMatch(/^[0-9]+$/);
    expect(session).toBe(parent);
  });

  it("exports the resolved STATE DIR too, so a pass never re-derives it from `.git`", async () => {
    // The fence's allow-path asks "is a repository in play" from the
    // filesystem, which distinguishes a marker that is unreadable from one
    // that is confirmed absent — but a `.git` DELETED or RENAMED after a drive
    // wrote its lease is a genuine ENOENT, indistinguishable from a tree that
    // never held a repository, and the POST would be permitted with that live
    // lease unread.
    //
    // No probe closes that; durable knowledge does. The driver already
    // resolved the directory, so it hands it down — and because
    // $DRIVE_PR_STATE_DIR short-circuits the repository probe entirely, a pass
    // that inherits it reads the real lease whatever happened to its marker.
    //
    // The harness normally SETS $DRIVE_PR_STATE_DIR for the driver, which
    // would make this vacuous: the pass would inherit the harness's value
    // whether or not drive.ts exports anything. So the override is blanked and
    // the driver has to resolve the directory itself, from a repository of
    // this probe's own — asserting the pass received exactly that repo's
    // an earlier change default (`~/.local/state/jig/drive-pr/<cloneKey>`, keyed off this
    // repo's own `--git-common-dir`, never that directory itself newer)
    // pins BOTH halves ("something was exported" and "it is the right
    // directory"). Exporting an unrelated path would send the fence hunting
    // leases in the wrong place, which is worse than not exporting.
    const repo = makeScratchRepo("drive-statedir-probe");
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: repo.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(commonDir).not.toBe("");
    // `gitCleanEnv()` pins `$HOME` to `suiteHome` for every subprocess this
    // suite spawns (including the pass below), so the driver's own
    // `cloneKey(realpath(commonDir))` under that same `$HOME` is exactly what
    // `defaultStateDirFor` would compute — reproduced here via `cloneKey`
    // directly rather than `defaultStateDirFor` (which reads the REAL
    // `os.homedir()` of THIS test process, not the subprocess's `suiteHome`).
    const expected = join(
      suiteHome,
      ".local",
      "state",
      "jig",
      "drive-pr",
      cloneKey(resolve(repo.dir, commonDir)),
    );

    const marker = join(
      mkdtempSync(join(tmpdir(), "drive-statedir-")),
      "statedir",
    );
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        "sh",
        "-c",
        `: pass for 999; printf '%s' "$DRIVE_PR_STATE_DIR" > ${JSON.stringify(marker)}`,
      ],
      repo.dir,
      { env: { DRIVE_PR_STATE_DIR: "" } },
    );
    expect(r.exitCode).toBeDefined();
    const exported = readFileSync(marker, "utf8");
    expect(exported).not.toBe("");
    // `realpath`ed because macOS's tmpdir is a `/var` -> `/private/var`
    // symlink and both `mkdtempSync` (this test's `suiteHome`) and the
    // driver's own resolution cross it — the two spellings name one
    // directory, and comparing them literally fails on the platform this
    // suite runs on. Both sides are already absolute (an earlier change's default is
    // never printed relative to a cwd the way `--git-common-dir` could be),
    // so no `resolve(repo.dir, …)` is needed before `realpathSync`.
    expect(realpathSync(exported)).toBe(realpathSync(expected));
  });

  it("refuses a pass command that names a different PR", async () => {
    const r = await runDrive({ threads: [] }, [
      "--no-head-sync",
      "--",
      "claude",
      "-p",
      "/drive-pr 1234",
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("names no PR");
  });

  it("carries the round budget across process restarts", async () => {
    // The durable count exists so the bound survives restarts. A per-process
    // counter hands every resumed drive a fresh full budget, so a "bounded"
    // unattended loop runs forever across resumptions.
    //
    // Asserting only that each invocation eventually exits 6 does NOT pin this:
    // on an unchanged head the round count stays flat, so a restart that ran
    // another full `--max-rounds` of passes would still exit 6 at the end and
    // satisfy that assertion while doing exactly what the bound forbids. What
    // is asserted instead is that the restart runs NO pass at all — which is
    // only true if prior attempts on an unchanged head consumed durable budget.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
      // Durable-budget accounting across restarts is the subject, and it needs
      // the first invocation to genuinely exhaust --max-rounds on no-op
      // passes — which the stall stop would (correctly) end one gate early.
      // The stall behaviour has its own probes above.
      DRIVE_PR_STALL_ROUNDS: "0",
    };
    const once = async () => {
      const p = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          "2",
          "--",
          ...PASS_LOUD,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stderr, exitCode };
    };
    // First invocation burns the budget (the stub pass never changes the head,
    // so drive-state counts one round and the loop re-reads the same state).
    const first = await once();
    expect(first.exitCode).toBe(6);
    expect(first.stderr.match(/RAN_THE_PASS/g)?.length).toBe(2);
    // A restart must NOT get a fresh budget — and must not run even one pass.
    const second = await once();
    expect(second.exitCode).toBe(6);
    expect(second.stderr).not.toContain("RAN_THE_PASS");
    expect(second.stderr).toContain("resuming PR #999 at round");
  });

  /** Seed the durable state directly, to model a drive resumed at its bound. */
  function seedRounds(stateDir: string, rounds: number, head = HEAD) {
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({
        pr: 999,
        rounds,
        lastCountedHead: head,
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [],
        held: [],
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
      }),
    );
  }

  it("RAISING --max-rounds admits the round the previous bound rejected", async () => {
    // drive-status.ts persists a head before drive.ts rejects it, so the
    // over-limit head is already counted. Seeding a local counter from that
    // durable count and incrementing on top counts the head twice across the
    // resume: the operator raises 3 → 4 to admit exactly this round, and it is
    // rejected again without the pass ever running.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // 3 heads counted, and the head about to be reviewed is not one of them —
    // so drive-status.ts will bump the durable count to 4 before drive.ts sees
    // it, exactly as it does at a real bound.
    seedRounds(stateDir, 3, PREV);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
    };
    const at = async (max: string) => {
      const p = Bun.spawn(
        [
          join(SCRIPTS, "drive.ts"),
          "999",
          "--no-head-sync",
          "--max-rounds",
          max,
          "--",
          ...PASS_LOUD,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { stderr, exitCode };
    };
    // At the old bound the head is counted (3 → 4) and then rejected.
    const held = await at("3");
    expect(held.exitCode).toBe(6);
    expect(held.stderr).not.toContain("RAN_THE_PASS");
    // Resume with the limit raised by one — no re-seed, because the whole point
    // is that this head is ALREADY counted. It must now be worked.
    const raised = await at("4");
    expect(raised.stderr).toContain("RAN_THE_PASS");
  });
});
