/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { claimWasTakenOver, inspect, roundFingerprint } from "../scripts/drive";
import {
  LEAVE_OPEN_MARKER,
  NO_OUTCOME_MARKER,
} from "../scripts/lib/outcome.ts";
import { leasePathFor } from "../scripts/lib/state/lease";
import { ROUND_PATHS_MAX_PER_ROUND } from "../scripts/lib/state/schema";
// Imported, never restated: every fixture age below is derived from the
// production floor, so raising it cannot silently leave a probe sitting
// underneath it and passing vacuously.
import {
  isLeftOpenThread,
  RECONCILIATION_INTERVAL_SEC,
  RECONCILIATION_REACTIVATION_SEC,
  REVIEW_PUBLICATION_MARGIN_SEC,
  STALLED_MIN_AGE_SEC,
} from "../scripts/lib/status/evaluate";

import {
  SCRIPTS,
  HEAD,
  PREV,
  BASE_MOVED,
  realHead,
  STICKY_ROUND,
  REVIEWER_RUN,
  DORMANT_ARM,
  tmpRoot,
  binDir,
  scratchClean,
  scratchOther,
  gitCleanEnv,
  makeOrphanCommit,
  makeScratchRepo,
  type FixtureThread,
  writeFixture,
  probeIn,
  probe,
  park,
  hold,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

describe("drive-status.ts surfaces drive-state.ts’s stderr", () => {
  it("does not swallow a one-time warning it is the first caller to trigger", async () => {
    // `evaluate()`'s `parked-keys` call is the FIRST drive-state.ts invocation
    // of a drive, so it reliably reaches any one-time, marker-guarded warning
    // first. Redirecting its stderr to /dev/null consumed that single showing
    // invisibly while the marker stayed claimed, so every later human-visible
    // `rounds`/`get` stayed silent about state holding parked human decisions.
    //
    // Probed through the malformed-state message rather than the orphan one:
    // it is the other thing drive-state.ts writes to stderr, it needs no
    // worktree scaffolding, and the property under test is the same — whether
    // this caller passes that channel through at all.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    writeFileSync(join(stateDir, "drive-pr-999.json"), '{"pr": 999, "rounds"');
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    // drive-status.ts's own summary, AND the detail from the layer below it.
    expect(stderr).toContain("cannot read the parked set");
    expect(stderr).toContain("not usable drive state");
  });

  it("refuses a foreign-worktree drive BEFORE the reconciliation sweep can touch GitHub", async () => {
    // The sweep is not a drive-state mutation, so `claimLease` never gated it —
    // but it is not read-only either: `reconcile-replied-threads.ts` invokes
    // `resolve-thread.ts` and resolves threads ON GITHUB. Exit 13 was first
    // raised at the leased `bump-round` much further down, so a second worktree
    // reached the sweep, resolved threads belonging to another resolver's
    // round, and only afterwards learned it was not admitted.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      reviewedSha: HEAD,
    });
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // A live lease belonging to ANOTHER working tree — a foreign actor, so
      // this is the PR-wide condition (13) and not the same-tree one (11).
      writeFileSync(
        leasePathFor(stateDir, "999", "wt-0000000000000abc"),
        JSON.stringify({
          holder: "session",
          pid: holder.pid,
          host: hostname(),
          platform: process.platform,
          actor: "wt-0000000000000abc",
          worktree: "/some/other/tree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "a".repeat(32),
          sessionStarted: "",
        }),
      );
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--head",
          HEAD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_SESSION: String(process.pid),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({
        exitCode,
        state: JSON.parse(out.trim()).state,
      }).toEqual({ exitCode: 13, state: "DRIVE_HELD_BY_OTHER_WORKTREE" });
      expect(stderr).toContain("ANOTHER working tree");
      // The point of the test: it refused BEFORE reaching the sweep, so no
      // thread was resolved on the other resolver's behalf.
      //
      // Asserted through the sweep's own log lines, which is what actually
      // distinguishes the paths here — the refusal returns before the sweep
      // block is entered, so none of its messages can appear. Not a count of
      // `resolve-thread.ts` invocations: nothing in this fixture records those,
      // and claiming otherwise would describe a mechanism that does not exist.
      expect(stderr).not.toContain("reconciliation sweep");
    } finally {
      holder.kill();
    }
  });

  it("propagates a session-lease refusal as exit 11, not as INDETERMINATE", async () => {
    // This gate is the DOCUMENTED first command of a pass (SKILL.md § 1), so a
    // second interactive session in one tree meets the lease HERE — inside the
    // round-counting `bump-round`. Discarding that child's stderr and mapping
    // every non-zero to INDETERMINATE told the refused session to go hunting
    // for an unwritable state dir, withholding the holder's pid, `ps -p` and
    // `clear-lease` — the three things that make the refusal actionable and
    // the whole reason the lease reports a holder at all.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      reviewedSha: HEAD,
    });
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // A live OTHER session in this same tree takes the lease first.
      const seed = Bun.spawnSync(
        [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
        {
          env: {
            ...process.env,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_SESSION: String(holder.pid),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(seed.exitCode).toBe(0);

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--head",
          HEAD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_SESSION: String(process.pid),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(JSON.parse(out.trim()).state).toBe("SESSION_LEASE_HELD");
      // The refusal's own diagnostic, verbatim from the layer that made it.
      expect(stderr).toContain(`pid ${holder.pid}`);
      expect(stderr).toContain(`ps -p ${holder.pid}`);
      expect(stderr).toContain("clear-lease 999");
    } finally {
      holder.kill();
    }
  });

  it("propagates exit 11 from `bump-attempt` when --no-count skips bump-round", async () => {
    // The parser accepts `--no-count` and `--bump-attempt` together, and under
    // that pair `bump-round` never runs — so `bump-attempt` is the FIRST leased
    // call of the process and the only one that can meet the lease. It is in
    // drive-state.ts's LEASED_COMMANDS and returns 11 unaided, so mapping its
    // non-zero to INDETERMINATE discarded the holder's pid, `ps -p` and
    // `clear-lease` on precisely the path with no earlier call to have
    // surfaced them.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      reviewedSha: HEAD,
    });
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const seed = Bun.spawnSync(
        [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
        {
          env: {
            ...process.env,
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_SESSION: String(holder.pid),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(seed.exitCode).toBe(0);

      // `DRIVE_PR_TARGET` must be absent, or the bump is skipped entirely and
      // this test would pass without exercising the branch at all.
      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_SESSION: String(process.pid),
      };
      delete (env as Record<string, string | undefined>).DRIVE_PR_TARGET;

      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--no-count",
          "--bump-attempt",
          "--head",
          HEAD,
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const [out, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(11);
      expect(JSON.parse(out.trim()).state).toBe("SESSION_LEASE_HELD");
      expect(stderr).toContain(`pid ${holder.pid}`);
      expect(stderr).toContain(`ps -p ${holder.pid}`);
      expect(stderr).toContain("clear-lease 999");
    } finally {
      holder.kill();
    }
  });
});

describe("drive-status.ts terminal states", () => {
  it("CONVERGED — reviewer completed on this head, marker matches, nothing open", async () => {
    const r = await probe({ threads: [], reviewedSha: HEAD });
    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
    expect((r.json.reviewer as Record<string, unknown>).reviewedShaSource).toBe(
      "comment-marker",
    );
  });

  it("ROUND_READY — unresolved threads on a reviewed head", async () => {
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    expect((r.json.work as Record<string, unknown>).unresolvedThreads).toBe(1);
  });

  it("PR_NOT_OPEN — merged mid-loop, detected before anything else", async () => {
    const r = await probe({ prState: "MERGED", threads: [] });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("REVIEWER_FAILED — the posting reviewer’s run did not pass", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }, DORMANT_ARM],
    });
    expect(r.state).toBe("REVIEWER_FAILED");
    expect(r.exitCode).toBe(7);
  });
});

// The single pass-start entry point: on ROUND_READY, `--bump-attempt`
// records this pass BEFORE `reflectDue` is computed, so the interactive path
// gets the same ordering `drive.ts` always had for free, in one call instead
// of the two-command "bump then recheck" it used to require.
describe("drive-status.ts --bump-attempt", () => {
  async function driveState(
    stateDir: string,
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), exitCode };
  }

  it("the SAME call reports reflectDue against POST-bump counters — no separate recheck needed", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // Passes 1-3 on one head: attempts 1..3, still under the default
    // threshold (due when depth > 3).
    const on = { env: { JIG__REFLECTION__ENABLED: "true" } };
    for (let i = 0; i < 3; i++) {
      const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"], on);
      expect(r.exitCode).toBe(0);
      expect(r.json.reflectDue).toBe(false);
    }
    // Pass 4 crosses the threshold, and this SAME call's own report already
    // says so — not a call later, which is the off-by-one this flag closes.
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"], on);
    expect(r.json.reflectDue).toBe(true);
    // With reflection off, the same depth asks for nothing.
    const off = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(off.json.reflectDue).toBe(false);

    const s = JSON.parse((await driveState(stateDir, ["get", "999"])).stdout);
    expect(s.rounds).toBe(1);
    expect(s.attempts).toBe(5);
  });

  it("a pass-start on the same head twice counts the head once, the attempts twice", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    const s = JSON.parse((await driveState(stateDir, ["get", "999"])).stdout);
    expect(s.rounds).toBe(1);
    expect(s.attempts).toBe(2);
  });

  it("without the flag, the attempt counter is never touched — the unattended driver is unaffected", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(dir, stateDir, HEAD, []);
    const s = JSON.parse((await driveState(stateDir, ["get", "999"])).stdout);
    expect(s.rounds).toBe(1);
    expect(s.attempts).toBe(0);
  });

  it("under drive.ts ($DRIVE_PR_TARGET set), --bump-attempt is a no-op — drive.ts already bumped it", async () => {
    // drive.ts bumps the durable attempt counter itself (its own separate
    // `drive-state.ts bump-attempt` call) BEFORE spawning the pass that then
    // runs this exact gate command per SKILL.md § 1. Without this guard the
    // spawned pass's own --bump-attempt double-counts every real round under
    // the unattended driver: reflectDue fires after 2 passes instead of more
    // than 3, and --max-rounds trips around pass 5 instead of 10.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // Simulate drive.ts's own bump, done before it spawns the pass.
    await driveState(stateDir, ["bump-attempt", "999", "--head", HEAD]);
    // The spawned pass's step-1 gate call — always includes --bump-attempt,
    // unconditionally, exactly as SKILL.md § 1 instructs.
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"], {
      env: { DRIVE_PR_TARGET: "999" },
    });
    expect(r.exitCode).toBe(0);
    const s = JSON.parse((await driveState(stateDir, ["get", "999"])).stdout);
    expect(s.rounds).toBe(1);
    // Only drive.ts's own bump counted — the pass's own --bump-attempt was a
    // no-op, not a second increment.
    expect(s.attempts).toBe(1);
  });
});

// `structuralEscalationDue` is the recurrence half of the round
// gate: it arms when a reviewer finding lands on the same FILE in two
// consecutive rounds, which is deliberately sharper than `reflectDue`'s
// round-DEPTH trigger — it fires while there is one narrow fix to reconsider
// rather than three (the depth trigger was measured arriving at round 4 on a
// signal that was unambiguous at round 2).
//
// The predicate's own edges are covered in structural-escalation.test.ts
// against hand-built state. What is covered HERE is the wiring the predicate
// depends on and cannot assert for itself: that a counting gate files this
// round's anchors into durable state at all, that a non-counting one does not,
// and that the field the report publishes is derived from what was just filed
// rather than from the round before it.
describe("drive-status.ts structuralEscalationDue", () => {
  async function driveState(
    stateDir: string,
    args: string[],
  ): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), exitCode };
  }

  it("files this round’s anchor paths and publishes them in the report", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
        { id: "PRRT_c", path: "b.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    // A SET, not a list: three findings on two files is two files.
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts", "b.ts"]);
    expect(r.json.structuralEscalationDue).toBe(false);
    expect(
      JSON.parse((await driveState(stateDir, ["round-paths", "999"])).stdout),
    ).toEqual([{ round: 1, paths: ["a.ts", "b.ts"] }]);
  });

  // Regression: `a.ts` and ` a.ts` are two
  // distinct, legitimate repository paths — trimming both before storing them
  // as the recurrence identity would alias them to the same key, arming
  // `structuralEscalationDue` on findings from two different files. `.trim()`
  // is used only to detect a whitespace-only path, never to transform it.
  it("a path’s own leading/trailing whitespace is preserved, not aliased away", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", path: " a.ts", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual([" a.ts", "a.ts"]);
  });

  it("arms on the same file two consecutive rounds — in the SAME report", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(
      (await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]))
        .json.structuralEscalationDue,
    ).toBe(false);

    // A new head is a new ROUND. The state dir is the first round's, because
    // the durable record is per-PR-per-clone, not per-fixture.
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.exitCode).toBe(0);
    // The field is computed AFTER this round's anchors are filed, so the round
    // that completes the pair says so itself rather than a round later — the
    // off-by-one `--bump-attempt` had to close for `reflectDue`.
    expect(r.json.structuralEscalationDue).toBe(true);
  });

  it("does NOT arm when the rounds land on disjoint files", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "z.ts", bot: true }],
    });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.json.structuralEscalationDue).toBe(false);
  });

  // `set-escalated --invariant` persists what a round believed it
  // closed, and the NEXT arming of the same file echoes it back — so the
  // round investigating a recurrence sees the prior claim directly instead of
  // re-deriving it from the GitHub thread and diff by hand.
  it("echoes the last set-escalated invariant back on the next arming of the same file", async () => {
    const HEAD3 = "c9e3a2b006333333333333333333333333333333";
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r2.json.structuralEscalationDue).toBe(true);
    // Armed, but nothing has been acknowledged yet — nothing to echo.
    expect(r2.json.structuralEscalationInvariant).toBeNull();

    await driveState(round1.stateDir, [
      "set-escalated",
      "999",
      "--invariant",
      "the recovery guard wraps every step past the reset boundary",
    ]);

    const round3 = writeFixture({
      head: HEAD3,
      threads: [{ id: "PRRT_c", path: "a.ts", bot: true }],
    });
    const r3 = await probeIn(round3.dir, round1.stateDir, HEAD3, [
      "--bump-attempt",
    ]);
    expect(r3.json.structuralEscalationDue).toBe(true);
    expect(r3.json.structuralEscalationInvariant).toBe(
      "the recovery guard wraps every step past the reset boundary",
    );
  });

  // The mirror case: while the duty is discharged (not armed), the field is
  // `null` even though a prior invariant was recorded — a live claim is only
  // worth surfacing while something is actively re-litigating it.
  it("does not echo the invariant while the escalation is discharged", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    await probeIn(round2.dir, round1.stateDir, PREV, ["--bump-attempt"]);

    await driveState(round1.stateDir, [
      "set-escalated",
      "999",
      "--invariant",
      "a claim that should not resurface once discharged",
    ]);
    expect(
      (await driveState(round1.stateDir, ["escalation-due", "999"])).stdout,
    ).toBe("false");

    const round3 = writeFixture({
      head: "c9e3a2b006333333333333333333333333333333",
      threads: [{ id: "PRRT_c", path: "z.ts", bot: true }],
    });
    const r3 = await probeIn(
      round3.dir,
      round1.stateDir,
      "c9e3a2b006333333333333333333333333333333",
      ["--bump-attempt"],
    );
    expect(r3.json.structuralEscalationDue).toBe(false);
    expect(r3.json.structuralEscalationInvariant).toBeNull();
  });

  // A parked thread is a human decision already made, not a recurring root
  // cause the fix keeps missing — counting it would arm the signal for as
  // long as it stays parked, on a file nothing new landed on.
  // The SAME thread id anchors `a.ts` in both
  // rounds here, unresolved and parked throughout; each round also carries a
  // genuinely live thread on a DIFFERENT file so the round stays ROUND_READY
  // (case 0, which records anchors, never runs on HITL_PARKED) without that
  // live thread itself supplying a false intersection.
  it("a parked thread’s path never feeds the recurrence signal, even unchanged across rounds", async () => {
    const round1 = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    await park(round1.stateDir, "PRRT_a", "thread");
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // A thread left open on purpose (`triage-thread.ts --leave-open`, usually a
  // human thread per `/jig:resolve-review-comments` § Human threads) is a settled
  // decision, not a recurring root cause — it stays unresolved on GitHub
  // forever by design, so without this exclusion it would arm the signal for
  // as long as the PR stays open, on a file nothing new landed on.
  // Same shape as the parked-thread probe
  // above: the SAME thread id anchors `a.ts` in both rounds, with its
  // qualifying reply and leave-open marker unchanged throughout, and each
  // round also carries a genuinely live thread on a different file so the
  // round stays ROUND_READY.
  it("a left-open thread’s path never feeds the recurrence signal, even unchanged across rounds", async () => {
    const leftOpenThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: `**wont-fix** — deliberately left open.\n\n${LEAVE_OPEN_MARKER}`,
        },
      ],
    };
    const round1 = writeFixture({
      threads: [leftOpenThread, { id: "PRRT_live1", path: "b.ts", bot: true }],
    });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [leftOpenThread, { id: "PRRT_live2", path: "c.ts", bot: true }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // A HELD thread (`**accepted**`, awaiting `resolve-held-thread.ts` after
  // this round's own push) is triaged work awaiting its own external
  // mutation, not a finding that landed again — the same argument the parked
  // and left-open probes above make, extended to the third way a thread stays
  // open with nothing new for the next pass to have caused. Reachable from a
  // single transient sweep failure inside `finish-round.ts`'s drain.
  // Unlike a park, holding does NOT
  // remove the thread from `work.unresolvedThreads` — a held item is still
  // live work for ITS round, only its recurrence evidence is stale — so that
  // count is pinned unchanged alongside the path exclusion.
  it("a held thread’s path never feeds the recurrence signal, but still counts as open work", async () => {
    const round1 = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    // The default single-comment thread's own url — `threadCommentNodes`
    // (no per-thread `comments` override) — is what the hold's `commentUrl`
    // must match for the exclusion to hold: `evaluate.ts` now compares the
    // hold against the thread's OWN most recent comment, not the threadId
    // alone (see the dedicated superseded-hold probe below for the case this
    // replaced).
    await hold(
      round1.stateDir,
      "PRRT_a",
      "thread",
      "https://example.invalid/PRRT_a",
    );
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);
    expect((r1.json.work as Record<string, unknown>).unresolvedThreads).toBe(2);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // Regression for the fix itself: a hold
  // recorded against ONE comment must not go on vouching for the thread once
  // a LATER comment lands on it — the reviewer's own example is a plain new
  // finding, not a re-triage, so the comparison must key on the thread's
  // literal most recent comment, not merely its most recent QUALIFYING one.
  it("a held thread SUPERSEDED by a later comment is no longer excluded from recurrence evidence", async () => {
    const round1 = writeFixture({
      threads: [
        {
          id: "PRRT_a",
          path: "a.ts",
          bot: false,
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            {
              author: "example-user-2",
              authorAssociation: "OWNER",
              body: "**accepted** — fixed already; posting once pushed.",
            },
            // Landed AFTER the hold below was recorded — an ordinary new
            // bot finding on the same still-open thread, exactly the
            // reviewer's own example, never itself a "qualifying" reply.
            { authorAssociation: "NONE", body: "a fresh finding", bot: true },
          ],
        },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    // Recorded against the SECOND comment (index 1) — the accepted reply —
    // which is no longer the thread's last comment once the third one lands.
    await hold(
      round1.stateDir,
      "PRRT_a",
      "thread",
      "https://example.invalid/PRRT_a/comment-1",
    );
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts", "b.ts"]);
  });

  // Same argument, for a held SUMMARY finding — no thread, so the exclusion
  // has to key on the fingerprint `answer-summary-finding.ts` will eventually
  // post against, not a thread id. The fixture's two backlog findings both
  // anchor `AGENTS.md` (see `backlogJson` above), so both are held here —
  // otherwise the sibling, still-unaddressed finding on the same path would
  // keep it in the list and the assertion would prove nothing about the fix.
  it("a held summary finding’s path never feeds the recurrence signal", async () => {
    const round1 = writeFixture({ backlog: true });
    await hold(round1.stateDir, "b9a7a18089043564", "finding");
    await hold(round1.stateDir, "c773d9fdb7974e6d", "finding");
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual([]);
    // Held, not answered — summaryUnaddressed still counts both; only the
    // path list, fed to structuralEscalationDue, excludes them.
    expect((r1.json.work as Record<string, unknown>).summaryUnaddressed).toBe(
      2,
    );
  });

  // A trusted `--no-outcome` clarification reply is a settled ask-and-wait, not
  // a live finding still open: `reply-to-thread.ts` appends `NO_OUTCOME_MARKER`
  // itself whenever `--no-outcome` is passed, and `isLeftOpenThread` now
  // requires that durable marker rather than inferring the clarification path
  // from a bare absence of an outcome token — the marker is what tells this
  // case apart from a trusted author's own outcome-less prose posted straight
  // on GitHub, which can never carry it. As long as the marked reply stays the
  // thread's most recent comment, this path must not feed the recurrence signal
  // — same shape as the left-open probe above.
  it("a trusted no-outcome clarification’s path never feeds the recurrence signal, until answered", async () => {
    const clarificationThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: `Can you clarify which caller you mean?\n\n${NO_OUTCOME_MARKER}`,
        },
      ],
    };
    const round1 = writeFixture({
      threads: [
        clarificationThread,
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        clarificationThread,
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);

    // Once the reviewer answers, the thread is live again and must count.
    const answeredThread = {
      ...clarificationThread,
      comments: [
        ...clarificationThread.comments,
        { authorAssociation: "NONE", body: "The caller in foo.ts:12." },
      ],
    };
    const round3 = writeFixture({
      head: HEAD,
      threads: [answeredThread, { id: "PRRT_live3", path: "a.ts", bot: true }],
    });
    const r3 = await probeIn(round3.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r3.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
  });

  // The bug this marker requirement fixes: a trusted author can reply directly
  // on GitHub with ordinary prose ("I agree; please fix this") that never
  // passes through `reply-to-thread.ts` and so never carries
  // `NO_OUTCOME_MARKER`. Before the marker was required,
  // `qualifyingOutcome(body) === null` alone treated this identically to a
  // genuine `--no-outcome` clarification, silently dropping a live finding
  // recurrence from the signal. It must instead be read as live, unresolved
  // work.
  it("a trusted author’s unmarked outcome-less reply is never mistaken for a clarification", async () => {
    const unmarkedReplyThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "I agree; please fix this.",
        },
      ],
    };
    const round1 = writeFixture({ threads: [unmarkedReplyThread] });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ ...unmarkedReplyThread, id: "PRRT_b" }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(true);
  });

  // A thread's FIRST comment is the finding that OPENED it, never a reply —
  // the outcome-token grammar applies to replies posted after triage, not to
  // opening comments. On an interactive/non-`--bots-only` run, a human
  // OWNER/MEMBER/COLLABORATOR can open a brand-new thread directly, and its
  // opening comment naturally carries no outcome token — the identical shape
  // the left-open and clarification probes above use for their SECOND
  // comment. Reading a single trusted, outcome-less comment as a left-open
  // marker candidate would misclassify this fresh, live finding as an
  // already-settled clarification and permanently blind
  // `structuralEscalationDue` to every fresh human finding on that file
  // — so, unlike those two probes, this
  // one MUST feed the recurrence signal and arm on the second round.
  it("a fresh single-comment thread from a trusted author is never mistaken for left-open", async () => {
    const freshHumanThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "This new fetch does not verify origin before dereferencing it.",
        },
      ],
    };
    const round1 = writeFixture({ threads: [freshHumanThread] });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ ...freshHumanThread, id: "PRRT_b" }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(true);
  });

  // A comment array element is untrusted input off an external enumerator: a
  // `null`/non-object element must not crash the scan reading
  // `.authorAssociation` off it. Unreachable through the full CLI pipeline
  // above — the real thread producer sanitizes/crashes on a malformed
  // GraphQL comment node before evaluate.ts would ever see one — so this
  // calls the exported pure function directly.
  describe("isLeftOpenThread — a malformed comment element never throws", () => {
    const trustedNoOutcome = {
      authorAssociation: "OWNER",
      body: "Any update on this?",
    };

    it("a null last comment is treated as absent, not as a crash", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, null],
        }),
      ).not.toThrow();
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, null],
        }),
      ).toBe(false);
    });

    it("a null earlier comment in the backward scan is skipped, not thrown on", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            null,
            trustedNoOutcome,
          ],
        }),
      ).not.toThrow();
    });

    it("a non-object comment element (string/number) is treated the same as null", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, 5],
        }),
      ).not.toThrow();
    });
  });

  // The leave-open marker is human-thread-only by design — a bot-started
  // thread must always eventually resolve. `isLeftOpenThread` must not grant
  // the exemption on `confirmedHumanStarted` alone being absent/malformed
  // either (fail closed: count the thread as live, never silently exempt
  // it) — the field's PRODUCER (list-unresolved-threads.ts) is
  // fixture-tested where that field is actually computed, not here; this
  // describe block fixture-tests only this function's own consumption of
  // whatever the field says.
  describe("isLeftOpenThread — the leave-open marker is human-thread-only", () => {
    const leaveOpenReply = {
      author: "example-user-2",
      authorAssociation: "OWNER",
      body: `**wont-fix** — pre-existing, not part of this diff.\n\n${LEAVE_OPEN_MARKER}`,
    };

    it("grants the exemption when confirmedHumanStarted is explicitly true", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: true,
          comments: [
            { authorAssociation: "NONE", body: "a human finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(true);
    });

    it("refuses the exemption when confirmedHumanStarted is false", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: false,
          comments: [
            { authorAssociation: "NONE", body: "a bot finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the exemption when confirmedHumanStarted is missing (fail closed)", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the exemption when confirmedHumanStarted is a malformed non-boolean", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: "yes" as unknown,
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });
  });

  // The trusted no-outcome CLARIFICATION branch (a question, no outcome token
  // yet) has the identical requirement as the leave-open-marker branch — it
  // was once fixed in the OTHER branch of this SAME function while this
  // branch was still missed.
  describe("isLeftOpenThread — the no-outcome clarification pause is also human-thread-only", () => {
    const clarificationReply = {
      author: "example-user-2",
      authorAssociation: "OWNER",
      body: `Can you clarify which caller you mean?\n\n${NO_OUTCOME_MARKER}`,
    };

    it("grants the pause when confirmedHumanStarted is explicitly true", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: true,
          comments: [
            { authorAssociation: "NONE", body: "a human finding" },
            clarificationReply,
          ],
        }),
      ).toBe(true);
    });

    it("refuses the pause when confirmedHumanStarted is false — a bot thread must not silently drop out of the live count", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: false,
          comments: [
            { authorAssociation: "NONE", body: "a bot finding" },
            clarificationReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the pause when confirmedHumanStarted is missing (fail closed)", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            clarificationReply,
          ],
        }),
      ).toBe(false);
    });
  });

  // `--no-count` is a re-read, not a pass entry. `record-paths` keys itself to
  // the CURRENT round, so recording under it would overwrite the previous
  // round's anchors with this snapshot — collapsing two rounds' findings into
  // one entry, which destroys the pair the predicate was about to compare.
  it("a --no-count re-read files nothing", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(dir, stateDir, HEAD, ["--no-count", "--no-reconcile"]);
    expect(
      JSON.parse((await driveState(stateDir, ["round-paths", "999"])).stdout),
    ).toEqual([]);
  });

  // A PR-level thread names no file, so it cannot feed a signal about one file
  // recurring — and must not contribute a `"null"` pseudo-path that would then
  // "recur" every round.
  it("a thread with no path contributes nothing", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
  });

  // A summary-only finding creates no thread at all (summary-findings.ts's own
  // doc comment: false convergence mode 1), so a recurrence signal
  // fed only from `threads` never arms for one that keeps landing on the same
  // file across rounds. This fixture has ZERO threads — only the two backlog
  // entries, both anchored to `AGENTS.md` — so a paths list still missing
  // `AGENTS.md` here can only be explained by the completeness gap,
  // not by a thread this fixture never had.
  it("a summary-only finding’s path feeds the recurrence signal too, not only a thread’s", async () => {
    const { dir, stateDir } = writeFixture({ backlog: true });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["AGENTS.md"]);
  });

  // The same recurrence the earlier "arms on the same file two consecutive
  // rounds" probe demonstrates for a thread, but with no thread on that file
  // at all in either round — only the standing backlog entries, which stay
  // unaddressed on both independently-built rounds. Proves the signal now
  // arms on a purely summary-only recurrence, which it could not before.
  it("arms on the same file two consecutive rounds when only a summary finding recurs there", async () => {
    const round1 = writeFixture({ backlog: true });
    expect(
      (await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]))
        .json.structuralEscalationDue,
    ).toBe(false);

    const round2 = writeFixture({ head: PREV, backlog: true });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.json.structuralEscalationDue).toBe(true);
  });

  // The cap-truncation warning `record-paths` writes on stdout-success (its
  // own probe in structural-escalation.test.ts) has nowhere to surface if the
  // caller that spawns it discards its stderr — which `recordRoundPaths()`
  // used to do unconditionally. Passing it through (the same convention
  // `parked-keys` above already uses) is what lets a repeated file sorted
  // outside the retained 200 paths still show up on an operator's screen
  // instead of silently vanishing from the
  // recurrence signal.
  it("passes record-paths’s own cap-truncation warning through to stderr", async () => {
    const many = Array.from(
      { length: ROUND_PATHS_MAX_PER_ROUND + 5 },
      (_, i) => ({ id: `PRRT_${i}`, path: `f${i}.ts`, bot: true }),
    );
    const { dir, stateDir } = writeFixture({ threads: many });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("exceeding the");
    expect(r.stderr).toContain("5 dropped");
  });
});

// `fleetHealth` in the gate's JSON report and the plain-text
// `fleet-health` stderr line are the ONLY routes a published snapshot takes
// into a round's brief. `fleet-health.test.ts` covers `readFleetHealthAdvisory`
// directly, which cannot notice `drive-status.ts` no longer calling it: these
// tests pin the wiring itself, against a snapshot published to a scratch
// `$DEV_DASHBOARD_DIR`.
describe("drive-status.ts publishes the fleet-health advisory", () => {
  /** Publish a snapshot raising a review-carousel for PR 999 (the probes' PR). */
  function publishSnapshot(
    opts: { ageMs?: number; gaps?: string[] } = {},
  ): string {
    const dashDir = mkdtempSync(join(tmpdir(), "drive-fleet-health-"));
    writeFileSync(
      join(dashDir, "fleet-health.json"),
      JSON.stringify({
        panel: "fleet-health",
        generatedAt: new Date(
          Date.now() - (opts.ageMs ?? 600_000),
        ).toISOString(),
        source: "test",
        ttlSec: 3600,
        error: null,
        everSucceeded: true,
        data: {
          signals: [
            {
              kind: "review-carousel",
              scope: { type: "pr", pr: 999, epics: [] },
              severity: "elevated",
              headline: "10 bot-reviewed heads",
              state: null,
            },
          ],
          gaps: opts.gaps ?? [],
        },
      }),
    );
    return dashDir;
  }

  it("carries the PR-scoped warnings, snapshot age and staleness in the JSON report", async () => {
    const dashDir = publishSnapshot();
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DEV_DASHBOARD_DIR: dashDir },
      });
      const fh = r.json.fleetHealth as {
        warnings: string[];
        snapshotAgeSec: number;
        stale: boolean;
      };
      expect(fh.warnings).toEqual(["review-carousel: 10 bot-reviewed heads"]);
      // ~10 minutes, with slack for the spawn between publish and read.
      expect(fh.snapshotAgeSec).toBeGreaterThanOrEqual(600);
      expect(fh.snapshotAgeSec).toBeLessThan(700);
      expect(fh.stale).toBe(false);
      expect((fh as { partial?: boolean }).partial).toBe(false);
      // Advice never touches the verdict.
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });

  // One flag true at a time, so swapping the `stale`/`partial` mapping in the
  // JSON payload fails a case instead of passing on a both-true fixture.
  it.each([
    {
      label: "STALE only",
      // Past the 3600s TTL, with a clean gap list.
      snapshot: { ageMs: 2 * 3600_000 } as { ageMs?: number; gaps?: string[] },
      stale: true,
      partial: false,
    },
    {
      label: "PARTIAL only",
      // Fresh, with a non-empty gap list.
      snapshot: { gaps: ["Linear unreachable"] } as {
        ageMs?: number;
        gaps?: string[];
      },
      stale: false,
      partial: true,
    },
  ])(
    "forwards a $label snapshot with distinct flags in the JSON report",
    async ({ snapshot, stale, partial }) => {
      const dashDir = publishSnapshot(snapshot);
      try {
        const { dir, stateDir } = writeFixture({
          threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        });
        const r = await probeIn(dir, stateDir, HEAD, [], {
          env: { DEV_DASHBOARD_DIR: dashDir },
        });
        const fh = r.json.fleetHealth as {
          warnings: string[];
          stale: boolean;
          partial: boolean;
        };
        expect(fh.warnings).toEqual(["review-carousel: 10 bot-reviewed heads"]);
        expect(fh.stale).toBe(stale);
        expect(fh.partial).toBe(partial);
        expect(r.state).toBe("ROUND_READY");
        expect(r.exitCode).toBe(0);
      } finally {
        rmSync(dashDir, { recursive: true, force: true });
      }
    },
  );

  it("reports no warnings when no snapshot is published", async () => {
    const dashDir = mkdtempSync(join(tmpdir(), "drive-fleet-health-empty-"));
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DEV_DASHBOARD_DIR: dashDir },
      });
      expect(r.json.fleetHealth).toEqual({
        warnings: [],
        snapshotAgeSec: null,
        stale: false,
        partial: false,
      });
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });

  it("prints the suspicion line on stderr for the plain-text (non---json) caller", async () => {
    const dashDir = publishSnapshot();
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const proc = Bun.spawn(
        [
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--once",
          "--no-reconcile",
          "--head",
          HEAD,
        ],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DEV_DASHBOARD_DIR: dashDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(out.trim()).toBe("ROUND_READY");
      expect(stderr).toMatch(/PR #999/);
      expect(stderr).toMatch(/review-carousel: 10 bot-reviewed heads/);
      expect(stderr).toMatch(/suspicion, not a finding/);
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });
});

// A draft is DRIVEN, not refused. `PR_IS_DRAFT` (exit 10) used to be terminal
// here, on the premise that no reviewer arm looks at a draft; measured false
// when `example-review` posted findings on two PRs — both created as drafts
// and never marked Ready — about a minute after each was opened: that
// reviewer's deployment reviews drafts.
//
// CodeRabbit still refuses a draft ("Review skipped / Draft detected", on the
// same PRs), and that asymmetry is the point: the drive works the in-house
// findings on the draft and marks it Ready afterwards, so the paid reviewer's
// one pass lands on a cleaned-up head. `mark-ready.ts` owns the transition;
// these tests own the gate's half, which is simply that draftness no longer
// decides anything.
describe("drive-status.ts draft PRs", () => {
  /** The check-run set on a head the reviewer has not run on at all. */
  const NO_REVIEWER = [DORMANT_ARM];

  it("a draft with findings is an ordinary ROUND_READY", async () => {
    // The whole retirement, in one assertion: a draft is worked exactly as a
    // Ready PR is. Before this, the identical fixture returned exit 10 and the
    // round was never dispatched.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    // Measured and published, so a caller can act on it — mark-ready.ts does.
    expect(r.json.draft).toBe(true);
  });

  it("a clean draft CONVERGES — the reviewer’s stamp counts on a draft head", async () => {
    // `CONVERGED` is defined against the arm that reviews drafts, so every
    // witness it rests on is available on one. This is the assertion that would
    // have been unreachable under the old gate: exit 10 fired before any
    // reviewer evidence was read.
    const r = await probe({ threads: [], reviewedSha: HEAD, isDraft: true });
    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
    expect(r.json.draft).toBe(true);
  });

  it("names the draft-review setting when a DRAFT has no reviewer run", async () => {
    // Whether drafts are reviewed is a deployment setting this gate cannot
    // read; the consumer declares it as drive.reviews_drafts.
    // So the one wait a draft can enter that a Ready PR cannot is named rather
    // than gated on: refusing to drive drafts on the chance the dial is off is
    // exactly the stall retiring PR_IS_DRAFT removed, but leaving an operator
    // to guess why a 30-minute poll learned nothing is the failure.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: true,
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(r.json.reason).toContain("drive.reviews_drafts");

    // The note is DRAFT-SPECIFIC. On a Ready PR the same wait has no such
    // cause, and appending it there would send every operator chasing a
    // setting that has nothing to do with their stall.
    const ready = await probe({ threads: [], checkRuns: NO_REVIEWER });
    expect(ready.state).toBe("AWAITING_REVIEWER");
    expect(ready.json.reason).not.toContain("drive.reviews_drafts");
  });

  it("does not short-circuit head sync — a stale draft head is HEAD_LAG", async () => {
    // The old gate sat AHEAD of head sync deliberately, so a draft could not
    // present as HEAD_LAG. With draftness deciding nothing, that ordering has
    // no work left to do and the honest answer for a lagging head is HEAD_LAG —
    // which clears in seconds, as it does on any Ready PR.
    const r = await probe(
      { threads: [], checkRuns: NO_REVIEWER, isDraft: true, head: PREV },
      ["--head", HEAD],
    );
    expect(r.state).toBe("HEAD_LAG");
    expect(r.exitCode).toBe(4);
  });

  it("is still checked BEHIND liveness — a closed draft is PR_NOT_OPEN", async () => {
    // Both flags can arrive together — a draft that was then closed — so the
    // order decides which is reported rather than being moot. The contract is
    // that a PR no longer open stops the loop before anything else is said
    // about it, draftness included.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: true,
      prState: "CLOSED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it('an absent isDraft is INDETERMINATE, never "Ready for review"', async () => {
    // The silent-disarm shape: `null` coerces to `false` under a truthiness
    // read. That answer is still the dangerous one after the retirement, but
    // for a different consumer — `isDraft` stopped being a GATE and stayed
    // DECISION evidence, because mark-ready.ts reads it to decide whether the
    // draft→Ready transition is owed, and `false` means "already Ready,
    // nothing to do". A partial response accepted here would silently skip the
    // transition on the one PR that needs it.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: null,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.json.reason).toContain("isDraft");
    // Unmeasured stays unmeasured — `false` here would be the very claim the
    // read failed to establish.
    expect(r.json.draft).toBeNull();
  });

  it("a GENUINELY OMITTED isDraft key is INDETERMINATE too, same as null", async () => {
    // `isDraft: null` models the field answered WITH a null value; a key
    // dropped from the response entirely is a distinct wire shape `gh` could
    // just as well produce on a partial response. `evaluate()` reads both the
    // same way (`typeof draft !== 'boolean'`), so this must reach the
    // identical outcome as the null case above (the fixture builder could not
    // previously produce this shape at all).
    // mark-ready.ts applies the same rule to its own read of the field, in the
    // same direction, for the same reason.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraftAbsent: true,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.json.reason).toContain("isDraft");
    expect(r.json.reason).toContain("<absent>");
    expect(r.json.draft).toBeNull();
  });

  it("a mid-evaluation flip TO draft no longer invalidates CONVERGED", async () => {
    // The deliberate inverse of a guard that used to live in `still_on_head`:
    // a PR converted back to draft while reviewer and thread evidence
    // was being gathered reported PR_IS_DRAFT rather than CONVERGED, because a
    // terminal claim was only sound while a reviewer was scheduled to look.
    //
    // It is sound now regardless. Every witness CONVERGED rests on — the
    // reviewer's check-run, its reviewed-SHA stamp, the thread and summary
    // counts — describes this head and is unaffected by draftness, so tripping
    // on the flip would stop a drive over a state change that costs the claim
    // nothing. `headMovesAfter: 1` opens the same window the old guard used.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      isDraftMovesTo: true,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("a mid-evaluation flip TO draft no longer withholds a ROUND_READY", async () => {
    // Same retirement on the other path.
    // The round is dispatched: the findings are real, the reviewer that posted
    // them reads drafts, and the fixes land on the same branch either way.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraftMovesTo: true,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
  });

  it("closes mid-evaluation on the ROUND_READY path — the surviving half of the recheck", async () => {
    // `closedSinceOpen` is what `draftOrClosedSinceOpen` became. Its draft half
    // is gone with the premise; this half is why the function was KEPT rather
    // than deleted alongside it — a round dispatched onto a PR that merged or
    // closed during enumeration is a whole triage-fix-push pass with nowhere to
    // land, which was always an independent justification.
    //
    // `isDraftMovesTo` rides along to pin the PRECEDENCE that outlived the
    // guard it was found in: GitHub keeps `isDraft` true on a closed draft, so
    // this fixture is simultaneously "became a draft" and "got closed", and
    // PR_NOT_OPEN must still win. It does so now by construction — nothing
    // reads draftness here at all — and this is what would go red if a future
    // draft check were reintroduced ahead of the liveness one.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraftMovesTo: true,
      stateMovesTo: "CLOSED",
      headMovesAfter: 1,
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("a Ready PR reports draft:false and proceeds normally", async () => {
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    expect(r.json.draft).toBe(false);
  });

  it("publishes draft:null from a gate that returned before the snapshot", async () => {
    // Same rule as the work counts: a state decided before the read happened
    // has nothing to say about draftness, and `false` there would be a claim.
    const r = await probe({ threads: [], transientMergeabilityFailure: true });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.json.draft).toBeNull();
  });
});

// Mode 14: a conflicting PR runs no `pull_request` CI, so the posting
// reviewer never creates a check-run and the mode-4 guard — correctly, on its
// own evidence — reports AWAITING_REVIEWER and polls to `--timeout`. Exit 4
// means "becomes something else with time", which a conflict never does.
describe("drive-status.ts merge conflicts", () => {
  /** Exactly the observed check-run set on the conflicting head. */
  const CONFLICTED_CHECKS = [DORMANT_ARM];

  it("PR_CONFLICTING — reported instead of AWAITING_REVIEWER, when nothing is workable", async () => {
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(r.json.merge).toEqual({
      mergeable: "CONFLICTING",
      stateStatus: "DIRTY",
    });
    // The message has to name the fix, not the symptom — and the base branch
    // by name, since it is read from the snapshot rather than assumed.
    expect(r.stderr).toContain("Merge develop into this one");
  });

  it("does not poll to --timeout, the way exit 4 does", async () => {
    // The distinguishing property, asserted on the WAITING path: `--once`
    // returns every state promptly, so a probe that keeps it cannot tell a
    // terminal conflict from the 30-minute wait this replaces. The control
    // below is the same fixture with the conflict removed.
    const started = Date.now();
    const r = await probe(
      {
        threads: [],
        checkRuns: CONFLICTED_CHECKS,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--timeout", "20", "--interval", "5"],
      { once: false },
    );
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(Date.now() - started).toBeLessThan(15_000);

    // One 1s poll is enough to show the control waits out its budget.
    const control = await probe(
      { threads: [], checkRuns: CONFLICTED_CHECKS },
      ["--timeout", "2", "--interval", "1"],
      { once: false, env: { DRIVE_PR_STATUS_MIN_INTERVAL: "1" } },
    );
    expect(control.state).toBe("AWAITING_REVIEWER");
    expect(control.exitCode).toBe(4);
    expect(control.stderr).toContain("gave up after");
  });

  it("does NOT preempt a round that has live work", async () => {
    // The first cut short-circuited here, on the premise that a conflicting
    // head has no findings "because GitHub runs no pull_request CI on it".
    // That premise is false: the live reviewer is a self-hosted POLLER, whose
    // eligibility predicate (non-draft, base develop, same-repo head, head not
    // yet reviewed) contains no mergeability term at all — and the only
    // pull_request_target arm in this repo is dormant. A poller is not stopped
    // by a conflict, so findings CAN sit on a conflicting head, and
    // short-circuiting discarded them unread.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    // ...but the pass has to be told, or it will push into a branch no CI runs on.
    expect(r.json.reason).toContain("conflicts with its base");
  });

  // The same gap shows from both directions: skipping the reviewer
  // GATES on a conflicting head also skipped READING the reviewed-SHA marker,
  // so the round said nothing about whether its findings were current. The
  // answer is to report it, never to gate on it — gating is the stall
  // under another name, and an unresolved thread is open work on any head.
  describe("reviewer evidence on a conflicting head", () => {
    const CONFLICT_WORK = {
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    };

    it("names a STALE marker in the reason, and still hands the round out", async () => {
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: PREV });
      // Reported, NOT gated: the state is unchanged by the staleness.
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
      expect(r.json.reason).toContain("predate");
      // The evidence itself is published, so a caller need not parse prose.
      const reviewer = r.json.reviewer as Record<string, unknown>;
      expect(reviewer.reviewedSha).toBe(PREV);
      expect(reviewer.reviewedShaSource).toBe("comment-marker");
    });

    it("says so when the marker DOES name this head", async () => {
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: HEAD });
      expect(r.state).toBe("ROUND_READY");
      expect(r.json.reason).toContain("did review this exact head");
      expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(
        HEAD,
      );
    });

    it("never substitutes the check-run fallback when there is no marker", async () => {
      // `reviewedShaSource: check-run` means "queried BY SHA, so it always
      // matches" — on a path where no reviewer gate ran, publishing it would
      // assert a review this script has no evidence of. Absent stays absent.
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: null });
      expect(r.state).toBe("ROUND_READY");
      const reviewer = r.json.reviewer as Record<string, unknown>;
      expect(reviewer.reviewedShaSource).not.toBe("check-run");
      expect(reviewer.reviewedSha).toBe("");
      expect(r.json.reason).toContain("cannot be dated");
    });
  });

  it("a conflict beats HITL_PARKED when nothing is workable, naming the parked items", async () => {
    // Both are terminal and both are true. An operator handed a merge and a
    // question should get the mechanical one first — but the parked counts
    // stay in the reason so the precedence hides nothing.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    });
    await park(stateDir, "PRRT_parked", "thread");
    const r = await probeIn(dir, stateDir);
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(r.json.reason).toContain("1 parked thread(s)");
  });

  it("liveness still wins — a merged PR stops the loop first", async () => {
    const r = await probe({
      prState: "MERGED",
      threads: [],
      mergeable: "CONFLICTING",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("head sync still wins — mergeability is a property OF a head", async () => {
    // The false terminal this ordering prevents: a driver that pushes the base
    // merge and re-polls inside GitHub's replication window would otherwise
    // read the PRE-push CONFLICTING verdict and report a terminal state for the
    // conflict it had just fixed.
    // The API is one push behind, exactly as in mode 3: the fixture's head is
    // PREV while the local tree is already at HEAD. The later `--head` wins.
    const r = await probe(
      { threads: [], head: PREV, mergeable: "CONFLICTING" },
      ["--head", HEAD],
    );
    expect(r.state).toBe("HEAD_LAG");
    expect(r.exitCode).toBe(4);
  });

  it("a head that moves mid-evaluation is HEAD_MOVED, not a terminal conflict", async () => {
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      headMovesTo: PREV,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });

  it("UNKNOWN is not settled either way — not judged, not converged", async () => {
    // The FIRST cut of this guard let UNKNOWN proceed straight to the
    // reviewer/work checks below, which could report CONVERGED over a
    // mergeability verdict GitHub itself had not finished computing — the
    // false-CONVERGED sibling of the false-CONFLICTING case this whole guard
    // exists to prevent.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(r.state).toBe("MERGEABILITY_UNKNOWN");
    expect(r.exitCode).toBe(4);
    expect((r.json.merge as Record<string, unknown>).mergeable).toBe("UNKNOWN");
  });

  it("a gh missing a required field is a PREREQUISITE error, not a degraded mode", async () => {
    // An earlier version built a three-tier CLI-version fallback ladder plus a
    // second REST parser here, and every tier then needed its own binding and
    // validation guards — each of which produced the next round's findings.
    // A backward-compatibility ladder of that shape is exactly what to avoid,
    // and the premise was thin anyway: the fields have all been in `gh`
    // for years. Requiring them deletes the whole surface. Exit 2 is the usage
    // /configuration code, and the message has to name the fix.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeabilityUnreadable: true,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("upgrade the GitHub CLI");
    expect(r.stderr).toContain("mergeable");
    // Never a terminal verdict, and never a quiet degrade.
    expect(r.state).not.toBe("CONVERGED");
    expect(r.state).not.toBe("PR_CONFLICTING");
    // ...and it goes through the REPORTER. The first cut called `exit 2` from
    // inside evaluate(), which skips report() entirely: `--json` emitted stderr
    // and no object at all, so a caller parsing the documented contract got an
    // empty string and could not tell this from a crash. `probe` parses stdout,
    // so an empty state here IS that bug.
    expect(r.state).toBe("UNSUPPORTED_CLI");
    expect(r.json.exit).toBe(2);
    expect(r.json.pr).toBe(999);
    expect(String(r.json.reason)).toContain("upgrade the GitHub CLI");
  });

  it("an unreadable check-runs API does not block PR_CONFLICTING", async () => {
    // On a conflicting head every consumer of `runs` is already skipped, so
    // hard-failing on that query let a timeout or a 403 on evidence this path
    // does not use block the new state from ever being reported.
    const r = await probe({
      threads: [],
      mergeable: "CONFLICTING",
      checkRunsUnreadable: true,
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    // ...but the empty stand-in must never read as a clean CI verdict.
    expect(r.json.ci).toContain("unknown");
  });

  it("an unreadable check-runs API is still INDETERMINATE on a MERGEABLE head", async () => {
    // The control: where the evidence IS used, an unreadable query is exactly
    // what it was before — never an empty (therefore clean) set.
    const r = await probe({ threads: [], checkRunsUnreadable: true });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("liveness is still checked FIRST, even on an unsupported gh", async () => {
    // Folding liveness into the combined required-field read broke the
    // "a merged or closed PR stops the loop before anything else" contract:
    // on an old `gh` a finished PR reported a configuration error, so a caller
    // could not tell a PR that is simply done from a CLI it cannot use. The
    // `state` field alone is supported by every `gh` that has the subcommand.
    const r = await probe({
      prState: "MERGED",
      threads: [],
      mergeabilityUnreadable: true,
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
    expect(r.exitCode).not.toBe(2);
  });

  it("a malformed snapshot is INDETERMINATE, not silently mergeable", async () => {
    // A nominally SUCCESSFUL read carrying a null/absent/unhandled `mergeable`
    // collapsed to "" and fell through the case exactly as though the PR were
    // mergeable.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeable: "SOMETHING_NEW",
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no handled 'mergeable' value");
  });

  it("a missing mergeStateStatus does NOT block the state it annotates", async () => {
    // The counterpart to the test above, and the other half of the contract
    // review read as self-contradictory. Validation is scoped to the fields a
    // state is DECIDED from — `mergeable` picks the branch, `baseRefOid` arms
    // the base-race guard. `mergeStateStatus` and `baseRefName` are reported
    // and nothing branches on them, so requiring them would block
    // PR_CONFLICTING over evidence this path never consumes — exactly the
    // regression the check-runs read once had to undo. It degrades to an
    // omitted parenthetical instead.
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      mergeStateStatusMissing: true,
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect((r.json.merge as Record<string, unknown>).stateStatus).toBe("");
    // Reported as absent, never invented — and the fix is still named.
    expect(r.json.reason).not.toContain("mergeStateStatus=");
    expect(r.stderr).toContain("Merge develop into this one");
  });

  it("a snapshot missing baseRefOid is INDETERMINATE, not a silent guard-off", async () => {
    // The base-race guard is unconditional now, so an absent baseRefOid is
    // always a malformed response — there is no tier that opted out of it.
    const r = await probe({ threads: [], reviewedSha: HEAD, base: "" });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no 'baseRefOid'");
  });

  it("a TRANSIENT failure is INDETERMINATE, never a silent degrade", async () => {
    // An earlier fallback conflated ANY failure of the full read with "this
    // token cannot access mergeability". A transient blip (network, rate
    // limit, timeout) that happens to clear before the narrower retry would
    // then silently disable the merge-conflict guard for that evaluation —
    // and that evaluation can be the one reporting CONVERGED. Distinguished
    // now by the `gh` error text itself: only "Unknown JSON field" — a
    // deterministic, client-side, version-based failure — degrades. Anything
    // else, including this fixture's simulated network failure, must report
    // INDETERMINATE so the caller's existing MAX_QUERY_ERRORS retry handles it.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      transientMergeabilityFailure: true,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("transient failure");
    // Specifically NOT mistaken for the unmet-prerequisite exit.
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).not.toContain("upgrade the GitHub CLI");
  });
});

// Mode 15: mergeability is a function of (head, base), not head alone.
// `still_on_head` must recheck the base tip too, or a base that advances
// mid-evaluation — measured to be the STANDING lag pattern for `baseRefOid`,
// not a rare race — lets a stale mergeability verdict survive into a terminal
// claim.
describe("drive-status.ts base-race guard", () => {
  it("a base that moves mid-evaluation is HEAD_MOVED, not a terminal CONVERGED", async () => {
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      baseMovesTo: BASE_MOVED,
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("base");
  });

  it("a base that moves mid-evaluation also preempts a terminal PR_CONFLICTING", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [DORMANT_ARM],
      mergeable: "CONFLICTING",
      baseMovesTo: BASE_MOVED,
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });

  it('an empty baseRefOid on the recheck is INDETERMINATE, not "unchanged"', async () => {
    // An earlier still_on_head treated an empty base_now as "the base didn't
    // move" (the whole `-n "$base_now" && ...` condition is false when empty),
    // which is the SAME failure mode the head check next to it already
    // refuses: an unreadable recheck is not evidence of anything, and letting
    // it fall through to `return 0` would let CONVERGED or PR_CONFLICTING
    // stand on a base half of the (head, base) pair that was never
    // re-verified. Modelled here by moving the base to an EMPTY string on the
    // recheck read — `??` only substitutes for null/undefined, so an explicit
    // `''` survives into the served fixture unchanged.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      baseMovesTo: "",
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot re-read #999's base");
  });

  // There is deliberately no "base tracking is off" case left to probe: the
  // base fields are required, so the guard is unconditional. The whole class
  // of bug it used to invite — a recheck asking for a field the opening
  // snapshot had degraded past, turning an announced degradation into an
  // INDETERMINATE on every terminal return — was deleted with the tier ladder
  // rather than guarded.
});

describe("drive-status.ts terminal witness — the PR merges mid-evaluation", () => {
  // `still_on_head` re-reads before every terminal return so no terminal claim
  // outlives the evidence behind it. Reading `headRefOid` ALONE left it blind to
  // the one transition that moves no ref: a merge. The head compares equal, the
  // guard passes, and the drive is handed CONVERGED / HITL_PARKED /
  // REVIEWER_FAILED about a pull request that is no longer open — where the
  // required answer is PR_NOT_OPEN (5), the state that stops the loop without a
  // push. Every probe below returned its original terminal state before `state`
  // joined the re-read.
  //
  // `stateChangesAfter: 1` lets evaluate()'s opening liveness read answer OPEN
  // truthfully, so what is pinned here is the TERMINAL witness, not the gate at
  // the top that already worked.

  it("CONVERGED becomes PR_NOT_OPEN", async () => {
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      stateChangesTo: "MERGED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("REVIEWER_FAILED becomes PR_NOT_OPEN", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }, DORMANT_ARM],
      stateChangesTo: "CLOSED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("HITL_PARKED becomes PR_NOT_OPEN", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      stateChangesTo: "MERGED",
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(JSON.parse(out).state).toBe("PR_NOT_OPEN");
    expect(exitCode).toBe(5);
  });

  it("a head that moves is still HEAD_MOVED, not PR_NOT_OPEN", async () => {
    // The other half: widening the witness must not collapse the two failures
    // it now distinguishes. A push mid-evaluation is recoverable (re-gather and
    // judge the new head); a merge is not.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      headMovesTo: PREV,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });
});

describe("drive-status.ts reports counts it never measured as null", () => {
  // `evaluate()` returns from the liveness, head-sync and reviewer gates long
  // before it enumerates threads or summary findings. Initialised to 0, those
  // gates published `work.unresolvedThreads: 0` — "not counted" rendered
  // identically to "none open". Observed while driving a PR: the reviewer gate
  // reported zero while nine threads were live.
  it("AWAITING_REVIEWER carries null work counts, not zeroes", async () => {
    const r = await probe({ threads: [], checkRuns: [DORMANT_ARM] });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.json.work).toEqual({
      unresolvedThreads: null,
      parkedThreads: null,
      summaryFindings: null,
      summaryUnaddressed: null,
      parkedSummaryFindings: null,
      // The key arrays carry the same distinction as the counts beside them:
      // null is "not measured", and an EMPTY array would be the positive claim
      // "enumerated, and nothing is open" — which this gate never established.
      unresolvedThreadKeys: null,
      summaryUnaddressedKeys: null,
      parkedKeys: null,
      // The anchor PATHS the same way — `[]` here would be the
      // positive claim "no file drew a finding this round", which is exactly
      // what a same-file recurrence check must never be told on a gate that
      // returned before enumerating.
      unresolvedThreadPaths: null,
    });
  });

  it("a measured zero is still a zero", async () => {
    // The distinction is only worth anything if the real count survives it.
    const r = await probe({ threads: [], reviewedSha: HEAD });
    expect(r.state).toBe("CONVERGED");
    const work = r.json.work as Record<string, unknown>;
    expect(work.unresolvedThreads).toBe(0);
    expect(work.parkedThreads).toBe(0);
    expect(work.summaryUnaddressed).toBe(0);
    expect(work.parkedSummaryFindings).toBe(0);
    // A measured EMPTY set, which is what the counts above are counting.
    expect(work.unresolvedThreadKeys).toEqual([]);
    expect(work.summaryUnaddressedKeys).toEqual([]);
    expect(work.parkedKeys).toEqual([]);
    // Exact, not merely numeric: the fixture carries no summary findings, so
    // a regression to any other count is the false positive this asserts against.
    expect(work.summaryFindings).toBe(0);
  });

  it("publishes the key sets SORTED, which is what makes the consumer’s equality set equality", async () => {
    // `roundFingerprint` serializes what it is given, so the sort has to happen
    // HERE or the stall stop compares order rather than membership. Parked keys
    // are the one set a probe can plant in a chosen order — they come from the
    // durable state, not from a fixture the enumerators normalise — so this is
    // where the producer's `.sort()` is pinned. Deleting it from evaluate.ts
    // turns this red; an assertion in the consumer's own unit probe would not.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    for (const key of ["zzz-parked-last", "aaa-parked-first"]) {
      const parked = Bun.spawn(
        [
          join(SCRIPTS, "drive-state.ts"),
          "park",
          "999",
          "--key",
          key,
          "--kind",
          "finding",
          "--reason",
          "planted out of order",
        ],
        {
          env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: stateDir },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await parked.exited).toBe(0);
    }
    const r = await probeIn(dir, stateDir);
    const work = r.json.work as Record<string, unknown>;
    expect(work.parkedKeys).toEqual(["aaa-parked-first", "zzz-parked-last"]);
  });
});

describe("roundFingerprint — what counts as evidence of sameness", () => {
  /** A gate report that WOULD fingerprint, so each probe varies one field. */
  const gate = (
    head: Record<string, unknown>,
    work: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    head: { api: "a".repeat(40), ...head },
    work: {
      unresolvedThreadKeys: ["PRRT_a"],
      summaryUnaddressedKeys: [],
      parkedKeys: [],
      summaryFindings: 0,
      ...work,
    },
  });

  it("refuses a caller-supplied --head, which asserts one instant rather than measuring", () => {
    // Forward one frozen `--head` to every gate and the local head never moves
    // however much the pass pushes — sameness the gate never witnessed. The
    // measured shape is the same report with a `git` source.
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "flag" })),
    ).toBeNull();
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "git" })),
    ).not.toBeNull();
  });

  it("accepts only a provenance known to re-measure, so an unknown source fails CLOSED", () => {
    for (const source of ["disabled", "unavailable", "something-new", ""]) {
      expect(roundFingerprint(gate({ local: "", localSource: source }))).toBe(
        null,
      );
    }
    // And with a real SHA attached, which is the case a denylist got wrong: a
    // future `cache` source carrying a frozen SHA would read as a continuing
    // measurement and stop a productive drive at 13. Refusing it only loses the
    // early stop and falls back to --max-rounds, so this is the safe direction.
    for (const source of ["flag", "cache", "future", ""]) {
      expect(
        roundFingerprint(gate({ local: "b".repeat(40), localSource: source })),
      ).toBeNull();
    }
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "git" })),
    ).not.toBeNull();
  });

  it("refuses counts without identities, rather than falling back to the weaker evidence", () => {
    const measured = { local: "b".repeat(40), localSource: "git" };
    expect(
      roundFingerprint(
        gate(measured, {
          unresolvedThreadKeys: undefined,
          unresolvedThreads: 1,
        }),
      ),
    ).toBeNull();
    expect(
      roundFingerprint(
        gate(measured, {
          summaryUnaddressedKeys: undefined,
          summaryUnaddressed: 0,
        }),
      ),
    ).toBeNull();
  });

  it("distinguishes a SUBSTITUTION from a no-op at equal cardinality", () => {
    const measured = { local: "b".repeat(40), localSource: "git" };
    const before = roundFingerprint(gate(measured));
    const after = roundFingerprint(
      gate(measured, { unresolvedThreadKeys: ["PRRT_b"] }),
    );
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    // The fingerprint serializes what it is GIVEN — order-sensitive, by
    // design — so set equality rests entirely on the PRODUCER sorting. That is
    // asserted where it is produced (drive-status.ts, the probe below);
    // asserting it here against arrays this test sorted itself would stay green
    // with `.sort()` deleted from evaluate.ts (exactly that vacuous shape).
    expect(
      roundFingerprint(gate(measured, { parkedKeys: ["b", "a"] })),
    ).not.toBe(roundFingerprint(gate(measured, { parkedKeys: ["a", "b"] })));
  });
});

describe("claimWasTakenOver — coexistence, a full successor-only transition, AND a vanished claim set", () => {
  // The real race this decides is a microsecond window between a
  // `renameSync` and the `inspect()` call that follows it — nothing in a
  // single-process test can land inside it (see drive.ts's own comment on
  // this function). Testing the DECISION directly, rather than racing the
  // real filesystem, is what makes this actually mutation-provable: an
  // earlier revision of this fix (`afterRewrite.claimNames.length > 1` alone)
  // passed every existing subprocess-based test because none of them ever
  // reached the sole-foreign-claim shape at all.
  it("is false when the sole claim is ours", () => {
    expect(claimWasTakenOver(["claim.ours"], "claim.ours")).toBe(false);
  });

  it("is true when nothing is there at all — a contender can remove our claim before installing its own successor, and that gap must read as loss too", () => {
    expect(claimWasTakenOver([], "claim.ours")).toBe(true);
  });

  it("is true for coexistence — our claim plus a resurrected/foreign one", () => {
    expect(claimWasTakenOver(["claim.ours", "claim.ghost"], "claim.ours")).toBe(
      true,
    );
  });

  it("is true for a full successor-only transition — exactly one claim, and it is not ours", () => {
    expect(claimWasTakenOver(["claim.successor01"], "claim.ours")).toBe(true);
  });

  it("is order-independent for coexistence", () => {
    expect(claimWasTakenOver(["claim.ghost", "claim.ours"], "claim.ours")).toBe(
      true,
    );
  });
});

describe("inspect — an unreadable directory is not a confirmed empty claim set", () => {
  // `claimWasTakenOver([], ...)` is deliberately `true` (the "vanished claim
  // set" case just above) — a genuine, successfully-read empty directory
  // really is a takeover signal. The bug this covers is upstream of that
  // decision: `inspect()` used to fold a `readdirSync` failure (a transient
  // permission/I/O/filesystem error) into the identical `claimNames: []`
  // shape, so its caller could not tell "confirmed empty" from "could not
  // read it" and called `claimWasTakenOver` on the ambiguous result either
  // way — reading a transient read failure as proof of takeover and
  // aborting a live drive for it.
  //
  // `process.getuid`-gated: on a container that runs tests as root, `chmod
  // 000` does not block root's own `readdirSync`, so the directory would read
  // successfully and the fixture would not exercise the failure path at all.
  const canDropOwnPermissions =
    typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(!canDropOwnPermissions)(
    "reports unreadable, with an empty claim set, when readdirSync itself throws",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "drive-pr-inspect-unreadable-"));
      try {
        chmodSync(dir, 0o000);
        const occupant = inspect(dir);
        expect(occupant.unreadable).toBe(true);
        expect(occupant.claimNames).toEqual([]);
        expect(occupant.claim).toBeNull();
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it("reports NOT unreadable for a confirmed, successfully-read empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-pr-inspect-empty-"));
    const occupant = inspect(dir);
    expect(occupant.unreadable).toBe(false);
    expect(occupant.claimNames).toEqual([]);
  });
});

describe("drive-status.ts measures local HEAD in the tree being driven", () => {
  /**
   * A gate with NO `--head`, so the measurement path itself is what runs —
   * `probeIn` always supplies one, which is exactly the path these probes must
   * not take. `cwd` and the anchor env var are the two variables.
   */
  async function measureFrom(
    cwd: string,
    env: Record<string, string> = {},
    extraArgs: string[] = [],
  ): Promise<{ local: string; localSource: string; stderr: string }> {
    const { dir, stateDir } = writeFixture({ threads: [] });
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        ...extraArgs,
      ],
      {
        cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const json = out.trim() ? JSON.parse(out) : {};
    const head = (json.head ?? {}) as Record<string, unknown>;
    return {
      local: String(head.local ?? ""),
      localSource: String(head.localSource ?? ""),
      stderr,
    };
  }

  it("refuses to measure from inside a git DIRECTORY, rather than reporting the main worktree’s head", async () => {
    // The measured wedge: a pass's shell cwd persists across tool calls, and
    // the state dir it legitimately reads — driver log, durable state — IS the
    // git common dir. One `cd` there and `git rev-parse HEAD` answers for the
    // MAIN worktree (`develop` in a Conductor checkout), so the gate reported
    // HEAD_LAG against a head that could never arrive: the pass did nothing,
    // round after round, while the driver counted each one.
    const r = await measureFrom(join(scratchClean.dir, ".git"));
    // Unreadable beats wrong: `unavailable` disarms the head-sync guard and
    // produces no stall fingerprint, where a confident wrong SHA wedges it.
    expect(r.localSource).toBe("unavailable");
    expect(r.local).toBe("");
    expect(r.stderr).toContain("outside a working tree");
  });

  it("measures in $DRIVE_PR_WORKTREE when the driver named one, whatever the cwd", async () => {
    // The anchor drive.ts exports. Same poisoned cwd as above; the difference
    // is that the driver said which tree it drives, so the reading is that
    // tree's head rather than a refusal.
    const r = await measureFrom(join(scratchClean.dir, ".git"), {
      DRIVE_PR_WORKTREE: scratchClean.dir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
  });

  it("still measures the cwd’s own head when it IS a worktree and no anchor is set", async () => {
    // The ordinary interactive case must not be collateral: no anchor, a cwd
    // that is a real working tree, and the reading is that tree's head.
    const r = await measureFrom(scratchClean.dir);
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
  });

  it("reports --no-head-sync as `disabled`, distinct from a measurement that FAILED", async () => {
    // The two empty-`local` shapes are not interchangeable, and only this
    // publishes the opt-out one. A caller declining to COMPARE the local head
    // is not a caller asserting no local commit happened — so `disabled` must
    // reach the report as its own value, where `roundFingerprint` refuses it
    // alongside `unavailable` (asserted there directly) and the drive falls
    // through to --max-rounds instead of stopping on sameness it never
    // witnessed.
    //
    // From a REAL worktree, so the reading is `disabled` because the flag said
    // so and not because the measurement had nowhere to run — the probe above
    // shows this same cwd measures `git` without the flag, which is what makes
    // this one non-vacuous. It replaces the end-to-end half of a `drive.ts`
    // stall probe that spent ~12.9s establishing the same fact through three
    // full rounds.
    const r = await measureFrom(scratchClean.dir, {}, ["--no-head-sync"]);
    expect(r.localSource).toBe("disabled");
    expect(r.local).toBe("");
  });

  /**
   * A "main" repo plus a LINKED worktree off it — the real relationship a
   * Conductor checkout has to its origin repo (`git worktree add`), not two
   * independent `git init`s. an earlier change's bug needs this exact shape: the
   * linked worktree's gitdir lives under the main repo's
   * `.git/worktrees/<name>`, and a git-hook env leak (`GIT_DIR`+
   * `GIT_WORK_TREE`, lefthook exports both) points at a tree of that shape —
   * a normal, non-bare worktree that `--is-inside-git-dir` answers `false`
   * for, same as the tree being driven. `linked` gets its own extra commit so
   * its head provably differs from `main`'s and from any sibling linked
   * worktree's — a probe that can't tell the trees apart by SHA can't prove
   * which one a mismeasurement actually read.
   */
  function makeMainPlusLinkedWorktree(name: string): {
    mainDir: string;
    mainHead: string;
    linkedDir: string;
    linkedHead: string;
  } {
    const mainRepo = makeScratchRepo(`${name}-main`);
    const linkedDir = join(tmpRoot, `${name}-linked`);
    const env = gitCleanEnv();
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    git(
      mainRepo.dir,
      "worktree",
      "add",
      "-q",
      "-b",
      `${name}-branch`,
      linkedDir,
    );
    writeFileSync(join(linkedDir, "linked.txt"), `${name}\n`);
    git(linkedDir, "add", "-A");
    git(linkedDir, "commit", "-qm", `linked ${name}`, "--no-verify");
    const linkedHead = git(linkedDir, "rev-parse", "HEAD")
      .stdout.toString()
      .trim();
    return {
      mainDir: mainRepo.dir,
      mainHead: mainRepo.head,
      linkedDir,
      linkedHead,
    };
  }

  /** The linked worktree's OWN gitdir — `.git/worktrees/<name>` — not the shared common one. */
  function absoluteGitDir(dir: string): string {
    return Bun.spawnSync(["git", "rev-parse", "--absolute-git-dir"], {
      cwd: dir,
      env: gitCleanEnv(),
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  }

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at the MAIN worktree never reports its SHA as trustworthy — the sanitized read recovers the LINKED worktree's own HEAD instead", async () => {
    const { mainDir, mainHead, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("doc6876-main");
    expect(linkedHead).not.toBe(mainHead);
    // The driver names the LINKED worktree as the tree to drive; the leak used
    // to make every git call in this process answer for the MAIN worktree
    // instead. Stripping GIT_DIR/GIT_WORK_TREE (and the rest of
    // GIT_LOCATION_VARS) from the measurement calls' own env neutralizes the
    // leak at the source, so the read correctly falls back to ordinary
    // cwd-based discovery from `linkedDir` rather than merely detecting the
    // poisoning and refusing (the toplevel-identity check alone cannot catch a
    // GIT_DIR-only leak, since without GIT_WORK_TREE git treats cwd itself as
    // the worktree root).
    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(mainDir),
      GIT_WORK_TREE: mainDir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(mainHead);
  });

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at a SIBLING linked worktree never reports its SHA as trustworthy — the sanitized read recovers the driven worktree's own HEAD instead", async () => {
    const { mainDir, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("doc6876-sib-a");
    const siblingDir = join(tmpRoot, "doc6876-sib-b");
    const env = gitCleanEnv();
    Bun.spawnSync(
      [
        "git",
        "worktree",
        "add",
        "-q",
        "-b",
        "doc6876-sib-b-branch",
        siblingDir,
      ],
      { cwd: mainDir, env, stdout: "pipe", stderr: "pipe" },
    );
    writeFileSync(join(siblingDir, "sibling.txt"), "sibling\n");
    Bun.spawnSync(["git", "add", "-A"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "commit", "-qm", "sibling commit", "--no-verify"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const siblingHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: siblingDir,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(siblingHead).not.toBe(linkedHead);

    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(siblingDir),
      GIT_WORK_TREE: siblingDir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(siblingHead);
  });

  it("acceptance: a leaked GIT_DIR/GIT_WORK_TREE pointed at an UNRELATED checkout never reports its SHA as trustworthy — the sanitized read recovers the driven checkout's own HEAD instead", async () => {
    // scratchClean and scratchOther share no history at all — the third
    // acceptance shape, distinct from a main checkout or a sibling linked
    // worktree of the SAME repo.
    const r = await measureFrom(scratchClean.dir, {
      DRIVE_PR_WORKTREE: scratchClean.dir,
      GIT_DIR: join(scratchOther.dir, ".git"),
      GIT_WORK_TREE: scratchOther.dir,
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(scratchClean.head);
    expect(r.local).not.toBe(scratchOther.head);
  });

  it("acceptance: a GIT_DIR-only leak, with NO GIT_WORK_TREE, never reports the foreign SHA as trustworthy", async () => {
    // The shape the toplevel-identity check alone cannot catch: without
    // GIT_WORK_TREE, git treats the CURRENT DIRECTORY as the worktree root,
    // so `--show-toplevel` resolves to `linkedDir` (matching the anchor)
    // even while GIT_DIR points `rev-parse HEAD` at the MAIN worktree's
    // history — the old mismatch-only guard would have accepted `mainHead`
    // as trustworthy here. Sanitizing GIT_DIR out of the measurement calls'
    // own env closes it: HEAD is read via ordinary cwd-based discovery from
    // `linkedDir` instead.
    const { mainDir, mainHead, linkedDir, linkedHead } =
      makeMainPlusLinkedWorktree("doc6876-gitdir-only");
    expect(linkedHead).not.toBe(mainHead);
    const r = await measureFrom(linkedDir, {
      DRIVE_PR_WORKTREE: linkedDir,
      GIT_DIR: absoluteGitDir(mainDir),
    });
    expect(r.localSource).toBe("git");
    expect(r.local).toBe(linkedHead);
    expect(r.local).not.toBe(mainHead);
  });

  /** A `git` stub that hangs on ONE subcommand and delegates every other call
   * to the real binary — same shape as the `announce-merge-ready.ts` timeout
   * probes above, applied here to the measurement calls this describe
   * block owns. */
  function makeHangingGitStub(hangsOn: string[]): string {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("no git on PATH to wrap for this probe");
    const dir = mkdtempSync(join(tmpdir(), "drive-pr-git-hang-stub-"));
    const stubPath = join(dir, "git");
    const cond = hangsOn
      .map((arg, i) => `[ "\${${i + 1}:-}" = "${arg}" ]`)
      .join(" && ");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        `if ${cond}; then`,
        "  sleep 30",
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);
    return dir;
  }

  it("the local-HEAD `rev-parse HEAD` read refuses on a TIMEOUT rather than hanging", async () => {
    // Neither of this describe block's two `git()` calls carried a deadline —
    // `git()` is undeadlined by default on the premise that a local call
    // cannot hang the way a network one can, but a stalled FUSE/NFS mount or
    // a held filesystem lock defeats that premise, and this read feeds a
    // fail-closed guard that must not block forever waiting to fail closed.
    const gitStubDir = makeHangingGitStub(["rev-parse", "HEAD"]);
    const started = Date.now();
    const r = await measureFrom(scratchClean.dir, {
      DRIVE_PR_WORKTREE: scratchClean.dir,
      GIT_CALL_TIMEOUT: "1",
      PATH: `${gitStubDir}:${binDir}:${process.env.PATH}`,
    });
    const elapsed = Date.now() - started;
    expect(r.localSource).toBe("unavailable");
    expect(r.local).toBe("");
    expect({ boundedWellUnder30s: elapsed < 15_000 }).toEqual({
      boundedWellUnder30s: true,
    });
  });

  it("the local-HEAD `rev-parse --show-toplevel` identity check refuses on a TIMEOUT rather than hanging", async () => {
    const gitStubDir = makeHangingGitStub(["rev-parse", "--show-toplevel"]);
    const started = Date.now();
    const r = await measureFrom(scratchClean.dir, {
      DRIVE_PR_WORKTREE: scratchClean.dir,
      GIT_CALL_TIMEOUT: "1",
      PATH: `${gitStubDir}:${binDir}:${process.env.PATH}`,
    });
    const elapsed = Date.now() - started;
    // `rev-parse HEAD` still succeeds (real git, real SHA) before the
    // identity check's own `--show-toplevel` call hangs — so this pins the
    // SECOND call's deadline specifically, distinct from the probe above.
    expect(r.localSource).toBe("unavailable");
    expect(r.local).toBe("");
    expect({ boundedWellUnder30s: elapsed < 15_000 }).toEqual({
      boundedWellUnder30s: true,
    });
  });
});

describe("drive-status.ts refuses to converge — the measured false-convergence modes", () => {
  it("mode 1: summary-only findings are open work even with zero threads", async () => {
    const r = await probe({ threads: [], backlog: true, anchored: [] });
    expect(r.state).not.toBe("CONVERGED");
    expect(r.state).toBe("ROUND_READY");
    // Two backlog entries plus the unanchored body bullet.
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(3);
  });

  it("mode 1b: answering every summary finding lets it converge", async () => {
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      addressed: ["b9a7a18089043564", "c773d9fdb7974e6d"],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("mode 2+4: a settled non-posting reviewer does not stand in for the posting one", async () => {
    // Exactly the observed set on a fresh head: the dormant CI arm (SKIPPED)
    // plus a rate-limited CodeRabbit reporting SUCCESS as a commit status,
    // while `AI review (shadow)` has not been created yet.
    const r = await probe({
      threads: [],
      checkRuns: [DORMANT_ARM],
      statuses: [
        {
          context: "CodeRabbit",
          state: "success",
          description: "Review rate limited",
        },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("mode 2b: a reviewer check-run that was SKIPPED never reviewed anything", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "skipped" }],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("mode 2c: a reviewer check-run still in progress, with no sticky posted at all, is not settled", async () => {
    // `reviewedSha: null` is load-bearing here — the default fixture posts a
    // matching sticky, which is exactly the stranded-check-run shape an earlier change
    // now trusts (see the tests below). This probe models the genuinely
    // still-running case: in_progress AND no marker evidence of any kind.
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, status: "in_progress", conclusion: null }],
      reviewedSha: null,
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  /**
   * Seed the drive-state store's `.rounds` counter directly, ahead of a
   * probe — the "last counted round" the stranded-check-run bypass (below)
   * compares the sticky's `ai-review-round` against. `probe` has no
   * fixture knob for it because nothing before an earlier change ever needed to
   * control it; every other test either accepts the fresh-state default (0)
   * or bumps it indirectly through a real round.
   */
  function seedRounds(stateDir: string, rounds: number) {
    writeFileSync(
      join(stateDir, "drive-pr-999.json"),
      JSON.stringify({
        pr: 999,
        rounds,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        verifiedSha: "",
        phase: "",
        readyMarkedRound: 0,
        ciHold: null,
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

  describe("stranded-check-run bypass", () => {
    // Measured live: the check-run for a head sat 'in_progress' 3.5+ hours
    // while the review had already published its sticky (round 6, matching
    // `ai-reviewed-sha`), three inline threads, and a wind-down entry. The gate
    // reported AWAITING_REVIEWER forever, learning nothing from the marker it
    // already trusts on the no-check-run path.

    // Comfortably past the $DRIVE_PR_STALLED_MIN_AGE_SEC age floor — the
    // fourth bypass condition, which rules out reading a sticky that was
    // upserted before its own inline threads finished posting (outbox
    // semantics; see terminal-states.md § the age-floor test below). Older
    // than `DEFAULT_STICKY_UPDATED_AT` so condition 5 (the sticky post-dates
    // the run) holds for every probe that is not specifically about it.
    const OLD_ENOUGH_STARTED = new Date(
      Date.now() - STALLED_MIN_AGE_SEC * 3 * 1000,
    ).toISOString();

    it("an in_progress check-run whose sticky already reviewed THIS head at a NEWER round yields ROUND_READY", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        // Default reviewedSha (== HEAD) and default sticky round (7,
        // STICKY_ROUND) — the sticky names this exact head.
      });
      seedRounds(stateDir, 6); // one behind the sticky's round 7
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
      // AC: the reason states the check-run and the marker disagree.
      expect(r.json.reason).toContain("reads 'in_progress'");
      expect(r.json.reason).toContain("round 7");
      expect(r.json.reason).toContain("comment-marker");
    });

    it("the same shape with zero live work converges instead of blocking", async () => {
      // The bypass does not only unlock ROUND_READY — it unlocks whatever the
      // enumerated work supports, exactly as the no-check-run 'comment-marker'
      // path already does for CONVERGED.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("CONVERGED");
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("the same shape with every thread parked reaches HITL_PARKED, not stuck AWAITING_REVIEWER", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      await park(stateDir, "t1", "thread");
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("HITL_PARKED");
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("a marker naming an EARLIER head still blocks — the fix must not race a real review", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        reviewedSha: PREV,
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a marker at a round the drive has ALREADY counted does not bypass", async () => {
      // Sticky round is 7 (default); counting 7 already means this exact
      // round's evidence was already consumed by a prior evaluation, so it is
      // not fresh — replaying it would let a stale in_progress check-run be
      // waved through on evidence that predates it.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 7);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a QUEUED check-run does not bypass — only in_progress does", async () => {
      // Queued has not started at all, so there is nothing a marker could
      // have overtaken; the bypass is scoped to in_progress specifically.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "queued",
            conclusion: null,
            started: null,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an in_progress run that just started does NOT bypass — the outbox-race guard", async () => {
      // Publication is not atomic: the sticky can land before its own inline
      // threads finish posting. A run that started SECONDS ago, still
      // reading zero threads, must not be trusted as "the round already
      // published nothing" — only a run old enough that a real publish would
      // have finished is. Everything else about the fixture matches the
      // CONVERGED-via-bypass test above; only the run's age differs.
      //
      // The sticky is dated a second after that start, so it is genuinely
      // THIS run's evidence (condition 5 holds) and the young sticky is the
      // sole decider — without that, the fixture would trip condition 5 and
      // pass vacuously, asserting nothing about the floor (a fail-closed
      // conjunction needs each clause to be the sole decider in its probe).
      const startedMs = Date.now() - 5000;
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: new Date(startedMs).toISOString(),
          },
        ],
        stickyUpdatedAt: new Date(startedMs + 1000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a FRESHLY-EDITED sticky on a long-stranded run does NOT bypass — the floor ages the evidence, not the run", async () => {
      // The first cut floored the CHECK-RUN's own
      // `started_at`, which the stranded run clears by construction — it has
      // been stuck for hours. So a sticky rewritten seconds before the read,
      // with its inline threads still mid-publish, sailed through the very
      // window the floor exists to exclude and reached a false CONVERGED.
      //
      // Everything here matches the CONVERGED-via-bypass probe above except
      // the sticky's own age: the run is comfortably past the floor, and only
      // basing the floor on `updated_at` blocks it.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a sticky PREDATING the run does NOT bypass — a re-run on an unchanged head cannot inherit the old attempt evidence", async () => {
      // A re-run never rewrites `ai-reviewed-sha`,
      // so the previous attempt's sticky still names this exact head and
      // clears the SHA pin; the round comparison is near-vacuous against a
      // per-drive counter. Once the re-run itself crossed the age floor,
      // every remaining condition held and the stale sticky authorized
      // convergence on evidence THIS attempt never produced.
      //
      // The sticky is old enough to clear the age floor on its own, so
      // condition 5 — it must post-date the run's start — is the sole
      // decider here rather than the floor catching it incidentally.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        // Older than OLD_ENOUGH_STARTED, and derived from the same constant so
        // it stays that way if the floor moves — condition 5 is the sole
        // decider here only while the sticky both clears the floor and
        // predates the run.
        stickyUpdatedAt: new Date(
          Date.now() - STALLED_MIN_AGE_SEC * 4 * 1000,
        ).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an ABBREVIATED sticky marker that resolves to this head DOES bypass", async () => {
      // The bypass compared `sticky.sha` to the head
      // raw, while the marker grammar admits 7-40 hex — so an abbreviated
      // marker could never match a 40-character head, and the one situation
      // this bypass exists to unblock stayed blocked forever. The reviewed-SHA
      // gate a few hundred lines down had resolved abbreviations through git
      // all along; both now share `resolveMarkerSha`.
      //
      // Needs a head git can actually resolve, so `realHead()` rather than the
      // opaque `HEAD` token — same reasoning as the mode-5b probes.
      const head = await realHead();
      const { dir, stateDir } = writeFixture({
        threads: [],
        head,
        reviewedSha: head.slice(0, 8),
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, head);
      expect(r.state).toBe("CONVERGED");
      // Specifically via the bypass, not some other route to CONVERGED.
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("an abbreviated sticky marker that resolves to a DIFFERENT commit does NOT bypass", async () => {
      // The other half: resolving must not become accepting. A marker that
      // resolves to some other object is not a witness to this head, and the
      // stranded run keeps blocking. Without this, the fix above could have
      // been "resolve, then compare prefixes" and still pass.
      const head = await realHead();
      const other = makeOrphanCommit("drive-pr-probe-bypass-abbrev");
      const { dir, stateDir } = writeFixture({
        threads: [],
        head,
        reviewedSha: other.slice(0, 16),
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, head);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an EMPTY $DRIVE_PR_STALLED_MIN_AGE_SEC does not disable the floor", async () => {
      // `Math.max(0, Number(''))` is 0, so an empty
      // env var silently switched the whole floor off — failing OPEN on a
      // misconfiguration that reads like it set a bound. (A non-numeric value
      // already failed closed through NaN; empty-string and negative did not.)
      //
      // The fixture is the freshly-edited-sticky shape, which the floor is the
      // sole reason to reject: with the floor disabled this converges, with the
      // default restored it blocks.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "" },
      });
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a NEGATIVE $DRIVE_PR_STALLED_MIN_AGE_SEC does not disable the floor", async () => {
      // The other value the old `Math.max(0, ...)` clamp swallowed.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "-1" },
      });
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an explicit positive $DRIVE_PR_STALLED_MIN_AGE_SEC is still honoured", async () => {
      // The dial must stay a dial: rejecting junk must not mean ignoring a
      // legitimate operator setting. Same freshly-edited sticky as the two
      // probes above — a low-but-positive floor is exactly what lets it
      // through, so this fails if the fix hardcoded the default.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "1" },
      });
      expect(r.state).toBe("CONVERGED");
    });

    it("the default floor covers reconciliation THRESHOLD + one full pass INTERVAL + publication", async () => {
      // an earlier change and 4. The floor's job is to let the reviewer
      // service's own outbox reconciliation repair a crashed-mid-publish head
      // before the drive trusts a sticky with zero threads behind it — so it
      // has to cover the worst case of that repair, not its best.
      //
      // A 600s default sat under the reactivation threshold outright. The
      // follow-on fix was still short: 2100s cleared the 30-minute
      // threshold but encoded ONLY that, dropping the 15-minute pass cadence
      // (the threshold is evaluated when a pass runs, so worst-case detection
      // is threshold + interval) and the re-run's own publication time (a
      // reactivated row has not rewritten its sticky or posted its threads
      // until it publishes). The same false convergence stayed reachable, just
      // later.
      //
      // Asserted as the RELATIONSHIP between the service's documented timings,
      // never as a number: an equality against 3600 would restate the sum a
      // reader has to trust, and an inequality against the threshold alone is
      // exactly the too-weak assertion that let 2100s pass. Retuning any
      // component stays free; dropping a term from the sum fails here.
      expect(STALLED_MIN_AGE_SEC).toBeGreaterThanOrEqual(
        RECONCILIATION_REACTIVATION_SEC +
          RECONCILIATION_INTERVAL_SEC +
          REVIEW_PUBLICATION_MARGIN_SEC,
      );
      // Each term contributes — a probe that passed with any of them zeroed
      // would not be testing the sum.
      expect(RECONCILIATION_REACTIVATION_SEC).toBeGreaterThan(0);
      expect(RECONCILIATION_INTERVAL_SEC).toBeGreaterThan(0);
      expect(REVIEW_PUBLICATION_MARGIN_SEC).toBeGreaterThan(0);
    });

    it("an UNDATABLE sticky does NOT bypass — fail closed rather than read absence as freshness", async () => {
      // `updated_at` absent or unparseable must not be treated as "now" (nor
      // as epoch, which would clear the floor while failing condition 5).
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: "not-a-timestamp",
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });
  });

  it("mode 3: PR-head replication lag is not judged at all", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], head: PREV });
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const json = JSON.parse(out);
    expect(json.state).toBe("HEAD_LAG");
    expect(exitCode).toBe(4);
  });

  it("mode 5: a stale ai-reviewed-sha marker blocks convergence", async () => {
    const r = await probe({ threads: [], reviewedSha: PREV });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain(PREV);
  });

  it("mode 5b: an ABBREVIATED marker naming a DIFFERENT commit is still stale", async () => {
    // The marker grammar admits 7–40 hex, and a prefix comparison accepts any
    // commit sharing the head's first N characters — so a stale review of a
    // different commit passes as fresh, which is mode 5 wearing a disguise.
    // `PREV` is a fabricated SHA; `makeOrphanCommit` gives the marker a real,
    // resolvable commit — created fresh in THIS repository's object store on
    // every run, so the probe holds on any checkout, CI included —
    // whose first PREFIX_LEN characters name a different object entirely.
    //
    // Old behaviour on exactly this input: `${api_head:0:PREFIX_LEN}` == the
    // marker, so CONVERGED. New behaviour: resolve first, then compare in
    // full. `PREV` alone as `head` would not exercise that: its prefix has no
    // reason to match `real`'s, so even the broken prefix-comparison
    // implementation would report STALE_REVIEW here for an unrelated reason,
    // making the probe pass regardless of which implementation is under test.
    // The fabricated head below shares `real`'s prefix — the collision the
    // old comparison would have accepted — while its full SHA still differs.
    //
    // PREFIX_LEN is 16 hex (64 bits), not the 8 (32 bits) a real ABBREVIATED
    // marker could use: at 8, `git rev-parse` can hit an existing object in
    // this repository's own object store sharing those first 32 bits and reject
    // the abbreviation as ambiguous, sending the probe down the cannot-resolve
    // path instead and making it flaky. 64 bits keeps that collision
    // astronomically unlikely while the marker is still well under the 40-hex
    // full length, so it still exercises the ABBREVIATED-marker path this probe
    // is named for.
    const PREFIX_LEN = 16;
    const real = makeOrphanCommit("drive-pr-probe-mode-5b");
    const collidingPrefixHead = `${real.slice(0, PREFIX_LEN)}${PREV.slice(PREFIX_LEN)}`;
    const r = await probe({
      threads: [],
      head: collidingPrefixHead,
      reviewedSha: real.slice(0, PREFIX_LEN),
    });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    // Names the object it actually resolved to, not just the abbreviation.
    expect(r.stderr).toContain(real);
  });

  it("refuses an abbreviated marker it cannot resolve AT ALL", async () => {
    // A shallow clone, a fetch that never brought the object, or no git: the
    // marker witnesses nothing, and the honest report is that this head cannot
    // be confirmed reviewed. It is a prefix of the head, so the old comparison
    // accepted it outright.
    const unresolvable = `ffffff0${"a".repeat(33)}`;
    const r = await probe({
      threads: [],
      head: unresolvable,
      reviewedSha: unresolvable.slice(0, 7),
    });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("cannot be resolved");
  });

  it("still converges on an abbreviation that resolves TO the head", async () => {
    // Failing closed must not mean refusing every abbreviation: one that
    // resolves to this exact commit is a genuine witness. Needs a head git can
    // actually resolve, so it uses `realHead()` rather than the opaque `HEAD`
    // token — same reasoning as mode 5b above.
    const head = await realHead();
    const r = await probe({ threads: [], head, reviewedSha: head.slice(0, 8) });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(head);
  });

  it("still accepts a full-length reviewed-SHA equal to the head", async () => {
    // The stamp the reviewer actually emits today is the full 40 characters,
    // and it must not need git at all.
    const r = await probe({ threads: [], reviewedSha: HEAD });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedShaSource).toBe(
      "comment-marker",
    );
  });

  // The probes below were found by running drive-status.ts against its OWN pull
  // request. GitHub returns check-runs newest-FIRST, and one SHA
  // routinely carries several runs under the same name — there, a `cancelled`
  // `Parse ops-followups block` sat alongside the `success` that superseded it.
  it("a superseded (cancelled) check-run does not mark CI failing forever", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [
        // Newest first, exactly as the API orders them.
        {
          name: "Parse ops-followups block",
          status: "completed",
          conclusion: "success",
          app: "github-actions",
          started: "2026-08-03T13:05:00Z",
        },
        {
          name: "Parse ops-followups block",
          status: "completed",
          conclusion: "cancelled",
          app: "github-actions",
          started: "2026-08-03T13:00:00Z",
        },
        REVIEWER_RUN,
      ],
    });
    expect(r.json.ci).toBe("green");
    expect(r.state).toBe("CONVERGED");
  });

  // The `ci` verdict is what announce-merge-ready.ts trusts before telling a
  // human the branch is safe. Every way it can read green while it is not:
  it("a PENDING legacy commit status is not green", async () => {
    const r = await probe({
      threads: [],
      statuses: [
        { context: "CodeRabbit", state: "pending", description: "reviewing" },
      ],
    });
    expect(String(r.json.ci)).toStartWith("pending:");
    expect(String(r.json.ci)).toContain("CodeRabbit");
  });

  it("mode 12: a head that moves MID-EVALUATION is not convergence", async () => {
    // `api_head` is read at the top of evaluate(); the thread query, the
    // summary enumerator and the check-run reads all follow it, each with a
    // 120s deadline. A push anywhere in that window leaves every witness
    // describing a head the PR no longer has, and CONVERGED would name a SHA
    // nobody reviewed.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
      headMovesTo: PREV,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
    expect(r.json.reason).toContain(PREV);
  });

  it("mode 12b: EVERY terminal return re-checks the head, not just CONVERGED", async () => {
    // The first version of this guard covered CONVERGED alone. HITL_PARKED is
    // also terminal, also stops drive.ts, and returns a few lines earlier — so
    // a parked drive could hand back against a head another actor had already
    // replaced, and the newer head would go unreviewed until a human looked.
    // Guarding per-site means remembering it again at the next terminal state
    // anyone adds, which is the class of guard this skill exists to mechanize.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
      headMovesTo: PREV,
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // Without the guard this is HITL_PARKED / 8 — terminal, on a stale head.
    expect(JSON.parse(out).state).toBe("HEAD_MOVED");
    expect(exitCode).toBe(4);
  });

  it("an unreadable PARKED set is indeterminate, not an empty one", async () => {
    // `|| true` here undid the fail-closed state reader one layer up: state
    // that becomes malformed after startup would report zero parked items, so
    // a thread a human parked reads as live work and the drive re-arms it.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    writeFileSync(join(stateDir, "drive-pr-999.json"), "not json at all");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(out);
    expect(json.state).toBe("INDETERMINATE");
    // The REASON, not just the state. Malformed state also breaks the round-count
    // persist a few lines later, which reports the same exit and the same state —
    // so asserting only those lets this pass while the parked read still swallows
    // its error, which is precisely the defect.
    expect(json.reason).toContain("parked set");
  });

  it("reads EVERY page of legacy commit statuses before calling CI green", async () => {
    // A commit can carry more than one page of status contexts. Reading only
    // the first drops the rest from the verdict entirely, so a failing context
    // on page 2 leaves `ci_verdict: green` — and announce-merge-ready.ts, which
    // refuses on anything but exactly `green`, then tells a human every
    // non-reviewer check succeeded over one nobody looked at.
    const r = await probe({
      threads: [],
      statuses: [{ context: "page-1/ok", state: "success", description: "" }],
      statusesPage2: [
        { context: "page-2/broken", state: "failure", description: "" },
      ],
    });
    expect(r.json.ci).toContain("failing");
    expect(r.json.ci).toContain("page-2/broken");
  });

  it("an UNREADABLE commit-status API is unknown, not green", async () => {
    // A timeout or 403 must not read as "no legacy statuses exist".
    const r = await probe({ threads: [], statusesUnreadable: true });
    expect(String(r.json.ci)).toStartWith("unknown:");
  });

  it("two apps sharing a check NAME do not mask each other", async () => {
    // Grouping by name alone lets one app's newer success discard the other's
    // failure, and announce-merge-ready.ts then claims everything is green.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          app: "app-a",
          started: "2026-08-03T13:05:00Z",
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "failure",
          app: "app-b",
          started: "2026-08-03T13:00:00Z",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("failing:");
    expect(String(r.json.ci)).toContain("lint");
  });

  it("a completed run with a NULL conclusion is pending, not green", async () => {
    // It matched neither the failing nor the pending predicate and so vanished
    // from the verdict entirely, leaving `green` over an indeterminate run.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "flaky",
          status: "completed",
          conclusion: null,
          app: "github-actions",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("pending:");
    expect(String(r.json.ci)).toContain("flaky");
  });

  it("a QUEUED reviewer rerun is not superseded by the completed run it replaces", async () => {
    // A queued attempt has no `started_at`. Ordering on that timestamp sorted
    // it BEFORE the old completed run, so `last` picked the stale success and
    // declared CONVERGED while a fresh review was pending. Ordering is on the
    // monotonic run id instead — the queued rerun is listed first (newest) and
    // therefore carries the higher id.
    const r = await probe({
      threads: [],
      checkRuns: [
        { ...REVIEWER_RUN, status: "queued", conclusion: null, started: null },
        { ...REVIEWER_RUN, started: "2026-08-03T13:00:00Z" },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("a FAILING sibling check from the reviewer app still counts against CI", async () => {
    // Excluding the whole app from the verdict — rather than just the posting
    // review check — dropped its siblings entirely, so a failing one read green.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "coverage telemetry",
          status: "completed",
          conclusion: "failure",
          app: "example-review",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("failing:");
    expect(String(r.json.ci)).toContain("coverage telemetry");
  });

  it("a sibling check from the reviewer APP does not attest that review completed", async () => {
    // The app slug alone is not an identity: an app may publish several checks
    // on one SHA. Only the named reviewer check counts.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "coverage telemetry",
          status: "completed",
          conclusion: "success",
          app: "example-review",
        },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("judges the reviewer on its NEWEST run, not the API’s first-listed one", async () => {
    // A re-run superseding a failed attempt. Taking the array's `last` would
    // read the older FAILURE and report REVIEWER_FAILED on a clean re-review.
    const r = await probe({
      threads: [],
      checkRuns: [
        { ...REVIEWER_RUN, started: "2026-08-03T13:05:00Z" },
        {
          ...REVIEWER_RUN,
          conclusion: "failure",
          started: "2026-08-03T13:00:00Z",
        },
      ],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("still reports REVIEWER_FAILED when the NEWEST reviewer run failed", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          ...REVIEWER_RUN,
          conclusion: "failure",
          started: "2026-08-03T13:05:00Z",
        },
        { ...REVIEWER_RUN, started: "2026-08-03T13:00:00Z" },
      ],
    });
    expect(r.state).toBe("REVIEWER_FAILED");
    expect(r.exitCode).toBe(7);
  });

  it("an inline comment from an EARLIER round does not hide a new summary finding", async () => {
    // Anchoring is a per-round property. Matching against every inline comment
    // the PR ever received means one thread on `a.ts` in round 1 hides every
    // later summary-only finding on `a.ts`, permanently.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md"],
      anchoredRound: STICKY_ROUND - 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("a sticky with NO round marker anchors nothing, rather than anchoring everything", async () => {
    // With no round to scope by, admitting every inline comment the reviewer
    // ever posted lets a long-resolved comment at the same `path:line` consume
    // a current bullet — the live finding vanishes from `summaryUnaddressed`
    // while thread count reads zero, which is the false convergence reached
    // through the one input nobody controls. Fail closed: nothing anchors, so
    // the bullet stays open work.
    const r = await probe({
      threads: [],
      backlog: false,
      stickyRound: null,
      // An inline comment anchored EXACTLY to the bullet, which would cover it
      // if the historical set were still trusted.
      anchored: [".claude/agents/review-arbiter.md:31"],
      anchoredRound: 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("records the round for a ready head, and refuses to proceed when it cannot", async () => {
    // `|| true` here returned ROUND_READY having recorded nothing. Since the
    // per-process pass counter resets, every restart then granted another full
    // `--max-rounds` on a counter that never advanced.
    const { dir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // A regular FILE where the state dir belongs: `mkdir -p` cannot create it,
    // which is what an unwritable state dir looks like from here.
    const blocked = join(dir, "unwritable-state");
    writeFileSync(blocked, "not a directory");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: blocked,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(out).state).toBe("INDETERMINATE");
  });

  it("reads the reviewed-SHA witness only from the STICKY comment", async () => {
    // A non-sticky reviewer comment carrying a marker for an older head must
    // not override the real witness — the contract names the sticky.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      decoyReviewerComments: [`chatter\n<!-- ai-reviewed-sha: ${PREV} -->`],
    });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(HEAD);
  });

  it("one anchored finding does not suppress a second finding on the SAME file", async () => {
    // Reducing anchoring to a set of PATHS meant a neighbour's thread hid this
    // finding entirely. The inline comment here is anchored to line 31; the
    // body bullet in the fixture is also line 31, so a line-99 anchor must NOT
    // cover it.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:99"],
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("an inline comment anchored to the finding DOES cover it", async () => {
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("an addressed marker from an untrusted commenter does not permit convergence", async () => {
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      addressed: ["b9a7a18089043564", "c773d9fdb7974e6d"],
      addressedBy: "NONE",
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(2);
  });

  it("CLI wiring: a backlog fix marker at the reviewed head registers end to end", async () => {
    // Unlike the `collectAddressed` unit probes in `summary-findings parsing`
    // above, this drives the REAL chain: `drive-status.ts` spawns
    // `summary-findings.ts` as a subprocess, which reads the sticky's own
    // backlog blob via `backlogFingerprintsOf` and wires it into
    // `collectAddressed` itself — nothing here calls either function
    // directly. A one-line regression to that wiring (`backlogFingerprints:
    // new Set()`, or restoring the retired `reason === 'winddown-deferred'`
    // filter) would leave `c773d9fdb7974e6d` unaddressed here even though
    // every direct-call probe above still passes.
    //
    // Only ONE of the sticky's two backlog entries gets a marker, so the
    // count below is unambiguous evidence THIS fingerprint registered — a
    // wiring bug that drops backlog membership entirely would leave both
    // unaddressed and this would read 2, not 1.
    //
    // The head here must be one `reviewerPosition` can RESOLVE: it decides
    // `at` vs `past` through `git rev-parse`, and an unresolvable revision
    // fails closed to `past`, which drops the marker and makes this read 2 for
    // a reason that has nothing to do with the wiring under test. Hence
    // `realHead()` rather than the opaque `HEAD` token (see its own comment —
    // a literal that resolved only in checkouts carrying one idle branch is
    // what this probe originally had).
    const head = await realHead();
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      head,
      reviewedSha: head,
      fixDependentAddressed: [{ fingerprint: "c773d9fdb7974e6d", sha: head }],
    });
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("no marker at all falls back to the check-run, and SAYS the witness is weaker", async () => {
    // The fallback survives for a ROUND: evidence of live work is positive
    // there, so a weak SHA witness costs nothing.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      reviewedSha: null,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.reviewer as Record<string, unknown>).reviewedShaSource).toBe(
      "check-run",
    );
  });

  it("mode 7: a completed reviewer that published NO sticky cannot converge", async () => {
    // Both zeroes convergence rests on are read out of the sticky comment's
    // neighbourhood — summary-findings.ts reads a missing sticky as zero
    // findings, and a review that posted nothing leaves zero threads. So a
    // completed check-run with no published sticky makes "nothing left to say"
    // and "nothing was ever said" the same observation, and the weaker witness
    // cannot tell them apart.
    const r = await probe({ threads: [], reviewedSha: null });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("mode 8: a reviewer-app sibling whose NAME merely contains the pattern does not attest", async () => {
    // The (app, name) pair only splits siblings if the name half is anchored.
    // Unanchored it is a substring match, so `AI review telemetry` from the
    // reviewer's own app rejoins the set the pair exists to exclude — and the
    // newest-run reduction then lets its success stand in for a posting check
    // that never ran.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      checkRuns: [
        {
          name: "AI review telemetry",
          status: "completed",
          conclusion: "success",
          app: "example-review",
        },
        DORMANT_ARM,
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });
});

describe("drive-status.ts HITL parking", () => {
  it("HITL_PARKED — every remaining thread awaits a human", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const json = JSON.parse(out);
    expect(json.state).toBe("HITL_PARKED");
    expect(exitCode).toBe(8);
    expect(json.work.parkedThreads).toBe(1);
  });

  it("an UNparked thread alongside a parked one is still a live round", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_parked", path: "a.ts", bot: true },
        { id: "PRRT_live", path: "b.ts", bot: true },
      ],
    });
    await park(stateDir, "PRRT_parked", "thread");
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(JSON.parse(out).state).toBe("ROUND_READY");
    expect(exitCode).toBe(0);
  });
});

// The reconciliation sweep used to be a sentence in SKILL.md — "run it
// independently of the gate's answer" — which is a duty nothing bounds except
// an agent remembering it. Every stuck verdict below ends the round without a
// pass running, so a reconciliation reachable only from inside a pass could
// never fire in exactly the situation it exists for. an earlier change moves it into
// the gate itself, ahead of the evaluation.
describe("drive-status.ts reconciles replied threads on every pass", () => {
  /** A thread whose last trusted comment already answered it, unresolved. */
  function repliedThread(id: string, token: string): FixtureThread {
    return {
      id,
      path: "a.ts",
      bot: false,
      comments: [
        { author: "example-review[bot]", bot: true, body: "a finding" },
        {
          author: "agent",
          authorAssociation: "MEMBER",
          body: `${token} — settled in an earlier, interrupted pass`,
        },
      ],
    };
  }

  function resolvedIn(dir: string): string[] {
    const f = join(dir, "resolved-threads.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  }

  /**
   * Both readers below FAIL on a non-zero exit rather than returning the
   * empty answer.
   *
   * `held-keys` returns `''` and `held` returns `[]` when `drive-state.ts`
   * writes nothing to stdout — and those are exactly the values three of the
   * assertions in this describe block treat as the passing result. A broken
   * `drive-state.ts held` would therefore have kept them green while proving
   * nothing about the sweep at all: the vacuous-pass shape.
   */
  function requireOk(exitCode: number, command: string): void {
    if (exitCode !== 0) {
      throw new Error(
        `drive-state.ts ${command} exited ${exitCode}; its empty result would ` +
          'otherwise read as "nothing held"',
      );
    }
  }

  async function heldKeysIn(stateDir: string): Promise<string> {
    const proc = Bun.spawn(
      [join(SCRIPTS, "drive-state.ts"), "held-keys", "999"],
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    requireOk(code, "held-keys");
    return out.trim();
  }

  /**
   * The held RECORDS, not just their keys. A key proves only that some hold
   * mentioning the thread exists — an ordinary claimable hold at the current
   * round satisfies that just as well as the unconfirmed one the sweep is
   * required to write, so a regression from the latter to the former is
   * invisible to a key-only assertion and would let a fix-dependent thread be
   * resolved with no push verification.
   */
  async function heldIn(
    stateDir: string,
  ): Promise<Array<Record<string, unknown>>> {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), "held", "999"], {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    requireOk(code, "held");
    return JSON.parse(out.trim() === "" ? "[]" : out.trim());
  }

  it("reconciles while the gate is stuck at AWAITING_REVIEWER — the measured leak", async () => {
    // The shape: nothing here becomes true with time (a CONFLICTING PR gets
    // zero `pull_request` CI; a PR past the reviewer's own round ceiling never
    // gets another check-run), so the gate returns 4 on every call forever and
    // no pass ever runs. `**rejected**` is a claim about the finding's MERIT —
    // not fix-dependent — so the sweep resolves it outright, and that has to
    // happen despite the verdict, not after it.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_stuck_gate", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual(["PRRT_stuck_gate"]);
  });

  it("reconciles on PR_CONFLICTING — the terminal state that never becomes anything with time", async () => {
    // The conflict variant of the same leak. Its findings are parked for a
    // human, so the conflict is terminal (exit 9) and no round is ever handed
    // out — while the thread itself already carries a merit reply somebody
    // posted on GitHub without clearing the park. Nothing here resolves
    // itself: the exit says so in as many words ("nothing here becomes
    // judgeable with time").
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_conflicting", "**deferred**")],
      checkRuns: [DORMANT_ARM],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    await park(stateDir, "PRRT_conflicting", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(resolvedIn(dir)).toEqual(["PRRT_conflicting"]);
  });

  it("reconciles ahead of the EARLIEST return — UNSUPPORTED_CLI is decided before anything is enumerated", async () => {
    // The strongest available witness that the sweep runs ahead of the
    // evaluation rather than somewhere inside it: `UNSUPPORTED_CLI` is raised
    // off the very first `gh pr view`, on the missing-field path, before
    // `evaluate()` has read liveness or the head — let alone enumerated any
    // work. If the sweep still resolved the thread here, it cannot be running
    // anywhere inside the evaluation.
    //
    // This probe used to use a DRAFT PR for the same purpose, on the grounds
    // that PR_IS_DRAFT was terminal and returned early. an earlier change
    // changed that — drafts are now driven and marked Ready after the first
    // round — so a draft falls through to ordinary evaluation and the fixture
    // stopped witnessing anything the AWAITING_REVIEWER probe above does not.
    // Retargeted rather than deleted, because "ahead of the earliest return"
    // is the property worth pinning, not the particular state that was
    // earliest when it was written.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_earliest", "**wont-fix**")],
      checkRuns: [DORMANT_ARM],
      mergeabilityUnreadable: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("UNSUPPORTED_CLI");
    expect(r.exitCode).toBe(2);
    expect(resolvedIn(dir)).toEqual(["PRRT_earliest"]);
  });

  it("re-holds an **accepted** reply unconfirmed — the gate never resolves a fix-dependent one", async () => {
    // The semantics an earlier change shipped are unchanged by being wired in: an
    // `accepted`/`moot` reply promises a FIX, and only resolve-held-thread.ts
    // may resolve one, after verifying the push that carries it. The sweep has
    // no way to confirm that, so it re-holds at a round `claim-held` can never
    // match and leaves the thread open for a live pass's own step 3.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_accepted", "**accepted**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
    // Asserted as the WHOLE record, because each field is a separate way the
    // production path could regress into an ordinary claimable hold: `round`
    // is the -1 sentinel `claim-held` can never match (the actual mechanism
    // keeping the thread unresolved until a live pass re-holds it for real),
    // and `commentUrl` must be the QUALIFYING reply's own permalink —
    // `comment-1`, not the finding at `comment-0` — since that is what a
    // later superseding comment is compared against.
    expect(await heldIn(stateDir)).toEqual([
      {
        key: "PRRT_accepted",
        kind: "thread",
        outcome: "accepted",
        round: -1,
        commentUrl: "https://example.invalid/PRRT_accepted/comment-1",
        actor: expect.any(String),
      },
    ]);
  });

  /**
   * Same shape as `repliedThread`, but STARTED by a human — the first comment
   * decides, which is what `list-unresolved-threads.ts --bots-only` filters
   * on. The reply is still a trusted MEMBER one, so the only thing separating
   * this from the bot fixtures is the authorship the social boundary turns on.
   */
  function humanRepliedThread(id: string, token: string): FixtureThread {
    return {
      id,
      path: "a.ts",
      bot: false,
      comments: [
        {
          author: "a-human-reviewer",
          authorAssociation: "MEMBER" as const,
          body: "a finding",
        },
        {
          author: "agent",
          authorAssociation: "MEMBER" as const,
          body: `${token} — settled in an earlier, interrupted pass`,
        },
      ],
    };
  }

  it("under --bots-only, leaves a replied HUMAN thread open — the deliberate state, not a leak", async () => {
    // `/jig:resolve-review-comments` § Human threads makes "a human thread you replied to
    // but chose not to close on the author's behalf" the one sanctioned
    // exception to "every comment you act on ends resolved", and says that
    // exception is WHY continuous mode targets bot threads. This sweep runs
    // unattended, so it is exactly the act that rule governs: a `**rejected**`
    // reply plus a still-open thread IS the exception, and resolving it here
    // would use the author's own triage as the warrant for overriding their
    // choice.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bots-only"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("without --bots-only, still reconciles a replied human thread — the human-attended scope", async () => {
    // The other half of the same boundary, and the reason the fix is a
    // forwarded flag rather than a blanket exclusion: an unscoped one-shot is
    // the human-attended run AGENTS.md assigns the wider scope to, so the
    // merit outcome still resolves there. Human-ATTENDED is the whole test —
    // a scheduled --all-open sweep is not, and passes --bots-only like the
    // gate does.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual(["PRRT_human"]);
  });

  it("an UNATTENDED drive sweeps bot-only even when counting human threads", async () => {
    // `drive.ts` is the unattended runner, and it accepts `--bots-only` as
    // optional — so a drive started without it ran an UNSCOPED sweep every
    // round, resolving human threads with nobody watching. That is the act
    // `/jig:resolve-review-comments` § Human threads reserves, and it does not become
    // permissible because the operator also wanted human threads COUNTED.
    //
    // `$DRIVE_PR_TARGET` exists exactly when drive.ts spawned this gate, which
    // is the signal used. Note the two scopes now differ — human threads are
    // still counted — and only in the safe direction: the sweep is narrower
    // than the count, so an unattended drive simply cannot converge over a
    // replied human thread, which is the correct outcome.
    // The reviewer run is present (no `checkRuns` override) so the evaluation
    // reaches the thread ENUMERATION — the stuck-gate fixtures used elsewhere
    // in this block return before counting anything, which would make the
    // second assertion vacuous.
    const { dir, stateDir } = writeFixture({
      threads: [humanRepliedThread("PRRT_human_unattended", "**rejected**")],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], {
      reconcile: true,
      env: { DRIVE_PR_TARGET: "999" },
    });

    expect(r.exitCode).toBe(0);
    expect(resolvedIn(dir)).toEqual([]);
    // Still COUNTED — the narrowing is of the sweep, not of convergence.
    expect((r.json.work as Record<string, unknown>).unresolvedThreads).toBe(1);
  });

  it("a FAILING sweep is reported, and changes nothing about a RE-ARMING verdict", async () => {
    // A reconciliation error means some already-answered thread is still
    // unresolved on GitHub — a thing to report, never a reason to refuse a
    // round this gate can otherwise judge. Modelled with the resolve mutation
    // itself failing, which is what the sweep exits non-zero over.
    //
    // RE-ARMING is the load-bearing half, and the boundary the next test
    // draws: `4` comes back, so the next pass sweeps again and a failure here
    // costs nothing durable. The verdicts that do NOT come back are gated.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_sweep_fails", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("reconciliation sweep");
    // The report is still the gate's own, on stdout, uncorrupted by the
    // sweep's NDJSON — which is why that output is re-emitted on stderr.
    expect(r.json.state).toBe("AWAITING_REVIEWER");
  });

  it("a FAILING sweep BLOCKS a verdict that ends the drive", async () => {
    // The other half of the boundary, and the generalisation of the liveness
    // degrade: `drive.ts` does not re-arm on 8/9/10, so after one of those no
    // later pass is promised — and a thread the sweep failed to resolve would
    // stay open with nothing left to retry it. That is the leak
    // rebuilt one level up, and two independent reviewers found it in the same
    // round.
    //
    // Same fixture as the test above except for the verdict it reaches: the
    // reviewer run is present (so the evaluation gets past AWAITING_REVIEWER)
    // and the thread is parked, so it evaluates to HITL_PARKED. Reading 1
    // rather than 8 is therefore evidence about the gate, not about the
    // fixture being unable to reach a terminal state.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_sweep_fails_terminal", "**rejected**")],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    await park(stateDir, "PRRT_sweep_fails_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("a FAILING sweep blocks REVIEWER_FAILED too — the set is drive.ts’s stopping codes", async () => {
    // 7 was missed on the first cut of the guard because that cut reasoned
    // from "terminal states" rather than from `drive.ts`'s own default branch,
    // which returns 7 alongside 8/9/10. Same consequence: the drive ends, so
    // nothing retries the sweep.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reviewer_failed", "**rejected**")],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }, DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("--no-reconcile cannot certify a verdict that ends the drive", async () => {
    // Opting out suppresses the sweep; it must not also VOUCH for one. Folding
    // the flag into "reconciliation succeeded" made a drive-ending verdict
    // reachable with nothing swept — the stranding this guard exists to stop,
    // available by flag. The flag still works for
    // every other verdict: the `--no-reconcile opts out explicitly` probe
    // above reaches 4 with it, unchanged.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_optout_terminal", "**rejected**")],
    });
    await park(stateDir, "PRRT_optout_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--no-reconcile");
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-count cannot certify a verdict that ends the drive either", async () => {
    // `--no-count` was exempted on the reasoning that it marks a mid-round
    // re-read, so the pass entry above it already swept. That holds only if
    // the entry swept SUCCESSFULLY — and a counting pass deliberately returns
    // ROUND_READY over a FAILED sweep, so a re-read inside exactly that round
    // would certify a drive-ending verdict for a sweep that never succeeded.
    //
    // The exemption is gone rather than narrowed: `sweepReconciled` is set by
    // one thing only, a sweep that ran and exited 0. Both flags therefore fail
    // closed here for the same reason, without either being special-cased —
    // which is the point, since this guard shipped one hole per round while it
    // was built by exempting signals one at a time.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_nocount_terminal", "**rejected**")],
    });
    await park(stateDir, "PRRT_nocount_terminal", "thread");
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--no-count");
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-count still certifies CONVERGED — announce-merge-ready.ts’s own re-read depends on it", async () => {
    // CONVERGED has its own narrower gate (drive-status.ts, next to
    // UNRECONCILED_STOPPERS) rather than blanket membership in that set,
    // because a first cut of this fix DID add it blanket and broke exactly
    // this: `announce-merge-ready.ts` calls this script with `--no-count`
    // (SKILL.md §§ 3 and 6) specifically to check CONVERGED without spending
    // a round, and CONVERGED is the only verdict that caller ever acts on.
    // `--no-count` suppresses the sweep every time, so `sweepReconciled` can
    // never be true on that call — folding CONVERGED into the blanket set
    // made it permanently unreachable through the one path built to reach it
    // without a sweep. The `announce-merge-ready.ts` describe block's own
    // tests caught it: most of the block failed, each expecting a real exit
    // code and getting `1` instead. This is the regression test for that: an
    // otherwise textbook-CONVERGED fixture must still read CONVERGED under
    // `--no-count`, unaffected by this guard.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("--no-reconcile still certifies CONVERGED too — the same exemption, the other flag", async () => {
    // The sibling of the probe above: `--no-reconcile` suppresses the sweep
    // the same way `--no-count` does (`sweepSuppressed = noCount ||
    // noReconcile`), so it must leave CONVERGED reachable for the same
    // reason, even though nothing in this skill actually calls it with
    // `--no-reconcile` today — the guard does not get to special-case one
    // suppressing flag over the other.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("a sweep that actually RUNS and FAILS degrades an otherwise-CONVERGED PR to INDETERMINATE", async () => {
    // Mutation-tests `convergedUnswept` itself, which neither probe above
    // does: both suppress the sweep via a flag, so `sweepRanAndFailed` can
    // never be true on either call and deleting the guard entirely would
    // leave both green. This fixture is the
    // other half — a COUNTING pass (no `--no-count`/`--no-reconcile`) where
    // the sweep subprocess genuinely spawns and exits nonzero, on a PR that
    // otherwise evaluates to zero unresolved threads. `evaluate()` on its
    // own would call that CONVERGED; the guard must withhold it instead.
    //
    // `sweepThreadListingFailsOnce` fails the sweep's OWN thread-listing call
    // (graphql call #1 of the whole invocation — the sweep always runs before
    // `evaluate()` does) while leaving `evaluate()`'s later, independent
    // listing (call #2) to succeed and see the `threads: []` fixture as
    // genuinely empty — exactly the "resolved on GitHub, but this pass's own
    // sweep could not certify it" shape `convergedUnswept`'s own comment
    // describes, without hand-rolling the full stale-held-cleanup scenario
    // that is only ONE of several ways the sweep can fail nonzero.
    const { dir, stateDir } = writeFixture({
      threads: [],
      reviewedSha: HEAD,
      sweepThreadListingFailsOnce: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("reconciliation sweep");
    expect(r.stderr).toContain("exited");
  });

  // NOT COVERED HERE, and deliberately: a first cut of this fix's own gate
  // used `!sweepSuppressed && !sweepReconciled` for "the sweep ran and
  // failed", which is also true whenever the sweep never got a turn at all —
  // the loop-top spent-budget skip and the "liveness read just spent the
  // budget" skip both leave `sweepSuppressed` false too, since neither
  // `--no-count` nor `--no-reconcile` was passed. That produced a false
  // INDETERMINATE on a genuinely converged PR whose sweep was merely SKIPPED,
  // which is why `sweepRanAndFailed` below is a
  // dedicated flag set at exactly one call site — immediately after the
  // sweep subprocess itself exits nonzero — and nowhere else, including
  // neither skip branch. A black-box probe for the skip side of that
  // distinction needs `budgetLeftMs() <= 0` on the very first iteration, but
  // both `--timeout` and `--interval` are floored at `MIN_INTERVAL` (5s) by
  // the CLI's own validation, and the one call whose OWN kill-timeout could
  // be raced against that budget (`ghCall`'s liveness read, a few lines
  // above `sweepRanAndFailed`'s call site) clamps its `timeoutSec` to
  // `budgetLeftMs()` itself — so hanging it via `DRIVE_PR_STUB_HANG` either
  // finishes under the clamp (budget still positive, skip never fires) or
  // gets killed BY the clamp (a genuinely unreadable read, a different
  // branch entirely). There is no window to land the hang exactly on the
  // budget boundary without a wall-clock race this suite's existing hang
  // mechanism cannot avoid, so this fix's skip-path correctness rests on
  // `sweepRanAndFailed` having exactly one set site — reviewed, not
  // black-box tested.

  it("a failing sweep is re-attempted on EVERY poll, not a bounded few", async () => {
    // The docs say the sweep is re-attempted on each poll, which is what makes
    // a `4` returned after the whole `--timeout` window mean something. A
    // MAX_QUERY_ERRORS cap made that false after three attempts, leaving the
    // loop still polling but no longer trying to fix what it was waiting on —
    // so a transient helper failure that cleared mid-window was never retried.
    //
    // Counted via the sweep's OWN liveness probe (`--json state`, that field
    // alone), which is one per attempt. `4` is the verdict throughout, so this
    // measures the retry rather than any degrade path.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_retry_forever", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    writeFileSync(join(dir, "resolve-thread-fails"), "");
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      // This probe needs strictly more than MAX_QUERY_ERRORS attempts, so the
      // window must hold at least three polls even when each iteration's
      // spawns take seconds: 1s polls (the `--interval` floor lowered through
      // its test pacing seam) in an 8s window.
      ["--timeout", "8", "--interval", "1"],
      {
        reconcile: true,
        once: false,
        env: { DRIVE_PR_STATUS_MIN_INTERVAL: "1" },
      },
    );

    expect(r.exitCode).toBe(4);
    const attempts = Number.parseInt(
      readFileSync(join(dir, "live-probes"), "utf8"),
      10,
    );
    // Strictly more than the old cap — the assertion is "it did not stop at
    // three", not an exact count, which would pin poll timing rather than the
    // behaviour.
    expect(attempts).toBeGreaterThan(3);
    // Explicit per-test budget, far above the suite's 30s default: this
    // probe is the most expensive one in the file under load.
    //
    // Its logic is only ~8s (`--timeout 8`, and the run ends with the gate's
    // own "gave up after 8s"). The rest is subprocess fan-out: >
    // MAX_QUERY_ERRORS poll iterations is the irreducible floor for the
    // assertion below, and EACH iteration spawns a real sweep —
    // `reconcile-replied-threads.ts`, which spawns `list-unresolved-threads.ts`,
    // `resolve-thread.ts` and `summary-findings.ts` — on top of `evaluate()`'s
    // own helper spawns.
    //
    // Kept at that price because the property is a twice-reported defect
    // and nothing
    // cheaper distinguishes "retried on every poll" from the capped variant
    // that shipped and had to be removed. But it IS the concrete instance of
    // what lefthook.yml's own timeout comment warns about — "growth past this
    // is a signal to make the suite cheaper (the probes each spawn a real
    // drive-status.ts), not to bump again" — so it is the first thing to
    // reach for if this suite needs to get cheaper.
  }, 300_000);

  it("a REOPENED PR retracts the finished-skip and sweeps before ROUND_READY", async () => {
    // The liveness probe skips the sweep on a positively-finished PR, which is
    // correct — until the evaluation, an independent later snapshot,
    // disagrees. GitHub permits a closed PR to be reopened, and the stopper
    // guard alone did not cover it: `sweepReconciled` stayed false but exit 0
    // is not a stopper, so a reopened PR was handed a ROUND_READY that never
    // swept — contradicting this gate's own contract that reconciliation
    // happens before any verdict at all.
    //
    // Modelled with the probe's `--json state` read answering CLOSED once and
    // every later read answering OPEN, which is exactly the reopen window.
    //
    // POLLING mode, because retracting means re-running `evaluate()` and
    // `--once` is a promise to evaluate once — under it the gate defers to the
    // caller's next invocation instead (see the sibling probe below). This is
    // the mode where the retraction actually runs.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reopened", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeSaysClosedOnce: true,
    });
    // The retraction takes one iteration: the branch `continue`s WITHOUT
    // sleeping, so the second iteration's sweep happens immediately. An
    // `--interval` as long as the whole `--timeout` never fits after that, so
    // the ordinary `case 4` afterwards gives up instead of sleeping, while the
    // 6s window still leaves the first iteration seconds to spare under load.
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "6", "--interval", "6"],
      { reconcile: true, once: false },
    );

    // The verdict is the ordinary one for this fixture — the retraction is
    // about WHAT RAN, not about degrading the answer.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("retracting the skip");
    // The load-bearing assertion: the thread got reconciled anyway.
    expect(resolvedIn(dir)).toEqual(["PRRT_reopened"]);
  }, 120_000);

  it("a PERSISTENT finished/open disagreement terminates INDETERMINATE, never unswept", async () => {
    // The retraction `continue`s past the verdict switch, where every budget
    // in this loop lives, and two earlier bounds for it were wrong in opposite
    // directions: a bare flag was no bound (the next iteration's read set it
    // again, looping forever, `--once` included), and a one-shot latch bounded
    // the loop but let a SECOND disagreement through unswept — reopening the
    // hole the branch exists to close.
    //
    // This fixture is the one that actually reaches the branch repeatedly: the
    // single-field probe says CLOSED on every call while the fuller snapshot
    // keeps reporting the PR open. An earlier version of this probe used an
    // UNREADABLE snapshot instead, which made `evaluate()` return 1 — and
    // production requires `code !== 1` to enter the retraction at all, so it
    // was asserting ordinary `case 1` termination and would have stayed green
    // against exactly the loop it claimed to guard.
    //
    // Both failure modes are covered by the two assertions together:
    // terminating at all rules out the loop, and INDETERMINATE rather than a
    // verdict rules out the unswept-ROUND_READY the latch permitted.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_retract_loop", "**rejected**")],
      liveProbeSaysClosedAlways: true,
    });
    // POLLING mode, not `--once`: under `--once` the first disagreement degrades
    // before the retraction counter advances, so a `--once` run passes with the
    // retraction bound deleted.
    // `--timeout 5 --interval 5` leaves no room for a second poll, so the run
    // ends without sleeping once the retractions are spent.
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "5", "--interval", "5"],
      { reconcile: true, once: false },
    );

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    // Never swept, so never resolved — and, crucially, never judged either.
    expect(resolvedIn(dir)).toEqual([]);
    // The bound itself, pinned to the path that enforces it rather than to a
    // range the poll deadline could also land in: the initial probe plus
    // exactly one per permitted retraction (the retraction budget is
    // MAX_QUERY_ERRORS = 3), the three retraction notices, and the degrade
    // reason only the exhausted-budget branch emits. Were the count bound
    // removed the loop would spin until the deadline instead — many more
    // probes, and no such reason.
    const attempts = Number(readFileSync(join(dir, "live-probes"), "utf8"));
    expect(attempts).toBe(1 + 3);
    expect(r.stderr.split("retracting the skip").length - 1).toBe(3);
    expect(r.stderr).toContain("disagree persistently");
  });

  it("--once does not retract — it evaluates once and defers", async () => {
    // The retraction is the only path in this loop that re-runs `evaluate()`
    // without sleeping, so it was quietly breaking `--once`'s promise to
    // evaluate once. Under `--once` the same
    // disagreement degrades on the FIRST occurrence instead, which is the
    // answer this gate gives everywhere else in that mode: the caller comes
    // back, and its next pass entry sweeps.
    //
    // Same fixture as the polling reopen probe above; only the mode differs,
    // so the two together pin the mode-dependent behaviour rather than one
    // pinning an accident of the other's flags.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_once_no_retract", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeSaysClosedOnce: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("degrade() stops at the poll DEADLINE, not only at the retry count", async () => {
    // `degrade()` bounded retries by count alone, and it is reached from paths
    // that did not exist when the loop's only deadline check was placed down
    // in `case 4` — so it overran `--timeout`: with `--timeout 5 --interval 5`
    // an unreadable liveness probe slept twice and returned after 10s+.
    //
    // Asserted by ATTEMPT COUNT rather than elapsed time, which would pin the
    // machine rather than the bound: one interval already exhausts this
    // deadline, so exactly one attempt may run. The count-only bound would
    // allow MAX_QUERY_ERRORS of them.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_deadline", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      liveProbeFails: true,
    });
    const r = await probeIn(
      dir,
      stateDir,
      HEAD,
      ["--timeout", "5", "--interval", "5"],
      { reconcile: true, once: false },
    );

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(dir, "live-probes"), "utf8")).toBe("1");
  });

  it("an UNRECOGNISED state is unreadable, not a confirmed finished PR", async () => {
    // The skip used to fire on "not exactly OPEN", so a malformed `-q` result
    // or a state GitHub adds later would suppress the sweep and then license a
    // verdict that ends the drive. Only CLOSED and MERGED positively mean
    // finished; everything else takes the retry path.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_weird_state", "**rejected**")],
      prState: "UNKNOWN",
    });
    await park(stateDir, "PRRT_weird_state", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("does not sweep on a --no-count re-read — one sweep per pass, not per status read", async () => {
    // SKILL.md §§ 3 and 6 both re-read the gate mid-round with --no-count, as
    // does announce-merge-ready.ts. Those are re-reads inside a round whose
    // entry already swept; re-sweeping on each would multiply the sweep by
    // however many times a pass consults the gate.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_reread", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-count"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("--no-reconcile opts out explicitly", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_optout", "**rejected**")],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--no-reconcile"], {
      reconcile: true,
    });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("leaves an ordinary unanswered thread alone — no reply, nothing to reconcile", async () => {
    // The sweep is scoped to threads that ALREADY carry a trusted outcome
    // token. Running it on every pass must not touch live work, or the gate
    // would be resolving findings nobody triaged.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_live", path: "a.ts", bot: true }],
      checkRuns: [DORMANT_ARM],
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.exitCode).toBe(4);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });

  it("does NOT sweep a MERGED PR — liveness is read ahead of the mutation", async () => {
    // "A merged or closed PR stops the loop before the round spends anything"
    // is SKILL.md § 1's opening contract, and the sweep is a MUTATION: it
    // resolves threads and writes unconfirmed holds. Placing it ahead of
    // `evaluate()` — which is the only thing that reads liveness — made those
    // mutations land on a finished pull request before the gate ever returned
    // PR_NOT_OPEN. The same fixture that resolves on every stuck-but-open
    // verdict above must resolve NOTHING here, which is what separates a
    // liveness guard from the sweep simply not running.
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_merged", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      prState: "MERGED",
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });

  it("an unreadable liveness probe cannot hand back a NON-RE-ARMING verdict", async () => {
    // The reachable path a silent fail-closed skip opened, and the reason the
    // probe sits inside the loop rather than above it. HITL_PARKED (8) is one
    // of the verdicts that do not re-arm — SKILL.md § Guardrails: "never
    // re-arm on HITL_PARKED" — so a pass that skipped the sweep on a
    // transient blip and then returned it would strand the reply forever,
    // rebuilding the exact an earlier change leak the sweep closes, with nothing left
    // to retry it.
    //
    // The fixture is the discriminating one: ONLY the probe fails, so the
    // evaluation below it succeeds and WOULD reach 8. Reading 1 instead is
    // therefore evidence about the degrade, not about `gh` being broken —
    // `transientMergeabilityFailure` (the next test) cannot say that, since
    // its evaluation fails too.
    const { dir, stateDir } = writeFixture({
      // No `checkRuns` override, so the reviewer run is present and completed
      // on this head — which is what lets the evaluation below actually REACH
      // HITL_PARKED. With the degrade removed this probe reports 8; the whole
      // assertion is that it reports 1 instead.
      threads: [repliedThread("PRRT_stranded", "**rejected**")],
      liveProbeFails: true,
    });
    await park(stateDir, "PRRT_stranded", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("does NOT sweep when liveness is UNREADABLE — the guard fails closed", async () => {
    // The failure direction matters as much as the merged one. Skipping a
    // sweep costs a deferral to the next pass entry — every action it takes is
    // idempotent and re-derived from GitHub — while sweeping a PR that may
    // already be finished costs a mutation nothing undoes. So an unreadable
    // `state` suppresses the sweep rather than being read as "probably still
    // open".
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_unreadable", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      transientMergeabilityFailure: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });
});
