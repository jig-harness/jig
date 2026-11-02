/**
 * `jig dispatch install [--interval 5m] [--yes] [--uninstall]`: the timer
 * that runs `jig dispatch --apply` every interval, on the scheduler and
 * launcher code `jig gc install` uses (a systemd user timer, a launchd job,
 * or a crontab line). It prints the job first and writes it only with
 * `--yes`; the job finds the installed copy of the plugin at each run, so a
 * plugin update reaches it without a new install. What the tick starts is
 * the machine file's to say, so the job is written only when there is one.
 */
import { resolve } from "node:path";
import { ExitError } from "../shared/cli.ts";
import { GcError } from "../shared/gc-error.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import type { JobSpec } from "../runtime/job-spec.ts";
import {
  checkLauncherResolves,
  detectScheduler,
  installedScript,
  jobPreview,
  restoreScheduler,
  snapshotScheduler,
  updateJob,
} from "../runtime/scheduler.ts";
import {
  type MachineConfig,
  machineConfigPath,
  MIN_TICK_DEADLINE_MS,
  tickBudgetMs,
} from "./lib/machine-config.ts";
import { stateRoot } from "./receipts.ts";

/** `jig dispatch install`'s options, as dispatch/cli.ts parses them. */
interface InstallOptions {
  /** `--interval`, whole minutes in milliseconds; null takes the machine file's. */
  intervalMs: number | null;
  confirm: boolean;
  uninstall: boolean;
}

/**
 * The Orca command configuration the tick resolves at run time, kept in the
 * installed job: a timer's environment holds none of a login shell's.
 */
function orcaEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const command = env.ORCA_CLI_COMMAND?.trim();
  const dir = env.ORCA_CLI_BIN_DIR?.trim();
  return {
    ...(command ? { ORCA_CLI_COMMAND: command } : {}),
    ...(dir ? { ORCA_CLI_BIN_DIR: resolve(dir) } : {}),
  };
}

/**
 * The tick's job, every `minutes`. Its overall budget covers the workspace
 * opens one tick makes (`OPENS_PER_TICK`) and the runtime calls around them
 * at the machine file's limits, and never less than `MIN_TICK_DEADLINE_MS`.
 */
export function dispatchJobSpec(
  minutes: number,
  machine: MachineConfig | null = null,
  env: NodeJS.ProcessEnv = process.env,
): JobSpec {
  const needed = machine === null ? 0 : Math.ceil(tickBudgetMs(machine) / 1000);
  const minimum = MIN_TICK_DEADLINE_MS / 1000;
  return {
    name: "jig-dispatch",
    label: "dev.jig.dispatch",
    description: "Jig dispatcher tick",
    timerDescription: `Jig dispatcher tick every ${minutes} minutes`,
    stateRoot: stateRoot(),
    args: ["dispatch", "--apply"],
    schedule: { everyMinutes: minutes },
    deadlineSec: Math.max(minimum, needed),
    env: orcaEnvironment(env),
  };
}

/**
 * The timer's interval in minutes: `--interval` (`override`), else the machine
 * file's, else five; whole minutes, or a usage error (exit 2).
 */
function intervalMinutes(
  override: number | null,
  machine: MachineConfig | null,
): number {
  if (override !== null && override % 60_000 !== 0)
    throw new ExitError(
      2,
      `the interval must be whole minutes; --interval is ${override / 1000}s`,
    );
  const ms = override ?? machine?.intervalMs ?? 5 * 60_000;
  if (ms % 60_000 !== 0)
    throw new ExitError(
      2,
      `the interval must be whole minutes; the machine file's interval is ${ms / 1000}s`,
    );
  return ms / 60_000;
}

export async function installDispatch(
  options: InstallOptions,
  script: string,
  machine: MachineConfig | null,
): Promise<number> {
  if (options.intervalMs !== null) intervalMinutes(options.intervalMs, null);
  if (machine === null && !options.uninstall)
    throw new ExitError(
      2,
      `the dispatch timer needs the machine file ${machineConfigPath()} first: it runs --apply, and that file says what it may start`,
    );
  const spec = dispatchJobSpec(
    intervalMinutes(options.intervalMs, machine),
    machine,
  );
  console.log(jobPreview(spec, options.uninstall));
  if (!options.confirm) {
    console.log("Preview only. Repeat with --yes to write the job.");
    return 0;
  }
  if (!installedScript(script))
    throw new GcError(
      "Scheduler installation requires the installed plugin copy, outside every worktree",
    );
  if (!options.uninstall) await checkLauncherResolves();
  return exclusiveGcLock("install", async () => {
    // Captured first, so a failed update puts back the job that was running.
    const previous = await snapshotScheduler(detectScheduler(), spec);
    let job: string;
    try {
      job = await updateJob(spec, options.uninstall);
    } catch (error) {
      await restoreScheduler(previous);
      throw new GcError(
        `${(error as Error).message}; the previous scheduler job is restored`,
      );
    }
    console.log(
      `Scheduler ${options.uninstall ? "removed" : "updated"}: ${job}`,
    );
    return 0;
  });
}
