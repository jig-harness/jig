/** Served assignments, inherited through epics, with metadata kept at updatedAt. */
import {
  type Assigner,
  type IssueRelation,
  type PoolIssue,
  type Tracker,
  workingStates,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { servedParentHold } from "./served-parents.ts";
import { otherRepoLabel, type RepoScope } from "./served-repo.ts";
import { servedPlan } from "./served-plan.ts";
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
}
export interface ServedReading {
  wanted: WantedItem[];
  unplaced: Unplaced[];
  claimed: ClaimedItem[];
}
export interface ServedPolicy {
  hitl?: string;
  manualOps?: string;
  executionPlanBlock?: string;
  /** This repository's label and the other repositories': an item carrying another's is not this checkout's to start. */
  repoScope?: RepoScope;
}
export interface ServedOptions extends ServedPolicy {
  cache?: PickupReads;
  epic: string;
  nowMs: number;
  headroom: boolean;
}
const closed = (i: PoolIssue) =>
  ["completed", "canceled", "duplicate"].includes(i.state.type);
const ready = (i: PoolIssue) =>
  !closed(i) && ["triage", "backlog", "unstarted"].includes(i.state.type);

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

/** A failed blocker read holds the item: absence of evidence never means unblocked. */
async function blockers(
  tracker: Tracker,
  relations: IssueRelation[],
): Promise<string[]> {
  const open: string[] = [];
  for (const r of relations)
    if (r.type === "blocked_by") {
      const other = await tracker.poolIssue(r.issue);
      if (other === null || !closed(other)) open.push(r.issue);
    }
  return open;
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
  out.wanted = rankQueue(candidates).map((c) => ({
    key: c.issue.identifier,
    title: c.issue.title,
    url: c.issue.url,
    state: c.issue.state.name,
    assignee: c.identity,
    assignedBy: c.by,
    servedPerson: c.identity,
    queueIssue: c.issue,
    queueRank: {
      unblocks: c.unblocks,
      ...(c.epicOrder === undefined ? {} : { epicOrder: c.epicOrder }),
    },
    ...(c.ancestor === undefined ? {} : { ancestorEpic: c.ancestor }),
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
        blockers: await blockers(tracker, await tracker.listRelations(key)),
        unblocks: 0,
      },
      policy,
    );
    if (held !== null) return held;
    const authority = await freshAuthority(tracker, issue, identity, ancestor);
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
}

async function enqueueChildren(
  ctx: WalkContext,
  issue: PoolIssue,
  ancestor: string | undefined,
  meta: Metadata,
  candidate: Candidate,
): Promise<void> {
  const { tracker, options, out, pending } = ctx;
  const children: PoolIssue[] = [];
  for (const kept of meta.children) {
    const child = await tracker.poolIssue(kept.identifier);
    if (child === null || child.truncated.length) {
      out.unplaced.push({
        target: kept.identifier,
        record: "tracker",
        reason: "the child cannot be read completely",
      });
      continue;
    }
    children.push(child);
  }
  const live = await childStates(ctx, children, meta);
  const selection = servedPlan(
    meta.description ?? "",
    issue.identifier,
    live,
    options.executionPlanBlock,
  );
  for (const child of children)
    pending.push({
      issue: child,
      ancestor: ancestor ?? issue.identifier,
      by: candidate.by,
      epicOrder: selection.present
        ? selection.order.indexOf(child.identifier)
        : undefined,
      planHold:
        selection.error ??
        selection.holds[child.identifier] ??
        (selection.present && !selection.order.includes(child.identifier)
          ? "waiting on the epic execution plan"
          : undefined),
    });
}

/**
 * Whether the walk passes this node by: already seen, nothing to start and no
 * epic to walk, or another repository's item (an epic is still walked, its
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
    !walkedEpic && otherRepoLabel(issue.labels, options.repoScope) !== null
  );
}

async function visitNode(ctx: WalkContext, node: Pending): Promise<void> {
  const { tracker, identity, options, cache, out, candidates, seen } = ctx;
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
        target: issue.identifier,
        record: "tracker",
        reason: initialHold,
      });
      return;
    }
    const candidate: Candidate = {
      issue,
      identity,
      by: meta.by?.name ?? node.by ?? "",
      ancestor,
      blockers: await blockers(tracker, meta.relations),
      ...(node.epicOrder === undefined ? {} : { epicOrder: node.epicOrder }),
      unblocks: meta.relations.filter((r) => r.type === "blocks").length,
    };
    const held = queueHold(candidate, options);
    if (held !== null) {
      out.unplaced.push({
        target: issue.identifier,
        record: "tracker",
        reason: held,
      });
      return;
    }
    if (meta.children.length > 0) {
      await enqueueChildren(ctx, issue, ancestor, meta, candidate);
    } else if (
      ready(issue) &&
      otherRepoLabel(issue.labels, options.repoScope) === null
    ) {
      const parentHold = await servedParentHold(
        tracker,
        issue,
        cache,
        options.executionPlanBlock,
      );
      if (parentHold !== null)
        out.unplaced.push({
          target: issue.identifier,
          record: "tracker",
          reason: parentHold,
        });
      else candidates.push(candidate);
    }
  } catch (error) {
    out.unplaced.push({
      target: issue.identifier,
      record: "tracker",
      reason: `the queue metadata could not be read: ${failureText(error)}`,
    });
  }
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
  if (node.ancestor === undefined && meta.by?.trusted !== true)
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
