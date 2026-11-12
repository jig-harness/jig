import { expect, test } from "bun:test";
import { applyStewardOrder } from "../lib/steward-queue.ts";
import type { WantedItem } from "../lib/types.ts";

function item(
  key: string,
): WantedItem & Required<Pick<WantedItem, "queueRank" | "queueIssue">> {
  return {
    key,
    title: "Task",
    url: null,
    state: "Todo",
    assignee: "alex",
    assignedBy: "writer",
    queueRank: { unblocks: 0 },
    queueIssue: {
      identifier: key,
      title: "Task",
      url: null,
      type: "task",
      priority: 2,
      size: "small",
      state: { id: "todo", name: "Todo", type: "unstarted" },
      createdAt: "2026-01-01",
      assignee: { id: "a", name: "alex" },
      labels: [],
      isEpic: false,
      hasOpenChildren: false,
      truncated: [],
    },
  };
}
const orderRecord = {
  kind: "order" as const,
  targets: ["#2", "#1"],
  reason: "Keep related work together",
};
const order = [orderRecord];

test("orders rule ties and preserves every other queue position", () => {
  const items = [item("#1"), item("#2"), item("#3")];
  expect(applyStewardOrder(items, order).map((i) => i.key)).toEqual([
    "#2",
    "#1",
    "#3",
  ]);
  expect(items.map((i) => i.key)).toEqual(["#1", "#2", "#3"]);
});

test("never overrides any of the queue's ranking rules", () => {
  for (const change of [
    "priority",
    "unblocks",
    "epicOrder",
    "size",
    "createdAt",
  ] as const) {
    const first = item("#1");
    const items = [first, item("#2")];
    if (change === "priority") first.queueIssue.priority = 1;
    if (change === "unblocks") first.queueRank.unblocks = 2;
    if (change === "epicOrder") first.queueRank.epicOrder = 0;
    if (change === "size") first.queueIssue.size = "xs";
    if (change === "createdAt") first.queueIssue.createdAt = "2025-01-01";
    expect(applyStewardOrder(items, order).map((i) => i.key)).toEqual([
      "#1",
      "#2",
    ]);
  }
});

test("an incomplete rank, unknown target or duplicate order grants no override", () => {
  const first: WantedItem = item("#1");
  const items = [first, item("#2")];
  delete first.queueRank;
  expect(applyStewardOrder(items, order)).toEqual(items);
  expect(
    applyStewardOrder(items, [{ ...orderRecord, targets: ["#99", "#1"] }]),
  ).toEqual(items);
  expect(
    applyStewardOrder(items, [{ ...orderRecord, targets: ["#2", "#2"] }]),
  ).toEqual(items);
});
