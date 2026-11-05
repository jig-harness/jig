/**
 * The generation-addressed cooperative stop channel: `drives.ts --stop`
 * asks a driver to stop, and the driver confirms it stopped, through a row
 * of the drive database's `stops` table keyed by the driver lock and that
 * lock's acquisition token. A successor's lock has another token, so an old
 * request can never stop a replacement driver. The request goes with the
 * lock when the driver releases it; the completion outlives the release, for
 * `--stop` to read and consume.
 */
import { driveDb } from "./state/db.ts";
import { fail } from "./cli.ts";

/** Ask the driver holding `lock` under `nonce` to stop. Idempotent. */
export function requestDriverStop(
  stateDir: string,
  lock: string,
  nonce: string,
): void {
  const drive = driveDb(stateDir);
  drive.db.run(
    "INSERT OR IGNORE INTO stops (clone, lock, nonce, requested_at) VALUES (?, ?, ?, ?)",
    [drive.clone, lock, nonce, new Date().toISOString()],
  );
}

/** Whether a stop was requested of the driver holding `lock` under `nonce`. */
export function driverStopRequested(
  stateDir: string,
  lock: string,
  nonce: string,
): boolean {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query("SELECT 1 FROM stops WHERE clone = ? AND lock = ? AND nonce = ?")
      .get(drive.clone, lock, nonce) !== null
  );
}

/** The driver's confirmation that it stopped as asked, as process `pid`. */
export function publishDriverStopCompletion(
  stateDir: string,
  lock: string,
  nonce: string,
  pid: number,
): void {
  const drive = driveDb(stateDir);
  drive.db.run(
    "UPDATE stops SET completed_pid = ?, completed_at = ? WHERE clone = ? AND lock = ? AND nonce = ?",
    [pid, new Date().toISOString(), drive.clone, lock, nonce],
  );
}

/** Whether the driver holding `lock` under `nonce`, as process `pid`, confirmed it stopped. */
export function driverStopCompleted(
  stateDir: string,
  lock: string,
  nonce: string,
  pid: number,
): boolean {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query(
        "SELECT 1 FROM stops WHERE clone = ? AND lock = ? AND nonce = ? AND completed_pid = ?",
      )
      .get(drive.clone, lock, nonce, pid) !== null
  );
}

/** Forget a stop and its completion, once `--stop` has read it. */
export function consumeDriverStopCompletion(
  stateDir: string,
  lock: string,
  nonce: string,
): void {
  const drive = driveDb(stateDir);
  drive.db.run("DELETE FROM stops WHERE clone = ? AND lock = ? AND nonce = ?", [
    drive.clone,
    lock,
    nonce,
  ]);
}

/** Forget an unanswered stop request of `lock` under `nonce`: the lock is being released. */
export function clearDriverStopRequest(
  stateDir: string,
  lock: string,
  nonce: string,
): void {
  const drive = driveDb(stateDir);
  drive.db.run(
    "DELETE FROM stops WHERE clone = ? AND lock = ? AND nonce = ? AND completed_at IS NULL",
    [drive.clone, lock, nonce],
  );
}

/**
 * Remove `--expect-started ISO` from `argv` and return ISO (`''` when
 * absent): the acquisition a `--stop` is bound to.
 */
export function takeExpectStarted(argv: string[]): string {
  const at = argv.indexOf("--expect-started");
  if (at < 0) return "";
  const [, value = ""] = argv.splice(at, 2);
  if (value === "") fail(2, "--expect-started takes a time");
  return value;
}

export function requireStopForExpectStarted(
  expectStarted: string,
  stopPr: string,
): void {
  if (expectStarted !== "" && stopPr === "")
    fail(2, "--expect-started only qualifies --stop");
}
