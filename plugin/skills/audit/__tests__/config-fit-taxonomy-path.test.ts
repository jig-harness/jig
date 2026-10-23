import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a configured taxonomy is named with forward slashes", () => {
  const configured = byPlatform("only Windows separates with \\", {
    windows: "docs\\label-taxonomy.yaml",
    posix: "./docs//label-taxonomy.yaml",
  });
  const dir = scratchRepo({
    ".config/jig.yaml": `issue_tracker:\n  taxonomy: '${configured}'\n  labels:\n    bug: [bug, defect]\n`,
    "docs/label-taxonomy.yaml":
      "version: 1\ntypes:\n  - id: feature\n  - id: bug\nstatuses:\n  - id: todo\n",
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as {
    findings: { id: string; message: string }[];
  };
  expect(
    report.findings.find((f) => f.id === "taxonomy:issue_tracker.labels.bug")
      ?.message,
  ).toContain("defect, which docs/label-taxonomy.yaml");
});
