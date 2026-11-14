/** Record CI retries and charged repairs in the state mirrored to the drive ledger. */
import { run, tsArgv } from "../proc.ts";
import { driveState } from "./paths.ts";

export async function recordCiAttempt(
  pr: string,
  action: "rerun" | "repair",
  detail: string,
): Promise<void> {
  const result = await run(tsArgv(driveState, ["record-event", pr]), {
    stdin: JSON.stringify({ kind: "ci", cause: `${action}: ${detail}` }),
    stderr: "pipe",
    timeoutSec: 60,
  });
  if (result.code !== 0)
    console.error(
      `Could not record the CI ${action} in the ledger: ${result.stderr.trim()}`,
    );
}
