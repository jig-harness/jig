// Small helpers of the foreground runner: forcing its own child, publishing
// its identity, and arming the command deadline.
import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { swallow } from "../../../../shared/errors.ts";
import {
  processCompletionPath,
  publishProcessIdentity,
} from "../../../../shared/process-registry.ts";
import type { ProcessRow } from "../../../../shared/process-table.ts";
import { currentMs } from "../../../../shared/time.ts";

/** Force only this still-owned OS child handle when native identity lookup is unavailable. */
export function forceOwnedChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    swallow(
      error,
      "owned foreground command could not be forced; tree remains unknown",
    );
  }
}

/** A readable runner identity can finish a handoff whose launch-time probe failed. */
export function registerRunnerSnapshot(
  registry: string | undefined,
  entry: string | undefined,
  rows: ProcessRow[] | null,
): boolean {
  if (!registry || !entry) return false;
  const self = rows?.find((row) => row.pid === process.pid);
  if (!self?.start) return false;
  publishProcessIdentity(
    registry,
    entry,
    self,
    processCompletionPath(registry, entry),
  );
  return true;
}

/** A test fixture can establish captured identities before starting its unchanged deadline. */
export function armCommandDeadline(
  seconds: number,
  timers: NodeJS.Timeout[],
  terminate: (code: number, note: string) => Promise<void>,
): void {
  const start = () =>
    timers.push(
      setTimeout(() => {
        void terminate(124, `deadline of ${seconds}s reached`);
      }, seconds * 1000),
    );
  const gate =
    process.env.NODE_ENV === "test"
      ? process.env.DRIVE_PR_FOREGROUND_WAIT_DEADLINE_GATE
      : undefined;
  if (!gate) {
    start();
    return;
  }
  const readyBy = currentMs() + 20000;
  const readiness = setInterval(() => {
    if (!existsSync(gate) && currentMs() < readyBy) return;
    clearInterval(readiness);
    if (existsSync(gate)) start();
    else void terminate(125, "test deadline gate did not become ready");
  }, 20);
  timers.push(readiness);
}
