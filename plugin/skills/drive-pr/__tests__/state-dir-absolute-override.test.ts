/**
 * A relative `$DRIVE_PR_STATE_DIR` resolves against `process.cwd()`, both in
 * `resolveStateDir()` (store.ts) and in `resolveFenceContext()`'s own,
 * independent read of the raw env var (lease.ts) — two participants launched
 * from different working directories (the base checkout and a linked worktree,
 * in particular) would silently resolve the identical override string to two
 * different directories, recreating exactly the split state/lease hazard
 * `$DRIVE_PR_STATE_DIR` exists to let an operator opt OUT of. Both readers now
 * fail closed on a relative override rather than resolving it silently.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

const STORE_TS = fileURLToPath(
  new URL("../scripts/lib/state/store.ts", import.meta.url),
);
const LEASE_TS = fileURLToPath(
  new URL("../scripts/lib/state/lease.ts", import.meta.url),
);
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "state-dir-override-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function probe(
  module: string,
  expression: string,
  override: string,
  cwd: string,
) {
  return Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const mod = await import(${JSON.stringify(module)});
try {
  console.log(await ${expression});
} catch (error) {
  console.error("CAUGHT: " + error.constructor.name);
  process.exit(2);
}`,
    ],
    {
      cwd,
      // Remove inherited git identity so a non-repository cwd cannot silently
      // resolve its actor from the parent repository before rejecting the override.
      env: { ...gitIdentityEnv(), DRIVE_PR_STATE_DIR: override },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function expectRelativeRefused(result: ReturnType<typeof probe>): void {
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("must be an absolute path");
  expect(result.stderr.toString()).toContain("CAUGHT: ExitError");
}

describe("resolveStateDir — relative $DRIVE_PR_STATE_DIR fails closed", () => {
  it("accepts an absolute override", () => {
    const dir = scratch();
    expectSpawnExit(
      Bun.spawnSync(["git", "init", "-q", dir], {
        env: gitIdentityEnv(),
        stdout: "pipe",
        stderr: "pipe",
      }),
      0,
    );
    const result = probe(STORE_TS, "mod.resolveStateDir()", dir, dir);
    expectSpawnExit(result, 0);
    expect(dirname(result.stdout.toString().trim())).toBe(dir);
  });

  it("refuses a relative override rather than silently resolving it against cwd", () => {
    // A literal stays relative even when the checkout and temporary directory
    // reside on different Windows drives; path.relative cannot promise that.
    const result = probe(
      STORE_TS,
      "mod.resolveStateDir()",
      "relative-state-dir-override",
      scratch(),
    );
    expectRelativeRefused(result);
  });
});

describe("resolveFenceContext — relative $DRIVE_PR_STATE_DIR fails closed", () => {
  it("refuses a relative override before ever reading git or a lease", () => {
    // A fresh process in a non-repository cwd avoids actor memoization. Pin
    // the guard's wording: resolveActor also throws ExitError on missing git,
    // so its error class alone would not prove the guard precedes actor/lease reads.
    const result = probe(
      LEASE_TS,
      'mod.resolveFenceContext("test")',
      "relative-state-dir-override",
      scratch(),
    );
    expectRelativeRefused(result);
  });
});
