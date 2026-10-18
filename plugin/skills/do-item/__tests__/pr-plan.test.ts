/**
 * pr-plan.ts — the pull-request policy applied to one pull request, run as
 * the agent runs it: in a git repository, with the consumer configuration
 * and a fake `gh` that answers the repository settings, the open
 * pull-request listing and the gh-stack probe.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  countChangedLines,
  measureChange,
  shellQuote,
} from "../scripts/pr-plan.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "pr-plan.ts");

let dir: string;
let repo: string;
let bin: string;
let overlayFile: string;

interface FakeGh {
  repoSettings?: Record<string, unknown> | null;
  pulls?: Array<{
    number: number;
    url: string;
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
  }>;
  ghStack?: boolean;
  /** GitHub's Stacks API listing, one page; `null` answers it with an error. */
  stacks?: Array<{
    number: number;
    base: { ref: string };
    pull_requests: Array<{
      number: number;
      state: "open" | "closed";
      merged_at: string | null;
    }>;
  }> | null;
  /**
   * Pull requests that answer the eligibility query as ineligible; every
   * other open pull request answers eligible. `null` fails the query.
   */
  ineligible?: Record<number, "auto-merge" | "queued"> | null;
}

/** Native stack members as GitHub's Stacks API lists them. */
const openMember = (number: number) => ({
  number,
  state: "open" as const,
  merged_at: null,
});
const mergedMember = (number: number) => ({
  number,
  state: "closed" as const,
  merged_at: "2026-10-01T00:00:00Z",
});

function fakeGh(f: FakeGh): void {
  const settings =
    f.repoSettings === undefined
      ? { allow_squash_merge: true, delete_branch_on_merge: true }
      : f.repoSettings;
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(dir, "pulls.json"), JSON.stringify(f.pulls ?? []));
  writeFileSync(join(dir, "stacks.json"), JSON.stringify([f.stacks ?? []]));
  const repository: Record<string, unknown> = {};
  for (const p of f.pulls ?? []) {
    const why = f.ineligible?.[p.number];
    repository[`p${p.number}`] = {
      autoMergeRequest:
        why === "auto-merge" ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
      mergeQueueEntry: why === "queued" ? { id: "MQE_1" } : null,
    };
  }
  writeFileSync(
    join(dir, "eligibility.json"),
    JSON.stringify({ data: { repository } }),
  );
  const script = [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "api repos/{owner}/{repo}") ${settings === null ? "exit 1" : `cat "${join(dir, "settings.json")}"`} ;;`,
    `  "pr list") cat "${join(dir, "pulls.json")}" ;;`,
    `  "api --paginate") ${f.stacks === null ? "exit 1" : `cat "${join(dir, "stacks.json")}"`} ;;`,
    `  "api graphql") ${f.ineligible === null ? "exit 1" : `cat "${join(dir, "eligibility.json")}"`} ;;`,
    `  "stack --version") ${f.ghStack ? 'echo "gh stack v0.1.0"' : "exit 1"} ;;`,
    `  *) echo "unexpected gh $*" >&2; exit 3 ;;`,
    "esac",
  ].join("\n");
  writeFakeProgram(join(bin, "gh"), `${script}\n`);
}

function overlay(text: string): void {
  writeFileSync(overlayFile, `repository:\n  base_branch: main\n${text}`);
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  env.JIG_OVERLAY = overlayFile;
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GH_CALL_TIMEOUT = "10";
  return env;
}

function plan(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function commitLines(file: string, n: number): void {
  writeFileSync(
    join(repo, file),
    `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`,
  );
  git("add", file);
  git("commit", "-q", "-m", `feat: add ${file}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-plan-"));
  repo = join(dir, "repo");
  bin = join(dir, "bin");
  overlayFile = join(dir, "overlay.yaml");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(
    join(dir, "gitconfig"),
    "[user]\n  name = t\n  email = t@example.com\n[init]\n  defaultBranch = main\n",
  );
  git("init", "-q");
  commitLines("base.txt", 1);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("switch", "-q", "-c", "eng-1-work");
  overlay("");
  fakeGh({});
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("countChangedLines", () => {
  it("adds added and deleted lines, ignoring binary files", () => {
    expect(countChangedLines("3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.ts\n")).toBe(
      14,
    );
    expect(countChangedLines("")).toBe(0);
  });

  it("leaves the audit record out of the total and names it", () => {
    expect(
      measureChange("3\t1\ta.ts\n900\t880\t.config/jig-audit.yaml\n"),
    ).toEqual({
      changedLines: 4,
      uncounted: [
        {
          path: ".config/jig-audit.yaml",
          lines: 1780,
          why: "the audit record, rewritten by every audit",
        },
      ],
    });
    // Only that path: a file of the same name elsewhere counts.
    expect(countChangedLines("5\t0\tdocs/jig-audit.yaml\n")).toBe(5);
  });
});

describe("shellQuote", () => {
  it("leaves plain words and the PR placeholder bare and quotes the rest", () => {
    expect(shellQuote("--label")).toBe("--label");
    expect(shellQuote("feature/a-b")).toBe("feature/a-b");
    expect(shellQuote("<PR URL>")).toBe("<PR URL>");
    expect(shellQuote("help wanted")).toBe("'help wanted'");
    expect(shellQuote("$(touch x); y")).toBe("'$(touch x); y'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("pr-plan.ts branch", () => {
  it("renders the default pattern", () => {
    const r = plan("branch", "--issue", "ENG-7", "--title", "Add the export");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("eng-7-add-the-export");
  });

  it("renders a declared pattern, as JSON on request", () => {
    overlay("pull_requests:\n  branch_name: feature/{key}-{slug}\n");
    const r = plan(
      "branch",
      "--issue",
      "ENG-7",
      "--title",
      "Add the export",
      "--json",
    );
    expect(JSON.parse(r.stdout)).toEqual({
      branch: "feature/ENG-7-add-the-export",
    });
  });

  it("refuses a rendered name git would reject", () => {
    overlay("pull_requests:\n  branch_name: '{key}..{slug}'\n");
    const r = plan("branch", "--issue", "ENG-7", "--title", "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a valid branch name");
  });

  it("needs --issue and --title", () => {
    expect(plan("branch", "--issue", "ENG-7").code).toBe(2);
    expect(plan("branch", "--issue", "not a key", "--title", "x").code).toBe(2);
  });
});

describe("pr-plan.ts open", () => {
  it("plans a draft against the trunk by default", () => {
    commitLines("a.txt", 5);
    const r = plan("open", "--issue", "ENG-1", "--json");
    expect(r.code).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.base).toBe("main");
    expect(p.createArgs).toEqual(["--base", "main", "--draft"]);
    expect(p.stack).toEqual({
      mode: "none",
      on: null,
      depth: 1,
      maxDepth: null,
    });
    expect(p.body.issueLink).toBe("Closes ENG-1");
    expect(p.size.changedLines).toBe(5);
    expect(p.afterCreate).toEqual([]);
  });

  it("opens Ready and adds labels when the policy says so", () => {
    overlay(
      "drive:\n  reviews_drafts: false\npull_requests:\n  labels: [agent-authored]\n  issue_link: none\n",
    );
    commitLines("a.txt", 1);
    const p = JSON.parse(plan("open", "--issue", "ENG-1", "--json").stdout);
    expect(p.createArgs).toEqual([
      "--base",
      "main",
      "--label",
      "agent-authored",
    ]);
    expect(p.openAs.source).toBe("derived: drive.reviews_drafts is false");
    expect(p.body.issueLink).toBeNull();
  });

  it("prints a label with spaces as one shell word", () => {
    overlay("pull_requests:\n  labels: [help wanted]\n");
    commitLines("a.txt", 1);
    const r = plan("open");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--label 'help wanted'");
  });

  it("refuses to stack when stacking is none", () => {
    commitLines("a.txt", 1);
    const r = plan("open", "--stack-on", "eng-0-below");
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("pull_requests.stacking is none");
  });

  describe("branch stacking", () => {
    const below = [
      {
        number: 23,
        url: "https://github.com/o/r/pull/23",
        headRefName: "eng-0-a",
        baseRefName: "main",
        isCrossRepository: false,
      },
      {
        number: 24,
        url: "https://github.com/o/r/pull/24",
        headRefName: "eng-0-b",
        baseRefName: "eng-0-a",
        isCrossRepository: false,
      },
    ];

    beforeEach(() => {
      git("update-ref", "refs/remotes/origin/eng-0-b", "HEAD");
      commitLines("a.txt", 2);
    });

    it("bases the pull request on its predecessor and counts the layer", () => {
      overlay("pull_requests:\n  stacking: branch\n");
      fakeGh({ pulls: below });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.base).toBe("eng-0-b");
      expect(p.trunk).toBe("main");
      expect(p.stack.on).toEqual({ branch: "eng-0-b", pr: 24 });
      expect(p.stack.depth).toBe(3);
      expect(p.size.changedLines).toBe(2);
      expect(p.warnings).toEqual([]);
    });

    it("warns when merged head branches are kept", () => {
      overlay("pull_requests:\n  stacking: branch\n");
      fakeGh({
        pulls: below,
        repoSettings: {
          allow_squash_merge: true,
          delete_branch_on_merge: false,
        },
      });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.warnings.join("\n")).toContain("will not retarget");
    });

    it("refuses a stack deeper than max_stack_depth", () => {
      overlay("pull_requests:\n  stacking: branch\n  max_stack_depth: 2\n");
      fakeGh({ pulls: below });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("layer 3");
    });

    it("refuses a base that does not lead to the trunk", () => {
      overlay("pull_requests:\n  stacking: branch\n");
      fakeGh({ pulls: [below[1] as (typeof below)[number]] });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("does not lead to main");
    });

    it("links an unstacked chain as a new native stack after creating the pull request", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({ pulls: below, ghStack: true });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.afterCreate).toEqual([
        [
          "gh",
          "stack",
          "link",
          "--base",
          "main",
          "https://github.com/o/r/pull/23",
          "https://github.com/o/r/pull/24",
          "<PR URL>",
        ],
      ]);
    });

    it("never gives gh stack link a bare pull-request number, which a local branch of that name would shadow", () => {
      overlay("pull_requests:\n  stacking: native\n");
      git("branch", "23");
      git("branch", "24");
      fakeGh({ pulls: below, ghStack: true });
      const r = plan("open", "--stack-on", "eng-0-b", "--json");
      expect(r.code).toBe(0);
      const link = JSON.parse(r.stdout).afterCreate[0] as string[];
      expect(link).not.toContain("23");
      expect(link).not.toContain("24");
      expect(link.at(-1)).toBe("<PR URL>");
    });

    it("appends to the predecessor's native stack by number, merged members included", () => {
      overlay("pull_requests:\n  stacking: native\n");
      // #22 merged, so the open chain is only #23 and #24.
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [mergedMember(22), openMember(23), openMember(24)],
          },
        ],
      });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.afterCreate).toEqual([["gh", "stack", "link", "7", "<PR URL>"]]);
      expect(p.stack.depth).toBe(4);
    });

    it("refuses a native append past max_stack_depth once merged members count", () => {
      overlay("pull_requests:\n  stacking: native\n  max_stack_depth: 3\n");
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [mergedMember(22), openMember(23), openMember(24)],
          },
        ],
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("would be layer 4 of a stack");
      expect(r.stderr).toContain("keeps its merged members");
      expect(r.stderr).not.toContain("Wait until the bottom");
    });

    it("refuses a new native stack over a layer gh-stack will not link", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({
        pulls: below,
        ghStack: true,
        ineligible: { 23: "auto-merge", 24: "queued" },
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("#23 (it has auto-merge enabled)");
      expect(r.stderr).toContain("#24 (it is queued for merge)");
    });

    it("fails when the layers' eligibility cannot be read", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({ pulls: below, ghStack: true, ineligible: null });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("can be added to a native stack");
    });

    it("does not check the eligibility of layers already in the stack", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({
        pulls: below,
        ghStack: true,
        ineligible: { 23: "auto-merge" },
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [openMember(23), openMember(24)],
          },
        ],
      });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.afterCreate).toEqual([["gh", "stack", "link", "7", "<PR URL>"]]);
    });

    it("refuses to append when a local branch is named like the stack", () => {
      overlay("pull_requests:\n  stacking: native\n");
      git("branch", "7");
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [openMember(23), openMember(24)],
          },
        ],
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("a local branch is named 7");
    });

    it("fails when it cannot read whether a local branch is named like the stack", () => {
      overlay("pull_requests:\n  stacking: native\n");
      const realGit = spawnSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).stdout.trim();
      writeFakeProgram(
        join(bin, "git"),
        `#!/bin/sh\nfor a in "$@"; do [ "$a" = show-ref ] && exit 124; done\nexec "${realGit}" "$@"\n`,
      );
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [openMember(23), openMember(24)],
          },
        ],
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "could not read whether a local branch is named 7",
      );
    });

    it("refuses to stack on a native stack member that is not its top", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [openMember(23), openMember(24), openMember(25)],
          },
        ],
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("not the top of native stack #7");
    });

    it("refuses when a lower layer is in a native stack the predecessor is not", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({
        pulls: below,
        ghStack: true,
        stacks: [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [openMember(23)],
          },
        ],
      });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("#24 is in no native stack");
    });

    it("fails when the native stacks cannot be read", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({ pulls: below, ghStack: true, stacks: null });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "could not read the repository's native stacks",
      );
    });

    /** `n` open pull requests in all, `below` among them. */
    const census = (n: number) =>
      Array.from({ length: n - below.length }, (_, i) => ({
        number: 100 + i,
        url: `https://github.com/o/r/pull/${100 + i}`,
        headRefName: `other-${i}`,
        baseRefName: "main",
        isCrossRepository: false,
      })).concat(below);

    it("refuses to stack when the listing reaches the limit and may be truncated", () => {
      overlay("pull_requests:\n  stacking: branch\n");
      fakeGh({ pulls: census(1000) });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("could not list every open pull request");
    });

    it("stacks when the listing stops one short of the limit", () => {
      overlay("pull_requests:\n  stacking: branch\n");
      fakeGh({ pulls: census(999) });
      const p = JSON.parse(
        plan("open", "--stack-on", "eng-0-b", "--json").stdout,
      );
      expect(p.stack.on).toEqual({ branch: "eng-0-b", pr: 24 });
    });

    it("refuses a native stack without gh-stack", () => {
      overlay("pull_requests:\n  stacking: native\n");
      fakeGh({ pulls: below, ghStack: false });
      const r = plan("open", "--stack-on", "eng-0-b");
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("gh extension install github/gh-stack");
    });
  });

  it("refuses an oversize change unless the reason is stated", () => {
    overlay("pull_requests:\n  size_budget: 10\n");
    commitLines("a.txt", 11);
    const refused = plan("open");
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("over pull_requests.size_budget (10)");
    const accepted = plan(
      "open",
      "--accept-oversize",
      "one generated migration",
      "--json",
    );
    expect(accepted.code).toBe(0);
    for (const blank of ["", "  "]) {
      const r = plan("open", "--accept-oversize", blank);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--accept-oversize needs a reason");
    }
    expect(JSON.parse(accepted.stdout).size).toEqual({
      changedLines: 11,
      budget: 10,
      over: true,
      acceptedReason: "one generated migration",
      uncounted: [],
    });
  });

  it("fits a change within the budget when only the audit record is large, and says it left the record out", () => {
    overlay("pull_requests:\n  size_budget: 10\n");
    mkdirSync(join(repo, ".config"), { recursive: true });
    commitLines(".config/jig-audit.yaml", 500);
    commitLines("a.txt", 4);
    const r = spawnSync(process.execPath, [SCRIPT, "open"], {
      cwd: repo,
      encoding: "utf8",
      env: cleanEnv(),
    });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    expect(r.stdout).toContain(
      "size:        4 changed lines of 10, not counting .config/jig-audit.yaml (500 lines, the audit record, rewritten by every audit)",
    );
  });

  it("reads the title convention from a conventional commitlint configuration before history", () => {
    writeFileSync(
      join(repo, "commitlint.config.js"),
      'export default { extends: ["@commitlint/config-conventional"] }',
    );
    git("add", "commitlint.config.js");
    git("commit", "-q", "-m", "Add commitlint");
    const p = JSON.parse(plan("open", "--json").stdout);
    expect(p.title).toEqual({
      format: "conventional",
      source: "derived: commitlint.config.js",
    });
  });

  it("falls back to history when the commitlint configuration is not conventional", () => {
    writeFileSync(join(repo, "commitlint.config.js"), "export default {}");
    git("add", "commitlint.config.js");
    git("commit", "-q", "-m", "Add commitlint");
    const p = JSON.parse(plan("open", "--json").stdout);
    expect(p.title.source).not.toBe("derived: commitlint.config.js");
  });

  it("warns, and still plans, when the repository settings are unreadable", () => {
    fakeGh({ repoSettings: null });
    commitLines("a.txt", 1);
    const p = JSON.parse(plan("open", "--json").stdout);
    expect(p.warnings[0]).toContain("could not read the repository's settings");
  });

  it("fails on an invalid policy, naming the field and the file", () => {
    overlay("pull_requests:\n  stacking: yes\n");
    const r = plan("open");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pull_requests.stacking must be one of");
    expect(r.stderr).toContain(overlayFile);
  });

  it("prints a readable plan without --json", () => {
    commitLines("a.txt", 1);
    const r = plan("open", "--issue", "ENG-1");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("create:      gh pr create --base main --draft");
    expect(r.stdout).toContain("issue link:  Closes ENG-1");
  });
});
