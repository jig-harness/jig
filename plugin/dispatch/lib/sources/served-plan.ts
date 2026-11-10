/** Execution-plan eligibility is shared with interactive pickup; absent merge proof holds a conflict. */
import {
  eligibleIssues,
  hasExecutionPlanHeading,
  humanGates,
  readExecutionPlan,
  type LiveIssue,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import { failureText } from "../text.ts";

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
    const order = eligibleIssues(plan, live, []);
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
