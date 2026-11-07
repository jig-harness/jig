/**
 * `jig dispatch install [--interval 5m] [--yes] [--uninstall]`: the timer
 * that runs `jig dispatch --apply` every interval, on the scheduler and
 * launcher code `jig gc install` uses (a systemd user timer, a launchd job,
 * or a crontab line), and beside it the change probe's timer, which runs
 * `jig dispatch probe --apply` every minute (`lib/change-probe.ts`) unless
 * the machine file sets `change_probe: false`. It prints the jobs first and
 * writes them only with `--yes`; each job finds the installed copy of the
 * plugin at each run, so a plugin update reaches it without a new install.
 * What the tick starts is the machine file's to say, so the jobs are written
 * only when there is one; a removal takes both away.
 *
 * The probe has a timer of its own rather than a place in the tick's: the
 * two run at different intervals, a probe inside the tick's job would wait
 * out every sweep (systemd and launchd never overlap two runs of one job;
 * cron can, and there the probe's holder lock keeps two applying probes
 * apart), and a probe that fails or hangs then never delays a sweep, nor a
 * sweep a probe.
 */
import { resolve } from "node:path";
import { ExitError } from "../shared/cli.ts";
import { GcError } from "../shared/gc-error.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import { jobPresent } from "../runtime/installed-job.ts";
import type { JobSpec } from "../runtime/job-spec.ts";
import {
  checkLauncherResolves,
  detectScheduler,
  installedScript,
  jobPreview,
  restoreScheduler,
  type SchedulerSnapshot,
  snapshotScheduler,
  updateJob,
} from "../runtime/scheduler.ts";
import { probeRoot } from "./lib/change-probe.ts";
import {
  type MachineConfig,
  machineConfigPath,
  MIN_TICK_DEADLINE_MS,
  tickBudgetMs,
} from "./lib/machine-config.ts";
import { stateRoot } from "./receipts.ts";
import { WAKE_ATTEMPTS, WAKE_SPACING_MS } from "../shared/wake.ts";

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
 * opens one tick makes (`opens_per_tick`) and the runtime calls around them
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
 * The change probe's job, every minute, with its own state directory under
 * the dispatcher's, so its launcher copy and logs are its own. It waits for
 * the ticks it wakes, together, and a waiter starts up to `WAKE_ATTEMPTS`
 * runs a `WAKE_SPACING_MS` apart, so its deadline covers that many ticks'.
 */
export function probeJobSpec(
  machine: MachineConfig | null = null,
  env: NodeJS.ProcessEnv = process.env,
): JobSpec {
  const tick = dispatchJobSpec(1, machine, env);
  return {
    name: "jig-dispatch-probe",
    label: "dev.jig.dispatch-probe",
    description: "Jig dispatcher change probe",
    timerDescription: "Jig dispatcher change probe every minute",
    stateRoot: probeRoot(),
    args: ["dispatch", "probe", "--apply"],
    schedule: { everyMinutes: 1 },
    ...(tick.deadlineSec === undefined
      ? {}
      : {
          deadlineSec:
            WAKE_ATTEMPTS * (tick.deadlineSec + WAKE_SPACING_MS / 1000),
        }),
  };
}

/** One job an install writes or removes. */
interface JobChange {
  spec: JobSpec;
  remove: boolean;
}

/**
 * Write or remove each job in turn; a failure puts every job back as the
 * snapshots taken first had it, and says so.
 */
async function updateJobs(changes: readonly JobChange[]): Promise<string[]> {
  const previous: SchedulerSnapshot[] = [];
  for (const change of changes)
    previous.push(await snapshotScheduler(detectScheduler(), change.spec));
  const written: string[] = [];
  try {
    for (const [i, change] of changes.entries()) {
      // A job that is not there needs no removal.
      if (change.remove && !jobPresent(previous[i] as SchedulerSnapshot))
        continue;
      const job = await updateJob(change.spec, change.remove);
      written.push(
        `Scheduler ${change.remove ? "removed" : "updated"}: ${job}`,
      );
    }
  } catch (error) {
    // Every job is put back on its own: one that will not restore does not stop the rest.
    const unrestored: string[] = [];
    for (const snapshot of previous.reverse())
      try {
        await restoreScheduler(snapshot);
      } catch (restoreError) {
        unrestored.push((restoreError as Error).message);
      }
    throw new GcError(
      unrestored.length === 0
        ? `${(error as Error).message}; the previous scheduler jobs are restored`
        : `${(error as Error).message}; some scheduler jobs could not be restored: ${unrestored.join("; ")}`,
    );
  }
  return written;
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
  const changes: JobChange[] = [
    {
      spec: dispatchJobSpec(
        intervalMinutes(options.intervalMs, machine),
        machine,
      ),
      remove: options.uninstall,
    },
    {
      spec: probeJobSpec(machine),
      remove: options.uninstall || machine?.changeProbe === false,
    },
  ];
  for (const change of changes)
    console.log(jobPreview(change.spec, change.remove));
  if (!options.confirm) {
    console.log("Preview only. Repeat with --yes to write the jobs.");
    return 0;
  }
  if (!installedScript(script))
    throw new GcError(
      "Scheduler installation requires the installed plugin copy, outside every worktree",
    );
  if (!options.uninstall) await checkLauncherResolves();
  return exclusiveGcLock("install", async () => {
    for (const line of await updateJobs(changes)) console.log(line);
    return 0;
  });
}
