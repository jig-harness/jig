/**
 * Assigning an unassigned issue on a tracker whose issues hold one assignee
 * and which offers no conditional write (Linear, Jira): the adapter cannot
 * ask the tracker to assign only if nobody is assigned, so it reads, writes
 * and then verifies the write against the issue's history.
 *
 * The newest change that set the assignee to the user must have set it from
 * nobody. A change from someone else means another writer assigned the issue
 * between the read and the write, and this write replaced them: the adapter
 * puts them back, if the issue still shows this write, and the claim stands
 * down. A history that holds no such change cannot verify the write, and
 * stands the claim down too. A writer that changes the assignee after this
 * write leaves the issue assigned to someone else, and the claim stands down
 * without restoring anyone: that writer's assignment stands.
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
  | { ok: true }
  | { ok: false; replaced: string | null };

/** Read the history after assigning `user`: did the write replace nobody? */
export function checkAssignment(
  current: string | null,
  changes: readonly AssigneeChange[],
  user: string,
): AssignmentCheck {
  if (current !== user) return { ok: false, replaced: null };
  const latest = changes
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.to === user)
    .sort(
      (a, b) => Date.parse(a.c.at) - Date.parse(b.c.at) || a.i - b.i,
    )
    .at(-1)?.c;
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
  await ops.assign(user);
  const check = checkAssignment(
    await ops.assignee(),
    await ops.history(),
    user,
  );
  if (check.ok) return true;
  if (check.replaced !== null && (await ops.assignee()) === user)
    await ops.assign(check.replaced);
  return false;
}
