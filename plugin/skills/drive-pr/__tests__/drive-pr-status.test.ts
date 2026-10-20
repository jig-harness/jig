/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { afterAll, describe, expect, it } from "bun:test";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join, delimiter } from "node:path";

import { leasePathFor } from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  HEAD,
  REVIEWER_RUN,
  DORMANT_ARM,
  stickyBody,
  binDir,
  writeFixture,
  probeIn,
  probe,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";

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
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
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
        scriptArgv(
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--head",
          HEAD,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
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
            DRIVE_PR_STATE_DIR: stateDir,
            DRIVE_PR_SESSION: String(holder.pid),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(seed.exitCode).toBe(0);

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--head",
          HEAD,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
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
      expect(stderr).toContain(
        // Windows has no ps; the refusal names its own process probe there.
        byPlatform("Windows has no ps", {
          windows: `powershell.exe -NoProfile -Command "Get-Process -Id ${holder.pid}"`,
          posix: `ps -p ${holder.pid}`,
        }),
      );
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
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_SESSION: String(process.pid),
      };
      delete (env as Record<string, string | undefined>).DRIVE_PR_TARGET;

      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--json",
          "--once",
          "--no-count",
          "--bump-attempt",
          "--head",
          HEAD,
        ),
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
      expect(stderr).toContain(
        // Windows has no ps; the refusal names its own process probe there.
        byPlatform("Windows has no ps", {
          windows: `powershell.exe -NoProfile -Command "Get-Process -Id ${holder.pid}"`,
          posix: `ps -p ${holder.pid}`,
        }),
      );
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

  describe("a repository that names no AI reviewer", () => {
    const scratchDirs: string[] = [];
    afterAll(() => {
      for (const dir of scratchDirs)
        rmSync(dir, { recursive: true, force: true });
    });

    // The suite's overlay minus `review.reviewer_app`: no app and no check
    // pattern, so the drive has no reviewer to wait on. `bots` replaces
    // `review.bots`, which alone must not make a reviewer expected.
    function noReviewerEnv(bots?: string[]): Record<string, string> {
      const source = readFileSync(
        join(import.meta.dir, "fixtures", "overlay.yaml"),
        "utf8",
      );
      const text = source
        .split("\n")
        .filter((line) => !line.includes("reviewer_app"))
        .map((line) =>
          bots !== undefined && line.trimStart().startsWith("bots:")
            ? `  bots: ${JSON.stringify(bots)}`
            : line,
        )
        .join("\n");
      const dir = mkdtempSync(join(tmpdir(), "drive-no-reviewer-"));
      scratchDirs.push(dir);
      const path = join(dir, "overlay.yaml");
      writeFileSync(path, text);
      return { JIG_OVERLAY: path };
    }

    // A reviewer sticky whose backlog blob cannot be decoded: reading it as
    // reviewer protocol evidence makes the summary enumeration fail closed.
    const unreadableSticky = `${stickyBody({ backlog: false })}\n<!-- ai-review-backlog: bm90IGpzb24= -->`;

    it("CONVERGED on zero threads and green CI, with no reviewer check or stamp", async () => {
      const r = await probe(
        { threads: [], checkRuns: [], reviewedSha: null },
        [],
        { env: noReviewerEnv() },
      );
      expect(r.state).toBe("CONVERGED");
      expect(r.json.ci).toBe("green");
      expect(String(r.json.reason)).toContain("no AI reviewer is configured");
    });

    it("reads no sticky from a review.bots login, so an undecodable one does not stop convergence", async () => {
      const fixture = {
        threads: [],
        reviewedSha: null,
        decoyReviewerComments: [unreadableSticky],
      };
      const named = await probe(fixture);
      expect(named.state).toBe("INDETERMINATE");
      const r = await probe({ ...fixture, checkRuns: [] }, [], {
        env: noReviewerEnv(["example-review[bot]"]),
      });
      expect(r.state).toBe("CONVERGED");
      expect((r.json.work as Record<string, unknown>).summaryFindings).toBe(0);
    });

    it("summary-findings.ts still reads a review.bots sticky unless the drive's flag is passed", async () => {
      // The standalone resolver runs the enumerator without the flag, and its
      // minimal configuration declares `review.bots` alone.
      const { dir } = writeFixture({
        threads: [],
        reviewedSha: null,
        decoyReviewerComments: [unreadableSticky],
      });
      const enumerate = (flags: string[]) => {
        const r = Bun.spawnSync(
          scriptArgv(
            join(SCRIPTS, "summary-findings.ts"),
            "999",
            "--json",
            ...flags,
          ),
          {
            env: {
              ...process.env,
              PATH: `${binDir}${delimiter}${process.env.PATH}`,
              DRIVE_PR_FIXTURES: dir,
              ...noReviewerEnv(["example-review[bot]"]),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return {
          exitCode: r.exitCode,
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
        };
      };
      const standalone = enumerate([]);
      expectSpawnExit(standalone, 1, "standalone reads the bot's sticky");
      const drive = enumerate(["--configured-reviewer-only"]);
      expectSpawnExit(drive, 0, "the drive reads no sticky");
      expect(JSON.parse(drive.stdout).total).toBe(0);
    });

    it("summary-findings.ts reads no PR comments for the drive when no reviewer is named", async () => {
      // A `gh` that always fails: any read of the PR's comments is an error.
      const failingBin = mkdtempSync(join(tmpdir(), "drive-no-gh-"));
      scratchDirs.push(failingBin);
      writeFakeProgram(join(failingBin, "gh"), "#!/bin/sh\nexit 1\n");
      const enumerate = (flags: string[]) => {
        const r = Bun.spawnSync(
          scriptArgv(
            join(SCRIPTS, "summary-findings.ts"),
            "999",
            "--json",
            ...flags,
          ),
          {
            env: {
              ...process.env,
              PATH: `${failingBin}${delimiter}${process.env.PATH}`,
              JIG_GH_CACHE: "off",
              ...noReviewerEnv(),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return {
          exitCode: r.exitCode,
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
        };
      };
      expectSpawnExit(enumerate([]), 1, "standalone reads the comments");
      const drive = enumerate(["--configured-reviewer-only"]);
      expectSpawnExit(drive, 0, "the drive reads nothing");
      expect(JSON.parse(drive.stdout).total).toBe(0);
    });

    it("ignores a reviewer-shaped check, which is an ordinary check here", async () => {
      const r = await probe(
        {
          threads: [],
          checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }],
        },
        [],
        { env: noReviewerEnv() },
      );
      expect(r.state).toBe("CONVERGED");
      expect(r.json.ci).not.toBe("green");
    });

    it("ROUND_READY on unresolved threads", async () => {
      const r = await probe(
        {
          threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
          checkRuns: [],
        },
        [],
        { env: noReviewerEnv() },
      );
      expect(r.state).toBe("ROUND_READY");
    });

    it("the same fixture still waits for the reviewer when one is named", async () => {
      const r = await probe({ threads: [], checkRuns: [] });
      expect(r.state).toBe("AWAITING_REVIEWER");
    });
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
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
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
