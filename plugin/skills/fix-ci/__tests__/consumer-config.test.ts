/**
 * consumer-config.ts: the package manager detected from the lockfile, and the
 * overlay values with their fallbacks. Each case builds a scratch repository
 * and runs the script from a directory outside this one, as the plugin cache
 * does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "consumer-config.ts");

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fix-ci-config-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function touch(...files: string[]) {
  for (const file of files) writeFileSync(join(repo, file), "");
}

function overlay(text: string) {
  mkdirSync(join(repo, ".config"), { recursive: true });
  writeFileSync(join(repo, ".config", "jig.yaml"), text);
}

function runConfig(extra: Record<string, string> = {}): {
  code: number;
  out: string;
  err: string;
} {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "JIG_OVERLAY") env[k] = v;
  env.JIG_CONSUMER_ROOT = repo;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe("consumer-config.ts", () => {
  it("without a configuration file prints the fallbacks", () => {
    touch("pnpm-lock.yaml");
    const r = runConfig();
    expect(r.code).toBe(0);
    expect(r.out).toContain("defaults apply");
    expect(r.out).toContain("package_manager: pnpm (from pnpm-lock.yaml)");
    expect(r.out).toContain("install_command: pnpm install --frozen-lockfile");
    expect(r.out).toContain("gates.command: (not set");
    expect(r.out).toContain("drive.validation_plan_command: (not set");
    expect(r.out).toContain("fix_ci.regenerate_commands: (none)");
  });

  it("prints the configured values", () => {
    overlay(
      [
        "gates:",
        "  command: make check",
        "drive:",
        "  validation_plan_command: ./plan --stdin",
        "fix_ci:",
        "  regenerate_commands:",
        "    - make openapi",
        "    - make schema",
        "",
      ].join("\n"),
    );
    const r = runConfig();
    expect(r.code).toBe(0);
    expect(r.out).toContain("gates.command: make check");
    expect(r.out).toContain("drive.validation_plan_command: ./plan --stdin");
    expect(r.out).toContain(
      "fix_ci.regenerate_commands:\n  - make openapi\n  - make schema\n",
    );
    expect(r.out).toContain("package_manager: (none detected");
  });

  it("refuses regeneration commands that are not a list of strings", () => {
    overlay("fix_ci:\n  regenerate_commands: make openapi\n");
    const r = runConfig();
    expect(r.code).toBe(2);
    expect(r.err).toContain("fix_ci.regenerate_commands");
  });

  it("refuses an empty gate command", () => {
    overlay('gates:\n  command: ""\n');
    const r = runConfig();
    expect(r.code).toBe(2);
    expect(r.err).toContain("gates.command");
  });

  it("refuses a configuration that does not parse", () => {
    overlay("gates: [unclosed\n");
    expect(runConfig().code).toBe(2);
  });
});

describe("configuration layers", () => {
  it("reads the user file and JIG__ variables without a repository file", () => {
    const home = join(repo, "home");
    mkdirSync(home);
    writeFileSync(
      join(home, "jig.yaml"),
      "drive:\n  validation_plan_command: plan --json\n",
    );
    const r = runConfig({
      JIG_HOME: home,
      JIG__GATES__COMMAND: "make ci",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("gates.command: make ci");
    expect(r.out).toContain("drive.validation_plan_command: plan --json");
    expect(r.out).toContain("is absent; the user file");
  });
});
