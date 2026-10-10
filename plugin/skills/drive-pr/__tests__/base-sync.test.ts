/**
 * base-sync.test.ts — the "is this round already pushing?" precondition.
 *
 * Fixture-driven through `alreadyPushing`'s injected `GitRunner` seam, the
 * same shape `base-drift.test.ts` uses for `probeBaseDrift`. The property
 * worth pinning is the fail-CLOSED contract: a genuine read failure —
 * `git status` or `git rev-parse HEAD` erroring, or no `headRefOid` to
 * compare against — must come back as `ok: false`, never silently coerced
 * into `pushing: true` or `pushing: false` (docomply-review, a reference-implementation pull request).
 * Widening either guess back in is exactly the merge-condition regression
 * this test exists to catch.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alreadyPushing,
  type GhRunner,
  resolveReadReason,
  verifyStillCurrent,
  worktreeClean,
} from "../scripts/base-sync.ts";
import type { GitRunner } from "../scripts/lib/base-drift.ts";

const BASE_SYNC = join(import.meta.dir, "..", "scripts", "base-sync.ts");

// Prefix-scrubbed rather than enumerated — the convention
// verification-fit.test.ts, triage-thread.test.ts and
// reconcile-replied-threads.test.ts already use (coderabbitai, PR #4279): a
// leaked `GIT_DIR`/`GIT_WORK_TREE` pair (a lefthook hook exports both) would
// otherwise reach these subprocesses regardless of what `base-sync.ts` itself
// happens to scrub internally, which is not a fact either spawn below should
// have to rely on to be correct.
function scrubbedGitEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

interface Answers {
  status?: { code: number; stdout: string };
  revParse?: { code: number; stdout: string };
}

function fakeGit(a: Answers): GitRunner {
  return (args) => {
    const sub = args[2] ?? "";
    if (sub === "status") {
      return Promise.resolve(a.status ?? { code: 0, stdout: "" });
    }
    if (sub === "rev-parse") {
      return Promise.resolve(a.revParse ?? { code: 0, stdout: "deadbeef\n" });
    }
    return Promise.resolve({ code: 1, stdout: "" });
  };
}

describe("alreadyPushing", () => {
  it("reads uncommitted changes as pushing, without needing headOid", async () => {
    const git = fakeGit({ status: { code: 0, stdout: " M foo.ts\n" } });
    expect(await alreadyPushing(git, "/repo", "")).toEqual({
      ok: true,
      pushing: true,
    });
  });

  it("reads a clean tree exactly at the PR head as nothing to piggyback", async () => {
    const git = fakeGit({ revParse: { code: 0, stdout: "deadbeef\n" } });
    expect(await alreadyPushing(git, "/repo", "deadbeef")).toEqual({
      ok: true,
      pushing: false,
    });
  });

  it("reads a clean tree ahead of the PR head as pushing", async () => {
    const git = fakeGit({ revParse: { code: 0, stdout: "newlocalsha\n" } });
    expect(await alreadyPushing(git, "/repo", "deadbeef")).toEqual({
      ok: true,
      pushing: true,
    });
  });

  it("refuses rather than guessing when git status fails to run", async () => {
    const git = fakeGit({ status: { code: 1, stdout: "" } });
    const r = await alreadyPushing(git, "/repo", "deadbeef");
    expect(r.ok).toBe(false);
  });

  it("refuses rather than guessing when the PR reports no headRefOid", async () => {
    const git = fakeGit({});
    const r = await alreadyPushing(git, "/repo", "");
    expect(r.ok).toBe(false);
  });

  it("refuses rather than guessing when git rev-parse HEAD fails to run", async () => {
    const git = fakeGit({ revParse: { code: 1, stdout: "" } });
    const r = await alreadyPushing(git, "/repo", "deadbeef");
    expect(r.ok).toBe(false);
  });

  it("refuses rather than guessing when git rev-parse HEAD returns nothing", async () => {
    const git = fakeGit({ revParse: { code: 0, stdout: "" } });
    const r = await alreadyPushing(git, "/repo", "deadbeef");
    expect(r.ok).toBe(false);
  });

  // Same hardening, same reason as worktreeClean's own pin below: a plain
  // `git status --porcelain` can read real uncommitted state as clean
  // depending on ambient `status.showUntrackedFiles`/submodule config
  // (chatgpt-codex-connector, a reference-implementation pull request).
  it("always passes --untracked-files=normal and --ignore-submodules=none", async () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "" });
    };
    await alreadyPushing(git, "/repo", "deadbeef");
    const statusCall = calls.find((c) => c[2] === "status");
    expect(statusCall).toEqual(
      expect.arrayContaining([
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ]),
    );
  });
});

describe("worktreeClean", () => {
  // Pins the fix for the gap the reviewer named (docomply-review, a reference-implementation pull request):
  // `HEAD` matching its pre-merge value is not proof the WORKTREE is
  // restored — a hook-created or merge-driver-produced untracked file
  // survives both `git merge --abort` and `git reset --hard`. This is the
  // check `atPreMergeHead()` runs after confirming `HEAD`, so it must fail
  // closed on both a dirty status and an unreadable one.
  it("is true when git status --porcelain reports nothing", async () => {
    const git = fakeGit({ status: { code: 0, stdout: "" } });
    expect(await worktreeClean(git, "/repo")).toBe(true);
  });

  it("is false when an untracked leftover file survives restoration", async () => {
    const git = fakeGit({ status: { code: 0, stdout: "?? leftover.txt\n" } });
    expect(await worktreeClean(git, "/repo")).toBe(false);
  });

  it("is false, not true, when git status itself fails to run", async () => {
    const git = fakeGit({ status: { code: 1, stdout: "" } });
    expect(await worktreeClean(git, "/repo")).toBe(false);
  });

  // Pins the hardening itself, not just its effect on a fixture already
  // primed to answer 'clean' either way: `status.showUntrackedFiles=no` or a
  // `submodule.<name>.ignore` setting can make a plain `git status
  // --porcelain` read real state as clean depending on ambient config this
  // test cannot see — `--untracked-files=normal`/`--ignore-submodules=none`
  // must be passed on every call so the read is config-independent
  // (chatgpt-codex-connector, a reference-implementation pull request).
  it("always passes --untracked-files=normal and --ignore-submodules=none", async () => {
    const calls: string[][] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "" });
    };
    await worktreeClean(git, "/repo");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ]),
    );
  });
});

describe("resolveReadReason", () => {
  // An unfetched measurement must outrank a positive verdict regardless of
  // WHAT the (unreliable) verdict happened to compute — a stale
  // `origin/<base>` can look `in-sync` or `no-overlap` and still be wrong
  // (docomply-review, a reference-implementation pull request round 8: the old `main()` control flow
  // returned `in-sync`/`no-overlap` before ever checking `fetched`).
  it("reports fetch-failed over an in-sync verdict", () => {
    expect(resolveReadReason(false, "in-sync", false, false)).toBe(
      "fetch-failed",
    );
  });

  it("reports fetch-failed over a no-overlap verdict, forced or not", () => {
    expect(resolveReadReason(false, "no-overlap", false, false)).toBe(
      "fetch-failed",
    );
    expect(resolveReadReason(false, "no-overlap", false, true)).toBe(
      "fetch-failed",
    );
  });

  it("reports fetch-failed over an overlapping verdict too", () => {
    expect(resolveReadReason(false, "overlapping", false, false)).toBe(
      "fetch-failed",
    );
  });

  it("--check always reports check-only, fetched or not", () => {
    expect(resolveReadReason(true, "in-sync", false, false)).toBe("check-only");
    expect(resolveReadReason(true, "overlapping", true, false)).toBe(
      "check-only",
    );
  });

  it("reports the real verdict once the fetch succeeded", () => {
    expect(resolveReadReason(false, "in-sync", true, false)).toBe("in-sync");
    expect(resolveReadReason(false, "no-overlap", true, false)).toBe(
      "no-overlap",
    );
  });

  it("defers to the caller (null) on a fetched, forced no-overlap or any overlapping verdict", () => {
    expect(resolveReadReason(false, "no-overlap", true, true)).toBeNull();
    expect(resolveReadReason(false, "overlapping", true, false)).toBeNull();
    expect(resolveReadReason(false, "overlapping", true, true)).toBeNull();
  });
});

describe("verifyStillCurrent", () => {
  // Pins the fix for the TOCTOU gap the reviewer named (docomply-review +
  // chatgpt-codex-connector, a reference-implementation pull request): liveness and checkout identity are
  // read once, well before the fetch and the tree-lock wait (documented as
  // potentially five minutes) — this is the re-check `main()` runs
  // immediately before `git merge`, and it must fail closed on every one of
  // liveness, branch identity and ancestry independently, without ever
  // guessing "still current" on an unreadable answer.

  interface StillCurrentAnswers {
    prView?: { code: number; stdout: string };
    revParse?: { code: number; stdout: string };
    mergeBase?: { code: number; stdout: string };
  }

  function fakeGh(a: StillCurrentAnswers): GhRunner {
    return (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(
          a.prView ?? { code: 0, stdout: JSON.stringify({ state: "OPEN" }) },
        );
      }
      return Promise.resolve({ code: 1, stdout: "" });
    };
  }

  function fakeStillCurrentGit(a: StillCurrentAnswers): GitRunner {
    return (args) => {
      const sub = args[2] ?? "";
      if (sub === "rev-parse") {
        return Promise.resolve(
          a.revParse ?? { code: 0, stdout: "feature-branch\n" },
        );
      }
      if (sub === "merge-base") {
        return Promise.resolve(a.mergeBase ?? { code: 0, stdout: "" });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    };
  }

  const HEAD_REF = "feature-branch";
  const HEAD_OID = "deadbeefcafe";

  it("reports ok when the PR is still OPEN and the checkout has not moved", async () => {
    const git = fakeStillCurrentGit({});
    const gh = fakeGh({});
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r).toEqual({ ok: true });
  });

  it("refuses with exit 5 when the PR closed during the wait", async () => {
    const git = fakeStillCurrentGit({});
    const gh = fakeGh({
      prView: { code: 0, stdout: JSON.stringify({ state: "MERGED" }) },
    });
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 5 });
  });

  it("refuses rather than guessing when the liveness re-check itself fails to run", async () => {
    const git = fakeStillCurrentGit({});
    const gh = fakeGh({ prView: { code: 1, stdout: "" } });
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 1 });
  });

  it("refuses rather than guessing on unparseable liveness JSON", async () => {
    const git = fakeStillCurrentGit({});
    const gh = fakeGh({ prView: { code: 0, stdout: "not json" } });
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 1 });
  });

  it("refuses with exit 2 when the checkout moved to a different branch during the wait", async () => {
    const git = fakeStillCurrentGit({
      revParse: { code: 0, stdout: "someone-elses-branch\n" },
    });
    const gh = fakeGh({});
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 2 });
  });

  it("refuses rather than guessing when the branch re-read itself fails to run", async () => {
    const git = fakeStillCurrentGit({ revParse: { code: 1, stdout: "" } });
    const gh = fakeGh({});
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 1 });
  });

  it("refuses with exit 2 when HEAD is no longer at or ahead of the reported head commit", async () => {
    const git = fakeStillCurrentGit({ mergeBase: { code: 1, stdout: "" } });
    const gh = fakeGh({});
    const r = await verifyStillCurrent(
      git,
      gh,
      "/repo",
      "4279",
      HEAD_REF,
      HEAD_OID,
    );
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 2 });
  });
});

describe("--base validation", () => {
  // Both spawn the REAL script against a value that never reaches a real
  // fetch — a stub `gh` stands in for the one outbound call the good path
  // would otherwise make, and its being touched (or not) is what tells the
  // two cases apart. `DRIVE_PR_TARGET`/`DRIVE_PR_WORKTREE` are stripped from
  // the child's env so this test's own outcome does not depend on whether it
  // happens to run inside a live drive-pr session (this file's own repo does,
  // routinely) — an inherited `DRIVE_PR_TARGET` that disagreed with the
  // literal PR number below would refuse before ever reaching the code under
  // test, for an unrelated reason.
  function runBaseSync(args: string[]): {
    exitCode: number;
    stderr: string;
    ghCalled: boolean;
  } {
    const probeDir = mkdtempSync(join(tmpdir(), "base-sync-base-flag-"));
    const marker = join(probeDir, "gh-was-called");
    writeFileSync(
      join(probeDir, "gh"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
      { mode: 0o755 },
    );
    const env = scrubbedGitEnv({
      PATH: `${probeDir}:${process.env.PATH ?? ""}`,
      GH_CALL_TIMEOUT: "1",
    });
    delete env.DRIVE_PR_TARGET;
    delete env.DRIVE_PR_WORKTREE;
    const r = Bun.spawnSync([process.execPath, BASE_SYNC, ...args], { env });
    const ghCalled = existsSync(marker);
    rmSync(probeDir, { recursive: true, force: true });
    return {
      exitCode: r.exitCode,
      stderr: r.stderr.toString(),
      ghCalled,
    };
  }

  // The refspec-injection payload from the reviewer finding this closes
  // (docomply-review, a reference-implementation pull request): a colon turns `--base`'s value from a
  // branch name into a `git fetch` refspec, which would WRITE
  // `refs/heads/other` locally as a side effect of the fetch this test must
  // never reach.
  //
  // Both `it`s below are POSIX-only: `runBaseSync`'s `gh` stub is an
  // extensionless `#!/bin/sh` script made executable via a POSIX mode bit,
  // and PATH lookup relying on that bit is not how Windows resolves an
  // executable — so this test would fail there for a reason having nothing
  // to do with the behavior under test (docomply-review, a reference-implementation pull request round 8).
  // Skipped rather than reimplemented on a `.cmd`/`.ps1` stub: every other
  // test in this file already spawns the real script cross-platform through
  // `proc.ts`'s own seam, and only this stubbed-`gh`-on-PATH shape is
  // POSIX-specific.
  (process.platform === "win32" ? it.skip : it)(
    "refuses a refspec-shaped --base before ever calling gh",
    () => {
      const r = runBaseSync(["--base", "source:refs/heads/other", "999999"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("not a valid branch name");
      expect(r.ghCalled).toBe(false);
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "accepts a plain branch name and proceeds to resolve the PR",
    () => {
      const r = runBaseSync(["--base", "develop", "999999"]);
      expect(r.stderr).not.toContain("not a valid branch name");
      expect(r.ghCalled).toBe(true);
    },
  );
});

describe("importing base-sync.ts does not run main()", () => {
  // `main()` runs only behind an `isEntryPoint` guard keyed on
  // `process.argv[1]` matching this file's own resolved path — exactly so
  // this file can `import { alreadyPushing }` above without triggering real
  // `git`/`gh` I/O against the TEST RUNNER's own argv. Nothing previously
  // asserted that (coderabbitai, PR #4279). A synchronous check of
  // `process.exitCode` right after import is NOT a reliable probe here:
  // `runMain` awaits `main()` and never calls `process.exit()`, so a broken
  // guard's side effects land on a later microtask, well after the importing
  // test file's own synchronous checks would have already run — verified by
  // mutation: forcing the guard true left `bun test` on this file reporting
  // 7/7 pass regardless, proving that shape of probe vacuous. A spawned
  // subprocess is required because `spawnSync` blocks until every pending
  // promise the child created (main()'s included, since it is never unref'd)
  // has settled — the same "spawns no gh" pattern
  // resolve-review-comments/__tests__/scripts.test.ts uses for its own
  // script family.
  // POSIX-only, the same reason as the `--base validation` tests above: an
  // extensionless `#!/bin/sh` `gh` stub made executable via a POSIX mode bit
  // is not how Windows PATH resolution works (docomply-review, a reference-implementation pull request
  // round 8).
  (process.platform === "win32" ? it.skip : it)(
    "spawns no gh and prints nothing to stderr",
    () => {
      const probeDir = mkdtempSync(join(tmpdir(), "base-sync-import-"));
      const marker = join(probeDir, "gh-was-called");
      writeFileSync(
        join(probeDir, "gh"),
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
        { mode: 0o755 },
      );
      const r = Bun.spawnSync(
        [process.execPath, "-e", `import(${JSON.stringify(BASE_SYNC)})`],
        {
          env: scrubbedGitEnv({
            PATH: `${probeDir}:${process.env.PATH ?? ""}`,
            GH_CALL_TIMEOUT: "1",
          }),
        },
      );
      const stderr = r.stderr.toString().slice(0, 400);
      expect({ ghCalled: existsSync(marker), stderr }).toEqual({
        ghCalled: false,
        stderr: "",
      });
      rmSync(probeDir, { recursive: true, force: true });
    },
  );
});

describe("unmerged-path detection distinguishes a hook block from a real conflict", () => {
  // The fix this pins (chatgpt-codex-connector, a reference-implementation pull request): `MERGE_HEAD`'s
  // mere presence after a failed `git merge` does not by itself prove a
  // content conflict — `githooks(5)`'s `pre-merge-commit` runs after git has
  // already resolved the merge into the index/worktree, and a nonzero exit
  // from it blocks the commit while leaving the identical marker behind.
  // `main()`'s discriminator is `git diff --name-only --diff-filter=U`
  // (empty index = nothing unmerged = not a content conflict). This test
  // exercises REAL git — a stubbed `GitRunner` would only assert this file's
  // own beliefs about git's behavior, not git's actual behavior — to verify
  // the two cases are actually distinguishable by that command, which is the
  // one fact the fix depends on. POSIX-only, the same reason as the other
  // real-git tests in this file: an executable-bit hook script is not how
  // Windows resolves an executable.
  function run(cwd: string, args: string[]): { code: number; stdout: string } {
    const r = Bun.spawnSync(["git", ...args], { cwd });
    return { code: r.exitCode, stdout: r.stdout.toString() };
  }

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "base-sync-unmerged-"));
    run(dir, ["init", "-q", "-b", "main"]);
    run(dir, ["config", "user.email", "test@example.com"]);
    run(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "shared.txt"), "base\n");
    run(dir, ["add", "."]);
    run(dir, ["commit", "-q", "-m", "base"]);
    return dir;
  }

  function unmergedPaths(dir: string): string {
    return run(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
  }

  function mergeHeadPresent(dir: string): boolean {
    return run(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0;
  }

  (process.platform === "win32" ? it.skip : it)(
    "is empty when a pre-merge-commit hook blocks an otherwise-clean merge",
    () => {
      const dir = initRepo();
      run(dir, ["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(dir, "feature-only.txt"), "feature\n");
      run(dir, ["add", "."]);
      run(dir, ["commit", "-q", "-m", "feature"]);
      run(dir, ["checkout", "-q", "main"]);
      writeFileSync(join(dir, "main-only.txt"), "main\n");
      run(dir, ["add", "."]);
      run(dir, ["commit", "-q", "-m", "main-side"]);
      writeFileSync(
        join(dir, ".git", "hooks", "pre-merge-commit"),
        "#!/bin/sh\nexit 1\n",
        { mode: 0o755 },
      );

      const merge = run(dir, [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        "merge feature",
        "feature",
      ]);

      expect(merge.code).not.toBe(0);
      expect(mergeHeadPresent(dir)).toBe(true);
      expect(unmergedPaths(dir)).toBe("");

      run(dir, ["merge", "--abort"]);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "is non-empty when the merge leaves a real textual conflict",
    () => {
      const dir = initRepo();
      run(dir, ["checkout", "-q", "-b", "feature"]);
      writeFileSync(join(dir, "shared.txt"), "feature-change\n");
      run(dir, ["add", "."]);
      run(dir, ["commit", "-q", "-m", "feature"]);
      run(dir, ["checkout", "-q", "main"]);
      writeFileSync(join(dir, "shared.txt"), "main-change\n");
      run(dir, ["add", "."]);
      run(dir, ["commit", "-q", "-m", "main-side"]);

      const merge = run(dir, [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        "merge feature",
        "feature",
      ]);

      expect(merge.code).not.toBe(0);
      expect(mergeHeadPresent(dir)).toBe(true);
      expect(unmergedPaths(dir)).toBe("shared.txt");

      run(dir, ["merge", "--abort"]);
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
