/** Spending and quota forecasts from the machine's hourly cost ledger; no outside calls. */
import type {
  BudgetRecord,
  BudgetWindow,
} from "../../shared/outbound/budget.ts";
import type { LedgerReport, LedgerRow } from "../../shared/outbound/ledger.ts";
import type { LineNeed } from "./dashboard-contract.ts";

const HOUR = 3_600_000;

export interface SystemSpending {
  system: string;
  requests: number;
  durationMs: number;
  costs: Array<{
    unit: string;
    cost: number;
    unknownCost: number;
    estimated: number;
  }>;
  operations: Array<{
    operation: string;
    unit: string;
    cost: number;
    requests: number;
  }>;
  balances: Array<{
    key: string;
    requests: BudgetWindow;
    complexity: BudgetWindow;
  }>;
}

/** The balance carried forward by a continuous refill, or by a whole-window reset. */
function balance(
  window: BudgetWindow,
  record: BudgetRecord,
  now: number,
): BudgetWindow {
  if (window.remaining === null) return window;
  const remaining =
    window.refillMs != null && window.limit !== null
      ? Math.min(
          window.limit,
          window.remaining +
            (Math.max(0, now - (window.readAt ?? record.observedAt)) *
              window.limit) /
              window.refillMs,
        )
      : window.resetAt !== null &&
          window.resetAt <= now &&
          window.limit !== null
        ? window.limit
        : window.remaining;
  return { ...window, remaining };
}

/** Each system's exact caller totals and the latest quota observations carried to now. */
export function systemSpending(
  report: LedgerReport,
  caller: string,
  now: number,
): SystemSpending[] {
  const systems = new Map<string, SystemSpending>();
  const system = (name: string) => {
    let found = systems.get(name);
    if (found === undefined) {
      found = {
        system: name,
        requests: 0,
        durationMs: 0,
        costs: [],
        operations: [],
        balances: [],
      };
      systems.set(name, found);
    }
    return found;
  };
  for (const row of report.rows) {
    if (row.caller !== caller) continue;
    const entry = system(row.system);
    entry.requests += row.requests;
    entry.durationMs += row.durationMs;
    let cost = entry.costs.find((c) => c.unit === row.unit);
    if (cost === undefined) {
      cost = { unit: row.unit, cost: 0, unknownCost: 0, estimated: 0 };
      entry.costs.push(cost);
    }
    cost.cost += row.cost;
    cost.unknownCost += row.unknownCost;
    cost.estimated += row.estimated;
    let operation = entry.operations.find(
      (o) => o.operation === row.operation && o.unit === row.unit,
    );
    if (operation === undefined) {
      operation = {
        operation: row.operation,
        unit: row.unit,
        cost: 0,
        requests: 0,
      };
      entry.operations.push(operation);
    }
    operation.cost += row.cost;
    operation.requests += row.requests;
  }
  for (const b of report.balances)
    system(b.system).balances.push({
      key: b.key,
      requests: balance(b.record.requests, b.record, now),
      complexity: balance(b.record.complexity, b.record, now),
    });
  return [...systems.values()]
    .sort((a, b) => a.system.localeCompare(b.system))
    .map((s) => ({
      ...s,
      operations: s.operations.sort(
        (a, b) => b.cost - a.cost || b.requests - a.requests,
      ),
    }));
}

export interface QuotaRisk {
  key: string;
  system: string;
  window: "requests" | "complexity";
  remaining: number;
  spent: number;
  emptiesAt: number;
  resetAt: number;
  operations: string[];
}

/**
 * Estimate the preceding hour from hourly totals, weighting each bucket by
 * its overlap. Spending is assumed uniform within each bucket; an incomplete
 * current bucket is weighted against only its elapsed part.
 */
function hourShare(row: LedgerRow, now: number): number {
  const end = Math.min(row.hour + HOUR, now);
  const duration = end - row.hour;
  return duration <= 0
    ? 0
    : Math.max(0, end - Math.max(row.hour, now - HOUR)) / duration;
}

/** Spending in a quota's own unit, never inferred from missing complexity headers. */
function quotaCost(row: LedgerRow, window: "requests" | "complexity"): number {
  if (window === "requests") return row.requests;
  return row.unit === "points" ? row.cost : 0;
}

function quotaOperations(
  rows: readonly LedgerRow[],
  window: "requests" | "complexity",
  now: number,
): string[] {
  const operations = new Map<string, number>();
  for (const row of rows)
    operations.set(
      row.operation,
      (operations.get(row.operation) ?? 0) +
        quotaCost(row, window) * hourShare(row, now),
    );
  return [...operations]
    .filter(([, cost]) => cost > 0)
    .sort((a, z) => z[1] - a[1])
    .map(([operation]) => operation);
}

/** One quota's forecast, or null when the measured spend cannot empty it before refill. */
function quotaRisk(
  b: LedgerReport["balances"][number],
  name: "requests" | "complexity",
  rows: readonly LedgerRow[],
  now: number,
): QuotaRisk | null {
  const window = balance(b.record[name], b.record, now);
  if (
    window.remaining === null ||
    window.resetAt === null ||
    window.resetAt <= now
  )
    return null;
  const spent = rows.reduce(
    (sum, r) => sum + quotaCost(r, name) * hourShare(r, now),
    0,
  );
  const refill =
    window.refillMs != null && window.limit !== null
      ? window.limit / window.refillMs
      : 0;
  const net = spent / HOUR - refill;
  if (net <= 0) return null;
  const emptiesAt = now + Math.max(0, window.remaining) / net;
  if (emptiesAt >= window.resetAt) return null;
  return {
    key: b.key,
    system: b.system,
    window: name,
    remaining: window.remaining,
    spent,
    emptiesAt,
    resetAt: window.resetAt,
    operations: quotaOperations(rows, name, now),
  };
}

/** The quotas whose last hour's net spend empties their balance before the refill horizon. */
export function quotaRisks(report: LedgerReport, now: number): QuotaRisk[] {
  return report.balances.flatMap((b) => {
    const rows = report.rows.filter(
      (r) =>
        r.credential === b.key &&
        r.system === b.system &&
        hourShare(r, now) > 0,
    );
    return (["requests", "complexity"] as const).flatMap((name) => {
      const risk = quotaRisk(b, name, rows, now);
      return risk === null ? [] : [risk];
    });
  });
}

/** One continuing host need per quota; an absent risk withdraws its need on the next tick. */
export function lowQuotaNeeds(
  risks: readonly QuotaRisk[],
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed[] {
  return risks.map((risk): LineNeed => {
    const target = `${risk.system} ${risk.key} ${risk.window}`;
    const known = previous.find(
      (n) =>
        n.repo === "host" && n.cause === "low-quota" && n.target === target,
    );
    return {
      cause: "low-quota",
      act: "Investigate",
      stage: "rearm",
      repo: "host",
      target,
      pr: null,
      item: null,
      url: null,
      title: "Quota projected to run out",
      workspace: null,
      since: known?.since ?? nowIso,
      reason: `${risk.system}'s ${risk.window} quota is projected to empty at ${new Date(risk.emptiesAt).toISOString()}, before its refill horizon ${new Date(risk.resetAt).toISOString()}; ${Math.round(risk.remaining)} left, ${Math.round(risk.spent)} spent in the estimated last hour. Operations: ${risk.operations.join(", ")}. Inspect jig budget before changing the workload.`,
      question: null,
      decisions: [],
      notified: known?.notified ?? null,
      workspaces: [],
    };
  });
}

/** One terminal line per system, with units kept separate. */
export function spendingLines(systems: readonly SystemSpending[]): string[] {
  return systems.map((s) => {
    const held =
      s.balances
        .map(
          (b) =>
            `${b.key}: requests ${b.requests.remaining ?? "unknown"}/${b.requests.limit ?? "unknown"}, points ${b.complexity.remaining ?? "unknown"}/${b.complexity.limit ?? "unknown"}`,
        )
        .join("; ") || "balance unknown";
    const costs =
      s.costs
        .map(
          (c) =>
            `${c.cost} ${c.unit}${c.estimated ? " (includes estimates)" : ""}${c.unknownCost ? `, ${c.unknownCost} unknown cost` : ""}`,
        )
        .join(", ") || "no cost recorded";
    const top =
      [...new Set(s.operations.map((o) => o.unit))]
        .map((unit) => {
          const operations = s.operations
            .filter((o) => o.unit === unit)
            .slice(0, 3)
            .map((o) => `${o.operation} ${o.cost} ${o.unit}`)
            .join(", ");
          return operations || `none (${unit})`;
        })
        .join("; ") || "none";
    return `outbound ${s.system}: ${held}; tick spent ${s.requests} requests, ${costs}; costliest: ${top}`;
  });
}
