/** Direct assignments obey the same ancestor execution plans as inherited work. */
import type {
  DispatchRawIssue,
  PoolIssue,
  QueueParent,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { LiveIssue } from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { trackerScope, type HeldIssue } from "./served-reads.ts";
import { planMergeEvidence, type PlanMergeReader } from "./plan-merges.ts";
import { planKeys, servedPlan } from "./served-plan.ts";
import { freshReads } from "./fresh-reads.ts";

/**
 * How the parent walk reads: one issue by key, and what a queue read already
 * carried (an assigned issue's parent, a parent's description), so the walk
 * reads it again only when the queue did not carry it.
 */
export interface ParentReads {
  readonly readAt?: number;
  metadataEpoch?(key: string): number;
  pool(key: string): Promise<PoolIssue | null>;
  /** One read per key in the tick, where the reads are shared. */
  once?<T>(key: string, read: () => Promise<T>): Promise<T>;
  /** An issue's native row, where the reads hold native rows. */
  raw?(key: string): Promise<DispatchRawIssue | null>;
  held?(key: string): HeldIssue | undefined;
  parentBody?(key: string): QueueParent | undefined;
}

interface Body {
  updatedAt: string;
  readAt?: number | undefined;
  description: string;
  parent: string | null;
}

/** The body a read already carried of `issue`, when it is the issue's current one. */
function carriedBody(
  carried: QueueParent | undefined,
  issue: PoolIssue,
): Body | null {
  return carried !== undefined && carried.issue.updatedAt === issue.updatedAt
    ? {
        updatedAt: issue.updatedAt ?? "",
        description: carried.description,
        parent: carried.parent,
      }
    : null;
}

/** GitHub ancestry edits may leave the issue timestamp unchanged. */
function readingAt(
  tracker: Tracker,
  reads: ParentReads,
  issue: PoolIssue,
): number | undefined {
  return tracker.adapter === "github" && tracker.dispatchSource !== undefined
    ? (reads.metadataEpoch?.(issue.identifier) ?? reads.readAt)
    : undefined;
}

/** A kept entry, when it is the issue's current one. */
function current<T extends { updatedAt: string; readAt?: number | undefined }>(
  kept: T | null,
  issue: PoolIssue,
  readAt?: number,
): T | null {
  return issue.updatedAt &&
    kept?.updatedAt === issue.updatedAt &&
    (readAt === undefined ||
      (typeof kept.readAt === "number" && kept.readAt >= readAt))
    ? kept
    : null;
}

/** Keeps what a read carried, for a tick whose reads carry none (the kept reading is reused). */
function remember<T>(
  cache: PickupReads,
  key: string,
  value: T,
  kept: T | null,
  issue: PoolIssue,
): T {
  if (issue.updatedAt && kept === null) cache.set(key, value);
  return value;
}

/**
 * What the issue's native row in this reading carries of its description and
 * parent, as current as the row: `null` where the reads hold no native row
 * or the row does not carry them.
 */
async function rowBody(
  tracker: Tracker,
  issue: PoolIssue,
  reads: ParentReads,
): Promise<Body | null> {
  const describe = tracker.dispatchSource?.describe;
  if (describe === undefined || reads.raw === undefined) return null;
  const row = await reads.raw(issue.identifier);
  const carried = row === null ? null : describe(row);
  return carried === null
    ? null
    : { updatedAt: issue.updatedAt ?? "", ...carried };
}

/** The issue read whole, once per check where `reads` bounds it; `null` when the tracker has none by that key. */
async function readFull(
  tracker: Tracker,
  issue: PoolIssue,
  reads: ParentReads,
  readAt: number | undefined,
): Promise<Body | null> {
  const read = () => tracker.getIssue(issue.identifier);
  const full = await (reads.once === undefined
    ? read()
    : reads.once(`issue ${issue.identifier} ${issue.updatedAt ?? ""}`, read));
  if (full === null || full.identifier !== issue.identifier) return null;
  return {
    updatedAt: issue.updatedAt ?? "",
    readAt,
    description: full.description,
    parent: full.parent?.identifier ?? null,
  };
}

async function body(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  reads: ParentReads,
): Promise<Body | null> {
  const native = await rowBody(tracker, issue, reads);
  if (native !== null) return native;
  const key = `${trackerScope(tracker)}:parent-plan:${issue.identifier}`;
  const readAt = readingAt(tracker, reads, issue);
  const kept = current(cache.get<Body>(key), issue, readAt);
  const carried = carriedBody(reads.parentBody?.(issue.identifier), issue);
  if (carried !== null)
    return remember(cache, key, { ...carried, readAt }, kept, issue);
  if (kept !== null) return kept;
  const value = await readFull(tracker, issue, reads, readAt);
  if (value === null) return null;
  return remember(cache, key, value, null, issue);
}

/** The issue's parent's key (`null` for none), from the queue read where it carried it; `null` overall when unreadable. */
async function parentOf(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  reads: ParentReads,
): Promise<{ parent: string | null } | null> {
  const key = `${trackerScope(tracker)}:parent-of:${issue.identifier}`;
  const readAt = readingAt(tracker, reads, issue);
  const kept = current(
    cache.get<{
      updatedAt: string;
      parent: string | null;
      readAt?: number | undefined;
    }>(key),
    issue,
    readAt,
  );
  const held = reads.held?.(issue.identifier);
  if (held !== undefined && held.parent !== undefined) {
    const value = {
      updatedAt: issue.updatedAt ?? "",
      readAt,
      parent: held.parent?.issue.identifier ?? null,
    };
    return { parent: remember(cache, key, value, kept, issue).parent };
  }
  if (kept !== null) return { parent: kept.parent };
  const full = await body(tracker, issue, cache, reads);
  return full === null ? null : { parent: full.parent };
}

/**
 * Tracker completion never substitutes for directly verified delivering
 * merges. Without `reads`, the check reads fresh: straight from the tracker,
 * a plan's steps in one batch.
 */
export async function servedParentHold(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  block?: string,
  reads: ParentReads = freshReads(tracker),
  merges?: PlanMergeReader,
): Promise<string | null> {
  const seen = new Set<string>();
  let child = issue;
  let up = await parentOf(tracker, issue, cache, reads);
  for (;;) {
    if (seen.has(child.identifier) || seen.size >= 100)
      return "the epic ancestry is cyclic or too deep";
    seen.add(child.identifier);
    if (up === null) return "the item's parent plan cannot be read";
    if (up.parent === null) return null;
    const parent = await reads.pool(up.parent);
    if (parent === null || parent.truncated.length)
      return "the parent cannot be read completely";
    const parentBody = await body(tracker, parent, cache, reads);
    if (parentBody === null) return "the parent plan cannot be read";
    const held = await parentStepHold(
      reads,
      child.identifier,
      parent.identifier,
      parentBody.description,
      block,
      async (description, block) =>
        (await planMergeEvidence(tracker, description, block, merges)) ?? {
          merged: [],
          held: {},
        },
    );
    if (held !== null) return held;
    child = parent;
    up = { parent: parentBody.parent };
  }
}

/** The live state of every step a plan names, read together. */
async function planLive(
  reads: ParentReads,
  description: string,
  block?: string,
): Promise<Record<string, LiveIssue>> {
  const keys = planKeys(description, block);
  const read = await Promise.all(keys.map((key) => reads.pool(key)));
  const live: Record<string, LiveIssue> = {};
  keys.forEach((key, i) => {
    const current = read[i];
    if (current !== null && current !== undefined && !current.truncated.length)
      live[key] = { state: current.state.type, blockedBy: [] };
  });
  return live;
}

async function parentStepHold(
  reads: ParentReads,
  child: string,
  parent: string,
  description: string,
  block?: string,
  merges?: PlanMergeReader,
): Promise<string | null> {
  const selected = servedPlan(
    description,
    parent,
    await planLive(reads, description, block),
    block,
    await merges?.(description, block),
  );
  if (selected.error) return selected.error;
  if (!selected.present) return null;
  const held = selected.holds[child];
  if (held) return held;
  return selected.order.includes(child)
    ? null
    : "waiting on the epic execution plan";
}

/** The complete ancestor chain, with the direct child whose slot each parent owns. */
export async function servedParentSteps(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  reads: ParentReads,
): Promise<Array<{
  parent: PoolIssue;
  child: string;
  description: string;
}> | null> {
  const steps: Array<{
    parent: PoolIssue;
    child: string;
    description: string;
  }> = [];
  const seen = new Set<string>();
  let child = issue;
  let up = await parentOf(tracker, child, cache, reads);
  for (;;) {
    if (seen.has(child.identifier) || seen.size >= 100 || up === null)
      return null;
    seen.add(child.identifier);
    if (up.parent === null) return steps;
    const parent = await reads.pool(up.parent);
    if (parent === null || parent.truncated.length) return null;
    const full = await body(tracker, parent, cache, reads);
    if (full === null) return null;
    steps.push({
      parent,
      child: child.identifier,
      description: full.description,
    });
    child = parent;
    up = { parent: full.parent };
  }
}
