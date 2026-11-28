/**
 * The configuration fit reads `do_item.override_label`, the label a claim a
 * person started ahead of open blockers adds, as the claim reads it: unset
 * or a label's name.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The fit's findings for a repository with this configuration. */
function findings(config: string): { id: string; message: string }[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

const about = (found: { id: string; message: string }[]) =>
  found.filter(
    (f) =>
      f.id.includes("override_label") || f.message.includes("override_label"),
  );

test("a label's name is accepted, and so is leaving it unset", () => {
  expect(
    about(findings("do_item:\n  override_label: started-early\n")),
  ).toEqual([]);
  expect(about(findings("do_item:\n  claim_marker: true\n"))).toEqual([]);
});

test("a blank or non-text label is refused", () => {
  for (const value of ['"  "', "3", "[a]"])
    expect(
      about(findings(`do_item:\n  override_label: ${value}\n`)).length,
    ).toBeGreaterThan(0);
});
