/** Bounded board lists on the line retain why a PR is unread and what was omitted. */
import { expect, it } from "bun:test";
import { boardUnread, readyOf } from "../lib/line-ready.ts";
import type { BoardCard, BoardRead } from "../lib/board.ts";
import { report } from "./line-fixtures.ts";

function card(n: number): BoardCard {
  return {
    number: n,
    url: "",
    title: "change",
    head: "a".repeat(40),
    place: "ready",
    lane: "merge-now",
    says: "ready",
    waitsOn: { kind: "person", act: "merge" },
    conditions: [],
    failing: Array.from({ length: 12 }, (_, i) => `check ${i}`),
    requested: [],
    command: null,
    withheld: null,
    unblocks: [],
    since: "2026-11-09T10:00:00Z",
  };
}
function board(over: Partial<BoardRead> = {}): BoardRead {
  return {
    ok: true,
    reason: null,
    cards: [],
    unread: [],
    pending: [],
    ms: 0,
    cost: 0,
    remaining: null,
    ...over,
  };
}
it("carries per-PR unread reasons even when other cards were placed", () => {
  expect(
    boardUnread(
      report({
        board: board({ unread: [{ number: 7, reason: "its head moved" }] }),
      }),
    ).boardUnread,
  ).toContain("#7: its head moved");
});
it("counts omitted cards and failing check names", () => {
  const r = report({
    board: board({ cards: Array.from({ length: 103 }, (_, i) => card(i + 1)) }),
  });
  const ready = readyOf([r]);
  expect(ready).toHaveLength(100);
  expect(ready[0]?.failing).toHaveLength(10);
  expect(ready[0]?.failingOmitted).toBe(2);
  expect(boardUnread(r).readyOmitted).toBe(3);
});
