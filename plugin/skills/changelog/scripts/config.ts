// The `changelog:` section of a repository's `.config/jig.yaml`: what turns
// the skill on and what it enforces. Every field describes one repository, so
// the section is read from the repository's own file only: a user file or an
// environment variable that sets any of it is refused, never merged, or a
// person's own settings could switch the skill on, or weaken what it
// enforces, in a repository that never adopted it.
import { ChangelogError } from "./errors.ts";
import { posix } from "node:path";
import {
  isMapping,
  OVERLAY_RELPATH,
  parseField,
  sourceOf,
  valueAt,
} from "../../../shared/config-layers.ts";
import { layeredConfig } from "../../../shared/consumer.ts";
import { load } from "../../../shared/yaml.ts";
import {
  detectFormat,
  FORMAT_IDS,
  type Format,
  type FormatId,
  formatOf,
} from "./formats.ts";
import { type NotesConfig, tryGit, workingTree } from "./notes-dir.ts";
import {
  type FileReader,
  isVersionFile,
  resolveVersionSource,
  type VersionFile,
  type VersionSource,
} from "./versions.ts";

/** A version placeholder: `from` is replaced by `to`, with `{version}` filled in, in the files matched. */
export interface Placeholder {
  /** Globs relative to the root. */
  files: string[];
  /** The placeholder as written, on one line, such as `since: next`. */
  from: string;
  /** What replaces it; `{version}` stands for the released version. */
  to: string;
}

export interface ChangelogConfig {
  file: string;
  /** Null: detected from the file. */
  format: FormatId | null;
  notesDir: string;
  /** Null: derived from the repository's own manifests. */
  version: VersionSource | null;
  releasePaths: string[];
  notePaths: string[];
  placeholders: Placeholder[];
  /** A command the release step runs after it moves the version; null: none. */
  afterVersion: string | null;
  /** Null: `write`, and `wait` when releases go through a pull request. */
  unreleased: "write" | "wait" | null;
  authors: boolean;
  tagPrefix: string;
  release: { push: "direct" | "pull-request"; branch: string };
}

/** Every field of the section, as the schema and CONFIGURATION.md list them. */
export const FIELDS = [
  "file",
  "format",
  "notes_dir",
  "version",
  "release_paths",
  "note_paths",
  "placeholders",
  "after_version",
  "unreleased",
  "authors",
  "tag_prefix",
  "release.push",
  "release.branch",
] as const;

export const DEFAULTS = {
  notesDir: "changes",
  authors: true,
  tagPrefix: "v",
  push: "direct",
  branch: "changelog-release",
} as const;

const WORKFLOWS = ".github/workflows/";

/** A repository-relative path: not absolute, with no `..` segment. */
function relative(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\\"))
    throw new ChangelogError(
      `${field} must be a path relative to the repository root`,
    );
  const path = value.replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes(".."))
    throw new ChangelogError(
      `${field} must stay inside the repository: not absolute, with no .. segment`,
    );
  return path;
}

/**
 * A file or a folder below the repository root: `relative`, normalised, and
 * neither the root itself (`.`, `./`) nor, for a file, a folder path.
 */
function place(field: string, value: unknown, what: "file" | "folder"): string {
  const path = relative(field, value);
  const normal = posix.normalize(path).replace(/\/+$/, "");
  if (!normal || normal === "." || (what === "file" && path.endsWith("/")))
    throw new ChangelogError(
      what === "file"
        ? `${field} must name a file below the repository root, not a folder`
        : `${field} must name a folder below the repository root, not the root itself`,
    );
  return normal;
}

function stringList(field: string, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim())
  )
    throw new ChangelogError(`${field} must be a list of nonempty strings`);
  return value as string[];
}

function pathList(field: string, value: unknown): string[] {
  return stringList(field, value).map((v, i) => relative(`${field}[${i}]`, v));
}

/** Whether a glob could match a workflow file, which the release's token may not write. */
function reachesWorkflows(pattern: string): boolean {
  if (`${pattern}/`.startsWith(WORKFLOWS) || pattern.startsWith(WORKFLOWS))
    return true;
  const glob = new Bun.Glob(pattern);
  return ["x.yml", "x.yaml", "sub/x.yml"].some((name) =>
    glob.match(`${WORKFLOWS}${name}`),
  );
}

/** Refuses a key of mapping `at` that is not one of `allowed`. */
function onlyKeys(
  at: string,
  entry: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(entry))
    if (!allowed.includes(key))
      throw new ChangelogError(
        `${at} has unknown key ${key} (${allowed.join(", ")})`,
      );
}

function placeholder(entry: unknown, at: string): Placeholder {
  if (!isMapping(entry)) throw new ChangelogError(`${at} must be a mapping`);
  onlyKeys(at, entry, ["files", "from", "to"]);
  const files = pathList(`${at}.files`, entry.files);
  if (!files.length) throw new ChangelogError(`${at}.files must name a file`);
  for (const pattern of files)
    if (reachesWorkflows(pattern))
      throw new ChangelogError(
        `${at}.files: ${pattern} could match a workflow under ${WORKFLOWS}, which the release may not change: name the files that hold the placeholder`,
      );
  const { from, to } = entry;
  if (typeof from !== "string" || !from.trim() || from.includes("\n"))
    throw new ChangelogError(`${at}.from must be one line of text`);
  if (typeof to !== "string" || to.includes("\n") || !to.includes("{version}"))
    throw new ChangelogError(`${at}.to must be one line holding {version}`);
  return { files, from, to };
}

function placeholders(value: unknown): Placeholder[] {
  const field = "changelog.placeholders";
  if (!Array.isArray(value))
    throw new ChangelogError(`${field} must be a list`);
  return value.map((entry: unknown, i) => placeholder(entry, `${field}[${i}]`));
}

function versionFile(entry: unknown, at: string): VersionFile {
  if (!isMapping(entry)) throw new ChangelogError(`${at} must be a mapping`);
  onlyKeys(at, entry, ["path", "key"]);
  const path = place(`${at}.path`, entry.path, "file");
  if (!isVersionFile(path))
    throw new ChangelogError(
      `${at}.path: ${path} is not a kind of file a version is kept in (JSON, TOML, YAML or a plain VERSION file)`,
    );
  if (/^version(\.txt)?$/i.test(path.split("/").at(-1) ?? "")) {
    if (entry.key !== undefined)
      throw new ChangelogError(
        `${at}.key is for a file with keys; ${path} holds the version alone`,
      );
    return { path, key: "" };
  }
  if (typeof entry.key !== "string" || !entry.key.trim())
    throw new ChangelogError(
      `${at}.key must name the key that holds the version`,
    );
  try {
    parseField(entry.key);
  } catch (error) {
    throw new ChangelogError(
      `${at}.key is not a key path such as project.version`,
      {
        cause: error,
      },
    );
  }
  return { path, key: entry.key };
}

function versionSetting(value: unknown): VersionSource {
  const field = "changelog.version";
  if (!isMapping(value)) throw new ChangelogError(`${field} must be a mapping`);
  onlyKeys(field, value, ["files", "tags"]);
  if ((value.files === undefined) === (value.tags === undefined))
    throw new ChangelogError(`${field} sets files or tags, one of them`);
  if (value.tags !== undefined) {
    if (value.tags !== true)
      throw new ChangelogError(`${field}.tags must be true`);
    return { kind: "tags" };
  }
  if (!Array.isArray(value.files) || !value.files.length)
    throw new ChangelogError(`${field}.files must list at least one file`);
  const files = value.files.map((entry: unknown, i) =>
    versionFile(entry, `${field}.files[${i}]`),
  );
  const seen = new Set<string>();
  files.forEach((file, i) => {
    const id = JSON.stringify([
      file.path,
      file.key ? parseField(file.key) : [],
    ]);
    if (seen.has(id))
      throw new ChangelogError(
        `${field}.files[${i}] names ${file.path}${file.key ? ` ${file.key}` : ""} again: list each version once`,
      );
    seen.add(id);
  });
  return { kind: "files", files };
}

function oneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw new ChangelogError(`${field} must be one of ${allowed.join(", ")}`);
}

/** The `release` mapping: how the release reaches the integration branch. */
function releaseSetting(value: unknown): ChangelogConfig["release"] {
  if (value === undefined)
    return { push: DEFAULTS.push, branch: DEFAULTS.branch };
  if (!isMapping(value))
    throw new ChangelogError("changelog.release must be a mapping");
  for (const key of Object.keys(value))
    if (key !== "push" && key !== "branch")
      throw new ChangelogError(
        `changelog.release.${key} is not a field (push, branch)`,
      );
  const branch = value.branch ?? DEFAULTS.branch;
  if (
    typeof branch !== "string" ||
    !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(branch)
  )
    throw new ChangelogError("changelog.release.branch must be a branch name");
  return {
    push: oneOf("changelog.release.push", value.push ?? DEFAULTS.push, [
      "direct",
      "pull-request",
    ]),
    branch,
  };
}

/** The `unreleased` setting; null when unset. */
function unreleasedSetting(
  value: unknown,
  release: ChangelogConfig["release"],
): ChangelogConfig["unreleased"] {
  if (value === undefined) return null;
  const unreleased = oneOf("changelog.unreleased", value, ["write", "wait"]);
  if (release.push === "pull-request" && unreleased === "write")
    throw new ChangelogError(
      "changelog.unreleased cannot be write when changelog.release.push is pull-request: a release pull request is opened only for a release, so a note without one waits",
    );
  return unreleased;
}

/** A field with a text value that `valid` accepts, or its default. */
function text(
  field: string,
  value: unknown,
  fallback: string,
  valid: RegExp,
  what: string,
): string {
  const given = value ?? fallback;
  if (typeof given !== "string" || !valid.test(given))
    throw new ChangelogError(`${field} must be ${what}`);
  return given;
}

function flag(field: string, value: unknown, fallback: boolean): boolean {
  const given = value ?? fallback;
  if (typeof given !== "boolean")
    throw new ChangelogError(`${field} must be true or false`);
  return given;
}

/** Refuses a key of the section that is not one of its fields. */
function refuseUnknownKeys(section: Record<string, unknown>): void {
  const known = [...FIELDS.filter((f) => !f.startsWith("release.")), "release"];
  for (const key of Object.keys(section))
    if (!known.includes(key))
      throw new ChangelogError(
        `changelog.${key} is not a changelog field (${FIELDS.join(", ")})`,
      );
}

/** The `after_version` command; null when unset. */
function commandSetting(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim())
    throw new ChangelogError("changelog.after_version must be a command");
  return value;
}

/**
 * The section as a configuration, validated; null when it does not set
 * `file`, which is what turns the skill on. A message opens with the field
 * at fault, so the reader can name where it was set.
 */
export function parseChangelogSection(
  section: unknown,
): ChangelogConfig | null {
  if (section === undefined || section === null) return null;
  if (!isMapping(section))
    throw new ChangelogError("changelog must be a mapping");
  refuseUnknownKeys(section);
  const release = releaseSetting(section.release);
  const config: ChangelogConfig = {
    file: "",
    format:
      section.format === undefined
        ? null
        : oneOf("changelog.format", section.format, FORMAT_IDS),
    notesDir: place(
      "changelog.notes_dir",
      section.notes_dir ?? DEFAULTS.notesDir,
      "folder",
    ),
    version:
      section.version === undefined ? null : versionSetting(section.version),
    releasePaths: pathList(
      "changelog.release_paths",
      section.release_paths ?? [],
    ),
    notePaths: pathList("changelog.note_paths", section.note_paths ?? []),
    placeholders: placeholders(section.placeholders ?? []),
    afterVersion: commandSetting(section.after_version),
    unreleased: unreleasedSetting(section.unreleased, release),
    authors: flag("changelog.authors", section.authors, DEFAULTS.authors),
    tagPrefix: text(
      "changelog.tag_prefix",
      section.tag_prefix,
      DEFAULTS.tagPrefix,
      /^[A-Za-z0-9._/-]*$/,
      "text a tag name may start with",
    ),
    release,
  };
  if (section.file === undefined) return null;
  config.file = place("changelog.file", section.file, "file");
  return config;
}

/** The fields under `changelog` that `values` sets, dotted. */
function setFields(values: unknown): string[] {
  if (!isMapping(values)) return ["changelog"];
  return Object.entries(values).flatMap(([key, value]) =>
    key === "release" && isMapping(value)
      ? Object.keys(value).map((k) => `changelog.release.${k}`)
      : [`changelog.${key}`],
  );
}

/**
 * The repository's configuration for the skill, read from the repository
 * layer of its configuration alone; null when it does not set
 * `changelog.file`, so the skill is off. Throws when any other layer sets a
 * field of the section, and when the section is invalid, naming the file or
 * variable at fault.
 */
export function loadChangelogConfig(
  root: string,
  env: Record<string, string | undefined> = process.env,
): ChangelogConfig | null {
  // JIG_OVERLAY names another file for the other skills; this one reads the
  // repository's own, or a variable could turn it on or swap its section.
  const layers = layeredConfig(root, { ...env, JIG_OVERLAY: undefined });
  for (const layer of layers.layers) {
    if (layer.name === "repository") continue;
    const set = valueAt(layer.values, "changelog");
    if (set === undefined) continue;
    const sources = [
      ...new Set(setFields(set).map((field) => sourceOf(layers, field))),
    ];
    throw new ChangelogError(
      `the changelog fields are read from the repository's own ${OVERLAY_RELPATH} only, but ${sources.join(", ")} sets one: a person's settings or an environment variable must not turn the skill on, or change what it enforces, in a repository that did not adopt it. Move it into the repository's file, or remove it`,
    );
  }
  const repository = layers.layers.find((l) => l.name === "repository");
  try {
    return parseChangelogSection(repository?.values.changelog);
  } catch (error) {
    throw new ChangelogError(
      `${error instanceof Error ? error.message : String(error)}: ${layers.repositoryPath}`,
    );
  }
}

/**
 * The configuration the revision `base` holds (its `.config/jig.yaml`); null
 * when it has no file or no `changelog.file`. Throws when what it holds is
 * invalid.
 */
export function configAtBase(
  root: string,
  base: string,
): ChangelogConfig | null {
  const text = tryGit(root, ["show", `${base}:${OVERLAY_RELPATH}`]);
  if (text === null) return null;
  try {
    const parsed = load(text);
    return isMapping(parsed) ? parseChangelogSection(parsed.changelog) : null;
  } catch (error) {
    throw new ChangelogError(
      `${error instanceof Error ? error.message : String(error)}: ${OVERLAY_RELPATH} at ${base}`,
    );
  }
}

/** What differs between two configurations, one `field: before → after` per change. */
export function changes(
  before: ChangelogConfig,
  after: ChangelogConfig,
): string[] {
  const out: string[] = [];
  const show = (v: unknown) => JSON.stringify(v) ?? "unset";
  const compare = (field: string, a: unknown, b: unknown) => {
    if (show(a) !== show(b))
      out.push(`changelog.${field}: ${show(a)} → ${show(b)}`);
  };
  compare("file", before.file, after.file);
  compare("format", before.format, after.format);
  compare("notes_dir", before.notesDir, after.notesDir);
  compare("version", before.version, after.version);
  compare("release_paths", before.releasePaths, after.releasePaths);
  compare("note_paths", before.notePaths, after.notePaths);
  compare("placeholders", before.placeholders, after.placeholders);
  compare("after_version", before.afterVersion, after.afterVersion);
  compare("unreleased", before.unreleased, after.unreleased);
  compare("authors", before.authors, after.authors);
  compare("tag_prefix", before.tagPrefix, after.tagPrefix);
  compare("release.push", before.release.push, after.release.push);
  compare("release.branch", before.release.branch, after.release.branch);
  return out;
}

/** A configuration with everything the commands need that the files decide. */
export interface Resolved extends NotesConfig {
  config: ChangelogConfig;
  /** Whether a note without a release is written under Unreleased at once, or waits. */
  unreleased: "write" | "wait";
}

/**
 * A placeholder's globs may not reach a file the release writes itself (the
 * changelog or a version file): its text would be computed twice.
 */
function refuseWrittenPlaceholders(
  config: ChangelogConfig,
  version: VersionSource,
): void {
  const written = [
    config.file,
    ...(version.kind === "files" ? version.files.map((f) => f.path) : []),
  ];
  for (const { files } of config.placeholders)
    for (const pattern of files) {
      const glob = new Bun.Glob(pattern);
      const claimed = written.find((path) => glob.match(path));
      if (claimed)
        throw new ChangelogError(
          `changelog.placeholders: ${pattern} matches ${claimed}, which the release writes itself: name the other files that hold the placeholder`,
        );
    }
}

/**
 * The configuration resolved against the repository as `read` sees it: the
 * format (set, or detected from the changelog), the version source (set, or
 * derived from the manifests) and when a note without a release is written.
 * Throws, naming the field to set, where the repository does not say.
 */
export function resolve(
  root: string,
  config: ChangelogConfig,
  read: FileReader,
): Resolved {
  const text = read(config.file);
  if (text === null)
    throw new ChangelogError(
      `changelog.file: ${config.file} does not exist: create it, or point the field at the changelog`,
    );
  let format: Format | null;
  if (config.format !== null) format = formatOf(config.format);
  else format = detectFormat(text);
  if (format === null)
    throw new ChangelogError(
      `${config.file} does not say which format it is in (an ## [Unreleased] heading or a link to keepachangelog.com is Keep a Changelog; a link to common-changelog.org is Common Changelog): set changelog.format to ${FORMAT_IDS.join(" or ")}`,
    );
  const pullRequest = config.release.push === "pull-request";
  const version = resolveVersionSource(config.version, read);
  refuseWrittenPlaceholders(config, version);
  return {
    root,
    config,
    notes: config.notesDir,
    changelog: config.file,
    format,
    version,
    tagPrefix: config.tagPrefix,
    unreleased: format.hasUnreleased
      ? (config.unreleased ?? (pullRequest ? "wait" : "write"))
      : "wait",
  };
}

/** The repository at `root` resolved from its working tree; null when the skill is off. */
export function loadResolved(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Resolved | null {
  const config = loadChangelogConfig(root, env);
  return config === null ? null : resolve(root, config, workingTree(root));
}
