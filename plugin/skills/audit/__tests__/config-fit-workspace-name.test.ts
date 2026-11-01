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

const aboutTemplate = (yaml: string) =>
  findings(yaml).filter((f) => f.message.includes("workspace_name.template"));

test("a template naming a variable the skill refuses is a finding", () => {
  const found = aboutTemplate("workspace_name:\n  template: '{branch} {id}'\n");
  expect(found).toHaveLength(1);
});

test("a template over the variables the skill fills is not", () => {
  expect(
    aboutTemplate(
      "workspace_name:\n  template: '{status} {id} {title} {pr}'\n",
    ),
  ).toEqual([]);
});

test("an empty template, which turns the renaming off, is not", () => {
  expect(aboutTemplate("workspace_name:\n  template: ''\n")).toEqual([]);
});

test("a blank template is a finding", () => {
  expect(aboutTemplate("workspace_name:\n  template: '   '\n")).toHaveLength(1);
});

test("a blank status text is a finding", () => {
  const found = findings(
    "workspace_name:\n  statuses:\n    ready: ''\n",
  ).filter((f) => f.message.includes("workspace_name.statuses"));
  expect(found).toHaveLength(1);
});
