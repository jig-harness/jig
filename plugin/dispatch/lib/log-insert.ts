/**
 * Leaf writer for the outcome log's `log` table (`state.ts`). Keeping the SQL
 * insert free of `launches.ts` lets launch cleanup and steward-request
 * settlement write outcome rows in the same transaction without an import cycle.
 */
import type { Database } from "bun:sqlite";
import { parseMs } from "../../shared/time.ts";
import { releaseOf } from "./release.ts";

/** The columns `insertLogRow` reads from an ended or event outcome row. */
interface InsertableLogRow {
  kind: "ended" | "event";
  key: string;
  at: string;
  release?: string;
  repo: string;
  stage: string;
  target: string;
  account: string | null;
  class: string | null;
  reason: string;
  event?: string;
  cause?: string;
  by?: string;
}

/** The class a row counts under: its class, else (an observation no class names) its event. */
function bucketOf(row: InsertableLogRow): string {
  if (row.class !== null) return row.class;
  return row.kind === "event" ? `event: ${row.event ?? ""}` : "unknown";
}

/**
 * The row with the release it counts under: an ended row keeps the one its
 * launch record named (the run's release is the one at its launch, not the
 * one that logs its end); an event is the writing tick's own.
 */
function withRelease<T extends InsertableLogRow>(row: T): T {
  if (row.release !== undefined || row.kind === "ended") return row;
  const release = releaseOf();
  return release === undefined ? row : { ...row, release };
}

/**
 * Write `given` into the log, unless a row with its key is already there:
 * true when this call wrote it. Called inside the transaction that writes
 * what the row records, it lands with it or not at all.
 */
export function insertLogRow(db: Database, given: InsertableLogRow): boolean {
  const row = withRelease(given);
  const done = db
    .query(
      `INSERT INTO log (key, kind, at, at_ms, repo, stage, account, bucket, reason, row, target, cause, report_by, release)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    )
    .run(
      row.key,
      row.kind,
      row.at,
      parseMs(row.at),
      row.repo,
      row.stage,
      row.account,
      bucketOf(row),
      row.reason,
      JSON.stringify(row),
      row.target,
      row.kind === "ended" ? (row.cause ?? null) : null,
      row.kind === "ended" ? (row.by ?? null) : null,
      row.release ?? null,
    );
  return done.changes === 1;
}
