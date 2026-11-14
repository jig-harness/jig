import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function advisoryFindings(config: string) {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExit({ exitCode: run.code, stdout: run.out, stderr: run.err }, 0);
  const report = JSON.parse(run.out) as {
    findings: { id: string; severity: string; message: string }[];
  };
  return report.findings.filter((f) => f.id === "rule:ci.advisory_checks");
}

test("advisory checks warn when the repository excludes reviewer-posture parks", () => {
  expect(
    advisoryFindings(
      "ci:\n  advisory_checks: [quality]\nautonomy:\n  park_classes: [scope]\n",
    ),
  ).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("reviewer-posture"),
    }),
  ]);
});

test("default or explicitly allowed reviewer-posture parks need no warning", () => {
  for (const autonomy of [
    "",
    "autonomy:\n  park_classes: [reviewer-posture]\n",
  ])
    expect(
      advisoryFindings(`ci:\n  advisory_checks: [quality]\n${autonomy}`),
    ).toEqual([]);
});

test("an empty advisory list needs no reviewer-posture class", () => {
  expect(
    advisoryFindings(
      "ci:\n  hold_sentinels: [held-head]\n  advisory_checks: []\nautonomy:\n  park_classes: [scope]\n",
    ),
  ).toEqual([]);
});
