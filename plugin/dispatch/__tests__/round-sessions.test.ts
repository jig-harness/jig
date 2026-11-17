/**
 * A drive's per-round pass sessions on its launch record
 * (`round-sessions.ts`): its driver adds each one as the pass starts, on
 * its own drive's record only, the newest kept past the bound; and the
 * `sessions` column a database the release before wrote gains.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../shared/records/db.ts";
import { readEnded } from "../lib/launches.ts";
import {
  readRoundSessions,
  recordRoundSession,
  ROUND_SESSIONS_MAX,
} from "../lib/round-sessions.ts";
import {
  closeStateDb,
  MIGRATIONS,
  SCHEMA_VERSION,
  stateDb,
  statePath,
} from "../lib/state.ts";
import { type World, world } from "./fixtures.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";

const ID = "20261115T090000Z-abcdef21";
const TOKEN = "the-token";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

describe("a drive's round sessions on its launch record", () => {
  it("are added round by round, on the drive's own record only", () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, { id: ID, account: "a", token: TOKEN, pr: 7 });
    const pickup = "20261115T090000Z-abcdef23";
    earlierRecord(w, {
      id: pickup,
      account: "a",
      action: "pickup",
      item: "#12",
      pr: null,
    });
    const s1 = "0b8e2f4c-1d2e-4f50-9a1b-2c3d4e5f6a7b";
    const s2 = "1c9f3a5d-2e3f-4a61-8b2c-3d4e5f6a7b8c";
    expect(
      recordRoundSession(ID, 7, 1, s1, root, "2026-11-15T09:01:00.000Z"),
    ).toBeNull();
    expect(
      recordRoundSession(ID, 7, 1, s2, root, "2026-11-15T09:20:00.000Z"),
    ).toBeNull();
    // Another pull request's drive, a pickup's record, a record that is gone, an id that is not one.
    expect(recordRoundSession(ID, 8, 2, s1, root)).toBe(
      "it is not this drive's record",
    );
    expect(recordRoundSession(pickup, 7, 1, s1, root)).toBe(
      "it is not this drive's record",
    );
    expect(
      recordRoundSession("20261115T090000Z-ffffffff", 7, 1, s1, root),
    ).toBe("there is no such launch record");
    expect(recordRoundSession(ID, 7, 1, "two words", root)).toBe(
      "the pass's session id is not one",
    );
    expect(readEnded(ID, root)).toBeNull();
    const row = stateDb(root)
      .query("SELECT sessions FROM launches WHERE id = ?")
      .get(ID) as { sessions: string };
    expect(readRoundSessions(row.sessions)).toEqual([
      { round: 1, session: s1, at: "2026-11-15T09:01:00.000Z" },
      { round: 1, session: s2, at: "2026-11-15T09:20:00.000Z" },
    ]);
    const other = stateDb(root)
      .query("SELECT sessions FROM launches WHERE id = ?")
      .get(pickup) as { sessions: string | null };
    expect(other.sessions).toBeNull();
  });

  it("are never written over when the ones kept do not read", () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, { id: ID, account: "a", token: TOKEN, pr: 7 });
    stateDb(root)
      .query("UPDATE launches SET sessions = ? WHERE id = ?")
      .run("{not json", ID);
    expect(recordRoundSession(ID, 7, 1, "session-1", root)).toBe(
      "the sessions it keeps do not read, and are left as they are",
    );
    const row = stateDb(root)
      .query("SELECT sessions FROM launches WHERE id = ?")
      .get(ID) as { sessions: string };
    expect(row.sessions).toBe("{not json");
  });

  it("are never written over when one of the ones kept does not read", () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, { id: ID, account: "a", token: TOKEN, pr: 7 });
    const kept = JSON.stringify([
      { round: 1, session: "session-0", at: "2026-11-15T09:00:00.000Z" },
      { round: "two" },
    ]);
    stateDb(root)
      .query("UPDATE launches SET sessions = ? WHERE id = ?")
      .run(kept, ID);
    expect(recordRoundSession(ID, 7, 2, "session-1", root)).toBe(
      "the sessions it keeps do not read, and are left as they are",
    );
    const row = stateDb(root)
      .query("SELECT sessions FROM launches WHERE id = ?")
      .get(ID) as { sessions: string };
    expect(row.sessions).toBe(kept);
  });

  it("keep the newest entries past their bound", () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, { id: ID, account: "a", token: TOKEN, pr: 7 });
    for (let round = 1; round <= ROUND_SESSIONS_MAX + 5; round++)
      recordRoundSession(ID, 7, round, `session-${round}`, root);
    const row = stateDb(root)
      .query("SELECT sessions FROM launches WHERE id = ?")
      .get(ID) as { sessions: string };
    const kept = readRoundSessions(row.sessions);
    expect(kept).toHaveLength(ROUND_SESSIONS_MAX);
    expect(kept[0]?.round).toBe(6);
    expect(kept.at(-1)?.round).toBe(ROUND_SESSIONS_MAX + 5);
  });
});

describe("the sessions column", () => {
  it("is added to the launches of a database the release before wrote", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-sessions-"));
    const path = statePath(root);
    // The migrations up to, and not including, the one that adds the column.
    const sessions = MIGRATIONS.findIndex((m) =>
      m.sql.includes("ADD COLUMN sessions"),
    );
    const before = openDatabase({
      path,
      migrations: MIGRATIONS.slice(0, sessions),
    });
    if (!before.ok) throw new Error(before.failure.reason);
    const columns = (db: ReturnType<typeof stateDb>) =>
      (
        db.query("PRAGMA table_info(launches)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
    expect(columns(before.value)).not.toContain("sessions");
    closeDatabase(path);
    const after = stateDb(root);
    expect(after.query("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(columns(after)).toContain("sessions");
    closeStateDb(root);
  });
});
