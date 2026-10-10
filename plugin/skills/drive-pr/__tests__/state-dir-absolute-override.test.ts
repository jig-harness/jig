/**
 * docomply-review + chatgpt-codex-connector (PR #4612 round 4): a relative
 * `$DRIVE_PR_STATE_DIR` resolves against `process.cwd()`, both in
 * `resolveStateDir()` (store.ts) and in `resolveFenceContext()`'s own,
 * independent read of the raw env var (lease.ts) — two participants
 * launched from different working directories (the base checkout and a
 * linked worktree, in particular) would silently resolve the identical
 * override string to two different directories, recreating exactly the
 * split state/lease hazard `$DRIVE_PR_STATE_DIR` exists to let an operator
 * opt OUT of. Both readers now fail closed on a relative override rather
 * than resolving it silently.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import { resolveStateDir } from "../scripts/lib/state/store.ts";

const LEASE_TS = new URL("../scripts/lib/state/lease.ts", import.meta.url)
  .pathname;

// Captured once, before any test runs — never re-read inside `afterEach`,
// which would just capture whatever the PREVIOUS test left behind. A machine
// that exports `$DRIVE_PR_STATE_DIR` itself (the documented machine-wide
// relocation this same file's own header describes) launches `bun test`
// with it already inherited, and other test files sharing this worker
// process depend on that inherited value surviving — unconditionally
// deleting it here (rather than restoring whatever was actually present)
// would silently strip it out from under them for the rest of the run
// (docomply-review, a reference-implementation pull request round 6).
const ORIGINAL_STATE_DIR = process.env.DRIVE_PR_STATE_DIR;

const dirs: string[] = [];
afterEach(() => {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.DRIVE_PR_STATE_DIR;
  } else {
    process.env.DRIVE_PR_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveStateDir — relative $DRIVE_PR_STATE_DIR fails closed", () => {
  it("accepts an absolute override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-dir-abs-"));
    dirs.push(dir);
    process.env.DRIVE_PR_STATE_DIR = dir;
    expect(await resolveStateDir()).toBe(dir);
  });

  it("refuses a relative override rather than silently resolving it against cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-dir-abs-"));
    dirs.push(dir);
    // A genuinely relative path — relative to whatever cwd this test
    // process happens to run from, which is exactly the ambiguity the
    // guard exists to refuse rather than silently resolve one way.
    process.env.DRIVE_PR_STATE_DIR = relative(process.cwd(), dir);
    await expect(resolveStateDir()).rejects.toThrow(ExitError);
  });
});

describe("resolveFenceContext — relative $DRIVE_PR_STATE_DIR fails closed", () => {
  it("refuses a relative override before ever reading git or a lease", async () => {
    // Run in a REAL SUBPROCESS launched from a fresh, non-repository cwd —
    // not merely `process.chdir()` in this test process. This matters here,
    // not just belt-and-suspenders, for two reasons: (1) `worktreeRoot()`
    // (actor.ts) memoises its git resolution PER PROCESS — once this test
    // file's own process has resolved it against the real repo (which any
    // earlier test, in this file or one bun batches alongside it, may have
    // already triggered), every later call in that same process replays the
    // cached, real-repo answer regardless of `process.chdir()`. (2) Without
    // this, the assertion below would still pass even if the guard were
    // moved to AFTER `resolveActor()`/git — the exact ordering regression
    // this test exists to catch — because a real repo cwd makes that later
    // git call succeed too, and the same ExitError would still surface
    // moments later from the (now misplaced) guard (docomply-review, PR
    // #4612 round 5).
    const cwd = mkdtempSync(join(tmpdir(), "state-dir-abs-non-repo-"));
    dirs.push(cwd);
    // Shape alone (relative vs. absolute) is what the guard tests — it runs
    // before any existence check, so the override need not name a real
    // directory.
    const relOverride = "relative-state-dir-override";

    const probe = join(cwd, "probe.ts");
    writeFileSync(
      probe,
      [
        `import { resolveFenceContext } from ${JSON.stringify(LEASE_TS)};`,
        `try {`,
        `  await resolveFenceContext('test');`,
        `  console.error('UNEXPECTED_SUCCESS');`,
        `  process.exit(1);`,
        `} catch (e) {`,
        `  console.error('CAUGHT: ' + (e && e.constructor && e.constructor.name));`,
        `  process.exit(0);`,
        `}`,
        "",
      ].join("\n"),
    );

    // gitIdentityEnv(), not a raw `...process.env` spread — an inherited
    // GIT_DIR/GIT_WORK_TREE would let `resolveActor()` resolve against the
    // PARENT repo despite this non-repository cwd, so the probe could pass
    // even with the guard moved to after `resolveActor()` (coderabbitai, PR
    // #4612 round 12) — silently defeating the exact ordering regression
    // this test exists to catch.
    const result = Bun.spawnSync(["bun", probe], {
      cwd,
      env: { ...gitIdentityEnv(), DRIVE_PR_STATE_DIR: relOverride },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = result.stderr.toString();
    // The specific message, not just "an ExitError happened" — resolveActor()
    // ALSO throws via `fail()` (as an ExitError) when the cwd is not a git
    // repository, which this non-repo cwd deliberately is not. A bare
    // "contains ExitError" assertion would therefore still pass even with
    // the guard moved to after resolveActor(), for the wrong reason
    // entirely — pin the guard's own wording instead.
    expect(stderr).toContain("must be an absolute path");
    expect(stderr).toContain("CAUGHT: ExitError");
    expect(result.exitCode).toBe(0);
  });
});
