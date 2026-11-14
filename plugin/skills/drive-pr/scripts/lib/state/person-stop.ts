/** A deliberate stop is bound to the driver acquisition and survives failed forge writes. */
import { fail } from "../cli.ts";
import { driveDb } from "./db.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { redact } from "./ledger.ts";
import { currentIso, parseMs } from "../../../../../shared/time.ts";

export function personStopFor(
  stateDir: string,
  pr: string,
  started: string | undefined,
) {
  const drive = driveDb(stateDir);
  const row = drive.db
    .query(
      "SELECT started, person_stop FROM driver_records WHERE clone = ? AND pr = ?",
    )
    .get(drive.clone, pr) as {
    started: string;
    person_stop: string | null;
  } | null;
  if (row === null || row.started !== started || row.person_stop === null)
    return {};
  const stop: unknown = JSON.parse(row.person_stop);
  if (
    !isRecord(stop) ||
    typeof stop.at !== "string" ||
    !Number.isFinite(parseMs(stop.at)) ||
    typeof stop.reason !== "string"
  )
    fail(1, "the operator stop record does not read");
  return { personStop: { at: stop.at, reason: redact(stop.reason) } };
}

/** Never replace the record of a successor that acquired while the stop verified its target. */
export function recordPersonStop(
  stateDir: string,
  pr: string,
  driver: { worktree: string; started: string; pid: number; host: string },
  reason: string,
): boolean {
  const drive = driveDb(stateDir);
  return (
    drive.db.run(
      `INSERT INTO driver_records (clone, pr, worktree, started, pid, host, person_stop)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (clone, pr) DO UPDATE SET person_stop = excluded.person_stop
    WHERE driver_records.started = excluded.started`,
      [
        drive.clone,
        pr,
        driver.worktree,
        driver.started,
        driver.pid,
        driver.host,
        JSON.stringify({ at: currentIso(), reason }),
      ],
    ).changes > 0
  );
}
