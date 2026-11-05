/**
 * Serialization's decision for one tick, over injected reads: the order
 * and the leader of each group, a pull request in two groups, and the
 * pull requests left unplaced when a read fails.
 */
import { describe, expect, it } from "bun:test";
import { type ContentionReads, readContention } from "../lib/contention.ts";
import type { DrivenPr, LedgerClass } from "../lib/types.ts";

const CATALOG = `areas:
  migrations: { paths: ["db/**"], serialize: true }
  schema: { paths: ["schema/**"], serialize: true }
  app: { paths: ["src/**"] }
`;

const drive = (
  number: number,
  cls: LedgerClass = "stale",
  evidence: DrivenPr["evidence"] = { round: 1 },
): DrivenPr => ({
  number,
  url: "",
  title: "",
  head: `feature/${number}`,
  class: cls,
  why: cls,
  evidence,
});

function reads(
  files: Record<number, string[] | "fail">,
  threads: Record<number, number | "fail"> = {},
  catalog: string | null = CATALOG,
): ContentionReads {
  return {
    catalog: async () => catalog,
    files: async (pr) => {
      const f = files[pr];
      if (f === "fail" || f === undefined)
        throw new Error(`no files for ${pr}`);
      return f;
    },
    threads: async (pr) => {
      const t = threads[pr];
      if (t === "fail" || t === undefined)
        throw new Error(`no threads for ${pr}`);
      return t;
    },
  };
}

const input = (drives: DrivenPr[]) => ({
  catalogPath: "catalog.yaml",
  where: "example-org/example-repo@main:catalog.yaml",
  drives,
  created: new Map<number, string>(),
  launches: [],
});

describe("serialization's decision", () => {
  it("orders a group converged and mergeable first, then a drive in progress, then threads, rounds and age", async () => {
    const c = await readContention(
      input([
        drive(1, "stale", { round: 9 }),
        drive(2, "driven", { round: 1 }),
        drive(3, "done", { exit: 0, round: 1 }),
        drive(4, "stale", { round: 9 }),
        drive(5, "stale", { round: 2 }),
      ]),
      reads(
        { 1: ["db/1"], 2: ["db/2"], 3: ["db/3"], 4: ["db/4"], 5: ["db/5"] },
        { 1: 1, 2: 5, 3: 3, 4: 1, 5: 0 },
      ),
    );
    expect(c.report?.groups[0]?.order.map((o) => o.target)).toEqual([
      "PR #3",
      "PR #2",
      "PR #5",
      "PR #1",
      "PR #4",
    ]);
    expect([...c.held.keys()].sort()).toEqual([1, 2, 4, 5]);
    expect(c.held.get(5)).toEqual({ area: "migrations", leader: 3 });
  });

  it("orders members the same whatever the input order when some creation times are unknown", async () => {
    const created = new Map([
      [1, "2026-03-01T00:00:00Z"],
      [3, "2026-01-01T00:00:00Z"],
    ]);
    const orders = new Set<string>();
    for (const drives of [
      [drive(1), drive(2), drive(3)],
      [drive(3), drive(1), drive(2)],
      [drive(2), drive(3), drive(1)],
    ]) {
      const c = await readContention(
        { ...input(drives), created },
        reads({ 1: ["db/1"], 2: ["db/2"], 3: ["db/3"] }, { 1: 0, 2: 0, 3: 0 }),
      );
      orders.add(
        (c.report?.groups[0]?.order ?? []).map((o) => o.target).join(","),
      );
    }
    expect([...orders]).toEqual(["PR #3,PR #1,PR #2"]);
  });

  it("holds a pull request in two groups unless it leads both", async () => {
    const c = await readContention(
      input([drive(1), drive(2), drive(3)]),
      reads(
        { 1: ["db/a", "schema/a"], 2: ["schema/b"], 3: ["db/c", "src/x"] },
        { 1: 0, 2: 1, 3: 2 },
      ),
    );
    expect(c.held.has(1)).toBe(false);
    expect(c.held.get(2)).toEqual({ area: "schema", leader: 1 });
    expect(c.held.get(3)).toEqual({ area: "migrations", leader: 1 });
  });

  it("leaves a group unplaced when a member's threads or another pull request's files do not read", async () => {
    const threads = await readContention(
      input([drive(1), drive(2), drive(3)]),
      reads({ 1: ["db/a"], 2: ["db/b"], 3: ["src/c"] }, { 1: 0, 2: "fail" }),
    );
    expect([...threads.unplaced.keys()].sort()).toEqual([1, 2]);
    expect(threads.held.size).toBe(0);
    expect(threads.report?.groups[0]?.leader).toBeNull();

    const files = await readContention(
      input([drive(1), drive(2), drive(3)]),
      reads({ 1: ["db/a"], 2: ["db/b"], 3: "fail" }, { 1: 0, 2: 1 }),
    );
    expect([...files.unplaced.keys()].sort()).toEqual([1, 2, 3]);
    expect(files.held.size).toBe(0);
  });

  it("unplaces every drive when the catalog does not read, and decides nothing", async () => {
    const c = await readContention(
      input([drive(1), drive(2)]),
      reads({ 1: ["db/a"], 2: ["src/b"] }, {}, null),
    );
    expect([...c.unplaced.keys()]).toEqual([1, 2]);
    expect(c.decided).toBe(false);
    expect(c.failure).toBe(
      "drive.change_areas_catalog names catalog.yaml, which the default branch does not have",
    );
  });

  it("serializes nothing where no area is serialized or no catalog is configured", async () => {
    const none = await readContention(
      { ...input([drive(1), drive(2)]), catalogPath: null },
      reads({ 1: ["db/a"], 2: ["db/b"] }),
    );
    expect(none.report).toBeNull();
    expect(none.decided).toBe(true);
    const parallel = await readContention(
      input([drive(1), drive(2)]),
      reads(
        { 1: ["src/a"], 2: ["src/b"] },
        {},
        'areas:\n  app: { paths: ["src/**"] }\n',
      ),
    );
    expect(parallel.report).toBeNull();
    expect(parallel.held.size).toBe(0);
  });
});
