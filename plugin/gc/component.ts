/**
 * Resource collection as a component of the `jig` command: its own command
 * (`jig gc`), its daily job, and the lifecycle verbs' install, uninstall,
 * status, doctor and receipts, built from `install.ts` and `receipts.ts`.
 * Its own check for `jig doctor` is that its part of the machine file reads.
 * Its opt-in is the install itself: the install registers a repository and
 * confirms the bounds collection keeps to, so `jig install` with no component
 * named always includes it.
 */
import { existsSync } from "node:fs";
import { userConfigPath } from "../shared/config-layers.ts";
import { consumerRoot } from "../shared/consumer.ts";
import type { Component, DoctorCheck, LastRun } from "../runtime/component.ts";
import { scheduledStatus } from "../runtime/job-status.ts";
import { type GcArguments, gcCommand, gcMain, showReceipts } from "./cli.ts";
import { gcConfiguration } from "./config.ts";
import { install } from "./install.ts";
import { gcJobSpec } from "./job-spec.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";

/** The daily job at the machine file's hour. */
function job() {
  const configuration = gcConfiguration(process.cwd(), null);
  // The job's names and arguments do not depend on the hour; a machine
  // file that does not read is for install to refuse, not status or run.
  return configuration.ok
    ? gcJobSpec(configuration.value.machine.hour)
    : gcJobSpec();
}

/** The newest receipt that reads; null when there is none. */
function lastRun(): LastRun | null {
  for (const path of receiptPaths().reverse()) {
    const read = readReceipt(path);
    // A receipt that does not read is no evidence of a run; the one before it may be.
    if (!read.ok) continue;
    const receipt = read.value;
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

/** Whether the machine file's collection settings read, as install and the job read them. */
function machineFileCheck(): DoctorCheck {
  const id = "gc:machine-file";
  const path = userConfigPath();
  if (!existsSync(path)) return { id, status: "skip", detail: `no ${path}` };
  const configuration = gcConfiguration(process.cwd(), null);
  if (configuration.ok) return { id, status: "pass", detail: `${path} reads` };
  return {
    id,
    status: "fail",
    detail: configuration.failure.reason,
    fix: `edit ${path}: CONFIGURATION.md's gc section lists its settings`,
  };
}

export const gcComponent: Component<GcArguments> = {
  name: "gc",
  command: gcCommand,
  main: gcMain,
  job,
  missingOptIn: () => null,
  install: (request) =>
    install({
      repository: request.repository ?? consumerRoot(),
      script: request.script,
      confirm: request.confirm,
      uninstall: false,
      machine: false,
    }),
  uninstall: (request) =>
    install({
      repository: request.repository ?? consumerRoot(),
      script: request.script,
      confirm: request.confirm,
      uninstall: true,
      machine: request.machine,
    }),
  status: () => scheduledStatus("gc", job(), lastRun()),
  doctor: async () => [machineFileCheck()],
  receipts: showReceipts,
};
