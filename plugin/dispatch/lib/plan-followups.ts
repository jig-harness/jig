/**
 * The follow-ups in the plan: every pull request merged since the
 * follow-up stage's start, classified by its follow-up markers (claims of
 * the shared forge-claims module, read through `followup-marker.ts`), this
 * machine's launch records and the follow-ups' outcome records
 * (`followup-outcomes.ts`):
 *
 * | Markers | The tick |
 * | --- | --- |
 * | none trusted | wants a follow-up (an untrusted one is ignored, and named) |
 * | more than one trusted | reports them, naming the earliest, which holds the follow-up for the marker commands; a person settles which run stands |
 * | a trusted one that does not read | reports it, starts nothing |
 * | a manual run's, marked done | quiet: done |
 * | a manual run's, not marked done | quiet: held by that run, reported with its author and age |
 * | the tick's, its outcome done | quiet: done |
 * | the tick's, its launch record still holding | running |
 * | the tick's, its outcome failed, its record died, or record and outcome both gone | a failed follow-up: notified once, with the question its pass stopped on when it stated one, never started again |
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
import { questionOf } from "./session.ts";
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
  launched: boolean,
  question: string | null = null,
): Action {
  return {
    stage: "notify",
    target: `PR #${pr.number}`,
    record: "forge",
    reason: `failed follow-up: ${why}; never started again by the tick, a person settles it`,
    evidence: {
      url: pr.url,
      marker: marker.id,
      by: marker.login,
      ...(question === null ? {} : { question }),
    },
    cause: "followup-failed",
    notice: followupFailedNotice(input.slug, pr, marker.id, why, question),
    // The ended row of a follow-up this machine ran holds the failure; one it has no record of has no row.
    ...(launched ? { launched: true as const } : {}),
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

/** Why the launch record a marker names is not this pull request's follow-up; `null` when it is, or is not on this machine. */
function foreignRecord(
  found: ReadRecord | undefined,
  pr: MarkedPr,
  marker: number,
  id: string,
): string | null {
  if (
    found === undefined ||
    (found.record.action === "followup" && found.record.pr === pr.number)
  )
    return null;
  return `its follow-up marker (comment ${marker}) names launch record ${id}, which is a ${found.record.action} of ${targetOf(found.record)}: a person settles it`;
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
  const ended = endedAs(input, pr.number, id, found);
  const unsettled = foreignRecord(found, pr, marker.id, id);
  if (unsettled !== null) {
    plan.unplaced.push({ target, record: "forge", reason: unsettled });
    return;
  }
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
  const question = ended === "failed" ? questionOf(found?.state) : null;
  plan.actions.push(
    failed(
      input,
      pr,
      marker,
      ended === "failed"
        ? `its pass under launch record ${id} ended without recording done${question === null ? "" : `, on a question for a person: ${question}`}`
        : `marker comment ${marker.id} names launch record ${id}, and neither that record nor its outcome is on this machine`,
      ended === "failed",
      question,
    ),
  );
}

/** A merged pull request with no trusted follow-up marker: the tick wants one. */
function wantFollowup(
  input: FollowupInput,
  pr: MarkedPr,
  ignored: readonly { id: number; login: string }[],
  want: Want,
): void {
  want(
    {
      stage: "followup",
      target: `PR #${pr.number}`,
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
      reason: `it carries ${trusted.length} trusted follow-up markers (comments ${trusted.map((m) => m.id).join(", ")}): two runs may have claimed it; the earliest, comment ${trusted[0]?.id}, holds it by the claim rule, and a person settles which run stands`,
    });
    return;
  }
  const [marker] = trusted;
  if (marker === undefined) {
    wantFollowup(input, pr, ignored, want);
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
