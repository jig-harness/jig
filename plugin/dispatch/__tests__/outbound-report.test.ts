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
