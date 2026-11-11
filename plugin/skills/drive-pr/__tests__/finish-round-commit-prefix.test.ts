/**
 * finish-round.ts puts `pull_requests.commit_prefix` on the round's unpushed
 * commits itself, before the CI hold and the push, so the head it pushes and
 * stamps is the reworded one; and it refuses the push (exit 9) when the
 * prefix cannot be put on them.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { useDrivePrSuite, gitCleanEnv } from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();

/** The configuration of a repository whose commits carry the Linear key. */
const PREFIX_ENV = {
  JIG__ISSUE_TRACKER__ADAPTER: "linear",
  JIG__ISSUE_TRACKER__TEAM: "ENG",
  JIG__PULL_REQUESTS__COMMIT_PREFIX: '"{key}: "',
};

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: gitCleanEnv(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fixed committer date, so the reword makes a commit the test can name first. */
const COMMITTER_DATE = "1700000000 +0000";

/**
 * The commit `commit-prefix.ts` makes of HEAD with `prefix`: same tree,
 * parent and author, the message prefixed, committed at `COMMITTER_DATE`.
 */
function rewordedHead(dir: string, prefix: string): string {
  const [name = "", email = "", date = ""] = gitIn(
    dir,
    "log",
    "-1",
    "--format=%an%x00%ae%x00%ad",
    "--date=raw",
  ).split("\0");
  const message = gitIn(dir, "log", "-1", "--format=%B").replace(/\n+$/, "");
  const r = spawnSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD~1"], {
    cwd: dir,
    encoding: "utf8",
    input: `${prefix}${message}\n`,
    env: {
      ...gitCleanEnv(),
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: COMMITTER_DATE,
    },
  });
  if (r.status !== 0) throw new Error(`git commit-tree: ${r.stderr}`);
  return r.stdout.trim();
}

describe("finish-round.ts: the commit prefix", () => {
  const { finishRound, scratchWithOrigin } =
    createFindingsFinishRoundFixtures();

  it("rewords the unpushed commit before the push, then pushes, stamps and syncs the reworded head", async () => {
    const repo = scratchWithOrigin();
    const before = gitIn(repo.dir, "rev-parse", "HEAD");
    // The fixture PR's head branch is feature/ENG-9999-probe, and its head
    // the commit the reword makes: what the forge reports once it landed.
    const reworded = rewordedHead(repo.dir, "ENG-9999: ");
    const r = await finishRound({
      repo: { dir: repo.dir, head: reworded },
      env: { ...PREFIX_ENV, GIT_COMMITTER_DATE: COMMITTER_DATE },
    });
    expect(r.exitCode).toBe(0);
    expect(r.report.state).toBe("FINISHED");
    expect(gitIn(repo.dir, "rev-parse", "HEAD")).toBe(reworded);
    expect(gitIn(repo.dir, "log", "-1", "--format=%s")).toStartWith(
      "ENG-9999: ",
    );
    expect(r.report.head).toBe(reworded);
    expect(r.pushed).toContain(`${reworded}:refs/heads/feature/ENG-9999-probe`);
    expect(r.pushed).not.toContain(before);
    expect(r.report.stamped).toBe(true);
    expect(r.report.headSynced).toBe(true);
  });

  it("refuses the push with exit 9 when the key cannot be read, pushing nothing", async () => {
    const r = await finishRound({
      env: {
        JIG__ISSUE_TRACKER__ADAPTER: "linear",
        JIG__PULL_REQUESTS__COMMIT_PREFIX: '"{key}: "',
      },
    });
    expect(r.exitCode).toBe(9);
    expect(r.report.state).toBe("REFUSED_COMMIT_PREFIX");
    expect(String(r.report.reason)).toContain("commit-prefix.ts exited 3");
    expect(r.pushed).toBe("");
    expect(gitIn(r.repo.dir, "rev-parse", "HEAD")).toBe(r.repo.head);
  });

  it("leaves the commits alone without a prefix", async () => {
    const r = await finishRound();
    expect(gitIn(r.repo.dir, "rev-parse", "HEAD")).toBe(r.repo.head);
    expect(r.report.head).toBe(r.repo.head);
  });
});
