/**
 * pr-plan.ts — the base an item's labels choose (`pull_requests.base_rules`)
 * and the title a pattern renders (`pull_requests.title_pattern`), run as
 * the agent runs it: in a clone of a local bare remote that holds the
 * integration branch and a release line, with a fake `gh` that answers the
 * repository's settings.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "pr-plan.ts");

let dir: string;
let repo: string;
let bin: string;

const RULES = `pull_requests:
  base_rules:
    - when: { labels: ["fixversion:2.4"] }
      base: release/2.4
    - when: { labels: ["fixversion:9.9"] }
      base: release/9.9
`;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("GIT_") && !k.startsWith("DRIVE_PR_") && v !== undefined)
      out[k] = v;
  out.JIG_OVERLAY = join(dir, "overlay.yaml");
  out.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  out.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GH_CALL_TIMEOUT = "10";
  return out;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function overlay(text: string): void {
  writeFileSync(
    join(dir, "overlay.yaml"),
    `repository:\n  base_branch: main\nissue_tracker:\n  adapter: linear\n  team: ENG\n${text}`,
  );
}

function issueJson(labels: string[], title = "Fix the export"): string {
  const file = join(dir, "issue.json");
  writeFileSync(file, JSON.stringify({ identifier: "ENG-12", title, labels }));
  return file;
}

function plan(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env(),
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), "x\n");
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `add ${file}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-plan-conventions-"));
  repo = join(dir, "repo");
  bin = join(dir, "bin");
  const remote = join(dir, "remote.git");
  mkdirSync(bin);
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n  name = t\n  email = t@example.com\n[init]\n  defaultBranch = main\n",
  );
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "clone", "-q", remote, repo);
  commit(repo, "base.txt");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "switch", "-q", "-c", "release/2.4");
  commit(repo, "release.txt");
  git(repo, "push", "-q", "origin", "release/2.4");
  writeFakeProgram(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `case "$1 $2" in`,
      `  "api repos/{owner}/{repo}") echo '{"delete_branch_on_merge":true}' ;;`,
      `  *) echo "unexpected gh $*" >&2; exit 3 ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  overlay(RULES);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pr-plan.ts branch: the base to cut from", () => {
  it("names the release line a rule chooses for the item's label", () => {
    const r = plan(
      "branch",
      "--issue",
      "ENG-12",
      "--title",
      "Fix the export",
      "--issue-json",
      issueJson(["bug", "FixVersion:2.4"]),
      "--json",
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({
      branch: "eng-12-fix-the-export",
      base: "release/2.4",
      baseSource:
        "pull_requests.base_rules[0], for the item's label FixVersion:2.4",
    });
  });

  it("falls back to the integration branch when no rule matches", () => {
    const r = plan(
      "branch",
      "--issue",
      "ENG-12",
      "--title",
      "Fix the export",
      "--issue-json",
      issueJson(["bug"]),
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toBe(
      "eng-12-fix-the-export\nbase: main (the integration branch)\n",
    );
  });

  it("needs the issue's labels when rules are declared", () => {
    const r = plan("branch", "--issue", "ENG-12", "--title", "x");
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("pass --issue-json");
  });

  it("refuses labels that are null or missing when rules are declared", () => {
    for (const body of [
      { identifier: "ENG-12", labels: null },
      { identifier: "ENG-12" },
    ]) {
      const file = join(dir, "nolabels.json");
      writeFileSync(file, JSON.stringify(body));
      const r = plan(
        "branch",
        "--issue",
        "ENG-12",
        "--title",
        "x",
        "--issue-json",
        file,
      );
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain("`labels` must be an array of strings");
    }
  });

  it("refuses an issue JSON naming another team's key when open has no --issue", () => {
    const file = join(dir, "ops.json");
    writeFileSync(
      file,
      JSON.stringify({ identifier: "OPS-12", title: "x", labels: [] }),
    );
    const r = plan("open", "--issue-json", file);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("is not a key of the configured tracker");
  });
});

describe("pr-plan.ts open: the base a rule chooses", () => {
  it("opens against the release line the branch was cut from, naming the rule", () => {
    git(
      repo,
      "switch",
      "-q",
      "-c",
      "eng-12-fix-the-export",
      "origin/release/2.4",
    );
    commit(repo, "fix.txt");
    const json = plan(
      "open",
      "--issue",
      "ENG-12",
      "--issue-json",
      issueJson(["fixversion:2.4"]),
      "--json",
    );
    expectSpawnExit(json, 0);
    const p = JSON.parse(json.stdout);
    expect(p.base).toBe("release/2.4");
    expect(p.trunk).toBe("release/2.4");
    expect(p.createArgs.slice(0, 2)).toEqual(["--base", "release/2.4"]);
    // Measured against the release line: only this branch's own file.
    expect(p.size.changedLines).toBe(1);
    const text = plan(
      "open",
      "--issue",
      "ENG-12",
      "--issue-json",
      issueJson(["fixversion:2.4"]),
    );
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      "base:        release/2.4 (pull_requests.base_rules[0], for the item's label fixversion:2.4)",
    );
  });

  it("refuses a base the remote does not have", () => {
    git(repo, "switch", "-q", "-c", "eng-12-fix-the-export", "origin/main");
    commit(repo, "fix.txt");
    const r = plan(
      "open",
      "--issue",
      "ENG-12",
      "--issue-json",
      issueJson(["fixversion:9.9"]),
    );
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain(
      "names the base release/9.9, which origin does not have",
    );
  });

  it("opens against the integration branch when no rule matches", () => {
    git(repo, "switch", "-q", "-c", "eng-12-fix-the-export", "origin/main");
    commit(repo, "fix.txt");
    const r = plan(
      "open",
      "--issue",
      "ENG-12",
      "--issue-json",
      issueJson([]),
      "--json",
    );
    expectSpawnExit(r, 0);
    const p = JSON.parse(r.stdout);
    expect(p.base).toBe("main");
    expect(p.baseSource).toBe("the integration branch");
  });
});

describe("pr-plan.ts open: a title pattern", () => {
  beforeEach(() => {
    overlay(
      "pull_requests:\n  title_format: pattern\n  title_pattern: '{key}: {summary}'\n",
    );
    git(repo, "switch", "-q", "-c", "eng-12-fix-the-export", "origin/main");
    commit(repo, "fix.txt");
  });

  it("renders the title from the issue's key and title", () => {
    const r = plan(
      "open",
      "--issue",
      "eng-12",
      "--issue-json",
      issueJson([], "Fix the export"),
      "--json",
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).title).toEqual({
      format: "pattern",
      source: "pull_requests.title_format",
      pattern: "ENG-12: <summary>",
      rendered: "ENG-12: Fix the export",
    });
    const text = plan(
      "open",
      "--issue",
      "ENG-12",
      "--issue-json",
      issueJson([], "Fix the export"),
    );
    expect(text.stdout).toContain(
      "title:       ENG-12: Fix the export (pull_requests.title_format)",
    );
  });

  it("leaves the summary to fill when the issue's title is unknown", () => {
    const r = plan("open", "--issue", "ENG-12");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      "title:       ENG-12: <summary> (pull_requests.title_format)",
    );
  });
});
