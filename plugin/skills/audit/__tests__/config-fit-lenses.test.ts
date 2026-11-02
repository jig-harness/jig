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
  return findings.find((f) => f.id === "rejected:review (lenses)");
}

test("a trigger addition or an off entry naming no lens is refused", () => {
  expect(
    refusal(
      "review:\n  lenses:\n    triggers:\n      jig.no-such-lens:\n        added_lines: ['catch']\n",
    )?.message,
  ).toContain("review.lenses.triggers names jig.no-such-lens");
  expect(
    refusal("review:\n  lenses:\n    off: [jig.no-such-lens]\n")?.message,
  ).toContain("review.lenses.off names jig.no-such-lens");
});

test("a seed lens id draws no refusal", () => {
  expect(
    refusal("review:\n  lenses:\n    off: [jig.swallowed-failure]\n"),
  ).toBeUndefined();
});
