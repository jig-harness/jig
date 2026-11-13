/**
 * The Codex shim: runs the guard the pointer beside it names, and says so
 * loudly when it cannot.
 */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { POINTER } from "../codex-shim.ts";

/** A directory holding a copy of the shim, as `jig upgrade` leaves it. */
function installed() {
  const directory = mkdtempSync(join(tmpdir(), "jig-codex-shim-"));
  const shim = join(directory, "codex-turn-budget-guard.ts");
  copyFileSync(join(import.meta.dir, "..", "codex-shim.ts"), shim);
  return { directory, shim, pointer: join(directory, POINTER) };
}

function runShim(shim: string, input: string | null) {
  return Bun.spawnSync([process.execPath, shim], {
    stdin: input === null ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("the shim runs the guard the pointer names, with the payload and its exit status", () => {
  const { directory, shim, pointer } = installed();
  const guard = join(directory, "fake-guard.ts");
  writeFileSync(
    guard,
    'const payload = await Bun.stdin.text();\nprocess.stdout.write("got " + payload);\nprocess.exitCode = 3;\n',
  );
  writeFileSync(pointer, `${guard}\n`);
  const result = runShim(shim, "payload");
  expectSpawnExit(result, 3);
  expect(result.stdout.toString()).toBe("got payload");
  rmSync(directory, { recursive: true });
});

test("the shim fails loudly when the pointer names a guard that is gone", () => {
  const { directory, shim, pointer } = installed();
  writeFileSync(pointer, `${join(directory, "gone.ts")}\n`);
  expectSpawnExit(runShim(shim, null), 1);
  rmSync(directory, { recursive: true });
});

test("the shim fails loudly, naming the fix, when the pointer is missing", () => {
  const { directory, shim } = installed();
  const result = runShim(shim, null);
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("jig upgrade --codex");
  rmSync(directory, { recursive: true });
});
