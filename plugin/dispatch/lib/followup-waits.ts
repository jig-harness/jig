/**
 * A follow-up whose pass met a rate limit (the forge's or the tracker's)
 * records `waits --until <reset>` (`jig dispatch result`): a stop that clears
 * by waiting, not a question for a person. One whose pass found an arm still
 * pending (a release run still going, a deploy not started) records
 * `waits --until <time> --reason pending --arm <name>` the same way. The
 * steps a follow-up takes are idempotent, so the run after the wait repeats
 * them.
 *
 * 1. Its marker stays on the pull request while the wait lasts, so no host
 *    starts the follow-up before its time; the pass's wrapper does not
 *    answer it (`routineEnd`), so another host reads no failure.
 * 2. Once the time has passed, the tick with `--apply` deletes the marker
 *    (`releaseWaitMarkers`), and a later tick starts the follow-up again as
 *    a first run: no recovery tag, and nothing counted against the pull
 *    request's recovery budget.
 * 3. The waits in a row are read from this host's launch records of the
 *    pull request's follow-ups, oldest first, over those that recorded a
 *    result or stopped on a rate-limit question. Each kind has its own
 *    limit, past which the follow-up is a person's, notified as a failed
 *    follow-up that names the fault, its marker answered failed:
 *    - a rate limit's: the `WAITS_FOR_PERSON`th rate-limit wait of the run;
 *    - a pending arm's: a pending wait launched once the repository's
 *      `dispatch.followup_within` (kept on the launch record) has passed
 *      since the launch of the window's first pending wait, the arm still
 *      pending. A pending wait neither counts toward the rate limit's
 *      limit nor starts it again: it is not a rate limit, and the pass that
 *      recorded it met none on the way.
 *
 *      A window starts again when a pass names other release tags than the
 *      ones its window started on (a newer release replaced the one waited
 *      for); an arm that names none never starts one again. However often
 *      it starts again, a run of pending waits is a person's once
 *      `WINDOWS_FOR_PERSON` windows have passed since its first.
 *
 *      Before a wait past its window goes to a person, the tick reads the
 *      release tags its arm names again (`armTags`, `arm-reread.ts`): when
 *      every one now exists, the arm has settled, so the tick releases the
 *      marker instead and the follow-up runs once more, as a new run. An
 *      arm a run of the pull request already went past its window on is
 *      not read again, so a pass that keeps finding the same arm pending
 *      reaches a person; nor is an arm that names no tag.
 *
 * A pass that stopped on a question instead, whose question names a rate
 * limit and carries no routine class's tag (`routine-questions.ts`), waits
 * too: a pass from before passes recorded `waits`, or one that asked rather
 * than recorded it. It waits until an hour after it ended, the reset its
 * prompt names when the forge names none (`questionWait`).
 *
 * A person starts the run again: an attempt launched after the follow-up
 * went to a person on its waits, which only a person's deleting the marker
 * lets start, or one that carries a person's answer (their "Run it again"),
 * is the first of a new run.
 *
 * The run reads the launch records alone: a wait lasts a day at most, and
 * a record is kept `receipts_days`. A pending run's origin is its first
 * record, so a host whose `receipts_days` is shorter than its
 * `dispatch.followup_within` keeps no origin long enough to spend it.
 */
import { stateRoot } from "../receipts.ts";
import { type ReadRecord, readEnded, readRecord } from "./launches.ts";
import { routineClassOf } from "./routine-questions.ts";
import { unwrittenResult } from "./session-startup.ts";
import { questionOf } from "./session.ts";
import type { SharedContext } from "./shared-launches.ts";
import { stateDb } from "./state.ts";
import type { MarkedPr } from "./types.ts";
import {
  armWords,
  RATE_LIMIT_WAIT,
  readWaitFor,
  type WaitFor,
} from "./wait-for.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import { releaseTag } from "../../shared/records/release-tags.ts";

/** The rate-limit waits in a row at which a follow-up is a person's. */
const WAITS_FOR_PERSON = 3;

/** The windows of `dispatch.followup_within` after a run's first pending wait at which it is a person's, however often a newer arm started its window again. */
const WINDOWS_FOR_PERSON = 3;

/** `dispatch.followup_within`'s default, for a record written before it kept the repository's. */
const DEFAULT_WITHIN_MS = 3_600_000;

/** A follow-up's waits in a row, up to the newest. */
export interface WaitStreak {
  /** The launch record of the newest wait. */
  record: string;
  /** How many of the waits in a row were a rate limit's. */
  count: number;
  /** When the newest wait ends (ISO 8601). */
  until: string;
  /** What the newest wait waits for. */
  wait: WaitFor;
  /** When the run's first pending wait was launched; `null` when none of its waits was a pending one. */
  pendingSince: string | null;
  /** The longest the run's pending waits may last (`dispatch.followup_within`, from the newest record). */
  withinMs: number;
  /** The newest wait went past its kind's limit: the follow-up is a person's. */
  spent: boolean;
  /** For a pending wait past its window on an arm no earlier run went past its window on: the release tags it names, which the tick reads again before the follow-up goes to a person; empty otherwise. */
  reread: string[];
}

/** Characters that end a word in an arm's text: a release tag holds none. */
const WORD_END = /[\s,;:()[\]{}<>"'`]+/;

/** The release tags an arm's words name, as a release tag is spelled (`releaseTag`), in order of first mention. */
export function armTags(arm: string | undefined): string[] {
  if (arm === undefined) return [];
  const words = arm
    .split(WORD_END)
    .map((w) => w.replace(/[.…]+$/, ""))
    .filter((w) => releaseTag(w));
  return [...new Set(words)];
}

/** What an arm is, to tell a newer one from the one a window started on: the release tags it names; `null` when it names none. */
function armKey(wait: WaitFor): string | null {
  const tags = armTags(wait.arm);
  return tags.length > 0 ? [...tags].sort().join(" ") : null;
}

/** How long a pass that stopped on a rate-limit question waits after it ended: the reset its prompt names when the forge names none. */
const QUESTION_WAIT_MS = 3_600_000;

/** A question that names a rate limit, in the words the follow-up's prompt names the refusals it records `waits` for. */
const RATE_LIMIT = /\brate[- ]?limit|\bHTTP 429\b/i;

/**
 * The time a follow-up's ended pass waits until: the time its `waits`
 * result names, or for a pass that stopped on a question naming only a rate
 * limit, an hour after it ended; `null` when it does not wait.
 */
export function waitUntil(r: ReadRecord): string | null {
  if (r.result === "waits") return r.waitsUntil ?? null;
  return questionWait(r);
}

/**
 * The reset of a pass that stopped on a rate-limit question: its question,
 * as its session's last output or its closing report states it, names a
 * rate limit and carries no routine class's tag; `null` for any other, and
 * for one whose result the host could not write, whose question is the
 * host's, and for a pass that parked on a decision it framed, which a
 * person answers however it words the question.
 */
function questionWait(r: ReadRecord): string | null {
  if (
    r.result === "done" ||
    r.result === "parked" ||
    r.state.kind !== "ended" ||
    unwrittenResult(r)
  )
    return null;
  const question = questionOf(r.state) ?? r.report?.report.question ?? null;
  if (question === null || !RATE_LIMIT.test(question)) return null;
  if (routineClassOf(question) !== null) return null;
  const ended = parseMs(r.state.exit.at);
  return Number.isFinite(ended) ? isoFromMs(ended + QUESTION_WAIT_MS) : null;
}

/** One attempt as the run reads it. */
interface Attempt {
  id: string;
  createdAt: string;
  /** Whether it recorded a result, a wait or another. */
  answered: boolean;
  /** When its wait ends; `null` when it does not wait. */
  until: string | null;
  /** What it waits for; a rate limit's for a question that names one. */
  wait: WaitFor;
  /** The repository's `dispatch.followup_within` its record kept. */
  withinMs: number;
  /** It carries a person's answer: a person started it. */
  answeredByPerson: boolean;
}

/** An ended follow-up's attempt, as the run reads it. */
function attemptOf(r: ReadRecord): Attempt {
  const until = waitUntil(r);
  return {
    id: r.record.id,
    createdAt: r.record.createdAt,
    answered: r.result !== null || until !== null,
    until,
    wait:
      r.result === "waits" ? (r.waitsFor ?? RATE_LIMIT_WAIT) : RATE_LIMIT_WAIT,
    withinMs: r.record.followupWithinMs ?? DEFAULT_WITHIN_MS,
    answeredByPerson: r.record.answered !== undefined,
  };
}

/** The run of waits so far, as `streakOf` folds it. */
interface Run {
  count: number;
  /** When the current window of pending waits began. */
  pendingSince: string | null;
  /** When the run's first pending wait was launched, which no newer arm moves. */
  firstPending: string | null;
  /** The arm the current window started on (`armKey`). */
  arm: string | null;
  spent: boolean;
  /** The run was spent by a pending wait, past its window or the run's bound. */
  pendingSpent: boolean;
  reread: string[];
  /** The arm of the newest pass past its window, whether or not a re-read was allowed on it. */
  rereadArm: string | null;
  /** The arms earlier runs of the pull request went past their window on, which are never read again. */
  spentArms: ReadonlySet<string>;
}

const EMPTY: Run = {
  count: 0,
  pendingSince: null,
  firstPending: null,
  arm: null,
  spent: false,
  pendingSpent: false,
  reread: [],
  rereadArm: null,
  spentArms: new Set(),
};

/** A new run after `run`, keeping the arms runs went past their window on. */
function restart(run: Run): Run {
  const spentArms = new Set(run.spentArms);
  if (run.pendingSpent) {
    if (run.arm !== null) spentArms.add(run.arm);
    if (run.rereadArm !== null) spentArms.add(run.rereadArm);
  }
  return { ...EMPTY, spentArms };
}

/** An arm that names a release tag the window's arm does not: one that only drops tags is the same window, which a settled tag does not restart. */
function newerArm(window: string | null, arm: string | null): boolean {
  if (arm === null || window === null) return false;
  const known = new Set(window.split(" "));
  return arm.split(" ").some((t) => !known.has(t));
}

/** Whether the window's arm, and the pass's own when it names one, went past no earlier window. */
function unspentArm(
  spent: ReadonlySet<string>,
  windowArm: string | null,
  arm: string | null,
): boolean {
  return (
    windowArm !== null &&
    !spent.has(windowArm) &&
    (arm === null || !spent.has(arm))
  );
}

/** The pending run after `a`, a pending wait, from `from`. */
function nextPending(from: Run, a: Attempt): Run {
  const arm = armKey(a.wait);
  const fresh = from.pendingSince === null || newerArm(from.arm, arm);
  const pendingSince = fresh ? a.createdAt : (from.pendingSince as string);
  const firstPending = from.firstPending ?? a.createdAt;
  const at = parseMs(a.createdAt);
  const waited = at - parseMs(pendingSince);
  const overall = at - parseMs(firstPending);
  const pastWindow = Number.isFinite(waited) && waited >= a.withinMs;
  const pastRun =
    Number.isFinite(overall) && overall >= WINDOWS_FOR_PERSON * a.withinMs;
  // A window that began on an untagged pass takes the first tag a later pass names.
  const windowArm = fresh ? arm : (from.arm ?? arm);
  const readable =
    pastWindow && !pastRun && unspentArm(from.spentArms, windowArm, arm);
  return {
    ...from,
    pendingSince,
    firstPending,
    arm: windowArm,
    spent: pastWindow || pastRun,
    pendingSpent: pastWindow || pastRun,
    reread: readable ? armTags(a.wait.arm) : [],
    rereadArm: pastWindow || pastRun ? arm : from.rereadArm,
  };
}

/** The run after `a`, a wait: counted by its kind, and spent once past its kind's limit. */
function nextRun(run: Run, a: Attempt): Run {
  // A run a person settled, the tick ran once more on its arm's tags, or a
  // person's answer started again, starts over.
  const from = run.spent || a.answeredByPerson ? restart(run) : run;
  if (a.wait.reason === "pending") return nextPending(from, a);
  const count = from.count + 1;
  return {
    ...from,
    count,
    spent: count >= WAITS_FOR_PERSON,
    pendingSpent: false,
    reread: [],
    rereadArm: null,
  };
}

/**
 * The waits in a row at the newest end of `attempts` that recorded a
 * result; `null` when the newest result is not one. An attempt a person
 * started, after the waits before it went to a person or with their answer,
 * is the first of a new run.
 */
function streakOf(attempts: Attempt[]): WaitStreak | null {
  const answered = attempts
    .filter((a) => a.answered)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  let run = EMPTY;
  for (const a of answered)
    run = a.until === null ? restart(run) : nextRun(run, a);
  const newest = answered.at(-1);
  if (newest === undefined || newest.until === null) return null;
  return {
    record: newest.id,
    count: run.count,
    until: newest.until,
    wait: newest.wait,
    pendingSince: run.pendingSince,
    withinMs: newest.withinMs,
    spent: run.spent,
    reread: run.reread,
  };
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
      .map(attemptOf),
  );
}

/** A launch row as the run reads it when its exit is not written. */
interface StoredRow {
  id: string;
  created_at: string;
  result: string | null;
  result_until: string | null;
  result_wait: string | null;
}

/**
 * An earlier attempt read from the state database: as the tick reads it once
 * its exit is written, else by its result alone, which, with no output to
 * hold a question, waits only when it recorded `waits`.
 */
function storedAttempt(row: StoredRow, root: string): Attempt {
  const ended = readEnded(row.id, root);
  if (ended !== null) return attemptOf(ended);
  const until = row.result === "failed" ? row.result_until : null;
  const record = readRecord(row.id, root);
  return {
    id: row.id,
    createdAt: row.created_at,
    answered: row.result !== null,
    until,
    wait: until === null ? RATE_LIMIT_WAIT : readWaitFor(row.result_wait),
    withinMs: record?.followupWithinMs ?? DEFAULT_WITHIN_MS,
    answeredByPerson: record?.answered !== undefined,
  };
}

/** The waits in a row up to and including `r`, read from the state database when only the record is at hand. */
function storedStreak(r: ReadRecord, root: string): WaitStreak | null {
  const rows = stateDb(root)
    .query(
      "SELECT id, created_at, result, result_until, result_wait FROM launches WHERE action = 'followup' AND repo = ? AND pr = ? AND created_at <= ? AND id != ?",
    )
    .all(
      r.record.repo,
      r.record.pr,
      r.record.createdAt,
      r.record.id,
    ) as StoredRow[];
  // The record itself, as read, stands over its row.
  const attempts = [
    ...rows.map((row) => storedAttempt(row, root)),
    attemptOf(r),
  ];
  const streak = streakOf(attempts);
  return streak?.record === r.record.id ? streak : null;
}

/**
 * Whether an ended follow-up record waits, so its marker is released after
 * its time rather than answered: it waits (`waitUntil`), and its run of
 * waits has not gone past its kind's limit.
 */
export function waitEnd(r: ReadRecord, root = stateRoot()): boolean {
  if (r.record.action !== "followup" || r.record.pr === null) return false;
  if (waitUntil(r) === null) return false;
  if (r.state.kind !== "ended" && r.state.kind !== "died") return false;
  const streak = storedStreak(r, root);
  return streak !== null && !streak.spent;
}

/**
 * The wait of the follow-up whose launch record `found` is, while it is the
 * tick's to wait out; `null` when `found` did not end on a wait, or its
 * run of waits has gone past its kind's limit.
 */
export function owedWait(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  const streak = endedOnWait(found, records);
  return streak !== null && !streak.spent ? streak : null;
}

/** The waits in a row that made the follow-up of `found` a person's; `null` when they have not. */
export function waitsSpent(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  const streak = endedOnWait(found, records);
  return streak?.spent ? streak : null;
}

/** The waits in a row that end with `found`; `null` when `found` did not end on a wait. */
function endedOnWait(
  found: ReadRecord | undefined,
  records: readonly ReadRecord[],
): WaitStreak | null {
  if (found === undefined || found.record.pr === null) return null;
  if (waitUntil(found) === null) return null;
  const streak = waitStreak(records, found.record.repo, found.record.pr);
  return streak?.record === found.record.id ? streak : null;
}

/** Whether a wait has ended at `nowMs`; a time that does not read has. */
export function waitOver(streak: WaitStreak, nowMs: number): boolean {
  const at = parseMs(streak.until);
  return !Number.isFinite(at) || at <= nowMs;
}

/** A duration in the largest whole unit that holds it exactly: hours, minutes or seconds. */
function durationWords(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

/** What a follow-up that waits met, and how long it waits, in words. */
export function waitWords(streak: WaitStreak): string {
  if (streak.wait.reason === "pending")
    return `found ${armWords(streak.wait)} still pending and waits until ${streak.until} (pending since the pass launched ${streak.pendingSince}; past dispatch.followup_within ${durationWords(streak.withinMs)} a person settles it)`;
  return `met a rate limit and waits until ${streak.until} (${streak.count} in a row; at ${WAITS_FOR_PERSON} a person settles it)`;
}

/** Why a follow-up is a person's once its waits went past their limit, naming the fault: the rate limit, or the arm still pending. */
export function spentWords(id: string, streak: WaitStreak): string {
  if (streak.wait.reason === "pending")
    return `its pass under launch record ${id} found ${armWords(streak.wait)} still pending, as passes have since the one launched ${streak.pendingSince}, past dispatch.followup_within ${durationWords(streak.withinMs)}; its last wait was until ${streak.until}`;
  return `its pass under launch record ${id} met the rate limit ${streak.count} times in a row, the last until ${streak.until}`;
}

/** The trusted markers of this host's on a merged pull request that name `record`, those answered done excepted. */
function ownMarkers(pr: MarkedPr, host: string, record: string): number[] {
  if ("unreadable" in pr.markers) return [];
  return pr.markers
    .filter(
      (m) =>
        m.trusted &&
        m.run.kind === "tick" &&
        m.run.record === record &&
        // A marker a person's answer marked done settles the follow-up: never released.
        m.run.outcome !== "done" &&
        (m.run.host === undefined || m.run.host === host),
    )
    .map((m) => m.id);
}

/**
 * With `--apply`: delete the marker of each follow-up whose wait has ended,
 * or whose spent wait's arm the tick read as settled (`settled`, by launch
 * record), so a later tick starts it again; only on the pull requests in
 * `scope` when one is given. Returns why a marker could not be deleted, which the
 * next tick deletes.
 */
export async function releaseWaitMarkers(
  ctx: Pick<SharedContext, "records" | "host" | "slug">,
  merged: readonly MarkedPr[],
  records: readonly ReadRecord[],
  nowMs: number,
  scope?: ReadonlySet<number>,
  settled: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const failures: string[] = [];
  for (const pr of merged) {
    if (scope !== undefined && !scope.has(pr.number)) continue;
    const streak = waitEnded(records, ctx.slug, pr.number, nowMs, settled);
    if (streak === null) continue;
    failures.push(
      ...(await releaseOwnMarkers(
        ctx,
        pr,
        streak.record,
        streak.spent
          ? `found ${armWords(streak.wait)} still pending, whose tags now exist`
          : streak.wait.reason === "pending"
            ? `waited on ${armWords(streak.wait)} still pending`
            : "waited out a rate limit",
      )),
    );
  }
  return failures;
}

/** The wait of the follow-up of `pr` whose time has passed, or whose arm the tick read as settled, and whose pass has ended; `null` for any other. */
function waitEnded(
  records: readonly ReadRecord[],
  slug: string,
  pr: number,
  nowMs: number,
  settled: ReadonlySet<string>,
): WaitStreak | null {
  const streak = waitStreak(records, slug, pr);
  if (streak === null) return null;
  if (streak.spent ? !settled.has(streak.record) : !waitOver(streak, nowMs))
    return null;
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
