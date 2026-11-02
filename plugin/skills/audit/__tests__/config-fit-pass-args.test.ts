import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Finding = { id: string; message: string };

/** The drive-pr pass-argument refusal in config-fit's report for `passArgs`, or undefined. */
function refusal(passArgs: string): Finding | undefined {
  const dir = scratchRepo({
    ".config/jig.yaml": `drive:\n  pass_args: ${passArgs}\n`,
  });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  const { findings } = JSON.parse(run.out) as { findings: Finding[] };
  return findings.find((f) => f.id === "rejected:drive-pr (pass arguments)");
}

test("a pass_args list ending in --permission-mode is refused", () => {
  expect(refusal("[--permission-mode]")?.message).toContain(
    "cannot end with --permission-mode",
  );
});

test("a pass_args list holding a bare -- is refused", () => {
  expect(refusal('["--"]')?.message).toContain("cannot hold --");
});

test("a pass_args list the drive accepts draws no refusal", () => {
  expect(refusal("[--permission-mode, bypassPermissions]")).toBeUndefined();
});
