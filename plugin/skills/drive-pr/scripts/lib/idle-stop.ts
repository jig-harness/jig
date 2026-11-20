/** A person's stop of a drive that holds no lock: recorded on the retained acquisition before the ledger settles. */
import { readDriverRecord, recoverIdleStop } from "./ledger-stop.ts";
import {
  markIdlePersonStop,
  restoreIdlePersonStop,
} from "./state/person-stop.ts";

/**
 * Record the person's stop on the idle acquisition, so a stop whose first
 * attempt was refused still reads as theirs. Returns the exit code that ends
 * the stop (3: another acquisition than the one expected; 1: the stop is not
 * on the ledger), or null once it is recorded or there is nothing to record.
 */
function markIdleStop(
  stateDir: string,
  pr: string,
  expectStarted: string,
  reason: string,
): number | null {
  const idle = readDriverRecord(stateDir, pr);
  if (idle === null) return null;
  if (expectStarted !== "" && idle.started !== expectStarted) {
    console.log(
      `PR #${pr}'s retained driver record is another acquisition (started ${idle.started}, expected ${expectStarted}) — not stopping it.`,
    );
    return 3;
  }
  if (idle.personStop !== undefined) return null;
  if (markIdlePersonStop(stateDir, pr, idle.started, reason)) return null;
  return afterRacedMark(stateDir, pr, idle, reason);
}

/** The mark found no record to update: another recovery or acquisition got there first. */
function afterRacedMark(
  stateDir: string,
  pr: string,
  idle: { worktree: string; started: string; pid: number; host: string },
  reason: string,
): number | null {
  const now = readDriverRecord(stateDir, pr);
  if (now === null) {
    // A concurrent recovery published an ordinary stop and deleted the record first. The acquisition is restored with the person's stop so this recovery republishes the ledger with it, and a retry meets that record, never a settled drive without it.
    if (restoreIdlePersonStop(stateDir, pr, idle, reason)) return null;
    console.log(
      `PR #${pr}'s idle driver record was replaced by another acquisition while the stop was recorded — the person's stop (acquisition ${idle.started}) is not on the ledger; not reporting it settled.`,
    );
    return 1;
  }
  if (now.started !== idle.started || now.personStop === undefined) {
    console.log(
      `PR #${pr}'s retained driver record (started ${idle.started}) changed while the stop was recorded — the person's stop is not on the ledger; not reporting it settled.`,
    );
    return 1;
  }
  return null;
}

/** Record the stop, then settle the ledger the idle drive left; the exit code `--stop` ends with. */
export async function settleIdleStop(
  stateDir: string,
  pr: string,
  row: { diag: { started: string } | null },
  expectStarted: string,
  reason: string,
): Promise<number> {
  const refused = markIdleStop(stateDir, pr, expectStarted, reason);
  if (refused !== null) return refused;
  // A record may stay as a retained CI-hold witness after the ledger is settled; only the outcome says which.
  console.log(
    (await recoverIdleStop(stateDir, pr, row)) === "settled"
      ? `PR #${pr}'s idle ledger is settled.`
      : `PR #${pr}'s idle ledger is not settled: a ledger write is still owed.`,
  );
  return 1;
}
