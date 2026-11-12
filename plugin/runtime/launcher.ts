/**
 * The entry point of every scheduled job and of the `jig` command on `PATH`.
 * Installing a job copies this file, with the trusted `bunfig.toml`, to a
 * fixed place under that component's state directory and points the job
 * there (`jig install` does the same for the `jig` command), so neither names
 * a plugin release. Each run asks the agent tool which copy of the plugin is
 * installed now and runs that copy's `jig.ts` with the arguments after `--`;
 * a plugin update therefore reaches them without a new install.
 *
 * Before a job runs, the launcher runs the installed copy's
 * `jig upgrade --scheduled` with the agent tools the job recorded, under its
 * own deadline, then asks again which copy is installed, so the job runs the
 * copy the upgrade installed. The upgrade's code is the installed copy's,
 * never the launcher's. An upgrade that fails, runs past its deadline or is
 * withheld never stops the job: the job runs on the copy that is there, and
 * gets the upgrade's line of JSON in `JIG_SCHEDULED_UPGRADE` for its receipt.
 * The `jig` command's script sets `JIG_LAUNCHER_ROLE=command`, and a woken
 * dispatcher tick `wake`: neither is a timer's job, and neither upgrades.
 *
 * It runs alone, from that copy: Bun's built-ins and `node:` modules only.
 * Copies written by earlier releases keep running, so what it passes to
 * `jig.ts` (`--config=<plugin>/gc/bunfig.toml`, then the arguments) stays.
 *
 *   bun --no-env-file --config=<dir>/bunfig.toml <dir>/launcher.ts \
 *     [--claude=<program>] [--codex=<program>] -- gc --scheduled
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

const PLUGIN_ID = "jig@jig";
/** The separators of this platform's paths: a backslash is a filename character on POSIX. */
const SEPARATORS = sep === "\\" ? /[\\/]/ : /\//;

/** A launch that cannot go on; the message says why and what to run. */
class LauncherError extends Error {
  override name = "LauncherError";
}

/** The plugin directory of the user-scope install in `claude plugin list --json`. */
export function claudePluginDirectory(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (plugin) => plugin?.id === PLUGIN_ID && plugin?.scope === "user",
  );
  // A plugin loaded in place from a local marketplace has no cache copy.
  const directory = entry?.readFromFolder ?? entry?.installPath;
  return typeof directory === "string" && directory ? directory : null;
}

/** The cache directory of the install in `codex plugin list --json`. */
export function codexPluginDirectory(
  list: unknown,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
): string | null {
  const installed = (list as { installed?: unknown })?.installed;
  if (!Array.isArray(installed)) return null;
  const version = installed.find(
    (plugin) => plugin?.pluginId === PLUGIN_ID,
  )?.version;
  return typeof version === "string" && version
    ? join(codexHome, "plugins", "cache", "jig", "jig", version)
    : null;
}

/**
 * Every path resolving `path` passes through: each directory above it, each
 * symbolic link on the way and each link's target. It resolves one component
 * at a time, as the kernel does: a link is followed before the components
 * after it, so `..` climbs from where the link led, never from the text, and
 * only this platform's separators split a component.
 */
function resolutionPaths(path: string): string[] {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const root = parse(absolute).root;
  let current = root;
  const paths = [root];
  const pending = absolute.slice(root.length).split(SEPARATORS);
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      current = dirname(current);
      paths.push(current);
      continue;
    }
    const next = join(current, name);
    paths.push(next);
    if (!lstatSync(next).isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++links > 40)
      throw new LauncherError(`too many symbolic links: ${path}`);
    const target = readlinkSync(next);
    const targetRoot = parse(target).root;
    if (targetRoot) {
      current = targetRoot;
      paths.push(current);
    }
    pending.unshift(...target.slice(targetRoot.length).split(SEPARATORS));
  }
  return paths;
}

/**
 * Whether no checkout holds the script: a worktree reaper could remove it,
 * and a branch could change it. The path is what runs, so every directory and
 * symbolic link its resolution passes through counts, not only where it ends.
 */
export function outsideCheckout(script: string): boolean {
  return resolutionPaths(script).every(
    (path) => !existsSync(join(path, ".git")),
  );
}

export type PluginList = (program: string) => unknown;

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Why the launcher stopped a child: its deadline, its output, or a signal to the launcher. */
type StopCause = "deadline" | "output" | "aborted" | NodeJS.Signals;

/** How one supervised child ended. */
interface Outcome {
  code: number | null;
  /** Null when the child ended on its own. */
  stopped: StopCause | null;
  stdout: string;
  stderr: string;
}

interface Supervision {
  deadlineMs: number;
  /** Between `SIGTERM` and `SIGKILL`; zero sends `SIGKILL` at once. */
  graceMs: number;
  /** Captures stdout and stderr, together at most this many bytes; otherwise both are inherited. */
  captureBytes?: number;
  /** Names the child on stderr when it is stopped. */
  announce?: string;
  /** The child's environment, in place of the launcher's own. */
  env?: NodeJS.ProcessEnv;
  /** Ends the child's group at once when it aborts; an aborted signal never starts it. */
  signal?: AbortSignal;
}

/** The longest delay `setTimeout` takes; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `setTimeout` for any delay: one past the timer's range waits in segments
 * rather than firing at once. `clear` ends it.
 */
function longTimeout(run: () => void, ms: number): { clear(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (left: number) => {
    timer = setTimeout(
      () => (left > MAX_TIMER_MS ? arm(left - MAX_TIMER_MS) : run()),
      Math.min(left, MAX_TIMER_MS),
    );
  };
  arm(ms);
  return { clear: () => clearTimeout(timer) };
}

/**
 * Runs one child to its end under the launcher's ownership: every process the
 * launcher waits on starts here. The child leads its own process group, so a
 * signal reaches everything that stays in it; a descendant that starts its own
 * session leaves the group and is out of reach. Past the deadline, past the capture
 * budget, or when the launcher itself is told to stop, the group gets
 * `SIGTERM` and, `graceMs` later, `SIGKILL`. At `SIGKILL` the run settles at
 * once: the pipes are destroyed and the child unreferenced, so a descendant
 * still holding them cannot keep the launcher alive. Captured output is
 * decoded once, whole, so a character split across chunks survives. The
 * stop-signal handlers live exactly as long as the child.
 */
function supervise(command: string[], options: Supervision): Promise<Outcome> {
  return new Promise((settle, fail) => {
    if (options.signal?.aborted) {
      settle({ code: null, stopped: "aborted", stdout: "", stderr: "" });
      return;
    }
    const capture = options.captureBytes !== undefined;
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      detached: true,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-(child.pid as number), name);
      } catch {
        child.kill(name);
      }
    };
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let captured = 0;
    let stopped: StopCause | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const release = () => {
      done = true;
      deadline.clear();
      clearTimeout(escalation);
      for (const name of STOP_SIGNALS) process.off(name, onSignal);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code: number | null) => {
      if (done) return;
      release();
      // A stopped child's group is ended whole, whatever the child did.
      if (stopped) signal("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      settle({
        code,
        stopped,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    };
    const stop = (
      cause: StopCause,
      reason: string,
      graceMs = options.graceMs,
    ) => {
      if (stopped || done) return;
      stopped = cause;
      if (options.announce)
        console.error(`jig launcher: ${reason}; stopping ${options.announce}`);
      if (graceMs <= 0) {
        finish(null);
        return;
      }
      signal("SIGTERM");
      escalation = setTimeout(() => finish(null), graceMs);
    };
    const deadline = longTimeout(
      () => stop("deadline", `ran past ${options.deadlineMs / 1000}s`),
      options.deadlineMs,
    );
    const onSignal = (name: NodeJS.Signals) => stop(name, `received ${name}`);
    const onAbort = () => stop("aborted", "was cancelled", 0);
    options.signal?.addEventListener("abort", onAbort);
    for (const name of STOP_SIGNALS) process.on(name, onSignal);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) => {
        captured += chunk.length;
        if (captured > (options.captureBytes as number)) {
          stop("output", `printed more than ${options.captureBytes} bytes`, 0);
          return;
        }
        chunks[stream].push(chunk);
      });
    }
    child.on("error", (error) => {
      if (done) return;
      release();
      fail(error);
    });
    // Captured output is whole only once the pipes close.
    child.on(capture ? "close" : "exit", (code) => finish(code));
  });
}

/** The launcher was told to stop: no further lookup or collection runs. */
class LauncherStopped extends LauncherError {
  override name = "LauncherStopped";
}

/**
 * Asks one agent tool for its plugins. A tool that does not answer within
 * `timeoutMs`, or prints more than `maxBytes`, is killed with its process
 * group and the lookup fails; a stop signal ends the lookup and the launch.
 */
export async function listPlugins(
  program: string,
  timeoutMs = 30_000,
  maxBytes = 4 * 1024 * 1024,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<unknown> {
  const { code, stopped, stdout, stderr } = await supervise(
    [program, "plugin", "list", "--json"],
    {
      deadlineMs: timeoutMs,
      graceMs: 0,
      captureBytes: maxBytes,
      ...(env === undefined ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (stopped === "deadline")
    throw new LauncherError(`did not answer within ${timeoutMs / 1000}s`);
  if (stopped === "output")
    throw new LauncherError(`printed more than ${maxBytes} bytes`);
  if (stopped) throw new LauncherStopped(`received ${stopped}`);
  if (code !== 0) throw new LauncherError(`exited ${code}: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

/**
 * The installed plugin's `jig.ts`, from the first program that names a copy
 * outside every checkout. The programs are the absolute paths recorded at
 * install: the job's `PATH` never picks one.
 */
export async function installedEntry(
  programs: { claude?: string; codex?: string },
  list: PluginList = listPlugins,
  codexHome?: string,
): Promise<string> {
  const failures: string[] = [];
  const candidates: [
    string,
    string | undefined,
    (value: unknown) => string | null,
  ][] = [
    ["claude", programs.claude, claudePluginDirectory],
    [
      "codex",
      programs.codex,
      (value) => codexPluginDirectory(value, codexHome),
    ],
  ];
  for (const [name, program, directoryOf] of candidates) {
    if (!program) continue;
    try {
      const directory = directoryOf(await list(program));
      if (!directory) {
        failures.push(`${name}: ${PLUGIN_ID} is not installed`);
        continue;
      }
      const entry = join(directory, "jig.ts");
      if (!existsSync(entry)) {
        failures.push(`${name}: ${entry} does not exist`);
        continue;
      }
      if (!outsideCheckout(entry)) {
        failures.push(`${name}: ${entry} is inside a checkout`);
        continue;
      }
      return realpathSync(entry);
    } catch (error) {
      if (error instanceof LauncherStopped) throw error;
      failures.push(`${name}: ${(error as Error).message}`);
    }
  }
  throw new LauncherError(
    `Cannot find the installed jig plugin (${failures.join("; ") || "no agent tool recorded"}); run jig install again`,
  );
}

export function parseLauncherArguments(argv: string[]): {
  programs: { claude?: string; codex?: string };
  rest: string[];
} {
  const programs: { claude?: string; codex?: string } = {};
  let index = 0;
  for (; index < argv.length && argv[index] !== "--"; index++) {
    const match = /^--(claude|codex)=(.+)$/.exec(argv[index] as string);
    if (!match)
      throw new LauncherError(`Unknown launcher argument: ${argv[index]}`);
    programs[match[1] as "claude" | "codex"] = match[2] as string;
  }
  return { programs, rest: argv.slice(index + 1) };
}

/**
 * How long one collection may run: the machine heavy-run lock's wait
 * (`LOCK_TIMEOUT`, whole seconds, zero included; an hour unless set) and two
 * hours of work after it. A job that sets `JIG_LAUNCHER_DEADLINE_SEC` (whole
 * seconds) names its own bound instead. A value too large to represent as a
 * finite number is not a bound and falls back to the default.
 */
export function collectionDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const own = env.JIG_LAUNCHER_DEADLINE_SEC ?? "";
  const named = Number(own) * 1000;
  if (/^[1-9][0-9]*$/.test(own) && Number.isFinite(named)) return named;
  const timeout = env.LOCK_TIMEOUT ?? "";
  const given = /^[0-9]+$/.test(timeout)
    ? (Number(timeout) + 7200) * 1000
    : NaN;
  return Number.isFinite(given) ? given : (3600 + 7200) * 1000;
}

/**
 * Runs the collector to its exit. The scheduler bounds nothing, so the
 * launcher does: past the deadline, or when the launcher itself is told to
 * stop, the collector's process group gets `SIGTERM` and, `graceMs` later,
 * `SIGKILL`, and the run fails whatever status the collector exits with.
 */
export async function runCollector(
  command: string[],
  deadlineMs = collectionDeadlineMs(),
  graceMs = 30_000,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const { code, stopped } = await supervise(command, {
    deadlineMs,
    graceMs,
    announce: "the run",
    ...(env === undefined ? {} : { env }),
  });
  // A stopped run did not finish, even when the collector exits 0 on SIGTERM.
  return stopped ? code || 1 : (code ?? 1);
}

/** Who started the launcher, when it is not a timer: `command` (the `jig` command) or `wake` (a woken tick). */
const ROLE = "JIG_LAUNCHER_ROLE";
/** The scheduled upgrade's line, passed to the job (`upgrade-record.ts`). */
const UPGRADE_RESULT = "JIG_SCHEDULED_UPGRADE";
/** How long the scheduled upgrade may run before the job goes on without it. */
const UPGRADE_DEADLINE_MS = 30 * 60_000;

/** The installed `entry`, run by this Bun with its own trusted startup file. */
function entryCommand(entry: string): string[] {
  return [
    process.execPath,
    "--no-env-file",
    `--config=${join(dirname(entry), "gc", "bunfig.toml")}`,
    entry,
  ];
}

/**
 * The longest result line passed to a job: the system bounds one environment
 * value (128 KiB on Linux), and a longer one would stop the job starting.
 */
const RESULT_LIMIT = 8 * 1024;
/** The longest detail a scheduled upgrade's own result carries, kept whole when wrapped. */
const DETAIL_LIMIT = 2000;
/** The outcomes a result may name (`upgrade-record.ts`). */
const OUTCOMES = ["withheld", "skipped", "unchanged", "updated", "failed"];

/** `text`, cut to `limit` characters, saying how much was cut. */
function clip(text: string, limit = 1000): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)} … (${text.length - limit} more characters)`;
}

/** The last `limit` characters of `text`, saying how much was cut from its start. */
function tail(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `(${text.length - limit} earlier characters) … ${text.slice(-limit)}`;
}

/** `text` cut to `limit` characters from both ends, saying how much was cut between. */
function ends(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit / 2);
  const rest = limit - head;
  return `${text.slice(0, head)} … (${text.length - limit} characters) … ${rest > 0 ? text.slice(-rest) : ""}`;
}

/** A result line for an upgrade that printed none that reads, saying why. */
function failedUpgrade(detail: string, limit?: number): string {
  const at = Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });
  let keep = limit ?? 1000;
  // The line is bounded as serialized, whatever the detail holds: JSON escapes
  // a control character into six bytes, so a character count alone is no bound.
  // Each shrink keeps the detail's beginning and its diagnostic tail.
  for (;;) {
    const text = JSON.stringify({
      outcome: "failed",
      detail: ends(detail, keep),
      at,
    });
    if (Buffer.byteLength(text, "utf8") <= RESULT_LIMIT || keep <= 16)
      return text;
    keep = Math.floor(keep / 2);
  }
}

/** Whether `value` is a result as `upgrade-record.ts`'s `isScheduledUpgrade` reads one. */
function isResult(value: unknown): value is { detail: string } {
  const result = value as Record<string, unknown> | null;
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    OUTCOMES.includes(result.outcome as string) &&
    typeof result.detail === "string" &&
    typeof result.at === "string" &&
    ["undefined", "string"].includes(typeof result.from) &&
    ["undefined", "string"].includes(typeof result.to)
  );
}

/**
 * The result line the upgrade printed last (with its detail), or a failed one when that line
 * is JSON but not a result or too long to pass on; null when its last line is
 * not JSON at all.
 */
function resultLine(stdout: string): { text: string; detail: string } | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // Not the result line: an installed copy too old for --scheduled, or one that crashed.
    console.error(
      `jig launcher: the scheduled upgrade printed no result (${(error as Error).message})`,
    );
    return null;
  }
  if (!isResult(value))
    return {
      text: failedUpgrade(
        `jig upgrade --scheduled printed a result that does not read: ${line}`,
      ),
      detail: line,
    };
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  return {
    text:
      bytes <= RESULT_LIMIT
        ? text
        : failedUpgrade(
            `jig upgrade --scheduled printed a result of ${bytes} bytes, more than the ${RESULT_LIMIT} a job is passed: ${value.detail}`,
          ),
    detail: value.detail,
  };
}

/** What the supervised upgrade came to, as its result line. */
function upgradeResult(outcome: Outcome, deadlineMs: number): string {
  const { code, stopped, stdout, stderr } = outcome;
  if (stopped === "deadline")
    return failedUpgrade(
      `jig upgrade --scheduled ran past ${deadlineMs / 1000}s`,
    );
  if (stopped === "output")
    return failedUpgrade("jig upgrade --scheduled printed more than 4 MiB");
  if (stopped) throw new LauncherStopped(`received ${stopped}`);
  const said = clip(stderr.trim().split("\n").at(-1) ?? "", 500);
  const printed = resultLine(stdout);
  if (printed === null)
    return failedUpgrade(
      `jig upgrade --scheduled exited ${code} without a result${said ? `: ${said}` : ""}`,
    );
  if (code === 0) return printed.text;
  // The result's detail keeps its diagnostic tail, as the upgrade bounded it.
  const context = `jig upgrade --scheduled exited ${code} after printing a result: `;
  return failedUpgrade(
    context + tail(printed.detail, DETAIL_LIMIT),
    context.length + DETAIL_LIMIT + 64,
  );
}

/**
 * Runs the installed copy's `jig upgrade --scheduled` and returns the line of
 * JSON it printed, or, when it printed none, one that says the upgrade
 * failed and why. Only a stop signal to the launcher ends the launch.
 */
async function scheduledUpgrade(
  entry: string,
  programs: { claude?: string; codex?: string },
  env: NodeJS.ProcessEnv,
  deadlineMs = UPGRADE_DEADLINE_MS,
): Promise<string> {
  const upgrade = [
    ...entryCommand(entry),
    "upgrade",
    "--scheduled",
    ...Object.entries(programs).map(
      ([name, program]) => `--${name}-program=${program}`,
    ),
  ];
  let outcome: Outcome;
  try {
    outcome = await supervise(upgrade, {
      deadlineMs,
      graceMs: 10_000,
      captureBytes: 4 * 1024 * 1024,
      announce: "the scheduled upgrade",
      env,
    });
  } catch (error) {
    return failedUpgrade(
      `jig upgrade --scheduled did not start: ${(error as Error).message}`,
    );
  }
  process.stderr.write(outcome.stderr);
  return upgradeResult(outcome, deadlineMs);
}

/**
 * The job's entry once the upgrade ran: the copy installed now, or the one
 * it started with when the lookup fails, so a failed upgrade never stops it.
 */
async function entryAfterUpgrade(
  programs: { claude?: string; codex?: string },
  before: string,
): Promise<string> {
  try {
    return await installedEntry(programs);
  } catch (error) {
    if (error instanceof LauncherStopped) throw error;
    console.error(
      `jig launcher: ${(error as Error).message}; running ${before}`,
    );
    return before;
  }
}

/**
 * The jobs the plugin is upgraded before: collection's and the dispatcher's
 * ticks, whose receipts record the upgrade. Any other job, such as the
 * dispatcher's minute-by-minute change probe, runs without one.
 */
const UPGRADED_JOBS = [
  ["gc", "--scheduled"],
  ["dispatch", "--apply"],
];

/** Whether the job `rest` names runs the scheduled upgrade first. */
export function upgradesFirst(rest: readonly string[]): boolean {
  return UPGRADED_JOBS.some((job) =>
    job.every((word, index) => rest[index] === word),
  );
}

async function main(argv: string[]): Promise<number> {
  const stopped = new AbortController();
  let received: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    received ??= signal;
    stopped.abort();
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  try {
    const { programs, rest } = parseLauncherArguments(argv);
    const env = { ...process.env };
    const role = env[ROLE];
    delete env[ROLE];
    delete env[UPGRADE_RESULT];
    let entry = await installedEntry(programs, async (program) => {
      try {
        return await listPlugins(
          program,
          undefined,
          undefined,
          undefined,
          stopped.signal,
        );
      } catch (error) {
        if (error instanceof LauncherStopped && received)
          throw new LauncherStopped(`received ${received}`);
        throw error;
      }
    });
    if ((role === undefined || role === "") && upgradesFirst(rest)) {
      const result = await scheduledUpgrade(entry, programs, env);
      env[UPGRADE_RESULT] = result;
      // Only an update, or a failure part-way through one, can move the installed copy.
      if (["updated", "failed"].includes(JSON.parse(result).outcome))
        entry = await entryAfterUpgrade(programs, entry);
    }
    return await runCollector(
      [...entryCommand(entry), ...rest],
      collectionDeadlineMs(),
      30_000,
      env,
    );
  } catch (error) {
    console.error(`jig launcher: ${(error as Error).message}`);
    return 1;
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
