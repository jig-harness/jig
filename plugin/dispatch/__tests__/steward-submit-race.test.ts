import { expect, spyOn, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { keepStewardRun, submitStewardRecords } from "../lib/steward.ts";

test("steward submission reserves its write before reading while another connection writes", () => {
  const root = mkdtempSync(join(tmpdir(), "steward-submit-race-"));
  keepStewardRun(
    "run",
    {
      version: 1,
      repo: "example/repo",
      drives: [],
      queue: [],
      needs: [],
      passes: [],
      failures: [],
      load: null,
    },
    Date.now(),
    root,
  );
  const db = stateDb(root);
  const other = new Database(join(root, "state.sqlite"));
  other.run("PRAGMA busy_timeout = 0");
  const statement = db.query(
    "SELECT submitted, digest FROM steward_runs WHERE id = ?",
  );
  const get = statement.get.bind(statement);
  let writerWaited = false;
  const update = () =>
    other.run(
      "UPDATE steward_runs SET hash = 'another writer' WHERE id = 'run'",
    );
  // Interleave a real second connection after the submission reads its snapshot.
  const read = spyOn(statement, "get").mockImplementation((...params) => {
    const row = get(...params);
    try {
      update();
    } catch (error) {
      if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY")
        throw error;
      writerWaited = true;
    }
    return row;
  });
  try {
    const submitted = submitStewardRecords(
      "run",
      [
        {
          kind: "rearm",
          target: "PR #7",
          facts: "generation 1",
          class: "forge-timeout",
          reason: "a transient forge outage",
        },
      ],
      root,
    );
    expect(submitted).toEqual({ ok: true, value: "submitted" });
    expect(writerWaited).toBe(true);
    update();
    expect(
      other.query("SELECT submitted, hash FROM steward_runs").get(),
    ).toEqual({
      submitted: 1,
      hash: "another writer",
    });
    expect(
      other.query("SELECT COUNT(*) AS n FROM steward_records").get(),
    ).toEqual({
      n: 1,
    });
  } finally {
    read.mockRestore();
    other.close();
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});
