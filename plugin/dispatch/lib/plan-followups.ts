/**
 * The follow-ups in the plan: every pull request merged since the
 * follow-up stage's start, classified by its follow-up markers
 * (`followup-marker.ts`), this machine's launch records and the follow-ups'
 * outcome records (`followup-outcomes.ts`):
 *
 * | Markers | The tick |
 * | --- | --- |
 * | none trusted | wants a follow-up (an untrusted one is ignored, and named) |
 * | more than one trusted | reports both; a person settles which run stands |
 * | a trusted one that does not read | reports it, starts nothing |
 * | a manual run's, marked done | quiet: done |
 * | a manual run's, not marked done | quiet: held by that run, reported with its author and age |
 * | the tick's, its outcome done | quiet: done |
 * | the tick's, its launch record still holding | running |
 * | the tick's, its outcome failed, its record died, or record and outcome both gone | a failed follow-up: notified once, never started again |
 * | the tick's, naming a record for anything else | reports it, starts nothing |
 *
 * A marker is a claim, not a completion; a person settles a failed or
 * held follow-up by deleting its marker (wanted again) or, for a manual
 * run, by marking it done.
 */
import type { FollowupOutcome } from "./followup-outcomes.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import { trustedMarkers } from "./followup-marker.ts";
import { holds, type ReadRecord, targetOf } from "./launches.ts";
import { followupFailedNotice } from "./notices.ts";
import type { Workspace } from "./runtime/port.ts";
import type { Action, FollowupMarker, MarkedPr, RepoReport } from "./types.ts";

export interface FollowupInput {
  slug: string;
  command: string;
  merged: MarkedPr[];
  launches: ReadRecord[];
  outcomes: ReadonlyMap<number, FollowupOutcome>;
  nowMs: number;
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet">;
type Want = (action: Action, joined: (w: Workspace) => boolean) => void;

function age(createdAt: string, nowMs: number): string {
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return "an unknown time";
  const minutes = Math.floor((nowMs - at) / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function failed(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker,
  why: string,
): Action {
  return {
    stage: "notify",
    target: `PR #${pr.number}`,
    record: "forge",
    reason: `failed follow-up: ${why}; never started again by the tick, a person settles it`,
    evidence: { url: pr.url, marker: marker.id, by: marker.login },
    cause: "followup-failed",
    notice: followupFailedNotice(input.slug, pr, marker.id, why),
  };
}

/** How the follow-up a tick's marker names ended: its outcome record's, else its launch record's; `null` while it has not. */
function endedAs(
  input: FollowupInput,
  pr: number,
  id: string,
  found: ReadRecord | undefined,
): "done" | "failed" | null {
  const outcome = input.outcomes.get(pr);
  if (outcome?.record === id) return outcome.outcome;
  return found === undefined ? null : outcomeOf(found);
}

/** A pull request the tick's own marker claims, by the record it names and the outcome. */
function planTickMarker(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker & { run: { kind: "tick" } },
  plan: Plan,
): void {
  const target = `PR #${pr.number}`;
  const id = marker.run.record;
  const found = input.launches.find((r) => r.record.id === id);
  if (
    found !== undefined &&
    (found.record.action !== "followup" || found.record.pr !== pr.number)
  ) {
    plan.unplaced.push({
      target,
      record: "forge",
      reason: `its follow-up marker (comment ${marker.id}) names launch record ${id}, which is a ${found.record.action} of ${targetOf(found.record)}: a person settles it`,
    });
    return;
  }
  const ended = endedAs(input, pr.number, id, found);
  if (ended === "done") {
    plan.quiet.push({
      target,
      class: "followup-done",
      why: `the follow-up under launch record ${id} recorded done`,
    });
    return;
  }
  if (found !== undefined && holds(found.state) && ended === null) {
    plan.running.push({
      target,
      stage: "followup",
      reason: `launch record ${id} (${found.state.kind}) holds its follow-up, claimed by marker comment ${marker.id}`,
      evidence: { record: id, marker: marker.id },
    });
    return;
  }
  plan.actions.push(
    failed(
      input,
      pr,
      marker,
      ended === "failed"
        ? `its session under launch record ${id} ended without recording done`
        : `marker comment ${marker.id} names launch record ${id}, and neither that record nor its outcome is on this machine`,
    ),
  );
}

/** One merged pull request: wanted, running, quiet, failed or unplaced. */
function planMerged(
  input: FollowupInput,
  pr: MarkedPr,
  plan: Plan,
  want: Want,
): void {
  const target = `PR #${pr.number}`;
  if ("unreadable" in pr.markers) {
    plan.unplaced.push({
      target,
      record: "forge",
      reason: `its follow-up markers could not be read: ${pr.markers.unreadable}`,
    });
    return;
  }
  const trusted = trustedMarkers(pr.markers);
  const ignored = pr.markers.filter((m) => !m.trusted);
  if (trusted.length > 1) {
    plan.unplaced.push({
      target,
      record: "forge",
      reason: `it carries ${trusted.length} trusted follow-up markers (comments ${trusted.map((m) => m.id).join(", ")}): two runs may have claimed it, a person settles which stands`,
    });
    return;
  }
  const [marker] = trusted;
  if (marker === undefined) {
    want(
      {
        stage: "followup",
        target,
        record: "forge",
        reason: `merged ${pr.mergedAt} with no follow-up marker; run ${input.command} ${pr.number}`,
        evidence: {
          url: pr.url,
          head: pr.head,
          mergedAt: pr.mergedAt,
          ...(ignored.length === 0
            ? {}
            : {
                ignoredMarkers: ignored
                  .map((m) => `${m.id} by ${m.login}`)
                  .join(", "),
              }),
        },
      },
      (w) => w.prs.includes(pr.number),
    );
    return;
  }
  if (marker.run.kind === "unreadable") {
    plan.unplaced.push({
      target,
      record: "forge",
      reason: `its follow-up marker (comment ${marker.id} by ${marker.login}) does not read: ${marker.run.reason}`,
    });
    return;
  }
  if (marker.run.kind === "manual") {
    plan.quiet.push({
      target,
      class: marker.run.done ? "followup-done" : "followup-held",
      why: marker.run.done
        ? `a follow-up ${marker.login} ran marked it done (comment ${marker.id})`
        : `a follow-up ${marker.login} ran claimed it ${age(marker.createdAt, input.nowMs)} ago (comment ${marker.id}) and has not marked it done; mark it done when that run succeeded, or delete it to start the follow-up again`,
    });
    return;
  }
  planTickMarker(
    input,
    pr,
    marker as FollowupMarker & { run: { kind: "tick" } },
    plan,
  );
}

export function planFollowups(
  input: FollowupInput,
  plan: Plan,
  want: Want,
): void {
  for (const pr of input.merged) planMerged(input, pr, plan, want);
}
