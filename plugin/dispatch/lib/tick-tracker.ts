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
import { endedPassOver } from "./actions/pickup-hold.ts";
import type { ReadRecord } from "./launches.ts";
import { batchSafePickups } from "./queue-batch-areas.ts";
import { readFailureOfError } from "./read-failures.ts";
import { trackerConfigOf } from "./section.ts";
import type { ServedPerson } from "./serve-config.ts";
import type { TickBound } from "./sources/bounded.ts";
import {
  scopeOf,
  trackerDefaultKey,
  unlabeledModeOf,
} from "./sources/served-repo.ts";
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
    detail: `the tracker cannot be opened: ${failureText(error)}`,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** The tracker's part of a repository's tick: the pickups wanted, and the items claimed. */
export async function readTracker(
  request: TrackerRequest,
  bound: TickBound | undefined,
  reads: Pick<TickReads, "budget" | "servedViews">,
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
    const item = values.do_item as
      | { execution_plan_block?: unknown }
      | undefined;
    const scope = scopeOf(values);
    tracked.servedPolicy = {
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
        defaults: request.serveDefaults,
        repoPath: repo.path,
      }),
      trackerNamespace: trackerDefaultKey(
        config.adapter,
        config.team ?? "",
        config.jira.site,
      ),
    };
    const reading = await readPickups(
      () => {
        tracked.tracker =
          request.preparedTracker ?? openTracker(config, repo.path);
        return tracked.tracker;
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
    report.records.push(reading.read);
    report.unplaced.push(...reading.unplaced);
    tracked.pickups = await batchSafePickups(
      repo,
      values,
      reading.wanted,
      !lowBudget(await reads.budget()),
      bound,
    );
    if (reading.read.ok) tracked.claimed = reading.claimed;
  } catch (error) {
    report.records.push(trackerFailure(where, error));
  }
  return tracked;
}
