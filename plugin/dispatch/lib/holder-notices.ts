/**
 * A launch the workspace runtime refused because a checkout it does not
 * list holds the launch's branch and is in use (`LaunchOutcome.holder`)
 * becomes a notification to a person (cause `needs-person`), keyed by the
 * target, the branch and that checkout's path. It goes through the
 * notifications' suppression records like every other cause, so it is sent
 * once per holder, then on `dispatch.renotify_after` while the holder stays
 * busy, and the launch's report line says only that it waits on that
 * notice.
 *
 * The cause is seen only by a tick whose launch reached the workspace open.
 * A tick whose launch of the same target waited or was refused before it
 * saw the holder (no admitting account, the open budget, the deadline, an
 * identity check, a probe timeout) has not seen the holder leave, so
 * its record stands (`holderRecordStands`); it is dropped once the launch
 * opens its workspace, or the target is no longer planned.
 */
import { pullUrl } from "./forge.ts";
import { HOLDER_KEY_MARK, holderNotice } from "./notices.ts";
import type { Action, LaunchOutcome, RepoReport } from "./types.ts";

/** The notifications of `slug`'s launches refused by a busy holder, one per key. */
export function holderActions(
  slug: string,
  launches: readonly LaunchOutcome[],
): Action[] {
  const actions = new Map<string, Action>();
  for (const launch of launches) {
    const { holder } = launch;
    if (holder === undefined) continue;
    const pr = /^PR #(\d+)$/.exec(launch.target);
    const notice = holderNotice(slug, {
      target: launch.target,
      stage: launch.action,
      path: holder.path,
      branch: holder.branch,
      reasons: holder.reasons,
      url: pr === null ? null : pullUrl(slug, Number(pr[1])),
    });
    actions.set(notice.key, {
      stage: "notify",
      target: launch.target,
      record: "runtime",
      reason: `the checkout at ${holder.path}, which the workspace runtime does not list, holds ${holder.branch} and is in use: ${holder.reasons.join("; ")}`,
      evidence: {
        stage: launch.action,
        holder: holder.path,
        branch: holder.branch,
        busy: holder.reasons.join("; "),
      },
      cause: "needs-person",
      notice,
    });
  }
  return [...actions.values()];
}

/** The report line of a launch a busy holder refused: what it waits on, its reasons in the notice. */
export function holderRefusal(holder: {
  path: string;
  branch: string;
  reasons: string[];
}): string {
  return `waits on a person: the checkout at ${holder.path}, which the workspace runtime does not list, holds ${holder.branch} and is in use: ${holder.reasons.join("; ")}; a notice to a person follows where notifications are enabled`;
}

/** Whether a busy holder's suppression record stands although its cause is absent: its target's launch waited this tick before it could reach the open. */
export function holderRecordStands(
  report: Pick<RepoReport, "launches">,
  record: { key: string; target: string },
): boolean {
  return (
    record.key.includes(HOLDER_KEY_MARK) &&
    report.launches.some(
      (l) =>
        l.target === record.target &&
        (l.outcome === "waits" ||
          (l.outcome === "refused" && l.holder === undefined)),
    )
  );
}
