/** Run the handoff helper that publishes a driver's stopped ledger. */
import type { ForgeLimit } from "../forge-limit.ts";
import { helperTimeoutSeconds, run, tsArgv } from "../proc.ts";
import {
  HANDOFF_REPORT_LIMIT,
  HANDOFF_TELLS_REFUSED,
  LEDGER_DRIVER_ENV,
  LEDGER_REFUSED_EXIT,
  type LedgerDriverEnv,
  handoffLimit,
} from "../state/ledger-mirror.ts";
import { driveState } from "./paths.ts";

/**
 * What follows a ledger write the drive asked `handoff` for, told refusals
 * (`HANDOFF_TELLS_REFUSED`): `label` when it landed, so the state label may
 * follow; `refused` when the guards refused it, so the ledger is not this
 * driver's to label; `unwritten` when it was attempted and did not land.
 */
export function afterHandoff(code: number): "label" | "refused" | "unwritten" {
  if (code === 0) return "label";
  return code === LEDGER_REFUSED_EXIT ? "refused" : "unwritten";
}

/** Attempt the stopped ledger and carry back a rate limit found after a provisional label. */
export async function writeStoppedHandoff(
  pr: string,
  driver: LedgerDriverEnv,
  code: number | null,
  attempts: number,
): Promise<{ handoff: number; limit: ForgeLimit | null }> {
  const reportLimit = attempts > 1;
  let handoff = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await run(tsArgv(driveState, ["handoff", pr]), {
      stdout: reportLimit ? "pipe" : "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
      env: {
        ...process.env,
        [LEDGER_DRIVER_ENV]: JSON.stringify({ ...driver, stopped: code }),
        [HANDOFF_TELLS_REFUSED]: "1",
        ...(reportLimit ? { [HANDOFF_REPORT_LIMIT]: "1" } : {}),
      },
    });
    handoff = res.code;
    const limit = reportLimit ? handoffLimit(res.stdout) : null;
    if (limit !== null) return { handoff, limit };
    if (afterHandoff(handoff) !== "unwritten") break;
    if (attempts > 1)
      console.error(
        `ledger: PR #${pr}'s stopped ledger (exit ${code}) was not written (attempt ${attempt} of ${attempts}).`,
      );
  }
  return { handoff, limit: null };
}
