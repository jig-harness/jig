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
  {
    additive: true,
    sql: "CREATE TABLE forge_pacing (owner TEXT PRIMARY KEY, next_at REAL NOT NULL);",
  },
  {
    // A GitHub credential's quota owner, found once and shared by every
    // process (`github-owner.ts`): the owner's record key, whether it was
    // verified, the login it answered with, and when to look again.
    additive: true,
    sql: `CREATE TABLE github_owner (
      credential TEXT NOT NULL, host TEXT NOT NULL, owner TEXT NOT NULL,
      verified INTEGER NOT NULL, login TEXT, checked_at INTEGER NOT NULL,
      retry_at INTEGER NOT NULL, PRIMARY KEY (credential, host)
    );`,
  },
  {
    // Which quota owner and which of its windows an hourly ledger row spent,
    // beside the row (`ledger.ts`): a table of its own, so a copy that writes
    // the row's twelve columns by position still writes it.
    additive: true,
    sql: `CREATE TABLE outbound_cost_quota (
      hour INTEGER NOT NULL, system TEXT NOT NULL, credential TEXT NOT NULL,
      operation TEXT NOT NULL, caller TEXT NOT NULL, unit TEXT NOT NULL,
      owner TEXT, quota_window TEXT,
      PRIMARY KEY (hour, system, credential, operation, caller, unit)
    );`,
  },
  {
    // How many of an hourly ledger row's requests a conditional request
    // answered `304 Not Modified` (`ledger.ts`), beside the row for the same
    // reason as the quota table: a copy that writes the row's columns by
    // position still writes it.
    additive: true,
    sql: `CREATE TABLE outbound_cost_not_modified (
      hour INTEGER NOT NULL, system TEXT NOT NULL, credential TEXT NOT NULL,
      operation TEXT NOT NULL, caller TEXT NOT NULL, unit TEXT NOT NULL,
      not_modified INTEGER NOT NULL,
      PRIMARY KEY (hour, system, credential, operation, caller, unit)
    );`,
  },
];
