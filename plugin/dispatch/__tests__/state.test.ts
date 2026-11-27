/**
 * The state database through real ticks: the first tick on a machine
 * creates it at the plugin's schema version, a database a newer plugin
 * wrote is refused with its version named, and a tick killed between a
 * launch record's end and its outcome row leaves, after the next tick,
 * exactly one row: the two are one transaction. A record only a person can
 * settle is removed with `jig dispatch clear`.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { processTable } from "../../shared/process-table.ts";
import { PICKUP_SUCCESSORS } from "../lib/launch-conditional-result.ts";
import { readRecord } from "../lib/launches.ts";
import { PICKUP_SUCCESSOR_SCHEMA } from "../lib/pickup-successor-schema.ts";
import { bootId } from "../../shared/liveness.ts";
import { readRows } from "../lib/log.ts";
import { MIGRATIONS, SCHEMA_VERSION, statePath } from "../lib/state.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import {
  claimed,
  dispatchState,
  earlierRecord,
  recordIds,
  waitFor,
} from "./launch-fixtures.ts";

const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const CONFIG = `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`;
const RECORD = "20261101T080000Z-eeeeeeee";

let current: World | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  return w;
}

/** A connection of the test's own, outside the plugin's cache. */
function connect(w: World): Database {
  const db = new Database(statePath(dispatchState(w)));
  cleanups.push(() => db.close());
  return db;
}

describe("the state database", () => {
  it("is created by the first tick on a machine, at the plugin's schema version", async () => {
    const w = fixture();
    expect(existsSync(statePath(dispatchState(w)))).toBe(false);
    expectSpawnExit(await w.dispatch(["--repo", w.repo, "--json"]), 0);
    const db = connect(w);
    expect(db.query("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    const plan = db
      .query<{ detail: string }, Record<string, string | number>>(
        `EXPLAIN QUERY PLAN ${PICKUP_SUCCESSORS}`,
      )
      .all({ $repo: SLUG, $item: "#1", $at: "", $ordinal: 0 })
      .map(({ detail }) => detail)
      .join("\n");
    expect(plan).toContain("USING INDEX launches_pickup_successors");
    expect(plan).toContain("SEARCH member USING");
    expect(plan).toContain("USING INDEX launches_unreadable_pickups");
    expect(plan).not.toMatch(/SCAN (launches|member)/);
    const tables = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "launches",
        "thread_samples",
        "waiting_episodes",
        "notices",
        "nudges",
        "followup_outcomes",
        "idle",
        "log",
      ]),
    );
  });

  it("backfills readable batch members from an older database with damaged pickup records", () => {
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    const upgrade = MIGRATIONS.findIndex(
      ({ sql }) => sql === PICKUP_SUCCESSOR_SCHEMA,
    );
    expect(upgrade).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, upgrade))
      db.exec(migration.sql);
    const insert = db.query(
      "INSERT INTO launches (id, repo, action, item, created_at, record) VALUES (?, ?, 'pickup', '#1', ?, ?)",
    );
    insert.run("damaged", SLUG, "2026-11-01", "{");
    insert.run(
      "batch",
      SLUG,
      "2026-11-01",
      JSON.stringify({ batchItems: ["damaged", { key: "#2" }] }),
    );

    db.exec(PICKUP_SUCCESSOR_SCHEMA);
    expect(
      db.query("SELECT item, launch FROM pickup_batch_members").all(),
    ).toEqual([{ item: "#2", launch: "batch" }]);
    const candidates = db.query(PICKUP_SUCCESSORS).all({
      $repo: SLUG,
      $item: "#9",
      $at: "2026-10-31",
      $ordinal: 0,
    });
    expect(candidates.map((row) => (row as { id: string }).id).sort()).toEqual([
      "batch",
      "damaged",
    ]);
  });

  it("lists pickups no writer verified as launch records as successor candidates, and not verified ones", () => {
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const insert = db.query(
      "INSERT INTO launches (id, repo, action, item, created_at, record, record_reads) VALUES (?, ?, 'pickup', '#1', ?, ?, ?)",
    );
    insert.run("empty", SLUG, "2026-11-01", "{}", 0);
    insert.run("version-2", SLUG, "2026-11-01", '{"version":2}', 0);
    insert.run("verified", SLUG, "2026-11-01", "{}", 1);
    const ids = db
      .query(PICKUP_SUCCESSORS)
      .all({ $repo: SLUG, $item: "#9", $at: "2026-10-31", $ordinal: 0 })
      .map((row) => (row as { id: string }).id)
      .sort();
    expect(ids).toEqual(["empty", "version-2"]);
  });

  it("rebuilds a pickup's batch membership and clears its marker when the stored record changes", () => {
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    db.query(
      "INSERT INTO launches (id, repo, action, item, created_at, record, record_reads) VALUES ('b', ?, 'pickup', '#1', '2026-11-01', ?, 1)",
    ).run(SLUG, JSON.stringify({ batchItems: [{ key: "#2" }] }));
    db.query("UPDATE launches SET record = ? WHERE id = 'b'").run(
      JSON.stringify({ batchItems: [{ key: "#3" }] }),
    );
    expect(
      db.query("SELECT item, launch FROM pickup_batch_members").all(),
    ).toEqual([{ item: "#3", launch: "b" }]);
    expect(db.query("SELECT record_reads FROM launches").get()).toEqual({
      record_reads: 0,
    });
  });

  it("is refused, with its version named, when a newer plugin wrote it", async () => {
    const w = fixture();
    expectSpawnExit(await w.dispatch(["--repo", w.repo, "--json"]), 0);
    const newer = SCHEMA_VERSION + 1;
    connect(w).run(`PRAGMA user_version = ${newer}`);
    for (const args of [["--repo", w.repo, "--json"], ["log"]]) {
      const refused = await w.dispatch(args);
      expectSpawnExit(refused, 2);
      expect(refused.stderr).toContain(
        `state schema version ${newer}, which a newer plugin wrote`,
      );
    }
    expect(connect(w).query("PRAGMA user_version").get()).toEqual({
      user_version: newer,
    });
  });
});

/** Whether another connection holds the write lock: a write transaction cannot begin. */
function writeLocked(db: Database): boolean {
  try {
    db.run("BEGIN IMMEDIATE");
    db.run("ROLLBACK");
    return false;
  } catch (error) {
    if (/locked|busy/i.test(String(error))) return true;
    throw error;
  }
}

describe("a tick killed between a launch record's end and its outcome row", () => {
  it("leaves, after the next tick, exactly one row", async () => {
    const w = fixture();
    const state = dispatchState(w);
    // A drive this machine launched, which ended with exit 0 and has no row yet.
    earlierRecord(w, {
      id: RECORD,
      account: "a",
      createdAt: "2026-11-01T08:00:00.000Z",
    });
    claimed(
      w,
      RECORD,
      {
        hostId: "",
        host: "elsewhere",
        bootId: "",
        pid: 1,
        start: "",
        claimedAt: "2026-11-01T08:00:01.000Z",
      },
      0,
    );
    // The row's write never finishes: the tick is inside it when it is killed.
    const db = connect(w);
    db.run("PRAGMA busy_timeout = 0");
    db.run("CREATE TABLE stall (x INTEGER)");
    db.run("INSERT INTO stall VALUES (0)");
    for (let i = 0; i < 13; i++)
      db.run("INSERT INTO stall SELECT x FROM stall");
    db.run(
      "CREATE TRIGGER stall_log BEFORE INSERT ON log BEGIN SELECT count(*) FROM stall a, stall b, stall c; END",
    );

    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--config=${BUNFIG}`,
        JIG,
        "dispatch",
        "--repo",
        w.repo,
        "--json",
      ],
      { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
    );
    cleanups.push(() => child.kill("SIGKILL"));
    // Held for a second on end: the tick is stuck writing the row, not passing through a short write.
    let heldSince: number | null = null;
    await waitFor("the tick to stop inside the row's write", () => {
      if (!writeLocked(db)) {
        heldSince = null;
        return false;
      }
      heldSince ??= Date.now();
      return Date.now() - heldSince > 1000;
    });
    // Inside the write, the record's end is not visible on its own.
    const before = db
      .query("SELECT record FROM launches WHERE id = ?")
      .get(RECORD) as { record: string };
    expect(JSON.parse(before.record).endedAt).toBeUndefined();
    child.kill("SIGKILL");
    await child.exited;

    db.run("DROP TRIGGER stall_log");
    db.run("DROP TABLE stall");
    expectSpawnExit(await w.dispatch(["--repo", w.repo, "--json"]), 0);
    const rows = readRows(undefined, undefined, state).filter(
      (r) => r.key === `ended ${RECORD}`,
    );
    expect(rows.map((r) => [r.kind, r.class])).toEqual([
      ["ended", "converged"],
    ]);
    expect(readRecord(RECORD, state)?.endedAt).toBe(rows[0]?.at);
  }, 60_000);
});

describe("jig dispatch clear", () => {
  it("removes a record only a person can settle, and refuses one whose session runs", async () => {
    const w = fixture();
    const unknown = "20261101T090000Z-aaaaaaaa";
    const running = "20261101T090000Z-bbbbbbbb";
    earlierRecord(w, { id: unknown, account: "a" });
    claimed(w, unknown, {
      hostId: "",
      host: "elsewhere",
      bootId: "",
      pid: 1,
      start: "",
      claimedAt: "2026-11-01T09:00:01.000Z",
    });
    earlierRecord(w, { id: running, account: "a" });
    const driver = Bun.spawn(["sleep", "60"]);
    cleanups.push(() => driver.kill());
    const row = (await processTable())?.find((r) => r.pid === driver.pid);
    claimed(w, running, {
      hostId: "",
      host: hostname(),
      bootId: bootId(),
      pid: driver.pid,
      start: row?.start ?? "",
      claimedAt: new Date().toISOString(),
    });

    const cleared = await w.dispatch(["clear", unknown]);
    expectSpawnExit(cleared, 0);
    expect(JSON.parse(cleared.stdout)).toEqual({
      record: unknown,
      cleared: true,
      state: "unknown",
    });
    const refused = await w.dispatch(["clear", running]);
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("stop its session first");
    expectSpawnExit(await w.dispatch(["clear", unknown]), 2);
    expect(recordIds(w)).toEqual([running]);
  });
});
