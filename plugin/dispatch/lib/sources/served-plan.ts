/** Execution-plan eligibility is shared with interactive pickup; absent merge proof holds a conflict. */
import {
  eligibleIssues,
  hasExecutionPlanHeading,
  humanGates,
  planContradictions,
  readExecutionPlan,
  type LiveIssue,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import { failureText } from "../text.ts";

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
    const order = eligibleIssues(plan, inPlan, []);
    const holds: Record<string, string> = {};
    for (const step of plan.steps)
      if (!order.includes(step.issue))
        holds[step.issue] = "waiting on the epic execution plan";
    for (const gate of humanGates(plan))
      holds[gate.issue] = "needs a person to start";
    return { present: true, order, holds };
  } catch (error) {
    return { present: true, order: [], holds: {}, error: failureText(error) };
  }
}
