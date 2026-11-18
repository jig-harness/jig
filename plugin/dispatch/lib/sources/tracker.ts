import { factoryWalkView } from "./factory-walk-view.ts";
/**
 * The pickups the tracker wants: the items assigned to the repository's
 * factory identity (`dispatch.identity`) in a dispatch state
 * (`dispatch.states`), read through the tracker interface. Only an
 * assignment a person with write access made starts a pickup, so each item's
 * current assignment is traced to its maker (`trusted-assigner.ts`); an item
 * whose assigner cannot write, or whose history cannot be read, is reported
 * and never planned.
 *
 * With a ready pool (`dispatch.pool`), the unassigned items in its states
 * are pickups too, trusted by who made them ready (`ready-pool.ts`).
 *
 * Beside them, the items the identity claimed (in its in-progress state),
 * which the plan watches for stalls and double claims; and the fresh read a
 * pickup's launch makes just before it starts.
 *
 * In a tick its launcher bounds, the reads after the facet read keep to the
 * tick's own bound (`bounded.ts`): who assigned each item, the claimed
 * items and their claim markers. An item whose assigner the bound ended
 * before is unplaced with why, and claimed items it ended before are not
 * known, as when their read fails; each is a failed read, so the tick
 * reports it.
 */
import { cacheForTracker } from "./tracker-cache.ts";
import { sharedView, type ServedView } from "./served-reads.ts";
import { nativeQueueRequirements } from "../../../skills/do-item/scripts/lib/tracker/dispatch-source.ts";
import { type AssignedBy, byTrustedAssigner } from "./trusted-assigner.ts";
import { scopeFailureRow } from "./scope-failures.ts";
import type { ServedPerson } from "../serve-config.ts";
import { type PickupReads, pickupReads } from "../pickup-reads.ts";
import {
  CUT_AT_BOUND,
  ended,
  heldTo,
  passedBefore,
  within,
} from "./bounded.ts";
import { markClaims } from "./claim-markers.ts";
import { freshPoolPickup, readPoolPickups } from "./ready-pool.ts";
import { claimsUnreadRow, limitedRow } from "./served-failures.ts";
import {
  readServedPickups,
  freshServedPickup,
  type ServedPolicy,
  type ServedOptions,
} from "./served.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/outbound/budget.ts";
import {
  type CanonicalState,
  type PoolIssue,
  type Tracker,
  workingStates,
  isWorkingIssue,
  trackerStateMaps,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  type Failure,
  failed,
  ok,
  type Outcome,
} from "../../../shared/outcome.ts";
import {
  combinedFailure,
  readFailureOf,
  readFailureOfError,
} from "../read-failures.ts";
import { failureText } from "../text.ts";
import { failedBy, outboundFailure } from "../../../shared/outbound/failure.ts";
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
  ReadFailure,
  RecordRead,
  Unplaced,
  WantedItem,
} from "../types.ts";
import { currentMs } from "../../../shared/time.ts";

export interface TrackerReading {
  /** Full started epic rows retained from the existing claimed read. */
  epicRoots?: PoolIssue[];
  factoryView?: ServedView;
  read: RecordRead;
  wanted: WantedItem[];
  unplaced: Unplaced[];
  /**
   * The items assigned to the identity in its in-progress state, the claims
   * to watch; `null` when they could not be read (named in `unplaced`).
   */
  claimed: ClaimedItem[] | null;
  /**
   * A served queue's item, or a queue the rate limit stopped part way, was
   * not read: the wanted items are not all known, though the claims may be.
   */
  partial?: true;
}

/**
 * The claimed items, in `in_progress` or (where the repository names it)
 * `pr_open`: the claim's own assignment needs no assigner check, since
 * nothing is started for them.
 */
async function readClaimed(
  tracker: Tracker,
  identity: string,
  tick?: FacetBound,
): Promise<Array<ClaimedItem & { queueIssue: PoolIssue }> | Unplaced> {
  const unread = (why: string, cut?: ReadFailure): Unplaced => ({
    target: `items in ${workingNames(tracker)}`,
    record: "tracker",
    reason: `the items ${identity} claimed could not be read, so stalls and double claims are not checked: ${why}`,
    readFailed: true,
    ...(cut === undefined ? {} : { failure: cut }),
  });
  if (ended(tick)) return unread(passedBefore("they were read"), CUT_AT_BOUND);
  try {
    const issues = await heldTo(
      (signal) =>
        tracker.assignedIssues(
          identity,
          workingStates(tracker),
          tick === undefined || signal === undefined
            ? undefined
            : { signal, deadline: tick.deadline },
        ),
      tick,
    );
    return issues
      .filter(
        (i) => tracker.stateMaps === undefined || isWorkingIssue(tracker, i),
      )
      .map((i) => ({
        key: i.identifier,
        queueIssue: i,
        title: i.title,
        url: i.url,
        state: i.state.name,
        ...(i.nativeType === undefined ? {} : { nativeType: i.nativeType }),
        ...(i.updatedAt === undefined ? {} : { updatedAt: i.updatedAt }),
      }));
  } catch (error) {
    if (isRateLimited(error)) throw error;
    return unread(
      failureText(error),
      readFailureOfError(error) ?? (ended(tick) ? CUT_AT_BOUND : undefined),
    );
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
 * The assigned items split by who assigned them, and the claimed items; the
 * tracker's rate limit, when either read met it, instead of a reading
 * the limit cut short.
 */
async function trustedAndClaimed(
  tracker: Tracker,
  identity: string,
  issues: ReadonlyArray<PoolIssue>,
  cache: PickupReads,
  view?: ServedView,
  tick?: FacetBound,
): Promise<
  | { limited: TrackerRateLimited; unplaced: Unplaced[] }
  | {
      wanted: WantedItem[];
      unplaced: Unplaced[];
      claimed: Awaited<ReturnType<typeof readClaimed>>;
      assigners: Map<string, AssignedBy>;
    }
> {
  const { wanted, unplaced, limited, assigners } = await byTrustedAssigner(
    tracker,
    issues,
    identity,
    cache,
    view,
    tick,
  );
  if (limited !== undefined) return { limited, unplaced };
  try {
    return {
      wanted,
      unplaced,
      assigners,
      claimed:
        view === undefined
          ? await readClaimed(tracker, identity, tick)
          : view.progress().map((i) => ({
              key: i.identifier,
              queueIssue: i,
              title: i.title,
              url: i.url,
              state: i.state.name,
              ...(i.updatedAt === undefined ? {} : { updatedAt: i.updatedAt }),
              ...(i.nativeType === undefined
                ? {}
                : { nativeType: i.nativeType }),
            })),
    };
  } catch (error) {
    if (isRateLimited(error)) return { limited: error, unplaced };
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
    return failedBy(
      "stopped",
      outboundFailure("unreachable", passedBefore("the read could start")),
      passedBefore("the read could start"),
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

/** The failure class of a read the tracker did not answer, when a call failed it. */
function failureField(failure: Failure): { failure?: ReadFailure } {
  const read = readFailureOf(failure);
  return read === undefined ? {} : { failure: read };
}

/** The assigned lane is absent when the repository names no factory identity. */
function noFactory(): TrackerReading {
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
}

/** Keep claims unknown whenever the assigned queue could not be read. */
function failedFactory(
  source: string,
  identity: string,
  reason: string,
  stores: FacetRecord | undefined,
  failure?: Failure,
): TrackerReading {
  return {
    read: {
      record: "tracker",
      source,
      ok: false,
      detail: `the items assigned to ${identity} could not be read: ${reason}`,
      ...(failure === undefined ? {} : failureField(failure)),
      ...(stores === undefined ? {} : { facets: stores }),
    },
    wanted: [],
    unplaced: [],
    claimed: null,
  };
}

/** The repository's dispatch states applied to its own projection of the native queue. */
function factoryItems(
  tracker: Tracker,
  section: DispatchSection,
  view: ServedView,
): PoolIssue[] {
  const all = view.all?.() ?? [
    ...view.open().map((h) => h.issue),
    ...view.progress(),
  ];
  return all.filter((issue) =>
    section.states.some(
      (state) =>
        tracker
          .stateName(state as CanonicalState, issue.nativeType ?? null)
          ?.trim()
          .toLowerCase() === issue.state.name.trim().toLowerCase(),
    ),
  );
}

/** Native adapters consume the queue the tick prefetched; other adapters keep their bounded assigned read. */
async function factoryView(
  tracker: Tracker,
  identity: string,
  served: ServedOptions | undefined,
  cache: PickupReads,
  bound: FacetBound | undefined,
  states: readonly CanonicalState[],
): Promise<ServedView | undefined> {
  if (tracker.dispatchSource === undefined || served === undefined)
    return undefined;
  tracker.dispatchSource.configure?.([
    ...(tracker.dispatchSource.requirements ?? []),
    ...nativeQueueRequirements(tracker, states),
  ]);
  const view = await sharedView(
    served.views,
    tracker,
    identity,
    { ...served, ...(bound === undefined ? {} : { bound }) },
    cache,
  );
  view.save();
  return view;
}

/** A scope that did not answer leaves one aged row and no authoritative claims. */
function unavailableFactory(
  tracker: Tracker,
  identity: string,
  view: ServedView,
  stores: FacetRecord | undefined,
): TrackerReading {
  const source = `${tracker.adapter} ${tracker.team}`;
  const row = scopeFailureRow(
    tracker,
    view,
    view.unavailable ?? "the scope could not be read",
  );
  const cause = view.unavailableCause;
  const failed = failedFactory(
    source,
    identity,
    row.reason,
    stores,
    cause === undefined
      ? undefined
      : { code: "unreadable", reason: row.reason, cause },
  );
  failed.unplaced.push(row);
  return failed;
}

/**
 * The pickups; `open` opens the tracker, and is not called when there are
 * none to read. With `facets`, the record also says where the tracker
 * keeps each issue facet, read first and within `facets.bound` so a
 * detection the reads depend on is bounded too, and which assigned items
 * lack one (an epic needs no size); the reads after it keep to
 * `facets.tick`, the tick's own bound, where the tick has one.
 */
async function readFactoryPickups(
  open: () => Tracker,
  section: DispatchSection,
  facets?: PickupBounds,
  cache: PickupReads = pickupReads,
  served?: ServedOptions,
): Promise<TrackerReading> {
  if (section.identity === null) return noFactory();
  const identity = section.identity;
  const tracker = open();
  cache = cacheForTracker(tracker, cache);
  const source = `${tracker.adapter} ${tracker.team}`;
  // One bound for the whole facet read: the stores and the assigned items
  // share its allowance and its cancellation.
  const bound = facets?.bound();
  const tick = tickOf(facets);
  // The diagnostic report gets its own share of the allowance, so a slow
  // report leaves the assigned-item read its time.
  const stores =
    bound === undefined
      ? undefined
      : await readFacetStores(tracker, reportBound(bound));
  const view = await factoryView(
    tracker,
    identity,
    served,
    cache,
    bound,
    section.states as CanonicalState[],
  );
  if (view?.limited)
    return limitedFactory(tracker, identity, view.limited, stores, view);
  if (view?.unavailable !== undefined)
    return unavailableFactory(tracker, identity, view, stores);
  const assigned =
    view === undefined
      ? await readAssigned(tracker, identity, section, bound)
      : ok(factoryItems(tracker, section, view));
  if (!assigned.ok && isRateLimited(assigned.failure.cause))
    return limitedFactory(
      tracker,
      identity,
      assigned.failure.cause,
      stores,
      view,
    );
  if (!assigned.ok)
    return failedFactory(
      source,
      identity,
      assigned.failure.reason,
      stores,
      assigned.failure,
    );
  const issues = assigned.value;
  const read = await trustedAndClaimed(
    tracker,
    identity,
    issues,
    cache,
    view,
    tick,
  );
  if ("limited" in read) {
    const limited = limitedFactory(
      tracker,
      identity,
      read.limited,
      stores,
      view,
    );
    limited.unplaced.unshift(...read.unplaced);
    return limited;
  }
  if (view?.unavailable !== undefined) {
    const unavailable = unavailableFactory(tracker, identity, view, stores);
    unavailable.unplaced.unshift(...read.unplaced);
    return unavailable;
  }
  const { wanted, unplaced } = read;
  const claimed = await scopedClaims(
    tracker,
    identity,
    section,
    read.claimed,
    cache,
    tick,
  );
  unplaced.push(...claimed.unplaced);
  const record = factoryFacetRecord(stores, facets, issues);
  return {
    read: {
      record: "tracker",
      source,
      ok: true,
      detail: `${issues.length} item(s) assigned to ${identity} in ${section.states.join(", ")}${claimed.items === null ? "" : `; ${claimed.items.length} in ${workingNames(tracker)}`}${record === undefined ? "" : `; ${facetSummary(record)}`}`,
      ...(record === undefined ? {} : { facets: record }),
    },
    wanted,
    unplaced,
    epicRoots: epicRootsOf(read.claimed),
    factoryView:
      view ??
      factoryWalkView(
        tracker,
        identity,
        issues,
        progressRows(read.claimed),
        read.assigners,
        tick ?? bound,
      ),
    claimed: claimed.items,
  };
}

/** Facet gaps belong to a report only when that read was requested. */
function factoryFacetRecord(
  stores: FacetRecord | undefined,
  facets: PickupBounds | undefined,
  issues: PoolIssue[],
): FacetRecord | undefined {
  return stores === undefined || facets === undefined
    ? undefined
    : withGaps(stores, issues);
}

function progressRows(
  claimed: Array<ClaimedItem & { queueIssue: PoolIssue }> | Unplaced,
): PoolIssue[] {
  return Array.isArray(claimed) ? claimed.map((row) => row.queueIssue) : [];
}

/** Full epic rows already paid for by the claimed-item read. */
function epicRootsOf(
  claimed: Array<ClaimedItem & { queueIssue: PoolIssue }> | Unplaced,
): PoolIssue[] {
  if (!Array.isArray(claimed)) return [];
  return claimed
    .map((c) => c.queueIssue)
    .filter((i) => i.isEpic && i.hasOpenChildren);
}

/**
 * The claimed items as the stall watch reads them, with the rows for what
 * could not be read: under `dispatch.stalled_scope: claimed`, each marked
 * with the claim marker on it (`markClaims`); `null` items when they could
 * not be read at all.
 */
async function scopedClaims(
  tracker: Tracker,
  identity: string,
  section: DispatchSection,
  claimed: ClaimedItem[] | Unplaced,
  cache: PickupReads,
  tick?: FacetBound,
): Promise<{ items: ClaimedItem[] | null; unplaced: Unplaced[] }> {
  if (!Array.isArray(claimed)) return { items: null, unplaced: [claimed] };
  if (section.stalledScope !== "claimed")
    return { items: claimed, unplaced: [] };
  const marks = await markClaims(tracker, identity, claimed, cache, tick);
  return { items: marks.claimed, unplaced: marks.unplaced };
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
  factoryAncestor?: string,
): Promise<PoolIssue | string> {
  if (section.identity === null) return "dispatch.identity is no longer set";
  if (factoryAncestor !== undefined)
    return freshServedPickup(
      tracker,
      key,
      section.identity,
      factoryAncestor,
      policy,
    );
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

/** The tick's served input as the options a served read takes: everything but the people. */
function servedReadOptions<T extends { people: readonly ServedPerson[] }>(
  served: T,
): Omit<T, "people"> {
  const { people: _people, ...options } = served;
  return options;
}

/**
 * How the pickups' tracker reads are bounded: `bound` makes the facet
 * read's own bound as it starts, and `tick`, where the tick has one, is the
 * tick's bound that the reads after it keep to.
 */
export interface PickupBounds {
  bound: () => FacetBound;
  tick?: FacetBound | undefined;
}

/** The tick's own bound in `facets`, where the tick has one. */
function tickOf(facets: PickupBounds | undefined): FacetBound | undefined {
  return facets?.tick;
}

/** Factory and host-served work share the same plan and capacity checks. */
export async function readPickups(
  open: () => Tracker,
  section: DispatchSection,
  facets?: PickupBounds,
  servedInput?: {
    cache?: import("../pickup-reads.ts").PickupReads;
    people: readonly ServedPerson[];
    nowMs: number;
    headroom: boolean;
    bound?: FacetBound;
    hitl?: string;
    manualOps?: string;
    executionPlanBlock?: string;
    mergeEvidence?: import("./plan-merges.ts").PlanMergeReader | undefined;
    repoScope?: import("./served-repo.ts").RepoScope;
    views?: import("./served-reads.ts").ServedViews;
    unlabeled?: import("./served-repo.ts").UnlabeledMode;
    trackerNamespace?: string;
    passOver?: import("./served-epics.ts").PassOver;
  },
): Promise<TrackerReading> {
  const served =
    servedInput === undefined
      ? undefined
      : { ...servedInput, views: servedInput.views ?? new Map() };
  let tracker: Tracker | undefined;
  const once = () => (tracker ??= open());
  const factoryReading = await readFactoryPickups(
    once,
    section,
    facets,
    served?.cache,
    served,
  );
  // A failed native scope is a wall for this tick: do not let the optional
  // ready-pool lane send unrelated tracker reads after it.
  const factory = withPool(
    factoryReading,
    factoryReading.claimed === null
      ? null
      : await readPool(once, section, served, facets?.bound()),
    once,
  );
  // A failed shared native scope is a wall for every lane. A factory-only
  // claim failure is not: served identities can still be read independently.
  if (
    factory.claimed === null &&
    once().dispatchSource !== undefined &&
    factoryReading.factoryView === undefined
  ) {
    const adapter = once().adapter as keyof ServedPerson["tracker"];
    const unchecked = (served?.people ?? []).flatMap((person) => {
      const identity = person.tracker[adapter];
      return identity === undefined
        ? []
        : [
            claimsUnreadRow(
              identity,
              "the tracker's scope failed before the queue was read",
            ),
          ];
    });
    return unchecked.length === 0
      ? factory
      : { ...factory, unplaced: onceEach([...factory.unplaced, ...unchecked]) };
  }
  const roots = [
    ...(factoryReading.epicRoots ?? []),
    ...factoryReading.wanted.flatMap((i) =>
      i.queueIssue === undefined ? [] : [i.queueIssue],
    ),
  ];
  if ((served?.people.length ?? 0) === 0 && roots.length === 0) return factory;
  const extra = await readServedPickups(once(), served?.people ?? [], {
    ...(served === undefined
      ? { nowMs: currentMs(), headroom: true }
      : servedReadOptions(served)),
    epicWidth: section.epicWidth,
    ...(section.identity === null
      ? {}
      : {
          factory: {
            identity: section.identity,
            roots,
            view: factoryReading.factoryView,
            eligible: new Set(factoryReading.wanted.map((item) => item.key)),
          },
        }),
  });
  const keys = new Set(extra.wanted.map((i) => i.key));
  const rejected = new Set(extra.unplaced.map((i) => i.target));
  return {
    read: servedRead(factory.read, extra),
    wanted: [
      ...extra.wanted,
      ...factory.wanted.filter(
        (i) => i.pooled === true && !keys.has(i.key) && !rejected.has(i.key),
      ),
    ],
    unplaced: onceEach([...factory.unplaced, ...extra.unplaced]),
    // A queue whose items in progress were not read leaves its claims
    // unknown, so none is judged on it. An item below the queue that did
    // not read leaves the claims known and only the wanted items partial.
    claimed:
      factory.claimed === null || extra.claimsUnknown === true
        ? null
        : [
            ...new Map(
              // The identity's own reading wins: its claims are dispatch's whoever is served.
              [...extra.claimed, ...factory.claimed].map((i) => [i.key, i]),
            ).values(),
          ],
    ...(extra.limitedUntil !== undefined ||
    extra.incomplete === true ||
    factory.partial === true
      ? { partial: true as const }
      : {}),
  };
}

/**
 * The aggregate record with the served lane's reading in it: a served queue,
 * or an item in it, whose read threw makes the record not ok, with the
 * failure's class, so settlement treats it as it does the identity's own
 * failed read. An item no read threw for (an answer that names no assigner, a
 * read the tracker cut short) is its own unplaced row and leaves the record
 * ok. The record keeps one failure for the identity's read and
 * every failed served read (`combinedFailure`), so it waits only when every
 * one of them clears by waiting.
 */
function servedRead(
  read: TrackerReading["read"],
  extra: Awaited<ReturnType<typeof readServedPickups>>,
): TrackerReading["read"] {
  const detail = `${read.detail}; ${extra.wanted.length} served pickup(s)`;
  if ((extra.failures ?? []).length === 0) return { ...read, detail };
  const failure = combinedFailure([
    ...(read.ok ? [] : [read.failure]),
    ...(extra.failures ?? []).map((cause) =>
      cause === undefined
        ? undefined
        : readFailureOf({
            code: "unreadable",
            reason: failureText(cause),
            cause,
          }),
    ),
  ]);
  // The record's failure is the combined one alone: the read's own is in it.
  const { failure: _own, ...rest } = read as typeof read & {
    failure?: ReadFailure;
  };
  return {
    ...rest,
    ok: false,
    detail: `${detail}; a served queue could not be read`,
    ...(failure === undefined ? {} : { failure }),
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
    // A pool that was not read may hold an ended pickup's item: the reading
    // is partial, so its record is kept.
    ...(pool.limited !== undefined || pool.failed === true
      ? { partial: true as const }
      : {}),
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
  view?: ServedView,
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
    unplaced: [limitedRow(tracker, limited, view)],
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
