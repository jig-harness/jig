/** Operator-stop options and the acquisition-bound intent persisted before shutdown. */
import { fail } from "./cli.ts";
import type { ClaimDiag } from "./claim.ts";
import { withLedgerWriteLock } from "./state/ledger-write-lock.ts";
import {
  canStopPublishedDriver,
  publishOperatorStop,
} from "./state/stop-ownership.ts";
import { recordPersonStop } from "./state/person-stop.ts";
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

export function requireStopOptions(
  expectStarted: string,
  reason: string,
  stopPr: string,
): void {
  if (expectStarted !== "" && stopPr === "")
    fail(2, "--expect-started only qualifies --stop");
  if (reason !== "" && stopPr === "") fail(2, "--reason only qualifies --stop");
}

export function takeReason(argv: string[]): string {
  const at = argv.indexOf("--reason");
  if (at < 0) return "";
  const [, value = ""] = argv.splice(at, 2);
  if (value === "") fail(2, "--reason takes text");
  return value;
}
function persistOperatorStop(
  row: {
    stateDir: string;
    key: string;
    host: string | null;
    diag: ClaimDiag | null;
  },
  pid: number,
  reason: string,
): boolean {
  const diag = row.diag;
  if (diag === null) return true;
  return recordPersonStop(
    row.stateDir,
    row.key,
    {
      worktree: diag.worktree,
      started: diag.started,
      pid,
      host: row.host ?? "",
    },
    reason,
  );
}

/** Refuse unpublished ownership before recording or sending an operator stop. */
export async function prepareOperatorStop(
  row: Parameters<typeof persistOperatorStop>[0],
  pid: number,
  reason: string,
): Promise<number | null> {
  if (process.env.DRIVE_PR_LEDGER === "off")
    return persistOperatorStop(row, pid, reason) ? null : 3;
  return withLedgerWriteLock(row.stateDir, row.key, async () => {
    if (!(await canStopPublishedDriver(row))) return 1;
    if (!persistOperatorStop(row, pid, reason)) return 3;
    if (!(await publishOperatorStop(row))) {
      console.log(
        "refusing to signal: operator stop could not be verified on the pull request; hold dispatch and retry.",
      );
      return 1;
    }
    return null;
  });
}
