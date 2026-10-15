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
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import {
  isMapping,
  jigHome,
} from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { notionId } from "./notion/ids.ts";

export const STORE_KINDS = ["filesystem", "command", "notion"] as const;
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
    throw new Error(`unclosed ${unclosed[0]} in "${line}"`);
  return words;
}

const KNOWN = [
  "enabled",
  "store",
  "path",
  "command",
  "notion",
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
    throw new Error(`reflection.${field} must be one of ${allowed.join(", ")}`);
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
    throw new Error(`reflection.${field} must be a whole number of at least 1`);
  if ((value as number) > max)
    throw new Error(`reflection.${field} must be at most ${max}`);
  return value as number;
}

function pathSetting(
  value: unknown,
  field: string,
  root: string,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`reflection.${field} must be a path`);
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
    throw new Error(
      "reflection.command must be a command line or a list of words",
    );
  if (words.length === 0) throw new Error("reflection.command is empty");
  return words;
}

/** `reflection.notion`: the database's id, from an id or a link. */
function notionSetting(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isMapping(value)) throw new Error("reflection.notion must be a mapping");
  const unknown = Object.keys(value).find((key) => key !== "database");
  if (unknown !== undefined)
    throw new Error(
      `reflection.notion.${unknown} is not a Notion store setting (known: database)`,
    );
  const id =
    typeof value.database === "string" ? notionId(value.database) : null;
  if (id === null)
    throw new Error(
      "reflection.notion.database must be a Notion database id or link",
    );
  return id;
}

/** Parse the merged `reflection` section; `undefined` means off. */
export function parseReflection(
  section: unknown,
  root = consumerRoot(),
): Reflection {
  if (section === undefined || section === null) return { on: false };
  if (!isMapping(section)) throw new Error("reflection must be a mapping");
  const unknown = Object.keys(section).find((key) => !KNOWN.includes(key));
  if (unknown !== undefined)
    throw new Error(
      `reflection.${unknown} is not a reflection setting (known: ${KNOWN.join(", ")})`,
    );
  if (section.enabled !== undefined && typeof section.enabled !== "boolean")
    throw new Error("reflection.enabled must be true or false");
  if (section.enabled === false)
    return section.journal === undefined
      ? { on: false }
      : { on: false, journal: pathSetting(section.journal, "journal", root) };
  const store = oneOf(section.store, STORE_KINDS, "store", DEFAULTS.store);
  const command = commandSetting(section.command);
  if (store === "command" && command === null)
    throw new Error(
      "reflection.store is command, so reflection.command is required",
    );
  const notionDatabase = notionSetting(section.notion);
  if (store === "notion" && notionDatabase === null)
    throw new Error(
      "reflection.store is notion, so reflection.notion.database is required",
    );
  return {
    on: true,
    store,
    path:
      pathSetting(section.path, "path", root) ?? join(jigHome(), "reflections"),
    command,
    notionDatabase,
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
