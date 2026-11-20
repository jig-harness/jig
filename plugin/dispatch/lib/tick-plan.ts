/**
 * The plan phase of one repository's turn: wanted minus running, over what
 * the observe phase read, with this machine's launch records read beside the
 * sessions, the nudges that are due, and what a hold label or `only_labeled`
 * withholds. It writes the plan into the repository's report, and keeps the
 * plan's own records in the state database: the follow-up outcomes of ended
 * records, the settled nudges, the idle clock and the release of ended
 * pickups. A pickup whose agent finished frees its slot, so the slot table
 * of the apply state is counted again here. With `--apply`, the failure
 * ledger's rows past `failures.notify_after` are planned as notifications
 * beside the plan's own (failure-notices.ts). A stalled pickup's finished
 * work is told from the open pull requests the observe phase already read
 * (`stalled-pr.ts`), and its moves to `pr_open` go on the report. On the
 * owner host the priorities ranking's inputs are read after the plan, for the
 * tick to rank once every repository is planned (`tick-priorities.ts`); the
 * plan never reads it, and only the host's `priorities.enforce` lets the
 * ranking reorder the planned pickups. The planned pickups are then weighed
 * against the work in flight (`overlap-plan.ts`), to order their launch attempts.
 */
import { slotTable } from "./accounts.ts";
import { driversOf } from "./host-drivers.ts";
import { planSteers, readNudges, settlePending } from "./actions/steer.ts";
import {
  recordsWanted,
  releaseEnded,
  settleAgents,
} from "./actions/pickup-hold.ts";
import { planFailureNotices } from "./failure-notices.ts";
import { readOutcomes, settleFollowups } from "./followup-outcomes.ts";
import { readReleases, reconcileReleases } from "./followup-releases.ts";
import { readIdle, updateIdle } from "./idle.ts";
import { type ReadRecord, settledEnds } from "./launches.ts";
import { holdBack, type PlanInput, planTick } from "./plan.ts";
import type { SessionsReport } from "./runtime/port.ts";
import { deadlineOf, type TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { RepoReport } from "./types.ts";
import {
  readStewardDigest,
  recordBelongsToDigest,
  stewardRecords,
} from "./steward.ts";
import { applyStewardOrder } from "./steward-queue.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { bodyLinker } from "../../skills/do-item/scripts/lib/linked-pr.ts";
import type { StalledPrInput } from "./stalled-pr.ts";
import { readPickupTree, type TreeReader } from "./pickup-tree.ts";
import { type CarrierInput, carrierInput } from "./carried-pr.ts";
import { branchPattern } from "./section.ts";
import type { PrLinkText } from "./work-links.ts";
import { preparePriorities } from "./tick-priorities.ts";
import { rearmLockNeeds } from "./rearm-lock-needs.ts";

/** Put the steward's recorded queue order on the tracked pickups, where this host owns the repository. */
function orderTracked(
  context: TickContext,
  observation: RepoObservation,
): void {
  const { opened, tracked } = observation;
  const { repo } = opened;
  if (
    opened.owner &&
    opened.stages.has("steward") &&
    context.options.machine?.steward?.enabled === true
  ) {
    const orders = stewardRecords(repo.slug).flatMap((record) => {
      if (record.value.kind !== "order") return [];
      const digest = readStewardDigest(record.run);
      return digest.ok && recordBelongsToDigest(record.value, digest.value)
        ? [record.value]
        : [];
    });
    tracked.pickups = applyStewardOrder(tracked.pickups, orders);
  }
}

/** Plan one observed repository into its report. */
export function planObserved(
  context: TickContext,
  observation: RepoObservation,
): void {
  const { opened, tracked, forge, ctx, claims, sessions } = observation;
  const { repo, section, report } = opened;
  orderTracked(context, observation);
  const onlyLabeled = observation.labels?.onlyLabeled === true;
  planRepo(context, repo.slug, report, {
    slug: repo.slug,
    values: opened.values,
    root: repo.path,
    ...(observation.board === undefined ? {} : { board: observation.board }),
    section,
    pickups: tracked.pickups,
    claimed: tracked.claimed,
    ...(tracked.partial === true ? { partial: true as const } : {}),
    drives: observation.drives,
    merged: forge.merged,
    sessions,
    created: forge.created,
    held: observation.held,
    serialized: afterWait(context, observation.serialized),
    shared: { host: ctx.host, drives: claims, owner: ctx.owner },
    ...(observation.holders === undefined
      ? {}
      : { holders: observation.holders }),
    ...(context.options.machine == null
      ? {}
      : { unclaimedAfterMs: context.options.machine.unclaimedAfterMs }),
    ...(onlyLabeled ? { inScope: forge.inScope } : {}),
    ...(observation.armsSettled === undefined
      ? {}
      : { armsSettled: observation.armsSettled }),
    ...withStalledPr(observation, context.nowMs),
    ...withTrees(context, opened.stages.has("pickup")),
  });
  if (onlyLabeled) report.inScope = [...forge.inScope];
  // Weigh overlap after the priorities ranking so its tiers preserve that rank.
  context.overlaps ??= [];
  context.overlaps.push({ observation });
  if (opened.owner) {
    const prepared = preparePriorities(report, {
      slug: repo.slug,
      path: repo.path,
      defaultBranch: repo.defaultBranch,
      scope: tracked.issueRepository ?? repo.slug,
      pickups: tracked.pickups,
      unplaced: report.unplaced,
      trackerComplete: tracked.claimed !== null && tracked.partial !== true,
      nowMs: context.nowMs,
      enforce: context.options.machine?.priorities?.enforce === true,
      ...deadlineField(context),
    });
    if (prepared !== null) {
      context.priorities ??= [];
      context.priorities.push(prepared);
    }
  }
  // A failure on a held pull request, or one not known to be labelled, stands down with every other action.
  const failing = {
    actions: [
      ...planFailureNotices(context, opened),
      ...rearmLockNeeds(
        repo.slug,
        observation.drives,
        context.apply?.root,
        (reason) =>
          // A failed read leaves each stopped pull request's need unobserved, so its suppression record stays.
          report.unplaced.push(
            ...[
              "the rearm lock needs",
              ...observation.drives.map((drive) => `PR #${drive.number}`),
            ].map((target) => ({
              target,
              record: "runtime" as const,
              reason,
              readFailed: true as const,
            })),
          ),
        observation.forge.ok,
      ),
    ],
    held: [],
    withheld: report.withheld ?? [],
  };
  holdBack(
    failing,
    observation.held ?? new Set(),
    onlyLabeled ? forge.inScope : undefined,
  );
  report.withheld = failing.withheld;
  report.actions.push(...failing.actions);
}

/**
 * What tells a stalled pickup's finished work: the open pull requests'
 * descriptions where the repository's query read them all, the tracker's
 * `pr_open` state, whether this host owns the repository, and which open
 * pull requests carry an item with the drives that work them. None where
 * the tracker's keys do not read.
 */
function withStalledPr(
  observation: RepoObservation,
  nowMs: number,
): {
  prOpen?: StalledPrInput;
} {
  const { tracked, forge, opened, ctx } = observation;
  const { keys } = tracked;
  if (keys == null) return {};
  const repository = opened.repo.slug;
  const trackerRepository = tracked.issueRepository ?? undefined;
  const prs =
    forge.ok && forge.linkTexts !== undefined ? forge.linkTexts : null;
  return {
    prOpen: {
      prs,
      carried: carriersOf(observation, prs, nowMs),
      prOpen: (nativeType) => prOpenOf(tracked.tracker, nativeType),
      owner: ctx.owner,
      pickup: opened.stages.has("pickup"),
      links: (body, key) =>
        bodyLinker(key, {
          repository,
          keySource: keys.source,
          trackerRepository,
        })(body),
    },
  };
}

/**
 * What reads a stalled pickup's tree for the work it left, with local git
 * bounded by the tick's deadline; none where the pickup stage, which
 * applies a relaunch, is not enabled for the repository on this host.
 */
function withTrees(
  context: TickContext,
  pickup: boolean,
): { trees?: TreeReader } {
  if (!pickup) return {};
  const deadlineMs = deadlineOf(context.options.machine, context.startedMs);
  return { trees: (path) => readPickupTree(path, deadlineMs) };
}

/** Which open pull requests carry an item, the drives the tick read for them, and the merged pull requests that settle one (`carried-pr.ts`). */
function carriersOf(
  observation: RepoObservation,
  prs: readonly PrLinkText[] | null,
  nowMs: number,
): CarrierInput {
  const { tracked, forge, opened, drives } = observation;
  return carrierInput({
    prs,
    rules:
      tracked.keys == null
        ? null
        : {
            keys: tracked.keys,
            branchPattern: branchPattern(opened.values),
            repository: opened.repo.slug,
            issueRepository: tracked.issueRepository ?? null,
          },
    drives,
    read: forge.read,
    ...(forge.scoped ? { inScope: forge.inScope } : {}),
    merged: forge.merged,
    nowMs,
  });
}

/** The `pr_open` name of the workflow an item of this native type is in; `null` where there is no tracker or that workflow names none. */
function prOpenOf(
  tracker: Pick<Tracker, "stateName"> | null | undefined,
  nativeType: string | null,
): string | null {
  if (tracker == null) return null;
  return tracker.stateName("pr_open", nativeType)?.trim() || null;
}

/** A record's execution state: a replay moves it without making a new record. */
const executionOf = ({ record, state }: Pick<ReadRecord, "record" | "state">) =>
  `${record.attempts.length}:${state.kind === "pending"}`;

/** Whether `now` holds a launch record `before` did not, or one `before` read at another point of its execution: some tick launched in between. */
export function launchedMeanwhile(
  before: ReadonlyArray<Pick<ReadRecord, "record" | "state">>,
  now: ReadonlyArray<Pick<ReadRecord, "record" | "state">>,
): boolean {
  const known = new Map(before.map((r) => [r.record.id, executionOf(r)]));
  return now.some((r) => known.get(r.record.id) !== executionOf(r));
}

/**
 * After a wait for the act lock, the groups serialization read may predate
 * the launches of the tick that held it, which an earlier version makes
 * without an observe lock: no re-arm starts in a group this tick, and the
 * next tick reads it afresh.
 */
export function afterWait(
  context: TickContext,
  serialized: RepoObservation["serialized"],
): RepoObservation["serialized"] {
  if (context.actWaited !== true) return serialized;
  const unplaced = new Map(serialized.unplaced);
  for (const n of serialized.grouped)
    if (!unplaced.has(n))
      unplaced.set(
        n,
        "another tick acted while this one read, so its place in the group may have changed",
      );
  return { ...serialized, unplaced };
}

/**
 * Plan one repository's tick into its report, with this machine's launch
 * records read beside the sessions; then keep the idle clock and release
 * the ended pickups whose item left the dispatch states, when the claimed
 * items were read. With `partial`, an item the read left out may still be
 * wanted, so only a claimed item back in the dispatch states releases its record.
 */
function planRepo(
  context: TickContext,
  repo: string,
  report: RepoReport,
  input: Omit<PlanInput, "launches" | "idleSince" | "nowMs" | "outcomes"> & {
    partial?: true;
  },
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
    retried: settledEnds(),
    rerunsHeld: context.rerunsHeld ?? null,
    idleSince: readIdle(repo),
    nowMs,
  });
  report.actions.push(...plan.actions);
  if (plan.moves.length > 0) report.prOpenMoves = plan.moves;
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
  // A claimed item whose pass stopped on a question keeps its record until
  // the item returns to the dispatch states.
  releaseEnded(
    records,
    repo,
    recordsWanted(input.pickups, report.unplaced, records),
    new Set(input.claimed.map((c) => c.key)),
    new Set(input.pickups.map((p) => p.key)),
    undefined,
    new Set(input.claimed.filter((c) => c.served === true).map((c) => c.key)),
    input.partial === true,
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
      undefined,
      context.weights,
      driversOf(context.drivers),
    );
  return all.filter((r) => r.record.repo === repo);
}

/** The tick's deadline for the record read, when the tick has one. */
function deadlineField(context: TickContext): { deadlineMs?: number } {
  const at = deadlineOf(context.options.machine, context.startedMs);
  return at === undefined ? {} : { deadlineMs: at };
}
