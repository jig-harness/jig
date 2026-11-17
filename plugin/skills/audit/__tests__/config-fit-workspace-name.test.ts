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

const aboutSection = (yaml: string) =>
  findings(yaml).filter((f) => f.message.includes("workspace_name"));

test("a workspace_name section is reported as no longer having an effect, not as a bad template", () => {
  const found = aboutSection(
    "workspace_name:\n  template: '{branch} {id}'\n  statuses:\n    ready: ''\n",
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.message).toContain("no longer has an effect");
});

test("a configuration without the section has no finding about it", () => {
  expect(aboutSection("do_item:\n  arm_drive: auto\n")).toEqual([]);
});

test("a section holding only a template is reported the same way", () => {
  const found = aboutSection("workspace_name:\n  template: '{status} {id}'\n");
  expect(found).toHaveLength(1);
  expect(found[0]?.message).toContain("no longer has an effect");
});

test("a section holding only statuses is reported the same way", () => {
  const found = aboutSection(
    "workspace_name:\n  statuses:\n    ready: 'Ready'\n",
  );
  expect(found).toHaveLength(1);
});

test("a section that turned the renaming off with an empty template is reported too", () => {
  expect(aboutSection("workspace_name:\n  template: ''\n")).toHaveLength(1);
});
