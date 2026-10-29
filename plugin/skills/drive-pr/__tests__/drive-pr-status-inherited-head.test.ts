/**
 * drive-pr suite: drive-status.ts --inherited-head, the one local head the
 * head-sync guard accepts ahead of the PR head: the commits a pass killed at
 * its deadline left unpushed. Every other mismatch is still HEAD_LAG.
 * Shared fixtures live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  binDir,
  type Fixture,
  gitCleanEnv,
  makeScratchRepo,
  SCRIPTS,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";

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

/** Commit one file on the current branch and return the new head. */
function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", name, "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}

async function gate(tree: string, fixture: Fixture, args: string[]) {
  const { dir, stateDir } = writeFixture(fixture, tree);
  const proc = Bun.spawn(
    scriptArgv(
      join(SCRIPTS, "drive-status.ts"),
      "999",
      "--json",
      "--once",
      ...args,
    ),
    {
      cwd: tree,
      env: {
        ...gitCleanEnv(),
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const report = stdout.trim() === "" ? {} : JSON.parse(stdout);
  return {
    stdout,
    stderr,
    exitCode,
    state: String(report.state ?? ""),
    reason: String(report.reason ?? ""),
  };
}

const work = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };

describe("drive-status.ts --inherited-head", () => {
  it("hands out the round over the witnessed head a killed pass left unpushed", async () => {
    const repo = makeScratchRepo("inherited-accepts");
    const inherited = commit(repo.dir, "wip.txt");
    const fixture = { ...work, head: repo.head };
    const lag = await gate(repo.dir, fixture, []);
    expectSpawnExit(lag, 4);
    expect(lag.state).toBe("HEAD_LAG");
    const r = await gate(repo.dir, fixture, ["--inherited-head", inherited]);
    expectSpawnExit(r, 0);
    expect(r.state).toBe("ROUND_READY");
    expect(r.reason).toContain(`local HEAD ${inherited}`);
  });

  it("does not converge over the inherited commits: the round pushes them", async () => {
    const repo = makeScratchRepo("inherited-no-converge");
    const inherited = commit(repo.dir, "wip.txt");
    const fixture = { threads: [], reviewedSha: repo.head, head: repo.head };
    const r = await gate(repo.dir, fixture, ["--inherited-head", inherited]);
    expectSpawnExit(r, 0);
    expect(r.state).toBe("ROUND_READY");
    expect(r.reason).toContain("left unpushed");
  });

  it("still lags when local HEAD is not the head the driver witnessed", async () => {
    const repo = makeScratchRepo("inherited-other-head");
    const witnessed = commit(repo.dir, "wip.txt");
    commit(repo.dir, "later.txt");
    const r = await gate(repo.dir, { ...work, head: repo.head }, [
      "--inherited-head",
      witnessed,
    ]);
    expectSpawnExit(r, 4);
    expect(r.state).toBe("HEAD_LAG");
  });

  it("still lags when the inherited head does not descend from the PR head", async () => {
    const repo = makeScratchRepo("inherited-not-descendant");
    // The PR head moved to a commit the local tree does not build on.
    git(repo.dir, "checkout", "-q", "-b", "elsewhere", "HEAD~1");
    const apiHead = commit(repo.dir, "elsewhere.txt");
    git(repo.dir, "checkout", "-q", "main");
    const local = git(repo.dir, "rev-parse", "HEAD");
    const r = await gate(repo.dir, { ...work, head: apiHead }, [
      "--inherited-head",
      local,
    ]);
    expectSpawnExit(r, 4);
    expect(r.state).toBe("HEAD_LAG");
  });

  it("refuses a value that is not a full commit SHA", async () => {
    const repo = makeScratchRepo("inherited-bad-value");
    const r = await gate(repo.dir, { ...work, head: repo.head }, [
      "--inherited-head",
      "HEAD",
    ]);
    expectSpawnExit(r, 2);
  });
});

describe("drive-status.ts --inherited-head with --no-head-sync", () => {
  it("owes the round over unpushed commits, the local head unread", async () => {
    const repo = makeScratchRepo("inherited-no-head-sync");
    const inherited = commit(repo.dir, "wip.txt");
    const fixture = { threads: [], reviewedSha: repo.head, head: repo.head };
    const r = await gate(repo.dir, fixture, [
      "--no-head-sync",
      "--inherited-head",
      inherited,
    ]);
    expectSpawnExit(r, 0);
    expect(r.state).toBe("ROUND_READY");
    expect(r.reason).toContain(`local HEAD ${inherited}`);
  });

  it("owes nothing more once the PR head contains the inherited commits", async () => {
    const repo = makeScratchRepo("inherited-no-head-sync-pushed");
    const inherited = repo.head;
    const apiHead = commit(repo.dir, "pushed.txt");
    const fixture = { threads: [], reviewedSha: apiHead, head: apiHead };
    const r = await gate(repo.dir, fixture, [
      "--no-head-sync",
      "--inherited-head",
      inherited,
    ]);
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    expect(r.reason).not.toContain("left unpushed");
  });
});
