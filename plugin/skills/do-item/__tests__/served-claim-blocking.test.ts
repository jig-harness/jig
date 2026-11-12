import { expect, test } from "bun:test";
import { claimServedIssue } from "../scripts/lib/served-claim.ts";
import type { Tracker, TrackerUser } from "../scripts/lib/tracker/port.ts";

const person: TrackerUser = { id: "person", name: "dana" };

/** #1 is assigned to the person and waits on #2, which waits on #3, and so on down the chain. */
function world(chain: string[] = ["#1", "#2", "#3"]) {
  const holders = new Map<string, TrackerUser[]>([["#1", [person]]]);
  const labels = new Map<string, string[]>();
  const started = new Set<string>();
  const writes: string[] = [];
  const tracker = {
    user: async () => person,
    stateName: (s: string) => (s === "blocked" ? null : "In Progress"),
    listRelations: async (key: string) => {
      const at = chain.indexOf(key);
      const next = at === -1 ? undefined : chain[at + 1];
      return next === undefined ? [] : [{ type: "blocked_by", issue: next }];
    },
    getIssue: async (key: string) => ({
      identifier: key,
      parent: null,
      labels: labels.get(key) ?? [],
      state: started.has(key)
        ? { name: "In Progress", type: "started" }
        : { name: "Todo", type: "unstarted" },
    }),
    poolIssue: async (key: string) => ({
      identifier: key,
      labels: labels.get(key) ?? [],
      truncated: [],
      assignee: holders.get(key)?.[0] ?? null,
      hasOpenChildren: false,
      state: started.has(key)
        ? { name: "In Progress", type: "started" }
        : { name: "Todo", type: "unstarted" },
    }),
    assignees: async (key: string) => holders.get(key) ?? [],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    assignUnassigned: async (key: string, user: TrackerUser) => {
      writes.push(`assign ${key}`);
      holders.set(key, [user]);
      return true;
    },
    transition: async (key: string) => {
      writes.push(`start ${key}`);
      started.add(key);
    },
  } as unknown as Tracker;
  return { tracker, holders, labels, writes };
}

test("pulls the last blocker of a served item forward and assigns it to the person", async () => {
  const w = world(["#1", "#2"]);
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result.outcome).toBe("claimed");
  expect(w.writes).toEqual(["assign #2", "start #2"]);
  expect(w.holders.get("#2")).toEqual([person]);
});

test("pulls a blocker of a blocker, two links from the served item", async () => {
  const w = world();
  expect(
    (
      await claimServedIssue(w.tracker, "#3", {
        person: "dana",
        blocking: "#1",
      })
    ).outcome,
  ).toBe("claimed");
});

test("refuses a blocker whose path runs through an item the queue would not traverse", async () => {
  for (const middle of [
    (w: ReturnType<typeof world>) => w.holders.set("#2", [person]),
    (w: ReturnType<typeof world>) => w.labels.set("#2", ["epic"]),
    (w: ReturnType<typeof world>) => w.labels.set("#2", ["hitl"]),
  ]) {
    const w = world();
    middle(w);
    const result = await claimServedIssue(w.tracker, "#3", {
      person: "dana",
      blocking: "#1",
    });
    expect(result.outcome).toBe("refused");
    expect(w.writes).toEqual([]);
  }
});

test("refuses a blocker that itself still waits on another", async () => {
  const w = world();
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({ outcome: "refused", reason: "waiting on #3" });
  expect(w.writes).toEqual([]);
});

test("refuses an item more than three links from the served one", async () => {
  const w = world(["#1", "#2", "#3", "#4", "#5"]);
  const result = await claimServedIssue(w.tracker, "#5", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "#5 no longer blocks #1",
  });
  expect(w.writes).toEqual([]);
});

test("refuses a blocker that has acquired an assignee", async () => {
  const w = world(["#1", "#2"]);
  w.holders.set("#2", [{ id: "sam", name: "sam" }]);
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result.outcome).toBe("refused");
  expect(w.writes).toEqual([]);
});

test("refuses when the served item is no longer assigned to the person", async () => {
  const w = world(["#1", "#2"]);
  w.holders.set("#1", []);
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result.outcome).toBe("refused");
  expect(result).toMatchObject({ reason: expect.stringContaining("#1") });
  expect(w.writes).toEqual([]);
});

test("refuses a blocker that does not block the served item", async () => {
  const w = world(["#1", "#9"]);
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "#2 no longer blocks #1",
  });
});

test("refuses an epic and a held blocker", async () => {
  const w = world(["#1", "#2"]);
  w.labels.set("#2", ["epic"]);
  expect(
    await claimServedIssue(w.tracker, "#2", { person: "dana", blocking: "#1" }),
  ).toMatchObject({
    outcome: "refused",
    reason: "#2 is an epic and is not pulled forward",
  });
  w.labels.set("#2", ["jig:hold"]);
  expect(
    await claimServedIssue(w.tracker, "#2", { person: "dana", blocking: "#1" }),
  ).toMatchObject({ outcome: "refused", reason: "#2 needs a person to start" });
  expect(w.writes).toEqual([]);
});

test("stands down, not refuses, when a blocker leaves claim_from after its assignment was written", async () => {
  const w = world(["#1", "#2"]);
  const names: Record<string, string> = {
    todo: "Todo",
    in_progress: "In Progress",
    blocked: "Blocked",
  };
  const tracker = w.tracker as unknown as Record<string, unknown>;
  tracker.stateName = (s: string) => names[s] ?? "Backlog";
  const base = tracker.getIssue as (key: string) => Promise<{ state: object }>;
  tracker.getIssue = async (key: string) => {
    const issue = await base(key);
    const moved = w.writes.includes("assign #2");
    return moved
      ? { ...issue, state: { name: "Backlog", type: "unstarted" } }
      : issue;
  };
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
    claimFrom: ["todo"],
  });
  expect(result.outcome).toBe("stood_down");
  expect(w.writes).toEqual(["assign #2"]);
});

test("refuses a pulled blocker, before any write, when the served item's epic cannot be read", async () => {
  const w = world(["#1", "#2"]);
  const tracker = w.tracker as unknown as Record<string, unknown>;
  const getIssue = tracker.getIssue as (key: string) => Promise<object>;
  const poolIssue = tracker.poolIssue as (key: string) => Promise<object>;
  tracker.getIssue = async (key: string) => ({
    ...(await getIssue(key)),
    description: "",
    parent: key === "#1" ? { identifier: "#0" } : null,
  });
  tracker.poolIssue = async (key: string) =>
    key === "#0" ? null : poolIssue(key);
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({ outcome: "refused" });
  expect(w.writes).toEqual([]);
});

/** Gives `child` a parent whose plan cannot be read. */
function unreadableParentOf(w: ReturnType<typeof world>, child: string) {
  const tracker = w.tracker as unknown as Record<string, unknown>;
  const getIssue = tracker.getIssue as (key: string) => Promise<object>;
  const poolIssue = tracker.poolIssue as (key: string) => Promise<object>;
  tracker.getIssue = async (key: string) => ({
    ...(await getIssue(key)),
    description: "",
    parent: key === child ? { identifier: "#0" } : null,
  });
  tracker.poolIssue = async (key: string) =>
    key === "#0" ? null : poolIssue(key);
}

test("refuses a pulled blocker, before any write, when its own epic cannot be read", async () => {
  const w = world(["#1", "#2"]);
  unreadableParentOf(w, "#2");
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({ outcome: "refused" });
  expect(w.writes).toEqual([]);
});

test("refuses a pulled blocker, before any write, when an item between cannot be read through its epic", async () => {
  const w = world(["#1", "#2", "#3"]);
  unreadableParentOf(w, "#2");
  const result = await claimServedIssue(w.tracker, "#3", {
    person: "dana",
    blocking: "#1",
  });
  expect(result).toMatchObject({ outcome: "refused" });
  expect(w.writes).toEqual([]);
});

/** Reads `key` as the named Blocked state (an unstarted type) once `when` holds. */
function blockedStateOf(
  w: ReturnType<typeof world>,
  key: string,
  when: () => boolean,
) {
  const tracker = w.tracker as unknown as Record<string, unknown>;
  tracker.stateName = (s: string) =>
    s === "blocked" ? "Blocked" : "In Progress";
  for (const read of ["getIssue", "poolIssue"]) {
    const base = tracker[read] as (k: string) => Promise<object>;
    tracker[read] = async (k: string) => {
      const item = await base(k);
      return k === key && when()
        ? { ...item, state: { name: "Blocked", type: "unstarted" } }
        : item;
    };
  }
}

test("refuses a pulled blocker, before any write, when the origin or an item between is in the blocked state", async () => {
  for (const blocked of ["#1", "#2"]) {
    const w = world(["#1", "#2", "#3"]);
    blockedStateOf(w, blocked, () => true);
    const result = await claimServedIssue(w.tracker, "#3", {
      person: "dana",
      blocking: "#1",
    });
    expect(result.outcome).toBe("refused");
    expect(w.writes).toEqual([]);
  }
});

test("stands down, not refuses, when a pulled blocker becomes blocked after its assignment was written", async () => {
  const w = world(["#1", "#2"]);
  blockedStateOf(w, "#2", () => w.writes.includes("assign #2"));
  const result = await claimServedIssue(w.tracker, "#2", {
    person: "dana",
    blocking: "#1",
  });
  expect(result.outcome).toBe("stood_down");
  expect(w.writes).toEqual(["assign #2"]);
});
