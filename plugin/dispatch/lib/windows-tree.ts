/**
 * A Windows pass's process tree, recorded while it runs and ended by identity.
 *
 * Windows has no process group to signal. Descendants are recorded while their
 * parent links exist, and the record is kept after the pass exits, so what the
 * pass started can still be found and ended.
 */
import { swallow } from "../../shared/errors.ts";
import {
  captureProcessTree,
  stopWindowsTree,
  type WindowsTreeState,
} from "../../shared/process-tree.ts";

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

export function watchWindowsTree(pid: number | undefined): TreeWatch {
  const tree: WindowsTreeState = { root: null, targets: [] };
  let capturing: Promise<void> | null = null;
  let sampling = pid !== undefined;
  const record = async () => {
    if (pid === undefined) return;
    try {
      const rows = await captureProcessTree(pid);
      if (rows === null) {
        // While the pass runs and its root is bound, an unreadable tree is a gap, not an empty one;
        // after it exits the root is expected to be gone.
        if (tree.root !== null && sampling) tree.complete = false;
        return;
      }
      const root = rows.find((row) => row.pid === pid);
      // The root is bound by its first capture; a later snapshot of another creation is a reused pid.
      if (tree.root === null && root !== undefined)
        tree.root = { pid, start: root.start };
      if (tree.root !== null && root?.start !== tree.root.start) return;
      for (const row of rows) {
        const known = tree.targets.some(
          (t) => t.pid === row.pid && t.start === row.start,
        );
        if (!known) tree.targets.push(row);
      }
    } catch (error) {
      swallow(error, "the pass's tree is unreadable");
      if (tree.root !== null) tree.complete = false;
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
