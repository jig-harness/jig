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
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** Whether no checkout holds the script: a worktree reaper could remove it. */
export function outsideCheckout(script: string): boolean {
  let current = dirname(realpathSync(script));
  for (;;) {
    if (existsSync(join(current, ".git"))) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
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

function main(argv: string[]): number {
  try {
    const { programs, rest } = parseLauncherArguments(argv);
    const entry = installedEntry(programs);
    const result = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        `--config=${join(dirname(entry), "gc", "bunfig.toml")}`,
        entry,
        ...rest,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    console.error(`jig gc launcher: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
