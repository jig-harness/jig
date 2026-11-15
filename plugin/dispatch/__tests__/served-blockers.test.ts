import { describe, expect, it } from "bun:test";
import type {
  CanonicalState,
  PoolIssue,
  StateContext,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import { TrackerRateLimited } from "../../shared/outbound/budget.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { dispatchSection } from "../lib/section.ts";
import { freshServedPickup, readServedPickups } from "../lib/sources/served.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { issue } from "./served-fixtures.ts";

const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];

const started = (key: string, assignee: string | null = null): PoolIssue => ({
  ...issue(key, [], assignee),
  state: { id: "s", name: "In Progress", type: "started" },
});

interface Spec {
  /** What the served person is assigned. */
  assigned: PoolIssue[];
  /** Every other item a read can reach. */
  others?: PoolIssue[];
  /** `blocked_by` links: item to the items it waits on. */
  waits?: Record<string, string[]>;
  children?: Record<string, PoolIssue[]>;
  descriptions?: Record<string, string>;
  /** Items whose relations cannot be read. */
  failing?: string[];
  /** Items whose relation read meets a tracker rate limit. */
  limiting?: string[];
  /** Items whose relation read answers after the others. */
  slow?: string[];
}

function world(spec: Spec) {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const all = [
    ...spec.assigned,
    ...(spec.others ?? []),
    ...Object.values(spec.children ?? {}).flat(),
  ];
  const parent = new Map<string, string>();
  for (const [epic, kids] of Object.entries(spec.children ?? {}))
    for (const kid of kids) parent.set(kid.identifier, epic);
  const tracker = {
    adapter: "github",
    team: "example/repo",
    stateName: (state: string) => state,
    assignUnassigned: async () => true,
    assignedIssues: async (_: string, states: string[]) =>
      states.includes("in_progress") ? [] : spec.assigned,
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async (k: string) => spec.children?.[k] ?? [],
    listRelations: async (k: string) => [
      ...(spec.slow?.includes(k) ? await Bun.sleep(20).then(() => []) : []),
      ...(spec.limiting?.includes(k)
        ? (() => {
            throw new TrackerRateLimited("github", 60_000, "limited");
          })()
        : []),
      ...(spec.failing?.includes(k)
        ? (() => {
            throw new Error(`relations of ${k} cannot be read`);
          })()
        : []),
      ...(spec.waits?.[k] ?? []).map((i) => ({ type: "blocked_by", issue: i })),
      ...Object.entries(spec.waits ?? {})
        .filter(([, on]) => on.includes(k))
        .map(([i]) => ({ type: "blocks", issue: i })),
    ],
    poolIssue: async (k: string) => all.find((i) => i.identifier === k) ?? null,
    getIssue: async (k: string) => ({
      identifier: k,
      description: spec.descriptions?.[k] ?? "",
      parent: parent.has(k) ? { identifier: parent.get(k) } : null,
    }),
    user: async () => ({ id: "alex", name: "alex" }),
  } as unknown as Tracker;
  const read = (extra: Record<string, unknown> = {}) =>
    readServedPickups(tracker, people, {
      cache,
      nowMs: 1,
      headroom: true,
      ...extra,
    });
  return { tracker, read, cache };
}

const reasons = (read: Awaited<ReturnType<ReturnType<typeof world>["read"]>>) =>
  Object.fromEntries(read.unplaced.map((u) => [u.target, u.reason]));

describe("served items blocked by open work", () => {
  it("starts the unassigned blocker of an assigned item and never batches it", async () => {
    const read = await world({
      assigned: [issue("#1")],
      others: [issue("#2", [], null)],
      waits: { "#1": ["#2"] },
    }).read();
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(read.wanted[0]).toMatchObject({
      blockingFor: "#1",
      batchAllowed: false,
      servedPerson: "alex",
    });
    expect(reasons(read)["#1"]).toBe("waiting on #2 (picked up first)");
  });

  it("leaves a blocker to a person when the tracker cannot assign without replacing an assignee", async () => {
    const w = world({
      assigned: [issue("#1")],
      others: [issue("#2", [], null)],
      waits: { "#1": ["#2"] },
    });
    (w.tracker as unknown as Record<string, unknown>).assignUnassigned =
      undefined;
    const read = await w.read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#1"]).toContain("a person assigns it");
    expect(reasons(read)["#1"]).toContain("#2 (awaiting assignment)");
    expect(reasons(read)["#1"]).not.toContain("picked up first");
  });

  it("follows blockers of blockers, working the deepest first, to three links", async () => {
    const chain = {
      assigned: [issue("#1")],
      others: ["#2", "#3", "#4", "#5"].map((k) => issue(k, [], null)),
    };
    const three = await world({
      ...chain,
      waits: { "#1": ["#2"], "#2": ["#3"], "#3": ["#4"] },
    }).read();
    expect(three.wanted.map((i) => [i.key, i.blockingFor])).toEqual([
      ["#4", "#1"],
    ]);
    expect(reasons(three)["#2"]).toBe("waiting on #3 (picked up first)");
    const four = await world({
      ...chain,
      waits: { "#1": ["#2"], "#2": ["#3"], "#3": ["#4"], "#4": ["#5"] },
    }).read();
    expect(four.wanted).toEqual([]);
    expect(reasons(four)["#4"]).toBe(
      "waiting on #5 (too many links from the assigned item)",
    );
  });

  it("keeps an item waiting, and says why, when its blocker is not the person's to start", async () => {
    const cases: [PoolIssue | null, string][] = [
      [issue("#2", [], "sam"), "assigned to sam"],
      [started("#2"), "in In Progress"],
      [issue("#2", ["epic"], null), "an epic; assign it to start it"],
      [issue("#2", ["hitl"], null), "needs a person to start"],
      [issue("#2", ["jig:hold"], null), "needs a person to start"],
      [issue("#2", ["repo:other"], null), "another repository's"],
      [null, "cannot be read"],
    ];
    for (const [blocker, why] of cases) {
      const read = await world({
        assigned: [issue("#1")],
        others: blocker === null ? [] : [blocker],
        waits: { "#1": ["#2"] },
      }).read({
        repoScope: { own: "repo:own", others: ["repo:other"] },
      });
      expect(read.wanted).toEqual([]);
      expect(reasons(read)["#1"]).toBe(`waiting on #2 (${why})`);
    }
  });

  it("names every blocker of an item that has several", async () => {
    const read = await world({
      assigned: [issue("#1")],
      others: [issue("#2", [], null), issue("#3", [], "sam")],
      waits: { "#1": ["#2", "#3"] },
    }).read();
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(read)["#1"]).toBe(
      "waiting on #2 (picked up first), #3 (assigned to sam)",
    );
  });

  it("does not loop on blockers that wait on each other", async () => {
    const read = await world({
      assigned: [issue("#1")],
      others: [issue("#2", [], null)],
      waits: { "#1": ["#2"], "#2": ["#1"] },
    }).read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toBe("waiting on #1 (assigned to alex)");
  });

  it("does not pull for an item a person must start", async () => {
    const read = await world({
      assigned: [issue("#1", ["hitl"])],
      others: [issue("#2", [], null)],
      waits: { "#1": ["#2"] },
    }).read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#1"]).toBe("needs a person to start");
  });

  it("carries the epic a blocked child inherits through to the pulled blocker", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      others: [issue("#9", [], null)],
      children: { "#1": [issue("#2", [], null)] },
      waits: { "#2": ["#9"] },
    }).read();
    expect(
      read.wanted.map((i) => [i.key, i.blockingFor, i.ancestorEpic]),
    ).toEqual([["#9", "#2", "#1"]]);
  });
});

describe("launch-time recheck of a pulled blocker", () => {
  const pulled = (extra: Partial<Spec> = {}) =>
    world({
      assigned: [issue("#1")],
      others: [issue("#2", [], null)],
      waits: { "#1": ["#2"] },
      ...extra,
    });

  it("passes while the served item still holds the person's assignment and waits on it", async () => {
    const w = pulled();
    const fresh = await freshServedPickup(
      w.tracker,
      "#2",
      "alex",
      undefined,
      {},
      "#1",
    );
    expect(typeof fresh).toBe("object");
  });

  it("refuses a blocker that acquired an assignee", async () => {
    const w = pulled({ others: [issue("#2", [], "sam")] });
    expect(
      await freshServedPickup(w.tracker, "#2", "alex", undefined, {}, "#1"),
    ).toBe("the pulled blocker has acquired an assignee");
  });

  it("refuses when the served item no longer waits on it", async () => {
    const w = pulled({ waits: {} });
    expect(
      await freshServedPickup(w.tracker, "#2", "alex", undefined, {}, "#1"),
    ).toBe("it no longer blocks #1");
  });

  it("refuses when the served item was reassigned", async () => {
    const w = pulled({ assigned: [issue("#1", [], "sam")] });
    expect(
      await freshServedPickup(w.tracker, "#2", "alex", undefined, {}, "#1"),
    ).toBe("#1: the served assignment changed");
  });

  it("refuses when the served item is held or started", async () => {
    expect(
      await freshServedPickup(
        pulled({ assigned: [issue("#1", ["hitl"])] }).tracker,
        "#2",
        "alex",
        undefined,
        {},
        "#1",
      ),
    ).toBe("#1, which it blocks, needs a person to start");
    expect(
      await freshServedPickup(
        pulled({ assigned: [started("#1", "alex")] }).tracker,
        "#2",
        "alex",
        undefined,
        {},
        "#1",
      ),
    ).toBe("#1, which it blocks, is no longer open and not started");
  });
});

describe("an assigned epic's children", () => {
  const kids = (...keys: string[]) => keys.map((k) => issue(k, [], null));

  const parallelPlan = () =>
    "## Execution Plan\n" +
    renderExecutionPlan({
      epic: "#1",
      intent: "deliver",
      steps: [
        { issue: "#2", band: 1, lane: "a", gate: "agent" },
        { issue: "#3", band: 1, lane: "b", gate: "agent" },
      ],
      edges: [],
      gates: [],
    });

  const one = { epicWidth: 1 };

  it("starts ready children up to the epic's width when it has no execution plan", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4", "#5", "#6") },
    }).read({ epicWidth: 4 });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#3", "#4", "#5"]);
    expect(reasons(read)["#6"]).toBe(
      "#1 works at most 4 children at once (dispatch.epic_width): starting #2, #3, #4, #5",
    );
  });

  it("reads the width from the repository's dispatch section", async () => {
    const section = dispatchSection({ dispatch: { epic_width: 2 } });
    if (!section.ok) throw new Error(section.failure.reason);
    const w = world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4") },
    });
    const read = await readPickups(() => w.tracker, section.value, undefined, {
      people,
      cache: w.cache,
      nowMs: 1,
      headroom: true,
    });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#3"]);
    expect(read.unplaced.find((u) => u.target === "#4")?.reason).toBe(
      "#1 works at most 2 children at once (dispatch.epic_width): starting #2, #3",
    );
  });

  it("starts four children of a plan-less epic when no width is set", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4", "#5", "#6") },
    }).read();
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#3", "#4", "#5"]);
  });

  it("starts one child at a time under a width of 1", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4") },
    }).read(one);
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(read)).toMatchObject({
      "#3": "#1 works at most 1 child at once (dispatch.epic_width): starting #2",
      "#4": "#1 works at most 1 child at once (dispatch.epic_width): starting #2",
    });
  });

  it("counts the children under way against the width", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [...kids("#2", "#3"), started("#5")] },
    }).read({ epicWidth: 2 });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(read)["#3"]).toBe(
      "#1 works at most 2 children at once (dispatch.epic_width): working #5; starting #2",
    );
  });

  it("starts no child while the children under way fill the width", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [...kids("#2", "#3"), started("#5")] },
    }).read(one);
    expect(read.wanted).toEqual([]);
    expect(reasons(read)).toMatchObject({
      "#2": "#1 works at most 1 child at once (dispatch.epic_width): working #5",
      "#3": "#1 works at most 1 child at once (dispatch.epic_width): working #5",
    });
    expect(reasons(read)["#1"]).toBeUndefined();
  });

  it("lets a sibling start while a started child waits on a person", async () => {
    const parked = [
      {
        ...started("#5"),
        state: { id: "ops", name: "ops_pending", type: "started" },
      },
      ...["hitl", "hitl:product", "manual-ops", "jig:hold"].map((label) => ({
        ...started("#5"),
        labels: [label],
      })),
    ];
    for (const child of parked) {
      const read = await world({
        assigned: [issue("#1", ["epic"])],
        children: { "#1": [...kids("#2", "#3"), child] },
      }).read(one);
      expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
      expect(reasons(read)["#3"]).toBe(
        "#1 works at most 1 child at once (dispatch.epic_width): starting #2",
      );
    }
  });

  it("uses configured person labels and the child's mapped operations state", async () => {
    for (const child of [
      { ...started("#5"), labels: ["approval:product"] },
      { ...started("#5"), labels: ["operator"] },
      {
        ...started("#5"),
        nativeType: "Task",
        state: { id: "ops", name: "Awaiting check", type: "started" },
      },
    ]) {
      const w = world({
        assigned: [issue("#1", ["epic"])],
        children: { "#1": [...kids("#2"), child] },
      });
      w.tracker.stateName = (
        state: CanonicalState,
        type: StateContext = null,
      ) =>
        state === "ops_pending" && type === "Task" ? "Awaiting check" : state;
      const read = await w.read({
        hitl: "approval",
        manualOps: "operator",
        ...one,
      });
      expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    }
  });

  it("keeps a serial slot for a state that can also mean active pull-request work", async () => {
    const w = world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [
          {
            ...started("#5"),
            state: { id: "review", name: "Review", type: "started" },
          },
          ...kids("#2"),
        ],
      },
    });
    w.tracker.stateName = ((state: CanonicalState) =>
      ["pr_open", "in_review", "ops_pending"].includes(state)
        ? "Review"
        : state) as Tracker["stateName"];
    const read = await w.read(one);
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toBe(
      "#1 works at most 1 child at once (dispatch.epic_width): working #5",
    );
  });

  it("releases a serial slot for an operations state shared only with merged review work", async () => {
    const w = world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [
          {
            ...started("#5"),
            state: { id: "review", name: "Review", type: "started" },
          },
          ...kids("#2"),
        ],
      },
    });
    w.tracker.stateName = ((state: CanonicalState) =>
      ["in_review", "ops_pending"].includes(state)
        ? "Review"
        : state) as Tracker["stateName"];
    const read = await w.read(one);
    expect(read.wanted.map((item) => item.key)).toEqual(["#2"]);
  });

  it("gives the slot to the next startable child while an ended pickup holds the top one", async () => {
    const held = (i: { identifier: string }) =>
      i.identifier === "#2" ? "launch record r1 ended" : null;
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4") },
    }).read({ passOver: held, ...one });
    // The held child stays wanted, so the pickup plan reports it; it takes no slot.
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#3"]);
    expect(reasons(read)["#4"]).toBe(
      "#1 works at most 1 child at once (dispatch.epic_width): starting #3",
    );
    expect(reasons(read)["#1"]).toBe(
      "#2 is held, so it does not hold its siblings: launch record r1 ended",
    );
  });

  it("keeps a held child ranked after the leader planned, so its own need is raised", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3") },
    }).read({
      passOver: (i: { identifier: string }) =>
        i.identifier === "#3" ? "launch record r1 ended" : null,
      ...one,
    });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#3"]);
    expect(reasons(read)["#3"]).toBeUndefined();
  });

  it("names the held child in the idle epic summary when no sibling can start", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2") },
    }).read({ passOver: () => "launch record r1 ended" });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(read)["#1"]).toBe(
      "none of its 1 open children can start; first, #2: launch record r1 ended",
    );
  });

  it("names a parked child in the idle epic summary", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [
          { ...started("#2"), labels: ["manual-ops"] },
          {
            ...started("#3"),
            state: { id: "ops", name: "ops_pending", type: "started" },
          },
        ],
      },
    }).read();
    expect(read.wanted).toEqual([]);
    const summaries = read.unplaced.filter((u) => u.target === "#1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.reason).toContain("#2: waiting on a person");
  });

  it("does not traverse the children of a person-held epic", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [
          {
            ...issue("#2", ["epic", "hitl"], null),
            isEpic: true,
            hasOpenChildren: true,
          },
        ],
        "#2": [issue("#3", [], null)],
      },
    }).read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toBe("needs a person to start");
    expect(reasons(read)["#3"]).toBeUndefined();
  });

  it("still holds siblings when an active child follows a parked one", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [
          { ...started("#5"), labels: ["hitl"] },
          started("#6"),
          ...kids("#2"),
        ],
      },
    }).read(one);
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toBe(
      "#1 works at most 1 child at once (dispatch.epic_width): working #6",
    );
    expect(reasons(read)["#1"]).toBeUndefined();
  });

  it("keeps a planned epic's summary unchanged while a started child waits on a person", async () => {
    const description =
      "## Execution Plan\n" +
      renderExecutionPlan({
        epic: "#1",
        intent: "deliver",
        steps: [{ issue: "#2", band: 1, lane: "a", gate: "agent" }],
        edges: [],
        gates: [],
      });
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [{ ...started("#2"), labels: ["manual-ops"] }] },
      descriptions: { "#1": description },
    }).read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#1"]).toBeUndefined();
  });

  it("counts a child that cannot be read as under way, since it may be", async () => {
    const unread = { ...issue("#3", [], null), truncated: ["labels"] };
    const children = { "#1": [...kids("#2", "#4"), unread] };
    const held = await world({
      assigned: [issue("#1", ["epic"])],
      children,
    }).read(one);
    expect(held.wanted).toEqual([]);
    expect(reasons(held)["#2"]).toContain("#3 cannot be read");
    const wider = await world({
      assigned: [issue("#1", ["epic"])],
      children,
    }).read({ epicWidth: 2 });
    expect(wider.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(wider)["#4"]).toBe(
      "#1 works at most 2 children at once (dispatch.epic_width): #3 cannot be read and may be under way; starting #2",
    );
  });

  it("takes one slot for a child whose relations cannot be read and starts its siblings", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3", "#4", "#5") },
      failing: ["#3"],
    }).read({ epicWidth: 3 });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2", "#4"]);
    expect(reasons(read)["#5"]).toBe(
      "#1 works at most 3 children at once (dispatch.epic_width): #3 cannot be read and may be under way; starting #2, #4",
    );
  });

  it("counts a started child whose relations cannot be read once, and records the failed read", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [started("#3"), ...kids("#2", "#4")] },
      failing: ["#3"],
    }).read({ epicWidth: 2 });
    expect(read.wanted.map((i) => i.key)).toEqual(["#2"]);
    expect(reasons(read)["#3"]).toContain(
      "the queue metadata could not be read",
    );
    expect(read.incomplete).toBe(true);
  });

  const failedRecordCases: [string, Spec][] = [
    [
      "records a failed open child's read once",
      {
        assigned: [issue("#1", ["epic"])],
        children: { "#1": kids("#2", "#3") },
        failing: ["#3"],
      },
    ],
    [
      "keeps a failed child's record when another epic meets a rate limit",
      {
        assigned: [issue("#1", ["epic"]), issue("#5", ["epic"])],
        children: { "#1": kids("#2", "#3"), "#5": kids("#6") },
        failing: ["#3"],
        limiting: ["#6"],
      },
    ],
    [
      "keeps a failed child's record when a sibling of the same epic meets a rate limit",
      {
        assigned: [issue("#1", ["epic"])],
        children: { "#1": kids("#2", "#3") },
        failing: ["#3"],
        limiting: ["#2"],
        slow: ["#3"],
      },
    ],
  ];
  for (const [name, spec] of failedRecordCases) {
    it(name, async () => {
      const read = await world(spec).read({ epicWidth: 2 });
      expect(read.unplaced.filter((u) => u.target === "#3")).toHaveLength(1);
    });
  }

  it("reports a rate limit from a later child of a planned epic beside an earlier ordinary failure", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3") },
      descriptions: { "#1": parallelPlan() },
      failing: ["#2"],
      limiting: ["#3"],
      slow: ["#3"],
    }).read({ epicWidth: 2 });
    expect(read.limitedUntil).toBeDefined();
    expect(read.incomplete).toBe(true);
    expect(read.failures).toHaveLength(1);
  });

  it("keeps an epic working while its started child cannot be read", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [started("#3"), ...kids("#2")] },
      failing: ["#3"],
    }).read(one);
    const summary = read.unplaced.filter((u) => u.target === "#1");
    expect(summary).toEqual([]);
  });

  it("holds a directly assigned child while a sibling cannot be read", async () => {
    const unread = { ...issue("#3", [], null), truncated: ["labels"] };
    const read = await world({
      assigned: [issue("#1", ["epic"]), issue("#2", [], "alex")],
      children: { "#1": [issue("#2", [], "alex"), unread] },
    }).read(one);
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toContain("#3 cannot be read");
  });

  it("holds a directly assigned child to its epic's width", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"]), issue("#2", [], "alex")],
      children: { "#1": [issue("#2", [], "alex"), started("#5")] },
    }).read(one);
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#2"]).toBe(
      "#1 works at most 1 child at once (dispatch.epic_width): working #5",
    );
  });

  it("calls an epic working, not idle, while a nested epic's child is in progress", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [issue("#2", ["epic"], null)],
        "#2": [started("#3")],
      },
    }).read();
    expect(reasons(read)["#1"]).toBeUndefined();
  });

  it("names an epic whose every child cannot be read", async () => {
    const unread = { ...issue("#2", [], null), truncated: ["labels"] };
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": [unread] },
    }).read();
    expect(reasons(read)["#1"]).toContain("none of its 1 open children");
    expect(reasons(read)["#1"]).not.toContain("undefined");
  });

  it("keeps an execution plan's own order and parallelism", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2", "#3") },
      descriptions: { "#1": parallelPlan() },
    }).read();
    expect(read.wanted.map((i) => i.key).sort()).toEqual(["#2", "#3"]);
  });

  it("pulls the open blocker of a plan child that waits only on work outside the plan", async () => {
    const description =
      "## Execution Plan\n" +
      renderExecutionPlan({
        epic: "#1",
        intent: "deliver",
        steps: [{ issue: "#2", band: 1, lane: "a", gate: "agent" }],
        edges: [],
        gates: [],
      });
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      others: [issue("#9", [], null)],
      children: { "#1": kids("#2") },
      descriptions: { "#1": description },
      waits: { "#2": ["#9"] },
    }).read();
    expect(read.wanted.map((i) => [i.key, i.blockingFor])).toEqual([
      ["#9", "#2"],
    ]);
  });

  it("does not pull a blocker through an intermediate behind its epic's human gate", async () => {
    const description =
      "## Execution Plan\n" +
      renderExecutionPlan({
        epic: "#5",
        intent: "deliver",
        steps: [{ issue: "#9", band: 1, lane: "a", gate: "human" }],
        edges: [],
        gates: [],
      });
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      others: [issue("#5", ["epic"], "sam"), issue("#10", [], null)],
      children: { "#1": kids("#2"), "#5": kids("#9") },
      descriptions: { "#5": description },
      waits: { "#2": ["#9"], "#9": ["#10"] },
    }).read();
    expect(read.wanted.map((i) => i.key)).not.toContain("#10");
  });

  it("holds each nested epic to its own width", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: {
        "#1": [issue("#2", ["epic"], null)],
        "#2": kids("#3", "#4"),
      },
    }).read(one);
    expect(read.wanted.map((i) => i.key)).toEqual(["#3"]);
    expect(reasons(read)["#4"]).toBe(
      "#2 works at most 1 child at once (dispatch.epic_width): starting #3",
    );
  });

  it("reports one reason for an epic none of whose children can start", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      others: [issue("#9", [], "sam")],
      children: { "#1": [issue("#2", ["hitl"], null), issue("#3", [], null)] },
      waits: { "#3": ["#9"] },
    }).read();
    expect(read.wanted).toEqual([]);
    expect(reasons(read)["#1"]).toBe(
      "none of its 2 open children can start; first, #2: waiting on a person",
    );
  });

  it("says nothing of an epic that has a child to start", async () => {
    const read = await world({
      assigned: [issue("#1", ["epic"])],
      children: { "#1": kids("#2") },
    }).read();
    expect(reasons(read)["#1"]).toBeUndefined();
  });
});
