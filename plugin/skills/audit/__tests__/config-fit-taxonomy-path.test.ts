import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";
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

const linkTest = test.skipIf(
  skipsOnWindows("file-system", "Windows collapses .. before following a link"),
);

for (const form of ["absolute", "relative"] as const)
  linkTest(`a configured ${form} taxonomy path is read as configured`, () => {
    const dir = scratchRepo({
      "real/sub/.keep": "",
      "real/label-taxonomy.yaml":
        "version: 1\ntypes:\n  - id: feature\n  - id: bug\nstatuses:\n  - id: todo\n",
    });
    dirs.push(dir);
    // The configured path climbs out of a link to real/sub, so the file is
    // real/label-taxonomy.yaml; collapsing the .. by text names a file that
    // does not exist.
    symlinkSync(join(dir, "real", "sub"), join(dir, "link"));
    const configured =
      form === "absolute"
        ? `${join(dir, "link")}/../label-taxonomy.yaml`
        : "link/../label-taxonomy.yaml";
    mkdirSync(join(dir, ".config"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "jig.yaml"),
      `issue_tracker:\n  taxonomy: '${configured}'\n  labels:\n    bug: [bug, defect]\n`,
    );
    const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
    const report = JSON.parse(run.out) as { findings: { id: string }[] };
    const ids = report.findings.map((f) => f.id);
    expect(ids).not.toContain("unchecked:label-taxonomy");
    expect(ids).not.toContain("derivation:issue_tracker.taxonomy");
    expect(ids).toContain("taxonomy:issue_tracker.labels.bug");
  });
