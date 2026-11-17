import { expect, it } from "bun:test";
import { world, people, started } from "./served-blocker-fixtures.ts";
import { issue } from "./served-fixtures.ts";
import { dispatchSection } from "../lib/section.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { AssignerUnknown } from "../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";

it("counts active descendants of unwalked sibling epics", async () => {
  const w = world({
    assigned: [issue("#2")],
    others: [issue("#1", ["epic"], "sam")],
    children: {
      "#1": [issue("#2"), issue("#6", ["epic"], null)],
      "#6": [started("#7")],
    },
  });
  const read = await w.read({ epicWidth: 1 });
  expect(read.wanted).toEqual([]);
  expect(read.unplaced.find((u) => u.target === "#2")?.reason).toContain(
    "working #6",
  );
});

it("inspects parent occupancy without requiring assignment to the child's owner", async () => {
  const w = world({
    assigned: [issue("#2")],
    others: [issue("#1", ["epic"], "sam")],
    children: { "#1": [issue("#2"), started("#5")] },
  });
  w.tracker.assignedBy = async (key, identity) => {
    if (key === "#1" && identity !== "sam")
      throw new AssignerUnknown("no assignment to this person");
    return { id: "writer", name: "writer", trusted: true };
  };
  const read = await w.read({ epicWidth: 1 });
  expect(read.wanted).toEqual([]);
});

it("expands a sole started factory epic", async () => {
  const epic = {
    ...issue("#11", ["epic"], "factory"),
    state: { id: "s", name: "in_progress", type: "started" as const },
  };
  const w = world({
    assigned: [epic],
    children: { "#11": [issue("#12", [], null), issue("#13", [], null)] },
  });
  w.tracker.assignedIssues = async (_, states) =>
    states.includes("in_progress") ? [epic] : [];
  const section = dispatchSection({
    dispatch: { identity: "factory", epic_width: 1 },
  });
  if (!section.ok) throw new Error(section.failure.reason);
  const read = await readPickups(() => w.tracker, section.value);
  expect(read.wanted.map((i) => i.key)).toEqual(["#12"]);
  expect(read.wanted[0]?.factoryAncestor).toBe("#11");
});

it("preserves served assignment when the same identity is also the factory", async () => {
  const w = world({ assigned: [issue("#1")] });
  const section = dispatchSection({ dispatch: { identity: "alex" } });
  if (!section.ok) throw new Error(section.failure.reason);
  const read = await readPickups(() => w.tracker, section.value, undefined, {
    people,
    cache: w.cache,
    nowMs: 1,
    headroom: true,
  });
  expect(read.wanted[0]?.servedPerson).toBe("alex");
});

it("reserves one slot when nested sibling occupancy cannot be read", async () => {
  const w = world({
    assigned: [issue("#2")],
    others: [issue("#1", ["epic"], "sam")],
    children: {
      "#1": [issue("#2"), issue("#6", ["epic"], null)],
      "#6": [issue("#7", ["epic"], null)],
      "#7": [started("#8")],
    },
    failing: ["#7"],
  });
  const read = await w.read({ epicWidth: 1 });
  expect(read.wanted).toEqual([]);
  expect(read.incomplete).toBe(true);
  expect(read.unplaced.find((u) => u.target === "#2")?.reason).toContain(
    "#6 cannot be read",
  );
});

it("reserves one slot for a cyclic nested occupancy graph", async () => {
  const nested = issue("#6", ["epic"], null);
  const w = world({
    assigned: [issue("#2")],
    others: [issue("#1", ["epic"], "sam")],
    children: { "#1": [issue("#2"), nested], "#6": [nested] },
  });
  const read = await w.read({ epicWidth: 1 });
  expect(read.wanted).toEqual([]);
  expect(read.incomplete).toBe(true);
});

it("records every concurrent nested failure while the tracker wall dominates", async () => {
  const w = world({
    assigned: [issue("#2")],
    others: [issue("#1", ["epic"], "sam")],
    children: {
      "#1": [issue("#2"), issue("#6", ["epic"], null)],
      "#6": [issue("#7", ["epic"], null), issue("#8", ["epic"], null)],
      "#7": [issue("#9", [], null)],
      "#8": [issue("#10", [], null)],
    },
    limiting: ["#7"],
    failing: ["#8"],
  });
  const read = await w.read({ epicWidth: 1 });
  expect(read.limitedUntil).toBeDefined();
  expect(
    read.failures?.some((e) => e instanceof Error && e.message.includes("#8")),
  ).toBe(true);
});

it("does not inspect a planned human subtree while an eligible sibling can start", async () => {
  const description =
    "## Execution Plan\n```execution-plan-v1\n" +
    JSON.stringify({
      epic: "#1",
      intent: "deliver",
      steps: [
        { issue: "#2", band: 1, lane: "a", gate: "human" },
        { issue: "#3", band: 1, lane: "b", gate: "agent" },
      ],
      edges: [],
      gates: [],
    }) +
    "\n```";
  const w = world({
    assigned: [issue("#1", ["epic"])],
    descriptions: { "#1": description },
    children: {
      "#1": [issue("#2", ["epic"], null), issue("#3", [], null)],
      "#2": [issue("#4", ["epic"], null)],
      "#4": [issue("#5", [], null)],
    },
    limiting: ["#4"],
  });
  const read = await w.read({ epicWidth: 1 });
  expect(read.wanted.map((i) => i.key)).toEqual(["#3"]);
  expect(read.limitedUntil).toBeUndefined();
});

it("preserves a scope wall beside an ordinary nested failure", async () => {
  const { occupancySlots } = await import("../lib/sources/served-occupancy.ts");
  const { OutboundError } = await import("../../shared/outbound/failure.ts");
  const wall = new OutboundError("unreachable", "scope stopped");
  const ordinary = new Error("ordinary nested failure");
  const failures: unknown[] = [];
  const inspect = async (node: { identifier: string }) => {
    if (node.identifier === "#1")
      return {
        children: [issue("#2", ["epic"], null), issue("#3", ["epic"], null)],
        unread: [],
      };
    return Promise.reject(node.identifier === "#2" ? ordinary : wall);
  };
  await expect(
    occupancySlots(
      [issue("#1", ["epic"], null)],
      [],
      inspect,
      () => false,
      (_, error) => failures.push(error),
      { recursive: true, failed: (error) => failures.push(error) },
    ),
  ).rejects.toBe(wall);
  expect(failures).toEqual([ordinary]);
});

it("records both ordinary failures in concurrent nested reads", async () => {
  const { occupancySlots } = await import("../lib/sources/served-occupancy.ts");
  const failures: unknown[] = [];
  const errors = [new Error("first"), new Error("second")];
  const inspect = async (node: { identifier: string }) => {
    if (node.identifier === "#1")
      return {
        children: [issue("#2", ["epic"], null), issue("#3", ["epic"], null)],
        unread: [],
      };
    return Promise.reject(node.identifier === "#2" ? errors[0] : errors[1]);
  };
  await occupancySlots(
    [issue("#1", ["epic"], null)],
    [],
    inspect,
    () => false,
    (_, error) => failures.push(error),
    { recursive: true, failed: (error) => failures.push(error) },
  );
  expect(new Set(failures)).toEqual(new Set(errors));
});
