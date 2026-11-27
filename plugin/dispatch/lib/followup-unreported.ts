/**
 * The need that stands in for a merged pull request's follow-up when a
 * workspace joined to it has terminals whose agents the runtime cannot
 * report: an idle shell or an editor left there reads the same as an agent
 * the runtime cannot see, so the follow-up waits, and a person is told which
 * workspace holds it and what settles it, rather than the pull request
 * sitting off the line until someone happens to close those terminals.
 */
import { followupUnreportedNotice } from "./notices.ts";
import type { Action } from "./types.ts";

/** The need for the follow-up of `pr` that `wanted` says the tick would start, given the workspace that holds it and why. */
export function followupUnreportedNeed(
  slug: string,
  pr: { number: number; url: string },
  command: string,
  wanted: string,
): (workspace: string, reason: string) => Action {
  return (workspace, reason) => ({
    stage: "notify",
    target: `PR #${pr.number}`,
    record: "forge",
    reason: `${wanted}; but ${reason}, so nothing is started until a person settles it`,
    evidence: { url: pr.url, workspace, stage: "followup" },
    cause: "needs-person",
    notice: followupUnreportedNotice(slug, pr, command, workspace, reason),
  });
}
