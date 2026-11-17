import { expect, test } from "bun:test";
import { renderExecutionPlan } from "../../skills/do-item/scripts/lib/execution-plan.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { servedParentHold } from "../lib/sources/served-parents.ts";
import { issue } from "./served-fixtures.ts";
import {
  planMergeReader,
  type MergeContext,
  type MergeReads,
} from "../lib/sources/plan-merges.ts";
import { isMergeFact } from "../lib/merge-facts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMergeFact, writeMergeFact } from "../lib/merge-facts.ts";
import { closeStateDb } from "../lib/state.ts";
import { writeMergeReads, forgetMergeRead } from "../lib/merge-reads.ts";
import { readServedPickups, freshServedPickup } from "../lib/sources/served.ts";

const context: MergeContext = {
  root: ".",
  repository: "example/repo",
  trunk: "main",
  keySource: "#[1-9]\\d*(?!\\w)",
  bodyLinkRequired: true,
};
const merged = {
  number: 10,
  url: "https://github.com/example/repo/pull/10",
  state: "MERGED",
  baseRefName: "main",
  body: "Closes #2",
};
const oldMerge = {
  mergedAt: "2020-01-01T00:00:00.000Z",
  base: "main",
  files: ["shared.ts"],
};

function fixture() {
  let pulls = [merged];
  let fact: typeof oldMerge | null = oldMerge;
  const counts = { search: 0, fact: 0, comments: 0 };
  const reads: MergeReads = {
    links: {
      comments: async () => {
        counts.comments++;
        return [];
      },
      search: async () => {
        counts.search++;
        return pulls;
      },
      view: async (pr) => pulls.find((pull) => pull.number === pr) ?? null,
    },
    fact: async () => {
      counts.fact++;
      return fact;
    },
  };
  return {
    reads,
    counts,
    setPulls: (value: typeof pulls) => {
      pulls = value;
    },
    setFact: (value: typeof fact) => {
      fact = value;
    },
    reader: () => planMergeReader({} as Tracker, context, reads),
  };
}

const description =
  "## Execution Plan\n" +
  renderExecutionPlan({
    epic: "#1",
    intent: "deliver",
    steps: [
      { issue: "#2", band: 1, lane: "a", gate: "agent" },
      { issue: "#3", band: 2, lane: "b", gate: "agent" },
    ],
    edges: [
      {
        from: "#2",
        to: "#3",
        kind: "conflict",
        reason: "shared file",
        completion: "merged",
        conflictSurfaceKinds: ["repository-files"],
        conflictFiles: ["shared.ts"],
      },
    ],
    gates: [],
  });

test("a verified delivering merge releases an ancestor conflict edge", async () => {
  const tracker = {
    adapter: "github",
    team: "example/repo",
    getIssue: async (key: string) => ({
      identifier: key,
      description: key === "#1" ? description : "",
      parent: key === "#3" ? { identifier: "#1" } : null,
    }),
  } as unknown as Tracker;
  const held = await servedParentHold(
    tracker,
    issue("#3"),
    { get: () => null, set: () => undefined },
    undefined,
    { pool: async (key) => issue(key) },
    async () => ({ merged: ["#2>#3"], held: {} }),
  );
  expect(held).toBeNull();
});

test("direct merge proof predating follow-up activation releases while each launch check refreshes associations", async () => {
  const f = fixture();
  const read = f.reader();
  expect(await read(description)).toEqual({ merged: ["#2>#3"], held: {} });
  expect(await read(description)).toEqual({ merged: ["#2>#3"], held: {} });
  expect(f.counts).toEqual({ search: 2, fact: 1, comments: 2 });
});

test("a tick merge reader runs each proof chain through its shared pool", async () => {
  const f = fixture();
  let runs = 0;
  const read = planMergeReader(
    {} as Tracker,
    {
      ...context,
      pool: {
        size: 6,
        run: async <T>(operation: () => Promise<T>) => {
          runs++;
          return operation();
        },
      },
    },
    f.reads,
  );

  await read(description);

  expect(runs).toBe(1);
});

test("a later open predecessor pull request holds the next tick despite its earlier merge", async () => {
  const f = fixture();
  expect((await f.reader()(description)).merged).toEqual(["#2>#3"]);
  f.setPulls([
    merged,
    {
      ...merged,
      number: 11,
      url: "https://github.com/example/repo/pull/11",
      state: "OPEN",
    },
  ]);
  const next = await f.reader()(description);
  expect(next.merged).toEqual([]);
  expect(next.held["#2>#3"]).toContain("open or not yet landed");
  expect(f.counts.search).toBe(2);
});

test("a closed abandoned pull request does not veto the delivering merge", async () => {
  const f = fixture();
  f.setPulls([
    merged,
    {
      ...merged,
      number: 11,
      url: "https://github.com/example/repo/pull/11",
      state: "CLOSED",
    },
  ]);
  expect((await f.reader()(description)).merged).toEqual(["#2>#3"]);
  expect(f.counts.fact).toBe(1);
});

test.each([
  ["unreadable merge", null, "could not be read completely"],
  ["wrong base", { ...oldMerge, base: "release" }, "no linked merge"],
  ["unrelated files", { ...oldMerge, files: ["other.ts"] }, "conflict files"],
])("%s keeps the edge held", async (_name, fact, reason) => {
  const f = fixture();
  f.setFact(fact);
  const value = await f.reader()(description);
  expect(value.merged).toEqual([]);
  expect(value.held["#2>#3"]).toContain(reason);
});

test("unreadable current associations never reuse last tick's release", async () => {
  const f = fixture();
  expect((await f.reader()(description)).merged).toEqual(["#2>#3"]);
  f.reads.links.search = async () => null;
  const next = await f.reader()(description);
  expect(next.merged).toEqual([]);
  expect(next.held["#2>#3"]).toContain("could not be searched");
});

test("malformed immutable facts never serve as merge evidence", () => {
  expect(isMergeFact(oldMerge)).toBe(true);
  expect(isMergeFact({ ...oldMerge, mergedAt: "invalid" })).toBe(false);
  expect(isMergeFact({ ...oldMerge, files: [null] })).toBe(false);
});

test("immutable merge facts survive follow-up window pruning and comment invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-merge-facts-"));
  try {
    writeMergeFact(context.repository, 10, oldMerge, root);
    writeMergeReads(context.repository, [], [], 1, null, root);
    forgetMergeRead(context.repository, 10, root);
    expect(readMergeFact(context.repository, 10, root)).toEqual(oldMerge);
    expect(readMergeFact("example/other", 10, root)).toBeNull();
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("inherited epic expansion and fresh launch checks use delivering merge evidence", async () => {
  const f = fixture();
  const predecessor = {
    ...issue("#2", [], null),
    state: { id: "s", name: "Review", type: "started" },
  };
  const child = issue("#3", [], null);
  const parent = issue("#1", ["epic"]);
  const tracker = {
    adapter: "github",
    team: "example/repo",
    stateName: () => null,
    user: async () => ({ id: "alex", name: "alex" }),
    assignedIssues: async (_: string, states: string[]) =>
      states.includes("in_progress") ? [] : [parent],
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async () => [predecessor, child],
    listRelations: async () => [],
    poolIssue: async (key: string) =>
      [parent, predecessor, child].find((row) => row.identifier === key) ??
      null,
    getIssue: async (key: string) => ({
      identifier: key,
      description: key === "#1" ? description : "",
      parent: key === "#3" || key === "#2" ? { identifier: "#1" } : null,
    }),
  } as unknown as Tracker;
  const mergeEvidence = f.reader();
  const reading = await readServedPickups(
    tracker,
    [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }],
    {
      nowMs: 1,
      headroom: true,
      cache: { get: () => null, set: () => undefined },
      mergeEvidence,
    },
  );
  expect(reading.wanted.map((row) => row.key)).toContain("#3");
  expect(
    await freshServedPickup(tracker, "#3", "alex", "#1", { mergeEvidence }),
  ).toMatchObject({ identifier: "#3" });
  f.setPulls([
    merged,
    {
      ...merged,
      number: 11,
      url: "https://github.com/example/repo/pull/11",
      state: "OPEN",
    },
  ]);
  expect(
    await freshServedPickup(tracker, "#3", "alex", "#1", {
      mergeEvidence: f.reader(),
    }),
  ).toContain("open or not yet landed");
});
