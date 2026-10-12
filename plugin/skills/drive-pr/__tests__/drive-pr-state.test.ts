/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ExitError } from "../scripts/lib/cli";
import { pidCheckCommand } from "../scripts/lib/proc";
import { resolveActor } from "../scripts/lib/state/actor";
import {
  claimCreate,
  claimPathFor,
  newClaimToken,
} from "../scripts/lib/state/claims";
import { cloneKey } from "../scripts/lib/state/clone-key";
import {
  assertLeaseUnchanged,
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
  clearAllLeases,
  leaseFilesFor,
  leasePathFor,
  prRemoteMutationLockPathFor,
  readLease,
  readTreeLease,
  type Session,
  treeLeasePathFor,
} from "../scripts/lib/state/lease";
import { createLock } from "../scripts/lib/state/lock";
import { reflectDepthPastLast } from "../scripts/lib/state/schema";
import { defaultStateDirFor } from "../scripts/lib/state/store";

import {
  SCRIPTS,
  ACTOR,
  OLDER_SESSION_TOKEN,
  NEWER_SESSION_TOKEN,
  STALE_LASTSEEN,
  HELD_PUSH,
  tmpRoot,
  suiteHome,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

describe("drive-state.ts durability", () => {
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
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: dir, ...env },
      stdin: stdin !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
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
    // inherited a session identity locally and none in CI, and after an earlier change's
    // PR-wide admission gate that difference decides whether a second worktree
    // is admitted at all. A probe whose subject changes with the harness that
    // runs it is a probe that proves whatever the machine felt like proving.
    return { a: dir, b, env: { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" } };
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
    const p = Bun.spawnSync([join(SCRIPTS, "drive-state.ts"), ...args], {
      cwd,
      env,
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
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

  describe("the /reflect duty tracks two counters, not one", () => {
    // `rounds` is cumulative; `attempts` resets to 1 on every new head. A
    // single stamp is wrong in BOTH directions: stamping `.rounds` alone
    // re-armed the duty immediately after a reflect discharged at attempt
    // depth, and stamping `max(rounds, attempts)` suppressed it for the next
    // several genuine rounds. The PRODUCTION predicate, not a restatement of it
    // — a copy here would pass while both consumers used something else.
    async function due(dir: string): Promise<boolean> {
      const r = await state(dir, ["get", "999"]);
      return reflectDepthPastLast(JSON.parse(r.stdout)) > 3;
    }

    it("a counter that is not a number ARMS the duty, it does not disarm it", () => {
      // `{"rounds":"x"}` PARSES, so no consumer's `catch` runs; the subtraction
      // yields NaN and every `depth > threshold` comparison is then false — the
      // duty silently OFF on the one input that cannot be trusted, against the
      // documented fail-open. The guard lives in the
      // shared predicate so both consumers get the same answer.
      expect(
        reflectDepthPastLast({ rounds: "x" } as unknown as { rounds?: number }),
      ).toBe(Number.POSITIVE_INFINITY);
      expect(
        reflectDepthPastLast({
          rounds: 9,
          lastReflectedAttempts: "y",
        } as unknown as { rounds?: number }),
      ).toBe(Number.POSITIVE_INFINITY);
      // A trustworthy file still answers with its real depth.
      expect(reflectDepthPastLast({ rounds: 9, lastReflectedRound: 4 })).toBe(
        5,
      );
    });

    it("a reflect discharged at ATTEMPT depth does not re-arm on the next attempt", async () => {
      const d = stateDirFor("reflect-attempts");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      for (let i = 0; i < 8; i++) {
        await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      }
      expect(await due(d)).toBe(true); // 8 attempts, 0 stamped
      await state(d, ["set-reflected", "999"]);
      expect(await due(d)).toBe(false);

      // Three more passes on the same head: still discharged.
      for (let i = 0; i < 3; i++) {
        await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      }
      expect(await due(d)).toBe(false);
      // The fourth crosses the threshold again — the duty DOES re-arm.
      await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      expect(await due(d)).toBe(true);
    });

    it("a reflect discharged at ATTEMPT depth does not suppress the next rounds", async () => {
      // The `max(rounds, attempts)` stamp recorded 8 here, and the next seven
      // distinct heads all stayed under it — many real rounds with the duty
      // silently off.
      const d = stateDirFor("reflect-rounds");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      for (let i = 0; i < 8; i++) {
        await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      }
      await state(d, ["set-reflected", "999"]);

      // New heads bbb, ccc and ddd: rounds 2..4, `attempts` resetting to 1 on
      // each. (Naming them rather than counting them: a hand-written count
      // drifts from the loop, and this test is sensitive to exactly that
      // number.)
      for (const head of ["bbb", "ccc", "ddd"]) {
        await state(d, ["bump-round", "999", "--head", head]);
        await state(d, ["bump-attempt", "999", "--head", head]);
      }
      expect(await due(d)).toBe(false); // 3 rounds past — still under
      await state(d, ["bump-round", "999", "--head", "eee"]);
      expect(await due(d)).toBe(true); // 4 rounds past — armed
    });

    it("a head change REBASES the attempt baseline, so passes on the new head count", async () => {
      // The attempt axis does not survive the head change: a reflect recorded
      // at attempt 8, followed by a head where attempts restart at 1, left a
      // delta of -7 that the `max` prefers to ignore — so several real passes
      // on the new head produced no duty at all, and it did not re-arm until
      // attempt 12.
      const d = stateDirFor("reflect-rebase");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      for (let i = 0; i < 8; i++) {
        await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      }
      await state(d, ["set-reflected", "999"]);
      expect(await due(d)).toBe(false);

      // One new head, then four passes on it — real work, none of which the
      // rounds counter can see (it moves once per head).
      await state(d, ["bump-round", "999", "--head", "bbb"]);
      for (let i = 0; i < 4; i++) {
        await state(d, ["bump-attempt", "999", "--head", "bbb"]);
      }
      const s = JSON.parse((await state(d, ["get", "999"])).stdout);
      expect(s.attempts).toBe(4);
      expect(s.lastReflectedAttempts).toBe(0);
      expect(await due(d)).toBe(true);
    });

    it("set-reflected stamps both baselines", async () => {
      const d = stateDirFor("reflect-stamp");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      await state(d, ["bump-attempt", "999", "--head", "aaa"]);
      await state(d, ["set-reflected", "999"]);
      const s = JSON.parse((await state(d, ["get", "999"])).stdout);
      expect(s.lastReflectedRound).toBe(1);
      expect(s.lastReflectedAttempts).toBe(2);
    });
  });

  it("an ABSENT state file is a fresh drive, not an error", async () => {
    const d = stateDirFor("absent");
    const r = await state(d, ["rounds", "999"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("0");
  });

  it("a MALFORMED state file fails closed instead of resetting the drive", async () => {
    // The file is the ONLY record of the parked human decisions and the durable
    // round budget. Substituting fresh state silently grants a new budget and
    // re-arms work a human deliberately parked — the re-arm loop, reached by
    // the one path where the evidence it is happening has just been discarded.
    const d = stateDirFor("malformed");
    const f = join(d, "drive-pr-999.json");
    writeFileSync(f, '{"pr": 999, "rounds": 3, "parked": [{"key"');
    for (const cmd of [
      ["rounds", "999"],
      ["get", "999"],
      ["verified", "999"],
    ]) {
      const r = await state(d, cmd);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("not usable drive state");
    }
    // And it is PRESERVED for diagnosis, never truncated or replaced.
    expect(readFileSync(f, "utf8")).toBe(
      '{"pr": 999, "rounds": 3, "parked": [{"key"',
    );
  });

  it("rejects JSON with the wrong SHAPE, not merely bad syntax", async () => {
    // `{}` parses. Under a syntax-only predicate `.rounds` emitted `null`,
    // drive.ts coerced it to zero, and a resumed drive got a fresh round
    // budget with its parked decisions silently gone — the outcome the
    // fail-closed reader exists to refuse, reached by a file that parses.
    for (const body of [
      "{}",
      "[]",
      '"a string"',
      JSON.stringify({ pr: 999, rounds: 3 }),
      JSON.stringify({
        pr: 999,
        rounds: "3",
        lastCountedHead: "",
        verifiedSha: "",
        phase: "",
        parked: [],
      }),
      // Right shape, WRONG PR — a copied or mis-named file must not lend one
      // PR's round budget and parked set to another.
      JSON.stringify({
        pr: 111,
        rounds: 3,
        lastCountedHead: "",
        verifiedSha: "",
        phase: "",
        parked: [],
      }),
    ]) {
      const d = stateDirFor("shape");
      writeFileSync(join(d, "drive-pr-999.json"), body);
      const r = await state(d, ["rounds", "999"]);
      expect({ body, exit: r.exitCode }).toEqual({ body, exit: 3 });
      expect(r.stdout).not.toBe("0");
    }
  });

  it("rejects a parked ENTRY that is malformed, not just a malformed container", async () => {
    // The shape check used to stop at `.parked | type == "array"`, one level
    // short of the thing the array exists for. `{"parked":[{}]}` passed;
    // `parked-keys` then emitted the literal `null`, drive-status.ts matched it
    // against no thread id and no fingerprint, and the drive re-armed work a
    // human had parked — the re-arm loop, reached through the validator that
    // exists to protect the parked set.
    //
    // Each body below breaks exactly ONE field, so a probe cannot pass because
    // some neighbouring predicate happened to catch it.
    const base = {
      pr: 999,
      rounds: 3,
      lastCountedHead: "",
      verifiedSha: "",
      phase: "",
    };
    const good = {
      key: "PRRT_x",
      kind: "thread",
      reason: "needs a human",
      round: 1,
    };
    for (const entry of [
      {}, // the observed shape: no fields at all
      { ...good, key: undefined },
      { ...good, key: "" }, // an empty key is a match token that matches nothing
      { ...good, key: 42 },
      { ...good, kind: "other" }, // not one of the kinds `park` accepts
      { ...good, kind: undefined },
      { ...good, reason: undefined },
      { ...good, reason: "" }, // a park with no framed decision is a dropped finding
      { ...good, round: "1" },
      { ...good, round: undefined },
      "a string, not an object",
    ]) {
      const d = stateDirFor("parked-entry");
      const body = JSON.stringify({ ...base, parked: [entry] });
      writeFileSync(join(d, "drive-pr-999.json"), body);
      const r = await state(d, ["parked-keys", "999"]);
      expect({ body, exit: r.exitCode }).toEqual({ body, exit: 3 });
      // Specifically: it must never emit a key at all — `null` on stdout is the
      // exact output that let the parked item stop matching.
      expect(r.stdout).toBe("");
    }
  });

  it("accepts a well-formed parked entry", async () => {
    // The other half: the tightened predicate must still accept what `park`
    // itself writes, or every real drive with a parked item fails closed.
    const d = stateDirFor("parked-entry-ok");
    await state(d, [
      "park",
      "999",
      "--key",
      "PRRT_x",
      "--kind",
      "thread",
      "--reason",
      "needs a human",
    ]);
    const r = await state(d, ["parked-keys", "999"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("PRRT_x");
  });

  it("REFUSES a state file written before `attempts` and `held` existed", async () => {
    // This test used to assert the opposite, and the assertion was the defect:
    // tolerating an absent field meant one parser accepted both the old and the
    // new shape, which is the accepts-both tolerance the project defers
    // pre-GA.
    //
    // Refusing costs a `drive-state.ts reset` on a file that predates a field.
    // That is the sanctioned price — an explicit rejection a human clears,
    // rather than a silent dual-shape read whose two branches drift apart.
    const d = stateDirFor("legacy-shape");
    writeFileSync(
      join(d, "drive-pr-999.json"),
      JSON.stringify({
        pr: 999,
        rounds: 4,
        lastCountedHead: "abc",
        verifiedSha: "",
        phase: "",
        parked: [],
      }),
    );
    const r = await state(d, ["rounds", "999"]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("not usable drive state");
    // And it names the fields, so the refusal is actionable rather than a
    // riddle about which of ten fields the file is missing.
    expect(r.stderr).toContain("attempts");
    expect(r.stderr).toContain("lastReflectedAttempts");
    // Never truncated or rewritten: recovering it is a deliberate act.
    expect(
      JSON.parse(readFileSync(join(d, "drive-pr-999.json"), "utf8")).rounds,
    ).toBe(4);
  });

  it("shares one drive state across LINKED WORKTREES of the same clone", async () => {
    // `--git-dir` resolves to a linked worktree's PRIVATE
    // `.git/worktrees/<name>`, so the same PR gets an independent round budget
    // and parked set per worktree — a second Conductor worktree re-arms an
    // escalation the first one parked, and restarts a bound meant to be
    // durable. This repo is driven from linked worktrees as the normal case.
    //
    // $DRIVE_PR_STATE_DIR is deliberately UNSET here: the whole point is where
    // the script puts state when nobody tells it.
    const { dir } = makeScratchRepo("worktree-state");
    const linked = join(tmpRoot, "worktree-state-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const run = (cwd: string, args: string[]) => {
      const p = Bun.spawnSync([join(SCRIPTS, "drive-state.ts"), ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return p.stdout.toString().trim();
    };
    // Park in the MAIN worktree…
    run(dir, [
      "park",
      "999",
      "--key",
      "PRRT_x",
      "--kind",
      "thread",
      "--reason",
      "needs a human",
    ]);
    run(dir, ["bump-round", "999", "--head", "aaaaaaa"]);
    // …and the LINKED one must see it, not a blank slate.
    expect(run(linked, ["parked-keys", "999"])).toBe("PRRT_x");
    expect(run(linked, ["rounds", "999"])).toBe("1");
  });

  // RETIRED: this warning fires only when `openStore` resolves
  // WITHOUT an override AND lands on `--git-common-dir` (the guard's own
  // condition — `!process.env.DRIVE_PR_STATE_DIR && !existsSync(file)` — skips
  // it whenever an override is set). The unoverridden default no longer ever
  // resolves there,
  // and setting `DRIVE_PR_STATE_DIR` to `--git-common-dir` explicitly to
  // restore the old landing spot ALSO trips that same "override is set" skip
  // — there is no longer any way to reach this code path at all. The
  // mechanism this warning guarded (the worktree-private → git-common-dir
  // migration) has its own successor for the move:
  // `legacy-state.ts`'s `ensureMigratedFromLegacy`. Left `.skip`, not deleted,
  // so the scenario and its history stay legible if `orphans.ts` is ever
  // revisited.
  it.skip("warns about an orphaned worktree-private state file ONCE, not on every call", async () => {
    // The documentation promises a "loud ONE-TIME warning". The condition it
    // guards — no state at the clone-wide path — stays true on every call that
    // does not itself write state (`rounds`, `get`, `parked-keys` never do),
    // and `drive-status.ts` calls `parked-keys` on every evaluation. Without a
    // durable "already told them" marker this fires every round of an
    // unattended loop until a human happens to notice — which is not what
    // "once" means.
    const { dir } = makeScratchRepo("orphan-warn-once");
    const linked = join(tmpRoot, "orphan-warn-once-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    // A pre-existing worktree-private state file, shaped exactly like one
    // `bump-round` would have written before the clone-wide move — this is the
    // orphan, not a fixture artefact.
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const run = () =>
      Bun.spawnSync([join(SCRIPTS, "drive-state.ts"), "rounds", "999"], {
        cwd: linked,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = run();
    const second = run();
    const third = run();
    expect(first.stderr.toString()).toContain("worktree-private one exists");
    expect(second.stderr.toString()).not.toContain(
      "worktree-private one exists",
    );
    expect(third.stderr.toString()).not.toContain(
      "worktree-private one exists",
    );
    // The underlying answer is unaffected — a fresh drive either way, since
    // adopting the orphan is a human's `mv`, not something this warning does.
    expect(first.stdout.toString().trim()).toBe("0");
    expect(third.stdout.toString().trim()).toBe("0");
  });

  // RETIRED — see the previous test's comment: unreachable now
  // that the unoverridden default never lands on `--git-common-dir` and an
  // explicit override there trips the same "override is set" skip the guard
  // already applies.
  it.skip("finds an orphan in ANOTHER worktree, not just the one it runs from", async () => {
    // Checking only `git rev-parse --git-dir` — the CURRENT worktree's private
    // dir — means resuming the drive from a worktree that is not the one that
    // held the orphan reports a silent fresh start, because the one place this
    // loop looked has nothing there. Two linked worktrees here; the orphan is
    // written into worktree A's private dir, and the drive is resumed from B.
    const { dir } = makeScratchRepo("orphan-other-worktree");
    const worktreeA = join(tmpRoot, "orphan-other-worktree-a");
    const worktreeB = join(tmpRoot, "orphan-other-worktree-b");
    const env = gitCleanEnv();
    for (const [name, path] of [
      ["a", worktreeA],
      ["b", worktreeB],
    ] as const) {
      Bun.spawnSync(["git", "worktree", "add", "-q", "-b", name, path], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    const privateDirA = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: worktreeA,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: worktreeA, env: { ...env, DRIVE_PR_STATE_DIR: privateDirA } },
    );
    // Resumed from B, which has never seen this PR.
    const r = Bun.spawnSync(
      [join(SCRIPTS, "drive-state.ts"), "rounds", "999"],
      {
        cwd: worktreeB,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(r.stderr.toString()).toContain("worktree-private one exists");
    expect(r.stderr.toString()).toContain(privateDirA);
  });

  it("refuses a parked key containing a newline, at BOTH the write and read side", async () => {
    // `parked-keys` is a line-delimited channel and drive-status.ts splits its
    // output on LF, so `PRRT_x\nPRRT_unrelated` parks ONE item and yields TWO
    // match tokens — the phantom second one suppressing live work nobody
    // parked. That is the inverse of what parking is for, and it is invisible
    // in the state file's own shape, so the ban has to sit on the channel's
    // entry AND on the reader that a hand-edited file reaches directly.
    for (const bad of ["PRRT_x\nPRRT_unrelated", "PRRT_x\rPRRT_unrelated"]) {
      const d = stateDirFor("parked-key-newline");
      // Write side: `park` refuses it.
      const w = await state(d, [
        "park",
        "999",
        "--key",
        bad,
        "--kind",
        "thread",
        "--reason",
        "a decision",
      ]);
      expect(w.exitCode).toBe(2);
      expect(w.stderr).toContain("may not contain a newline");

      // Read side: a file hand-edited past the write guard is still refused,
      // so `parked-keys` can never emit the phantom token.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          rounds: 1,
          lastCountedHead: "",
          verifiedSha: "",
          phase: "",
          parked: [
            { key: bad, kind: "thread", reason: "a decision", round: 1 },
          ],
        }),
      );
      const r = await state(d, ["parked-keys", "999"]);
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toBe("");
    }
  });

  // RETIRED — see the "warns about an orphaned…" test's comment.
  it.skip("renders the suggested adoption command safely for a worktree path containing an apostrophe", async () => {
    // A hand-composed `mv '$path' '$file'` breaks the moment `$path` itself
    // contains an apostrophe — git places no restriction on a worktree's
    // directory name — and copying the "helpful" instruction as printed would
    // then run whatever shell text follows the embedded quote. Verified by
    // actually feeding the printed command through `bash -c`, with `mv`
    // swapped for a `printf` that echoes its argv instead of moving anything:
    // if the escaping is correct, that round-trips to exactly the two original
    // paths; if it is the naive single-quoted form, the shell either parses it
    // into the wrong words or fails outright.
    const { dir } = makeScratchRepo("orphan-quote-path");
    const linked = join(tmpRoot, "orphan-quote-path-o'clock");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const r = Bun.spawnSync(
      [join(SCRIPTS, "drive-state.ts"), "rounds", "999"],
      {
        cwd: linked,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = r.stderr.toString();
    const cmdLine = stderr.split("\n").find((l) => l.includes(" ln "));
    expect(cmdLine).toBeDefined();
    // Just the `ln <src> <dest>` half; the `&& rm <src>` tail would echo a
    // third word and says nothing extra about the quoting.
    const lnCmd = cmdLine!
      .slice(cmdLine!.indexOf("ln "))
      .replace(/ && rm .*$/, "")
      .replace(/^ln /, 'printf "%s\\n" ');
    const parsed = Bun.spawnSync(["bash", "-c", lnCmd], {
      cwd: linked,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(parsed.exitCode).toBe(0);
    const orphanPath = join(privateDir, "drive-pr-999.json");
    const filePath = join(commonDir, "drive-pr-999.json");
    expect(parsed.stdout.toString().trim().split("\n")).toEqual([
      orphanPath,
      filePath,
    ]);
  });

  // RETIRED — see the "warns about an orphaned…" test's comment.
  it.skip("the suggested adoption command REFUSES to clobber state created since the warning", async () => {
    // The absence check that produced the warning is the driver's, seconds
    // ago; the human runs the command later. A concurrent driver creating
    // `$file` in between makes a plain `mv` silently overwrite it — destroying
    // a live drive's parked decisions to recover an older one's. The printed
    // command must fail instead, which is why it is `ln` and not `mv`.
    const { dir } = makeScratchRepo("orphan-no-clobber");
    const linked = join(tmpRoot, "orphan-no-clobber-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const r = Bun.spawnSync(
      [join(SCRIPTS, "drive-state.ts"), "rounds", "999"],
      {
        cwd: linked,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const cmdLine = r.stderr
      .toString()
      .split("\n")
      .find((l) => l.includes(" ln "));
    expect(cmdLine).toBeDefined();
    const adopt = cmdLine!.slice(cmdLine!.indexOf("ln "));
    // A rival driver creates the clone-wide state AFTER the warning printed.
    const rival = JSON.stringify({
      pr: 999,
      rounds: 9,
      lastCountedHead: "",
      verifiedSha: "",
      phase: "",
      parked: [
        {
          key: "PRRT_live",
          kind: "thread",
          reason: "a live decision",
          round: 9,
        },
      ],
    });
    const filePath = join(commonDir, "drive-pr-999.json");
    writeFileSync(filePath, rival);
    const run = Bun.spawnSync(["bash", "-c", adopt], {
      cwd: linked,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).not.toBe(0);
    // The rival's parked decision is untouched — which is the whole point.
    expect(readFileSync(filePath, "utf8")).toBe(rival);
  });

  // RETIRED — see the "warns about an orphaned…" test's comment.
  it.skip("re-warns when the marker was RESERVED but the warning never got delivered", async () => {
    // The marker has to be created before the first `echo` to serialise
    // concurrent warners, which opens a window: a process killed in between
    // leaves "already warned" standing for a warning nobody saw, silently
    // trading the only notification that an orphan may hold parked human
    // decisions for an empty file. So the create only RESERVES, the delivered
    // sentinel is written after the last line, and an EMPTY marker is treated
    // as unclaimed. Modelled by truncating the marker — exactly the on-disk
    // state such a kill leaves behind.
    const { dir } = makeScratchRepo("orphan-undelivered");
    const linked = join(tmpRoot, "orphan-undelivered-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const run = () =>
      Bun.spawnSync([join(SCRIPTS, "drive-state.ts"), "rounds", "999"], {
        cwd: linked,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(run().stderr.toString()).toContain("worktree-private one exists");
    const marker = join(commonDir, ".drive-pr-999.orphan-warned");
    // A delivered warning leaves a NON-empty marker and stays quiet.
    expect(readFileSync(marker, "utf8").length).toBeGreaterThan(0);
    expect(run().stderr.toString()).not.toContain(
      "worktree-private one exists",
    );
    // Reserved-but-never-delivered: the marker exists and is empty.
    writeFileSync(marker, "");
    expect(run().stderr.toString()).toContain("worktree-private one exists");
    // …and delivering it again re-claims, so it does not warn forever.
    expect(readFileSync(marker, "utf8").length).toBeGreaterThan(0);
    expect(run().stderr.toString()).not.toContain(
      "worktree-private one exists",
    );
  });

  // RETIRED — see the "warns about an orphaned…" test's comment.
  it.skip("a caller running it with 2>/dev/null claims NOTHING, so a visible caller still warns", async () => {
    // Un-silencing `drive-status.ts` fixed the instance, not the class:
    // `round-plan.ts --delta` silences `drive-state.ts verified` the same way,
    // and any future caller may. Whichever quiet caller happens to run first
    // would write the warning into the void and record it as seen, leaving
    // every later human-visible call silent about state holding parked human
    // decisions. So the test is on fd 2 itself, not on the caller's name.
    const { dir } = makeScratchRepo("orphan-quiet-caller");
    const linked = join(tmpRoot, "orphan-quiet-caller-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const commonDir = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    // A QUIET caller runs first — stderr genuinely redirected to /dev/null by
    // the shell, exactly as `round-plan.ts` and the old `drive-status.ts` did.
    const quiet = Bun.spawnSync(
      [
        "bash",
        "-c",
        `exec 2>/dev/null; "${join(SCRIPTS, "drive-state.ts")}" rounds 999`,
      ],
      { cwd: linked, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(quiet.stdout.toString().trim()).toBe("0");
    // It must not have claimed the marker…
    expect(existsSync(join(commonDir, ".drive-pr-999.orphan-warned"))).toBe(
      false,
    );
    // …so the first caller a human can actually read still gets the warning.
    const visible = Bun.spawnSync(
      [join(SCRIPTS, "drive-state.ts"), "rounds", "999"],
      { cwd: linked, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(visible.stderr.toString()).toContain("worktree-private one exists");
  });

  // RETIRED — see the "warns about an orphaned…" test's comment.
  it.skip("`reset` re-arms the orphan warning for a later recurrence of the condition", async () => {
    // A `reset` clears the clone-wide file, which is `[ ! -e "$file" ]` all
    // over again — the same condition the warning guards. Leaving the marker
    // standing across that reset makes it permanently stale: it was written
    // for an absence that has since ended (a state file existed) and begun
    // again (reset removed it), and a marker from the FIRST absence has
    // nothing to say about whether the second one was ever reported.
    const { dir } = makeScratchRepo("orphan-reset-rearm");
    const linked = join(tmpRoot, "orphan-reset-rearm-linked");
    const env = gitCleanEnv();
    Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "probe", linked], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const privateDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: linked,
      env,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    Bun.spawnSync(
      [
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ],
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const run = (args: string[]) =>
      Bun.spawnSync([join(SCRIPTS, "drive-state.ts"), ...args], {
        cwd: linked,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = run(["rounds", "999"]);
    expect(first.stderr.toString()).toContain("worktree-private one exists");
    const suppressed = run(["rounds", "999"]);
    expect(suppressed.stderr.toString()).not.toContain(
      "worktree-private one exists",
    );
    // `reset` here only removes the (still-absent) clone-wide file — a no-op on
    // it — but must also clear the marker, re-arming the warning.
    run(["reset", "999"]);
    const afterReset = run(["rounds", "999"]);
    expect(afterReset.stderr.toString()).toContain(
      "worktree-private one exists",
    );
  });

  it("a malformed state file blocks a WRITE too, so nothing is built on it", async () => {
    const d = stateDirFor("malformed-write");
    writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
    const r = await state(d, [
      "park",
      "999",
      "--key",
      "PRRT_x",
      "--kind",
      "thread",
      "--reason",
      "a decision",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(join(d, "drive-pr-999.json"), "utf8")).toBe(
      "not json at all",
    );
  });

  it("`reset` is the deliberate way out of a malformed state", async () => {
    // An unparseable file with no raw-byte evidence of `ciHold` also cannot
    // rule out a truncated-before-the-key transition, so
    // `reset` now confirms against the live timeline too — this test's own
    // recovery path needs a `gh` on PATH that answers with an empty one,
    // where before it needed none at all.
    const d = stateDirFor("reset");
    const ghRoot = mkdtempSync(join(tmpdir(), "drive-state-reset-gh-"));
    const ghBin = join(ghRoot, "gh");
    writeFileSync(
      ghBin,
      `#!/bin/sh\ncase "$*" in\n  *timeline*) printf '%s\\n' '[[]]' ;;\n  *) exit 1 ;;\nesac\n`,
    );
    chmodSync(ghBin, 0o755);
    const ghEnv = { PATH: `${ghRoot}:${process.env.PATH ?? ""}` };
    writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
    expect((await state(d, ["reset", "999"], ghEnv)).exitCode).toBe(0);
    expect((await state(d, ["rounds", "999"])).stdout).toBe("0");
  });

  it("`reset` also clears the handoff, not just the JSON", async () => {
    // Deleting the JSON without it leaves a stale .md still showing the
    // round/phase/held/parked state `reset` just discarded, while the file's
    // own text tells a compacted agent to prefer it over memory.
    const d = stateDirFor("reset-handoff");
    const hd = join(d, "handoff");
    const env = { DRIVE_PR_HANDOFF_DIR: hd };
    const path = join(hd, "pr-drive-999.md");
    await state(
      d,
      ["park", "999", "--key", "PRRT_a", "--kind", "thread", "--reason", "r"],
      env,
    );
    expect(existsSync(path)).toBe(true);
    await state(d, ["reset", "999"], env);
    expect(existsSync(path)).toBe(false);
  });

  it("`reset` also compacts the lock`s own permanent quarantine tombstones", async () => {
    // `lock.ts`'s own `tombstone()` never sweeps `${lock}.stale.*` or
    // `${lock}.recovering.stale.*` — deliberately, see its doc comment — so
    // without this, "forget everything for this PR" left an unbounded pile
    // of inode-consuming quarantine directories behind forever. `reset` is a
    // convenient trigger for the compaction, not a safety precondition for
    // it (see `sweepLockQuarantine`'s own doc comment for why a delete-based
    // sweep gated on `reset`'s live-lease/live-claim checks alone is NOT
    // actually safe): compaction never removes the permanent fence, only
    // shrinks it to an empty file at the same path, so it needs none of
    // that.
    const d = stateDirFor("reset-lock-quarantine");
    const file = join(d, "drive-pr-999.json");
    const lock = `${file}.lock`;
    const lockDoomed = `${lock}.stale.owner.${"a".repeat(24)}`;
    mkdirSync(lockDoomed, { recursive: true });
    writeFileSync(join(lockDoomed, "tombstone"), "broken by pid 1\n");
    const recoveringDoomed = `${lock}.recovering.stale.owner.${"b".repeat(24)}`;
    mkdirSync(recoveringDoomed, { recursive: true });
    writeFileSync(join(recoveringDoomed, "tombstone"), "broken by pid 1\n");

    expect((await state(d, ["reset", "999"])).exitCode).toBe(0);

    // Still present at the same generation-keyed path — the fence a foreign
    // rename would collide against is never removed — but compacted from a
    // directory down to a single empty file.
    expect(existsSync(lockDoomed)).toBe(true);
    expect(statSync(lockDoomed).isDirectory()).toBe(false);
    expect(existsSync(recoveringDoomed)).toBe(true);
    expect(statSync(recoveringDoomed).isDirectory()).toBe(false);

    // `reset` itself acquires and releases this PR's own lock (to check for
    // a live lease/claim before it deletes anything), and releasing ALWAYS
    // mints a FRESH pair of permanent tombstones for the generation it just
    // held — one from `release()`'s own rename, one from
    // `releaseRecoveringGate()`'s. Asserting only the two entries planted
    // BEFORE this test's own `reset` call would still pass if
    // `sweepLockQuarantine` were called back INSIDE `store.locked()` (the
    // exact ordering bug this call site's own comment guards against) — that
    // fresh pair is created only
    // when `store.locked()` releases the lock AFTER its callback returns, so
    // a sweep run before that never sees them. Enumerate every entry this
    // PR's lock has produced and require ALL of them, not just the
    // pre-planted two, to be compacted.
    const lockBase = basename(lock);
    const quarantineEntries = readdirSync(d).filter(
      (f) =>
        f.startsWith(`${lockBase}.stale.`) ||
        f.startsWith(`${lockBase}.recovering.stale.`),
    );
    expect(quarantineEntries.length).toBeGreaterThan(2);
    for (const entry of quarantineEntries) {
      expect(statSync(join(d, entry)).isDirectory()).toBe(false);
    }
  });

  it("SERIALISES concurrent parks so neither driver’s decision is lost", async () => {
    // Two drivers read the same state, each add a different parked item, and
    // both rename. Without a lock the later write wins outright and the earlier
    // HITL decision is gone with no error anywhere. Conductor runs many
    // worktrees against one clone, so this is the normal case here.
    const d = stateDirFor("concurrent");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        state(d, [
          "park",
          "999",
          "--key",
          `PRRT_${i}`,
          "--kind",
          "thread",
          "--reason",
          `decision ${i}`,
        ]),
      ),
    );
    const keys = (await state(d, ["parked-keys", "999"])).stdout
      .split("\n")
      .sort();
    expect(keys).toEqual([
      "PRRT_0",
      "PRRT_1",
      "PRRT_2",
      "PRRT_3",
      "PRRT_4",
      "PRRT_5",
    ]);
  });

  it("breaks a STALE lock rather than blocking every later driver forever", async () => {
    const d = stateDirFor("stale-lock");
    mkdirSync(join(d, "drive-pr-999.json.lock"), { recursive: true });
    // -1 makes every lock older than "minus one minute", i.e. always stale.
    const r = await state(
      d,
      ["park", "999", "--key", "K", "--kind", "thread", "--reason", "r"],
      { DRIVE_PR_LOCK_STALE_MIN: "-1" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("broke a stale lock");
  });

  it("releases only the lock INSTANCE it acquired", async () => {
    // An updater suspended past the stale threshold has its lock broken and
    // replaced by another driver. On resuming, a release keyed on "I once
    // acquired this path" deletes the NEW driver's live lock, letting a third
    // in concurrently — the lost parked decision the mutex exists to prevent,
    // reached through the mutex itself.
    //
    // Modelled directly: take the lock, then simulate the break-and-replace by
    // renaming it away and creating a fresh, foreign lock at the same path.
    // Releasing must leave that foreign lock alone.
    const d = stateDirFor("lock-ownership");
    const lock = join(d, "drive-pr-999.json.lock");
    // A real `park` holds the lock for milliseconds, so a plain sleep-then-swap
    // races it and passes whatever the code does. Stalling the update while
    // the lock is HELD is what actually reproduces the suspension — the bash
    // suite got that window by shimming `mv` on PATH, which a `renameSync`
    // port cannot be stalled by, so the store exposes the same sanctioned
    // signal+delay hook pair `claim-held` already ships
    // (DRIVE_PR_UPDATE_TEST_SIGNAL / DRIVE_PR_UPDATE_TEST_DELAY): the signal
    // fires the instant the lock is held, and the delay holds it open.
    const signal = join(d, "updater-is-holding");
    const parkPromise = state(
      d,
      ["park", "999", "--key", "K", "--kind", "thread", "--reason", "r"],
      {
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "2",
      },
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(signal)) {
      if (Date.now() > deadline) {
        throw new Error("the updater never signalled that it holds the lock");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // Swap the lock out from under the still-holding updater, exactly as a
    // stale-breaker would, then let it finish and release.
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "foreign"), "");
    await parkPromise;
    // The foreign lock must survive: it is not ours to release.
    expect(existsSync(join(lock, "foreign"))).toBe(true);
  });

  it("gives up rather than writing without the lock", async () => {
    const d = stateDirFor("held-lock");
    mkdirSync(join(d, "drive-pr-999.json.lock"), { recursive: true });
    const r = await state(
      d,
      ["park", "999", "--key", "K", "--kind", "thread", "--reason", "r"],
      { DRIVE_PR_LOCK_TIMEOUT: "1" },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("could not acquire");
  });

  it("counts ATTEMPTS per head, resetting when the head moves", async () => {
    // `rounds` counts distinct reviewed heads, so it cannot bound a pass that
    // never pushes. `attempts` is the counter that can, and it is durable so
    // restarting the driver does not hand it a fresh budget.
    const d = stateDirFor("attempts");
    expect(
      (await state(d, ["bump-attempt", "999", "--head", "aaa"])).stdout,
    ).toBe("1");
    expect(
      (await state(d, ["bump-attempt", "999", "--head", "aaa"])).stdout,
    ).toBe("2");
    expect((await state(d, ["attempts", "999"])).stdout).toBe("2");
    expect(
      (await state(d, ["bump-attempt", "999", "--head", "bbb"])).stdout,
    ).toBe("1");
  });

  describe("the held batch", () => {
    // The window between replying `**accepted**` and resolving the thread after
    // the push. That list used to live only in the agent's context, so anything
    // that ended the context inside the window dropped it — silently, and in
    // both directions: a fixed finding re-triaged next round as unfixed, or a
    // second outcome token on a thread that already carries one. `--handoff-at
    // never` expects a compaction there by design, which is why it does not
    // ship without these.

    it("survives a pass KILLED between the reply and the resolve", async () => {
      // The acceptance probe. Model the round exactly: the pass records its
      // holds at reply time, then dies before step 6 ever runs. A fresh process
      // — which is what a successor, or the agent after a compaction, is — must
      // recover the batch from state rather than re-deriving or dropping it.
      //
      // SIGKILL, not a clean exit: an EXIT trap could otherwise be what makes
      // this pass, and a compacted agent fires no traps.
      const d = stateDirFor("held-killed");
      const holder = Bun.spawn(
        [
          "bash",
          "-c",
          [
            `"${join(SCRIPTS, "drive-state.ts")}" hold 999 --key PRRT_a --kind thread --outcome accepted --comment-url https://example.invalid/killed-pass-reply`,
            `"${join(SCRIPTS, "drive-state.ts")}" hold 999 --key f00d --kind finding --outcome moot <<'REASON_EOF'`,
            "code already gone, superseded by round 2",
            "REASON_EOF",
            // …and the pass dies here, before it resolves anything.
            "kill -9 $$",
          ].join("\n"),
        ],
        {
          env: { ...process.env, DRIVE_PR_STATE_DIR: d },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await holder.exited;
      expect(holder.signalCode).toBe("SIGKILL");

      const recovered = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(recovered).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/killed-pass-reply",
          // Recorded at hold time, on both kinds: which driver is promising
          // this fix. No `verifiedSha` — the killed pass never pushed, which is
          // exactly the state a hold starts in.
          actor: ACTOR,
        },
        {
          key: "f00d",
          kind: "finding",
          outcome: "moot",
          round: 0,
          // The trailing newline survives — same deliberate preservation
          // reply-to-thread.ts's own body handling uses, not truncation.
          reason: "code already gone, superseded by round 2\n",
          actor: ACTOR,
        },
      ]);
    });

    it("records the KIND, because it decides which script releases the item", async () => {
      // A thread is resolved with resolve-thread.ts; a summary finding is
      // answered with answer-summary-finding.ts --pushed-sha. A successor that
      // has to guess gets one of them wrong, and the wrong guess on a finding
      // leaves it blocking convergence forever.
      const d = stateDirFor("held-kind");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "moot",
        ],
        {},
        "no longer applies",
      );
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)[0].kind).toBe(
        "finding",
      );
    });

    it("refuses to hold a DURABLE outcome", async () => {
      // `rejected` / `wont-fix` / `deferred` are claims about the finding's
      // MERIT, which no later commit changes, so they are replied to AND
      // resolved in the same step. Holding one records a thread that is already
      // resolved, which step 6 then tries to resolve again.
      const d = stateDirFor("held-outcome");
      for (const outcome of ["rejected", "wont-fix", "deferred", ""]) {
        const r = await state(d, [
          "hold",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "thread",
          "--outcome",
          outcome,
          "--comment-url",
          "https://example.invalid/synthetic-comment-1",
        ]);
        expect({ outcome, exit: r.exitCode }).toEqual({ outcome, exit: 2 });
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("requires a --kind, like park does", async () => {
      const d = stateDirFor("held-nokind");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--outcome",
        "accepted",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--kind thread|finding");
    });

    it("requires the reason body on stdin for a `finding` hold, unlike `thread`", async () => {
      // A thread's reply is already posted to GitHub by hold time (the
      // reply-to-thread.ts call that precedes this one), so its text survives
      // independently. A finding's answer can't be posted until step 6, after
      // the push — so at hold time the reasoning exists nowhere but the
      // triaging agent's own context, and a crash before the push would lose
      // it entirely without this.
      const d = stateDirFor("held-finding-noreason");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--outcome",
        "accepted",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("reason body on stdin");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");

      // A `thread` hold needs no stdin at all and carries no `reason` field.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-2",
      ]);
      const held = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(held).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/synthetic-comment-2",
          actor: ACTOR,
        },
      ]);
    });

    it("re-holding one key updates it instead of duplicating it", async () => {
      const d = stateDirFor("held-dupe");
      for (const outcome of ["accepted", "moot"]) {
        await state(d, [
          "hold",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "thread",
          "--outcome",
          outcome,
          "--comment-url",
          "https://example.invalid/synthetic-comment-3",
        ]);
      }
      const held = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(held).toHaveLength(1);
      expect(held[0].outcome).toBe("moot");
    });

    it("releases one key, or the whole batch — but never on a bare invocation", async () => {
      // `--all` is explicit on purpose. A typo'd `--key` silently falling back
      // to "clear everything" drops the very items the batch exists to
      // remember, which is the failure this command was added to close.
      const d = stateDirFor("held-release");
      for (const key of ["PRRT_a", "PRRT_b"]) {
        await state(d, [
          "hold",
          "999",
          "--key",
          key,
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/synthetic-comment-4",
        ]);
      }
      const bare = await state(d, ["release-held", "999"]);
      expect(bare.exitCode).toBe(2);
      expect((await state(d, ["held-keys", "999"])).stdout.split("\n")).toEqual(
        ["PRRT_a", "PRRT_b"],
      );

      await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_b");

      await state(d, ["release-held", "999", "--all"]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("SERIALISES concurrent release-held --key calls so none is silently dropped", async () => {
      // The existence check and the removal used to run as two separate
      // steps — a precheck before `update_state`'s own lock acquisition —
      // which reopened the exact TOCTOU the mutex exists to close elsewhere:
      // a release for key A racing a release for key B could interleave
      // between A's check and A's write. Holding the lock continuously
      // across the check and the write (not two separate acquisitions)
      // closes it; six concurrent releases for six distinct real keys must
      // all succeed and the batch must end up completely empty, not missing
      // a write or resurrecting one that already happened.
      const d = stateDirFor("release-held-concurrent");
      for (let i = 0; i < 6; i++) {
        await state(d, [
          "hold",
          "999",
          "--key",
          `PRRT_${i}`,
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/synthetic-comment-5",
        ]);
      }
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          state(d, ["release-held", "999", "--key", `PRRT_${i}`]),
        ),
      );
      for (const r of results) {
        expect(r.exitCode).toBe(0);
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("refuses to silently no-op releasing a key that is not held", async () => {
      // A typo'd or already-released `--key` used to succeed with exit 0 and
      // an unchanged batch — indistinguishable from a real release. The caller
      // believes the real item is gone; for a `finding`, the next thing that
      // happens on that wrong belief is a second, non-idempotent
      // `answer-summary-finding.ts` post on a later round.
      const d = stateDirFor("held-release-typo");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-6",
      ]);
      const r = await state(d, ["release-held", "999", "--key", "PRRT_typo"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no held item with key");
      // The real held item is untouched.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses --key and --all together rather than guessing", async () => {
      const d = stateDirFor("held-both");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-7",
      ]);
      const r = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--all",
      ]);
      expect(r.exitCode).toBe(2);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("a malformed state file blocks a hold, so nothing is built on it", async () => {
      const d = stateDirFor("held-malformed");
      writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-8",
      ]);
      expect(r.exitCode).not.toBe(0);
    });

    it("rejects a well-formed array of ILL-SHAPED held entries, not just non-arrays", async () => {
      // `.held` being an array was not enough: an empty key, a `kind` outside
      // thread|finding, or a missing `round` all satisfied "array" while
      // being unusable by `held-keys`/`release-held`/step 6. Only a
      // hand-edited or externally-corrupted file can reach this shape — every
      // writer here (`hold`) already enforces it — but a state file that
      // parses and passes the shape check is treated as trustworthy, so the
      // check has to actually cover the shape.
      const d = stateDirFor("held-ill-shaped");
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 0,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 0,
          ciHold: null,
          verifiedSha: "",
          phase: "",
          parked: [],
          held: [{ key: "", kind: "bogus", outcome: "rejected" }],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("not usable drive state");
    });

    it("the refusal message NAMES every field the predicate requires", async () => {
      // That message says of itself: "This list is exhaustive on purpose: it
      // is the only thing that tells a reader WHICH field is missing." Nothing
      // enforced it, so it drifted the moment a field was added —
      // `readyMarkedRound` was checked by the
      // predicate and absent from the message, so a file missing exactly that
      // field got a diagnostic listing only the fields it *did* have
      // (measured). A hand-written tally standing in for "only the fields it
      // did have" would itself be a hand-maintained count that drifts.
      //
      // Derived from BEHAVIOUR, not from a second hand-maintained list, which
      // would drift the same way: drop each field in turn from a known-good
      // state, confirm the predicate actually rejects it, and only then
      // require the message to name it. A field the predicate stops caring
      // about drops out of this test automatically.
      const complete: Record<string, unknown> = {
        pr: 999,
        rounds: 0,
        lastCountedHead: "",
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
      };
      // THE BASELINE IS THE MUTATION. `complete` is hand-written, so if
      // production adds a required field that this fixture AND the message
      // both omit, every deletion case below is rejected for the wrong reason
      // (the missing new field), the assertions only ever inspect the old
      // names, and the test stays green while proving nothing — the vacuity
      // this whole test exists to prevent, reached through its own fixture
      //. Asserting the untouched fixture is
      // ACCEPTED is what turns that into a red: a new required field fails
      // here first, and names itself in the refusal it triggers.
      const baseDir = stateDirFor("msg-names-baseline");
      writeFileSync(
        join(baseDir, "drive-pr-999.json"),
        JSON.stringify(complete),
      );
      expect((await state(baseDir, ["held-keys", "999"])).exitCode).toBe(0);

      const unnamed: string[] = [];
      for (const field of Object.keys(complete)) {
        // `pr` is named by number rather than by key ("this PR's number"), so
        // it is the one field the message identifies differently.
        if (field === "pr") continue;
        const d = stateDirFor(`msg-names-${field}`);
        const partial = { ...complete };
        delete partial[field];
        writeFileSync(join(d, "drive-pr-999.json"), JSON.stringify(partial));
        const res = await state(d, ["held-keys", "999"]);
        // Guard against a vacuous pass: if dropping the field is ACCEPTED,
        // there is no refusal message to inspect and this field proves
        // nothing either way.
        if (res.exitCode === 0) continue;
        if (!res.stderr.includes(field)) unnamed.push(field);
      }
      expect(unnamed).toEqual([]);
    });

    it("the refusal message names every NESTED field the predicate requires", async () => {
      // The exhaustiveness claim covers `parked` and `held` ENTRIES too, and
      // the top-level sweep above cannot reach them: it deletes whole
      // containers, so removing `commentUrl` or `outcome` from the message
      // left that test green while a file missing exactly those fields got a
      // diagnostic that named neither. Nested
      // entries are where the message earns its keep — a state file whose
      // top-level keys all look fine is precisely the one a reader cannot
      // diagnose unaided.
      //
      // Derived from behaviour, exactly as above: mutate one nested field at a
      // time out of a known-good record, require the predicate to reject it,
      // and only then require the message to name it.
      const actor = "wt-0123456789abcdef";
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [
          {
            key: "PRRT_park",
            kind: "thread",
            reason: "awaiting a human",
            round: 1,
          },
        ],
        held: [
          {
            key: "PRRT_thread",
            kind: "thread",
            outcome: "accepted",
            round: 1,
            commentUrl: "https://example.invalid/#discussion_r1",
            actor,
          },
          {
            key: "fingerprint0001",
            kind: "finding",
            outcome: "moot",
            round: 1,
            reason: "the anchored code was rewritten",
            actor,
          },
        ],
      };
      // Every required field of every nested entry, by container and index —
      // one case per field, so a message that names some but not others fails
      // on exactly the ones it omits.
      const cases: Array<{
        container: "parked" | "held";
        index: number;
        field: string;
      }> = [];
      for (const field of Object.keys(base.parked[0] ?? {})) {
        cases.push({ container: "parked", index: 0, field });
      }
      for (const [index, entry] of base.held.entries()) {
        for (const field of Object.keys(entry)) {
          cases.push({ container: "held", index, field });
        }
      }
      // Same baseline mutation as the top-level test above, and needed for the
      // same reason: `base` is hand-written, so a newly required nested field
      // absent from BOTH it and the message would have every case below
      // rejected for that field instead of the one under test, with the
      // assertions none the wiser. A fixture that
      // is not itself accepted proves nothing about which deletion caused a
      // refusal.
      const baseDir = stateDirFor("msg-nested-baseline");
      writeFileSync(join(baseDir, "drive-pr-999.json"), JSON.stringify(base));
      expect((await state(baseDir, ["held-keys", "999"])).exitCode).toBe(0);

      const unnamed: string[] = [];
      const accepted: string[] = [];
      for (const { container, index, field } of cases) {
        const label = `${container}[${index}].${field}`;
        const d = stateDirFor(`msg-nested-${container}-${index}-${field}`);
        const partial = JSON.parse(JSON.stringify(base)) as Record<
          string,
          unknown
        >;
        const entries = partial[container] as Array<Record<string, unknown>>;
        delete entries[index]?.[field];
        writeFileSync(join(d, "drive-pr-999.json"), JSON.stringify(partial));
        const res = await state(d, ["held-keys", "999"]);
        // Not the vacuous-pass SKIP the top-level sweep uses: every field here
        // is one `isUsableState` demands, so an accepted deletion is a
        // predicate regression and must fail this test rather than drop out of
        // it silently.
        if (res.exitCode === 0) {
          accepted.push(label);
          continue;
        }
        if (!res.stderr.includes(field)) unnamed.push(label);
      }
      expect(accepted).toEqual([]);
      expect(unnamed).toEqual([]);
    });

    it("re-checks the durable mark AFTER winning the lease, not only before", async () => {
      // The read and the `claimCreate` are not one atomic step. A caller can
      // read `readyMarkedRound === 0`, be pre-empted for arbitrarily long, and
      // resume only after some OTHER caller has committed the mark AND released
      // its lease — at which point this caller's create succeeds against a
      // now-vacant path and its driver fires a second `gh pr ready`, which is
      // the duplicate paid review the lease exists to prevent.
      //
      // The commit landing during the gap is what makes this deterministic:
      // it strictly happens-before the release that frees the path, which
      // strictly happens-before this create can succeed, so a plain re-read is
      // guaranteed to observe it — no lock needed on this half.
      const d = stateDirFor("ready-claim-recheck");
      const signal = join(d, "claim-read-done");
      const proc = Bun.spawn(
        [join(SCRIPTS, "drive-state.ts"), "claim-ready-mark", "999"],
        {
          env: {
            ...process.env,
            DRIVE_PR_STATE_DIR: d,
            DRIVE_PR_CLAIM_READY_TEST_SIGNAL: signal,
            DRIVE_PR_CLAIM_READY_TEST_DELAY: "2",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline)
          throw new Error("claim signal never appeared");
        await Bun.sleep(10);
      }
      // The other driver commits and releases while this one is pre-empted.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          rounds: 0,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 3,
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
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(stdout.trim()).toBe("already");
      // And it left no lease behind for a later caller to trip over.
      expect(existsSync(join(d, "drive-pr-999.ready-claim"))).toBe(false);
    });

    it("never destroys a ready-mark lease generation it does not own", async () => {
      // The cross-generation delete: an owner returning at the edge of the
      // staleness window passes its own token check, and a DIFFERENT driver
      // legitimately breaks that stale claim and writes a fresh one in the gap
      // before the removal runs — so the removal deletes the successor's file,
      // not the one this caller ever owned, and that successor (which has
      // already read `readyMarkedRound === 0`) can proceed as a second winner.
      //
      // Under one lock hold the check and the removal cannot be interleaved,
      // so a token that no longer matches never reaches a removal at all. That
      // is the property here, and it is deterministic: replacing the token IS
      // the successor's reclaim, minus the timing.
      for (const cmd of ["commit-ready-mark", "release-ready-mark"]) {
        const d = stateDirFor(`ready-lease-generation-${cmd}`);
        const lease = join(d, "drive-pr-999.ready-claim");
        writeFileSync(lease, "successor-token");
        const r = await state(d, [
          cmd,
          "999",
          "--token",
          "the-dead-owners-token",
        ]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("not yours");
        // The successor's lease survives, and nothing was recorded on its behalf.
        expect(readFileSync(lease, "utf8")).toBe("successor-token");
        expect((await state(d, ["ready-marked", "999"])).stdout.trim()).toBe(
          "0",
        );
      }
    });

    it("refuses to renew a ready-mark lease that is no longer ours", async () => {
      // The dispatch-point guard: `renew-ready-mark` is what stands between a
      // suspended holder and a duplicate `ready_for_review`, so it has to
      // refuse a reclaimed lease rather than reset someone else's clock.
      const d = stateDirFor("ready-lease-renew");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "successor-token");
      const refused = await state(d, [
        "renew-ready-mark",
        "999",
        "--token",
        "the-suspended-owners-token",
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("no longer yours");
      expect(refused.stderr).toContain("Do NOT fire 'gh pr ready'");

      // And it DOES renew one that is still ours — the half that buys the full
      // staleness window for the outbound call.
      const old = new Date(Date.now() - 9 * 60 * 1000);
      utimesSync(lease, old, old);
      const ok = await state(d, [
        "renew-ready-mark",
        "999",
        "--token",
        "successor-token",
      ]);
      expect(ok.exitCode).toBe(0);
      expect(Date.now() - statSync(lease).mtimeMs).toBeLessThan(60_000);
    });

    it("refuses to renew into a window the configuration cannot cover", async () => {
      // The two knobs are independent and can contradict: a staleness window
      // shorter than one outbound call's deadline lets the lease become
      // reclaimable while the very `gh pr ready` it protects is still running
      //. A renewal cannot make the guarantee its own
      // comment claims under that configuration, so it refuses rather than
      // renewing into a window it cannot cover.
      const d = stateDirFor("ready-lease-window");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "our-token");
      const bad = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "1", GH_CALL_TIMEOUT: "120" },
      );
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("DRIVE_PR_CLAIM_STALE_MIN");
      expect(bad.stderr).toContain("GH_CALL_TIMEOUT");

      // The same lease renews fine once the two are consistent.
      const ok = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "10", GH_CALL_TIMEOUT: "30" },
      );
      expect(ok.exitCode).toBe(0);
    });

    it("accounts for the kill-escalation grace, not just $GH_CALL_TIMEOUT", async () => {
      // `ghCall` does not settle AT its deadline — it SIGTERMs there and waits
      // `KILL_ESCALATE_MS` (2000ms) more before force-killing and returning.
      // Comparing the staleness window only against the raw timeout let
      // `DRIVE_PR_CLAIM_STALE_MIN=1` (60s) pass against `GH_CALL_TIMEOUT=59`
      // (60 > 59), even though the protected call can still be in flight for
      // ~61s — reclaimable and running at once.
      const d = stateDirFor("ready-lease-window-escalation");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "our-token");
      const bad = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "1", GH_CALL_TIMEOUT: "59" },
      );
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("kill-escalation grace");

      // One second of margin past the grace is enough to pass.
      const ok = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "2", GH_CALL_TIMEOUT: "59" },
      );
      expect(ok.exitCode).toBe(0);
    });

    it("reset clears the ready-mark lease, which no claim sweep covers", async () => {
      // The lease deliberately sits outside `claimPrefix` so the held-batch
      // sweep never sees it — which meant reset's sweep never did either
      //. An operator resetting to unwedge a drive would get
      // a fresh JSON plus an orphaned lease that keeps reporting contention
      // for a full staleness window, with nothing left to explain why.
      const d = stateDirFor("reset-ready-lease");
      const lease = join(d, "drive-pr-999.ready-claim");
      await state(d, ["phase", "999", "--set", "probe"]);
      writeFileSync(lease, "an-abandoned-token");
      const r = await state(d, ["reset", "999"]);
      expect(r.exitCode).toBe(0);
      expect(existsSync(lease)).toBe(false);
      // And the very next claim succeeds rather than reporting contention.
      const claim = await state(d, ["claim-ready-mark", "999"]);
      expect(claim.stdout.trim().startsWith("claimed ")).toBe(true);
    });

    it("rejects a COUNTER that is negative or fractional, not merely non-numeric", async () => {
      // These fields are positions and sentinels, not arbitrary numbers, and
      // `typeof x === 'number'` accepted values no writer here can produce.
      // Tolerating them is not neutral: `readyMarkedRound: 0.5` is non-zero,
      // so every consumer reads it as "already marked" and the draft→Ready
      // transition is suppressed forever — while mark-ready.ts's own digits
      // check rejects the decimal point and exits 1, wedging the drive rather
      // than the field. Found on `readyMarkedRound`; fixed for the whole class,
      // which is what this enumerates.
      const base = {
        pr: 999,
        rounds: 0,
        lastCountedHead: "",
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
      };
      const fields = [
        "rounds",
        "attempts",
        "lastReflectedRound",
        "lastReflectedAttempts",
        "readyMarkedRound",
        // The escalation acknowledgment is the same construct with the same
        // invariant, so it joins the class rather than being trusted to be
        // different. A fractional or negative value here reads as
        // an acknowledgment position no writer can produce.
        "lastEscalatedRound",
      ];
      for (const field of fields) {
        for (const bad of [0.5, -1]) {
          const d = stateDirFor(`counter-${field}-${bad}`);
          writeFileSync(
            join(d, "drive-pr-999.json"),
            JSON.stringify({ ...base, [field]: bad }),
          );
          const r = await state(d, ["get", "999"]);
          expect(r.exitCode).not.toBe(0);
          expect(r.stderr).toContain("not usable drive state");
        }
      }
    });

    it("still accepts the UNCONFIRMED hold sentinel, which is deliberately -1", async () => {
      // The counter check above must not close over `hold --unconfirmed`,
      // whose whole mechanism is a round no `claim-held` can ever match
      //. -1 is a writer-produced value here where it is nowhere
      // else, so this is the boundary the class fix had to stop at — and a
      // probe for it, since nothing else in the suite would notice the day it
      // stopped being legal.
      const d = stateDirFor("held-unconfirmed-round");
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 3,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 0,
          ciHold: null,
          verifiedSha: "",
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_unconfirmed",
              kind: "thread",
              outcome: "accepted",
              round: -1,
              commentUrl: "https://example.invalid/c1",
              actor: await resolveActor(),
            },
          ],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("PRRT_unconfirmed");
    });

    it("rejects a malformed NESTED round — parked[].round and the ordinary held[].round branch, not just the top-level counters", async () => {
      // The top-level-counter test above never injects into parked[].round or
      // the ordinary held[].round branch — only the held[].round === -1
      // sentinel test above it does, and that one asserts the OPPOSITE
      // (accepted, not rejected). So removing `isCount(e.round)` for parked
      // entries, or weakening the held[].round integer/lower-bound check,
      // would not turn this suite red without a probe here.
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 3,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
      };
      const actor = await resolveActor();
      for (const bad of [0.5, -1]) {
        const d = stateDirFor(`parked-round-${bad}`);
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({
            ...base,
            parked: [
              { key: "PRRT_a", kind: "thread", reason: "x", round: bad },
            ],
            held: [],
          }),
        );
        const r = await state(d, ["get", "999"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("not usable drive state");
      }
      // held[].round's lower bound is -1 (the unconfirmed sentinel), not 0 —
      // so -2 is the value that actually probes it; -1 itself must NOT be
      // rejected here, or this test would just re-cover the sentinel test.
      for (const bad of [0.5, -2]) {
        const d = stateDirFor(`held-round-${bad}`);
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({
            ...base,
            parked: [],
            held: [
              {
                key: "PRRT_a",
                kind: "thread",
                outcome: "accepted",
                round: bad,
                commentUrl: "https://example.invalid/c1",
                actor,
              },
            ],
          }),
        );
        const r = await state(d, ["get", "999"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("not usable drive state");
      }
    });

    it("rejects a `finding` entry with an empty or missing reason", async () => {
      // `hold --kind finding` refuses to write one without a non-empty reason
      // (it is the verbatim text step 6 must send to
      // answer-summary-finding.ts), so a state file with a finding entry
      // that has none can only be hand-edited or corrupted — but the schema
      // has to actually say so, or step 6 is left with an outcome and
      // nothing to explain it. A `thread` entry needs no reason at all.
      const d = stateDirFor("held-finding-empty-reason");
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [],
      };
      for (const held of [
        [
          {
            key: "f00d",
            kind: "finding",
            outcome: "moot",
            round: 0,
            reason: "",
          },
        ],
        [{ key: "f00d", kind: "finding", outcome: "moot", round: 0 }],
      ]) {
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({ ...base, held }),
        );
        const r = await state(d, ["held-keys", "999"]);
        expect(r.exitCode).not.toBe(0);
      }
      // A thread entry with no `reason` key at all remains valid (but still
      // needs a commentUrl — required for kind: thread, see the sibling test
      // below).
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          ...base,
          held: [
            {
              key: "PRRT_a",
              kind: "thread",
              outcome: "accepted",
              round: 0,
              commentUrl: "https://example.invalid/x",
              actor: ACTOR,
            },
          ],
        }),
      );
      expect((await state(d, ["held-keys", "999"])).exitCode).toBe(0);
    });

    it("rejects a `thread` entry with an empty or missing commentUrl", async () => {
      // `hold` itself refuses to write a thread entry without --comment-url
      // (either path), so a state file with one that has an
      // empty or absent commentUrl can only be hand-edited, corrupted, or
      // written by an older version of this script — but the schema
      // has to actually say so, or a provenance-free confirmed hold remains
      // claimable, bypassing the exact-comment protection this state adds.
      const d = stateDirFor("held-thread-empty-commenturl");
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        verifiedSha: "",
        phase: "",
        parked: [],
      };
      for (const held of [
        [
          {
            key: "PRRT_a",
            kind: "thread",
            outcome: "accepted",
            round: 0,
            commentUrl: "",
          },
        ],
        [{ key: "PRRT_a", kind: "thread", outcome: "accepted", round: 0 }],
      ]) {
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({ ...base, held }),
        );
        const r = await state(d, ["held-keys", "999"]);
        expect(r.exitCode).not.toBe(0);
      }
    });
  });

  describe("atomic claim over the held batch", () => {
    // `hold`/`held`/`release-held` serialise the JSON, but say nothing about
    // who may DISPATCH the external mutation for a held item — that call
    // happens entirely outside this script, between reading `held` and
    // eventually releasing the key. Two concurrent drivers reading the same
    // snapshot could both decide to process the same item and both dispatch,
    // which is a duplicate, permanent GitHub comment for a `finding`
    // (`answer-summary-finding.ts` is not idempotent). `claim-held` is the
    // gate that makes only one of them allowed to dispatch.

    // Holds the finding AND stamps it with the push whose fix it is waiting on
    // — `claim-held --kind finding` now refuses a `--pushed-sha`
    // that is not the item's own. `stamp-held` runs AFTER the hold on purpose:
    // it stamps the batch as it stands, so an item held later is not
    // retroactively vouched for by an earlier push. Every test in this block is
    // about the MUTEX, so each one starts from a legitimately claimable item;
    // the provenance check has its own block below.
    async function hold(
      d: string,
      key: string,
      outcome: "accepted" | "moot" = "accepted",
    ) {
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          key,
          "--kind",
          "finding",
          "--outcome",
          outcome,
        ],
        {},
        "reason",
      );
      await state(d, ["stamp-held", "999", "--sha", HELD_PUSH]);
    }

    it("claims a held item and prints a token", async () => {
      const d = stateDirFor("claim-basic");
      await hold(d, "PRRT_a");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toBe("");
    });

    it("refuses to claim a key that is not (or no longer) in the held batch", async () => {
      const d = stateDirFor("claim-not-held");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_ghost",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain("not in the held batch");
    });

    it("a second claim on a LIVE claim is refused — the actual double-dispatch guard", async () => {
      const d = stateDirFor("claim-contended");
      await hold(d, "PRRT_a");
      const first = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(first.exitCode).toBe(0);
      const second = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("already claimed");
      // The first claimant's token is still the only valid one.
      await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        first.stdout,
      ]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("ONLY ONE of many concurrent claimants wins the same key", async () => {
      // The scripted version of the race this whole issue is about: several
      // processes read the same held snapshot and all try to claim the same
      // item at once. `claimCreate`'s atomic, `O_CREAT|O_EXCL` file
      // creation (see its own comment in lib/state/claims.ts) must let exactly
      // one through.
      //
      // An earlier version of `claimIsLive` judged a claim directory "torn"
      // (not yet live) until its owner marker existed, and broke a directory
      // it found in that state — so a second claimant racing the FIRST
      // claimant's own two-step create window saw a torn slot, broke it,
      // and both ended up with a valid token. Measured empirically at the
      // time: an 8-way race over 40 iterations produced 3 winners once.
      // Repeating the race several times here is what actually catches that
      // regression — a single iteration passed the overwhelming majority of
      // the time even with the bug present.
      for (let round = 0; round < 10; round++) {
        const d = stateDirFor(`claim-race-${round}`);
        await hold(d, "PRRT_a");
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_a",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        );
        const winners = results.filter((r) => r.exitCode === 0);
        expect(winners).toHaveLength(1);
        expect(results.filter((r) => r.exitCode === 1)).toHaveLength(7);
      }
    });

    it("two keys differing only by CASE produce claim files that stay distinct even if the filesystem folds case", async () => {
      // `claimKeyForPath` sanitises a key into a directory name, and the
      // sanitisation alone does not guarantee two distinct keys land on two
      // distinct paths: real thread ids and fingerprints already fit inside
      // the preserved character set, so the `tr` is close to a no-op — the
      // actual source of a collision is a case-insensitive volume (the
      // default on macOS, where these worktrees run), which folds two ids
      // differing only in the case of one character onto the SAME directory.
      // Measured against a real PR in this repo: 7 of 100 thread ids
      // collided that way. A checksum on the exact-case original is what
      // keeps them apart regardless of the filesystem's case sensitivity.
      //
      // This runner's OWN temp filesystem is whatever the host gives it —
      // case-INSENSITIVE on macOS, where these worktrees run, but
      // case-SENSITIVE on Linux CI. On a case-sensitive host, both claims
      // succeeding proves nothing: the raw, un-checksummed "safe" prefix
      // already differs by case there, so a regression that deleted the
      // checksum suffix entirely would still pass this test green on CI —
      // exactly the gap to close. Folding both real
      // filenames to lowercase HERE, in the assertion, reproduces the
      // case-insensitive collision deterministically on any host: it is
      // true if and only if the checksum suffix (not the case-foldable
      // prefix) is what keeps the two files apart, independent of what the
      // actual test-runner filesystem does with case.
      const d = stateDirFor("claim-case-collision");
      await hold(d, "PRRT_AbCdEf");
      await hold(d, "PRRT_ABCDEF");
      const first = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_AbCdEf",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const second = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_ABCDEF",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      // On this host's actual filesystem, both succeed regardless of case
      // sensitivity: a case-sensitive host never collided in the first
      // place, and a case-insensitive one is exactly what the checksum
      // suffix is there to survive.
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      const claimFiles = readdirSync(d).filter((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_"),
      );
      expect(claimFiles).toHaveLength(2);
      const folded = claimFiles.map((f) => f.toLowerCase());
      expect(folded[0]).not.toBe(folded[1]);
    });

    it("claim-held propagates a distinct exit when the state file is unusable", async () => {
      // Must NOT be conflated with "key not in held batch" (exit 4) — one is
      // "nothing to do, move on", the other is "stop, a human has to look at
      // this file". Mirrors read_state's own fail-closed contract elsewhere
      // in this script.
      const d = stateDirFor("claim-malformed-state");
      // A held batch must exist for claim-held to reach the locked read at all —
      // write it well-formed first, THEN corrupt it, so the failure being
      // tested is read_state's, not an earlier, unrelated one.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 0,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 0,
          ciHold: null,
          verifiedSha: "",
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_a",
              kind: "finding",
              outcome: "accepted",
              round: 0,
              reason: "reason",
              actor: ACTOR,
              verifiedSha: HELD_PUSH,
            },
          ],
        }),
      );
      writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(3);
      expect(r.exitCode).not.toBe(4);
      // The claim taken before the read failed must not be left dangling —
      // a fresh, well-formed state must still be able to claim the key.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 0,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 0,
          ciHold: null,
          verifiedSha: "",
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_a",
              kind: "finding",
              outcome: "accepted",
              round: 0,
              reason: "reason",
              actor: ACTOR,
              verifiedSha: HELD_PUSH,
            },
          ],
        }),
      );
      const retry = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(retry.exitCode).toBe(0);
    });

    it("release-held --key refuses without a token while the claim is LIVE", async () => {
      const d = stateDirFor("claim-release-no-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("has a live claim");
      // Untouched — still held, still claimed.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("release-held --key refuses a WRONG token", async () => {
      const d = stateDirFor("claim-release-wrong-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        "owner.not-the-real-one",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("has a live claim");
    });

    it("release-held --key with the RIGHT token succeeds and clears the claim too", async () => {
      const d = stateDirFor("claim-release-right-token");
      await hold(d, "PRRT_a");
      const claimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const released = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      expect(released.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("release-held --key with NO prior claim needs no token — the unaffected solo path", async () => {
      // Nobody ever called claim-held for this key, so there is nothing to
      // verify identity against — the older behaviour, unaffected.
      const d = stateDirFor("claim-release-legacy");
      await hold(d, "PRRT_a");
      const r = await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect(r.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("unclaim-held gives back a claim without touching the held batch", async () => {
      const d = stateDirFor("unclaim-basic");
      await hold(d, "PRRT_a");
      const claimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const unclaimed = await state(d, [
        "unclaim-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      expect(unclaimed.exitCode).toBe(0);
      // Still held — unclaim is not a release.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
      // And immediately reclaimable, unlike waiting out a staleness window.
      const reclaimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(reclaimed.exitCode).toBe(0);
      expect(reclaimed.stdout).not.toBe(claimed.stdout);
    });

    it("unclaim-held refuses a WRONG token", async () => {
      const d = stateDirFor("unclaim-wrong-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, [
        "unclaim-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        "not-the-real-token",
      ]);
      expect(r.exitCode).toBe(1);
      // The real claim is untouched — still contended for anyone else.
      const stillLive = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(stillLive.exitCode).toBe(1);
    });

    it("a STALE owner calling unclaim-held never deletes a FRESH reclaimer's file", async () => {
      // `unclaim-held` used to check the token and remove the claim file as
      // two SEPARATE, unlocked steps. An owner returning right at the edge of
      // the staleness window could pass its token check against its own
      // still-on-disk (but now stale) file, then have a DIFFERENT driver
      // legitimately break that SAME stale claim and create a fresh one for
      // itself in the gap before this call's own `removeClaimFile` ran —
      // deleting the FRESH claimant's file, not the one this caller ever
      // owned, and leaving a third driver free to claim the key while the
      // second still believed it held it exclusively. Firing the original
      // owner's `unclaim-held` at the same instant as several reclaimers,
      // repeated over several rounds, is what actually exercises that window
      // — a single iteration passes the overwhelming majority of the time
      // even with the bug present, exactly like the sibling stale-claim race
      // probe. Deliberately smaller than that sibling's 8x8 (4 rounds x 4-way
      // here vs. 8x8 there): `drive-pr-selftest`'s commit hook caps the WHOLE
      // suite at a fixed budget, and this test's subprocess count stacks on top
      // of every other race probe already in the file, not in isolation.
      for (let round = 0; round < 4; round++) {
        const d = stateDirFor(`unclaim-race-${round}`);
        await hold(d, "PRRT_a");
        const original = await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        expect(original.exitCode).toBe(0);
        const originalToken = original.stdout;
        const claimFile = readdirSync(d).find((f) =>
          f.startsWith("drive-pr-999.held-claim.PRRT_a."),
        );
        if (!claimFile) throw new Error("claim file was not created");
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
        // The original, now-stale owner tries to give the claim back at the
        // same instant several OTHER drivers see it as stale and race to
        // reclaim it.
        const [, ...reclaimResults] = await Promise.all([
          state(d, [
            "unclaim-held",
            "999",
            "--key",
            "PRRT_a",
            "--token",
            originalToken,
          ]),
          ...Array.from({ length: 4 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_a",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        ]);
        const winners = reclaimResults.filter((r) => r.exitCode === 0);
        // Exactly one reclaimer must win — not merely "at most one". Under
        // the old unlocked match-then-remove, the stale owner's
        // unclaim-held could delete a fresh claimant's file AFTER
        // claimCreate but BEFORE that claimant's own final ownership
        // check (claim-held's "prove OUR token is still the content
        // actually sitting at $path" step) — so the claimant then exits
        // non-zero too, every contender loses, winners.length is 0, and a
        // `<= 1` assertion would pass right through that exact failure
        // mode without ever reaching the recovery check below.
        expect(winners).toHaveLength(1);
        // A fresh, LIVE claim now exists. A further attempt on the same
        // key must be refused — proof the winner's file was NOT silently
        // deleted by the racing unclaim-held call.
        const after = await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        expect(after.exitCode).toBe(1);
      }
      // Real per-PR-lock contention (the state lock's own 1s sleep-and-retry
      // backoff, not mocked) is legitimately slower than bun's 5s default
      // under any nontrivial concurrent load, hence a wider budget than a
      // single round would need — kept smaller than the sibling 8x8 probe's
      // 90s since this test is 4x4.
    }, 45_000);

    it("a claim racing release-held --all observes the CLEAR, never a stale pre-clear snapshot", async () => {
      // `release-held --all` checks every held key for a live claim, clears
      // `.held = []`, and deletes each key's claim file — all inside ONE lock
      // hold. Before this fix, claim-held's own post-create membership
      // re-check was UNLOCKED, so a concurrent claim-held racing exactly this
      // window could read the PRE-clear snapshot (key still present), pass its
      // own membership check, and return a "valid" token for a key `--all`'s
      // cleanup was about to delete out from under it — the exact
      // duplicate-dispatch bug this whole primitive exists to prevent, just
      // reached one step earlier than the claim-file deletion itself. Locking
      // the re-check closes it: the concurrent claimant's decision is now
      // ordered against `--all`'s clear, so it either wins before `--all`'s OWN
      // contended check (which then refuses to proceed) or loses to the clear
      // (reads `.held = []`, exits 4) — never a token for a key that is being
      // wiped out from under it in the same instant.
      //
      // `$DRIVE_PR_RELEASE_ALL_TEST_DELAY` holds `--all` open inside its lock
      // exactly between its contended check and its clear landing, so the
      // claimant below is GUARANTEED to be deciding while the pre-clear
      // snapshot is still on disk rather than merely likely to be. (The bash
      // original got that window by shimming `mv` on PATH, which a
      // `renameSync` port cannot be stalled by — see `testDelaySeconds`.)
      const d = stateDirFor("claim-vs-release-all");
      await hold(d, "PRRT_a");
      const releaseAll = state(d, ["release-held", "999", "--all"], {
        DRIVE_PR_RELEASE_ALL_TEST_DELAY: "2",
      });
      await new Promise((r) => setTimeout(r, 500));
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect((await releaseAll).exitCode).toBe(0);
      // The concurrent claimant must NOT win a token for a key `--all` is
      // clearing in the same instant — it must observe the clear.
      expect(claim.exitCode).toBe(4);
      expect(claim.stdout).toBe("");
      // No orphaned claim file left behind on either side.
      expect(readdirSync(d).filter((f) => f.includes("held-claim"))).toEqual(
        [],
      );
    }, 15_000);

    it("release-held --all's post-clear cleanup never deletes a RE-HELD key's fresh claim", async () => {
      // `claimPathFor` is a pure function of the key STRING — it encodes no
      // generation. Before this fix, `--all` released its lock and only THEN
      // removed each old key's claim file. A concurrent driver could, in that
      // unlocked window, legitimately `hold` the SAME key again and
      // `claim-held` it (the clear-ordering lock only orders a claimant against
      // `--all`'s CLEAR, not against `--all`'s CLEANUP — a claimant reading the
      // already-cleared `.held` sees its OWN fresh hold and correctly gets a
      // token) — and `--all`'s unconditional path-based removal would then
      // delete that live claim out from under it. Fixed by moving the cleanup
      // inside the same lock hold, so no claim can be CONFIRMED while it runs.
      //
      // `$DRIVE_PR_RELEASE_ALL_CLEANUP_TEST_DELAY` stalls `--all` after the
      // clear has landed and before the cleanup, which is where the two shapes
      // diverge observably: with the cleanup inside the lock the re-`hold`
      // below cannot start until every file is already gone, and with it
      // outside the lock the re-hold and its claim land first and the stalled
      // cleanup carries the fresh claim off.
      const d = stateDirFor("release-all-vs-rehold");
      await hold(d, "PRRT_a");
      const releaseAll = state(d, ["release-held", "999", "--all"], {
        DRIVE_PR_RELEASE_ALL_CLEANUP_TEST_DELAY: "2",
      });
      await new Promise((r) => setTimeout(r, 500));
      await hold(d, "PRRT_a");
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect((await releaseAll).exitCode).toBe(0);
      // The re-held key must be claimable, and the claim must survive — proof
      // `--all`'s cleanup did not carry off this fresh generation.
      expect(claim.exitCode).toBe(0);
      expect(claim.stdout).not.toBe("");
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_a."),
      );
      if (!claimFile) throw new Error("the fresh claim file was deleted");
      expect(readFileSync(join(d, claimFile), "utf8")).toBe(claim.stdout);
    }, 15_000);

    it("an ABANDONED claim is reclaimable after the staleness window, like the per-PR lock", async () => {
      const d = stateDirFor("claim-stale");
      await hold(d, "PRRT_a");
      // A negative staleness value no longer produces an instantly-stale claim
      // (drive-state.ts now clamps/validates DRIVE_PR_CLAIM_STALE_MIN — an
      // invalid value falls back to the default rather than making every
      // claim reclaimable immediately). Use the safe minimum instead and
      // backdate the claim file's mtime past it, the same technique the
      // concurrent-race probe below uses.
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "1" };
      const first = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(first.exitCode).toBe(0);
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_a."),
      );
      if (!claimFile) throw new Error("claim file was not created");
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      utimesSync(join(d, claimFile), twoMinutesAgo, twoMinutesAgo);
      const second = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stdout).not.toBe(first.stdout);
      expect(second.stderr).toContain("broke an abandoned claim");
    });

    it("DRIVE_PR_CLAIM_STALE_MIN is validated — a negative/non-numeric value falls back to the default rather than making every claim instantly stale", async () => {
      const d = stateDirFor("claim-stale-invalid-env");
      await hold(d, "PRRT_a");
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "-1" };
      const first = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(first.exitCode).toBe(0);
      // A second claim attempt right away must NOT succeed — if -1 were
      // honoured verbatim, the claim just created would already read as
      // stale and lose its exclusivity immediately.
      const second = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("is not a non-negative integer");
    });

    it("DRIVE_PR_CLAIM_STALE_MIN rejects a digit-only value too large to compare exactly", async () => {
      // A value that IS all-digits can still be far outside the range any
      // comparison handles exactly — this one parses to a float well past
      // `Number.MAX_SAFE_INTEGER`. The bash original's `[ "$v" -gt 1440 ]`
      // failed outright on it with "integer expression expected", an exit
      // `if` reads as simply "not true" — the SAME outcome as a legitimate
      // in-range value — so NEITHER clamp branch fired and the astronomical
      // original flowed straight through unclamped, making an abandoned claim
      // un-reclaimable for an effectively unbounded period instead of the
      // documented 24h maximum. Rejecting on digit COUNT, before any
      // comparison sees the value, is what closes that in either language.
      const d = stateDirFor("claim-stale-overflow-env");
      await hold(d, "PRRT_a");
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "99999999999999999999" };
      const first = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(first.exitCode).toBe(0);
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_a."),
      );
      if (!claimFile) throw new Error("claim file was not created");
      // Backdate past the DEFAULT staleness window (10m) but nowhere near
      // the bogus value — if the overflow bypassed the clamp, this claim
      // would still read as live and reclamation would fail (exit 1).
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
      const second = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toContain("too many digits to compare safely");
    });

    it("EXACTLY ONE of many concurrent claimants wins a genuinely STALE claim — no double-winner, ever", async () => {
      // The deep regression probe. 8 rounds x 8-way REAL per-PR-lock
      // contention (the state lock's own sleep-and-retry backoff, compressed
      // to 25ms by the suite-wide DRIVE_PR_LOCK_RETRY_MS but never mocked)
      // is legitimately slower than the file's 30s default under
      // any nontrivial concurrent load — a wider timeout here, not a wider
      // suite-wide default. Every earlier shape of this mechanism
      // passed the simple "many claimants race an UNCLAIMED key" test above
      // and still let two claimants win when the contested item was a real,
      // backdated-past-the-staleness-window claim instead: the two-step
      // "win a slot, then separately write an identity marker inside it"
      // protocol left a window where one claimant's identity-write could
      // land inside a DIFFERENT claimant's directory generation once enough
      // concurrent break-and-recreate cycles were in flight — reproduced
      // empirically at 3/40, then 10/50 (worse) after a naive verify-before-
      // destroy fix, then ~20/150 after removing the destructive restore
      // entirely. None of those patches touched the actual defect. Only
      // replacing the two-step create with ONE atomic `O_CREAT|O_EXCL`
      // write (see claimCreate's own comment in lib/state/claims.ts) closed it:
      // 0/200 over the same probe.
      //
      // What this probe pins is the PROTOCOL-level property: exactly one
      // winner over a stale claim, whatever the interleaving. What it can
      // NOT be relied on to catch is a regression of `claimCreate` itself
      // back to a check-then-write pair — measured directly (
      // 2026-08-15): a statSync-then-write mutation of claimCreate PASSED
      // this probe, because the finding path's final locked
      // `claimTokenMatches` verify serialises the win decision, so a
      // non-atomic create only double-wins in a µs-scale interleave that
      // scheduling almost never reaches (the losers arrive a whole lock-poll
      // interval after the breaker's re-create). The create's SHAPE is
      // pinned deterministically by the `claimCreate is one atomic …` test
      // right below instead; this probe stays as the end-to-end guard over
      // the protocol around it.
      for (let round = 0; round < 8; round++) {
        const d = stateDirFor(`claim-stale-race-${round}`);
        await hold(d, "PRRT_stale");
        await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_stale",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        const claimFile = readdirSync(d).find((f) =>
          f.startsWith("drive-pr-999.held-claim.PRRT_stale."),
        );
        if (!claimFile) throw new Error("claim file was not created");
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_stale",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        );
        const winners = results.filter((r) => r.exitCode === 0);
        expect(winners).toHaveLength(1);
      }
    }, 90_000);

    it("claimCreate is one atomic O_CREAT|O_EXCL syscall — shape pinned verbatim", () => {
      // The stale-race probe above cannot be relied on to redden when
      // claimCreate regresses to a check-then-write pair (see its comment:
      // the mutation was run, and passed). No schedule-based probe can pin a
      // µs-scale window deterministically, so the atomicity that the whole
      // claim mechanism rests on is pinned verbatim (parse or pin). A
      // legitimate refactor of claimCreate must update this pin consciously —
      // that friction is the point, the same trade EXPECTED_RUN_LINES makes in
      // ci-activation.test.ts.
      const src = readFileSync(
        join(SCRIPTS, "lib", "state", "claims.ts"),
        "utf8",
      );
      // Population check first (rule 1): exactly one claimCreate exists, so
      // a rename or duplicate cannot let the verbatim pin match a decoy.
      expect(src.split("export function claimCreate(").length).toBe(2);
      expect(src).toContain(
        `export function claimCreate(path: string, token: string): boolean {
  try {
    writeFileSync(path, token, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}`,
      );
      // The pin above is a claim about the FILE. On its own it says nothing
      // about which function the `claimCreate` export is actually bound to
      //: the pinned text can sit in the file
      // untouched while the executable export is something else — declared in
      // another form, re-bound, or re-exported from elsewhere — and every
      // assertion so far still passes.
      //
      // So assert against the EXECUTABLE. `Function.prototype.toString()`
      // returns the source of the function object this module actually
      // exported, which no amount of decoy text elsewhere in the file can
      // forge. Read from the imported binding at the top of this file, i.e.
      // the same symbol production callers get.
      //
      // Matched semantically rather than byte-for-byte because toString()
      // yields bun's TRANSPILED form (types stripped, `true` -> `!0`, quote
      // style normalized) — pinning that verbatim would redden on a bun
      // upgrade while proving nothing extra. What is asserted is exactly what
      // distinguishes atomic from check-then-write.
      const executable = claimCreate.toString();
      // The atomic create: `wx` fails when the path exists, in ONE syscall.
      expect(executable).toMatch(/flag:\s*['"]wx['"]/);
      // ...and no separate existence probe, which is the regression this
      // whole pin exists to catch — a check-then-write pair has a window
      // between the check and the write that two claimants both pass.
      expect(executable).not.toMatch(/existsSync|readFileSync|statSync/);

      // Behavioral half — refusing an existing claim must never truncate or
      // overwrite it. (A check-then-write mutation also passes THIS half,
      // which is why the pins above are the load-bearing guard.)
      const d = stateDirFor("claim-create-atomic");
      const path = join(d, "claim-pin");
      writeFileSync(path, "incumbent");
      expect(claimCreate(path, "challenger")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("incumbent");
    });

    it("release-held --all refuses while ANY held item still has a live claim", async () => {
      const d = stateDirFor("claim-all-refuses");
      await hold(d, "PRRT_a");
      await hold(d, "PRRT_b");
      const claimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("LIVE claim");
      // Nothing was cleared — not even the uncontended PRRT_b.
      expect((await state(d, ["held-keys", "999"])).stdout.split("\n")).toEqual(
        ["PRRT_a", "PRRT_b"],
      );
      // Once the live claim is released, --all proceeds as normal.
      await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      const all = await state(d, ["release-held", "999", "--all"]);
      expect(all.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("release-held --all with no claims at all is unaffected — the no-contention path", async () => {
      const d = stateDirFor("claim-all-unaffected");
      await hold(d, "PRRT_a");
      await hold(d, "PRRT_b");
      const r = await state(d, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });
  });

  describe("claim-held — atomic compare-and-delete", () => {
    // resolve-held-thread.ts used to read `held` and `rounds` as two separate,
    // unlocked calls and only decide afterwards whether to resolve — a window
    // in which a concurrent driver could change either. `claim-held --kind
    // thread` folds the whole predicate (kind, round, verifiedSha) and the
    // removal into ONE lock hold, so these probes exercise it directly —
    // including a forced concurrent overlap, since sequential calls prove
    // nothing about the mutex itself.

    it("removes a matching held thread and returns it", async () => {
      const d = stateDirFor("claim-happy");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-9",
      ]);
      // AFTER the hold, which is the order SKILL.md § 6 prescribes and, since
      // an earlier change, the order the mechanism requires: `stamp-held` stamps the
      // batch as it stands, so a hold made later is not vouched for by a push
      // that predates the promise it represents.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(0);
      // The whole item, including the provenance `restore-held` demands back
      // verbatim if the mutation that follows a claim fails.
      expect(JSON.parse(r.stdout)).toEqual({
        key: "PRRT_a",
        kind: "thread",
        outcome: "accepted",
        round: 1,
        commentUrl: "https://example.invalid/synthetic-comment-9",
        actor: ACTOR,
        verifiedSha: "ffffffffffffffffffffffffffffffffffffffff",
      });
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("a SECOND claim on the same key fails — proven with a FORCED concurrent overlap", async () => {
      // Two calls merely launched close together race real process-scheduling
      // jitter — on a fast/idle machine the first can finish entirely before
      // the second even starts its own `mkdir`, so a bug that dropped the
      // lock ENTIRELY would still pass a "launch both, await both" test (the
      // gap a sequential-await version of this test leaves). Proving the mutex
      // itself needs a deterministically FORCED overlap: process A signals the
      // instant it holds the lock, this test waits for that signal before
      // starting process B, and A is told to hold the lock open for another
      // 500ms — so B's `mkdir` is guaranteed to contend for a lock A still
      // holds, not merely scheduled near it.
      const d = stateDirFor("claim-race");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-10",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);

      const signal = join(d, "a-is-holding");
      const claimArgs = [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ];
      // Started but NOT awaited yet — this must run concurrently with B, not
      // resolve before B is even spawned.
      const firstPromise = state(d, claimArgs, {
        DRIVE_PR_CLAIM_HELD_TEST_SIGNAL: signal,
        DRIVE_PR_CLAIM_HELD_TEST_DELAY: "0.5",
      });

      const deadline = Date.now() + 5000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) {
          throw new Error(
            "process A never signalled that it was holding the lock",
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      // A is now DEFINITELY holding the lock and will for another ~0.5s — B's
      // own acquire_lock call below is forced to wait on A's mkdir, exercising
      // the real contention path rather than an accident of ordering.
      const second = await state(d, claimArgs);
      const first = await firstPromise;

      expect(first.exitCode).toBe(0);
      // Exit 4, not 1: "no held item at all" is the snapshot going stale — B
      // lost the race, and A's claim is why the key is gone — not a property
      // of B's own round/SHA the way exit 1 is reserved for.
      expect(second.exitCode).toBe(4);
      expect(second.stderr).toContain("no held item with key 'PRRT_a'");
    });

    it("refuses — without removing anything — when the pushed SHA is not the one recorded against this hold, even though the round matches", async () => {
      // The exact bypass: an unrelated push lands without
      // ever going through a counting drive-status.ts gate, so `.rounds` never
      // advances and a round-only comparison would read this as a match. The
      // stamp is written by exactly one call site (`stamp-held`, from a real
      // guarded push), so it stays stale here and the claim must refuse.
      const d = stateDirFor("claim-sha-mismatch");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-11",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "unrelated-push-sha",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
      // Names the stamp it DID find, not just that something mismatched — a
      // refusal a reader cannot act on sends them to the state file by hand.
      expect(r.stderr).toContain("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
      // Refused, not consumed — a legitimate retry with the right SHA must
      // still find it.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses a hold whose own driver has not pushed at all, even when the PR-GLOBAL verifiedSha matches", async () => {
      // The single-driver shadow of the cross-driver bug, and the cheapest
      // possible proof that the check moved off `state.verifiedSha`: the
      // PR-global field says this exact SHA was green-verified, the round
      // matches, and the claim must STILL refuse — because the hold was made
      // after that push, so nothing has yet vouched for the fix IT promises.
      const d = stateDirFor("claim-global-sha-not-enough");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const statePath = join(d, "drive-pr-999.json");
      const seeded = JSON.parse(readFileSync(statePath, "utf8"));
      seeded.verifiedSha = "ffffffffffffffffffffffffffffffffffffffff";
      writeFileSync(statePath, JSON.stringify(seeded));
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-11b",
      ]);
      expect((await state(d, ["verified", "999"])).stdout.trim()).toBe(
        "ffffffffffffffffffffffffffffffffffffffff",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses on a round mismatch before ever checking verifiedSha", async () => {
      const d = stateDirFor("claim-round-mismatch");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-12",
      ]);
      await state(d, ["bump-round", "999", "--head", "bbb"]);
      // A NEW push also satisfies verifiedSha, so only the round check can be
      // what refuses this.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("held in round 1");
      expect(r.stderr).toContain("round is 2");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("preserves a held FINDING's stamp while its claim is outstanding — a later, unrelated push from the SAME actor must not risk a duplicate answer", async () => {
      // The interrupted-dispatch scenario the finding describes: this actor
      // claims a finding (right before dispatching `answer-summary-
      // finding.ts`, per SKILL.md § 6) — which locks it with a SEPARATE
      // claim FILE rather than removing it from `held` — the dispatch POSTs
      // successfully, and the process dies before `release-held`. The claim
      // file is still there; nothing removed it. This SAME working tree
      // later pushes UNRELATED work and calls `stamp-held` again. Blindly
      // advancing the stamp would let a later `claim-held --pushed-sha
      // SHA_NEW` accept an entry whose actual posted marker sits at SHA_OLD,
      // and `--check-addressed --marker-sha SHA_NEW` would miss it and
      // dispatch a duplicate.
      const SHA_OLD = "3333333333333333333333333333333333333333";
      const SHA_NEW = "4444444444444444444444444444444444444444";
      const d = stateDirFor("stamp-held-preserves-outstanding-finding-claim");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dfeed",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      // The push that carries this finding's own promised fix.
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);

      // Claim it, exactly as a real dispatch pass would right before calling
      // `answer-summary-finding.ts` — this leaves a claim file on disk
      // WITHOUT removing the entry from `held` (unlike a thread's claim).
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dfeed",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);

      // This SAME actor pushes unrelated work and records it — "the process
      // died here" without ever calling release-held.
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);

      // The outstanding claim's stamp must survive untouched.
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);
    });

    it("advances an UNCLAIMED held item's stamp on a later push from the same actor — an ordinary pending hold must not wedge, on both a thread AND an unclaimed finding", async () => {
      // The counterweight to the fix above: preserving EVERY held item's
      // stamp unconditionally would strand ordinary pending/restored holds
      // the moment their frozen SHA stops being the PR's live head, since a
      // later verified push is normally a descendant commit that still
      // contains the fix. Only a FINDING with an outstanding claim (the test
      // above) has a real duplicate-dispatch risk to protect against.
      //
      // A version of this test that only constructed a THREAD — which never
      // touches the finding-only `existsSync( claimPathFor(...))` branch at all
      // (a thread's claim always removes it from `held` atomically, so this
      // whole code path is unreachable for one), so it never actually proved an
      // UNCLAIMED finding advances. A mutation that preserved every finding's
      // old stamp unconditionally would have left this test green. Both kinds
      // are constructed below.
      const SHA_OLD = "7777777777777777777777777777777777777777";
      const SHA_NEW = "8888888888888888888888888888888888888888";
      const d = stateDirFor("stamp-held-advances-unclaimed-hold");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_pending",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/pending-reply",
      ]);
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dpending",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in def5678",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const byKey = async () => {
        const items = JSON.parse((await state(d, ["held", "999"])).stdout);
        return Object.fromEntries(
          items.map((h: { key: string }) => [h.key, h]),
        );
      };
      expect((await byKey()).PRRT_pending).toMatchObject({
        verifiedSha: SHA_OLD,
      });
      expect((await byKey()).f00dpending).toMatchObject({
        verifiedSha: SHA_OLD,
      });

      // A later push, still unclaimed on BOTH — must ADVANCE, not freeze:
      // nothing has dispatched against either yet, so there is nothing to
      // protect, and freezing it would wedge it the moment SHA_OLD stops
      // being the live head.
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);
      expect((await byKey()).PRRT_pending).toMatchObject({
        verifiedSha: SHA_NEW,
      });
      expect((await byKey()).f00dpending).toMatchObject({
        verifiedSha: SHA_NEW,
      });

      const threadClaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_pending",
        "--kind",
        "thread",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(threadClaim.exitCode).toBe(0);

      const findingClaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dpending",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(findingClaim.exitCode).toBe(0);
    });

    it("refuses a held FINDING — claim-held --kind thread is thread-only", async () => {
      const d = stateDirFor("claim-kind");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "moot",
        ],
        {},
        "no longer applies",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "thread",
        "--pushed-sha",
        "fff",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("is a held 'finding', not a 'thread'");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("f00d");
    });

    it("requires --key, --kind and --pushed-sha", async () => {
      const d = stateDirFor("claim-usage");
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--kind",
            "thread",
            "--pushed-sha",
            "fff",
          ])
        ).exitCode,
      ).toBe(2);
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_a",
            "--kind",
            "thread",
          ])
        ).exitCode,
      ).toBe(2);
      expect(
        (await state(d, ["claim-held", "999", "--key", "PRRT_a"])).exitCode,
      ).toBe(2);
    });
  });

  describe("per-hold push provenance across drivers", () => {
    // an earlier change tied a held thread's resolve to `.verifiedSha` — but that is ONE
    // PR-global field in a state file every driver of the PR shares (store.ts
    // puts it in the clone-wide git dir precisely so they do). So whichever
    // driver pushed last moved it, and it then vouched for every held item on
    // the PR, including ones whose promised fix that push never contained.
    //
    // These probes run TWO REAL WORKTREES of one clone — the Conductor
    // topology the bug lives in, and the only way to exercise the actor
    // derivation rather than a stand-in for it (it is deliberately not
    // overridable; see lib/state/actor.ts).
    //
    // They run at ladder tier 3 (no session identity — `twoDrivers` pins both
    // variables empty) and HAND THE PR OVER between turns, which is the shape
    // the state these probes need is actually reachable in: two actors' holds
    // in one file, one of them unstamped. The gate decides who may drive NOW;
    // provenance decides whose push answers a promise made EARLIER, and those
    // two never answer the same question — a hold outlives the tree that made
    // it, which is why the second half survives the first. `two actors' holds
    // coexist by TAKEOVER, not by concurrency` below builds the same state
    // through a session-identified takeover, so neither route is the sole
    // evidence.
    //
    // Tier 3 used to reach it by CONCURRENCY instead — no lease either side,
    // so both trees simply mutated. That was the hole (two sessionless
    // resolvers), not a licence, and closing it
    // is what made these hand-overs necessary rather than incidental.

    const A_PUSH = "1111111111111111111111111111111111111111";
    const B_PUSH = "2222222222222222222222222222222222222222";

    /**
     * Tree `t` stops driving this PR, so another tree may be admitted.
     *
     * Explicit because a tier-3 holder has no pid whose death could say it
     *: a session lease clears when its process goes, a tree-held
     * record clears only by `clear-lease` or by the staleness window, and a
     * window measured in hours is not something a probe can wait out. So the
     * hand-over is stated. It drops the LEASE only — every hold stays exactly
     * where it was, which is the premise all three probes below are built on.
     */
    function handOver(t: string, env: Record<string, string>): void {
      const r = drive(t, env, ["clear-lease", "999"]);
      // Asserted rather than fired and forgotten: if this ever stopped working,
      // the next command would be refused with 13 and the probe would fail
      // somewhere unrelated to its subject.
      expect({ code: r.exitCode, stderr: r.stderr }).toMatchObject({ code: 0 });
    }

    it("refuses to resolve driver A's held thread against driver B's unrelated push — the acceptance probe", async () => {
      const { a, b, env } = twoDrivers("provenance-cross-resolve");
      // Round 1. Driver A triages, replies `**accepted**`, holds — and then
      // stalls before pushing its own fix.
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(a, env, [
        "hold",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/driver-a-reply",
      ]);
      // Driver A stops driving; driver B picks the PR up from its own worktree,
      // finishes unrelated work and pushes. No counting drive-status gate runs
      // (SKILL.md § 6's own post-push wait passes --no-count), so `.rounds`
      // does not move either.
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);
      // And hands back, so A's retry below is an admitted command rather than
      // a refusal at the gate — which would pass this probe for the wrong
      // reason, never reaching the provenance check it is about.
      handOver(b, env);

      // The round is unchanged, while the intermediate push deliberately does
      // not advance the final-CI-only PR-global pointer.
      expect(drive(a, env, ["rounds", "999"]).stdout.trim()).toBe("1");
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");

      // A's worktree later syncs to that head and retries.
      const claim = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--pushed-sha",
        B_PUSH,
      ]);
      expect(claim.exitCode).toBe(1);
      expect(claim.stderr).toContain("is not the push recorded against");
      // Refused, not consumed: the reply still stands and the item is still
      // there for the push that actually carries its fix.
      expect(drive(a, env, ["held-keys", "999"]).stdout.trim()).toBe("PRRT_x");

      // And the legitimate path still works, so this is a real gate rather
      // than a wedge: once A itself pushes and records it, the same claim
      // succeeds.
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      const ok = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(drive(a, env, ["held-keys", "999"]).stdout.trim()).toBe("");
    });

    it("stamp-held stamps only the caller's OWN holds, and the two drivers get distinct actors", async () => {
      // The state-level statement of the same property, and the one that shows
      // WHY the claim above refuses: two `stamp-held` calls from different
      // actors against one shared batch must leave two differently-stamped
      // items, not one pointer both read.
      const { a, b, env } = twoDrivers("provenance-scoped-stamp");
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(a, env, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/a-reply",
      ]);
      handOver(a, env);
      drive(b, env, [
        "hold",
        "999",
        "--key",
        "PRRT_b",
        "--kind",
        "thread",
        "--outcome",
        "moot",
        "--comment-url",
        "https://example.invalid/b-reply",
      ]);
      handOver(b, env);
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);

      const held: Array<{
        key: string;
        actor: string;
        verifiedSha?: string;
      }> = JSON.parse(drive(a, env, ["held", "999"]).stdout);
      const byKey = Object.fromEntries(held.map((h) => [h.key, h]));
      expect(byKey.PRRT_a?.verifiedSha).toBe(A_PUSH);
      expect(byKey.PRRT_b?.verifiedSha).toBe(B_PUSH);
      // Two worktrees, two identities — derived from the tree, so this is the
      // real mechanism and not a value the test handed the script.
      expect(byKey.PRRT_a?.actor).not.toBe(byKey.PRRT_b?.actor);
      // Intermediate pushes cannot move the final-CI-only PR-global pointer.
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");
    });

    it("refuses driver A's held FINDING against driver B's push too — the same defect, the more dangerous kind", async () => {
      // A finding needed this more than a thread did, not less:
      // `answer-summary-finding.ts` checks only that --pushed-sha is the PR's
      // live head and a clean local HEAD, which a concurrent driver's push
      // satisfies perfectly — and its dispatch is NOT idempotent, so a wrong
      // answer is a permanent, standing claim on the PR.
      const { a, b, env } = twoDrivers("provenance-cross-finding");
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(
        a,
        env,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        "fixed the thing A promised",
      );
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);
      handOver(b, env);
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");

      const claim = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--pushed-sha",
        B_PUSH,
      ]);
      expect(claim.exitCode).toBe(1);
      expect(claim.stderr).toContain("is not the push recorded against");
      // The mutex must be given back on this path, not left holding the key:
      // a refusal that leaked its claim file would block the legitimate claim
      // below for a whole staleness window.
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      const ok = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).not.toBe("");
    });

    it("two actors' holds coexist by TAKEOVER, not by concurrency", async () => {
      // The reachability argument for the tier-3 probes above, run for real.
      //
      // After an earlier change two worktrees cannot drive one PR at the same time — so
      // if that were the only way two actors' holds could land in one state
      // file, per-hold provenance would be guarding an impossible state and
      // could be deleted. It is not. A hold deliberately OUTLIVES its driver
      // (SKILL.md § 6), so the state arrives sequentially: A holds and its
      // session dies, B is admitted precisely because A's lease is no longer
      // live, and A's unstamped promise is still sitting there for B's
      // `stamp-held` to wrongly vouch for. Both mechanisms are load-bearing
      // at once, and this is the probe that says so.
      const { a, b, env } = twoDrivers("provenance-after-takeover");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };

        drive(a, ea, ["bump-round", "999", "--head", "aaa"]);
        drive(a, ea, [
          "hold",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/driver-a-reply",
        ]);
        // B is refused while A is live — the control, so the takeover below is
        // a takeover rather than a gate that never fired.
        expect(
          drive(b, eb, ["stamp-held", "999", "--sha", B_PUSH]).exitCode,
        ).toBe(13);

        // A's session dies. Its HOLD survives, which is the whole premise.
        sessionA.stop();
        await awaitPidGone(sessionA.pid);
        expect(drive(b, eb, ["held-keys", "999"]).stdout.trim()).toBe("PRRT_x");

        // B is now legitimately admitted, and pushes unrelated work.
        expect(
          drive(b, eb, ["stamp-held", "999", "--sha", B_PUSH]).exitCode,
        ).toBe(0);
        expect(drive(b, eb, ["verified", "999"]).stdout.trim()).toBe("");

        // B's push must NOT have vouched for A's stranded promise: the stamp
        // is per-hold and scoped to the calling tree, so A's item is still
        // unstamped and B may not resolve it on this SHA.
        const held: Array<{ key: string; verifiedSha?: string }> = JSON.parse(
          drive(b, eb, ["held", "999"]).stdout,
        );
        expect(held).toHaveLength(1);
        expect(held[0]?.verifiedSha).toBeUndefined();
        const claim = drive(b, eb, [
          "claim-held",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--pushed-sha",
          B_PUSH,
        ]);
        expect(claim.exitCode).toBe(1);
        expect(claim.stderr).toContain("is not the push recorded against");
      } finally {
        sessionA.stop();
      }
    });

    it("a claim of a held finding without --pushed-sha is a usage error, not a mutex-only claim", async () => {
      // The check is worthless if the flag carrying it is optional — a caller
      // that omits it would silently get the old, unguarded behaviour.
      const d = stateDirFor("provenance-finding-requires-sha");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "moot",
        ],
        {},
        "reason",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("requires --pushed-sha");
      // And it refused BEFORE taking the mutex — a usage error that left a
      // claim file behind would block the corrected retry.
      expect(
        readdirSync(d).filter((f) => f.includes("held-claim")),
      ).toHaveLength(0);
    });

    it("re-holding a key CLEARS its stamp, so an earlier push cannot answer a later promise", async () => {
      // The ordering hold → push → resolve, made structural. A reply posted
      // now promises a fix that is not pushed yet by definition, so the only
      // push that may answer it is a later one; carrying a previous hold's
      // stamp forward would let this reply inherit provenance from a push that
      // predates the promise it makes.
      const d = stateDirFor("provenance-rehold-clears");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/first-reply",
      ]);
      await state(d, ["stamp-held", "999", "--sha", A_PUSH]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout)[0].verifiedSha,
      ).toBe(A_PUSH);

      // Step 3 of a later pass re-holds the same key against a NEW reply.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/second-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout)[0].verifiedSha,
      ).toBeUndefined();
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
    });

    it("restore-held demands the provenance back verbatim rather than re-deriving it", async () => {
      // Re-deriving the actor would stamp the RESTORING tree, which is the same
      // tree on every path that exists today — and would hand one driver's hold
      // to another the first time it is not, which is the cross-resolve this
      // whole mechanism exists to prevent.
      const d = stateDirFor("provenance-restore-required");
      const base = [
        "restore-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--round",
        "0",
        "--comment-url",
        "https://example.invalid/restored",
      ];
      const noActor = await state(d, [...base, "--verified-sha", A_PUSH]);
      expect(noActor.exitCode).toBe(2);
      expect(noActor.stderr).toContain("requires --actor");

      const noSha = await state(d, [...base, "--actor", ACTOR]);
      expect(noSha.exitCode).toBe(2);
      expect(noSha.stderr).toContain("requires --verified-sha");

      // The exact `claim-held`-printed shape is required, not merely
      // "no newline" — a hand-composed value that names a DIFFERENT worktree,
      // or that carries a backtick/pipe rather than a newline, is just as
      // dangerous: the former lets that worktree's `stamp-held` vouch for
      // this hold, and the latter breaks the handoff's markdown table (both
      // fields render inside backtick code spans) exactly as a newline would
      // split its row.
      for (const [flag, value] of [
        ["--actor", `${ACTOR}\nwt-someone-else`],
        ["--verified-sha", `${A_PUSH}\r| forged | row |`],
        // No newline at all — the class the CR/LF-only check used to miss.
        ["--actor", "wt-aaaaaaaaaaaaaaaa|forged"],
        ["--verified-sha", `${A_PUSH}\`| forged |`],
      ] as const) {
        const args = [...base, "--actor", ACTOR, "--verified-sha", A_PUSH];
        args[args.indexOf(flag) + 1] = value;
        const bad = await state(d, args);
        expect({ flag, exit: bad.exitCode }).toEqual({ flag, exit: 2 });
        expect(bad.stderr).toContain(`restore-held: ${flag} must be`);
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");

      const ok = await state(d, [
        ...base,
        "--actor",
        ACTOR,
        "--verified-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/restored",
          actor: ACTOR,
          verifiedSha: A_PUSH,
        },
      ]);
    });

    it("refuses a held entry with no actor at all, rather than reading it as unowned", async () => {
      // A hand-edited or older file. An unattributable hold is one
      // `stamp-held` has no basis to skip, so tolerating it would mean
      // falling back to vouching for everything — the PR-global behaviour this
      // closes. Backward compatibility is deferred pre-GA, so the file is
      // refused, never silently migrated.
      const d = stateDirFor("provenance-actorless-refused");
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 1,
          lastCountedHead: "aaa",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          verifiedSha: A_PUSH,
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_a",
              kind: "thread",
              outcome: "accepted",
              round: 1,
              commentUrl: "https://example.invalid/legacy",
            },
          ],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toBe("");
    });

    it("re-holding a FINDING breaks its own STALE claim file, so the fresh record is stampable again", async () => {
      // The gap: `hold` inserts a fresh `.held` record
      // carrying no `verifiedSha`, but a finding's claim is a SEPARATE
      // filesystem file `hold` never touched — so a prior dispatch's claim
      // file, left behind by the interrupted-dispatch scenario the test above
      // covers, would make `stamp-held`'s own
      // `existsSync(claimPathFor(...))` check refuse to stamp the fresh
      // record forever, defeating the "re-hold via SKILL.md § 3" recovery
      // this command exists to provide.
      const SHA_OLD = "5555555555555555555555555555555555555555";
      const SHA_NEW = "6666666666666666666666666666666666666666";
      const d = stateDirFor("rehold-finding-breaks-stale-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dstale",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dstale",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      // The dispatch "died" here without releasing — the claim file is left
      // on disk, backdated past the staleness window (matching every other
      // stale-claim probe in this file).
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.f00dstale."),
      );
      if (!claimFile) throw new Error("claim file was not created");
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);

      // Re-hold, per SKILL.md § 3 — this must break the now-stale claim file
      // as part of creating the fresh record.
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dstale",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "confirmed fixed in def5678",
      );
      expect(existsSync(join(d, claimFile))).toBe(false);

      // The push that carries the RE-held promise now stamps successfully...
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dstale", verifiedSha: SHA_NEW }]);
      // ...and the recovery actually completes: a fresh claim against that
      // push succeeds, where before this fix it would have refused forever.
      const reclaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dstale",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(reclaim.exitCode).toBe(0);
    });

    it("re-holding a FINDING refuses while its claim is still LIVE — an in-flight dispatch must not be undercut", async () => {
      const SHA_OLD = "9999999999999999999999999999999999999999";
      const d = stateDirFor("rehold-finding-refuses-live-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dlive",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dlive",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      // No backdating this time — the claim is fresh, i.e. genuinely live.
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.f00dlive."),
      );
      if (!claimFile) throw new Error("claim file was not created");

      const rehold = await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dlive",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "confirmed fixed in def5678",
      );
      expect(rehold.exitCode).toBe(1);
      expect(rehold.stderr).toContain("has a LIVE claim");
      // Refused, not silently swallowed: the live claim file is untouched,
      // and the ORIGINAL held record (still stamped SHA_OLD) still stands.
      expect(existsSync(join(d, claimFile))).toBe(true);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dlive", verifiedSha: SHA_OLD }]);
    });

    it("stamp-held stamps an UNSTAMPED finding even while a concurrent (about-to-fail) claim-held attempt has a claim file open on it", async () => {
      // The race: `claimFinding` creates its claim file BEFORE acquiring the
      // state lock and validating anything (deliberate — see claims.ts's own
      // doc comment on why the claim precedes the check). If a driver's
      // FIRST-EVER `stamp-held` for a brand-new hold lands while that raw,
      // unvalidated claim file happens to exist, the OLD guard treated mere
      // file existence as "already dispatched" and skipped stamping — even
      // though a claim over an unstamped item can only ever be a claim still
      // in flight (claim-held refuses whenever item.verifiedSha !==
      // --pushed-sha, and an absent stamp can never satisfy that), never a
      // completed dispatch. Simulated directly rather than via a real
      // concurrent claim-held call: a real one would validate-and-fail-and-
      // clean-up in one synchronous pass, never leaving the file behind long
      // enough to race — the raw file is exactly the state a REAL race
      // leaves mid-flight, for the instant between claimCreate and the
      // failing claimant's own lock acquisition.
      const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const d = stateDirFor("stamp-held-stamps-through-unvalidated-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00drace",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      // No stamp-held yet — this hold has never been stamped.
      const racingClaimPath = claimPathFor(d, "999", "f00drace");
      writeFileSync(racingClaimPath, newClaimToken(), { flag: "wx" });

      await state(d, ["stamp-held", "999", "--sha", SHA]);

      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00drace", verifiedSha: SHA }]);
    });

    it("hold's claim-check and held-record replacement happen under ONE lock hold — a REAL concurrent claim-held racing in never sees a torn state", async () => {
      // An earlier fix made `hold --kind finding` break a stale claim before
      // replacing the record, but did so as tryBreakStaleClaim() (its OWN
      // lock acquire/release) followed by a SEPARATE store.update() (a
      // second acquire/release) — leaving a real window between them for a
      // concurrent claim-held to slip its own validate-and-succeed in
      // against the OLD record moments before hold silently replaced it out
      // from under the dispatch that had just been told to proceed. The
      // fix folds both into ONE `store.locked` hold (this file's `hold`
      // case). Proven here with a FORCED concurrent overlap, not a
      // sequential simulation — a claim file created by a genuinely
      // concurrent process, while `hold`'s lock is provably still held, per
      // the same idiom the "atomic claim over the held batch" block above
      // uses for claim-held's own mutex.
      //
      // Under the fix, a claimant's raw (unlocked) `claimCreate` landing
      // ANY TIME while `hold` holds the state lock is observed by `hold`'s
      // OWN existsSync check (since that check and the write are now one
      // atomic section) as a LIVE claim — so `hold` correctly REFUSES
      // rather than racing past it, and the claimant's own blocked
      // lock.acquire() only unblocks once `hold` has released without
      // having touched the record at all. The old record must therefore
      // survive completely untouched, and the claimant's own claim must
      // still validate against it successfully — the self-consistent
      // outcome the old two-lock version could not guarantee.
      const SHA_OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const d = stateDirFor("hold-claim-check-and-replace-one-lock");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dtorn",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);

      const signal = join(d, "hold-is-holding");
      const reholdPromise = state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dtorn",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "0.5",
        },
        "confirmed fixed in def5678",
      );
      const deadline = Date.now() + 5000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) {
          throw new Error("hold never signalled that it holds the lock");
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      // `hold` is now DEFINITELY holding the state lock, for another ~0.5s.
      // The claimant's own `claimCreate` is unlocked, so it wins the file
      // immediately; its `store.lock.acquire()` is what is forced to
      // genuinely contend with `hold`'s still-open hold.
      const claimPromise = state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dtorn",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      const [rehold, claim] = await Promise.all([reholdPromise, claimPromise]);

      expect(rehold.exitCode).toBe(1);
      expect(rehold.stderr).toContain("has a LIVE claim");
      expect(claim.exitCode).toBe(0);
      // The old record must have survived completely untouched — `hold`
      // refused before ever reaching its replacement write.
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dtorn", verifiedSha: SHA_OLD }]);
    });
  });

  describe("the session lease over one working tree", () => {
    // The actor a hold records is the WORKING TREE, and `drive.ts`'s
    // single-instance lock is keyed by the same tree — so the model assumes one
    // tree = one driver. An INTERACTIVE pass takes no lock, so two agent
    // sessions in ONE tree both stamp the same actor: `hold` upserts by key and
    // the second silently REPLACES the first's record, `stamp-held` stamps
    // both sessions' holds, and nothing in the claim path can tell them apart.
    // Measured (2026-08-13): all seventeen threads one session had just
    // replied to carried two `**accepted**` replies.
    //
    // Every probe below drives the identity through $DRIVE_PR_SESSION, which is
    // also the channel drive.ts itself uses (see the loop-control block), so a
    // "session" here is a real pid whose liveness the probe controls.

    /**
     * A pid that is definitively GONE: a child spawned only to be waited on.
     * Any literal would be a guess about the machine running the suite.
     */
    async function deadPid(): Promise<number> {
      const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
      await p.exited;
      return p.pid;
    }

    const A_URL = "https://example.invalid/session-a-reply";
    const B_URL = "https://example.invalid/session-b-reply";

    /** Hold one thread key, as `session`. */
    function holdAs(dir: string, pid: number, url: string) {
      return state(
        dir,
        [
          "hold",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          url,
        ],
        { DRIVE_PR_SESSION: String(pid) },
      );
    }

    /**
     * Backdate BOTH leases a session holds — the per-PR one and the
     * tree-wide one — to the same `lastSeen`, so a probe simulating
     * "this session has gone quiet" models a real quiet session rather than
     * leaving the tree lease fresh and refusing on that layer instead of the
     * one under test (`claimTreeLease` runs BEFORE the per-PR claim, so a
     * still-fresh tree lease shadows a deliberately-backdated per-PR one).
     */
    function backdateSessionLeases(dir: string, pr: string, ms: number): void {
      const when = new Date(Date.now() - ms).toISOString();
      for (const path of [
        leasePathFor(dir, pr, ACTOR),
        treeLeasePathFor(dir, ACTOR),
      ]) {
        const lease = JSON.parse(readFileSync(path, "utf8"));
        lease.lastSeen = when;
        writeFileSync(path, JSON.stringify(lease, null, 2));
      }
    }

    it("refuses a second live session in the same tree — and the first session’s hold survives intact", async () => {
      const d = stateDirFor("lease-collision");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);
        expect((await holdAs(d, a.pid, A_URL)).exitCode).toBe(0);

        // Session B — a forked/background agent in the SAME tree, so it derives
        // the SAME actor and its `hold` would upsert straight over A's record.
        const second = await holdAs(d, process.pid, B_URL);
        expect(second.exitCode).toBe(11);

        // The damage the refusal prevents, asserted directly rather than
        // inferred from the exit code: A's record is untouched, so A's reply is
        // still the one its hold represents. Without the lease this reads B_URL
        // and A's promise is gone with no error anywhere.
        expect(
          JSON.parse((await state(d, ["held", "999"])).stdout),
        ).toMatchObject([{ key: "PRRT_x", commentUrl: A_URL }]);
      } finally {
        a.stop();
      }
    });

    it("names the live holder and how to verify it", async () => {
      const d = stateDirFor("lease-diagnostic");
      const a = liveSession();
      try {
        await state(
          d,
          ["park", "999", "--key", "k", "--kind", "thread", "--reason", "r"],
          {
            DRIVE_PR_SESSION: String(a.pid),
          },
        );
        const refused = await state(d, ["phase", "999", "--set", "triage"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(refused.exitCode).toBe(11);
        // A refusal that cannot be checked is a refusal a human has to guess
        // about, so the pid, the liveness probe and the way out are all part of
        // the contract — not decoration.
        expect(refused.stderr).toContain(`pid ${a.pid}`);
        expect(refused.stderr).toContain(`ps -p ${a.pid}`);
        expect(refused.stderr).toContain("clear-lease 999");
      } finally {
        a.stop();
      }
    });

    it("self-recovers from a session that is GONE — a crashed driver never wedges the PR", async () => {
      // The lease is taken by a session that is ALIVE and only then dies. That
      // is both the real crash sequence and the only way to reach this state
      // now: admission refuses an already-dead `$DRIVE_PR_SESSION` outright
      // (see the sibling test), so seeding with a dead pid would no longer
      // produce a lease to recover from at all.
      const d = stateDirFor("lease-dead");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });
      a.stop();
      // Wait for the pid to actually stop answering, or this races the takeover
      // it is setting up.
      await awaitPidGone(a.pid);

      const next = await state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(next.exitCode).toBe(0);
      expect(next.stderr).toContain("took over an abandoned drive lease");
      expect(next.stdout).toBe("2");
    });

    it("expires a lease whose pid still answers but which stopped driving", async () => {
      // The recycled-pid hazard: after a session dies the OS hands its number
      // to an unrelated long-lived process, and a liveness check alone would
      // then refuse every later session forever. A real session renews on every
      // mutating command; a recycled pid never does.
      const d = stateDirFor("lease-recycled");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        // Backdated past the staleness FLOOR (330s — see `leaseStaleFloorMs`),
        // not merely past the 1-minute env value: the window can no longer be
        // configured below the longest a command can sit admitted-but-waiting,
        // so a 5-minute-old lease is deliberately still live here.
        backdateSessionLeases(d, "999", 10 * 60_000);
        // …and the TREE lease is then dropped entirely: since
        // `claimTreeLease` runs BEFORE the per-PR claim, a tree lease that is
        // ALSO still alive would refuse first, on its own account, and the
        // check below would prove nothing about the PER-PR staleness logic
        // this test is actually about — it would just be re-proving the tree
        // layer's refusal, which has its own dedicated coverage. Removing it
        // isolates: `claimTreeLease` sees no tree lease at all here, so it
        // CREATES one silently (no refusal), and whatever happens next is
        // decided by `claimPrLease` alone.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });

        // Still refused inside the window, even though it has gone quiet…
        const stillRefused = await state(
          d,
          ["bump-round", "999", "--head", "bbb"],
          {
            DRIVE_PR_SESSION: String(process.pid),
            DRIVE_PR_LEASE_STALE_MIN: "60",
          },
        );
        expect(stillRefused.exitCode).toBe(11);
        // Per-PR-specific wording — proves THIS layer refused, not merely
        // that SOME layer did.
        expect(stillRefused.stderr).toContain(
          "PR #999 is already being driven from this working tree",
        );
        // …and recoverable once it has been quiet longer than the window.
        const took = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(took.exitCode).toBe(0);
        expect(took.stderr).toContain("took over an abandoned drive lease");
      } finally {
        a.stop();
      }
    });

    it("floors the staleness window above the longest admitted-but-waiting wait", async () => {
      // `clearAllLeases` preserves a live foreign lease so that a second
      // session in that tree cannot claim an absent one and mutate beside a
      // command that is already ADMITTED — past `claimLease`, waiting on the
      // state mutex `reset` holds. That preservation is decided by
      // wall-clock liveness, so a staleness window shorter than the wait itself
      // would let `reset` sweep the lease of a command that has not run yet,
      // reopening the same-actor concurrency this module exists to close.
      //
      // The window is therefore floored at `LOCK_ACQUIRE_MAX_SEC` + the renewal
      // cap (330s): a lease is at most 30s old on admission and the wait is
      // capped at 300s, so it cannot expire mid-flight however small the env
      // var asks the window to be.
      const d = stateDirFor("lease-stale-floor");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        // Inside the 330s floor, but far outside the 1-minute window the env
        // var asks for — the floor is the only thing keeping this lease live.
        backdateSessionLeases(d, "999", 300_000);
        // The TREE lease is then dropped, isolating the per-PR floor this
        // probe names — see the identical step in `expires a lease whose pid
        // still answers…` for why: `claimTreeLease` runs first and, left in
        // place, would refuse (or not) on its OWN floor before ever reaching
        // the per-PR one this test is about.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });

        const refused = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(refused.exitCode).toBe(11);
        expect(refused.stderr).toContain(`pid ${a.pid}`);
        expect(refused.stderr).toContain(
          "PR #999 is already being driven from this working tree",
        );
      } finally {
        a.stop();
      }
    });

    /**
     * Hold a mutating command inside its locked section until `then()` has run,
     * so a takeover can be raced into the window between admission and mutation.
     */
    async function stalledMutation(
      d: string,
      sessionPid: number,
      name: string,
      then: () => Promise<void> | void,
    ) {
      const signal = join(d, `${name}-is-holding`);
      const running = state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(sessionPid),
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "3",
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) {
          throw new Error(
            "the mutation never signalled that it holds the lock",
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      await then();
      return running;
    }

    it("fences a command admitted before its lease disappeared", async () => {
      // The fence's "lease is gone" branch, which is what stands between an
      // admitted command and a revocation that did NOT go through the state
      // mutex.
      //
      // Note what this deliberately no longer models: an operator's
      // `clear-lease` racing INTO a locked section. That is unreachable now —
      // `clear-lease` takes the state mutex itself, so it can only land between
      // locked sections, which the sibling `clear-lease takes the state mutex`
      // test pins from the other side. Removing the file directly is the
      // general case that mutex ordering cannot reach: a crash-leftover
      // cleanup, an out-of-band sweep, anything that deletes a lease without
      // holding the state lock. The fence is the last line for all of them.
      const d = stateDirFor("fence-lease-gone");
      const a = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });
        const before = await state(d, ["get", "999"]);

        const running = await stalledMutation(d, a.pid, "gone", () => {
          rmSync(leasePathFor(d, "999", ACTOR), { force: true });
        });

        const r = await running;
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain("taken over while this command waited");
        expect(r.stderr).toContain("is gone");
        // Fails CLOSED: the mutation must not have landed.
        expect((await state(d, ["get", "999"])).stdout).toBe(before.stdout);
      } finally {
        a.stop();
      }
    });

    it("a dead-pid takeover cannot land while a command holds the state mutex", async () => {
      // This used to be a FENCE test — the takeover raced into the stalled
      // command's window and the fence caught it on the way out. It is now an
      // ORDERING test, because the race is gone: a takeover is a revocation,
      // and every revocation coordinates with the state mutex, so it can only
      // land BETWEEN locked sections. The window the fence was catching no
      // longer opens, which is strictly better than catching it afterwards —
      // the admitted command completes instead of being refused.
      //
      // The fence still has its own coverage: `fences a command admitted before
      // its lease disappeared` exercises the branch for revocations that do not
      // go through the state mutex at all.
      const d = stateDirFor("deadpid-ordering");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });

      // Asserted as completion ORDER rather than as elapsed time. The
      // guarantee is "the takeover cannot land while the mutex is held", and a
      // wall-clock probe on that is fragile — how long the killed session takes
      // to stop answering is not ours to control. Order is exact: with the
      // coordination the taker can only finish after the holder releases;
      // without it the taker needs no state lock at all and finishes FIRST.
      const done: string[] = [];
      const signal = join(d, "deadpid-is-holding");
      const running = state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(a.pid),
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "3",
      }).then((r) => {
        done.push("holder");
        return r;
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      // The owning session dies while its child holds the state mutex…
      a.stop();
      // Until the pid actually stops answering, the replacement sees a LIVE
      // foreign lease and refuses outright — a different outcome entirely,
      // which would make this test measure nothing.
      await awaitPidGone(a.pid);

      // …and a replacement tries to take the now-dead lease over.
      const taker = state(d, ["bump-round", "999", "--head", "ccc"], {
        DRIVE_PR_SESSION: String(process.pid),
      }).then((r) => {
        done.push("taker");
        return r;
      });

      const [r, t] = await Promise.all([running, taker]);
      expect(done).toEqual(["holder", "taker"]);
      // The admitted command is NOT refused — its lease was never revoked out
      // from under it, which is the whole point of ordering over fencing.
      expect(r.exitCode).toBe(0);
      // And the replacement then takes over legitimately, once the mutex frees.
      expect(t.exitCode).toBe(0);
      expect(t.stderr).toContain("took over an abandoned drive lease");
    });

    it("sweeping many leases leaves no process listeners behind", async () => {
      // `clearAllLeases` makes one lock per lease FILE, and every `createLock`
      // registers exit/SIGINT/SIGTERM handlers. Nothing removed them, so a PR
      // driven from more than ten trees pushed Node past its default
      // `maxListeners` and printed a leak warning on stderr — the same stream
      // `reset`'s preserved-lease report uses, so it landed in the middle of
      // the diagnostic an operator has to read (the threshold is 11 locks, not
      // 4 — the three handlers are on three
      // DIFFERENT events, so each lock adds one per event).
      //
      // Asserted as listener COUNT rather than as the warning text: the suite
      // runs under Bun, which does not emit the warning at all, so a probe on
      // the message would pass here while the leak stayed live on the Node
      // path the scripts also advertise.
      const d = stateDirFor("lease-listener-leak");
      for (let i = 0; i < 14; i++) {
        const actor = `wt-${String(i).padStart(16, "0")}`;
        writeFileSync(
          leasePathFor(d, "999", actor),
          JSON.stringify({
            holder: "session",
            pid: 999_999,
            host: "nowhere",
            platform: "linux",
            actor,
            worktree: "/tmp/probe-tree",
            startedAt: "2020-01-01T00:00:00.000Z",
            lastSeen: "2020-01-01T00:00:00.000Z",
            command: "hold",
            generation: String(i).padStart(32, "0"),
            sessionStarted: "",
          }),
        );
      }
      // All THREE events `createLock` registers, not just `exit`: the claim
      // is that disposal detaches everything it added, and a probe on one
      // event stays green while a regression leaks the other two.
      const events = ["exit", "SIGINT", "SIGTERM"] as const;
      const before = events.map((e) => process.listenerCount(e));
      await clearAllLeases(d, "999", null);
      expect(leaseFilesFor(d, "999")).toEqual([]);
      expect(events.map((e) => process.listenerCount(e))).toEqual(before);
    });

    it("the generation token survives renewal but not a same-tuple recreate", async () => {
      // The fence compares a random `generation`, not `startedAt`. An ISO
      // timestamp resolves to the millisecond, so a `clear-lease` plus a
      // same-session reclaim inside one millisecond can reproduce the exact
      // `(pid, host, startedAt)` tuple and would be waved through as "my lease,
      // renewed". Asserted structurally rather than
      // by racing a millisecond: a renewal must PRESERVE the token, and a
      // clear-then-reclaim must MINT a new one even when every other field is
      // identical.
      const d = stateDirFor("lease-generation");
      const path = leasePathFor(d, "999", ACTOR);

      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const first = JSON.parse(readFileSync(path, "utf8"));
      // Pinned as a RANDOM nonce, not merely "some string that changes".
      // "Changes after a clear" is satisfied by a timestamp too, as long as the
      // test does not happen to race a millisecond — so a value-inequality
      // assertion alone would stay green against exactly the clock-derived
      // identity this finding was about. The representation is the claim.
      expect(first.generation).toMatch(/^[0-9a-f]{32}$/);
      expect(first.generation).not.toBe(first.startedAt);
      expect(first.generation).not.toBe(first.lastSeen);

      // A renewal by the SAME session keeps it — sibling commands admitted
      // under it must stay admitted.
      await state(d, ["bump-attempt", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const renewed = JSON.parse(readFileSync(path, "utf8"));
      expect(renewed.generation).toBe(first.generation);

      // Cleared and reclaimed by the same session: same pid, same host, and
      // `startedAt` is the only thing distinguishing it — which a fast enough
      // clock cannot. The token must differ regardless.
      expect((await state(d, ["clear-lease", "999"])).exitCode).toBe(0);
      await state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      const reclaimed = JSON.parse(readFileSync(path, "utf8"));
      expect(reclaimed.pid).toBe(first.pid);
      expect(reclaimed.host).toBe(first.host);
      expect(reclaimed.generation).not.toBe(first.generation);
    });

    describe("OS pid reuse defeats (pid, host) alone", () => {
      // `isMine` used to be the WHOLE story for `claimLease`'s renewal-vs-
      // takeover decision: match on (pid, host) and preserve the generation.
      // `$DRIVE_PR_SESSION_STARTED` closed that for `isMine` itself (the
      // "session-started token" suite above) — but
      // `claimLease` also asks `leaseAlive`, and once the OS has handed a dead
      // predecessor's exact pid to THIS session, `leaseAlive`'s pid half is
      // asking whether the CALLER is running, which is tautologically true.
      // Before an earlier change that kept the claim refused (not merged, but not
      // admitted either) for a full staleness window instead of minting the
      // new generation the collision requires.
      //
      // These probes fake OS pid reuse the same way the fence's own token
      // tests do: seed a lease under THIS TEST'S OWN pid (always alive, so
      // `pidAlive` cannot tell the fixture apart from a real collision) while
      // giving the CLAIMING call a DIFFERENT `$DRIVE_PR_SESSION_STARTED` than
      // the one on disk — the token `drive.ts` mints once per launch.

      function deadPredecessorLease(generation: string): string {
        return JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: ACTOR,
          worktree: "/tmp/dead-predecessor-tree",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          // Fresh — well inside the default staleness window — so a fix that
          // merely waits out `leaseAlive`'s staleness clock, rather than
          // recognizing the recycled pid, would still show this test red.
          lastSeen: new Date(Date.now() - 60_000).toISOString(),
          command: "hold",
          generation,
          sessionStarted: OLDER_SESSION_TOKEN,
        });
      }

      it("a reused pid inside the staleness window MINTS a new generation rather than being refused or renewed", async () => {
        const d = stateDirFor("pid-reuse-mints");
        const path = leasePathFor(d, "999", ACTOR);
        const oldGeneration = "a".repeat(32);
        writeFileSync(path, deadPredecessorLease(oldGeneration));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        // Not 11: a session whose pid the OS has recycled must be admitted as
        // a TAKEOVER, not stuck behind a "someone else is driving" refusal —
        // there is no one else; the predecessor is dead and this session
        // simply inherited its pid.
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain(
          "took over a drive lease on PR #999 whose pid",
        );

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.generation).not.toBe(oldGeneration);
        expect(after.sessionStarted).toBe(NEWER_SESSION_TOKEN);
      });

      it("a command admitted under the OLD generation is refused by assertLeaseUnchanged once the reused-pid takeover lands", async () => {
        const d = stateDirFor("pid-reuse-fences-old-admission");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("b".repeat(32)));
        // The lease shape a command admitted under the dead predecessor's
        // generation would have been handed — read back rather than
        // hand-built, so it is provably the same record `claimLease` would
        // have returned.
        const admittedUnderOldGeneration = JSON.parse(
          readFileSync(path, "utf8"),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(0);

        let threw: unknown;
        try {
          assertLeaseUnchanged(d, "999", admittedUnderOldGeneration);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      });

      it("a STALE pass carrying an OLDER inherited token must not take back a genuinely newer driver's lease (alternation hazard)", async () => {
        // Without an ordering check, `isRecycledPid` fires symmetrically: a
        // pass detached from a killed driver keeps identifying with that
        // driver's (pid, token) forever, and if the OS later recycles the
        // exact pid to a brand-new driver, EACH side reads the OTHER's lease
        // as "my own recycled pid" — the new driver correctly, the stale pass
        // wrongly — and the two would alternate takeovers instead of the
        // stale pass ever standing down. Seed a dead predecessor's lease, let
        // a new driver legitimately take it over (mirroring the "mints a new
        // generation" probe above), then have a pass carrying the ORIGINAL
        // dead predecessor's token try to mutate next.
        const d = stateDirFor("pid-reuse-stale-pass-cannot-take-back");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("c".repeat(32)));

        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        const takenOverByNewDriver = JSON.parse(readFileSync(path, "utf8"));
        expect(takenOverByNewDriver.sessionStarted).toBe(NEWER_SESSION_TOKEN);

        // The stale pass — same (pid, host) by construction, but the OLDER
        // token the dead predecessor minted — must be refused, not admitted
        // as a second "recycled pid" takeover.
        const r = await state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        // And the lease is untouched — still the live, newer driver's.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(NEWER_SESSION_TOKEN);
      });

      it("a TOKENLESS caller gets NO fast-path takeover of a FRESH token-bearing lease — no timestamp on its own side means no proof", async () => {
        // One criterion governs this predicate: `isRecycledPid` proves `l`'s
        // writer is dead only via a TEMPORAL argument, and a temporal argument
        // needs BOTH pid claims timestamped. A tokenless
        // (`$DRIVE_PR_SESSION`-only, no `$DRIVE_PR_SESSION_STARTED`) caller
        // carries no timestamp of its own, so — even though `l` here DOES carry
        // one — there is no pair to order, and no proof that `l`'s
        // token-bearing writer is dead rather than a live rival this caller's
        // pid merely coincides with. An identity-based fix is UNSOUND: the
        // argument it relies on ("a tokenless caller can never have written a
        // token-bearing lease, so the disk record must be a dead predecessor")
        // proves only that the two CLAIMS differ, never that the caller's own
        // claim is the newer, live one — `Session.pid` is an inherited value,
        // not proof of the caller's own actual OS pid (the mirror image of the
        // same flaw on the other side).
        //
        // This is not a dead end: see the companion probe below, where the
        // SAME fixture is admitted once it is genuinely stale — recognition
        // is downgraded from instant to staleness-gated, not lost.
        const d = stateDirFor(
          "pid-reuse-tokenless-caller-no-fastpath-fresh-lease",
        );
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("d".repeat(32)));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          // Deliberately no DRIVE_PR_SESSION_STARTED — tier 2, tokenless.
        });
        expect(r.exitCode).toBe(11);

        // Untouched — the fresh token-bearing lease still stands.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(OLDER_SESSION_TOKEN);
      });

      it("...but the SAME tokenless caller IS admitted once that lease is genuinely STALE — the fallback this predicate defers to, not a dead end", async () => {
        // Mirrors the probe immediately above with one field changed:
        // `lastSeen` is past `leaseStaleFloorMs()` rather than fresh. With no
        // token-based fast path available, `claimLease`'s own `!leaseAlive`
        // check is what admits this caller — proving the criterion is a
        // downgrade to the older staleness wait for this combination,
        // not a permanent refusal.
        const d = stateDirFor("pid-reuse-tokenless-caller-admitted-once-stale");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: STALE_LASTSEEN,
            lastSeen: STALE_LASTSEEN,
            command: "hold",
            generation: "i".repeat(32),
            sessionStarted: OLDER_SESSION_TOKEN,
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          // Deliberately no DRIVE_PR_SESSION_STARTED — tier 2, tokenless.
          // Requests the shortest window `leaseStaleMs()` allows — it floors
          // this at `leaseStaleFloorMs()` (5.5min) regardless, which is
          // exactly what `STALE_LASTSEEN` is computed to clear. Omitting this
          // would leave the DEFAULT 360min window active, under which
          // `STALE_LASTSEEN`'s 6 minutes is nowhere near stale.
          DRIVE_PR_LEASE_STALE_MIN: "1",
        });
        expect(r.exitCode).toBe(0);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("");
      });

      it("a malformed (non-ISO, or ISO-looking but non-round-tripping) CALLER token fails isRecycledPid CLOSED, not open", async () => {
        // `resolveSession` accepts `$DRIVE_PR_SESSION_STARTED` from the
        // environment with no format validation — a broken or
        // hostile harness could set anything. A predicate that authorizes a
        // takeover must not trust an unparseable ordering; it must refuse,
        // the same as it would for a genuinely live rival.
        const d = stateDirFor("pid-reuse-malformed-caller-token-fails-closed");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(path, deadPredecessorLease("e".repeat(32)));

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: "not-a-real-timestamp",
        });
        expect(r.exitCode).toBe(11);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe(OLDER_SESSION_TOKEN);
      });

      it("a malformed (non-ISO) ON-DISK LEASE token fails isRecycledPid CLOSED, not open", async () => {
        // The mirror of the probe above: the token that fails to parse can be
        // on either side. A tampered or pre-validation lease file with a
        // garbage `sessionStarted` must not be trusted as "provably older"
        // just because SOME ordering comparison happens to return true on it.
        // `'1999-01-01'` is deliberately chosen, not arbitrary garbage: it
        // parses via `Date.parse` (so it WOULD sort before a real ISO instant
        // under a validation-free comparison — exit 0, the wrong answer) but
        // fails the round-trip check `parseStrictIsoInstantMs` requires
        // (`new Date(...).toISOString()` produces
        // `'1999-01-01T00:00:00.000Z'`, not the original string), so this
        // probe actually distinguishes fail-closed from a merely-lucky
        // lexicographic comparison — unlike a value that sorts "after" any
        // real instant regardless of validation.
        const d = stateDirFor("pid-reuse-malformed-lease-token-fails-closed");
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            lastSeen: new Date(Date.now() - 60_000).toISOString(),
            command: "hold",
            generation: "f".repeat(32),
            sessionStarted: "1999-01-01",
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("1999-01-01");
      });

      it("a TOKEN-BEARING caller gets NO fast-path takeover of a FRESH tokenless lease either — the mirror direction", async () => {
        // The mirror of the probe far above ("no timestamp on its own side
        // means no proof"): there `l` carried a token and `s` did not, here
        // it is reversed. Under that criterion the two are governed by
        // the IDENTICAL code path — `isRecycledPid` returns `false` whenever
        // EITHER side is empty, with no direction-dependent case split — so
        // this is the same invariant demonstrated from the other side, not a
        // logically distinct scenario.
        //
        // Historically this went through an intermediate "D2 (tokenless)
        // legitimately takes over from a token-bearing dead predecessor, THEN
        // a stale token-bearing pass tries to reclaim D2's fresh lease"
        // narrative — that story no longer applies as written, because the
        // same criterion also closes the FORWARD direction (a tokenless
        // caller's own fast-path takeover of a token-bearing lease, see the
        // probe far above), so there is no longer an instant "D2 takes over"
        // step to build on. The fresh, tokenless lease is constructed
        // directly instead; the invariant under test — a token-bearing
        // caller cannot fast-path a takeover of it — is unchanged.
        const d = stateDirFor(
          "pid-reuse-token-bearing-caller-no-fastpath-fresh-tokenless-lease",
        );
        const path = leasePathFor(d, "999", ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "session",
            pid: process.pid,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/tmp/dead-predecessor-tree",
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            lastSeen: new Date(Date.now() - 60_000).toISOString(),
            command: "hold",
            generation: "g".repeat(32),
            sessionStarted: "",
          }),
        );

        const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: OLDER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(11);

        // Untouched — the fresh tokenless lease still stands.
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after.sessionStarted).toBe("");
      });

      it("a genuine renewal by the SAME session (matching token) still preserves its generation", async () => {
        // Every OTHER "renewal preserves the generation" probe in this file
        // (e.g. "the generation token survives renewal…" above) exercises
        // `isMine`'s TOKENLESS fallback branch — neither call sets
        // `$DRIVE_PR_SESSION_STARTED`, so both sides compare `''`. This is
        // the only one that drives `claimLease` itself (not just the
        // external-mutation fence, which the "session-started token" suite
        // above already covers) through `isMine`'s TOKEN-MATCH branch. A
        // regression there — say, a mutation that always returns `false` once
        // both tokens are non-empty — would make `isMine` misreport this
        // renewal as foreign. Under the FINAL `isRecycledPid` criterion this
        // does NOT also flip `isRecycledPid` true: both sides carry the
        // IDENTICAL token here, so the parsed instants are equal, and the
        // comparison is strict `<` — equal fails it either way. `leaseAlive`
        // still reads true (genuinely alive, fresh `lastSeen`), so the
        // regression is instead caught by `underLocks`'s own "already being
        // driven" `fail(11)` refusal (`leaseAlive(held) && !isRecycledPid(...)`,
        // a few lines above `mintsNewGeneration`) rather than by a generation
        // mismatch. Either mechanism makes this probe correctly redden under
        // that regression.
        const d = stateDirFor("pid-reuse-genuine-renewal");
        const path = leasePathFor(d, "999", ACTOR);

        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        const first = JSON.parse(readFileSync(path, "utf8"));
        expect(first.sessionStarted).toBe(NEWER_SESSION_TOKEN);

        const r = await state(d, ["bump-attempt", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_SESSION_STARTED: NEWER_SESSION_TOKEN,
        });
        expect(r.exitCode).toBe(0);
        const renewed = JSON.parse(readFileSync(path, "utf8"));
        expect(renewed.generation).toBe(first.generation);
      });
    });

    it("clear-lease takes the state mutex, so it cannot land mid-mutation", async () => {
      // The fence and the write it guards are not atomic against a revocation
      // that needs only the LEASE mutex: clearing between the two let the
      // admitted command write anyway, and a successor could then claim the
      // absent lease and write under the same actor — the same corruption, in
      // a narrower window.
      //
      // `clear-lease` therefore takes the state mutex too, so it can only land
      // BETWEEN locked sections. Asserted as ordering: while a mutation holds
      // the lock, the clear must not complete.
      const d = stateDirFor("clear-lease-mutex");
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });

      const signal = join(d, "holding");
      const mutating = state(d, ["bump-round", "999", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "3",
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      let clearFinished = false;
      const clearing = state(d, ["clear-lease", "999"]).then((r) => {
        clearFinished = true;
        return r;
      });
      // Still blocked a full second into the holder's 3s stall.
      await new Promise((r) => setTimeout(r, 1000));
      expect(clearFinished).toBe(false);

      // The mutation completes normally — it was never fenced out, because the
      // clear could not reach the lease while it held the mutex.
      expect((await mutating).exitCode).toBe(0);
      expect((await clearing).exitCode).toBe(0);
    });

    it("names a liveness check the HOLDER’s platform can run, not the reader’s", async () => {
      // The refusal promises a check the operator can execute, so the command
      // must match the machine the pid lives on. Inferring it from the local
      // platform handed a Windows holder `ssh <host> ps -p <pid>`, which that
      // host has no `ps` for. The lease records
      // `platform`, and this reads it back.
      const other = `${hostname()}-elsewhere`;
      expect(pidCheckCommand(42, other, "win32")).toBe(
        `ssh ${other} Get-Process -Id 42`,
      );
      expect(pidCheckCommand(42, other, "linux")).toBe(`ssh ${other} ps -p 42`);
      // Unknown remote platform is answered honestly rather than guessed — a
      // fabricated command is exactly what this line exists not to produce.
      expect(pidCheckCommand(42, other, undefined)).toBeNull();
      expect(pidCheckCommand(42, other, "")).toBeNull();
      // Locally there is nothing to guess, so no `platform` is needed.
      const localExpected =
        process.platform === "win32" ? "Get-Process -Id 42" : "ps -p 42";
      expect(pidCheckCommand(42, hostname())).toBe(localExpected);
      expect(pidCheckCommand(42, "")).toBe(localExpected);
    });

    it("acquire honours a caller-supplied cap below the configured timeout", async () => {
      // The primitive behind `clearAllLeases`'s aggregate budget. `reset` holds
      // the PR's state mutex across the whole sweep, and each lease lock's
      // `acquire()` may wait up to the configured timeout — so a sweep that
      // waits per-lock costs N × that, growing with the number of trees that
      // have ever driven the PR. The sweep therefore
      // hands each `acquire()` the time REMAINING in one shared deadline.
      //
      // Tested here rather than end-to-end through `reset`, deliberately: the
      // sweep already aborts on the first lock it cannot take, so a reset over
      // unacquirable locks costs one timeout whether or not a budget exists,
      // and an end-to-end probe cannot tell the two apart. What the aggregate
      // budget actually changes is the case where each acquire SUCCEEDS after a
      // long wait, and the mechanism that bounds it is this cap.
      const d = stateDirFor("acquire-cap");
      const target = join(d, "capped.json");
      // A fresh, non-stale lock nothing will release.
      mkdirSync(`${target}.lock`, { recursive: true });
      writeFileSync(join(`${target}.lock`, "owner.someone-else"), "");

      const prev = {
        t: process.env.DRIVE_PR_LOCK_TIMEOUT,
        s: process.env.DRIVE_PR_LOCK_STALE_MIN,
      };
      process.env.DRIVE_PR_LOCK_TIMEOUT = "30";
      process.env.DRIVE_PR_LOCK_STALE_MIN = "60";
      try {
        const lock = createLock(target, "test", "999");
        const started = Date.now();
        await expect(lock.acquire(1)).rejects.toThrow();
        const elapsed = Date.now() - started;
        // Tight enough to actually guard the contract. A loose bound (the
        // first version allowed 15s against a 30s timeout) would stay green if
        // production turned a 1s cap into 10s — it would only have caught the
        // cap being ignored ENTIRELY. 4s leaves room
        // for spawn and poll granularity on a loaded machine without admitting
        // any plausible wrong multiplier.
        expect(elapsed).toBeLessThan(4_000);
        lock.dispose();
      } finally {
        process.env.DRIVE_PR_LOCK_TIMEOUT = prev.t;
        process.env.DRIVE_PR_LOCK_STALE_MIN = prev.s;
      }
    });

    it("fences claim-held --kind finding, which takes the lock directly", async () => {
      // `claimFinding` is the ONE path that calls `store.lock.acquire()` rather
      // than going through `store.locked`, so the fence installed at admission
      // never fired for it — and it is the path where that costs most: a
      // revoked session would validate the held record, return a claim token,
      // and dispatch a NON-idempotent summary answer beside its successor's,
      // leaving a duplicate standing claim on the PR.
      const d = stateDirFor("fence-claim-finding");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "FP",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        S,
        "reason",
      );
      await state(d, ["stamp-held", "999", "--sha", HELD_PUSH], S);

      // Hold the state lock open so the claim is admitted and then queues.
      const signal = join(d, "holding");
      const stalled = state(d, ["bump-round", "999", "--head", "aaa"], {
        ...S,
        DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
        DRIVE_PR_UPDATE_TEST_DELAY: "4",
      });
      const deadline = Date.now() + 8000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) throw new Error("never signalled");
        await new Promise((r) => setTimeout(r, 10));
      }

      const claiming = state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "FP",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        S,
      );
      // Long enough to be past `claimLease` and blocked on the state lock.
      await new Promise((r) => setTimeout(r, 800));
      rmSync(leasePathFor(d, "999", ACTOR), { force: true });

      const r = await claiming;
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("taken over while this command waited");
      // And the lock-free claim file it created moments earlier is cleaned up:
      // leaving it would wedge the key behind a claim no dispatch will follow.
      expect(existsSync(claimPathFor(d, "999", "FP"))).toBe(false);
      await stalled;
    });

    it("refuses a $DRIVE_PR_SESSION pid that is syntactically valid but dead", async () => {
      // `leaseAlive` fails on the pid half however young the lease, so a lease
      // written under a dead pid is takeover-able the instant it exists — it
      // reports an exclusion that excludes nobody. Reached when `drive.ts` is
      // killed and a detached pass outlives it still carrying the dead
      // driver's pid.
      const d = stateDirFor("dead-session-pid");
      const gone = await deadPid();
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(gone),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(`pid ${gone}`);
      expect(r.stderr).toContain("not running");
      // Refused BEFORE anything was written — no phantom lease, no state.
      expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(false);
      expect((await state(d, ["get", "999"])).stdout).toContain('"rounds": 0');
    });

    it("reset does the fallible lease sweep BEFORE discarding durable state", async () => {
      // `reset` used to delete the state file, handoff, orphan marker and claim
      // files and only then sweep the leases — so a sweep that threw left
      // everything already gone, a prefix of leases swept, and a non-zero exit
      // indistinguishable from "changed nothing".
      //
      // Modelled with a lease whose lock can never be taken, which makes the
      // sweep throw: the state file must survive, so the retry a caller
      // reaches for is operating on the state they think it is.
      const d = stateDirFor("reset-order");
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);

      // A foreign lease file whose lock is held and not stale.
      const foreign = leasePathFor(d, "999", "wt-00000000000000ff");
      writeFileSync(
        foreign,
        JSON.stringify({
          holder: "session",
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          actor: "wt-00000000000000ff",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      mkdirSync(`${foreign}.lock`, { recursive: true });
      writeFileSync(join(`${foreign}.lock`, "owner.someone-else"), "");

      const r = await state(d, ["reset", "999"], {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_LOCK_TIMEOUT: "1",
        DRIVE_PR_LOCK_STALE_MIN: "60",
      });
      expect(r.exitCode).not.toBe(0);
      // The whole point: durable state is untouched, so the exit really does
      // mean "no change" and a retry is sound.
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);
    });

    it("a sweep that cannot take every lock deletes NO lease, not a prefix", async () => {
      // Ordering the sweep before `reset`'s state deletions made the state half
      // of "a non-zero exit means no change" true and left the LEASE half
      // false: the loop deleted each stale lease as it went, so a lock failure
      // partway through had already removed the earlier ones.
      //
      // Two sweepable leases either side of one whose lock cannot be taken —
      // the middle file's lock proves acquisition reaches it, and the last
      // proves the failure is not simply "we never got that far".
      const d = stateDirFor("sweep-all-or-nothing");
      const files: string[] = [];
      for (let i = 0; i < 3; i++) {
        const actor = `wt-${String(i).padStart(16, "0")}`;
        const f = leasePathFor(d, "999", actor);
        writeFileSync(
          f,
          JSON.stringify({
            holder: "session",
            pid: 999_999,
            host: "nowhere",
            platform: "linux",
            actor,
            worktree: "/tmp/probe-tree",
            startedAt: "2020-01-01T00:00:00.000Z",
            lastSeen: "2020-01-01T00:00:00.000Z",
            command: "hold",
            generation: String(i).padStart(32, "0"),
            sessionStarted: "",
          }),
        );
        files.push(f);
      }
      // Wedge exactly one lock. `leaseFilesFor` sorts by readdir order, so
      // wedging the MIDDLE one leaves sweepable files on both sides of it.
      const wedged = `${files[1]}.lock`;
      mkdirSync(wedged, { recursive: true });
      writeFileSync(join(wedged, "owner.someone-else"), "");

      const prev = {
        t: process.env.DRIVE_PR_LOCK_TIMEOUT,
        s: process.env.DRIVE_PR_LOCK_STALE_MIN,
      };
      process.env.DRIVE_PR_LOCK_TIMEOUT = "1";
      process.env.DRIVE_PR_LOCK_STALE_MIN = "60";
      try {
        await expect(clearAllLeases(d, "999", null)).rejects.toThrow();
        // Every lease still present — the sweep is all-or-nothing.
        for (const f of files) expect(existsSync(f)).toBe(true);
      } finally {
        process.env.DRIVE_PR_LOCK_TIMEOUT = prev.t;
        process.env.DRIVE_PR_LOCK_STALE_MIN = prev.s;
      }
    });

    it("reset REFUSES while another tree is live, deleting nothing", async () => {
      // Preserving the foreign lease was not enough: the state file and the
      // CLAIM files are shared across trees. A live session mid-dispatch has
      // already created its claim file and may not have posted yet — deleting
      // it lets this tree rebuild state, see the finding as unaddressed, and
      // dispatch the same non-idempotent answer again.
      //
      // Still exit 9 after an earlier change's PR-wide admission gate, and WHY is worth
      // stating: this tree took its lease at the `bump-round` below, before the
      // foreign one existed, so `reset`'s claim is a fresh renewal and takes the
      // lock-free fast path — the gate does not re-litigate an admission that
      // already happened. Reaching this branch is therefore the narrow case it
      // is documented as: a tree that starts driving after this one was
      // admitted. The gate's own refusal is exercised separately below.
      const d = stateDirFor("reset-refuses-live");
      const other = liveSession();
      try {
        // This tree's own state, plus a live lease belonging to ANOTHER tree.
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        const foreignActor = "wt-00000000000000ff";
        writeFileSync(
          leasePathFor(d, "999", foreignActor),
          JSON.stringify({
            holder: "session",
            pid: other.pid,
            host: hostname(),
            platform: process.platform,
            actor: foreignActor,
            worktree: "/tmp/probe-tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "hold",
            generation: "a".repeat(32),
            sessionStarted: "",
          }),
        );
        // A claim file standing in for that session's in-flight dispatch.
        const claim = claimPathFor(d, "999", "FP");
        writeFileSync(claim, newClaimToken());

        const r = await state(d, ["reset", "999"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(r.exitCode).toBe(9);
        expect(r.stderr).toContain("refusing to reset");
        expect(r.stderr).toContain(`pid ${other.pid}`);
        // Nothing shared was touched — that is the whole point.
        expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);
        expect(existsSync(claim)).toBe(true);
        expect(existsSync(leasePathFor(d, "999", foreignActor))).toBe(true);
      } finally {
        other.stop();
      }
    });

    it("a lock whose acquire fails is still disposed", async () => {
      // `createLock` installs its exit/SIGINT/SIGTERM handlers at CONSTRUCTION,
      // so a lock registered only after a successful `acquire` leaks three
      // listeners on every failed attempt — the exact leak disposal was added
      // to stop, reintroduced on the failure path.
      const d = stateDirFor("dispose-on-acquire-fail");
      const f = leasePathFor(d, "999", "wt-00000000000000ab");
      writeFileSync(
        f,
        JSON.stringify({
          holder: "session",
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          actor: "wt-00000000000000ab",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          command: "hold",
          generation: "b".repeat(32),
          sessionStarted: "",
        }),
      );
      mkdirSync(`${f}.lock`, { recursive: true });
      writeFileSync(join(`${f}.lock`, "owner.someone-else"), "");

      const prev = {
        t: process.env.DRIVE_PR_LOCK_TIMEOUT,
        s: process.env.DRIVE_PR_LOCK_STALE_MIN,
      };
      process.env.DRIVE_PR_LOCK_TIMEOUT = "1";
      process.env.DRIVE_PR_LOCK_STALE_MIN = "60";
      try {
        const events = ["exit", "SIGINT", "SIGTERM"] as const;
        const before = events.map((e) => process.listenerCount(e));
        // Several failed attempts, because one leak is easy to miss in noise.
        for (let i = 0; i < 3; i++) {
          await expect(clearAllLeases(d, "999", null)).rejects.toThrow();
        }
        expect(events.map((e) => process.listenerCount(e))).toEqual(before);
      } finally {
        process.env.DRIVE_PR_LOCK_TIMEOUT = prev.t;
        process.env.DRIVE_PR_LOCK_STALE_MIN = prev.s;
      }
    });

    it("reports a deletion failure as an explicit PARTIAL sweep, naming both halves", async () => {
      // `force: true` only makes a MISSING target harmless — deletion can still
      // fail (EACCES, EPERM, EROFS, I/O). The two-phase split makes a phase-1
      // failure mean "nothing changed"; a phase-2 failure genuinely is partial,
      // and claiming otherwise would be false. It must SAY so.
      //
      // A directory named like a lease file is the portable way to make
      // `rmSync(f, { force: true })` throw: `leaseFilesFor` matches on name,
      // and `rmSync` without `recursive` refuses a directory on every platform.
      const d = stateDirFor("sweep-partial-report");
      const ok = leasePathFor(d, "999", "wt-0000000000000001");
      writeFileSync(
        ok,
        JSON.stringify({
          holder: "session",
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          actor: "wt-0000000000000001",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          command: "hold",
          generation: "1".repeat(32),
          sessionStarted: "",
        }),
      );
      const undeletable = leasePathFor(d, "999", "wt-0000000000000002");
      mkdirSync(undeletable, { recursive: true });
      writeFileSync(join(undeletable, "blocker"), "");

      await expect(clearAllLeases(d, "999", null)).rejects.toThrow(
        /PARTIAL sweep/,
      );
      // Every doomed entry is attempted, so the deletable one really is gone —
      // which is exactly why the error has to name both halves rather than let
      // the caller assume nothing happened.
      expect(existsSync(ok)).toBe(false);
      expect(existsSync(undeletable)).toBe(true);

      await expect(clearAllLeases(d, "999", null)).rejects.toThrow(
        /Left in place[\s\S]*wt-0000000000000002/,
      );
    });

    it("a MIXED lease set refuses without sweeping the stale ones", async () => {
      // `reset`'s exit-9 diagnostic promises nothing was deleted. That was
      // false while phase 2 ran before the caller could refuse: a set holding
      // both stale leases and one live foreign lease swept the stale ones and
      // THEN returned the refusal. The
      // sweep now returns before deleting, so the promise holds and the
      // function's own contract is simply "everything, or nothing".
      const d = stateDirFor("sweep-mixed-refuses");
      const other = liveSession();
      try {
        const stale = leasePathFor(d, "999", "wt-0000000000000001");
        writeFileSync(
          stale,
          JSON.stringify({
            holder: "session",
            pid: 999_999,
            host: "nowhere",
            platform: "linux",
            actor: "wt-0000000000000001",
            worktree: "/tmp/probe-tree",
            startedAt: "2020-01-01T00:00:00.000Z",
            lastSeen: "2020-01-01T00:00:00.000Z",
            command: "hold",
            generation: "1".repeat(32),
            sessionStarted: "",
          }),
        );
        const liveForeign = leasePathFor(d, "999", "wt-0000000000000002");
        writeFileSync(
          liveForeign,
          JSON.stringify({
            holder: "session",
            pid: other.pid,
            host: hostname(),
            platform: process.platform,
            actor: "wt-0000000000000002",
            worktree: "/tmp/probe-tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "hold",
            generation: "2".repeat(32),
            sessionStarted: "",
          }),
        );

        const { preservedForeign, removed } = await clearAllLeases(
          d,
          "999",
          null,
        );
        expect(preservedForeign).toHaveLength(1);
        // Nothing was removed — the point this test makes, now checkable
        // directly against the function's own report rather than only
        // inferred from the files still being on disk.
        expect(removed).toEqual([]);
        // The stale one is UNTOUCHED — that is the claim `reset` makes.
        expect(existsSync(stale)).toBe(true);
        expect(existsSync(liveForeign)).toBe(true);
      } finally {
        other.stop();
      }
    });

    it("CREATING a lease takes the state mutex, not just taking one over", async () => {
      // Scoping the state mutex to TAKEOVERS alone leaves `reset` exposed
      // to a tree it had never seen: a new actor's first claim writes its lease
      // AFTER `clearAllLeases` enumerated, so the sweep reports no live foreign
      // lease, reset deletes the shared state and claim files, and the freshly
      // admitted command then runs against reset state with its own lease
      // intact. The rule is now "any write
      // that MINTS a new generation takes the state mutex", which covers
      // creation as well as takeover.
      //
      // Modelled by removing the lease mid-stall so the next claim is a
      // CREATION (`held === null`) — the same state a never-seen tree is in —
      // rather than by adding a second worktree, since the cross-tree helper is
      // synchronous and cannot express concurrency.
      //
      // Asserted as completion ORDER, like the takeover case: with the mutex a
      // creation can only finish after the holder releases; without it, it
      // takes no state lock at all and finishes first.
      const d = stateDirFor("create-takes-mutex");
      const holder = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(holder.pid),
        });

        const done: string[] = [];
        const signal = join(d, "create-is-holding");
        const running = state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(holder.pid),
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "3",
        }).then((r) => {
          done.push("holder");
          return r;
        });
        const deadline = Date.now() + 8000;
        while (!existsSync(signal)) {
          if (Date.now() > deadline) throw new Error("never signalled");
          await new Promise((r) => setTimeout(r, 10));
        }

        // No lease for this actor any more: the next claim must CREATE one.
        // `holder`'s pid, not a different one: this probes the PER-PR
        // creation-takes-the-mutex rule in isolation (`held === null` alone
        // already forces `mintsNewGeneration`, regardless of session), and a
        // genuinely different session here would now ALSO collide with
        // `holder`'s still-live TREE lease — a real, separate
        // mechanism this test is not about.
        const leaseFile = leasePathFor(d, "999", ACTOR);
        rmSync(leaseFile, { force: true });

        const creating = state(d, ["bump-round", "999", "--head", "ccc"], {
          DRIVE_PR_SESSION: String(holder.pid),
        }).then((r) => {
          done.push("creator");
          return r;
        });

        // The assertion is about WHEN THE LEASE APPEARS, not about completion
        // order. `bump-round` blocks on the state mutex for its own mutation
        // either way, so both orderings finish holder-then-creator and an
        // order-only probe cannot tell them apart — an earlier version of this
        // test did exactly that and stayed green under mutation. What the fix
        // changes is that `claimLease` writes the lease only after taking the
        // state mutex, so while the holder still owns it the file must not
        // exist. Without the fix it reappears almost immediately, which is
        // precisely how `reset` came to miss it.
        await new Promise((r) => setTimeout(r, 1200));
        expect(existsSync(leaseFile)).toBe(false);

        await Promise.all([running, creating]);
        expect(done).toEqual(["holder", "creator"]);
        // …and once the mutex frees, the lease really is created.
        expect(existsSync(leaseFile)).toBe(true);
      } finally {
        holder.stop();
      }
    });

    it("an UNIDENTIFIED reset is blocked by a live lease in its own tree", async () => {
      // Actor equality is a claim about the TREE, not about ownership, and
      // equating the two broke in the case the lease exists for: run `reset`
      // from this checkout with no session identity at all (tier 3 — both
      // `$DRIVE_PR_SESSION` and `$CLAUDE_PID` unset) and `claimLease` admits
      // nothing, yet a real driver's live lease here still has
      // `actor === selfActor`. It was therefore treated as "mine, not news",
      // and reset deleted the shared state and claim files out from under a
      // live driver whose generation is unchanged — so its fence still passes
      // and its in-flight finding dispatch can be duplicated.
      const d = stateDirFor("reset-unidentified");
      const driver = liveSession();
      try {
        // A live driver in THIS tree.
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(driver.pid),
        });
        // an earlier change's tree lease removed: an unidentified caller now refuses
        // MUCH earlier, at `claimLease` time (exit 11), whenever a live tree
        // lease exists at all — see `assertNoForeignSessionInTree`, which
        // subsumes this exact scenario going forward. Dropping it isolates
        // the mechanism THIS test actually pins: `clearAllLeases`'s own
        // `isOwn` protection, which remains the last line for a per-PR lease
        // with no accompanying tree lease — a legacy driver from before
        // an earlier change, or one whose tree lease independently expired.
        rmSync(treeLeasePathFor(d, ACTOR), { force: true });
        const claim = claimPathFor(d, "999", "FP");
        writeFileSync(claim, newClaimToken());

        // …and a reset with no session identity whatsoever.
        const r = await state(d, ["reset", "999"], {
          DRIVE_PR_SESSION: "",
          CLAUDE_PID: "",
        });
        expect(r.exitCode).toBe(9);
        expect(r.stderr).toContain("refusing to reset");
        expect(r.stderr).toContain(`pid ${driver.pid}`);
        // Nothing shared was deleted underneath the live driver.
        expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);
        expect(existsSync(claim)).toBe(true);
        expect(existsSync(leasePathFor(d, "999", ACTOR))).toBe(true);
      } finally {
        driver.stop();
      }
    });

    it("reset refuses while a claim is LIVE, even one of its own session", async () => {
      // A finding's answer is POSTed outside the state mutex, between claiming
      // and releasing. So the claiming session's own lease is `isOwn` — round
      // 15's ownership test says "mine, not blocking" — while its dispatch has
      // not landed. Deleting the claim there lets any later command see the
      // finding as unaddressed and answer it again, which is the duplicate
      // top-level comment the claim protocol exists to prevent.
      //
      // Keyed on the CLAIM rather than on ownership, precisely because
      // ownership is what fails to discriminate here: this reset runs under the
      // SAME session that holds the claim, and must still refuse.
      const d = stateDirFor("reset-live-claim");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(d, ["bump-round", "999", "--head", "aaa"], S);
      const claim = claimPathFor(d, "999", "FP");
      writeFileSync(claim, newClaimToken());

      const r = await state(d, ["reset", "999"], S);
      expect(r.exitCode).toBe(9);
      expect(r.stderr).toContain("live claim");
      expect(existsSync(claim)).toBe(true);
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);

      // A STALE claim is not a dispatch in flight, so it must NOT block the
      // reset a human ran to clear exactly that kind of debris.
      const old = Date.now() - 60 * 60_000;
      utimesSync(claim, new Date(old), new Date(old));
      const second = await state(d, ["reset", "999"], S);
      expect(second.exitCode).toBe(0);
      expect(existsSync(claim)).toBe(false);
    });

    it("reset refused by a live claim still reports a stale lease it already swept", async () => {
      // The mixed case the previous test's own comment flagged as uncovered:
      // `clearAllLeases` runs BEFORE the live-claim check and sweeps stale
      // leases unconditionally on its non-refusing path, so a reset that goes
      // on to refuse on a live claim can still have mutated the lease set.
      // The old unconditional "Nothing has been deleted" wording was false
      // whenever that happened.
      const d = stateDirFor("reset-live-claim-mixed-lease");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(d, ["bump-round", "999", "--head", "aaa"], S);
      const claim = claimPathFor(d, "999", "FP");
      writeFileSync(claim, newClaimToken());

      // A lease from a session that is definitively gone — stale by both age
      // and a pid nothing owns, same fixture shape as the MIXED-set probe
      // above.
      const stale = leasePathFor(d, "999", "wt-0000000000000099");
      writeFileSync(
        stale,
        JSON.stringify({
          holder: "session",
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          actor: "wt-0000000000000099",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          command: "hold",
          generation: "9".repeat(32),
          sessionStarted: "",
        }),
      );

      const r = await state(d, ["reset", "999"], S);
      expect(r.exitCode).toBe(9);
      // Swept, even though the reset as a whole refused.
      expect(existsSync(stale)).toBe(false);
      // What the refusal is actually FOR — the state file and the live claim
      // — stayed untouched.
      expect(existsSync(claim)).toBe(true);
      expect(existsSync(join(d, "drive-pr-999.json"))).toBe(true);
      // The message must not claim nothing was deleted when a lease was.
      expect(r.stderr).not.toContain("Nothing has been deleted");
      expect(r.stderr).toContain("stale session lease");
    });

    it("clear-lease is the way out, and reports the record it overrode", async () => {
      const d = stateDirFor("lease-clear");
      const a = liveSession();
      try {
        await holdAs(d, a.pid, A_URL);
        expect((await holdAs(d, process.pid, B_URL)).exitCode).toBe(11);

        const cleared = await state(d, ["clear-lease", "999"]);
        expect(cleared.exitCode).toBe(0);
        // A human running this is overriding a refusal; the record they are
        // overriding is the evidence for whether that was right.
        expect(cleared.stderr).toContain(`pid ${a.pid}`);

        const now = await holdAs(d, process.pid, B_URL);
        expect(now.exitCode).toBe(0);
        expect(
          JSON.parse((await state(d, ["held", "999"])).stdout),
        ).toMatchObject([{ key: "PRRT_x", commentUrl: B_URL }]);
      } finally {
        a.stop();
      }
    });

    it("never gates a READ — the refused session can still see why", async () => {
      // The session being refused is the one that most needs to inspect the
      // state and the lease. Gating the readers would leave it with nothing but
      // an exit code.
      const d = stateDirFor("lease-reads");
      const a = liveSession();
      try {
        await holdAs(d, a.pid, A_URL);
        const b = { DRIVE_PR_SESSION: String(process.pid) };
        for (const cmd of [
          ["get", "999"],
          ["rounds", "999"],
          ["held", "999"],
          ["held-keys", "999"],
          ["parked-keys", "999"],
          ["verified", "999"],
          ["lease", "999"],
        ]) {
          expect({
            cmd: cmd[0],
            code: (await state(d, cmd, b)).exitCode,
          }).toEqual({ cmd: cmd[0], code: 0 });
        }
        // And `lease` answers with the HOLDER, which is the whole point of
        // being able to read it from the refused side.
        expect(
          JSON.parse((await state(d, ["lease", "999"], b)).stdout),
        ).toMatchObject({ pid: a.pid, actor: ACTOR });
      } finally {
        a.stop();
      }
    });

    it("REFUSES a second WORKTREE driving one PR, with a distinct exit 13", async () => {
      // The reversal an earlier change exists for. This block used to assert the
      // opposite — "two worktrees are two leases and neither refuses the
      // other" — on the reasoning that the per-tree scoping serves the
      // Conductor topology an earlier change's per-hold provenance was built for. Both
      // halves of that reasoning are still true and neither was a reason to let
      // both trees TRIAGE: nothing stopped two worktrees enumerating the same
      // unresolved threads and each replying with its own outcome, so every
      // thread both reached carried two outcome replies — the identical damage
      // measured within one tree (seventeen doubled `**accepted**` replies),
      // reached across trees instead.
      //
      // Two REAL worktrees, because the actor is derived and deliberately not
      // overridable: a stand-in would prove the refusal fires on a value the
      // test chose rather than on the topology.
      const { a, b, env } = twoDrivers("lease-cross-tree");
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
        const fromB = drive(b, eb, [
          "hold",
          "999",
          "--key",
          "PRRT_b",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          B_URL,
        ]);
        // 13, not 11: a caller must be able to tell "another session in YOUR
        // tree" from "another tree entirely" without parsing prose, because
        // the remedies differ.
        expect(fromB.exitCode).toBe(13);
        expect(fromB.stderr).toContain("ANOTHER working tree");
        // Actionable: it names the holder's session AND a place a human can go.
        // The actor is a sha256 prefix, so a refusal carrying only that tells
        // the reader which tree in the one form they cannot act on.
        expect(fromB.stderr).toContain(`pid ${sessionA.pid}`);
        // `realpathSync`, because git's `--show-toplevel` resolves symlinks and
        // the macOS temp root is one (`/var` → `/private/var`). Comparing the
        // unresolved path passes on Linux and fails here for a reason that has
        // nothing to do with the behaviour under test.
        expect(fromB.stderr).toContain(realpathSync(a));
        expect(fromB.stderr).toContain("clear-lease 999 --all");

        // NOTHING was written by the refused tree — not the hold, and not a
        // lease of its own. A refusal that installed a lease would leave one
        // this session's next command fast-paths off without ever re-reaching
        // the gate, which would make the whole admission model decorative.
        const held = JSON.parse(drive(a, ea, ["held", "999"]).stdout);
        expect(held.map((h: { key: string }) => h.key)).toEqual(["PRRT_a"]);
        const leases = JSON.parse(
          drive(a, ea, ["lease", "999", "--all"]).stdout,
        );
        expect(leases).toHaveLength(1);
      } finally {
        sessionA.stop();
      }
    });

    it("refuses a SESSIONLESS tree too — taking a lease needs an identity, checking one does not", async () => {
      // Ladder tier 3 returned before the PR-wide gate ever ran, so a runtime
      // that identifies no session mutated straight through it — and two such
      // resolvers in two worktrees still produced the doubled outcome replies
      // this module exists to prevent. Taking a lease
      // and reading someone else's are different capabilities, and only the
      // first needs an identity.
      const { a, b, env } = twoDrivers("lease-cross-tree-sessionless");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // No session identity at all: BOTH variables unset, which is what tier
        // 3 actually is — not merely an unusable value.
        const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        const fromB = drive(b, sessionless, [
          "phase",
          "999",
          "--set",
          "triage",
        ]);
        expect(fromB.exitCode).toBe(13);
        expect(fromB.stderr).toContain("ANOTHER working tree");

        // A REFUSED tree installs nothing — which after an earlier change is a claim
        // about the refusal, not about tier 3: a sessionless caller that is
        // ADMITTED does now leave a record (see the two-sessionless probe
        // below). Refusing first and writing second is what keeps that true;
        // the reverse order would leave a refused tree holding a live record
        // its own next command would fast-path off. Asserted through the read
        // surface because these two worktrees share the CLONE-WIDE state dir
        // that `twoDrivers` deliberately leaves unset, so the test has no path
        // to stat: only A's lease exists.
        const leases = JSON.parse(
          drive(a, ea, ["lease", "999", "--all"]).stdout,
        );
        expect(leases).toHaveLength(1);
        expect(leases[0].self).toBe(true);

        // And the refusal is not blanket: with A gone, the same sessionless
        // invocation is admitted. Otherwise this test would pass against a gate
        // that simply refuses every sessionless caller.
        sessionA.stop();
        await awaitPidGone(sessionA.pid);
        expect(
          drive(b, sessionless, ["phase", "999", "--set", "triage"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
      }
    });

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
      // it themselves) — an earlier change's default, `~/.local/state/jig/drive-pr/
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
      // Intra-tree behaviour must not change: before an earlier change a sessionless
      // caller left nothing, so a Claude Code session starting in the same tree
      // met an empty slot. It now meets a record — and if that record refused
      // it, the cost of closing a cross-tree hole would be a NEW intra-tree
      // refusal, on a path a human clears only with `clear-lease` or by waiting
      // out a window measured in hours.
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
      // The path probed here is the ONE tier-3 case that still claims nothing
      // after an earlier change: this tree already holds a live SESSION lease, so it is
      // represented in the PR-wide gate already and the sessionless caller
      // deliberately leaves it alone (overwriting it would be a takeover it
      // cannot justify — see `clearAllLeases`). That is exactly
      // the case with no lease of its own to fence on, so
      // `assertNoForeignDriveNow` remains its fence and this probe remains its
      // regression test. The tier-3 path that DOES claim now is fenced by
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
          [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
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
      // The other half of the sessionless fence after an earlier change. A tier-3
      // caller that found nothing in its tree writes a `worktree` record and is
      // therefore admitted on a lease like anybody else — so its fence is
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
        [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
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
        // Both trees land on the same state dir because they share one clone
        // — these probes deliberately leave $DRIVE_PR_STATE_DIR unset so
        // that both resolve it themselves. an earlier change's default,
        // `~/.local/state/jig/drive-pr/<cloneKey>/`, keyed off `--git-common-dir`
        // rather than the common dir itself.
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
        expect(fromB[0]?.worktree).toBe(realpathSync(a));
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
        expect(cleared.stderr).toContain(realpathSync(a));

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
      // This was a PRESERVE-and-continue test. Preserving the foreign lease is
      // still necessary but is not sufficient: the state file and the CLAIM
      // files are shared by every tree driving the PR, so continuing let this
      // tree delete a live session's in-flight claim and re-dispatch a
      // non-idempotent answer it had already claimed. `reset` then
      // refused outright, deleting nothing.
      //
      // an earlier change moved WHERE that refusal comes from, not whether it happens.
      // `reset` is a leased command, and this tree holds no lease yet, so its
      // claim is a fresh admission and meets the PR-wide gate first — exit 13,
      // naming the same holder, before `reset`'s own exit-9 branch is reached.
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
      // B is not A (the `sessionStarted` tokens differ) — but before
      // an earlier change, `assertNoForeignDrive` asked `leaseAlive` whether A's
      // recorded pid was still answering, and once that pid is B's OWN, the
      // answer is trivially "yes": B was refused exit 13 for a full staleness
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
      // End-to-end through BOTH fixed call sites: `reset` is a leased command,
      // so tree B's claim meets the PR-wide gate first (as above), and only
      // then reaches `clearAllLeases`'s own `leaseAlive` check on tree A's
      // now-doubly-stale record. Before an earlier change either one alone was enough
      // to leave tree A's lease standing — refused at admission (exit 13), or
      // admitted and then reported as a live foreign lease to preserve.
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

  describe("the tree-wide session lease across PRs", () => {
    // an earlier change's lease is scoped to (working tree, PR): two interactive
    // sessions in ONE tree driving TWO DIFFERENT PRs resolve two different
    // `leasePathFor` files, so neither refuses the other and both are
    // admitted into the SAME checkout — which they can then edit, commit, and
    // push over one another. `drive.ts` already closes the analogous
    // unattended-path gap with a worktree-wide single-instance lock; this is
    // the interactive counterpart.

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
        // with A's, but it shares the SAME working tree, which is exactly why
        // an earlier change exists.
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

    it("two DIFFERENT worktrees stay fully independent — an earlier change does not widen an earlier change", async () => {
      // Two DIFFERENT PRs so an earlier change's PR-wide gate has nothing to say —
      // this probes only whether the tree lease (keyed by actor) leaks across
      // actors, which it must not: two Conductor worktrees are two different
      // trees BY DESIGN, and remain so after this module gains a second lease
      // file.
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

    it("two SESSIONLESS worktrees driving the SAME PR now EXCLUDE each other", async () => {
      // Superseded by an earlier change: this test used to assert the OPPOSITE — that
      // an earlier change must not narrow the topology an earlier change's per-hold provenance
      // was built for, i.e. that two sessionless worktrees on the SAME PR
      // stayed both admitted, because tier 3 never wrote a per-PR lease at
      // all. It now does (`holder: 'worktree'`, keyed by actor rather than
      // pid), specifically to close this exact gap — two sessionless
      // resolvers on one PR could otherwise both post `**accepted**` to the
      // same thread. The SECOND worktree here now hits an earlier change's own
      // PR-wide gate (exit 13, `assertNoForeignDrive`) via the presence
      // lease the first one wrote, the identical refusal an IDENTIFIED
      // session gets in `REFUSES a second WORKTREE driving one PR`.
      const { a, b, env } = twoDrivers("lease-tree-same-pr-both-admitted");
      expect(
        drive(a, env, ["bump-round", "999", "--head", "aaa"]).exitCode,
      ).toBe(0);
      expect(
        drive(b, env, ["bump-round", "999", "--head", "bbb"]).exitCode,
      ).toBe(13);
    });

    describe("the sessionless tier claims the tree lease too", () => {
      it("two sessionless resolvers in ONE tree driving DIFFERENT PRs now refuse each other", async () => {
        // The gap an earlier change closes: before this, ladder tier 3 only CHECKED the
        // tree lease and never claimed one, so two sessionless resolvers on
        // different PRs from the SAME tree both passed admission — free to
        // edit, commit, and push over one another in the same checkout, the
        // exact cross-shipping hazard an earlier change exists to close for identified
        // sessions.
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
          [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
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
        // there (a PR-wide an earlier change refusal from ANOTHER tree, in this
        // probe) must not leave the tree claim it just minted behind,
        // wedging this tree for any OTHER pr this actor might claim next.
        const { a, b, env } = twoDrivers("lease-tree-rollback-sessionless");
        const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };

        // Tree A takes PR 999 first.
        expect(
          drive(a, sessionless, ["bump-round", "999", "--head", "aaa"])
            .exitCode,
        ).toBe(0);

        // Tree B: `claimSessionlessTreeLease` succeeds — tree B has never
        // held any tree-wide claim — but `claimPrLease` then hits an earlier change's
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
          [join(SCRIPTS, "release-sessionless-lease.ts"), ...args],
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
          [join(SCRIPTS, "release-sessionless-lease.ts"), ...args],
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
          [join(SCRIPTS, "drive-state.ts"), "phase", "999", "--set", "triage"],
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

    describe("`treeIsMine` — the tree-wide file is no longer session-exclusive", () => {
      // `isMine`'s `holder === 'worktree'` branch answers pure actor
      // equality, correct for the PER-PR presence record (already scoped to
      // (tree, pr) by its own filename) but silently wrong once a sessionless
      // resolver can ALSO write a `holder: 'worktree'` record to the
      // TREE-WIDE file: every caller in this tree, whichever pr it names,
      // would read it as "mine". Caught in review before shipping — these
      // probes reproduce both directions the hole opened.

      it("an identified session claiming a DIFFERENT pr refuses on a live sessionless tree claim, rather than silently overwriting it", async () => {
        const d = stateDirFor("lease-tree-treeismine-cross-pr");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const holder = liveSession();
        try {
          const refused = await state(
            d,
            ["bump-round", "888", "--head", "bbb"],
            { DRIVE_PR_SESSION: String(holder.pid) },
          );
          expect(refused.exitCode).toBe(11);
          expect(refused.stderr).toContain("sessionless resolver");
          expect(refused.stderr).toContain("PR #999");
          expect(existsSync(leasePathFor(d, "888", ACTOR))).toBe(false);
          // The tree record is still the sessionless resolver's own — an
          // identified session must never silently overwrite it.
          const tree = JSON.parse(
            readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
          );
          expect({ holder: tree.holder, pr: tree.pr }).toEqual({
            holder: "worktree",
            pr: "999",
          });
        } finally {
          holder.stop();
        }
      });

      it("an identified session claiming the SAME pr upgrades a live sessionless tree claim smoothly, no refusal", async () => {
        // The deliberate, intentional counterpart of the probe above — a
        // matching pr is a legitimate resolver-lifetime handoff, mirroring
        // an earlier change's own per-PR ruling that an identified session may take
        // over its own tree's presence record freely.
        const d = stateDirFor("lease-tree-treeismine-same-pr-upgrade");
        const sessionless = { DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        expect(
          (await state(d, ["bump-round", "999", "--head", "aaa"], sessionless))
            .exitCode,
        ).toBe(0);

        const holder = liveSession();
        try {
          const upgraded = await state(
            d,
            ["bump-round", "999", "--head", "bbb"],
            { DRIVE_PR_SESSION: String(holder.pid) },
          );
          expect(upgraded.exitCode).toBe(0);
          const tree = JSON.parse(
            readFileSync(treeLeasePathFor(d, ACTOR), "utf8"),
          );
          expect({ holder: tree.holder, pid: tree.pid, pr: tree.pr }).toEqual({
            holder: "session",
            pid: holder.pid,
            pr: "999",
          });
        } finally {
          holder.stop();
        }
      });

      it("the irreversible-post fence (assertTreeMutationAllowed) refuses a post under a live sessionless tree claim on a DIFFERENT pr", async () => {
        const d = mkdtempSync(join(tmpdir(), "drive-pr-tree-post-fence-"));
        const path = treeLeasePathFor(d, ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/this/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        // `fail()` throws an `ExitError` whose MESSAGE is just `exit ${code}`
        // — the descriptive text goes to `console.error` (stderr), not the
        // exception — so the outcome to assert on is the code, mirroring
        // every other in-process fence probe in this file (e.g.
        // `assertLeaseUnchanged`'s own "alternation hazard" probe above).
        let threw: unknown;
        try {
          await assertTreeMutationAllowed(
            {
              stateDir: d,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: d,
            },
            "888",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      });

      it("the irreversible-post fence (assertTreeMutationAllowed) allows a post under a live sessionless tree claim on the SAME pr", async () => {
        const d = mkdtempSync(join(tmpdir(), "drive-pr-tree-post-fence-same-"));
        const path = treeLeasePathFor(d, ACTOR);
        writeFileSync(
          path,
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: ACTOR,
            worktree: "/this/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        const lock = await assertTreeMutationAllowed(
          {
            stateDir: d,
            actor: ACTOR,
            session,
            fromOverride: false,
            legacyStateDirForFallback: d,
          },
          "999",
          "test",
        );
        lock.release();
        lock.dispose();
      });

      it("re-resolves the legacy-fallback directory LIVE before acquiring, catching a tree lease written after the snapshot decision", async () => {
        // The tree-fence counterpart of the TOCTOU fix and the matching
        // lock-ordering fix for `assertRemoteMutationAllowed`: a
        // stale `ctx.stateDir` (as `resolveFenceContext` would have snapshot-
        // decided from a genuinely empty legacy directory) must not make
        // this fence lock and check the WRONG directory once a concurrent
        // admission has since written into the relocated one.
        const legacyDir = mkdtempSync(
          join(tmpdir(), "drive-pr-tree-legacy-fallback-race-"),
        );
        const newDir = defaultStateDirFor(legacyDir);
        try {
          mkdirSync(newDir, { recursive: true });
          // A live tree lease for a DIFFERENT pr, in the RELOCATED
          // directory — exactly what a concurrent `drive.ts` admitted after
          // the snapshot would have written.
          writeFileSync(
            treeLeasePathFor(newDir, ACTOR),
            JSON.stringify({
              holder: "worktree",
              pid: 0,
              host: hostname(),
              platform: process.platform,
              actor: ACTOR,
              worktree: "/this/tree",
              startedAt: new Date().toISOString(),
              lastSeen: new Date().toISOString(),
              command: "bump-round",
              generation: "f".repeat(32),
              sessionStarted: "",
              pr: "999",
              revision: "a".repeat(32),
            }),
          );
          const session: Session = {
            pid: process.pid,
            host: hostname(),
            source: "DRIVE_PR_SESSION",
            sessionStarted: "",
          };
          let threw: unknown;
          try {
            await assertTreeMutationAllowed(
              {
                // The STALE snapshot decision — what `resolveFenceContext`
                // would have returned before the concurrent admission above
                // landed.
                stateDir: legacyDir,
                actor: ACTOR,
                session,
                fromOverride: false,
                legacyStateDirForFallback: legacyDir,
              },
              "888",
              "test",
            );
          } catch (e) {
            threw = e;
          }
          expect(threw).toBeInstanceOf(ExitError);
          expect((threw as ExitError).code).toBe(11);
        } finally {
          rmSync(newDir, { recursive: true, force: true });
          rmSync(legacyDir, { recursive: true, force: true });
        }
      });
    });

    it("clear-lease also drops the TREE lease, so the refusal's own remedy actually works", async () => {
      const d = stateDirFor("lease-tree-clear-drops-tree");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);

        // A live session, a DIFFERENT PR — refused, per the primary probe
        // above.
        const refused = await state(d, ["bump-round", "888", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(refused.exitCode).toBe(11);

        // The refusal names the REFUSED command's own PR (888) as the
        // remedy — `clear-lease ${pr}` uses `claimTreeLease`'s own `pr`
        // parameter, which is the PR this command asked for, not the one the
        // holder is on. Followed exactly as printed: running it must
        // actually free the tree, not just the (never-written) PR-888
        // per-PR record, or the documented remedy is a dead end.
        expect(refused.stderr).toContain("clear-lease 888");
        expect(
          (
            await state(d, ["clear-lease", "888"], {
              DRIVE_PR_SESSION: String(process.pid),
            })
          ).exitCode,
        ).toBe(0);

        expect(
          (
            await state(d, ["bump-round", "888", "--head", "bbb"], {
              DRIVE_PR_SESSION: String(process.pid),
            })
          ).exitCode,
        ).toBe(0);
      } finally {
        a.stop();
      }
    });

    it("self-recovers from a session that is GONE, whichever PR it was on", async () => {
      const d = stateDirFor("lease-tree-dead");
      const a = liveSession();
      await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(a.pid),
      });
      a.stop();
      await awaitPidGone(a.pid);

      // A DIFFERENT PR than the one the dead session was on.
      const next = await state(d, ["bump-round", "888", "--head", "bbb"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(next.exitCode).toBe(0);
      expect(next.stderr).toContain("took over an abandoned TREE lease");
    });

    it("assertTreeLeaseUnchanged fences the documented residual — a takeover for a DIFFERENT pr races an in-flight command", async () => {
      // `claimTreeLease`'s own takeover only coordinates with the state mutex
      // of the PR IT is claiming — a deliberate, documented boundary (see its
      // comment): a takeover for pr 888 does not wait out a command already
      // mid-mutation on pr 999. That leaves a window only the admission
      // fence can close: the pr-999 command was admitted BEFORE the pr-888
      // takeover happened, so it must be refused on its way out rather than
      // let to write beside a tree the takeover has already reassigned.
      const d = stateDirFor("lease-tree-fence-residual");
      const a = liveSession();
      let running: ReturnType<typeof state> | undefined;
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(a.pid),
        });

        // Session `a`'s SECOND pr-999 command stalls inside its locked
        // section, holding pr 999's state mutex.
        const signal = join(d, "fence-residual-is-holding");
        running = state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(a.pid),
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "3",
        });
        const deadline = Date.now() + 8000;
        while (!existsSync(signal)) {
          if (Date.now() > deadline) throw new Error("never signalled");
          await new Promise((r) => setTimeout(r, 10));
        }

        // `a` dies while `running` is still mid-mutation on pr 999…
        a.stop();
        await awaitPidGone(a.pid);

        // …and a REPLACEMENT session takes the tree over for a DIFFERENT pr
        // (888). Nothing orders this against `running`'s pr-999 mutex, so it
        // completes immediately rather than queuing behind it.
        const taker = await state(d, ["bump-round", "888", "--head", "ccc"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(taker.exitCode).toBe(0);
        expect(taker.stderr).toContain("took over an abandoned TREE lease");

        // `running` now finishes its stall and reaches the fence — the tree
        // lease it was admitted under is gone, taken by `taker`, so it must
        // be refused rather than write PR 999's state beside a tree that no
        // longer believes `a` is driving it.
        const r = await running;
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain(
          "TREE lease (admitted for PR #999) was taken over while this command waited",
        );
      } finally {
        a.stop();
        // If an assertion above threw, `running`'s stalled child still holds
        // PR 999's state lock — leaving the promise unobserved surfaces its
        // eventual settlement as a second, misleading unhandled-rejection
        // failure rather than just the original assertion.
        await running?.catch(() => {});
      }
    });

    it("refuses to treat an unreadable-but-fresh TREE lease as absent", async () => {
      // A file that EXISTS but cannot be parsed is evidence some session
      // wrote it — treating that as absent would mint a new generation over
      // a possibly-still-live foreign session on the strength of a record
      // nobody could actually read, the exact gap `unreadableLeaseFilesFor`
      // already closes for the PR-wide gate.
      const d = stateDirFor("lease-tree-unreadable");
      writeFileSync(treeLeasePathFor(d, ACTOR), "not valid json{{{");
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      // 11, not a generic 1 — the same exit this same check's own
      // confirmed-live-foreign-session case uses.
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("could not be read as one");
      // Nothing was written over it.
      expect(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).toBe(
        "not valid json{{{",
      );
    });

    it("the SESSIONLESS tier also refuses to treat an unreadable-but-fresh TREE lease as absent", async () => {
      // The identified claim path closes this
      // (`claimTreeLease`'s own writer); the sessionless preflight and fence
      // read the SAME file through plain `readTreeLease`, which collapses
      // "absent" and "unreadable" to the identical `null` — so a sessionless
      // command was still admitted past a record a live session might still
      // own, on the strength of a file nobody could actually parse.
      const d = stateDirFor("lease-tree-unreadable-sessionless");
      writeFileSync(treeLeasePathFor(d, ACTOR), "not valid json{{{");
      const r = await state(d, ["bump-round", "999", "--head", "aaa"], {
        DRIVE_PR_SESSION: "",
        CLAUDE_PID: "",
      });
      // 11, matching the identified path's own fix above.
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("could not be read as one");
      expect(readFileSync(treeLeasePathFor(d, ACTOR), "utf8")).toBe(
        "not valid json{{{",
      );
    });

    it("rolls back a freshly-created tree lease when the per-PR claim fails afterward", async () => {
      // `claimTreeLease` writes BEFORE `claimPrLease`'s own checks run — so a
      // failure there (a PR-wide an earlier change refusal from ANOTHER tree, in this
      // probe) must not leave the tree lease it just minted behind, wedging
      // this tree for any OTHER identified session on a PR that was never
      // actually admitted.
      const { a, b, env } = twoDrivers("lease-tree-rollback");
      const sessionA = liveSession();
      const sessionB = liveSession();
      const sessionC = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(sessionB.pid) };
        const ec = { ...env, DRIVE_PR_SESSION: String(sessionC.pid) };

        // Tree A takes PR 999 first.
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // Tree B, session B: `claimTreeLease` succeeds — tree B has never
        // held any lease — but `claimPrLease` then hits an earlier change's cross-tree
        // gate on PR 999 (tree A already holds it) and refuses.
        expect(
          drive(b, eb, ["bump-round", "999", "--head", "bbb"]).exitCode,
        ).toBe(13);

        // A DIFFERENT session in tree B, a DIFFERENT PR. Session B's own tree
        // lease would trivially self-renew (`isMine`), so it cannot detect a
        // leftover lease — session C can: if session B's failed claim had
        // left its tree lease on disk, THIS would be refused (exit 11) by a
        // lease pointing at a PR that was never actually admitted.
        expect(
          drive(b, ec, ["bump-round", "888", "--head", "ccc"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
        sessionB.stop();
        sessionC.stop();
      }
    });

    it("a sibling's failed claim does not destroy this session's own successful admission", async () => {
      // A rollback comparing identity `(pid, host, generation)` alone
      // — which two commands from the SAME session share identically
      // whenever a renewal preserves the generation, DELIBERATELY, since
      // that is what lets one session juggle several PRs without refusing
      // itself. So a failed SECOND claim's rollback could restore a stale
      // snapshot over — or delete — a successful FIRST claim by the exact
      // same session. The fix is a raw-string compare-and-swap, with the
      // "before" snapshot captured under the SAME lock as the write, so a
      // later claim's rollback can only ever undo what THAT claim itself
      // wrote.
      const { a, b, env } = twoDrivers("lease-tree-sibling-clobber");
      const sessionShared = liveSession();
      const sessionOther = liveSession();
      try {
        const eShared = { ...env, DRIVE_PR_SESSION: String(sessionShared.pid) };
        const eOther = { ...env, DRIVE_PR_SESSION: String(sessionOther.pid) };

        // Tree B, a DIFFERENT session, holds PR 777 first.
        expect(
          drive(b, eOther, ["bump-round", "777", "--head", "xxx"]).exitCode,
        ).toBe(0);

        // Tree A, sessionShared: successfully admits PR 999 — the successful
        // sibling write whose survival this probe checks.
        expect(
          drive(a, eShared, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // Tree A, sessionShared AGAIN, a DIFFERENT PR: `claimTreeLease`
        // succeeds (a renewal — same session), but `claimPrLease` then hits
        // an earlier change's cross-tree gate (tree B already holds 777) and fails.
        // Its rollback must not destroy the tree lease that still
        // legitimately admits this session for PR 999.
        expect(
          drive(a, eShared, ["bump-round", "777", "--head", "yyy"]).exitCode,
        ).toBe(13);

        // A THIRD, different session in tree A: still refused — proof the
        // tree lease SURVIVED sessionShared's failed second claim, rather
        // than being deleted or rewound to a stale pre-PR-999 snapshot.
        const sessionThird = liveSession();
        try {
          const eThird = { ...env, DRIVE_PR_SESSION: String(sessionThird.pid) };
          expect(
            drive(a, eThird, ["bump-round", "999", "--head", "zzz"]).exitCode,
          ).toBe(11);
        } finally {
          sessionThird.stop();
        }
      } finally {
        sessionShared.stop();
        sessionOther.stop();
      }
    });

    it("clear-lease reports the TREE lease it drops, not just the per-PR one", async () => {
      // The common real-world shape of this call: an operator follows a
      // cross-PR refusal's own `clear-lease <requested-pr>` suggestion,
      // where there is normally NO per-PR lease for that pr at all — round
      // 1's `Lease | null` return reported only that (empty) half, so the
      // live tree lease it silently overrode went unreported.
      const d = stateDirFor("lease-tree-clear-reports-both");
      const a = liveSession();
      try {
        expect(
          (
            await state(d, ["bump-round", "999", "--head", "aaa"], {
              DRIVE_PR_SESSION: String(a.pid),
            })
          ).exitCode,
        ).toBe(0);

        // No per-PR lease exists for 888 — clear-lease must still report the
        // TREE lease it drops, and NOT the "nothing to clear" message
        // (something genuinely was).
        const cleared = await state(d, ["clear-lease", "888"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(cleared.exitCode).toBe(0);
        expect(cleared.stderr).not.toContain("nothing to clear");
        expect(cleared.stderr).toContain(
          `cleared this working tree's TREE lease`,
        );
        expect(cleared.stderr).toContain(`pid ${a.pid}`);
        expect(cleared.stderr).toContain("was on PR #999");
      } finally {
        a.stop();
      }
    });

    it("clear-lease reports genuinely nothing when neither lease exists", async () => {
      const d = stateDirFor("lease-tree-clear-nothing");
      const cleared = await state(d, ["clear-lease", "999"], {
        DRIVE_PR_SESSION: String(process.pid),
      });
      expect(cleared.exitCode).toBe(0);
      expect(cleared.stderr).toContain(
        "no drive lease on PR #999 from this working tree — nothing to clear",
      );
    });
  });

  describe("the PR-wide remote-mutation lock spans the push/POST", () => {
    it("assertRemoteMutationAllowed HOLDS the PR-wide lock, not just checks it", async () => {
      // The gap this closes: before this fix, the fence read the per-PR
      // lease set and returned `void` — the underlying PR-wide lock was
      // never taken at all, so a DIFFERENT worktree's admission could land
      // in the exact window between the check and `git push` (or the POST)
      // completing. Proven directly at the lock level, independent of
      // `guarded-push.ts`'s own subprocess plumbing — the same shape as the
      // tree lock's own proof above: a second acquirer of the SAME
      // PR-remote-mutation-lock path — via the identical `createLock(path,
      // ...)` call `prRemoteMutationLockPathFor` resolves to — must stay
      // BLOCKED for as long as the returned lock is held.
      const d = mkdtempSync(join(tmpdir(), "drive-pr-remote-lock-held-"));
      const path = prRemoteMutationLockPathFor(d, "999");
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      // No lease seeded — the fence's own per-PR enumeration finds nothing,
      // so the lock is the only thing left to prove.
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir: d,
          actor: ACTOR,
          session,
          fromOverride: false,
          legacyStateDirForFallback: d,
        },
        "999",
        "test",
      );
      expect(lock).not.toBeNull();
      let released = false;
      try {
        const rival = createLock(
          path,
          "drive-state.ts (pr remote mutation)",
          "999",
        );
        let rivalAcquired = false;
        const rivalPromise = rival
          .acquire(5)
          .then(() => {
            rivalAcquired = true;
          })
          .finally(() => {
            rival.release();
            rival.dispose();
          });
        await new Promise((res) => setTimeout(res, 300));
        // Still held 300ms later — the rival must not have gotten in while
        // this lock was live, which is the whole property under test.
        expect(rivalAcquired).toBe(false);
        lock?.release();
        lock?.dispose();
        released = true;
        await rivalPromise;
        expect(rivalAcquired).toBe(true);
      } finally {
        if (!released) {
          lock?.release();
          lock?.dispose();
        }
      }
    });

    it("re-resolves the legacy-fallback directory LIVE, catching a drive admitted after the snapshot decision (TOCTOU)", async () => {
      // The race this closes: `resolveFenceContext` decides `legacyDir` vs
      // its relocation ONCE, as a snapshot — an empty, unmarked
      // legacy directory at that instant resolves to `legacyDir`. If a
      // concurrent current-code `drive.ts` is admitted into the relocated
      // directory (creates it, writes its lease) any time between that
      // snapshot and this fence's own check, a fence that trusted the stale
      // snapshot would enumerate the wrong directory and miss that lease
      // entirely — an exact fail-open.
      //
      // Reproduced directly at the `ctx` level, the same way the override
      // path's rename-and-recreate races are proven elsewhere in this file:
      // hand-build a `ctx` that matches what `resolveFenceContext` would
      // have returned from a genuinely empty legacy directory (`stateDir`
      // pinned to `legacyDir`, `fromOverride: false`), THEN — simulating the
      // concurrent admission — write a live foreign lease into
      // `defaultStateDirFor(legacyDir)`, and only THEN call
      // `assertRemoteMutationAllowed` with the stale `ctx`. It must still
      // refuse: that is only possible if the fence re-derives the directory
      // choice live, rather than trusting `ctx.stateDir` as resolved.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "drive-pr-legacy-fallback-race-"),
      );
      // `defaultStateDirFor` resolves under the REAL `os.homedir()` — this
      // legacyDir mints a fresh, random clone identity, so the resulting
      // `newDir` is a unique, never-otherwise-touched path (never collides
      // with the developer's own real drive-pr state), but it is still a
      // real write outside this test's own tmpdir and must be cleaned up
      // explicitly — nothing removes it automatically, and leaving one behind
      // on every run accumulates without bound.
      const newDir = defaultStateDirFor(legacyDir);
      try {
        mkdirSync(newDir, { recursive: true });
        const foreignActor = "wt-00000000deadbeef";
        // `holder: 'worktree'` — `isMine` decides a tree-held record purely
        // by `actor` (never pid/host, see its own comment), so this is
        // genuinely foreign as long as `foreignActor` differs from the
        // caller's own `ACTOR` below, with no need to spawn a separate live
        // process just to get a pid `isMine`'s (pid, host) branch would not
        // treat as ours. `leaseAlive` for this holder kind checks only
        // `lastSeen` freshness.
        writeFileSync(
          leasePathFor(newDir, "999", foreignActor),
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: foreignActor,
            worktree: "/some/other/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        let threw: unknown;
        try {
          await assertRemoteMutationAllowed(
            {
              // The STALE snapshot decision — what `resolveFenceContext`
              // would have returned before the concurrent admission above
              // landed.
              stateDir: legacyDir,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: legacyDir,
            },
            "999",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("never mints a clone identity for a genuinely fresh legacy dir", async () => {
      // This fence is documented as lightweight and read-only, but the
      // original `resolveLegacyFallbackDir` called `defaultStateDirFor`
      // unconditionally, which calls `cloneKey` — durably minting and
      // persisting a fresh clone identity (`drive-pr-clone-id`) the first
      // time it runs on a legacy dir that has none. A read-only check must
      // not have that side effect. `legacyDir` here has no such file at all
      // (a genuinely never-driven clone), so `peekDefaultStateDirFor` must
      // return `null` and the fence must fall back to `legacyDir` WITHOUT
      // minting anything.
      const legacyDir = mkdtempSync(join(tmpdir(), "drive-pr-no-mint-legacy-"));
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      expect(existsSync(join(legacyDir, "drive-pr-clone-id"))).toBe(false);
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir: legacyDir,
          actor: ACTOR,
          session,
          fromOverride: false,
          legacyStateDirForFallback: legacyDir,
        },
        "999",
        "test",
      );
      try {
        expect(existsSync(join(legacyDir, "drive-pr-clone-id"))).toBe(false);
      } finally {
        lock?.release();
        lock?.dispose();
      }
    });

    it("prefers an empty, not-yet-created newDir over acquiring the PR-wide lock in legacyDir when legacyDir holds nothing", async () => {
      // Two things proven together: the lock is acquired against the SAME
      // directory `resolveLegacyFallbackDir` would resolve to fresh (a lock
      // built from the STALE `ctx.stateDir` before any live refresh ran would
      // target the wrong directory), and that fresh resolution avoids
      // `legacyDir` entirely when it holds no real footprint (every acquire/
      // release leaves a permanent quarantine tombstone in whatever
      // directory it targets, which `legacyFootprint()` then reads back as
      // "unmigrated state", manufacturing the very refusal an earlier change exists
      // to prevent).
      //
      // `legacyDir` carries a PRE-EXISTING clone identity (so `newDir`'s path
      // is knowable via `peekDefaultStateDirFor` without this call minting
      // one) but is otherwise completely empty — no drive-pr footprint of
      // any kind — and `newDir` does not exist yet either. The stale `ctx`
      // handed to the fence still names `legacyDir` (as if resolved before
      // this state existed), mirroring the exact snapshot-then-check gap the
      // TOCTOU fix closed for enumeration; this test is the same gap
      // for the LOCK.
      //
      // Run as a SUBPROCESS, not in-process like the sibling tests above:
      // `peekDefaultStateDirFor`/`defaultStateDirFor` resolve `newDir` under
      // `os.homedir()`, and under Bun (unlike Node) `os.homedir()` does NOT
      // re-read `$HOME` from `process.env` after startup — an in-process
      // `process.env.HOME = fakeHome` before calling the fence is silently
      // ineffective, and the fence resolves and mutates the REAL developer's
      // `~/.local/state/jig` instead (measured while writing this test: it did).
      // Only a genuinely separate process picks up a faked `$HOME` cold, the
      // same reason `suiteHome`/`gitCleanEnv()` above route every
      // `homedir()`-sensitive probe in this file through a subprocess rather
      // than an in-process env mutation.
      const probeDir = mkdtempSync(
        join(tmpdir(), "drive-pr-empty-legacy-prefers-new-probe-"),
      );
      const legacyDir = join(probeDir, "legacy");
      const fakeHome = join(probeDir, "home");
      mkdirSync(legacyDir, { recursive: true });
      mkdirSync(fakeHome, { recursive: true });
      // A real, persisted clone identity — written the same way
      // `cloneKey`/`defaultStateDirFor` would, but without invoking either,
      // so this fixture does not itself depend on the code path under test.
      // UUID-shaped (never a bare label) so it survives `clone-key.ts`'s own
      // validation, which refuses anything `randomUUID()` would not have
      // minted — the same fixed value `migrate-legacy-state.test.ts` uses for
      // the identical reason.
      const cloneId = "4c1d2e3f-1a2b-4c3d-8e4f-0123456789ab";
      writeFileSync(join(legacyDir, "drive-pr-clone-id"), `${cloneId}\n`);
      const newDir = join(
        fakeHome,
        ".local",
        "state",
        "jig",
        "drive-pr",
        createHash("sha256").update(cloneId).digest("hex").slice(0, 16),
      );
      const leaseTsPath = join(SCRIPTS, "lib", "state", "lease.ts");
      const probeScript = join(probeDir, "probe.ts");
      writeFileSync(
        probeScript,
        [
          `import { existsSync, readdirSync } from 'node:fs';`,
          `import { hostname } from 'node:os';`,
          `import { assertRemoteMutationAllowed, prRemoteMutationLockPathFor } from ${JSON.stringify(leaseTsPath)};`,
          `const legacyDir = ${JSON.stringify(legacyDir)};`,
          `const newDir = ${JSON.stringify(newDir)};`,
          `const session = { pid: process.pid, host: hostname(), source: 'DRIVE_PR_SESSION', sessionStarted: '' };`,
          `const lock = await assertRemoteMutationAllowed(`,
          `  { stateDir: legacyDir, actor: 'wt-probe', session, fromOverride: false, legacyStateDirForFallback: legacyDir },`,
          `  '999', 'test',`,
          `);`,
          `console.log(JSON.stringify({`,
          `  lockAtNewDir: existsSync(prRemoteMutationLockPathFor(newDir, '999') + '.lock'),`,
          `  legacyDirEntries: readdirSync(legacyDir),`,
          `}));`,
          `lock?.release();`,
          `lock?.dispose();`,
        ].join("\n"),
      );
      try {
        expect(existsSync(newDir)).toBe(false);
        const r = Bun.spawnSync([process.execPath, probeScript], {
          env: { ...gitCleanEnv(), HOME: fakeHome },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(r.stderr.toString()).toBe("");
        const result = JSON.parse(r.stdout.toString());
        expect(result.lockAtNewDir).toBe(true);
        // legacyDir must show NOTHING drive-pr related beyond the
        // pre-seeded clone-id fixture itself — no lock, no quarantine.
        expect(result.legacyDirEntries).toEqual(["drive-pr-clone-id"]);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
        rmSync(newDir, { recursive: true, force: true });
      }
    });

    it("does NOT trust an existing newDir as migration proof when legacyDir still holds a live lease", async () => {
      // The gap the "prefer empty newDir" rule leaves open: `newDir`
      // existing was still, on its own, sufficient to select it — and
      // `ensureMigratedFromLegacy`/`migrate-legacy-state.ts --apply` both
      // `mkdirSync(newDir)` BEFORE scanning `legacyDir` and possibly
      // refusing, so an empty `newDir` is exactly as consistent with a
      // FAILED admission attempt as with a genuine one. `legacyDir` here
      // holds a real, live foreign lease — the marker is absent and
      // `newDir` exists-but-empty, simulating exactly that failed-attempt
      // debris. The fence must still find and refuse on the live lease in
      // `legacyDir`, not silently trust the empty `newDir`.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "drive-pr-newdir-not-proof-legacy-"),
      );
      const newDir = defaultStateDirFor(legacyDir);
      const foreignActor = "wt-00000000deadbeef";
      try {
        // `newDir` exists (as `ensureMigratedFromLegacy` would leave it
        // after a refused attempt) but is otherwise completely empty — no
        // marker, no lease.
        mkdirSync(newDir, { recursive: true });
        // `legacyDir` holds a genuinely LIVE lease — the content a failed
        // migration attempt would have refused on, and exactly what this
        // fence must not miss.
        writeFileSync(
          leasePathFor(legacyDir, "999", foreignActor),
          JSON.stringify({
            holder: "worktree",
            pid: 0,
            host: hostname(),
            platform: process.platform,
            actor: foreignActor,
            worktree: "/some/other/tree",
            startedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            command: "bump-round",
            generation: "f".repeat(32),
            sessionStarted: "",
            pr: "999",
            revision: "a".repeat(32),
          }),
        );
        const session: Session = {
          pid: process.pid,
          host: hostname(),
          source: "DRIVE_PR_SESSION",
          sessionStarted: "",
        };
        let threw: unknown;
        try {
          await assertRemoteMutationAllowed(
            {
              stateDir: legacyDir,
              actor: ACTOR,
              session,
              fromOverride: false,
              legacyStateDirForFallback: legacyDir,
            },
            "999",
            "test",
          );
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(11);
      } finally {
        rmSync(newDir, { recursive: true, force: true });
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("returns null, and touches nothing, with no PR named", async () => {
      // `assert-post-allowed.ts`'s standalone actor-wide path — there is no
      // single PR this call is protecting, so there is nothing for a lock
      // keyed by PR to guard.
      const d = mkdtempSync(join(tmpdir(), "drive-pr-remote-lock-nopr-"));
      const session: Session = {
        pid: process.pid,
        host: hostname(),
        source: "DRIVE_PR_SESSION",
        sessionStarted: "",
      };
      // Three rounds of observational fixes here (readdirSync name-list,
      // fs.watch, then a listenerCount snapshot) were each correctly found
      // insufficient in turn: a before/after snapshot cannot see a
      // create-then-remove, fs.watch's OS-level delivery is best-effort and
      // can coalesce or drop events, and a listener-COUNT snapshot cannot
      // see a construct-then-DISPOSE, since `dispose()` removes the exact
      // listener `createLock` added. The actual structural fix: spy on the
      // GLOBAL seam `createLock` unconditionally calls at construction —
      // `process.on('exit', ...)` — and record every CALL, not the net listener
      // count afterward. This captures the ATTEMPT itself, synchronously,
      // before any filesystem I/O, and survives any later `dispose()`
      // un-registering it — there is no way to construct a `PathLock` without
      // this call firing first, and no way for a subsequent `dispose()` to
      // erase the fact that it fired. bun-types 1.4.0 regression: the
      // process.on overloads collapse so `spyOn` infers the 'memoryPressure'
      // signature, making `event === 'exit'` below a no-overlap type error. Spy
      // through the EventEmitter view — same object, same seam, honest event
      // type — matching the cast lib/state/lock.ts already carries for the
      // mirror-image process.off collapse.
      const onSpy = spyOn(
        process as unknown as import("node:events").EventEmitter,
        "on",
      );
      let lock: Awaited<ReturnType<typeof assertRemoteMutationAllowed>>;
      try {
        lock = await assertRemoteMutationAllowed(
          {
            stateDir: d,
            actor: ACTOR,
            session,
            fromOverride: false,
            legacyStateDirForFallback: d,
          },
          null,
          "test",
        );
      } finally {
        onSpy.mockRestore();
      }
      expect(lock).toBeNull();
      expect(onSpy.mock.calls.some(([event]) => event === "exit")).toBe(false);
    });

    it("refuses a DIFFERENT worktree claiming this PR while the lock is held mid-push, and admits it once released", async () => {
      // The acceptance criterion this issue was filed against: worktree A
      // holds the fence and is mid-push when worktree B claims the PR's
      // per-PR lease and attempts a mutation — B must be refused until A's
      // push completes. Two REAL worktrees, for the same reason every other
      // cross-tree probe in this file uses them: the actor is derived and
      // deliberately not overridable, so a stand-in would prove the refusal
      // fires on a value the test chose rather than on the topology.
      //
      // A never actually claims a per-PR lease of its own here — the race
      // this closes is that the lock ALONE (guarded-push.ts's or
      // answer-summary-finding.ts's hold across their own mutation) must
      // block a fresh claim regardless of whether the pusher's own lease
      // still looks alive, which is exactly the case where the OLD,
      // point-in-time-only check could not have seen the conflict at all
      // (nothing had renewed A's lease mid-push). Holding the lock directly,
      // the way a real push does via `assertRemoteMutationAllowed`, is what
      // this probe is actually proving — spawning a real `guarded-push.ts`
      // would additionally exercise its own subprocess plumbing, which the
      // unit-level test above already covers on its own.
      const { a, b, env } = twoDrivers("remote-mutation-lock-pr-wide");
      // Both worktrees land on the SAME state dir because they share one
      // clone (mirrors the stale-lease probe above) — an earlier change's default,
      // `~/.local/state/jig/drive-pr/<cloneKey>/`, keyed off `--git-common-dir`
      // rather than the common dir itself.
      const commonDirRemoteLock = resolve(
        a,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: a,
          env,
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
        cloneKey(commonDirRemoteLock),
      );
      // A real caller only ever reaches `createLock()` after `resolveStateDir()`
      // has guaranteed this directory exists (via `ensureMigratedFromLegacy`'s
      // own `mkdirSync`, or `openStore()`'s) — this test constructs the lock
      // path directly, bypassing both, so it has to establish the same
      // precondition itself. Without it, `createLock`'s `acquire()` sees
      // `mkdirSync(lock)` fail with ENOENT (missing parent) and retries
      // indefinitely, identically to how it treats an already-held lock
      // (`lock.ts`'s blanket `catch` does not distinguish the two) — a real
      // hang, not a flake.
      mkdirSync(stateDir, { recursive: true });
      const holdLock = createLock(
        prRemoteMutationLockPathFor(stateDir, "999"),
        "drive-state.ts (pr remote mutation)",
        "999",
      );
      await holdLock.acquire();
      let released = false;
      // Hoisted above the `try` so the `finally` below can see and clean
      // them up on EVERY exit path, not just the happy one — a `const`/`let`
      // declared inside the `try` block is out of scope in its own `finally`.
      let proc: ReturnType<typeof Bun.spawn> | undefined;
      let exitCode: number | null = null;
      let exitedPromise: Promise<number> | undefined;
      try {
        proc = Bun.spawn(
          [
            join(SCRIPTS, "drive-state.ts"),
            "hold",
            "999",
            "--key",
            "PRRT_b",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/thread-b-reply",
          ],
          {
            cwd: b,
            env: { ...env, DRIVE_PR_SESSION: String(process.pid) },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        exitedPromise = proc.exited.then((code) => {
          exitCode = code;
          return code;
        });
        await new Promise((res) => setTimeout(res, 500));
        // Still blocked half a second later — B's claim must not have gone
        // through while A's (simulated) push holds the PR-wide lock, which
        // is the whole property this issue was filed over.
        expect(exitCode).toBeNull();
        holdLock.release();
        holdLock.dispose();
        released = true;
        // Bounded, not a bare `await`:
        // if the admission path regressed into an indefinite wait, an
        // unbounded await here would hang this ENTIRE test suite rather
        // than fail this one test — the `finally` below still kills the
        // child on any exit path, but the failure itself needs to surface
        // promptly, not after the suite's own outer runner eventually gives
        // up. Generous relative to the 500ms already waited above: B should
        // be admitted within milliseconds of the lock releasing.
        const AWAIT_EXITED_TIMEOUT_MS = 15_000;
        // The timer is cleared as soon as the race settles either way — a
        // `setTimeout` that outlives the `Promise.race` it was created for
        // keeps its closure (and the timer itself) alive for the rest of
        // this timeout's duration even after the normal, fast path has
        // already won.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          exitedPromise.then(() => false),
          new Promise<boolean>((resolve) => {
            timeoutHandle = setTimeout(
              () => resolve(true),
              AWAIT_EXITED_TIMEOUT_MS,
            );
          }),
        ]);
        clearTimeout(timeoutHandle);
        if (timedOut) {
          throw new Error(
            `B's 'hold' subprocess did not exit within ${AWAIT_EXITED_TIMEOUT_MS}ms of the lock releasing — the admission path may be hanging rather than genuinely refusing or succeeding.`,
          );
        }
        // Admitted the instant the lock clears — nothing else in this test
        // stood in B's way, so a non-zero exit here would mean the new gate
        // is refusing more than the in-flight mutation it exists to guard.
        // Compared via `===` rather than `expect(exitCode).toBe(0)`:
        // `exitCode` is mutated inside the closure above, so TypeScript never
        // narrows it past its declared `number | null` at any later read —
        // bun-types' generic `toBe<X = T>` overload then fails to resolve
        // against a `null`-inclusive `T`. A boolean comparison sidesteps that
        // inference entirely rather than fighting it with a cast.
        expect(exitCode === 0).toBe(true);
        const held = JSON.parse(
          drive(b, { ...env, DRIVE_PR_SESSION: String(process.pid) }, [
            "held",
            "999",
          ]).stdout,
        );
        expect(held.map((h: { key: string }) => h.key)).toEqual(["PRRT_b"]);
      } finally {
        if (!released) {
          holdLock.release();
          holdLock.dispose();
        }
        // Terminate and join the child on EVERY exit path, not just the
        // happy one: an earlier
        // assertion throwing above (e.g. the `toBeNull()` check) left the
        // child running, unkilled and unjoined, in the original version of
        // this test. `exitCode` is only ever set by the `.then()` above, so
        // it being still `null` here means the child has not reported an
        // exit yet.
        if (
          proc !== undefined &&
          exitedPromise !== undefined &&
          exitCode === null
        ) {
          try {
            proc.kill();
          } catch {
            // Already gone — nothing left to signal.
          }
          await exitedPromise.catch(() => {
            // Best-effort join; this cleanup must not itself throw and mask
            // whatever error is already propagating out of this `finally`.
          });
        }
      }
    });

    it("reports a genuinely-exceeded wait as exit 11, not acquire()'s own generic exit 1", async () => {
      // `claimPrLease`'s gate waits out an in-flight hold only up to
      // whatever THIS process's own acquire() bound resolves to
      // (`Math.min(LOCK_ACQUIRE_MAX_SEC, $DRIVE_PR_LOCK_TIMEOUT ?? 30)`,
      // `lock.ts`'s own arithmetic — never longer, whatever this call
      // passes, since a caller-supplied cap can only lower that bound, not
      // raise it). `$DRIVE_PR_LOCK_TIMEOUT` pinned to 1s here is a realistic
      // OPERATOR configuration, not a bypass attempt — proving that when a
      // hold genuinely outlasts it, B is refused with the purpose-built
      // exit 11 this fix adds, not `acquire`'s own generic exit 1
      // "could not acquire … or the lock is wedged" message, which would
      // misreport an entirely ordinary long-running push as a stuck lock.
      const { a, b, env } = twoDrivers("remote-mutation-lock-exceeds-wait");
      // See the previous test's comment: both worktrees share one clone's
      // an earlier change default, not `--git-common-dir` itself.
      const commonDirExceedsWait = resolve(
        a,
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: a,
          env,
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
        cloneKey(commonDirExceedsWait),
      );
      // See the previous test's comment: `createLock()` here bypasses
      // `resolveStateDir()`'s own guarantee that this directory exists.
      mkdirSync(stateDir, { recursive: true });
      const holdLock = createLock(
        prRemoteMutationLockPathFor(stateDir, "999"),
        "drive-state.ts (pr remote mutation)",
        "999",
      );
      await holdLock.acquire();
      try {
        const r = drive(
          b,
          {
            ...env,
            DRIVE_PR_SESSION: String(process.pid),
            DRIVE_PR_LOCK_TIMEOUT: "1",
          },
          [
            "hold",
            "999",
            "--key",
            "PRRT_b2",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/thread-b2-reply",
          ],
        );
        // `lock.ts`'s own `acquire()` still prints ITS generic diagnostic to
        // stderr before throwing — that is unavoidable from the caller side
        // and harmless (extra context, not a conflicting claim) — so this
        // asserts on the EXIT CODE (11, not `acquire()`'s own generic 1) and
        // on this fix's OWN message being present, not on the absence of
        // `acquire()`'s.
        expect(r.exitCode).toBe(11);
        expect(r.stderr).toContain("irreversible remote mutation");
        expect(r.stderr).toContain("in flight from another worktree");
        expect(r.stderr).toContain("not necessarily wedged");
      } finally {
        holdLock.release();
        holdLock.dispose();
      }
    });
  });

  describe("hold --unconfirmed", () => {
    // reconcile-replied-threads.ts re-holds a reply it found already POSTED,
    // not one it verified. The ordinary `hold` upsert stamps `round:.rounds`
    // unconditionally — sound for a live pass's own step 3, which only calls
    // it after confirming the promised fix, but NOT for a caller with no such
    // ability: round and .verifiedSha are both PR-global, not scoped to which
    // hold's fix a given push actually contains, so granting round-currency
    // on faith let a stale, never-verified reply ride an UNRELATED later
    // push's set-verified to a false resolve. `--unconfirmed`
    // closes this by stamping round -1, which bump-round (always >= 0,
    // starting at 0) can never equal. Insert-if-absent keyed on outcome alone
    // still let a SUPERSEDING same-outcome reply inherit an earlier
    // hold's round-currency, and tolerating an absent commentUrl on the
    // ordinary (live-pass-confirmed) path closed that only within a
    // chain of standalone re-holds, not for a confirmed hold. `--comment-url`
    // is now REQUIRED and compared exactly on BOTH paths: insert-
    // if-absent by (key, outcome, commentUrl), so any newer qualifying
    // comment — confirmed or not, same outcome word or not — invalidates a
    // stale hold rather than inheriting it.

    it("stamps round -1, which no future bump-round/set-verified pair can ever satisfy", async () => {
      const d = stateDirFor("unconfirmed-never-claims");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_stale",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/c1",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "PRRT_stale", round: -1 }]);

      // Simulate an UNRELATED live pass's own round, complete with a real
      // push — exactly the scenario the finding described: some other
      // thread's fix lands, round advances, verifiedSha moves. None of that
      // has anything to do with PRRT_stale's own promised fix.
      await state(d, ["bump-round", "999", "--head", "unrelated-head"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "dddddddddddddddddddddddddddddddddddddddd",
      ]);

      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_stale",
        "--kind",
        "thread",
        "--pushed-sha",
        "dddddddddddddddddddddddddddddddddddddddd",
      ]);
      // MUST refuse — round -1 can never equal the real (now >= 1) round.
      expect(claim.exitCode).not.toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_stale");
    });

    it("requires --comment-url on --kind thread, unconfirmed or not", async () => {
      const d = stateDirFor("unconfirmed-requires-url");
      const withoutUrl = [
        "--key",
        "PRRT_no_url",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
      ];
      const r1 = await state(d, [
        "hold",
        "999",
        ...withoutUrl,
        "--unconfirmed",
      ]);
      expect(r1.exitCode).toBe(2);
      expect(r1.stderr).toContain("--comment-url");

      const r2 = await state(d, ["hold", "999", ...withoutUrl]);
      expect(r2.exitCode).toBe(2);
      expect(r2.stderr).toContain("--comment-url");
    });

    it("does not touch an EXISTING held entry representing the SAME comment — insert-if-absent, never a downgrade", async () => {
      const d = stateDirFor("unconfirmed-insert-if-absent");
      // A live pass legitimately confirms the fix and holds at the current
      // (real) round.
      await state(d, ["bump-round", "999", "--head", "confirmed-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/original-reply",
      ]);
      const before = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(before).toMatchObject([{ key: "PRRT_confirmed", round: 1 }]);

      // A concurrent standalone reconcile pass sees the SAME already-posted
      // reply (same comment url) and tries to re-hold it too — this must be
      // a no-op, not a downgrade to round -1 that would strand the
      // already-confirmed hold.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/original-reply",
      ]);
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)).toEqual(
        before,
      );

      // And the legitimately-confirmed hold still claims normally.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--pushed-sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      expect(claim.exitCode).toBe(0);
    });

    it("invalidates a stale hold whose OUTCOME differs — a superseding reply must not inherit round-currency", async () => {
      const d = stateDirFor("unconfirmed-outcome-changed");
      // A live pass legitimately confirmed and held an `accepted` claim.
      await state(d, ["bump-round", "999", "--head", "first-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-15",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      // Confirm the legitimate hold really would have claimed, to prove the
      // invalidation below is doing real work, not asserting a no-op.
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_superseded",
            "--kind",
            "thread",
            "--pushed-sha",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ])
        ).exitCode,
      ).toBe(0);
      // Re-establish it (claim-held above removed it) to continue the scenario.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-16",
      ]);

      // A later trusted reply supersedes the original with a DIFFERENT
      // fix-dependent outcome (and, necessarily, a different comment url).
      // Reconcile re-holds — this must invalidate the stale `accepted`
      // round-currency, not preserve it under the new `moot` outcome.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "moot",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/superseding-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "PRRT_superseded", outcome: "moot", round: -1 }]);

      // The stale round+verifiedSha pairing that would have claimed the OLD
      // outcome must not silently carry over to resolve the new one.
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--pushed-sha",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      expect(claim.exitCode).not.toBe(0);
    });

    it("invalidates a CONFIRMED (live-pass) hold when a superseding reply appears — the absent-commentUrl tolerance's own acknowledged residual", async () => {
      // Tolerating an absent commentUrl left one case open: the ORDINARY (non
      // --unconfirmed) hold path never recorded commentUrl at all, so an
      // absent-vs-set comparison had to treat "no commentUrl on file" as
      // trustworthy — otherwise every legitimately-confirmed hold would
      // spuriously downgrade the first time reconcile ran afterward, changed or
      // not. That leniency, though, meant a genuinely SUPERSEDING reply on a
      // live-pass-confirmed thread was never caught either. Both `hold` paths
      // now require --comment-url, so there is no more "absent" case to be
      // lenient about — comparison is exact on both sides.
      const d = stateDirFor("confirmed-hold-superseded");
      await state(d, ["bump-round", "999", "--head", "confirmed-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/the-reply-a-live-pass-confirmed",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      // Prove the confirmed hold really would have claimed, so the
      // invalidation below is doing real work, not asserting a no-op. Then
      // re-establish it (claim-held above removed it) to continue.
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_confirmed_superseded",
            "--kind",
            "thread",
            "--pushed-sha",
            "cccccccccccccccccccccccccccccccccccccccc",
          ])
        ).exitCode,
      ).toBe(0);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/the-reply-a-live-pass-confirmed",
      ]);

      // A DIFFERENT trusted comment later supersedes it with the SAME
      // outcome word but a different promised fix. A standalone reconcile
      // pass sees this as the latest qualifying reply and re-holds
      // (unconfirmed) — this must invalidate the confirmed hold's
      // round-currency, not preserve it because the outcome word matches.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/a-different-superseding-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        { key: "PRRT_confirmed_superseded", outcome: "accepted", round: -1 },
      ]);

      // The stale round+verifiedSha pairing from the ORIGINAL confirmed hold
      // must not silently resolve the thread against the new promise.
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--pushed-sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      expect(claim.exitCode).not.toBe(0);
    });

    it("a chain of standalone re-holds tracks the LATEST comment — a newer same-outcome comment replaces an older unconfirmed entry's provenance", async () => {
      // Two reconcile passes, no live pass in between: the first pins
      // provenance to comment #1; a later run sees a DIFFERENT trusted
      // comment (same outcome word, different promise) and must not silently
      // keep pointing at the stale one — outcome-only comparison would have
      // read these as identical and left the OLD provenance
      // standing.
      const d = stateDirFor("unconfirmed-chain-tracks-latest-comment");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_restated",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/reply-1",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        {
          key: "PRRT_restated",
          outcome: "accepted",
          commentUrl: "https://example.invalid/reply-1",
        },
      ]);

      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_restated",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/reply-2-a-different-promise",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        {
          key: "PRRT_restated",
          outcome: "accepted",
          round: -1,
          commentUrl: "https://example.invalid/reply-2-a-different-promise",
        },
      ]);
    });
  });

  describe("handoff rendering", () => {
    async function handoff(reasons: string[], previousNarrative?: string) {
      const d = stateDirFor("handoff");
      const hd = join(d, "handoff");
      for (const [i, reason] of reasons.entries()) {
        await state(
          d,
          [
            "park",
            "999",
            "--key",
            `PRRT_${i}`,
            "--kind",
            "thread",
            "--reason",
            reason,
          ],
          { DRIVE_PR_HANDOFF_DIR: hd },
        );
      }
      if (previousNarrative !== undefined) {
        await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
        const p = join(hd, "pr-drive-999.md");
        writeFileSync(p, `${readFileSync(p, "utf8")}${previousNarrative}`);
      }
      await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
      return readFileSync(join(hd, "pr-drive-999.md"), "utf8");
    }

    it("keeps a reason containing a PIPE inside its own table cell", async () => {
      const out = await handoff(["choose A | B — a product call"]);
      const row = out.split("\n").find((l) => l.includes("PRRT_0"));
      expect(row).toBeDefined();
      // Four cells, so the decision is still in the column that states it.
      expect((row as string).match(/\|/g)?.length).toBe(5);
      expect(row).toContain("&#124;");
    });

    it("keeps a MULTILINE reason on one row instead of spilling into prose", async () => {
      const out = await handoff(["first line\nsecond line"]);
      const row = out.split("\n").find((l) => l.includes("PRRT_0"));
      expect(row).toContain("first line second line");
    });

    it("a reason QUOTING the narrative marker does not move the boundary", async () => {
      // The awk preservation pass used to cut at the first line merely
      // CONTAINING the marker text. A parked reason quoting it is reachable —
      // reasons routinely quote reviewer prose about this very file — and it
      // moves the boundary UP into the parked table, so everything below the
      // quoting row is copied into the narrative and re-copied every round.
      // Two parked items are what makes that visible: the second row is the
      // machine-block content that leaks.
      const out = await handoff(
        [
          "reviewer says the narrative below this line is agent-authored and preserved",
          "a second, ordinary decision",
        ],
        "\n## Narrative\n\nreal narrative text\n",
      );
      expect(out).toContain("real narrative text");
      const marker =
        "<!-- narrative below this line is agent-authored and preserved -->";
      const below = out.slice(out.indexOf(marker) + marker.length);
      // The machine block stays above the boundary, in one copy.
      expect(below).not.toContain("PRRT_1");
      expect(out.split("\n").filter((l) => l.includes("PRRT_1")).length).toBe(
        1,
      );
    });

    it("carries the HELD batch, which is what a compacted agent has lost", async () => {
      // The handoff file is the resumption point for the two paths where
      // context does not reset by construction: interactive `/loop`, and
      // `--handoff-at never`. The parked set alone is not enough — parked items
      // are things a HUMAN owes, while the held batch is work THIS round
      // already did and must not do twice.
      const d = stateDirFor("handoff-held");
      const hd = join(d, "handoff");
      const env = { DRIVE_PR_HANDOFF_DIR: hd };
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "PRRT_held",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/handoff-held-reply",
        ],
        env,
      );
      await state(d, ["handoff", "999"], env);
      const out = readFileSync(join(hd, "pr-drive-999.md"), "utf8");
      const row = out.split("\n").find((l) => l.includes("PRRT_held"));
      expect(row).toContain("accepted");
      expect(row).toContain("thread");
      // The provenance columns — a reader who cannot see WHO holds
      // an item and whether its fix is pushed cannot tell a dispatchable batch
      // from one `claim-held` will refuse outright.
      expect(row).toContain(ACTOR);
      expect(row).toContain("not yet");
      expect(out).toContain("Held — replied, awaiting the push");
      expect(out).toContain("Do NOT re-reply");
      // A successor session copy-pasting the literal rendered command must
      // get ONE runnable invocation, not `drive-state.ts` alone on one line
      // and `claim-held ...` as a bogus separate command on the next — the
      // regression this asserts against. Each command has to sit
      // fully inside its own line, script name and subcommand together —
      // including `--pushed-sha`, which the claim has required since an earlier change.
      expect(out).toContain(
        '`drive-state.ts claim-held 999 --key K --kind finding --pushed-sha "$(git rev-parse HEAD)"`\nfirst.',
      );
      expect(out).toContain(
        "`drive-state.ts release-held 999 --key K --token T`",
      );
    });

    it("regenerates itself on `hold`, `park` and `release-held` — no explicit `handoff` call needed", async () => {
      // The block claims to be "written at the moment of each event". Before
      // this, that was only true for `handoff`-triggered fields (round, phase,
      // verifiedSha) — `hold` and `park` only touched the JSON, so a mid-round
      // hold was invisible in the .md until the NEXT explicit `handoff` call
      // (step 7, or `drive.ts` at the start of the following round). A
      // successor reading only the file — the case `--handoff-at never`
      // exists for — could miss a hold made just before a compaction.
      const d = stateDirFor("handoff-live");
      const hd = join(d, "handoff");
      const env = { DRIVE_PR_HANDOFF_DIR: hd };
      const path = join(hd, "pr-drive-999.md");

      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "PRRT_live",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/handoff-live-reply",
        ],
        env,
      );
      let out = readFileSync(path, "utf8");
      expect(out).toContain("PRRT_live");
      expect(out).toContain("accepted");

      await state(
        d,
        [
          "park",
          "999",
          "--key",
          "PRRT_parked",
          "--kind",
          "thread",
          "--reason",
          "product call",
        ],
        env,
      );
      out = readFileSync(path, "utf8");
      expect(out).toContain("PRRT_parked");
      expect(out).toContain("product call");

      await state(d, ["release-held", "999", "--key", "PRRT_live"], env);
      out = readFileSync(path, "utf8");
      expect(out).not.toContain("PRRT_live");
      // Unrelated state (the parked item) survives the release untouched.
      expect(out).toContain("PRRT_parked");
    });

    it("prefers itself over a compacted recollection, WITHOUT overclaiming exactness with the JSON", async () => {
      // Deliberate, not decoration. A successor starting fresh has nothing to
      // weigh the file against; an agent resuming after a compaction still
      // holds a degraded summary of its own round and will prefer it unless
      // the file says otherwise. But the claim stops there: the JSON write
      // and this file's write are two separate `mv`s, so it cannot honestly
      // claim to be a transactional mirror of the state — it says so, and
      // points anything consequential back at `drive-state.ts` directly.
      const d = stateDirFor("handoff-authority");
      const hd = join(d, "handoff");
      await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
      const out = readFileSync(join(hd, "pr-drive-999.md"), "utf8");
      expect(out).toContain("Prefer this block over your own recollection");
      expect(out).toContain("not a transactional mirror");
      expect(out).toContain("drive-state.ts held");
      // And it sits ABOVE the agent-authored half, or it is describing the
      // wrong text.
      const marker =
        "<!-- narrative below this line is agent-authored and preserved -->";
      expect(
        out.indexOf("Prefer this block over your own recollection"),
      ).toBeLessThan(out.indexOf(marker));
    });
  });
});
