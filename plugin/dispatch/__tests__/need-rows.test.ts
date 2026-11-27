/**
 * A need's life in the outcome log (`need-rows.ts`), and the release every
 * record names (`release.ts`): one open row when a need appears, one close
 * row once it is absent from two lines in a row, no rows at all for a need
 * missing from a single line; a run is counted under the release it was
 * launched under, and a record's first write is the launch.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineNeed } from "../lib/dashboard-contract.ts";
import { endedRow } from "../lib/log.ts";
import { type LaunchRecord, readRecord, writeRecord } from "../lib/launches.ts";
import { recordNeedRows } from "../lib/need-rows.ts";
import { releaseOf } from "../lib/release.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { REPO } from "./line-fixtures.ts";

const ID = "20261101T000000Z-aaaaaaaa";
const T = (minute: number): string =>
  `2026-11-23T10:${String(minute).padStart(2, "0")}:00.000Z`;

function need(fields: Partial<LineNeed> = {}): LineNeed {
  return {
    cause: "stalled",
    stage: "pickup",
    repo: REPO,
    target: "ENG-4",
    pr: null,
    item: "ENG-4",
    url: null,
    title: "Fix the thing",
    since: T(0),
    reason: "its pickup stalled",
    decisions: [],
    notified: null,
    workspaces: [],
    ...fields,
  };
}

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jig-need-rows-"));
});
afterEach(() => {
  closeStateDb(root);
  rmSync(root, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  return (
    stateDb(root)
      .query(
        "SELECT row FROM log WHERE json_extract(row, '$.event') IN ('need-opened', 'need-closed') ORDER BY seq",
      )
      .all() as Array<{ row: string }>
  ).map((r) => JSON.parse(r.row));
}

function line(needs: LineNeed[], minute: number): void {
  recordNeedRows(stateDb(root), needs, T(minute));
}

describe("need rows", () => {
  it("writes one open row when a need appears, and none while it stays", () => {
    line([need()], 1);
    line([need()], 2);
    line([need()], 3);
    expect(rows()).toEqual([
      expect.objectContaining({
        event: "need-opened",
        repo: REPO,
        target: "ENG-4",
        at: T(1),
        class: null,
        reason: "stalled: its pickup stalled",
      }),
    ]);
  });

  it("keeps a need open that is absent from one line and back in the next", () => {
    line([need()], 1);
    line([], 2);
    line([need()], 3);
    line([], 4);
    line([need()], 5);
    expect(rows().map((r) => r.event)).toEqual(["need-opened"]);
  });

  it("closes a need absent from two lines in a row, timed at the first, once", () => {
    line([need()], 1);
    line([], 2);
    line([], 3);
    line([], 4);
    expect(rows().map((r) => r.event)).toEqual(["need-opened", "need-closed"]);
    expect(rows()[1]).toMatchObject({
      at: T(2),
      durationMs: 60_000,
      reason: "the line no longer holds it",
    });
  });

  it("opens a need that returns after its close as a new need", () => {
    line([need()], 1);
    line([], 2);
    line([], 3);
    line([need()], 4);
    expect(rows().map((r) => r.event)).toEqual([
      "need-opened",
      "need-closed",
      "need-opened",
    ]);
  });

  it("counts a group of releases whose target moved on as the same need", () => {
    const group = (target: string, covers: string[]) =>
      need({ cause: "release-owed", target, covers });
    line([group("v1", ["ENG-1", "ENG-2"])], 1);
    line([group("v2", ["ENG-2", "ENG-3"])], 2);
    line([], 3);
    line([], 4);
    expect(rows().map((r) => r.event)).toEqual(["need-opened", "need-closed"]);
    expect(rows()[1]).toMatchObject({ target: "v2" });
  });

  it("says how the need left from the leave row the tick wrote", () => {
    line([need()], 1);
    stateDb(root)
      .query(
        "INSERT INTO need_leaves (repo, target, cause, at_ms, value) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        REPO,
        "ENG-4",
        "stalled",
        Date.parse(T(2)),
        JSON.stringify({ by: "person", how: "chose release" }),
      );
    line([], 2);
    line([], 3);
    expect(rows()[1]).toMatchObject({ reason: "person: chose release" });
  });
});

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id: "20261101T000000Z-aaaaaaaa",
    token: "t",
    action: "rearm",
    repo: REPO,
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    ...over,
  };
}

describe("the release on a record", () => {
  it("is the plugin's version, and names one", () => {
    expect(releaseOf()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is stamped when a launch record is first written and kept by every rewrite", () => {
    writeRecord(record(), root);
    const first = readRecord(ID, root)?.release;
    expect(first).toBe(releaseOf());
    // A rewrite by another release (the record read back, changed) keeps the launch's.
    writeRecord({ ...record(), release: "0.0.1-older", account: "b" }, root);
    expect(readRecord(ID, root)?.release).toBe("0.0.1-older");
  });

  it("is not given to a record written before releases were named", () => {
    stateDb(root)
      .query(
        "INSERT INTO launches (id, repo, action, pr, item, created_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ID,
        REPO,
        "rearm",
        7,
        null,
        "2026-11-01T00:00:00.000Z",
        JSON.stringify(record()),
      );
    writeRecord({ ...record(), account: "b" }, root);
    expect(readRecord(ID, root)?.release).toBeUndefined();
  });

  it("is the release a run counts under: its ended row names the one at launch", () => {
    const ended = {
      record: record({ release: "0.1.0" }),
      state: {
        kind: "ended" as const,
        exit: { at: T(5), code: 0, signal: null },
        process: null,
      },
      result: null,
    };
    expect(
      endedRow(ended, T(5), { takenOver: false, merged: null }, null).release,
    ).toBe("0.1.0");
    expect(
      endedRow(
        { ...ended, record: record() },
        T(5),
        { takenOver: false, merged: null },
        null,
      ).release,
    ).toBeUndefined();
  });
});
