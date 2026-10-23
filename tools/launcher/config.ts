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

/** A configuration file the launcher cannot use; the message names the file and the key. */
export class LauncherConfigError extends Error {
  override name = "LauncherConfigError";
}

/**
 * Run a step that reads, resolves or checks the configuration at `path`, so
 * every failure is a LauncherConfigError naming the file, the original kept
 * as its cause.
 */
export function configStep<T>(path: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof LauncherConfigError) throw error;
    throw new LauncherConfigError(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export const DEFAULT_SKILL = "/jig:do-item";
export const DEFAULT_TRACKER = "linear";
export const DEFAULT_PROVIDER = "conductor";
export const DEFAULT_REPO_LABEL_GROUP = "Repo";

export interface LauncherConfig {
  /** Which issue tracker the issue is read from. */
  tracker: string;
  /**
   * The workspace providers in order of preference: an issue opens with the
   * first one its repository has settings for, else the first one.
   */
  providers: [string, ...string[]];
  /** The slash command that starts the work; the issue key follows it. */
  skill: string;
  /** The tracker label group whose value names the repository. */
  repoLabelGroup: string;
  /** Repository label -> settings per provider (`conductor`, `herdr`). */
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
    throw new LauncherConfigError(`${path}: ${key} must be a non-empty string`);
  return value.trim();
}

/** `provider`: one name, or a list of distinct names in order of preference. */
function providerList(
  raw: Record<string, unknown>,
  path: string,
): [string, ...string[]] {
  const value = raw.provider;
  if (value === undefined) return [DEFAULT_PROVIDER];
  const names = Array.isArray(value) ? value : [value];
  if (
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || name.trim() === "")
  )
    throw new LauncherConfigError(
      `${path}: provider must be a non-empty string or a list of them`,
    );
  const [first, ...rest] = names.map((name) => (name as string).trim());
  if (first === undefined || new Set([first, ...rest]).size !== rest.length + 1)
    throw new LauncherConfigError(
      `${path}: provider lists a name more than once`,
    );
  return [first, ...rest];
}

/** Parse configuration text; every error names the file and the key. */
export function parseConfig(text: string, path: string): LauncherConfig {
  const raw: unknown =
    text.trim() === ""
      ? {}
      : configStep(path, () => load(text, { schema: CONFIG_SCHEMA }));
  if (!isRecord(raw))
    throw new LauncherConfigError(`${path}: expected a mapping`);
  const known = new Set([
    "tracker",
    "provider",
    "skill",
    "repo_label_group",
    "repos",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key))
      throw new LauncherConfigError(
        `${path}: unknown key ${key} (known: ${[...known].join(", ")})`,
      );
  // No prototype: a label is any string, `__proto__` and `constructor`
  // included, and must be stored and looked up as an ordinary key.
  const repos: LauncherConfig["repos"] = Object.create(null);
  if (raw.repos !== undefined) {
    if (!isRecord(raw.repos))
      throw new LauncherConfigError(
        `${path}: repos must be a mapping of label to settings`,
      );
    for (const [label, settings] of Object.entries(raw.repos)) {
      if (!isRecord(settings))
        throw new LauncherConfigError(
          `${path}: repos.${label} must map a provider name to its settings`,
        );
      repos[label] = settings;
    }
  }
  const skill = optionalString(raw, "skill", DEFAULT_SKILL, path);
  if (!skill.startsWith("/") || /\s/.test(skill))
    throw new LauncherConfigError(
      `${path}: skill must be one slash command, e.g. ${DEFAULT_SKILL}`,
    );
  return {
    tracker: optionalString(raw, "tracker", DEFAULT_TRACKER, path),
    providers: providerList(raw, path),
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
