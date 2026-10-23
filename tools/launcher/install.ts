#!/usr/bin/env bun
/**
 * Wire the tracker's "open in coding agent" action to the launcher on this
 * machine, or check that it is wired.
 *
 * Usage:
 *   bun tools/launcher/install.ts              wire it (idempotent)
 *   bun tools/launcher/install.ts --check      report only; exit 1 if not ready
 *                                              (an API key others can read is not ready)
 *   bun tools/launcher/install.ts --dry-run    print what would change
 *   options: --provider <name>                 provider written into a new
 *                                              configuration file (default conductor)
 *   Any other argument, or --provider without a name, is a usage error (exit 2).
 *
 * It writes `~/.linear/coding-tools.json` (merged, never replaced: other keys
 * survive, a changed file is first copied to `coding-tools.json.bak-<time>`,
 * and the new one replaces it whole) and, only when absent, a starter
 * `~/.linear/launcher.yaml`. It never writes the API key (a secret) and never
 * touches a repository. Every check runs first: when one fails, nothing is
 * written. When a write itself fails, the writes before it are undone.
 *
 * The tracker starts the launcher as a GUI child with no shell profile, so
 * `bun` is unlikely to be on its `PATH`. The entry therefore names the absolute
 * path of the `bun` running this installer as the executable, with the launcher
 * script as its first argument. Run the installer again after changing the Bun
 * version; `--check` reports a path that no longer exists.
 */
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  configPath,
  configStep,
  DEFAULT_PROVIDER,
  parseConfig,
} from "./config.ts";
import { writeFileAtomic } from "./files.ts";
import { conductorDbPath } from "./providers/conductor.ts";
import { getProvider, providerNames } from "./providers/index.ts";
import { getTracker } from "./trackers/index.ts";

export const LAUNCH_SCRIPT = resolve(import.meta.dirname, "launch.ts");

/** The tracker's own variables; it rejects any other, `LINEAR_API_KEY` included. */
const TRACKER_ENV = ["LINEAR_PROMPT", "LINEAR_ISSUE_BRANCH_NAME"];

export interface OpenIssueEntry {
  path: string;
  args: string[];
  env: string[];
}

export function desiredEntry(bun: string, script: string): OpenIssueEntry {
  return {
    path: bun,
    args: [script, "{{issue.identifier}}", "{{issue.branchName}}"],
    env: TRACKER_ENV,
  };
}

/** A path as one POSIX shell word, whatever characters it holds. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Field by field, so an equivalent entry written in another key order matches. */
function sameEntry(a: unknown, b: OpenIssueEntry): boolean {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
  const entry = a as Record<string, unknown>;
  return (
    Object.keys(entry).length === 3 &&
    entry.path === b.path &&
    JSON.stringify(entry.args) === JSON.stringify(b.args) &&
    JSON.stringify(entry.env) === JSON.stringify(b.env)
  );
}

/** Whether `error` says the path is absent or off limits, rather than that something broke. */
function isAccessFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";
}

/** Whether `path` is a regular file this process may run. */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch (error) {
    if (isAccessFailure(error)) return false;
    throw error;
  }
}

/** Whether `path` is a regular file this process may read. */
function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch (error) {
    if (isAccessFailure(error)) return false;
    throw error;
  }
}

export function starterConfig(provider: string): string {
  return `# Jig launcher configuration. Read by tools/launcher/launch.ts.
# Reference: tools/launcher/README.md

# Which issue tracker the issue is read from.
# tracker: linear

# Which workspace provider opens the issue.
provider: ${provider}

# The slash command that starts the work.
# skill: /jig:do-item

# The tracker label group whose value names the repository.
# repo_label_group: Repo

# Repository label -> that repository's settings per provider. Without an entry
# the provider detects the repository itself, which is unreliable with several.
# For conductor the value is the repository's name in Conductor.
# repos:
#   my-service:
#     conductor: my-service
repos: {}
`;
}

export interface InstallOptions {
  home: string;
  bun: string;
  script?: string;
  check?: boolean;
  dryRun?: boolean;
  provider?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface InstallReport {
  ok: boolean;
  lines: string[];
}

/**
 * Create `path` with `text`, failing if it exists. A write that fails after
 * the file was created removes it, so the failed operation leaves nothing.
 */
function createFile(path: string, text: string): void {
  writeFileSync(path, "", { flag: "wx" });
  try {
    writeFileSync(path, text);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/** A backup name no earlier install used: `copyFileSync` must never overwrite one. */
function backupPath(file: string, now: () => number): string {
  const stamp = Math.floor(now() / 1000);
  for (let n = 0; ; n += 1) {
    const candidate = `${file}.bak-${stamp}${n === 0 ? "" : `-${n}`}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * `mkdir -p`, returning what undoes it: removing, deepest first, only the
 * directories it created.
 */
function makeDir(path: string, mode?: number): () => void {
  const first = mkdirSync(path, { recursive: true, mode });
  return () => {
    if (first === undefined) return;
    for (let dir = path; ; dir = dirname(dir)) {
      rmdirSync(dir);
      if (dir === first) return;
    }
  };
}

/** What an install has found so far and the writes it would make. */
interface Plan {
  ok: boolean;
  readonly lines: string[];
  /**
   * Every check runs before any write, so a failed install changes nothing:
   * replacing a working entry and then finding the configuration unusable
   * would leave the tracker's button broken. A write can still fail after the
   * checks pass (an unwritable directory), so each returns what undoes it, and
   * a failure undoes the writes before it. A write that fails removes what it
   * had created itself before throwing, so only finished writes need undoing.
   */
  readonly writes: Array<() => () => void>;
  readonly check: boolean;
  problem(line: string): void;
  good(line: string): void;
  change(line: string): void;
}

function newPlan(check: boolean, write: boolean): Plan {
  const plan: Plan = {
    ok: true,
    lines: [],
    writes: [],
    check,
    problem(line) {
      plan.ok = false;
      plan.lines.push(`✗ ${line}`);
    },
    good(line) {
      plan.lines.push(`✓ ${line}`);
    },
    change(line) {
      plan.lines.push(`${write ? "→" : "·"} ${line}`);
    },
  };
  return plan;
}

/** The tools file's parsed contents and its text; `original` is null when there is no file. */
function readToolsFile(toolsFile: string): {
  tools: Record<string, unknown>;
  original: string | null;
} {
  if (!existsSync(toolsFile)) return { tools: {}, original: null };
  const original = readFileSync(toolsFile, "utf8");
  const parsed: unknown = JSON.parse(original);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("not a JSON object");
  return { tools: parsed as Record<string, unknown>, original };
}

/** Replace a tools file that exists, keeping a backup; the returned function restores it. */
function replaceToolsFile(
  plan: Plan,
  toolsFile: string,
  tools: Record<string, unknown>,
  prior: string,
  entry: unknown,
  now: () => number,
): () => void {
  const mode = statSync(toolsFile).mode & 0o777;
  const backup = backupPath(toolsFile, now);
  try {
    copyFileSync(toolsFile, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    // A copy that fails partway leaves a partial backup behind; one that
    // found the name taken created nothing.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      rmSync(backup, { force: true });
    throw error;
  }
  try {
    writeFileAtomic(
      toolsFile,
      `${JSON.stringify({ ...tools, openIssue: entry }, null, 2)}\n`,
      mode,
    );
  } catch (error) {
    rmSync(backup);
    throw error;
  }
  plan.lines.push(`  previous file saved to ${backup}`);
  return () => {
    writeFileAtomic(toolsFile, prior, mode);
    rmSync(backup);
  };
}

/** Create the tools file with only the launcher's entry; the returned function removes it. */
function createToolsFile(
  toolsFile: string,
  entry: unknown,
  undoDir: () => void,
): () => void {
  try {
    writeFileAtomic(
      toolsFile,
      `${JSON.stringify({ openIssue: entry }, null, 2)}\n`,
      0o644,
    );
  } catch (error) {
    undoDir();
    throw error;
  }
  return () => {
    rmSync(toolsFile);
    undoDir();
  };
}

/**
 * The tracker's action: check the tools file and plan the write that makes it
 * run the launcher. False when the file cannot be read, which ends the install.
 */
function planToolsEntry(
  plan: Plan,
  toolsFile: string,
  bun: string,
  script: string,
  now: () => number,
): boolean {
  const entry = desiredEntry(bun, script);
  let file: ReturnType<typeof readToolsFile>;
  try {
    file = readToolsFile(toolsFile);
  } catch (error) {
    plan.problem(
      `${toolsFile} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it, nothing was changed`,
    );
    return false;
  }
  const { tools, original } = file;
  if (sameEntry(tools.openIssue, entry)) {
    plan.good(`${toolsFile} already runs the launcher`);
  } else if (plan.check) {
    plan.problem(`${toolsFile} does not run this launcher; run the installer`);
  } else {
    plan.change(`set openIssue in ${toolsFile} to run ${script} with ${bun}`);
    plan.writes.push(() => {
      // Private: the API key file lives here too.
      const undoDir = makeDir(dirname(toolsFile), 0o700);
      return original === null
        ? createToolsFile(toolsFile, entry, undoDir)
        : replaceToolsFile(plan, toolsFile, tools, original, entry, now);
    });
  }
  return true;
}

/** Validate an existing launcher configuration, reporting what it selects. */
function checkConfigFile(
  plan: Plan,
  config: string,
  home: string,
  env: Record<string, string | undefined>,
): void {
  try {
    const parsed = parseConfig(
      configStep(config, () => readFileSync(config, "utf8")),
      config,
    );
    configStep(config, () => {
      getTracker(parsed.tracker, { home, env });
      for (const provider of parsed.providers.map(getProvider))
        for (const [label, settings] of Object.entries(parsed.repos))
          if (settings[provider.name] !== undefined)
            provider.validateRepo(settings[provider.name], label);
    });
    plan.good(
      `${config}: tracker ${parsed.tracker}, provider ${parsed.providers.join(", ")}, ${Object.keys(parsed.repos).length} routed repositories`,
    );
  } catch (error) {
    plan.problem(error instanceof Error ? error.message : String(error));
  }
}

/** Plan a starter configuration where there is none. */
function planStarterConfig(plan: Plan, config: string, provider: string): void {
  if (!providerNames().includes(provider)) {
    plan.problem(
      `unknown provider "${provider}" (available: ${providerNames().join(", ")})`,
    );
  } else if (plan.check) {
    plan.lines.push(
      `· ${config} is absent; defaults apply (no repository routing)`,
    );
  } else {
    plan.change(`write a starter ${config}`);
    plan.writes.push(() => {
      const undoDir = makeDir(dirname(config));
      try {
        createFile(config, starterConfig(provider));
      } catch (error) {
        undoDir();
        throw error;
      }
      return () => {
        rmSync(config);
        undoDir();
      };
    });
  }
}

/** The credential: reported, never written; a key file others can read is made private. */
function planApiKey(plan: Plan, dir: string, keyFile: string): void {
  if (!existsSync(keyFile)) {
    const d = shellQuote(dir);
    const k = shellQuote(keyFile);
    plan.lines.push(
      `· no ${keyFile}: without a key the launcher cannot assign, route or cache the full context. Create it private before any key lands: (umask 077 && mkdir -p ${d} && touch ${k} && chmod 600 ${k} && printf '%s' "lin_api_…" > ${k})`,
    );
  } else if (!statSync(keyFile).isFile()) {
    plan.problem(
      `${keyFile} is not a file; replace it with one holding the key`,
    );
  } else if ((statSync(keyFile).mode & 0o077) === 0) {
    plan.good(`${keyFile} is private`);
  } else if (plan.check) {
    plan.problem(`${keyFile} is readable by others; chmod 600 it`);
  } else {
    plan.change(`make ${keyFile} private (mode 600)`);
    plan.writes.push(() => {
      const mode = statSync(keyFile).mode & 0o777;
      chmodSync(keyFile, 0o600);
      return () => chmodSync(keyFile, mode);
    });
  }
}

/** The launcher's configuration: validate it, or plan a starter one. */
function planLauncherConfig(
  plan: Plan,
  home: string,
  env: Record<string, string | undefined>,
  provider: string,
): void {
  const config = configPath(home, env);
  if (config !== configPath(home, {}))
    plan.lines.push(
      `· JIG_LAUNCHER_CONFIG selects ${config} here, but the tracker starts the launcher without it, so that launcher reads ${configPath(home, {})}`,
    );
  if (existsSync(config)) checkConfigFile(plan, config, home, env);
  else planStarterConfig(plan, config, provider);
}

export function install(options: InstallOptions): InstallReport {
  const { home, bun, check = false, dryRun = false } = options;
  const script = options.script ?? LAUNCH_SCRIPT;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const write = !check && !dryRun;
  const plan = newPlan(check, write);

  const dir = join(home, ".linear");
  const toolsFile = join(dir, "coding-tools.json");
  if (!planToolsEntry(plan, toolsFile, bun, script, now))
    return { ok: plan.ok, lines: plan.lines };
  if (!isExecutableFile(bun))
    plan.problem(`${bun} is not an executable file; re-run the installer`);
  if (!isReadableFile(script)) plan.problem(`${script} is not a readable file`);

  planLauncherConfig(plan, home, env, options.provider ?? DEFAULT_PROVIDER);

  planApiKey(plan, dir, join(dir, "api-key"));

  // What the default provider needs from the machine.
  if (!existsSync(conductorDbPath(home)))
    plan.lines.push(
      `· Conductor's database was not found at ${conductorDbPath(home)}; the conductor provider will let Conductor detect the repository`,
    );

  if (write) {
    if (!plan.ok) plan.lines.push("✗ nothing was changed");
    else commit(plan.writes, plan.problem);
  }
  return { ok: plan.ok, lines: plan.lines };
}

/** Run the writes in order; when one throws, undo the ones before it, newest first. */
function commit(
  writes: Array<() => () => void>,
  problem: (line: string) => void,
): void {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const undos: Array<() => void> = [];
  try {
    for (const run of writes) undos.push(run());
  } catch (error) {
    const stuck: string[] = [];
    for (const undo of undos.reverse()) {
      try {
        undo();
      } catch (undoError) {
        stuck.push(message(undoError));
      }
    }
    problem(
      stuck.length === 0
        ? `${message(error)}; the earlier changes were undone, nothing was changed`
        : `${message(error)}; undoing the earlier changes also failed (${stuck.join("; ")})`,
    );
  }
}

/** The command line's options, or a usage error naming what is wrong. */
export function parseArgs(
  args: string[],
): { check: boolean; dryRun: boolean; provider?: string } | string {
  const options: { check: boolean; dryRun: boolean; provider?: string } = {
    check: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--provider") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--"))
        return "--provider needs a provider name";
      options.provider = value;
      i += 1;
    } else return `unknown argument ${arg}`;
  }
  return options;
}

if (import.meta.main) {
  cli(() => {
    const parsed = parseArgs(process.argv.slice(2));
    if (typeof parsed === "string") {
      console.error(`install.ts: ${parsed}`);
      return 2;
    }
    const report = install({
      home: process.env.HOME ?? homedir(),
      bun: process.execPath,
      ...parsed,
    });
    console.log(report.lines.join("\n"));
    return report.ok ? 0 : 1;
  });
}
