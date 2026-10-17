#!/usr/bin/env bun
// Every scheduled workflow is declared in the cadence registry.
//
// The classifier (classify-heartbeat.ts) can only call a job stale if the
// registry says how often it should run, so a scheduled workflow the registry
// does not name is a job nobody watches: the same dark instrument the
// no-dark-instruments gate refuses, one level up. This check lists the
// workflows that carry a `schedule:` trigger and fails for each whose id is not
// a job in the registry.
//
// A workflow's id is its file name without the extension (`nightly.yml` is
// `nightly`), the name the run-history collector in mappings.md gives the job.
// Two scheduled files whose names differ only in extension (`nightly.yml`,
// `nightly.yaml`) would share one id, so one registry entry would cover both
// and fresh runs of one would hide the other stopping; that is an input error.
// The registry is read by the classifier's own parser, so a registry it would
// refuse is refused here too.
//
// This is the GitHub Actions form. A provider that keeps its schedules outside
// the repository (GitLab's pipeline schedules, a cron host) has no file to
// list; its mapping says to compare the provider's schedule list with the
// registry in the collector.
//
// Exit codes: 0 every scheduled workflow is declared (or none is scheduled),
// 1 a scheduled workflow is not declared, 2 usage or input error, including a
// workflow file that cannot be read or parsed and two scheduled workflows with
// one id.
//
// Usage:
//   check-schedules-declared.ts --registry <file> [--workflows <dir>]
// `--workflows` defaults to .github/workflows.
import { basename, extname } from "node:path";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { readYaml, workflowFiles } from "../../../../lib/workflows.ts";
import { HeartbeatInputError, parseRegistry } from "./classify-heartbeat.ts";

const usage =
  "usage: check-schedules-declared.ts --registry <file> [--workflows <dir>]";

/** Whether a parsed workflow's `on:` has a `schedule` trigger, written as one event, a list or a map. */
export function isScheduled(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return false;
  const on = (doc as Record<string, unknown>).on;
  if (typeof on === "string") return on === "schedule";
  if (Array.isArray(on)) return on.includes("schedule");
  return typeof on === "object" && on !== null && "schedule" in on;
}

/** The ids of the scheduled workflows under `dir`; throw when it cannot be read or two share an id. */
export function scheduledWorkflows(dir: string): string[] {
  const listing = workflowFiles(dir);
  if ("error" in listing) throw new HeartbeatInputError(listing.error);
  if ("missing" in listing)
    throw new HeartbeatInputError(`no workflow folder at ${dir}`);
  const files = new Map<string, string>();
  for (const path of listing.files) {
    const file = readYaml(path);
    if ("error" in file) throw new HeartbeatInputError(file.error);
    if (!isScheduled(file.doc)) continue;
    const id = basename(path, extname(path));
    const other = files.get(id);
    if (other !== undefined)
      throw new HeartbeatInputError(
        `${other} and ${path} are both scheduled workflow "${id}"; rename one so each job has its own id`,
      );
    files.set(id, path);
  }
  return [...files.keys()];
}

/** Check a repository's scheduled workflows against its registry; the exit code. */
export function checkSchedulesDeclared(
  registryPath: string,
  workflowsDir: string,
): number {
  const file = readYaml(registryPath);
  if ("error" in file) throw new HeartbeatInputError(file.error);
  const declared = new Set(
    parseRegistry(file.doc, registryPath).map((j) => j.id),
  );
  const scheduled = scheduledWorkflows(workflowsDir);
  let missing = 0;
  for (const id of scheduled) {
    if (declared.has(id))
      console.log(`OK   ${id} — declared in ${registryPath}`);
    else {
      console.log(
        `UNDECLARED ${id} — a scheduled workflow with no cadence in ${registryPath}, so nothing notices when it stops`,
      );
      missing++;
    }
  }
  if (scheduled.length === 0)
    console.log(`no scheduled workflow in ${workflowsDir}`);
  return missing === 0 ? 0 : 1;
}

export function main(args = process.argv.slice(2)): number {
  const { values } = strictOptions(
    {
      args,
      options: { registry: { type: "string" }, workflows: { type: "string" } },
      allowPositionals: false,
    },
    usage,
  );
  if (values.registry === undefined)
    throw new HeartbeatInputError(`--registry is required\n${usage}`);
  return checkSchedulesDeclared(
    values.registry,
    values.workflows ?? ".github/workflows",
  );
}

if (import.meta.main) cli(() => main());
