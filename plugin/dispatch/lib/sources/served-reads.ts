/**
 * The served walk's reads of one tracker, team and person: one queue read,
 * the issues it names read by key in batches, and a change probe that lets
 * a tick reuse the previous reading whole.
 *
 * - **One queue read.** The issues assigned to the person, open and in
 *   progress, with each one's relations (and the other issue's state) and
 *   its parent (with its description), in one paged request where the
 *   adapter has `queueIssues`; otherwise the two assigned lists.
 * - **Batched lookups.** Every issue the walk reads by key goes through one
 *   loader: the reads one step of the walk asks for together leave as one
 *   `poolIssues` request (per key where the adapter has none), and an issue
 *   read once is not read again in the tick.
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
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import {
  CANONICAL_STATES,
  type PoolIssue,
  type QueueParent,
  type QueueRelation,
  type Tracker,
  workingStates,
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
  /** The refusal that left the view offline; `null` when it is online. */
  readonly limited: TrackerRateLimited | null;
  /** When the reading the view holds was taken. */
  readonly readAt: number;
  /** The assigned issues in the open states (the dispatch's queue). */
  open(): HeldIssue[];
  /** The assigned issues in progress. */
  progress(): PoolIssue[];
  /** One issue by key, from the tick's reads or in the next batch. */
  pool(key: string): Promise<PoolIssue | null>;
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

/** The queue, read in one request where the adapter can. */
async function readQueue(
  tracker: Tracker,
  identity: string,
): Promise<{ open: HeldIssue[]; progress: PoolIssue[] }> {
  if (tracker.queueIssues === undefined) {
    const open = await tracker.assignedIssues(identity, [...OPEN]);
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
      progress,
    };
  }
  const working = workingStates(tracker);
  const read = await tracker.queueIssues(identity, [...OPEN, ...working]);
  const started = new Set(working.map((s) => tracker.stateName(s)));
  const open: HeldIssue[] = [];
  const progress: PoolIssue[] = [];
  for (const { relations, parent, ...issue } of read)
    if (started.has(issue.state.name)) progress.push(issue);
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

/** A loader that gathers the keys asked for in one turn of the event loop into one read. */
function loader(
  tracker: Tracker,
  memo: Map<string, Promise<PoolIssue | null>>,
  refusal: () => TrackerRateLimited | null,
  gate: Gate,
) {
  let queued = new Map<
    string,
    {
      resolve: (v: PoolIssue | null) => void;
      reject: (e: unknown) => void;
    }
  >();
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const batch = queued;
    queued = new Map();
    const keys = [...batch.keys()];
    if (tracker.poolIssues !== undefined)
      try {
        const read = await tracker.poolIssues(keys);
        for (const [key, waiter] of batch)
          waiter.resolve(read.get(key) ?? null);
        return;
      } catch (error) {
        // A refused batch refuses each key alike; any other failure is
        // retried key by key, so one bad issue fails only itself.
        if (isRateLimited(error)) {
          for (const waiter of batch.values()) waiter.reject(error);
          return;
        }
      }
    await Promise.all(
      [...batch].map(([key, waiter]) =>
        gate(() => tracker.poolIssue(key)).then(waiter.resolve, waiter.reject),
      ),
    );
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
  source: ViewSource;
  snapshot: Snapshot | null;
  /** Keys whose kept reading no longer holds. */
  stale: ReadonlySet<string> | "all";
  since: string;
  limited: TrackerRateLimited | null;
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
  if (kept !== null && p.stale !== "all")
    for (const [key, value] of Object.entries(kept.pool))
      if (!p.stale.has(key)) remember(key, value);
  const held = new Map<string, HeldIssue>();
  const parents = new Map<string, QueueParent>();
  for (const h of open) {
    held.set(h.issue.identifier, h);
    remember(h.issue.identifier, h.issue);
    if (h.parent) {
      parents.set(h.parent.issue.identifier, h.parent);
      remember(h.parent.issue.identifier, h.parent.issue);
    }
  }
  for (const issue of progress) remember(issue.identifier, issue);
  const gate = semaphore(IN_FLIGHT);
  const load = loader(tracker, memo, () => p.limited, gate);
  const reads = new Map<string, Promise<unknown>>();
  const readAt = queue === undefined ? (kept?.readAt ?? 0) : nowMs;
  return {
    source: p.source,
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
    once<T>(key: string, read: () => Promise<T>): Promise<T> {
      let kept = reads.get(key) as Promise<T> | undefined;
      if (kept === undefined) {
        kept = gate(read);
        reads.set(key, kept);
      }
      return kept;
    },
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

/**
 * What the tracker's configuration makes of its issues: the state names and
 * the facet stores. Repositories that differ in either cannot share a reading.
 */
function configIdentity(tracker: Tracker): string {
  const states = CANONICAL_STATES.map((s) => tracker.stateName(s)).join("|");
  return `${states}#${tracker.configKey ?? ""}`;
}

/** The view of one tracker, team and person for this tick. */
async function openView(
  tracker: Tracker,
  identity: string,
  options: { nowMs: number; headroom: boolean },
  cache: PickupReads,
): Promise<ServedView> {
  const key = `${tracker.adapter}:${tracker.team}:queue:${identity}:${configIdentity(tracker)}`;
  const kept = snapshotOf(cache.get<unknown>(key));
  const save = (s: Snapshot) => cache.set(key, s);
  let p: Plan;
  try {
    p = await plan(tracker, identity, kept, options.nowMs, options.headroom);
  } catch (error) {
    if (isRateLimited(error)) return offlineView(tracker, kept, error);
    throw error;
  }
  if (p.source === "kept" || p.source === "unchanged")
    return assemble(tracker, p, undefined, save, options.nowMs);
  try {
    const queue = await readQueue(tracker, identity);
    return assemble(tracker, p, queue, save, options.nowMs);
  } catch (error) {
    if (isRateLimited(error)) return offlineView(tracker, kept, error);
    throw error;
  }
}

/** The tick's view for `tracker` and `identity`, opened once and shared. */
export function sharedView(
  views: ServedViews | undefined,
  tracker: Tracker,
  identity: string,
  options: { nowMs: number; headroom: boolean },
  cache: PickupReads,
): Promise<ServedView> {
  if (views === undefined) return openView(tracker, identity, options, cache);
  const key = `${tracker.adapter}:${tracker.team}:${identity}:${configIdentity(tracker)}`;
  let view = views.get(key);
  if (view === undefined) {
    view = openView(tracker, identity, options, cache);
    views.set(key, view);
  }
  return view;
}
