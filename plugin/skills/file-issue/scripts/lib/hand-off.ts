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
 * Cost: one read of the issue (a second after a wait, so an assignment or a
 * start made meanwhile is never overwritten), the identity's lookup, one
 * assignment write and the read that confirms it; an issue already
 * assigned costs one history read instead of the write. Waiting costs no
 * request.
 */
import { type Clock, systemClock } from "../../../../shared/clock.ts";
import { failureOf } from "../../../../shared/outbound/failure.ts";
import { isoFromMs } from "../../../../shared/time.ts";
import { AssignerUnknown } from "../../../do-item/scripts/lib/tracker/assigner-unknown.ts";
import {
  assignableFromMs,
  waitBeforeAssigning,
  windowWords,
} from "../../../do-item/scripts/lib/tracker/assignment-window.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";

/** What a hand-off reads and writes through. */
export type HandOffTracker = Pick<
  Tracker,
  | "adapter"
  | "creationQuietMs"
  | "poolIssue"
  | "user"
  | "assign"
  | "assignees"
  | "assignedBy"
>;

export type HandOff =
  | {
      handedOver: true;
      issue: string;
      to: string;
      /** When this run wrote the assignment; `null` when it was already there. */
      writtenAt: string | null;
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

const CLOSED = ["completed", "canceled"];

/**
 * Hand `key` to `identity`. With `wait`, an issue younger than the
 * tracker's creation window is waited for; without it, the result names
 * the time from which the hand-off may run.
 */
export async function handOff(
  tracker: HandOffTracker,
  key: string,
  identity: string,
  opts: { wait: boolean; clock?: Pick<Clock, "now" | "sleep"> },
): Promise<HandOff> {
  const clock = opts.clock ?? systemClock;
  const notYet = (
    reason: string,
    remedy: string,
    earliest: string | null = null,
  ): HandOff => ({
    handedOver: false,
    issue: key,
    to: identity,
    reason,
    earliest,
    remedy,
  });
  const again = "run the hand-off again";
  /** Why an issue as read cannot be handed over whatever its assignee; `null` when it can. */
  const unfit = (issue: PoolIssue | null): HandOff | null => {
    if (issue === null)
      return notYet(`the tracker has no issue ${key}`, "check the key");
    if (CLOSED.includes(issue.state.type))
      return notYet(
        `${key} is ${issue.state.name}, a closed state`,
        "reopen it first if the work is still wanted",
      );
    if (issue.state.type === "started")
      return notYet(
        `${key} is ${issue.state.name}, a state of work in progress`,
        "a started item is someone's work: leave it to them",
      );
    return null;
  };
  let step = "read the issue";
  try {
    const issue = await tracker.poolIssue(key);
    const refused = unfit(issue);
    if (refused !== null || issue === null)
      return (
        refused ?? notYet(`the tracker has no issue ${key}`, "check the key")
      );
    step = `look up ${identity}`;
    const user = await tracker.user(identity);
    const window = windowWords(tracker);
    const from = assignableFromMs(tracker, issue.createdAt);
    if (!from.ok) return notYet(from.failure.reason, again);
    if (issue.assignee !== null) {
      if (issue.assignee.id !== user.id)
        return notYet(
          `${key} is assigned to ${issue.assignee.name}`,
          `a hand-off does not take an issue from its assignee: unassign ${key} first if that is meant, then ${again}`,
        );
      if (window === null)
        return {
          handedOver: true,
          issue: key,
          to: identity,
          writtenAt: null,
          detail: `${key} was already assigned to ${identity}; nothing written`,
        };
      step = `read who assigned ${key}`;
      try {
        const by = await tracker.assignedBy(key, identity);
        if (!by.trusted)
          return notYet(
            `${key} was assigned to ${identity} by ${by.name}, who may not start work in this repository`,
            `a hand-off does not change an existing assignment: someone who can write to the repository unassigns ${key} on the tracker and assigns it to ${identity} again`,
          );
        return {
          handedOver: true,
          issue: key,
          to: identity,
          writtenAt: null,
          detail: `${key} was already assigned to ${identity} by ${by.name}, and its history shows it; nothing written`,
        };
      } catch (error) {
        if (!(error instanceof AssignerUnknown)) throw error;
        const earliest =
          from.value !== null && from.value > clock.now()
            ? isoFromMs(from.value)
            : null;
        return notYet(
          `${key} is assigned to ${identity}, but who made that assignment cannot be read: ${error.message}`,
          `a hand-off does not change an existing assignment: unassign ${key} on the tracker, then assign it to ${identity} again${earliest === null ? "" : ` at or after ${earliest}`} (or ${again})`,
          earliest,
        );
      }
    }
    const { waitMs, until } = waitBeforeAssigning(from.value, clock.now());
    if (waitMs > 0 && !opts.wait)
      return notYet(
        `${key} is inside its creation window: ${window}`,
        `${again} at or after ${until}`,
        until,
      );
    if (waitMs > 0) {
      await clock.sleep(waitMs);
      step = `read ${key} again after the wait`;
      const fresh = await tracker.poolIssue(key);
      const changed = unfit(fresh);
      if (changed !== null) return changed;
      if (fresh?.assignee != null)
        return notYet(
          `${key} was assigned to ${fresh.assignee.name} while the hand-off waited; nothing written`,
          `a hand-off does not take an issue from its assignee: unassign ${key} first if that is meant, then ${again}`,
        );
    }
    step = `assign ${key} to ${identity}`;
    const writtenAt = isoFromMs(clock.now());
    await tracker.assign(key, user);
    step = `confirm ${key}'s assignment`;
    const now = await tracker.assignees(key);
    if (!now.some((u) => u.id === user.id))
      return notYet(
        `${key} did not read back as assigned to ${identity}`,
        `read ${key} on the tracker; if it is not assigned to ${identity}, ${again}`,
      );
    return {
      handedOver: true,
      issue: key,
      to: identity,
      writtenAt,
      detail: `${key} assigned to ${identity} at ${writtenAt}; the dispatcher sees it from its next tick after then`,
    };
  } catch (error) {
    const failure = failureOf(error);
    return notYet(
      `could not ${step}: ${failure.code}: ${failure.reason}${failure.sent === true ? " (the request may have been applied)" : ""}`,
      `read ${key} on the tracker; if it is not assigned to ${identity}, ${again}`,
    );
  }
}
