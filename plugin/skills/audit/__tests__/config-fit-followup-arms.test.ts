import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a follow-up arm's instructions are read as repository-relative paths", () => {
  const dir = scratchRepo({
    ".config/jig.yaml": `followup:
  arms:
    - id: docs-site
      instructions: '.config\\followup\\docs-site.md'
    - id: tilde
      instructions: '~missing.md'
`,
    ".config/followup/docs-site.md": "Rebuild the site.\n",
    "package.json": "{}",
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as { findings: { id: string }[] };
  const ids = report.findings.map((f) => f.id);
  expect(ids).not.toContain("derivation:followup.arms[0].instructions");
  expect(ids).toContain("derivation:followup.arms[1].instructions");
});
