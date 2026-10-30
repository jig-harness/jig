/**
 * drive-pr suite: commits a pass leaves unpushed, whatever its exit, and
 * commits the drive is armed over. The driver measures the tree before every
 * gate: commits on top of the head branch's remote ref go to the next round
 * as an inherited head with a notice telling its pass to push them, never to
 * a `HEAD_LAG` wait; commits that do not build on it stop the drive at once;
 * a failed pass's stop line names what it left. A head that was pushed and
 * that the API has not caught up with is still `HEAD_LAG`.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitCleanEnv, tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";
import { runDrive } from "./drive-loop-harness.ts";
import { trackedTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitCleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0);
  return r.stdout.toString().trim();
}

/** Commit one file in `cwd` as `subject` and return the new head. */
function commit(cwd: string, name: string, subject: string): string {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", subject, "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}

const COMMIT_WIP = (subject: string) =>
  `echo wip > wip.txt; git add wip.txt; git -c user.email=p@example.invalid -c user.name=p commit -qm '${subject}' --no-verify`;

/** The gate's flags: short enough that a HEAD_LAG wait ends the drive quickly. */
const GATE = ["--timeout", "5", "--interval", "5"];

const work = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };

describe("drive.ts hands unpushed commits to the next round", () => {
  it("after a pass that exits 0 without pushing, instead of waiting out HEAD_LAG", async () => {
    const tree = trackedTree("unpushed-exit0");
    const reviewed = git(tree, "rev-parse", "HEAD");
    const marker = join(tmpRoot, "unpushed-exit0-first");
    const noticeFile = join(tmpRoot, "unpushed-exit0-notice");
    const headFile = join(tmpRoot, "unpushed-exit0-head");
    // The first pass commits and exits 0 before pushing. The second records
    // its notice and stands in for the push by returning the tree to the
    // head the API reports.
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        `if [ ! -e '${marker}' ]; then : > '${marker}'; ${COMMIT_WIP("promised fix")}; exit 0; fi`,
        `printf '%s' "$DRIVE_PR_PASS_NOTICE" > '${noticeFile}'`,
        `git rev-parse HEAD > '${headFile}'`,
        `git reset -q --hard ${reviewed}`,
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDrive(
      { ...work, head: reviewed },
      [...GATE, "--max-rounds", "2", "--", ...pass],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).not.toContain("HEAD_LAG");
    expect(r.stderr).toContain("Unpushed commits: 1");
    expect(existsSync(noticeFile)).toBe(true);
    const notice = readFileSync(noticeFile, "utf8");
    const inherited = readFileSync(headFile, "utf8").trim();
    expect(inherited).not.toBe(reviewed);
    expect(notice).toStartWith("UNPUSHED COMMITS");
    expect(notice).toContain(`--inherited-head ${inherited}`);
    expect(notice).toContain("promised fix");
    expect(notice).toContain("finish-round");
  }, 120_000);

  it("when the drive is armed over them, to the first round", async () => {
    const tree = trackedTree("unpushed-armed");
    const reviewed = git(tree, "rev-parse", "HEAD");
    const local = commit(tree, "local.txt", "committed before the arm");
    const noticeFile = join(tmpRoot, "unpushed-armed-notice");
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        `printf '%s' "$DRIVE_PR_PASS_NOTICE" > '${noticeFile}'`,
        `git reset -q --hard ${reviewed}`,
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDrive(
      { ...work, head: reviewed },
      [...GATE, "--max-rounds", "1", "--", ...pass],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).not.toContain("HEAD_LAG");
    const notice = readFileSync(noticeFile, "utf8");
    expect(notice).toStartWith("UNPUSHED COMMITS");
    expect(notice).toContain(`--inherited-head ${local}`);
    expect(notice).toContain("committed before the arm");
  }, 120_000);

  it("still polls HEAD_LAG over a head that was pushed and the API has not caught up with", async () => {
    const tree = trackedTree("unpushed-replication-lag");
    const reviewed = git(tree, "rev-parse", "HEAD");
    // The pass pushes: local HEAD equals the remote-tracking ref, and only
    // the API (the fixture's head) is behind.
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        COMMIT_WIP("pushed fix"),
        "git push -q origin HEAD:main",
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDrive(
      { ...work, head: reviewed },
      [...GATE, "--max-rounds", "2", "--", ...pass],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 4);
    expect(r.stderr).toContain("HEAD_LAG");
    expect(r.stderr).not.toContain("Unpushed commits");
    expect(git(tree, "rev-parse", "HEAD")).toBe(
      git(tree, "rev-parse", "refs/remotes/origin/main"),
    );
  }, 120_000);
});

describe("drive.ts stops at once over commits no round can push", () => {
  it("names local commits that do not build on the head branch's remote ref", async () => {
    const tree = trackedTree("unpushed-diverged");
    const reviewed = git(tree, "rev-parse", "HEAD");
    const marker = join(tmpRoot, "unpushed-diverged-first");
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        `if [ -e '${marker}' ]; then echo 'pass for 999: SECOND_''PASS' >&2; exit 0; fi`,
        `: > '${marker}'`,
        "git reset -q --hard HEAD~1",
        COMMIT_WIP("rewritten history"),
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDrive(
      { ...work, head: reviewed },
      [...GATE, "--max-rounds", "3", "--", ...pass],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).not.toContain("HEAD_LAG");
    expect(r.stderr).not.toContain("SECOND_PASS");
    // The suite runs without the attach, so the tree's upstream is the base.
    expect(r.stderr).toContain("does not build on @{u}");
    expect(r.stderr).toContain("rewritten history");
  }, 120_000);
});

describe("drive.ts names what a failed pass left", () => {
  it("lists the uncommitted paths and the unpushed commits in the stop", async () => {
    const tree = trackedTree("unpushed-failed");
    const reviewed = git(tree, "rev-parse", "HEAD");
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        COMMIT_WIP("half-landed fix"),
        "echo stray > stray.txt",
        "exit 3",
      ].join("\n"),
    ];
    const r = await runDrive(
      { ...work, head: reviewed },
      [...GATE, "--", ...pass],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("pass failed on round 1 (exit 3)");
    expect(r.stderr).toContain("stray.txt");
    expect(r.stderr).toContain("Unpushed commits: 1");
    expect(r.stderr).toContain("half-landed fix");
  }, 120_000);
});
