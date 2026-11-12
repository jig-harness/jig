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

/** The rows `rowsFor` reads, where the lookup is expected to read. */
function rowsOf(repo: string, target: string, r: string) {
  const read = rowsFor(repo, target, r);
  expect(read).toMatchObject({ ok: true });
  return read.ok ? read.value : [];
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
      rowsOf("example-org/example-repo", "PR #7", r).map((x) => x.key),
    ).toEqual(["ended a", "ended c", "ended d"]);
    expect(rowsOf("other/repo", "PR #7", r)).toEqual([]);
    const seven = rowsOf("example-org/example-repo", "PR #7", r);
    expect(lastEnded(seven, ["rearm", "takeover"])?.key).toBe("ended c");
    expect(lastEnded(seven, ["followup"])?.key).toBe("ended d");
    expect(
      lastEnded(rowsOf("example-org/example-repo", "PR #9", r), ["rearm"]),
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
      rowsOf("example-org/example-repo", "PR #7", r).map((x) => x.key),
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
    old.run("ALTER TABLE notices_content DROP COLUMN pending");
    old.run("DROP TABLE followup_releases");
    old.run("DROP TABLE reflection_findings");
    old.run("DROP TABLE merge_reads");
    old.run("ALTER TABLE launches DROP COLUMN result_next");
    old.run("ALTER TABLE launches DROP COLUMN refusal");
    old.run("ALTER TABLE followup_outcomes DROP COLUMN asked");
    old.run("DROP TABLE load_samples");
    old.run("DROP TABLE failures");
    old.run("DROP TABLE pickup_reads");
    old.run("DROP TABLE steward_records");
    old.run("DROP TABLE steward_runs");
    old.run("DROP TABLE pickup_claims");
    old.run("ALTER TABLE launches DROP COLUMN result_until");
    old.run(`PRAGMA user_version = ${BEFORE_TARGET}`);
    old.run("DELETE FROM db_migrations WHERE version > ?", [BEFORE_TARGET]);
    old.run("UPDATE db_meta SET version = ?", [BEFORE_TARGET]);
    old.close();

    expect(
      rowsOf("example-org/example-repo", "PR #7", r).map((x) => x.key),
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

  it("declines a read-only lookup on a database from before the column, rather than scan the log", () => {
    const r = root();
    writeRow(ended("a", "PR #7", "2026-11-01T10:00:00.000Z"), r);
    closeStateDb(r);
    const old = new Database(statePath(r));
    old.run("DROP INDEX log_target");
    old.run("ALTER TABLE log DROP COLUMN target");
    old.close();

    const readOnly = new Database(statePath(r), { readonly: true });
    try {
      const rows = rowsFor("example-org/example-repo", "PR #7", r, readOnly);
      expect(rows.ok).toBe(false);
      if (!rows.ok) {
        expect(rows.failure.code).toBe("unindexed");
        expect(rows.failure.reason).toMatch(/no target column/);
      }
    } finally {
      readOnly.close();
    }
  });
});
