/**
 * Linear and Jira assign without a conditional write. Only a new history
 * sequence from nobody to the claimant verifies that write. Poll for delayed
 * evidence up to the visibility deadline; restore a replaced owner on a
 * visible race, or clear our lone assignment on an unverifiable timeout.
 * Tracker event ids are unavailable, so an indistinguishable delayed older
 * assignment remains a best-effort limit.
 */

/** One change of an issue's assignee: account ids, `null` for nobody. */
import { parseMs } from "../../../../../shared/time.ts";
import { type Clock, systemClock } from "../../../../../shared/clock.ts";
import type { AssignmentResult } from "./port.ts";

export interface AssigneeChange {
  from: string | null;
  to: string | null;
  /** When the tracker recorded it, as an ISO 8601 time. */
  at: string;
}

/** What an adapter supplies: the current assignee, the write and the history. */
export interface VerifiedAssignOps {
  assignee(): Promise<string | null>;
  assign(id: string | null): Promise<void>;
  history(): Promise<AssigneeChange[]>;
}

/** The assignee this write replaced, when the history shows it replaced one. */
export type AssignmentCheck =
  | { ok: true }
  | { ok: false; replaced: string | null };

/** The changes in the order the tracker recorded them. */
function ordered(changes: readonly AssigneeChange[]): AssigneeChange[] {
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => parseMs(a.c.at) - parseMs(b.c.at) || a.i - b.i)
    .map(({ c }) => c);
}

/** A change's identity for matching one listing against another. */
function identity(c: AssigneeChange): string {
  return JSON.stringify([c.from, c.to, parseMs(c.at)]);
}

/**
 * The changes a listing holds beyond the ones `known` held: each known change
 * cancels one equal change (the tracker supplies no event ids), so a tie in
 * time or a different listing order cannot move the boundary.
 */
function unseen(
  changes: readonly AssigneeChange[],
  known: readonly AssigneeChange[],
): AssigneeChange[] {
  const owed = new Map<string, number>();
  for (const c of known)
    owed.set(identity(c), (owed.get(identity(c)) ?? 0) + 1);
  return ordered(changes).filter((c) => {
    const left = owed.get(identity(c)) ?? 0;
    if (left === 0) return true;
    owed.set(identity(c), left - 1);
    return false;
  });
}

/** Retain each event's greatest observed multiplicity when listings lag. */
function retain(
  observed: readonly AssigneeChange[],
  listing: readonly AssigneeChange[],
): AssigneeChange[] {
  return ordered([...observed, ...unseen(listing, observed)]);
}

/**
 * Whether the changes form one unbroken sequence of assignees (each change
 * starts from where the one before ended) that ends at `user`. A listing that
 * also shows a delayed older event, or one that skips a change the tracker
 * has not yet made visible, breaks the sequence, and then nothing in it is
 * evidence of this write.
 */
function chainEndsAt(
  changes: readonly AssigneeChange[],
  user: string,
): boolean {
  let end: string | null | undefined;
  for (const c of changes) {
    if (end !== undefined && c.from !== end) return false;
    end = c.to;
  }
  return end === user;
}

/**
 * Read the history after assigning `user`: did the write replace nobody?
 * `known` is the history before the write; only the changes it did not hold
 * count as this write's evidence.
 */
export function checkAssignment(
  current: string | null,
  changes: readonly AssigneeChange[],
  user: string,
  known: readonly AssigneeChange[] = [],
): AssignmentCheck {
  if (current !== user) return { ok: false, replaced: null };
  const fresh = unseen(changes, known);
  const latest = fresh.findLast((c) => c.to === user);
  if (latest === undefined) return { ok: false, replaced: null };
  if (latest.from !== null)
    return {
      ok: false,
      replaced: fresh.at(-1)?.to === user ? latest.from : null,
    };
  return chainEndsAt(fresh, user)
    ? { ok: true }
    : { ok: false, replaced: null };
}

/** Whether a fresh history event involves an account other than the claimant. */
function hasConflict(
  changes: readonly AssigneeChange[],
  user: string,
): boolean {
  return changes.some(
    (c) =>
      (c.from !== null && c.from !== user) || (c.to !== null && c.to !== user),
  );
}

/** A complete check permits restoration or success, otherwise keep polling. */
async function resolveCheck(
  ops: VerifiedAssignOps,
  user: string,
  check: AssignmentCheck,
): Promise<AssignmentResult | null> {
  if (!check.ok && check.replaced !== null) {
    if ((await ops.assignee()) === user) await ops.assign(check.replaced);
    return { assigned: false, reason: "race" };
  }
  return check.ok ? { assigned: true } : null;
}

/** Unknown ownership after a race requires reconciliation, never a guess. */
async function finishUnverified(
  ops: VerifiedAssignOps,
  user: string,
  raced: boolean,
): Promise<AssignmentResult> {
  if (raced) return { assigned: false, reason: "race-unverified" };
  // Re-read immediately before clearing: never remove a different owner.
  if ((await ops.assignee()) === user) await ops.assign(null);
  return { assigned: false, reason: "unverified" };
}

/** Assign once, polling for visibility and the evidence needed for restoration. */
export async function assignVerified(
  ops: VerifiedAssignOps,
  user: string,
  options: { clock?: Clock; timeoutMs?: number; pollMs?: number } = {},
): Promise<AssignmentResult> {
  if ((await ops.assignee()) !== null)
    return { assigned: false, reason: "race" };
  const known = await ops.history();
  await ops.assign(user);
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + (options.timeoutMs ?? 3_000);
  let observed: AssigneeChange[] = [];
  let raced = false;
  for (;;) {
    const current = await ops.assignee();
    observed = retain(observed, await ops.history());
    const fresh = unseen(observed, known);
    const check = checkAssignment(current, observed, user, known);
    // A visible different owner is evidence of a race; an empty read may
    // still be the unassigned state from before our write.
    if (current !== null && current !== user)
      return { assigned: false, reason: "race" };
    raced ||= hasConflict(fresh, user);
    const resolved = await resolveCheck(ops, user, check);
    if (resolved) return resolved;
    const left = deadline - clock.now();
    if (left <= 0) {
      return finishUnverified(ops, user, raced);
    }
    await clock.sleep(Math.min(options.pollMs ?? 250, left));
  }
}
