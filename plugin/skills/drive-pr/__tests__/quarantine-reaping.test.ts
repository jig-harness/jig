import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { lockIdentity } from "../../../shared/liveness.ts";
import { DB_FILE, driveDb } from "../scripts/lib/state/db.ts";
import {
  readLockRow,
  releaseLockRow,
  takeLockRow,
} from "../scripts/lib/state/lock.ts";
import { judgeQuarantine } from "../scripts/lib/state/quarantine.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const REAP = join(import.meta.dir, "../scripts/reap-state.ts");
const OLD = "drive-pr-999.json.lock.stale.owner.0123456789abcdef01234567";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "quarantine-"));
  roots.push(root);
  const dir = scopedStateDir(root);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
function age(path: string, days = 2) {
  const when = (Date.now() - days * 86_400_000) / 1000;
  utimesSync(path, when, when);
}
function quarantine(dir: string) {
  const path = join(dir, OLD);
  mkdirSync(path);
  writeFileSync(join(path, "tombstone"), "retired");
  age(join(path, "tombstone"));
  age(path);
  const marker = join(
    dir,
    "pr-drive-999.lock.recovering.stale.owner.abcdef0123456789abcdef01",
  );
  writeFileSync(marker, "marker");
  age(marker);
  return [path, marker];
}
function reap(root: string, dir: string, del = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("DRIVE_PR_") && !k.startsWith("GIT_"),
    ),
  );
  const run = Bun.spawnSync(
    [process.execPath, REAP, "--json", ...(del ? ["--delete"] : [])],
    {
      env: {
        ...env,
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        DRIVE_PR_STATE_DIR: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(run, 0);
  return JSON.parse(run.stdout.toString()) as {
    retire: { id: string; entries: number; bytes: number | null }[];
    keep: { id: string; reason: string; bytes: number | null }[];
    entriesRemoved: number;
  };
}
describe("obsolete file-lock quarantine", () => {
  it("keeps an already-verified descendant written during verification", () => {
    const { dir } = setup();
    const paths = quarantine(dir);
    const stat = fs.lstatSync;
    let visits = 0;
    const probe = spyOn(fs, "lstatSync").mockImplementation(((
      path: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      if (String(path) === paths[1] && ++visits === 2)
        writeFileSync(join(paths[0] as string, "tombstone"), "new data");
      return stat(path, options);
    }) as typeof fs.lstatSync);
    try {
      expect(
        judgeQuarantine(
          dir,
          paths.map((path) => basename(path)),
        ).action,
      ).toBe("keep");
    } finally {
      probe.mockRestore();
    }
  });
  it("keeps descendants changed while later members are measured", () => {
    for (const addition of [false, true]) {
      const { dir } = setup();
      const paths = quarantine(dir);
      const stat = fs.lstatSync;
      let changed = false;
      const probe = spyOn(fs, "lstatSync").mockImplementation(((
        path: fs.PathLike,
        options?: fs.StatOptions,
      ) => {
        if (String(path) === paths[1] && !changed) {
          changed = true;
          writeFileSync(
            join(paths[0] as string, addition ? "fresh" : "tombstone"),
            "new data",
          );
        }
        return stat(path, options);
      }) as typeof fs.lstatSync);
      try {
        expect(
          judgeQuarantine(
            dir,
            paths.map((path) => basename(path)),
          ).action,
        ).toBe("keep");
        expect(changed).toBe(true);
      } finally {
        probe.mockRestore();
      }
    }
  });
  it.skipIf(
    skipsOnWindows(
      "file-system",
      "Windows chmod cannot remove all POSIX read bits",
    ),
  )("keeps a mode-000 regular file", () => {
    const { dir } = setup();
    const paths = quarantine(dir);
    fs.chmodSync(paths[1] as string, 0);
    try {
      expect(
        judgeQuarantine(
          dir,
          paths.map((path) => basename(path)),
        ).action,
      ).toBe("keep");
    } finally {
      fs.chmodSync(paths[1] as string, 0o600);
    }
  });
  it("retires displaced reaper locks and recovery gates", () => {
    const { root, dir } = setup();
    const paths = ["", ".recovering"].map((gate) =>
      join(dir, `.reap-state-delete.lock${gate}.stale.owner.generation`),
    );
    for (const path of paths) {
      mkdirSync(path);
      age(path);
    }
    expect(reap(root, dir).retire[0]?.entries).toBe(2);
    expect(reap(root, dir, true).entriesRemoved).toBe(2);
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });
  it("keeps a family when a fresh member appeared after the initial listing", () => {
    const { dir } = setup();
    quarantine(dir);
    const initial = [
      OLD,
      "pr-drive-999.lock.recovering.stale.owner.abcdef0123456789abcdef01",
    ];
    writeFileSync(join(dir, "pr-drive-999.lock.stale.new-generation"), "new");
    expect(judgeQuarantine(dir, initial).action).toBe("keep");
  });
  it("lists old entries as a family of their own, and --delete removes them, for a clone never imported", () => {
    const { root, dir } = setup();
    const paths = quarantine(dir);
    const dry = reap(root, dir);
    expect(existsSync(join(dirname(dir), DB_FILE))).toBe(false);
    expect(dry.keep).toEqual([]);
    expect(dry.retire).toHaveLength(1);
    expect(dry.retire[0]?.id).toBe(`quarantine:${basename(dir)}`);
    expect(dry.retire[0]?.entries).toBe(2);
    expect(dry.retire[0]?.bytes).toBeGreaterThanOrEqual(13);
    for (const path of paths) expect(existsSync(path)).toBe(true);
    const wet = reap(root, dir, true);
    expect(wet.entriesRemoved).toBe(2);
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });
  it("retires them beside earlier-release files that have been idle for a day", () => {
    const { root, dir } = setup();
    const paths = quarantine(dir);
    for (const name of [
      "drive-pr-999.json",
      "pr-drive-lease-999-wt-0123456789abcdef.json",
      "ledger-driver-999.json",
    ]) {
      const file = join(dir, name);
      writeFileSync(file, "{}");
      age(file);
    }
    expect(reap(root, dir, true).entriesRemoved).toBe(2);
    for (const path of paths) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, "drive-pr-999.json"))).toBe(true);
  });
  it("keeps every entry while a file of the earlier release was written within a day", () => {
    for (const name of [
      "drive-pr-999.json",
      "pr-drive-lease-999-wt-0123456789abcdef.json",
      "drive-tree-lease-wt-0123456789abcdef.json",
      "ledger-driver-999.json",
      "drive-pr-999.ready-claim",
    ]) {
      const { root, dir } = setup();
      const paths = quarantine(dir);
      writeFileSync(join(dir, name), "{}");
      const run = reap(root, dir, true);
      expect(run.retire).toEqual([]);
      expect(
        run.keep.find((k) => k.id.startsWith("quarantine:"))?.reason,
      ).toContain("earlier release");
      for (const path of paths) expect(existsSync(path)).toBe(true);
    }
  });
  it("keeps the entire family when a member or a descendant is recent", () => {
    for (const descendant of [false, true]) {
      const { root, dir } = setup();
      const paths = quarantine(dir);
      age(
        descendant
          ? join(paths[0] as string, "tombstone")
          : (paths[1] as string),
        0,
      );
      expect(reap(root, dir, true).retire).toEqual([]);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    }
  });
  it("keeps quarantine beside any legacy lock or recovery gate, including an unreadable holder", () => {
    for (const lock of [
      "pr-drive-999.lock",
      "drive-pr-999.json.lock.recovering",
      ".reap-state-delete.lock",
      ".reap-state-delete.lock.recovering",
    ]) {
      const { root, dir } = setup();
      const paths = quarantine(dir);
      mkdirSync(join(dir, lock));
      expect(reap(root, dir, true).retire).toEqual([]);
      for (const path of paths) expect(existsSync(path)).toBe(true);
    }
  });
  it.skipIf(
    skipsOnWindows(
      "file-system",
      "creating a symbolic link needs Windows privileges",
    ),
  )("keeps an unreadable quarantine member", () => {
    const { root, dir } = setup();
    const paths = quarantine(dir);
    symlinkSync(join(root, "missing"), join(paths[0] as string, "unknown"));
    age(paths[0] as string);
    expect(reap(root, dir, true).retire).toEqual([]);
    for (const path of paths) expect(existsSync(path)).toBe(true);
  });
});

describe("database lock displacement", () => {
  it("displacing a lock's holder many times in a row leaves one row, and nothing once released", () => {
    // Each displacement replaces the holder's row in place: one row while the
    // lock is held, and no quarantine entry, tombstone or sibling in the
    // clone's directory, however fast the displacements come.
    const { dir } = setup();
    const drive = driveDb(dir);
    const take = (token: string) =>
      takeLockRow(drive, "drive-pr-999", readLockRow(drive, "drive-pr-999"), {
        token,
        label: "drive.ts",
        holder: lockIdentity(),
        detail: null,
      });
    const rows = () =>
      drive.db
        .query("SELECT name FROM locks WHERE clone = ?")
        .all(drive.clone) as { name: string }[];
    expect(take("holder0")).toBe(true);
    const before = fs.readdirSync(dir).sort();
    for (let i = 1; i <= 300; i++) expect(take(`holder${i}`)).toBe(true);
    expect(rows()).toEqual([{ name: "drive-pr-999" }]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(releaseLockRow(drive, "drive-pr-999", "holder300")).toBe(true);
    expect(rows()).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});
