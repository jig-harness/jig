import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { isScheduled, scheduledWorkflows } from "./check-schedules-declared.ts";

const script = join(import.meta.dir, "check-schedules-declared.ts");
const fix = (name: string) => join(import.meta.dir, "fixtures", name);

function run(args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}
const check = (workflows: string, registry = fix("registry.yaml")) =>
  run(["--registry", registry, "--workflows", fix(workflows)]);

describe("the command", () => {
  test("every scheduled workflow declared passes, whichever way `on:` is written", () => {
    const r = check("workflows-good");
    expectSpawnExit(r, 0);
    for (const id of ["nightly", "weekly", "hourly-smoke"])
      expect(r.stdout).toContain(`OK   ${id}`);
    expect(r.stdout).not.toContain("ci");
  });

  test("a scheduled workflow the registry does not name fails and is named", () => {
    const r = check("workflows-bad");
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain("UNDECLARED rogue");
    expect(r.stdout).toContain("OK   nightly");
  });

  test("a workflow file that does not parse is an input error", () =>
    expectSpawnExit(check("workflows-broken"), 2));

  test("two scheduled workflows with one id are an input error naming both files", () => {
    const r = check("workflows-collision");
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("nightly.yaml");
    expect(r.stderr).toContain("nightly.yml");
  });

  test("an unscheduled file sharing a scheduled workflow's id is not a collision", () => {
    const r = check("workflows-unscheduled-twin");
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("OK   nightly");
  });

  test("a missing workflow folder is an input error, not a clean run", () =>
    expectSpawnExit(check("workflows-missing"), 2));

  test("a registry the classifier would refuse is refused here", () =>
    expectSpawnExit(
      check("workflows-good", fix("bad/registry-empty.yaml")),
      2,
    ));

  test("--registry is required and options are strict", () => {
    expectSpawnExit(run([]), 2);
    expectSpawnExit(run(["--registry", fix("registry.yaml"), "--bogus"]), 2);
  });
});

describe("isScheduled", () => {
  test("reads the three forms of `on:`", () => {
    expect(isScheduled({ on: "schedule" })).toBe(true);
    expect(isScheduled({ on: ["push", "schedule"] })).toBe(true);
    expect(isScheduled({ on: { schedule: [{ cron: "0 0 * * *" }] } })).toBe(
      true,
    );
    expect(isScheduled({ on: { schedule: null } })).toBe(true);
  });

  test("other triggers and other shapes are not scheduled", () => {
    expect(isScheduled({ on: "push" })).toBe(false);
    expect(isScheduled({ on: ["push"] })).toBe(false);
    expect(isScheduled({ on: { workflow_dispatch: null } })).toBe(false);
    expect(isScheduled({ on: null })).toBe(false);
    expect(isScheduled(null)).toBe(false);
    expect(isScheduled([])).toBe(false);
  });
});

test("a workflow's id is its file name without the extension", () =>
  expect(scheduledWorkflows(fix("workflows-good")).sort()).toEqual([
    "hourly-smoke",
    "nightly",
    "weekly",
  ]));
