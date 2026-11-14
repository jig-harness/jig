/**
 * Served assignments, inherited through epics, with metadata kept at
 * updatedAt. The tracker is read through the tick's view of the person's
 * queue (`served-reads.ts`): one queue read, batched lookups, and the
 * previous reading reused when the change probe finds nothing changed. A
 * read the tracker's rate limit refuses stops the walk, which reports the
 * limit once rather than one unplaced row per item.
 */
import { cacheForTracker } from "./tracker-cache.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { metadata, type Metadata } from "./served-metadata.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import { scopeFailureRow } from "./scope-failures.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/outbound/budget.ts";
import { servedParentHold } from "./served-parents.ts";
import { blocksWithin } from "../../../skills/do-item/scripts/lib/blocker-chain.ts";
import {
  closed,
  openBlockers,
  pullBlockers,
  ready,
  whyNotPulled,
  type OpenBlocker,
  type PullOrigin,
} from "./served-pull.ts";
import {
  childPlanHold,
  parkedOnPerson,
  serializeEpics,
  summarizeEpics,
  type EpicWalk,
  type Serial,
} from "./served-epics.ts";
import {
  NEEDS_REPOSITORY_LABEL,
  otherRepoLabel,
  type RepoScope,
  type UnlabeledMode,
  unlabeledOutcome,
} from "./served-repo.ts";
import { planKeys, servedPlan, type ServedPlan } from "./served-plan.ts";
import {
  type ServedView,
  type ServedViews,
  sharedView,
} from "./served-reads.ts";
import type { LiveIssue } from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { ServedPerson } from "../serve-config.ts";
import { pickupReads, type PickupReads } from "../pickup-reads.ts";
import {
  PERSON_HOLD,
  queueHold,
  rankQueue,
  type QueueItem,
} from "../queue-rank.ts";
import { failureText } from "../text.ts";
import type { ClaimedItem, Unplaced, WantedItem } from "../types.ts";
import { isoFromMs } from "../../../shared/time.ts";

interface Candidate extends QueueItem {
  identity: string;
  by: string;
  ancestor?: string | undefined;
  blockingFor?: string | undefined;
  serial?: Serial | undefined;
}
export interface ServedReading {
  wanted: WantedItem[];
  unplaced: Unplaced[];
  claimed: ClaimedItem[];
  /** The tracker refused the reads for its rate limit: until when, in ISO 8601. */
  limitedUntil?: string;
  /** A served identity's queue failed to read for another reason: the claims are not known. */
  incomplete?: boolean;
  /** What each failed read raised, `undefined` for one no call failed, so every class reaches the record. */
  failures?: unknown[];
}
export interface ServedPolicy {
  hitl?: string;
  manualOps?: string;
  executionPlanBlock?: string;
  /** This repository's label and the other repositories': an item carrying another's is not this checkout's to start. */
  repoScope?: RepoScope;
  /** What this checkout does with an item no repository label places; `start` when absent. */
  unlabeled?: UnlabeledMode;
  /** Identity of the tracker whose unplaced items this reading reports. */
  trackerNamespace?: string;
}
export interface ServedOptions extends ServedPolicy {
  cache?: PickupReads;
  nowMs: number;
  headroom: boolean;
  bound?: import("./tracker-facets.ts").FacetBound;
  /** The tick's views, shared by every repository that reads the same tracker, team and person. */
  views?: ServedViews;
}
/** An unplaced row's target, with the title and link the listing returned for it. */
const itemOf = (i: PoolIssue) => ({
  target: i.identifier,
  title: i.title,
  url: i.url,
});

/** The single row a rate-limited tracker leaves on the receipt. */
export function limitedRow(
  tracker: Pick<Tracker, "adapter" | "team">,
  limited: TrackerRateLimited,
  view: Pick<ServedView, "readAt" | "scope"> | null = null,
): Unplaced {
  const until = isoFromMs(limited.resetAt);
  const row: Unplaced = {
    target: `${tracker.adapter} ${tracker.team}`,
    record: "tracker",
    reason: `the tracker is rate limited until ${until}: pickups wait for the reset, and no request is sent before it`,
  };
  return view === null ? row : scopeFailureRow(tracker, view, row.reason);
}

/** What the walks of every served identity in one reading share about epics. */
interface EpicState {
  walks: EpicWalk[];
  /** The one-at-a-time constraint of each child of an epic with no execution plan, whoever reaches the child first. */
  serials: Map<string, Serial>;
}

/** What one served identity's queue gave: its claims, its holds and candidates, and the limit that stopped it. */
interface PersonReading {
  claimed: ClaimedItem[];
  unplaced: Unplaced[];
  candidates: Candidate[];
  limited: { error: TrackerRateLimited; view: ServedView | null } | null;
  /** What failed each read: the scope's cause or the error thrown, `undefined` for a read no call failed. */
  failures: unknown[];
}

/** A served item in progress, as the claim dispatch monitors. */
function servedClaim(i: PoolIssue) {
  return {
    key: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state.name,
    ...(i.nativeType === undefined ? {} : { nativeType: i.nativeType }),
    served: true as const,
  };
}

/** The one unplaced row an identity's failed read leaves. */
function readFailureRow(
  tracker: Tracker,
  identity: string,
  view: ServedView | null,
  error: unknown,
): Unplaced {
  const reason = `the served assignments could not be read: ${failureText(error)}`;
  return view?.scope !== undefined && isUnavailable(error)
    ? scopeFailureRow(tracker, view, reason)
    : { target: identity, record: "tracker", reason };
}

/** Read one served identity's queue and walk it; an unreadable one is one unplaced row. */
async function readPerson(
  tracker: Tracker,
  identity: string,
  options: ServedOptions,
  cache: PickupReads,
  seen: Set<string>,
  shared: EpicState,
): Promise<PersonReading> {
  const got: PersonReading = {
    claimed: [],
    unplaced: [],
    candidates: [],
    limited: null,
    failures: [],
  };
  let view: ServedView | null = null;
  try {
    view = await sharedView(options.views, tracker, identity, options, cache);
    if (view.limited !== null) got.limited = { error: view.limited, view };
    if (view.unavailable !== undefined) {
      got.failures.push(view.unavailableCause ?? view.unavailable);
      got.unplaced.push(
        scopeFailureRow(
          tracker,
          view,
          `the served assignments could not be read: ${view.unavailable}`,
        ),
      );
    }
    const progress = view.progress();
    got.claimed = progress.map(servedClaim);
    // Claims are monitored either way; an invalid scope only starts nothing.
    if (options.repoScope?.invalid !== undefined) return got;
    // The walk fills `got` as it goes, so a limit met in a later generation
    // keeps what the earlier ones placed.
    await walk(
      { tracker, identity, options, cache, view, seen, ...shared },
      [
        ...view.open().map((h) => h.issue),
        ...progress.filter((i) => i.isEpic && i.hasOpenChildren),
      ],
      got,
    );
  } catch (error) {
    if (isRateLimited(error)) got.limited ??= { error, view };
    else {
      got.failures.push(error);
      got.unplaced.push(readFailureRow(tracker, identity, view, error));
    }
  } finally {
    view?.save();
  }
  return got;
}

/** A failed queue makes the reading incomplete; every cause is kept. */
function noteFailure(out: ServedReading, got: PersonReading): void {
  if (got.failures.length === 0) return;
  out.failures = [...(out.failures ?? []), ...got.failures];
  out.incomplete = true;
}

/** Read every served identity for this adapter; an unreadable identity starts nothing. */
export async function readServedPickups(
  tracker: Tracker,
  people: readonly ServedPerson[],
  options: ServedOptions,
): Promise<ServedReading> {
  options =
    options.views === undefined ? { ...options, views: new Map() } : options;
  const cache = cacheForTracker(tracker, options.cache ?? pickupReads);
  const out: ServedReading = { wanted: [], unplaced: [], claimed: [] };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const shared: EpicState = { walks: [], serials: new Map() };
  let limited: PersonReading["limited"] = null;
  if (options.repoScope?.invalid !== undefined)
    out.unplaced.push({
      target: tracker.adapter,
      record: "tracker",
      reason: `served pickups are refused: the repository scope is invalid: ${options.repoScope.invalid}`,
    });
  for (const person of people) {
    const identity =
      person.tracker[tracker.adapter as keyof ServedPerson["tracker"]];
    if (identity === undefined) continue;
    const got = await readPerson(
      tracker,
      identity,
      options,
      cache,
      seen,
      shared,
    );
    out.claimed.push(...got.claimed);
    out.unplaced.push(...got.unplaced);
    candidates.push(...got.candidates);
    noteFailure(out, got);
    limited ??= got.limited;
  }
  if (limited !== null) {
    out.unplaced.push(limitedRow(tracker, limited.error, limited.view));
    out.limitedUntil = isoFromMs(limited.error.resetAt);
  }
  for (const c of candidates) {
    const serial = shared.serials.get(c.issue.identifier);
    if (c.serial === undefined && serial !== undefined) c.serial = serial;
  }
  const ranked = serializeEpics(rankQueue(candidates), out.unplaced);
  summarizeEpics(
    shared.walks,
    new Set(ranked.map((c) => c.issue.identifier)),
    out.unplaced,
  );
  out.wanted = ranked.map((c) => ({
    key: c.issue.identifier,
    title: c.issue.title,
    url: c.issue.url,
    state: c.issue.state.name,
    assignee: c.identity,
    assignedBy: c.by,
    servedPerson: c.identity,
    queueIssue: c.issue,
    ...(c.issue.updatedAt === undefined
      ? {}
      : { updatedAt: c.issue.updatedAt }),
    queueRank: {
      unblocks: c.unblocks,
      ...(c.epicOrder === undefined ? {} : { epicOrder: c.epicOrder }),
    },
    ...(c.ancestor === undefined ? {} : { ancestorEpic: c.ancestor }),
    ...(c.blockingFor === undefined
      ? {}
      : { blockingFor: c.blockingFor, batchAllowed: false }),
  }));
  return out;
}

/** Launch-time revalidation; do-item's serialized claim repeats the ancestry and writer checks at the write. */
export async function freshServedPickup(
  tracker: Tracker,
  key: string,
  identity: string,
  ancestor?: string,
  policy: ServedPolicy = {},
  blockingFor?: string,
): Promise<PoolIssue | string> {
  try {
    const issue = await tracker.poolIssue(key);
    if (
      issue === null ||
      !ready(issue, tracker.stateName("blocked", issue.nativeType ?? null))
    )
      return "the served item is no longer open and not started";
    if (policy.repoScope?.invalid !== undefined)
      return `the repository scope is invalid: ${policy.repoScope.invalid}`;
    const elsewhere = otherRepoLabel(issue.labels, policy.repoScope);
    if (elsewhere !== null)
      return `it carries the repository label ${elsewhere}, which is another repository's`;
    const unlabeled = unlabeledOutcome(
      issue.labels,
      policy.repoScope,
      policy.unlabeled,
    );
    if (unlabeled === "hold") return NEEDS_REPOSITORY_LABEL;
    if (unlabeled === "leave")
      return "no repository label places it, and this repository is not its team's default";
    const parentHold = await servedParentHold(
      tracker,
      issue,
      { get: () => null, set: () => undefined },
      policy.executionPlanBlock,
    );
    if (parentHold !== null) return parentHold;
    const held = queueHold(
      {
        issue,
        blockers: (
          await openBlockers(
            (k) => tracker.poolIssue(k),
            await tracker.listRelations(key),
          )
        ).map((b) => b.key),
        unblocks: 0,
      },
      policy,
    );
    if (held !== null) return held;
    const authority =
      blockingFor === undefined
        ? await freshAuthority(tracker, issue, identity, ancestor)
        : await freshPulledAuthority(
            tracker,
            issue,
            identity,
            blockingFor,
            ancestor,
            policy,
          );
    if (authority !== null) return authority;
    return issue;
  } catch (error) {
    return `the served assignment cannot be read again: ${failureText(error)}`;
  }
}

interface Pending {
  issue: PoolIssue;
  ancestor: string | undefined;
  by: string | undefined;
  epicOrder: number | undefined;
  planHold: string | undefined;
  /** Set for a blocker pulled forward: the item whose authority it is worked on. */
  pull?: PullOrigin | undefined;
  serial?: Serial | undefined;
}
interface WalkContext {
  tracker: Tracker;
  identity: string;
  options: ServedOptions;
  cache: PickupReads;
  view: ServedView;
  seen: Set<string>;
  walks: EpicWalk[];
  serials: Map<string, Serial>;
}
/** What one node of the walk found, merged in the walk's order. */
interface Found {
  unplaced: Unplaced[];
  candidates: Candidate[];
  pending: Pending[];
  /** What failed each read of this node, `undefined` for a read no call failed: the reading is incomplete. */
  failures: unknown[];
}

/**
 * Visit the roots, then each generation of children, every node of a
 * generation at once so the reads they ask for leave together; what each
 * found is merged in node order into `all`. A rate-limited read ends the walk,
 * leaving what the earlier generations found in `all`.
 */
async function walk(
  ctx: WalkContext,
  roots: PoolIssue[],
  all: Omit<Found, "pending">,
): Promise<Omit<Found, "pending">> {
  let generation: Pending[] = roots.map((issue) => ({
    issue,
    ancestor: undefined,
    by: undefined,
    epicOrder: undefined,
    planHold: undefined,
  }));
  while (generation.length > 0) {
    // Each visit fills a record the walk owns, so what a visit found before
    // it rejected is merged all the same.
    const nodes = generation.map((node) => ({ node, found: newFound() }));
    const visits = nodes.map(({ node, found }) => visitNode(ctx, node, found));
    const settled = await Promise.allSettled(visits);
    generation = [];
    settled.forEach((s, i) => {
      const found = nodes[i]?.found;
      if (found === undefined) return;
      all.unplaced.push(...found.unplaced);
      all.candidates.push(...found.candidates);
      all.failures.push(...found.failures);
      if (s.status === "fulfilled") generation.push(...found.pending);
    });
    try {
      await Promise.all(visits);
    } catch (error) {
      // The walk ends with this one error; every other rejected visit is a
      // failed read kept here, and a rate limit is the walk's limit alone.
      for (const s of settled)
        if (
          s.status === "rejected" &&
          s.reason !== error &&
          !isRateLimited(s.reason)
        )
          all.failures.push(s.reason);
      throw error;
    }
  }
  return all;
}

/**
 * Reads an epic's open children; one that cannot be read is reported and set
 * aside. A rate-limited read is thrown only once every sibling's result is
 * recorded, so a sibling's own defect is not lost to the limit.
 */
async function readChildren(
  ctx: WalkContext,
  meta: Metadata,
  found: Found,
): Promise<{ children: PoolIssue[]; unread: string[] }> {
  const { view } = ctx;
  const read = await Promise.all(
    meta.children.map(async (kept) => {
      try {
        return { child: await view.pool(kept.identifier), error: undefined };
      } catch (error) {
        return { child: null, error };
      }
    }),
  );
  const children: PoolIssue[] = [];
  const unread: string[] = [];
  const limits: unknown[] = [];
  meta.children.forEach((kept, i) => {
    const { child, error } = read[i] ?? { child: null, error: undefined };
    if (isRateLimited(error)) {
      limits.push(error);
      return;
    }
    if (child === null || child.truncated.length) {
      unread.push(kept.identifier);
      found.failures.push(error);
      found.unplaced.push({
        ...itemOf(kept),
        record: "tracker",
        reason:
          error === undefined
            ? "the child cannot be read completely"
            : `the child cannot be read: ${failureText(error)}`,
      });
    } else children.push(child);
  });
  if (limits.length > 0) return Promise.reject(limits[0]);
  return { children, unread };
}

async function enqueueChildren(
  ctx: WalkContext,
  issue: PoolIssue,
  ancestor: string | undefined,
  meta: Metadata,
  candidate: Candidate,
  found: Found,
): Promise<void> {
  const { options } = ctx;
  const { children, unread } = await readChildren(ctx, meta, found);
  let serial: Serial | undefined;
  let selection: ServedPlan;
  try {
    const live = await childStates(ctx, children, meta);
    selection = servedPlan(
      meta.description ?? "",
      issue.identifier,
      live,
      options.executionPlanBlock,
    );
    const parked = selection.present
      ? []
      : children.filter((c) => parkedOnPerson(c, ctx.tracker, options));
    const busy = children.find(
      (c) => c.state.type === "started" && !parked.includes(c),
    );
    ctx.walks.push({
      key: issue.identifier,
      children: children.map((c) => c.identifier),
      unread,
      working: busy !== undefined,
      parked: parked.map((c) => c.identifier),
    });
    serial = selection.present
      ? undefined
      : { epic: issue.identifier, busy: busy?.identifier, unread: unread[0] };
  } catch (error) {
    // Setup failed: no sibling starts on a guess, and a directly assigned child is held too.
    for (const kept of meta.children)
      ctx.serials.set(kept.identifier, {
        epic: issue.identifier,
        busy: undefined,
        unread: meta.children[0]?.identifier ?? issue.identifier,
      });
    throw error;
  }
  for (const child of children) {
    if (serial !== undefined) ctx.serials.set(child.identifier, serial);
    found.pending.push({
      issue: child,
      ancestor: ancestor ?? issue.identifier,
      by: candidate.by,
      serial,
      epicOrder: selection.present
        ? selection.order.indexOf(child.identifier)
        : undefined,
      planHold: childPlanHold(selection, child.identifier, unread),
    });
  }
}

/**
 * Whether the walk passes this node by: already seen, nothing to start and no
 * epic to walk, another repository's item, or an item no label places that
 * the team's default repository starts (an epic is still walked, its
 * children carry their own labels).
 */
function leavesNode(
  issue: PoolIssue,
  options: ServedOptions,
  seen: ReadonlySet<string>,
  tracker: Pick<Tracker, "stateName">,
): boolean {
  const walkedEpic = issue.isEpic && issue.hasOpenChildren && !closed(issue);
  if (
    seen.has(issue.identifier) ||
    (!ready(issue, tracker.stateName("blocked", issue.nativeType ?? null)) &&
      !walkedEpic)
  )
    return true;
  return (
    !walkedEpic &&
    (otherRepoLabel(issue.labels, options.repoScope) !== null ||
      unlabeledOutcome(issue.labels, options.repoScope, options.unlabeled) ===
        "leave")
  );
}

function newFound(): Found {
  return { unplaced: [], candidates: [], pending: [], failures: [] };
}

async function visitNode(
  ctx: WalkContext,
  node: Pending,
  found: Found,
): Promise<Found> {
  const { tracker, options, seen } = ctx;
  const { issue, ancestor } = node;
  if (leavesNode(issue, options, seen, tracker)) return found;
  // A child assigned elsewhere is not inherited. A direct assignment is read in its owner's list.
  if (ancestor !== undefined && issue.assignee !== null) return found;
  seen.add(issue.identifier);
  if (issue.truncated.length) {
    found.failures.push(undefined);
    found.unplaced.push({
      ...itemOf(issue),
      record: "tracker",
      reason: "the item cannot be read completely",
    });
    return found;
  }
  try {
    await placeNode(ctx, node, found);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    if (ctx.view.scope !== undefined && isUnavailable(error)) throw error;
    unreadable(issue, failureText(error), found, error);
  }
  return found;
}

/** An item whose queue metadata could not be read, or named no assigner: the walk's claims below it are unknown. */
function unreadable(
  issue: PoolIssue,
  why: string,
  found: Found,
  cause?: unknown,
): void {
  found.failures.push(cause);
  found.unplaced.push({
    ...itemOf(issue),
    record: "tracker",
    reason: `the queue metadata could not be read: ${why}`,
  });
}

/** Read what a node needs and place it: held with why, a candidate, or an epic whose children come next. */
async function placeNode(
  ctx: WalkContext,
  node: Pending,
  found: Found,
): Promise<void> {
  const { tracker, identity, options, cache, view } = ctx;
  const { issue, ancestor } = node;
  const unplace = unplacer(issue, options.trackerNamespace, found);
  const carried = view.held(issue.identifier)?.relations ?? null;
  const meta = await metadata(tracker, issue, identity, cache, carried, view);
  // A kept no-assigner answer is reported as the failed read it stands for.
  if (meta.noAssigner !== undefined)
    return void unreadable(issue, meta.noAssigner, found);
  const initialHold = nodeHold(node, meta, identity, options, tracker);
  if (initialHold !== null) {
    // An epic whose description is unreadable hides its subtree: the claims below it are unknown.
    if (meta.description === null) found.failures.push(undefined);
    return void unplace(initialHold);
  }
  const open = await openBlockers(
    (k) => view.pool(k),
    carried ?? meta.relations,
  );
  const candidate = candidateOf(node, meta, identity, open);
  const held = await heldReason(ctx, node, candidate, open, found);
  if (held !== null) return void unplace(held);
  if (meta.children.length > 0)
    return enqueueChildren(ctx, issue, ancestor, meta, candidate, found);
  await placeLeaf(ctx, candidate, found, unplace);
}

type Unplace = (reason: string, cause?: "needs-repository-label") => void;

/** Records an item the walk could not place, with the namespace it was read from. */
function unplacer(
  issue: PoolIssue,
  namespace: string | undefined,
  found: Found,
): Unplace {
  return (reason, cause) => {
    found.unplaced.push({
      ...itemOf(issue),
      record: "tracker",
      reason,
      ...(cause === undefined ? {} : { cause }),
      ...(namespace === undefined ? {} : { source: namespace }),
    });
  };
}

/** A node with no children: left out, held for its repository label or parent, or a candidate. */
async function placeLeaf(
  ctx: WalkContext,
  candidate: Candidate,
  found: Found,
  unplace: Unplace,
): Promise<void> {
  const { tracker, options, cache, view } = ctx;
  const { issue } = candidate;
  if (
    !ready(issue, tracker.stateName("blocked", issue.nativeType ?? null)) ||
    otherRepoLabel(issue.labels, options.repoScope) !== null
  )
    return;
  const unlabeled = unlabeledOutcome(
    issue.labels,
    options.repoScope,
    options.unlabeled,
  );
  if (unlabeled === "hold")
    return void unplace(NEEDS_REPOSITORY_LABEL, "needs-repository-label");
  if (unlabeled === "leave") return;
  const parentHold = await servedParentHold(
    tracker,
    issue,
    cache,
    options.executionPlanBlock,
    view,
  );
  if (parentHold !== null) unplace(parentHold);
  else found.candidates.push(candidate);
}

function nodeHold(
  node: Pending,
  meta: Metadata,
  identity: string,
  options: ServedOptions,
  tracker: Pick<Tracker, "stateName">,
): string | null {
  if (node.planHold) return node.planHold;
  if (parkedOnPerson(node.issue, tracker, options)) return PERSON_HOLD;
  if (
    node.ancestor === undefined &&
    node.pull === undefined &&
    meta.by?.trusted !== true
  )
    return `assignment to ${identity} was not made by a repository writer`;
  return meta.description === null
    ? "the epic description cannot be read"
    : null;
}

/** The live state of an epic's children and the issues its plan names, read together. */
async function childStates(
  ctx: WalkContext,
  children: PoolIssue[],
  meta: Metadata,
): Promise<Record<string, LiveIssue>> {
  const { tracker, identity, options, cache, view } = ctx;
  const live: Record<string, LiveIssue> = {};
  const keys = planKeys(
    meta.description ?? "",
    options.executionPlanBlock,
    children.map((c) => c.identifier),
  );
  const read = await Promise.all(
    keys.map(
      async (key) =>
        children.find((c) => c.identifier === key) ?? (await view.pool(key)),
    ),
  );
  const infos = await Promise.all(
    read.map((child) =>
      child === null || child.truncated.length
        ? null
        : metadata(
            tracker,
            child,
            identity,
            cache,
            view.held(child.identifier)?.relations ?? null,
            view,
          ),
    ),
  );
  const blockersOf = new Map<string, string[]>();
  keys.forEach((key, i) => {
    const child = read[i];
    const info = infos[i];
    if (!child || !info || info.noAssigner !== undefined) return;
    const blockedBy = info.relations
      .filter((r) => r.type === "blocked_by")
      .map((r) => r.issue);
    live[key] = { state: child.state.type, blockedBy };
    blockersOf.set(key, blockedBy);
  });
  const blockerKeys = [...new Set([...blockersOf.values()].flat())];
  const others = await Promise.all(blockerKeys.map((k) => view.pool(k)));
  blockerKeys.forEach((blocker, i) => {
    const other = others[i];
    if (
      other !== null &&
      other !== undefined &&
      !other.truncated.length &&
      live[blocker] === undefined
    )
      live[blocker] = { state: other.state.type, blockedBy: [] };
  });
  return live;
}

async function freshAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  ancestor?: string,
): Promise<string | null> {
  return ancestor === undefined
    ? directAuthority(tracker, issue, identity)
    : inheritedAuthority(tracker, issue, identity, ancestor);
}

async function directAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
): Promise<string | null> {
  const user = await tracker.user(identity);
  if (issue.assignee?.id !== user.id) return "the served assignment changed";
  if (!(await tracker.assignedBy(issue.identifier, identity)).trusted)
    return "the assigner cannot write";
  return null;
}

async function inheritedAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  ancestor: string,
): Promise<string | null> {
  if (issue.assignee !== null)
    return "the inherited item has acquired an assignee";
  const user = await tracker.user(identity);
  const seen = new Set<string>();
  let current: PoolIssue | null = issue;
  for (;;) {
    if (current === null || current.truncated.length)
      return "the inherited ancestry cannot be read completely";
    if (seen.has(current.identifier) || seen.size >= 100)
      return "the inherited ancestry is cyclic or too deep";
    seen.add(current.identifier);
    if (current.identifier === ancestor)
      return ancestorChanged(tracker, current, user.id, identity);
    if (current.assignee !== null)
      return "the inherited ancestry assignment changed";
    const full = await tracker.getIssue(current.identifier);
    if (full === null || full.parent === null)
      return "the inherited ancestor is no longer live";
    current = await tracker.poolIssue(full.parent.identifier);
  }
}

async function ancestorChanged(
  tracker: Tracker,
  ancestor: PoolIssue,
  userId: string,
  identity: string,
): Promise<string | null> {
  if (
    ancestor.assignee?.id !== userId ||
    !(await tracker.assignedBy(ancestor.identifier, identity)).trusted
  )
    return "the inherited assignment changed";
  return null;
}

function candidateOf(
  node: Pending,
  meta: Metadata,
  identity: string,
  open: readonly OpenBlocker[],
): Candidate {
  return {
    issue: node.issue,
    identity,
    by: meta.by?.name ?? node.by ?? "",
    ancestor: node.ancestor,
    blockers: open.map((b) => b.key),
    ...(node.pull === undefined ? {} : { blockingFor: node.pull.root }),
    ...(node.serial === undefined ? {} : { serial: node.serial }),
    ...(node.epicOrder === undefined ? {} : { epicOrder: node.epicOrder }),
    unblocks: meta.relations.filter((r) => r.type === "blocks").length,
  };
}

/**
 * Why a node starts nothing now. A node held only by open blockers queues
 * the blockers it may pull forward, so the item waits on work that runs.
 */
async function heldReason(
  ctx: WalkContext,
  node: Pending,
  candidate: Candidate,
  open: readonly OpenBlocker[],
  found: Found,
): Promise<string | null> {
  const { tracker, options, cache, view } = ctx;
  const held = queueHold(candidate, options);
  if (held === null || open.length === 0) return held;
  if (queueHold({ ...candidate, blockers: [] }, options) !== null) return held;
  // An item behind its epic's human gate authorizes no work, its blockers' included: the served item and each pulled item between.
  const parentHold = await servedParentHold(
    tracker,
    node.issue,
    cache,
    options.executionPlanBlock,
    view,
  );
  if (parentHold !== null) return parentHold;
  const pull = pullBlockers(node.issue, node.pull, node.ancestor, open, {
    hitl: options.hitl,
    manualOps: options.manualOps,
    repoScope: options.repoScope,
    canAssign: tracker.assignUnassigned !== undefined,
    blockedState: (item) =>
      tracker.stateName("blocked", item.nativeType ?? null),
  });
  // A tracker that cannot assign without replacing a concurrent assignee refuses the claim, so no launch is spent on it; each blocker is still explained.
  if (pull.pulled.length > 0 && tracker.assignUnassigned === undefined)
    return `${pull.reason}; this tracker cannot assign a blocker on its own, so a person assigns it`;
  for (const blocker of pull.pulled)
    if (!ctx.seen.has(blocker.identifier))
      found.pending.push({
        issue: blocker,
        ancestor: pull.origin.rootAncestor,
        by: candidate.by,
        epicOrder: undefined,
        planHold: undefined,
        pull: pull.origin,
      });
  return pull.reason;
}

/** A pulled blocker is empty; the served item it blocks must still hold the person's authority and wait on it. */
async function freshPulledAuthority(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  blockingFor: string,
  ancestor: string | undefined,
  policy: ServedPolicy,
): Promise<string | null> {
  if (issue.assignee !== null)
    return "the pulled blocker has acquired an assignee";
  if (issue.hasOpenChildren || issue.isEpic)
    return "the pulled blocker has become an epic";
  const origin = await tracker.poolIssue(blockingFor);
  if (
    origin === null ||
    !ready(origin, tracker.stateName("blocked", origin.nativeType ?? null))
  )
    return `${blockingFor}, which it blocks, is no longer open and not started`;
  if (queueHold({ issue: origin, blockers: [], unblocks: 0 }, policy) !== null)
    return `${blockingFor}, which it blocks, needs a person to start`;
  const originHold = await servedParentHold(
    tracker,
    origin,
    { get: () => null, set: () => undefined },
    policy.executionPlanBlock,
  );
  if (originHold !== null) return `${blockingFor}: ${originHold}`;
  const authority = await freshAuthority(tracker, origin, identity, ancestor);
  if (authority !== null) return `${blockingFor}: ${authority}`;
  const through = async (via: string): Promise<boolean> => {
    const item = await tracker.poolIssue(via);
    return (
      whyNotPulled(item, {
        hitl: policy.hitl,
        manualOps: policy.manualOps,
        repoScope: policy.repoScope,
        blockedState: (item) =>
          tracker.stateName("blocked", item.nativeType ?? null),
      }) === null &&
      (await servedParentHold(
        tracker,
        item as PoolIssue,
        { get: () => null, set: () => undefined },
        policy.executionPlanBlock,
      )) === null
    );
  };
  return (await blocksWithin(tracker, blockingFor, issue.identifier, through))
    ? null
    : `it no longer blocks ${blockingFor}`;
}
