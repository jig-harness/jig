/** Recoveries reserve the PR slot, including retries after a recovery process itself died. */
import { createHash } from "node:crypto";
import { isAlive } from "../../../../shared/liveness.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { parseDiagText } from "./claim.ts";
import {
  acquireObservedLock,
  prLockName,
  release,
  type DriveLock,
} from "./driver/locks.ts";
import { driveDb, inTransaction } from "./state/db.ts";
import { readLockRow } from "./state/lock.ts";

interface Acquisition {
  started: string;
  pid: number;
  host: string;
  worktree: string;
}

/** Each reservation is bound to the exact recorded acquisition, independent of its helper's pid. */
export async function reserveDeadDriver(
  stateDir: string,
  pr: string,
  record: Acquisition,
  recover: () => Promise<void>,
  witness = false,
): Promise<boolean> {
  const drive = driveDb(stateDir);
  const name = prLockName(pr);
  const seen = readLockRow(drive, name);
  const label = `drive-recovery:${createHash("sha256")
    .update(
      JSON.stringify([
        pr,
        record.started,
        record.pid,
        record.host,
        record.worktree,
      ]),
    )
    .digest("hex")}`;
  const diag = seen?.detail ? parseDiagText(seen.detail) : null;
  if (
    seen !== null &&
    !(
      seen.pid === record.pid &&
      seen.host === record.host &&
      diag?.started === record.started &&
      diag.worktree === record.worktree
    )
  ) {
    if (
      seen.label !== label ||
      diag?.started !== record.started ||
      diag.worktree !== record.worktree
    )
      return false;
    const holder = await isAlive({
      pid: seen.pid,
      start: seen.start,
      host: seen.host,
      hostId: seen.host_id,
      bootId: seen.boot_id,
    });
    if (!holder.ok || holder.value.state !== "dead") return false;
  }
  const guard: DriveLock = {
    stateDir,
    name,
    what: `PR #${pr} recovery`,
    label,
    diag: diag ?? {
      pr,
      worktree: record.worktree,
      log: "",
      started: record.started,
      account: {
        account: null,
        vendor: null,
        provenance: "recovery",
        reason: "temporary ledger reconciliation",
      },
    },
  };
  const reserved = inTransaction(drive.db, () => {
    const current: unknown = drive.db
      .query(
        "SELECT released FROM driver_records WHERE clone = ? AND pr = ? AND started = ? AND pid = ? AND host = ? AND worktree = ?",
      )
      .get(
        drive.clone,
        pr,
        record.started,
        record.pid,
        record.host,
        record.worktree,
      );
    if (!isRecord(current) || (!witness && current.released !== 1))
      return false;
    if (!acquireObservedLock(guard, seen?.token ?? null)) return false;
    if (witness) {
      // The slot and witness commit together. A killed helper leaves both or neither.
      drive.db.run(
        "UPDATE driver_records SET released = 1 WHERE clone = ? AND pr = ? AND started = ? AND pid = ? AND host = ? AND worktree = ?",
        [
          drive.clone,
          pr,
          record.started,
          record.pid,
          record.host,
          record.worktree,
        ],
      );
    }
    return true;
  });
  if (!reserved) return false;
  try {
    await recover();
  } finally {
    release(guard);
  }
  return true;
}
