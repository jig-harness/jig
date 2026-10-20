/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { reflectDepthPastLast } from "../scripts/lib/state/schema";

import {
  SCRIPTS,
  tmpRoot,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;

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
      const p = Bun.spawnSync(
        scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args),
        {
          cwd,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const run = () =>
      Bun.spawnSync(
        scriptArgv(join(SCRIPTS, "drive-state.ts"), "rounds", "999"),
        {
          cwd: linked,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
      { cwd: worktreeA, env: { ...env, DRIVE_PR_STATE_DIR: privateDirA } },
    );
    // Resumed from B, which has never seen this PR.
    const r = Bun.spawnSync(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "rounds", "999"),
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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const r = Bun.spawnSync(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "rounds", "999"),
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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const r = Bun.spawnSync(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "rounds", "999"),
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
});
