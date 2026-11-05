/**
 * The newest tick's line in the state database (`tick_line`, one row): what
 * `jig dispatch dashboard` shows above the log, and that tick's receipt. It is
 * a table rather than a file so a host that serves the dashboard from a copy
 * of the database has it with no other read: launch states, walls, accounts
 * and titles all come from records only the tick can reach.
 *
 * `stateAnswer` is the one read of it for everything outside the tick: the
 * dashboard's `GET /state` and `jig dispatch line --json` both answer with it,
 * so the two never say different things about one database.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { pluginVersion } from "../../shared/plugin-version.ts";
import { stateRoot } from "../receipts.ts";
import type { LineSnapshot, StateAnswer } from "./dashboard-contract.ts";
import { hostTimeZone } from "./host-time.ts";
import { existingStateDb, SCHEMA_VERSION, stateDb } from "./state.ts";

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

/**
 * The newest tick's line with the reader's own facts (its clock, its plugin,
 * the schema it reads): what `GET /state` answers and `jig dispatch line
 * --json` prints. `line` is `null` before a tick wrote one, and when there is
 * no state database yet, which this read never creates.
 */
export function stateAnswer(
  nowMs: number,
  root = stateRoot(),
): Outcome<StateAnswer, "line-unreadable"> {
  const line = readLine(root);
  if (!line.ok) return line;
  return ok({
    now: new Date(nowMs).toISOString(),
    timeZone: line.value?.timeZone ?? hostTimeZone(),
    plugin: pluginVersion(),
    schema: SCHEMA_VERSION,
    line: line.value,
  });
}

/** The receipt of the tick that wrote the stored line, with that tick's run; `null` before a tick wrote one. One row is read, so the two always belong together. */
export function readLineReceipt(
  root = stateRoot(),
): Outcome<{ runId: string; receipt: string } | null, "line-unreadable"> {
  const row = attempt(
    "line-unreadable",
    "the newest tick's receipt cannot be read",
    () =>
      (existingStateDb(root)
        ?.query("SELECT run_id AS runId, receipt FROM tick_line WHERE id = 1")
        .get() as { runId: string; receipt: string } | null | undefined) ??
      null,
  );
  return row;
}
