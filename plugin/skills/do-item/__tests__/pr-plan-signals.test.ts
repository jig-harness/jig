/**
 * pr-plan.ts open — the labels and reviewers a pull request opens with for
 * the issue's labels (`pull_requests.labels_from_issue`,
 * `pull_requests.reviewers_from_issue`) and the touched change areas
 * (`pr`), run as the agent runs it: in a git repository, with the consumer
 * configuration and a fake `gh` that answers the repository's settings and
 * its labels.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  firstOfEach,
  issueSignals,
  missingLabels,
} from "../scripts/pr-plan.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "pr-plan.ts");

let dir: string;
let repo: string;
let bin: string;

/** A fake `gh`: the repository's settings, and its labels (`null`: unreadable). */
function fakeGh(labels: string[] | null): void {
  writeFileSync(
    join(dir, "labels.json"),
    JSON.stringify((labels ?? []).map((name) => ({ name }))),
  );
  writeFakeProgram(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `case "$1 $2" in`,
      `  "api repos/{owner}/{repo}") echo '{"allow_squash_merge":true,"delete_branch_on_merge":true}' ;;`,
      `  "label list") ${labels === null ? "exit 1" : `cat "${join(dir, "labels.json")}"`} ;;`,
      `  *) echo "unexpected gh $*" >&2; exit 3 ;;`,
      "esac",
      "",
    ].join("\n"),
  );
}

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("GIT_") && v !== undefined) out[k] = v;
  out.JIG_OVERLAY = join(dir, "overlay.yaml");
  out.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  out.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GH_CALL_TIMEOUT = "10";
  return out;
}

function git(...args: string[]): void {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function overlay(text: string): void {
  writeFileSync(
    join(dir, "overlay.yaml"),
    `repository:\n  base_branch: main\nissue_tracker:\n  adapter: linear\n${text}`,
  );
}

function commit(file: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), "x\n");
  git("add", file);
  git("commit", "-q", "-m", `feat: add ${file}`);
}

function issueJson(labels: string[], identifier = "ENG-1"): string {
  const file = join(dir, "issue.json");
  writeFileSync(file, JSON.stringify({ identifier, title: "t", labels }));
  return file;
}

function plan(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "open", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env(),
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The values each flag takes in `createArgs`. */
const valuesOf = (args: string[], flag: string) =>
  args.filter((_, i) => args[i - 1] === flag);

const POLICY = `pull_requests:
  labels_from_issue: { "kind:db-migration": needs-dba-review }
  reviewers_from_issue: { "kind:db-migration": ["@acme/dba", alice] }
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-plan-signals-"));
  repo = join(dir, "repo");
  bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n  name = t\n  email = t@example.com\n[init]\n  defaultBranch = main\n",
  );
  git("init", "-q");
  commit("base.txt");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-q", "-c", "eng-1-work");
  overlay("");
  fakeGh(["needs-dba-review", "needs-api-review"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("issueSignals", () => {
  const policy = {
    labelsFromIssue: new Map([["kind:db-migration", "needs-dba-review"]]),
    reviewersFromIssue: new Map([["kind:db-migration", ["acme/dba"]]]),
  };

  it("maps nothing when no issue label is mapped", () => {
    expect(issueSignals(policy, ["bug", "kind:ui"])).toEqual({
      labels: [],
      reviewers: [],
    });
  });

  it("matches an issue label in any case", () => {
    expect(issueSignals(policy, ["Kind:DB-Migration"])).toEqual({
      labels: [
        { value: "needs-dba-review", from: "issue label Kind:DB-Migration" },
      ],
      reviewers: [{ value: "acme/dba", from: "issue label Kind:DB-Migration" }],
    });
  });

  it("keeps the first of each label in any case, and names the missing ones", () => {
    const signals = firstOfEach([
      { value: "Needs-Review", from: "a" },
      { value: "needs-review", from: "b" },
      { value: "other", from: "c" },
    ]);
    expect(signals.map((s) => s.from)).toEqual(["a", "c"]);
    expect(missingLabels(signals, new Set(["needs-review"]))).toEqual([
      { value: "other", from: "c" },
    ]);
  });
});

describe("pr-plan.ts open: labels and reviewers from the issue", () => {
  it("adds nothing when the issue carries no mapped label", () => {
    overlay(POLICY);
    commit("a.txt");
    const r = plan(
      "--issue",
      "ENG-1",
      "--issue-json",
      issueJson(["bug"]),
      "--json",
    );
    expectSpawnExit(r, 0);
    const p = JSON.parse(r.stdout);
    expect(p.createArgs).toEqual(["--base", "main", "--draft"]);
    expect(p.signals).toEqual({ labels: [], reviewers: [] });
  });

  it("adds the mapped label and requests the mapped reviewers", () => {
    overlay(POLICY);
    commit("a.txt");
    const r = plan(
      "--issue",
      "ENG-1",
      "--issue-json",
      issueJson(["KIND:DB-MIGRATION"]),
      "--json",
    );
    expectSpawnExit(r, 0);
    const p = JSON.parse(r.stdout);
    expect(valuesOf(p.createArgs, "--label")).toEqual(["needs-dba-review"]);
    expect(valuesOf(p.createArgs, "--reviewer")).toEqual(["acme/dba", "alice"]);
    expect(p.warnings.join("\n")).toContain(
      "not notified until it is marked Ready (pull_requests.mark_ready: 1)",
    );
  });

  it("shows the labels and reviewers with where each came from", () => {
    overlay(POLICY);
    commit("a.txt");
    const r = plan(
      "--issue",
      "ENG-1",
      "--issue-json",
      issueJson(["kind:db-migration"]),
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      "label:       needs-dba-review (issue label kind:db-migration)",
    );
    expect(r.stdout).toContain(
      "reviewer:    acme/dba (issue label kind:db-migration)",
    );
  });

  it("adds a touched area's pr labels and reviewers", () => {
    writeFileSync(
      join(repo, "areas.yaml"),
      `areas:
  api:
    paths: ['api/**']
    pr: { labels: [needs-api-review], reviewers: ['@acme/api'] }
  web:
    paths: ['web/**']
    pr: { reviewers: [carol] }
`,
    );
    overlay("drive:\n  change_areas_catalog: areas.yaml\n");
    commit("api/route.ts");
    const r = plan("--json");
    expectSpawnExit(r, 0);
    const p = JSON.parse(r.stdout);
    expect(valuesOf(p.createArgs, "--label")).toEqual(["needs-api-review"]);
    expect(valuesOf(p.createArgs, "--reviewer")).toEqual(["acme/api"]);
    expect(p.signals.reviewers).toEqual([
      { value: "acme/api", from: "area api" },
    ]);
  });

  it("refuses a mapped label the repository does not have", () => {
    overlay(POLICY);
    fakeGh(["something-else"]);
    commit("a.txt");
    const r = plan(
      "--issue",
      "ENG-1",
      "--issue-json",
      issueJson(["kind:db-migration"]),
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "needs-dba-review (from issue label kind:db-migration) does not exist in the repository",
    );
  });

  it("warns, rather than refuses, when the repository's labels cannot be read", () => {
    overlay(POLICY);
    fakeGh(null);
    commit("a.txt");
    const r = plan(
      "--issue",
      "ENG-1",
      "--issue-json",
      issueJson(["kind:db-migration"]),
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("whether needs-dba-review exist is unchecked");
  });

  it("warns when the mappings are set and the issue's labels were not given", () => {
    overlay(POLICY);
    commit("a.txt");
    const r = plan("--issue", "ENG-1");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("pass --issue-json");
  });

  it("refuses the JSON of another issue", () => {
    overlay(POLICY);
    commit("a.txt");
    const r = plan("--issue", "ENG-1", "--issue-json", issueJson([], "ENG-2"));
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("is ENG-2, not ENG-1");
  });

  it("refuses JSON that names no identifier when --issue is given", () => {
    overlay(POLICY);
    commit("a.txt");
    const file = join(dir, "bare.json");
    writeFileSync(file, JSON.stringify({ labels: ["kind:db-migration"] }));
    const r = plan("--issue", "ENG-1", "--issue-json", file);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("`identifier` must be the issue's key (ENG-1)");
  });
});
