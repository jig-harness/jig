/**
 * The scheduled job's entry point. `jig gc install` copies this file, with the
 * trusted `bunfig.toml`, to a fixed place under the gc state directory and
 * points the job there, so the job names no plugin release. Each run asks the
 * agent tool which copy of the plugin is installed now and runs that copy's
 * collector; a plugin update therefore reaches the job without a new install.
 *
 * It runs alone, from that copy: Bun's built-ins and `node:` modules only.
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
type StopCause = "deadline" | "output" | NodeJS.Signals;

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
    const capture = options.captureBytes !== undefined;
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      detached: true,
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
      clearTimeout(deadline);
      clearTimeout(escalation);
      for (const name of STOP_SIGNALS) process.off(name, onSignal);
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
        console.error(
          `jig gc launcher: ${reason}; stopping ${options.announce}`,
        );
      if (graceMs <= 0) {
        finish(null);
        return;
      }
      signal("SIGTERM");
      escalation = setTimeout(() => finish(null), graceMs);
    };
    const deadline = setTimeout(
      () => stop("deadline", `ran past ${options.deadlineMs / 1000}s`),
      options.deadlineMs,
    );
    const onSignal = (name: NodeJS.Signals) => stop(name, `received ${name}`);
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
): Promise<unknown> {
  const { code, stopped, stdout, stderr } = await supervise(
    [program, "plugin", "list", "--json"],
    { deadlineMs: timeoutMs, graceMs: 0, captureBytes: maxBytes },
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
    `Cannot find the installed jig plugin (${failures.join("; ") || "no agent tool recorded"}); run jig gc install again`,
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
 * seconds) names its own bound instead.
 */
export function collectionDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const own = env.JIG_LAUNCHER_DEADLINE_SEC ?? "";
  if (/^[1-9][0-9]*$/.test(own)) return Number(own) * 1000;
  const timeout = env.LOCK_TIMEOUT ?? "";
  const wait = /^[0-9]+$/.test(timeout) ? Number(timeout) : 3600;
  return (wait + 7200) * 1000;
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
): Promise<number> {
  const { code, stopped } = await supervise(command, {
    deadlineMs,
    graceMs,
    announce: "the collector",
  });
  // A stopped run did not finish, even when the collector exits 0 on SIGTERM.
  return stopped ? code || 1 : (code ?? 1);
}

async function main(argv: string[]): Promise<number> {
  try {
    const { programs, rest } = parseLauncherArguments(argv);
    const entry = await installedEntry(programs);
    return await runCollector([
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(entry), "gc", "bunfig.toml")}`,
      entry,
      ...rest,
    ]);
  } catch (error) {
    console.error(`jig gc launcher: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
