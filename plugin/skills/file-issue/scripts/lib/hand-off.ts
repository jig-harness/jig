/**
 * Hand a newly filed issue to the line: assign it to a served person (or
 * any tracker identity) so that the dispatcher sees who made the
 * assignment. On a tracker whose history leaves out changes made just
 * after an issue's creation (`assignment-window.ts`), the assignment is
 * written only once that window has passed, waiting for it when asked.
 *
 * It hands over an unassigned issue only. An issue already assigned is
 * never changed: assigned to the identity with its history showing it, it
 * is already handed over; otherwise the result says what a person does.
 *
 * Cost: two reads of the issue (the second after the identity's lookup and
 * any wait, so an assignment or a start made meanwhile is never
 * overwritten), the identity's lookup, the protected write and the read
 * that confirms it, then the assigner read. On a tracker with
 * `assignUnassigned` the protected write reads the current assignee and
 * the assignment history, the issue's id, the assignee again, then
 * the history after the write; a history not yet showing the write is read
 * again until that operation's own deadline, and a long history is read in
 * pages. An issue already assigned costs the assigner read (one history
 * read) instead of the write. Waiting costs no request.
 */
import { type Clock, systemClock } from "../../../../shared/clock.ts";
import { failureOf } from "../../../../shared/outbound/failure.ts";
import { isoFromMs } from "../../../../shared/time.ts";
import { AssignerUnknown } from "../../../do-item/scripts/lib/tracker/assigner-unknown.ts";
import {
  assignableFromMs,
  waitBeforeAssigning,
  WINDOW_MARGIN_MS,
  windowWords,
} from "../../../do-item/scripts/lib/tracker/assignment-window.ts";
import {
  CLOSED_STATE_TYPES,
  type PoolIssue,
  type TrackerUser,
  type Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";

/** What a hand-off reads and writes through. */
export type HandOffTracker = Pick<
  Tracker,
  | "adapter"
  | "creationQuietMs"
  | "poolIssue"
  | "user"
  | "assign"
  | "assignUnassigned"
  | "assignees"
  | "assignedBy"
>;

export type HandOff =
  | {
      handedOver: true;
      issue: string;
      to: string;
      /** When this run's assignment write was confirmed; `null` when it was already there. */
      confirmedAt: string | null;
      detail: string;
    }
  | {
      handedOver: false;
      issue: string;
      to: string;
      reason: string;
      /** The earliest time the hand-off may be written; `null` when that is not what it waits on. */
      earliest: string | null;
      /** What a person (or the next session) does to finish it. */
      remedy: string;
    };

/** What every step of one hand-off shares. */
type Run = {
  tracker: HandOffTracker;
  key: string;
  identity: string;
  clock: Pick<Clock, "now" | "sleep">;
  signal: AbortSignal | undefined;
  /** The step in flight, named in a failure's reason. */
  step: string;
};

const AGAIN = "run the hand-off again";

/** What a hand-off may spend on its reads, write and confirmation, beyond any wait for the creation window. */
export const WORK_BUDGET_MS = 120_000;

function notYet(
  run: Run,
  reason: string,
  remedy: string,
  earliest: string | null = null,
): HandOff {
  return {
    handedOver: false,
    issue: run.key,
    to: run.identity,
    reason,
    earliest,
    remedy,
  };
}

const rerunWords = (run: Run): string =>
  `${AGAIN}: an issue already assigned to ${run.identity} is only confirmed, never rewritten`;

function interrupted(run: Run, step: string): HandOff | null {
  return run.signal?.aborted === true
    ? notYet(
        run,
        `the hand-off was interrupted or ran past its deadline before it could ${step}`,
        `read ${run.key} on the tracker, then ${rerunWords(run)}`,
      )
    : null;
}

/** Why an issue as read cannot be handed over whatever its assignee; `null` when it can. */
function unfit(run: Run, issue: PoolIssue | null): HandOff | null {
  const { key } = run;
  if (issue === null)
    return notYet(run, `the tracker has no issue ${key}`, "check the key");
  if ((CLOSED_STATE_TYPES as readonly string[]).includes(issue.state.type))
    return notYet(
      run,
      `${key} is ${issue.state.name}, a closed state`,
      "reopen it first if the work is still wanted",
    );
  if (issue.state.type === "started")
    return notYet(
      run,
      `${key} is ${issue.state.name}, a state of work in progress`,
      "a started item is someone's work: leave it to them",
    );
  return null;
}

/** An issue already assigned to the identity: confirmed from its history, never rewritten. */
async function confirmExisting(
  run: Run,
  assignee: { id: string; name: string },
  userId: string,
  from: number | null,
): Promise<HandOff> {
  const { key, identity } = run;
  if (assignee.id !== userId)
    return notYet(
      run,
      `${key} is assigned to ${assignee.name}`,
      `a hand-off does not take an issue from its assignee: unassign ${key} first if that is meant, then ${AGAIN}`,
    );
  run.step = `read who assigned ${key}`;
  try {
    const by = await run.tracker.assignedBy(key, identity, run.signal);
    if (!by.trusted)
      return notYet(
        run,
        `${key} was assigned to ${identity} by ${by.name}, who may not start work in this repository`,
        `a hand-off does not change an existing assignment: someone who can write to the repository unassigns ${key} on the tracker and assigns it to ${identity} again`,
      );
    return {
      handedOver: true,
      issue: key,
      to: identity,
      confirmedAt: null,
      detail: `${key} was already assigned to ${identity} by ${by.name}, and its history shows it; nothing written`,
    };
  } catch (error) {
    if (!(error instanceof AssignerUnknown)) throw error;
    const earliest =
      from !== null && from > run.clock.now() ? isoFromMs(from) : null;
    return notYet(
      run,
      `${key} is assigned to ${identity}, but who made that assignment cannot be read: ${error.message}`,
      `a hand-off does not change an existing assignment: unassign ${key} on the tracker, then assign it to ${identity} again${earliest === null ? "" : ` at or after ${earliest}`} (or ${AGAIN})`,
      earliest,
    );
  }
}

/** The write and its read-back; a result when the assignment did not take. */
async function assignAndConfirm(
  run: Run,
  user: TrackerUser,
): Promise<HandOff | null> {
  const { tracker, key, identity } = run;
  run.step = `assign ${key} to ${identity}`;
  if (tracker.assignUnassigned !== undefined) {
    const wrote = await tracker.assignUnassigned(key, user);
    if (!wrote.assigned)
      return notYet(
        run,
        `${key} was not assigned to ${identity} (${wrote.reason}): someone else may hold it now`,
        `read ${key} on the tracker; if it is unassigned, ${AGAIN}`,
      );
  } else await tracker.assign(key, user);
  run.step = `confirm ${key}'s assignment`;
  const now = await tracker.assignees(key);
  if (!now.some((u) => u.id === user.id))
    return notYet(
      run,
      `${key} did not read back as assigned to ${identity}`,
      `read ${key} on the tracker, then ${rerunWords(run)}`,
    );
  return null;
}

/** The assigner read after a write; a result when the assigner may not start work. */
async function checkAssigner(run: Run): Promise<HandOff | null> {
  const { key, identity } = run;
  run.step = `read who assigned ${key}`;
  try {
    const by = await run.tracker.assignedBy(key, identity, run.signal);
    if (by.trusted) return null;
    return notYet(
      run,
      `${key} was assigned to ${identity}, but the tracker's history names ${by.name} as the assigner, who may not start work in this repository`,
      `someone who can write to the repository unassigns ${key} on the tracker and assigns it to ${identity} again`,
    );
  } catch (error) {
    if (!(error instanceof AssignerUnknown)) throw error;
    return notYet(
      run,
      `${key} is assigned to ${identity}, but who made that assignment cannot be read: ${error.message}`,
      `unassign ${key} on the tracker, then assign it to ${identity} again (or ${AGAIN})`,
    );
  }
}

/** The second read, after the lookup and any wait, so no start or assignment made meanwhile is overwritten. */
async function rereadBeforeWrite(
  run: Run,
  waited: boolean,
): Promise<HandOff | null> {
  const { key } = run;
  run.step = `read ${key} again before assigning`;
  const fresh = await run.tracker.poolIssue(key, run.signal);
  const changed = unfit(run, fresh);
  if (changed !== null) return changed;
  if (fresh?.assignee != null)
    return notYet(
      run,
      `${key} was assigned to ${fresh.assignee.name} while the hand-off ${waited ? "waited" : "looked up the identity"}; nothing written`,
      `a hand-off does not take an issue from its assignee: unassign ${key} first if that is meant, then ${AGAIN}`,
    );
  return interrupted(run, `assign ${key}`);
}

/** Waits out the creation window when asked; a result when it may not or could not. */
async function waitForWindow(
  run: Run,
  from: number | null,
  wait: boolean,
): Promise<{ waited: boolean } | { result: HandOff }> {
  const { waitMs, until } = waitBeforeAssigning(from, run.clock.now());
  if (waitMs <= 0) return { waited: false };
  if (!wait)
    return {
      result: notYet(
        run,
        `${run.key} is inside its creation window: ${windowWords(run.tracker)}`,
        `${AGAIN} at or after ${until}`,
        until,
      ),
    };
  await run.clock.sleep(waitMs, run.signal);
  const stopped = interrupted(run, `read ${run.key} again after the wait`);
  return stopped === null ? { waited: true } : { result: stopped };
}

/**
 * Hand `key` to `identity`. With `wait`, an issue younger than the
 * tracker's creation window is waited for; without it, the result names
 * the time from which the hand-off may run. An aborted `signal`, or the
 * operation's own deadline (the creation window, its margin and
 * `WORK_BUDGET_MS`, counted from the start and covering the prerequisite
 * reads, the wait, the write and the confirmation), ends the wait and
 * starts no further read or write; the result is then a not-handed-over
 * one.
 */
export async function handOff(
  tracker: HandOffTracker,
  key: string,
  identity: string,
  opts: {
    wait: boolean;
    clock?: Pick<Clock, "now" | "sleep">;
    signal?: AbortSignal;
    /** Replaces the operation's deadline (tests). */
    deadlineMs?: number;
    /**
     * Aborted when the operation's deadline expires, so a tracker opened
     * with its signal stops its in-flight assignment requests too, which
     * take no signal of their own.
     */
    operation?: AbortController;
  },
): Promise<HandOff> {
  const quiet = tracker.creationQuietMs ?? 0;
  const deadline = AbortSignal.timeout(
    opts.deadlineMs ??
      WORK_BUDGET_MS + (opts.wait && quiet > 0 ? quiet + WINDOW_MARGIN_MS : 0),
  );
  const { operation } = opts;
  const expire = () => operation?.abort(deadline.reason);
  if (operation !== undefined)
    deadline.addEventListener("abort", expire, { once: true });
  const run: Run = {
    tracker,
    key,
    identity,
    clock: opts.clock ?? systemClock,
    signal:
      opts.signal === undefined
        ? deadline
        : AbortSignal.any([opts.signal, deadline]),
    step: "read the issue",
  };
  try {
    const issue = await tracker.poolIssue(key, run.signal);
    const refused = unfit(run, issue);
    if (refused !== null || issue === null)
      return (
        refused ??
        notYet(run, `the tracker has no issue ${key}`, "check the key")
      );
    run.step = `look up ${identity}`;
    const user = await tracker.user(identity, run.signal);
    const from = assignableFromMs(tracker, issue.createdAt);
    if (!from.ok) return notYet(run, from.failure.reason, AGAIN);
    if (issue.assignee !== null)
      return await confirmExisting(run, issue.assignee, user.id, from.value);
    const waited = await waitForWindow(run, from.value, opts.wait);
    if ("result" in waited) return waited.result;
    const blocked =
      (await rereadBeforeWrite(run, waited.waited)) ??
      (await assignAndConfirm(run, user)) ??
      (await checkAssigner(run));
    if (blocked !== null) return blocked;
    const confirmedAt = isoFromMs(run.clock.now());
    return {
      handedOver: true,
      issue: key,
      to: identity,
      confirmedAt,
      detail: `${key} assigned to ${identity}, confirmed by its history at ${confirmedAt}; the dispatcher sees it from its next tick after then`,
    };
  } catch (error) {
    const failure = failureOf(error);
    return notYet(
      run,
      `could not ${run.step}: ${failure.code}: ${failure.reason}${failure.sent === true ? " (the request may have been applied)" : ""}`,
      `read ${key} on the tracker, then ${rerunWords(run)}`,
    );
  } finally {
    deadline.removeEventListener("abort", expire);
  }
}
