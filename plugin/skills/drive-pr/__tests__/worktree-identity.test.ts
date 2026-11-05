import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { byPlatform } from "../../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const root = mkdtempSync(join(tmpdir(), "worktree-identity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a worktree alias has the same key as its canonical directory", () => {
  const real = join(root, "real");
  const alias = join(root, "alias");
  mkdirSync(real);
  symlinkSync(
    real,
    alias,
    byPlatform(
      "Windows directory aliases use junctions without symlink privileges",
      { windows: "junction" as const, posix: "dir" as const },
    ),
  );
  expect(worktreePathKey(alias)).toBe(worktreePathKey(real));
});

test("filesystem case aliases use the same key without merging distinct directories", () => {
  const actual = join(root, "MixedCase");
  const alternate = join(root, "mIXEDcASE");
  mkdirSync(actual);
  try {
    realpathSync.native(alternate);
    expect(worktreePathKey(alternate)).toBe(worktreePathKey(actual));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(alternate);
    expect(worktreePathKey(alternate)).not.toBe(worktreePathKey(actual));
  }
});

test("an alternate drive-letter spelling keeps the worktree key", () => {
  const alternate = byPlatform(
    "Windows paths can spell the same drive with either letter case",
    {
      windows: root.replace(/^([a-zA-Z]):/, (drive) =>
        drive === drive.toUpperCase()
          ? drive.toLowerCase()
          : drive.toUpperCase(),
      ),
      posix: join(root, "."),
    },
  );
  expect(worktreePathKey(alternate)).toBe(worktreePathKey(root));
});

test("a database's identity is stable, and a database created again has another", () => {
  const directory = join(root, "identity", "0123456789abcdef");
  mkdirSync(directory, { recursive: true });
  const before = stateDirIdentityToken(directory);
  expect(before).toMatch(/^[0-9a-f-]{36}$/);
  expect(stateDirIdentityToken(directory)).toBe(before);
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(root, "identity", `state.sqlite${suffix}`), { force: true });
  expect(stateDirIdentityToken(directory)).not.toBe(before);
});

test("the driver runs its entry point through a directory alias", () => {
  const alias = join(root, "scripts-alias");
  symlinkSync(
    join(import.meta.dir, "..", "scripts"),
    alias,
    byPlatform(
      "Windows directory aliases use junctions without symlink privileges",
      { windows: "junction" as const, posix: "dir" as const },
    ),
  );
  const result = Bun.spawnSync([process.execPath, join(alias, "drive.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("usage: drive.ts");
});
