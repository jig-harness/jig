import { expect, test } from "bun:test";
import { trackerFootprints } from "../scripts/lib/tracker/footprints.ts";
import { footprintBody } from "../../../shared/footprint.ts";
import type {
  FootprintCacheEntry,
  FootprintReadOptions,
} from "../scripts/lib/tracker/footprint-port.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";
import {
  recordCall,
  withLedgerWriter,
} from "../../../shared/outbound/ledger.ts";
import { readConnection } from "../scripts/lib/tracker/graphql.ts";

const record = {
  key: "#42",
  at: "2026-11-14T17:30:00.000Z",
  source: "scout" as const,
  base: "abcdef0123456789",
  paths: ["path with spaces/"],
  areas: [],
  writer: { host: "digest" },
};
const item = { key: record.key, updatedAt: "v1", labels: ["area:shared"] };
function options(): FootprintReadOptions {
  return {
    cycle: {},
    scopeRead: "scope-1",
    cache: new Map<string, FootprintCacheEntry>(),
    areaLabels: { shared: ["area:shared"] },
  };
}
function harness(updates = true) {
  const calls: string[] = [];
  const state = {
    fail: false,
    comments: [
      { body: footprintBody(record), createdAt: record.at, trusted: true },
    ],
  };
  const t = trackerFootprints(
    {
      adapter: "linear",
      team: "ENG",
      async issueComments(key, signal) {
        signal?.throwIfAborted();
        calls.push(key);
        if (state.fail) throw new OutboundError("unreachable", "offline");
        return { uuid: key, comments: state.comments };
      },
      async postComment(key, body) {
        calls.push(key);
        expect(body).toContain("jig:footprint");
        recordCall({
          system: "test",
          credential: "test",
          operation: "postComment",
          durationMs: 1,
        });
      },
    },
    updates,
  );
  return { calls, state, t };
}
test("clients with the same team cannot share trusted comments through a caller cache", async () => {
  const first = harness(false),
    second = harness(false);
  second.state.comments = [
    {
      body: footprintBody({ ...record, paths: ["second-workspace/"] }),
      createdAt: record.at,
      trusted: true,
    },
  ];
  const shared = options();
  await first.t.footprints([item], shared);
  const result = await second.t.footprints([item], { ...shared, cycle: {} });
  expect(result.get(item.key)?.paths).toEqual(["second-workspace/"]);
  expect(second.calls).toEqual([item.key]);
  await second.t.footprints([item], { ...shared, cycle: {} });
  expect(second.calls).toEqual([item.key]);
});
test("reuse is driven by item update time and adapter comment capability", async () => {
  for (const updates of [true, false]) {
    const { t, calls } = harness(updates);
    const o = options();
    expect((await t.footprints([item], o)).get(item.key)?.source).toBe("scout");
    await t.footprints([item], { ...o, cycle: {} });
    expect(calls).toHaveLength(1);
    await t.footprints([item], { ...o, cycle: {}, scopeRead: "scope-2" });
    expect(calls).toHaveLength(updates ? 1 : 2);
    await t.footprints([{ ...item, updatedAt: "v2" }], { ...o, cycle: {} });
    expect(calls).toHaveLength(updates ? 2 : 3);
  }
});
test("failures keep last reading with age, never read becomes unknown; same tick sends once", async () => {
  const { t, state, calls } = harness();
  const o = options();
  await t.footprints([item], o);
  state.fail = true;
  const failedOptions = { ...o, cycle: {} };
  const changed = { ...item, updatedAt: "v2" };
  const old = (await t.footprints([changed], failedOptions)).get(item.key);
  expect(old).toMatchObject({
    source: "scout",
    stale: true,
    reason: "unreachable",
    failure: { code: "unreachable" },
  });
  expect(old?.ageMs).toBeGreaterThanOrEqual(0);
  await t.footprints([changed], failedOptions);
  expect(calls).toHaveLength(2);
  const never = (
    await t.footprints([{ key: "#43", labels: [] }], failedOptions)
  ).get("#43");
  expect(never).toMatchObject({
    source: "unknown",
    readAt: null,
    ageMs: null,
    stale: true,
  });
});
test("bounded fresh reads preserve wanted order and derive only catalog seeds from labels", async () => {
  const { t, calls, state } = harness();
  state.comments = [];
  const o = { ...options(), maxFresh: 1 };
  const result = await t.footprints([item, { ...item, key: "#43" }], o);
  expect(result.get(item.key)).toMatchObject({
    source: "labels",
    areas: ["shared"],
    stale: false,
  });
  expect(result.get("#43")).toMatchObject({
    source: "unknown",
    stale: true,
    reason: "fresh footprint read limit",
  });
  await t.footprints([{ ...item, key: "#44" }], o);
  expect(calls).toEqual(["#42"]);
});
test("deadline and ten-page limit return classified no-answer without accepting partial comments", async () => {
  const { t, calls } = harness();
  expect(
    (await t.footprints([item], { ...options(), deadline: 0 })).get(item.key)
      ?.failure?.code,
  ).toBe("unreachable");
  expect(calls).toEqual([]);
  let pages = 0;
  const paged = trackerFootprints(
    {
      async issueComments() {
        await readConnection(
          async () => {
            pages++;
            return {
              nodes: [{ id: String(pages) }],
              pageInfo: { hasNextPage: true, endCursor: String(pages) },
            };
          },
          {
            pick: (v) => v,
            idOf: (v) => v.id,
            where: "test",
            fail: (s) => new Error(s),
          },
        );
        return { uuid: "id", comments: [] };
      },
      async postComment() {
        /* Read-only fixture. */
      },
    },
    false,
  );
  expect(
    (await paged.footprints([item], options())).get(item.key),
  ).toMatchObject({
    source: "unknown",
    stale: true,
    failure: { code: "too-costly" },
  });
  expect(pages).toBe(10);
});
test("writes record every governed call under footprint and reject malformed paths before sending", async () => {
  const { t, calls } = harness();
  const operations: string[] = [];
  await withLedgerWriter(
    (r) => operations.push(r.operation),
    () => t.writeFootprint(record),
  );
  expect(operations).toEqual(["footprint"]);
  await expect(
    t.writeFootprint({ ...record, paths: ["../escape"] }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
