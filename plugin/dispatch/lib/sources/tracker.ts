/**
 * The pickups the tracker wants: the items assigned to the repository's
 * factory identity (`dispatch.identity`) in a dispatch state
 * (`dispatch.states`), read through the tracker interface. Only an
 * assignment a person with write access made starts a pickup, so each item's
 * current assignment is traced to its maker (`assignedBy`); an item whose
 * assigner cannot write, or whose history cannot be read, is reported and
 * never planned.
 *
 * With a ready pool (`dispatch.pool`), the unassigned items in its states
 * are pickups too, trusted by who made them ready (`ready-pool.ts`).
 *
 * Beside them, the items the identity claimed (in its in-progress state),
 * which the plan watches for stalls and double claims; and the fresh read a
 * pickup's launch makes just before it starts.
 */
import type { ServedPerson } from "../serve-config.ts";
import { type PickupReads, pickupReads } from "../pickup-reads.ts";
import { within } from "./bounded.ts";
import { freshPoolPickup, readPoolPickups } from "./ready-pool.ts";
import { limitedRow, readServedPickups, type ServedPolicy } from "./served.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import {
  type CanonicalState,
  type PoolIssue,
  type Tracker,
  workingStates,
  isWorkingIssue,
  trackerStateMaps,
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
import { currentMs } from "../../../shared/time.ts";

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
    return issues
      .filter(
        (i) => tracker.stateMaps === undefined || isWorkingIssue(tracker, i),
      )
      .map((i) => ({
        key: i.identifier,
        title: i.title,
        url: i.url,
        state: i.state.name,
      }));
  } catch (error) {
    if (isRateLimited(error)) throw error;
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
    ...new Set(
      trackerStateMaps(tracker)
        .flatMap((map) => workingStates(tracker).map((state) => map[state]))
        .filter((name) => name !== null),
    ),
  ].join(" or ");
}

/** The facet record with the assigned items that lack a facet, where the stores were read. */
function withGaps(
  stores: FacetRecord,
  issues: ReadonlyArray<PoolIssue>,
): FacetRecord {
  return stores.stores === undefined
    ? stores
    : { ...stores, gaps: facetGaps(issues, stores.stores) };
}

/**
 * The assigned items a person with write access assigned, wanted; the
 * others, and those whose assigner cannot be read, unplaced with why.
 */
async function byTrustedAssigner(
  tracker: Tracker,
  issues: ReadonlyArray<PoolIssue>,
  identity: string,
): Promise<{
  wanted: WantedItem[];
  unplaced: Unplaced[];
  limited?: TrackerRateLimited;
}> {
  const wanted: WantedItem[] = [];
  const unplaced: Unplaced[] = [];
  for (const issue of issues) {
    let by: Awaited<ReturnType<Tracker["assignedBy"]>>;
    try {
      by = await tracker.assignedBy(issue.identifier, identity);
    } catch (error) {
      if (isRateLimited(error)) {
        return { wanted: [], unplaced, limited: error };
      }
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
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
    });
  }
  return { wanted, unplaced };
}

/**
 * The assigned items split by who assigned them, and the claimed items; the
 * tracker's rate limit, when either read met it, instead of a reading
 * the limit cut short.
 */
async function trustedAndClaimed(
  tracker: Tracker,
  identity: string,
  issues: ReadonlyArray<PoolIssue>,
): Promise<
  | { limited: TrackerRateLimited }
  | {
      wanted: WantedItem[];
      unplaced: Unplaced[];
      claimed: Awaited<ReturnType<typeof readClaimed>>;
    }
> {
  const { wanted, unplaced, limited } = await byTrustedAssigner(
    tracker,
    issues,
    identity,
  );
  if (limited !== undefined) return { limited };
  try {
    return { wanted, unplaced, claimed: await readClaimed(tracker, identity) };
  } catch (error) {
    if (isRateLimited(error)) return { limited: error };
    throw error;
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
    (bound.signal.aborted || currentMs() >= bound.deadline)
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
 * lack one (an epic needs no size).
 */
async function readFactoryPickups(
  open: () => Tracker,
  section: DispatchSection,
  facets?: { bound: () => FacetBound },
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
  if (!assigned.ok && isRateLimited(assigned.failure.cause))
    return limitedFactory(tracker, identity, assigned.failure.cause, stores);
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
  const read = await trustedAndClaimed(tracker, identity, issues);
  if ("limited" in read)
    return limitedFactory(tracker, identity, read.limited, stores);
  const { wanted, unplaced, claimed } = read;
  if (!Array.isArray(claimed)) unplaced.push(claimed);
  const record =
    stores === undefined || facets === undefined
      ? undefined
      : withGaps(stores, issues);
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
  policy?: ServedPolicy,
  pooled?: boolean,
): Promise<PoolIssue | string> {
  if (section.identity === null) return "dispatch.identity is no longer set";
  // A pool pickup stays one: an assignment since the plan read it must not
  // move it to the assigned lane, whose checks are the assigner's alone.
  if (pooled === true) return freshPoolPickup(tracker, section, key, policy);
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
  const unassigned = `it is no longer assigned to ${section.identity} in ${section.states.join(", ")}`;
  if (issue === undefined && section.pool !== undefined) {
    // Not assigned: a pickup from the ready pool, read again as one.
    const pooled = await freshPoolPickup(tracker, section, key, policy);
    return typeof pooled === "string"
      ? `${unassigned}, and not ready in the pool: ${pooled}`
      : pooled;
  }
  if (issue === undefined) return unassigned;
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
  facets?: { bound: () => FacetBound },
  served?: {
    cache?: import("../pickup-reads.ts").PickupReads;
    people: readonly ServedPerson[];
    nowMs: number;
    headroom: boolean;
    hitl?: string;
    manualOps?: string;
    executionPlanBlock?: string;
    repoScope?: import("./served-repo.ts").RepoScope;
    views?: import("./served-reads.ts").ServedViews;
    unlabeled?: import("./served-repo.ts").UnlabeledMode;
    trackerNamespace?: string;
  },
): Promise<TrackerReading> {
  let tracker: Tracker | undefined;
  const once = () => (tracker ??= open());
  const factory = withPool(
    await readFactoryPickups(once, section, facets),
    await readPool(once, section, served, facets?.bound()),
    once,
  );
  if (served === undefined || served.people.length === 0) return factory;
  const extra = await readServedPickups(once(), served.people, {
    ...(served.cache === undefined ? {} : { cache: served.cache }),
    nowMs: served.nowMs,
    headroom: served.headroom,
    ...(served.hitl === undefined ? {} : { hitl: served.hitl }),
    ...(served.manualOps === undefined ? {} : { manualOps: served.manualOps }),
    ...(served.executionPlanBlock === undefined
      ? {}
      : { executionPlanBlock: served.executionPlanBlock }),
    ...(served.repoScope === undefined ? {} : { repoScope: served.repoScope }),
    ...(served.views === undefined ? {} : { views: served.views }),
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
    unplaced: onceEach([...factory.unplaced, ...extra.unplaced]),
    // A queue the rate limit stopped part way, or one that failed to read,
    // was not read whole: its claims are not known, so no ended pickup is released or judged on it.
    claimed:
      factory.claimed === null ||
      extra.limitedUntil !== undefined ||
      extra.incomplete === true
        ? null
        : [
            ...new Map(
              // The identity's own reading wins: its claims are dispatch's whoever is served.
              [...extra.claimed, ...factory.claimed].map((i) => [i.key, i]),
            ).values(),
          ],
  };
}

/**
 * The ready pool's reading, `null` when the repository has none; with the
 * tick's served options, its policy and the kept reads apply.
 */
async function readPool(
  open: () => Tracker,
  section: DispatchSection,
  served: (ServedPolicy & { cache?: PickupReads }) | undefined,
  bound?: FacetBound,
): Promise<Awaited<ReturnType<typeof readPoolPickups>> | null> {
  if (section.pool === undefined || section.identity === null) return null;
  return readPoolPickups(
    open(),
    section,
    served,
    served === undefined ? undefined : (served.cache ?? pickupReads),
    bound,
  );
}

/**
 * The factory's reading with the ready pool's pickups after its own, an item
 * both readings want kept once; the pool's rate limit or failure is named
 * in its rows, and leaves the claims as the factory read them.
 */
function withPool(
  factory: TrackerReading,
  pool: Awaited<ReturnType<typeof readPoolPickups>> | null,
  open: () => Tracker,
): TrackerReading {
  if (pool === null) return factory;
  const keys = new Set(factory.wanted.map((i) => i.key));
  const detail =
    pool.limited !== undefined
      ? `the ready pool (${pool.states}) waits for the tracker's rate limit to reset`
      : pool.failed === true
        ? `the ready pool (${pool.states}) was not read`
        : `${pool.read} unassigned item(s) in the ready pool (${pool.states}), ${pool.wanted.length} made ready by a person with write access`;
  return {
    ...factory,
    read: { ...factory.read, detail: `${factory.read.detail}; ${detail}` },
    wanted: [...factory.wanted, ...pool.wanted.filter((i) => !keys.has(i.key))],
    unplaced: onceEach([
      ...factory.unplaced,
      ...pool.unplaced,
      ...(pool.limited === undefined ? [] : [limitedRow(open(), pool.limited)]),
    ]),
  };
}

/**
 * The factory's reading when the tracker's rate limit refused it: one
 * limited row, no record failed (the wall is not the repository's failure),
 * and no claims, so nothing is released or judged stalled on a reading
 * that was not taken.
 */
function limitedFactory(
  tracker: Tracker,
  identity: string,
  limited: Parameters<typeof limitedRow>[1],
  stores: FacetRecord | undefined,
): TrackerReading {
  return {
    read: {
      record: "tracker",
      source: `${tracker.adapter} ${tracker.team}`,
      ok: true,
      detail: `the items assigned to ${identity} wait for the tracker's rate limit to reset`,
      ...(stores === undefined ? {} : { facets: stores }),
    },
    wanted: [],
    unplaced: [limitedRow(tracker, limited)],
    claimed: null,
  };
}

/** The rows, a tracker's rate-limit row kept once whichever read met the limit first. */
function onceEach(rows: Unplaced[]): Unplaced[] {
  const limited = new Set<string>();
  return rows.filter((row) => {
    if (!row.reason.startsWith("the tracker is rate limited until"))
      return true;
    if (limited.has(row.target)) return false;
    limited.add(row.target);
    return true;
  });
}
