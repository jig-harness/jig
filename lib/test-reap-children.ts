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
// surviving descendant of that process is killed. It is a SIGKILL of the
// whole tree with no grace, because at `afterAll` nothing a test spawned
// should still be alive, and a process a test meant to keep has been
// reparented away (a launched runner, drive-pr's foreground-wait) and is no
// longer a descendant. The identity rules are process-tree.ts's: a row whose
// creation identity cannot be read is never signalled, so a reused pid is
// never somebody else's process.
import {
  processTable,
  type ProcessRow,
} from "../plugin/shared/process-table.ts";
import { signalIdentityTargets } from "../plugin/shared/process-tree.ts";
import { partitionProcessTree } from "../plugin/shared/process-uncertainty.ts";

/**
 * Kill every surviving descendant of `pid`. Reports the pids signalled,
 * deepest first, and the descendants left alone because their identity could
 * not be read; null when the process table itself could not be read, in
 * which case nothing was signalled.
 */
export async function reapSurvivingDescendants(
  pid: number,
  deps: {
    table?: () => Promise<ProcessRow[] | null>;
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  } = {},
): Promise<{ signalled: number[]; unreadable: number[] } | null> {
  const table = deps.table ?? (() => processTable());
  const rows = await table();
  if (rows === null) return null;
  const { targets, uncertain } = partitionProcessTree(pid, rows);
  const descendants = targets.filter((row) => row.pid !== pid);
  const signalled: number[] = [];
  await signalIdentityTargets(descendants, "SIGKILL", {
    table,
    ...(deps.kill ? { kill: deps.kill } : {}),
    onKilled: (target) => {
      signalled.push(target.pid);
    },
  });
  return {
    signalled,
    unreadable: uncertain
      .filter((row) => row.pid !== pid)
      .map((row) => row.pid),
  };
}
