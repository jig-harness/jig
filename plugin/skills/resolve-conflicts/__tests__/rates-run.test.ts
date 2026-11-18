/**
 * The git reads of `--rates`: the integration branch of the consumer's own
 * remote, the first-parent walk bounded in git, and an object the clone does
 * not hold told from a git that failed.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, ReplayError } from "../scripts/lib/replay.ts";
import {
  ancestryOf,
  commitFiles,
  firstParents,
  integrationRef,
  unavailable,
} from "../scripts/lib/rates-run.ts";
import type { CohortPr } from "../scripts/lib/cohort.ts";

const dir = mkdtempSync(join(tmpdir(), "rates-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function git(args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(file: string, date: string): string {
  writeFileSync(join(dir, file), file);
  git(["add", file]);
  git(["commit", "-m", file], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(["rev-parse", "HEAD"]);
}

git(["init", "-b", "main"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "T"]);
const old = commit("old.txt", "2020-01-01T00:00:00Z");
const recent = commit("recent.txt", "2026-11-10T00:00:00Z");
const repo = new Git(dir);

describe("the integration branch", () => {
  it("is the tracking branch of the configured remote, else the local branch", () => {
    git(["update-ref", "refs/remotes/upstream/main", recent]);
    expect(integrationRef(repo, "upstream", "main")).toBe(
      "refs/remotes/upstream/main",
    );
    expect(integrationRef(repo, "origin", "main")).toBe("refs/heads/main");
    expect(integrationRef(repo, "origin", "absent")).toBeNull();
  });
});

describe("the first-parent walk", () => {
  it("keeps the commits whose own dates fall in the window", () => {
    const since = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const walked = firstParents(repo, "refs/heads/main", since, null);
    expect(walked.map((c) => c.commit)).toEqual([recent]);
    expect(
      firstParents(repo, "refs/heads/main", null, null).map((c) => c.commit),
    ).toEqual([recent, old]);
  });
});

describe("the first-parent walk over dates that run backwards", () => {
  it("reaches an in-window ancestor behind an older commit", () => {
    git(["checkout", "-q", "-b", "skew", recent]);
    commit("mid.txt", "2026-10-01T00:00:00Z");
    const tip = commit("tip.txt", "2026-11-18T00:00:00Z");
    git(["checkout", "-q", "main"]);
    const since = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const walked = firstParents(repo, "refs/heads/skew", since, null);
    expect(walked.map((c) => c.commit)).toEqual([tip, recent]);
  });
});

describe("an object the clone does not hold", () => {
  const missing = "1".repeat(40);
  const pr = (head: string, merge: string): CohortPr => ({
    number: 1,
    createdAt: "2026-11-01T00:00:00Z",
    mergedAt: "2026-11-02T00:00:00Z",
    mergeCommit: merge,
    headRefOid: head,
    baseRefName: "main",
    files: [],
    filesCut: false,
    commitCount: 1,
    commits: [],
    forcePushed: false,
  });

  it("reads as unavailable", () => {
    expect(ancestryOf(repo, pr(missing, missing))).toBeNull();
    expect(commitFiles(repo, missing)).toBeNull();
  });

  it("is told from a git that fails for another reason", () => {
    const broken = new Git(dir, { ...process.env, GIT_DIR: join(dir, "nope") });
    expect(() => commitFiles(broken, recent)).toThrow(ReplayError);
  });
});

describe("git's answer told unavailable or failed", () => {
  const args = ["cat-file", "x"];
  it("reads only missing-object lines as unavailable", () => {
    expect(
      unavailable(args, { code: 128, stderr: "fatal: bad object abc\n" }),
    ).toBe(true);
  });

  it("reports a corruption diagnostic that precedes a missing-object line", () => {
    expect(() =>
      unavailable(args, {
        code: 128,
        stderr:
          "error: inflate: data stream error (incorrect header check)\nfatal: bad object abc\n",
      }),
    ).toThrow(ReplayError);
  });
});
