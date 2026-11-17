/**
 * The tracker snapshot contract: the port's normalized issue forms, which
 * every adapter (GitHub, Linear, Jira) returns, become snapshot items whose
 * missing facets are gaps, never a low priority.
 */
import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  QueueIssue,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { snapshotItem } from "../lib/priorities-snapshot.ts";

function pool(over: Partial<PoolIssue> = {}): PoolIssue {
  return {
    identifier: "ENG-7",
    title: "an item",
    url: null,
    priority: 2,
    type: "Bug",
    size: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    state: { id: "s1", name: "Todo", type: "unstarted" },
    assignee: { id: "u1", name: "alex" },
    labels: ["b", "a"],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
    ...over,
  };
}

function queue(over: Partial<QueueIssue> = {}): QueueIssue {
  return {
    ...pool(),
    relations: [
      { type: "blocked_by", issue: "ENG-2", state: "started" },
      { type: "blocked_by", issue: "ENG-1", state: "done" },
      { type: "blocks", issue: "ENG-9", state: "unstarted" },
    ],
    parent: {
      issue: pool({ identifier: "ENG-100", isEpic: true }),
      description: "",
      parent: null,
    },
    ...over,
  };
}

describe("a snapshot item from the tracker port", () => {
  it("normalizes priority, type, parent, open blockers, assignee and labels", () => {
    const item = snapshotItem(queue(), {
      scope: "ENG",
      readyState: "todo",
    });
    expect(item).toMatchObject({
      scope: "ENG",
      key: "ENG-7",
      priority: 2,
      type: "bug",
      state: "ready",
      parent: "ENG-100",
      blockers: ["ENG-2"],
      assigned: true,
      labels: ["a", "b"],
    });
    expect(item.gaps).toEqual(["dueDate", "project", "cycle"]);
  });

  it("names a missing priority, type, parent and relations as gaps, never as low priority", () => {
    const item = snapshotItem(pool({ priority: 0, type: null, isEpic: true }), {
      scope: "ENG",
    });
    expect(item.priority).toBeNull();
    expect(item.gaps).toEqual(
      expect.arrayContaining([
        "priority",
        "type",
        "blockers",
        "parent",
        "children",
      ]),
    );
  });

  it("names relations the read could not take in full as a blockers gap", () => {
    const item = snapshotItem(queue({ relations: null }), { scope: "ENG" });
    expect(item.blockers).toEqual([]);
    expect(item.gaps).toContain("blockers");
  });

  it("carries the plan's exclusion and an unknown assignee", () => {
    const item = snapshotItem(pool(), {
      scope: "ENG",
      excluded: "needs a person to start",
      assigned: null,
    });
    expect(item.excluded).toBe("needs a person to start");
    expect(item.gaps).toContain("assignee");
  });
});
