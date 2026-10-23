/**
 * The `reflection` configuration section, read through the shared layered
 * reader. Reflection is on only when some layer has the section and it does
 * not say `enabled: false`; every caller asks `reflectionSettings()` and does
 * nothing when it is off, so the switch is decided by scripts, not by
 * instructions.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  consumerRoot,
  readConfig,
  withSource,
} from "../../../../shared/consumer.ts";
import { isMapping, jigHome } from "../../../../shared/config-layers.ts";
import { notionId } from "./notion/ids.ts";

/** A `reflection` setting that cannot be used, naming the field. */
export class SettingError extends Error {
  override name = "SettingError";
}

export const STORE_KINDS = [
  "filesystem",
  "command",
  "notion",
  "github",
] as const;
export type StoreKind = (typeof STORE_KINDS)[number];
export const MODES = ["quick", "comprehensive"] as const;
export type Mode = (typeof MODES)[number];

export interface ReflectionSettings {
  on: true;
  store: StoreKind;
  /** The filesystem store's folder, absolute. */
  path: string;
  /** The `command` store's argument list. */
  command: string[] | null;
  /** The Notion store's database id. */
  notionDatabase: string | null;
  /** The GitHub store's repository, `owner/name`. */
  githubRepository: string | null;
  /** The journal's path when configured, absolute; null for the default. */
  journal: string | null;
  escalateAfter: number;
  timeoutSec: number;
  mode: Mode;
}

/**
 * Reflection off. `journal` is the configured journal when the section is
 * present but switched off: parking still has to find findings noted there
 * while it was on.
 */
export type Reflection =
  | ReflectionSettings
  | { on: false; journal?: string | null };

const DEFAULTS = {
  store: "filesystem" as StoreKind,
  escalateAfter: 3,
  timeoutSec: 120,
  mode: "quick" as Mode,
};

/** `~` and `~/…` name the home directory; a relative path is the repository's. */
export function expandPath(raw: string, root = consumerRoot()): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\"))
    return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

/**
 * Split a command line into words: spaces separate them, single or double
 * quotes keep spaces inside one, and no shell runs it, so the same setting
 * behaves alike on every operating system.
 */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  // A word is a run of unquoted non-space characters and quoted stretches.
  const word = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;
  for (const match of line.matchAll(word))
    words.push(match[0].replace(/'([^']*)'|"([^"]*)"/g, "$1$2"));
  const rest = line.replace(word, "");
  const unclosed = /['"]/.exec(rest);
  if (unclosed !== null)
    throw new SettingError(`unclosed ${unclosed[0]} in "${line}"`);
  return words;
}

const KNOWN = [
  "enabled",
  "store",
  "path",
  "command",
  "notion",
  "github",
  "journal",
  "escalate_after",
  "timeout_sec",
  "mode",
];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly unknown[]).includes(value))
    throw new SettingError(
      `reflection.${field} must be one of ${allowed.join(", ")}`,
    );
  return value as T;
}

/**
 * The longest store deadline, in seconds: `list` and `diagnose` get five
 * times it, and a timer longer than about 24.8 days fires at once.
 */
export const MAX_TIMEOUT_SEC = 86_400;

function positiveWhole(
  value: unknown,
  field: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new SettingError(
      `reflection.${field} must be a whole number of at least 1`,
    );
  if ((value as number) > max)
    throw new SettingError(`reflection.${field} must be at most ${max}`);
  return value as number;
}

function pathSetting(
  value: unknown,
  field: string,
  root: string,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "")
    throw new SettingError(`reflection.${field} must be a path`);
  return expandPath(value, root);
}

function commandSetting(value: unknown): string[] | null {
  if (value === undefined) return null;
  const words =
    typeof value === "string"
      ? splitWords(value)
      : Array.isArray(value) && value.every((word) => typeof word === "string")
        ? (value as string[])
        : null;
  if (words === null)
    throw new SettingError(
      "reflection.command must be a command line or a list of words",
    );
  if (words.length === 0) throw new SettingError("reflection.command is empty");
  return words;
}

/** `reflection.notion`: the database's id, from an id or a link. */
function notionSetting(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isMapping(value))
    throw new SettingError("reflection.notion must be a mapping");
  const unknown = Object.keys(value).find((key) => key !== "database");
  if (unknown !== undefined)
    throw new SettingError(
      `reflection.notion.${unknown} is not a Notion store setting (known: database)`,
    );
  const id =
    typeof value.database === "string" ? notionId(value.database) : null;
  if (id === null)
    throw new SettingError(
      "reflection.notion.database must be a Notion database id or link",
    );
  return id;
}

/**
 * An `owner/name` GitHub repository: an owner of letters, digits and single
 * inner hyphens, and a name of letters, digits, `.`, `_` and `-`.
 */
const GITHUB_REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** `reflection.github`: the repository the store keeps its issues in. */
export function githubSetting(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isMapping(value))
    throw new SettingError("reflection.github must be a mapping");
  const unknown = Object.keys(value).find((key) => key !== "repository");
  if (unknown !== undefined)
    throw new SettingError(
      `reflection.github.${unknown} is not a GitHub store setting (known: repository)`,
    );
  const repository =
    typeof value.repository === "string" ? value.repository.trim() : "";
  const name = repository.split("/")[1];
  if (!GITHUB_REPOSITORY.test(repository) || name === "." || name === "..")
    throw new SettingError(
      "reflection.github.repository must be a GitHub repository as owner/name",
    );
  return repository;
}

/** A store's own setting, required when that store is the chosen one. */
function requiredFor<T>(
  store: StoreKind,
  kind: StoreKind,
  value: T | null,
  field: string,
): T | null {
  if (store === kind && value === null)
    throw new SettingError(
      `reflection.store is ${kind}, so ${field} is required`,
    );
  return value;
}

/** The settings of the stores other than the filesystem's. */
function storeSettings(
  section: Record<string, unknown>,
  store: StoreKind,
): Pick<ReflectionSettings, "command" | "notionDatabase" | "githubRepository"> {
  return {
    command: requiredFor(
      store,
      "command",
      commandSetting(section.command),
      "reflection.command",
    ),
    notionDatabase: requiredFor(
      store,
      "notion",
      notionSetting(section.notion),
      "reflection.notion.database",
    ),
    githubRepository: requiredFor(
      store,
      "github",
      githubSetting(section.github),
      "reflection.github.repository",
    ),
  };
}

/** Parse the merged `reflection` section; `undefined` means off. */
export function parseReflection(
  section: unknown,
  root = consumerRoot(),
): Reflection {
  if (section === undefined || section === null) return { on: false };
  if (!isMapping(section))
    throw new SettingError("reflection must be a mapping");
  const unknown = Object.keys(section).find((key) => !KNOWN.includes(key));
  if (unknown !== undefined)
    throw new SettingError(
      `reflection.${unknown} is not a reflection setting (known: ${KNOWN.join(", ")})`,
    );
  if (section.enabled !== undefined && typeof section.enabled !== "boolean")
    throw new SettingError("reflection.enabled must be true or false");
  if (section.enabled === false)
    return section.journal === undefined
      ? { on: false }
      : { on: false, journal: pathSetting(section.journal, "journal", root) };
  const store = oneOf(section.store, STORE_KINDS, "store", DEFAULTS.store);
  return {
    on: true,
    store,
    // Before the other settings, so a store's missing setting is reported first.
    ...storeSettings(section, store),
    path:
      pathSetting(section.path, "path", root) ?? join(jigHome(), "reflections"),
    journal: pathSetting(section.journal, "journal", root),
    escalateAfter: positiveWhole(
      section.escalate_after,
      "escalate_after",
      DEFAULTS.escalateAfter,
    ),
    timeoutSec: positiveWhole(
      section.timeout_sec,
      "timeout_sec",
      DEFAULTS.timeoutSec,
      MAX_TIMEOUT_SEC,
    ),
    mode: oneOf(section.mode, MODES, "mode", DEFAULTS.mode),
  };
}

/** The repository's reflection settings, from every configuration layer. */
export function reflectionSettings(): Reflection {
  const values = readConfig();
  try {
    return parseReflection(values.reflection);
  } catch (error) {
    throw withSource(values, "reflection", error);
  }
}

/**
 * Whether reflection is on, for a skill that only asks for it: `true`,
 * `false`, or the configuration error that makes the answer unknown, which
 * the caller reports and reads as off.
 */
export function reflectionSwitch(): boolean | Error {
  try {
    return reflectionSettings().on;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
