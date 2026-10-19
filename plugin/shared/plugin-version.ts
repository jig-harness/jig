/**
 * The version of the plugin a script runs from, for the commands that print
 * which version they ran as.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMapping } from "./config-layers.ts";

/** The version a plugin's manifest under `root` names, or `null` when neither manifest is there. */
export function manifestVersion(root: string): string | null {
  for (const manifest of [".claude-plugin", ".codex-plugin"]) {
    const path = join(root, manifest, "plugin.json");
    if (!existsSync(path)) continue;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = isMapping(parsed) ? parsed.version : undefined;
    if (typeof version === "string") return version;
  }
  return null;
}

/**
 * The version of the plugin this code belongs to, from its manifest, or
 * `null` when neither manifest is beside `shared/`.
 */
export function pluginVersion(): string | null {
  return manifestVersion(dirname(import.meta.dir));
}
