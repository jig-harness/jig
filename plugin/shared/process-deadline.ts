/** Deadlines settle independently of inherited pipes still held by descendants. */
import type { ChildProcess } from "node:child_process";
import type { ProcessTimers } from "./process-output.ts";

export function armProcessDeadline(
  child: ChildProcess,
  timers: ProcessTimers,
  timeoutSec: number | undefined,
  graceMs: () => number,
  onTimeout: () => void,
  signalTree: (signal: NodeJS.Signals) => void,
  settle: (code: number) => void,
): void {
  if (timeoutSec === undefined) return;
  timers.kill = setTimeout(() => {
    onTimeout();
    signalTree("SIGTERM");
    timers.escalate = setTimeout(() => {
      signalTree("SIGKILL");
      // `close` waits for inherited streams, including descendants that escaped
      // the group. Destroy our pipe ends so those handles cannot extend the
      // deadline or keep the runtime alive after its result has settled.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle(124);
    }, graceMs());
  }, timeoutSec * 1000);
}
