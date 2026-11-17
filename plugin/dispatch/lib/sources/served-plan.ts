import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { planMergeEvidence, type PlanMergeReader } from "./plan-merges.ts";
/** Execution-plan eligibility is shared with interactive pickup; absent merge proof holds a conflict. */
import {
  eligibleIssues,
  hasExecutionPlanHeading,
  humanGates,
  planContradictions,
  readExecutionPlan,
  type LiveIssue,
  type ExecutionPlan,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import { failureText } from "../text.ts";
import { PERSON_HOLD } from "../queue-rank.ts";

/** Every issue a plan names (its steps and its edges' predecessors), after `first`, once each. */
export function planKeys(
  description: string,
  block: string | undefined,
  first: readonly string[] = [],
): string[] {
  const plan = readExecutionPlan(description, block);
  return [
    ...new Set([
      ...first,
      ...(plan?.steps.map((s) => s.issue) ?? []),
      ...(plan?.edges.map((e) => e.from) ?? []),
    ]),
  ];
}

export interface ServedPlan {
  present: boolean;
  order: string[];
  holds: Record<string, string>;
  error?: string;
}
export function servedPlan(
  description: string,
  epic: string,
  live: Record<string, LiveIssue>,
  block?: string,
  evidence: { merged: string[]; held: Record<string, string> } = {
    merged: [],
    held: {},
  },
): ServedPlan {
  try {
    const plan = readExecutionPlan(description, block);
    if (plan === null)
      return hasExecutionPlanHeading(description)
        ? {
            present: true,
            order: [],
            holds: {},
            error:
              "Execution Plan lacks its machine-readable block; re-run the planner",
          }
        : { present: false, order: [], holds: {} };
    if (plan.epic !== epic)
      return {
        present: true,
        order: [],
        holds: {},
        error: "Execution plan belongs to a different epic",
      };
    const contradictions = planContradictions(plan, live);
    if (contradictions.length > 0)
      return {
        present: true,
        order: [],
        holds: {},
        error: `Execution plan contradicts the tracker's blocks: ${contradictions.join("; ")}`,
      };
    // A blocker outside the plan is the queue's to hold or pull; only the plan's own steps order it.
    const steps = new Set(plan.steps.map((s) => s.issue));
    const inPlan: Record<string, LiveIssue> = {};
    for (const [key, item] of Object.entries(live))
      inPlan[key] = {
        ...item,
        blockedBy: Array.isArray(item.blockedBy)
          ? item.blockedBy.filter(
              (b) => steps.has(b) || live[b]?.state === "completed",
            )
          : item.blockedBy,
      };
    const order = eligibleIssues(plan, inPlan, evidence.merged);
    const holds: Record<string, string> = {};
    for (const step of plan.steps)
      if (!order.includes(step.issue))
        holds[step.issue] = "waiting on the epic execution plan";
    mergeHolds(plan, evidence.held, holds);
    for (const gate of humanGates(plan)) holds[gate.issue] = PERSON_HOLD;
    return { present: true, order, holds };
  } catch (error) {
    return { present: true, order: [], holds: {}, error: failureText(error) };
  }
}

/** A failed merge proof explains the conflict hold without overriding other plan gates. */
function mergeHolds(
  plan: ExecutionPlan,
  reasons: Record<string, string>,
  holds: Record<string, string>,
): void {
  for (const edge of plan.edges) {
    const reason = reasons[`${edge.from}>${edge.to}`];
    if (reason && holds[edge.to]) holds[edge.to] = reason;
  }
}

/** Resolve merge proof separately from the child walk's occupancy and selection. */
export function childMergeEvidence(
  tracker: Tracker,
  description: string | null,
  policy: {
    executionPlanBlock?: string;
    mergeEvidence?: PlanMergeReader | undefined;
  },
) {
  return planMergeEvidence(
    tracker,
    description ?? "",
    policy.executionPlanBlock,
    policy.mergeEvidence,
  );
}
