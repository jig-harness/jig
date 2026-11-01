/**
 * A pickup's expectation of opening a pull request: only one created after
 * the launch meets it; one its reused workspace already carried does not.
 */
import { describe, expect, it } from "bun:test";
import { planDrift } from "../lib/expectations.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { DispatchSection } from "../lib/types.ts";

const LAUNCHED = "2026-11-01T10:00:00.000Z";
const NOW = Date.parse("2026-11-01T14:00:00.000Z");

function input(created: Map<number, string>) {
  const r = {
    record: {
      id: "pick-1",
      action: "pickup",
      repo: "o/a",
      item: "#5",
      createdAt: LAUNCHED,
      workspace: { id: "w", path: "/work/w" },
    },
    state: { kind: "alive" },
    result: null,
  } as unknown as ReadRecord;
  return {
    slug: "o/a",
    section: { pickupWithinMs: 3_600_000 } as DispatchSection,
    launches: [r],
    sessions: {
      ok: true,
      source: "test",
      workspaces: [
        {
          id: "w",
          path: "/work/w",
          branch: "",
          items: [],
          prs: [3],
          agents: [],
        },
      ],
    },
    created,
    itemStates: new Map<string, string>(),
    waiting: new Set<string>(),
    nowMs: NOW,
  } as unknown as Parameters<typeof planDrift>[0];
}

describe("a pickup's pull request", () => {
  it("is drifting when its workspace carries only a pull request older than the launch", () => {
    const older = planDrift(input(new Map([[3, "2026-10-01T00:00:00.000Z"]])));
    expect(older.actions.length + older.running.length).toBeGreaterThan(0);
  });

  it("meets the expectation when the pull request was created after the launch", () => {
    const mine = planDrift(input(new Map([[3, "2026-11-01T11:00:00.000Z"]])));
    expect(mine.actions).toEqual([]);
    expect(mine.running).toEqual([]);
  });
});
