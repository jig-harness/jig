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
    } else if (record.testLockWait?.waiting) {
      record.testLockWait.waiting = false;
      save(record);
    }
  }
}

/** A current wait, or the last observed wait, never evidence that a deadline was paused. */
export function testLockNote(
  record: LaunchRecord,
  now = currentMs(),
  historical = false,
): string | null {
  const wait = record.testLockWait;
  if (wait === undefined) return null;
  const current = wait.waiting && !historical;
  const duration = Math.max(
    0,
    (current ? now : parseMs(wait.observedAt)) - parseMs(wait.since),
  );
  return `${current ? "is waiting" : "was last seen waiting"} for the test lock for ${Math.floor(duration / 60000)}m (pid ${wait.pid}, since ${wait.since}, observed ${wait.observedAt})`;
}
