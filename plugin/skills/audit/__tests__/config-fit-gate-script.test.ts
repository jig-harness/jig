import { afterAll, expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suggestedGate(files: Record<string, string>, executable?: string) {
  const dir = scratchRepo(files);
  dirs.push(dir);
  if (executable !== undefined) {
    // The index carries the executable bit a checkout on any platform takes.
    chmodSync(join(dir, executable), 0o755);
    git(dir, "update-index", "--chmod=+x", executable);
    git(dir, "commit", "-qm", "executable");
  }
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as {
    suggestions: { field: string; value: unknown }[];
  };
  return report.suggestions.find((s) => s.field === "gates.command")?.value;
}

test("without a package script or CI step, a gate script CI does not run is still found", () => {
  // Not executable in the index: it runs through bash, on every platform.
  expect(suggestedGate({ "scripts/check.sh": "#!/bin/sh\ntrue\n" })).toBe(
    "bash scripts/check.sh",
  );
});

test("a gate script the index marks executable runs directly", () => {
  expect(
    suggestedGate(
      { "scripts/check.sh": "#!/bin/sh\ntrue\n" },
      "scripts/check.sh",
    ),
  ).toBe("./scripts/check.sh");
});
