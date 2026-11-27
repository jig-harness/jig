/**
 * What a person does about a need: one act from a closed list, so a reader
 * sees at a glance whether a need asks them to merge, to choose, to allow,
 * to reply, to do a step by hand, or to look into a failure. The dashboard's
 * cards and `jig ask` both read the act from here, so the two never name
 * different acts for the same need.
 *
 * Pure data and functions with no imports: the dashboard's page bundles it.
 */

/** The acts, in the order the dashboard groups them, each with what it asks of a person. */
export const NEED_ACT_VALUES = {
  Merge: { meaning: "Merge the pull request: only a person merges." },
  Decide: { meaning: "Choose among the options the decision frames." },
  Authorize: {
    meaning:
      "Allow, or refuse, what only a person may allow; refusing is an option of the decision's own.",
  },
  Reply: { meaning: "Answer a person's review thread." },
  Do: { meaning: "Perform steps by hand, outside the line." },
  Investigate: {
    meaning:
      "Look into what went wrong: a failure or a stall nobody framed as a decision.",
  },
} as const satisfies Readonly<Record<string, { meaning: string }>>;
export type NeedAct = keyof typeof NEED_ACT_VALUES;

/** The acts, in the order the dashboard groups them. */
export const NEED_ACTS = Object.keys(NEED_ACT_VALUES) as readonly NeedAct[];

/** A decision class, the act a park under it asks for and what it decides. */
export interface ClassAct {
  readonly act: NeedAct;
  readonly meaning: string;
}

/** An act the table holds under its own key; `constructor` and the other inherited names have none. */
function ownAct(
  table: Readonly<Record<string, NeedAct>>,
  key: string,
): NeedAct | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The act a park under each decision class Jig knows asks for: the classes
 * of the human-in-the-loop registry's template, and the dispatcher's own
 * framings of a need.
 */
export const CLASS_ACTS = {
  scope: { act: "Decide", meaning: "Expand a pull request's scope." },
  "next-item": {
    act: "Decide",
    meaning: "Pick the next item from the computed ranking.",
  },
  "reopen-or-waive": {
    act: "Decide",
    meaning:
      "Reopen an item on a rejecting verdict, or waive a missing acceptance review.",
  },
  escalated: {
    act: "Decide",
    meaning:
      "A review thread the review arbiter escalated with no recorded person's decision behind it.",
  },
  "human-decision": {
    act: "Decide",
    meaning:
      "A fix that would change what the pull request records as a person's decision, or a decision only a person can take; a pass that cannot read the repository's policy parks every decision under it.",
  },
  merge: { act: "Merge", meaning: "Merge a pull request." },
  ready: {
    act: "Authorize",
    meaning: "Mark a pull request ready for review.",
  },
  release: {
    act: "Authorize",
    meaning: "Release or promote to production.",
  },
  destructive: {
    act: "Authorize",
    meaning: "A destructive operation: data loss or a history rewrite.",
  },
  legal: {
    act: "Authorize",
    meaning: "A legal or data-protection sign-off.",
  },
  copy: { act: "Authorize", meaning: "Publish customer-facing copy." },
  "dark-dial": {
    act: "Authorize",
    meaning: "Flip a dial that is off by default.",
  },
  rules: {
    act: "Authorize",
    meaning:
      "Change the rules the agents follow: instructions and scaffolding.",
  },
  "reviewer-posture": {
    act: "Authorize",
    meaning:
      "Promote an automated reviewer to blocking, or waive a failing advisory check.",
  },
  "human-thread": {
    act: "Reply",
    meaning:
      "A person's review thread an agent may not overrule on its own, or a person's reversal of a provisional decision.",
  },
  // The drive's own park: its structural-churn brake (drive-pr's
  // `lib/state/churn.ts`) frames the decision when it stops itself.
  "structural-churn": {
    act: "Decide",
    meaning:
      "The drive's own park: the same files keep drawing non-blocking findings round after round, or a file returned to an earlier content; choose how the pull request goes on.",
  },
  // The dispatcher's own framings of a need (`decisions/station.ts`): each
  // option is a step the tick carries out once a person chooses it.
  "followup-recovery": {
    act: "Decide",
    meaning:
      "The dispatcher's framing: how a follow-up that failed or whose claim went stale goes on.",
  },
  "pickup-recovery": {
    act: "Decide",
    meaning:
      "The dispatcher's framing: how a pickup that stalled, stopped on a question or ended without moving its item goes on.",
  },
  "checkout-recovery": {
    act: "Decide",
    meaning:
      "The dispatcher's framing: how a checkout another tree holds is freed for a launch.",
  },
  "drive-recovery": {
    act: "Decide",
    meaning:
      "The dispatcher's framing: how a drive that handed its pull request to a person goes on.",
  },
  "launch-recovery": {
    act: "Decide",
    meaning:
      "The dispatcher's framing: how a launch record no tick launches again is settled.",
  },
} as const satisfies Readonly<Record<string, ClassAct>>;

/** Each class's act alone, for the lookups below. */
const ACT_OF_CLASS: Readonly<Record<string, NeedAct>> = Object.fromEntries(
  Object.entries(CLASS_ACTS).map(([name, c]) => [name, c.act]),
);

/**
 * The act a park under `decisionClass` asks for. A class with no act of its
 * own, a repository's class included, reads Decide: a need is never hidden
 * for want of an act.
 */
export function actOfClass(decisionClass: string | null | undefined): NeedAct {
  return (
    (decisionClass == null ? undefined : ownAct(ACT_OF_CLASS, decisionClass)) ??
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
  return decisionClass == null
    ? undefined
    : ownAct(ACT_OF_CLASS, decisionClass);
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
  "tracker-unreachable": "Authorize",
  "low-quota": "Investigate",
  "calls-failing": "Investigate",
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
