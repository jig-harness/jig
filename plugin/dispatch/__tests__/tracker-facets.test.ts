/**
 * dispatch: the tick's tracker record says where each issue facet is kept
 * and which assigned items lack one, and the facet read is bounded by the
 * tick's deadline, never holding back the pickups.
 */
import { describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type {
  FacetReadOptions,
  FacetStoreReport,
  FacetStores,
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { FACET_READ_MS, facetBound } from "../lib/sources/tracker-facets.ts";
import type { DispatchSection } from "../lib/types.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, world } from "./fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";

const section = {
  identity: "factory",
  states: ["todo"],
} as unknown as DispatchSection;

function item(
  key: string,
  facets: Pick<PoolIssue, "type" | "priority" | "size">,
  labels: string[] = [],
): PoolIssue {
  return {
    identifier: key,
    title: `title of ${key}`,
    url: null,
    createdAt: "2026-11-01T00:00:00Z",
    state: { id: "s", name: "Todo", type: "unstarted" },
    assignee: { id: "u", name: "factory" },
    labels,
    hasOpenChildren: false,
    truncated: [],
    ...facets,
  };
}

const LABEL_STORES: FacetStores = {
  facets: [
    { facet: "type", store: "label", why: "kept in labels" },
    {
      facet: "priority",
      store: "native",
      why: "detected",
      field: "Priority",
      detection: {
        status: "read",
        labelEvidence: false,
        nativeEvidence: true,
        candidate: { store: "native", field: "Priority" },
        wouldSelect: "native",
        cached: true,
      },
    },
    { facet: "size", store: "label", why: "configured" },
  ],
  discovery: { status: "none", reason: "not asked" },
};

interface Fake {
  tracker: Tracker;
  calls: string[];
  options: FacetReadOptions[];
  assigned: FacetReadOptions[];
}

/** A tracker whose facet report is `stores` (or what it does), and whose assigned items are `issues`. */
function fakeTracker(
  issues: PoolIssue[],
  stores: (options: FacetReadOptions) => Promise<FacetStores>,
): Fake {
  const calls: string[] = [];
  const options: FacetReadOptions[] = [];
  const assigned: FacetReadOptions[] = [];
  const tracker = {
    adapter: "github",
    team: "example-org/example-repo",
    stateName: (s: string) => s,
    async facetStores(o: FacetReadOptions = {}) {
      calls.push("facetStores");
      options.push(o);
      return await stores(o);
    },
    async assignedIssues(
      _: string,
      states: readonly string[],
      o?: FacetReadOptions,
    ) {
      calls.push(`assignedIssues ${states.join(",")}`);
      if (o !== undefined) assigned.push(o);
      return states.includes("in_progress") ? [] : issues;
    },
    async assignedBy() {
      return { id: "p", name: "maintainer", trusted: true };
    },
  } as unknown as Tracker;
  return { tracker, calls, options, assigned };
}

const later = () => facetBound(undefined);

describe("the tick's tracker record and the issue facets", () => {
  it("names each facet's store and why, and the assigned items that lack one", async () => {
    const fake = fakeTracker(
      [
        item("#1", { type: "bug", priority: 2, size: "small" }),
        item("#2", { type: "docs", priority: 0, size: null }),
        item("#3", { type: null, priority: 3, size: null }, ["Epic"]),
      ],
      async () => LABEL_STORES,
    );
    const reading = await readPickups(() => fake.tracker, section, {
      bound: later,
      epic: "epic",
    });
    expect(reading.read.ok).toBe(true);
    expect(reading.read.facets?.stores).toEqual([
      { facet: "type", store: "label", why: "kept in labels" },
      { facet: "priority", store: "native", why: "detected", cached: true },
      { facet: "size", store: "label", why: "configured" },
    ]);
    // Keys and facets only; the epic needs no size.
    expect(reading.read.facets?.gaps).toEqual([
      { key: "#2", missing: ["priority", "size"] },
      { key: "#3", missing: ["type"] },
    ]);
    expect(reading.read.detail).toContain(
      "2 assigned item(s) lack a type, priority or size",
    );
    expect(reading.wanted.map((w) => w.key)).toEqual(["#1", "#2", "#3"]);
  });

  it("reads the stores first, without discovery, under the tick's signal and deadline", async () => {
    const fake = fakeTracker([], async () => LABEL_STORES);
    const before = Date.now();
    await readPickups(() => fake.tracker, section, {
      bound: later,
      epic: "epic",
    });
    expect(fake.calls[0]).toBe("facetStores");
    const [options] = fake.options;
    expect(options?.discovery).toBe(false);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.deadline).toBeGreaterThanOrEqual(before);
    expect(options?.deadline).toBeLessThanOrEqual(Date.now() + FACET_READ_MS);
  });

  it("asks nothing of a facet the repository has no store for", async () => {
    const none: FacetStoreReport = {
      facet: "size",
      store: null,
      why: "no facet",
    };
    const fake = fakeTracker(
      [item("#4", { type: "bug", priority: 2, size: null })],
      async () => ({
        ...LABEL_STORES,
        facets: [...LABEL_STORES.facets.slice(0, 2), none],
      }),
    );
    const reading = await readPickups(() => fake.tracker, section, {
      bound: later,
      epic: "epic",
    });
    expect(reading.read.facets?.gaps).toEqual([]);
  });

  it("stops a stalled store report at its share, and still reads the pickups", async () => {
    const fake = fakeTracker(
      [item("#5", { type: "bug", priority: 2, size: "small" })],
      (o) =>
        new Promise((_, reject) => {
          o.signal?.addEventListener("abort", () =>
            reject(new Error("the request was cancelled")),
          );
        }),
    );
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(Date.now() + 400),
      epic: "epic",
    });
    expect(reading.read.facets?.failed).toBe(
      "stopped at the tick's deadline: the request was cancelled",
    );
    expect(reading.read.facets?.stores).toBeUndefined();
    expect(reading.read.ok).toBe(true);
    expect(reading.wanted.map((w) => w.key)).toEqual(["#5"]);
    expect(fake.assigned[0]?.signal?.aborted).toBe(false);
  });

  it("gives the store report part of the tick's bound and the assigned items all of it", async () => {
    const fake = fakeTracker([], async () => LABEL_STORES);
    const bound = facetBound(undefined);
    await readPickups(() => fake.tracker, section, {
      bound: () => bound,
      epic: "epic",
    });
    expect(fake.options[0]?.deadline).toBeLessThan(bound.deadline);
    expect(fake.assigned[0]?.signal).toBe(bound.signal);
    expect(fake.assigned[0]?.deadline).toBe(bound.deadline);
  });

  it("starts no facet read once the tick's deadline has passed", async () => {
    const fake = fakeTracker([], async () => LABEL_STORES);
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(Date.now() - 1),
      epic: "epic",
    });
    expect(fake.calls).not.toContain("facetStores");
    expect(reading.read.facets?.failed).toContain(
      "the tick's deadline passed before the facet read could start",
    );
  });

  it("records a failed facet read as one line", async () => {
    const fake = fakeTracker([], async () => {
      throw new Error(`detection read failed: ${"x".repeat(400)}\nsecond line`);
    });
    const reading = await readPickups(() => fake.tracker, section, {
      bound: later,
      epic: "epic",
    });
    const failed = reading.read.facets?.failed ?? "";
    expect(failed.startsWith("detection read failed: ")).toBe(true);
    expect(failed.length).toBeLessThanOrEqual(300);
    expect(failed).not.toContain("second line");
    expect(reading.read.ok).toBe(true);
  });

  it("reaches the receipt of a tick", async () => {
    const w = world();
    try {
      w.setConfig(
        `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  identity: factory-bot\n`,
      );
      w.setIssues([assignedIssue(12, "factory-bot", [])]);
      w.setAssigner(12, "maintainer", "WRITE");
      machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
      const r = await w.dispatch(["--json"]);
      expectSpawnExit(r, 0);
      const receipt = JSON.parse(r.stdout) as TickReceipt;
      const read = receipt.repos[0]?.records.find(
        (x) => x.record === "tracker",
      );
      expect(read?.facets?.stores?.map((s) => s.facet)).toEqual([
        "type",
        "priority",
        "size",
      ]);
      // The repository has no label taxonomy, so it has no size facet.
      expect(read?.facets?.gaps).toEqual([
        { key: "#12", missing: ["type", "priority"] },
      ]);
    } finally {
      w.close();
    }
  });

  it("bounds the facet read by the tick's own deadline when it is sooner", () => {
    const now = 1_000_000;
    expect(facetBound(now + 5_000, now).deadline).toBe(now + 5_000);
    expect(facetBound(undefined, now).deadline).toBe(now + FACET_READ_MS);
    expect(facetBound(now + 10 * FACET_READ_MS, now).deadline).toBe(
      now + FACET_READ_MS,
    );
  });
});
