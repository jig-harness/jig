/**
 * A machine for the lifecycle verbs' tests: a scratch home, a repository
 * with a resource-collection declaration and a remote, an installed copy of
 * the plugin outside every checkout, and fakes on `PATH` for the platform
 * schedulers (`systemctl`, `crontab`, `launchctl`, which keep their jobs'
 * state in files) and the agent tools (`claude` names the plugin copy a file
 * holds, so a test can move it as a plugin update does). Every command runs
 * as a child with that home, so no test reaches the real scheduler, the real
 * `~/.local/bin` or the real machine files.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { gitEnvironment } from "../gc/git.ts";
import { dump } from "../shared/yaml.ts";

/** The schedulers a machine of this platform can have: both of Linux's, or macOS's. */
export const SCHEDULERS =
  process.platform === "linux"
    ? (["systemd", "cron"] as const)
    : (["launchd"] as const);
export type Variant = (typeof SCHEDULERS)[number];

/** A scheduler fake: each job's state is a file under `state`. */
function schedulerFake(name: string, state: string, units: string): string {
  return `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const S = ${JSON.stringify(state)};
const args = process.argv.slice(2);
appendFileSync(join(S, "calls.log"), ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");
const flag = (kind, unit) => join(S, kind + "-" + unit);
if (${JSON.stringify(name)} === "systemctl") {
  const unit = args.at(-1);
  if (args[1] === "show") {
    const unitName = args[2];
    console.log("LoadState=" + (existsSync(join(${JSON.stringify(units)}, unitName)) ? "loaded" : "not-found")
      + "\\nUnitFileState=" + (existsSync(flag("enabled", unitName)) ? "enabled" : "disabled")
      + "\\nActiveState=" + (existsSync(flag("active", unitName)) ? "active" : "inactive"));
  }
  if (args[1] === "enable") { writeFileSync(flag("enabled", unit), ""); if (args.includes("--now")) writeFileSync(flag("active", unit), ""); }
  if (args[1] === "disable") { rmSync(flag("enabled", unit), { force: true }); rmSync(flag("active", unit), { force: true }); }
  if (args[1] === "start") writeFileSync(flag("active", unit), "");
}
if (${JSON.stringify(name)} === "crontab") {
  const table = join(S, "crontab");
  if (args[0] === "-l") {
    if (!existsSync(table)) { console.error("no crontab for user"); process.exit(1); }
    process.stdout.write(readFileSync(table, "utf8"));
  } else writeFileSync(table, await Bun.stdin.text());
}
if (${JSON.stringify(name)} === "launchctl") {
  const label = (target) => basename(target).replace(/\\.plist$/, "");
  if (args[0] === "print") process.exit(existsSync(flag("loaded", label(args[1]))) ? 0 : 113);
  if (args[0] === "bootstrap") writeFileSync(flag("loaded", label(args[2])), "");
  if (args[0] === "bootout") rmSync(flag("loaded", label(args[1])), { force: true });
}
`;
}

/** A finished child's exit code and output. */
export interface Run {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface Machine {
  root: string;
  home: string;
  repo: string;
  /** The installed plugin copy, outside every checkout. */
  plugin: string;
  env: NodeJS.ProcessEnv;
  variant: Variant;
  /** Where the fakes keep the schedulers' state. */
  state: string;
  /** Runs `<plugin>/jig.ts <args>` from the repository, as an installed copy runs. */
  jig(args: string[]): Run;
  /** Points the `claude` fake at another plugin copy, as a plugin update does. */
  movePlugin(directory: string): void;
  /** Whether the scheduler holds the job named `name` (`jig-gc`, `jig-dispatch`). */
  hasJob(name: string): boolean;
  /** Writes the dispatcher's machine file, the opt-in its install needs. */
  writeDispatchFile(): void;
}

export function machine(variant: Variant): Machine {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jig-lifecycle-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const state = join(root, "scheduler");
  const bin = join(root, "bin");
  for (const dir of [home, repo, state, bin]) mkdirSync(dir);
  const units = join(home, ".config", "systemd", "user");
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "systemd"), { recursive: true });
  if (variant === "systemd")
    writeFileSync(join(runtime, "systemd", "private"), "");
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    HOME: home,
    USERPROFILE: home,
    JIG_HOME: join(home, ".jig"),
    XDG_RUNTIME_DIR: runtime,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    JIG_USER_LAYER: undefined,
    JIG_CONSUMER_ROOT: undefined,
    JIG_GC_HEAVY_LOCK: undefined,
    LOCK_TIMEOUT: undefined,
    RESOURCE_LOCK_BYPASS: "1",
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    ORCA_CLI_COMMAND: undefined,
    ORCA_CLI_BIN_DIR: undefined,
  };
  const git = (args: string[], cwd = repo) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    });
    expectSpawnExit(result, 0, `git ${args.join(" ")}`);
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(join(repo, ".config"));
  writeFileSync(
    join(repo, ".config", "jig.yaml"),
    dump({
      gc: {
        kinds: ["scratch"],
        worktree_roots: [],
        scratch_prefixes: [join(root, "scratch-")],
      },
    }),
  );
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  const remote = join(root, "remote.git");
  git(["clone", "--bare", repo, remote]);
  git(["remote", "add", "origin", remote]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const plugin = join(root, "installed");
  cpSync(resolve(import.meta.dir, ".."), plugin, {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  const pluginPath = join(root, "plugin-path");
  writeFileSync(pluginPath, plugin);
  writeFakeProgram(
    join(bin, "claude"),
    `#!/usr/bin/env bun
const installPath = require("node:fs").readFileSync(${JSON.stringify(pluginPath)}, "utf8");
console.log(JSON.stringify([{ id: "jig@jig", scope: "user", installPath }]));
`,
  );
  writeFakeProgram(
    join(bin, "codex"),
    `#!/usr/bin/env bun
console.log(JSON.stringify({ installed: [] }));
`,
  );
  for (const name of ["systemctl", "crontab", "launchctl"])
    writeFakeProgram(join(bin, name), schedulerFake(name, state, units));
  const jobFile = (name: string) =>
    variant === "systemd"
      ? join(units, `${name}.timer`)
      : join(
          home,
          "Library",
          "LaunchAgents",
          `dev.${name.replace("-", ".")}.plist`,
        );
  return {
    root,
    home,
    repo,
    plugin,
    env,
    variant,
    state,
    jig: (args) =>
      Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          `--config=${join(plugin, "gc", "bunfig.toml")}`,
          join(plugin, "jig.ts"),
          ...args,
        ],
        { cwd: repo, env, stdout: "pipe", stderr: "pipe", timeout: 60000 },
      ),
    movePlugin: (directory) => writeFileSync(pluginPath, directory),
    hasJob: (name) =>
      variant === "cron"
        ? existsSync(join(state, "crontab")) &&
          readFileSync(join(state, "crontab"), "utf8").includes(`# ${name}\n`)
        : existsSync(jobFile(name)),
    writeDispatchFile: () => {
      const config = join(root, "config-a");
      mkdirSync(config, { recursive: true });
      mkdirSync(join(home, ".jig"), { recursive: true });
      writeFileSync(
        join(home, ".jig", "dispatch.yaml"),
        dump({
          repositories: [{ path: repo, stages: ["rearm"] }],
          accounts: [
            {
              name: "a",
              vendor: "claude",
              config_dir: config,
              identity: "a@example.com",
            },
          ],
        }),
      );
    },
  };
}
