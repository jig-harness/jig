/** Served assignments, inherited through epics, with metadata kept at updatedAt. */
import {
  type Assigner,
  type IssueRelation,
  type PoolIssue,
  type Tracker,
  workingStates,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
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
import { servedPlan, type ServedPlan } from "./served-plan.ts";
import {
  readExecutionPlan,
  type LiveIssue,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { ServedPerson } from "../serve-config.ts";
import { pickupReads, type PickupReads } from "../pickup-reads.ts";
import { queueHold, rankQueue, type QueueItem } from "../queue-rank.ts";
import { failureText } from "../text.ts";
import type { ClaimedItem, Unplaced, WantedItem } from "../types.ts";

const OPEN = ["triage", "backlog", "todo"] as const;
const REREAD_MS = 15 * 60_000;
interface Metadata {
  updatedAt: string;
  by: Assigner | null;
  relations: IssueRelation[];
  children: PoolIssue[];
  description: string | null;
}
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
}
export interface ServedPolicy {
  /** The label that marks an epic. */
  epic?: string;
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
  epic: string;
  nowMs: number;
  headroom: boolean;
}
/** An unplaced row's target, with the title and link the listing returned for it. */
const itemOf = (i: PoolIssue) => ({
  target: i.identifier,
  title: i.title,
  url: i.url,
});

/** Each identity's list is read with capacity, or on the Queue view's slow cadence. */
async function assignments(
  tracker: Tracker,
  identity: string,
  options: ServedOptions,
  cache: PickupReads,
): Promise<PoolIssue[]> {
  const key = `${tracker.adapter}:${tracker.team}:assigned:${identity}`;
  const kept = cache.get<{ at: number; issues: PoolIssue[] }>(key);
  if (!options.headroom && kept !== null && options.nowMs - kept.at < REREAD_MS)
    return kept.issues;
  const issues = await tracker.assignedIssues(identity, OPEN);
  cache.set(key, { at: options.nowMs, issues });
  return issues;
}

/** Cache entries without a timestamp are never reused. */
async function metadata(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  epic: string,
  cache: PickupReads,
): Promise<Metadata> {
  const key = `${tracker.adapter}:${tracker.team}:item:${issue.identifier}:${identity}`;
  const kept = cache.get<Metadata>(key);
  if (issue.updatedAt && kept?.updatedAt === issue.updatedAt) return kept;
  const by =
    issue.assignee === null
      ? null
      : await tracker.assignedBy(issue.identifier, identity);
  const relations = await tracker.listRelations(issue.identifier);
  const children =
    issue.labels.includes(epic) && issue.hasOpenChildren
      ? await tracker.openChildren(issue.identifier)
      : [];
  const description =
    children.length > 0
      ? ((await tracker.getIssue(issue.identifier))?.description ?? null)
      : "";
  const value = {
    updatedAt: issue.updatedAt ?? "",
    by,
    relations,
    children,
    description,
  };
  if (issue.updatedAt && description !== null) cache.set(key, value);
  return value;
}

/** Read every served identity for this adapter; an unreadable identity starts nothing. */
export async function readServedPickups(
  tracker: Tracker,
  people: readonly ServedPerson[],
  options: ServedOptions,
): Promise<ServedReading> {
  const cache = options.cache ?? pickupReads;
  const out: ServedReading = { wanted: [], unplaced: [], claimed: [] };
  const candidates: Candidate[] = [];
  const walks: EpicWalk[] = [];
  const serials = new Map<string, Serial>();
  const seen = new Set<string>();
  const refused = options.repoScope?.invalid !== undefined;
  if (refused)
    out.unplaced.push({
      target: tracker.adapter,
      record: "tracker",
      reason: `served pickups are refused: the repository scope is invalid: ${options.repoScope?.invalid}`,
    });
  for (const person of people) {
    const identity =
      person.tracker[tracker.adapter as keyof ServedPerson["tracker"]];
    if (identity === undefined) continue;
    try {
      const progress = await tracker.assignedIssues(
        identity,
        workingStates(tracker),
      );
      out.claimed.push(
        ...progress.map((i) => ({
          key: i.identifier,
          title: i.title,
          url: i.url,
          state: i.state.name,
        })),
      );
      // Claims are monitored either way; an invalid scope only starts nothing.
      if (refused) continue;
      const roots = [
        ...(await assignments(tracker, identity, options, cache)),
        ...progress.filter(
          (i) => i.labels.includes(options.epic) && i.hasOpenChildren,
        ),
      ];
      const pending = roots.map((issue) => ({
        issue,
        ancestor: undefined as string | undefined,
        by: undefined as string | undefined,
        epicOrder: undefined as number | undefined,
        planHold: undefined as string | undefined,
      }));
      const ctx: WalkContext = {
        tracker,
        identity,
        options,
        cache,
        out,
        pending,
        candidates,
        seen,
        walks,
        serials,
      };
      for (let n = 0; n < pending.length; n++) {
        const node = pending[n];
        if (node === undefined) continue;
        await visitNode(ctx, node);
      }
    } catch (error) {
      out.unplaced.push({
        target: identity,
        record: "tracker",
        reason: `the served assignments could not be read: ${failureText(error)}`,
      });
    }
  }
  for (const c of candidates) {
    const serial = serials.get(c.issue.identifier);
    if (c.serial === undefined && serial !== undefined) c.serial = serial;
  }
  const ranked = serializeEpics(rankQueue(candidates), out.unplaced);
  summarizeEpics(
    walks,
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
    if (issue === null || !ready(issue))
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
          await openBlockers(tracker, await tracker.listRelations(key))
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
  out: ServedReading;
  pending: Pending[];
  candidates: Candidate[];
  seen: Set<string>;
  walks: EpicWalk[];
  /** The one-at-a-time constraint of each child of an epic with no execution plan, whoever reaches the child first. */
  serials: Map<string, Serial>;
}

/** Reads an epic's open children; one that cannot be read is reported and set aside. */
async function readChildren(
  ctx: WalkContext,
  meta: Metadata,
): Promise<{ children: PoolIssue[]; unread: string[] }> {
  const { tracker, out } = ctx;
  const children: PoolIssue[] = [];
  const unread: string[] = [];
  for (const kept of meta.children) {
    const child = await tracker.poolIssue(kept.identifier);
    if (child === null || child.truncated.length) {
      unread.push(kept.identifier);
      out.unplaced.push({
        ...itemOf(kept),
        record: "tracker",
        reason: "the child cannot be read completely",
      });
    } else children.push(child);
  }
  return { children, unread };
}

/** Why a child waits on its epic's plan, or, with no plan, on an unreadable sibling. */
function childPlanHold(
  selection: ServedPlan,
  child: string,
  unread: readonly string[],
): string | undefined {
  if (selection.error !== undefined) return selection.error;
  if (selection.holds[child] !== undefined) return selection.holds[child];
  if (selection.present)
    return selection.order.includes(child)
      ? undefined
      : "waiting on the epic execution plan";
  // A child that cannot be read may be the one in progress, so no sibling starts on a guess.
  return unread.length > 0
    ? `${unread[0]} cannot be read, so whether a sibling is in progress is unknown`
    : undefined;
}

async function enqueueChildren(
  ctx: WalkContext,
  issue: PoolIssue,
  ancestor: string | undefined,
  meta: Metadata,
  candidate: Candidate,
): Promise<void> {
  const { options, pending } = ctx;
  const { children, unread } = await readChildren(ctx, meta);
  const live = await childStates(ctx, children, meta);
  const selection = servedPlan(
    meta.description ?? "",
    issue.identifier,
    live,
    options.executionPlanBlock,
  );
  const busy = children.find((c) => c.state.type === "started");
  ctx.walks.push({
    key: issue.identifier,
    children: children.map((c) => c.identifier),
    unread,
    working: busy !== undefined,
  });
  const serial = selection.present
    ? undefined
    : { epic: issue.identifier, busy: busy?.identifier, unread: unread[0] };
  for (const child of children) {
    if (serial !== undefined) ctx.serials.set(child.identifier, serial);
    pending.push({
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
): boolean {
  const walkedEpic =
    issue.labels.includes(options.epic) &&
    issue.hasOpenChildren &&
    !closed(issue);
  if (seen.has(issue.identifier) || (!ready(issue) && !walkedEpic)) return true;
  return (
    !walkedEpic &&
    (otherRepoLabel(issue.labels, options.repoScope) !== null ||
      unlabeledOutcome(issue.labels, options.repoScope, options.unlabeled) ===
        "leave")
  );
}

async function visitNode(ctx: WalkContext, node: Pending): Promise<void> {
  const { tracker, identity, options, cache, out, seen } = ctx;
  const { issue, ancestor } = node;
  if (leavesNode(issue, options, seen)) return;
  // A child assigned elsewhere is not inherited. A direct assignment is read in its owner's list.
  if (ancestor !== undefined && issue.assignee !== null) return;
  seen.add(issue.identifier);
  try {
    const meta = await metadata(tracker, issue, identity, options.epic, cache);
    const initialHold = nodeHold(node, meta, identity, options);
    if (initialHold !== null) {
      out.unplaced.push({
        ...itemOf(issue),
        record: "tracker",
        reason: initialHold,
      });
      return;
    }
    const open = await openBlockers(tracker, meta.relations);
    const candidate = candidateOf(node, meta, identity, open);
    const held = await heldReason(ctx, node, candidate, open);
    const placed = held ?? (await placeNode(ctx, node, meta, candidate));
    if (placed !== null)
      out.unplaced.push({
        ...itemOf(issue),
        record: "tracker",
        reason: placed,
      });
  } catch (error) {
    out.unplaced.push({
      ...itemOf(issue),
      record: "tracker",
      reason: `the queue metadata could not be read: ${failureText(error)}`,
    });
  }
}

/** A startable item with nothing left to walk: a candidate, unless no repository label places it or its parent holds it. */
async function placeLeaf(
  ctx: WalkContext,
  candidate: Candidate,
): Promise<void> {
  const { tracker, options, cache, out, candidates } = ctx;
  const { issue } = candidate;
  const hold = (reason: string, cause?: "needs-repository-label"): void => {
    out.unplaced.push({
      ...itemOf(issue),
      record: "tracker",
      reason,
      ...(cause === undefined ? {} : { cause }),
      ...(options.trackerNamespace === undefined
        ? {}
        : { source: options.trackerNamespace }),
    });
  };
  const unlabeled = unlabeledOutcome(
    issue.labels,
    options.repoScope,
    options.unlabeled,
  );
  if (unlabeled === "hold") {
    hold(NEEDS_REPOSITORY_LABEL, "needs-repository-label");
    return;
  }
  if (unlabeled === "leave") return;
  const parentHold = await servedParentHold(
    tracker,
    issue,
    cache,
    options.executionPlanBlock,
  );
  if (parentHold !== null) hold(parentHold);
  else candidates.push(candidate);
}

function nodeHold(
  node: Pending,
  meta: Metadata,
  identity: string,
  options: ServedOptions,
): string | null {
  if (node.planHold) return node.planHold;
  const hitl = options.hitl ?? "hitl";
  if (
    node.issue.labels.some(
      (l) =>
        l === hitl ||
        l.startsWith(`${hitl}:`) ||
        l === (options.manualOps ?? "manual-ops"),
    )
  )
    return "needs a person to start";
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
): Promise<Record<string, LiveIssue>> {
  const { tracker, identity, options, cache } = ctx;
  const live: Record<string, LiveIssue> = {};
  const plan = readExecutionPlan(
    meta.description ?? "",
    options.executionPlanBlock,
  );
  const keys = new Set([
    ...children.map((c) => c.identifier),
    ...(plan?.steps.map((s) => s.issue) ?? []),
    ...(plan?.edges.map((e) => e.from) ?? []),
  ]);
  for (const key of keys) {
    const child =
      children.find((c) => c.identifier === key) ??
      (await tracker.poolIssue(key));
    if (child === null || child.truncated.length) continue;
    const info = await metadata(tracker, child, identity, options.epic, cache);
    live[key] = {
      state: child.state.type,
      blockedBy: info.relations
        .filter((r) => r.type === "blocked_by")
        .map((r) => r.issue),
    };
    for (const blocker of live[key]?.blockedBy ?? []) {
      const other = await tracker.poolIssue(blocker);
      if (
        other !== null &&
        !other.truncated.length &&
        live[blocker] === undefined
      )
        live[blocker] = { state: other.state.type, blockedBy: [] };
    }
  }
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

/** An epic's children join the walk, an item with none is a candidate; the reason it is neither, if any. */
async function placeNode(
  ctx: WalkContext,
  node: Pending,
  meta: Metadata,
  candidate: Candidate,
): Promise<string | null> {
  const { options } = ctx;
  const { issue } = node;
  if (meta.children.length > 0) {
    await enqueueChildren(ctx, issue, node.ancestor, meta, candidate);
    return null;
  }
  if (!ready(issue) || otherRepoLabel(issue.labels, options.repoScope) !== null)
    return null;
  await placeLeaf(ctx, candidate);
  return null;
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
): Promise<string | null> {
  const { tracker, options, cache, pending } = ctx;
  const held = queueHold(candidate, options);
  if (held === null || open.length === 0) return held;
  if (queueHold({ ...candidate, blockers: [] }, options) !== null) return held;
  // An item behind its epic's human gate authorizes no work, its blockers' included.
  if (node.pull === undefined) {
    const parentHold = await servedParentHold(
      tracker,
      node.issue,
      cache,
      options.executionPlanBlock,
    );
    if (parentHold !== null) return parentHold;
  }
  const pull = pullBlockers(node.issue, node.pull, node.ancestor, open, {
    epic: options.epic,
    hitl: options.hitl,
    manualOps: options.manualOps,
    repoScope: options.repoScope,
  });
  for (const blocker of pull.pulled)
    if (!ctx.seen.has(blocker.identifier))
      pending.push({
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
  if (issue.hasOpenChildren || issue.labels.includes(policy.epic ?? "epic"))
    return "the pulled blocker has become an epic";
  const origin = await tracker.poolIssue(blockingFor);
  if (origin === null || !ready(origin))
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
  const through = async (via: string): Promise<boolean> =>
    whyNotPulled(await tracker.poolIssue(via), {
      epic: policy.epic ?? "epic",
      hitl: policy.hitl,
      manualOps: policy.manualOps,
      repoScope: policy.repoScope,
    }) === null;
  return (await blocksWithin(tracker, blockingFor, issue.identifier, through))
    ? null
    : `it no longer blocks ${blockingFor}`;
}
