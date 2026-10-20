/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";

import { basename, join, delimiter } from "node:path";

import {
  SCRIPTS,
  tmpRoot,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;

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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
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
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "rounds", "999"),
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
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "bump-round",
        "999",
        "--head",
        "aaaaaaa",
      ),
      { cwd: linked, env: { ...env, DRIVE_PR_STATE_DIR: privateDir } },
    );
    const run = (args: string[]) =>
      Bun.spawnSync(scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args), {
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
    writeFakeProgram(
      ghBin,
      `#!/bin/sh\ncase "$*" in\n  *timeline*) printf '%s\\n' '[[]]' ;;\n  *) exit 1 ;;\nesac\n`,
    );
    const ghEnv = { PATH: `${ghRoot}${delimiter}${process.env.PATH ?? ""}` };
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

  it("`reset` sweeps quarantine history while retaining every permanent fence", async () => {
    // `lock.ts`'s own `tombstone()` never sweeps `${lock}.stale.*` or
    // `${lock}.recovering.stale.*` — deliberately, see its doc comment — so
    // without this, "forget everything for this PR" left an unbounded pile
    // of inode-consuming quarantine directories on POSIX systems. `reset` is a
    // convenient trigger for the compaction, not a safety precondition for
    // it (see `sweepLockQuarantine`'s own doc comment for why a delete-based
    // sweep gated on `reset`'s live-lease/live-claim checks alone is NOT
    // actually safe): compaction never removes the permanent fence, only
    // shrinks it to an empty file on POSIX systems. Windows retains the
    // nonempty directory, which a directory rename cannot replace.
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

    // Every generation-keyed path remains fenced: POSIX shrinks it to an
    // empty file, while Windows retains the nonempty directory.
    const directoryFence =
      byPlatform("Windows retains nonempty directory fences", {
        windows: "directory",
        posix: "file",
      }) === "directory";
    for (const fence of [lockDoomed, recoveringDoomed]) {
      expect(existsSync(fence)).toBe(true);
      expect(statSync(fence).isDirectory()).toBe(directoryFence);
      if (directoryFence)
        expect(existsSync(join(fence, "tombstone"))).toBe(true);
      else expect(readFileSync(fence, "utf8")).toBe("");
    }

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
    // pre-planted two, to retain the platform's permanent fence.
    const lockBase = basename(lock);
    const quarantineEntries = readdirSync(d).filter(
      (f) =>
        f.startsWith(`${lockBase}.stale.`) ||
        f.startsWith(`${lockBase}.recovering.stale.`),
    );
    expect(quarantineEntries.length).toBeGreaterThan(2);
    for (const entry of quarantineEntries) {
      const fence = join(d, entry);
      expect(statSync(fence).isDirectory()).toBe(directoryFence);
      if (directoryFence)
        expect(existsSync(join(fence, "tombstone"))).toBe(true);
      else expect(readFileSync(fence, "utf8")).toBe("");
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
});
