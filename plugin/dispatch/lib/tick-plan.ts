/**
 * The plan phase of one repository's turn: wanted minus running, over what
 * the observe phase read, with this machine's launch records read beside the
 * sessions, the nudges that are due, and what a hold label or `only_labeled`
 * withholds. It writes the plan into the repository's report, and keeps the
 * plan's own records in the state database: the follow-up outcomes of ended
 * records, the settled nudges, the idle clock and the release of ended
 * pickups. A pickup whose agent finished frees its slot, so the slot table
 * of the apply state is counted again here.
 */
import { slotTable } from "./accounts.ts";
import { planSteers, readNudges, settlePending } from "./actions/steer.ts";
import { releaseEnded, settleAgents } from "./actions/pickup-hold.ts";
import { readOutcomes, settleFollowups } from "./followup-outcomes.ts";
import { readReleases, reconcileReleases } from "./followup-releases.ts";
import { readIdle, updateIdle } from "./idle.ts";
import type { ReadRecord } from "./launches.ts";
import { holdBack, type PlanInput, planTick } from "./plan.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type { TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { RepoReport } from "./types.ts";

/** Plan one observed repository into its report. */
export function planObserved(
  context: TickContext,
  observation: RepoObservation,
): void {
  const { opened, tracked, forge, ctx, claims, sessions } = observation;
  const { repo, section, report } = opened;
  const onlyLabeled = observation.labels?.onlyLabeled === true;
  planRepo(context, repo.slug, report, {
    slug: repo.slug,
    section,
    pickups: tracked.pickups,
    claimed: tracked.claimed,
    drives: forge.drives,
    merged: forge.merged,
    sessions,
    created: forge.created,
    held: observation.held,
    serialized: observation.serialized,
    shared: { host: ctx.host, drives: claims, owner: ctx.owner },
    ...(context.options.machine == null
      ? {}
      : { unclaimedAfterMs: context.options.machine.unclaimedAfterMs }),
    ...(onlyLabeled ? { inScope: forge.inScope } : {}),
  });
  if (onlyLabeled) report.inScope = [...forge.inScope];
}

/**
 * Plan one repository's tick into its report, with this machine's launch
 * records read beside the sessions; then keep the idle clock and release
 * the ended pickups whose item left the dispatch states, when the claimed
 * items were read whole.
 */
function planRepo(
  context: TickContext,
  repo: string,
  report: RepoReport,
  input: Omit<PlanInput, "launches" | "idleSince" | "nowMs" | "outcomes">,
): void {
  const { nowMs } = context;
  const records = settleRecords(context, repo, input.sessions, nowMs);
  // A follow-up that ended keeps its outcome past its record.
  settleFollowups(records);
  const plan = planTick({
    ...input,
    outcomes: readOutcomes(repo),
    releases: reconcileReleases(
      readReleases(
        repo,
        input.merged.map((pr) => pr.number),
      ),
      input.merged,
    ),
    launches: records,
    idleSince: readIdle(repo),
    nowMs,
  });
  report.actions.push(...plan.actions);
  report.running.push(...plan.running);
  const nudges = readNudges(repo);
  for (const reason of settlePending(nudges))
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
  const steers = planSteers({
    slug: repo,
    launches: records,
    sessions: input.sessions,
    nudges,
    nowMs,
  });
  // The nudges stand down for a held or not-known-labelled pull request like every other action.
  const nudged = {
    actions: steers.actions,
    held: plan.held,
    withheld: plan.withheld,
  };
  holdBack(nudged, input.held ?? new Set(), input.inScope);
  report.actions.push(...nudged.actions);
  report.withheld = plan.withheld;
  report.serialized?.held.push(...plan.serialHeld);
  report.running.push(...steers.running);
  report.unplaced.push(...plan.unplaced);
  report.quiet.push(...plan.quiet);
  if (input.section.labels.enabled)
    report.labels = {
      prefix: input.section.labels.prefix,
      onlyLabeled: input.section.labels.onlyLabeled,
      unlabeled: 0,
      states: [],
      commands: [],
      held: plan.held,
      writes: [],
    };
  if (input.claimed === null) return;
  updateIdle(repo, plan.idleNow, nowMs, undefined, plan.idleKeep);
  // An item the read left out (who assigned it could not be read, or not by a
  // person with write access) is still assigned: only leaving the dispatch
  // states releases its record.
  releaseEnded(
    records,
    repo,
    new Set([
      ...input.pickups.map((p) => p.key),
      ...report.unplaced.map((u) => u.target),
    ]),
  );
}

/**
 * This machine's launch records for `repo`, each pickup's read beside its
 * agent: one whose agent the runtime reports finished no longer holds its
 * slot, so the slot table is counted again.
 */
function settleRecords(
  context: TickContext,
  repo: string,
  sessions: SessionsReport,
  nowMs: number,
): ReadRecord[] {
  const all = context.apply?.records ?? context.launches;
  if (settleAgents(all, repo, sessions, nowMs) && context.apply !== null)
    context.apply.table = slotTable(
      context.apply.machine.accounts,
      context.apply.records,
      nowMs,
    );
  return all.filter((r) => r.record.repo === repo);
}
