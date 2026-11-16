import { expect, test } from "bun:test";
import {
  lowQuotaNeeds,
  quotaRisks,
  spendingLines,
  systemSpending,
} from "../lib/outbound-report.ts";
import type { LedgerReport, LedgerRow } from "../../shared/outbound/ledger.ts";

const hour = 3_600_000;
const now = 10 * hour;
const row = (caller = "tick:one", cost = 200): LedgerRow => ({
  hour: now - hour,
  system: "linear",
  credential: "linear:test",
  operation: "Queue",
  caller,
  requests: 20,
  cost,
  unknownCost: 0,
  unit: "points",
  estimated: 0,
  durationMs: 100,
  failures: {},
});
const report = (cost = 200): LedgerReport => ({
  rows: [row("tick:one", cost)],
  balances: [
    {
      key: "linear:test",
      system: "linear",
      record: {
        requests: {
          limit: 100,
          remaining: 80,
          resetAt: now + hour,
          refillMs: hour,
          readAt: now,
        },
        complexity: {
          limit: 100,
          remaining: 50,
          resetAt: now + hour,
          refillMs: hour,
          readAt: now,
        },
        limitedUntil: null,
        why: null,
        observedAt: now,
      },
    },
  ],
});

test("a rate above refill raises one host need, retains its age, and later withdraws", () => {
  const risks = quotaRisks(report(), now);
  expect(risks).toHaveLength(1);
  expect(risks[0]?.window).toBe("complexity");
  expect(risks[0]?.operations).toEqual(["Queue"]);
  const first = lowQuotaNeeds(risks, [], new Date(now).toISOString());
  expect(first).toHaveLength(1);
  expect(first[0]?.cause).toBe("low-quota");
  const second = lowQuotaNeeds(
    risks,
    first,
    new Date(now + 1000).toISOString(),
  );
  expect(second).toHaveLength(1);
  expect(second[0]?.since).toBe(first[0]?.since);
  expect(
    lowQuotaNeeds(
      quotaRisks(report(10), now),
      second,
      new Date(now + hour).toISOString(),
    ),
  ).toEqual([]);
});

test("tick totals exclude a concurrent caller and retain the system's known balance", () => {
  const data = report();
  data.rows.push(row("skill:review", 900));
  const systems = systemSpending(data, "tick:one", now);
  expect(systems).toHaveLength(1);
  expect(systems[0]?.costs).toEqual([
    { unit: "points", cost: 200, unknownCost: 0, estimated: 0 },
  ]);
  expect(systems[0]?.requests).toBe(20);
  expect(systems[0]?.balances[0]?.complexity.remaining).toBe(50);
});

test("spending lines retain the costliest operations for each cost unit", () => {
  const data = report();
  data.rows.push({
    ...row("tick:one", 9),
    unit: "requests",
    operation: "Rest",
  });
  const line = spendingLines(systemSpending(data, "tick:one", now))[0];
  expect(line).toContain("Queue 200 points");
  expect(line).toContain("Rest 9 requests");
});

test("a window whose refill keeps pace is safe and a fixed window predicts exhaustion before reset", () => {
  expect(quotaRisks(report(100), now)).toEqual([]);
  const data = report(100);
  const balance = data.balances[0];
  if (balance === undefined) throw new Error("fixture has no balance");
  delete balance.record.complexity.refillMs;
  expect(quotaRisks(data, now)).toHaveLength(1);
});

test("search requests are not core spending", () => {
  const search: LedgerRow = {
    ...row(),
    system: "github",
    credential: "github:test",
    operation: "GET /search/issues",
    unit: "requests",
    requests: 500,
    cost: 500,
  };
  const github: LedgerReport = {
    rows: [search],
    balances: [
      {
        key: "github:test",
        system: "github",
        record: {
          requests: { limit: 5000, remaining: 100, resetAt: now + hour },
          complexity: { limit: 5000, remaining: 4000, resetAt: now + hour },
          limitedUntil: null,
          why: null,
          observedAt: now,
        },
      },
    ],
  };
  expect(quotaRisks(github, now)).toEqual([]);
});

test("unchanged GitHub traffic is reported without forecasting primary depletion", () => {
  const data = report();
  data.rows = [
    {
      ...row(),
      system: "github",
      credential: "github:test",
      operation: "GET /repos/{}/{}/pulls/{}",
      unit: "requests",
      requests: 2000,
      cost: 0,
    },
  ];
  const balance = data.balances[0];
  if (balance === undefined) throw new Error("fixture has no balance");
  balance.key = "github:test";
  balance.system = "github";
  balance.record.requests = { limit: 5000, remaining: 10, resetAt: now + hour };
  expect(quotaRisks(data, now)).toEqual([]);
  const line = spendingLines(systemSpending(data, "tick:one", now))[0];
  expect(line).toContain("tick spent 2000 requests, 0 requests");
  const charged = data.rows[0];
  if (charged === undefined) throw new Error("fixture has no spending row");
  charged.cost = 20;
  expect(quotaRisks(data, now)[0]).toMatchObject({
    window: "requests",
    spent: 20,
  });
});

test("unknown GitHub primary spending forecasts conservatively", () => {
  const data = report();
  data.rows = [
    {
      ...row(),
      system: "github",
      credential: "github:test",
      operation: "GET /repos/{}/{}/pulls/{}",
      unit: "requests",
      requests: 2000,
      cost: 0,
      unknownCost: 2000,
    },
  ];
  const balance = data.balances[0];
  if (balance === undefined) throw new Error("fixture has no balance");
  balance.key = "github:test";
  balance.system = "github";
  balance.record.requests = { limit: 5000, remaining: 10, resetAt: now + hour };
  expect(quotaRisks(data, now)[0]).toMatchObject({
    window: "requests",
    spent: 2000,
  });
});

/** A GitHub owner's record and the rows of its credentials. */
function github(rows: LedgerRow[]): LedgerReport {
  return {
    rows,
    balances: [
      {
        key: "github:owner",
        system: "github",
        record: {
          requests: { limit: 5000, remaining: 100, resetAt: now + hour },
          complexity: { limit: 5000, remaining: 100, resetAt: now + hour },
          limitedUntil: null,
          why: null,
          observedAt: now,
        },
      },
    ],
  };
}

const pullView = (window: string | null): LedgerRow => ({
  ...row(),
  system: "github",
  credential: "github:token",
  owner: window === null ? null : "github:owner",
  window,
  operation: "pr view",
  unit: "requests",
  requests: 500,
  cost: 500,
  estimated: 500,
});

test("a GraphQL subcommand spends the GraphQL window of its owner's record, marked as estimated", () => {
  const risks = quotaRisks(github([pullView("complexity")]), now);
  expect(risks).toHaveLength(1);
  expect(risks[0]).toMatchObject({
    key: "github:owner",
    window: "complexity",
    spent: 500,
    estimated: true,
    operations: ["pr view"],
  });
  const [need] = lowQuotaNeeds(risks, [], new Date(now).toISOString());
  expect(need?.reason).toContain("(includes estimated costs)");
  const line = spendingLines(
    systemSpending(github([pullView("complexity")]), "tick:one", now),
  )[0];
  expect(line).toContain("by window: graphql 500 (includes estimates)");
});

test("spending no evidence placed is reported as unknown, never as core or GraphQL", () => {
  const report = github([
    pullView("unknown"),
    {
      ...pullView("requests"),
      operation: "GET /repos/{}/{}",
      cost: 200,
      estimated: 0,
    },
  ]);
  const risks = quotaRisks(report, now);
  expect(risks).toHaveLength(1);
  expect(risks[0]).toMatchObject({
    window: "requests",
    spent: 200,
    estimated: false,
    unknownWindow: 500,
  });
  const [need] = lowQuotaNeeds(risks, [], new Date(now).toISOString());
  expect(need?.reason).toContain(
    "500 more in a window the ledger could not name",
  );
  expect(spendingLines(systemSpending(report, "tick:one", now))[0]).toContain(
    "unknown 500 (includes estimates)",
  );
});

test("a row written before owners were kept counts against its credential's record, its window inferred", () => {
  const legacy = github([
    { ...pullView(null), credential: "github:owner", cost: 300 },
  ]);
  expect(quotaRisks(legacy, now)[0]).toMatchObject({
    window: "requests",
    spent: 300,
    estimated: true,
  });
  // A row of another owner does not count.
  expect(
    quotaRisks(
      github([{ ...pullView("requests"), owner: "github:else" }]),
      now,
    ),
  ).toEqual([]);
});
