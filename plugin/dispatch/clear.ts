/**
 * `jig dispatch clear <record>`: a person removes a launch record the tick
 * cannot settle on its own: an unknown one (claimed on another host or
 * before a reboot, or ended on its account's wall that could not be
 * recorded), a pending one whose launch cannot be retried (a stuck one,
 * `lib/stuck-launches.ts`), or one that
 * does not read (which keeps every `--apply` from launching). Each holds
 * its stage and its account's slot until it is cleared. A record whose
 * wrapper is alive is refused: stop the session first.
 *
 * It takes the tick lock, so no tick holding the record in memory writes
 * it back after it is removed.
 *
 * Only those records clear: an ended or died one, and a pending one whose
 * launch can still be retried, are the tick's to settle.
 *
 * Exit codes: 0 cleared; 2 usage, no such record, a record that may not be
 * cleared or that changed while it was read; 3 a tick holds the lock.
 */
import {
  inspectRow,
  isRecordId,
  type InspectedRow,
  removeRecordIf,
} from "./lib/launches.ts";
import { existingStateDb } from "./lib/state.ts";
import { retryable } from "./lib/stuck-launches.ts";
import { stateRoot, takeTickLock } from "./receipts.ts";

/** A tick holds the lock: try again once it is done. */
const LOCK_HELD = 3;

/** Why a row may not be cleared; `null` when a person may clear it. */
function refusal(id: string, row: InspectedRow): string | null {
  const { state, record } = row;
  if (state.kind === "alive")
    return `${id} is running (process ${state.process.pid}); stop its session first`;
  // The claim speaks whether or not the record reads.
  if (record === null) return null;
  if (state.kind === "unknown") return null;
  if (state.kind === "pending") {
    if (!retryable(record)) return null;
    return `${id} is pending and its launch can still be retried`;
  }
  return `${id} is ${state.kind}: the tick settles it and its outcome row, and it keeps its protections until it is pruned`;
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
    const row =
      existingStateDb(root) === null ? null : await inspectRow(id, root);
    if (row === null) {
      console.error(`jig dispatch clear: no launch record ${id}`);
      return 2;
    }
    const refused = refusal(id, row);
    if (refused !== null) {
      console.error(`jig dispatch clear: ${refused}`);
      return 2;
    }
    if (!removeRecordIf(id, row, root)) {
      console.error(
        `jig dispatch clear: ${id} changed while it was read (a wrapper claimed it or it ended); try again`,
      );
      return 2;
    }
    const state = row.record === null ? "unreadable" : row.state.kind;
    console.log(JSON.stringify({ record: id, cleared: true, state }));
    return 0;
  } finally {
    lock.release();
  }
}
