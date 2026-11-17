/** The pure ranker: lanes, inheritance, gaps, weights, hashes and disagreements. */
import { describe, expect, test } from "bun:test";
import { rank } from "../priorities/ranker.ts";
import type { WeekCharge } from "../priorities/week.ts";
import {
  epic,
  input,
  item,
  objective,
  objectiveWork,
  record,
  SCOPE,
  weights,
} from "./priorities-fixtures.ts";

/** The same value with every object's keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, reverseKeys(v)]),
  );
}

function charge(lane: WeekCharge["lane"], i: number): WeekCharge {
  return {
    claimId: `c${i}`,
    lane,
    objective: null,
    peripheralShare: 0.1,
    atMs: i,
  };
}

describe("the ranker's determinism", () => {
  test("equal input hashes give equal output, whatever the key order of the input", () => {
    const a = input({
      snapshot: { readAt: "t", items: objectiveWork(3) },
    });
    const b = reverseKeys(a) as typeof a;
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    const first = rank(a);
    const second = rank(b);
    expect(second.inputHash).toBe(first.inputHash);
    expect(second).toEqual(first);
    expect(first.algorithm).toBe("priorities-ranker/1");
    expect(Object.keys(first.inputHashes).sort()).toEqual([
      "asOf",
      "capacity",
      "epochs",
      "records",
      "snapshot",
      "week",
      "weights",
    ]);
  });

  test("a changed epoch revision changes the input hash", () => {
    const a = input({ snapshot: { readAt: "t", items: objectiveWork(1) } });
    const b = { ...a, epochs: { revision: 7, startN: {} } };
    expect(rank(b).inputHash).not.toBe(rank(a).inputHash);
  });
});

describe("lanes", () => {
  test("Urgent and High-bug work come first and next, and neither counts toward N", () => {
    const items = [
      ...objectiveWork(2),
      item("#900", { priority: 1, type: "bug" }),
      item("#901", { priority: 2, type: "bug" }),
    ];
    const out = rank(
      input({
        snapshot: { readAt: "t", items },
        week: {
          week: "2026-11-16",
          d0: 0,
          d0Reason: null,
          charges: [charge("urgent", 0), charge("bug-high", 1)],
        },
      }),
    );
    expect(out.shortlist.slice(0, 3).map((p) => [p.key, p.lane])).toEqual([
      ["#900", "urgent"],
      ["#901", "bug-high"],
      ["#101", "core"],
    ]);
    // The urgent and bug-high charges left N at 0: core opens with its 0.5 deficit.
    expect(out.shortlist[2]?.reason).toContain("largest deficit, 0.5 (N 0,");
  });

  test("an Urgent item is listed even when blocked, and takes no start", () => {
    const out = rank(
      input({
        snapshot: {
          readAt: "t",
          items: [item("#900", { priority: 1, blockers: ["#1"] })],
        },
      }),
    );
    expect(out.shortlist).toHaveLength(1);
    expect(out.shortlist[0]).toMatchObject({ lane: "urgent", eligible: false });
    expect(out.shortlist[0]?.reason).toContain("waiting on #1");
  });

  test("bug-other never jumps ahead of an objective lane on a tie", () => {
    // Equal weights: every lane's deficit ties at the first start.
    const out = rank(
      input({
        snapshot: {
          readAt: "t",
          items: [
            ...objectiveWork(2, ["tactical"]),
            item("#400", { type: "bug", priority: 3 }),
          ],
        },
        weights: weights({
          core: 25,
          tactical: 25,
          peripheral: 25,
          "bug-other": 25,
        }),
        capacity: { starts: 1 },
      }),
    );
    expect(out.shortlist[0]?.lane).toBe("tactical");
  });

  test("a bug sits in its bug lane whatever objective it also belongs to", () => {
    const out = rank(
      input({
        snapshot: {
          readAt: "t",
          items: [
            epic("#100"),
            item("#150", { parent: "#100", type: "bug", priority: 4 }),
          ],
        },
      }),
    );
    expect(out.shortlist[0]).toMatchObject({ key: "#150", lane: "bug-other" });
    expect(out.shortlist[0]?.alsoIn).toEqual([`repository:${SCOPE}:core-goal`]);
  });

  test("a weight of 0 takes a lane out of rotation, and Urgent work stays listed", () => {
    const out = rank(
      input({
        snapshot: {
          readAt: "t",
          items: [...objectiveWork(2, ["core"]), item("#900", { priority: 1 })],
        },
        weights: weights({ core: 0 }),
      }),
    );
    expect(out.shortlist.map((p) => p.key)).toEqual(["#900"]);
    expect(out.lanes.find((l) => l.lane === "core")).toMatchObject({
      inRotation: false,
      share: 0,
    });
    expect(out.excluded).toContainEqual({
      key: "#101",
      reason: "its lane core is out of rotation",
    });
  });
});

describe("membership", () => {
  test("an epic's rank reaches its children, before their own Priority", () => {
    const rec = record({
      objectives: [objective("core-goal", "core", ["#110", "#120"])],
    });
    const out = rank(
      input({
        records: [rec],
        snapshot: {
          readAt: "t",
          items: [
            epic("#110"),
            epic("#120"),
            item("#121", { parent: "#120", priority: 2 }),
            item("#111", { parent: "#110", priority: 4 }),
            // A grandchild inherits through its parent.
            item("#112", { parent: "#111", priority: 3 }),
          ],
        },
      }),
    );
    expect(out.shortlist.map((p) => p.key)).toEqual(["#112", "#111", "#121"]);
  });

  test("duplicate membership: the first matching objective owns the item, the others report it", () => {
    const rec = record({
      objectives: [
        objective("core-goal", "core", ["#100"]),
        objective("side-goal", "peripheral", ["#100"]),
      ],
    });
    const out = rank(
      input({
        records: [rec],
        snapshot: { readAt: "t", items: objectiveWork(1, ["core"]) },
      }),
    );
    expect(out.shortlist[0]).toMatchObject({
      key: "#101",
      lane: "core",
      objective: "core-goal",
      owners: { repository: `repository:${SCOPE}:core-goal` },
      alsoIn: [`repository:${SCOPE}:side-goal`],
    });
    expect(out.lanes.find((l) => l.lane === "peripheral")?.ready).toBe(0);
  });

  test("owners at different levels that name different classes are an allocation conflict", () => {
    const site = {
      level: "site" as const,
      scope: "hub",
      revision: 1,
      objectives: [objective("site-goal", "tactical", ["#100"])],
    };
    const out = rank(
      input({
        records: [record(), site],
        snapshot: { readAt: "t", items: objectiveWork(1, ["core"]) },
      }),
    );
    expect(out.shortlist).toHaveLength(0);
    expect(out.excluded.find((e) => e.key === "#101")?.reason).toContain(
      "an allocation conflict",
    );
  });

  test("an infeasible revision blocks objective allocation, and urgent work still ranks", () => {
    const out = rank(
      input({
        allocationBlocked: "the newest revision is infeasible",
        snapshot: {
          readAt: "t",
          items: [...objectiveWork(1, ["core"]), item("#900", { priority: 1 })],
        },
      }),
    );
    expect(out.shortlist.map((p) => p.key)).toEqual(["#900"]);
    expect(out.unallocated).toEqual([
      { key: "#101", reason: "the newest revision is infeasible" },
    ]);
    expect(out.problems).toContain("the newest revision is infeasible");
  });

  test("unreadable parentage and a parent cycle are incomplete evidence, excluded from allocation", () => {
    const out = rank(
      input({
        snapshot: {
          readAt: "t",
          items: [
            item("#101", { gaps: ["parent"] }),
            item("#102", { parent: "#103" }),
            item("#103", { parent: "#102" }),
          ],
        },
      }),
    );
    expect(out.shortlist).toHaveLength(0);
    expect(out.excluded.map((e) => e.reason)).toEqual([
      "incomplete evidence: its parent could not be read",
      "incomplete evidence: its parents form a cycle through #102",
      "incomplete evidence: its parents form a cycle through #103",
    ]);
  });
});

describe("unknown facets", () => {
  test("a bug with no priority is a gap, after the bugs whose priority is known, never read as Low", () => {
    const out = rank(
      input({
        records: [],
        snapshot: {
          readAt: "t",
          items: [
            item("#401", { type: "bug", priority: null, gaps: ["priority"] }),
            item("#402", { type: "bug", priority: 4 }),
            item("#403", { type: "bug", priority: 3 }),
          ],
        },
      }),
    );
    expect(out.shortlist.map((p) => [p.key, p.gaps])).toEqual([
      ["#403", []],
      ["#402", []],
      ["#401", ["priority"]],
    ]);
  });

  test("an item with no priority is never Urgent and never a High bug", () => {
    const out = rank(
      input({
        records: [],
        snapshot: {
          readAt: "t",
          items: [item("#401", { type: "bug", priority: null })],
        },
      }),
    );
    expect(out.shortlist[0]?.lane).toBe("bug-other");
  });

  test("work outside every objective and not a bug stays visible as unallocated", () => {
    const out = rank(
      input({ snapshot: { readAt: "t", items: [item("#77")] } }),
    );
    expect(out.unallocated).toEqual([
      { key: "#77", reason: "outside every objective and not a bug" },
    ]);
  });
});

describe("the peripheral floor", () => {
  test("an opening debt carried across the week boundary restricts the choice to peripheral work once a whole start is owed", () => {
    const out = rank(
      input({
        snapshot: { readAt: "t", items: objectiveWork(3) },
        capacity: { starts: 1 },
        week: { week: "2026-11-16", d0: 0.9, d0Reason: null, charges: [] },
      }),
    );
    expect(out.shortlist[0]).toMatchObject({ lane: "peripheral" });
    expect(out.shortlist[0]?.reason).toContain("owed a whole start");
  });

  test("with the floor owed and no peripheral work ready, the start is lent and reported", () => {
    const out = rank(
      input({
        snapshot: { readAt: "t", items: objectiveWork(3, ["core"]) },
        capacity: { starts: 1 },
        week: { week: "2026-11-16", d0: 0.9, d0Reason: null, charges: [] },
      }),
    );
    expect(out.shortlist[0]?.lane).toBe("core");
    expect(out.floor.lent).toBe(1);
  });
});

describe("disagreements", () => {
  test("an epic's inherited position against a child's tracker Priority is reported, never edited", () => {
    const rec = record({
      objectives: [objective("core-goal", "core", ["#110", "#120"])],
    });
    const items = [
      epic("#110"),
      epic("#120"),
      item("#111", { parent: "#110", priority: 4 }),
      item("#121", { parent: "#120", priority: 2 }),
    ];
    const out = rank(
      input({ records: [rec], snapshot: { readAt: "t", items } }),
    );
    expect(out.disagreements).toEqual([
      {
        objective: "core-goal",
        ahead: { key: "#111", epic: "#110", priority: 4 },
        behind: { key: "#121", epic: "#120", priority: 2 },
        rule: "an epic's declared position orders its children before their own tracker Priority",
      },
    ]);
    expect(items[3]?.priority).toBe(2);
  });
});
