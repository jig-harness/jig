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
  let capturing = false;
  let sampling = pid !== undefined;
  const capture = async () => {
    if (pid === undefined || capturing || !sampling) return;
    capturing = true;
    try {
      for (const row of (await captureProcessTree(pid)) ?? []) {
        if (row.pid === pid) tree.root = { pid, start: row.start };
        const known = tree.targets.some(
          (t) => t.pid === row.pid && t.start === row.start,
        );
        if (!known) tree.targets.push(row);
      }
    } catch (error) {
      swallow(error, "the pass's tree is unreadable");
    } finally {
      capturing = false;
    }
  };
  const timer = sampling ? setInterval(() => void capture(), CAPTURE_MS) : null;
  void capture();
  return {
    stopSampling() {
      sampling = false;
      if (timer !== null) clearInterval(timer);
    },
    async end() {
      if (pid === undefined) return true;
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
