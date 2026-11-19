/**
 * dispatch: a stage's exit crosses a state schema step that was not
 * additive. The wrapper knows the dispatcher's schema; while its stage runs,
 * the database moves one step ahead to a schema whose minimum reader is newer
 * than the wrapper (built as the historical-schema fixtures build theirs: the
 * shared `MIGRATIONS` and one more entry). A reader on that newer schema then
 * reads the exit and classes the launch as the tick logs it.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { thisHost } from "../../shared/liveness.ts";
import {
  type Migration,
  openReadOnly,
  openTransientDatabase,
} from "../../shared/records/db.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { type ReadRecord, readLaunches } from "../lib/launches.ts";
import { classifyEnded } from "../lib/log.ts";
import { closeStateDb, MIGRATIONS, statePath } from "../lib/state.ts";
import { type World, world } from "./fixtures.ts";
import {
  dispatchState,
  driveRuns,
  earlierRecord,
  waitFor,
} from "./launch-fixtures.ts";
import { claudeRuns } from "./pickup-fixtures.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

/** The newer schema: one step past the wrapper's, which only raises the minimum reader. */
const FENCED: readonly Migration[] = [
  ...MIGRATIONS,
  { additive: false, sql: "SELECT 1;" },
];
/** A newer schema whose step that was not additive renames the column the wrapper writes its exit to. */
const RENAMED: readonly Migration[] = [
  ...MIGRATIONS,
  {
    additive: false,
    sql: "ALTER TABLE launches RENAME COLUMN exit TO ended;",
  },
];

/** A newer schema whose step that was not additive renames a log column a deadline report rewrites. */
const LOG_RENAMED: readonly Migration[] = [
  ...MIGRATIONS,
  {
    additive: false,
    sql: "ALTER TABLE log RENAME COLUMN report_by TO reported_by;",
  },
];

let current: World | null = null;
afterEach(() => {
  if (current !== null) closeStateDb(dispatchState(current));
  current?.close();
  current = null;
});

function startWrapper(w: World, id: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      RUN_TS,
      id,
      "the-token",
    ],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  return async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

/** One read of the database through a connection of the test's own, outside the module's cache. */
function peek<T>(w: World, sql: string, ...args: string[]): T | null {
  const db = new Database(statePath(dispatchState(w)), { readonly: true });
  try {
    return db.query(sql).get(...args) as T | null;
  } finally {
    db.close();
  }
}

/** Whether the supervisor recorded the stage's child, the last write the wrapper's side makes before the stage ends. */
function childRegistered(w: World, id: string): boolean {
  const row = peek<{ child: string | null }>(
    w,
    "SELECT json_extract(claim, '$.supervision.child') AS child FROM launches WHERE id = ?",
    id,
  );
  return row?.child !== null && row?.child !== undefined;
}

/** Move the database to `migrations` as a newer plugin's open does, and return when it did. */
function moveTo(w: World, migrations: readonly Migration[]): number {
  closeStateDb(dispatchState(w));
  const opened = openTransientDatabase({
    path: statePath(dispatchState(w)),
    migrations,
  });
  if (!opened.ok) throw new Error(opened.failure.reason);
  opened.value.close();
  expect(
    peek<{ min_reader: number }>(w, "SELECT min_reader FROM db_meta"),
  ).toEqual({ min_reader: migrations.length });
  return Date.now();
}

/** The launch `id` as a reader on the newer schema reads it, with the class and reason the tick logs for it. */
async function readOnNewer(w: World, id: string) {
  const opened = openReadOnly({
    path: statePath(dispatchState(w)),
    migrations: FENCED,
  });
  if (!opened.ok || opened.value === null)
    throw new Error(opened.ok ? "no database" : opened.failure.reason);
  const { db } = opened.value;
  try {
    const { records } = await readLaunches(dispatchState(w), thisHost(), db);
    const r = records.find((x) => x.record.id === id) as ReadRecord;
    const at = r.state.kind === "ended" ? r.state.exit.at : "";
    return {
      r,
      logged: classifyEnded(r, at, { takenOver: false, merged: null }),
    };
  } finally {
    db.close();
  }
}

describe("a stage's exit across a state schema step that was not additive", () => {
  it("is recorded for a drive, which the newer reader classes by its exit code", async () => {
    const w = world();
    current = w;
    const id = "20261114T124020Z-aaaaaaa1";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    writeFileSync(join(w.dir, "drive-hold"), "");
    writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.STALLED));
    const finished = startWrapper(w, id);
    await waitFor("the stage's child", () => childRegistered(w, id));
    const movedAt = moveTo(w, FENCED);
    rmSync(join(w.dir, "drive-hold"));
    const r = await finished();
    expectSpawnExit(r, DRIVE_EXIT.STALLED);
    expect(r.stderr).not.toContain("newer plugin");
    expect(driveRuns(w)).toHaveLength(1);

    // This copy's own open still refuses the database.
    const own = openReadOnly({
      path: statePath(dispatchState(w)),
      migrations: MIGRATIONS,
    });
    expect(own.ok ? null : own.failure.code).toBe("newer-schema");

    const { r: read, logged } = await readOnNewer(w, id);
    expect(read.state.kind).toBe("ended");
    if (read.state.kind !== "ended") return;
    expect(read.state.exit.code).toBe(DRIVE_EXIT.STALLED);
    expect(read.state.exit.signal).toBeNull();
    expect(Date.parse(read.state.exit.at)).toBeGreaterThanOrEqual(movedAt);
    expect(logged).toEqual({
      class: "stalled",
      reason: `exit ${DRIVE_EXIT.STALLED} (stalled)`,
    });
  }, 60_000);

  it("is recorded for a pickup stopped at its deadline with no result, which the newer reader logs by how its session exited", async () => {
    const w = world();
    current = w;
    const id = "20261114T141514Z-aaaaaaa2";
    earlierRecord(w, {
      id,
      account: "a",
      token: "the-token",
      action: "pickup",
      headless: true,
      pr: null,
      item: "#12",
      passTimeoutSec: 4,
    });
    const finished = startWrapper(w, id);
    await waitFor("the stage's child", () => childRegistered(w, id));
    const movedAt = moveTo(w, FENCED);
    const r = await finished();
    expect(r.stderr).not.toContain("newer plugin");
    expect(claudeRuns(w)).toHaveLength(1);

    const { r: read, logged } = await readOnNewer(w, id);
    expect(read.result).toBeNull();
    expect(read.state.kind).toBe("ended");
    if (read.state.kind !== "ended") return;
    expect(Date.parse(read.state.exit.at)).toBeGreaterThanOrEqual(movedAt);
    const how = read.state.exit.code ?? read.state.exit.signal;
    expect(how).not.toBeNull();
    expect(logged).toEqual({
      class: "died",
      reason: `no result recorded; its session exited ${how}`,
    });
    expect(logged.reason).not.toContain("its wrapper is gone without an exit");
  }, 60_000);

  it("is refused before the stage starts: nothing starts, and the wrapper exits 2 naming the database", async () => {
    const w = world();
    current = w;
    const id = "20261114T150000Z-aaaaaaa3";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    moveTo(w, FENCED);
    const r = await startWrapper(w, id)();
    expectSpawnExit(r, 2);
    expect(r.stderr.trim()).toBe(
      `jig dispatch run: ${statePath(dispatchState(w))} is at state schema version ${FENCED.length}, which a newer plugin wrote and which needs a reader of version ${FENCED.length} or later; this plugin knows version ${MIGRATIONS.length}. Update the plugin, or move the file aside to start a new one`,
    );
    expect(driveRuns(w)).toEqual([]);
  });

  it("refused after the stage ran, by a newer schema without the exit column, says the stage ran and exits with its code", async () => {
    const w = world();
    current = w;
    const id = "20261114T160000Z-aaaaaaa4";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    writeFileSync(join(w.dir, "drive-hold"), "");
    writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.STALLED));
    const finished = startWrapper(w, id);
    await waitFor("the stage's child", () => childRegistered(w, id));
    moveTo(w, RENAMED);
    rmSync(join(w.dir, "drive-hold"));
    const r = await finished();
    expectSpawnExit(r, DRIVE_EXIT.STALLED);
    expect(r.stderr).toContain(
      `jig dispatch run: the stage ran and ended (exit ${DRIVE_EXIT.STALLED}), and its exit is not recorded: `,
    );
    expect(r.stderr).toContain("it lacks launches.exit");
    expect(r.stderr).not.toContain("nothing");
    expect(
      peek<{ ended: string | null }>(
        w,
        "SELECT ended FROM launches WHERE id = ?",
        id,
      ),
    ).toEqual({ ended: null });
  }, 60_000);

  it("refused after the stage ran, by a newer schema without a log column a report rewrites, is not taken for a compatible one", async () => {
    const w = world();
    current = w;
    const id = "20261114T160000Z-aaaaaaa5";
    earlierRecord(w, { id, account: "a", token: "the-token" });
    writeFileSync(join(w.dir, "drive-hold"), "");
    writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.STALLED));
    const finished = startWrapper(w, id);
    await waitFor("the stage's child", () => childRegistered(w, id));
    moveTo(w, LOG_RENAMED);
    rmSync(join(w.dir, "drive-hold"));
    const r = await finished();
    expectSpawnExit(r, DRIVE_EXIT.STALLED);
    expect(r.stderr).toContain(
      `jig dispatch run: the stage ran and ended (exit ${DRIVE_EXIT.STALLED}), and its exit is not recorded: `,
    );
    expect(r.stderr).toContain("it lacks log.report_by");
  }, 60_000);
});
