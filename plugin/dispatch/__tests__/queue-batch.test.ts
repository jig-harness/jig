import { expect, it } from "bun:test";
import { batchPickups } from "../lib/queue-batch.ts";
import type { Action, WantedItem } from "../lib/types.ts";
it("batches small launchable items of one area and preserves fixed served context", () => {
  const items: WantedItem[] = [1, 2].map((n) => ({
    key: `#${n}`,
    title: "task",
    url: null,
    state: "Todo",
    assignee: "alex",
    assignedBy: "writer",
    servedPerson: "alex",
    queueIssue: {
      identifier: `#${n}`,
      title: "task",
      url: null,
      priority: 2,
      type: "task",
      size: "small",
      createdAt: "2026-01-01",
      state: { id: "s", name: "Todo", type: "unstarted" },
      assignee: { id: "a", name: "alex" },
      labels: ["area:tools"],
      hasOpenChildren: false,
      truncated: [],
    },
  }));
  const actions = items.map(
    (i) =>
      ({
        stage: "pickup",
        target: i.key,
        record: "tracker",
        reason: "ready",
        evidence: { servedPerson: "alex" },
      }) satisfies Action,
  );
  const result = batchPickups(actions, items, {
    do_item: { agents: { codearea_areas: { "area:tools": "tools" } } },
  });
  expect(result).toHaveLength(1);
  expect(JSON.parse(String(result[0]?.evidence.batchItems))).toEqual([
    { key: "#1", person: "alex" },
    { key: "#2", person: "alex" },
  ]);
  for (const item of items) if (item.queueIssue) item.queueIssue.priority = 1;
  expect(
    batchPickups(
      actions.map((a) => ({ ...a, evidence: { servedPerson: "alex" } })),
      items,
      { do_item: { agents: { codearea_areas: { "area:tools": "tools" } } } },
    ),
  ).toHaveLength(2);
});
