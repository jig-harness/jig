/**
 * The newest tick's line in the state database (`tick_line`, one row): what
 * `jig dispatch dashboard` shows above the log, and that tick's receipt. It is
 * a table rather than a file so a host that serves the dashboard from a copy
 * of the database has it with no other read: launch states, walls, accounts
 * and titles all come from records only the tick can reach.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import type { LineSnapshot } from "./dashboard-contract.ts";
import { existingStateDb, stateDb } from "./state.ts";

/** Replace the stored line with this tick's. */
export function writeLine(
  line: LineSnapshot,
  receipt: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      `INSERT INTO tick_line (id, run_id, line, receipt) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         run_id = excluded.run_id, line = excluded.line, receipt = excluded.receipt`,
    )
    .run(line.runId, JSON.stringify(line), receipt);
}

function isLine(value: unknown): value is LineSnapshot {
  return (
    isMapping(value) &&
    value.version === 1 &&
    typeof value.runId === "string" &&
    Array.isArray(value.needs) &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.accounts) &&
    Array.isArray(value.queue) &&
    Array.isArray(value.repos)
  );
}

type Stored = { line: string; receipt: string };

function stored(root: string): Stored | null {
  return (
    (existingStateDb(root)
      ?.query("SELECT line, receipt FROM tick_line WHERE id = 1")
      .get() as Stored | null | undefined) ?? null
  );
}

/** The stored line; `null` before a tick wrote one. */
export function readLine(
  root = stateRoot(),
): Outcome<LineSnapshot | null, "line-unreadable"> {
  const row = attempt(
    "line-unreadable",
    "the newest tick's line cannot be read",
    () => stored(root),
  );
  if (!row.ok) return row;
  if (row.value === null) return ok(null);
  const { line } = row.value;
  const parsed = attempt(
    "line-unreadable",
    "the newest tick's line is not JSON",
    (): unknown => JSON.parse(line),
  );
  if (!parsed.ok) return parsed;
  return isLine(parsed.value)
    ? ok(parsed.value)
    : failed(
        "line-unreadable",
        "the newest tick's line is not in a form this plugin reads; the next tick writes it again",
      );
}

/** The receipt of the tick that wrote the stored line, as its text; `null` before a tick wrote one. */
export function readLineReceipt(
  root = stateRoot(),
): Outcome<string | null, "line-unreadable"> {
  const row = attempt(
    "line-unreadable",
    "the newest tick's receipt cannot be read",
    () => stored(root),
  );
  return row.ok ? ok(row.value?.receipt ?? null) : row;
}
