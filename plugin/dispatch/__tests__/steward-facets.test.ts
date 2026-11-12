import { expect, test } from "bun:test";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { applyStewardFacet } from "../lib/steward-facets.ts";

const issue = (): PoolIssue => ({
  identifier: "#12",
  title: "Add a report",
  url: null,
  priority: 0,
  type: null,
  size: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
  state: { id: "todo", name: "Todo", type: "unstarted" },
  assignee: { id: "person", name: "alex" },
  labels: [],
  isEpic: false,
  hasOpenChildren: false,
  truncated: [],
});
const record = {
  kind: "facet" as const,
  target: "#12",
  facet: "priority" as const,
  value: 2,
  reason: "Unblocks the reporting work",
};

function fixture() {
  let current = issue();
  const writes: unknown[] = [];
  const comments: string[] = [];
  const tracker = {
    poolIssue: async () => structuredClone(current),
    postComment: async (_key: string, body: string) => {
      comments.push(body);
    },
    updateIssue: async (_key: string, patch: unknown) => {
      writes.push(patch);
    },
  };
  return {
    tracker,
    writes,
    comments,
    current: () => current,
    set: (next: PoolIssue) => {
      current = next;
    },
  };
}

test("fills an empty facet and records the steward's reason", async () => {
  const f = fixture();
  expect(await applyStewardFacet(f.tracker, record, [issue()])).toEqual({
    ok: true,
    value: "applied",
  });
  expect(f.writes).toEqual([{ priority: 2 }]);
  expect(f.comments[0]).toContain("Steward");
  expect(f.comments[0]).toContain(record.reason);
});

test("preserves a facet a person set since the digest", async () => {
  const f = fixture();
  f.current().priority = 1;
  expect(await applyStewardFacet(f.tracker, record, [issue()])).toEqual({
    ok: true,
    value: "skipped",
  });
  expect(f.writes).toEqual([]);
  expect(f.comments).toEqual([]);
});

test("reads again after recording intent, preserving an intervening human edit", async () => {
  const f = fixture();
  f.tracker.postComment = async () => {
    f.current().priority = 4;
  };
  expect(await applyStewardFacet(f.tracker, record, [issue()])).toEqual({
    ok: true,
    value: "skipped",
  });
  expect(f.writes).toEqual([]);
});

test("refuses unknown targets, new assignees, holds and unmapped values", async () => {
  for (const change of [
    { identifier: "#99" },
    { assignee: { id: "other", name: "other" } },
    { labels: ["jig:hold"] },
    { labels: ["hitl:legal"] },
    { unmappedFacets: ["priority" as const] },
    { truncated: ["labels"] },
    { state: { id: "done", name: "Done", type: "completed" as const } },
  ]) {
    const f = fixture();
    f.set({ ...issue(), ...change });
    const result = await applyStewardFacet(f.tracker, record, [issue()]);
    expect(result.ok && result.value).toBe("skipped");
    expect(f.writes).toEqual([]);
  }
  const f = fixture();
  expect((await applyStewardFacet(f.tracker, record, [])).ok).toBe(false);
  expect(f.writes).toEqual([]);
});

test("rejects out-of-range values and reports a tracker failure", async () => {
  const f = fixture();
  expect(
    (await applyStewardFacet(f.tracker, { ...record, value: 0 }, [issue()])).ok,
  ).toBe(false);
  expect(
    (
      await applyStewardFacet(f.tracker, { ...record, value: "high" }, [
        issue(),
      ])
    ).ok,
  ).toBe(false);
  f.tracker.poolIssue = async () => {
    throw new Error("offline");
  };
  expect((await applyStewardFacet(f.tracker, record, [issue()])).ok).toBe(
    false,
  );
  expect(f.writes).toEqual([]);
});

test("respects configured human holds and fills type and size through their facet stores", async () => {
  const held = fixture();
  held.current().labels = ["person-required:legal"];
  expect(
    await applyStewardFacet(held.tracker, record, [issue()], {
      hitl: "person-required",
    }),
  ).toEqual({ ok: true, value: "skipped" });
  expect(held.writes).toEqual([]);
  for (const facet of ["type", "size"] as const) {
    const f = fixture();
    expect(
      await applyStewardFacet(
        f.tracker,
        { ...record, facet, value: facet === "type" ? "feature" : "small" },
        [issue()],
      ),
    ).toEqual({ ok: true, value: "applied" });
    expect(f.writes).toEqual([
      { [facet]: facet === "type" ? "feature" : "small" },
    ]);
  }
});
