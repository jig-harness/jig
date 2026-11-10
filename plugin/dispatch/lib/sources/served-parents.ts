/** Direct assignments obey the same ancestor execution plans as inherited work. */
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  readExecutionPlan,
  type LiveIssue,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { servedPlan } from "./served-plan.ts";

async function body(tracker: Tracker, issue: PoolIssue, cache: PickupReads) {
  const key = `${tracker.adapter}:${tracker.team}:parent-plan:${issue.identifier}`;
  const kept = cache.get<{
    updatedAt: string;
    description: string;
    parent: string | null;
  }>(key);
  if (issue.updatedAt && kept?.updatedAt === issue.updatedAt) return kept;
  const full = await tracker.getIssue(issue.identifier);
  if (full === null || full.identifier !== issue.identifier) return null;
  const value = {
    updatedAt: issue.updatedAt ?? "",
    description: full.description,
    parent: full.parent?.identifier ?? null,
  };
  if (issue.updatedAt) cache.set(key, value);
  return value;
}

/** No merge evidence is inferred from tracker completion; such edges stay held. */
export async function servedParentHold(
  tracker: Tracker,
  issue: PoolIssue,
  cache: PickupReads,
  block?: string,
): Promise<string | null> {
  const seen = new Set<string>();
  let child = issue;
  for (;;) {
    if (seen.has(child.identifier) || seen.size >= 100)
      return "the epic ancestry is cyclic or too deep";
    seen.add(child.identifier);
    const full = await body(tracker, child, cache);
    if (full === null) return "the item's parent plan cannot be read";
    if (full.parent === null) return null;
    const parent = await tracker.poolIssue(full.parent);
    if (parent === null || parent.truncated.length)
      return "the parent cannot be read completely";
    const parentBody = await body(tracker, parent, cache);
    if (parentBody === null) return "the parent plan cannot be read";
    const held = await parentStepHold(
      tracker,
      child.identifier,
      parent.identifier,
      parentBody.description,
      block,
    );
    if (held !== null) return held;
    child = parent;
  }
}

async function planLive(
  tracker: Tracker,
  description: string,
  block?: string,
): Promise<Record<string, LiveIssue>> {
  const plan = readExecutionPlan(description, block);
  const keys = new Set([
    ...(plan?.steps.map((s) => s.issue) ?? []),
    ...(plan?.edges.map((e) => e.from) ?? []),
  ]);
  const live: Record<string, LiveIssue> = {};
  for (const key of keys) {
    const current = await tracker.poolIssue(key);
    if (current !== null && !current.truncated.length)
      live[key] = { state: current.state.type, blockedBy: [] };
  }
  return live;
}
async function parentStepHold(
  tracker: Tracker,
  child: string,
  parent: string,
  description: string,
  block?: string,
): Promise<string | null> {
  const selected = servedPlan(
    description,
    parent,
    await planLive(tracker, description, block),
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
