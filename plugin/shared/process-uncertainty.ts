/** Unknown ancestry cannot bind a descendant identity to an owned process. */
export interface IdentityRow {
  pid: number;
  ppid: number;
  start: string;
}
export function partitionProcessTree<T extends IdentityRow>(
  pid: number,
  rows: readonly T[],
): { targets: T[]; uncertain: T[] } {
  const targets: T[] = [];
  const uncertain: T[] = [];
  const queue = [{ pid, bound: true }];
  const seen = new Set<number>();
  for (const next of queue) {
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    const row = rows.find((candidate) => candidate.pid === next.pid);
    if (!row) continue;
    const bound = next.bound && row.start !== "";
    (bound ? targets : uncertain).push(row);
    for (const child of rows)
      if (child.ppid === row.pid) queue.push({ pid: child.pid, bound });
  }
  return { targets, uncertain };
}

/** Unbound PIDs remain uncertain after reparenting, until absent or freshly bound. */
export function trackUnknownDescendants(
  captured: readonly { pid: number; start: string }[],
  rows: readonly { pid: number }[],
  unknown: Set<number>,
): void {
  for (const pid of unknown)
    if (!rows.some((row) => row.pid === pid)) unknown.delete(pid);
  for (const row of captured) {
    if (row.start === "") unknown.add(row.pid);
    else unknown.delete(row.pid);
  }
}
export function trackPartitionUncertainty(
  partition: { targets: IdentityRow[]; uncertain: IdentityRow[] },
  rows: IdentityRow[],
  unknown: Set<number>,
): void {
  trackUnknownDescendants(
    [
      ...partition.targets,
      ...partition.uncertain.map((row) => ({ pid: row.pid, start: "" })),
    ],
    rows,
    unknown,
  );
}
/** Retain a previously bound identity when its current creation time is unreadable. */
export function liveOrUnknownTargets<T extends { pid: number; start: string }>(
  targets: T[],
  rows: readonly { pid: number; start: string; stat: string }[],
): T[] {
  return targets.filter((target) =>
    rows.some(
      (row) =>
        row.pid === target.pid &&
        !row.stat.startsWith("Z") &&
        (row.start === "" || row.start === target.start),
    ),
  );
}
