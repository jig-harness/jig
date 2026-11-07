import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const next = { address: "drive PR #42" };
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
  for (const next of [42, "bad", {}, { address: " " }, null])
    expect(parseLine(JSON.stringify({ ...row, next }))).toMatchObject({
      next: null,
    });
  expect(parseLine(JSON.stringify(row))).toMatchObject(row);
  expect(parseLine(JSON.stringify(row))).not.toHaveProperty("next");
  expect(
    parseLine(JSON.stringify({ ...row, next: { address: "drive PR #42" } })),
  ).toMatchObject({ next: { address: "drive PR #42" } });
});
