/**
 * The page size each repository's paged read last answered at, in the state
 * database's `read_pages` table (keyed by the repository's checkout and the
 * read). A read the forge times out at its full page shrinks it
 * (`shared/outbound/paging.ts`); keeping the size that answered lets the next
 * tick begin there, instead of timing out at full size once every tick
 * before it shrinks.
 *
 * A kept size stands for `PAGE_KEPT_MS` from when it was found, then the
 * read begins at its full page again, so a repository whose pull requests
 * grew lighter is read in fewer pages once more. A read that answers at its
 * full page removes the row.
 *
 * Keeping these is an optimization, never a record anything else depends
 * on: a row that cannot be read or written leaves the read at its full page.
 */
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";
import { stateDb } from "./state.ts";

/** How long a kept page size stands: a day. */
export const PAGE_KEPT_MS = 24 * 60 * 60 * 1000;

/** The paged reads whose size is kept. */
export type PagedReadName = "pull-requests";

/** The kept size and when it was found; `null` when none stands. */
function keptRow(
  repo: string,
  read: PagedReadName,
  nowMs: number,
  root: string,
): { size: number; atMs: number } | null {
  const row = stateDb(root)
    .query("SELECT size, at_ms FROM read_pages WHERE repo = ? AND read = ?")
    .get(repo, read) as { size: number; at_ms: number } | null;
  if (row === null || !Number.isSafeInteger(row.size) || row.size < 1)
    return null;
  const age = nowMs - row.at_ms;
  return age >= 0 && age < PAGE_KEPT_MS
    ? { size: row.size, atMs: row.at_ms }
    : null;
}

/** The page `read` of `repo` begins at: the kept size where one stands under `full`, `full` otherwise. */
export function keptPage(
  repo: string,
  read: PagedReadName,
  full: number,
  nowMs: number,
  root = stateRoot(),
): number {
  try {
    const kept = keptRow(repo, read, nowMs, root);
    return kept === null ? full : Math.min(kept.size, full);
  } catch (error) {
    swallow(error, "a kept page size that does not read leaves the full page");
    return full;
  }
}

/**
 * Keep `size` as the page `read` of `repo` answered at: removed when it is
 * the full page, kept from now when it differs from the size that stands or
 * none stands, and left with its time when it is the same.
 */
export function keepPage(
  repo: string,
  read: PagedReadName,
  size: number,
  full: number,
  nowMs: number,
  root = stateRoot(),
): void {
  try {
    const db = stateDb(root);
    if (size >= full) {
      db.query("DELETE FROM read_pages WHERE repo = ? AND read = ?").run(
        repo,
        read,
      );
      return;
    }
    if (keptRow(repo, read, nowMs, root)?.size === size) return;
    db.query(
      `INSERT INTO read_pages (repo, read, size, at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo, read) DO UPDATE SET size = excluded.size, at_ms = excluded.at_ms`,
    ).run(repo, read, size, nowMs);
  } catch (error) {
    swallow(error, "a page size that cannot be kept is found again");
  }
}
