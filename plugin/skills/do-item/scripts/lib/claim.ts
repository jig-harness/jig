/**
 * `do-item`'s claim of an issue, through the tracker port: refuse an issue
 * someone already holds, mark it started and assigned to this session's
 * own identity (the user the tracker's credential acts as), then read it
 * again and stand down when another claim landed first.
 *
 * A tracker offers no conditional write, so a claim racing another inside
 * the re-read is narrowed, not closed; and two claims made with the same
 * identity cannot be told apart by the issue's state and assignee. The
 * dispatcher checks its running sessions for that case.
 */

import {
  CANONICAL_STATES,
  type CanonicalState,
  type StateContext,
  type PoolIssue,
  type Tracker,
  TrackerRequestError,
  type TrackerUser,
} from "./tracker/port.ts";

export type ClaimTracker = Pick<
  Tracker,
  "viewer" | "assignees" | "assign" | "poolIssue" | "transition" | "stateName"
>;

export type ClaimResult =
  | {
      outcome: "claimed";
      issue: string;
      /** The identity the issue is now assigned to. */
      claimant: TrackerUser;
      /** The tracker's name for the state it is now in. */
      state: string;
    }
  | {
      /**
       * Nothing was written to the item's assignee or state: someone already
       * holds the issue, its state is not one `do_item.claim_from` lets work
       * start from, the repository's `do_item.preflight_command` refused
       * it, or, with `do_item.claim_marker`, another claim's marker is
       * earlier or this claim's own could not be posted and read back.
       */
      outcome: "refused";
      issue: string;
      why:
        | "in_progress"
        | "pr_open"
        | "assigned"
        | "state"
        | "preflight"
        | "blocked"
        | "marker";
      reason: string;
      /** A preflight refusal: the item's `updatedAt` as the command saw it. */
      updatedAt?: string;
    }
  | {
      /** The claim was written and the re-read shows another one landed first. */
      outcome: "stood_down";
      issue: string;
      reason: string;
    };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function names(users: TrackerUser[]): string {
  return users.map((u) => u.name).join(", ");
}

/** The canonical states whose tracker name is `name`; empty when none is. */
export function canonicalStatesOf(
  tracker: Pick<ClaimTracker, "stateName">,
  name: string,
  context: StateContext = null,
): CanonicalState[] {
  return CANONICAL_STATES.filter((s) => {
    const mapped = tracker.stateName(s, context);
    return mapped !== null && sameName(mapped, name);
  });
}

/**
 * The refusal of a claim from `stateName` when `claimFrom`
 * (`do_item.claim_from`) does not list it; `null` when it does, or when the
 * repository sets no list. A status that maps to no canonical state is
 * refused: a side state with its own name is never claimable by accident.
 */
export function claimFromRefusal(
  tracker: Pick<ClaimTracker, "stateName">,
  key: string,
  stateName: string,
  claimFrom: readonly CanonicalState[] | null,
  context: StateContext = null,
): ClaimResult | null {
  if (claimFrom === null) return null;
  const states = canonicalStatesOf(tracker, stateName, context);
  if (states.some((s) => claimFrom.includes(s))) return null;
  const allowed = claimFrom
    .map((s) => `${s} (${tracker.stateName(s, context)})`)
    .join(", ");
  return {
    outcome: "refused",
    issue: key,
    why: "state",
    reason:
      states.length === 0
        ? `${key} is in ${stateName}, which maps to no canonical state; do_item.claim_from lets work start only from ${allowed}`
        : `${key} is in ${stateName} (${states.join(", ")}); do_item.claim_from lets work start only from ${allowed}`,
  };
}

/** The refusal of a claim from the tracker's `blocked` state; `null` otherwise. */
export function blockedStateRefusal(
  tracker: Pick<ClaimTracker, "stateName">,
  key: string,
  stateName: string,
  context: StateContext = null,
): ClaimResult | null {
  const blocked = tracker.stateName("blocked", context);
  if (blocked === null || !sameName(stateName, blocked)) return null;
  return {
    outcome: "refused",
    issue: key,
    why: "blocked",
    reason: `${key} is ${blocked}: its drive stopped on parked work, and only the drive's projection or a person moves it out`,
  };
}

/** What a repository's configuration adds to a claim's own rules. */
export interface ClaimRules {
  /** `do_item.claim_from`: the canonical states work may start from; `null` keeps every open state. */
  claimFrom: readonly CanonicalState[] | null;
}

/** Claim `key` for the identity the tracker's credential acts as. */
export async function claimIssue(
  tracker: ClaimTracker,
  key: string,
  rules: ClaimRules = { claimFrom: null },
): Promise<ClaimResult> {
  const me = await tracker.viewer();
  const before = await tracker.poolIssue(key);
  if (before === null)
    throw new TrackerRequestError("unresolved", `issue ${key} does not exist`);
  const admission = startAdmission(tracker, key, before, rules);
  if ("refusal" in admission) return admission.refusal;
  const started = admission.started;
  const holders = await tracker.assignees(key);
  const others = holders.filter((u) => u.id !== me.id);
  if (others.length > 0)
    return {
      outcome: "refused",
      issue: key,
      why: "assigned",
      reason: `${key} is assigned to ${names(others)}, not to ${me.name}`,
    };

  // The assignment first: a claim racing this one then reads it and refuses.
  if (!holders.some((u) => u.id === me.id)) await tracker.assign(key, me);
  await tracker.transition(key, "in_progress");

  const now = await tracker.assignees(key);
  const after = await tracker.poolIssue(key);
  const landed = now.filter((u) => u.id !== me.id);
  if (landed.length > 0 || !now.some((u) => u.id === me.id))
    return {
      outcome: "stood_down",
      issue: key,
      reason:
        landed.length > 0
          ? `another claim landed first: ${key} is now assigned to ${names(landed)}`
          : `another claim landed first: ${key} is no longer assigned to ${me.name}`,
    };
  if (after === null || !sameName(after.state.name, started))
    return {
      outcome: "stood_down",
      issue: key,
      reason: `another change landed first: ${key} is now ${after?.state.name ?? "gone"}, not ${started}`,
    };
  return { outcome: "claimed", issue: key, claimant: me, state: started };
}

/** Refuse unavailable, held or disallowed start states before an assignment. */
function startAdmission(
  tracker: ClaimTracker,
  key: string,
  before: PoolIssue,
  rules: ClaimRules,
): { started: string } | { refusal: ClaimResult } {
  const context = before.nativeType ?? null;
  const started = tracker.stateName("in_progress", context);
  if (started === null)
    return {
      refusal: {
        outcome: "refused",
        issue: key,
        why: "state",
        reason: `${key} has no in_progress state in its workflow`,
      },
    };
  if (sameName(before.state.name, started))
    return {
      refusal: {
        outcome: "refused",
        issue: key,
        why: "in_progress",
        reason: `${key} is already ${started}: another session holds it`,
      },
    };
  // The state this claim acts on: a block that landed while it waited refuses here.
  const blocked = blockedStateRefusal(tracker, key, before.state.name, context);
  if (blocked !== null) return { refusal: blocked };
  const outside = claimFromRefusal(
    tracker,
    key,
    before.state.name,
    rules.claimFrom,
    context,
  );
  if (outside !== null) return { refusal: outside };
  const prOpen = tracker.stateName("pr_open", context);
  if (prOpen !== null && sameName(before.state.name, prOpen))
    return {
      refusal: {
        outcome: "refused",
        issue: key,
        why: "pr_open",
        reason: `${key} is ${prOpen}: its pull request is open`,
      },
    };
  return { started };
}
