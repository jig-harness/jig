/** Outages are shared by native scope without hiding each repository's aged reading. */
import { expect, it } from "bun:test";
import { LinearApiError } from "../../skills/do-item/scripts/lib/tracker/linear-transport.ts";
import { emptyReport } from "../lib/tick-context.ts";
import {
  dropRepeatedScopeFailures,
  scopeFailureRow,
} from "../lib/sources/scope-failures.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { FakeLinear } from "./served-linear-fake.ts";

it("reports a failed scope once across repositories, retaining ages and distinct credentials", () => {
  const tracker = { adapter: "linear", team: "TEAM" };
  const reports = ["a", "b", "c"].map((path) => emptyReport(path, ""));
  for (const [index, report] of reports.entries()) {
    report.records.push({
      record: "tracker",
      source: "linear TEAM",
      ok: false,
      detail: "kept queue",
    });
    report.unplaced.push(
      scopeFailureRow(
        tracker,
        {
          scope: index === 2 ? "credential-b" : "credential-a",
          readAt: 1000 * (index + 1),
        },
        "connection unavailable",
      ),
    );
  }
  dropRepeatedScopeFailures(reports);
  expect(reports.flatMap((report) => report.unplaced)).toHaveLength(2);
  expect(reports.map((report) => report.records[0]?.detail)).toEqual([
    expect.stringContaining("1970-01-01T00:00:01.000Z"),
    expect.stringContaining("1970-01-01T00:00:02.000Z"),
    expect.stringContaining("1970-01-01T00:00:03.000Z"),
  ]);
});

it("gives a transport failure during an online walk a scoped notice and reading age", async () => {
  const fake = new FakeLinear();
  fake.add({ identifier: "ENG-1", assignee: "person@example.com" });
  const tracker = {
    ...fake.tracker(),
    assignedBy: async () => {
      throw new LinearApiError("connection unavailable", null, "unreachable");
    },
  };
  const saved = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (saved.get(key) as T | undefined) ?? null,
    set: (key: string, value: unknown) => {
      saved.set(key, value);
    },
  };
  const read = await readServedPickups(
    tracker,
    [{ name: "Person", forge: [], tracker: { linear: "person@example.com" } }],
    {
      nowMs: Date.parse("2026-11-10T12:00:00Z"),
      headroom: true,
      cache,
    },
  );
  expect(read.incomplete).toBe(true);
  expect(read.unplaced).toEqual([
    expect.objectContaining({
      target: "linear ENG",
      scopeFailure: expect.any(String),
      reason: expect.stringContaining("2026-11-10T12:00:00.000Z"),
    }),
  ]);
  const mark = fake.count();
  const later = await readServedPickups(
    {
      ...tracker,
      changedSince: async () => {
        throw new LinearApiError("still offline", null, "unreachable");
      },
    },
    [{ name: "Person", forge: [], tracker: { linear: "person@example.com" } }],
    { nowMs: Date.parse("2026-11-10T12:01:00Z"), headroom: true, cache },
  );
  expect(fake.count()).toBe(mark);
  expect(later.unplaced).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining("2026-11-10T12:00:00.000Z"),
    }),
  );
});
