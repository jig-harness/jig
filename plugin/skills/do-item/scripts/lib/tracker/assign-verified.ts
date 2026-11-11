/**
 * Assigning an unassigned issue on a tracker whose issues hold one assignee
 * and which offers no conditional write (Linear, Jira): the adapter cannot
 * ask the tracker to assign only if nobody is assigned, so it reads, writes
 * and then verifies the write against the issue's history.
 *
 * The history is read before the write, and only a change that appeared after
 * that read can verify it: an older assignment of the same account proves
 * nothing about this write. The newest such change that set the assignee to
 * the user must have set it from nobody, and the changes that appeared must
 * form one unbroken sequence ending at the user: a broken sequence means the
 * listing shows events from outside this write, and it fails closed. A change from someone else means another writer assigned the issue
 * between the read and the write, and this write replaced them: the adapter
 * puts them back, if the issue still shows this write, and the claim stands
 * down. A history that holds no such change cannot verify the write, and
 * stands the claim down too. A writer that changes the assignee after this
 * write leaves the issue assigned to someone else, and the claim stands down
 * without restoring anyone: that writer's assignment stands. The trackers
 * supply no event ids, so this is best effort: a lone delayed older change to
 * the user that is consistent with the sequence cannot be told from the write's.
 */

/** One change of an issue's assignee: account ids, `null` for nobody. */
export interface AssigneeChange {
  from: string | null;
  to: string | null;
  /** When the tracker recorded it, as an ISO 8601 time. */
  at: string;
}

/** What an adapter supplies: the current assignee, the write and the history. */
export interface VerifiedAssignOps {
  assignee(): Promise<string | null>;
  assign(id: string): Promise<void>;
  history(): Promise<AssigneeChange[]>;
}

/** The assignee this write replaced, when the history shows it replaced one. */
export type AssignmentCheck =
  { ok: true } | { ok: false; replaced: string | null };

/** The changes in the order the tracker recorded them. */
function ordered(changes: readonly AssigneeChange[]): AssigneeChange[] {
  return changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Date.parse(a.c.at) - Date.parse(b.c.at) || a.i - b.i)
    .map(({ c }) => c);
}

/** A change's identity for matching one listing against another. */
function identity(c: AssigneeChange): string {
  return JSON.stringify([c.from, c.to, Date.parse(c.at)]);
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
  if (!chainEndsAt(fresh, user)) return { ok: false, replaced: null };
  const latest = fresh.at(-1);
  if (latest === undefined) return { ok: false, replaced: null };
  return latest.from === null
    ? { ok: true }
    : { ok: false, replaced: latest.from };
}

/** Assign `user` to an unassigned issue, verified; false means refresh the queue. */
export async function assignVerified(
  ops: VerifiedAssignOps,
  user: string,
): Promise<boolean> {
  if ((await ops.assignee()) !== null) return false;
  const known = await ops.history();
  await ops.assign(user);
  const check = checkAssignment(
    await ops.assignee(),
    await ops.history(),
    user,
    known,
  );
  if (check.ok) return true;
  if (check.replaced !== null && (await ops.assignee()) === user)
    await ops.assign(check.replaced);
  return false;
}
