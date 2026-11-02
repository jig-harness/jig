/**
 * The outcome log's text: `jig dispatch log` reads it from the database,
 * and every tick copies the rows written since the last copy into the
 * month files, so the database, `jig dispatch log --jsonl` and the month
 * files hold the same rows. A copy that cannot be written fails, and the
 * next one copies the same rows.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeRow, type LogRow } from "../lib/log.ts";
import { exportLog } from "../lib/log-export.ts";
import { stateDb, closeStateDb } from "../lib/state.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import { dispatchState } from "./launch-fixtures.ts";

const roots: string[] = [];
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
  for (const r of roots.splice(0)) {
    closeStateDb(r);
    rmSync(r, { recursive: true, force: true });
  }
});

function row(key: string, at: string, reason = "r"): LogRow {
  return {
    kind: "event",
    key,
    at,
    repo: "o/r",
    stage: "steer",
    target: "t",
    event: "nudge",
    account: null,
    class: null,
    reason,
  };
}

/** Every line of every month file under `root`, in file order. */
function monthLines(root: string): string[] {
  return readdirSync(root)
    .filter((n) => /^log-\d{4}-\d{2}\.jsonl$/.test(n))
    .sort()
    .flatMap((n) =>
      readFileSync(join(root, n), "utf8")
        .split("\n")
        .filter((l) => l !== ""),
    );
}

describe("the outcome log's text", () => {
  it("holds the same rows in the database, in jig dispatch log --jsonl and in the month files a tick writes", async () => {
    const w = world();
    current = w;
    w.setConfig(
      `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
    );
    const state = dispatchState(w);
    const rows = [
      row("event a", "2026-09-30T23:59:59.000Z", "é".repeat(200)),
      row("event b", "2026-10-01T00:00:00.000Z"),
      row("event c", "2026-10-15T12:00:00.000Z"),
      row("event d", "2026-11-01T08:00:00.000Z"),
    ];
    for (const r of rows) writeRow(r, state);
    // An ended row for an earlier month, written after a later one.
    writeRow(row("event e", "2026-10-31T23:00:00.000Z"), state);

    expectSpawnExit(await w.dispatch(["--repo", w.repo, "--json"]), 0);

    const database = (
      stateDb(state).query("SELECT row FROM log ORDER BY seq").all() as Array<{
        row: string;
      }>
    ).map((r) => r.row);
    expect(database).toHaveLength(5);
    const printed = await w.dispatch(["log", "--jsonl"]);
    expectSpawnExit(printed, 0);
    const jsonl = printed.stdout.split("\n").filter((l) => l !== "");
    expect(jsonl).toEqual(database);
    expect([...monthLines(state)].sort()).toEqual([...database].sort());
    expect(
      readdirSync(state)
        .filter((n) => n.endsWith(".jsonl"))
        .sort(),
    ).toEqual(["log-2026-09.jsonl", "log-2026-10.jsonl", "log-2026-11.jsonl"]);

    // A second tick copies nothing twice.
    expectSpawnExit(await w.dispatch(["--repo", w.repo, "--json"]), 0);
    expect([...monthLines(state)].sort()).toEqual([...database].sort());

    const since = await w.dispatch(["log", "--since", "2026-10-31"]);
    expectSpawnExit(since, 0);
    expect(
      since.stdout
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => l.split("\t")[0]),
    ).toEqual(["2026-11-01T08:00:00.000Z", "2026-10-31T23:00:00.000Z"]);
  });

  it("fails a copy it cannot write, and the next copy writes the same rows", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-log-"));
    roots.push(root);
    writeRow(row("a", "2026-01-02T03:04:05.000Z"), root);
    // A directory where the month file should be cannot be written.
    mkdirSync(join(root, "log-2026-01.jsonl"));
    expect(() => exportLog(root)).toThrow();
    rmSync(join(root, "log-2026-01.jsonl"), { recursive: true });
    expect(exportLog(root)).toBe(1);
    expect(monthLines(root).map((l) => JSON.parse(l).key)).toEqual(["a"]);
  });

  it("copies every row written before it began, across batches", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-log-"));
    roots.push(root);
    for (let i = 0; i < 5001; i++)
      writeRow(row(`k${i}`, "2026-01-02T03:04:05.000Z"), root);
    expect(exportLog(root)).toBe(5001);
    expect(monthLines(root)).toHaveLength(5001);
    expect(exportLog(root)).toBe(0);
  });
});
