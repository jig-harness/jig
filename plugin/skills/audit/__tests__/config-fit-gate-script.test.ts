import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dir = scratchRepo({ "scripts/check.sh": "#!/bin/sh\ntrue\n" });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("without a package script or CI step, a gate script CI does not run is still found", () => {
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  const report = JSON.parse(run.out) as {
    suggestions: { field: string; value: unknown }[];
  };
  // A shell script without the executable bit runs through bash.
  expect(
    report.suggestions.find((s) => s.field === "gates.command")?.value,
  ).toBe(
    byPlatform("Windows has no executable bit: a script runs as ./<path>", {
      windows: "./scripts/check.sh",
      posix: "bash scripts/check.sh",
    }),
  );
});
