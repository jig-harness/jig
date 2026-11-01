/**
 * The dispatcher as a component of the `jig` command: its own command
 * (`jig dispatch`), the timer that runs its tick with `--apply`, and the
 * lifecycle verbs' install, uninstall, status and receipts, built from
 * `install.ts` and `receipts.ts`.
 *
 * Its opt-in is the machine file (`~/.jig/dispatch.yaml`): the timer starts
 * drives on the accounts that file names, so `jig install` with no component
 * named leaves the dispatcher out while the file does not exist, and its
 * install refuses without one. Its timer serves every repository the file
 * lists, so only `jig uninstall --machine` removes it.
 */
import { existsSync } from "node:fs";
import type { Component, LastRun } from "../runtime/component.ts";
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
import { type MachineConfig, machineConfigPath } from "./lib/machine-config.ts";
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

/** The newest receipt that reads; null when there is none. */
function lastRun(): LastRun | null {
  for (const path of receiptPaths().reverse()) {
    const receipt = readReceipt(path);
    if (receipt !== null)
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
  install: (request) =>
    installDispatch(
      { intervalMs: null, confirm: request.confirm, uninstall: false },
      request.script,
      machineFile(),
    ),
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
  receipts: showReceipts,
};
