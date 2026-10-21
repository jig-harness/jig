// Reap the processes a test left running.
//
// Jig's suites spawn process trees — a runner, a pass, a descendant that
// outlives its leader — and kill them again in a `finally`. Under load the
// capture that names them can miss (an identity that cannot be read, a
// deadline that passes before the tree is complete), and a test whose own
// timeout fires never reaches its teardown at all. When the test process then
// exits, the init process adopts whatever it left, and the orphan idles for
// good. Measured on one laptop: 82 idle `bun -e setInterval` fixtures, the
// oldest four hours old.
//
// This is the net under those fixtures: at the end of a test process, every
// surviving descendant of that process is killed, with no grace, because at
// `afterAll` nothing a test spawned should still be alive. The process table
// links a process to its parent only while that parent lives, so a
// grandchild whose leader exited has left the tree by teardown. The test
// process therefore also captures its descendants' identities as it runs
// (`captureDescendants`), and the reap kills a captured identity, with its
// own descendants, wherever init has adopted it. A process orphaned between
// two captures — a child that starts a grandchild and exits within one
// capture interval — was never seen and is not reaped; the host sweep covers
// it. The identity rules are process-tree.ts's: a row whose creation
// identity cannot be read is never signalled, so a reused pid is never
// somebody else's process, and a process counts as gone once it is absent,
// a zombie, or a different process under the same pid.
import {
  processTable,
  type ProcessRow,
} from "../plugin/shared/process-table.ts";
import { signalIdentityTargets } from "../plugin/shared/process-tree.ts";
import { partitionProcessTree } from "../plugin/shared/process-uncertainty.ts";

type Identity = Pick<ProcessRow, "pid" | "start">;

export interface ReapDeps {
  table?: () => Promise<ProcessRow[] | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  /** How long the kill and its witness may take together, in ms. */
  timeoutMs?: number;
  pause?: (ms: number) => Promise<void>;
}

export interface ReapReport {
  /** Pids sent SIGKILL, deepest first. */
  signalled: number[];
  /** Descendants left alone because their identity could not be read. */
  unreadable: number[];
  /** Targets still alive, or not witnessed gone, when the deadline passed. */
  survived: number[];
}

/**
 * The identities of `pid`'s readable descendants now, while their parent
 * links still exist; null when the process table could not be read.
 */
export async function captureDescendants(
  pid: number,
  table: () => Promise<ProcessRow[] | null> = () => processTable(),
): Promise<Identity[] | null> {
  const rows = await table();
  if (rows === null) return null;
  return partitionProcessTree(pid, rows)
    .targets.filter((row) => row.pid !== pid)
    .map(({ pid, start }) => ({ pid, start }));
}

/** The row that is still this identity's process, and not yet a zombie. */
function liveRow(
  rows: readonly ProcessRow[],
  target: Identity,
): ProcessRow | undefined {
  return rows.find(
    (row) =>
      row.pid === target.pid &&
      row.start !== "" &&
      row.start === target.start &&
      !row.stat.startsWith("Z"),
  );
}

/**
 * Kill every surviving descendant of `pid`, and every identity in `captured`
 * that is still alive wherever it was adopted, with its own descendants.
 * Reports the pids signalled, the descendants left alone because their
 * identity could not be read, and the targets not witnessed gone; null when
 * the process table itself could not be read, in which case nothing was
 * signalled.
 */
export async function reapSurvivingDescendants(
  pid: number,
  deps: ReapDeps = {},
  captured: readonly Identity[] = [],
): Promise<ReapReport | null> {
  const table = deps.table ?? (() => processTable());
  const pause =
    deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.timeoutMs ?? 10_000);
  const rows = await table();
  if (rows === null) return null;
  const targets: ProcessRow[] = [];
  const unreadable: number[] = [];
  const seen = new Set<number>([pid]);
  const take = (root: number) => {
    const tree = partitionProcessTree(root, rows);
    for (const row of [...tree.targets, ...tree.uncertain]) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      if (tree.targets.includes(row)) targets.push(row);
      else unreadable.push(row.pid);
    }
  };
  take(pid);
  for (const identity of captured) {
    const row = liveRow(rows, identity);
    if (row && !seen.has(row.pid)) take(row.pid);
  }
  const signalled: number[] = [];
  await signalIdentityTargets(targets, "SIGKILL", {
    table,
    deadline,
    ...(deps.kill ? { kill: deps.kill } : {}),
    onKilled: (target) => {
      signalled.push(target.pid);
    },
  });
  let survived = targets.map((row) => row.pid);
  while (survived.length > 0) {
    const now = await table();
    if (now !== null)
      survived = targets
        .filter(
          (target) =>
            now.some((row) => row.pid === target.pid && row.start === "") ||
            liveRow(now, target) !== undefined,
        )
        .map((row) => row.pid);
    if (survived.length === 0 || Date.now() >= deadline) break;
    await pause(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  return { signalled, unreadable, survived };
}
