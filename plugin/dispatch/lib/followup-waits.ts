/**
 * A follow-up whose pass met a rate limit (the forge's or the tracker's)
 * records `waits --until <reset>` (`jig dispatch result`): a stop that clears
 * by waiting, not a question for a person. The steps a follow-up takes are
 * idempotent, so the run after the reset repeats them.
 *
 * 1. Its marker stays on the pull request while the wait lasts, so no host
 *    starts the follow-up before the reset; the pass's wrapper does not
 *    answer it (`routineEnd`), so another host reads no failure.
 * 2. Once the reset has passed, the tick with `--apply` deletes the marker
 *    (`releaseWaitMarkers`), and a later tick starts the follow-up again as
 *    a first run: no recovery tag, and nothing counted against the pull
 *    request's recovery budget.
 * 3. The waits in a row are counted from this host's launch records of the
 *    pull request's follow-ups, newest first, over those that recorded a
 *    result: at `WAITS_FOR_PERSON` the follow-up is a person's, notified as
 *    a failed follow-up that names the fault, its marker answered failed.
 *
 * The count reads the launch records alone: a wait lasts a day at most, and
 * a record is kept `receipts_days`.
 */
import { stateRoot } from "../receipts.ts";
import type { ReadRecord } from "./launches.ts";
import type { SharedContext } from "./shared-launches.ts";
import { stateDb } from "./state.ts";
import type { MarkedPr } from "./types.ts";

/** The waits in a row at which a follow-up is a person's. */
export const WAITS_FOR_PERSON = 3;

/** A follow-up's waits in a row, newest first. */
export interface WaitStreak {
  /** The launch record of the newest wait. */
  record: string;
  /** How many results in a row were waits. */
  count: number;
  /** When the newest wait ends (ISO 8601). */
  until: string;
}

/** One attempt as the count reads it. */
interface Attempt {
  id: string;
  createdAt: string;
  result: string | null;
  until: string | null;
}

/** The waits in a row at the newest end of `attempts` that recorded a result; `null` when the newest result is not one. */
function streakOf(attempts: Attempt[]): WaitStreak | null {
  const answered = attempts
    .filter((a) => a.result !== null)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  let count = 0;
  for (const a of answered) {
    if (a.result !== "waits" || a.until === null) break;
    count += 1;
  }
  const newest = answered[0];
  if (count === 0 || newest === undefined || newest.until === null) return null;
  return { record: newest.id, count, until: newest.until };
}

/** The waits in a row of this host's follow-ups of `pr` among `records`; `null` when the newest result is not a wait. */
export function waitStreak(
  records: readonly ReadRecord[],
  repo: string,
  pr: number,
): WaitStreak | null {
  return streakOf(
    records
      .filter(
        (r) =>
          r.record.action === "followup" &&
          r.record.repo === repo &&
          r.record.pr === pr,
      )
      .map((r) => ({
        id: r.record.id,
        createdAt: r.record.createdAt,
        result: r.result,
        until: r.waitsUntil ?? null,
      })),
  );
}

/** The waits in a row up to and including `r`, read from the state database when only the record is at hand. */
function storedStreak(r: ReadRecord, root: string): WaitStreak | null {
  const rows = stateDb(root)
    .query(
      "SELECT id, created_at, result, result_until FROM launches WHERE action = 'followup' AND repo = ? AND pr = ? AND created_at <= ?",
    )
    .all(r.record.repo, r.record.pr, r.record.createdAt) as {
    id: string;
    created_at: string;
    result: string | null;
    result_until: string | null;
  }[];
  const attempts: Attempt[] = rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    result:
      row.result === "failed" && row.result_until !== null
        ? "waits"
        : row.result,
    until: row.result_until,
  }));
  // The record itself, as read, stands over its row.
  const own = attempts.findIndex((a) => a.id === r.record.id);
  const self: Attempt = {
    id: r.record.id,
    createdAt: r.record.createdAt,
    result: r.result,
    until: r.waitsUntil ?? null,
  };
  if (own === -1) attempts.push(self);
  else attempts[own] = self;
  const streak = streakOf(attempts);
  return streak?.record === r.record.id ? streak : null;
}

/**
 * Whether an ended follow-up record waits out a rate limit, so its marker is
 * released after the reset rather than answered: it recorded `waits`, and
 * fewer than `WAITS_FOR_PERSON` results in a row were waits.
 */
export function waitEnd(r: ReadRecord, root = stateRoot()): boolean {
  if (r.record.action !== "followup" || r.record.pr === null) return false;
  if (r.result !== "waits" || r.waitsUntil === undefined) return false;
  if (r.state.kind !== "ended" && r.state.kind !== "died") return false;
  const streak = storedStreak(r, root);
  return streak !== null && streak.count < WAITS_FOR_PERSON;
}

/**
 * The wait of the follow-up whose launch record `found` is, while it is the
 * tick's to wait out; `null` when `found` did not end on a wait, or its
 * waits in a row have reached `WAITS_FOR_PERSON`.
 */
export function owedWait(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  const streak = endedOnWait(found, records);
  return streak !== null && streak.count < WAITS_FOR_PERSON ? streak : null;
}

/** The waits in a row that made the follow-up of `found` a person's; `null` when they have not. */
export function waitsSpent(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  const streak = endedOnWait(found, records);
  return streak !== null && streak.count >= WAITS_FOR_PERSON ? streak : null;
}

/** The waits in a row that end with `found`; `null` when `found` did not end on a wait. */
function endedOnWait(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  if (found === undefined || found.record.pr === null) return null;
  if (found.result !== "waits") return null;
  const streak = waitStreak(records, found.record.repo, found.record.pr);
  return streak?.record === found.record.id ? streak : null;
}

/** Whether a wait has ended at `nowMs`; a time that does not read has. */
export function waitOver(streak: WaitStreak, nowMs: number): boolean {
  const at = Date.parse(streak.until);
  return !Number.isFinite(at) || at <= nowMs;
}

/** What a follow-up that waits for its rate limit's reset met, in words. */
export function waitWords(streak: WaitStreak): string {
  return `met a rate limit and waits until ${streak.until} (${streak.count} in a row; at ${WAITS_FOR_PERSON} a person settles it)`;
}

/** Why a follow-up is a person's after `WAITS_FOR_PERSON` waits in a row, naming the fault. */
export function spentWords(id: string, streak: WaitStreak): string {
  return `its pass under launch record ${id} met the rate limit ${streak.count} times in a row, the last until ${streak.until}`;
}

/** The trusted markers of this host's on a merged pull request that name `record`. */
function ownMarkers(pr: MarkedPr, host: string, record: string): number[] {
  if ("unreadable" in pr.markers) return [];
  return pr.markers
    .filter(
      (m) =>
        m.trusted &&
        m.run.kind === "tick" &&
        m.run.record === record &&
        (m.run.host === undefined || m.run.host === host),
    )
    .map((m) => m.id);
}

/**
 * With `--apply`: delete the marker of each follow-up whose wait has ended,
 * so a later tick starts it again; only on the pull requests in `scope`
 * when one is given. Returns why a marker could not be deleted, which the
 * next tick deletes.
 */
export async function releaseWaitMarkers(
  ctx: Pick<SharedContext, "records" | "host" | "slug">,
  merged: readonly MarkedPr[],
  records: readonly ReadRecord[],
  nowMs: number,
  scope?: ReadonlySet<number>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const pr of merged) {
    if (scope !== undefined && !scope.has(pr.number)) continue;
    const streak = waitEnded(records, ctx.slug, pr.number, nowMs);
    if (streak === null) continue;
    failures.push(
      ...(await releaseOwnMarkers(
        ctx,
        pr,
        streak.record,
        "waited out a rate limit",
      )),
    );
  }
  return failures;
}

/** The wait of the follow-up of `pr` whose reset has passed and whose pass has ended; `null` for any other. */
function waitEnded(
  records: readonly ReadRecord[],
  slug: string,
  pr: number,
  nowMs: number,
): WaitStreak | null {
  const streak = waitStreak(records, slug, pr);
  if (streak === null || streak.count >= WAITS_FOR_PERSON) return null;
  if (!waitOver(streak, nowMs)) return null;
  const found = records.find((r) => r.record.id === streak.record);
  const ended = found?.state.kind === "ended" || found?.state.kind === "died";
  return ended ? streak : null;
}

/**
 * Delete this host's trusted markers on `pr` that name `record`, the
 * follow-up that `what`; why each one that could not be deleted was not.
 */
export async function releaseOwnMarkers(
  ctx: Pick<SharedContext, "records" | "host" | "slug">,
  pr: MarkedPr,
  record: string,
  what: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const id of ownMarkers(pr, ctx.host, record)) {
    const released = await ctx.records.release(
      { repo: ctx.slug, pr: pr.number },
      id,
    );
    if (!released.ok && released.failure.code !== "not-found")
      failures.push(
        `PR #${pr.number}: the marker ${id} of the follow-up that ${what} could not be released: ${released.failure.reason}`,
      );
  }
  return failures;
}
