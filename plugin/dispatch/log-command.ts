/**
 * `jig dispatch log [--since DATE] [--jsonl]`: the outcome log as text,
 * read from the state database (`lib/log.ts`), oldest row first. With
 * `--jsonl` it prints each row as the JSON line the month files
 * (`lib/log-export.ts`) hold, the export that outlives the database's
 * schema; without it, one line a row for a person: the time, the class,
 * the stage and its target, the repository, the account and the reason.
 */
import { bucket, type LogRow, rowsOf } from "./lib/log.ts";
import { existingStateDb } from "./lib/state.ts";
import { stateRoot } from "./receipts.ts";

export interface LogOptions {
  /** An ISO time; rows timed before it are left out. */
  since?: string;
  jsonl: boolean;
}

/** One row as a line for a person. */
function textLine(row: LogRow): string {
  return [
    row.at,
    bucket(row),
    `${row.stage} ${row.target}`,
    row.repo,
    row.account ?? "-",
    row.reason,
  ].join("\t");
}

/** The rows since `since`, in the order they were written, as `print` gets them. */
export function logMain(
  options: LogOptions,
  root = stateRoot(),
  print: (line: string) => void = console.log,
): number {
  const db = existingStateDb(root);
  if (db === null) return 0;
  const since =
    options.since === undefined
      ? Number.MIN_SAFE_INTEGER
      : Date.parse(options.since);
  const rows = db
    .query("SELECT row FROM log WHERE at_ms >= ? ORDER BY seq")
    .all(since) as Array<{ row: string }>;
  if (options.jsonl) for (const { row } of rows) print(row);
  else for (const row of rowsOf(rows)) print(textLine(row));
  return 0;
}
