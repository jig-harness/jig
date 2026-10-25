import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";
import { taxonomyAt } from "../../file-issue/scripts/lib/config.ts";
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

// The configured path climbs out of a link to real/sub. Read as written it
// reaches real/label-taxonomy.yaml; joined to the root, as the file-issue
// skill joins a relative setting, its .. collapses to label-taxonomy.yaml at
// the root. The audit checks the file the skill reads.
for (const form of ["absolute", "relative"] as const)
  linkTest(
    `a configured ${form} taxonomy path is read as file-issue reads it`,
    () => {
      const dir = scratchRepo({
        "real/sub/.keep": "",
        "real/label-taxonomy.yaml":
          "version: 1\ntypes:\n  - id: feature\n  - id: bug\nstatuses:\n  - id: todo\n",
      });
      dirs.push(dir);
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
      const read = existsSync(taxonomyAt(dir, configured));
      expect(read).toBe(form === "absolute");
      const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
      const report = JSON.parse(run.out) as { findings: { id: string }[] };
      const ids = report.findings.map((f) => f.id);
      expect(ids).not.toContain("unchecked:label-taxonomy");
      expect(ids.includes("derivation:issue_tracker.taxonomy")).toBe(!read);
      expect(ids.includes("taxonomy:issue_tracker.labels.bug")).toBe(read);
    },
  );
