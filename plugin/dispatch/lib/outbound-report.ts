/** Spending and quota forecasts from the machine's hourly cost ledger; no outside calls. */
import type {
  BudgetRecord,
  BudgetWindow,
} from "../../shared/outbound/budget.ts";
import type { LedgerReport, LedgerRow } from "../../shared/outbound/ledger.ts";
import { GITHUB_WINDOW_NAMES } from "../../shared/outbound/github-budget.ts";
import { isoFromMs } from "../../shared/time.ts";
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
  /**
   * What the rows that recorded the window of the quota owner's record they
   * spent spent in each, estimates counted apart; `unknown` for spending no
   * evidence placed.
   */
  windows: Array<{ window: string; cost: number; estimated: number }>;
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

/**
 * Adds a row to the window of the quota owner's record it spent. A GitHub row
 * written without its window spent the one its unit and operation suggest,
 * counted as an estimate.
 */
function addWindow(entry: SystemSpending, row: LedgerRow): void {
  const spentIn =
    row.window != null
      ? { window: row.window, inferred: false }
      : row.system === "github"
        ? rowWindow(row)
        : null;
  if (spentIn === null) return;
  let spent = entry.windows.find((w) => w.window === spentIn.window);
  if (spent === undefined) {
    spent = { window: spentIn.window, cost: 0, estimated: 0 };
    entry.windows.push(spent);
  }
  spent.cost += row.cost + row.unknownCost;
  spent.estimated +=
    row.estimated + row.unknownCost + (spentIn.inferred ? row.cost : 0);
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
        windows: [],
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
    addWindow(entry, row);
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
  /** Part of `spent` is an estimate: a cost no answer reported, or a window inferred for a row that recorded none. */
  estimated: boolean;
  /** What the owner's rows spent in the last hour that no evidence placed in a window. */
  unknownWindow: number;
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

/**
 * The window of the quota owner's record a row spent: as it recorded, else
 * for a GitHub row written without one, inferred from its unit and
 * operation (GraphQL points, a REST search, else the core requests).
 */
function rowWindow(row: LedgerRow): { window: string; inferred: boolean } {
  if (row.window != null) return { window: row.window, inferred: false };
  const window =
    row.unit === "points"
      ? "complexity"
      : /^[A-Z]+ \/search(\/|$)/.test(row.operation)
        ? "search"
        : "requests";
  return { window, inferred: true };
}

/**
 * Spending in a quota's own unit, never inferred from missing complexity
 * headers. A GitHub row spends only the window it recorded, an unknown cost
 * counted as the least a call costs; a row with no window recorded spends
 * the one its unit and operation suggest.
 */
function quotaCost(row: LedgerRow, window: "requests" | "complexity"): number {
  if (row.system !== "github")
    return window === "requests"
      ? row.requests
      : row.unit === "points"
        ? row.cost
        : 0;
  const spent = rowWindow(row);
  if (spent.window !== window) return 0;
  return spent.inferred && window === "complexity"
    ? row.cost
    : row.cost + row.unknownCost;
}

/** Whether a row's part of a quota's spending is an estimate. */
function estimatedCost(
  row: LedgerRow,
  window: "requests" | "complexity",
): boolean {
  if (quotaCost(row, window) <= 0) return false;
  return (
    row.estimated > 0 ||
    row.unknownCost > 0 ||
    (row.system === "github" && rowWindow(row).inferred)
  );
}

/** What a system calls each window of its record. */
function windowLabel(system: string, window: string): string {
  if (system === "github") return GITHUB_WINDOW_NAMES[window] ?? window;
  return window === "requests" ? "requests" : "points";
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
  const unknownWindow = rows.reduce(
    (sum, r) =>
      r.window === "unknown"
        ? sum + (r.cost + r.unknownCost) * hourShare(r, now)
        : sum,
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
    estimated: rows.some(
      (r) => hourShare(r, now) > 0 && estimatedCost(r, name),
    ),
    unknownWindow,
    emptiesAt,
    resetAt: window.resetAt,
    operations: quotaOperations(rows, name, now),
  };
}

/**
 * The quotas whose last hour's net spend empties their balance before the
 * refill horizon. A row counts against the record of the quota owner it
 * names, else (a row written before owners were kept) its credential's.
 */
export function quotaRisks(report: LedgerReport, now: number): QuotaRisk[] {
  return report.balances.flatMap((b) => {
    const rows = report.rows.filter(
      (r) =>
        (r.owner ?? r.credential) === b.key &&
        r.system === b.system &&
        hourShare(r, now) > 0,
    );
    return (["requests", "complexity"] as const).flatMap((name) => {
      const risk = quotaRisk(b, name, rows, now);
      return risk === null ? [] : [risk];
    });
  });
}

/** The fewest calls, across the credentials that never succeeded, that make a caller's failures worth a person's look. */
const FAILING_CALLER_MIN_REQUESTS = 20;

/** A caller outside the tick and its passes whose calls to one system were all refused as unauthorized or invalid. */
export interface FailingCaller {
  caller: string;
  system: string;
  /** Requests it sent, across the credentials that never succeeded. */
  requests: number;
  /** How many credentials it sent them under. */
  credentials: number;
  /** The failure classes it met, in name order. */
  classes: string[];
}

/**
 * The failure classes that say a caller cannot use its credential or asks
 * what it should not: a refused credential and a refused request. A wait
 * (`rate-limited`), an absence (`not-found`) and a fault of the system's own
 * say nothing of the caller.
 */
const CALLER_FAULTS = ["unauthorized", "invalid"] as const;

/** The calls a ledger row counts as the caller's own fault. */
const failedOf = (r: LedgerRow): number =>
  CALLER_FAULTS.reduce((sum, name) => sum + (r.failures[name] ?? 0), 0);

/** What one caller sent to one system under one credential. */
interface CredentialCalls {
  caller: string;
  system: string;
  requests: number;
  failed: number;
  classes: Set<string>;
}

/** The calls of every caller outside the tick and its passes, by the credential they went out under. */
function outsideCalls(report: LedgerReport): CredentialCalls[] {
  const byKey = new Map<string, CredentialCalls>();
  for (const r of report.rows) {
    if (r.caller.startsWith("tick:") || r.caller.startsWith("pass:")) continue;
    const key = `${r.caller}\0${r.system}\0${r.credential}`;
    const at = byKey.get(key) ?? {
      caller: r.caller,
      system: r.system,
      requests: 0,
      failed: 0,
      classes: new Set<string>(),
    };
    at.requests += r.requests;
    at.failed += failedOf(r);
    for (const name of CALLER_FAULTS)
      if ((r.failures[name] ?? 0) > 0) at.classes.add(name);
    byKey.set(key, at);
  }
  return [...byKey.values()];
}

/**
 * The callers outside the tick and its passes (a skill a timer or a person
 * runs) with credentials whose every call in the report's window failed,
 * at least `FAILING_CALLER_MIN_REQUESTS` calls in all. The tick's own and a
 * pass's failures are already on the receipt and the failure ledger; a
 * caller the dispatcher does not run is otherwise seen by nobody. A
 * credential that fails on every call is one a caller cannot use, whatever
 * it is asking; a caller that starts each run with a fresh credential shows
 * as many.
 */
export function failingCallers(report: LedgerReport): FailingCaller[] {
  const callers = new Map<string, FailingCaller>();
  for (const at of outsideCalls(report)) {
    if (at.failed === 0 || at.failed < at.requests) continue;
    const key = `${at.caller}\0${at.system}`;
    const known = callers.get(key) ?? {
      caller: at.caller,
      system: at.system,
      requests: 0,
      credentials: 0,
      classes: [],
    };
    known.requests += at.requests;
    known.credentials += 1;
    known.classes = [...new Set([...known.classes, ...at.classes])].sort();
    callers.set(key, known);
  }
  return [...callers.values()]
    .filter((c) => c.requests >= FAILING_CALLER_MIN_REQUESTS)
    .sort((a, z) =>
      `${a.system} ${a.caller}`.localeCompare(`${z.system} ${z.caller}`),
    );
}

/** One continuing host need per failing caller and system; an absent one withdraws its need on the next tick. */
export function failingCallerNeeds(
  callers: readonly FailingCaller[],
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed[] {
  return callers.map((c): LineNeed => {
    const target = `${c.system} ${c.caller}`;
    const known = previous.find(
      (n) =>
        n.repo === "host" && n.cause === "calls-failing" && n.target === target,
    );
    return {
      cause: "calls-failing",
      act: "Investigate",
      stage: "rearm",
      repo: "host",
      target,
      pr: null,
      item: null,
      url: null,
      title: "A caller's calls all fail",
      workspace: null,
      since: known?.since ?? nowIso,
      reason: `${c.caller} sent ${c.requests} request(s) to ${c.system} in the last hours and every one was refused (${c.classes.join(", ")}) under ${c.credentials} credential(s): the client it runs with probably has no credential that can answer. Inspect jig budget --hours 2 --json for the caller, and give it a login or stop it.`,
      question: null,
      decisions: [],
      notified: known?.notified ?? null,
      workspaces: [],
    };
  });
}

/** What a tick reads of the ledger beside its spending: the quotas it empties and the callers whose calls all failed. */
export function ledgerFindings(
  report: LedgerReport,
  now: number,
): { quotaRisks: QuotaRisk[]; failingCallers: FailingCaller[] } {
  return {
    quotaRisks: quotaRisks(report, now),
    failingCallers: failingCallers(report),
  };
}

/**
 * The line's host needs from the ledger: one per quota and one per failing
 * caller. A finding the ledger did not give (it did not read) keeps the
 * needs of the tick before.
 */
export function outboundNeeds(
  found: { quotaRisks?: QuotaRisk[]; failingCallers?: FailingCaller[] },
  previous: readonly LineNeed[],
  nowIso: string,
): LineNeed[] {
  const kept = (cause: LineNeed["cause"]) =>
    previous.filter((n) => n.repo === "host" && n.cause === cause);
  return [
    ...(found.quotaRisks === undefined
      ? kept("low-quota")
      : lowQuotaNeeds(found.quotaRisks, previous, nowIso)),
    ...(found.failingCallers === undefined
      ? kept("calls-failing")
      : failingCallerNeeds(found.failingCallers, previous, nowIso)),
  ];
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
      reason: `${risk.system}'s ${risk.window} quota is projected to empty at ${isoFromMs(risk.emptiesAt)}, before its refill horizon ${isoFromMs(risk.resetAt)}; ${Math.round(risk.remaining)} left, ${Math.round(risk.spent)} spent in the estimated last hour${risk.estimated ? " (includes estimated costs)" : ""}${risk.unknownWindow > 0 ? `, and ${Math.round(risk.unknownWindow)} more in a window the ledger could not name` : ""}. Operations: ${risk.operations.join(", ")}. Inspect jig budget before changing the workload.`,
      question: null,
      decisions: [],
      notified: known?.notified ?? null,
      workspaces: [],
    };
  });
}

/** A balance as a whole count; a refilling window's is fractional. */
function shown(remaining: number | null): string {
  return remaining === null ? "unknown" : String(Math.floor(remaining));
}

/** One terminal line per system, with units kept separate. */
export function spendingLines(systems: readonly SystemSpending[]): string[] {
  return systems.map((s) => {
    const held =
      s.balances
        .map(
          (b) =>
            `${b.key}: ${windowLabel(s.system, "requests")} ${shown(b.requests.remaining)}/${b.requests.limit ?? "unknown"}, ${windowLabel(s.system, "complexity")} ${shown(b.complexity.remaining)}/${b.complexity.limit ?? "unknown"}`,
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
    const windows = s.windows
      .map(
        (w) =>
          `${windowLabel(s.system, w.window)} ${w.cost}${w.estimated ? " (includes estimates)" : ""}`,
      )
      .join(", ");
    return `outbound ${s.system}: ${held}; tick spent ${s.requests} requests, ${costs}${windows === "" ? "" : `; by window: ${windows}`}; costliest: ${top}`;
  });
}
