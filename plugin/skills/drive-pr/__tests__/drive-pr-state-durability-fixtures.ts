import { existsSync, mkdtempSync, realpathSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import {
  SCRIPTS,
  tmpRoot,
  suiteHome,
  gitCleanEnv,
  makeScratchRepo,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export function createStateDurabilityFixtures() {
  function stateDirFor(name: string): string {
    const d = mkdtempSync(join(tmpdir(), `drive-state-${name}-`));
    return d;
  }

  async function state(
    dir: string,
    args: string[],
    env: Record<string, string> = {},
    stdin?: string,
  ) {
    // gitCleanEnv(), not process.env: resolveActor() runs `git rev-parse` in
    // this child, so an inherited GIT_DIR/GIT_COMMON_DIR (a suite invoked
    // from a git hook, per this file's own gitCleanEnv doc comment) would
    // make it resolve a DIFFERENT actor than the module-level ACTOR the
    // tree-lease tests assert against — reading their own assertions as
    // passing or failing for the wrong reason rather than the one under test.
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: dir, ...env },
        stdin: stdin !== undefined ? "pipe" : undefined,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), stderr, exitCode };
  }

  /**
   * A directory as git's `--show-toplevel` spells it, and as the product prints
   * it: symlinks and 8.3 short names resolved, forward slashes.
   */
  const gitPathOf = (p: string): string =>
    realpathSync.native(p).replaceAll("\\", "/");

  /**
   * Two linked worktrees of one clone, therefore ONE shared drive state — the
   * Conductor topology, and the only way to exercise the actor derivation
   * rather than a stand-in for it (it is deliberately not overridable; see
   * lib/state/actor.ts). Shared by the two blocks that need a SECOND actor:
   * per-hold push provenance and the session lease,
   * whose whole contract is that it separates sessions WITHOUT disturbing the
   * cross-worktree case this builds.
   */
  function twoDrivers(name: string): {
    a: string;
    b: string;
    env: Record<string, string>;
  } {
    const { dir } = makeScratchRepo(name);
    const b = join(tmpRoot, `${name}-driver-b`);
    const env = gitCleanEnv();
    const added = Bun.spawnSync(
      ["git", "worktree", "add", "-q", "-b", `${name}-b`, b],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    // Checked, not assumed: a failed `worktree add` leaves `b` absent, every
    // `drive` call from it runs in the enclosing directory instead, and both
    // "drivers" resolve to ONE actor — under which the cross-driver probes
    // would pass by never reproducing the scenario at all.
    if (added.exitCode !== 0) {
      throw new Error(
        `git worktree add failed for ${name}: ${added.stderr.toString()}`,
      );
    }
    // Both session variables PINNED EMPTY, so the returned env is ladder tier 3
    // — no lease claimed, nothing refused — unless a caller opts back in by
    // setting `DRIVE_PR_SESSION` itself (which takes precedence over
    // `$CLAUDE_PID` anyway, so the lease probes below are unaffected).
    //
    // Not a convenience. `gitCleanEnv` copies the ambient environment, which
    // under a Claude Code harness carries `$CLAUDE_PID` — so these probes
    // would inherit a session identity locally and none in CI, and under the
    // PR-wide admission gate that difference decides whether a second worktree
    // is admitted at all. A probe whose subject changes with the harness that
    // runs it is a probe that proves whatever the machine felt like proving.
    // Windows' home directory is USERPROFILE, not HOME.
    return {
      a: dir,
      b,
      env: {
        ...env,
        DRIVE_PR_SESSION: "",
        CLAUDE_PID: "",
        USERPROFILE: suiteHome,
      },
    };
  }

  /**
   * `drive-state.ts` from a NAMED working tree, with the environment supplied
   * whole. $DRIVE_PR_STATE_DIR is deliberately left to the caller: the
   * cross-worktree probes unset it entirely, so that both worktrees land on
   * the same clone-wide state exactly as two Conductor worktrees driving one
   * PR do.
   */
  function drive(
    cwd: string,
    env: Record<string, string>,
    args: string[],
    stdin?: string,
  ) {
    const p = Bun.spawnSync(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
      {
        cwd,
        env,
        stdin: stdin === undefined ? undefined : Buffer.from(stdin),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: p.exitCode,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    };
  }

  /** A real, live pid that is NOT this process — killed when the test ends. */
  function liveSession(): { pid: number; stop: () => void } {
    const p = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return {
      pid: p.pid,
      stop: () => {
        try {
          p.kill();
        } catch {
          // Already gone — the probe under test may have outlived it.
        }
      },
    };
  }

  /**
   * Wait until `pid` genuinely stops answering.
   *
   * `kill()` is ASYNCHRONOUS, so every probe that kills a session and then
   * asserts takeover/expiry behaviour has to wait for the pid to actually go
   * — not for a fixed interval. A fixed sleep is a load-dependent flake in
   * the direction that hides bugs: the lease still reads as LIVE, so the
   * assertion measures the refusal path instead of the path under test.
   */
  async function awaitPidGone(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`pid ${pid} still answering after ${timeoutMs}ms`);
  }

  /**
   * Wait until `proc` reaches its in-locked-section signal — or fail with what
   * actually happened.
   *
   * The bare `while (!existsSync(signal))` this replaces has two failure modes
   * that look identical from the outside, and neither says anything useful. If
   * the subprocess dies BEFORE writing the signal — a usage error, an admission
   * refusal, a crash — the loop spins until bun's per-test budget kills the
   * whole file with SIGTERM (exit 143), which reads like a harness bug rather
   * than like the process that exited three seconds in. And a genuinely slow
   * start is indistinguishable from that while it is happening.
   *
   * So this races the signal against the process: whichever resolves first
   * decides, and an exit-first result throws with the child's own exit code and
   * stderr — the thing a reader of the failure actually needs.
   *
   * The TIMEOUT branch kills the child before throwing, and that is not
   * tidiness. Reaching it means the process is still running and still holding
   * whatever it holds — it can go on mutating the shared state directory that
   * the next probe in this file will build its own fixtures in, and it keeps
   * bun's test worker alive after the failure that abandoned it. Throwing while
   * leaving it there produces exactly the class of hang this helper exists to
   * diagnose, one level up. The exit branch
   * needs no kill: that process is already gone, which is what it reported.
   */
  async function awaitLockedSection(
    signal: string,
    proc: {
      exited: Promise<number>;
      stderr: ReadableStream;
      kill: (signal?: number) => void;
    },
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let exitCode: number | null = null;
    // Observed rather than awaited, so the poll below can see the exit without
    // ever blocking on a process that is (correctly) still running.
    void proc.exited.then((c) => {
      exitCode = c;
    });
    while (Date.now() < deadline) {
      if (existsSync(signal)) return;
      if (exitCode !== null) {
        // Read AFTER the exit, so the stream is complete rather than a
        // snapshot of whatever had been flushed by the time we noticed.
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `subprocess exited ${exitCode} before reaching its locked section:\n${stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    // ESCALATING and BOUNDED at every step. `kill` only delivers a signal, so
    // the wait for the exit has to be here — but an UNBOUNDED wait reintroduces
    // the hang one layer down: a child that ignores SIGTERM, or wedges during
    // shutdown, leaves this promise unsettled and takes the whole test worker
    // with it, which is the exact failure this helper exists to convert into a
    // diagnosis. So each wait has a deadline, SIGTERM
    // escalates to SIGKILL, and the throw happens either way — reporting which
    // of the two it took, because "did not die even to SIGKILL" means something
    // very different (an uninterruptible wait, a zombie) than a slow shutdown.
    const exitedWithin = (ms: number): Promise<boolean> =>
      Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
      ]);
    const signalIt = (sig?: number) => {
      try {
        proc.kill(sig);
      } catch {
        // Already gone between the last poll and here — the only thing the
        // kill was for. Swallowed so the throw below stays the diagnosis.
      }
    };
    signalIt();
    let reaped = await exitedWithin(2_000);
    if (!reaped) {
      signalIt(9);
      reaped = await exitedWithin(2_000);
    }
    throw new Error(
      `subprocess never reached its locked section within ${timeoutMs}ms (signal: ${signal}); ` +
        (reaped
          ? "it was killed"
          : "and it did NOT exit even after SIGKILL — it may still be touching the state directory"),
    );
  }
  return {
    stateDirFor,
    state,
    gitPathOf,
    twoDrivers,
    drive,
    liveSession,
    awaitPidGone,
    awaitLockedSection,
  };
}
