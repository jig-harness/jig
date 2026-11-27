/**
 * An epic whose execution plan holds a child that no rule will release:
 * the plan cannot be applied (its heading has no machine-readable block, it
 * was written for another epic, or the tracker's `blocks` contradict it), or
 * it does not name the child, such as a sub-issue added after the plan was
 * written. Only a person settles that, by re-running the planner or removing
 * the plan, so the epic raises one need of cause `epic-plan` per reading,
 * for its cause, and every child it holds names that need in its Queue line.
 * A plan step waiting on its predecessors is a wait that ends by itself and
 * raises nothing.
 */
import type { PoolIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { Unplaced } from "../types.ts";
import type { ServedPlan } from "./served-plan.ts";

/** The epic a need is raised on, with the title and link the listing returned for it. */
type PlanEpic = Pick<PoolIssue, "identifier" | "title" | "url">;

interface PlanNeed {
  epic: PlanEpic;
  /** Why the plan cannot be applied; absent when it applies but leaves children out. */
  error?: string;
  /** Open children the plan does not name, in the order they were met. */
  unplanned: string[];
}

/** The epic-plan needs one reading raised, by epic. */
export type PlanNeeds = Map<string, PlanNeed>;

/** What a person does about either cause. */
const SETTLE = "re-run the planner on it, or remove its Execution Plan section";

/** A child as the plan's need reads it: its key, its state, and whether it is an epic the walk goes into. */
type PlanChild = Pick<
  PoolIssue,
  "identifier" | "state" | "isEpic" | "hasOpenChildren"
>;

/** A child the plan's hold keeps from starting: not started yet, or an open epic whose children it holds back. */
function heldBack(child: PlanChild): boolean {
  return (
    ["triage", "backlog", "unstarted"].includes(child.state.type) ||
    (child.isEpic && child.hasOpenChildren)
  );
}

/** Notes the epic's need when the plan cannot place `child`; a reading without a sink notes nothing. */
function notePlanNeed(
  needs: PlanNeeds | undefined,
  epic: PlanEpic,
  selection: ServedPlan,
  child: PlanChild,
): void {
  if (needs === undefined || !heldBack(child)) return;
  const key = child.identifier;
  const unplanned =
    selection.error === undefined &&
    selection.steps !== undefined &&
    !selection.steps.includes(key);
  if (selection.error === undefined && !unplanned) return;
  const need = needs.get(epic.identifier) ?? { epic, unplanned: [] };
  if (selection.error !== undefined) need.error = selection.error;
  else if (!need.unplanned.includes(key)) need.unplanned.push(key);
  needs.set(epic.identifier, need);
}

/**
 * Why a child waits on its epic's plan, recording in `needs` the epic's
 * need when no rule will release it; an epic with no plan holds its
 * children to its width instead.
 */
export function childPlanHold(
  selection: ServedPlan,
  child: PlanChild,
  epic: PlanEpic,
  needs?: PlanNeeds,
): string | undefined {
  notePlanNeed(needs, epic, selection, child);
  const key = child.identifier;
  const raised = `so it waits on the need raised on ${epic.identifier} for a person`;
  if (selection.error !== undefined)
    return `${epic.identifier}'s execution plan cannot be applied (${selection.error}), ${raised}`;
  if (!selection.present) return undefined;
  if (selection.steps !== undefined && !selection.steps.includes(key))
    return `not in ${epic.identifier}'s execution plan, ${raised}`;
  if (selection.holds[key] !== undefined) return selection.holds[key];
  return selection.order.includes(key)
    ? undefined
    : "waiting on the epic execution plan";
}

/** The reason a need gives, framed for the person who settles it. */
function needReason(need: PlanNeed): string {
  if (need.error !== undefined)
    return `its execution plan cannot be applied, so none of its children starts: ${need.error}. A person settles it: ${SETTLE}`;
  const count = need.unplanned.length;
  const children = count === 1 ? "open child" : "open children";
  return `its execution plan does not name ${count} ${children} (${need.unplanned.join(", ")}), so ${count === 1 ? "it does" : "they do"} not start. A person settles it: ${SETTLE}`;
}

/** One need per epic the reading's plans hold children of, in the order they were met. */
export function planNeedRows(
  needs: PlanNeeds | undefined,
  namespace?: string,
): Unplaced[] {
  return [...(needs?.values() ?? [])].map((need) => ({
    target: need.epic.identifier,
    title: need.epic.title,
    url: need.epic.url,
    record: "tracker",
    reason: needReason(need),
    cause: "epic-plan",
    ...(namespace === undefined ? {} : { source: namespace }),
  }));
}
