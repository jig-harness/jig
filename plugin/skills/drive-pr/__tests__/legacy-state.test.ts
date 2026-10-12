/**
 * legacy-state.test.ts — the guard that refuses to let `resolveStateDir`
 * silently move a clone onto a fresh, empty new-location state dir while the
 * OLD `--git-common-dir` default still holds drive-pr state nobody has migrated
 * (a failure already hit once, by hand — see `legacy-state.ts`'s own doc
 * comment).
 *
 * Both functions under test operate on plain directories, never on a real
 * git repo — `legacyDir`/`newDir` are just paths, so these tests use scratch
 * temp directories rather than `git init`.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import {
  ensureMigratedFromLegacy,
  legacyFootprint,
  migratedMarkerPath,
} from "../scripts/lib/state/legacy-state.ts";

function scratchDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `legacy-state-${name}-`));
}

describe("legacyFootprint", () => {
  it("is empty for a directory holding only ordinary git contents", () => {
    const legacy = scratchDir("git-only");
    try {
      writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(legacy, "config"), "[core]\n");
      writeFileSync(join(legacy, "packed-refs"), "# pack-refs\n");
      expect(legacyFootprint(legacy)).toEqual([]);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("recognises the durable state file, a PR lease, a tree lease, and a drive.ts single-instance lock", () => {
    const legacy = scratchDir("recognised");
    try {
      const stateFile = "drive-pr-4172.json";
      const prLease = "pr-drive-lease-4172-wt-00112233445566aa.json";
      const treeLease = "drive-tree-lease-wt-00112233445566aa.json";
      const foreignLock = "pr-drive-4172.lock";
      for (const n of [stateFile, prLease, treeLease, foreignLock]) {
        writeFileSync(join(legacy, n), "{}");
      }
      writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
      const found = legacyFootprint(legacy).sort();
      expect(found).toEqual(
        [stateFile, prLease, treeLease, foreignLock].sort(),
      );
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("reads a NONEXISTENT legacy dir (ENOENT) as empty (nothing to migrate), not an error", () => {
    expect(
      legacyFootprint(join(tmpdir(), "legacy-state-never-existed")),
    ).toEqual([]);
  });

  it("refuses (ExitError 2) on a readdirSync failure that is NOT ENOENT, rather than reading it as empty", async () => {
    // The directory genuinely exists here — unlike the ENOENT case above,
    // an EACCES/EIO means state may exist but could not be inspected, and
    // silently treating that as "nothing to migrate" is exactly what would
    // let `ensureMigratedFromLegacy()` write the migrated marker over state
    // it never looked at. Modelled via
    // `mock.module`, not a real chmod-hostile fixture: `lock.test.ts`
    // already documents why `chmodSync` cannot reliably induce EACCES here
    // — running as root (this reviewer's own sandbox, and plenty of CI/dev
    // containers) bypasses directory permission checks entirely.
    const legacy = scratchDir("unreadable");
    try {
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      mock.module("node:fs", () => ({
        ...realFs,
        readdirSync: (p: string) => {
          if (p === legacy) {
            const err = new Error("simulated EACCES") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return realFs.readdirSync(p);
        },
      }));
      try {
        let caught: unknown;
        try {
          legacyFootprint(legacy);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ExitError);
        expect((caught as ExitError).code).toBe(2);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });
});

describe("ensureMigratedFromLegacy", () => {
  it("fsyncs the parent directory after creating a brand-new state directory", async () => {
    // `mkdirSync` alone does not make the new directory ENTRY durable — a crash
    // right after it, before its parent's own entry for it commits, can lose
    // `newDir` even though every write later fsynced inside it was individually
    // durable. Spies on `openSync` (what `fsyncDirectoryBestEffort` calls
    // first) since a successful fsync has no other observable side effect.
    const legacy = scratchDir("fsync-new-legacy");
    const parent = scratchDir("fsync-new-parent");
    const newDir = join(parent, "new");
    try {
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
        writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
        ensureMigratedFromLegacy(legacy, newDir);
        expect(openedForSync).toContain(parent);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("STILL fsyncs the parent when newDir already existed — presence alone is not proof a prior fsync completed", async () => {
    // A prior call could have had mkdirSync succeed and then crash (or its own
    // fsync throw and abort) before ever confirming newDir's entry — leaving
    // newDir visible on this retry. Skipping the fsync merely because the
    // directory already exists would let that unconfirmed entry stay
    // unconfirmed forever; a retry must always reconfirm dirname(newDir).
    const legacy = scratchDir("fsync-existing-legacy");
    const parent = scratchDir("fsync-existing-parent");
    const newDir = join(parent, "new");
    mkdirSync(newDir, { recursive: true });
    try {
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
        writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
        ensureMigratedFromLegacy(legacy, newDir);
        expect(openedForSync).toContain(parent);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fsyncs EVERY newly created ancestor, not just newDir’s immediate parent — the multi-level case", async () => {
    // `{ recursive: true }` can create several path components at once (a fresh
    // $HOME with no `~/.local/state/groundwork` at all yet creates it,
    // `drive-pr`, and the clone directory in one `mkdirSync` call). Fsyncing
    // only `dirname(newDir)` protects the deepest entry alone — the newly
    // created intermediate levels' own entries in THEIR parents would still be
    // uncommitted.
    const legacy = scratchDir("fsync-multilevel-legacy");
    const root = scratchDir("fsync-multilevel-root");
    // Three levels new: root/a, root/a/b, root/a/b/c (== newDir).
    const level1 = join(root, "a");
    const level2 = join(level1, "b");
    const newDir = join(level2, "c");
    try {
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
        writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
        ensureMigratedFromLegacy(legacy, newDir);
        // Every ancestor's own PARENT is fsynced — root (protects `a`'s
        // entry), level1 (protects `b`'s entry), level2 (protects `c`'s
        // entry, == newDir's immediate parent, the single-level case).
        expect(openedForSync).toContain(root);
        expect(openedForSync).toContain(level1);
        expect(openedForSync).toContain(level2);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proceeds and writes the marker when the legacy dir has nothing to migrate", () => {
    const legacy = scratchDir("empty-legacy");
    const parent = scratchDir("empty-new-parent");
    const newDir = join(parent, "new");
    try {
      writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
      expect(() => ensureMigratedFromLegacy(legacy, newDir)).not.toThrow();
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(migratedMarkerPath(newDir))).toBe(true);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses (ExitError 2) when the legacy dir holds an unmigrated footprint", () => {
    const legacy = scratchDir("dirty-legacy");
    const parent = scratchDir("dirty-new-parent");
    const newDir = join(parent, "new");
    try {
      writeFileSync(join(legacy, "drive-pr-4172.json"), "{}");
      let caught: unknown;
      try {
        ensureMigratedFromLegacy(legacy, newDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ExitError);
      expect((caught as ExitError).code).toBe(2);
      // The marker must NOT exist — a refusal is not a silent "migrated".
      expect(existsSync(migratedMarkerPath(newDir))).toBe(false);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("re-checks LIVE immediately before publishing, catching a legacy write that lands after the first scan", async () => {
    // An older process can begin its first legacy write after the initial
    // `legacyFootprint()` scan returns empty but before the marker is written —
    // the original code trusted that one snapshot and published anyway,
    // abandoning the old process's state permanently (every later
    // resolveStateDir() call trusts the marker without re-scanning). Modelled
    // by making the SECOND readdirSync call (the re-check) see content the
    // first one did not.
    const legacy = scratchDir("toctou-legacy");
    const parent = scratchDir("toctou-new-parent");
    const newDir = join(parent, "new");
    try {
      const actualFs = await import("node:fs");
      const realFs = { ...actualFs };
      let calls = 0;
      mock.module("node:fs", () => ({
        ...realFs,
        readdirSync: (p: string) => {
          if (p === legacy) {
            calls += 1;
            if (calls === 1) return [];
            return ["drive-pr-4172.json"];
          }
          return realFs.readdirSync(p);
        },
      }));
      try {
        let caught: unknown;
        try {
          ensureMigratedFromLegacy(legacy, newDir);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(ExitError);
        expect((caught as ExitError).code).toBe(2);
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(existsSync(migratedMarkerPath(newDir))).toBe(false);
      } finally {
        mock.module("node:fs", () => realFs);
      }
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("skips the legacy scan entirely once the marker exists, even if the legacy dir now looks dirty", () => {
    // The whole point of the marker: once a clone has migrated, later calls
    // must not pay (or even attempt) another readdir of the legacy location
    // — that readdir is exactly the cost this relocation exists to
    // eliminate. Proven here by making the legacy dir "dirty" AFTER the
    // marker is written and confirming no refusal happens.
    const legacy = scratchDir("post-migration-legacy");
    const parent = scratchDir("post-migration-new-parent");
    const newDir = join(parent, "new");
    try {
      writeFileSync(join(legacy, "HEAD"), "ref: refs/heads/main\n");
      ensureMigratedFromLegacy(legacy, newDir);
      expect(existsSync(migratedMarkerPath(newDir))).toBe(true);

      writeFileSync(join(legacy, "drive-pr-9999.json"), "{}");
      expect(() => ensureMigratedFromLegacy(legacy, newDir)).not.toThrow();
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("names the found entries and the migration script in the refusal message", () => {
    // `fail()` throws a bare `ExitError` whose OWN `.message` is generic
    // ("exit 2") — the actual content goes to stderr via `console.error`, so
    // that is what this test has to capture to pin the refusal is
    // actionable, not just "some error happened".
    const legacy = scratchDir("named-legacy");
    const parent = scratchDir("named-new-parent");
    const newDir = join(parent, "new");
    const printed: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
    try {
      writeFileSync(join(legacy, "drive-pr-4172.json"), "{}");
      expect(() => ensureMigratedFromLegacy(legacy, newDir)).toThrow();
      const message = printed.join("\n");
      expect(message).toContain("drive-pr-4172.json");
      expect(message).toContain("migrate-legacy-state.ts");
      expect(readdirSync(newDir)).not.toContain(".migrated-from-legacy");
    } finally {
      console.error = originalError;
      rmSync(legacy, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
