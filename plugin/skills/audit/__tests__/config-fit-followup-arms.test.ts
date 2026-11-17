import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The ids of the findings of `severity` that config-fit reports for a repository holding `files`. */
function findingIds(files: Record<string, string>, severity: string): string[] {
  const dir = scratchRepo({ "package.json": "{}", ...files });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as {
    findings: { id: string; severity: string }[];
  };
  return report.findings
    .filter((f) => f.severity === severity)
    .map((f) => f.id);
}

describe("followup.arms derivations", () => {
  test("a missing instructions file and a broken check command are findings", () => {
    const errors = findingIds(
      {
        ".config/jig.yaml": `followup:
  arms:
    - id: docs-site
      instructions: .config/followup/missing.md
    - id: ledger
      check_command: "<your check command>"
`,
      },
      "error",
    );
    expect(errors).toContain("derivation:followup.arms[0].instructions");
    expect(errors).toContain("derivation:followup.arms[1].check_command");
  });

  test("instructions are read as repository-relative paths, as the follow-up reads them", () => {
    const errors = findingIds(
      {
        ".config/jig.yaml": `followup:
  arms:
    - id: docs-site
      instructions: .config/followup/docs-site.md
    - id: windows
      instructions: '.config\\followup\\docs-site.md'
    - id: tilde
      instructions: '~missing.md'
`,
        ".config/followup/docs-site.md": "Rebuild the site.\n",
      },
      "error",
    );
    expect(errors).not.toContain("derivation:followup.arms[0].instructions");
    expect(errors).not.toContain("derivation:followup.arms[1].instructions");
    expect(errors).toContain("derivation:followup.arms[2].instructions");
  });

  test("an instructions file the repository does not track is a finding", () => {
    const errors = findingIds(
      {
        ".gitignore": "local.md\n",
        ".config/jig.yaml": `followup:
  arms:
    - id: docs-site
      instructions: local.md
`,
        "local.md": "Rebuild the site.\n",
      },
      "error",
    );
    expect(errors).toContain("derivation:followup.arms[0].instructions");
  });
});
