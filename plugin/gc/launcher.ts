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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

const PLUGIN_ID = "jig@jig";

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
 * after it, so `..` climbs from where the link led, never from the text.
 */
function resolutionPaths(path: string): string[] {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const root = parse(absolute).root;
  let current = root;
  const paths = [root];
  const pending = absolute.slice(root.length).split(/[\\/]/);
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
    pending.unshift(...target.slice(targetRoot.length).split(/[\\/]/));
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

function listPlugins(program: string): unknown {
  const result = spawnSync(program, ["plugin", "list", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new LauncherError(`exited ${result.status}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/**
 * The installed plugin's `jig.ts`, from the first program that names a copy
 * outside every checkout. The programs are the absolute paths recorded at
 * install: the job's `PATH` never picks one.
 */
export function installedEntry(
  programs: { claude?: string; codex?: string },
  list: PluginList = listPlugins,
  codexHome?: string,
): string {
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
      const directory = directoryOf(list(program));
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
 * (`LOCK_TIMEOUT`, an hour unless set) and two hours of work after it.
 */
export function collectionDeadlineMs(
  lockTimeout = process.env.LOCK_TIMEOUT,
): number {
  const wait = Number(lockTimeout);
  return ((Number.isFinite(wait) && wait > 0 ? wait : 3600) + 7200) * 1000;
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs the collector to its exit. The scheduler bounds nothing, so the
 * launcher does: past the deadline, or when the launcher itself is told to
 * stop, the collector's process group gets `SIGTERM` and, `graceMs` later,
 * `SIGKILL`. The collector leads its own group so that every process it
 * started ends with it.
 */
export function runCollector(
  command: string[],
  deadlineMs = collectionDeadlineMs(),
  graceMs = 30_000,
): Promise<number> {
  return new Promise((settle, fail) => {
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: "inherit",
      detached: true,
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-(child.pid as number), name);
      } catch {
        child.kill(name);
      }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (escalation) return;
      console.error(`jig gc launcher: ${reason}; stopping the collector`);
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), graceMs);
    };
    const deadline = setTimeout(
      () => stop(`the collector ran past ${deadlineMs / 1000}s`),
      deadlineMs,
    );
    const onSignal = (name: NodeJS.Signals) => stop(`received ${name}`);
    for (const name of STOP_SIGNALS) process.on(name, onSignal);
    const finish = () => {
      clearTimeout(deadline);
      for (const name of STOP_SIGNALS) process.off(name, onSignal);
      if (escalation) {
        clearTimeout(escalation);
        signal("SIGKILL");
      }
    };
    child.on("error", (error) => {
      finish();
      fail(error);
    });
    child.on("exit", (code) => {
      finish();
      settle(code ?? 1);
    });
  });
}

async function main(argv: string[]): Promise<number> {
  try {
    const { programs, rest } = parseLauncherArguments(argv);
    const entry = installedEntry(programs);
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
