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
// a zombie, or a different process under the same pid. Every process the
// reap has seen is accounted for — signalled, left alone as unreadable, or
// reported as surviving — and one deadline bounds every process-table read
// it makes.
import {
  processTable,
  type ProcessRow,
} from "../plugin/shared/process-table.ts";
import { signalIdentityTargets } from "../plugin/shared/process-tree.ts";
import { partitionProcessTree } from "../plugin/shared/process-uncertainty.ts";

type Identity = Pick<ProcessRow, "pid" | "start">;
type Table = (timeoutSec?: number) => Promise<ProcessRow[] | null>;

export interface ReapDeps {
  table?: Table;
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
  table: Table = processTable,
): Promise<Identity[] | null> {
  const rows = await table();
  if (rows === null) return null;
  return descendantsIn(pid, rows);
}

function descendantsIn(pid: number, rows: readonly ProcessRow[]): Identity[] {
  return partitionProcessTree(pid, rows)
    .targets.filter((row) => row.pid !== pid)
    .map(({ pid, start }) => ({ pid, start }));
}

/**
 * Add `pid`'s readable descendants to `captured`, keyed by identity, and drop
 * the captured identities one process table shows gone: absent, a zombie, or
 * a different readable process under the same pid. An identity whose row
 * cannot be read stays, since it may still be the captured process. False
 * when the process table could not be read, which changes nothing.
 */
export async function recordDescendants(
  pid: number,
  captured: Map<string, Identity>,
  table: Table = processTable,
): Promise<boolean> {
  const rows = await table();
  if (rows === null) return false;
  for (const [key, identity] of captured)
    if (!liveOrUnreadable(rows, identity)) captured.delete(key);
  for (const identity of descendantsIn(pid, rows))
    captured.set(`${identity.pid}:${identity.start}`, identity);
  return true;
}

/** The row that may still be this identity's process: its own, or unreadable. */
function liveOrUnreadable(
  rows: readonly ProcessRow[],
  target: Identity,
): ProcessRow | undefined {
  return rows.find(
    (row) =>
      row.pid === target.pid &&
      !row.stat.startsWith("Z") &&
      (row.start === "" || row.start === target.start),
  );
}

/**
 * Kill every surviving descendant of `pid`, and every identity in `captured`
 * that is still alive wherever it was adopted, with its own descendants.
 * Reports the pids signalled, the processes left alone because their
 * identity could not be read (a captured identity whose row has become
 * unreadable included), and the targets not witnessed gone; null when the
 * process table itself could not be read, in which case nothing was
 * signalled.
 */
export function reapSurvivingDescendants(
  pid: number,
  deps: ReapDeps = {},
  captured: readonly Identity[] = [],
): Promise<ReapReport | null> {
  return reap(pid, deps, captured);
}

/**
 * Kill every identity in `captured` that is still alive, with its own
 * descendants, and witness them gone: the reap of `reapSurvivingDescendants`
 * for processes a test named itself rather than found under its own pid.
 */
export function reapIdentities(
  captured: readonly Identity[],
  deps: ReapDeps = {},
): Promise<ReapReport | null> {
  return reap(null, deps, captured);
}

/**
 * The identity of the process `pid` names now, when the process table shows
 * it alive with a readable creation identity; null otherwise, and when the
 * table could not be read.
 */
export async function identityOf(
  pid: number,
  table: Table = processTable,
): Promise<Identity | null> {
  const rows = await table();
  const row = rows?.find(
    (row) => row.pid === pid && !row.stat.startsWith("Z") && row.start !== "",
  );
  return row ? { pid: row.pid, start: row.start } : null;
}

async function reap(
  pid: number | null,
  deps: ReapDeps,
  captured: readonly Identity[],
): Promise<ReapReport | null> {
  const deadline = Date.now() + (deps.timeoutMs ?? 10_000);
  const remaining = () => Math.max(0, deadline - Date.now());
  const read = deps.table ?? processTable;
  // Each read gets what is left of the deadline, and none starts after it.
  const table: Table = async () => {
    const left = remaining();
    return left === 0 ? null : read(Math.min(5, left / 1000));
  };
  const rows = await table();
  if (rows === null) return null;
  const { targets, unreadable } = collectTargets(pid, rows, captured);
  const signalled: number[] = [];
  await signalIdentityTargets(targets, "SIGKILL", {
    table: read,
    deadline,
    ...(deps.kill ? { kill: deps.kill } : {}),
    onKilled: (target) => {
      signalled.push(target.pid);
    },
  });
  const pause =
    deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const survived = await witnessGone(targets, table, remaining, pause);
  return { signalled, unreadable, survived };
}

/**
 * `pid`'s descendants, when there is a `pid`, and every captured identity's
 * live process with its descendants, split into the readable targets and the
 * unreadable pids.
 */
function collectTargets(
  pid: number | null,
  rows: readonly ProcessRow[],
  captured: readonly Identity[],
): { targets: ProcessRow[]; unreadable: number[] } {
  const targets: ProcessRow[] = [];
  const unreadable: number[] = [];
  const seen = new Set<number>(pid === null ? [] : [pid]);
  const take = (root: number) => {
    const tree = partitionProcessTree(root, rows);
    for (const row of [...tree.targets, ...tree.uncertain]) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      if (tree.targets.includes(row)) targets.push(row);
      else unreadable.push(row.pid);
    }
  };
  if (pid !== null) take(pid);
  // A captured identity whose row is now unreadable is taken too: its
  // partition reports it, and what it started, as unreadable.
  for (const identity of captured) {
    const row = liveOrUnreadable(rows, identity);
    if (row && !seen.has(row.pid)) take(row.pid);
  }
  return { targets, unreadable };
}

/** The targets not witnessed gone by the time `remaining` runs out. */
async function witnessGone(
  targets: readonly ProcessRow[],
  table: Table,
  remaining: () => number,
  pause: (ms: number) => Promise<void>,
): Promise<number[]> {
  let survived = targets.map((row) => row.pid);
  while (survived.length > 0 && remaining() > 0) {
    const now = await table();
    if (now !== null)
      survived = targets
        .filter((target) => liveOrUnreadable(now, target) !== undefined)
        .map((row) => row.pid);
    if (survived.length === 0 || remaining() === 0) break;
    await pause(Math.min(100, remaining()));
  }
  return survived;
}
