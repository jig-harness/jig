/**
 * Waking one repository's tick (`shared/wake.ts`): a command that wrote a
 * record the tick reads asks for `jig dispatch --apply --repo <path>` soon,
 * rather than at the next timer sweep. The repository is named by its path
 * in the machine file, so the tick it starts is the one the timer would run
 * for it, and the machine file alone decides what that tick starts.
 *
 * The wake lives under the dispatcher's state directory, one folder per
 * repository path (`wake/<digest>/`). `wakeTick` records the request and,
 * when no waiter holds the wake, starts one: this file, run detached in a
 * session of its own, so it outlives the command that asked. The waiter runs
 * the tick the way the installed timer does: the job's own launcher command
 * and environment, read back from the scheduler, with `dispatch --apply
 * --repo <path>` as its arguments. With no timer installed it runs this copy
 * of the plugin's `jig.ts`. The launcher is told it runs a woken tick
 * (`JIG_LAUNCHER_ROLE=wake`), so the plugin is not upgraded first: that is
 * the timer's, and a woken tick is to run soon. A tick that ends with exit 3
 * found its repository or the act lock held and is tried again after the
 * minute. The waiter's notes, and each
 * run's command, exit code and output, go to `last-run.log` beside the wake.
 *
 * `JIG_WAKE_COMMAND`, a JSON array, names the command a test runs in place
 * of the tick's launcher; the tick's arguments follow it.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import {
  requestWake,
  type WaitEnd,
  waitAndRun,
  wakeDir,
} from "../../shared/wake.ts";
import { stateRoot } from "../receipts.ts";
import {
  MIN_TICK_DEADLINE_MS,
  readMachineConfig,
  tickDeadlineMs,
} from "./machine-config.ts";

/** The exit of a tick that found another holding its repository or the act lock (`dispatch/cli.ts`). */
const LOCK_HELD_EXIT = 3;

const PLUGIN = resolve(import.meta.dir, "..", "..");
const BUNFIG = join(PLUGIN, "gc", "bunfig.toml");
const JIG = join(PLUGIN, "jig.ts");

/** The variables a session holds that the timer's tick does not: the line's, the drive's, the agent tools' and Orca's. */
const SESSION_VARIABLE = /^(?:JIG_|DRIVE_PR_|CLAUDE|CODEX_|ORCA_)/;
/** The variables a session holds that no tick reads as its own. */
const LINE_VARIABLE = /^(?:JIG_LAUNCH$|DRIVE_PR_)/;

function environment(drop: RegExp): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !drop.test(entry[0]),
    ),
  );
}

/** The tick the waiter runs: its command, environment and deadline. */
interface TickCall {
  argv: string[];
  env: Record<string, string>;
  timeoutSec: number;
}

const tickArgs = (path: string) => ["dispatch", "--apply", "--repo", path];
const DEFAULT_DEADLINE_SEC = MIN_TICK_DEADLINE_MS / 1000;
/** The time past the launcher's own deadline the waiter gives it to stop the tick. */
const GRACE_SEC = 60;

/** The command a test names in place of the launcher: `null` for none, or why it does not read. */
function testCommand(): Outcome<string[] | null, "unstarted"> {
  const text = process.env.JIG_WAKE_COMMAND;
  if (!text) return ok(null);
  const parsed = attempt("unstarted", "JIG_WAKE_COMMAND does not read", () =>
    JSON.parse(text),
  );
  if (!parsed.ok) return parsed;
  const words: unknown = parsed.value;
  return Array.isArray(words) &&
    words.length > 0 &&
    words.every((word) => typeof word === "string")
    ? ok(words as string[])
    : failed("unstarted", "JIG_WAKE_COMMAND must be a JSON array of strings");
}

/**
 * The installed timer's launcher command (up to `--`) and environment;
 * `null` only when no timer is installed, and `malformed` when the installed
 * job is incomplete; or why the scheduler cannot be read.
 */
async function installedTimer(): Promise<
  Outcome<
    { prefix: string[]; env: Record<string, string> } | null,
    "malformed" | "unsupported" | "unreadable"
  >
> {
  const { dispatchJobSpec } = await import("../install.ts");
  const { detectScheduler, snapshotScheduler, launcherDirectory } =
    await import("../../runtime/scheduler.ts");
  const { jobPresent, readInstalledJob } = await import(
    "../../runtime/installed-job.ts"
  );
  const scheduler = detectScheduler();
  if (!scheduler.ok) return scheduler;
  const read = await snapshotScheduler(scheduler.value, dispatchJobSpec(5));
  if (!read.ok) return read;
  const snapshot = read.value;
  if (!jobPresent(snapshot)) return ok(null);
  const job = readInstalledJob(snapshot);
  const separator = job?.command.indexOf("--") ?? -1;
  if (
    job === null ||
    separator < 1 ||
    ["launcher.ts", "bunfig.toml"].some(
      (name) =>
        typeof snapshot.launcher[
          join(launcherDirectory(snapshot.spec), name)
        ] !== "string",
    )
  )
    return failed(
      "malformed",
      "the installed timer is incomplete or malformed",
    );
  return ok({ prefix: job.command.slice(0, separator + 1), env: job.env });
}

/** How the waiter runs the tick for the repository at `path`. */
export async function tickCall(
  path: string,
): Promise<Outcome<TickCall, "unstarted">> {
  const test = testCommand();
  if (!test.ok) return test;
  if (test.value !== null)
    return ok({
      argv: [...test.value, ...tickArgs(path)],
      env: environment(LINE_VARIABLE),
      timeoutSec: DEFAULT_DEADLINE_SEC,
    });
  let installed: Awaited<ReturnType<typeof installedTimer>>;
  try {
    installed = await installedTimer();
  } catch (error) {
    return failed(
      "unstarted",
      `the installed timer does not read: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (!installed.ok)
    return failed(
      "unstarted",
      `the installed timer does not read: ${installed.failure.reason}`,
      installed.failure.cause,
    );
  const timer = installed.value;
  if (timer === null) {
    const machine = readMachineConfig();
    if (!machine.ok)
      return failed(
        "unstarted",
        `the machine configuration does not read: ${machine.failure.reason}`,
        machine.failure.cause,
      );
    return ok({
      argv: [
        process.execPath,
        "--no-env-file",
        `--config=${BUNFIG}`,
        JIG,
        ...tickArgs(path),
      ],
      env: environment(LINE_VARIABLE),
      timeoutSec:
        (machine.value === null
          ? DEFAULT_DEADLINE_SEC
          : tickDeadlineMs(machine.value) / 1000) + GRACE_SEC,
    });
  }
  const deadline = Number(timer.env.JIG_LAUNCHER_DEADLINE_SEC);
  return ok({
    argv: [...timer.prefix, ...tickArgs(path)],
    env: {
      ...environment(SESSION_VARIABLE),
      ...timer.env,
      JIG_LAUNCHER_ROLE: "wake",
    },
    timeoutSec:
      (Number.isSafeInteger(deadline) && deadline > 0
        ? deadline
        : DEFAULT_DEADLINE_SEC) + GRACE_SEC,
  });
}

/** The wake of the repository at `path`. */
export function tickWakeDir(path: string, root = stateRoot()): string {
  return wakeDir(root, path);
}

const logPath = (dir: string) => join(dir, "last-run.log");
/** The size past which a waiter starts the log over. */
const LOG_BYTES = 256 * 1024;

/** Start the waiter for the repository at `path`, detached, in a session of its own, its output to the wake's log. */
function startWaiter(path: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(logPath(dir), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      ["--no-env-file", `--config=${BUNFIG}`, import.meta.path, path],
      {
        cwd: homedir(),
        detached: true,
        stdio: ["ignore", log, log],
        env: environment(LINE_VARIABLE),
        windowsHide: true,
      },
    );
    child.on("error", (error) => {
      // A waiter that does not start leaves the request pending for the next wake or sweep.
      appendFileSync(logPath(dir), `the waiter did not start: ${error}\n`);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * Ask for a tick of the machine-file repository at `path` soon, saying who
 * asks and why (`reason`, which the waiter's log names): when it can start,
 * when idle and no sooner than a minute after the last start; or why the
 * request could not be recorded.
 */
export function wakeTick(
  path: string,
  reason: string,
): Outcome<"now" | "soon", "failed"> {
  const dir = tickWakeDir(path);
  return attempt("failed", "the wake did not record", () => {
    const requested = requestWake(dir, undefined, reason);
    if (requested.startWaiter) startWaiter(path, dir);
    return requested.when;
  });
}

/**
 * Ask for a tick of the machine-file repository at `path`, as `wakeTick`
 * does, and when no live waiter holds the wake be its waiter in this
 * process, returning once it ends: for a caller a scheduler runs, which ends
 * every process a job leaves behind (systemd stops the job's whole control
 * group), so a detached waiter would not outlive it. `elsewhere` when another
 * waiter takes the request; otherwise how the waiter ended.
 */
export async function wakeTickHere(
  path: string,
  reason: string,
): Promise<Outcome<WaitEnd, "failed">> {
  const dir = tickWakeDir(path);
  const requested = attempt("failed", "the wake did not record", () =>
    requestWake(dir, undefined, reason),
  );
  if (!requested.ok) return requested;
  if (!requested.value.startWaiter) return ok("elsewhere");
  try {
    return ok(await waiterMain(path));
  } catch (error) {
    const thrown = error instanceof Error ? error.message : String(error);
    return failed("failed", `the waiter did not run: ${thrown}`, error);
  }
}

/** The waiter: run the repository's tick under the wake's rule, then exit. */
async function waiterMain(path: string): Promise<WaitEnd> {
  const dir = tickWakeDir(path);
  // The log keeps the last few wakes: one past its bound starts over.
  if (
    (statSync(logPath(dir), { throwIfNoEntry: false })?.size ?? 0) > LOG_BYTES
  )
    truncateSync(logPath(dir));
  const note = (line: string) =>
    appendFileSync(logPath(dir), `${new Date().toISOString()} ${line}\n`);
  let prepared: TickCall;
  const { end } = await waitAndRun(dir, {
    busy: LOCK_HELD_EXIT,
    note,
    prepare: async () => {
      const call = await tickCall(path);
      if (!call.ok) return call;
      prepared = call.value;
      return ok(undefined);
    },
    run: async () => {
      const { argv, env, timeoutSec } = prepared;
      const result = await run(argv, { env, cwd: homedir(), timeoutSec });
      if (result.spawnFailed)
        return failed(
          "unstarted",
          `${argv[0]} did not start: ${result.stderr}`,
        );
      note(
        `${JSON.stringify(argv)} exited ${result.code}\n${result.stdout}${result.stderr}`,
      );
      return ok(result.code);
    },
  });
  return end;
}

if (import.meta.main) {
  const [path] = process.argv.slice(2);
  process.exitCode =
    path === undefined ? 2 : (await waiterMain(path)) === "failed" ? 1 : 0;
}
