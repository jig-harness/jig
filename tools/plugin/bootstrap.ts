#!/usr/bin/env bun
/** Read-only setup preflight shared by the shell and PowerShell entry points. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  commandTimeoutMs,
  harnessesExit,
  prepareHarnesses,
  upgradeHarnesses,
} from "../../plugin/runtime/harness.ts";
import { parse } from "./setup.ts";
import { isLocalSource } from "../../plugin/runtime/harness-source.ts";

class BootstrapError extends Error {}

export function parseBootstrap(argv: string[]) {
  const setup: string[] = [];
  let apply = false;
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] as string;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    setup.push(arg);
    if (arg === "--source" || arg === "--channel") {
      const next = argv[++at];
      if (!next || next.startsWith("--"))
        throw new BootstrapError(`${arg} needs a value`);
      setup.push(next);
    }
  }
  // Validate through the existing parser; it owns source/channel semantics.
  const request = parse(setup);
  if (request.check)
    throw new BootstrapError(
      "Use setup.ts --check for an installed-plugin check",
    );
  return { apply, setup };
}

export function requireVersion(tool: string, text: string, minimum: string) {
  const found = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0];
  if (!found)
    throw new BootstrapError(`${tool}: unreadable version: ${text.trim()}`);
  const a = found.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) break;
    if ((a[i] ?? 0) < (b[i] ?? 0))
      throw new BootstrapError(
        `${tool} requires ${minimum} or later; found ${found}`,
      );
  }
  console.log(`${tool}: ${found}`);
}

export function githubRepository(source: string, git?: boolean): string | null {
  if (isLocalSource(source, git)) return null;
  if (/^[\w.-]+\/[\w.-]+(?:#[^\s]+)?$/.test(source)) {
    return source.split("#")[0] ?? null;
  }
  const match = source.match(
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#[^\s]+)?$/,
  );
  if (!match?.[1])
    throw new BootstrapError(
      "Bootstrap access checks support GitHub HTTPS sources or local directories; use setup.ts for other transports",
    );
  return match[1];
}

function run(program: string, args: string[]) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: commandTimeoutMs(),
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0)
    throw new BootstrapError(
      `${program} ${args.join(" ")} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}): ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim())}. Authenticate explicitly with gh auth login --hostname github.com if needed; bootstrap never signs in.`,
      { cause: result.error },
    );
  return result.stdout.trim();
}

/** A managed machine needs its administrator, rather than a guessed policy interpretation. */
function checkManagedPolicy() {
  const paths =
    process.platform === "win32"
      ? [
          join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "ClaudeCode",
            "managed-settings.json",
          ),
          join(
            process.env.ProgramData ?? "C:\\ProgramData",
            "codex",
            "requirements.toml",
          ),
        ]
      : [
          "/etc/claude-code/managed-settings.json",
          "/Library/Application Support/ClaudeCode/managed-settings.json",
          "/etc/codex/requirements.toml",
        ];
  for (const path of paths)
    if (existsSync(path))
      throw new BootstrapError(
        `Managed policy exists at ${path}; ask its administrator to approve installation using the agent CLI. Bootstrap does not override policy.`,
      );
  // User requirements can also restrict Codex; the agent enforces remote policy.
  const requirements = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "requirements.toml",
  );
  if (existsSync(requirements))
    throw new BootstrapError(
      `Managed policy exists at ${requirements}; obtain administrator guidance before setup`,
    );
  console.log(
    "No local managed-policy files found; agent marketplace commands retain enforcement of remote policy.",
  );
}

export function bootstrap(argv: string[]) {
  const { apply, setup } = parseBootstrap(argv);
  console.log(
    `Platform: ${process.platform}/${process.arch}; shell: ${process.env.SHELL ?? process.env.ComSpec ?? "unknown"}`,
  );
  const pins = readFileSync(
    join(import.meta.dirname, "../../mise.toml"),
    "utf8",
  );
  const bun = pins.match(/^bun = "([\d.]+)"/m)?.[1];
  if (!bun)
    throw new BootstrapError(
      "Cannot read the required Bun version from mise.toml",
    );
  requireVersion("bun", Bun.version, bun);
  requireVersion("git", run("git", ["--version"]), "2.36.0");
  requireVersion("gh", run("gh", ["--version"]), "2.48.0");
  checkManagedPolicy();
  run("gh", ["auth", "status", "--hostname", "github.com"]);
  console.log(
    `GitHub identity: ${run("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"])}`,
  );
  const request = parse(setup);
  const plans = prepareHarnesses(request);
  for (const plan of plans) {
    const repository = githubRepository(plan.source, plan.registered?.git);
    if (repository)
      run("gh", [
        "api",
        "--hostname",
        "github.com",
        `repos/${repository}`,
        "--jq",
        ".full_name",
      ]);
    requireVersion(
      plan.harness,
      run(plan.harness, ["--version"]),
      plan.harness === "claude" ? "2.1.292" : "0.159.0",
    );
  }
  console.log(
    "Plan: install/update jig@jig through each selected agent marketplace, preserving its source/ref. No login, shell profile or scheduler activation.",
  );
  if (!apply) {
    console.log(
      "Preview only. Rerun with --apply to authorize the plugin changes above.",
    );
    return 0;
  }
  const status = harnessesExit(
    plans.flatMap((plan) => {
      const source =
        !plan.registered &&
        !existsSync(request.source) &&
        /^[\w.-]+\/[\w.-]+(?:#[^\s]+)?$/.test(request.source)
          ? `https://github.com/${request.source}`
          : request.source;
      return upgradeHarnesses({ ...request, source, only: plan.harness });
    }),
  );
  console.log(
    "Schedulers remain explicit: inspect jig doctor, then use jig install only for jobs you want.",
  );
  return status;
}

if (import.meta.main) cli(() => bootstrap(process.argv.slice(2)));
