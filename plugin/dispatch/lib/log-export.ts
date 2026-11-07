/**
 * The outcome log's text copy: one file per month under the state
 * directory (`log-<year>-<month>.jsonl`), one row per line as the database
 * keeps it, which nothing removes. It is the archive that outlives any
 * change to the database's schema; the tick keeps it current at the end of
 * every run, so no person has to run anything for it.
 *
 * The database remembers the last row it copied (`log_export`). A tick
 * adds each later row to its month's file, unless the file already holds
 * a row with that key, by writing the file whole, once, with the rows added
 * and renaming it into place: a tick that stops mid-copy leaves the file as it
 * was, and the next copies the same rows again without a second line for
 * any. A late result refreshes its existing line. Other lines are kept, so a
 * copy written before the database existed, or before it was replaced, is
 * never lost.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type { Database } from "bun:sqlite";
import { writeAllSync } from "../../skills/drive-pr/scripts/lib/state/fsutil.ts";
import { stateRoot } from "../receipts.ts";
import { logFile, monthOf, parseLine } from "./log.ts";
import { existingStateDb } from "./state.ts";

/** The most rows one query reads; an export pages through the rows written before it began. */
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

/** Refresh archived lines in bounded batches; old lines need no individual query. */
function copyRevisions(
  db: Database,
  path: string,
  out: number,
  mark: number,
  high: number,
): void {
  let lines: string[] = [];
  const flush = () => {
    const keys = lines.flatMap((text) => {
      const key = parseLine(text)?.key;
      return key === undefined ? [] : [key];
    });
    const revisions = new Map<string, string>();
    if (keys.length > 0) {
      const rows = db
        .query(
          `SELECT key, row FROM log WHERE seq > ? AND seq <= ? AND key IN (${keys.map(() => "?").join(",")})`,
        )
        .all(mark, high, ...keys) as { key: string; row: string }[];
      for (const row of rows) revisions.set(row.key, row.row);
    }
    for (const text of lines) {
      const key = parseLine(text)?.key;
      writeAllSync(
        out,
        `${key === undefined ? text : (revisions.get(key) ?? text)}\n`,
      );
    }
    lines = [];
  };
  eachLine(path, (text) => {
    if (text === "") return;
    lines.push(text);
    if (lines.length === BATCH) flush();
  });
  if (lines.length > 0) flush();
}

interface Copied {
  seq: number;
  key: string;
  at: string;
  row: string;
}

/**
 * Call `each` for each row with `mark < seq <= high` (and, when `within` is
 * given, `at_ms` in that half-open range), in order, reading `BATCH` rows at
 * a time.
 */
function eachRow(
  db: Database,
  mark: number,
  high: number,
  each: (row: Copied) => void,
  within?: { from: number; to: number },
): void {
  const range = within === undefined ? "" : "AND at_ms >= ? AND at_ms < ?";
  const extra = within === undefined ? [] : [within.from, within.to];
  let after = mark;
  for (;;) {
    const page = db
      .query(
        `SELECT seq, key, at, row FROM log WHERE seq > ? AND seq <= ? ${range} ORDER BY seq LIMIT ${BATCH}`,
      )
      .all(after, high, ...extra) as Copied[];
    if (page.length === 0) return;
    for (const r of page) each(r);
    after = (page.at(-1) as Copied).seq;
  }
}

/** The months with a row in `mark < seq <= high`, read from the timestamps alone, never the rows. */
function monthsOf(db: Database, mark: number, high: number): Set<string> {
  const months = new Set<string>();
  let after = mark;
  for (;;) {
    const page = db
      .query(
        `SELECT seq, at FROM log WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ${BATCH}`,
      )
      .all(after, high) as { seq: number; at: string }[];
    if (page.length === 0) return months;
    for (const r of page) months.add(monthOf(r.at));
    after = (page.at(-1) as { seq: number }).seq;
  }
}

/**
 * Add to one month's file the rows of the range it lacks; returns how many
 * it added. The file is copied in chunks into a temporary beside it, the
 * rows read from the database a page at a time are added, and the
 * temporary is renamed into place once: a reader sees the old file or the
 * new one, and a failure removes the temporary.
 */
function copyMonth(
  db: Database,
  path: string,
  month: string,
  mark: number,
  high: number,
): number {
  const held = new Set<string>();
  eachLine(path, (text) => {
    const key = parseLine(text)?.key;
    if (key !== undefined) held.add(key);
  });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let fd: number | null = null;
  let created = false;
  let added = 0;
  try {
    const [year, number] = month.split("-").map(Number) as [number, number];
    const within = {
      from: Date.UTC(year, number - 1, 1),
      to: Date.UTC(year, number, 1),
    };
    eachRow(
      db,
      mark,
      high,
      (r) => {
        if (monthOf(r.at) !== month) return;
        if (fd === null) {
          fd = openSync(temporary, "wx", 0o600);
          created = true;
          // Refresh a result recorded after its ended row was exported.
          copyRevisions(db, path, fd, mark, high);
        }
        if (held.has(r.key)) return;
        writeAllSync(fd, `${r.row}\n`);
        held.add(r.key);
        added++;
      },
      within,
    );
    if (fd === null) return 0;
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
    created = false;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // closed already
      }
    }
    if (created) {
      try {
        unlinkSync(temporary);
      } catch {
        // already removed
      }
    }
    throw error;
  }
  return added;
}

/**
 * Copy the rows written since the last copy into their months' files, up
 * to the newest row there was when it began, each month's file written
 * once; returns how many lines it added. The database reads a page at a
 * time. Nothing happens before the database exists.
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
  const mark =
    (
      db.query("SELECT seq FROM log_export WHERE id = 1").get() as {
        seq: number;
      } | null
    )?.seq ?? 0;
  if (mark >= high) return 0;
  let added = 0;
  for (const month of monthsOf(db, mark, high))
    added += copyMonth(
      db,
      logFile(`${month}-01T00:00:00.000Z`, root),
      month,
      mark,
      high,
    );
  db.query(
    "INSERT INTO log_export (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq",
  ).run(high);
  return added;
}
