/**
 * `jig doctor`: whether this machine can run what Jig installs, and whether
 * the repository it runs in fits its configuration. Each check has a stable
 * name and passes, fails, or is skipped where it does not apply; a failure
 * names the command that fixes it. It changes nothing.
 *
 * The machine's checks: Bun's version; `claude` and `codex` resolving
 * outside every git checkout (a job never records an agent tool inside one,
 * which a worktree cleanup or a branch could change or remove); the plugin
 * in each harness and what it follows; the `jig` command's launcher copy;
 * and the latest scheduled upgrade, which fails while that attempt failed
 * (`upgrade-record.ts`). Each component's: its own checks (`Component.doctor`: its machine
 * file, the programs its work needs), then its job's launcher copy against
 * the installed plugin's, the programs its job names, and its last run's
 * receipt. Last, the audit's configuration-fit check on the repository,
 * offline. A third component's checks come through the same interface.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { shellQuote } from "../shared/cli.ts";
import { swallow } from "../shared/errors.ts";
import { decodeJson, isRecord } from "../shared/guards.ts";
import { run } from "../shared/proc.ts";
import type {
  Component,
  ComponentStatus,
  DoctorCheck,
  LastRun,
} from "./component.ts";
import {
  available,
  describeSource,
  type Harness,
  HARNESSES,
  installed,
  PLUGIN_ID,
  registeredMarketplace,
} from "./harness.ts";
import {
  commandScriptCall,
  type InstalledJob,
  jobPresent,
  launcherCall,
  readInstalledJob,
} from "./installed-job.ts";
import { installedEntry, listPlugins, outsideCheckout } from "./launcher.ts";
import {
  commandLauncherDirectory,
  installedCommandText,
} from "./path-command.ts";
import { recordedPrograms } from "./refresh.ts";
import { upgradeCheck } from "./upgrade-record.ts";
import {
  detectScheduler,
  launcherDirectory,
  pluginPrograms,
  snapshotScheduler,
  staleLauncherFiles,
} from "./scheduler.ts";

/** The Bun Jig tests with: `mise.toml`'s, kept equal by `bun run pins`. */
const TESTED_BUN = "1.4.4";

const pass = (id: string, detail: string): DoctorCheck => ({
  id,
  status: "pass",
  detail,
});
const skip = (id: string, detail: string): DoctorCheck => ({
  id,
  status: "skip",
  detail,
});
const fail = (id: string, detail: string, fix?: string): DoctorCheck => ({
  id,
  status: "fail",
  detail,
  ...(fix === undefined ? {} : { fix }),
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** -1, 0 or 1 as dotted version `a` is older than, equal to or newer than `b`. */
function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function bunCheck(version = Bun.version): DoctorCheck {
  return compareVersions(version, TESTED_BUN) >= 0
    ? pass("bun", `Bun ${version}`)
    : fail(
        "bun",
        `Bun ${version} is older than ${TESTED_BUN}, the version Jig tests; a script may use an API it lacks`,
        "bun upgrade, or update Bun through the version manager that installed it",
      );
}

/** Whether `path` resolves outside every checkout; a path that does not resolve is not. */
function outside(path: string): boolean {
  try {
    return outsideCheckout(path);
  } catch (error) {
    swallow(error, `${path} does not resolve, so no job can run it`);
    return false;
  }
}

/** The first `name` on `PATH` that resolves outside every checkout. */
function firstOutsideCheckout(name: string): string | null {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry === "") continue;
    const found = Bun.which(name, { PATH: entry });
    if (found !== null && outside(found)) return found;
  }
  return null;
}

function pathCheck(name: Harness): DoctorCheck {
  const id = `path:${name}`;
  const found = Bun.which(name);
  if (found === null) return skip(id, "not on PATH");
  if (outside(found)) return pass(id, found);
  const other = firstOutsideCheckout(name);
  return fail(
    id,
    `${found} is inside a git checkout: an installed job never records it, and a worktree cleanup or a branch could change or remove it${other === null ? "" : `; ${other} is outside one`}`,
    other === null
      ? `install ${name} outside every git checkout, put its directory first on PATH, then run jig install --yes`
      : `PATH="${dirname(other)}${delimiter}$PATH" jig install --yes, and put ${dirname(other)} before ${dirname(found)} on your shell's PATH`,
  );
}

function pluginCheck(harness: Harness): DoctorCheck {
  const id = `plugin:${harness}`;
  try {
    if (!available(harness)) return skip(id, "not on PATH");
    const state = installed(harness);
    if (state === null)
      return fail(
        id,
        `${PLUGIN_ID} is not installed for this user`,
        `jig upgrade --${harness}`,
      );
    if (!state.enabled)
      return fail(
        id,
        `${PLUGIN_ID} ${state.version} is installed but disabled`,
        harness === "claude"
          ? `claude plugin enable ${PLUGIN_ID}`
          : `set enabled = true under [plugins."${PLUGIN_ID}"] in Codex's config.toml`,
      );
    const registered = registeredMarketplace(harness);
    return pass(
      id,
      `${PLUGIN_ID} ${state.version} enabled${registered === null ? "" : `, following ${describeSource(registered)}`}`,
    );
  } catch (error) {
    return fail(
      id,
      message(error),
      `run ${harness} plugin list to see why it fails, then jig upgrade --${harness}`,
    );
  }
}

/** The plugin's check in each harness; with neither harness on `PATH`, both fail. */
function pluginChecks(): DoctorCheck[] {
  const checks = HARNESSES.map(pluginCheck);
  if (checks.every((check) => check.status === "skip"))
    return checks.map((check) =>
      fail(
        check.id,
        "neither claude nor codex is on PATH: the plugin installs into one of them",
        "install Claude Code or Codex, then run jig upgrade",
      ),
    );
  return checks;
}

type Programs = { claude?: string; codex?: string };

/**
 * The installed plugin's `runtime/` directory as the agent tools `programs`
 * name it (what a launcher that records them runs), or why it was not found;
 * each set of tools is asked once.
 */
type Runtime = (
  programs: Programs,
  env?: Record<string, string>,
) => Promise<string | Error>;

/** The variables the agent tools read their plugin registries from. */
const REGISTRY_VARIABLES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/**
 * The environment an installed job asks its registry in: the caller's own
 * with the registry variables replaced by the job's, so an override the job
 * does not record is not inherited from the invoking shell.
 */
function registryEnvironment(
  registry: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REGISTRY_VARIABLES) delete env[name];
  return { ...env, ...registry };
}

function installedRuntime(fallback: Programs): Runtime {
  const asked = new Map<string, Promise<string | Error>>();
  return (programs, env) => {
    const tools = Object.keys(programs).length > 0 ? programs : fallback;
    // An installed job asks the registry its own environment names.
    const registry =
      env === undefined
        ? undefined
        : Object.fromEntries(
            REGISTRY_VARIABLES.flatMap((name) =>
              env[name] === undefined ? [] : [[name, env[name]]],
            ),
          );
    const key = JSON.stringify([tools, registry ?? null]);
    let lookup = asked.get(key);
    if (lookup === undefined) {
      lookup = installedEntry(
        tools,
        registry === undefined
          ? undefined
          : (program) =>
              listPlugins(
                program,
                undefined,
                undefined,
                registryEnvironment(registry),
              ),
        registry === undefined
          ? undefined
          : (registry.CODEX_HOME ?? join(homedir(), ".codex")),
      ).then(
        (entry) => join(dirname(entry), "runtime"),
        (error: Error) => error,
      );
      asked.set(key, lookup);
    }
    return lookup;
  };
}

/** Whether the launcher copy in `directory` is the installed plugin's. */
function launcherCheck(
  id: string,
  directory: string,
  runtime: string | Error,
): DoctorCheck {
  if (runtime instanceof Error)
    return fail(
      id,
      `cannot find the installed plugin copy to compare ${directory} with: ${runtime.message}`,
      "jig upgrade",
    );
  let stale: string[];
  try {
    stale = staleLauncherFiles(directory, runtime);
  } catch (error) {
    return fail(
      id,
      `cannot compare ${directory} with ${runtime}: ${message(error)}`,
      "jig upgrade",
    );
  }
  return stale.length === 0
    ? pass(id, `${directory} matches ${runtime}`)
    : fail(
        id,
        `${stale.join(" and ")} in ${directory} differ from the installed plugin's ${runtime}`,
        "jig upgrade",
      );
}

async function commandCheck(
  runtime: Runtime,
  script: string,
): Promise<DoctorCheck> {
  const text = installedCommandText();
  if (text === null)
    return skip("command:launcher", "the jig command is not installed");
  const installed = commandScriptCall(text);
  const call = installed === null ? null : launcherCall(installed.command);
  // The launcher is the thing that is broken, so the repair runs the plugin copy this doctor runs from.
  const fix = [
    shellQuote(process.execPath),
    "--no-env-file",
    shellQuote(`--config=${join(dirname(script), "gc", "bunfig.toml")}`),
    shellQuote(script),
    "install --yes",
  ].join(" ");
  if (call === null)
    return fail(
      "command:launcher",
      "cannot read the command the installed jig script runs",
      fix,
    );
  if (Object.keys(call.programs).length === 0)
    return fail(
      "command:launcher",
      "the installed jig script's command names no agent tool",
      fix,
    );
  const problems = [
    programProblem(call.bun, false),
    ...Object.values(call.programs).map((program) =>
      programProblem(program, true),
    ),
  ].filter((problem) => problem !== null);
  if (problems.length > 0)
    return fail("command:launcher", problems.join("; "), fix);
  return launcherCheck(
    "command:launcher",
    commandLauncherDirectory(),
    await runtime(call.programs),
  );
}

/** Whether `program` exists and runs; an agent tool also outside every checkout. */
function programProblem(program: string, agent: boolean): string | null {
  if (Bun.which(program) === null) return `${program} does not exist`;
  if (agent && !outside(program)) return `${program} is inside a git checkout`;
  return null;
}

/** The programs an installed job names: its Bun, and the agent tools it asks for the plugin. */
function programsCheck(name: string, job: InstalledJob): DoctorCheck {
  const id = `${name}:programs`;
  const fix = `jig install ${name} --yes`;
  const call = launcherCall(job.command);
  if (call === null)
    return fail(id, "cannot read the command the installed job runs", fix);
  const agents = Object.entries(call.programs);
  if (agents.length === 0)
    return fail(
      id,
      "the job names no agent tool, so its launcher cannot find the plugin",
      fix,
    );
  const problems = [
    programProblem(call.bun, false),
    ...agents.map(([, program]) => programProblem(program, true)),
  ].filter((problem) => problem !== null);
  return problems.length === 0
    ? pass(
        id,
        [
          `bun ${call.bun}`,
          ...agents.map(([tool, path]) => `${tool} ${path}`),
        ].join(", "),
      )
    : fail(id, problems.join("; "), fix);
}

/**
 * The component's installed job, read back from the scheduler (null when none
 * or unreadable), and whether any part of it is installed: a job that is
 * present but unreadable is a broken installation, not an absent one.
 */
async function installedJob(
  component: Component,
): Promise<{ job: InstalledJob | null; present: boolean }> {
  try {
    const snapshot = await snapshotScheduler(
      detectScheduler(),
      component.job(),
    );
    return { job: readInstalledJob(snapshot), present: jobPresent(snapshot) };
  } catch (error) {
    swallow(error, "the status check reports a scheduler that cannot be read");
    return { job: null, present: false };
  }
}

/** A component's own checks (`Component.doctor`); one that throws is a failure. */
async function ownChecks(
  component: Component,
  job: InstalledJob | null,
): Promise<DoctorCheck[]> {
  try {
    return (await component.doctor?.({ job })) ?? [];
  } catch (error) {
    return [
      fail(
        `${component.name}:doctor`,
        message(error),
        `jig status ${component.name} shows the component's state; fix what it names, then run jig doctor again`,
      ),
    ];
  }
}

/** The installed job's launcher copy and the programs it names; skipped with no job. */
async function jobChecks(
  component: Component,
  status: ComponentStatus,
  job: InstalledJob | null,
  present: boolean,
  runtime: Runtime,
): Promise<DoctorCheck[]> {
  const { name } = component;
  if (status.error !== undefined)
    return [
      fail(
        `${name}:launcher`,
        status.error,
        `fix what it names so the scheduler can be read, or jig install ${name} --yes`,
      ),
    ];
  if (!status.installed && present)
    return [
      fail(
        `${name}:launcher`,
        "the job is only partly installed: part of it is in the scheduler, but the scheduler does not report it installed",
        `jig install ${name} --yes`,
      ),
    ];
  if (!status.installed)
    return [skip(`${name}:launcher`, `no job installed (${status.detail})`)];
  const call = job === null ? null : launcherCall(job.command);
  return [
    launcherCheck(
      `${name}:launcher`,
      launcherDirectory(component.job()),
      await runtime(call?.programs ?? {}, job?.env),
    ),
    job === null
      ? fail(
          `${name}:programs`,
          "cannot read the installed job",
          `jig install ${name} --yes`,
        )
      : programsCheck(name, job),
  ];
}

/** The last run's receipt: passes when it completed with exit 0. */
function lastRunCheck(name: string, last: LastRun | null): DoctorCheck {
  const id = `${name}:last-run`;
  if (last === null) return skip(id, "no receipt yet");
  if (last.completed && last.exitStatus === 0)
    return pass(id, `${last.runId}, exit 0`);
  return fail(
    id,
    last.completed
      ? `${last.runId} exited ${last.exitStatus}`
      : `${last.runId} did not complete: it is still running, or it stopped before it finished`,
    `jig receipts ${name} ${last.runId}`,
  );
}

/** A component's own checks, then its launcher copy, its job's programs and its last run. */
async function componentChecks(
  component: Component,
  runtime: Runtime,
): Promise<DoctorCheck[]> {
  const { job, present } = await installedJob(component);
  const status = await component.status();
  return [
    ...(await ownChecks(component, job)),
    ...(await jobChecks(component, status, job, present, runtime)),
    lastRunCheck(component.name, status.lastRun),
  ];
}

/** The repository the working directory is in, as the skills find it; null outside one. */
function repositoryRoot(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.JIG_CONSUMER_ROOT?.trim();
  if (explicit) return resolve(explicit);
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

interface FitFinding {
  id: string;
  severity: string;
  message: string;
}

/** What `jig doctor` reads of `config-fit.ts --json`'s report. */
interface FitReport {
  file: string;
  configured: boolean;
  findings: FitFinding[];
}

function isFitReport(value: unknown): value is FitReport {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.configured === "boolean" &&
    Array.isArray(value.findings) &&
    value.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.id === "string" &&
        typeof finding.severity === "string" &&
        typeof finding.message === "string",
    )
  );
}

/** The audit's configuration-fit check on the repository, offline. */
async function configFitCheck(pluginRoot: string): Promise<DoctorCheck> {
  const id = "config-fit";
  const root = repositoryRoot();
  if (root === null) return skip(id, "not inside a repository");
  const script = join(
    pluginRoot,
    "skills",
    "audit",
    "scripts",
    "config-fit.ts",
  );
  const report = [
    shellQuote(process.execPath),
    "--no-env-file",
    shellQuote(`--config=${join(pluginRoot, "gc", "bunfig.toml")}`),
    shellQuote(script),
    "--offline",
  ].join(" ");
  const result = await run(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(pluginRoot, "gc", "bunfig.toml")}`,
      script,
      "--offline",
      "--json",
    ],
    { cwd: root, timeoutSec: 120 },
  );
  let fit: FitReport;
  try {
    // The check exits 1 when its report holds configuration errors; the report is then the answer.
    if (
      result.timedOut ||
      result.spawnFailed ||
      (result.code !== 0 && result.code !== 1)
    )
      throw new Error("the check did not complete");
    fit = decodeJson(
      result.stdout,
      isFitReport,
      "the configuration-fit report",
    );
  } catch (error) {
    return fail(
      id,
      `the configuration-fit check ${result.timedOut ? "did not finish within 120s" : `exited ${result.code}`}: ${(result.stderr || result.stdout).trim().slice(-500) || (error as Error).message}`,
      report,
    );
  }
  const count = (severity: string) =>
    fit.findings.filter((finding) => finding.severity === severity);
  const tally = (severity: string) => {
    const n = count(severity).length;
    return `${n} ${severity}${n === 1 ? "" : "s"}`;
  };
  const errors = count("error");
  if (errors.length > 0)
    return fail(
      id,
      `${fit.file}: ${errors.map((finding) => `config/${finding.id}: ${finding.message}`).join("; ")}`,
      `edit ${fit.file} as each finding says; the whole report: ${report}`,
    );
  if (!fit.configured)
    return pass(
      id,
      `${root} has no ${fit.file}: the skills run on their defaults, and /jig:audit drafts one`,
    );
  return pass(
    id,
    `${fit.file}: no errors, ${tally("warning")}, ${tally("suggestion")}; offline, so the forge and the tracker are unchecked (/jig:audit reads them)`,
  );
}

/**
 * Every check, in order: the machine's, then each component `names` selects
 * (all of them when none is named), then the repository's configuration fit.
 */
async function doctorChecks(options: {
  components: readonly Component[];
  names: readonly string[];
  script: string;
}): Promise<DoctorCheck[]> {
  const runtime = installedRuntime({
    ...(await recordedPrograms(options.components)),
    ...pluginPrograms(),
  });
  const checks = [
    bunCheck(),
    ...HARNESSES.map(pathCheck),
    ...pluginChecks(),
    await commandCheck(runtime, options.script),
    upgradeCheck(),
  ];
  for (const component of options.components)
    if (options.names.length === 0 || options.names.includes(component.name))
      checks.push(...(await componentChecks(component, runtime)));
  checks.push(await configFitCheck(dirname(options.script)));
  return checks;
}

/** One check for people: its status, name and detail, and a failure's fix. */
function formatCheck(check: DoctorCheck): string {
  const label = { pass: "pass", fail: "FAIL", skip: "skip" }[check.status];
  return `${label}  ${check.id}: ${check.detail}${check.fix === undefined ? "" : `\n      fix: ${check.fix}`}`;
}

/** Runs `jig doctor`; exits 1 when any check fails. */
export async function doctorVerb(
  args: { components: readonly string[]; json: boolean },
  context: { components: readonly Component[]; script: string },
): Promise<number> {
  const checks = await doctorChecks({ ...context, names: args.components });
  const failed = checks.filter((check) => check.status === "fail");
  if (args.json)
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  else {
    for (const check of checks) console.log(formatCheck(check));
    console.log(
      failed.length === 0
        ? "Every check passes."
        : `Failing: ${failed.map((check) => check.id).join(", ")}.`,
    );
  }
  return failed.length === 0 ? 0 : 1;
}
