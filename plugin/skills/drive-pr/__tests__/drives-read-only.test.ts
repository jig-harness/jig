/**
 * `drives-read-only.ts --json`: the listing a reader that is not a driver
 * runs (`jig ask`). Opening the drive's database creates it, migrates its
 * schema and reads the clone's state directory in, so this lists only a
 * database that is already current and leaves the file as it found it:
 * none is no drives, one behind, or not yet read in, is exit 4 naming why.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { closeDatabase } from "../../../shared/records/db.ts";
import { DRIVE_DB_VERSION, dbPathFor } from "../scripts/lib/state/db.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { putLock } from "./state-rows.ts";

const DRIVES = join(import.meta.dir, "..", "scripts", "drives-read-only.ts");

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "drives-read-only-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function freshStateDir(): string {
  return scopedStateDir(join(root, `state-${n++}`));
}

async function list(
  stateDir: string,
  args = ["--json"],
  script = DRIVES,
  extraEnv: Record<string, string> = {},
) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_") && !k.startsWith("DRIVE_PR_"))
      env[k] = v;
  env.DRIVE_PR_STATE_DIR = stateDir;
  Object.assign(env, extraEnv);
  const child = Bun.spawn([process.execPath, script, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A clone with one lock held, its database closed so the file holds everything. */
function drivenClone(): { stateDir: string; db: string } {
  const stateDir = freshStateDir();
  putLock(stateDir, "pr-drive-4242", { label: "drive.ts" });
  const db = dbPathFor(stateDir);
  closeDatabase(db);
  return { stateDir, db };
}

/** Edit the database file the way an older plugin's would have left it. */
function edit(db: string, sql: string): void {
  const raw = new Database(db);
  raw.run(sql);
  raw.close();
}

describe("drives-read-only.ts --json", () => {
  it("lists a current database as it is, byte for byte", async () => {
    const { stateDir, db } = drivenClone();
    const before = readFileSync(db);
    const r = await list(stateDir);
    expectSpawnExit(r, 0);
    const rows = (JSON.parse(r.stdout) as { rows: Array<{ key: string }> })
      .rows;
    expect(rows.map((row) => row.key)).toContain("4242");
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("lists no drives where no driver ever created the database, and creates none", async () => {
    const stateDir = freshStateDir();
    const r = await list(stateDir);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({ stateDir, rows: [] });
    expect(existsSync(dbPathFor(stateDir))).toBe(false);
  });

  it("declines a database one schema behind, naming why, and leaves it unchanged", async () => {
    const { stateDir, db } = drivenClone();
    edit(db, `PRAGMA user_version = ${DRIVE_DB_VERSION - 1}`);
    const before = readFileSync(db);
    const r = await list(stateDir);
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain(
      `schema version ${DRIVE_DB_VERSION - 1}, and a driver's next run brings it forward`,
    );
    expect(r.stdout).toBe("");
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("declines a clone whose state directory was not read in yet, and leaves it unchanged", async () => {
    const { stateDir, db } = drivenClone();
    edit(db, "DELETE FROM imports");
    const before = readFileSync(db);
    const r = await list(stateDir);
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("has not read this clone's state directory in");
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("opens read-only throughout: a database that changed after the readiness check is declined, not migrated", async () => {
    const { stateDir, db } = drivenClone();
    edit(db, "DELETE FROM imports");
    const before = readFileSync(db);
    const r = await list(
      stateDir,
      ["--json"],
      join(import.meta.dir, "..", "scripts", "drives.ts"),
      { JIG_DRIVE_DB_READ_ONLY: "1" },
    );
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("has not read this clone's state directory in");
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it("checks each clone's readiness when one process reads two clones of one database", async () => {
    const { stateDir } = drivenClone();
    const sibling = join(dirname(stateDir), "other-clone");
    mkdirSync(sibling);
    const script = `
      const { driveDb } = await import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "lib", "state", "db.ts"))});
      try {
        driveDb(process.argv[1]);
        driveDb(process.argv[2]);
      } catch (e) {
        process.exit(e.code ?? 1);
      }
    `;
    const child = Bun.spawnSync(
      [process.execPath, "-e", script, stateDir, sibling],
      {
        env: { ...process.env, JIG_DRIVE_DB_READ_ONLY: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(child, 4);
    expect(child.stderr.toString()).toContain(
      "has not read this clone's state directory in",
    );
  });

  it("takes --json alone", async () => {
    const r = await list(freshStateDir(), ["--doctor"]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("usage: drives-read-only.ts --json");
  });
});
