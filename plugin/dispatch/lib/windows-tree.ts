/**
 * A Windows pass's process tree, recorded while it runs and ended by identity.
 *
 * Windows has no process group to signal. Descendants are recorded while their
 * parent links exist, and the record is kept after the pass exits, so what the
 * pass started can still be found and ended.
 */
import { swallow } from "../../shared/errors.ts";
import { processTable } from "../../shared/process-table.ts";
import type { WindowsTreeState } from "../../shared/process-tree.ts";
import { stopWindowsTree } from "../../shared/process-tree.ts";
import {
  partitionProcessTree,
  trackPartitionUncertainty,
} from "../../shared/process-uncertainty.ts";

/** How often the pass's descendants are recorded while it runs. */
const CAPTURE_MS = 1000;

export interface TreeWatch {
  /** Stop recording; what was recorded is kept. */
  stopSampling(): void;
  /** End what was recorded; whether the tree is shown to have ended. */
  end(): Promise<boolean>;
}

/** A watch that records nothing: the pass is not on Windows or runs under no deadline. */
export const NO_WATCH: TreeWatch = {
  stopSampling() {
    return undefined;
  },
  async end() {
    return true;
  },
};

/**
 * `owned` says the pass's child handle is still unreaped: while it is, the pid
 * cannot belong to anything else, and a root missing from a snapshot is a gap.
 */
export function watchWindowsTree(
  pid: number | undefined,
  owned: () => boolean,
): TreeWatch {
  const tree: WindowsTreeState = { root: null, targets: [] };
  let capturing: Promise<void> | null = null;
  let sampling = pid !== undefined;
  const record = async () => {
    if (pid === undefined) return;
    // A capture begun while the pass was owned keeps its uncertainty even if the pass exits mid-snapshot.
    const ownedAtStart = owned();
    try {
      const rows = await processTable();
      if (rows === null) {
        if (ownedAtStart) tree.complete = false;
        return;
      }
      const root = rows.find((row) => row.pid === pid);
      if (root?.start === undefined || root.start === "") {
        // Still owned after the snapshot yet not visible: unreadable, not gone.
        if (ownedAtStart && owned()) tree.complete = false;
        return;
      }
      if (tree.root === null) {
        // Binding needs the unreaped child handle after the snapshot returns: only then is the pid not a reused one.
        if (!owned()) return;
        tree.root = { pid, start: root.start };
      }
      if (root.start !== tree.root.start) return;
      const captured = partitionProcessTree(root.pid, rows);
      tree.unknownDescendants ??= new Set();
      trackPartitionUncertainty(captured, rows, tree.unknownDescendants);
      if (captured.uncertain.length > 0) tree.complete = false;
      for (const row of captured.targets) {
        const known = tree.targets.some(
          (t) => t.pid === row.pid && t.start === row.start,
        );
        if (!known) tree.targets.push(row);
      }
    } catch (error) {
      swallow(error, "the pass's tree is unreadable");
      if (ownedAtStart) tree.complete = false;
    }
  };
  const capture = () => {
    if (pid === undefined || capturing !== null || !sampling) return;
    capturing = record().finally(() => {
      capturing = null;
    });
  };
  const timer = sampling ? setInterval(capture, CAPTURE_MS) : null;
  capture();
  return {
    stopSampling() {
      sampling = false;
      if (timer !== null) clearInterval(timer);
    },
    async end() {
      if (pid === undefined) return true;
      // A snapshot still in flight can hold the last descendants; wait for it.
      await capturing;
      try {
        return await stopWindowsTree(pid, 0, undefined, () => false, {
          state: tree,
        });
      } catch (error) {
        swallow(error, "the pass's tree is gone or unreadable");
        return false;
      }
    },
  };
}
