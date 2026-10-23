#!/usr/bin/env bun
/**
 * Print the repository values the CI fix loop uses: the package manager and
 * its install commands (detected from the lockfile), the local checks
 * (`gates.command`), the validation plan command
 * (`drive.validation_plan_command`) and the regeneration commands
 * (`fix_ci.regenerate_commands`).
 *
 * Usage: bun consumer-config.ts
 *   Run from inside the repository (any directory of it). The repository
 *   root and configuration file can be overridden with
 *   JIG_CONSUMER_ROOT and JIG_OVERLAY; the user file and `JIG__` variables
 *   are read as for every skill.
 *
 * Every value has a fallback, so a repository without a configuration file
 * still gets a usable answer; the output says which values are fallbacks.
 *
 * Exit codes: 0 values printed; 2 configuration present but invalid.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import {
  configSource,
  consumerRoot,
  hasRepositoryConfig,
  overlayPath,
  readConfig,
} from "../../../shared/consumer.ts";

export interface PackageManager {
  name: string;
  lockfile: string;
  /** Install exactly what the lockfile records; fails when it is stale. */
  install: string;
  /** Install and rewrite the lockfile to match the manifests. */
  relock: string;
}

/** Lockfiles in the order they are checked; the first present one wins. */
const LOCKFILES: [
  string,
  (root: string) => Omit<PackageManager, "lockfile">,
][] = [
  [
    "bun.lock",
    () => ({
      name: "bun",
      install: "bun install --frozen-lockfile",
      relock: "bun install",
    }),
  ],
  [
    "bun.lockb",
    () => ({
      name: "bun",
      install: "bun install --frozen-lockfile",
      relock: "bun install",
    }),
  ],
  [
    "pnpm-lock.yaml",
    () => ({
      name: "pnpm",
      install: "pnpm install --frozen-lockfile",
      relock: "pnpm install",
    }),
  ],
  [
    "yarn.lock",
    // Yarn 2 and later keep their settings in .yarnrc.yml and renamed the
    // frozen-install flag.
    (root) => ({
      name: "yarn",
      install: existsSync(join(root, ".yarnrc.yml"))
        ? "yarn install --immutable"
        : "yarn install --frozen-lockfile",
      relock: "yarn install",
    }),
  ],
  [
    "package-lock.json",
    () => ({ name: "npm", install: "npm ci", relock: "npm install" }),
  ],
  [
    "npm-shrinkwrap.json",
    () => ({ name: "npm", install: "npm ci", relock: "npm install" }),
  ],
];

/**
 * The package manager `package.json` declares in its `packageManager` field
 * (`pnpm@10.1.0` → `pnpm`), or null when it declares none or cannot be read.
 */
function declaredManager(root: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { packageManager?: unknown };
    if (typeof manifest.packageManager !== "string") return null;
    return manifest.packageManager.split("@")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The package manager named by the repository's lockfile, or null. When
 * several lockfiles are present (a repository that uses one manager and keeps
 * another's lockfile for a tool), the one `package.json` declares in
 * `packageManager` wins; otherwise the first in `LOCKFILES` order.
 */
export function detectPackageManager(root: string): {
  found: PackageManager | null;
  others: string[];
} {
  const present = LOCKFILES.filter(([file]) => existsSync(join(root, file)));
  const declared = declaredManager(root);
  const preferred = present.findIndex(
    ([, manager]) => manager(root).name === declared,
  );
  if (preferred > 0) present.unshift(...present.splice(preferred, 1));
  const first = present[0];
  if (first === undefined) return { found: null, others: [] };
  return {
    found: { lockfile: first[0], ...first[1](root) },
    others: present.slice(1).map(([file]) => file),
  };
}

function section(
  overlay: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const value = overlay[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    fail(
      2,
      `consumer-config: ${name} must be an object in ${configSource(name)}`,
    );
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    fail(
      2,
      `consumer-config: ${field} must be a nonempty string (${configSource(field)})`,
    );
  return value;
}

export interface FixCiConfig {
  configuration: string | null;
  gatesCommand: string | undefined;
  validationPlanCommand: string | undefined;
  regenerateCommands: string[];
}

/** Read the values from every configuration layer; an unset value has its default. */
export function fixCiConfig(): FixCiConfig {
  let overlay: Record<string, unknown>;
  try {
    overlay = readConfig();
  } catch (err) {
    fail(2, `consumer-config: ${err instanceof Error ? err.message : err}`);
  }
  const regenerate = section(overlay, "fix_ci").regenerate_commands;
  if (
    regenerate !== undefined &&
    regenerate !== null &&
    (!Array.isArray(regenerate) ||
      regenerate.some((c) => typeof c !== "string" || c.trim() === ""))
  )
    fail(
      2,
      `consumer-config: fix_ci.regenerate_commands must be a list of nonempty commands (${configSource("fix_ci.regenerate_commands")})`,
    );
  return {
    configuration: hasRepositoryConfig() ? overlayPath() : null,
    gatesCommand: optionalText(
      section(overlay, "gates").command,
      "gates.command",
    ),
    validationPlanCommand: optionalText(
      section(overlay, "drive").validation_plan_command,
      "drive.validation_plan_command",
    ),
    regenerateCommands: (regenerate as string[] | undefined | null) ?? [],
  };
}

async function main(): Promise<number> {
  const root = consumerRoot();
  const config = fixCiConfig();
  const pm = detectPackageManager(root);
  const lines: [string, string][] = [
    ["repository", root],
    [
      "configuration",
      config.configuration ??
        `(none: ${overlayPath()} is absent; the user file, JIG__ variables and defaults apply)`,
    ],
    [
      "package_manager",
      pm.found === null
        ? "(none detected: no lockfile at the repository root)"
        : `${pm.found.name} (from ${pm.found.lockfile}${pm.others.length > 0 ? `; also found ${pm.others.join(", ")}` : ""})`,
    ],
    ["install_command", pm.found?.install ?? "(none)"],
    ["relock_command", pm.found?.relock ?? "(none)"],
    [
      "gates.command",
      config.gatesCommand ??
        "(not set: use the checks the repository's instruction file names)",
    ],
    [
      "drive.validation_plan_command",
      config.validationPlanCommand ??
        "(not set: the validation plan is gates.command)",
    ],
  ];
  for (const [key, value] of lines) console.log(`${key}: ${value}`);
  if (config.regenerateCommands.length === 0)
    console.log("fix_ci.regenerate_commands: (none)");
  else {
    console.log("fix_ci.regenerate_commands:");
    for (const command of config.regenerateCommands)
      console.log(`  - ${command}`);
  }
  return 0;
}

if (import.meta.main) runMain("consumer-config", main);
