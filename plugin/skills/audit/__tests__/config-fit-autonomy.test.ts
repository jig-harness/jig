import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Finding = { id: string; message: string };

function refusal(config: string): Finding | undefined {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  const { findings } = JSON.parse(run.out) as { findings: Finding[] };
  return findings.find((f) => f.id.startsWith("rejected:autonomy"));
}

test("a level above the ceiling is reported", () => {
  expect(
    refusal("autonomy:\n  level: unattended\n  max_level: attended\n")?.message,
  ).toContain("above autonomy.max_level");
});

test("a level at its ceiling is accepted", () => {
  expect(
    refusal("autonomy:\n  level: unattended\n  max_level: wide\n"),
  ).toBeUndefined();
});
