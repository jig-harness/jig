/**
 * consumer-config.ts: package-manager detection from the lockfile, and the
 * overlay values with their fallbacks. Each case builds a scratch repository
 * and runs the script from a directory outside this one, as the plugin cache
 * does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageManager } from "../scripts/consumer-config.ts";

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

function runConfig(): { code: number; out: string; err: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "JIG_OVERLAY") env[k] = v;
  env.JIG_CONSUMER_ROOT = repo;
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe("detectPackageManager", () => {
  const cases: [string, string, string, string][] = [
    ["bun.lock", "bun", "bun install --frozen-lockfile", "bun install"],
    ["bun.lockb", "bun", "bun install --frozen-lockfile", "bun install"],
    [
      "pnpm-lock.yaml",
      "pnpm",
      "pnpm install --frozen-lockfile",
      "pnpm install",
    ],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile", "yarn install"],
    ["package-lock.json", "npm", "npm ci", "npm install"],
    ["npm-shrinkwrap.json", "npm", "npm ci", "npm install"],
  ];
  for (const [lockfile, name, install, relock] of cases)
    it(`${lockfile} means ${name}`, () => {
      touch(lockfile);
      expect(detectPackageManager(repo)).toEqual({
        found: { lockfile, name, install, relock },
        others: [],
      });
    });

  it("prefers the lockfile of the manager package.json declares", () => {
    touch("bun.lock", "pnpm-lock.yaml");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.30.1" }),
    );
    expect(detectPackageManager(repo)).toMatchObject({
      found: { lockfile: "pnpm-lock.yaml", name: "pnpm" },
      others: ["bun.lock"],
    });
  });

  it("modern Yarn (with .yarnrc.yml) uses --immutable", () => {
    touch("yarn.lock", ".yarnrc.yml");
    expect(detectPackageManager(repo).found?.install).toBe(
      "yarn install --immutable",
    );
  });

  it("several lockfiles: the first wins and the rest are reported", () => {
    touch("package-lock.json", "pnpm-lock.yaml");
    expect(detectPackageManager(repo)).toMatchObject({
      found: { name: "pnpm" },
      others: ["package-lock.json"],
    });
  });

  it("no lockfile: nothing detected", () => {
    expect(detectPackageManager(repo)).toEqual({ found: null, others: [] });
  });
});

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
