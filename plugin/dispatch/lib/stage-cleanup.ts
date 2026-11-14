/** Driver locks survive uncertain cleanup; a normal child exit alone is not its completion witness. */
import { thisHost } from "../../shared/liveness.ts";
import { swallow } from "../../shared/errors.ts";
import { peekResolvedStateDir } from "../../skills/drive-pr/scripts/lib/state/store.ts";
import {
  inspectLock,
  prLockName,
} from "../../skills/drive-pr/scripts/lib/driver/locks.ts";
import { readDriverRecord } from "../../skills/drive-pr/scripts/lib/ledger-stop.ts";
import { isDrive, type LaunchRecord } from "./launches.ts";
import { readStageClaim } from "./launch-supervision.ts";
import type { Ran } from "./run-stage.ts";

/** Externally interrupted drivers cannot certify the detached pass groups they manage. */
export async function driverCleanupUncertain(
  record: LaunchRecord,
  ran: Ran,
): Promise<boolean> {
  if (!isDrive(record)) return false;
  if (interruptedDriver(ran)) return true;
  try {
    const stateDir = await peekResolvedStateDir();
    if (stateDir === null || record.pr === null) return false;
    const driver = readDriverRecord(stateDir, String(record.pr));
    const lock = inspectLock(stateDir, prLockName(String(record.pr)));
    const child = readStageClaim(record.id, record.token)?.supervision?.child;
    const host = child ?? thisHost();
    const pid = child?.pid ?? ran.pid;
    if (
      driver !== null &&
      driver.released !== true &&
      driver.pid === pid &&
      driver.host === host.host
    )
      return true;
    if (lock === null) return false;
    if (
      lock.pid !== pid ||
      lock.hostId !== host.hostId ||
      lock.bootId !== host.bootId
    )
      return false;
    // Windows locks deliberately omit creation time; that absence cannot prove cleanup.
    return child == null || lock.start === "" || lock.start === child.start;
  } catch (error) {
    swallow(error, "the driver's cleanup witness could not be read");
    return true;
  }
}

function interruptedDriver(ran: Ran): boolean {
  return (
    ran.interrupted === true || ran.signal !== null || (ran.code ?? 0) >= 128
  );
}
