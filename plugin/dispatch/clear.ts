/**
 * `jig dispatch clear <record>`: a person removes a launch record the tick
 * cannot settle on its own: an unknown one (claimed on another host or
 * before a reboot, or ended on its account's wall that could not be
 * recorded), a pending one whose launch cannot be retried, or one that
 * does not read (which keeps every `--apply` from launching). Each holds
 * its stage and its account's slot until it is cleared. A record whose
 * wrapper is alive is refused: stop the session first.
 *
 * It takes the tick lock, so no tick holding the record in memory writes
 * it back after it is removed.
 *
 * Exit codes: 0 cleared; 2 usage, no such record, or a record whose
 * wrapper is alive; 3 a tick holds the lock.
 */
import {
  isRecordId,
  readLaunches,
  readRecord,
  removeRecord,
} from "./lib/launches.ts";
import { existingStateDb } from "./lib/state.ts";
import { stateRoot, takeTickLock } from "./receipts.ts";

/** A tick holds the lock: try again once it is done. */
const LOCK_HELD = 3;

/** A record's state by name, its process when it is alive, or `null` when there is no such row. */
async function stateOf(
  id: string,
  root: string,
): Promise<string | { pid: number } | null> {
  const db = existingStateDb(root);
  if (db === null) return null;
  if (db.query("SELECT 1 FROM launches WHERE id = ?").get(id) === null)
    return null;
  if (readRecord(id, root) === null) return "unreadable";
  const found = (await readLaunches(root)).records.find(
    (r) => r.record.id === id,
  );
  if (found === undefined) return "unreadable";
  return found.state.kind === "alive"
    ? { pid: found.state.process.pid }
    : found.state.kind;
}

export async function clearMain(
  id: string,
  root = stateRoot(),
): Promise<number> {
  if (!isRecordId(id)) {
    console.error(`jig dispatch clear: ${id} is not a launch record id`);
    return 2;
  }
  const lock = takeTickLock(root);
  if ("heldBy" in lock) {
    console.error(
      `jig dispatch clear: a tick holds the lock (${lock.heldBy}); try again once it is done`,
    );
    return LOCK_HELD;
  }
  try {
    const state = await stateOf(id, root);
    if (state === null) {
      console.error(`jig dispatch clear: no launch record ${id}`);
      return 2;
    }
    if (typeof state !== "string") {
      console.error(
        `jig dispatch clear: ${id} is running (process ${state.pid}); stop its session first`,
      );
      return 2;
    }
    removeRecord(id, root);
    console.log(JSON.stringify({ record: id, cleared: true, state }));
    return 0;
  } finally {
    lock.release();
  }
}
