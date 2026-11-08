/**
 * The outcome log's part of a tick: each launch record that ended gets its
 * ended row in the log once, in the transaction that writes its end
 * (log-ended.ts). A repository's turn logs its own records with its ledgers
 * beside them (`logRepo`); the close of the tick logs the records of every
 * repository the tick did not read, without them, and then prunes the
 * records whose rows are in the log (`settleOutcomes`).
 */
import { resolve } from "node:path";
import { mergedNotClosed } from "./forge.ts";
import { logEnded } from "./log-ended.ts";
import { hasEnded } from "./log.ts";
import { pruneLaunches, type ReadRecord } from "./launches.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { allRecords, type TickContext } from "./tick-context.ts";
import {
  type Lock,
  type TickReceipt,
  takeObserveLock,
  takeRepositoryLock,
} from "../receipts.ts";
import type { RepoReport } from "./types.ts";

/** The ended rows of this repository's records that ended, read beside its ledgers. */
export async function logRepo(
  context: TickContext,
  slug: string,
  report: RepoReport,
  drives: Awaited<ReturnType<typeof readDrives>>,
): Promise<void> {
  const all = allRecords(context);
  const failed = await logEnded(
    all.filter((r) => r.record.repo === slug),
    {
      all,
      drives,
      merged: (pr) => mergedNotClosed(slug, pr).catch(() => null),
      nowIso: new Date(context.nowMs).toISOString(),
    },
  );
  for (const reason of failed)
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
}

/**
 * The records of `records` whose repository no tick is observing, with their
 * repositories' observe locks held until `release`: a record of one that is
 * being observed is left to that observation.
 */
function claimUnobserved(records: ReadRecord[]): {
  records: ReadRecord[];
  release: () => void;
} {
  const taken: { release: () => void }[] = [];
  const claimed = new Map<string, boolean>();
  const claim = (key: string, take: () => Lock): boolean => {
    const known = claimed.get(key);
    if (known !== undefined) return known;
    const lock = take();
    const free = !("heldBy" in lock);
    if (!("heldBy" in lock)) taken.push(lock);
    claimed.set(key, free);
    return free;
  };
  let free: ReadRecord[];
  try {
    free = records.filter((r) => {
      // Both locks are asked for, so a record that is busy by one holds nothing back from the next.
      const byPath = claim(`path:${resolve(r.record.repoPath)}`, () =>
        takeObserveLock(r.record.repoPath),
      );
      const bySlug = claim(`slug:${r.record.repo}`, () =>
        takeRepositoryLock(r.record.repo),
      );
      return byPath && bySlug;
    });
  } catch (error) {
    // A later acquisition failed: no caller has the release, so the earlier locks go now.
    for (const lock of taken) lock.release();
    throw error;
  }
  return {
    records: free,
    release: () => {
      for (const lock of taken) lock.release();
    },
  };
}

/**
 * Give each record of a repository this tick did not read its ended row
 * before the record can expire, without a ledger to count rounds by, and
 * prune the records whose rows are in the log; whether the tick failed.
 */
export async function settleOutcomes(
  receipt: TickReceipt,
  context: TickContext,
  days: number | undefined,
  keepFollowups = false,
): Promise<boolean> {
  const records = allRecords(context);
  // A repository this tick read gave its records their rows in `logRepo`,
  // with its ledgers beside them; the rest get the row without them.
  const read = new Set(
    receipt.repos.filter((r) => r.refused === null).map((r) => r.slug),
  );
  // A repository another tick is observing is that tick's to log, with its ledgers beside its records.
  const held = new Set((receipt.busy ?? []).map((b) => resolve(b.path)));
  const unread = records.filter(
    (r) => !read.has(r.record.repo) && !held.has(resolve(r.record.repoPath)),
  );
  // Whoever observes one, a repository this tick was not asked for included, holds its locks.
  const exclusive = claimUnobserved(unread);
  let unlogged: Awaited<ReturnType<typeof logEnded>>;
  try {
    unlogged = await logEnded(exclusive.records, {
      all: records,
      drives: null,
      merged: async () => null,
      nowIso: new Date(context.nowMs).toISOString(),
    });
  } finally {
    exclusive.release();
  }
  if (unlogged.length > 0) receipt.unloggedOutcomes = unlogged;
  // A record that ended without its outcome row in the log is kept: its end is written with the row.
  pruneLaunches(
    records.filter(
      (r) =>
        (!hasEnded(r) || r.record.endedAt !== undefined) &&
        // A follow-up whose outcome could not be written is kept until it is.
        !(keepFollowups && r.record.action === "followup"),
    ),
    context.nowMs,
    days ?? 30,
  );
  return (
    unlogged.length > 0 ||
    receipt.repos.some(
      (r) =>
        r.refused !== null ||
        r.records.some((x) => !x.ok) ||
        r.unplaced.some((u) => u.target === "the outcome log"),
    )
  );
}
