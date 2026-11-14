/** The budget database's migrations, shared by admission and the cost ledger. */
import type { Migration } from "../records/db.ts";
export const BUDGET_MIGRATIONS: readonly Migration[] = [
  {
    additive: false,
    sql: "CREATE TABLE tracker_budget (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  },
  {
    additive: true,
    sql: `CREATE TABLE outbound_cost (
      hour INTEGER NOT NULL, system TEXT NOT NULL, credential TEXT NOT NULL,
      operation TEXT NOT NULL, caller TEXT NOT NULL, unit TEXT NOT NULL,
      requests INTEGER NOT NULL, cost REAL NOT NULL, unknown_cost INTEGER NOT NULL,
      estimated INTEGER NOT NULL, duration_ms REAL NOT NULL, failures TEXT NOT NULL,
      PRIMARY KEY (hour, system, credential, operation, caller, unit)
    );`,
  },
];
