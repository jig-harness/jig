/** Read-only operation and caller totals from the machine's cost ledger. */
import type { CommandComponent } from "../runtime/component.ts";
import { ExitError } from "../shared/cli.ts";
import {
  ledgerReport,
  type LedgerRow,
  UNATTRIBUTED,
} from "../shared/outbound/ledger.ts";
import {
  credentialLabel,
  NO_CREDENTIAL,
} from "../shared/outbound/missing-credential.ts";
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

/** The calls each system had no credential for, with who made them: they spent nothing, so they are no credential's spending. */
function noCredentialGroups(rows: readonly LedgerRow[]) {
  const bySystem = new Map<string, { calls: number; callers: Set<string> }>();
  for (const row of rows) {
    if (row.credential !== NO_CREDENTIAL) continue;
    const known = bySystem.get(row.system) ?? {
      calls: 0,
      callers: new Set<string>(),
    };
    known.calls += Object.values(row.failures).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    );
    known.callers.add(row.caller);
    bySystem.set(row.system, known);
  }
  return [...bySystem]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([system, { calls, callers }]) => ({
      system,
      label: credentialLabel(system, NO_CREDENTIAL) as string,
      calls,
      callers: [...callers].sort(),
    }));
}

/** The rows by operation or caller, keeping system, credential and cost unit separate. */
function budgetGroups(
  rows: readonly LedgerRow[],
  group: "operation" | "caller",
) {
  const totals = new Map<string, LedgerRow>();
  for (const row of rows) {
    if (row.credential === NO_CREDENTIAL) continue;
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
    known.notModified = (known.notModified ?? 0) + (row.notModified ?? 0);
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
      /** How the credential reads when it is not a hashed key: a client's own login. */
      credentialLabel: credentialLabel(row.system, row.credential),
      unit: row.unit,
      [group]: row[group],
      requests: row.requests,
      notModified: row.notModified ?? 0,
      cost: row.cost,
      unknownCost: row.unknownCost,
      estimated: row.estimated,
      durationMs: row.durationMs,
      failures: row.failures,
      unattributed: row[group] === UNATTRIBUTED,
    }))
    .sort((a, b) => a.system.localeCompare(b.system) || b.cost - a.cost);
}

type BudgetTotals = ReturnType<typeof budgetGroups>;
type BudgetAnswer = ReturnType<typeof ledgerReport> & {
  operations: BudgetTotals;
  callers: BudgetTotals;
  noCredential: ReturnType<typeof noCredentialGroups>;
};

function costLine(
  row: BudgetTotals[number],
  group: "operation" | "caller",
): string {
  const credential = row.credentialLabel ?? row.credential;
  if (row.unattributed)
    return `  ${row.system} ${credential} unattributed: ${row.cost} ${row.unit} the reported balance shows spent that no counted call explains`;
  const estimated = row.estimated ? " (includes estimates)" : "";
  const unknown = row.unknownCost ? `, ${row.unknownCost} unknown cost` : "";
  const notModified = row.notModified
    ? ` (${row.notModified} answered 304 Not Modified)`
    : "";
  return `  ${row.system} ${credential} ${row[group]}: ${row.requests} requests${notModified}, ${row.cost} ${row.unit}${estimated}${unknown}, ${row.durationMs} ms`;
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

/** The calls that had no credential, by system, with their callers: the caller's environment lacks the key. */
function printNoCredential(answer: BudgetAnswer): void {
  if (answer.noCredential.length === 0) return;
  console.log("No credential (nothing sent, nothing spent):");
  for (const group of answer.noCredential)
    console.log(
      `  ${group.system} ${group.label}: ${group.calls} call${group.calls === 1 ? "" : "s"}, from ${group.callers.join(", ")}`,
    );
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
  printNoCredential(answer);
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
    noCredential: noCredentialGroups(report.rows),
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
