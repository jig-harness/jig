/** Attribute validation waits to this host's launches without changing deadlines. */
import {
  lockPlace,
  readLockWaits,
  resourceLockPath,
  type LockWait,
} from "../../shared/resource-lock-waits.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import { type LaunchRecord, type ReadRecord, writeRecord } from "./launches.ts";
import { sep } from "node:path";
import { ended, type TickBound } from "./sources/bounded.ts";

export { testLockNote } from "./test-lock-note.ts";

export interface TestLockWait extends LockWait {
  observedAt: string;
  waiting: boolean;
}

/** One host read; Windows keeps aggregate readings until its identity check can verify creation time. */
function testLockWaits(bound?: TickBound): LockWait[] {
  const { root, name } = lockPlace(process.env);
  if (ended(bound)) return [];
  // The bound's deadline is epoch milliseconds; the liveness probes keep to the monotonic clock.
  const deadline =
    bound === undefined
      ? undefined
      : performance.now() + (bound.deadline - currentMs());
  return readLockWaits(root, resourceLockPath(root, name), deadline);
}

/** Whether a wait ran in the launch's workspace or a directory inside it. */
function inWorkspace(wait: LockWait, record: LaunchRecord): boolean {
  const root = record.workspace?.path;
  if (root === undefined || root === "") return false;
  return (
    wait.workspace === root ||
    wait.workspace.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/** Keep the last observation after admission or exit, explicitly marked as historical. */
export function observeTestLockWaits(
  records: ReadRecord[],
  repo: string,
  waits?: LockWait[],
  now = currentMs(),
  save: (record: LaunchRecord) => void = writeRecord,
  bound?: TickBound,
): void {
  const seen = waits ?? testLockWaits(bound);
  // A scan the bound cut short proves no absence: a wait it did not read keeps its last observation.
  const complete = waits !== undefined || !ended(bound);
  const owners = (wait: LockWait) =>
    records.filter(
      ({ record, state }) =>
        state.kind === "alive" &&
        inWorkspace(wait, record) &&
        parseMs(record.createdAt) <= parseMs(wait.since),
    );
  for (const { record, state } of records) {
    if (record.repo !== repo) continue;
    const found =
      state.kind === "alive"
        ? seen
            .filter(
              (w) =>
                inWorkspace(w, record) &&
                parseMs(w.since) >= parseMs(record.createdAt) &&
                parseMs(w.since) <= now &&
                owners(w).length === 1,
            )
            .sort((a, b) => parseMs(a.since) - parseMs(b.since))[0]
        : undefined;
    if (found !== undefined) {
      record.testLockWait = {
        ...found,
        observedAt: isoFromMs(now),
        waiting: true,
      };
      save(record);
    } else if (complete && record.testLockWait?.waiting) {
      record.testLockWait.waiting = false;
      save(record);
    }
  }
}
