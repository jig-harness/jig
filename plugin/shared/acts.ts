/**
 * What a person does about a need: one act from a closed list, so a reader
 * sees at a glance whether a need asks them to merge, to choose, to allow,
 * to reply, to do a step by hand, or to look into a failure. The dashboard's
 * cards and `jig ask` both read the act from here, so the two never name
 * different acts for the same need.
 *
 * Pure data and functions with no imports: the dashboard's page bundles it.
 */

/** The acts, in the order the dashboard groups them. */
export const NEED_ACTS = [
  "Merge",
  "Decide",
  "Authorize",
  "Reply",
  "Do",
  "Investigate",
] as const;
export type NeedAct = (typeof NEED_ACTS)[number];

/** An act the table holds under its own key; `constructor` and the other inherited names have none. */
function ownAct(
  table: Readonly<Record<string, NeedAct>>,
  key: string,
): NeedAct | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The act a park under each registry class asks for. */
const CLASS_ACTS: Readonly<Record<string, NeedAct>> = {
  scope: "Decide",
  "next-item": "Decide",
  "reopen-or-waive": "Decide",
  escalated: "Decide",
  "human-decision": "Decide",
  merge: "Merge",
  ready: "Authorize",
  release: "Authorize",
  destructive: "Authorize",
  legal: "Authorize",
  copy: "Authorize",
  "dark-dial": "Authorize",
  rules: "Authorize",
  "reviewer-posture": "Authorize",
  "human-thread": "Reply",
  // The dispatcher's own framings of a need (`decisions/station.ts`): each
  // option is a step the tick carries out once a person chooses it.
  "followup-recovery": "Decide",
  "pickup-recovery": "Decide",
  "checkout-recovery": "Decide",
  "drive-recovery": "Decide",
  "launch-recovery": "Decide",
};

/**
 * The act a park under `decisionClass` asks for. A class with no act of its
 * own, a repository's class included, reads Decide: a need is never hidden
 * for want of an act.
 */
export function actOfClass(decisionClass: string | null | undefined): NeedAct {
  return (
    (decisionClass == null ? undefined : ownAct(CLASS_ACTS, decisionClass)) ??
    "Decide"
  );
}

/**
 * The act the table lists for `decisionClass` by name; `undefined` for a
 * class it does not list (a repository's own class), which `actOfClass`
 * reads as Decide only as a fallback. A send that approves several items at
 * once takes only a class listed as Decide here.
 */
export function listedActOfClass(
  decisionClass: string | null | undefined,
): NeedAct | undefined {
  return decisionClass == null ? undefined : ownAct(CLASS_ACTS, decisionClass);
}

/** The act each cause the dispatcher finds waiting on a person asks for; a park's act is its class's. */
const CAUSE_ACTS: Readonly<Record<string, NeedAct>> = {
  "needs-person": "Investigate",
  "stopped-unknown": "Investigate",
  "followup-failed": "Investigate",
  "followup-stale": "Investigate",
  "double-claim": "Investigate",
  stalled: "Investigate",
  "nudge-unanswered": "Reply",
  "assigner-cannot-write": "Do",
};

/**
 * The act a need asks for: a stuck launch record nobody framed is
 * investigated, a park or any need that carries a framed decision asks for
 * its oldest decision's class's act, and any other cause for its own. An
 * unknown cause reads Decide.
 */
export function actOfNeed(need: {
  cause: string;
  decisionClass?: string | null;
  stuck?: boolean;
}): NeedAct {
  if (need.stuck === true) return "Investigate";
  if (need.cause === "parked" || need.decisionClass != null)
    return actOfClass(need.decisionClass);
  return ownAct(CAUSE_ACTS, need.cause) ?? "Decide";
}

/** The act a need on the dashboard's line asks for: the one the line kept, or, on a line written before it kept one, derived as the tick derives it. */
export function actOfLineNeed(need: {
  act?: NeedAct;
  cause: string;
  decisions: ReadonlyArray<{ decisionClass: string | null }>;
  stuckRecord?: string | null;
}): NeedAct {
  return (
    need.act ??
    actOfNeed({
      cause: need.cause,
      decisionClass: need.decisions[0]?.decisionClass ?? null,
      stuck: need.stuckRecord != null,
    })
  );
}
