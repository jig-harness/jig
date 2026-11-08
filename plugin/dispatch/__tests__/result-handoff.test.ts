import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDb } from "../lib/state.ts";
import { exportLog } from "../lib/log-export.ts";
import { afterEach, expect, it } from "bun:test";
import { readEnded, recordExit, recordResult } from "../lib/launches.ts";
import { logEnded } from "../lib/log-ended.ts";
import { parseLine, readRows } from "../lib/log.ts";
import { earlierRecord, dispatchState } from "./launch-fixtures.ts";
import { world, type World } from "./fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

for (const late of [false, true]) {
  it(`keeps a pickup handoff recorded ${late ? "after logging" : "after the tick snapshot"}`, async () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, {
      id: "pickup-result",
      account: "a",
      action: "pickup",
      item: "#12",
    });
    recordExit(
      "pickup-result",
      { at: "2026-11-01T12:00:00.000Z", code: 0, signal: null },
      root,
    );
    const snapshot = readEnded("pickup-result", root);
    if (snapshot === null) throw new TypeError("missing fixture launch");
    const next = { address: "drive@example/repo#42" };
    if (!late)
      expect(recordResult("pickup-result", "done", root, next)).toBe(true);
    expect(
      await logEnded([snapshot], {
        all: [snapshot],
        drives: [],
        merged: async () => null,
        nowIso: "2026-11-01T12:01:00.000Z",
        root,
      }),
    ).toEqual([]);
    exportLog(root);
    if (late)
      expect(recordResult("pickup-result", "done", root, next)).toBe(true);
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "converged", reason: "result done", next },
    ]);
    exportLog(root);
    const exported = readFileSync(join(root, "log-2026-11.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(exported).toMatchObject([{ class: "converged", next }]);
    expect(recordResult("pickup-result", "failed", root)).toBe(false);
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "converged", next },
    ]);
  });
}

it("normalizes invalid outcome handoffs while reading legacy rows", () => {
  const row = {
    kind: "ended",
    key: "ended a",
    at: "2026-11-01T12:00:00.000Z",
    repo: "example/repo",
    stage: "pickup",
    target: "#12",
    account: "a",
    class: "converged",
    reason: "result done",
  };
  for (const next of [
    42,
    "bad",
    {},
    { address: " " },
    { address: "garbage" },
    ...["drive", "followup", "pickup"].flatMap((station) => [
      { address: `${station}#42` },
      { address: `${station}@repo#42` },
    ]),
    { address: "drive@example/repo#42", none: "done" },
    { person: "maintainer", act: "merge", none: "done" },
    { none: "done", act: "merge" },
    null,
  ])
    expect(parseLine(JSON.stringify({ ...row, next }))).toMatchObject({
      next: null,
    });
  expect(parseLine(JSON.stringify(row))).toMatchObject(row);
  expect(parseLine(JSON.stringify(row))).not.toHaveProperty("next");
  expect(
    parseLine(
      JSON.stringify({ ...row, next: { address: "drive@example/repo#42" } }),
    ),
  ).toMatchObject({ next: { address: "drive@example/repo#42" } });
  for (const station of ["drive", "followup", "pickup"])
    expect(
      parseLine(
        JSON.stringify({
          ...row,
          next: { address: `${station}@example/repo#42` },
        }),
      ),
    ).toMatchObject({ next: { address: `${station}@example/repo#42` } });
});

for (const late of [false, true]) {
  it(`preserves the question when failure is recorded ${late ? "after" : "before"} logging`, async () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    earlierRecord(w, {
      id: "question-result",
      account: "a",
      action: "followup",
      pr: 42,
    });
    recordExit(
      "question-result",
      {
        at: "2026-11-01T12:00:00.000Z",
        code: 1,
        signal: null,
        said: "Question: publish it?",
      },
      root,
    );
    if (!late) recordResult("question-result", "failed", root);
    const snapshot = readEnded("question-result", root);
    if (snapshot === null) throw new TypeError("missing launch");
    await logEnded([snapshot], {
      all: [snapshot],
      drives: [],
      merged: async () => null,
      nowIso: "2026-11-01T12:01:00.000Z",
      root,
    });
    if (late) recordResult("question-result", "failed", root);
    expect(readRows(undefined, undefined, root)).toMatchObject([
      {
        class: "parked for a person",
        reason: "stopped on a question: publish it?",
      },
    ]);
  });
}

it("keeps a completed pickup's unreadable handoff unknown", async () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  earlierRecord(w, {
    id: "unknown-result",
    account: "a",
    action: "pickup",
    item: "#12",
  });
  recordExit(
    "unknown-result",
    { at: "2026-11-01T12:00:00.000Z", code: 0, signal: null },
    root,
  );
  recordResult("unknown-result", "done", root);
  stateDb(root)
    .query("UPDATE launches SET result_next = ? WHERE id = ?")
    .run('{"address":"garbage"}', "unknown-result");
  const snapshot = readEnded("unknown-result", root);
  if (snapshot === null) throw new TypeError("missing launch");
  await logEnded([snapshot], {
    all: [snapshot],
    drives: [],
    merged: async () => null,
    nowIso: "2026-11-01T12:01:00.000Z",
    root,
  });
  expect(readRows(undefined, undefined, root)).toMatchObject([
    { class: "converged", next: null },
  ]);
});
