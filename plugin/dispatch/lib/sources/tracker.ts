/**
 * The pickups the tracker wants: the items assigned to the repository's
 * factory identity (`dispatch.identity`) in a dispatch state
 * (`dispatch.states`), read through the tracker interface. Only an
 * assignment a person with write access made starts a pickup, so each item's
 * current assignment is traced to its maker (`assignedBy`); an item whose
 * assigner cannot write, or whose history cannot be read, is reported and
 * never planned.
 *
 * Beside them, the items the identity claimed (in its in-progress state),
 * which the plan watches for stalls and double claims; and the fresh read a
 * pickup's launch makes just before it starts.
 */
import type { ServedPerson } from "../serve-config.ts";
import { readServedPickups } from "./served.ts";
import {
  type CanonicalState,
  type PoolIssue,
  type Tracker,
  workingStates,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { failureText } from "../text.ts";
import {
  type FacetBound,
  facetGaps,
  facetSummary,
  readFacetStores,
  reportBound,
} from "./tracker-facets.ts";
import type {
  ClaimedItem,
  DispatchSection,
  FacetRecord,
  RecordRead,
  Unplaced,
  WantedItem,
} from "../types.ts";

export interface TrackerReading {
  read: RecordRead;
  wanted: WantedItem[];
  unplaced: Unplaced[];
  /**
   * The items assigned to the identity in its in-progress state, the claims
   * to watch; `null` when they could not be read (named in `unplaced`).
   */
  claimed: ClaimedItem[] | null;
}

/**
 * The claimed items, in `in_progress` or (where the repository names it)
 * `pr_open`: the claim's own assignment needs no assigner check, since
 * nothing is started for them.
 */
async function readClaimed(
  tracker: Tracker,
  identity: string,
): Promise<ClaimedItem[] | Unplaced> {
  try {
    const issues = await tracker.assignedIssues(
      identity,
      workingStates(tracker),
    );
    return issues.map((i) => ({
      key: i.identifier,
      title: i.title,
      url: i.url,
      state: i.state.name,
    }));
  } catch (error) {
    return {
      target: `items in ${workingNames(tracker)}`,
      record: "tracker",
      reason: `the items ${identity} claimed could not be read, so stalls and double claims are not checked: ${failureText(error)}`,
    };
  }
}

/** The tracker's names for the working states, for messages. */
function workingNames(tracker: Tracker): string {
  return [
    ...new Set(workingStates(tracker).map((s) => tracker.stateName(s))),
  ].join(" or ");
}

/** The facet record with the assigned items that lack a facet, where the stores were read. */
function withGaps(
  stores: FacetRecord,
  issues: ReadonlyArray<PoolIssue>,
  epic: string,
): FacetRecord {
  return stores.stores === undefined
    ? stores
    : { ...stores, gaps: facetGaps(issues, stores.stores, epic) };
}

/**
 * The assigned items a person with write access assigned, wanted; the
 * others, and those whose assigner cannot be read, unplaced with why.
 */
async function byTrustedAssigner(
  tracker: Tracker,
  issues: ReadonlyArray<PoolIssue>,
  identity: string,
): Promise<{ wanted: WantedItem[]; unplaced: Unplaced[] }> {
  const wanted: WantedItem[] = [];
  const unplaced: Unplaced[] = [];
  for (const issue of issues) {
    let by: Awaited<ReturnType<Tracker["assignedBy"]>>;
    try {
      by = await tracker.assignedBy(issue.identifier, identity);
    } catch (error) {
      unplaced.push({
        target: issue.identifier,
        title: issue.title,
        url: issue.url,
        record: "tracker",
        reason: `who assigned it cannot be read: ${failureText(error)}`,
      });
      continue;
    }
    if (!by.trusted) {
      unplaced.push({
        target: issue.identifier,
        title: issue.title,
        url: issue.url,
        record: "tracker",
        reason: `assigned to ${identity} by ${by.name}, who cannot write to ${tracker.team}; only a person with write access starts a pickup`,
        cause: "assigner-cannot-write",
      });
      continue;
    }
    wanted.push({
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: issue.state.name,
      assignee: issue.assignee?.name ?? identity,
      assignedBy: by.name,
    });
  }
  return { wanted, unplaced };
}

/** `read`, or a rejection once `bound` has ended it. */
async function within<T>(read: Promise<T>, bound: FacetBound): Promise<T> {
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("stopped at the tick's deadline"));
    if (bound.signal.aborted) stop();
    else bound.signal.addEventListener("abort", stop, { once: true });
  });
  read.catch(() => undefined);
  try {
    return await Promise.race([read, stopped]);
  } finally {
    if (stop !== undefined) bound.signal.removeEventListener("abort", stop);
  }
}

/**
 * The items assigned to `identity`, held to `bound` when there is one: not
 * started once it has ended (`stopped`), and given its signal so the
 * detection the read waits on ends with it; `unreadable` with what the
 * tracker's read threw.
 */
async function readAssigned(
  tracker: Tracker,
  identity: string,
  section: DispatchSection,
  bound: FacetBound | undefined,
): Promise<Outcome<PoolIssue[], "stopped" | "unreadable">> {
  const states = section.states as CanonicalState[];
  if (
    bound !== undefined &&
    (bound.signal.aborted || Date.now() >= bound.deadline)
  )
    return failed(
      "stopped",
      "the tick's deadline passed before the read could start",
    );
  try {
    return ok(
      bound === undefined
        ? await tracker.assignedIssues(identity, states)
        : await within(
            tracker.assignedIssues(identity, states, {
              signal: bound.signal,
              deadline: bound.deadline,
            }),
            bound,
          ),
    );
  } catch (error) {
    return failed("unreadable", failureText(error), error);
  }
}

/**
 * The pickups; `open` opens the tracker, and is not called when there are
 * none to read. With `facets`, the record also says where the tracker
 * keeps each issue facet, read first and within `facets.bound` so a
 * detection the reads depend on is bounded too, and which assigned items
 * lack one (an item carrying `facets.epic` needs no size).
 */
async function readFactoryPickups(
  open: () => Tracker,
  section: DispatchSection,
  facets?: { bound: () => FacetBound; epic: string },
): Promise<TrackerReading> {
  if (section.identity === null)
    return {
      read: {
        record: "tracker",
        source: "dispatch.identity",
        ok: true,
        detail: "no dispatch.identity: this repository has no pickups",
      },
      wanted: [],
      unplaced: [],
      claimed: [],
    };
  const identity = section.identity;
  const tracker = open();
  const source = `${tracker.adapter} ${tracker.team}`;
  // One bound for the whole facet read: the stores and the assigned items
  // share its allowance and its cancellation.
  const bound = facets?.bound();
  // The diagnostic report gets its own share of the allowance, so a slow
  // report leaves the assigned-item read its time.
  const stores =
    bound === undefined
      ? undefined
      : await readFacetStores(tracker, reportBound(bound));
  const assigned = await readAssigned(tracker, identity, section, bound);
  if (!assigned.ok)
    return {
      read: {
        record: "tracker",
        source,
        ok: false,
        detail: `the items assigned to ${identity} could not be read: ${assigned.failure.reason}`,
        ...(stores === undefined ? {} : { facets: stores }),
      },
      wanted: [],
      unplaced: [],
      claimed: null,
    };
  const issues = assigned.value;
  const { wanted, unplaced } = await byTrustedAssigner(
    tracker,
    issues,
    identity,
  );
  const claimed = await readClaimed(tracker, identity);
  if (!Array.isArray(claimed)) unplaced.push(claimed);
  const record =
    stores === undefined || facets === undefined
      ? undefined
      : withGaps(stores, issues, facets.epic);
  return {
    read: {
      record: "tracker",
      source,
      ok: true,
      detail: `${issues.length} item(s) assigned to ${identity} in ${section.states.join(", ")}${Array.isArray(claimed) ? `; ${claimed.length} in ${workingNames(tracker)}` : ""}${record === undefined ? "" : `; ${facetSummary(record)}`}`,
      ...(record === undefined ? {} : { facets: record }),
    },
    wanted,
    unplaced,
    claimed: Array.isArray(claimed) ? claimed : null,
  };
}

/**
 * The fresh read just before a pickup's launch: the item as the tracker
 * holds it while it is still assigned to the identity in a dispatch state,
 * else why not.
 */
export async function freshPickup(
  tracker: Tracker,
  section: DispatchSection,
  key: string,
): Promise<PoolIssue | string> {
  if (section.identity === null) return "dispatch.identity is no longer set";
  let issues: PoolIssue[];
  try {
    issues = await tracker.assignedIssues(
      section.identity,
      section.states as CanonicalState[],
    );
  } catch (error) {
    return `the tracker cannot be read again: ${failureText(error)}`;
  }
  const issue = issues.find((i) => i.identifier === key);
  if (issue === undefined)
    return `it is no longer assigned to ${section.identity} in ${section.states.join(", ")}`;
  // The assignment authorizes the pickup: who made it is read again, so a
  // reassignment by someone without write access, or an assigner whose access
  // ended since the plan, starts nothing.
  try {
    const by = await tracker.assignedBy(key, section.identity);
    if (!by.trusted)
      return `it is assigned to ${section.identity} by ${by.name}, who cannot write to ${tracker.team}`;
  } catch (error) {
    return `who assigned it cannot be read again: ${failureText(error)}`;
  }
  return issue;
}

/** Factory and host-served work share the same plan and capacity checks. */
export async function readPickups(
  open: () => Tracker,
  section: DispatchSection,
  facets?: { bound: () => FacetBound; epic: string },
  served?: {
    cache?: import("../pickup-reads.ts").PickupReads;
    people: readonly ServedPerson[];
    nowMs: number;
    headroom: boolean;
    hitl?: string;
    manualOps?: string;
    executionPlanBlock?: string;
    repoScope?: import("./served-repo.ts").RepoScope;
    unlabeled?: import("./served-repo.ts").UnlabeledMode;
    trackerNamespace?: string;
  },
): Promise<TrackerReading> {
  let tracker: Tracker | undefined;
  const once = () => (tracker ??= open());
  const factory = await readFactoryPickups(once, section, facets);
  if (served === undefined || served.people.length === 0) return factory;
  const extra = await readServedPickups(once(), served.people, {
    ...(served.cache === undefined ? {} : { cache: served.cache }),
    epic: facets?.epic ?? "epic",
    nowMs: served.nowMs,
    headroom: served.headroom,
    ...(served.hitl === undefined ? {} : { hitl: served.hitl }),
    ...(served.manualOps === undefined ? {} : { manualOps: served.manualOps }),
    ...(served.executionPlanBlock === undefined
      ? {}
      : { executionPlanBlock: served.executionPlanBlock }),
    ...(served.repoScope === undefined ? {} : { repoScope: served.repoScope }),
    ...(served.unlabeled === undefined ? {} : { unlabeled: served.unlabeled }),
    ...(served.trackerNamespace === undefined
      ? {}
      : { trackerNamespace: served.trackerNamespace }),
  });
  const keys = new Set(extra.wanted.map((i) => i.key));
  return {
    read: {
      ...factory.read,
      detail: `${factory.read.detail}; ${extra.wanted.length} served pickup(s)`,
    },
    wanted: [
      ...extra.wanted,
      ...factory.wanted.filter((i) => !keys.has(i.key)),
    ],
    unplaced: [...factory.unplaced, ...extra.unplaced],
    claimed:
      factory.claimed === null
        ? null
        : [
            ...new Map(
              // The identity's own reading wins: its claims are dispatch's whoever is served.
              [...extra.claimed, ...factory.claimed].map((i) => [i.key, i]),
            ).values(),
          ],
  };
}
