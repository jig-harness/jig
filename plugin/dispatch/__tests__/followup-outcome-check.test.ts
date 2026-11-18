/**
 * The state database's `followup_outcomes.outcome` column accepts exactly
 * the tick's outcomes in `shared/records/followup-values.ts`. Its `CHECK`
 * list is migration text a released plugin ran, so it cannot be built from
 * the table; this test holds the two together instead, so an outcome added
 * to the table fails here rather than at the tick's insert.
 */
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOWUP_OUTCOMES } from "../../shared/records/followup-values.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh state database, migrated to the current schema. */
function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "jig-followup-check-"));
  roots.push(root);
  return stateDb(root);
}

/** The values the `CHECK (outcome IN (…))` of the table's current definition lists. */
function checkedOutcomes(sql: string): string[] {
  const list = /\boutcome TEXT NOT NULL CHECK \(outcome IN \(([^)]*)\)\)/.exec(
    sql,
  );
  if (list?.[1] === undefined)
    throw new Error(`followup_outcomes declares no outcome CHECK:\n${sql}`);
  return list[1].split(",").map((v) => v.trim().replace(/^'(.*)'$/, "$1"));
}

it("checks the outcome column against the tick's outcomes in followup-values.ts", () => {
  const db = freshDb();
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'followup_outcomes'",
    )
    .get();
  expect(checkedOutcomes(row?.sql ?? "").sort()).toEqual(
    Object.keys(FOLLOWUP_OUTCOMES.tick).sort(),
  );
});

it("stores every tick outcome and refuses a value outside them", () => {
  const db = freshDb();
  const insert = db.query(
    "INSERT INTO followup_outcomes (repo, pr, record, outcome, at, created) VALUES ('o/r', ?, 'rec', ?, 'at', 'created')",
  );
  const outcomes = Object.keys(FOLLOWUP_OUTCOMES.tick);
  for (const [i, outcome] of outcomes.entries()) insert.run(i + 1, outcome);
  expect(
    db.query("SELECT outcome FROM followup_outcomes ORDER BY pr").values(),
  ).toEqual(outcomes.map((o) => [o]));
  expect(() => insert.run(outcomes.length + 1, "running")).toThrow(/CHECK/);
});
