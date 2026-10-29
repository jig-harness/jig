/**
 * Marking a stopped driver's drive ledger stopped from outside the driver:
 * `drives.ts --stop` once the driver is witnessed gone, and `drives.ts
 * --stop` or `--doctor` against a lock whose process is confirmed gone, or a
 * driver record whose driver is gone and no longer holds the lock (the
 * recovery after a crash, a kill, or a stop by signal, none of which can
 * write it: once a driver's shutdown begins it starts no new command, and a
 * stop by signal releases the lock).
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
 * Written once the driver owns the ledger, removed once its stopped ledger
 * is written or the drive is taken over.
 */
export interface DriverRecord {
  worktree: string;
  started: string;
  pid: number;
  host: string;
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

function readDriverRecord(stateDir: string, pr: string): DriverRecord | null {
  try {
    const v: unknown = JSON.parse(
      readFileSync(recordPath(stateDir, pr), "utf8"),
    );
    return isRecord(v) &&
      typeof v.worktree === "string" &&
      typeof v.started === "string" &&
      typeof v.pid === "number" &&
      typeof v.host === "string"
      ? (v as unknown as DriverRecord)
      : null;
  } catch (err) {
    swallow(err, "no readable driver record");
    return null;
  }
}

/**
 * The recovery from a driver record: when the driver it names is gone and
 * no longer holds the PR's lock, mark its ledger stopped, guarded, and drop
 * the record once nothing is left to do.
 */
export async function recoverFromDriverRecord(
  stateDir: string,
  pr: string,
  lock: { diag: { started: string } | null },
): Promise<void> {
  const record = readDriverRecord(stateDir, pr);
  if (record === null || lock.diag?.started === record.started) return;
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

/** A lock row, as far as a recovery reads it. */
export interface StoppedLock {
  state: string;
  pid: number | null;
  host: string | null;
  diag: ClaimDiag | null;
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
 * The recovery for a driver that could not write its own stopped ledger:
 * for a lock whose process is confirmed gone, mark the ledger stopped.
 */
export async function recoverStoppedLedger(
  stateDir: string,
  pr: string,
  row: StoppedLock,
): Promise<void> {
  if (row.state !== "stale" || row.pid === null) return;
  if (pidAlive(row.pid, row.host ?? "")) return;
  if (
    (await markLedgerStopped(stateDir, pr, row.diag, null)) === "done" &&
    row.diag !== null
  )
    removeDriverRecord(stateDir, pr, row.diag.started);
}

/** `--doctor`'s recovery: every PR lock in `rows` whose process is confirmed gone. */
export async function recoverStoppedLedgers(
  stateDir: string,
  rows: ReadonlyArray<StoppedLock & { kind: string; key: string }>,
): Promise<void> {
  for (const row of rows)
    if (row.kind === "pr") await recoverStoppedLedger(stateDir, row.key, row);
  await recoverDriverRecords(stateDir);
}
