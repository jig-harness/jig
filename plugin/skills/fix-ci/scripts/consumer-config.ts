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

import { fail, runMain } from "../../../shared/cli.ts";
import {
  configSource,
  consumerRoot,
  hasRepositoryConfig,
  overlayPath,
  readConfig,
} from "../../../shared/consumer.ts";
import { detectPackageManager } from "../../../shared/detect.ts";

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
