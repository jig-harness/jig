/** Direct assignments obey the same ancestor execution plans as inherited work. */
import type {
  PoolIssue,
  QueueParent,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { LiveIssue } from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { trackerScope, type HeldIssue } from "./served-reads.ts";
import { planKeys, servedPlan } from "./served-plan.ts";

/**
 * How the parent walk reads: one issue by key, and what a queue read already
 * carried (an assigned issue's parent, a parent's description), so the walk
 * reads it again only when the queue did not carry it.
 */
export interface ParentReads {
  pool(key: string): Promise<PoolIssue | null>;
  /** One read per key in the tick, where the reads are shared. */
  once?<T>(key: string, read: () => Promise<T>): Promise<T>;
  held?(key: string): HeldIssue | undefined;
  parentBody?(key: string): QueueParent | undefined;
}

/** Reads straight from the tracker, for the launch's fresh check. */
function directReads(tracker: Tracker): ParentReads {
  return { pool: (key) => tracker.poolIssue(key) };
}

interface Body {
  updatedAt: string;
  description: string;
  parent: string | null;
}

async function body(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  reads: ParentReads,
): Promise<Body | null> {
  const key = `${trackerScope(tracker)}:parent-plan:${issue.identifier}`;
  const kept = cache.get<Body>(key);
  const fresh = issue.updatedAt && kept?.updatedAt === issue.updatedAt;
  const carried = reads.parentBody?.(issue.identifier);
  if (carried !== undefined && carried.issue.updatedAt === issue.updatedAt) {
    const value = {
      updatedAt: issue.updatedAt ?? "",
      description: carried.description,
      parent: carried.parent,
    };
    // Kept for a tick whose reads carry no parents (the kept reading is reused).
    if (issue.updatedAt && !fresh) cache.set(key, value);
    return value;
  }
  if (fresh && kept) return kept;
  const read = () => tracker.getIssue(issue.identifier);
  const full = await (reads.once === undefined
    ? read()
    : reads.once(`issue ${issue.identifier} ${issue.updatedAt ?? ""}`, read));
  if (full === null || full.identifier !== issue.identifier) return null;
  const value = {
    updatedAt: issue.updatedAt ?? "",
    description: full.description,
    parent: full.parent?.identifier ?? null,
  };
  if (issue.updatedAt) cache.set(key, value);
  return value;
}

/** The issue's parent's key (`null` for none), from the queue read where it carried it; `null` overall when unreadable. */
async function parentOf(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  reads: ParentReads,
): Promise<{ parent: string | null } | null> {
  const key = `${trackerScope(tracker)}:parent-of:${issue.identifier}`;
  const kept = cache.get<{ updatedAt: string; parent: string | null }>(key);
  const fresh = issue.updatedAt && kept?.updatedAt === issue.updatedAt;
  const held = reads.held?.(issue.identifier);
  if (held !== undefined && held.parent !== undefined) {
    const parent = held.parent?.issue.identifier ?? null;
    // Kept for a tick whose reads carry no parents (the kept reading is reused).
    if (issue.updatedAt && !fresh)
      cache.set(key, { updatedAt: issue.updatedAt, parent });
    return { parent };
  }
  if (fresh && kept) return { parent: kept.parent };
  const full = await body(tracker, issue, cache, reads);
  return full === null ? null : { parent: full.parent };
}

/** No merge evidence is inferred from tracker completion; such edges stay held. */
export async function servedParentHold(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  block?: string,
  reads: ParentReads = directReads(tracker),
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
): Promise<string | null> {
  const selected = servedPlan(
    description,
    parent,
    await planLive(reads, description, block),
    block,
  );
  if (selected.error) return selected.error;
  if (!selected.present) return null;
  const held = selected.holds[child];
  if (held) return held;
  return selected.order.includes(child)
    ? null
    : "waiting on the epic execution plan";
}
