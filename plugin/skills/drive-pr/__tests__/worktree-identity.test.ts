import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import {
  parseDirIdentityToken,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease.ts";
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

test("runtime directory identities survive transport and distinguish replacement", () => {
  const directory = join(root, "identity");
  mkdirSync(directory);
  const before = statSync(directory, { bigint: true });
  expect(before.ino).not.toBe(0n);
  expect(stateDirIdentityToken(directory)).toStartWith(
    `${before.dev}:${before.ino}:`,
  );
  renameSync(directory, `${directory}-old`);
  mkdirSync(directory);
  const after = statSync(directory, { bigint: true });
  expect(`${after.dev}:${after.ino}`).not.toBe(`${before.dev}:${before.ino}`);
  expect(stateDirIdentityToken(directory)).toStartWith(
    `${after.dev}:${after.ino}:`,
  );
});

test("zero inode tokens cannot certify a directory identity", () => {
  expect(parseDirIdentityToken("0:0")).toEqual({ kind: "bad" });
  expect(parseDirIdentityToken("12:0")).toEqual({ kind: "bad" });
  // A zero device identifier can still carry a usable filesystem inode.
  expect(parseDirIdentityToken("0:42")).toEqual({
    kind: "ok",
    id: { dev: 0n, ino: 42n },
  });
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
