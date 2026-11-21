import type { MachineConfig } from "../machine-config.ts";
import { tickDeadlineMs } from "../machine-config.ts";

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
