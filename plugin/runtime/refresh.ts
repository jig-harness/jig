/**
 * What `jig upgrade` refreshes once the plugin is up to date: each installed
 * job's launcher copy and its entry in the scheduler (the systemd units, the
 * launchd job, the crontab line), and the `jig` command's launcher copy and
 * script, all written by this copy of the plugin, so a launcher change in a
 * new release reaches the jobs and the command.
 *
 * A job is rewritten from what it holds now (`installed-job.ts`): the
 * environment, the Bun and agent tools, the schedule and the arguments its
 * install recorded stay, and only the form this release writes changes.
 * Nothing is written where nothing differs, and a job that is enabled or
 * running stays so. The installed jobs are the components' jobs
 * (`Component.job()`) the scheduler holds, so a third component's job is
 * refreshed with no change here.
 */
import { swallow } from "../shared/errors.ts";
import { exclusiveGcLock } from "../shared/gc-lock.ts";
import type { Component } from "./component.ts";
import {
  type InstalledJob,
  type LauncherCall,
  launcherCall,
  readInstalledJob,
} from "./installed-job.ts";
import type { JobSpec } from "./job-spec.ts";
import { commandPrograms, refreshCommand } from "./path-command.ts";
import {
  detectScheduler,
  installLauncher,
  jobChanged,
  jobFiles,
  launcherCommand,
  launcherDirectory,
  rewriteJob,
  type Scheduler,
  snapshotScheduler,
  staleLauncherFiles,
} from "./scheduler.ts";

/** What became of one installed job, or of the `jig` command. */
export interface RefreshResult {
  /** The job's name (`jig-gc`), or `jig command`. */
  target: string;
  outcome: "refreshed" | "unchanged" | "skipped" | "failed";
  detail: string;
}

/** Sees each scheduler command before it runs. */
export type Announce = (command: string[]) => void;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The job's files as this release writes them, from what the installed job
 * holds: its environment, Bun, agent tools, arguments, schedule and
 * descriptions; only the launcher's directory comes from `spec`.
 */
function rewritten(
  scheduler: Scheduler,
  spec: JobSpec,
  installed: InstalledJob,
  call: LauncherCall,
): Record<string, string> {
  const { schedule, description, timerDescription } = installed;
  return jobFiles(scheduler, {
    command: [
      ...launcherCommand(launcherDirectory(spec), call.programs, call.bun),
      ...call.args,
    ],
    env: installed.env,
    spec: {
      ...spec,
      ...(schedule === null ? {} : { schedule }),
      ...(description === undefined ? {} : { description }),
      ...(timerDescription === undefined ? {} : { timerDescription }),
    },
  });
}

/** What a refresh wrote, in words. */
function refreshed(parts: (string | false)[]): string {
  return parts.filter((part) => part !== false).join("; ");
}

/**
 * Refreshes one component's job, under the lock installs take, so a
 * concurrent `jig install` never interleaves with it.
 */
function refreshJob(
  component: Component,
  scheduler: Scheduler,
  announce?: Announce,
): Promise<RefreshResult> {
  const spec = component.job();
  const result = (
    outcome: RefreshResult["outcome"],
    detail: string,
  ): RefreshResult => ({ target: spec.name, outcome, detail });
  return exclusiveGcLock("install", async () => {
    const snapshot = await snapshotScheduler(scheduler, spec);
    const installed = readInstalledJob(snapshot);
    if (installed === null) return result("skipped", "not installed");
    const call = launcherCall(installed.command);
    if (call === null)
      return result(
        "failed",
        `cannot read the command the installed job runs; jig install ${component.name} --yes writes it again`,
      );
    const directory = launcherDirectory(spec);
    const files = rewritten(scheduler, spec, installed, call);
    const stale = staleLauncherFiles(directory).length > 0;
    const changed = jobChanged(snapshot, files);
    if (!stale && !changed)
      return result("unchanged", "its launcher copy and job are current");
    // The launcher first: a rewritten job may start at once and run it.
    if (stale) installLauncher(directory);
    if (changed) await rewriteJob(snapshot, files, announce);
    return result(
      "refreshed",
      refreshed([
        stale && `copied the launcher to ${directory}`,
        changed && `rewrote the ${scheduler} job`,
      ]),
    );
  });
}

/**
 * The agent tools the installed jobs and the `jig` command ask for the
 * plugin copy, where they name one: how to find the copy their launchers
 * run when the tools first on `PATH` are inside a checkout and never
 * recorded.
 */
export async function recordedPrograms(
  components: readonly Component[],
): Promise<{ claude?: string; codex?: string }> {
  // The command's first, then each job's for a tool none before it named.
  const programs: { claude?: string; codex?: string } = commandPrograms();
  for (const component of components)
    try {
      const job = readInstalledJob(
        await snapshotScheduler(detectScheduler(), component.job()),
      );
      const recorded =
        (job === null ? null : launcherCall(job.command))?.programs ?? {};
      for (const tool of ["claude", "codex"] as const) {
        const program = recorded[tool];
        if (programs[tool] === undefined && program !== undefined)
          programs[tool] = program;
      }
    } catch (error) {
      swallow(error, "a job that cannot be read names no agent tool");
    }
  return programs;
}

/** Refreshes every component's installed job, then the `jig` command. */
export async function refreshInstalled(
  components: readonly Component[],
  announce?: Announce,
): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  let scheduler: Scheduler | null = null;
  try {
    scheduler = detectScheduler();
  } catch {
    // Windows: no component has a job; the command is still refreshed.
  }
  for (const component of components) {
    const target = component.job().name;
    if (scheduler === null) {
      results.push({
        target,
        outcome: "skipped",
        detail: "scheduled jobs need macOS or Linux",
      });
      continue;
    }
    try {
      results.push(await refreshJob(component, scheduler, announce));
    } catch (error) {
      results.push({ target, outcome: "failed", detail: message(error) });
    }
  }
  try {
    results.push({ target: "jig command", ...refreshCommand() });
  } catch (error) {
    results.push({
      target: "jig command",
      outcome: "failed",
      detail: message(error),
    });
  }
  return results;
}

/** `jig upgrade`'s line for one refreshed target. */
export function formatRefresh(result: RefreshResult): string {
  return `${result.target}: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`;
}
