/**
 * What overlap reads and says: the footprints read through the tracker port
 * (the wanted pickups first, a running pickup's session named, nothing read
 * when nothing is wanted, a failed read an unknown footprint with its
 * failure class), and the reasons and notes a person sees.
 */
import { describe, expect, it } from "bun:test";
import type {
  FootprintItem,
  FootprintReading,
  FootprintReadOptions,
} from "../../skills/do-item/scripts/lib/tracker/footprint-port.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { DEFAULT_OVERLAP } from "../lib/overlap-config.ts";
import {
  footprintItems,
  MAX_FRESH,
  readOverlapFacts,
} from "../lib/overlap-observe.ts";
import { footprintOf, overlapModel, readingNote } from "../lib/overlap-plan.ts";
import { type InFlight, walkOverlap } from "../lib/overlap.ts";
import {
  entryOf,
  hotspotProposal,
  overlapLines,
  reasonOf,
  whenText,
} from "../lib/overlap-reasons.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { ClaimedItem, WantedItem } from "../lib/types.ts";
import { parseMs } from "../../shared/time.ts";

const NOW = parseMs("2026-11-18T12:00:00.000Z");
const CATALOG = `areas:
  dispatch:
    paths: ["src/dispatch/**"]
    tracker:
      labels: ["area:dispatch"]
`;

const wanted = (key: string, labels: string[] = []): WantedItem =>
  ({
    key,
    title: key,
    url: null,
    state: "Todo",
    assignee: "factory-bot",
    assignedBy: "maintainer",
    updatedAt: "2026-11-18T10:00:00.000Z",
    queueIssue: { labels, priority: 3 },
  }) as unknown as WantedItem;

const reading = (
  key: string,
  more: Partial<FootprintReading> = {},
): FootprintReading => ({
  key,
  source: "unknown",
  paths: [],
  areas: [],
  record: null,
  readAt: null,
  ageMs: null,
  stale: false,
  ...more,
});

function fakeTracker(
  answer: (
    items: readonly FootprintItem[],
    options: FootprintReadOptions,
  ) => Map<string, FootprintReading>,
) {
  const calls: Array<{
    items: readonly FootprintItem[];
    options: FootprintReadOptions;
  }> = [];
  const tracker = {
    footprints: async (
      items: readonly FootprintItem[],
      options: FootprintReadOptions,
    ) => {
      calls.push({ items, options });
      return answer(items, options);
    },
  } as unknown as Tracker;
  return { tracker, calls };
}

const base = {
  claimed: [] as ClaimedItem[],
  records: [] as ReadRecord[],
  catalogText: CATALOG,
  where: "example-org/example-repo@main",
  nowMs: NOW,
};

describe("the footprint read", () => {
  it("reads the wanted pickups first, then the claimed items, with each live batch member's session named", async () => {
    const running = {
      record: {
        action: "pickup",
        item: "#30",
        batchItems: [{ key: "#30" }, { key: "#31" }],
        sessionId: "s-1",
      },
      state: { kind: "alive" },
    } as unknown as ReadRecord;
    const items = footprintItems({
      ...base,
      tracker: null,
      wanted: [wanted("#12", ["area:dispatch"]), wanted("#13")],
      claimed: [
        { key: "#30", title: "", state: "In progress" },
        { key: "#31", title: "", state: "In progress" },
        { key: "#12", title: "", state: "x" },
      ],
      records: [running],
    });
    expect(items).toEqual([
      {
        key: "#12",
        labels: ["area:dispatch"],
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
      { key: "#13", labels: [], updatedAt: "2026-11-18T10:00:00.000Z" },
      { key: "#30", labels: [], activePickup: "s-1" },
      { key: "#31", labels: [], activePickup: "s-1" },
    ]);
  });

  it("asks the port once, bounded, with the catalog's area labels and a cache kept for the tracker", async () => {
    const { tracker, calls } = fakeTracker(() => new Map());
    await readOverlapFacts({ ...base, tracker, wanted: [wanted("#12")] });
    await readOverlapFacts({ ...base, tracker, wanted: [wanted("#12")] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toMatchObject({
      maxFresh: MAX_FRESH,
      areaLabels: { dispatch: ["area:dispatch"] },
    });
    expect(calls[0]?.options.cache).toBe(calls[1]?.options.cache as never);
  });

  it("reads nothing while no pickup is wanted", async () => {
    const { tracker, calls } = fakeTracker(() => new Map());
    const facts = await readOverlapFacts({ ...base, tracker, wanted: [] });
    expect(calls).toHaveLength(0);
    expect(facts.readings.size).toBe(0);
  });

  it("leaves every footprint unknown, saying why, when the port fails or no tracker was opened", async () => {
    const { tracker } = fakeTracker(() => {
      throw new Error("the tracker went away");
    });
    const failed = await readOverlapFacts({
      ...base,
      tracker,
      wanted: [wanted("#12")],
    });
    expect(failed.readings.size).toBe(0);
    expect(failed.notes).toEqual([
      "the footprints could not be read, so every footprint is unknown: the tracker went away",
    ]);
    const none = await readOverlapFacts({
      ...base,
      tracker: null,
      wanted: [wanted("#12")],
    });
    expect(none.notes).toEqual([
      "the tracker was not opened, so every footprint is unknown",
    ]);
    expect(footprintOf(none.readings.get("#12")).known).toBe(false);
  });

  it("notes a catalog that does not read, and reads on without it", async () => {
    const { tracker } = fakeTracker(() => new Map());
    const facts = await readOverlapFacts({
      ...base,
      tracker,
      catalogText: "areas: [",
      wanted: [wanted("#12")],
    });
    expect(facts.catalog).toBeNull();
    expect(facts.notes[0]).toContain(
      "so area labels give no footprint and no path is generated",
    );
  });
});

describe("the footprint note beside the rank", () => {
  it("names a failed read's class, a read the tick left for later, labels alone, and no record at all", () => {
    expect(
      readingNote(
        reading("#12", {
          failure: {
            code: "rate-limited",
            reason: "the tracker refused the credential",
          },
        }),
        "unread",
      ),
    ).toBe(
      "footprint unknown: its footprint did not read (rate-limited: the tracker refused the credential)",
    );
    expect(
      readingNote(
        reading("#12", { reason: "fresh footprint read limit", stale: true }),
        "unread",
      ),
    ).toBe(
      "footprint unknown: its footprint was not read this tick (fresh footprint read limit)",
    );
    expect(
      readingNote(
        reading("#12", {
          source: "record" as FootprintReading["source"],
          paths: ["a.ts"],
          readAt: 1,
          ageMs: 5,
          reason: "timeout",
          stale: true,
        }),
        "unread",
      ),
    ).toBe("footprint stale: timeout");
    expect(
      readingNote(
        reading("#12", { source: "labels", areas: ["dispatch"] }),
        "unread",
      ),
    ).toBe(
      "footprint unknown: no footprint record; derived from its area labels (dispatch)",
    );
    expect(
      readingNote(
        reading("#12", {
          source: "labels",
          areas: ["dispatch"],
          readAt: 1,
          stale: true,
          failure: { code: "rate-limited", reason: "the tracker said wait" },
        }),
        "unread",
      ),
    ).toBe(
      "footprint unknown: no footprint record; derived from its area labels (dispatch); stale: the tracker said wait",
    );
    expect(readingNote(reading("#12"), "unread")).toBe(
      "footprint unknown: no footprint record and no area label",
    );
    expect(readingNote(undefined, "it was not read this tick")).toBe(
      "footprint unknown: it was not read this tick",
    );
    expect(
      readingNote(
        reading("#12", { source: "pickup", paths: ["a.ts"] }),
        "unread",
      ),
    ).toBeNull();
  });

  it("weighs a failed read that kept its last reading by that reading", () => {
    const kept = reading("#12", {
      source: "scout",
      paths: ["src/a.ts", "src/b/"],
      stale: true,
      reason: "timeout",
    });
    expect(footprintOf(kept)).toEqual({
      known: true,
      files: ["src/a.ts"],
      dirs: ["src/b/"],
      areas: [],
    });
  });
});

describe("the reasons a person sees", () => {
  const m = overlapModel(
    { ...DEFAULT_OVERLAP, maxPerFile: 2 },
    () => 0.5,
    null,
  );
  const pr = (n: number, files: string[]): InFlight => ({
    kind: "pull request",
    ref: `#${n}`,
    url: `https://example.test/pull/${n}`,
    state: "open",
    footprint: { known: true, files, dirs: [], areas: [] },
    quiet: false,
  });
  const c = (item: string, files: string[] | null) => ({
    item,
    url: null,
    priority: "medium" as const,
    footprint:
      files === null
        ? { known: false, files: [], dirs: [], areas: [] }
        : { known: true, files, dirs: [], areas: [] },
  });

  it("says what a pickup shares, with what, the rounds expected and when its patience is spent", () => {
    const [p] = walkOverlap(
      [c("#12", ["src/load.ts", "src/b.ts", "src/c.ts"])],
      [pr(20, ["src/load.ts", "src/b.ts"]), pr(21, ["src/c.ts"])],
      new Map(),
      m,
      NOW,
    );
    const reason = p === undefined ? null : reasonOf(p, NOW);
    expect(reason).toEqual({
      relation: "waits on overlap",
      item: "#12",
      on: [
        {
          kind: "pull request",
          ref: "#20",
          state: "open",
          url: "https://example.test/pull/20",
        },
        {
          kind: "pull request",
          ref: "#21",
          state: "open",
          url: "https://example.test/pull/21",
        },
      ],
      count: 2,
      text: "waits on overlap: shares src/b.ts (+2) with #20 (pull request) and #21 (pull request); 1.3 rounds expected; first when a slot is free after work that does not overlap, or from 14:30 UTC",
    });
  });

  it("says a pickup waits on the bound, with the work that changes the file", () => {
    const [p] = walkOverlap(
      [c("#12", ["src/hot.ts"])],
      [pr(20, ["src/hot.ts"]), pr(21, ["src/hot.ts"])],
      new Map(),
      m,
      NOW,
    );
    expect(p === undefined ? null : reasonOf(p, NOW)?.text).toBe(
      "waits on the overlap bound: 2 in flight already change src/hot.ts (#20, #21); starts when no other work can take a slot",
    );
  });

  it("says an unknown footprint waits on overlap, and keeps the entry's facts", () => {
    const [p] = walkOverlap([c("#12", null)], [], new Map(), m, NOW);
    if (p === undefined) throw new Error("no placement");
    const entry = entryOf(
      p,
      1,
      {
        source: "unknown",
        note: "footprint unknown: no footprint record and no area label",
      },
      NOW,
    );
    expect(entry).toMatchObject({
      item: "#12",
      rank: 1,
      turn: 1,
      tier: 2,
      cost: 0.5,
      waitingSince: "2026-11-18T12:00:00.000Z",
      footprint: "unknown",
      footprintNote: "footprint unknown: no footprint record and no area label",
      reason: { relation: "waits on overlap", on: [], count: 0 },
    });
    expect(entry.reason?.text).toStartWith(
      "waits on overlap: its footprint is unknown; 0.5 rounds expected",
    );
    expect(
      overlapLines({
        rates: { measuredAt: null, defaulted: "no conflict rates yet" },
        inFlight: { pullRequests: 0, pickups: 0, unknown: [] },
        entries: [entry],
        hotspots: [
          {
            path: "a.ts",
            day: "2026-11-18",
            ticks: 3,
            proposal: hotspotProposal("a.ts", "2026-11-18", 3),
          },
        ],
        notes: [],
      }),
    ).toEqual([
      "  overlap  in flight: 0 pull request(s), 0 pickup(s); no conflict rates yet",
      `  overlap  #12 (rank 1) tier 2, 0.5 round(s): ${entry.reason?.text} [footprint unknown: no footprint record and no area label]`,
      "  hotspot  a.ts kept work over the overlap bound in 3 ticks on 2026-11-18: resolve-conflicts' `history.ts --propose-serialize` proposes the serialized area a person may add to the change-area catalog",
    ]);
  });

  it("names a time on another day with its date", () => {
    expect(whenText(NOW + 2 * 3_600_000, NOW)).toBe("14:00 UTC");
    expect(whenText(NOW + 24 * 3_600_000, NOW)).toBe("2026-11-19 12:00 UTC");
  });
});
