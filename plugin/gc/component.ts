/**
 * Resource collection as a component of the `jig` command: its own command
 * (`jig gc`), its daily job, and the lifecycle verbs' install, uninstall,
 * status and receipts, built from `install.ts` and `receipts.ts`. Its opt-in
 * is the install itself: the install registers a repository and confirms the
 * bounds collection keeps to, so `jig install` with no component named always
 * includes it.
 */
import { consumerRoot } from "../shared/consumer.ts";
import type { Component, LastRun } from "../runtime/component.ts";
import { scheduledStatus } from "../runtime/job-status.ts";
import { type GcArguments, gcCommand, gcMain, showReceipts } from "./cli.ts";
import { gcConfiguration } from "./config.ts";
import { install } from "./install.ts";
import { gcJobSpec } from "./job-spec.ts";
import { readReceipt, receiptPaths } from "./receipts.ts";

/** The daily job at the machine file's hour. */
function job() {
  try {
    return gcJobSpec(gcConfiguration(process.cwd(), null).machine.hour);
  } catch {
    // The job's names and arguments do not depend on the hour; a machine
    // file that does not read is for install to refuse, not status or run.
    return gcJobSpec();
  }
}

/** The newest receipt that reads; null when there is none. */
function lastRun(): LastRun | null {
  for (const path of receiptPaths().reverse())
    try {
      const receipt = readReceipt(path);
      return {
        runId: receipt.runId,
        startedAt: receipt.startedAt,
        completed: receipt.completed,
        exitStatus: receipt.exitStatus,
        path,
      };
    } catch {
      // A receipt that does not read is no evidence of a run; the one before it may be.
    }
  return null;
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
  receipts: showReceipts,
};
