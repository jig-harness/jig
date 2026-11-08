/**
 * Whether a drive ledger's running driver is gone from this host, read
 * without writing anything: for a reader outside the clone that drove it
 * (the dispatcher), which takes a silent drive over only where this host
 * shows its driver's run ended. The run is found in this machine's drive
 * database by the ledger's clone key, pull request and acquisition time, and
 * shown ended by the evidence recovery itself accepts (`ledger-stop.ts`): a
 * released witness whose driver pid no longer runs, or the acquisition's
 * persisted observations showing the driver and every observed or
 * registered pass gone (`driver-observation.ts`). A driver whose lock claim
 * still reads alive is `present`; anything else is `unknown`.
 *
 * The caller opens the database read-only (`READ_ONLY_ENV`), so a read never
 * migrates another clone's rows or reads its state directory in.
 */
import { observedDriverGone } from "./driver-observation.ts";
import { claimAlive, inspectLock, prLockName } from "./driver/locks.ts";
import { type DriverRecord, readDriverRecord } from "./ledger-stop.ts";
import { pidAlive } from "./proc.ts";
import { driveDbReadiness } from "./state/db.ts";
import { stateDirOfClone } from "./state/store.ts";

export interface Presence {
  verdict: "gone" | "present" | "unknown";
  why: string;
}

/** The run a ledger names: its pull request, its clone's key and its acquisition time. */
export interface RecordedRun {
  pr: string;
  clone: string;
  started: string;
}

/** The run `driver-presence.ts`'s arguments name (`<PR> <clone key> <started>`); `null` when they name none. */
export function recordedRun(argv: readonly string[]): RecordedRun | null {
  const [pr = "", clone = "", started = ""] = argv;
  // The clone key names a state directory: one path component, never `.` or `..`.
  const key = /^[\w.-]+$/.test(clone) && clone !== "." && clone !== "..";
  return argv.length === 3 && /^[1-9]\d*$/.test(pr) && key && started !== ""
    ? { pr, clone, started }
    : null;
}

/** What this host shows of the driver run `run` names, from the state directory of its clone under this machine's root unless `stateDir` names another. */
export async function driverPresence(
  run: RecordedRun,
  stateDir = stateDirOfClone(run.clone),
): Promise<Presence> {
  const unread = unreadDatabase(stateDir);
  if (unread !== null) return { verdict: "unknown", why: unread };
  const record = readDriverRecord(stateDir, run.pr);
  if (record === null || record.started !== run.started)
    return {
      verdict: "unknown",
      why: `this host's drive database holds no record of the driver's run started ${run.started} in clone ${run.clone}`,
    };
  if (record.released === true) return releasedPresence(record);
  if (await observedDriverGone(stateDir, run.pr, record))
    return {
      verdict: "gone",
      why: `its driver (pid ${record.pid}) and every pass it observed or registered are gone`,
    };
  return heldPresence(stateDir, run, record);
}

/** Why this host's drive database cannot be read without writing; `null` when it can. */
function unreadDatabase(stateDir: string): string | null {
  const ready = driveDbReadiness(stateDir);
  if (ready.state === "current") return null;
  return ready.state === "absent"
    ? "this host has no drive database, so it holds no record of the driver's run"
    : `this host's drive database cannot be read without writing: ${ready.reason}`;
}

/** A driver that released its locks: gone once its pid no longer runs, as recovery reads it. */
function releasedPresence(record: DriverRecord): Presence {
  return pidAlive(record.pid, record.host)
    ? {
        verdict: "present",
        why: `its driver released its locks, and its pid ${record.pid} still runs`,
      }
    : {
        verdict: "gone",
        why: `its driver released its locks, and its pid ${record.pid} no longer runs`,
      };
}

/** A driver whose run no observation shows ended: present while its lock claim reads alive, else unknown. */
function heldPresence(
  stateDir: string,
  run: RecordedRun,
  record: DriverRecord,
): Presence {
  const claim = inspectLock(stateDir, prLockName(run.pr));
  const alive =
    claim !== null && claim.diag?.started === run.started && claimAlive(claim);
  return alive
    ? {
        verdict: "present",
        why: `its driver (pid ${claim.pid}) still holds the pull request's lock`,
      }
    : {
        verdict: "unknown",
        why: `its driver (pid ${record.pid}) left no complete observation of its passes that shows them gone`,
      };
}
