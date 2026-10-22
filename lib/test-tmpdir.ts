// Per-test-process temp-dir scope: gives every test process its own subtree of
// the system temp dir and removes it when the process exits, so scratch
// directories a suite never cleans up cannot accumulate on a shared host.
//
// The failure this exists to stop: a shared build host's `/tmp` was a tmpfs
// with a fixed inode table that reached 100% while the disk still reported
// free space, so every gate on the host failed with `ENOSPC ... mkdtemp` for
// every worktree, regardless of the diff. A dependency's own test helper
// mkdtemps a directory per synth and never removes it; one full suite run
// leaked over a thousand empty directories, per worktree, per run. Such call
// sites cannot be fixed one by one (some sit inside a dependency), so the
// scope is applied one level up, where `os.tmpdir()` is resolved.
//
// Wire it in through the runner's "run something once before tests start" hook
// (Bun `[test] preload`; see test-tmpdir-bun-preload.ts) so it applies however
// the run was invoked, without editing any call site. Bun resolves
// bunfig.toml from the working directory only, with no walk-up, so a test run
// whose cwd is a subdirectory without its own bunfig.toml gets no scope.
//
// Published for tests that need to assert containment (the system temp dir did
// not grow) without importing this module across a package boundary:
//   JIG_TEST_TMPDIR         this process's scoped root
//   JIG_TEST_TMPDIR_SYSTEM  the temp dir it would otherwise have used
// A consumer that needs different names (for example so a host-side sweep can
// reap by its own prefix) passes them in the options.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedGcLock } from "../plugin/shared/gc-lock.ts";
import { writeScratchOwner } from "../plugin/shared/scratch-owner.ts";

/**
 * Scratch collection is report-only, so a home the admission store cannot be
 * created in (a read-only container or sandbox home) costs no safety: the
 * owner record still marks the scope, and no collector removes it. Every
 * other admission failure, a collection in progress above all, still refuses.
 */
function scratchAdmission(): () => void {
  try {
    return sharedGcLock("scratch");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM")
      return () => undefined;
    throw error;
  }
}

export const TEST_TMPDIR_PREFIX = "jig-test-tmp.";
export const TEST_TMPDIR_ENV = "JIG_TEST_TMPDIR";
export const TEST_TMPDIR_SYSTEM_ENV = "JIG_TEST_TMPDIR_SYSTEM";

/**
 * Every variable `os.tmpdir()` consults. The precedence differs by platform:
 * POSIX reads TMPDIR, TMP, TEMP in that order; Windows reads TEMP and TMP and
 * never TMPDIR. All three have to move together or the scope silently fails
 * to apply on one of them.
 */
const TMPDIR_VARS = ["TMPDIR", "TMP", "TEMP"] as const;

export interface TestTmpdirOptions {
  /** Directory-name prefix of the scoped root; a host sweep can reap by it. */
  prefix?: string;
  /** Env var publishing the scoped root. */
  rootEnv?: string;
  /** Env var publishing the temp dir the scope replaced. */
  systemEnv?: string;
}

export interface TestTmpdirScope {
  /** The scoped root. `os.tmpdir()` resolves here until `release()`. */
  root: string;
  /** What `os.tmpdir()` resolved to before the scope was applied. */
  systemTmpdir: string;
  /**
   * Restores the previous environment and removes `root` and everything under
   * it. Idempotent: safe to call from both an exit handler and a test's own
   * teardown.
   */
  release(): void;
}

/**
 * Fails before anything is created. The prefix must stay a single path
 * component, or `join` could place the root outside the current temp dir where
 * a parent scope's recursive cleanup cannot reach it. The published names must
 * be distinct from each other and from the vars `os.tmpdir()` reads, or one
 * assignment silently overwrites another. Names compare case-insensitively on
 * every platform because Windows environments are case-insensitive.
 */
function validateOptions(
  prefix: string,
  rootEnv: string,
  systemEnv: string,
): void {
  // `join` normalizes "" and "." away and ".." up a level, so `mkdtemp` would
  // create a sibling of (or a directory above) the current temp dir.
  if (
    /[\\/]/.test(prefix) ||
    prefix.includes("\0") ||
    prefix === "" ||
    prefix === "." ||
    prefix === ".."
  )
    throw new Error(
      `scopeTestTmpdir: prefix ${JSON.stringify(prefix)} must be a non-empty directory-name prefix without path separators or dot components`,
    );
  const taken = new Set<string>(TMPDIR_VARS);
  for (const name of [rootEnv, systemEnv]) {
    const key = name.toUpperCase();
    if (taken.has(key))
      throw new Error(
        `scopeTestTmpdir: env name ${JSON.stringify(name)} collides with TMPDIR/TMP/TEMP or another published name`,
      );
    taken.add(key);
  }
}

/**
 * Redirects `os.tmpdir()` for this process to a fresh directory under the
 * current one.
 *
 * Nesting is deliberately not special-cased: a test process that spawns
 * another one gets a root inside its parent's root, and both clean up their
 * own. The parent's recursive removal covers a child that died without
 * running its handler.
 *
 * Same-process nesting (two scopes live in one process) is expected to release
 * in LIFO order. `release()` guards the shared-environment restore against a
 * non-LIFO or retried-out-of-order call, but an outer scope's recursive
 * removal still deletes whatever is under its root, including a still-live
 * inner scope's directory, if released first.
 */
export function scopeTestTmpdir(
  options: TestTmpdirOptions = {},
): TestTmpdirScope {
  const prefix = options.prefix ?? TEST_TMPDIR_PREFIX;
  const rootEnv = options.rootEnv ?? TEST_TMPDIR_ENV;
  const systemEnv = options.systemEnv ?? TEST_TMPDIR_SYSTEM_ENV;
  validateOptions(prefix, rootEnv, systemEnv);
  const systemTmpdir = tmpdir();
  const releaseAdmission = scratchAdmission();
  let root: string;
  try {
    root = mkdtempSync(join(systemTmpdir, prefix));
    try {
      writeScratchOwner(root);
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  } finally {
    releaseAdmission();
  }

  const previous = new Map<string, string | undefined>();
  for (const name of [...TMPDIR_VARS, rootEnv, systemEnv]) {
    previous.set(name, process.env[name]);
  }

  // What this scope itself assigned to each var. `release()` restores a var
  // only while it still holds the value recorded here, so a per-var check (not
  // a single combined `tmpdir()` read) lets a caller that reassigns just ONE
  // tracked var still get the other, still-owned vars restored correctly.
  const assigned = new Map<string, string>();
  for (const name of TMPDIR_VARS) assigned.set(name, root);
  assigned.set(rootEnv, root);
  assigned.set(systemEnv, systemTmpdir);

  for (const [name, value] of assigned) process.env[name] = value;

  // This only redirects `os.tmpdir()` for THIS process: in-process call sites
  // pick it up because they read `process.env` live. A CHILD spawned with no
  // explicit `env` does not. Bun snapshots a spawned child's inherited
  // environment at its own process's startup, not from a live `process.env`
  // read at spawn time, and this scope is applied after startup. Such a child
  // still inherits the ORIGINAL system tmpdir and any scratch it leaves behind
  // is not contained. A spawn that needs containment must forward `env`
  // explicitly.
  let removed = false;
  // Tracked apart from `removed`: a retry after a failed removal must not
  // restore the environment a second time, because by then a newer scope may
  // have published the very same values, which value equality cannot tell
  // apart from this scope's own.
  let restored = false;
  return {
    root,
    systemTmpdir,
    release() {
      if (removed) return;
      // A release that lost the removal race gets retried on a later call, by
      // which time a newer scope may have reassigned some or all of these
      // vars; restoring again would stomp that scope's live values with this
      // one's stale snapshot. So the restore happens on the first call only.
      if (!restored) {
        restored = true;
        for (const [name, value] of previous) {
          if (process.env[name] !== assigned.get(name)) continue;
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
        removed = true;
      } catch (error) {
        // A run that produced correct results must not fail because its
        // scratch could not be removed, but the leak has to be visible and
        // named, or it is exactly the silent accumulation this file exists to
        // stop. A host-side retention sweep reaps whatever is reported here.
        console.warn(
          `[test-tmpdir] could not remove ${root}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
