import { expect, test } from "bun:test";
import { failingCallerNeeds, failingCallers } from "../lib/outbound-report.ts";
import type { LedgerReport, LedgerRow } from "../../shared/outbound/ledger.ts";

const hour = 3_600_000;
const now = 10 * hour;
const at = new Date(now).toISOString();

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  hour: now - hour,
  system: "github",
  credential: "github:a",
  operation: "GET /user",
  caller: "skill:example.ts",
  requests: 30,
  cost: 30,
  unknownCost: 0,
  unit: "requests",
  estimated: 0,
  durationMs: 100,
  failures: { invalid: 30 },
  ...over,
});
const report = (...rows: LedgerRow[]): LedgerReport => ({ rows, balances: [] });

test("an outside caller whose calls to a system all failed, under credentials that never succeeded, is one caller", () => {
  const found = failingCallers(
    report(
      row({ credential: "github:a" }),
      row({ credential: "github:a", operation: "GET /issues" }),
      row({ credential: "github:b" }),
      row({ credential: "github:c", failures: { unauthorized: 30 } }),
    ),
  );
  expect(found).toEqual([
    {
      caller: "skill:example.ts",
      system: "github",
      requests: 120,
      credentials: 3,
      classes: ["invalid", "unauthorized"],
    },
  ]);
});

test("a caller whose failures are waits, absences or the system's own faults is not one", () => {
  expect(
    failingCallers(
      report(
        row({ credential: "github:a", failures: { "rate-limited": 30 } }),
        row({ credential: "github:b", failures: { "not-found": 30 } }),
        row({ credential: "github:c", failures: { "server-fault": 30 } }),
      ),
    ),
  ).toEqual([]);
});

test("a caller with too few failing calls, or a tick or pass caller, is not one", () => {
  expect(
    failingCallers(
      report(
        row({ failures: { invalid: 10 } }),
        row({
          caller: "skill:other.ts",
          requests: 10,
          failures: { invalid: 10 },
        }),
        row({ caller: "tick:run-1" }),
        row({ caller: "pass:followup:run-2" }),
      ),
    ),
  ).toEqual([]);
});

test("one host need per caller and system keeps its age and withdraws when the failures stop", () => {
  const callers = failingCallers(report(row({})));
  const first = failingCallerNeeds(callers, [], at);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    cause: "calls-failing",
    act: "Investigate",
    repo: "host",
    target: "github skill:example.ts",
  });
  expect(first[0]?.reason).toContain("skill:example.ts");
  expect(first[0]?.reason).toContain("jig budget");
  const later = failingCallerNeeds(
    callers,
    first,
    new Date(now + 1000).toISOString(),
  );
  expect(later).toHaveLength(1);
  expect(later[0]?.since).toBe(first[0]?.since);
  expect(failingCallerNeeds([], later, at)).toEqual([]);
});

test("a credential that worked does not hide the same caller's credentials that never did", () => {
  expect(
    failingCallers(
      report(
        row({
          credential: "github:a",
          requests: 20,
          failures: { unauthorized: 20 },
        }),
        row({
          credential: "github:b",
          requests: 15,
          failures: { unauthorized: 15 },
        }),
        row({ credential: "github:ok", requests: 300, failures: {} }),
        row({
          credential: "github:mixed",
          requests: 100,
          failures: { invalid: 10 },
        }),
      ),
    ),
  ).toEqual([
    {
      caller: "skill:example.ts",
      system: "github",
      requests: 35,
      credentials: 2,
      classes: ["unauthorized"],
    },
  ]);
});

test("a caller whose only failures sit under credentials that also succeeded is not one", () => {
  expect(
    failingCallers(
      report(
        row({
          credential: "github:a",
          requests: 40,
          failures: { invalid: 30 },
        }),
        row({ credential: "github:b", requests: 30, failures: {} }),
      ),
    ),
  ).toEqual([]);
});
