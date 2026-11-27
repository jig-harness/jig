/** Configured reflection-class vocabularies, read only by `gather`. */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  lstatSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import {
  formatDisplayValue,
  isMapping,
  type ConfigLayer,
} from "../../../../shared/config-layers.ts";
import { load } from "../../../../shared/yaml.ts";
import { isClassName } from "./events.ts";
import { SettingError } from "./setting-error.ts";

export interface SeededClass {
  slug: string;
  shape: string;
  source?: string;
}

export type ClassSeedSource =
  | { kind: "file"; path: string }
  | { kind: "inline"; classes: SeededClass[] };

const LINE_BREAK = /[\r\n\u2028\u2029]/;
const URL = /^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** A Windows UNC share (`\\host\x`) or its slash form, which is a network path. */
const NETWORK_PATH = /^\s*[\\/]{2}/;
/** The Windows NT forms of a UNC target, as a directory link reports it. */
const NT_UNC = /^\s*\\\?\?\\UNC\\/i;
const MAX_LINK_HOPS = 40;
/** The vocabulary file and entry bounds keep gather's output reviewable. */
export const MAX_CLASS_FILE_BYTES = 256 * 1024;
export const MAX_CLASS_ENTRIES = 500;

/** A configured list's entries, named by the field that supplied it. */
export function classEntries(value: unknown, field: string): SeededClass[] {
  if (!Array.isArray(value))
    throw new SettingError(`${field} must be a list of class entries`);
  if (value.length > MAX_CLASS_ENTRIES)
    throw new SettingError(
      `${field} lists ${value.length} classes; at most ${MAX_CLASS_ENTRIES} are read`,
    );
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const at = `${field}[${index}]`;
    if (!isMapping(entry))
      throw new SettingError(`${at} must be a mapping with slug and shape`);
    if (
      Object.keys(entry).some(
        (key) => key !== "slug" && key !== "shape" && key !== "source",
      )
    )
      throw new SettingError(`${at} accepts only slug, shape and source`);
    if (!isClassName(entry.slug))
      throw new SettingError(`${at}.slug must be a kebab-case class slug`);
    if (seen.has(entry.slug))
      throw new SettingError(`${at}.slug repeats "${entry.slug}" in one list`);
    seen.add(entry.slug);
    if (
      typeof entry.shape !== "string" ||
      entry.shape.trim() === "" ||
      LINE_BREAK.test(entry.shape)
    )
      throw new SettingError(
        `${at}.shape must be a non-empty one-line description`,
      );
    if (
      entry.source !== undefined &&
      (typeof entry.source !== "string" || entry.source.trim() === "")
    )
      throw new SettingError(`${at}.source must be non-empty text`);
    return entry.source === undefined
      ? { slug: entry.slug, shape: entry.shape }
      : { slug: entry.slug, shape: entry.shape, source: entry.source };
  });
}

/** A local class-vocabulary path, before it is expanded for this machine. */
export function classFilePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    URL.test(value) ||
    NETWORK_PATH.test(value)
  )
    throw new SettingError("reflection.classes_from must be a local path");
  return value;
}

/**
 * Each active layer contributes its file first, then its inline entries.
 * That makes an inline entry the deliberate override for its vocabulary
 * file; later (higher-precedence) layers override both by slug.
 */
export function classSeedSources(
  layers: readonly ConfigLayer[],
  expandPath: (path: string) => string,
): ClassSeedSource[] {
  const sources: ClassSeedSource[] = [];
  for (const layer of layers) {
    const reflection = layer.values.reflection;
    // An explicit null replaces the whole section, dropping lower layers' seeds.
    if (reflection === null) sources.length = 0;
    if (!isMapping(reflection)) continue;
    try {
      if (reflection.classes_from !== undefined)
        sources.push({
          kind: "file",
          path: expandPath(classFilePath(reflection.classes_from)),
        });
      if (reflection.classes !== undefined)
        sources.push({
          kind: "inline",
          classes: classEntries(reflection.classes, "reflection.classes"),
        });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SettingError(`${reason}: ${layer.source}`, { cause: error });
    }
  }
  return sources;
}

const TOO_LARGE = `is larger than ${MAX_CLASS_FILE_BYTES} bytes, so none of it is read`;

function isNetworkLocation(path: string): boolean {
  return URL.test(path) || NETWORK_PATH.test(path);
}

const COMPONENT_SEPARATOR = sep === "\\" ? /[\\/]+/ : /\/+/;

function components(path: string): string[] {
  return path.split(COMPONENT_SEPARATOR).filter(Boolean);
}

/** The components behind an absolute path's root, which is kept whole (`C:\`, `/`). */
function componentsBehindRoot(path: string): string[] {
  return components(path.slice(parse(path).root.length));
}

/**
 * Resolve a path the way the system would, one component at a time, using
 * the host's separators. `resolved` only ever holds a path whose own
 * components are not links, so a `..` steps to its true parent. A link whose
 * target names a network location is refused where it is met, and a local
 * link is followed by hand so the components behind it are checked too. Only
 * a link's own entry is examined, never what lies behind it. The final
 * component is returned unfollowed; the caller refuses a link there.
 */
function verifiedLocalPath(path: string): string {
  if (!isAbsolute(path)) throw new SettingError("is not an absolute path");
  let resolved = parse(path).root;
  const pending = componentsBehindRoot(path);
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === ".") continue;
    resolved = part === ".." ? dirname(resolved) : join(resolved, part);
    if (part === ".." || pending.length === 0) continue;
    if (!lstatSync(resolved).isSymbolicLink()) continue;
    if (++hops > MAX_LINK_HOPS) throw new SettingError("has too many links");
    const target = localLinkTarget(resolved);
    if (isAbsolute(target)) {
      resolved = parse(target).root;
      pending.unshift(...componentsBehindRoot(target));
    } else {
      resolved = dirname(resolved);
      pending.unshift(...components(target));
    }
  }
  return resolved;
}

/** A link's target, refused when it names a network location. */
function localLinkTarget(link: string): string {
  const target = readlinkSync(link);
  if (isNetworkLocation(target) || NT_UNC.test(target))
    throw new SettingError("is not a local path");
  return target;
}

/** Read at most one byte past the bound: the file may have grown since fstat. */
function readBounded(fd: number): string {
  const buffer = Buffer.alloc(MAX_CLASS_FILE_BYTES + 1);
  let length = 0;
  let read = 1;
  while (read > 0 && length < buffer.length) {
    read = readSync(fd, buffer, length, buffer.length - length, null);
    length += read;
  }
  if (length > MAX_CLASS_FILE_BYTES) throw new SettingError(TOO_LARGE);
  return buffer.toString("utf8", 0, length);
}

/**
 * Open without blocking on a pipe and without following a link, then check
 * the file actually opened. A path that names a network location, or whose
 * last component is a link, is refused before the system resolves it, so the
 * read never contacts a location it has not been shown to be local.
 */
function readClassFile(path: string): string {
  if (isNetworkLocation(path)) throw new SettingError("is not a local path");
  const verified = verifiedLocalPath(path);
  if (lstatSync(verified).isSymbolicLink())
    throw new SettingError("is a link, not a regular file");
  const fd = openSync(
    verified,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SettingError("is not a regular file");
    if (stat.size > MAX_CLASS_FILE_BYTES) throw new SettingError(TOO_LARGE);
    return readBounded(fd);
  } finally {
    closeSync(fd);
  }
}

/** A parser error can contain source text, including inside its cause chain. */
function parseLocation(error: unknown): string {
  if (!(error instanceof Error) || !("mark" in error) || !isMapping(error.mark))
    return "";
  const { line, column } = error.mark;
  return typeof line === "number" && typeof column === "number"
    ? ` at line ${line + 1}, column ${column + 1}`
    : "";
}

export interface LoadedClassSeeds {
  classes: SeededClass[];
  warnings: string[];
}

/**
 * Read the configured vocabulary files and overlay every source by slug.
 * Only file-system failures are warnings: malformed content is configuration
 * the person can fix, not an unavailable source to silently ignore.
 */
export function loadClassSeeds(
  sources: readonly ClassSeedSource[],
): LoadedClassSeeds {
  const classes = new Map<string, SeededClass>();
  const warnings: string[] = [];
  const add = (entries: readonly SeededClass[]) => {
    for (const entry of entries) classes.set(entry.slug, entry);
  };
  const shown = (path: string) => formatDisplayValue(path);
  for (const source of sources) {
    if (source.kind === "inline") {
      add(source.classes);
      continue;
    }
    let text: string;
    try {
      text = readClassFile(source.path);
    } catch (error) {
      // Only a filesystem failure or the explicit refusals above are expected.
      const code = (error as { code?: unknown } | null)?.code;
      if (!(error instanceof SettingError) && typeof code !== "string")
        throw error;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(
        `reflection.classes_from ${shown(source.path)} could not be read (${formatDisplayValue(reason)}); continuing without it`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = /\.json$/i.test(source.path) ? JSON.parse(text) : load(text);
    } catch (error) {
      throw new SettingError(
        `reflection.classes_from ${shown(source.path)} could not be parsed as ${/\.json$/i.test(source.path) ? "JSON" : "YAML"}${parseLocation(error)}`,
      );
    }
    add(classEntries(parsed, `reflection.classes_from ${shown(source.path)}`));
  }
  return { classes: [...classes.values()], warnings };
}
