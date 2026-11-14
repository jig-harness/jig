/** Read-only operation and caller totals from the machine's cost ledger. */
import type { CommandComponent } from "../runtime/component.ts";
import { ExitError } from "../shared/cli.ts";
import { ledgerReport, type LedgerRow } from "../shared/outbound/ledger.ts";
import { currentMs, isoFromMs } from "../shared/time.ts";
import {
  command,
  type InferValue,
  message,
  object,
  option,
  optional,
  string,
} from "../shared/vendor/optique.mjs";

const budgetCommand = command(
  "budget",
  object({
    hours: optional(
      option("--hours", string({ metavar: "HOURS" }), {
        description: message`Hours of totals to show, from 1 to 168; default 24. Hour buckets that overlap the interval are included.`,
      }),
    ),
    json: option("--json", {
      description: message`Print balances and operation/caller totals as JSON.`,
    }),
  }),
  { brief: message`Show what outside calls spent, by operation and caller.` },
);

type BudgetArguments = InferValue<typeof budgetCommand>;

/** The rows by operation or caller, keeping system, credential and cost unit separate. */
function budgetGroups(
  rows: readonly LedgerRow[],
  group: "operation" | "caller",
) {
  const totals = new Map<string, LedgerRow>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.system,
      row.credential,
      row.unit,
      row[group],
    ]);
    const known = totals.get(key);
    if (known === undefined) {
      totals.set(key, { ...row, failures: { ...row.failures } });
      continue;
    }
    known.requests += row.requests;
    known.cost += row.cost;
    known.unknownCost += row.unknownCost;
    known.estimated += row.estimated;
    known.durationMs += row.durationMs;
    for (const [failure, count] of Object.entries(row.failures)) {
      const name = failure as keyof LedgerRow["failures"];
      known.failures[name] = (known.failures[name] ?? 0) + (count ?? 0);
    }
  }
  return [...totals.values()]
    .map((row) => ({
      system: row.system,
      credential: row.credential,
      unit: row.unit,
      [group]: row[group],
      requests: row.requests,
      cost: row.cost,
      unknownCost: row.unknownCost,
      estimated: row.estimated,
      durationMs: row.durationMs,
      failures: row.failures,
    }))
    .sort((a, b) => a.system.localeCompare(b.system) || b.cost - a.cost);
}

type BudgetTotals = ReturnType<typeof budgetGroups>;
type BudgetAnswer = ReturnType<typeof ledgerReport> & {
  operations: BudgetTotals;
  callers: BudgetTotals;
};

function costLine(
  row: BudgetTotals[number],
  group: "operation" | "caller",
): string {
  const estimated = row.estimated ? " (includes estimates)" : "";
  const unknown = row.unknownCost ? `, ${row.unknownCost} unknown cost` : "";
  return `  ${row.system} ${row.credential} ${row[group]}: ${row.requests} requests, ${row.cost} ${row.unit}${estimated}${unknown}, ${row.durationMs} ms`;
}

function printGroup(
  name: string,
  rows: BudgetTotals,
  group: "operation" | "caller",
): void {
  console.log(`By ${name}:`);
  for (const row of rows) console.log(costLine(row, group));
  if (rows.length === 0) console.log("  No calls recorded.");
}

function printBalances(report: BudgetAnswer): void {
  const known = (value: number | null) => value ?? "unknown";
  for (const b of report.balances)
    console.log(
      `Balance ${b.key}: requests ${known(b.record.requests.remaining)}/${known(b.record.requests.limit)}, points ${known(b.record.complexity.remaining)}/${known(b.record.complexity.limit)} (observed ${isoFromMs(b.record.observedAt)}).`,
    );
}

function printBudget(answer: BudgetAnswer, hours: number): void {
  console.log(
    `Outbound spending over the last ${hours} hours (overlapping hourly totals).`,
  );
  if (answer.unavailable)
    console.log("The cost ledger could not be read; no spending is inferred.");
  printGroup("operations", answer.operations, "operation");
  printGroup("callers", answer.callers, "caller");
  printBalances(answer);
}

function budgetMain(args: BudgetArguments): number {
  const hours = args.hours === undefined ? 24 : Number(args.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw new ExitError(
      2,
      "jig budget: --hours must be an integer from 1 to 168",
    );
  const until = currentMs();
  const since = until - hours * 3_600_000;
  const report = ledgerReport({ since, until });
  const answer = {
    since: isoFromMs(since),
    until: isoFromMs(until),
    ...report,
    operations: budgetGroups(report.rows, "operation"),
    callers: budgetGroups(report.rows, "caller"),
  };
  if (args.json) console.log(JSON.stringify(answer, null, 2));
  else printBudget(answer, hours);
  return report.unavailable ? 1 : 0;
}

export const budgetComponent: CommandComponent<BudgetArguments> = {
  name: "budget",
  command: budgetCommand,
  main: async (args) => budgetMain(args),
};
