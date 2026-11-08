/**
 * drive-pr suite: drive-status.ts over a head the reviewer skipped. The
 * reviewer's sticky comment names, in a skip-notice block, a pushed head it
 * did not review; its reviewed-SHA marker stays on the earlier head. A skip
 * of the current head whose pull-request diff equals the reviewed head's is
 * judged on the reviewed head; any other skip of the current head stops as
 * `REVIEW_SKIPPED`; a notice naming another head changes nothing.
 * Shared fixtures live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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

function commitFile(cwd: string, name: string, text: string): string {
  writeFileSync(join(cwd, name), text);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", `edit ${name}`, "--no-verify");
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * A pull request's history: `reviewed` (the head the reviewer reviewed) edits
 * `feature.txt` on a branch off the base; the base then moves on with a file
 * of its own (`base`); `merged` merges that base in, which leaves the pull
 * request's own diff unchanged; `changed` edits the feature on top of it.
 */
function pullRequestRepo(name: string) {
  const repo = makeScratchRepo(name);
  commitFile(repo.dir, "feature.txt", "one\ntwo\nthree\n");
  git(repo.dir, "checkout", "-q", "-b", "feature");
  const reviewed = commitFile(repo.dir, "feature.txt", "one\nTWO\nthree\n");
  git(repo.dir, "checkout", "-q", "main");
  const base = commitFile(repo.dir, "base.txt", "from the base\n");
  git(repo.dir, "checkout", "-q", "feature");
  git(repo.dir, "merge", "-q", "--no-ff", "--no-edit", "main");
  const merged = git(repo.dir, "rev-parse", "HEAD");
  const changed = commitFile(repo.dir, "feature.txt", "one\nTWO\nTHREE\n");
  return { dir: repo.dir, base, reviewed, merged, changed };
}

const SKIP_MARKER = "ai-review-skip-notice";

function skipNotice(head: string, marker = SKIP_MARKER): string {
  return [
    `<!-- ${marker} -->`,
    "> [!WARNING]",
    `> **Review did not run** for push \`${head.slice(0, 12)}\` — skipped: empty diff (nothing to review after excludes). A green check on this run does not mean the push was reviewed.`,
    `<!-- /${marker} -->`,
  ].join("\n");
}

/** Put `notice` into the fixture's sticky comment, right below its marker. */
function addToSticky(dir: string, notice: string): void {
  const path = join(dir, "issue-comments.json");
  const comments = JSON.parse(readFileSync(path, "utf8")) as Array<{
    body: string;
  }>;
  const sticky = comments.find((c) =>
    c.body.startsWith("<!-- ai-code-review -->"),
  );
  if (sticky === undefined) throw new Error("the fixture has no sticky");
  sticky.body = sticky.body.replace(
    "<!-- ai-code-review -->",
    `<!-- ai-code-review -->\n${notice}`,
  );
  writeFileSync(path, JSON.stringify(comments));
}

async function gate(
  tree: string,
  fixture: Fixture,
  notice: string | null,
  env: Record<string, string> = {},
) {
  const { dir, stateDir } = writeFixture(fixture, tree);
  if (notice !== null) addToSticky(dir, notice);
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "drive-status.ts"), "999", "--json", "--once"),
    {
      cwd: tree,
      env: {
        ...gitCleanEnv(),
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        ...env,
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
    reviewer: (report.reviewer ?? {}) as Record<string, unknown>,
  };
}

/** The pull request at `head`, checked out, with the reviewer's marker on `reviewed`. */
function at(
  repo: ReturnType<typeof pullRequestRepo>,
  head: string,
  base = repo.base,
): Fixture {
  git(repo.dir, "checkout", "-q", "--detach", head);
  return { threads: [], head, base, reviewedSha: repo.reviewed };
}

describe("drive-status.ts over a head the reviewer skipped", () => {
  it("judges a base merge the reviewer skipped on the head it reviewed", async () => {
    const repo = pullRequestRepo("skipped-base-merge");
    const r = await gate(
      repo.dir,
      at(repo, repo.merged),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    expect(r.reviewer.reviewedSha).toBe(repo.reviewed);
    expect(r.reviewer.reviewedShaSource).toBe("skip-notice");
    expect(r.reason).toContain(repo.reviewed);
    expect(r.reason).toContain("skipped");
  });

  it("stops as REVIEW_SKIPPED, naming the skip, when the skipped head changed the diff", async () => {
    const repo = pullRequestRepo("skipped-changed-diff");
    const r = await gate(
      repo.dir,
      at(repo, repo.changed),
      skipNotice(repo.changed),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
    expect(r.reason).toContain(repo.changed);
    expect(r.reason).toContain("empty diff");
  });

  it("stops as REVIEW_SKIPPED when the two diffs cannot be compared here", async () => {
    const repo = pullRequestRepo("skipped-unreadable-base");
    // A base commit this clone does not hold: no merge base can be found.
    const r = await gate(
      repo.dir,
      at(repo, repo.merged, "de7e10ba5e222222222222222222222222222222"),
      skipNotice(repo.merged),
    );
    expectSpawnExit(r, 22);
    expect(r.state).toBe("REVIEW_SKIPPED");
    expect(r.reason).toContain("could not compare");
  });

  it("changes nothing when the notice names a head other than the current one", async () => {
    const repo = pullRequestRepo("skipped-other-head");
    const fixture = at(repo, repo.merged);
    const without = await gate(repo.dir, fixture, null);
    expectSpawnExit(without, 4);
    expect(without.state).toBe("STALE_REVIEW");
    const r = await gate(repo.dir, fixture, skipNotice(repo.base));
    expectSpawnExit(r, 4);
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.reason).toBe(without.reason);
  });

  it("reads the notice under the marker the repository configures", async () => {
    const repo = pullRequestRepo("skipped-custom-marker");
    const fixture = at(repo, repo.merged);
    const env = { DRIVE_PR_SKIP_NOTICE_MARKER: "example-skip" };
    const r = await gate(
      repo.dir,
      fixture,
      skipNotice(repo.merged, "example-skip"),
      env,
    );
    expectSpawnExit(r, 3);
    expect(r.state).toBe("CONVERGED");
    const other = await gate(repo.dir, fixture, skipNotice(repo.merged), env);
    expectSpawnExit(other, 4);
    expect(other.state).toBe("STALE_REVIEW");
  });
});
