/**
 * Marking a stopped driver's drive ledger stopped from outside the driver:
 * `drives.ts --stop` once the driver is witnessed gone, and `drives.ts
 * --stop` or `--doctor` against a lock whose process is confirmed gone (the
 * recovery after a crash, a kill, or a stop by signal, none of which can
 * write it: once a driver's shutdown begins it starts no new command).
 *
 * Guarded so it never overwrites a successor: the ledger is marked only
 * while it still names the stopped driver as running (its working tree, its
 * clone and, where recorded, its run), with no claim in force from another
 * clone past its recorded position (`ledgerOfStoppedDriver`). Any other
 * ledger is left as it is, and stderr says so. The write itself goes
 * through `drive-state.ts handoff` under a driver variable naming the
 * stopped driver, the path every ledger write takes.
 */
import type { ClaimDiag } from "./claim.ts";
import { driveState } from "./driver/paths.ts";
import { helperTimeoutSeconds, pidAlive, run, tsArgv } from "./proc.ts";
import { worktreePathKey } from "./state/actor.ts";
import { ledgerOfStoppedDriver } from "./state/ledger.ts";
import { readLedgerSnapshot, resolveLogin } from "./state/ledger-forge.ts";
import {
  LEDGER_DRIVER_ENV,
  type LedgerDriverEnv,
  cloneId,
} from "./state/ledger-mirror.ts";

/** A lock row, as far as a recovery reads it. */
export interface StoppedLock {
  state: string;
  pid: number | null;
  host: string | null;
  diag: ClaimDiag | null;
}

/**
 * Mark PR `pr`'s ledger stopped for the driver `diag` names, guarded as the
 * module header says; `exit` is the exit it stopped with, `null` unknown.
 */
export async function markLedgerStopped(
  stateDir: string,
  pr: string,
  diag: ClaimDiag | null,
  exit: number | null,
): Promise<void> {
  if ((process.env.DRIVE_PR_LEDGER ?? "") === "off" || diag === null) return;
  if (diag.worktree === "") return;
  // Best-effort: the stop itself has already happened, and its exit stands.
  try {
    await markGuarded(stateDir, pr, diag, exit);
  } catch (err) {
    console.error(
      `ledger: PR #${pr}'s ledger was not marked stopped: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

async function markGuarded(
  stateDir: string,
  pr: string,
  diag: ClaimDiag,
  exit: number | null,
): Promise<void> {
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
    return;
  }
  const found = ledgerOfStoppedDriver(snapshot, who);
  if ("why" in found) {
    // Silent when there is nothing to say: no ledger, or one already stopped.
    const parsed = snapshot.canonical?.parsed;
    if (parsed?.kind === "ledger" && parsed.ledger.driver.state === "running")
      console.error(
        `ledger: PR #${pr}'s ledger is left as it is: ${found.why}.`,
      );
    return;
  }
  const driver: LedgerDriverEnv = {
    ...who,
    login,
    floor: found.ledger.driver.position ?? null,
    claim: null,
    stopped: exit,
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
  if (res.code !== 0)
    console.error(
      `ledger: PR #${pr}'s ledger was not marked stopped (drive-state.ts handoff exited ${res.code}).`,
    );
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
  await markLedgerStopped(stateDir, pr, row.diag, null);
}

/** `--doctor`'s recovery: every PR lock in `rows` whose process is confirmed gone. */
export async function recoverStoppedLedgers(
  stateDir: string,
  rows: ReadonlyArray<StoppedLock & { kind: string; key: string }>,
): Promise<void> {
  for (const row of rows)
    if (row.kind === "pr") await recoverStoppedLedger(stateDir, row.key, row);
}
