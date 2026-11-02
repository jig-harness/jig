/**
 * The outcome log's text copy: one file per month under the state
 * directory (`log-<year>-<month>.jsonl`), one row per line as the database
 * keeps it, which nothing removes. It is the archive that outlives any
 * change to the database's schema; the tick keeps it current at the end of
 * every run, so no person has to run anything for it.
 *
 * The database remembers the last row it copied (`log_export`). A tick
 * adds each later row to its month's file, unless the file already holds
 * a row with that key, by writing the file whole with the rows added and
 * renaming it into place: a tick that stops mid-copy leaves the file as it
 * was, and the next copies the same rows again without a second line for
 * any. A line the file already holds is kept as it is, so a copy written
 * before the database existed, or before it was replaced, is never lost.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { stateRoot } from "../receipts.ts";
import { logFile, monthOf, parseLine } from "./log.ts";
import { existingStateDb } from "./state.ts";

/** Write `text` to `path` whole: a reader sees the old file or the new one. */
function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

interface Copied {
  seq: number;
  key: string;
  at: string;
  row: string;
}

/** Add to one month's file the rows it lacks; returns how many it added. */
function copyMonth(path: string, rows: Copied[]): number {
  const text = readText(path);
  const held = new Set<string>();
  for (const line of text.split("\n")) {
    const key = parseLine(line)?.key;
    if (key !== undefined) held.add(key);
  }
  const missing = rows.filter((r) => !held.has(r.key));
  if (missing.length === 0) return 0;
  const lead = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  writeWhole(path, lead + missing.map((r) => `${r.row}\n`).join(""));
  return missing.length;
}

/**
 * Copy the rows written since the last copy into their months' files;
 * returns how many lines it added. Nothing happens before the database
 * exists.
 */
export function exportLog(root = stateRoot()): number {
  const db = existingStateDb(root);
  if (db === null) return 0;
  const mark =
    (
      db.query("SELECT seq FROM log_export WHERE id = 1").get() as {
        seq: number;
      } | null
    )?.seq ?? 0;
  const fresh = db
    .query("SELECT seq, key, at, row FROM log WHERE seq > ? ORDER BY seq")
    .all(mark) as Copied[];
  if (fresh.length === 0) return 0;
  const months = new Map<string, Copied[]>();
  for (const row of fresh) {
    const month = monthOf(row.at);
    months.set(month, [...(months.get(month) ?? []), row]);
  }
  let added = 0;
  for (const rows of months.values())
    added += copyMonth(logFile((rows[0] as Copied).at, root), rows);
  db.query(
    "INSERT INTO log_export (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq",
  ).run((fresh.at(-1) as Copied).seq);
  return added;
}
