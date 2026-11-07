/**
 * The follow-ups in the plan: every pull request merged since the
 * follow-up stage's start, classified by its follow-up markers (the
 * follow-up's shared records, read through `followup-marker.ts`), this
 * machine's launch records and the follow-ups' outcome records
 * (`followup-outcomes.ts`):
 *
 * | Markers | The tick |
 * | --- | --- |
 * | none trusted | wants a follow-up (an untrusted one is ignored, and named) |
 * | more than one trusted | reports them, naming the earliest, which holds the follow-up for the marker commands; a person settles which run stands |
 * | a trusted one that does not read | reports it, starts nothing |
 * | a manual run's, marked done | quiet: done |
 * | a manual run's, not marked done | quiet: held by that run, reported with its author and age, until it goes stale |
 * | another host's, its answer done | quiet: done |
 * | another host's, its answer failed | a failed follow-up: notified, never started again |
 * | another host's, no answer yet | running, held by that host, until it goes stale |
 * | a manual run's or another host's with no answer, stale, never released | released: the marker deleted, so a later tick starts the follow-up again |
 * | the same, stale, a claim on it released before | notified to a person, never released twice |
 * | this host's, its outcome done | quiet: done |
 * | this host's, its launch record still holding | running |
 * | this host's, its pass died with no result and no question, not itself a run again | running: the tick releases the marker, and a later tick runs the follow-up again once, within the pull request's recovery budget |
 * | this host's, its outcome failed, its run again died, or record and outcome both gone | a failed follow-up: notified on the configured cadence, with the question its pass stopped on when it stated one, never started again |
 * | this host's, naming a record for anything else | reports it, starts nothing |
 *
 * A tick's marker names the host that posted it; one that names none was
 * posted before markers named their host, and is read as this host's; the
 * host whose launch record it names writes its own host onto it when it ends
 * it. This
 * host's own marker is read through its launch record and outcome record,
 * and through the answer written on the marker once both are gone.
 *
 * A marker is a claim, not a completion; a person settles a failed or
 * held follow-up by deleting its marker (wanted again) or, for a manual
 * run, by marking it done.
 *
 * A claim nobody can see the end of, a manual run's not marked done or
 * another host's with no answer, is **stale** once it is older than
 * `dispatch.followup_stale_after` and no session the runtime reports is
 * joined to its pull request: the run that made it stopped short (on a
 * question, a crash, a closed session) and will not finish. A claim whose
 * age does not read, or a runtime that cannot say, holds it as before. The
 * host that owns the repository releases a stale claim once per pull
 * request (`followup-releases.ts`); a claim that goes stale again after
 * that is notified, with its age and whose claim it is, and never released
 * a second time, since a follow-up that stalls twice wants a person.
 */
import type { FollowupOutcome } from "./followup-outcomes.ts";
import { outcomeOf } from "./followup-outcomes.ts";
import type { FollowupRelease } from "./followup-releases.ts";
import { trustedMarkers } from "./followup-marker.ts";
import { holding } from "./holding.ts";
import { holds, type ReadRecord, targetOf } from "./launches.ts";
import { followupFailedNotice, staleClaimNotice } from "./notices.ts";
import type { SessionsReport, Workspace } from "./runtime/port.ts";
import { localRecoverySpent } from "./no-cause-stops.ts";
import { RECOVERY_FACTS } from "./recovery-facts.ts";
import {
  diedWithoutResult,
  isRerun,
  retriedDeath,
  retryableStartup,
} from "./session-startup.ts";
import { questionOf } from "./session.ts";
import type { Action, FollowupMarker, MarkedPr, RepoReport } from "./types.ts";

export interface FollowupInput {
  slug: string;
  command: string;
  merged: MarkedPr[];
  launches: ReadRecord[];
  outcomes: ReadonlyMap<number, FollowupOutcome>;
  /** This host, as its markers name it; `null` when the shared records name none. */
  host: string | null;
  /** The runtime's answer: a claim a running session is joined to is not stale. */
  sessions: SessionsReport;
  /** `dispatch.followup_stale_after`. */
  staleAfterMs: number;
  /** The claims this host released, by pull request. */
  releases: ReadonlyMap<number, FollowupRelease>;
  /** Whether this host owns the repository: only the owner releases a claim. */
  owner: boolean;
  /** The launch records whose marker a tick released as a retry, and whose claims owe nothing more (`settledEnds`). */
  retried: ReadonlySet<string>;
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

function hoursOf(ms: number): string {
  return ms % 3_600_000 === 0
    ? `${ms / 3_600_000}h`
    : `${Math.round(ms / 60_000)}m`;
}

/**
 * A claim with no end a tick can see: held by `held` while it is inside
 * `followup_stale_after`, a running session is joined to its pull request,
 * or either cannot be read; once stale, released, or notified when a claim
 * on the pull request was released before.
 */
function planClaimed(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker,
  claimant: string,
  plan: Plan,
  held: () => void,
): void {
  const posted = Date.parse(marker.createdAt);
  const joined = holding(input.sessions, (w) => w.prs.includes(pr.number));
  if (
    !Number.isFinite(posted) ||
    input.nowMs - posted < input.staleAfterMs ||
    joined.kind !== "free"
  ) {
    held();
    return;
  }
  const target = `PR #${pr.number}`;
  const ageText = age(marker.createdAt, input.nowMs);
  const facts = `${claimant} claimed it ${ageText} ago (marker comment ${marker.id}), has not marked it done, and no session is joined to it, past dispatch.followup_stale_after ${hoursOf(input.staleAfterMs)}`;
  const evidence = {
    url: pr.url,
    marker: marker.id,
    by: marker.login,
    claimant,
    claimedAt: marker.createdAt,
  };
  const earlier = input.releases.get(pr.number);
  if (earlier !== undefined && earlier.marker !== marker.id) {
    plan.actions.push({
      stage: "notify",
      target,
      record: "forge",
      reason: `stale follow-up claim, again: ${facts}; the tick released ${earlier.claimant}'s stale claim (marker comment ${earlier.marker}) once and does not release a second, a person settles it`,
      evidence: { ...evidence, released: earlier.marker },
      cause: "followup-stale",
      notice: staleClaimNotice(input.slug, pr, {
        marker: marker.id,
        claimant,
        age: ageText,
        manual: marker.run.kind === "manual",
        earlier,
      }),
    });
    return;
  }
  if (!input.owner) {
    plan.quiet.push({
      target,
      class: "followup-held",
      why: `${facts}; the host that owns the repository releases it`,
    });
    return;
  }
  plan.actions.push({
    stage: "followup",
    target,
    record: "forge",
    reason: `stale follow-up claim: ${facts}; the tick deletes the marker once, and a later tick starts the follow-up again`,
    evidence,
    release: {
      marker: marker.id,
      login: marker.login,
      claimant,
      claimedAt: marker.createdAt,
    },
  });
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

/** A pull request another host's marker claims, by the answer that host wrote on it. */
function planForeignMarker(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker & { run: { kind: "tick"; host: string } },
  plan: Plan,
): void {
  const target = `PR #${pr.number}`;
  const { record, host, outcome } = marker.run;
  const named = `host ${host}'s launch record ${record} (marker comment ${marker.id})`;
  if (outcome === "done") {
    plan.quiet.push({
      target,
      class: "followup-done",
      why: `the follow-up under ${named} recorded done`,
    });
    return;
  }
  if (outcome === "failed") {
    plan.actions.push(
      failed(
        input,
        pr,
        marker,
        `its pass under ${named} ended without recording done; that host's report carries the question it stopped on, if any`,
        false,
      ),
    );
    return;
  }
  planClaimed(
    input,
    pr,
    marker,
    `host ${host}'s launch record ${record}`,
    plan,
    () =>
      plan.running.push({
        target,
        stage: "followup",
        reason: `held by host ${host}: ${named} claims its follow-up, and that host has not written its answer`,
        evidence: { record, marker: marker.id, host },
      }),
  );
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
  const ended = endedHere(input, pr.number, marker, found);
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
  if (found !== undefined && retriedDeath(found, input.nowMs)) {
    plan.running.push({
      target,
      stage: "followup",
      reason: `launch record ${id}'s pass died with no result and no question: the tick releases its marker (comment ${marker.id}), and a later tick runs the follow-up again once`,
      evidence: { record: id, marker: marker.id },
    });
    return;
  }
  if (
    found !== undefined &&
    (holds(found.state) || retryableStartup(found)) &&
    ended === null
  ) {
    plan.running.push({
      target,
      stage: "followup",
      reason: `launch record ${id} (${found.state.kind}) holds its follow-up, claimed by marker comment ${marker.id}`,
      evidence: { record: id, marker: marker.id },
    });
    return;
  }
  plan.actions.push(failedTick(input, pr, marker, found, ended === "failed"));
}

/** A failed follow-up this host's marker claims: its pass ended short of done, or its record and outcome are both gone. */
function failedTick(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker & { run: { kind: "tick" } },
  found: ReadRecord | undefined,
  ended: boolean,
): Action {
  const id = marker.run.record;
  const question = ended ? questionOf(found?.state) : null;
  const asked =
    question === null ? "" : `, on a question for a person: ${question}`;
  const again =
    found !== undefined && diedWithoutResult(found) && isRerun(found.record)
      ? ", dying again after the tick ran it again once"
      : "";
  const why = ended
    ? `its pass under launch record ${id} ended without recording done${asked}${again}`
    : `marker comment ${marker.id} names launch record ${id}, and neither that record nor its outcome is on this machine`;
  const action = failed(input, pr, marker, why, ended, question);
  action.evidence.record = id;
  return action;
}

/**
 * How the follow-up this host's marker names ended: by its outcome record or
 * its launch record, and by the answer written on the marker once both are
 * gone from this host; `null` while it has not.
 */
function endedHere(
  input: FollowupInput,
  pr: number,
  marker: FollowupMarker & { run: { kind: "tick" } },
  found: ReadRecord | undefined,
): "done" | "failed" | null {
  const ended = endedAs(input, pr, marker.run.record, found);
  if (ended !== null || found !== undefined) return ended;
  return marker.run.outcome ?? null;
}

/** The host another host's marker names, when it is not this one; `null` for this host's own, or one that names none. */
function foreignHost(
  input: FollowupInput,
  marker: FollowupMarker & { run: { kind: "tick" } },
): string | null {
  const { host } = marker.run;
  return host === undefined || input.host === null || host === input.host
    ? null
    : host;
}

/** A pull request a tick's marker claims: another host's by the answer it wrote, this host's by its records. */
function planTick(
  input: FollowupInput,
  pr: MarkedPr,
  marker: FollowupMarker & { run: { kind: "tick" } },
  plan: Plan,
): void {
  const host = foreignHost(input, marker);
  if (host === null) planTickMarker(input, pr, marker, plan);
  else
    planForeignMarker(
      input,
      pr,
      { ...marker, run: { ...marker.run, host } },
      plan,
    );
}

/**
 * The follow-up of a pull request that a follow-up launched now runs again:
 * this host's latest follow-up of it, when that one died for the first time
 * and a tick released its marker as a retry (`retried`); `undefined`
 * otherwise. A follow-up a person asked for again by deleting a failed
 * marker is a new one, not a run again.
 */
function deathOf(input: FollowupInput, pr: number): ReadRecord | undefined {
  const latest = input.launches
    .filter(
      (r) =>
        r.record.repo === input.slug &&
        r.record.pr === pr &&
        r.record.action === "followup",
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
  return latest !== undefined &&
    diedWithoutResult(latest) &&
    !isRerun(latest.record) &&
    input.retried.has(latest.record.id)
    ? latest
    : undefined;
}

/** A merged pull request with no trusted follow-up marker: the tick wants one, run again after a death within the recovery budget. */
function wantFollowup(
  input: FollowupInput,
  pr: MarkedPr,
  ignored: readonly { id: number; login: string }[],
  want: Want,
): void {
  const died = deathOf(input, pr.number);
  const spent =
    died === undefined
      ? null
      : localRecoverySpent(input.slug, pr.number, input.launches, input.nowMs);
  if (died !== undefined && spent !== null) {
    want(failedRerun(input, pr, died, spent), (w) => w.prs.includes(pr.number));
    return;
  }
  want(
    {
      stage: "followup",
      target: `PR #${pr.number}`,
      record: "forge",
      reason:
        died === undefined
          ? `merged ${pr.mergedAt} with no follow-up marker; run ${input.command} ${pr.number}`
          : `merged ${pr.mergedAt}, and launch record ${died.record.id}'s follow-up died with no result: run ${input.command} ${pr.number} again, once`,
      ...(died === undefined
        ? {}
        : { facts: `${RECOVERY_FACTS}merged ${pr.mergedAt}` }),
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
    if (marker.run.done) {
      plan.quiet.push({
        target,
        class: "followup-done",
        why: `a follow-up ${marker.login} ran marked it done (comment ${marker.id})`,
      });
      return;
    }
    planClaimed(
      input,
      pr,
      marker,
      `${marker.login}'s ${input.command} run`,
      plan,
      () =>
        plan.quiet.push({
          target,
          class: "followup-held",
          why: `a follow-up ${marker.login} ran claimed it ${age(marker.createdAt, input.nowMs)} ago (comment ${marker.id}) and has not marked it done; mark it done when that run succeeded, or delete it to start the follow-up again; past dispatch.followup_stale_after ${hoursOf(input.staleAfterMs)} with no session joined to it, the tick releases it once`,
        }),
    );
    return;
  }
  planTick(
    input,
    pr,
    marker as FollowupMarker & { run: { kind: "tick" } },
    plan,
  );
}

/** A follow-up that died, whose run again the pull request's spent recovery budget withholds: a person's. */
function failedRerun(
  input: FollowupInput,
  pr: MarkedPr,
  died: ReadRecord,
  spent: string,
): Action {
  const why = `its pass under launch record ${died.record.id} died with no result, and ${spent}`;
  return {
    stage: "notify",
    target: `PR #${pr.number}`,
    record: "forge",
    reason: `failed follow-up: ${why}`,
    evidence: { url: pr.url, record: died.record.id },
    cause: "followup-failed",
    notice: followupFailedNotice(input.slug, pr, died.record.marker ?? 0, why),
    launched: true,
  };
}

export function planFollowups(
  input: FollowupInput,
  plan: Plan,
  want: Want,
): void {
  for (const pr of input.merged) planMerged(input, pr, plan, want);
}
