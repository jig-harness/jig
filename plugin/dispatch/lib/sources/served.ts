/**
 * Served assignments, inherited through epics, with metadata kept at
 * updatedAt. The tracker is read through the tick's view of the person's
 * queue (`served-reads.ts`): one queue read, batched lookups, and the
 * previous reading reused when the change probe finds nothing changed. A
 * read the tracker's rate limit refuses stops the walk, which reports the
 * limit once rather than one unplaced row per item.
 */
import type {
  Assigner,
  IssueRelation,
  PoolIssue,
  QueueRelation,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  isRateLimited,
  type TrackerRateLimited,
} from "../../../shared/tracker-budget.ts";
import { servedParentHold } from "./served-parents.ts";
import {
  NEEDS_REPOSITORY_LABEL,
  otherRepoLabel,
  type RepoScope,
  type UnlabeledMode,
  unlabeledOutcome,
} from "./served-repo.ts";
import { planKeys, servedPlan } from "./served-plan.ts";
import {
  type ServedView,
  type ServedViews,
  sharedView,
} from "./served-reads.ts";
import type { LiveIssue } from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { ServedPerson } from "../serve-config.ts";
import { pickupReads, type PickupReads } from "../pickup-reads.ts";
import { queueHold, rankQueue, type QueueItem } from "../queue-rank.ts";
import { failureText } from "../text.ts";
import type { ClaimedItem, Unplaced, WantedItem } from "../types.ts";

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
  /** The tracker refused the reads for its rate limit: until when, in ISO 8601. */
  limitedUntil?: string;
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
  epic: string;
  nowMs: number;
  headroom: boolean;
  /** The tick's views, shared by every repository that reads the same tracker, team and person. */
  views?: ServedViews;
}
const closed = (i: PoolIssue) =>
  ["completed", "canceled", "duplicate"].includes(i.state.type);
const closedType = (type: string) =>
  ["completed", "canceled", "duplicate"].includes(type);
const ready = (i: PoolIssue) =>
  !closed(i) && ["triage", "backlog", "unstarted"].includes(i.state.type);

/** Cache entries without a timestamp are never reused. */
async function metadata(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  epic: string,
  cache: PickupReads,
  carried: QueueRelation[] | null,
): Promise<Metadata> {
  const key = `${tracker.adapter}:${tracker.team}:item:${issue.identifier}:${identity}:${epic}`;
  const kept = cache.get<Metadata>(key);
  if (issue.updatedAt && kept?.updatedAt === issue.updatedAt)
    return carried === null
      ? kept
      : {
          ...kept,
          relations: carried.map(({ type, issue: i }) => ({ type, issue: i })),
        };
  const by =
    issue.assignee === null
      ? null
      : await tracker.assignedBy(issue.identifier, identity);
  const relations =
    carried === null
      ? await tracker.listRelations(issue.identifier)
      : carried.map(({ type, issue: i }) => ({ type, issue: i }));
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

/**
 * The open blockers among `relations`: a relation the queue read carried
 * with the blocker's state needs no read; the others are read together. A
 * failed blocker read holds the item: absence of evidence never means
 * unblocked.
 */
async function blockers(
  pool: (key: string) => Promise<PoolIssue | null>,
  relations: ReadonlyArray<IssueRelation | QueueRelation>,
): Promise<string[]> {
  const blocking = relations.filter((r) => r.type === "blocked_by");
  const states = await Promise.all(
    blocking.map(async (r) => {
      const known = "state" in r ? r.state : null;
      if (known !== null) return known;
      const other = await pool(r.issue);
      return other === null ? null : other.state.type;
    }),
  );
  return blocking
    .filter((_, i) => {
      const state = states[i];
      return state === null || state === undefined || !closedType(state);
    })
    .map((r) => r.issue);
}

/** The single row a rate-limited tracker leaves on the receipt. */
export function limitedRow(
  tracker: Pick<Tracker, "adapter" | "team">,
  limited: TrackerRateLimited,
  view: Pick<ServedView, "readAt"> | null = null,
): Unplaced {
  const until = new Date(limited.resetAt).toISOString();
  const kept =
    view !== null && view.readAt > 0
      ? `; the queue shown is the reading of ${new Date(view.readAt).toISOString()}`
      : "";
  return {
    target: `${tracker.adapter} ${tracker.team}`,
    record: "tracker",
    reason: `the tracker is rate limited until ${until}: pickups wait for the reset, and no request is sent before it${kept}`,
  };
}

/** What one served identity's queue gave: its claims, its holds and candidates, and the limit that stopped it. */
interface PersonReading {
  claimed: ClaimedItem[];
  unplaced: Unplaced[];
  candidates: Candidate[];
  limited: { error: TrackerRateLimited; view: ServedView | null } | null;
}

/** Read one served identity's queue and walk it; an unreadable one is one unplaced row. */
async function readPerson(
  tracker: Tracker,
  identity: string,
  options: ServedOptions,
  cache: PickupReads,
  seen: Set<string>,
): Promise<PersonReading> {
  const got: PersonReading = {
    claimed: [],
    unplaced: [],
    candidates: [],
    limited: null,
  };
  let view: ServedView | null = null;
  try {
    view = await sharedView(options.views, tracker, identity, options, cache);
    if (view.limited !== null) got.limited = { error: view.limited, view };
    const progress = view.progress();
    got.claimed = progress.map((i) => ({
      key: i.identifier,
      title: i.title,
      state: i.state.name,
    }));
    // Claims are monitored either way; an invalid scope only starts nothing.
    if (options.repoScope?.invalid !== undefined) return got;
    // The walk fills `got` as it goes, so a limit met in a later generation
    // keeps what the earlier ones placed.
    await walk(
      { tracker, identity, options, cache, view, seen },
      [
        ...view.open().map((h) => h.issue),
        ...progress.filter(
          (i) => i.labels.includes(options.epic) && i.hasOpenChildren,
        ),
      ],
      got,
    );
    if (view.limited === null) view.save();
  } catch (error) {
    if (isRateLimited(error)) got.limited ??= { error, view };
    else
      got.unplaced.push({
        target: identity,
        record: "tracker",
        reason: `the served assignments could not be read: ${failureText(error)}`,
      });
  }
  return got;
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
    const got = await readPerson(tracker, identity, options, cache, seen);
    out.claimed.push(...got.claimed);
    out.unplaced.push(...got.unplaced);
    candidates.push(...got.candidates);
    limited ??= got.limited;
  }
  if (limited !== null) {
    out.unplaced.push(limitedRow(tracker, limited.error, limited.view));
    out.limitedUntil = new Date(limited.error.resetAt).toISOString();
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
        blockers: await blockers(
          (k) => tracker.poolIssue(k),
          await tracker.listRelations(key),
        ),
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
  view: ServedView;
  seen: Set<string>;
}
/** What one node of the walk found, merged in the walk's order. */
interface Found {
  unplaced: Unplaced[];
  candidates: Candidate[];
  pending: Pending[];
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
  all: Omit<Found, "pending"> = { unplaced: [], candidates: [] },
): Promise<Omit<Found, "pending">> {
  let generation: Pending[] = roots.map((issue) => ({
    issue,
    ancestor: undefined,
    by: undefined,
    epicOrder: undefined,
    planHold: undefined,
  }));
  while (generation.length > 0) {
    const found = await Promise.all(
      generation.map((node) => visitNode(ctx, node)),
    );
    generation = [];
    for (const f of found) {
      all.unplaced.push(...f.unplaced);
      all.candidates.push(...f.candidates);
      generation.push(...f.pending);
    }
  }
  return all;
}

async function enqueueChildren(
  ctx: WalkContext,
  issue: PoolIssue,
  ancestor: string | undefined,
  meta: Metadata,
  candidate: Candidate,
  found: Found,
): Promise<void> {
  const { options, view } = ctx;
  const read = await Promise.all(
    meta.children.map((kept) => view.pool(kept.identifier)),
  );
  const children: PoolIssue[] = [];
  meta.children.forEach((kept, i) => {
    const child = read[i];
    if (child === null || child === undefined || child.truncated.length) {
      found.unplaced.push({
        target: kept.identifier,
        record: "tracker",
        reason: "the child cannot be read completely",
      });
      return;
    }
    children.push(child);
  });
  const live = await childStates(ctx, children, meta);
  const selection = servedPlan(
    meta.description ?? "",
    issue.identifier,
    live,
    options.executionPlanBlock,
  );
  for (const child of children)
    found.pending.push({
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

async function visitNode(ctx: WalkContext, node: Pending): Promise<Found> {
  const { options, seen } = ctx;
  const found: Found = { unplaced: [], candidates: [], pending: [] };
  const { issue, ancestor } = node;
  if (leavesNode(issue, options, seen)) return found;
  // A child assigned elsewhere is not inherited. A direct assignment is read in its owner's list.
  if (ancestor !== undefined && issue.assignee !== null) return found;
  seen.add(issue.identifier);
  try {
    await placeNode(ctx, node, found);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    found.unplaced.push({
      target: issue.identifier,
      record: "tracker",
      reason: `the queue metadata could not be read: ${failureText(error)}`,
    });
  }
  return found;
}

/** Read what a node needs and place it: held with why, a candidate, or an epic whose children come next. */
async function placeNode(
  ctx: WalkContext,
  node: Pending,
  found: Found,
): Promise<void> {
  const { tracker, identity, options, cache, view } = ctx;
  const { issue, ancestor } = node;
  const unplace = (reason: string, cause?: "needs-repository-label") =>
    found.unplaced.push({
      target: issue.identifier,
      record: "tracker",
      reason,
      ...(cause === undefined ? {} : { cause }),
      ...(options.trackerNamespace === undefined
        ? {}
        : { source: options.trackerNamespace }),
    });
  const carried = view.held(issue.identifier)?.relations ?? null;
  const meta = await view.once(
    `metadata ${issue.identifier} ${issue.updatedAt ?? ""} ${options.epic}`,
    () => metadata(tracker, issue, identity, options.epic, cache, carried),
  );
  const initialHold = nodeHold(node, meta, identity, options);
  if (initialHold !== null) return void unplace(initialHold);
  const candidate: Candidate = {
    issue,
    identity,
    by: meta.by?.name ?? node.by ?? "",
    ancestor,
    blockers: await blockers((k) => view.pool(k), carried ?? meta.relations),
    ...(node.epicOrder === undefined ? {} : { epicOrder: node.epicOrder }),
    unblocks: meta.relations.filter((r) => r.type === "blocks").length,
  };
  const held = queueHold(candidate, options);
  if (held !== null) return void unplace(held);
  if (meta.children.length > 0)
    return enqueueChildren(ctx, issue, ancestor, meta, candidate, found);
  if (!ready(issue) || otherRepoLabel(issue.labels, options.repoScope) !== null)
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
        : view.once(
            `metadata ${child.identifier} ${child.updatedAt ?? ""}`,
            () => metadata(tracker, child, identity, options.epic, cache, null),
          ),
    ),
  );
  const blockersOf = new Map<string, string[]>();
  keys.forEach((key, i) => {
    const child = read[i];
    const info = infos[i];
    if (child === null || child === undefined || !info) return;
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
