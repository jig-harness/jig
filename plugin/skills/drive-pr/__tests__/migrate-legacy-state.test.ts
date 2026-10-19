/**
 * migrate-legacy-state.test.ts — the one-time migration CLI.
 *
 * Runs the real script as a subprocess against a real git repository (the
 * function under test IS `git rev-parse --git-common-dir`, so a stub would
 * not exercise it — same rationale as `actor.test.ts`/`store.test.ts`).
 * `$HOME` is always faked: this suite must never touch the real
 * `~/.local/state/jig`.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import {
  copyAndRemove,
  copyPlainSiblingBestEffort,
  publishFailureHeadline,
  publishMigratedMarker,
  reconfirmMarkerDurably,
} from "../scripts/migrate-legacy-state.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

function gitCleanEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "DRIVE_PR_STATE_DIR" || v === undefined)
      continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
    // Windows' home directory is USERPROFILE, not HOME.
    if (k === "HOME") {
      if (v === undefined) delete env.USERPROFILE;
      else env.USERPROFILE = v;
    }
  }
  return env;
}

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `migrate-legacy-state-test-${name}-`));
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "migrate-probe@example.invalid");
  git("config", "user.name", "drive-pr migrate probe");
  writeFileSync(join(dir, "f.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `${name} init`, "--no-verify");
  return dir;
}

const SCRIPT = join(
  import.meta.dir,
  "..",
  "scripts",
  "migrate-legacy-state.ts",
);

/**
 * For a probe whose lock is LIVE: one acquire attempt instead of the script's
 * few-second wait on it. The refusal is the same, only sooner.
 */
const LIVE_LOCK_ENV = { DRIVE_PR_LOCK_TIMEOUT: "0" };

function runMigrate(
  repo: string,
  home: string,
  args: string[] = ["--apply"],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: repo,
    env: gitCleanEnv({ HOME: home, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function newDirFor(home: string): string {
  // The marker path is under $HOME/.local/state/jig/drive-pr/<one hashed dir> — the
  // exact hash is `cloneKey`'s business, not this suite's, so find it by
  // listing rather than recomputing sha256 a second time here.
  const drivePrRoot = join(home, ".local", "state", "jig", "drive-pr");
  const entries = existsSync(drivePrRoot) ? readdirSync(drivePrRoot) : [];
  expect(entries.length).toBe(1);
  return join(drivePrRoot, entries[0] ?? "");
}

/**
 * Fixed for every test that needs `newDir` computable BEFORE running the
 * script. UUID-shaped (never a bare label) so it survives `clone-key.ts`'s
 * own validation, which now refuses anything `randomUUID()` would not have
 * minted.
 */
const FIXED_CLONE_ID = "4c1d2e3f-1a2b-4c3d-8e4f-0123456789ab";

/**
 * Pre-seeds `clone-key.ts`'s persisted identity file so `cloneKey()` never
 * mints a fresh one for this repo — making `newDir` (below) deterministic
 * and known ahead of running the script, which a test needs when it must
 * plant a fixture INSIDE `newDir` before the one invocation that would
 * otherwise create it.
 */
function seedCloneId(repo: string): void {
  writeFileSync(join(repo, ".git", "drive-pr-clone-id"), `${FIXED_CLONE_ID}\n`);
}

/** The `newDir` a repo seeded via `seedCloneId` will resolve to, given `home`. */
function deterministicNewDir(home: string): string {
  const key = createHash("sha256")
    .update(FIXED_CLONE_ID)
    .digest("hex")
    .slice(0, 16);
  return join(home, ".local", "state", "jig", "drive-pr", key);
}

/** Backdates `path`'s mtime by `minutes`, past `createLock`'s staleness window. */
function backdate(path: string, minutes: number): void {
  const past = new Date(Date.now() - minutes * 60_000);
  utimesSync(path, past, past);
}

describe("migrate-legacy-state.ts", () => {
  const cleanupDirs: string[] = [];
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  it("marks a clone migrated when the legacy location has nothing but ordinary git contents", () => {
    const repo = makeRepo("clean");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);
    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the second run re-confirms the marker with fsyncFileSync, which fails with EPERM on Windows (fsync on a read-only handle)",
    ),
  )("is idempotent — a second run is a fast no-op", () => {
    const repo = makeRepo("idempotent");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    expect(runMigrate(repo, home).code).toBe(0);
    const r2 = runMigrate(repo, home);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("already marked migrated");
  });

  it("refuses (ExitError 2) rather than reporting success when the marker path is a DIRECTORY", () => {
    // `existsSync` alone can't tell a directory apart from a real marker, and
    // `fsyncFileSync` can open a directory read-only on POSIX — silently
    // reporting "already migrated" over corruption instead of refusing.
    const repo = makeRepo("marker-is-dir");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    expect(runMigrate(repo, home).code).toBe(0);
    const marker = join(newDirFor(home), ".migrated-from-legacy");
    rmSync(marker, { force: true });
    mkdirSync(marker);

    const r2 = runMigrate(repo, home);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("not a regular file");
  });

  it("refuses (ExitError 2) rather than reporting success when the marker path is a SYMLINK", () => {
    const repo = makeRepo("marker-is-symlink");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    expect(runMigrate(repo, home).code).toBe(0);
    const marker = join(newDirFor(home), ".migrated-from-legacy");
    rmSync(marker, { force: true });
    symlinkSync("/nonexistent-target", marker);

    const r2 = runMigrate(repo, home);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("not a regular file");
  });

  it("bare invocation (no --apply) is a dry run: reports, touches nothing, marks nothing", () => {
    // Same posture as reap-state.ts's --delete: a script whose only job is
    // copying and deleting real per-PR round history must not be one
    // accidental invocation away from mutating it.
    const repo = makeRepo("dry-run");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');

    const r = runMigrate(repo, home, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dry run");
    // Untouched: still present, still exactly what it was.
    expect(existsSync(legacyStateFile)).toBe(true);
    expect(readFileSync(legacyStateFile, "utf8")).toBe('{"pr":4172}');

    const drivePrRoot = join(home, ".local", "state", "jig", "drive-pr");
    // Not even the marker (or the directory it would live in, in some
    // configurations) gets written on a dry run.
    const entries = existsSync(drivePrRoot) ? readdirSync(drivePrRoot) : [];
    if (entries.length > 0) {
      expect(
        existsSync(
          join(drivePrRoot, entries[0] ?? "", ".migrated-from-legacy"),
        ),
      ).toBe(false);
      expect(
        existsSync(join(drivePrRoot, entries[0] ?? "", "drive-pr-4172.json")),
      ).toBe(false);
    }
  });

  it("a bare dry run does not mint a clone identity — repository metadata stays untouched", () => {
    // The gap this round closes: even a
    // BARE (no --apply) invocation used to call `defaultStateDirFor`
    // unconditionally, which mints and durably persists a fresh
    // `drive-pr-clone-id` inside the git common directory the first time
    // it's called on a clone with none yet — mutating repository metadata
    // despite this script's own "a dry run writes nothing" promise.
    const repo = makeRepo("dry-run-no-mint");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const cloneIdFile = join(repo, ".git", "drive-pr-clone-id");
    expect(existsSync(cloneIdFile)).toBe(false);

    const r = runMigrate(repo, home, []);
    expect(r.code).toBe(0);
    expect(existsSync(cloneIdFile)).toBe(false);

    // A subsequent --apply is unaffected: it mints the identity itself and
    // completes normally, exactly as if the dry run had never run.
    const r2 = runMigrate(repo, home, ["--apply"]);
    expect(r2.code).toBe(0);
    expect(existsSync(cloneIdFile)).toBe(true);
    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("copies a durable state file to the new location and removes the legacy original", () => {
    const repo = makeRepo("copy");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(legacyStateFile)).toBe(false);

    const newDir = newDirFor(home);
    const migrated = join(newDir, "drive-pr-4172.json");
    expect(existsSync(migrated)).toBe(true);
    expect(readFileSync(migrated, "utf8")).toBe('{"pr":4172}');
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("copies a plain .log sibling to the new location but retains the legacy original, unlike the content anchor", () => {
    // No re-read immediately before a delete can ever prove a
    // `.log`/`.orphan-warned` file quiescent, since no producer of one takes
    // any lock before writing — three successive attempts at narrowing that
    // window with one more re-read each still left a gap between the LAST read
    // and the delete itself. The fix is to stop deleting these siblings at all:
    // copy durably, leave `src` in place as the same harmless, self-limiting
    // debris the header already accepts for lock/quarantine files.
    const repo = makeRepo("plain-sibling-retained");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    const legacyLogFile = join(repo, ".git", "drive-pr-4172.log");
    writeFileSync(legacyLogFile, "round 1\n");

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);

    // The content anchor is genuinely MOVED — lock-protected, so this
    // migration is the only writer possible.
    expect(existsSync(legacyStateFile)).toBe(false);
    // The plain sibling is COPIED but the legacy original survives — the
    // structural fix under test.
    expect(existsSync(legacyLogFile)).toBe(true);
    expect(readFileSync(legacyLogFile, "utf8")).toBe("round 1\n");

    const newDir = newDirFor(home);
    const migratedLog = join(newDir, "drive-pr-4172.log");
    expect(existsSync(migratedLog)).toBe(true);
    expect(readFileSync(migratedLog, "utf8")).toBe("round 1\n");
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("a dry run reports a dangling-symlink content anchor as present, not silently as absent", () => {
    // The migration loop's own gate used `existsSync`, which FOLLOWS a symlink
    // and reports `false` for one whose target does not resolve — even though
    // `readdirSync` (what `classifyEntries` scans) already saw the entry. A
    // dangling `drive-pr-<n>.json` symlink used to read as entirely absent
    // here, so a dry run under-reported "would migrate 0 file(s)" for a family
    // that genuinely has one entry to account for.
    const repo = makeRepo("dangling-symlink-dry-run");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    symlinkSync(join(repo, ".git", "nonexistent-target"), legacyStateFile);

    const r = runMigrate(repo, home, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("drive-pr-4172.json");
    expect(r.stdout).not.toContain("would migrate 0 file");
    // A dry run changes nothing — `existsSync` reads the dangling link as
    // absent, so check the entry with `lstatSync` instead.
    expect(() => lstatSync(legacyStateFile)).not.toThrow();
  });

  it("apply fails with a clear real-file refusal instead of a misleading reappeared-content refusal on a dangling-symlink content anchor", () => {
    // Before the fix, the same `existsSync` gap made `--apply` skip this anchor
    // too (never calling `copyAndRemove`, so the symlink was left behind in the
    // legacy directory) — and `publishMigratedMarker`'s own, already-correct
    // `readdirSync`-based scan then found it still there and reported
    // `reappeared-content`, an error that reads as "something else wrote here
    // concurrently" and could never clear on a re-run, because nothing about
    // the dangling link ever changes between attempts. `copyAndRemove` now runs
    // against it and refuses with its own `assertRealFile` message — stricter
    // and clearer than the raw `ENOENT` a bare `copyFileSync` would otherwise
    // have thrown here.
    const repo = makeRepo("dangling-symlink-apply");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    symlinkSync(join(repo, ".git", "nonexistent-target"), legacyStateFile);

    const r = runMigrate(repo, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is not a real file");
    expect(r.stderr).not.toContain("reappeared-content");
    // Left in place for manual reconciliation — a dangling symlink is
    // filesystem corruption this script does not attempt to repair.
    expect(() => lstatSync(legacyStateFile)).not.toThrow();
  });

  it("refuses globally when a drive.ts single-instance lock is present", () => {
    const repo = makeRepo("foreign-lock");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    mkdirSync(join(repo, ".git", "pr-drive-4172.lock"));

    const r = runMigrate(repo, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("pr-drive-4172.lock");
    // Nothing touched — the state file must still be exactly where it was.
    expect(existsSync(legacyStateFile)).toBe(true);
    expect(readFileSync(legacyStateFile, "utf8")).toBe('{"pr":4172}');
  });

  it("skips (does not delete) a content anchor whose own lock is present, and does not mark the clone migrated", () => {
    const repo = makeRepo("anchor-locked");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    mkdirSync(join(repo, ".git", "drive-pr-4172.json.lock"));

    const r = runMigrate(repo, home, ["--apply"], LIVE_LOCK_ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drive-pr-4172.json");
    expect(existsSync(legacyStateFile)).toBe(true);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(false);
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(false);
  });

  it("skips a family with an in-flight claim file and reports it", () => {
    const repo = makeRepo("claim");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    writeFileSync(join(repo, ".git", "drive-pr-4172.ready-claim"), "");

    const r = runMigrate(repo, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("in-flight claim");
    expect(existsSync(legacyStateFile)).toBe(true);
  });

  it("leaves lock-quarantine debris in place and reports it, without blocking migration of the content file", () => {
    const repo = makeRepo("debris");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    const quarantine = join(
      repo,
      ".git",
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    mkdirSync(quarantine);

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("left in place");
    expect(existsSync(quarantine)).toBe(true);
    expect(existsSync(legacyStateFile)).toBe(false);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(true);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("breaks a genuinely STALE anchor lock and completes the migration, rather than treating any lock presence as permanently blocking", () => {
    // The fix: the old existsSync check treated ANY `.lock`
    // presence — live or crashed — as blocking forever. Taking the real
    // `createLock` mutex means a lock past the staleness window is broken
    // exactly as it would be for any other contender, and migration
    // proceeds.
    const repo = makeRepo("stale-lock");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    const anchorLock = join(repo, ".git", "drive-pr-4172.json.lock");
    mkdirSync(anchorLock);
    backdate(anchorLock, 15); // past the default 10-minute staleness window

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(legacyStateFile)).toBe(false);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(true);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("blocks migration on a LIVE anchor lock with no content file yet — a family whose only trace is its .lock", () => {
    // The gap: an old, older driver taking an anchor's lock for the FIRST write
    // to a brand-new anchor has no bare content file on disk yet.
    // `contentNames` used to be derived from file NAMES that already existed,
    // so this family had nothing in it to even attempt a lock against — the
    // `.lock` fell straight into harmless-looking debris and the clone was
    // marked migrated regardless, silently abandoning whatever that driver was
    // about to write. Iterating `family.anchors` (every anchor a `.lock`
    // implies, content or not) closes it: the lock is live, so this now blocks
    // exactly like an anchor that already has content.
    const repo = makeRepo("lock-only-live");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    mkdirSync(join(repo, ".git", "drive-pr-4172.json.lock"));
    // Deliberately no drive-pr-4172.json — this IS the gap being probed.

    const r = runMigrate(repo, home, ["--apply"], LIVE_LOCK_ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drive-pr-4172.json");

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(false);
  });

  it("completes migration when a lock-only anchor turns out to be genuinely stale — nothing was ever written, so there is nothing to copy", () => {
    const repo = makeRepo("lock-only-stale");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const anchorLock = join(repo, ".git", "drive-pr-4172.json.lock");
    mkdirSync(anchorLock);
    backdate(anchorLock, 15); // past the default 10-minute staleness window
    // Still no drive-pr-4172.json: the lock is stale precisely because
    // whatever held it never got as far as writing content.

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
    // Nothing to migrate for this anchor — no content file should be
    // conjured into existence at the new location either.
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(false);
  });

  it("blocks migration on a LIVE drive-pr-remote-lock-<n> mutex even though it has no content of its own to migrate", () => {
    // The gap this round closes:
    // `lease.ts`'s `claimLease` acquires `drive-pr-remote-lock-<pr>` FIRST,
    // before the per-PR state mutex or any lease lock — so an old,
    // older process can be holding this exact mutex while still on
    // its way to writing a real `drive-pr-<pr>.json`/lease file into this
    // legacy directory. `CONTENT_ANCHOR_PATTERNS` correctly excludes this
    // anchor from copy-then-delete (it has no content), but a naive
    // implementation let that exclusion also skip its LIVENESS check
    // entirely, so the marker published while the claim was still in
    // flight and the old process's subsequent write was silently orphaned.
    const repo = makeRepo("remote-lock-live");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    mkdirSync(join(repo, ".git", "drive-pr-remote-lock-4618.lock"));
    // Deliberately no drive-pr-4618.json and no other content anchor for
    // this PR — the remote-mutation lock is the family's ONLY trace.

    const r = runMigrate(repo, home, ["--apply"], LIVE_LOCK_ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drive-pr-remote-lock-4618");

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(false);
  });

  it("completes migration when a drive-pr-remote-lock-<n> mutex turns out to be genuinely stale", () => {
    const repo = makeRepo("remote-lock-stale");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const remoteLock = join(repo, ".git", "drive-pr-remote-lock-4618.lock");
    mkdirSync(remoteLock);
    backdate(remoteLock, 15); // past the default 10-minute staleness window

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("does not migrate a family’s own content anchor when its remote-mutation lock could not be acquired", () => {
    // The remote-lock loop's own `continue` only advanced ITS `for` loop —
    // after it, execution fell straight through into the `contentAnchors` loop
    // for the SAME family, so a content anchor could still be
    // copied-and-removed even though the remote-mutation lock (which
    // `lease.ts`'s claimant acquires FIRST, per the comment above this loop)
    // could not be won. A retrying claimant would then see an absent legacy
    // file, write a fresh one, and orphan the copy already migrated. This
    // family carries BOTH a live remote-mutation lock AND its own state file —
    // unlike the "no content of its own" test above — so a broken fix would
    // still migrate `drive-pr-4618.json` even while correctly reporting
    // `blocked`.
    const repo = makeRepo("remote-lock-live-with-content");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    mkdirSync(join(repo, ".git", "drive-pr-remote-lock-4618.lock"));
    const legacyStateFile = join(repo, ".git", "drive-pr-4618.json");
    writeFileSync(legacyStateFile, '{"pr":4618}');

    const r = runMigrate(repo, home, ["--apply"], LIVE_LOCK_ENV);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("drive-pr-remote-lock-4618");

    // The content anchor must be untouched: still in the legacy location,
    // never copied to the new one, and the marker never published.
    expect(existsSync(legacyStateFile)).toBe(true);
    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, "drive-pr-4618.json"))).toBe(false);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(false);
  });

  it("does not treat a released claim leftover as an in-flight claim", () => {
    // `removeClaimFile` (claims.ts) renames a claim to
    // `<name>.released.<pid>` before deleting it, so a crash between the
    // two can leave that renamed copy behind forever. The old CLAIM_RE
    // matched it too, blocking migration permanently over debris that was
    // never actually in flight.
    const repo = makeRepo("released-claim");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    writeFileSync(
      join(repo, ".git", "drive-pr-4172.ready-claim.released.99999"),
      "",
    );

    const r = runMigrate(repo, home);
    expect(r.code).toBe(0);
    expect(existsSync(legacyStateFile)).toBe(false);

    const newDir = newDirFor(home);
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(true);
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(true);
  });

  it("sets blocked (exit 1) when a durable plain file (.log/.orphan-warned) fails to copy, rather than silently marking migrated", () => {
    const repo = makeRepo("plain-copy-fail");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);
    seedCloneId(repo);

    const legacyStateFile = join(repo, ".git", "drive-pr-4172.json");
    writeFileSync(legacyStateFile, '{"pr":4172}');
    const legacyLogFile = join(repo, ".git", "drive-pr-4172.log");
    writeFileSync(legacyLogFile, "log line\n");

    const newDir = deterministicNewDir(home);
    mkdirSync(newDir, { recursive: true });
    // Occupy the destination with a DIRECTORY so copyFileSync fails
    // (EISDIR) deterministically — portable and root-safe, unlike a
    // chmod-based EACCES fixture (see `lock.test.ts`'s own note on why
    // those are unreliable when running as root).
    mkdirSync(join(newDir, "drive-pr-4172.log"));

    const r = runMigrate(repo, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not copy drive-pr-4172.log");
    // The content anchor's own copy is unaffected...
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(true);
    // ...but the marker must NOT be written while a durable file's copy
    // failed — the old code left `blocked` false here and would have
    // marked this clone migrated with the log silently dropped.
    expect(existsSync(join(newDir, ".migrated-from-legacy"))).toBe(false);
    // The original log is left in place, not lost.
    expect(existsSync(legacyLogFile)).toBe(true);
  });

  it("blocks (exit 1) on an atomic-write staging leftover, rather than treating it as harmless debris", () => {
    // fsutil.ts's atomicWrite leaves `<target>.<6-hex>` behind when a crash
    // lands between the write and the rename — which can make it the ONLY
    // persisted copy of a content anchor. The classifier already
    // attributes it to its family; the old migration script silently left
    // it as debris and marked the clone migrated anyway.
    const repo = makeRepo("staging-leftover");
    const home = mkdtempSync(join(tmpdir(), "migrate-legacy-state-test-home-"));
    cleanupDirs.push(repo, home);

    const staging = join(repo, ".git", "drive-pr-4172.json.a1b2c3");
    writeFileSync(staging, '{"pr":4172}');

    const r = runMigrate(repo, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("staging leftover");
    expect(existsSync(staging)).toBe(true);

    const drivePrRoot = join(home, ".local", "state", "jig", "drive-pr");
    const entries = existsSync(drivePrRoot) ? readdirSync(drivePrRoot) : [];
    if (entries.length > 0) {
      expect(
        existsSync(
          join(drivePrRoot, entries[0] ?? "", ".migrated-from-legacy"),
        ),
      ).toBe(false);
    }
  });
});

describe("publishMigratedMarker", () => {
  // Direct unit tests, not the subprocess-integration style the rest of
  // this file uses: this function is pure filesystem logic with nothing to
  // do with git resolution (the reason the rest of the suite goes through
  // a real subprocess), and the race it closes — a `drive.ts` lock
  // appearing DURING a real migration run, between the initial scan and
  // the marker write — cannot be reproduced deterministically against a
  // live subprocess without a flaky, timing-dependent test. Testing the
  // function's own decision directly is the reachable, distinguishable
  // probe instead.
  const cleanupDirs: string[] = [];
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  it("publishes the marker when no foreign lock is present", () => {
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-clean-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-clean-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "durably publishes the marker via createExclusiveDurable — fsyncs its containing directory and leaves no temp-file residue",
    async () => {
      // The migrated content and legacy-source deletions are both explicitly
      // fsynced, but the marker itself used to be only written and closed — a
      // crash right after this function returned could lose it while the
      // migration it certifies survives, and the retained lock/quarantine debris
      // then makes legacyFootprint() nonempty on restart, refusing an otherwise
      // complete migration.
      //
      // A later fix replaced the bare `writeFileSync(marker, '')` with
      // `createExclusiveDurable(marker, '')` (fsutil.ts) — a SEPARATE fix, for
      // the symlink-follow gap the test below exercises, not for this one — which
      // happens to change how content durability is achieved:
      // `createExclusiveDurable` fsyncs its content via the temp file's own
      // still-open write descriptor (opened `wx`) rather than a later
      // `openSync(marker, 'r')` re-open of the published path, so that specific
      // call no longer occurs at all. What remains directly observable and still
      // this function's own responsibility is the CONTAINING DIRECTORY's fsync
      // (`fsyncDirectoryBestEffort`, called by `createExclusiveDurable` after the
      // publishing `link`) and that a successful publish leaves no temp-file
      // residue behind.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "publish-marker-fsync-legacy-"),
      );
      const newDir = mkdtempSync(join(tmpdir(), "publish-marker-fsync-new-"));
      cleanupDirs.push(legacyDir, newDir);
      const marker = join(newDir, ".migrated-from-legacy");

      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const openedForSync: string[] = [];
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r") openedForSync.push(p);
          return realFs.openSync(p, flags);
        },
      }));
      try {
        const result = publishMigratedMarker(legacyDir, marker);
        expect(result.ok).toBe(true);
        expect(openedForSync).toContain(newDir);
        // Nothing survives in `newDir` but the published marker itself — the
        // temp file `createExclusiveDurable` staged content in before
        // publishing was disposed of, not left behind as debris.
        expect(readdirSync(newDir)).toEqual([".migrated-from-legacy"]);
        expect(readFileSync(marker, "utf8")).toBe("");
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it("refuses to publish, without writing the marker, when a drive.ts single-instance lock is present at publish time", () => {
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-foreign-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    mkdirSync(join(legacyDir, "pr-drive-4172.lock"));

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("foreign-lock");
      expect(result.names).toContain("pr-drive-4172.lock");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish when a content anchor has reappeared since this run copied it", () => {
    // A standalone drive-state.ts/lease.ts write never takes drive.ts's own
    // single-instance lock (FOREIGN_LOCKS), so it was invisible to the check
    // above. `main()` never reaches `publishMigratedMarker` with `blocked`
    // true, so any content anchor present at THIS scan is new or recreated
    // since this run's own loop already processed it — refusing to publish
    // over it is what closes the gap.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-reappeared-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-reappeared-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"pr":4172}');

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not treat expected debris (a released claim, lock quarantine) as reappeared content", () => {
    // The header's own documented posture: debris left behind on purpose
    // must not block an otherwise clean publish.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-debris-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-debris-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    writeFileSync(
      join(legacyDir, "drive-pr-4172.ready-claim.released.123"),
      "",
    );
    writeFileSync(
      join(legacyDir, "drive-pr-4172.json.lock.stale.unowned-1"),
      "",
    );

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses to publish when a LIVE in-flight claim has reappeared — invisible to a check scoped to content anchors alone", () => {
    // A `.ready-claim`/`.held-claim.` file is a `PLAIN_ENTRIES` match, landing
    // in `family.names` rather than `family.anchors` — so a check that only
    // ever examined `family.anchors` (filtered to `CONTENT_ANCHOR_PATTERNS`)
    // never saw it. Distinct from the debris test above: `.released.` marks a
    // claim as ALREADY retired, this one is not.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-live-claim-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-live-claim-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    writeFileSync(join(legacyDir, "drive-pr-4172.ready-claim"), "");

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.ready-claim");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish when an atomic-write staging leftover has reappeared", () => {
    // Same gap, the OTHER `PLAIN_ENTRIES` shape: `fsutil.ts`'s `atomicWrite`
    // staging suffix can be the ONLY persisted copy of a content anchor if a
    // crash lands between the write and the rename — never safe to treat as
    // harmless debris.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-staging-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-staging-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    writeFileSync(join(legacyDir, "drive-pr-4172.json.a1b2c3"), "{}");

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json.a1b2c3");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish when a content anchor has a LIVE write lock but no content file yet", () => {
    // A legacy standalone writer takes createLock's own per-anchor mutex
    // (`<anchor>.lock`) BEFORE it writes the content file itself. If that lock
    // appears after this anchor was already copied-and-removed but before this
    // final scan, the bare-content check alone reads it as clear — content
    // genuinely isn't there yet — and publishes over an in-flight writer. Same
    // liveness check the remote-lock anchor already gets, applied to a content
    // anchor too.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-content-lock-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-content-lock-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    mkdirSync(join(legacyDir, "drive-pr-4172.json.lock"));

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json.lock");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish when a reappeared content anchor is a DANGLING symlink — existsSync would read it as absent", () => {
    // `existsSync` follows symlinks and reports false for one whose target does
    // not resolve, even though the entry itself is real and was already
    // captured by the readdirSync at the top of this function. A dangling
    // symlink here would silently publish the marker and leave the symlink
    // behind — permanently ignoring that legacy state if its target later
    // reappears.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-dangling-symlink-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-dangling-symlink-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    symlinkSync(
      join(legacyDir, "nonexistent-target"),
      join(legacyDir, "drive-pr-4172.json"),
    );

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish when a drive-pr-remote-lock-<n> mutex is LIVE at this final scan, even with no content anchor to compare", () => {
    // The third shape: `drive-pr-remote-lock-<n>` is deliberately excluded from
    // `CONTENT_ANCHOR_PATTERNS` (it has no bare content of its own), and the
    // old check's `existsSync(anchor)` would therefore always read false for it
    // regardless of whether the mutex was held — liveness has to be checked via
    // its `.lock` file instead, the same way main()'s own dry-run path already
    // does for this anchor kind.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-remote-lock-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-remote-lock-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    mkdirSync(join(legacyDir, "drive-pr-remote-lock-4172.lock"));

    const result = publishMigratedMarker(legacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-remote-lock-4172.lock");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to publish while a drive.ts single-instance lock is still in its staging window — invisible to a bare FOREIGN_LOCKS match", () => {
    // `drive.ts`'s own single-instance lock is a DIRECTORY installed by
    // `takeLock`'s create-then-rename dance — a driver still mid-take has only
    // the staging sibling on disk (`stagingDirFor`), never the installed
    // `pr-drive-<n>.lock` name `FOREIGN_LOCKS` matches. Without recognizing it,
    // this scan would publish while that driver is still on its way to
    // acquiring the lock, stranding its subsequent write in the now-abandoned
    // legacy directory.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-live-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-live-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const staging = `pr-drive-4172.lock.${process.pid}.${hostname()}.staging`;
    mkdirSync(join(legacyDir, staging));

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("foreign-lock");
      expect(result.names).toContain(staging);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not block on an abandoned single-instance-lock staging directory — a dead pid ages out rather than blocking forever", () => {
    // The "excluding stale quarantines" half of the same finding: a staging
    // directory left behind by a crash before its publishing rename must
    // not block this script indefinitely, since nothing else will ever
    // clear it. `stagingLive` reports a dead pid as not-live regardless of
    // age, the same rule `drive.ts`'s own `sweepStaleStaging` reclaims by.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-dead-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-dead-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    // A pid this large is never a real, running process.
    const deadPid = 999_999_999;
    mkdirSync(
      join(
        legacyDir,
        `pr-drive-4172.lock.${deadPid}.${hostname()}@${process.platform}.staging`,
      ),
    );

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses to publish when a content anchor's `.lock.recovering` gate is live, even though `.lock` itself is absent", () => {
    // `createLock`'s stale-break and release dances hold
    // `${anchor}.lock.recovering` during a window where `${anchor}.lock` itself
    // can be momentarily absent (mid-rename to or from quarantine) — invisible
    // to a bare `${anchor}.lock` presence check. Modelled directly: only the
    // `.recovering` gate exists, no bare `.lock` and no content file, so the
    // OLD check alone would have read this anchor as fully clear.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-live-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-live-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    mkdirSync(join(legacyDir, "drive-pr-4172.json.lock.recovering"));

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json.lock.recovering");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("does not block on a stale `.lock.recovering` gate — aged past RECOVERING_STALE_MS, the same policy `createLock` itself ages it out by", () => {
    // The "excluding stale quarantines" half again, for the recovering gate:
    // a dance abandoned by a crash must age out, or a content anchor no
    // live process is contending for could block this script forever.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-stale-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-stale-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const recovering = join(legacyDir, "drive-pr-4172.json.lock.recovering");
    mkdirSync(recovering);
    // Comfortably past RECOVERING_STALE_MS (5s) — a real dance never
    // survives more than a handful of synchronous syscalls.
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(recovering, staleTime, staleTime);

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it('blocks on a foreign-lock staging entry whose stat fails with EACCES, rather than reading the failure as "already gone"', async () => {
    // `isLiveForeignStaging`'s stat catch used to return `false` (not live) on
    // ANY failure, not just ENOENT — an EACCES/EIO against a still-live staging
    // directory would let `publishMigratedMarker` treat it as cleared and
    // publish while a driver is still mid-`takeLock`. Modelled via
    // `mock.module`, not `chmodSync` — a permission bit is not a reliable way
    // to induce EACCES when the suite runs as root (see `lock.test.ts`'s own
    // note on this).
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-eacces-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-foreign-staging-eacces-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const staging = `pr-drive-4172.lock.${process.pid}.${hostname()}.staging`;
    const stagingPath = join(legacyDir, staging);
    mkdirSync(stagingPath);

    const actualFs = await import("node:fs");
    const realStatSync = actualFs.statSync;
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      statSync: (path: string, opts?: unknown) => {
        if (path === stagingPath) {
          const err = new Error(
            "EACCES: permission denied, stat",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realStatSync(path, opts as never);
      },
    }));

    let result: ReturnType<typeof publishMigratedMarker>;
    try {
      result = publishMigratedMarker(legacyDir, marker);
    } finally {
      mock.module("node:fs", () => realFs);
    }

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("foreign-lock");
      expect(result.names).toContain(staging);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('blocks on a content anchor\'s `.lock.recovering` gate whose stat fails with EACCES, rather than reading the failure as "already gone"', async () => {
    // Same defect, same fix, in `isLiveRecoveringGate`.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-eacces-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-recovering-eacces-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const recovering = join(legacyDir, "drive-pr-4172.json.lock.recovering");
    mkdirSync(recovering);

    const actualFs = await import("node:fs");
    const realStatSync = actualFs.statSync;
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      statSync: (path: string, opts?: unknown) => {
        if (path === recovering) {
          const err = new Error(
            "EACCES: permission denied, stat",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realStatSync(path, opts as never);
      },
    }));

    let result: ReturnType<typeof publishMigratedMarker>;
    try {
      result = publishMigratedMarker(legacyDir, marker);
    } finally {
      mock.module("node:fs", () => realFs);
    }

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reappeared-content");
      expect(result.names).toContain("drive-pr-4172.json.lock.recovering");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed — refuses rather than assuming clear — when the legacy directory cannot even be re-scanned", () => {
    const missingLegacyDir = join(tmpdir(), "publish-marker-nonexistent-dir");
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-noread-new-"));
    cleanupDirs.push(newDir);
    const marker = join(newDir, ".migrated-from-legacy");

    const result = publishMigratedMarker(missingLegacyDir, marker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scan-failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses — never following or overwriting — when something already occupies the marker path at publish time, even a symlink", () => {
    // This function's own scans (the foreign-lock and reappeared-content checks
    // above) are both scoped to `legacyDir` — `marker` lives under `newDir`, a
    // different directory entirely, so neither ever looks at `marker`'s own
    // path. The ONLY guard against something occupying that path at publish
    // time used to be `main()`'s `lstatSync(marker)` check, moments before a
    // potentially long migration — a bare `writeFileSync(marker, '')` afterward
    // follows whatever is there THEN, not what was there at that earlier check.
    // Modelled directly against this function (not through main()'s earlier
    // check, which this residual is specifically the gap AFTER): plant a
    // symlink at `marker` before calling it, standing in for whatever raced in
    // during the gap.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-symlinked-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "publish-marker-symlinked-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const elsewhereDir = mkdtempSync(
      join(tmpdir(), "publish-marker-symlinked-elsewhere-"),
    );
    cleanupDirs.push(elsewhereDir);
    const elsewhereTarget = join(elsewhereDir, "do-not-touch");
    writeFileSync(elsewhereTarget, "do-not-touch");
    symlinkSync(elsewhereTarget, marker);

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("marker-reappeared");
      expect(result.names).toContain(marker);
    }
    // The symlink survives untouched — never followed, never clobbered —
    // and its external target was never opened for writing.
    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhereTarget, "utf8")).toBe("do-not-touch");
    // No temp-file residue from the attempted (and refused) publish.
    expect(readdirSync(newDir)).toEqual([".migrated-from-legacy"]);
  });

  it("refreshes a plain durable sibling from the latest legacy content immediately before publishing", () => {
    // `.log`/`.orphan-warned` files are deliberately excluded from the
    // reappeared-content scan above (they are EXPECTED to remain in
    // `legacyDir`, per the module header), so nothing previously re-copied one
    // if an unlocked writer (`drive.ts`'s log append, `orphans.ts`'s
    // `.orphan-warned` write) appended to it between `main()`'s per-family loop
    // copying it and this function's eventual publish. Models that interleaving
    // directly: a stale copy already sitting in `newDir` (standing in for the
    // per-family loop's own, earlier copy) and a legacy `src` that has since
    // grown past it.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "publish-marker-plain-refresh-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "publish-marker-plain-refresh-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const marker = join(newDir, ".migrated-from-legacy");
    const name = "drive-pr-4172.log";
    writeFileSync(join(newDir, name), "round 1\n");
    writeFileSync(join(legacyDir, name), "round 1\nround 2 (concurrent)\n");

    const result = publishMigratedMarker(legacyDir, marker);

    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
    // The migrated copy now carries the append too, not just whatever the
    // per-family loop happened to see at its own, earlier copy time.
    expect(readFileSync(join(newDir, name), "utf8")).toBe(
      "round 1\nround 2 (concurrent)\n",
    );
    // Retain-source is unconditional — the legacy original is never deleted
    // by this refresh, same as every other `copyPlainSiblingBestEffort` call.
    expect(readFileSync(join(legacyDir, name), "utf8")).toBe(
      "round 1\nround 2 (concurrent)\n",
    );
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "the directory fsync is skipped on Windows (opening a directory fails with EPERM), so the directory open this test observes never happens",
    ),
  )(
    "propagates a verification failure from the final plain-sibling refresh rather than publishing over it",
    async () => {
      // A refresh that cannot confirm its own bytes is exactly the case this
      // function must not paper over: publishing the marker afterward would
      // certify a migrated copy this run never actually verified. Modelled
      // the same way `copyPlainSiblingBestEffort`'s own TOCTOU test is —
      // injecting a concurrent append at the exact read `atomicWrite`'s
      // post-rename directory fsync performs, so the refresh's own two
      // verification reads land on either side of it.
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const legacyDir = mkdtempSync(
        join(tmpdir(), "publish-marker-plain-refresh-toctou-legacy-"),
      );
      const newDir = mkdtempSync(
        join(tmpdir(), "publish-marker-plain-refresh-toctou-new-"),
      );
      cleanupDirs.push(legacyDir, newDir);
      const marker = join(newDir, ".migrated-from-legacy");
      const name = "drive-pr-4172.log";
      const src = join(legacyDir, name);
      writeFileSync(src, "round 1\n");

      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r" && p === newDir) {
            realFs.appendFileSync(src, "round 2 (concurrent)\n");
          }
          return realFs.openSync(p, flags);
        },
      }));
      try {
        let threw: unknown;
        try {
          publishMigratedMarker(legacyDir, marker);
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        // Never published over the unverified refresh.
        expect(existsSync(marker)).toBe(false);
        // Retain-source held even on this failure path — the concurrently
        // appended bytes are not lost, there is no delete step to lose them to.
        expect(readFileSync(src, "utf8")).toBe(
          "round 1\nround 2 (concurrent)\n",
        );
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );
});

describe("reconfirmMarkerDurably", () => {
  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows, and the directory fsync is skipped",
    ),
  )("fsyncs the marker file and its containing directory", async () => {
    // main()'s "already migrated, nothing to do" fast path used to trust the
    // marker's mere existence as proof its original publish was durably
    // confirmed.
    const newDir = mkdtempSync(join(tmpdir(), "reconfirm-marker-new-"));
    const marker = join(newDir, ".migrated-from-legacy");
    writeFileSync(marker, "");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    const openedForSync: string[] = [];
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (p: string, flags: string) => {
        if (flags === "r") openedForSync.push(p);
        return realFs.openSync(p, flags);
      },
    }));
    try {
      reconfirmMarkerDurably(marker);
      expect(openedForSync).toContain(marker);
      expect(openedForSync).toContain(newDir);
    } finally {
      mock.module("node:fs", () => realFs);
      rmSync(newDir, { recursive: true, force: true });
    }
  });
});

describe("copyAndRemove", () => {
  const cleanupDirs: string[] = [];
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  it("copies a fresh anchor normally when the destination does not exist yet", () => {
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-fresh-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "copy-and-remove-fresh-new-"));
    cleanupDirs.push(legacyDir, newDir);
    writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"rounds":1}');

    copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");

    expect(existsSync(join(legacyDir, "drive-pr-4172.json"))).toBe(false);
    expect(readFileSync(join(newDir, "drive-pr-4172.json"), "utf8")).toBe(
      '{"rounds":1}',
    );
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows, and the directory fsync is skipped",
    ),
  )(
    "fsyncs legacyDir after removing src, both in the fresh-copy and the resumable path",
    async () => {
      // `rmSync(src)` alone does not make the deletion durable — a crash right
      // after it can leave the unlink uncommitted while `dst` and the eventual
      // migrated marker survive, resurrecting `src` on the next boot. Modelled by
      // spying on `openSync` (what `fsyncDirectoryBestEffort` calls first) rather
      // than asserting on-disk state, since a successful fsync has no observable
      // side effect through the public filesystem API.
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const openedForSync: string[] = [];
      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r") openedForSync.push(p);
          return realFs.openSync(p, flags);
        },
      }));
      try {
        const freshLegacy = mkdtempSync(
          join(tmpdir(), "copy-and-remove-fsync-fresh-legacy-"),
        );
        const freshNew = mkdtempSync(
          join(tmpdir(), "copy-and-remove-fsync-fresh-new-"),
        );
        cleanupDirs.push(freshLegacy, freshNew);
        writeFileSync(join(freshLegacy, "drive-pr-4172.json"), '{"rounds":1}');
        copyAndRemove(freshLegacy, freshNew, "drive-pr-4172.json");
        expect(openedForSync).toContain(freshLegacy);

        const resumableLegacy = mkdtempSync(
          join(tmpdir(), "copy-and-remove-fsync-resumable-legacy-"),
        );
        const resumableNew = mkdtempSync(
          join(tmpdir(), "copy-and-remove-fsync-resumable-new-"),
        );
        cleanupDirs.push(resumableLegacy, resumableNew);
        writeFileSync(
          join(resumableLegacy, "drive-pr-4172.json"),
          '{"rounds":1}',
        );
        writeFileSync(join(resumableNew, "drive-pr-4172.json"), '{"rounds":1}');
        openedForSync.length = 0;
        copyAndRemove(resumableLegacy, resumableNew, "drive-pr-4172.json");
        expect(openedForSync).toContain(resumableLegacy);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows",
    ),
  )(
    "is resumable when the destination already exists with IDENTICAL content — the retry-after-reappeared-content case",
    () => {
      // A retry after `publishMigratedMarker` refused on `reappeared-content`
      // (some OTHER family member, not this anchor) re-enters `main()`, which
      // calls this function again for an anchor that already migrated cleanly on
      // the earlier attempt. `dst` already holding byte-identical content is the
      // resumable case — this anchor's copy is done, only the reappeared legacy
      // leftover needs clearing.
      const legacyDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-resumable-legacy-"),
      );
      const newDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-resumable-new-"),
      );
      cleanupDirs.push(legacyDir, newDir);
      writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"rounds":1}');
      writeFileSync(join(newDir, "drive-pr-4172.json"), '{"rounds":1}');

      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");

      expect(existsSync(join(legacyDir, "drive-pr-4172.json"))).toBe(false);
      expect(readFileSync(join(newDir, "drive-pr-4172.json"), "utf8")).toBe(
        '{"rounds":1}',
      );
    },
  );

  it("refuses rather than overwriting when the destination already exists with DIFFERENT content — two independent copies now disagree", () => {
    // The failure mode this guards: without it, `copyFileSync` overwrites
    // `dst` unconditionally — replacing the already-migrated, correct
    // destination with whatever a resurrected legacy file happens to
    // contain, silently losing the round history and parked decisions the
    // first migration preserved.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-conflict-legacy-"),
    );
    const newDir = mkdtempSync(join(tmpdir(), "copy-and-remove-conflict-new-"));
    cleanupDirs.push(legacyDir, newDir);
    writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"rounds":99}');
    writeFileSync(join(newDir, "drive-pr-4172.json"), '{"rounds":1}');

    let threw: unknown;
    try {
      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ExitError);
    expect((threw as ExitError).code).toBe(1);
    // Neither copy was touched — the whole point of refusing is to leave
    // both for manual reconciliation rather than guessing which is current.
    expect(readFileSync(join(legacyDir, "drive-pr-4172.json"), "utf8")).toBe(
      '{"rounds":99}',
    );
    expect(readFileSync(join(newDir, "drive-pr-4172.json"), "utf8")).toBe(
      '{"rounds":1}',
    );
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows",
    ),
  )(
    "refuses to delete src on the RESUMABLE path when a concurrent writer appends between the byte-compare and the delete",
    async () => {
      // An unlocked plain-file caller (drive.ts's bare appendFileSync for its
      // log, orphans.ts's bare writeFileSync for .orphan-warned) can write to
      // `src` during the fsync calls between the byte-compare and `rmSync` —
      // silently losing the appended bytes. Modelled the same way as the
      // fsync-spy test above: intercepting `openSync` — what
      // `fsyncDirectoryBestEffort` calls first — to inject the concurrent write
      // exactly where the real race lands, right before the re-check this fix
      // adds.
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const legacyDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-toctou-resumable-legacy-"),
      );
      const newDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-toctou-resumable-new-"),
      );
      cleanupDirs.push(legacyDir, newDir);
      const src = join(legacyDir, "drive-pr-4172.log");
      writeFileSync(src, "round 1\n");
      writeFileSync(join(newDir, "drive-pr-4172.log"), "round 1\n");

      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r" && p === newDir) {
            realFs.appendFileSync(src, "round 2 (concurrent)\n");
          }
          return realFs.openSync(p, flags);
        },
      }));
      try {
        let threw: unknown;
        try {
          copyAndRemove(legacyDir, newDir, "drive-pr-4172.log");
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(1);
        // The concurrently-appended bytes must survive — proof nothing was
        // silently deleted out from under the writer.
        expect(readFileSync(src, "utf8")).toBe(
          "round 1\nround 2 (concurrent)\n",
        );
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it("refuses to delete src on the FRESH-COPY path when a concurrent writer appends between the byte-compare and the delete", async () => {
    // No fsync sits between this branch's own compare (`a`/`b`, both read
    // fresh from disk) and the re-check this fix adds, so the injection
    // point is different from the resumable-path test above: it lands on
    // the `b = readFileSync(dst)` call, chronologically between `a`'s read
    // and the new re-check's read — landing on `a`'s own read would instead
    // trip the PRE-EXISTING `a.equals(b)` check, not the one this test means
    // to exercise.
    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-toctou-fresh-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-toctou-fresh-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const src = join(legacyDir, "drive-pr-4172.log");
    const dst = join(newDir, "drive-pr-4172.log");
    writeFileSync(src, "round 1\n");

    mock.module("node:fs", () => ({
      ...realFs,
      readFileSync: (p: string, enc?: BufferEncoding) => {
        if (p === dst) realFs.appendFileSync(src, "round 2 (concurrent)\n");
        return enc === undefined
          ? realFs.readFileSync(p)
          : realFs.readFileSync(p, enc);
      },
    }));
    try {
      let threw: unknown;
      try {
        copyAndRemove(legacyDir, newDir, "drive-pr-4172.log");
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ExitError);
      expect((threw as ExitError).code).toBe(1);
      expect(readFileSync(src, "utf8")).toBe("round 1\nround 2 (concurrent)\n");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("refuses when the legacy source is a symlink rather than a real file", () => {
    // `existsSync`/`readFileSync`/`copyFileSync`/`fsyncFileSync` all follow a
    // symlink, so without an `lstatSync`-based check a `src` symlink would copy
    // whatever external content its target names and then be removed as if it
    // were a migrated artifact.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-src-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-src-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const outsideDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-src-outside-"),
    );
    cleanupDirs.push(outsideDir);
    const outsideTarget = join(outsideDir, "outside-secret.txt");
    writeFileSync(outsideTarget, "not migratable content");
    symlinkSync(outsideTarget, join(legacyDir, "drive-pr-4172.json"));

    let threw: unknown;
    try {
      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ExitError);
    expect((threw as ExitError).code).toBe(1);
    // Neither the symlink nor its external target was touched, and nothing
    // was published to the destination.
    expect(
      lstatSync(join(legacyDir, "drive-pr-4172.json")).isSymbolicLink(),
    ).toBe(true);
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(false);
  });

  it("refuses when the migrated destination is a symlink, even one whose target byte-matches src", () => {
    // A pre-existing `dst` symlink whose target happens to byte-match `src`
    // would otherwise take the resumable branch — `existsSync`/`readFileSync`
    // both follow it — deleting `src` and letting the migration proceed as if
    // `newDir` held the canonical copy, when it actually just holds a symlink
    // pointing elsewhere.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-dst-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-dst-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"rounds":1}');
    const elsewhereDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-symlink-dst-elsewhere-"),
    );
    cleanupDirs.push(elsewhereDir);
    const elsewhereTarget = join(elsewhereDir, "elsewhere.json");
    writeFileSync(elsewhereTarget, '{"rounds":1}');
    symlinkSync(elsewhereTarget, join(newDir, "drive-pr-4172.json"));

    let threw: unknown;
    try {
      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ExitError);
    expect((threw as ExitError).code).toBe(1);
    // The legacy source survives — it must not be deleted on the strength
    // of a symlinked "destination" that was never verified to be real.
    expect(existsSync(join(legacyDir, "drive-pr-4172.json"))).toBe(true);
  });

  it("refuses when the migrated destination is a DANGLING symlink, rather than following it into the fresh-copy branch", () => {
    // `existsSync(dst)` reports `false` for a dangling symlink even though its
    // directory entry is real, so this case used to fall straight through to
    // the fresh-copy branch below — where `copyFileSync` follows the link and
    // creates the target file wherever it points, outside `newDir` entirely,
    // silently publishing "migrated" content to an unrelated location this
    // script does not own.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-dangling-dst-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-dangling-dst-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    writeFileSync(join(legacyDir, "drive-pr-4172.json"), '{"rounds":1}');
    const elsewhereDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-dangling-dst-elsewhere-"),
    );
    cleanupDirs.push(elsewhereDir);
    const danglingTarget = join(elsewhereDir, "does-not-exist.json");

    symlinkSync(danglingTarget, join(newDir, "drive-pr-4172.json"));
    expect(existsSync(join(newDir, "drive-pr-4172.json"))).toBe(false);

    let threw: unknown;
    try {
      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(ExitError);
    expect((threw as ExitError).code).toBe(1);
    // Nothing was ever written through the dangling link, and the legacy
    // source survives untouched.
    expect(existsSync(danglingTarget)).toBe(false);
    expect(existsSync(join(legacyDir, "drive-pr-4172.json"))).toBe(true);
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows",
    ),
  )(
    "refuses to delete src on the RESUMABLE path when it is swapped for a symlink between the byte-compare and the delete",
    async () => {
      // Same substitution race as the concurrent-append tests above, but for
      // the real-file invariant rather than byte content: a symlink swapped
      // in after the entry check and before the final re-check, pointing at
      // content that happens to byte-match, must still be caught.
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const legacyDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-toctou-symlink-resumable-legacy-"),
      );
      const newDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-toctou-symlink-resumable-new-"),
      );
      cleanupDirs.push(legacyDir, newDir);
      const src = join(legacyDir, "drive-pr-4172.log");
      const elsewhereDir = mkdtempSync(
        join(tmpdir(), "copy-and-remove-toctou-symlink-swapped-in-"),
      );
      cleanupDirs.push(elsewhereDir);
      const elsewhereTarget = join(elsewhereDir, "swapped-in.log");
      writeFileSync(src, "round 1\n");
      writeFileSync(elsewhereTarget, "round 1\n");
      writeFileSync(join(newDir, "drive-pr-4172.log"), "round 1\n");

      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r" && p === newDir) {
            realFs.rmSync(src, { force: true });
            realFs.symlinkSync(elsewhereTarget, src);
          }
          return realFs.openSync(p, flags);
        },
      }));
      try {
        let threw: unknown;
        try {
          copyAndRemove(legacyDir, newDir, "drive-pr-4172.log");
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        expect((threw as ExitError).code).toBe(1);
        // The swapped-in symlink survives untouched — proof nothing was
        // deleted on the strength of a real-file check that ran too early.
        expect(realFs.lstatSync(src).isSymbolicLink()).toBe(true);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it("never follows a symlink swapped in at dst between the initial entryPresent check and the write, on the FRESH-COPY path", async () => {
    // copyPlainSiblingBestEffort below had the identically-shaped gap; this
    // branch shares the same root cause, so the fix has to cover it too —
    // fixing one call site and leaving its sibling vulnerable is exactly
    // the class this repo's own "fix the class, not the reported instance"
    // discipline exists to catch. `entryPresent(dst)` above decides which
    // branch to take; a symlink planted at `dst` AFTER that decision but
    // BEFORE the write used to reach a raw `copyFileSync`, which follows
    // it and writes through to its external target. Fixed by routing the
    // write through `atomicWrite` (fsutil.ts): its publish step is
    // `renameSync`, which REPLACES whatever occupies `dst` — symlink
    // included — without ever opening or following it, so the race has no
    // window to land in regardless of timing.
    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-toctou-symlink-dst-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-toctou-symlink-dst-new-"),
    );
    const elsewhereDir = mkdtempSync(
      join(tmpdir(), "copy-and-remove-toctou-symlink-dst-elsewhere-"),
    );
    cleanupDirs.push(legacyDir, newDir, elsewhereDir);
    const src = join(legacyDir, "drive-pr-4172.json");
    const dst = join(newDir, "drive-pr-4172.json");
    const elsewhereTarget = join(elsewhereDir, "do-not-touch.json");
    writeFileSync(src, '{"rounds":1}');
    writeFileSync(elsewhereTarget, "do-not-touch");

    mock.module("node:fs", () => ({
      ...realFs,
      lstatSync: (p: string, opts?: unknown) => {
        if (p === dst) {
          // Simulate the race: dst becomes a symlink to an external file
          // the instant after entryPresent's own check reports it absent.
          realFs.symlinkSync(elsewhereTarget, dst);
          const e = new Error(
            "ENOENT: no such file or directory",
          ) as NodeJS.ErrnoException;
          e.code = "ENOENT";
          throw e;
        }
        return opts === undefined
          ? realFs.lstatSync(p)
          : realFs.lstatSync(p, opts as never);
      },
    }));
    try {
      copyAndRemove(legacyDir, newDir, "drive-pr-4172.json");
    } finally {
      mock.module("node:fs", () => realFs);
    }

    // The symlink was replaced, never followed: dst is now a real file
    // holding the migrated content, and the symlink's external target was
    // never opened for writing.
    expect(realFs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(readFileSync(dst, "utf8")).toBe('{"rounds":1}');
    expect(readFileSync(elsewhereTarget, "utf8")).toBe("do-not-touch");
    expect(existsSync(src)).toBe(false);
  });
});

describe("copyPlainSiblingBestEffort", () => {
  const cleanupDirs: string[] = [];
  afterAll(() => {
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  });

  it("copies the sibling durably without deleting src", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "copy-plain-sibling-legacy-"));
    const newDir = mkdtempSync(join(tmpdir(), "copy-plain-sibling-new-"));
    cleanupDirs.push(legacyDir, newDir);
    const src = join(legacyDir, "drive-pr-4172.log");
    writeFileSync(src, "round 1\n");

    copyPlainSiblingBestEffort(legacyDir, newDir, "drive-pr-4172.log");

    expect(readFileSync(join(newDir, "drive-pr-4172.log"), "utf8")).toBe(
      "round 1\n",
    );
    // Unlike `copyAndRemove`, `src` is never deleted.
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(src, "utf8")).toBe("round 1\n");
  });

  it.skipIf(
    skipsOnWindows(
      "file-system",
      "fsyncFileSync opens the file read-only and fsync on a read-only handle fails with EPERM on Windows",
    ),
  )(
    "a concurrent append during the copy is never lost, because src is never deleted — even when the torn copy is (correctly) rejected",
    async () => {
      // The exact interleaving: an unlocked writer (drive.ts's bare
      // appendFileSync, or orphans.ts's bare writeFileSync for .orphan-warned)
      // appends while a copy is in flight. `copyAndRemove`'s re-read narrows the
      // window between the last re-read and a delete, but cannot close it (see
      // the two "refuses to delete src ... when a concurrent writer appends"
      // tests above); this function sidesteps the whole class instead, by never
      // reaching a delete at all. The append still makes the just-taken copy
      // stale, so verification still (correctly) refuses to publish it — that
      // part of the behavior is unchanged and appropriate for a best-effort copy.
      // What changed is the consequence: `src` — the only place a retry can
      // recover the appended bytes from — is never touched, where the old
      // copy-then-delete idiom would have destroyed it. Modelled the same way as
      // the tests above — intercepting `openSync` to inject the concurrent write
      // exactly where the real race would land, immediately before this
      // function's own directory fsync.
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      const legacyDir = mkdtempSync(
        join(tmpdir(), "copy-plain-sibling-toctou-legacy-"),
      );
      const newDir = mkdtempSync(
        join(tmpdir(), "copy-plain-sibling-toctou-new-"),
      );
      cleanupDirs.push(legacyDir, newDir);
      const src = join(legacyDir, "drive-pr-4172.log");
      writeFileSync(src, "round 1\n");

      mock.module("node:fs", () => ({
        ...realFs,
        openSync: (p: string, flags: string) => {
          if (flags === "r" && p === newDir) {
            realFs.appendFileSync(src, "round 2 (concurrent)\n");
          }
          return realFs.openSync(p, flags);
        },
      }));
      try {
        let threw: unknown;
        try {
          copyPlainSiblingBestEffort(legacyDir, newDir, "drive-pr-4172.log");
        } catch (e) {
          threw = e;
        }
        expect(threw).toBeInstanceOf(ExitError);
        // The concurrently-appended bytes survive in the legacy original —
        // there is no delete step for them to be lost to, torn copy or not.
        expect(readFileSync(src, "utf8")).toBe(
          "round 1\nround 2 (concurrent)\n",
        );
      } finally {
        mock.module("node:fs", () => realFs);
      }
    },
  );

  it("overwrites an existing destination unconditionally — these files only ever grow by append", () => {
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-overwrite-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-overwrite-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const src = join(legacyDir, "drive-pr-4172.log");
    writeFileSync(src, "round 1\nround 2\n");
    // An earlier run's copy, now stale relative to `src`.
    writeFileSync(join(newDir, "drive-pr-4172.log"), "round 1\n");

    copyPlainSiblingBestEffort(legacyDir, newDir, "drive-pr-4172.log");

    expect(readFileSync(join(newDir, "drive-pr-4172.log"), "utf8")).toBe(
      "round 1\nround 2\n",
    );
  });

  it("refuses when the legacy source is a symlink rather than a real file", () => {
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-symlink-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-symlink-new-"),
    );
    cleanupDirs.push(legacyDir, newDir);
    const outside = join(legacyDir, "outside.log");
    writeFileSync(outside, "not migratable content");
    const src = join(legacyDir, "drive-pr-4172.log");
    symlinkSync(outside, src);

    expect(() =>
      copyPlainSiblingBestEffort(legacyDir, newDir, "drive-pr-4172.log"),
    ).toThrow(ExitError);
    expect(existsSync(join(newDir, "drive-pr-4172.log"))).toBe(false);
  });

  it("replaces a pre-existing dst symlink instead of following it", () => {
    // This function validates only `src` (via `assertRealFile`) before
    // writing to `dst` — unlike `copyAndRemove`, it never checked `dst` at
    // all, so a pre-existing `drive-pr-<pr>.log` or `.orphan-warned`
    // symlink used to be followed by a raw `copyFileSync`, overwriting and
    // fsyncing whatever external file it named. Fixed by routing the write
    // through `atomicWrite` (fsutil.ts), whose publish step is
    // `renameSync` — it replaces the directory entry at `dst`, symlink
    // included, without ever opening or following it, so the external
    // target is never touched regardless of what occupied `dst` beforehand.
    const legacyDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-dst-symlink-legacy-"),
    );
    const newDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-dst-symlink-new-"),
    );
    const elsewhereDir = mkdtempSync(
      join(tmpdir(), "copy-plain-sibling-dst-symlink-elsewhere-"),
    );
    cleanupDirs.push(legacyDir, newDir, elsewhereDir);
    const src = join(legacyDir, "drive-pr-4172.log");
    const dst = join(newDir, "drive-pr-4172.log");
    const elsewhereTarget = join(elsewhereDir, "do-not-touch.log");
    writeFileSync(src, "round 1\n");
    writeFileSync(elsewhereTarget, "do-not-touch");
    symlinkSync(elsewhereTarget, dst);

    copyPlainSiblingBestEffort(legacyDir, newDir, "drive-pr-4172.log");

    expect(lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(readFileSync(dst, "utf8")).toBe("round 1\n");
    expect(readFileSync(elsewhereTarget, "utf8")).toBe("do-not-touch");
    expect(readFileSync(src, "utf8")).toBe("round 1\n");
  });
});

describe("publishFailureHeadline", () => {
  // `scan-failed` used to fall through a two-way ternary into the
  // `foreign-lock` wording — "a drive.ts single-instance lock appeared" printed
  // over what was actually a `readdirSync` failure. Pinning all three as
  // pairwise distinct is what a future two-way regression would violate.
  it("gives scan-failed, foreign-lock and reappeared-content three distinct headlines", () => {
    const scanFailed = publishFailureHeadline("scan-failed");
    const foreignLock = publishFailureHeadline("foreign-lock");
    const reappeared = publishFailureHeadline("reappeared-content");
    expect(new Set([scanFailed, foreignLock, reappeared]).size).toBe(3);
  });

  it("scan-failed names the re-scan failure, not a lock", () => {
    expect(publishFailureHeadline("scan-failed")).toContain("re-scanned");
    expect(publishFailureHeadline("scan-failed")).not.toContain(
      "single-instance lock",
    );
  });

  it("foreign-lock names the drive.ts single-instance lock", () => {
    expect(publishFailureHeadline("foreign-lock")).toContain(
      "single-instance lock",
    );
  });
});
