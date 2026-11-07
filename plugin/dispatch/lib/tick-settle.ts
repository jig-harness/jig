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
import { pruneLaunches } from "./launches.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { allRecords, type TickContext } from "./tick-context.ts";
import type { TickReceipt } from "../receipts.ts";
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
  // A repository another tick holds is that tick's to log, with its ledgers beside its records.
  const held = new Set((receipt.busy ?? []).map((b) => resolve(b.path)));
  const unlogged = await logEnded(
    records.filter(
      (r) => !read.has(r.record.repo) && !held.has(resolve(r.record.repoPath)),
    ),
    {
      all: records,
      drives: null,
      merged: async () => null,
      nowIso: new Date(context.nowMs).toISOString(),
    },
  );
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
