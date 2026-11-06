/**
 * The outcome log's key column: each row is written with the piece of work
 * it is about, one key's rows are read through it, a row a copy one release
 * behind wrote without it is still read, and a database from before the
 * column gains it, filled from the rows it already holds.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EndedRow, lastEnded, rowsFor, writeRow } from "../lib/log.ts";
import {
  closeStateDb,
  SCHEMA_VERSION,
  stateDb,
  statePath,
} from "../lib/state.ts";

/** The schema version before the log gained its `target` column. */
const BEFORE_TARGET = 8;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "dispatch-log-target-"));
  roots.push(r);
  return r;
}

function ended(
  id: string,
  target: string,
  at: string,
  stage: EndedRow["stage"] = "rearm",
  cls: EndedRow["class"] = "converged",
): EndedRow {
  return {
    kind: "ended",
    key: `ended ${id}`,
    at,
    repo: "example-org/example-repo",
    stage,
    target,
    record: id,
    account: "a",
    model: null,
    durationMs: 1000,
    rounds: null,
    class: cls,
    reason: "exit 0 (converged)",
  };
}

describe("the outcome log's key column", () => {
  it("reads one key's rows, and its last ended launch among the stages asked for", () => {
    const r = root();
    writeRow(ended("a", "PR #7", "2026-11-01T10:00:00.000Z"), r);
    writeRow(ended("b", "PR #8", "2026-11-01T11:00:00.000Z"), r);
    writeRow(
      ended("c", "PR #7", "2026-11-01T12:00:00.000Z", "rearm", "quota wall"),
      r,
    );
    writeRow(ended("d", "PR #7", "2026-11-01T13:00:00.000Z", "followup"), r);
    expect(
      rowsFor("example-org/example-repo", "PR #7", r).map((x) => x.key),
    ).toEqual(["ended a", "ended c", "ended d"]);
    expect(rowsFor("other/repo", "PR #7", r)).toEqual([]);
    const seven = rowsFor("example-org/example-repo", "PR #7", r);
    expect(lastEnded(seven, ["rearm", "takeover"])?.key).toBe("ended c");
    expect(lastEnded(seven, ["followup"])?.key).toBe("ended d");
    expect(
      lastEnded(rowsFor("example-org/example-repo", "PR #9", r), ["rearm"]),
    ).toBeNull();
    const db = stateDb(r);
    expect(
      db.query("SELECT target FROM log WHERE key = 'ended a'").get(),
    ).toEqual({
      target: "PR #7",
    });
  });

  it("reads a row written without the column, as a copy one release behind writes it", () => {
    const r = root();
    writeRow(ended("a", "PR #7", "2026-11-01T10:00:00.000Z"), r);
    stateDb(r).run("UPDATE log SET target = NULL");
    expect(
      rowsFor("example-org/example-repo", "PR #7", r).map((x) => x.key),
    ).toEqual(["ended a"]);
  });

  it("adds the column to a database from before it, filled from its rows", () => {
    const r = root();
    writeRow(ended("a", "PR #7", "2026-11-01T10:00:00.000Z"), r);
    closeStateDb(r);
    // The database as the version before the column left it, without the columns later versions added.
    const old = new Database(statePath(r));
    old.run("DROP INDEX log_target");
    old.run("ALTER TABLE log DROP COLUMN target");
    old.run("ALTER TABLE notices DROP COLUMN sent_at");
    old.run(`PRAGMA user_version = ${BEFORE_TARGET}`);
    old.run("UPDATE db_meta SET version = ?", [BEFORE_TARGET]);
    old.close();

    expect(
      rowsFor("example-org/example-repo", "PR #7", r).map((x) => x.key),
    ).toEqual(["ended a"]);
    const db = stateDb(r);
    expect(db.query("PRAGMA user_version").get()).toEqual({
      user_version: SCHEMA_VERSION,
    });
    expect(db.query("SELECT target FROM log").all()).toEqual([
      { target: "PR #7" },
    ]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'log_target'",
        )
        .get(),
    ).toEqual({ name: "log_target" });
  });
});
