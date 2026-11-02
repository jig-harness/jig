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
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { stateRoot } from "../receipts.ts";
import { logFile, monthOf, parseLine } from "./log.ts";
import { existingStateDb } from "./state.ts";

/** The most rows one query copies; an export repeats until it has copied every row written before it began. */
const BATCH = 5000;
const CHUNK = 1 << 20;
const TEMPORARY = /\.[0-9a-f-]{36}\.tmp$/;

/** Remove the temporaries an interrupted export left beside the month files. */
function reclaimTemporaries(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^log-.*\.jsonl\./.test(name) || !TEMPORARY.test(name)) continue;
    try {
      unlinkSync(`${root}/${name}`);
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/** Call `line` for each line of `path` (without its newline), reading it in chunks; nothing for a missing file. */
function eachLine(path: string, line: (text: string) => void): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(CHUNK);
    let rest = "";
    const decoder = new TextDecoder();
    for (;;) {
      const n = readSync(fd, buffer, 0, CHUNK, null);
      if (n === 0) break;
      rest += decoder.decode(buffer.subarray(0, n), { stream: true });
      const parts = rest.split("\n");
      rest = parts.pop() as string;
      for (const part of parts) line(part);
    }
    rest += decoder.decode();
    if (rest !== "") line(rest);
  } finally {
    closeSync(fd);
  }
}

interface Copied {
  seq: number;
  key: string;
  at: string;
  row: string;
}

/**
 * Add to one month's file the rows it lacks; returns how many it added.
 * The file is copied in chunks into a temporary beside it, the rows added,
 * and the temporary renamed into place: a reader sees the old file or the
 * new one, and a failure removes the temporary.
 */
function copyMonth(path: string, rows: Copied[]): number {
  const held = new Set<string>();
  eachLine(path, (text) => {
    const key = parseLine(text)?.key;
    if (key !== undefined) held.add(key);
  });
  const missing = rows.filter((r) => !held.has(r.key));
  if (missing.length === 0) return 0;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    // A line the file holds is kept as it is, blank lines apart.
    eachLine(path, (text) => {
      if (text !== "") writeSync(fd, `${text}\n`);
    });
    for (const r of missing) writeSync(fd, `${r.row}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // closed already
    }
    try {
      unlinkSync(temporary);
    } catch {
      // never created or already renamed
    }
    throw error;
  }
  return missing.length;
}

/** Add `fresh` to its months' files; returns how many lines were added. */
function copyBatch(fresh: Copied[], root: string): number {
  const months = new Map<string, Copied[]>();
  for (const row of fresh) {
    const month = monthOf(row.at);
    const held = months.get(month);
    if (held === undefined) months.set(month, [row]);
    else held.push(row);
  }
  let added = 0;
  for (const rows of months.values())
    added += copyMonth(logFile((rows[0] as Copied).at, root), rows);
  return added;
}

/**
 * Copy the rows written since the last copy into their months' files, in
 * batches, up to the newest row there was when it began; returns how many
 * lines it added. Nothing happens before the database exists.
 */
export function exportLog(root = stateRoot()): number {
  const db = existingStateDb(root);
  if (db === null) return 0;
  reclaimTemporaries(root);
  const high =
    (
      db.query("SELECT MAX(seq) AS seq FROM log").get() as {
        seq: number | null;
      } | null
    )?.seq ?? 0;
  let added = 0;
  for (;;) {
    const mark =
      (
        db.query("SELECT seq FROM log_export WHERE id = 1").get() as {
          seq: number;
        } | null
      )?.seq ?? 0;
    const fresh =
      mark >= high
        ? []
        : (db
            .query(
              `SELECT seq, key, at, row FROM log WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ${BATCH}`,
            )
            .all(mark, high) as Copied[]);
    if (fresh.length === 0) return added;
    added += copyBatch(fresh, root);
    db.query(
      "INSERT INTO log_export (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq",
    ).run((fresh.at(-1) as Copied).seq);
  }
}
