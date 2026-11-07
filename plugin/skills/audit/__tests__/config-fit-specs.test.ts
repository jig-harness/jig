import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Finding = { id: string; message: string };

/** config-fit's findings for a repository whose configuration is `yaml`. */
function findings(yaml: string): Finding[] {
  const dir = scratchRepo({ ".config/jig.yaml": yaml });
  dirs.push(dir);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  return (JSON.parse(run.out) as { findings: Finding[] }).findings;
}

const refusal = (yaml: string) =>
  findings(yaml).find((f) => f.id === "rejected:do-item (spec resolver)");

test("a spec heading the resolver reads on its own is refused, as the resolver refuses it", () => {
  expect(
    refusal("specs:\n  body_section: 'Acceptance criteria:'\n")?.message,
  ).toContain(
    "specs.body_section must differ from the Acceptance criteria heading",
  );
});

test("null spec fields read as not set, by the audit and by the resolver alike", () => {
  expect(
    refusal("specs:\n  adapters: null\n  body_section: null\n"),
  ).toBeUndefined();
});
