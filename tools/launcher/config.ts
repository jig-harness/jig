/**
 * The launcher's machine-level configuration.
 *
 * It lives in the user's home, not in a repository: the tracker starts the
 * launcher before any repository is known, and the launcher routes an issue to
 * one of several. Everything an organization chooses is here (which tracker,
 * which workspace provider, which label group names the repository, where each
 * repository lives for that provider); the mechanism carries no such values.
 *
 * Without a file the launcher still works: Linear, Conductor, the default skill
 * and no routing, so the provider falls back to its own repository detection.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_SCHEMA, load, type Type, types } from "js-yaml";
import { isRecord } from "../../lib/record.ts";

// js-yaml exports its built-in types at run time; its type declarations omit them.
declare module "js-yaml" {
  export const types: { merge: Type };
}

// The default schema without timestamp coercion: every value stays
// JSON-shaped, so a date-like scalar is a string rather than a Date that would
// pass the mapping check, and `<<: *anchor` still merges a shared mapping in.
const CONFIG_SCHEMA = CORE_SCHEMA.extend({ implicit: [types.merge] });

export const DEFAULT_SKILL = "/jig:do-item";
export const DEFAULT_TRACKER = "linear";
export const DEFAULT_PROVIDER = "conductor";
export const DEFAULT_REPO_LABEL_GROUP = "Repo";

export interface LauncherConfig {
  /** Which issue tracker the issue is read from. */
  tracker: string;
  /** Which workspace provider opens the issue. */
  provider: string;
  /** The slash command that starts the work; the issue key follows it. */
  skill: string;
  /** The tracker label group whose value names the repository. */
  repoLabelGroup: string;
  /** Repository label -> settings per provider (`conductor`, later `herdr`). */
  repos: Record<string, Record<string, unknown>>;
}

export function configPath(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.JIG_LAUNCHER_CONFIG?.trim();
  return override ? override : join(home, ".linear", "launcher.yaml");
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  path: string,
): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${path}: ${key} must be a non-empty string`);
  return value.trim();
}

/** Parse configuration text; every error names the file and the key. */
export function parseConfig(text: string, path: string): LauncherConfig {
  const raw: unknown =
    text.trim() === "" ? {} : load(text, { schema: CONFIG_SCHEMA });
  if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
  const known = new Set([
    "tracker",
    "provider",
    "skill",
    "repo_label_group",
    "repos",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key))
      throw new Error(
        `${path}: unknown key ${key} (known: ${[...known].join(", ")})`,
      );
  // No prototype: a label is any string, `__proto__` and `constructor`
  // included, and must be stored and looked up as an ordinary key.
  const repos: LauncherConfig["repos"] = Object.create(null);
  if (raw.repos !== undefined) {
    if (!isRecord(raw.repos))
      throw new Error(`${path}: repos must be a mapping of label to settings`);
    for (const [label, settings] of Object.entries(raw.repos)) {
      if (!isRecord(settings))
        throw new Error(
          `${path}: repos.${label} must map a provider name to its settings`,
        );
      repos[label] = settings;
    }
  }
  const skill = optionalString(raw, "skill", DEFAULT_SKILL, path);
  if (!skill.startsWith("/") || /\s/.test(skill))
    throw new Error(
      `${path}: skill must be one slash command, e.g. ${DEFAULT_SKILL}`,
    );
  return {
    tracker: optionalString(raw, "tracker", DEFAULT_TRACKER, path),
    provider: optionalString(raw, "provider", DEFAULT_PROVIDER, path),
    skill,
    repoLabelGroup: optionalString(
      raw,
      "repo_label_group",
      DEFAULT_REPO_LABEL_GROUP,
      path,
    ),
    repos,
  };
}

/** Read the configuration, or the defaults when the file does not exist. */
export function loadConfig(
  home: string,
  env: Record<string, string | undefined> = process.env,
): LauncherConfig {
  const path = configPath(home, env);
  if (!existsSync(path)) return parseConfig("", path);
  return parseConfig(readFileSync(path, "utf8"), path);
}
