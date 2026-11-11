/**
 * Whether the reviewers that skip drafts have run on the announced head since
 * the pull request was last marked Ready for review: one gate of the
 * merge-ready announcement (`announce-merge-ready.ts`).
 *
 * Marking a draft Ready is what summons a reviewer that skips drafts, so in
 * the seconds after it two stale shapes still read as settled: no check run
 * of that reviewer exists on the head yet, or its newest one is the skip it
 * posted while the pull request was a draft. Each refuses the announcement
 * until a run of that reviewer started on the head after the Ready
 * transition.
 *
 * Which reviewers count is configuration, `review.draft_skipping_reviewers`
 * (GitHub App slugs); a reviewer with a built-in profile is recognised by its
 * check run's name, any other by its app alone. The transition's time is the
 * forge's own record, the newest `ready_for_review` event on the pull
 * request's timeline, which a person's Ready mark writes as the drive's does.
 * A pull request that never was a draft has no such event, and needs only a
 * run of each reviewer on the head.
 */
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import {
  announcedIds,
  announcements,
  withdrawAnnouncement,
} from "./announce.ts";
import { checkPattern } from "./merge-ready.ts";
import { draftSkippingReviewers } from "./overlay.ts";
import { readTimeline } from "./pr-timeline.ts";
import { runTitleSays, reviewerProfile } from "./reviewer-profiles.ts";
import { type CheckRun, checkRunsFor } from "./status/evidence.ts";

/**
 * The newest `ready_for_review` event's time on `events`: `{ readyAt: null }`
 * when there is none, `null` when an entry is not an event or one carries no
 * readable time, since an unknown history cannot stand for "never marked
 * Ready".
 */
export function readyMarkedAt(
  events: readonly unknown[],
): { readyAt: string | null } | null {
  let newest: string | null = null;
  for (const event of events) {
    // An entry that is not an event cannot say the pull request was never
    // marked Ready, so the history is unreadable.
    if (typeof event !== "object" || event === null || Array.isArray(event))
      return null;
    const { event: kind, created_at: at } = event as Record<string, unknown>;
    if (typeof kind !== "string") return null;
    if (kind !== "ready_for_review") continue;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
    if (newest === null || Date.parse(at) > Date.parse(newest)) newest = at;
  }
  return { readyAt: newest };
}

/**
 * Why `app`'s reviewer has not yet run on `head` since `readyAt`, from the
 * head's check runs; `null` when it has.
 */
export function draftSkipperPending(
  runs: readonly CheckRun[],
  app: string,
  head: string,
  readyAt: string | null,
): string | null {
  const profile = reviewerProfile(app);
  const name =
    profile === undefined ? null : checkPattern(profile.checkPattern);
  const newest = runs
    .filter((r) => r.app === app && (name === null || name.test(r.name)))
    .sort((a, b) => a.id - b.id)
    .at(-1);
  if (newest === undefined)
    return `${app} has no check run on ${head} yet, so it has not looked at this head`;
  const says = runTitleSays(newest.title);
  if (says === "draft-skip")
    return `${app}'s newest check run on ${head} is its draft skip ("${newest.title}")`;
  // A skip or a pause is a run that did not review the head, however recent.
  if (says !== null)
    return `${app}'s newest check run on ${head} did not review it ("${newest.title}")`;
  // A run that did not complete successfully reviewed nothing, whatever its
  // title and start time say.
  if (
    newest.status !== "completed" ||
    !["success", "neutral"].includes(newest.conclusion ?? "")
  )
    return `${app}'s newest check run on ${head} has not completed successfully (${newest.status}, ${newest.conclusion ?? "no conclusion"})`;
  if (readyAt === null) return null;
  const started = Date.parse(newest.started ?? "");
  return Number.isFinite(started) && started >= Date.parse(readyAt)
    ? null
    : `${app}'s newest check run on ${head} started ${newest.started ?? "at an unreadable time"}, before the pull request was marked Ready at ${readyAt}`;
}

/**
 * Whether every reviewer `review.draft_skipping_reviewers` names has run on
 * PR `pr`'s `head` since it was last marked Ready: `not-yet` names the first
 * that has not, `unreadable` the read that failed. No read when the field
 * names none.
 */
export async function draftSkippersRan(
  pr: string,
  head: string,
): Promise<Outcome<true, "not-yet" | "unreadable">> {
  const apps = draftSkippingReviewers();
  if (apps.length === 0) return ok(true);
  const timeline = await readTimeline(pr);
  if (!timeline.ok) return failed("unreadable", timeline.failure.reason);
  const runs = await checkRunsFor("{owner}", "{repo}", head);
  if (runs === null)
    return failed("unreadable", `cannot read the check runs on ${head}`);
  const marked = readyMarkedAt(timeline.value);
  if (marked === null)
    return failed(
      "unreadable",
      "a ready_for_review event on the timeline carries no readable time",
    );
  const { readyAt } = marked;
  for (const app of apps) {
    const pending = draftSkipperPending(runs, app, head, readyAt);
    if (pending !== null) return failed("not-yet", pending);
  }
  return ok(true);
}

/**
 * Reconcile the standing announcements of `head` with the skippers: when one
 * is positively not-yet since the Ready mark, withdraw them (unless
 * `withdraw` is false, as in a dry run, which only evaluates). Run ahead of
 * any convergence refusal, which would otherwise leave the old "Safe to
 * merge" standing; an unreadable fact withdraws nothing. `pending` says a
 * skipper was positively not-yet, so the caller can report the waiting exit
 * when that explains its refusal; `failed` says a withdrawal or the listing
 * failed, leaving a stale claim standing. Every comment is attempted.
 */
export async function withdrawIfSkippersPending(
  pr: string,
  head: string,
  withdraw = true,
): Promise<{ pending: boolean; failed: boolean }> {
  const ran = await draftSkippersRan(pr, head);
  if (ran.ok || ran.failure.code !== "not-yet")
    return { pending: false, failed: false };
  if (!withdraw) return { pending: true, failed: false };
  const standing = await announcements(pr);
  if (standing === null) {
    console.error(
      `announce-merge-ready: cannot read PR #${pr}'s comments — remove any standing merge-ready announcement by hand.`,
    );
    return { pending: true, failed: true };
  }
  let failed = false;
  for (const id of announcedIds(standing, head))
    if (!(await withdrawAnnouncement(pr, id))) {
      failed = true;
      console.error(
        `announce-merge-ready: could NOT delete comment ${id} — remove it by hand.`,
      );
    }
  return { pending: true, failed };
}
