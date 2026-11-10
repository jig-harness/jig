/**
 * The `docs` section of the repository's configuration, with every value
 * detected from the tree when it is not set: the docs tree's root, the
 * frontmatter schema, the age at which a draft counts as stale, the statuses
 * the scar lint treats as promoted, and how the generated index is laid out.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { readConfig, withSource } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";

export const FIELDS = [
  "root",
  "schema",
  "stale_after_days",
  "promoted_statuses",
  "index",
] as const;

/** The fields of `docs.index`, which shapes the generated `INDEX.md`. */
export const INDEX_FIELDS = [
  "preamble",
  "descriptions",
  "descriptions_from_readme",
  "order",
  "frontmatter",
] as const;

/** M4's wiki-lint table: content older than six months is stale. */
export const DEFAULT_STALE_AFTER_DAYS = 180;

/** The one status M4's lifecycle promotes a document to. */
export const DEFAULT_PROMOTED_STATUSES = ["approved"];

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

/** How the generated index is laid out; the defaults are the bare listing. */
export interface IndexSettings {
  /** A file, relative to the repository root, kept verbatim above the listing. */
  preamble: string | null;
  /** One line per category, by the category's name (`(root)` for loose files). */
  descriptions: Record<string, string>;
  /** A category without a description takes its `README.md`'s `description`. */
  descriptionsFromReadme: boolean;
  /** `name` (byte order), `count` (most documents first) or categories listed first. */
  order: "name" | "count" | string[];
  /** The index's frontmatter fields, `last_updated` stamped; null for none. */
  frontmatter: Record<string, string | string[]> | null;
}

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  preamble: null,
  descriptions: {},
  descriptionsFromReadme: false,
  order: "name",
  frontmatter: null,
};

export interface DocsSettings {
  /** The docs tree, relative to the repository root; null when there is none. */
  root: string | null;
  /** The frontmatter schema, relative to the repository root; null when there is none. */
  schema: string | null;
  staleAfterDays: number;
  index: IndexSettings;
  /** The `status` values of documents the scar lint holds to no review scars. */
  promotedStatuses: string[];
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

/** What a configured path must name: the root a folder, the schema a file. */
const KINDS = {
  root: { noun: "directory", is: (path: string) => isDir(path) },
  schema: { noun: "file", is: (path: string) => isFileOrLinkToFile(path) },
};

/** A configured path: nonempty text naming a thing of the key's kind. */
function configuredPath(
  section: Record<string, unknown>,
  key: keyof typeof KINDS,
  repo: string,
): string | undefined {
  const value = section[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new SettingsError(`docs.${key} must be a path (nonempty text)`);
  const path = join(repo, value);
  if (!existsSync(path))
    throw new SettingsError(`docs.${key} names ${value}, which does not exist`);
  const { noun, is } = KINDS[key];
  if (!is(path))
    throw new SettingsError(
      `docs.${key} names ${value}, which is not a ${noun}`,
    );
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

/**
 * The statuses the scar lint treats as promoted: a nonempty list of distinct
 * status values. Read on its own by the lint, which runs without the rest of
 * the section.
 */
export function promotedStatuses(section: unknown): string[] {
  if (section !== undefined && section !== null && !isRecord(section))
    throw new SettingsError("docs must be a mapping");
  const value = isRecord(section) ? section.promoted_statuses : undefined;
  if (value === undefined || value === null) return DEFAULT_PROMOTED_STATUSES;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (status) => typeof status !== "string" || !/^\S+$/.test(status),
    ) ||
    new Set(value).size !== value.length
  )
    throw new SettingsError(
      "docs.promoted_statuses must be a list of distinct statuses, each one word",
    );
  return value;
}

/** Nonempty text on one line. */
const oneLine = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value);

/** A frontmatter value the index can write as a plain scalar or a flow list. */
const frontmatterValue = (value: unknown): value is string | string[] =>
  Array.isArray(value)
    ? value.length > 0 &&
      value.every((item) => oneLine(item) && !/[,[\]]/.test(item))
    : oneLine(value);

function indexFrontmatter(
  value: unknown,
): Record<string, string | string[]> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).length === 0)
    throw new SettingsError(
      "docs.index.frontmatter must be a mapping of field to value",
    );
  const fields: Record<string, string | string[]> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w-]*$/.test(key) || key === "last_updated")
      throw new SettingsError(
        `docs.index.frontmatter has field ${key}, which is not a name it can write (last_updated is stamped)`,
      );
    if (!frontmatterValue(field))
      throw new SettingsError(
        `docs.index.frontmatter.${key} must be one line of text, or a list of such words without commas or brackets`,
      );
    fields[key] = field;
  }
  return fields;
}

function indexOrder(value: unknown): IndexSettings["order"] {
  if (value === undefined || value === null) return "name";
  if (value === "name" || value === "count") return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(oneLine) &&
    new Set(value).size === value.length
  )
    return value;
  throw new SettingsError(
    "docs.index.order must be name, count, or a list of distinct category names",
  );
}

function indexDescriptions(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || !Object.values(value).every((text) => oneLine(text)))
    throw new SettingsError(
      "docs.index.descriptions must be a mapping of category name to one line of text",
    );
  return value as Record<string, string>;
}

/** Check the `docs.index` section and fill in what it leaves out. */
export function parseIndexSettings(
  section: unknown,
  repo: string,
): IndexSettings {
  if (section === undefined || section === null) return DEFAULT_INDEX_SETTINGS;
  if (!isRecord(section))
    throw new SettingsError("docs.index must be a mapping");
  for (const key of Object.keys(section))
    if (!(INDEX_FIELDS as readonly string[]).includes(key))
      throw new SettingsError(
        `docs.index has unknown field ${key} (known: ${INDEX_FIELDS.join(", ")})`,
      );
  const readme = section.descriptions_from_readme;
  if (readme !== undefined && readme !== null && typeof readme !== "boolean")
    throw new SettingsError(
      "docs.index.descriptions_from_readme must be true or false",
    );
  const preamble = section.preamble;
  if (preamble !== undefined && preamble !== null && !oneLine(preamble))
    throw new SettingsError(
      "docs.index.preamble must be a path (nonempty text)",
    );
  if (oneLine(preamble)) {
    const path = join(repo, preamble);
    if (!existsSync(path))
      throw new SettingsError(
        `docs.index.preamble names ${preamble}, which does not exist`,
      );
    if (!isFileOrLinkToFile(path))
      throw new SettingsError(
        `docs.index.preamble names ${preamble}, which is not a file`,
      );
  }
  return {
    preamble: oneLine(preamble)
      ? confined(repo, "index.preamble", canonicalPath(preamble))
      : null,
    descriptions: indexDescriptions(section.descriptions),
    descriptionsFromReadme: readme === true,
    order: indexOrder(section.order),
    frontmatter: indexFrontmatter(section.frontmatter),
  };
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
      SCHEMA_NAMES.has(entry.name) &&
      isFileOrLinkToFile(join(folder, entry.name)),
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
    index: parseIndexSettings(value.index, repo),
    promotedStatuses: promotedStatuses(value),
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

/** The `docs.index` settings from every configuration layer, an error naming its source. */
export function loadIndexSettings(repo: string): IndexSettings {
  const values = readConfig();
  try {
    const docs = values.docs;
    if (docs !== undefined && docs !== null && !isRecord(docs))
      throw new SettingsError("docs must be a mapping");
    return parseIndexSettings(isRecord(docs) ? docs.index : undefined, repo);
  } catch (error) {
    throw new SettingsError(withSource(values, "docs", error).message, {
      cause: error,
    });
  }
}

/**
 * The statuses the scar lint treats as promoted, from every configuration
 * layer, an error naming its source.
 */
export function loadPromotedStatuses(): string[] {
  const values = readConfig();
  try {
    return promotedStatuses(values.docs);
  } catch (error) {
    throw new SettingsError(withSource(values, "docs", error).message, {
      cause: error,
    });
  }
}
