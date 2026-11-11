/**
 * The audit checks each base `pull_requests.base_rules` names against the
 * repository's branches, through a fake forge.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
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

/** config-fit against a fake forge. */
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

describe("config-fit: pull-request conventions", () => {
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
