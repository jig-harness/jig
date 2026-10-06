/**
 * Unit suite for the temp-dir scope.
 *
 * A containment test (a suite run adds nothing to the system temp dir) belongs
 * next to the code that leaks. It cannot assert the teardown, because it runs
 * INSIDE the scope it is describing: the root is still present for as long as
 * any test in that process is executing. So the removal, and the environment
 * restoration that makes nesting safe, are pinned here instead.
 *
 * Note that this file itself runs under the preload (root bunfig.toml), so
 * every `scopeTestTmpdir()` below is a NESTED scope. That is deliberate — it
 * is also the shape a test process that spawns another one produces, and the
 * restore-on-release behaviour is what keeps the outer scope intact.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  scopeTestTmpdir,
  TEST_TMPDIR_ENV,
  TEST_TMPDIR_PREFIX,
  TEST_TMPDIR_SYSTEM_ENV,
} from "./test-tmpdir.ts";

const TMPDIR_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

function envSnapshot(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const name of [
    ...TMPDIR_VARS,
    TEST_TMPDIR_ENV,
    TEST_TMPDIR_SYSTEM_ENV,
  ]) {
    snapshot[name] = process.env[name];
  }
  return snapshot;
}

describe("scopeTestTmpdir", () => {
  it("redirects os.tmpdir() to a fresh root under the previous one", () => {
    const outer = tmpdir();
    const scope = scopeTestTmpdir();
    try {
      expect(scope.systemTmpdir).toBe(outer);
      expect(scope.root.startsWith(outer)).toBe(true);
      expect(basename(scope.root).startsWith(TEST_TMPDIR_PREFIX)).toBe(true);
      expect(tmpdir()).toBe(scope.root);
      for (const name of TMPDIR_VARS) {
        expect(process.env[name]).toBe(scope.root);
      }
      expect(process.env[TEST_TMPDIR_ENV]).toBe(scope.root);
      expect(process.env[TEST_TMPDIR_SYSTEM_ENV]).toBe(outer);
    } finally {
      scope.release();
    }
  });

  it("contains scratch that resolves tmpdir() at call time", () => {
    // The whole mechanism rests on os.tmpdir() being read per call rather
    // than cached at module load — true for both node and bun, but it is the
    // single assumption that would make every other assertion here vacuous.
    const outer = tmpdir();
    const scope = scopeTestTmpdir();
    try {
      const scratch = mkdtempSync(join(tmpdir(), "probe-scratch."));
      expect(scratch.startsWith(scope.root)).toBe(true);
      const strayInOuter = readdirSync(outer).filter((entry) =>
        entry.startsWith("probe-scratch."),
      );
      expect(strayInOuter).toEqual([]);
    } finally {
      scope.release();
    }
  });

  it("release() removes the root and everything under it", () => {
    const scope = scopeTestTmpdir();
    const scratch = mkdtempSync(join(scope.root, "nested."));
    writeFileSync(join(scratch, "file.txt"), "content");
    expect(existsSync(scratch)).toBe(true);

    scope.release();

    // The whole point: not just the leaf, the root too. A teardown that only
    // removed empty directories would still leak the root per test process.
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(scope.root)).toBe(false);
  });

  it("release() restores the exact prior environment, unset vars included", () => {
    // TMP/TEMP unset while TMPDIR is set is the ordinary POSIX shape, and the
    // one where a restore that writes back an empty string instead of
    // deleting would be invisible to `process.env[name]` truthiness checks
    // but visible to os.tmpdir() on Windows.
    const beforeOuter = envSnapshot();
    const outerScope = scopeTestTmpdir();
    try {
      delete process.env.TMP;
      delete process.env.TEMP;
      const before = envSnapshot();

      const inner = scopeTestTmpdir();
      // Read through the snapshot helper: after the `delete` above, TS
      // narrows a direct `process.env.TMP` access to `undefined`.
      expect(envSnapshot().TMP).toBe(inner.root);
      inner.release();

      expect(envSnapshot()).toEqual(before);
      expect("TMP" in process.env).toBe(false);
      expect("TEMP" in process.env).toBe(false);
    } finally {
      outerScope.release();
      // Deleting TEMP/TMP is an external change that release deliberately keeps.
      // The test owns those deletions and must restore them for later suites,
      // especially on Windows where TMPDIR alone does not contain scratch files.
      for (const name of ["TMP", "TEMP"]) {
        const value = beforeOuter[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  // Both retry tests below simulate a removal failure by denying write
  // permission via chmod. That simulation is unreliable on two platforms:
  // UID 0 bypasses the Unix permission check entirely, and on Windows
  // `process.getuid` doesn't exist at all so a UID-0-only guard would still
  // run there even though chmod 0o500 doesn't reliably block recursive
  // removal on that platform either. Both cases make `rmSync` succeed anyway and the
  // subsequent `chmodSync` on the now-deleted path throw ENOENT. Skipped
  // explicitly rather than silently passing on an assumption that doesn't
  // hold.
  const SKIP_PERMISSION_SIM =
    process.getuid?.() === 0 || process.platform === "win32";

  it.skipIf(SKIP_PERMISSION_SIM)(
    "release() lets a failed removal be retried on a later call",
    () => {
      // Deny write on the scope's own root (never the shared system tmpdir) so
      // rmSync cannot unlink the nested entry from it — simulating the
      // documented race with a surviving child without touching state any
      // other concurrent process might depend on.
      const scope = scopeTestTmpdir();
      const nested = mkdtempSync(join(scope.root, "nested."));
      writeFileSync(join(nested, "file.txt"), "content");
      chmodSync(scope.root, 0o500);
      try {
        scope.release();
        // The denied permission genuinely blocks rmSync either way — this
        // assertion holds regardless of the fix.
        expect(existsSync(scope.root)).toBe(true);
      } finally {
        chmodSync(scope.root, 0o700);
      }

      // The retry is what the fix is about: a pre-fix version marks
      // `released` before the first, failed attempt, so this second call
      // returns early and never retries — the root would still exist and
      // this reddens.
      scope.release();
      expect(existsSync(scope.root)).toBe(false);
    },
  );

  it.skipIf(SKIP_PERMISSION_SIM)(
    "a retried release() does not stomp a newer scope's active environment",
    () => {
      // `older`'s first release() fails to remove (denied permission),
      // leaving it retryable. Before the retry, `newer` becomes the active
      // scope. The retry must not restore `older`'s stale snapshot over
      // `newer`'s live redirect — a version that restores unconditionally on
      // every non-removed call does exactly that.
      const older = scopeTestTmpdir();
      const nested = mkdtempSync(join(older.root, "nested."));
      writeFileSync(join(nested, "file.txt"), "content");
      chmodSync(older.root, 0o500);
      older.release();
      chmodSync(older.root, 0o700);
      expect(existsSync(older.root)).toBe(true);

      const newer = scopeTestTmpdir();
      expect(tmpdir()).toBe(newer.root);

      older.release();
      expect(existsSync(older.root)).toBe(false);
      expect(tmpdir()).toBe(newer.root);
      // Also the published metadata: `newer` and `older` both published the
      // same outer temp dir as the system one, so value equality alone would
      // let the retry overwrite it with `older`'s stale snapshot.
      expect(process.env[TEST_TMPDIR_SYSTEM_ENV]).toBe(newer.systemTmpdir);

      newer.release();
    },
  );

  it("release() restores each tracked var independently, even when only one was reassigned externally", () => {
    // Simulate code that mutates the platform's highest-precedence var
    // directly, bypassing this scope's API entirely — release() must not
    // blindly skip restoring the OTHER vars just because this one no longer
    // matches what the scope assigned; a version gated on a single combined
    // `tmpdir() === root` read does exactly that.
    const before = envSnapshot();
    const scope = scopeTestTmpdir();
    const externalValue = `${scope.systemTmpdir}/external-marker`;
    process.env.TMPDIR = externalValue;

    try {
      scope.release();

      // TMPDIR was reassigned externally, so this scope no longer owns it —
      // release() must not stomp that external value.
      expect(process.env.TMPDIR).toBe(externalValue);
      // TMP/TEMP and the published vars were never touched externally —
      // still owned by this scope, so they must be restored.
      const after = envSnapshot();
      expect(after.TMP).toBe(before.TMP);
      expect(after.TEMP).toBe(before.TEMP);
      expect(after[TEST_TMPDIR_ENV]).toBe(before[TEST_TMPDIR_ENV]);
      expect(after[TEST_TMPDIR_SYSTEM_ENV]).toBe(
        before[TEST_TMPDIR_SYSTEM_ENV],
      );
    } finally {
      if (before.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before.TMPDIR;
    }
  });

  it("rejects a prefix that could escape the current temp dir", () => {
    const before = envSnapshot();
    for (const prefix of ["../escaped.", "a/b.", "a\\b.", "", ".", ".."]) {
      expect(() => scopeTestTmpdir({ prefix })).toThrow(
        /non-empty directory-name prefix/,
      );
    }
    expect(envSnapshot()).toEqual(before);
  });

  it("rejects published env names that collide with each other or with the tmpdir vars", () => {
    const before = envSnapshot();
    const collisions: [string, string][] = [
      ["TMPDIR", "OTHER_SYSTEM"],
      ["OTHER_ROOT", "temp"],
      ["SAME_NAME", "SAME_NAME"],
      ["SAME_NAME", "same_name"],
    ];
    for (const [rootEnv, systemEnv] of collisions) {
      expect(() => scopeTestTmpdir({ rootEnv, systemEnv })).toThrow(/collides/);
    }
    expect(envSnapshot()).toEqual(before);
  });

  it("release() is idempotent", () => {
    const before = envSnapshot();
    const scope = scopeTestTmpdir();
    scope.release();
    // A second call must not throw, must not re-delete a root some later
    // scope may now own, and must not re-apply the restore over a newer one.
    const between = scopeTestTmpdir();
    scope.release();
    expect(tmpdir()).toBe(between.root);
    between.release();
    expect(envSnapshot()).toEqual(before);
  });
});
