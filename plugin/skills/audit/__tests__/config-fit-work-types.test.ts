/**
 * The configuration fit reads `issue_tracker.types` and `do_item.work_types`
 * as do-item reads them: it refuses what the loading rules refuse, and
 * checks each type's labels against the label taxonomy.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const TAXONOMY =
  "version: 1\ntypes:\n  - id: feature\n  - id: bug\nstatuses:\n  - id: todo\n";

/** The fit's findings for a repository with this configuration and the taxonomy above. */
function findings(config: string): { id: string; message: string }[] {
  const dir = scratchRepo({
    ".config/jig.yaml": config,
    "label-taxonomy.yaml": TAXONOMY,
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

test("a work type with no complete row is refused as do-item refuses it", () => {
  const found = findings(
    "issue_tracker:\n  types:\n    bug: [bug]\n    chore: [chore]\n",
  );
  expect(
    found.find((f) => f.id === "rejected:do-item (tracker)")?.message,
  ).toContain("do_item.work_types.chore");
});

test("a type's labels the taxonomy does not define are reported", () => {
  const found = findings(
    "issue_tracker:\n  types:\n    bug: [bug, defect]\n    feature: [feature]\n",
  );
  expect(
    found.find((f) => f.id === "taxonomy:issue_tracker.types.bug")?.message,
  ).toContain("defect, which label-taxonomy.yaml");
  expect(
    found.some((f) => f.id === "taxonomy:issue_tracker.types.feature"),
  ).toBe(false);
  expect(found.some((f) => f.id.startsWith("rejected:"))).toBe(false);
});
