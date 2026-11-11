/**
 * The audit checks a declared title pattern against the recent merged
 * titles, and each base `pull_requests.base_rules` names against the
 * repository's branches, through a fake forge.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { titlePatternFindings } from "../scripts/lib/pr-policy-fit.ts";
import {
  cleanEnv,
  fakeGh,
  runScript,
  scratchRepo,
  withPath,
} from "./helpers.ts";

interface Report {
  findings: Array<{ id: string; severity: string; message: string }>;
}

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

const merged = (titles: string[]) =>
  JSON.stringify(
    titles.map((title, i) => ({
      number: i + 1,
      title,
      headRefName: `eng-${i + 1}-x`,
      baseRefName: "main",
    })),
  );

/** config-fit against a fake forge whose merged pull requests carry `titles`. */
function audit(config: string, answers: Record<string, string>): Report {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  repos.push(dir);
  const bin = fakeGh(dir, {
    "repo view": JSON.stringify({
      nameWithOwner: "example/web",
      defaultBranchRef: { name: "main" },
      deleteBranchOnMerge: true,
    }),
    "--state open": "[]",
    ...answers,
  });
  const run = runScript(
    "config-fit.ts",
    ["--json"],
    dir,
    cleanEnv({ PATH: withPath(bin) }),
  );
  if (run.code === 2) throw new Error(run.err);
  return JSON.parse(run.out) as Report;
}

const PATTERN = `repository:
  base_branch: main
pull_requests:
  title_format: pattern
  title_pattern: "{key}: {summary}"
`;

describe("titlePatternFindings", () => {
  test("says nothing when every title follows the pattern", () => {
    expect(
      titlePatternFindings("{key}: {summary}", ["ENG-1: a", "#4: b"]),
    ).toEqual([]);
  });

  test("warns when most titles do not follow it, and informs when few do not", () => {
    const off = titlePatternFindings("{key}: {summary}", [
      "ENG-1: a",
      "fix: b",
      "c",
    ]);
    expect(off).toHaveLength(1);
    expect(off[0]?.severity).toBe("warning");
    expect(off[0]?.message).toContain(
      '2 of the last 3 merged pull requests\' titles do not follow pull_requests.title_pattern ({key}: {summary}), such as "fix: b", "c"',
    );
    const few = titlePatternFindings("{key}: {summary}", [
      ...Array.from({ length: 9 }, (_, i) => `ENG-${i + 1}: a`),
      "chore: b",
    ]);
    expect(few[0]?.severity).toBe("info");
  });
});

describe("config-fit: pull-request conventions", () => {
  test("checks the title pattern against the merged titles", () => {
    const report = audit(PATTERN, {
      "--state merged": merged(["fix: a", "ENG-2: b", "chore: c"]),
    });
    const finding = report.findings.find(
      (f) => f.id === "contradiction:pull_requests.title_pattern",
    );
    expect(finding?.severity).toBe("warning");
  });

  test("says nothing of the titles without a pattern", () => {
    const report = audit("repository:\n  base_branch: main\n", {
      "--state merged": merged(["fix: a"]),
    });
    expect(report.findings.map((f) => f.id)).not.toContain(
      "contradiction:pull_requests.title_pattern",
    );
  });

  test("warns of a base a rule names that the repository does not have", () => {
    const report = audit(
      `repository:
  base_branch: main
pull_requests:
  base_rules:
    - when: { labels: ["fixversion:2.4"] }
      base: release/2.4
    - when: { labels: ["fixversion:2.3"] }
      base: release/2.3
`,
      {
        "--state merged": merged([]),
        "branches/release%2F2.4": JSON.stringify({ name: "release/2.4" }),
        "branches/release%2F2.3": "!gh: Branch not found (HTTP 404)",
      },
    );
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain("derivation:pull_requests.base_rules:release/2.3");
    expect(ids).not.toContain(
      "derivation:pull_requests.base_rules:release/2.4",
    );
  });
});
