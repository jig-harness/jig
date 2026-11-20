/**
 * The tracker's part of a repository's tick: the configuration's keys and
 * served policy, the pickups wanted (`sources/tracker.ts`, answered from the
 * queues the tick gathered first, `tick-trackers.ts`), kept to the batches
 * that are safe to take together (`queue-batch-areas.ts`), and the items
 * claimed. The world view's direct implementation reads it
 * (`world-view.ts`); a tracker that cannot be opened is a failed record,
 * never an escape.
 */
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { personPickupHolds, pickupHoldReason } from "./person-pickup-holds.ts";
import { endedPassOver } from "./actions/pickup-hold.ts";
import type { ReadRecord } from "./launches.ts";
import { batchSafePickups } from "./queue-batch-areas.ts";
import { pool as proofPool, type Pool } from "./pool.ts";
import { combinedFailure, readFailureOfError } from "./read-failures.ts";
import { trackerConfigOf } from "./section.ts";
import type { ServedPerson } from "./serve-config.ts";
import type { TickBound } from "./sources/bounded.ts";
import {
  scopeOf,
  trackerDefaultKey,
  unlabeledModeOf,
} from "./sources/served-repo.ts";
import { planMergeReader } from "./sources/plan-merges.ts";
import { readPickups } from "./sources/tracker.ts";
import { facetBound } from "./sources/tracker-facets.ts";
import { failureText } from "./text.ts";
import { lowBudget, type TickReads } from "./tick-reads.ts";
import type {
  ClaimedItem,
  DispatchSection,
  RepoReport,
  RepoTarget,
  WantedItem,
} from "./types.ts";

/** What the tracker gives one repository's tick. */
export interface Tracked {
  servedPolicy?: import("./sources/served.ts").ServedPolicy;
  keys: IssueKeys | null;
  /** The configured adapter (`issue_tracker.adapter`); `null` when the tracker configuration does not read. */
  adapter: string | null;
  /** For GitHub Issues, the repository the issues are in (`owner/name`); `null` for any other tracker. */
  issueRepository: string | null;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  /** Some wanted item was not read (a served item, merge proof, or a failed record): the pickups are not all known. */
  partial?: true;
  /** The tracker opened for the read, for the pickups' fresh reads; `null` when none was. */
  tracker: Tracker | null;
}

/** What one repository's tracker read is asked with. */
export interface TrackerRequest {
  values: Record<string, unknown>;
  repo: RepoTarget;
  section: DispatchSection;
  /** The report the read's records and unplaced targets go on. */
  report: RepoReport;
  /** Where the dispatch section was read from, which names a tracker that cannot be opened. */
  where: string;
  /** The people this host serves pickups for; none where the pickup stage is off. */
  people: readonly ServedPerson[];
  serveDefaults: Readonly<Record<string, string>> | undefined;
  nowMs: number;
  /** State directory whose pickup holds this tick reads. */
  root: string;
  /** Whether some account has room for a pickup this tick. */
  headroom: boolean;
  /** This machine's launch records, for the pickups a person passed over. */
  records: readonly ReadRecord[];
  /** The tracker the tick opened while it gathered the queues, reused here. */
  preparedTracker?: Tracker | undefined;
}

/** The tracker's failed record, carrying the class of the call that failed it. */
function trackerFailure(
  where: string,
  error: unknown,
): RepoReport["records"][number] {
  const failure = readFailureOfError(error);
  return {
    record: "tracker",
    source: where,
    ok: false,
    detail: `the issue service cannot be opened: ${failureText(error)}`,
    ...(failure === undefined ? {} : { failure }),
  };
}

/**
 * The pool merge proofs run through, one per tick and shared by every
 * repository: the enclosing tracker read holds a slot of the tick's pool,
 * which never lends a second one to the same read, so proof chains take a
 * pool of their own, as wide as the tick's configured `poolSize`, rather
 * than waiting on it. Proof chains and ordinary reads each stay within that
 * width, so the tick's reads in flight never exceed twice it.
 */
const proofPools = new WeakMap<Pool, Pool>();
function proofPoolOf(tickPool: Pool): Pool {
  let proofs = proofPools.get(tickPool);
  if (proofs === undefined) {
    proofs = proofPool(tickPool.size);
    proofPools.set(tickPool, proofs);
  }
  return proofs;
}

/** The merge-proof reader for one repository, collecting its failures in `failures`. */
function mergeReaderOf(
  tracker: Tracker,
  from: {
    values: Record<string, unknown>;
    repo: RepoTarget;
    config: ReturnType<typeof trackerConfigOf>;
    keySource: string | undefined;
    bound: TickBound | undefined;
  },
  pool: Pool,
  failures: unknown[],
): ReturnType<typeof planMergeReader> {
  const { values, repo, config } = from;
  const base = (values.repository as { base_branch?: unknown } | undefined)
    ?.base_branch;
  return planMergeReader(tracker, {
    root: repo.path,
    repository: repo.slug,
    trunk: typeof base === "string" ? base : repo.defaultBranch,
    keySource: from.keySource ?? "(?!)",
    trackerRepository:
      config.adapter === "github"
        ? (config.github.repository ?? repo.slug)
        : undefined,
    bodyLinkRequired:
      (values.pull_requests as { issue_link?: unknown } | undefined)
        ?.issue_link !== "none",
    bound: from.bound,
    pool,
    onFailure: (error) => failures.push(error),
  });
}

/** The pickup read, failed with what the merge proofs could not read. */
function withMergeFailures<R extends { ok: boolean; detail: string }>(
  read: R,
  mergeFailures: readonly unknown[],
): R {
  if (mergeFailures.length === 0) return read;
  const failure = combinedFailure([
    ...(read.ok ? [] : [(read as { failure?: unknown }).failure as never]),
    ...mergeFailures.map(readFailureOfError),
  ]);
  const { failure: _previousFailure, ...rest } = read as R & {
    failure?: unknown;
  };
  return {
    ...rest,
    ok: false,
    detail: `${read.detail}; merge proof could not be read: ${failureText(mergeFailures[0])}`,
    ...(failure === undefined ? {} : { failure }),
  } as R;
}

/** The served policy one repository's pickup read runs under. */
function servedPolicyOf(
  from: {
    values: Record<string, unknown>;
    repo: RepoTarget;
    config: ReturnType<typeof trackerConfigOf>;
    serveDefaults: Readonly<Record<string, string>> | undefined;
  },
  mergeEvidence: ReturnType<typeof planMergeReader>,
): NonNullable<Tracked["servedPolicy"]> {
  const { values, repo, config } = from;
  const item = values.do_item as { execution_plan_block?: unknown } | undefined;
  const scope = scopeOf(values);
  return {
    mergeEvidence,
    hitl: config.labels.hitl,
    manualOps: config.labels.manualOps,
    ...(typeof item?.execution_plan_block === "string"
      ? { executionPlanBlock: item.execution_plan_block }
      : {}),
    ...(scope === undefined ? {} : { repoScope: scope }),
    unlabeled: unlabeledModeOf({
      scope,
      adapter: config.adapter,
      team: config.team ?? "",
      site: config.jira.site,
      defaults: from.serveDefaults,
      repoPath: repo.path,
    }),
    trackerNamespace: trackerDefaultKey(
      config.adapter,
      config.team ?? "",
      config.jira.site,
    ),
  };
}

/** The tracker's part of a repository's tick: the pickups wanted, and the items claimed. */
export async function readTracker(
  request: TrackerRequest,
  bound: TickBound | undefined,
  reads: Pick<TickReads, "budget" | "servedViews" | "pool">,
): Promise<Tracked> {
  const { values, repo, section, report, where, nowMs, records } = request;
  const tracked: Tracked = {
    keys: null,
    adapter: null,
    issueRepository: null,
    pickups: [],
    claimed: null,
    tracker: null,
  };
  try {
    const config = trackerConfigOf(values, repo.slug);
    tracked.keys = issueKeysOf(config);
    tracked.adapter = config.adapter;
    tracked.issueRepository =
      config.adapter === "github" ? config.github.repository : null;
    const holds = personPickupHolds(repo.slug, request.root);
    if (!holds.ok) {
      report.records.push({
        record: "tracker",
        source: where,
        ok: false,
        detail: holds.failure.reason,
      });
      return { ...tracked, partial: true };
    }
    const byKey = new Map(holds.value.map((hold) => [hold.item, hold]));
    for (const hold of holds.value) {
      report.unplaced.push({
        target: hold.item,
        record: "tracker",
        reason: pickupHoldReason(hold),
        title: hold.title,
        url: hold.url,
        pickupHold: { by: hold.by, at: hold.at },
      });
    }
    const tracker = request.preparedTracker ?? openTracker(config, repo.path);
    const mergeFailures: unknown[] = [];
    tracked.servedPolicy = servedPolicyOf(
      { values, repo, config, serveDefaults: request.serveDefaults },
      mergeReaderOf(
        tracker,
        { values, repo, config, keySource: tracked.keys?.source, bound },
        proofPoolOf(reads.pool),
        mergeFailures,
      ),
    );
    tracked.servedPolicy.personHold = (key) => {
      const hold = byKey.get(key);
      return hold === undefined ? null : pickupHoldReason(hold);
    };
    const reading = await readPickups(
      () => {
        tracked.tracker = tracker;
        return tracker;
      },
      section,
      { bound: () => facetBound(bound?.deadline), tick: bound },
      {
        people: request.people,
        nowMs,
        headroom: request.headroom,
        passOver: endedPassOver(records, repo.slug, nowMs),
        ...tracked.servedPolicy,
        ...(reads.servedViews === undefined
          ? {}
          : { views: reads.servedViews }),
      },
    );
    reading.read = withMergeFailures(reading.read, mergeFailures);
    report.records.push(reading.read);
    report.unplaced.push(
      ...reading.unplaced.filter((row) => !byKey.has(row.target)),
    );
    tracked.pickups = await batchSafePickups(
      repo,
      values,
      reading.wanted,
      !lowBudget(await reads.budget()),
      bound,
    );
    // The reading leaves its claims unknown itself; a failed item read
    // leaves them known and only the pickups partial.
    tracked.claimed = reading.claimed;
    if (!reading.read.ok || reading.partial === true) tracked.partial = true;
  } catch (error) {
    report.records.push(trackerFailure(where, error));
  }
  return tracked;
}
