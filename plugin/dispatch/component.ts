/**
 * The dispatcher as a component of the `jig` command: its own command
 * (`jig dispatch`), the timer that runs its tick with `--apply`, and the
 * lifecycle verbs' install, uninstall, status, doctor and receipts, built
 * from `install.ts` and `receipts.ts`. Its own checks for `jig doctor` are
 * that its machine file reads and that Orca, the session runtime it works
 * through, resolves where its timer runs.
 *
 * Its opt-in is the machine file (`~/.jig/dispatch.yaml`): the timer starts
 * drives on the accounts that file names, so `jig install` with no component
 * named leaves the dispatcher out while the file does not exist, and its
 * install refuses without one. Its timer serves every repository the file
 * lists, so only `jig uninstall --machine` removes it. With `--repo`, its
 * install also creates the dispatch labels that repository turns on and
 * lacks (`install-labels.ts`).
 */
import { existsSync } from "node:fs";
import type {
  Component,
  DoctorCheck,
  DoctorContext,
  LastRun,
} from "../runtime/component.ts";
import type { InstalledJob } from "../runtime/installed-job.ts";
import { orcaCommandOrInstalled } from "../shared/orca.ts";
import { scheduledStatus } from "../runtime/job-status.ts";
import {
  type DispatchArguments,
  dispatchCommand,
  dispatchMain,
  machineFile,
  showReceipts,
  strictDispatchCommand,
  winningIntervalArguments,
} from "./cli.ts";
import { dispatchJobSpec, installDispatch } from "./install.ts";
import { installLabels } from "./install-labels.ts";
import {
  type MachineConfig,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";

/**
 * The tick's job, by its names, arguments and deadline: what `jig run` runs
 * and `jig status` looks up. A machine file that does not read, or an
 * interval that is not whole minutes, is for an install to refuse; the
 * installed job's own schedule is what status reports.
 */
function job() {
  let machine: MachineConfig | null = null;
  try {
    machine = machineFile();
  } catch {
    // Left to install, which refuses the file with its message.
  }
  const minutes =
    machine === null ? 5 : Math.max(1, Math.ceil(machine.intervalMs / 60_000));
  return dispatchJobSpec(minutes, machine);
}

function missingOptIn(): string | null {
  const path = machineConfigPath();
  return existsSync(path)
    ? null
    : `no machine file ${path}. The dispatcher's timer starts drives on the accounts that file names; write it (CONFIGURATION.md, the machine's dispatch file), then run jig install dispatch`;
}

/** The newest receipt of a tick that ran; null when there is none. A tick that found the lock held ran nothing. */
function lastRun(): LastRun | null {
  for (const path of receiptPaths().reverse()) {
    const receipt = readReceipt(path);
    if (receipt !== null && receipt.lockHeldBy === undefined)
      return {
        runId: receipt.runId,
        startedAt: receipt.startedAt,
        completed: receipt.completed,
        exitStatus: receipt.exitStatus,
        path,
      };
  }
  return null;
}

/**
 * Whether Orca's command resolves in the environment the installed timer
 * runs with, or, with no timer, in this one: `ORCA_CLI_COMMAND`, else the
 * command in `ORCA_CLI_BIN_DIR`, else the name Orca installs it under on
 * `PATH` (`orca-ide` on Linux, `orca` elsewhere).
 */
function orcaCheck(job: InstalledJob | null): DoctorCheck {
  const id = "dispatch:orca";
  const env = job?.env ?? process.env;
  const command = orcaCommandOrInstalled(env);
  const found = Bun.which(command, { PATH: env.PATH ?? "" });
  const where = job === null ? "" : " in the installed timer's environment";
  return found !== null
    ? { id, status: "pass", detail: `${found}${where}` }
    : {
        id,
        status: "fail",
        detail: `${command} is not found${where}: the dispatcher reads and starts sessions through Orca`,
        fix: `install Orca, or set ORCA_CLI_COMMAND to its command${job === null ? "" : ", then run jig install dispatch --yes"}`,
      };
}

async function doctor({ job }: DoctorContext): Promise<DoctorCheck[]> {
  const id = "dispatch:machine-file";
  const path = machineConfigPath(job?.env ?? process.env);
  let file: DoctorCheck;
  try {
    file =
      readMachineConfig(path) === null
        ? {
            id,
            status: "skip",
            detail: `no ${path}: the dispatcher is not set up on this machine`,
          }
        : { id, status: "pass", detail: `${path} reads` };
    if (file.status === "skip" && job !== null)
      file = {
        id,
        status: "fail",
        detail: `no ${path}, but the dispatcher's timer is installed: every tick fails without it`,
        fix: `write ${path} (CONFIGURATION.md's section on the machine's dispatch file), or remove the timer with jig uninstall dispatch --machine`,
      };
  } catch (error) {
    file = {
      id,
      status: "fail",
      detail: (error as Error).message,
      fix: `edit ${path}: CONFIGURATION.md's section on the machine's dispatch file lists its settings`,
    };
  }
  if (file.status === "skip" && job === null)
    return [
      file,
      {
        id: "dispatch:orca",
        status: "skip",
        detail: "the dispatcher is not set up on this machine",
      },
    ];
  return [file, orcaCheck(job)];
}

export const dispatchComponent: Component<DispatchArguments> = {
  name: "dispatch",
  command: dispatchCommand,
  main: dispatchMain,
  // `dispatch install` holds its interval to whole minutes, which only the
  // interval that wins has to meet.
  strictCommand: strictDispatchCommand,
  strictArguments: (args, argv) =>
    args.action === "install" &&
    args.intervalMs !== undefined &&
    args.intervalMs % 60_000 !== 0
      ? winningIntervalArguments(argv)
      : null,
  job,
  missingOptIn,
  install: async (request) => {
    const timer = await installDispatch(
      { intervalMs: null, confirm: request.confirm, uninstall: false },
      request.script,
      machineFile(),
    );
    // A repository named with --repo also gets the dispatch labels it lacks.
    if (request.repository === undefined) return timer;
    const labels = await installLabels([request.repository], request.confirm);
    return Math.max(timer, labels);
  },
  uninstall: async (request) => {
    if (request.machine)
      // A removal needs no machine file: a broken one must not keep the timer installed.
      return installDispatch(
        { intervalMs: null, confirm: request.confirm, uninstall: true },
        request.script,
        null,
      );
    console.log(
      `The dispatcher's timer serves every repository ${machineConfigPath()} lists, so it stays: take the repository out of that file, or remove the timer with jig uninstall dispatch --machine.`,
    );
    return 0;
  },
  status: () =>
    scheduledStatus(
      "dispatch",
      job(),
      lastRun(),
      missingOptIn() === null
        ? undefined
        : `no machine file ${machineConfigPath()}`,
    ),
  doctor,
  receipts: showReceipts,
};
