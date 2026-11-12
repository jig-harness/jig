/**
 * dispatch and the optional `pr_open` state: an item whose pull request is
 * open is claimed work, so the stall and double-claim watch reads it beside
 * `in_progress` where the repository names it, and `dispatch.states` may not
 * offer it for pickup.
 */
import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { dispatchSection } from "../lib/section.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import type { DispatchSection } from "../lib/types.ts";

const section = {
  identity: "factory",
  states: ["todo"],
} as unknown as DispatchSection;

function item(key: string, state: string): PoolIssue {
  return {
    identifier: key,
    title: `title of ${key}`,
    url: null,
    createdAt: "2026-11-01T00:00:00Z",
    state: { id: state, name: state, type: "started" },
    assignee: { id: "u", name: "factory" },
    labels: [],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
    type: null,
    priority: 0,
    size: null,
  };
}

/** A tracker naming `pr_open` as `prOpen`, holding one item in each working state. */
function fakeTracker(prOpen: string | null) {
  const asked: string[][] = [];
  const names: Record<string, string | null> = {
    todo: "Todo",
    in_progress: "In Progress",
    pr_open: prOpen,
    in_review: "In Review",
    ops_pending: "Ops Pending",
  };
  const held: Record<string, PoolIssue> = {
    in_progress: item("#1", "In Progress"),
    pr_open: item("#2", prOpen ?? "unnamed"),
  };
  const tracker = {
    adapter: "github",
    team: "example-org/example-repo",
    stateName: (s: string) => names[s] ?? null,
    async assignedIssues(_: string, states: readonly string[]) {
      asked.push([...states]);
      return states.flatMap((s) => (held[s] === undefined ? [] : [held[s]]));
    },
    async assignedBy() {
      return { id: "p", name: "maintainer", trusted: true };
    },
  } as unknown as Tracker;
  return { tracker, asked };
}

describe("the claim watch and pr_open", () => {
  it("watches pr_open items beside in_progress ones where the repository names it", async () => {
    const fake = fakeTracker("Awaiting Review");
    const reading = await readPickups(() => fake.tracker, section);
    expect(fake.asked).toContainEqual(["in_progress", "pr_open"]);
    expect(reading.claimed?.map((c) => c.key)).toEqual(["#1", "#2"]);
    expect(reading.read.detail).toContain(
      "2 in In Progress or Awaiting Review",
    );
  });

  it("watches in_progress alone where pr_open shares in_review's name, since merged items wait there too", async () => {
    const fake = fakeTracker("in review");
    const reading = await readPickups(() => fake.tracker, section);
    expect(fake.asked.flat()).not.toContain("pr_open");
    expect(reading.claimed?.map((c) => c.key)).toEqual(["#1"]);
  });

  it("watches in_progress alone while pr_open is unset", async () => {
    const fake = fakeTracker(null);
    const reading = await readPickups(() => fake.tracker, section);
    expect(fake.asked).toContainEqual(["in_progress"]);
    expect(fake.asked.flat()).not.toContain("pr_open");
    expect(reading.claimed?.map((c) => c.key)).toEqual(["#1"]);
    expect(reading.read.detail).toContain("1 in In Progress");
  });
});

describe("dispatch.states and pr_open", () => {
  it("refuses pr_open as a pickup state", () => {
    const read = dispatchSection({
      dispatch: { identity: "factory", states: ["todo", "pr_open"] },
    });
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.failure.reason).toContain(
        "dispatch.states cannot list pr_open",
      );
  });

  it("refuses a pickup state aliased to pr_open", () => {
    const read = dispatchSection({
      issue_tracker: { states: { pr_open: "Review", in_review: "Review" } },
      dispatch: { identity: "factory", states: ["in_review"] },
    });
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.failure.reason).toContain(
        "dispatch.states cannot list in_review",
      );
  });
});
