/**
 * The drive-pr suite's repository shaped like a driven pull request after a
 * base-sync merge, for the probes of the base-sync exclusion. Built under the
 * suite's scratch root (`tmpRoot`), so `useDrivePrSuite()` must be active.
 */
import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCleanEnv, tmpRoot } from "./drive-pr-harness.ts";

/**
 * A repo shaped like a real driven PR that has been through a base-sync
 * merge: C0 (seed.txt) → C1 (fix seed.txt, doubling as this round's own last
 * VERIFIED sha) → D (a commit on a stand-in "develop" tip, sibling to C1, off
 * a file `origin/develop` alone ever touches) → M (`git merge D`, a
 * base-sync-style merge with parents [C1, D]) → R (the round's OWN
 * single-parent commit on top of M, touching a THIRD file). `origin/develop`
 * is pointed at D.
 *
 * Exercises the base-sync exclusion:
 * `changedFilesSinceExcludingMerges(root, pr, verifiedSha)` must report ONLY
 * `round-only.txt` (R's own file) as touched by this round — never
 * `develop-only.txt` (D's file, imported solely by the base-sync merge M) —
 * even though a plain `git diff verifiedSha` (what `changedFilesSince` used
 * to compute, and what `round-plan.ts` still deliberately computes for its
 * own cumulative purpose) contains both.
 */
export function makeBaseSyncMergeRepo(name: string): {
  dir: string;
  verifiedSha: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Every call here used to run unchecked, so a failed setup step would
    // silently hand the probes below a repo shape they then assert against for
    // the wrong reason. Matches the `gitOut` pattern of `makeOrphanCommit`
    // in drive-pr-harness.ts.
    expect(`git ${args[0]}: ${r.stderr.toString().trim()}`).toBe(
      `git ${args[0]}: `,
    );
    return r;
  };
  const gitOut = (...args: string[]) =>
    git(...args)
      .stdout.toString()
      .trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", "/dev/null");

  writeFileSync(join(dir, "seed.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `seed ${name}`, "--no-verify");
  writeFileSync(join(dir, "seed.txt"), `${name} fixed\n`);
  git("add", "-A");
  git("commit", "-qm", `fix ${name}`, "--no-verify");
  const verifiedSha = gitOut("rev-parse", "HEAD");

  // D — a sibling commit off the SAME parent (verifiedSha), never checked
  // out as `main`: a stand-in for `origin/develop` advancing independently
  // while this round's branch sat at `verifiedSha`.
  git("branch", "-q", "devtip", "HEAD");
  git("checkout", "-q", "devtip");
  writeFileSync(join(dir, "develop-only.txt"), "from develop\n");
  git("add", "-A");
  git("commit", "-qm", "develop advances", "--no-verify");
  const devTip = gitOut("rev-parse", "HEAD");
  git("checkout", "-q", "main");

  // M — a base-sync-style merge, parents [verifiedSha, devTip].
  git("merge", "-q", "--no-ff", "devtip", "--no-edit");

  // R — the round's OWN commit, on top of the merge, touching a THIRD file.
  writeFileSync(join(dir, "round-only.txt"), "from the round\n");
  git("add", "-A");
  git("commit", "-qm", "round work", "--no-verify");
  const head = gitOut("rev-parse", "HEAD");

  git("remote", "add", "origin", "git@github.com:example-org/example-repo.git");
  git("update-ref", "refs/remotes/origin/develop", devTip);

  return { dir, verifiedSha, head };
}
