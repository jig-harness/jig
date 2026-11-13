/**
 * dispatch.stalled_scope: which of the identity's claimed items the stall
 * watch reads as pickups. Under `claimed` (the default) only an item a launch
 * record of this host or a claim marker took; under `assigned`, every one.
 */
import { describe, expect, it } from "bun:test";
import { claimMarkerBody } from "../../skills/do-item/scripts/lib/claim-marker.ts";
import type {
  CommentFact,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { dispatchSection } from "../lib/section.ts";
import { markClaims } from "../lib/sources/claim-markers.ts";
import type {
  ClaimedItem,
  DispatchSection,
  StalledScope,
} from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";

const NOW = Date.parse("2026-11-11T08:00:00Z");
const HOUR = 3_600_000;

function input(
  scope: StalledScope,
  claimed: ClaimedItem[],
  launches: ReadRecord[] = [],
  workspaces: Workspace[] = [],
) {
  return {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR / 2,
      blockedAfterMs: HOUR,
      stalledScope: scope,
    } as DispatchSection,
    pickups: [],
    claimed,
    sessions: { ok: true, source: "fake", workspaces },
    launches,
    idleSince: new Map(claimed.map((c) => [c.key, NOW - 2 * HOUR])),
    nowMs: NOW,
  } satisfies PickupInput;
}

const item = (extra: Partial<ClaimedItem> = {}): ClaimedItem => ({
  key: "#7",
  title: "task",
  state: "In Progress",
  ...extra,
});

/** A pickup of `key` that ended, after claiming it when `claimed`. */
function endedPickup(key: string, claimed: boolean): ReadRecord {
  return {
    record: {
      id: "2026-11-11T06-00-00-000Z-test",
      action: "pickup",
      repo: SLUG,
      item: key,
      pr: null,
      released: false,
      ...(claimed ? { claimedItems: [key] } : {}),
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-11T06:30:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
  };
}

function workspace(id: string, key: string): Workspace {
  return {
    id,
    path: `/work/${id}`,
    branch: `${id}-branch`,
    items: [key],
    prs: [],
    agents: [{ state: "working" } as Workspace["agents"][number]],
    unverifiableTerminals: 0,
    comment: "",
    unread: null,
    name: id,
  };
}

const stalled = (plan: ReturnType<typeof planPickups>) =>
  plan.actions.filter((a) => a.cause === "stalled").map((a) => a.target);

describe("the stall watch's scope", () => {
  it("leaves an identity's item no launch record or claim marker took quiet under claimed, and reports it under assigned", () => {
    const quiet = planPickups(input("claimed", [item()]));
    expect(quiet.actions).toEqual([]);
    expect(quiet.idleNow).toEqual([]);
    expect(quiet.quiet).toContainEqual(
      expect.objectContaining({
        target: "#7",
        class: "claimed-by-person",
        why: expect.stringContaining("dispatch.stalled_scope claimed"),
      }),
    );
    expect(stalled(planPickups(input("assigned", [item()])))).toEqual(["#7"]);
  });

  it("still reports a stall under claimed for an item a pickup of this host launched for", () => {
    for (const claimed of [true, false]) {
      const plan = planPickups(
        input("claimed", [item()], [endedPickup("#7", claimed)]),
      );
      expect(stalled(plan)).toEqual(["#7"]);
    }
  });

  it("watches an item a claim marker took, and waits on one whose markers could not be read", () => {
    expect(
      stalled(planPickups(input("claimed", [item({ claimMarker: "found" })]))),
    ).toEqual(["#7"]);
    const plan = planPickups(
      input("claimed", [item({ claimMarker: "unread" })]),
    );
    expect(stalled(plan)).toEqual([]);
    expect(plan.idleNow).toEqual([]);
  });

  it("still reports a double claim for an item outside the scope", () => {
    const plan = planPickups(
      input(
        "claimed",
        [item()],
        [],
        [workspace("a", "#7"), workspace("b", "#7")],
      ),
    );
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#7", cause: "double-claim" }),
    ]);
  });
});

/** A tracker whose items carry `comments`, counting the reads. */
function tracker(comments: Record<string, CommentFact[]>) {
  const reads: string[] = [];
  const t = {
    adapter: "github",
    team: SLUG,
    issueComments: async (key: string) => {
      reads.push(key);
      const list = comments[key];
      if (list === undefined) throw new Error("HTTP 502");
      return { uuid: key, comments: list };
    },
  } as unknown as Tracker;
  return { t, reads };
}

function memoryCache(): PickupReads {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (map.get(key) as T | undefined) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

const marker = (trusted: boolean): CommentFact => ({
  body: claimMarkerBody({
    session: "s",
    branch: "b",
    claimant: "factory-bot",
    at: "2026-11-11T06:00:00Z",
  }),
  createdAt: "2026-11-11T06:00:00Z",
  trusted,
});

describe("markClaims", () => {
  it("marks an item a trusted claim marker is on, and keeps each answer by the item's update time", async () => {
    const { t, reads } = tracker({
      "#1": [marker(true)],
      "#2": [marker(false)],
      "#3": [],
      "#4": [
        {
          ...marker(true),
          body: claimMarkerBody({
            session: "s",
            branch: "b",
            claimant: "someone-else",
            at: "2026-11-11T06:00:00Z",
          }),
        },
      ],
    });
    const cache = memoryCache();
    const items = ["#1", "#2", "#3", "#4"].map((key) =>
      item({ key, updatedAt: "2026-11-11T07:00:00Z" }),
    );
    const first = await markClaims(t, "factory-bot", items, cache);
    expect(first.claimed.map((c) => [c.key, c.claimMarker])).toEqual([
      ["#1", "found"],
      ["#2", undefined],
      ["#3", undefined],
      ["#4", undefined],
    ]);
    expect(first.unplaced).toEqual([]);
    const again = await markClaims(t, "factory-bot", items, cache);
    expect(again.claimed).toEqual(first.claimed);
    expect(reads).toEqual(["#1", "#2", "#3", "#4"]);
    await markClaims(
      t,
      "factory-bot",
      [item({ key: "#3", updatedAt: "2026-11-11T07:30:00Z" })],
      cache,
    );
    expect(reads).toEqual(["#1", "#2", "#3", "#4", "#3"]);
  });

  it("marks an item whose comments could not be read unread, with a row saying so", async () => {
    const { t } = tracker({});
    const read = await markClaims(t, "factory-bot", [item()], memoryCache());
    expect(read.claimed[0]?.claimMarker).toBe("unread");
    expect(read.unplaced).toEqual([
      expect.objectContaining({
        target: "#7",
        reason: expect.stringContaining("waits for a read"),
      }),
    ]);
  });
});

describe("dispatch.stalled_scope", () => {
  const scope = (value?: unknown) => {
    const read = dispatchSection({
      issue_tracker: { adapter: "github", github: { repository: SLUG } },
      dispatch: {
        identity: "factory-bot",
        ...(value === undefined ? {} : { stalled_scope: value }),
      },
    });
    return read.ok ? read.value.stalledScope : read.failure.reason;
  };

  it("is claimed by default, takes assigned, and refuses anything else", () => {
    expect(scope()).toBe("claimed");
    expect(scope("assigned")).toBe("assigned");
    expect(scope("everything")).toBe(
      "dispatch.stalled_scope must be claimed or assigned",
    );
  });
});
