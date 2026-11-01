import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { dispatchJobSpec } from "../dispatch/install.ts";
import { gcJobSpec } from "../gc/job-spec.ts";
import { parseCommandLine } from "../jig.ts";

const entry = resolve(import.meta.dir, "../jig.ts");

/** `jig <args>`, run from a scratch directory that is also its home. */
function jig(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "jig-entry-"));
  return Bun.spawnSync([process.execPath, "--no-env-file", entry, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      JIG_HOME: join(home, ".jig"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
  });
}

test("a dispatch usage error exits 2 and says why", () => {
  const result = jig("dispatch", "--bogus");
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain(
    "Unexpected option or subcommand: `--bogus`",
  );
});

test.each([
  [["--help"], ["gc", "dispatch", "completion"]],
  [["help"], ["gc", "dispatch", "completion"]],
  [
    ["gc", "--help"],
    ["install", "receipts", "--collect", "--scheduled"],
  ],
  [
    ["help", "gc"],
    ["install", "receipts", "--kind", "--json"],
  ],
  [
    ["gc", "install", "--help"],
    ["--repo", "--yes", "--uninstall"],
  ],
  [
    ["dispatch", "--help"],
    ["install", "receipts", "--apply", "--repo"],
  ],
  [
    ["dispatch", "install", "--help"],
    ["--interval", "--yes"],
  ],
])("jig %p prints help naming its commands and exits 0", (args, names) => {
  const result = jig(...args);
  expectSpawnExit(result, 0);
  for (const name of names) expect(result.stdout.toString()).toContain(name);
  expect(result.stderr.toString()).toBe("");
});

test.each(["bash", "zsh", "fish", "pwsh", "nu"])(
  "jig completion %s prints a completion script and exits 0",
  (shell) => {
    const result = jig("completion", shell);
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain("jig");
  },
);

test.each([
  [[], "No matching command"],
  [["gc", "--collect", "--scheduled"], "cannot be used together"],
  [["gc", "--kind", "bogus"], '"bogus"'],
  [["gc", "--repo", "--json"], "Expected a path"],
  [["gc", "--json", "--json"], "cannot be used multiple times"],
  [["gc", "--yes"], "`--yes`"],
  [["gc", "install", "--json"], "cannot be used together"],
  [["gc", "install", "--machine"], "`--uninstall`"],
  [["gc", "receipts", "nope"], '"nope"'],
  [["gc", "receipts", "2026-10-31", "extra"], "`extra`"],
  [["dispatch", "--followup-since", "nope"], '"nope"'],
  [["dispatch", "install", "--interval", "90s"], "whole minutes"],
  [["dispatch", "receipts", "one", "two"], "`two`"],
])("jig %p is refused with exit 2 and the reason", (args, reason) => {
  const result = jig(...args);
  expectSpawnExit(result, 2);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(reason);
});

test("bare gc parses as a report and bare dispatch as a tick", () => {
  expect(parseCommandLine(["gc"])).toEqual({
    component: "gc",
    gc: {
      action: "collect",
      mode: undefined,
      repository: undefined,
      kind: undefined,
      json: false,
    },
  });
  expect(parseCommandLine(["dispatch"])).toEqual({
    component: "dispatch",
    dispatch: {
      action: "tick",
      apply: false,
      repos: [],
      followupSince: undefined,
      json: false,
    },
  });
});

test("the installed jobs' command lines parse as the scheduled run and the applying tick", () => {
  expect(parseCommandLine(gcJobSpec().args)).toMatchObject({
    component: "gc",
    gc: { action: "collect", mode: "scheduled" },
  });
  expect(parseCommandLine(dispatchJobSpec(5).args)).toMatchObject({
    component: "dispatch",
    dispatch: { action: "tick", apply: true },
  });
});

test("dispatch --apply reaches the tick, which asks for the machine file", () => {
  const result = jig("dispatch", "--apply");
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain(
    "jig dispatch --apply needs the machine file",
  );
});

test("dispatch run passes its arguments to the pass wrapper as they are", () => {
  const result = jig("dispatch", "run", "--help");
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("usage: run.ts <record> <token>");
});
