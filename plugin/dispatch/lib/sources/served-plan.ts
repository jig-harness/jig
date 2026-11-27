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
  /** The issues the plan places as its steps, when it could be applied. */
  steps?: string[];
  error?: string;
}

/** A plan step's state as a reader of the Queue says it. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  triage: "in triage",
  backlog: "in the backlog",
  unstarted: "not started",
  started: "in progress",
  completed: "done",
  canceled: "canceled",
};

/**
 * Why a plan step does not start yet: the predecessors it waits on, each
 * with its state (its plan edges not yet released and the other steps the
 * tracker records as blocking it), or the plan alone when none is named.
 */
function waitReason(
  plan: ExecutionPlan,
  step: string,
  live: Record<string, LiveIssue>,
  merged: readonly string[],
  held: Readonly<Record<string, string>> = {},
): string {
  const done = (key: string) => live[key]?.state === "completed";
  const state = stateWord(live);
  const waits = new Map<string, string>();
  // A failed merge proof explains its own edge; every such edge keeps its reason beside the other waits.
  const proofs: string[] = [];
  for (const edge of plan.edges.filter((e) => e.to === step)) {
    const proof = edge.completion === "merged" ? mergeKey(edge) : null;
    if (proof !== null && merged.includes(proof)) continue;
    if (proof !== null && held[proof]) proofs.push(held[proof]);
    else if (proof !== null)
      waits.set(edge.from, `${state(edge.from)}, until its merge is proven`);
    else if (!done(edge.from)) waits.set(edge.from, state(edge.from));
  }
  addBlockers(waits, live, step, state);
  return describeWaits(waits, proofs);
}

/** A step's state as a reader of the Queue says it. */
function stateWord(live: Record<string, LiveIssue>): (key: string) => string {
  return (key) => STATE_WORDS[live[key]?.state ?? ""] ?? "its state not read";
}

/** The other steps the tracker records as blocking `step` and not done, beside the plan's own edges. */
function addBlockers(
  waits: Map<string, string>,
  live: Record<string, LiveIssue>,
  step: string,
  state: (key: string) => string,
): void {
  const blockers = live[step]?.blockedBy;
  for (const key of Array.isArray(blockers) ? blockers : [])
    if (live[key]?.state !== "completed" && !waits.has(key))
      waits.set(key, state(key));
}

/** The key merge evidence records an edge under. */
function mergeKey(edge: { from: string; to: string }): string {
  return `${edge.from}>${edge.to}`;
}

/** The predecessors a step waits on, then the failed merge proofs; the plan alone when none is named. */
function describeWaits(
  waits: ReadonlyMap<string, string>,
  proofs: readonly string[],
): string {
  if (waits.size === 0)
    return proofs.length > 0
      ? proofs.join("; ")
      : "waiting on the epic execution plan";
  const named = [...waits].map(([key, how]) => `${key} (${how})`);
  const waiting = `waiting on ${named.join(", ")}, which the epic execution plan puts before it`;
  return proofs.length > 0 ? `${waiting}; ${proofs.join("; ")}` : waiting;
}

export function servedPlan(
  description: string,
  epic: string,
  live: Record<string, LiveIssue>,
  block?: string,
  evidence?: { merged: string[]; held: Record<string, string> },
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
        error: `Execution plan contradicts the blocks recorded on the issues: ${contradictions.join("; ")}`,
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
    const merged = evidence?.merged ?? [];
    const order = eligibleIssues(plan, inPlan, merged);
    const holds: Record<string, string> = {};
    for (const step of plan.steps)
      if (!order.includes(step.issue))
        holds[step.issue] = waitReason(
          plan,
          step.issue,
          inPlan,
          merged,
          evidence?.held,
        );
    for (const gate of humanGates(plan)) holds[gate.issue] = PERSON_HOLD;
    return { present: true, order, holds, steps: [...steps] };
  } catch (error) {
    return { present: true, order: [], holds: {}, error: failureText(error) };
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
