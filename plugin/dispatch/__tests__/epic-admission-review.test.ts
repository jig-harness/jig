import { expect, it } from "bun:test";
import { world, people } from "./served-blocker-fixtures.ts";
import { issue } from "./served-fixtures.ts";
import { dispatchSection } from "../lib/section.ts";
import { readPickups } from "../lib/sources/tracker.ts";

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
  expect(read.wanted.map((i) => i.key)).toEqual(["#12", "#13"]);
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
  const read = await w.read();
  expect(read.wanted.map((i) => i.key)).toEqual(["#3"]);
  expect(read.limitedUntil).toBeUndefined();
});
