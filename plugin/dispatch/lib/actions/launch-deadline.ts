import { currentMs } from "../../../shared/time.ts";
import type { MachineConfig } from "../machine-config.ts";
import { tickDeadlineMs } from "../machine-config.ts";
import type { ApplyState } from "./launch.ts";

/** The installed launcher's deadline, or this machine's configured tick deadline. */
export function enforcedDeadlineMs(
  machine: MachineConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const installed = env.JIG_LAUNCHER_DEADLINE_SEC ?? "";
  return /^[1-9][0-9]*$/.test(installed)
    ? Number(installed) * 1000
    : tickDeadlineMs(machine);
}

/** The kill grace a timed-out child may take beyond its timeout before it settles. */
export const KILL_GRACE_MS = 2000;

/** The longest `calls` runtime calls of `timeoutMs` each take to settle: a call rounds up to whole seconds and may spend its kill grace. */
export function settleMs(timeoutMs: number, calls = 1): number {
  return calls * (Math.ceil(timeoutMs / 1000) * 1000 + KILL_GRACE_MS);
}

/** What the tick has left of its launcher's deadline, less the time its receipt needs; `null` for a tick that keeps no start. */
export function timeLeftMs(
  state: Pick<ApplyState, "startedAt" | "machine">,
): number | null {
  if (state.startedAt === undefined) return null;
  const allowed =
    enforcedDeadlineMs(state.machine) - state.machine.runtimeTimeoutMs;
  return allowed - (currentMs() - state.startedAt);
}
