/**
 * The served walk's reads of one tracker, team and person: one queue read,
 * the issues it names read by key in batches, and a change probe that lets
 * a tick reuse the previous reading whole.
 *
 * - **One queue read.** The issues assigned to the person, open, blocked and
 *   in progress, with each one's relations (and the other issue's state) and
 *   its parent (with its description), in one paged request where the
 *   adapter has `queueIssues`; otherwise the two assigned lists.
 * - **Batched lookups.** Every issue the walk reads by key goes through one
 *   loader: the reads one step of the walk asks for together leave as one
 *   paged request (per key where the adapter has none), and an issue read
 *   once is not read again in the tick. Where the adapter has
 *   `queueIssuesByKey` the request carries each issue's relations and parent
 *   too, so the walk does not read them issue by issue afterwards (`held`,
 *   `parentBody`); otherwise it is `poolIssues`.
 * - **The change probe.** The reading is kept between ticks (`pickup_reads`,
 *   under `<adapter>:<team>:queue:<identity>`). Where the adapter has
 *   `changedSince`, a tick asks once whether any issue the reading depended
 *   on, or any issue newly assigned to the person, changed since the
 *   reading; nothing changed reuses it whole, and a change re-reads the
 *   queue and only the issues that changed. Every `REREAD_MS` the reading is
 *   taken whole again, so a change the probe cannot see (a relation added
 *   between two issues that were not otherwise updated) is caught. A tick
 *   with no free slot (`headroom` false) reuses a reading younger than that
 *   without probing.
 * - **One read per tick.** Every repository of the machine file that names
 *   the same tracker, team and person is answered from the same view
 *   (`ServedViews`, kept for one tick).
 * - **A rate limit is a wall.** A read the machine's request budget refuses
 *   (`TrackerRateLimited`) leaves the view offline: the walk then runs over
 *   the kept reading alone, any read it would send fails the same way, and
 *   the walk reports the limit once (`served.ts`).
 */
import { cacheForTracker } from "./tracker-cache.ts";
import { ended, within } from "./bounded.ts";
import type { FacetBound } from "./tracker-facets.ts";
import { failureText } from "../text.ts";
import { nativeSharedView } from "./native-view.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  type PoolIssue,
  type QueueParent,
  type QueueRelation,
  type Tracker,
  workingStates,
  isWorkingIssue,
  trackerStateMaps,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";

/** How old a reading may be before it is taken whole again. */
const REREAD_MS = 15 * 60_000;
/** How far before a full read the next probe looks, for the clocks of the host and the tracker. */
const SKEW_MS = 60_000;

const OPEN = ["triage", "backlog", "todo"] as const;

/** An assigned issue as the queue read holds it; `parent` is `undefined` when the read did not carry it. */
export interface HeldIssue {
  issue: PoolIssue;
  relations: QueueRelation[] | null;
  parent: QueueParent | null | undefined;
}

interface Snapshot {
  version: 1;
  shape?: string;
  /** When the queue was last read whole or in part (the tick's clock). */
  readAt: number;
  /** When the reading was last taken whole. */
  fullAt: number;
  /** The probe's watermark: changes after it count. */
  since: string;
  open: HeldIssue[];
  progress: PoolIssue[];
  pool: Record<string, PoolIssue | null>;
}

/** How the view was made, for the receipt and the tests. */
export type ViewSource = "kept" | "unchanged" | "changed" | "full" | "offline";

/** What the walk reads through. */
export interface ServedView {
  readonly source: ViewSource;
  readonly scope?: string;
  readonly bound?: FacetBound;
  /** A shared transport failure, with the kept reading still available. */
  readonly unavailable?: string | undefined;
  /** What the shared transport threw, which carries the failure's class. */
  readonly unavailableCause?: unknown;
  /** The refusal that left the view offline; `null` when it is online. */
  readonly limited: TrackerRateLimited | null;
  /** When the reading the view holds was taken. */
  readonly readAt: number;
  /** The assigned issues in the open states and the `blocked` state (the dispatch's queue). */
  open(): HeldIssue[];
  /** Every projected native row, before the served queue narrows its states. */
  all?(): PoolIssue[];
  /** The assigned issues in progress. */
  progress(): PoolIssue[];
  /** One issue by key, from the tick's reads or in the next batch. */
  pool(key: string): Promise<PoolIssue | null>;
  raw?(
    key: string,
  ): Promise<
    | import("../../../skills/do-item/scripts/lib/tracker/port.ts").DispatchRawIssue
    | null
  >;
  /** What the queue read carried of an issue: its relations and parent. */
  held(key: string): HeldIssue | undefined;
  /** The parent the queue read carried with its description, by the parent's key. */
  parentBody(key: string): QueueParent | undefined;
  /** `read` once per `key` in the tick, every repository sharing the view waiting on the same read. */
  once<T>(key: string, read: () => Promise<T>): Promise<T>;
  /** Keep the reading for the next tick. */
  save(): void;
}

/** The views of one tick, shared by its repositories. */
export type ServedViews = Map<string, Promise<ServedView>>;

function snapshotOf(value: unknown): Snapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Partial<Snapshot>;
  return s.version === 1 &&
    typeof s.readAt === "number" &&
    typeof s.fullAt === "number" &&
    typeof s.since === "string" &&
    Array.isArray(s.open) &&
    Array.isArray(s.progress) &&
    typeof s.pool === "object" &&
    s.pool !== null
    ? (s as Snapshot)
    : null;
}

/** The keys a reading depended on: what the probe watches. */
function watched(s: Snapshot): string[] {
  const keys = new Set<string>(Object.keys(s.pool));
  for (const h of s.open) {
    keys.add(h.issue.identifier);
    for (const r of h.relations ?? []) keys.add(r.issue);
    if (h.parent) keys.add(h.parent.issue.identifier);
  }
  for (const p of s.progress) keys.add(p.identifier);
  return [...keys];
}

/**
 * The states the queue read asks for beyond the open ones: the tracker's
 * `blocked` state when the repository names one. An item in it is not a
 * pickup, but an epic in it still has children the walk may start.
 */
const blockedStates = (tracker: Tracker): CanonicalState[] =>
  trackerStateMaps(tracker).some((map) => map.blocked !== null)
    ? ["blocked"]
    : [];

/** The queue, read in one request where the adapter can. */
async function readQueue(
  tracker: Tracker,
  identity: string,
): Promise<{ open: HeldIssue[]; progress: PoolIssue[] }> {
  if (tracker.queueIssues === undefined) {
    const open = await tracker.assignedIssues(identity, [
      ...OPEN,
      ...blockedStates(tracker),
    ]);
    const progress = await tracker.assignedIssues(
      identity,
      workingStates(tracker),
    );
    return {
      open: open.map((issue) => ({
        issue,
        relations: null,
        parent: undefined,
      })),
      progress: progress.filter(
        (issue) =>
          tracker.stateMaps === undefined || isWorkingIssue(tracker, issue),
      ),
    };
  }
  const working = workingStates(tracker);
  const read = await tracker.queueIssues(identity, [
    ...OPEN,
    ...blockedStates(tracker),
    ...working,
  ]);
  const open: HeldIssue[] = [];
  const progress: PoolIssue[] = [];
  for (const { relations, parent, ...issue } of read)
    if (isWorkingIssue(tracker, issue)) progress.push(issue);
    else open.push({ issue, relations, parent });
  return { open, progress };
}

/** How many reads of single issues a view sends at once. */
const IN_FLIGHT = 6;

/** A limit on the reads in flight: at most `size` at once, the rest queued in order. */
function semaphore(size: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= size)
      await new Promise<void>((go) => {
        waiting.push(go);
      });
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

type Gate = ReturnType<typeof semaphore>;

/** What a batch read carried of an issue besides the issue: handed on as the queue read's. */
type Carry = (key: string, held: HeldIssue) => void;

/** The read of one key waiting for its batch. */
interface Waiter {
  resolve: (v: PoolIssue | null) => void;
  reject: (e: unknown) => void;
}

type Batch = Map<string, Waiter>;

/** The keys of `batch` read on their own, one at a time. */
function readEach(
  tracker: Tracker,
  keys: Iterable<[string, Waiter]>,
  gate: Gate,
): Promise<unknown> {
  return Promise.all(
    [...keys].map(([key, waiter]) =>
      gate(() => tracker.poolIssue(key)).then(waiter.resolve, waiter.reject),
    ),
  );
}

/**
 * One batch read the tracker may refuse: `read` settles the batch and
 * answers true; a refusal by the rate limit refuses each key alike (true);
 * any other failure answers false, so the batch is read another way and one
 * bad issue fails only itself.
 */
async function settleBatch(
  batch: Batch,
  read: () => Promise<void>,
): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    if (!isRateLimited(error)) return false;
    for (const waiter of batch.values()) waiter.reject(error);
    return true;
  }
}

/** The batch with each issue's relations and parent, handed to `carry`; a key the batch did not hold is read on its own (it may have moved out of the team). */
async function readWithRelations(
  tracker: Tracker,
  batch: Batch,
  gate: Gate,
  carry: Carry,
): Promise<void> {
  const read =
    (await tracker.queueIssuesByKey?.([...batch.keys()])) ?? new Map();
  const alone: Array<[string, Waiter]> = [];
  for (const [key, waiter] of batch) {
    const found = read.get(key);
    if (found === undefined) {
      alone.push([key, waiter]);
      continue;
    }
    const { relations, parent, ...issue } = found;
    carry(key, { issue, relations, parent });
    waiter.resolve(issue);
  }
  await readEach(tracker, alone, gate);
}

/** The batch as pool issues alone. */
async function readPooled(tracker: Tracker, batch: Batch): Promise<void> {
  const read = (await tracker.poolIssues?.([...batch.keys()])) ?? new Map();
  for (const [key, waiter] of batch) waiter.resolve(read.get(key) ?? null);
}

/** A loader that gathers the keys asked for in one turn of the event loop into one read. */
function loader(
  tracker: Tracker,
  memo: Map<string, Promise<PoolIssue | null>>,
  refusal: () => unknown | null,
  gate: Gate,
  carry: Carry,
) {
  let queued: Batch = new Map();
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const batch = queued;
    queued = new Map();
    if (
      tracker.queueIssuesByKey !== undefined &&
      (await settleBatch(batch, () =>
        readWithRelations(tracker, batch, gate, carry),
      ))
    )
      return;
    if (
      tracker.poolIssues !== undefined &&
      (await settleBatch(batch, () => readPooled(tracker, batch)))
    )
      return;
    await readEach(tracker, batch, gate);
  };
  return (key: string): Promise<PoolIssue | null> => {
    const kept = memo.get(key);
    if (kept !== undefined) return kept;
    const offline = refusal();
    const read =
      offline !== null
        ? Promise.reject(offline)
        : new Promise<PoolIssue | null>((resolve, reject) => {
            queued.set(key, { resolve, reject });
            if (!scheduled) {
              scheduled = true;
              setTimeout(() => void flush(), 0);
            }
          });
    memo.set(key, read);
    return read;
  };
}

interface Plan {
  bound?: FacetBound;
  source: ViewSource;
  snapshot: Snapshot | null;
  /** Keys whose kept reading no longer holds. */
  stale: ReadonlySet<string> | "all";
  since: string;
  limited: TrackerRateLimited | null;
  unavailable?: string;
  unavailableCause?: unknown;
}

/** Whether the kept reading serves, needs part re-read, or must be taken whole. */
async function plan(
  tracker: Tracker,
  identity: string,
  kept: Snapshot | null,
  nowMs: number,
  headroom: boolean,
): Promise<Plan> {
  const full: Plan = {
    source: "full",
    snapshot: null,
    stale: "all",
    since: new Date(nowMs - SKEW_MS).toISOString(),
    limited: null,
  };
  if (kept === null || nowMs - kept.fullAt >= REREAD_MS) return full;
  if (!headroom)
    return {
      ...full,
      source: "kept",
      snapshot: kept,
      stale: new Set(),
      since: kept.since,
    };
  if (tracker.changedSince === undefined) return full;
  const answer = await tracker.changedSince({
    since: kept.since,
    identity,
    keys: watched(kept),
  });
  if (answer.keys.length === 0)
    return {
      ...full,
      source: "unchanged",
      snapshot: kept,
      stale: new Set(),
      since: kept.since,
    };
  if (!answer.complete) return full;
  return {
    ...full,
    source: "changed",
    snapshot: kept,
    stale: new Set(answer.keys),
    since:
      answer.latest !== null && answer.latest > kept.since
        ? answer.latest
        : kept.since,
  };
}

/** The view over a kept reading alone, every read it would send refused with `limited`. */
function offlineView(
  tracker: Tracker,
  kept: Snapshot | null,
  limited: TrackerRateLimited,
): ServedView {
  return assemble(tracker, {
    source: "offline",
    snapshot: kept,
    stale: new Set(),
    since: kept?.since ?? "",
    limited,
  });
}

/** A scope failure refuses every missing fact alike, without another request. */
function offlineReason(p: Plan): unknown | null {
  if (ended(p.bound)) return new Error("stopped at the tick’s deadline");
  if (p.limited !== null) return p.limited;
  return p.unavailable === undefined ? null : new Error(p.unavailable);
}

function factReader(p: Plan, gate: Gate): ServedView["once"] {
  const reads = new Map<string, Promise<unknown>>();
  return <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let kept = reads.get(key) as Promise<T> | undefined;
    if (kept === undefined) {
      kept =
        p.source === "offline" || ended(p.bound)
          ? Promise.reject(
              offlineReason(p) ?? new Error("the tracker is offline"),
            )
          : p.bound === undefined
            ? gate(read)
            : within(gate(read), p.bound);
      reads.set(key, kept);
    }
    return kept;
  };
}

/** Seed one view from unchanged pool rows and the fresher assigned queue. */
function seedReading(
  p: Plan,
  open: HeldIssue[],
  progress: PoolIssue[],
  remember: (key: string, value: PoolIssue | null) => void,
  held: Map<string, HeldIssue>,
  parents: Map<string, QueueParent>,
): void {
  const kept = p.snapshot;
  if (kept !== null && p.stale !== "all")
    for (const [key, value] of Object.entries(kept.pool))
      if (!p.stale.has(key)) remember(key, value);
  for (const h of open) {
    held.set(h.issue.identifier, h);
    remember(h.issue.identifier, h.issue);
    if (h.parent) {
      parents.set(h.parent.issue.identifier, h.parent);
      remember(h.parent.issue.identifier, h.parent.issue);
    }
  }
  for (const issue of progress) remember(issue.identifier, issue);
}

function assemble(
  tracker: Tracker,
  p: Plan,
  queue?: { open: HeldIssue[]; progress: PoolIssue[] },
  save?: (s: Snapshot) => void,
  nowMs = 0,
): ServedView {
  const kept = p.snapshot;
  const open = queue?.open ?? kept?.open ?? [];
  const progress = queue?.progress ?? kept?.progress ?? [];
  const memo = new Map<string, Promise<PoolIssue | null>>();
  const resolved = new Map<string, PoolIssue | null>();
  const remember = (key: string, value: PoolIssue | null) => {
    resolved.set(key, value);
    memo.set(key, Promise.resolve(value));
  };
  const held = new Map<string, HeldIssue>();
  const parents = new Map<string, QueueParent>();
  seedReading(p, open, progress, remember, held, parents);
  const gate = semaphore(IN_FLIGHT);
  const load = loader(
    tracker,
    memo,
    () => offlineReason(p),
    gate,
    (key, h) => {
      // What the queue read carried of an issue is the fresher reading.
      if (!held.has(key)) held.set(key, h);
      if (h.parent) {
        if (!parents.has(h.parent.issue.identifier))
          parents.set(h.parent.issue.identifier, h.parent);
        remember(h.parent.issue.identifier, h.parent.issue);
      }
    },
  );
  const readAt = queue === undefined ? (kept?.readAt ?? 0) : nowMs;
  return {
    source: p.source,
    ...(p.bound === undefined ? {} : { bound: p.bound }),
    ...(p.unavailable === undefined
      ? {}
      : { unavailable: p.unavailable, unavailableCause: p.unavailableCause }),
    limited: p.limited,
    readAt,
    open: () => open,
    progress: () => progress,
    async pool(key) {
      const value = await load(key);
      resolved.set(key, value);
      return value;
    },
    held: (key) => held.get(key),
    parentBody: (key) => parents.get(key),
    once: factReader(p, gate),
    save() {
      if (save === undefined) return;
      save({
        version: 1,
        readAt,
        fullAt: p.source === "full" ? nowMs : (kept?.fullAt ?? nowMs),
        since: p.since,
        open,
        progress,
        pool: Object.fromEntries(resolved),
      });
    },
  };
}

const credentialScopes = new WeakMap<Tracker, string>();

/** Names the tracker an issue key belongs to: the adapter, its instance and its team. */
export function trackerScope(tracker: Tracker): string {
  return `${tracker.adapter}:${tracker.instance ?? ""}:${tracker.team}${credentialScopes.has(tracker) ? `:${credentialScopes.get(tracker)}` : ""}`;
}

/**
 * What the tracker's configuration makes of its issues: the state names and
 * the facet stores. Repositories that differ in either cannot share a reading.
 */
function configIdentity(tracker: Tracker): string {
  const states = trackerStateMaps(tracker)
    .map((map) => CANONICAL_STATES.map((state) => map[state]).join("|"))
    .join(";");
  return `${tracker.instance ?? ""}|${states}#${tracker.configKey ?? ""}`;
}

/**
 * The key a pool reading is kept under: the tracker, its configuration and
 * the settings that decide who made an item ready and what blocks it, so a
 * changed board or link mapping never reuses an earlier answer.
 */
export function poolScope(tracker: Tracker): string {
  return `${trackerScope(tracker)}#${configIdentity(tracker)}#${tracker.readinessKey ?? ""}`;
}

/** The saved dependencies of one native person queue, for the scope's combined probe. */
function savedProbe(
  tracker: Tracker,
  identity: string,
  cache: PickupReads,
): { since: string; keys: string[] } | null {
  const key = `${tracker.adapter}:${tracker.team}:queue:${identity}:${configIdentity(tracker)}`;
  const snapshot = snapshotOf(cache.get<unknown>(key));
  return snapshot === null
    ? null
    : { since: snapshot.since, keys: watched(snapshot) };
}

/** The view of one tracker, team and person for this tick. */
async function openView(
  tracker: Tracker,
  identity: string,
  options: {
    nowMs: number;
    headroom: boolean;
    bound?: FacetBound;
    scopeIdentities?: readonly string[];
  },
  cache: PickupReads,
  shape?: string,
): Promise<ServedView> {
  const key = `${tracker.adapter}:${tracker.team}:queue:${identity}:${configIdentity(tracker)}`;
  const previous = snapshotOf(cache.get<unknown>(key));
  const kept = previous?.shape === shape ? previous : null;
  const save = (s: Snapshot) =>
    cache.set(key, { ...s, ...(shape === undefined ? {} : { shape }) });
  let p: Plan;
  try {
    p = await plan(tracker, identity, kept, options.nowMs, options.headroom);
    if (options.bound !== undefined) p.bound = options.bound;
  } catch (error) {
    return failedView(tracker, kept, error);
  }
  if (p.source === "kept" || p.source === "unchanged")
    return assemble(tracker, p, undefined, save, options.nowMs);
  try {
    const queue = await readQueue(tracker, identity);
    return assemble(tracker, p, queue, save, options.nowMs);
  } catch (error) {
    return failedView(tracker, kept, error);
  }
}

/** The view of a queue whose read failed: offline when rate limited, else unavailable. */
function failedView(
  tracker: Tracker,
  kept: Snapshot | null,
  error: unknown,
): ServedView {
  return isRateLimited(error)
    ? offlineView(tracker, kept, error)
    : unavailableView(tracker, kept, error);
}

/** The view of a queue whose read failed for a reason other than a rate limit. */
function unavailableView(
  tracker: Tracker,
  kept: Snapshot | null,
  error: unknown,
): ServedView {
  return assemble(tracker, {
    source: "offline",
    snapshot: kept,
    stale: new Set(),
    since: kept?.since ?? "",
    limited: null,
    unavailable: failureText(error),
    unavailableCause: error,
  });
}

/** The tick's view for `tracker` and `identity`, opened once and shared. */
export async function sharedView(
  views: ServedViews | undefined,
  tracker: Tracker,
  identity: string,
  options: {
    nowMs: number;
    headroom: boolean;
    bound?: FacetBound;
    scopeIdentities?: readonly string[];
  },
  cache: PickupReads,
): Promise<ServedView> {
  cache = cacheForTracker(tracker, cache);
  if (tracker.dispatchSource !== undefined)
    return nativeSharedView(views, tracker, identity, options, cache, {
      open: openView,
      probe: savedProbe,
      credential: (tracker, key) => credentialScopes.set(tracker, key),
    });
  if (views === undefined) return openView(tracker, identity, options, cache);
  const key = `${tracker.adapter}:${tracker.team}:${identity}:${configIdentity(tracker)}`;
  let view = views.get(key);
  if (view === undefined) {
    view = openView(tracker, identity, options, cache);
    views.set(key, view);
  }
  return view;
}
