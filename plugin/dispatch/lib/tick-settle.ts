/**
 * The outcome log's part of a tick: each launch record that ended gets its
 * ended row in the log once, in the transaction that writes its end
 * (log-ended.ts). A repository's turn logs its own records with its ledgers
 * beside them (`logRepo`); the close of the tick logs the records of every
 * repository the tick did not read, without them, and then prunes the
 * records whose rows are in the log (`settleOutcomes`).
 *
 * Once the tick's exit is decided, the failure ledger (failures.ts) counts
 * what failed in a row (`settleFailures`): each repository this tick read
 * whose turn was refused, stopped by a defect or found a record that did not
 * read, and the tick itself when it exits 1. A repository read whole, and a
 * tick that exits 0, clears its row; a tick that exits 0 also quiets the
 * wake-up rows of the other repositories it read whole. Only a tick with `--apply` and a
 * machine file counts: a person's report changes nothing there.
 */
import { resolve } from "node:path";
import { swallow } from "../../shared/errors.ts";
import {
  clearFailure,
  entryOf,
  escalates,
  isActionKind,
  quietFailure,
  readFailures,
  recordFailure,
} from "./failures.ts";
import { failureSettings, type MachineConfig } from "./machine-config.ts";
import { failureText } from "./text.ts";
import { hostNoticeKeys } from "./failure-notices.ts";
import { stateDb } from "./state.ts";
import { mergedNotClosed } from "./forge.ts";
import { logEnded } from "./log-ended.ts";
import { aboutTargets } from "./line.ts";
import { hasEnded } from "./log.ts";
import { pruneLaunches, type ReadRecord } from "./launches.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { allRecords, type TickContext } from "./tick-context.ts";
import {
  type Lock,
  stateRoot,
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
      merged: (pr) =>
        // An unread merge state is null, which leaves the record's ending unclassified.
        mergedNotClosed(slug, pr).then(
          (read) => (read.ok ? read.value : null),
          (error: unknown) => {
            swallow(
              error,
              "an unread merge state leaves the ending unclassified",
            );
            return null;
          },
        ),
      nowIso: new Date(context.nowMs).toISOString(),
      about: aboutTargets(
        slug,
        context.lineInputs.get(report.path),
        report.unplaced,
      ),
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
    context.apply?.root,
  );
  return (
    unlogged.length > 0 ||
    receipt.repos.some(
      (r) =>
        r.refused !== null ||
        (r.stageDefects?.length ?? 0) > 0 ||
        r.records.some((x) => !x.ok) ||
        // An individual claim, ledger or marker that did not read fails the turn as repoFailure says.
        r.unplaced.some(
          (u) => u.readFailed === true || u.target === "the outcome log",
        ),
    )
  );
}

/** Why a repository's turn failed this tick; `null` when it was read whole. */
function repoFailure(report: RepoReport): string | null {
  if (report.refused !== null) return report.refused;
  const defect = report.stageDefects?.[0];
  if (defect !== undefined) return defect.reason;
  const unread = report.records.find((r) => !r.ok);
  if (unread !== undefined)
    return `the ${unread.record} record (${unread.source}) did not read: ${unread.detail}`;
  // An individual comment listing or ledger that failed leaves the aggregate forge record ok.
  const failed = report.unplaced.find((u) => u.readFailed === true);
  return failed === undefined
    ? null
    : `${failed.target} did not read: ${failed.reason}`;
}

/** Why the tick exits 1, in one sentence. */
function tickFailure(receipt: TickReceipt): string {
  if (receipt.defect !== undefined) return receipt.defect.reason;
  if (receipt.applyWithheld !== undefined)
    return `--apply was withheld: ${receipt.applyWithheld}`;
  const failing = receipt.repos.flatMap((r) => {
    const why = repoFailure(r);
    return why === null ? [] : [`${r.slug ?? r.path}: ${why}`];
  });
  if (failing.length > 0)
    return `${failing.length === 1 ? "a repository's turn failed" : `${failing.length} repositories' turns failed`}, ${failing[0]}${failing.length > 1 ? ` (and ${failing.length - 1} more)` : ""}`;
  const unlogged =
    receipt.unloggedOutcomes?.[0] ??
    receipt.repos
      .flatMap((r) => r.unplaced)
      .find((u) => u.target === "the outcome log")?.reason;
  if (unlogged !== undefined)
    return `the outcome log was not written: ${unlogged}`;
  if (receipt.logCopyFailed !== undefined)
    return `the outcome log's copy was not written: ${receipt.logCopyFailed}`;
  if (receipt.lineFailed !== undefined)
    return `the dashboard line was not written: ${receipt.lineFailed}`;
  return "the tick exited 1 with no cause on its receipt";
}

/**
 * The failure ledger's key of a tick's scope: a tick of one repository (a
 * wake-up) has its own, so the sweeps that succeed between failing wake-ups
 * do not clear theirs; every tick of several shares the sweep's.
 */
function tickScope(
  receipt: TickReceipt,
  repos: readonly string[],
): { key: string; target: string } {
  const paths = [...new Set(repos.map((p) => resolve(p)))];
  if (paths.length !== 1)
    return { key: "ticks sweep", target: "ticks of several repositories" };
  const path = paths[0] as string;
  const slug = receipt.repos.find((r) => resolve(r.path) === path)?.slug;
  return { key: `ticks ${path}`, target: `ticks of ${slug ?? path}` };
}

/**
 * The rows of repositories the machine file no longer lists, and of their
 * wake-ups' ticks, go, and the sweep's once a single repository is listed; so do the action rows of a repository no listed path
 * names, when this tick read every listed path and so knows each one's slug.
 */
function dropUnlisted(
  machine: MachineConfig,
  receipt: TickReceipt,
  root: string,
): void {
  const listed = new Set(machine.repositories.map((r) => resolve(r.path)));
  const slugs = new Set<string>();
  let known = true;
  for (const path of listed) {
    const slug = receipt.repos.find((r) => resolve(r.path) === path)?.slug;
    if (slug == null) known = false;
    else slugs.add(slug);
  }
  for (const row of readFailures(undefined, root)) {
    const gone =
      (row.kind === "repository" && !listed.has(resolve(row.repo))) ||
      (row.kind === "tick" &&
        (row.key === "ticks sweep"
          ? // With one repository listed, every tick is that repository's own scope.
            listed.size === 1
          : !listed.has(resolve(row.key.replace(/^ticks /, ""))))) ||
      (known && isActionKind(row.kind) && !slugs.has(row.repo));
    if (gone) clearFailure(row.repo, row.key, root);
  }
}

/**
 * Count this tick's failures of each repository it read and of the tick
 * itself, with `--apply` and a machine file, once its exit is decided; then
 * put the ledger's rows that back off or are notified on the receipt. A
 * write the database refuses is said on the receipt and leaves the exit as
 * it is.
 */
export function settleFailures(
  receipt: TickReceipt,
  context: TickContext,
): void {
  const { options } = context;
  const machine = options.machine;
  if (options.apply !== true || machine == null) return;
  if (context.failuresSettled === true) return;
  context.failuresSettled = true;
  const root = context.apply?.root ?? stateRoot();
  const settings = failureSettings(machine);
  const nowMs = Date.now();
  try {
    for (const r of receipt.repos) {
      const path = resolve(r.path);
      const why = repoFailure(r);
      if (why === null) clearFailure(path, "repository", root);
      else
        recordFailure(
          {
            repo: path,
            key: "repository",
            kind: "repository",
            target: r.slug ?? r.path,
          },
          why,
          nowMs,
          settings,
          root,
        );
    }
    const pending = settleTick(receipt, context, root, nowMs, false);
    dropUnlisted(machine, receipt, root);
    reportFailures(receipt, root, settings, nowMs, pending);
  } catch (error) {
    receipt.failuresUnwritten = failureText(error);
  }
}

/**
 * The tick's own row for the exit as it stands: counted at 1. At 0 it is
 * cleared only once `final`: before the dashboard's line is written the
 * exit may still become 1, and a streak cleared and begun again would hide
 * a failure that never stops. The key of the row left pending, or `null`.
 */
function settleTick(
  receipt: TickReceipt,
  context: TickContext,
  root: string,
  nowMs: number,
  final: boolean,
): string | null {
  const machine = context.options.machine as MachineConfig;
  const scope = tickScope(receipt, context.options.repos);
  if (receipt.exitStatus === 0 && !final) {
    delete context.tickSettledExit;
    return scope.key;
  }
  context.tickSettledExit = receipt.exitStatus;
  if (receipt.exitStatus === 0) {
    clearFailure("", scope.key, root);
    quietWakeUps(receipt, scope.key, root, nowMs);
  } else if (receipt.exitStatus === 1)
    recordFailure(
      { repo: "", ...scope, kind: "tick" },
      tickFailure(receipt),
      nowMs,
      failureSettings(machine),
      root,
    );
  return null;
}

/**
 * A tick that exits 0 quiets the wake-up rows of the other repositories it
 * read whose turn succeeded: their cause is gone from every step they share
 * with it, but only a wake-up of their own clears their count, so a
 * wake-up that keeps failing between succeeding sweeps is still told.
 */
function quietWakeUps(
  receipt: TickReceipt,
  own: string,
  root: string,
  nowMs: number,
): void {
  const at = new Date(nowMs).toISOString();
  const rows = readFailures(undefined, root);
  const release = stateDb(root).query("DELETE FROM notices WHERE key = ?");
  for (const r of receipt.repos) {
    const key = `ticks ${resolve(r.path)}`;
    if (key === own || repoFailure(r) !== null) continue;
    quietFailure("", key, at, root);
    // The notice was told at whichever repository was its destination: its record goes with the quiet, or a failure after it would still be suppressed there.
    for (const row of rows.filter((w) => w.repo === "" && w.key === key))
      for (const notice of hostNoticeKeys([row])) release.run(notice);
  }
}

/** Put the ledger's rows that back off or are notified on the receipt. */
function reportFailures(
  receipt: TickReceipt,
  root: string,
  settings: ReturnType<typeof failureSettings>,
  nowMs: number,
  pendingTick: string | null = null,
): void {
  // The row of a tick that exits 0 so far goes at the end of the close, if the exit holds.
  const rows = readFailures(undefined, root).filter(
    (r) => !(r.kind === "tick" && r.key === pendingTick),
  );
  const backingOff = rows.filter(
    (r) => isActionKind(r.kind) && r.nextAtMs > nowMs,
  );
  const escalated = rows.filter((r) => escalates(r, settings));
  delete receipt.failures;
  if (backingOff.length > 0 || escalated.length > 0)
    receipt.failures = {
      backingOff: backingOff.map(entryOf),
      escalated: escalated.map(entryOf),
    };
}

/**
 * Settle the tick's row for the exit the receipt ends with: `settleFailures`
 * counts a tick that exits 1 and leaves a tick that exits 0 to this, which
 * clears its row only once the dashboard's line or its history has not set
 * the exit to 1. The repositories' rows are
 * counted once, by `settleFailures`.
 */
export function finalizeTickFailure(
  receipt: TickReceipt,
  context: TickContext,
): void {
  const { options } = context;
  if (options.apply !== true || options.machine == null) return;
  if (context.failuresSettled !== true) return;
  if (context.tickSettledExit === receipt.exitStatus) return;
  const root = context.apply?.root ?? stateRoot();
  const nowMs = Date.now();
  try {
    settleTick(receipt, context, root, nowMs, true);
    reportFailures(receipt, root, failureSettings(options.machine), nowMs);
  } catch (error) {
    receipt.failuresUnwritten = failureText(error);
  }
}
