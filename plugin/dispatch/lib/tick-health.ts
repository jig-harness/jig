/**
 * How each recent tick ran, for the dashboard's tick strip (`LineTick`): its
 * duration, its time per phase and per repository, the forge budget it read,
 * and its busy, low-budget and defect counts, all from its receipt. The line
 * carries the list from tick to tick, as it does the durations, so a server on
 * a copy of the state database has it with no receipt file to read.
 */
import type { TickReceipt } from "../receipts.ts";
import type { LineTick, LineTickRepo } from "./dashboard-contract.ts";

/** The recent ticks the line keeps: an hour of wake-ups at one a minute, or four hours of the default interval. */
export const RECENT_TICK_HEALTH = 48;

/**
 * What the strip reads of a receipt. The tick's phases are named by the
 * version that wrote it (`repos` for a tick that observed each repository in
 * turn, `observe`, `wait` and `act` for one that observed them at once), and
 * `busy` and `lowBudget` are absent from a receipt of a tick of the first kind.
 */
export type HealthReceipt = Pick<
  TickReceipt,
  "runId" | "startedAt" | "finishedAt" | "exitStatus" | "defect"
> & {
  phasesMs?: Partial<Record<string, number>>;
  repos: ReadonlyArray<
    Pick<
      TickReceipt["repos"][number],
      "path" | "slug" | "phasesMs" | "defect" | "stageDefects" | "shared"
    >
  >;
  busy?: ReadonlyArray<{ path: string }>;
  lowBudget?: {
    remaining: number;
    limit: number;
    skipped: readonly string[];
  };
};

function summed(phases: Partial<Record<string, number>>): number {
  return Object.values(phases).reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
}

/** The phases with a time, in the order the receipt gives them. */
function timed(
  phases: Partial<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [phase, ms] of Object.entries(phases ?? {}))
    if (typeof ms === "number" && Number.isFinite(ms)) out[phase] = ms;
  return out;
}

/**
 * The tick's own phases. The line is written while the tick closes, so a
 * receipt read then has no `close`: it is the rest of the tick's time to that
 * write. A receipt that timed no phase has none.
 */
function tickPhases(
  receipt: HealthReceipt,
  tookMs: number,
): Record<string, number> {
  const phases = timed(receipt.phasesMs);
  if (Object.keys(phases).length === 0 || "close" in phases) return phases;
  return { ...phases, close: Math.max(0, tookMs - summed(phases)) };
}

function repoOf(report: HealthReceipt["repos"][number]): LineTickRepo {
  const phasesMs = timed(report.phasesMs);
  return {
    repo: report.slug ?? report.path,
    ms: summed(phasesMs),
    phasesMs,
    defect: report.defect?.phase ?? null,
  };
}

/** The forge budget the tick read: the budget gate's, else the shared records' first. */
function budgetOf(receipt: HealthReceipt): LineTick["budget"] {
  if (receipt.lowBudget !== undefined)
    return {
      remaining: receipt.lowBudget.remaining,
      limit: receipt.lowBudget.limit,
    };
  for (const report of receipt.repos) {
    const budget = report.shared?.budget;
    if (budget !== null && budget !== undefined && "remaining" in budget)
      return { remaining: budget.remaining, limit: budget.limit };
  }
  return null;
}

/** One tick's entry; `sweep` says whether it read every repository the machine file lists. */
export function tickHealthOf(receipt: HealthReceipt, sweep: boolean): LineTick {
  const tookMs = Math.max(
    0,
    Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
  );
  const repos = receipt.repos.map(repoOf);
  return {
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    tookMs,
    exitStatus: receipt.exitStatus,
    sweep,
    phasesMs: tickPhases(receipt, tookMs),
    repos,
    budget: budgetOf(receipt),
    busy: (receipt.busy ?? []).map((b) => b.path),
    lowBudget:
      receipt.lowBudget === undefined ? null : [...receipt.lowBudget.skipped],
    defects:
      (receipt.defect === undefined ? 0 : 1) +
      repos.filter((r) => r.defect !== null).length +
      receipt.repos.reduce((n, r) => n + (r.stageDefects?.length ?? 0), 0),
  };
}

/** The recent ticks with this one added last, at most `RECENT_TICK_HEALTH`. */
export function withTick(
  previous: readonly LineTick[] | undefined,
  tick: LineTick,
): LineTick[] {
  return [
    ...(previous ?? []).filter((t) => t.runId !== tick.runId),
    tick,
  ].slice(-RECENT_TICK_HEALTH);
}
