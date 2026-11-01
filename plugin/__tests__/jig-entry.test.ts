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

const VERBS = ["install", "uninstall", "status", "receipts", "run"];

test.each([
  [["--help"], [...VERBS, "gc", "dispatch", "completion"]],
  [["help"], [...VERBS, "gc", "dispatch", "completion"]],
  [
    ["gc", "--help"],
    ["--collect", "--scheduled", "--kind"],
  ],
  [
    ["help", "gc"],
    ["--collect", "--kind", "--json"],
  ],
  [
    ["gc", "install", "--help"],
    ["--repo", "--yes", "--uninstall"],
  ],
  [
    ["dispatch", "--help"],
    ["--apply", "--repo", "--followup-since"],
  ],
  [
    ["dispatch", "install", "--help"],
    ["--interval", "--yes"],
  ],
  [
    ["install", "--help"],
    ["--repo", "--yes", "COMPONENT", "gc, dispatch"],
  ],
  [
    ["uninstall", "--help"],
    ["--machine", "--yes", "COMPONENT"],
  ],
  [
    ["status", "--help"],
    ["--json", "COMPONENT"],
  ],
  [
    ["help", "receipts"],
    ["COMPONENT", "DATE|RUN-ID"],
  ],
  [["run", "--help"], ["COMPONENT"]],
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
  [["install", "bogus"], '"bogus"'],
  [["install", "--machine"], "`--machine`"],
  [["receipts"], "COMPONENT"],
  [["status", "--yes"], "`--yes`"],
  [["run", "--json"], "`--json`"],
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

test.each([
  [
    ["gc", "install"],
    {
      component: "gc",
      gc: {
        action: "install",
        repository: undefined,
        confirm: false,
        uninstall: undefined,
      },
    },
  ],
  [
    ["gc", "install", "--uninstall", "--machine", "--yes"],
    {
      component: "gc",
      gc: {
        action: "install",
        repository: undefined,
        confirm: true,
        uninstall: { uninstall: true, machine: true },
      },
    },
  ],
  [
    ["dispatch", "install", "--interval", "10m", "--yes"],
    {
      component: "dispatch",
      dispatch: {
        action: "install",
        intervalMs: 600_000,
        confirm: true,
        uninstall: false,
      },
    },
  ],
  [
    ["gc", "receipts"],
    { component: "gc", gc: { action: "receipts", query: undefined } },
  ],
  [
    ["dispatch", "receipts"],
    {
      component: "dispatch",
      dispatch: { action: "receipts", runId: undefined },
    },
  ],
])("the earlier form jig %p parses as it did", (args, parsed) => {
  expect(parseCommandLine(args) as unknown).toStrictEqual(parsed);
});

test("the earlier install and receipts forms stay out of help", () => {
  const help = [
    jig("--help"),
    jig("gc", "--help"),
    jig("dispatch", "--help"),
    jig("help", "gc"),
  ].map((result) => {
    expectSpawnExit(result, 0);
    return result.stdout.toString();
  });
  for (const text of help) {
    expect(text).not.toMatch(/jig (gc|dispatch) \[?\(?(install|receipts)/);
    expect(text).not.toContain(
      "Register a repository and install the daily job.",
    );
    expect(text).not.toContain("Install the timer that runs dispatch --apply.");
    expect(text).not.toContain(
      "List the receipts of earlier runs, or print one.",
    );
  }
});

test.each([
  [
    ["install"],
    { verb: "install", components: [], repository: undefined, confirm: false },
  ],
  [
    ["install", "dispatch", "gc", "--yes"],
    {
      verb: "install",
      components: ["dispatch", "gc"],
      repository: undefined,
      confirm: true,
    },
  ],
  [
    ["uninstall", "--machine", "--yes"],
    {
      verb: "uninstall",
      components: [],
      repository: undefined,
      machine: true,
      confirm: true,
    },
  ],
  [
    ["status", "gc", "--json"],
    { verb: "status", components: ["gc"], json: true },
  ],
  [
    ["receipts", "dispatch", "2026-10-31"],
    { verb: "receipts", component: "dispatch", query: "2026-10-31" },
  ],
  [["run"], { verb: "run", components: [] }],
])("the lifecycle verb jig %p parses", (args, parsed) => {
  expect(parseCommandLine(args) as unknown).toStrictEqual(parsed);
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
