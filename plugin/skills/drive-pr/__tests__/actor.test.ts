/**
 * actor.test.ts — worktree identity anchoring for lease/hold attribution.
 *
 * `resolveActor()`/`worktreeRoot()` (lib/state/actor.ts) answer "which working
 * tree is this process in" for every fence and hold this skill takes
 * (`resolveFenceContext`, `hold`, `set-verified`, …). Verified through a real
 * subprocess and two real git repositories, not a stub: the function under
 * test IS the `git rev-parse --show-toplevel` call itself, and the property
 * being pinned is which directory that call runs FROM.
 *
 * Pins the fix for the gap the reviewer named (chatgpt-codex-connector, PR
 * #4279): a driven pass's shell cwd persists across tool calls, so a `cd` to
 * an unrelated tree between calls used to make this resolve THAT tree's root
 * instead of the one the driver is actually driving — protecting the wrong
 * tree's fence while the mutation lands in the real one, or falsely refusing
 * on an unrelated lease. `base-sync.ts` and `drive-status.ts` already anchor
 * their own root/HEAD reads to `$DRIVE_PR_WORKTREE`; this is the same anchor
 * applied at the one shared choke point every lease/hold caller goes through.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `process.env` minus every `GIT_*` pointer and `DRIVE_PR_WORKTREE` — a git
 * hook exports `GIT_DIR`/`GIT_WORK_TREE` into its children, and a scratch
 * repo created under that inheritance would operate on the REAL repository
 * instead (see `drive-pr.test.ts`'s own copy of this rule). `DRIVE_PR_WORKTREE`
 * is the anchor `worktreeRoot` is under test for, so it must be ABSENT by
 * default and each test states it explicitly — this suite is not immune to
 * the ambient value a live `drive.ts` pass exports into every subprocess it
 * spawns (including a `bun test` run started from inside one), and an
 * inherited leak here silently makes the no-anchor fallback test pass or
 * fail depending on whether the suite happens to be running under a drive.
 */
function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "DRIVE_PR_WORKTREE" || v === undefined)
      continue;
    env[k] = v;
  }
  return env;
}

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `actor-test-${name}-`));
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "actor-probe@example.invalid");
  git("config", "user.name", "drive-pr actor probe");
  writeFileSync(join(dir, "f.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `${name} init`, "--no-verify");
  return dir;
}

/** The real `--show-toplevel` for `dir`, to compare against — not `dir`
 * itself, since a symlink hop (macOS `/var` -> `/private/var`) can make the
 * two differ even though they name one tree. */
function showToplevel(dir: string): string {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    env: gitCleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString().trim();
}

const ACTOR_MODULE = join(
  import.meta.dir,
  "..",
  "scripts",
  "lib",
  "state",
  "actor.ts",
);
const probeDir = mkdtempSync(join(tmpdir(), "actor-test-probe-"));
const probeScript = join(probeDir, "probe.ts");
writeFileSync(
  probeScript,
  [
    `import { worktreeRoot } from ${JSON.stringify(ACTOR_MODULE)};`,
    "console.log(await worktreeRoot());",
    "",
  ].join("\n"),
);

function probeWorktreeRoot(
  cwd: string,
  extraEnv: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", probeScript], {
    cwd,
    env: { ...gitCleanEnv(), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString(),
  };
}

describe("worktreeRoot", () => {
  const repoA = makeRepo("a");
  const repoB = makeRepo("b");

  afterAll(() => {
    for (const dir of [repoA, repoB, probeDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves from the ambient cwd when $DRIVE_PR_WORKTREE is unset — unchanged fallback for a hand-run pass", () => {
    const r = probeWorktreeRoot(repoA);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(showToplevel(repoA));
  });

  it("ignores an inherited GIT_DIR/GIT_WORK_TREE naming another checkout — the key names the tree actually driven", () => {
    // A hook-launched driver inherits these for ANOTHER checkout, and they
    // outrank the cwd: unscrubbed, `--show-toplevel` would name repoB while
    // the driver sits in repoA, so the worktree lock would key on the wrong
    // tree (docomply-review, a reference-implementation pull request round 9).
    const r = probeWorktreeRoot(repoA, {
      GIT_DIR: join(repoB, ".git"),
      GIT_WORK_TREE: repoB,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(showToplevel(repoA));
    expect(r.stdout).not.toBe(showToplevel(repoB));
  });

  it("anchors to $DRIVE_PR_WORKTREE, not the ambient cwd, when the driver set one", () => {
    // The exact shape a driven pass reproduces: cwd has drifted to repoA (a
    // prior tool call `cd`'d there) while the driver is actually driving
    // repoB. Before the fix this read repoA's root — the pass's wandering
    // cwd — silently taking the fence in the wrong tree.
    const r = probeWorktreeRoot(repoA, { DRIVE_PR_WORKTREE: repoB });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(showToplevel(repoB));
    expect(r.stdout).not.toBe(showToplevel(repoA));
  });

  it("anchors correctly even when cwd and $DRIVE_PR_WORKTREE happen to agree", () => {
    // Not a redundant case: it rules out a fix that accidentally always
    // prefers cwd and only LOOKS anchored because the two usually match.
    const r = probeWorktreeRoot(repoB, { DRIVE_PR_WORKTREE: repoB });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(showToplevel(repoB));
  });
});
