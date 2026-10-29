/**
 * Marking a stopped driver's drive ledger stopped from outside the driver:
 * `drives.ts --stop` once the driver and its captured pass tree are
 * witnessed gone, and `drives.ts --stop` or `--doctor` against a driver
 * record the driver marked released (the recovery after a stop by signal or
 * a failed last write, neither of which can write it: once a driver's
 * shutdown begins it starts no new command). The driver marks its record
 * released only as it releases its locks, which it does only once it has
 * witnessed its pass's process tree terminating.
 *
 * A lock left behind is no such evidence. A driver that retained its locks
 * over a pass it could not witness gone, or that was killed outright, may
 * have left that pass running in its own process group, so its ledger keeps
 * naming it running: another clone waits out its heartbeat's lease window,
 * and this clone's next drive recovers the lock and continues the ledger.
 *
 * Guarded so it never overwrites a successor: the ledger is marked only
 * while it still names the stopped driver as running (its working tree, its
 * clone and, where recorded, its run), with no claim in force from another
 * clone past its recorded position (`ledgerOfStoppedDriver`). Any other
 * ledger is left as it is, and stderr says so. The write itself goes
 * through `drive-state.ts handoff` under a driver variable naming the
 * stopped driver, the path every ledger write takes.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { CLAIM_PREFIX, type ClaimDiag, parseClaimText } from "./claim.ts";
import { driveState } from "./driver/paths.ts";
import { helperTimeoutSeconds, pidAlive, run, tsArgv } from "./proc.ts";
import { worktreePathKey } from "./state/actor.ts";
import { atomicWrite } from "./state/fsutil.ts";
import { ledgerOfStoppedDriver } from "./state/ledger.ts";
import { readLedgerSnapshot, resolveLogin } from "./state/ledger-forge.ts";
import {
  LEDGER_DRIVER_ENV,
  type LedgerDriverEnv,
  cloneId,
} from "./state/ledger-mirror.ts";

/**
 * A running driver's acquisition, kept beside the state outside its locks:
 * a stop by signal releases the lock, and with it the evidence a recovery
 * reads, so this record is what `--stop` and `--doctor` recover from then.
 * Written once the driver owns the ledger, marked `released` as the driver
 * releases its locks, and removed once its stopped ledger is written or the
 * drive is taken over.
 */
export interface DriverRecord {
  worktree: string;
  started: string;
  pid: number;
  host: string;
  /** The driver witnessed its pass gone and released its locks. */
  released?: true;
}

function recordPath(stateDir: string, pr: string): string {
  return join(stateDir, `ledger-driver-${pr}.json`);
}

export function writeDriverRecord(
  stateDir: string,
  pr: string,
  record: DriverRecord,
): void {
  atomicWrite(recordPath(stateDir, pr), `${JSON.stringify(record)}\n`);
}

/** Remove the record when it is still `started`'s (a successor's stays). */
export function removeDriverRecord(
  stateDir: string,
  pr: string,
  started: string,
): void {
  if (readDriverRecord(stateDir, pr)?.started === started)
    rmSync(recordPath(stateDir, pr), { force: true });
}

/**
 * Mark `started`'s record released: called only as the driver releases the
 * PR's lock, which it keeps over a pass it could not witness gone.
 */
export function markDriverRecordReleased(
  stateDir: string,
  pr: string,
  started: string,
): void {
  // Never in the way of the release: an unmarked record only keeps the
  // ledger running, the direction a lost mark is safe in.
  try {
    const record = readDriverRecord(stateDir, pr);
    if (record?.started === started)
      writeDriverRecord(stateDir, pr, { ...record, released: true });
  } catch (err) {
    swallow(err, "the driver record could not be marked released");
  }
}

function readDriverRecord(stateDir: string, pr: string): DriverRecord | null {
  try {
    const v: unknown = JSON.parse(
      readFileSync(recordPath(stateDir, pr), "utf8"),
    );
    return isRecord(v) &&
      typeof v.worktree === "string" &&
      typeof v.started === "string" &&
      typeof v.pid === "number" &&
      typeof v.host === "string" &&
      (v.released === undefined || v.released === true)
      ? (v as unknown as DriverRecord)
      : null;
  } catch (err) {
    swallow(err, "no readable driver record");
    return null;
  }
}

/**
 * The recovery from a driver record: when the driver it names released its
 * locks, is gone and no longer holds the PR's lock, mark its ledger stopped,
 * guarded, and drop the record once nothing is left to do.
 */
export async function recoverFromDriverRecord(
  stateDir: string,
  pr: string,
  lock: { diag: { started: string } | null },
): Promise<void> {
  const record = readDriverRecord(stateDir, pr);
  if (record === null || lock.diag?.started === record.started) return;
  if (record.released !== true) {
    console.error(
      `ledger: PR #${pr}'s ledger is left running: its driver (started ${record.started}) did not release its locks, so a pass it could not witness gone may still act.`,
    );
    return;
  }
  if (pidAlive(record.pid, record.host)) return;
  if ((await markLedgerStopped(stateDir, pr, record, null)) === "done")
    removeDriverRecord(stateDir, pr, record.started);
}

/** `--doctor`'s sweep of the driver records no lock row covers. */
async function recoverDriverRecords(stateDir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(stateDir);
  } catch (err) {
    swallow(err, "the state directory could not be listed");
  }
  for (const name of names) {
    const pr = /^ledger-driver-(\d+)\.json$/.exec(name)?.[1];
    if (pr === undefined) continue;
    const row = readLock(join(stateDir, `pr-drive-${pr}.lock`));
    if (row !== "unreadable") await recoverFromDriverRecord(stateDir, pr, row);
  }
}

/** The PR lock's single claim's diagnostics, `{diag: null}` when none holds it. */
function readLock(
  dir: string,
): { diag: { started: string } | null } | "unreadable" {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { diag: null };
    return "unreadable";
  }
  const claims = names.filter(
    (n) => n.startsWith(CLAIM_PREFIX) && n.length > CLAIM_PREFIX.length,
  );
  if (claims.length === 0) return { diag: null };
  if (claims.length > 1) return "unreadable";
  try {
    const record = parseClaimText(
      readFileSync(join(dir, claims[0] as string), "utf8"),
    );
    return record === null ? "unreadable" : { diag: record.diag };
  } catch (err) {
    swallow(err, "the PR lock's claim could not be read");
    return "unreadable";
  }
}

/** The stopped driver's tree and acquisition, as a lock or a record names them. */
type StoppedDiag = Pick<ClaimDiag, "worktree" | "started">;

/**
 * Mark PR `pr`'s ledger stopped for the driver `diag` names, guarded as the
 * module header says; `exit` is the exit it stopped with, `null` unknown.
 * `done` when nothing is left to do (marked, or not the driver's to mark),
 * `retry` when the forge did not answer.
 */
export async function markLedgerStopped(
  stateDir: string,
  pr: string,
  diag: StoppedDiag | null,
  exit: number | null,
): Promise<"done" | "retry"> {
  if ((process.env.DRIVE_PR_LEDGER ?? "") === "off" || diag === null)
    return "done";
  if (diag.worktree === "") return "done";
  // Best-effort: the stop itself has already happened, and its exit stands.
  try {
    return await markGuarded(stateDir, pr, diag, exit);
  } catch (err) {
    console.error(
      `ledger: PR #${pr}'s ledger was not marked stopped: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return "retry";
  }
}

async function markGuarded(
  stateDir: string,
  pr: string,
  diag: StoppedDiag,
  exit: number | null,
): Promise<"done" | "retry"> {
  const who = {
    actor: `wt-${worktreePathKey(diag.worktree)}`,
    clone: cloneId(stateDir),
    started: diag.started,
  };
  const login = await resolveLogin();
  const snapshot = await readLedgerSnapshot(pr, login);
  if (typeof snapshot === "string") {
    console.error(
      `ledger: PR #${pr}'s ledger was not marked stopped: ${snapshot}.`,
    );
    return "retry";
  }
  const found = ledgerOfStoppedDriver(snapshot, who);
  if ("why" in found) {
    // Silent when there is nothing to say: no ledger, or one already stopped.
    const parsed = snapshot.canonical?.parsed;
    if (parsed?.kind === "ledger" && parsed.ledger.driver.state === "running")
      console.error(
        `ledger: PR #${pr}'s ledger is left as it is: ${found.why}.`,
      );
    return "done";
  }
  const driver: LedgerDriverEnv = {
    ...who,
    login,
    floor: found.ledger.driver.position ?? null,
    claim: found.own,
    stopped: exit,
    // The writer re-checks the guard against every snapshot it builds from:
    // a successor can publish between this read and that write.
    recovering: true,
  };
  const res = await run(tsArgv(driveState, ["handoff", pr]), {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    env: {
      ...process.env,
      [LEDGER_DRIVER_ENV]: JSON.stringify(driver),
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_WORKTREE: diag.worktree,
    },
  });
  if (res.code === 0) return "done";
  console.error(
    `ledger: PR #${pr}'s ledger was not marked stopped (drive-state.ts handoff exited ${res.code}).`,
  );
  return "retry";
}

/**
 * Mark the ledger of the stopped driver `diag` names stopped, and drop its
 * driver record once nothing is left to do: for a driver whose captured
 * pass tree `--stop` witnessed gone.
 */
export async function settleStoppedDriver(
  stateDir: string,
  pr: string,
  diag: StoppedDiag | null,
): Promise<void> {
  if (diag === null) return;
  if ((await markLedgerStopped(stateDir, pr, diag, null)) === "done")
    removeDriverRecord(stateDir, pr, diag.started);
}

/**
 * `--stop`'s recovery when no live driver holds PR `pr`'s lock: the driver
 * record a released driver left. A stale lock's own driver is no such
 * driver: it kept its locks.
 */
export async function recoverIdleStop(
  stateDir: string,
  pr: string,
  row: { diag: { started: string } | null },
): Promise<void> {
  await recoverFromDriverRecord(stateDir, pr, row);
}

/** `--doctor`'s recovery: every driver record a released driver left. */
export async function recoverStoppedLedgers(stateDir: string): Promise<void> {
  await recoverDriverRecords(stateDir);
}
