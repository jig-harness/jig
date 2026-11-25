import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const jig = resolve(import.meta.dir, "../../jig.ts");

function run(...args: string[]) {
  return Bun.spawnSync([process.execPath, jig, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("jig hub prints its help and exits 0", () => {
  const result = run("hub");
  expectSpawnExit(result, 0);
  const shown = result.stdout.toString();
  expect(shown).toContain("Usage: jig hub");
  expect(shown).toContain("shared control plane");
  expect(run("hub", "--help").stdout.toString()).toBe(shown);
});

test("jig lists hub among its commands", () => {
  const result = run("--help");
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toMatch(/^\s+hub\s+The hub/m);
});

test("jig hub refuses an argument it does not know", () => {
  expectSpawnExit(run("hub", "sever"), 2);
  expectSpawnExit(run("hub", "serve", "--port", "1"), 2);
});

test("jig hub serve refuses a settings file it cannot read", () => {
  const result = run(
    "hub",
    "serve",
    "--settings",
    "/nonexistent/settings.yaml",
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("cannot read the hub's settings");
});
