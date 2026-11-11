/**
 * commit-prefix.ts — every commit of a branch starts with
 * `pull_requests.commit_prefix`, rendered for the key the branch name
 * carries: unpushed commits reworded, pushed ones reported. Run as a pass
 * runs it, in a clone of a local bare remote.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "commit-prefix.ts");

let dir: string;
let repo: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("GIT_") && !k.startsWith("DRIVE_PR_") && v !== undefined)
      out[k] = v;
  out.JIG_OVERLAY = join(dir, "overlay.yaml");
  out.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function overlay(prefix: string | null): void {
  writeFileSync(
    join(dir, "overlay.yaml"),
    `repository:\n  base_branch: main\nissue_tracker:\n  adapter: linear\n  team: ENG\n${prefix === null ? "" : `pull_requests:\n  commit_prefix: "${prefix}"\n`}`,
  );
}

function commit(file: string, message: string): void {
  writeFileSync(join(repo, file), `${file}\n`);
  git("add", file);
  git("commit", "-q", "-m", message);
}

function check(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env(),
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The subjects of the branch's commits above main, newest first. */
const subjects = () =>
  git("log", "--format=%s", "origin/main..HEAD").trim().split("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "commit-prefix-"));
  repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n  name = t\n  email = t@example.com\n[init]\n  defaultBranch = main\n",
  );
  spawnSync("git", ["init", "-q", "--bare", remote], { env: env() });
  spawnSync("git", ["clone", "-q", remote, repo], { env: env() });
  commit("base.txt", "the base, without a key");
  git("push", "-q", "origin", "main");
  git("switch", "-q", "-c", "eng-12-fix-the-export");
  overlay("{key}: ");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("commit-prefix.ts", () => {
  it("checks nothing when no prefix is configured", () => {
    overlay(null);
    commit("a.txt", "fix a");
    const r = check();
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("commit_prefix is not set");
    expect(subjects()).toEqual(["fix a"]);
  });

  it("rewords the unpushed commits that lack the prefix, keeping tree, author and working tree", () => {
    commit("a.txt", "fix a\n\nwith a body");
    commit("b.txt", "ENG-12: fix b");
    git(
      "commit",
      "-q",
      "--allow-empty",
      "--author",
      "Other <o@example.com>",
      "-m",
      "fix c",
    );
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
    const tree = git("rev-parse", "HEAD^{tree}");
    const r = check("--json");
    expectSpawnExit(r, 0);
    const report = JSON.parse(r.stdout);
    expect(report.prefix).toBe("ENG-12: ");
    expect(report.reworded.map((w: { subject: string }) => w.subject)).toEqual([
      "ENG-12: fix a",
      "ENG-12: fix c",
    ]);
    expect(subjects()).toEqual([
      "ENG-12: fix c",
      "ENG-12: fix b",
      "ENG-12: fix a",
    ]);
    expect(git("log", "-1", "--format=%B", "HEAD~2").trim()).toBe(
      "ENG-12: fix a\n\nwith a body",
    );
    expect(git("log", "-1", "--format=%an <%ae>").trim()).toBe(
      "Other <o@example.com>",
    );
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git("symbolic-ref", "--short", "HEAD").trim()).toBe(
      "eng-12-fix-the-export",
    );
    expect(readFileSync(join(repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    // A second run finds nothing to do.
    expectSpawnExit(check(), 0);
  });

  it("reports a pushed commit without the prefix and still rewords the unpushed ones", () => {
    commit("a.txt", "fix a");
    git("push", "-q", "origin", "eng-12-fix-the-export");
    commit("b.txt", "fix b");
    const r = check();
    expectSpawnExit(r, 4);
    expect(r.stdout).toContain("pushed:");
    expect(r.stdout).toContain("fix a (lacks the prefix and is already pushed");
    expect(subjects()).toEqual(["ENG-12: fix b", "fix a"]);
  });

  it("only reports under --check", () => {
    commit("a.txt", "fix a");
    const head = git("rev-parse", "HEAD");
    const r = check("--check");
    expectSpawnExit(r, 5);
    expect(r.stdout).toContain("unpushed:");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("leaves out the base and a stacked predecessor, and rewords a merge commit", () => {
    git("switch", "-q", "-c", "eng-11-predecessor", "main");
    commit("p.txt", "the predecessor, without this key");
    git("push", "-q", "origin", "eng-11-predecessor");
    git("switch", "-q", "eng-12-fix-the-export");
    git("reset", "-q", "--hard", "origin/eng-11-predecessor");
    commit("a.txt", "ENG-12: fix a");
    git("switch", "-q", "main");
    commit("m.txt", "more on main");
    git("push", "-q", "origin", "main");
    git("switch", "-q", "eng-12-fix-the-export");
    git("merge", "-q", "--no-edit", "origin/main");
    const r = check("--json");
    expectSpawnExit(r, 0);
    const report = JSON.parse(r.stdout);
    expect(report.reworded).toHaveLength(1);
    expect(report.reworded[0].subject).toBe(
      "ENG-12: Merge remote-tracking branch 'origin/main' into eng-12-fix-the-export",
    );
    expect(
      git("rev-list", "--parents", "-1", "HEAD").trim().split(" "),
    ).toHaveLength(3);
    expect(git("log", "-1", "--format=%s", "HEAD^2").trim()).toBe(
      "more on main",
    );
  });

  it("reads the key from --branch on a detached HEAD, and moves the detached HEAD", () => {
    commit("a.txt", "fix a");
    git("switch", "-q", "--detach");
    expectSpawnExit(check(), 2);
    const r = check("--branch", "eng-12-fix-the-export");
    expectSpawnExit(r, 0);
    expect(git("log", "-1", "--format=%s").trim()).toBe("ENG-12: fix a");
    // The branch itself is left where it was: the tree's HEAD is what pushes.
    expect(
      git("log", "-1", "--format=%s", "eng-12-fix-the-export").trim(),
    ).toBe("fix a");
  });

  it("refuses to rewrite from a head other than --expect-head, changing nothing", () => {
    commit("a.txt", "fix a");
    const asked = git("rev-parse", "HEAD").trim();
    commit("b.txt", "fix b");
    const r = check("--expect-head", asked);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("nothing was rewritten");
    expect(subjects()).toEqual(["fix b", "fix a"]);
  });

  it("rewrites when HEAD is the --expect-head", () => {
    commit("a.txt", "fix a");
    const r = check("--expect-head", git("rev-parse", "HEAD").trim());
    expectSpawnExit(r, 0);
    expect(subjects()).toEqual(["ENG-12: fix a"]);
  });

  it("cannot check a branch that carries no key", () => {
    git("switch", "-q", "-c", "spike");
    commit("a.txt", "fix a");
    const r = check();
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("carries no issue key");
  });

  it("cannot check while a merge is in progress", () => {
    commit("a.txt", "fix a");
    git("switch", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "conflicting\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a on main");
    git("switch", "-q", "eng-12-fix-the-export");
    spawnSync("git", ["merge", "main"], { cwd: repo, env: env() });
    const r = check();
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("MERGE_HEAD");
  });
});
