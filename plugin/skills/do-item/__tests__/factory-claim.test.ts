import { expect, test } from "bun:test";
import { claimFactoryIssue } from "../scripts/lib/served-claim.ts";
import type { Tracker, TrackerUser } from "../scripts/lib/tracker/port.ts";

const factory: TrackerUser = { id: "factory", name: "factory" };
const viewer: TrackerUser = { id: "viewer", name: "dana" };

function world() {
  const holders = new Map<string, TrackerUser[]>([
    ["#1", []],
    ["#2", [factory]],
  ]);
  const writes: string[] = [];
  let labels: string[] = [];
  let trusted = true;
  const tracker = {
    viewer: async () => viewer,
    user: async (name: string) => (name === factory.name ? factory : viewer),
    stateName: (state: string) => (state === "blocked" ? null : "In Progress"),
    getIssue: async (key: string) => ({
      identifier: key,
      description: "",
      parent: key === "#1" ? { identifier: "#2" } : null,
      labels: key === "#2" ? labels : [],
      isEpic: key === "#2",
      state: {
        name: key === "#1" && writes.includes("start") ? "In Progress" : "Todo",
        type:
          key === "#1" && writes.includes("start") ? "started" : "unstarted",
      },
    }),
    poolIssue: async (key: string) => ({
      identifier: key,
      labels: [],
      truncated: [],
      state: {
        name: writes.includes("start") ? "In Progress" : "Todo",
        type: writes.includes("start") ? "started" : "unstarted",
      },
    }),
    assignees: async (key: string) => holders.get(key) ?? [],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted }),
    listRelations: async () => [],
    assignUnassigned: async (key: string, user: TrackerUser) => {
      holders.set(key, [user]);
      writes.push("assign");
      return { assigned: true };
    },
    transition: async () => {
      writes.push("start");
    },
  } as unknown as Tracker;
  return {
    tracker,
    holders,
    writes,
    hold: () => {
      labels = ["jig:hold"];
    },
    untrust: () => {
      trusted = false;
    },
  };
}

test("factory inheritance authorizes through the factory but assigns the credential's person", async () => {
  const w = world();
  const result = await claimFactoryIssue(w.tracker, "#1", {
    person: "factory",
    ancestor: "#2",
  });
  expect(result.outcome).toBe("claimed");
  expect(w.holders.get("#1")).toEqual([viewer]);
  expect(w.holders.get("#2")).toEqual([factory]);
  expect(w.writes).toEqual(["assign", "start"]);
});

test.each(["changed-owner", "held", "untrusted"])(
  "factory inheritance refuses %s without writing",
  async (scenario) => {
    const w = world();
    if (scenario === "changed-owner") w.holders.set("#2", [viewer]);
    if (scenario === "held") w.hold();
    if (scenario === "untrusted") w.untrust();
    const result = await claimFactoryIssue(w.tracker, "#1", {
      person: "factory",
      ancestor: "#2",
    });
    expect(result.outcome).toBe("refused");
    expect(w.writes).toEqual([]);
  },
);

test("factory inheritance stands down if ancestor changes after assignment", async () => {
  const w = world();
  const original = w.tracker.transition;
  w.tracker.transition = async (...args) => {
    await original(...args);
    w.hold();
  };
  const result = await claimFactoryIssue(w.tracker, "#1", {
    person: "factory",
    ancestor: "#2",
  });
  expect(result.outcome).toBe("stood_down");
  expect(w.holders.get("#1")).toEqual([viewer]);
});

test("a factory child acquired by another assignee is never replaced", async () => {
  const w = world();
  const other = { id: "other", name: "other" };
  w.tracker.assignUnassigned = async () => {
    w.holders.set("#1", [other]);
    return { assigned: false, reason: "race" };
  };
  const result = await claimFactoryIssue(w.tracker, "#1", {
    person: "factory",
    ancestor: "#2",
  });
  expect(result.outcome).toBe("stood_down");
  expect(w.holders.get("#1")).toEqual([other]);
  expect(w.writes).toEqual([]);
});

test("a factory child behind a changed human execution-plan gate writes nothing", async () => {
  const w = world();
  const get = w.tracker.getIssue;
  w.tracker.getIssue = async (key) => {
    const issue = await get(key);
    if (issue && key === "#2")
      issue.description =
        "## Execution Plan\n\n```execution-plan-v1\n" +
        JSON.stringify({
          epic: "#2",
          intent: "test",
          steps: [{ issue: "#1", band: 1, lane: "a", gate: "human" }],
          edges: [],
          gates: [],
        }) +
        "\n```";
    return issue;
  };
  expect(
    (
      await claimFactoryIssue(w.tracker, "#1", {
        person: "factory",
        ancestor: "#2",
      })
    ).outcome,
  ).toBe("refused");
  expect(w.writes).toEqual([]);
});
