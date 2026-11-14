/**
 * `jig upgrade`: the plugin first, then what runs it. It installs or updates
 * the plugin in each agent harness on this machine, on the channel each
 * follows (`harness.ts`), then has the installed plugin copy, the one the
 * harnesses now name, refresh the installed jobs and the `jig` command
 * (`refresh.ts`), so a launcher change in the new release reaches them.
 *
 * The copy that runs `jig upgrade` is the release it updates from, so it
 * refreshes nothing itself unless it is the installed copy: it runs that
 * copy's `jig upgrade --jobs-only --json` and reads its report. The result is
 * one structure (`UpgradeResult`): what each harness and each installed job
 * became. A scheduled upgrade (`scheduled-upgrade.ts`) refreshes the same
 * way, telling the installed copy so in `JIG_UPGRADE_SCHEDULED=1`: a loaded
 * launchd job is then not rewritten, since that would stop the job running
 * the upgrade.
 */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { ExitError, failureExit } from "../shared/cli.ts";
import { USAGE_EXIT } from "../shared/command-line.ts";
import { swallow } from "../shared/errors.ts";
import { decodeJson, isRecord } from "../shared/guards.ts";
import { failed as failure, ok, type Outcome } from "../shared/outcome.ts";
import { run } from "../shared/proc.ts";
import { refreshCodexHook } from "./codex-hook.ts";
import type { Component } from "./component.ts";
import {
  type Channel,
  commandTimeoutMs,
  type Harness,
  type HarnessRequest,
  type HarnessResult,
  harnessesExit,
  harnessRequest,
  type Say,
  upgradeHarnesses,
} from "./harness.ts";
import { exclusiveInstallLock } from "../shared/gc-lock.ts";
import { installedEntry } from "./launcher.ts";
import {
  type Announce,
  formatRefresh,
  type RefreshResult,
  recordedPrograms,
  refreshInstalled,
} from "./refresh.ts";
import { installedScript, pluginPrograms } from "./scheduler.ts";
import { liveForeignClaim, writeStampWhen } from "./upgrade-stamp.ts";
import { currentIso } from "../shared/time.ts";

/** What `jig upgrade` did: each harness, then each installed job and the `jig` command. */
interface UpgradeResult {
  harnesses: HarnessResult[];
  jobs: RefreshResult[];
}

interface UpgradeOptions {
  /** What to install or update; null refreshes the installed jobs only. */
  request: HarnessRequest | null;
  components: readonly Component[];
  /** The running `jig.ts`. */
  script: string;
  /** Where the commands it runs and its progress are printed. */
  say: Say;
  /** A timer's job runs this upgrade: a refresh leaves loaded launchd jobs as they are. */
  scheduled?: boolean;
}

/** The variable that tells the installed copy's refresh a timer's job runs it. */
const SCHEDULED_REFRESH = "JIG_UPGRADE_SCHEDULED";

function announcer(say: Say): Announce {
  return (command) => say(`$ ${command.join(" ")}`);
}

function failed(detail: string): RefreshResult[] {
  return [{ target: "installed jobs", outcome: "failed", detail }];
}

/** The report `jig upgrade --jobs-only --json` printed; null when it is not one. */
function jobsReport(stdout: string): RefreshResult[] | null {
  try {
    return decodeJson(stdout, isJobsReport, "the installed copy's report").jobs;
  } catch (error) {
    swallow(error, "the caller reports the installed copy's exit instead");
    return null;
  }
}

/** The harness outcomes that leave the plugin at this upgrade's release. */
const CURRENT: readonly string[] = [
  "installed",
  "updated",
  "unchanged",
  "present",
];

const OUTCOMES: readonly string[] = [
  "refreshed",
  "unchanged",
  "skipped",
  "failed",
];

function isJobsReport(value: unknown): value is { jobs: RefreshResult[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(
      (job) =>
        isRecord(job) &&
        typeof job.target === "string" &&
        typeof job.detail === "string" &&
        typeof job.outcome === "string" &&
        OUTCOMES.includes(job.outcome),
    )
  );
}

/**
 * The agent tools to ask for the installed copy: the copy a harness that did
 * not update names is not the release this upgrade brought, so look only
 * where an upgrade succeeded, when one did.
 */
async function updatedPrograms(
  options: UpgradeOptions,
  harnesses: readonly HarnessResult[],
): Promise<{ claude?: string; codex?: string }> {
  const programs: { claude?: string; codex?: string } = {
    ...(await recordedPrograms(options.components)),
    ...pluginPrograms(),
    ...options.request?.programs,
  };
  const current = harnesses.filter((result) =>
    CURRENT.includes(result.outcome),
  );
  if (current.length > 0)
    for (const tool of ["claude", "codex"] as const)
      if (!current.some((result) => result.harness === tool))
        delete programs[tool];
  return programs;
}

/**
 * `refresh` and then the turn-budget hook's entry in the Codex home
 * (`codex-hook.ts`), which this copy of the plugin writes beside the jobs.
 */
async function withCodexHook(
  refresh: Promise<RefreshResult[]>,
): Promise<RefreshResult[]> {
  const jobs = await refresh;
  try {
    return [
      ...jobs,
      await exclusiveInstallLock(async () => refreshCodexHook()),
    ];
  } catch (error) {
    return [
      ...jobs,
      {
        target: "codex turn-budget hook",
        outcome: "failed",
        detail: (error as Error).message,
      },
    ];
  }
}

/**
 * The refresh, by the plugin copy a harness names now: in this process when
 * that is this copy, otherwise by running it.
 */
export async function refreshFromInstalled(
  options: UpgradeOptions,
  harnesses: readonly HarnessResult[],
): Promise<RefreshResult[]> {
  let entry: string;
  try {
    entry = await installedEntry(await updatedPrograms(options, harnesses));
  } catch (error) {
    return failed((error as Error).message);
  }
  const scheduled = options.scheduled === true;
  return entry === realpathSync(options.script)
    ? withCodexHook(
        refreshInstalled(options.components, announcer(options.say), {
          scheduled,
        }),
      )
    : refreshByRunning(entry, options.say, scheduled);
}

/** The installed copy's `jig upgrade --jobs-only --json`, run, and its report. */
async function refreshByRunning(
  entry: string,
  say: Say,
  scheduled: boolean,
): Promise<RefreshResult[]> {
  const command = [
    process.execPath,
    "--no-env-file",
    `--config=${join(dirname(entry), "gc", "bunfig.toml")}`,
    entry,
    "upgrade",
    "--jobs-only",
    "--json",
  ];
  say(`$ ${command.join(" ")}`);
  const timeoutSec = commandTimeoutMs() / 1000;
  const child = await run(command, {
    timeoutSec,
    stderr: "inherit",
    ...(scheduled ? { env: { ...process.env, [SCHEDULED_REFRESH]: "1" } } : {}),
  });
  const report = jobsReport(child.stdout);
  const ended = child.timedOut
    ? `did not finish within ${timeoutSec}s`
    : `exited ${child.code}`;
  if (report === null)
    return failed(`${entry} ${ended} without a report of the installed jobs`);
  // A report is not a completed run: a child that printed it and then failed
  // or hung is a failure the report does not show.
  return child.timedOut || child.code !== 0
    ? [...report, ...failed(`${entry} ${ended} after printing its report`)]
    : report;
}

/**
 * Brings the plugin up to date in each harness, then the installed jobs and
 * the `jig` command, and says what became of each; it prints only progress.
 */
async function upgrade(options: UpgradeOptions): Promise<UpgradeResult> {
  if (options.request === null)
    return {
      harnesses: [],
      jobs: await withCodexHook(
        refreshInstalled(options.components, announcer(options.say), {
          scheduled: options.scheduled === true,
        }),
      ),
    };
  const harnesses = upgradeHarnesses(options.request, options.say);
  return { harnesses, jobs: await refreshFromInstalled(options, harnesses) };
}

/** 0 when every harness on `PATH` has the plugin and no refresh failed; 1 otherwise. */
function upgradeExit(result: UpgradeResult, jobsOnly = false): number {
  const harnesses = jobsOnly ? 0 : harnessesExit(result.harnesses);
  const jobs = result.jobs.some((job) => job.outcome === "failed") ? 1 : 0;
  return Math.max(harnesses, jobs);
}

/** `jig upgrade`'s options, as `verbs.ts` parses them. */
export interface UpgradeArguments {
  harness?: Harness | undefined;
  channel?: Channel | undefined;
  source?: string | undefined;
  jobsOnly: boolean;
  json: boolean;
}

/**
 * The refresh alone: a usage error (exit 2) with any option that chooses
 * what to install; refused from a checkout.
 */
function checkJobsOnly(
  args: UpgradeArguments,
  script: string,
): Outcome<void, "refused"> {
  const { harness, channel, source } = args;
  if (harness !== undefined || channel !== undefined || source !== undefined)
    throw new ExitError(
      USAGE_EXIT,
      "--jobs-only refreshes the installed jobs alone: it takes no --claude, --codex, --channel or --source",
    );
  if (!installedScript(script))
    return failure(
      "refused",
      "jig upgrade --jobs-only requires the installed plugin copy, outside every worktree",
    );
  return ok(undefined);
}

/** What to install or update, or a usage error (exit 2) for options that contradict each other. */
function requestOf(args: UpgradeArguments): HarnessRequest {
  const request = harnessRequest({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.channel === undefined ? {} : { channel: args.channel }),
    only: args.harness ?? null,
  });
  if (!request.ok) throw new ExitError(USAGE_EXIT, request.failure.reason);
  return request.value;
}

/** For people: each harness that moved, then each job. */
function report(result: UpgradeResult, say: Say): void {
  for (const harness of result.harnesses)
    if (harness.outcome === "updated")
      say(`${harness.harness}: updated ${harness.before} → ${harness.version}`);
  for (const job of result.jobs) say(formatRefresh(job));
}

/**
 * A `jig upgrade` that brought every harness up to date counts as the
 * interval's upgrade: its stamp clears a failed scheduled one, as `jig
 * doctor`'s fix says, and the timers wait `upgrade.every` from it.
 */
async function stampManual(result: UpgradeResult): Promise<void> {
  const current = result.harnesses.filter(
    (h) => h.outcome === "updated" || h.outcome === "unchanged",
  );
  if (current.length === 0) return;
  const moved = current.find((h) => h.outcome === "updated");
  try {
    // Not over a scheduled upgrade still running: its claim and its result stand.
    await writeStampWhen(
      {
        outcome: moved === undefined ? "unchanged" : "updated",
        detail: `jig upgrade, run by a person: ${current
          .map((h) =>
            h.outcome === "updated"
              ? `${h.harness} ${h.before} -> ${h.version}`
              : `${h.harness} at ${h.version}`,
          )
          .join("; ")}`,
        at: currentIso(),
        ...(moved?.before !== undefined && moved.version !== undefined
          ? { from: moved.before, to: moved.version }
          : {}),
      },
      (standing) => !liveForeignClaim(standing),
    );
  } catch (error) {
    console.error(
      `jig upgrade: the upgrade stamp could not be written: ${(error as Error).message}`,
    );
  }
}

/** Runs `jig upgrade` and prints what became of each harness and job. */
export async function upgradeVerb(
  args: UpgradeArguments,
  context: { components: readonly Component[]; script: string },
): Promise<number> {
  const say: Say = args.json ? console.error : console.log;
  if (args.jobsOnly) {
    const checked = checkJobsOnly(args, context.script);
    if (!checked.ok) return failureExit(checked.failure);
  }
  const request = args.jobsOnly ? null : requestOf(args);
  const result = await upgrade({
    request,
    ...context,
    say,
    scheduled: args.jobsOnly && process.env[SCHEDULED_REFRESH] === "1",
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else report(result, say);
  const code = upgradeExit(result, args.jobsOnly);
  if (code === 0 && !args.jobsOnly) await stampManual(result);
  return code;
}
