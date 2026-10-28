/**
 * The `docs` section of the repository's configuration, with every value
 * detected from the tree when it is not set: the docs tree's root, the
 * frontmatter schema, and the age at which a draft counts as stale.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { readConfig, withSource } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";

export const FIELDS = ["root", "schema", "stale_after_days"] as const;

/** M4's wiki-lint table: content older than six months is stale. */
export const DEFAULT_STALE_AFTER_DAYS = 180;

/** Where a docs tree usually lives, in the order they are tried. */
export const ROOT_CANDIDATES = ["docs", "doc", "documentation"];

/** The names M4's schema template is copied under. */
const SCHEMA_NAMES = new Set([
  ".frontmatter-schema.yaml",
  ".frontmatter-schema.yml",
  "frontmatter-schema.yaml",
  "frontmatter-schema.yml",
]);

/** Folders a schema search never enters. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export class SettingsError extends Error {}

export interface DocsSettings {
  /** The docs tree, relative to the repository root; null when there is none. */
  root: string | null;
  /** The frontmatter schema, relative to the root; null when there is none. */
  schema: string | null;
  staleAfterDays: number;
  /** Which values were detected rather than configured. */
  detected: { root: boolean; schema: boolean };
}

export const isDir = (path: string) =>
  existsSync(path) && statSync(path).isDirectory();

const posixPath = (path: string) => path.split(sep).join("/");

/**
 * A repository-relative path in the spelling git prints: `/` separators, no
 * leading `./`, no trailing `/`, no `.` or `..` segments. The root is a
 * prefix the pass matches git's paths against, so `./docs/` must read `docs`.
 */
export const canonicalPath = (path: string) =>
  posix.normalize(posixPath(path)).replace(/\/+$/, "") || ".";

/**
 * A docs path (repository-relative) as the path it resolves to, symbolic
 * links followed, or a refusal naming it when that leads outside the
 * repository. The gates read and the index writes under the docs root, so a
 * root that leads out of the repository would let one repository's
 * configuration overwrite files in another. An alias inside the repository
 * becomes its target, because git reports files by their real path: a
 * pathspec or prefix filter written with the alias would match none of them.
 */
function confined<T extends string | null>(
  repo: string,
  key: string,
  path: T,
): T {
  if (path === null) return path;
  const to = relative(realpathSync(repo), realpathSync(join(repo, path)));
  if (isAbsolute(to) || to.split(sep)[0] === "..")
    throw new SettingsError(
      `docs.${key} names ${path}, which leads outside the repository`,
    );
  return canonicalPath(to || ".") as T;
}

/** A configured path: nonempty text naming something that exists. */
function configuredPath(
  section: Record<string, unknown>,
  key: string,
  repo: string,
): string | undefined {
  const value = section[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new SettingsError(`docs.${key} must be a path (nonempty text)`);
  if (!existsSync(join(repo, value)))
    throw new SettingsError(`docs.${key} names ${value}, which does not exist`);
  return canonicalPath(value);
}

function staleAfter(section: Record<string, unknown>): number {
  const value = section.stale_after_days;
  if (value === undefined || value === null) return DEFAULT_STALE_AFTER_DAYS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new SettingsError(
      "docs.stale_after_days must be a whole number of days, 1 or more",
    );
  return value;
}

/** Byte order of two strings, the same on every machine and locale. */
export const byteOrder = (a: string, b: string) =>
  Number(a > b) - Number(a < b);

/** A folder's entries in byte order of their names. */
const entriesOf = (folder: string) =>
  readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
    byteOrder(a.name, b.name),
  );

/** A file, or a symbolic link to one; where the link leads is `confined`'s. */
const isFileOrLinkToFile = (path: string) =>
  existsSync(path) && statSync(path).isFile();

/** The schema file directly in `folder`, repository-relative, or null. */
function schemaIn(repo: string, folder: string): string | null {
  const hit = entriesOf(folder).find(
    (entry) =>
      SCHEMA_NAMES.has(entry.name) && isFileOrLinkToFile(join(folder, entry.name)),
  );
  return hit ? posixPath(relative(repo, join(folder, hit.name))) : null;
}

/** The folders a schema search enters below `folder`. */
const subfolders = (folder: string) =>
  entriesOf(folder)
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
    .map((entry) => join(folder, entry.name));

/** The first schema file under `dir`, shallowest first, then by name. */
export function findSchema(repo: string, dir: string): string | null {
  for (
    let level = [join(repo, dir)];
    level.length;
    level = level.flatMap(subfolders).sort(byteOrder)
  )
    for (const folder of level) {
      const found = schemaIn(repo, folder);
      if (found) return found;
    }
  return null;
}

/** Check the `docs` section and fill in what it leaves out. */
export function parseDocsSettings(
  section: unknown,
  repo: string,
): DocsSettings {
  const value = section ?? {};
  if (!isRecord(value)) throw new SettingsError("docs must be a mapping");
  for (const key of Object.keys(value))
    if (!(FIELDS as readonly string[]).includes(key))
      throw new SettingsError(
        `docs has unknown field ${key} (known: ${FIELDS.join(", ")})`,
      );
  const configuredRoot = configuredPath(value, "root", repo);
  const root = confined(
    repo,
    "root",
    configuredRoot ??
      ROOT_CANDIDATES.find((dir) => isDir(join(repo, dir))) ??
      null,
  );
  const configuredSchema = configuredPath(value, "schema", repo);
  const schema = confined(
    repo,
    "schema",
    configuredSchema ?? (root === null ? null : findSchema(repo, root)),
  );
  return {
    root,
    schema,
    staleAfterDays: staleAfter(value),
    detected: {
      root: configuredRoot === undefined,
      schema: configuredSchema === undefined,
    },
  };
}

/** The settings from every configuration layer, an error naming its source. */
export function loadDocsSettings(repo: string): DocsSettings {
  const values = readConfig();
  try {
    return parseDocsSettings(values.docs, repo);
  } catch (error) {
    throw new SettingsError(withSource(values, "docs", error).message, {
      cause: error,
    });
  }
}
