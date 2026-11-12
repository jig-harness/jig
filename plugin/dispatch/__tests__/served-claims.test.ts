import { describe, expect, it } from "bun:test";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import { releaseEnded } from "../lib/actions/pickup-hold.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import type { ClaimedItem, DispatchSection } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";
import { issue } from "./served-fixtures.ts";

const NOW = Date.parse("2026-11-11T08:00:00Z");
const HOUR = 3_600_000;

function input(claimed: ClaimedItem[], launches: ReadRecord[] = []) {
  return {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
    } as DispatchSection,
    pickups: [],
    claimed,
    sessions: { ok: true, source: "fake", workspaces: [] },
    launches,
    idleSince: new Map(claimed.map((c) => [c.key, NOW - 2 * HOUR])),
    nowMs: NOW,
  } satisfies PickupInput;
}

/** A pickup of `item` that ended without a question, optionally after claiming it. */
function endedPickup(item: string, claimed = true): ReadRecord {
  return {
    record: {
      id: "2026-11-11T06-00-00-000Z-test",
      action: "pickup",
      repo: SLUG,
      item,
      pr: null,
      released: false,
      ...(claimed ? { claimedItems: [item] } : {}),
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-11T06:30:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
  };
}

describe("claimed items read for a served person", () => {
  it("leaves the person's own work in progress quiet", () => {
    const plan = planPickups(
      input([{ key: "#7", title: "epic", state: "In Progress", served: true }]),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.idleNow).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#7", class: "claimed-by-person" }),
    );
  });

  it("reports a stall once a pickup of this machine claimed the item", () => {
    const plan = planPickups(
      input(
        [{ key: "#7", title: "task", state: "In Progress", served: true }],
        [endedPickup("#7")],
      ),
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#7", cause: "stalled" }),
    ]);
  });

  it("leaves a served person's claim quiet when the pickup ended before claiming it", () => {
    const plan = planPickups(
      input(
        [{ key: "#7", title: "task", state: "In Progress", served: true }],
        [endedPickup("#7", false)],
      ),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.idleNow).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#7", class: "claimed-by-person" }),
    );
  });

  it("leaves a served person's claim quiet while an unclaiming pickup waits on the rate limit", () => {
    const record = endedPickup("#7", false);
    record.result = "waits";
    record.waitsUntil = new Date(NOW + HOUR).toISOString();
    const plan = planPickups(
      input(
        [{ key: "#7", title: "task", state: "In Progress", served: true }],
        [record],
      ),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.idleNow).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#7", class: "claimed-by-person" }),
    );
  });

  it("does not attribute a later served claim to an ended pickup", () => {
    const record = endedPickup("#7", false);
    releaseEnded(
      [record],
      SLUG,
      new Set(),
      new Set(["#7"]),
      new Set(),
      undefined,
      new Set(["#7"]),
    );
    expect(record.record.claimedItems).toBeUndefined();

    const plan = planPickups(
      input(
        [{ key: "#7", title: "task", state: "In Progress", served: true }],
        [record],
      ),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#7", class: "claimed-by-person" }),
    );
  });

  it("does not attribute a served claim to a pickup that is only reserved", () => {
    const record = endedPickup("#7", false);
    record.state = { kind: "pending" };
    releaseEnded(
      [record],
      SLUG,
      new Set(),
      new Set(["#7"]),
      new Set(),
      undefined,
      new Set(["#7"]),
    );
    expect(record.record.claimedItems).toBeUndefined();
  });

  it("still reports the dispatch identity's own idle claim", () => {
    const plan = planPickups(
      input([{ key: "#7", title: "task", state: "In Progress" }]),
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#7", cause: "stalled" }),
    ]);
  });

  it("marks what the served reader claims as served", async () => {
    const tracker = {
      adapter: "github",
      assignedIssues: async (_: string, states: string[]) =>
        states.includes("in_progress")
          ? [
              {
                ...issue("#7"),
                state: { id: "p", name: "In Progress", type: "started" },
              },
            ]
          : [],
      stateName: (s: string) => (s === "pr_open" ? null : s),
    } as unknown as Tracker;
    const read = await readServedPickups(
      tracker,
      [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }],
      { epic: "epic", nowMs: NOW, headroom: true },
    );
    expect(read.claimed).toEqual([
      {
        key: "#7",
        title: "#7",
        state: "In Progress",
        served: true,
        url: null,
      },
    ]);
  });
});
