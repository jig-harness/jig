/**
 * Served assignments, inherited through epics, with metadata kept at
 * updatedAt. The tracker is read through the tick's view of the person's
 * queue (`served-reads.ts`): one queue read, batched lookups, and the
 * previous reading reused when the change probe finds nothing changed. A
 * read the tracker's rate limit refuses stops the walk, which reports the
 * limit once rather than one unplaced row per item.
 */
import {
  EPIC_PICKUP_REASON,
  isEpicPickup,
} from "../../../shared/epic-pickup.ts";
import type { PlanMergeReader } from "./plan-merges.ts";
import { finishAdmission, type Candidate } from "./served-admission.ts";
import { cacheForTracker } from "./tracker-cache.ts";
import {
  personRoots,
  personView,
  readyForWalk,
  carriedRelations,
  pulledNodes,
  servedClaim,
} from "./served-walk-inputs.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { metadata, type Metadata } from "./served-metadata.ts";
import { chainOf } from "./served-chain.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import { noCredentialFailure, scopeFailureRow } from "./scope-failures.ts";
import {
  claimsUnread,
  claimsUnreadRow,
  itemFailed,
  limitedRow,
  noteFailure,
  readFailureRow,
} from "./served-failures.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/outbound/budget.ts";
import {
  parentHoldUnread,
  servedParentHold,
  servedParentSteps,
} from "./served-parents.ts";
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
  type PassOver,
  parkedOnPerson,
  noteUnreadChild,
  type EpicWalk,
} from "./served-epics.ts";
import {
  NEEDS_REPOSITORY_LABEL,
  otherRepoLabel,
  type RepoScope,
  type UnlabeledMode,
  unlabeledOutcome,
} from "./served-repo.ts";
import { freshAuthority } from "./served-authority.ts";
import { childMergeEvidence, planKeys, servedPlan } from "./served-plan.ts";
import type { ServedView, ServedViews } from "./served-reads.ts";
import type { LiveIssue } from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { ServedPerson } from "../serve-config.ts";
import { pickupReads, type PickupReads } from "../pickup-reads.ts";
import { PERSON_HOLD, queueHold, type QueueHoldPolicy } from "../queue-rank.ts";
import { seenOrHeld } from "../queue-rank.ts";
import { failureText } from "../text.ts";
import type { ClaimedItem, Unplaced, WantedItem } from "../types.ts";
import { isoFromMs } from "../../../shared/time.ts";

export interface ServedReading {
  wanted: WantedItem[];
  unplaced: Unplaced[];
  claimed: ClaimedItem[];
  /** The tracker refused the reads for its rate limit: until when, in ISO 8601. */
  limitedUntil?: string;
  /** A served identity's queue, or an item in it, failed to read for another reason: the wanted items are not all known. */
  incomplete?: boolean;
  /** A served identity's queue itself was not read (it failed, or the rate limit stopped it): its claims are not known. */
  claimsUnknown?: true;
  /** What each read that fails the record raised: a queue's, or an item's a failed call stopped, so every class reaches the record. */
  failures?: unknown[];
}
export interface ServedPolicy extends QueueHoldPolicy {
  mergeEvidence?: PlanMergeReader | undefined;
  executionPlanBlock?: string;
  /** This repository's label and the other repositories': an item carrying another's is not this checkout's to start. */
  repoScope?: RepoScope;
  /** What this checkout does with an item no repository label places; `start` when absent. */
  unlabeled?: UnlabeledMode;
  /** Identity of the tracker whose unplaced items this reading reports. */
  trackerNamespace?: string;
}
export interface ServedOptions extends ServedPolicy {
  /** Factory roots already authorized by its bounded assignment read. */
  factory?: {
    identity: string;
    roots: PoolIssue[];
    view?: ServedView | undefined;
    eligible?: ReadonlySet<string>;
  };
  cache?: PickupReads;
  nowMs: number;
  headroom: boolean;
  bound?: import("./tracker-facets.ts").FacetBound;
  /** The tick's views, shared by every repository that reads the same tracker, team and person. */
  views?: ServedViews;
  /** Why a local pickup record keeps an item from starting. */
  passOver?: PassOver;
}
/** An unplaced row's target, with the title and link the listing returned for it. */
const itemOf = (i: PoolIssue) => ({
  target: i.identifier,
  title: i.title,
  url: i.url,
});

/** What the walks of every served identity in one reading share about epics. */
interface EpicState {
  walks: EpicWalk[];
  /** Items whose failed read is already recorded, so a later visit does not report it again. */
  reported: Set<string>;
}

/** What one served identity's queue gave: its claims, its holds and candidates, and the limit that stopped it. */
interface PersonReading {
  claimed: ClaimedItem[];
  unplaced: Unplaced[];
  candidates: Candidate[];
  limited: { error: TrackerRateLimited; view: ServedView | null } | null;
  /** What failed each read that fails the record: the scope's cause or the error thrown. */
  failures: unknown[];
  /** An item's read failed, so the items below it are unknown. */
  partial: boolean;
  /** Why the queue's items in progress were not read, so its claims are unknown; `null` when they were. */
  claimsUnread: string | null;
  /** What failed the read of its claims, when a call did. */
  claimsCause?: unknown;
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
    partial: false,
    claimsUnread: null,
  };
  let view: ServedView | null = null;
  try {
    view = await personView(tracker, identity, options, cache);
    if (view.limited !== null) got.limited = { error: view.limited, view };
    if (view.unavailable !== undefined) {
      got.failures.push(view.unavailableCause ?? view.unavailable);
      got.unplaced.push(
        scopeFailureRow(
          tracker,
          view,
          `the served assignments could not be read: ${view.unavailable}`,
          view.unavailableCause,
        ),
      );
    }
    got.claimsUnread = claimsUnread(view);
    if (view.unavailable !== undefined) got.claimsCause = view.unavailableCause;
    const progress = view.progress();
    got.claimed = progress.map(servedClaim);
    // Claims are monitored either way; an invalid scope only starts nothing.
    if (options.repoScope?.invalid !== undefined) return got;
    // The walk fills `got` as it goes, so a limit met in a later generation
    // keeps what the earlier ones placed.
    await walk(
      { tracker, identity, options, cache, view, seen, ...shared },
      personRoots(view, identity, options.factory, progress),
      got,
    );
  } catch (error) {
    if (view === null) {
      got.claimsUnread = claimsUnread(null, error);
      got.claimsCause = error;
    }
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

/** Read every served identity for this adapter; an unreadable identity starts nothing. */
export async function readServedPickups(
  tracker: Tracker,
  people: readonly ServedPerson[],
  options: ServedOptions,
): Promise<ServedReading> {
  options =
    options.views === undefined ? { ...options, views: new Map() } : options;
  if (
    options.factory !== undefined &&
    people.some(
      (p) =>
        p.tracker[tracker.adapter as keyof ServedPerson["tracker"]] ===
        options.factory?.identity,
    )
  ) {
    const { factory: _factory, ...withoutFactory } = options;
    options = withoutFactory;
  }
  const cache = cacheForTracker(tracker, options.cache ?? pickupReads);
  const out: ServedReading = { wanted: [], unplaced: [], claimed: [] };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const shared: EpicState = {
    walks: [],
    reported: new Set(),
  };
  let limited: PersonReading["limited"] = null;
  if (options.repoScope?.invalid !== undefined)
    out.unplaced.push({
      target: tracker.adapter,
      record: "tracker",
      reason: `served pickups are refused: the repository scope is invalid: ${options.repoScope.invalid}`,
    });
  const identities = [...people];
  if (
    options.factory !== undefined &&
    !identities.some(
      (p) =>
        p.tracker[tracker.adapter as keyof ServedPerson["tracker"]] ===
        options.factory?.identity,
    )
  )
    identities.push({
      name: options.factory.identity,
      forge: [],
      tracker: { [tracker.adapter]: options.factory.identity },
    });
  for (const person of identities) {
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
    if (got.claimsUnread !== null) {
      out.claimsUnknown = true;
      out.unplaced.push(
        claimsUnreadRow(
          identity,
          got.claimsUnread,
          noCredentialFailure(got.claimsCause),
        ),
      );
    }
    candidates.push(...got.candidates);
    noteFailure(out, got);
    limited ??= got.limited;
  }
  if (limited !== null) {
    out.unplaced.push(limitedRow(tracker, limited.error, limited.view));
    out.limitedUntil = isoFromMs(limited.error.resetAt);
  }
  finishAdmission(candidates, shared, out, options);
  return out;
}

/** The parent hold of a pulled item, read with no cache of the tick's own. */
function freshParentHold(
  tracker: Tracker,
  issue: PoolIssue,
  policy: ServedPolicy,
): Promise<string | null> {
  const none = { get: () => null, set: () => undefined };
  return servedParentHold(
    tracker,
    issue,
    none,
    policy.executionPlanBlock,
    undefined,
    policy.mergeEvidence,
    policy.personHold,
  );
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
    if (isEpicPickup(issue)) return EPIC_PICKUP_REASON;
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
    const parentHold = await freshParentHold(tracker, issue, policy);
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
  /** Every epic the walk passed through to reach the item, outermost to nearest. */
  ancestors?: string[] | undefined;
  by: string | undefined;
  epicOrder: number | undefined;
  planHold: string | undefined;
  /** Set for a blocker pulled forward: the item whose authority it is worked on. */
  pull?: PullOrigin | undefined;
}
interface WalkContext {
  tracker: Tracker;
  identity: string;
  options: ServedOptions;
  cache: PickupReads;
  view: ServedView;
  seen: Set<string>;
  walks: EpicWalk[];
  reported: Set<string>;
}
/** What one node of the walk found, merged in the walk's order. */
interface Found {
  unplaced: Unplaced[];
  candidates: Candidate[];
  pending: Pending[];
  /** What failed each read of this node that fails the record. */
  failures: unknown[];
  /** A read of this node failed: the claims below it are unknown. */
  partial: boolean;
}

/**
 * Visit the roots, then each generation of children at once so their reads
 * leave together, merging each node's finds in order into `all`. A
 * rate-limited read ends the walk with the earlier generations' finds in `all`.
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
      all.partial ||= found.partial;
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
        return {
          child: await view.pool(kept.identifier),
          threw: false as const,
        };
      } catch (error) {
        return { child: null, threw: true as const, error };
      }
    }),
  );
  const children: PoolIssue[] = [];
  const unread: string[] = [];
  const limits: unknown[] = [];
  meta.children.forEach((kept, i) => {
    const got = read[i];
    const child = got?.child ?? null;
    const threw = got?.threw === true;
    const error = got?.threw ? got.error : undefined;
    if (isRateLimited(error)) {
      limits.push(error);
      return;
    }
    if (child === null || child.truncated.length) {
      unread.push(kept.identifier);
      if (threw) itemFailed(found, error);
      else itemFailed(found);
      found.unplaced.push({
        ...itemOf(kept),
        record: "tracker",
        reason: threw
          ? `the child cannot be read: ${failureText(error)}`
          : "the child cannot be read completely",
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
  ancestors: readonly string[],
  meta: Metadata,
  candidate: Candidate,
  found: Found,
): Promise<void> {
  const { options } = ctx;
  const { children, unread } = await readChildren(ctx, meta, found);
  const planned = servedPlan(
    meta.description ?? "",
    issue.identifier,
    {},
    options.executionPlanBlock,
  ).present;
  const live = await childStates(
    ctx,
    children,
    meta,
    found,
    planned ? undefined : unread,
  );
  const selection = servedPlan(
    meta.description ?? "",
    issue.identifier,
    live,
    options.executionPlanBlock,
    await childMergeEvidence(ctx.tracker, meta.description, options),
  );
  const parked = selection.present
    ? []
    : children.filter((c) => parkedOnPerson(c, ctx.tracker, options));
  ctx.walks.push({
    key: issue.identifier,
    children: children.map((c) => c.identifier),
    unread,
    working: children.some(
      (child) => child.state.type === "started" && !parked.includes(child),
    ),
    parked: parked.map((c) => c.identifier),
  });
  for (const child of children) {
    found.pending.push({
      issue: child,
      ancestor: ancestor ?? issue.identifier,
      ancestors: [...ancestors, issue.identifier],
      by: candidate.by,
      epicOrder: selection.present
        ? selection.order.indexOf(child.identifier)
        : undefined,
      planHold: childPlanHold(selection, child.identifier),
    });
  }
}

/**
 * Whether the walk passes this node by: seen, nothing to start and no epic to
 * walk, another repository's item, or one no label places that the default
 * repository starts (an epic is still walked; its children carry labels).
 */
function leavesNode(
  issue: PoolIssue,
  options: ServedOptions,
  seen: ReadonlySet<string>,
  tracker: Pick<Tracker, "stateName">,
): boolean {
  const walkedEpic = issue.hasOpenChildren && !closed(issue);
  if (
    seenOrHeld(issue, options, seen) ||
    (!readyForWalk(issue, tracker, options) && !walkedEpic)
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
  return {
    unplaced: [],
    candidates: [],
    pending: [],
    failures: [],
    partial: false,
  };
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
    itemFailed(found);
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
    if (!ctx.reported.has(issue.identifier))
      unreadable(issue, failureText(error), found, [error]);
  }
  return found;
}

/** An item whose queue metadata could not be read, or named no assigner: the walk's claims below it are unknown. */
function unreadable(
  issue: PoolIssue,
  why: string,
  found: Found,
  thrown: [] | [cause: unknown] = [],
): void {
  itemFailed(found, ...thrown);
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
  if (isEpicPickup(issue) && !issue.hasOpenChildren)
    return void unplace(EPIC_PICKUP_REASON);
  const carried = carriedRelations(view, issue.identifier);
  const meta = await metadata(tracker, issue, identity, cache, carried, view);
  // A kept no-assigner answer is reported as the item's unreadable row.
  if (meta.noAssigner !== undefined)
    return void unreadable(issue, meta.noAssigner, found);
  const initialHold = nodeHold(node, meta, identity, options, tracker);
  if (initialHold !== null) {
    // An epic whose description is unreadable hides its subtree: the claims below it are unknown.
    if (meta.description === null) itemFailed(found);
    return void unplace(initialHold);
  }
  const open = await openBlockers(
    (k) => view.pool(k),
    carried ?? meta.relations,
  );
  const candidate = candidateOf(node, meta, identity, open);
  candidate.factory = options.factory?.identity === identity;
  const read = view.held(issue.identifier);
  if (read !== undefined && read.parent !== undefined)
    candidate.queueRead = { relations: read.relations, parent: read.parent };
  const held = await heldReason(ctx, node, candidate, open, found);
  if (held !== null) return void unplace(held);
  if (meta.children.length > 0)
    return enqueueChildren(
      ctx,
      issue,
      ancestor,
      node.ancestors ?? [],
      meta,
      candidate,
      found,
    );
  if (issue.hasOpenChildren) {
    itemFailed(found);
    return void unplace(
      "the epic reports open children but its children cannot be read",
    );
  }
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
    !readyForWalk(issue, tracker, options) ||
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
    options.mergeEvidence,
    options.personHold,
  );
  if (parentHoldUnread(parentHold)) itemFailed(found);
  if (parentHold !== null) return void unplace(parentHold);
  const steps = await servedParentSteps(tracker, candidate.issue, cache, view);
  if (steps === null) {
    itemFailed(found);
    return void unplace("the epic ancestry cannot be read");
  }
  const chain = chainOf(steps, candidate.ancestors);
  if (chain.length > 0) candidate.ancestors = chain;
  found.candidates.push(candidate);
}

function nodeHold(
  node: Pending,
  meta: Metadata,
  identity: string,
  options: ServedOptions,
  tracker: Pick<Tracker, "stateName">,
): string | null {
  if (node.planHold) return node.planHold;
  if (parkedOnPerson(node.issue, tracker, options, true)) return PERSON_HOLD;
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

async function childStates(
  ctx: WalkContext,
  children: PoolIssue[],
  meta: Metadata,
  found: Found,
  unread?: string[],
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
  // Every read settles, and each failure is recorded as observed, before a
  // wall rejects: a sibling's slower failure is not lost to a faster limit.
  const settledInfos = await Promise.allSettled(
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
          ).catch((error: unknown) => {
            // An epic with a plan keeps the failure: its consistency needs this read.
            if (unread === undefined) return Promise.reject(error);
            return noteUnreadChild(unread, child.identifier, error, (e) => {
              // Recorded when observed: a later visit may never happen.
              if (ctx.reported.has(child.identifier)) return;
              ctx.reported.add(child.identifier);
              unreadable(child, failureText(e), found, [e]);
            });
          }),
    ),
  );
  // A rate limit outranks an ordinary failure, whichever child rejected first:
  // only the limit carries the reset time the walk must stop on.
  const rejected = settledInfos.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  const wall = rejected.find((r) => isRateLimited(r.reason)) ?? rejected.at(0);
  if (wall !== undefined) {
    // Only the selected wall propagates: every other ordinary failure is kept as this node's.
    for (const r of rejected)
      if (r !== wall && !isRateLimited(r.reason)) itemFailed(found, r.reason);
    return Promise.reject(wall.reason);
  }
  const infos = settledInfos.map((r) =>
    r.status === "fulfilled" ? r.value : null,
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
    ...(node.ancestors === undefined ? {} : { ancestors: node.ancestors }),
    blockers: open.map((b) => b.key),
    ...(node.pull === undefined ? {} : { blockingFor: node.pull.root }),
    ...(node.epicOrder === undefined ? {} : { epicOrder: node.epicOrder }),
    unblocks: meta.relations.filter((r) => r.type === "blocks").length,
  };
}

/** Why a node starts nothing now; one held only by open blockers queues the blockers it may pull forward. */
async function heldReason(
  ctx: WalkContext,
  node: Pending,
  candidate: Candidate,
  open: readonly OpenBlocker[],
  found: Found,
): Promise<string | null> {
  const { tracker, options, cache, view } = ctx;
  const held = queueHold(candidate, options);
  if (held === null || open.length === 0 || candidate.factory) return held;
  if (queueHold({ ...candidate, blockers: [] }, options) !== null) return held;
  // An item behind its epic's human gate authorizes no work, its blockers' included: the served item and each pulled item between.
  const parentHold = await servedParentHold(
    tracker,
    node.issue,
    cache,
    options.executionPlanBlock,
    view,
    options.mergeEvidence,
    options.personHold,
  );
  if (parentHoldUnread(parentHold)) itemFailed(found);
  if (parentHold !== null) return parentHold;
  // The blocked node's own tracker epics reach every blocker pulled for it, whether or not the walk passed through them.
  const steps = await servedParentSteps(tracker, node.issue, cache, view);
  if (steps === null) {
    itemFailed(found);
    return "the epic ancestry cannot be read";
  }
  const chain = chainOf(steps, node.ancestors);
  const origin =
    node.pull === undefined
      ? undefined
      : {
          ...node.pull,
          rootAncestors: [
            ...(node.pull.rootAncestors ?? []),
            ...chain.filter(
              (k) => !(node.pull?.rootAncestors ?? []).includes(k),
            ),
          ],
        };
  const pull = pullBlockers(
    node.issue,
    origin,
    { ancestor: node.ancestor, ancestors: chain },
    open,
    {
      hitl: options.hitl,
      manualOps: options.manualOps,
      repoScope: options.repoScope,
      canAssign: tracker.assignUnassigned !== undefined,
      blockedState: (item) =>
        tracker.stateName("blocked", item.nativeType ?? null),
    },
  );
  // A tracker that cannot assign without replacing a concurrent assignee refuses the claim, so no launch is spent on it; each blocker is still explained.
  if (pull.pulled.length > 0 && tracker.assignUnassigned === undefined)
    return `${pull.reason}; this issue service cannot assign a blocker on its own, so a person assigns it`;
  found.pending.push(...pulledNodes(pull, ctx.seen, candidate.by));
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
  if (isEpicPickup(issue)) return "the pulled blocker has become an epic";
  const origin = await tracker.poolIssue(blockingFor);
  if (
    origin === null ||
    !ready(origin, tracker.stateName("blocked", origin.nativeType ?? null))
  )
    return `${blockingFor}, which it blocks, is no longer open and not started`;
  if (queueHold({ issue: origin, blockers: [], unblocks: 0 }, policy) !== null)
    return `${blockingFor}, which it blocks, needs a person to start`;
  const originHold = await freshParentHold(tracker, origin, policy);
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
      (await freshParentHold(tracker, item as PoolIssue, policy)) === null
    );
  };
  return (await blocksWithin(tracker, blockingFor, issue.identifier, through))
    ? null
    : `it no longer blocks ${blockingFor}`;
}
