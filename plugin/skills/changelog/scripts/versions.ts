// Where the released version lives, and how to read and move it.
//
// A version is kept in files (JSON, TOML, YAML, or a plain VERSION file), each
// at a key, or only in the repository's tags. A file is edited by replacing
// the one value at its key, inside the key's own table or object, so the
// file's formatting, comments and key order stay; the result is parsed again
// to check that exactly that value changed.
import { ChangelogError } from "./errors.ts";
import { parseField, valueAt } from "../../../shared/config-layers.ts";
import { swallow } from "../../../shared/errors.ts";
import { load } from "../../../shared/yaml.ts";
import { type Format, releasedVersions } from "./formats.ts";

/** One file holding the version, at `key` (dotted); the key is empty for a plain VERSION file. */
export interface VersionFile {
  path: string;
  key: string;
}

/** Where the version lives. */
export type VersionSource =
  | { kind: "files"; files: VersionFile[] }
  | { kind: "tags" };

/** A file's text, or null when the file does not exist. */
export type FileReader = (path: string) => string | null;

type Kind = "json" | "toml" | "yaml" | "plain";

const PLAIN = /^\d+\.\d+\.\d+$/;

/** The kind of file `path` names; null for a kind that cannot hold a version. */
function kindOrNull(path: string): Kind | null {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "version" || name === "version.txt") return "plain";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".toml")) return "toml";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return null;
}

function kindOf(path: string): Kind {
  const kind = kindOrNull(path);
  if (kind === null)
    throw new ChangelogError(
      `${path}: cannot keep a version in this kind of file; the files are JSON, TOML, YAML or a plain VERSION file`,
    );
  return kind;
}

/** Whether `path` names a kind of file a version can be kept in. */
export function isVersionFile(path: string): boolean {
  return kindOrNull(path) !== null;
}

function parse(kind: Exclude<Kind, "plain">, text: string): unknown {
  if (kind === "json") return JSON.parse(text);
  if (kind === "toml") return Bun.TOML.parse(text);
  return load(text);
}

/** The version a file holds at its key; null when there is no written one. */
export function readVersion(file: VersionFile, text: string): string | null {
  const kind = kindOf(file.path);
  if (kind === "plain") return text.trim() || null;
  const value = valueAt(
    parse(kind, text) as Record<string, unknown>,
    parseField(file.key),
  );
  return typeof value === "string" ? value : null;
}

/** `readVersion`, with a file that cannot be read or parsed counted as holding none. */
export function versionIn(
  file: VersionFile,
  text: string | null,
): string | null {
  if (text === null) return null;
  try {
    return readVersion(file, text);
  } catch (error) {
    swallow(error, `${file.path} holds no readable version`);
    return null;
  }
}

/**
 * The files a version is derived from when the repository names none:
 * `package.json` (`version`), `pyproject.toml` (`project.version`, else
 * `tool.poetry.version`) and `Cargo.toml` (`package.version`), each only when
 * it sits at the root and holds a written version at that key. A version
 * computed at build time, inherited from a workspace, or absent is not
 * derived.
 */
export function derivedFiles(read: FileReader): VersionFile[] {
  const candidates: VersionFile[][] = [
    [{ path: "package.json", key: "version" }],
    [
      { path: "pyproject.toml", key: "project.version" },
      { path: "pyproject.toml", key: "tool.poetry.version" },
    ],
    [{ path: "Cargo.toml", key: "package.version" }],
  ];
  return candidates.flatMap((alternatives) => {
    const found = alternatives.find((file) => versionIn(file, read(file.path)));
    return found ? [found] : [];
  });
}

/** The version source: the configured files, else the derived ones; tags as configured. */
export function resolveVersionSource(
  setting: VersionSource | null,
  read: FileReader,
): VersionSource {
  if (setting !== null) return setting;
  const files = derivedFiles(read);
  if (!files.length)
    throw new ChangelogError(
      "no version to release: the repository has no package.json, pyproject.toml or Cargo.toml with a written version at the root. Set changelog.version to the files that hold it ({ files: [{ path, key }] }) or to { tags: true } when only the tags do",
    );
  return { kind: "files", files };
}

/** What the current version is read from, besides the version files. */
export interface VersionContext {
  read: FileReader;
  format: Format;
  tagPrefix: string;
  /** The changelog's text. */
  changelog: string;
  /** Every tag of the repository. */
  tags: () => string[];
}

/** The highest `<prefix>x.y.z` among `tags`, as its version; null when there is none. */
export function highestTag(tags: string[], prefix: string): string | null {
  const versions = tags.flatMap((tag) => {
    const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    return PLAIN.test(version) ? [version] : [];
  });
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** Plain versions in semantic order. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The version released now. From files, the one every file holds, which must
 * agree. From tags, the changelog's newest release heading (the release
 * commit writes it at once, before the tag exists), else the highest tag of
 * the repository, else 0.0.0.
 */
export function currentVersion(
  source: VersionSource,
  context: VersionContext,
): string {
  if (source.kind === "tags")
    return (
      releasedVersions(context.changelog, context.format)[0] ??
      highestTag(context.tags(), context.tagPrefix) ??
      "0.0.0"
    );
  const versions = source.files.map((file) => {
    const text = context.read(file.path);
    if (text === null) throw new ChangelogError(`${file.path}: no such file`);
    return readVersion(file, text);
  });
  const [first] = versions;
  if (!first || versions.some((v) => v !== first))
    throw new ChangelogError(
      `the version files disagree: ${source.files.map((f, i) => `${f.path}=${versions[i] ?? "(none)"}`).join(", ")}`,
    );
  return first;
}

/**
 * The current version from files, checked the way the release moves it,
 * without writing: a plain major.minor.patch, and every file editable from it
 * in place. Throws with the release's own reason when either fails.
 */
export function releasableVersion(
  source: Extract<VersionSource, { kind: "files" }>,
  context: VersionContext,
): string {
  const version = currentVersion(source, context);
  if (!PLAIN.test(version))
    throw new ChangelogError(
      `the version ${JSON.stringify(version)} is not a plain major.minor.patch version, the only kind the release step moves`,
    );
  const next = version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  for (const file of source.files)
    withVersion(file, context.read(file.path) ?? "", version, next);
  return version;
}

/** Where a value sits in a file's text: from `start` up to `end`. */
export type Span = [start: number, end: number];

/** Whether `a` and `b` are the same path. */
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Walks JSON text, collecting the string values at one path as the content between the quotes. */
class JsonScanner {
  readonly found: Span[] = [];
  private at = 0;
  private readonly text: string;
  private readonly target: readonly string[];

  constructor(text: string, target: readonly string[]) {
    this.text = text;
    this.target = target;
  }

  scan(): Span[] {
    this.value([]);
    return this.found;
  }

  private skip(): void {
    while (/\s/.test(this.text[this.at] ?? "x")) this.at++;
  }

  private string(): Span {
    const start = ++this.at;
    while (this.text[this.at] !== '"')
      this.at += this.text[this.at] === "\\" ? 2 : 1;
    return [start, this.at++];
  }

  /** Whether another member follows, having read its `,` or the closing bracket. */
  private more(): boolean {
    this.skip();
    return this.text[this.at++] === ",";
  }

  private value(path: string[]): void {
    this.skip();
    const c = this.text[this.at];
    if (c === "{") this.object(path);
    else if (c === "[") this.array(path);
    else if (c === '"') this.leaf(path);
    else
      while (
        this.at < this.text.length &&
        !/[,\]}\s]/.test(this.text[this.at] ?? "")
      )
        this.at++;
  }

  private leaf(path: string[]): void {
    const span = this.string();
    if (same(path, this.target)) this.found.push(span);
  }

  private object(path: string[]): void {
    this.at++;
    this.skip();
    if (this.text[this.at] === "}") {
      this.at++;
      return;
    }
    do {
      this.skip();
      const [from, to] = this.string();
      const key: unknown = JSON.parse(`"${this.text.slice(from, to)}"`);
      this.skip();
      this.at++;
      this.value([...path, String(key)]);
    } while (this.more());
  }

  private array(path: string[]): void {
    this.at++;
    this.skip();
    if (this.text[this.at] === "]") {
      this.at++;
      return;
    }
    do this.value([...path, "\0item"]);
    while (this.more());
  }
}

const jsonSpans = (text: string, target: readonly string[]): Span[] =>
  new JsonScanner(text, target).scan();

/** How many brackets a TOML line leaves open, ignoring strings and comments. */
function openBrackets(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const close = line.indexOf(c, i + 1);
      if (close === -1) break;
      i = close;
    } else if (c === "#") break;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

/** A TOML dotted key as its segments, quoted parts included. */
function tomlKey(text: string): string[] | null {
  const parts = [
    ...text.matchAll(
      /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/gy,
    ),
  ];
  if (!parts.length || parts.map((m) => m[0]).join("") !== text) return null;
  return parts.map((m) =>
    m[1] !== undefined ? String(JSON.parse(`"${m[1]}"`)) : (m[2] ?? m[3] ?? ""),
  );
}

/** A key line of TOML: the key's full path and the text after its `=`. */
interface TomlEntry {
  path: string[];
  rest: string;
  /** Where `rest` starts in the file. */
  at: number;
}

/**
 * Reads TOML text line by line, yielding each key line with the path its
 * table header and dotted key give it. Lines inside a multi-line string, a
 * multi-line array or inline table, and the keys of an array of tables, are
 * skipped.
 */
class TomlLines {
  private table: string[] | null = [];
  private open = 0;
  private multiline: string | null = null;
  private offset = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  *entries(): Generator<TomlEntry> {
    for (const raw of this.text.split("\n")) {
      const start = this.offset;
      this.offset += raw.length + 1;
      if (this.continues(raw) || this.header(raw)) continue;
      const entry = this.entry(raw, start);
      if (entry) yield entry;
    }
  }

  /** Whether `raw` continues a multi-line string or collection from before. */
  private continues(raw: string): boolean {
    if (this.multiline !== null) {
      if (raw.includes(this.multiline)) this.multiline = null;
      return true;
    }
    if (this.open <= 0) return false;
    this.open += openBrackets(raw);
    return true;
  }

  /** Whether `raw` is a table header, which sets the table the next keys belong to. */
  private header(raw: string): boolean {
    const array = /^\s*\[\[(.+)\]\]\s*(?:#.*)?$/.test(raw);
    const table = /^\s*\[([^[\]].*)\]\s*(?:#.*)?$/.exec(raw)?.[1];
    if (!array && table === undefined) return false;
    this.table = array || table === undefined ? null : tomlKey(table.trim());
    return true;
  }

  private entry(raw: string, start: number): TomlEntry | null {
    const pair = /^(\s*)([^=#]+?)\s*=\s*(.*)$/.exec(raw);
    const key = pair ? tomlKey((pair[2] ?? "").trim()) : null;
    if (!pair || this.table === null || key === null) return null;
    const rest = pair[3] ?? "";
    const quote = /^("""|''')/.exec(rest)?.[1];
    if (quote) {
      if (!rest.slice(3).includes(quote)) this.multiline = quote;
      return null;
    }
    this.open = Math.max(0, openBrackets(rest));
    return {
      path: [...this.table, ...key],
      rest,
      at: start + raw.length - rest.length,
    };
  }
}

/**
 * The positions of the single-line string values at `target` in TOML text:
 * a key line under the right table header, or a dotted key from above it.
 * Throws where the key sits inside an inline table, which is not edited.
 */
function tomlSpans(text: string, target: readonly string[]): Span[] {
  const found: Span[] = [];
  for (const { path, rest, at } of new TomlLines(text).entries()) {
    if (same(path, target)) {
      const quote = rest[0];
      const close =
        quote === '"' || quote === "'" ? rest.indexOf(quote, 1) : -1;
      if (close > 0) found.push([at + 1, at + close]);
    } else if (
      rest.startsWith("{") &&
      target.length > path.length &&
      same(path, target.slice(0, path.length))
    )
      throw new ChangelogError(
        `${path.join(".")} is an inline table, so the version inside it cannot be edited in place: write it as a table of its own`,
      );
  }
  return found;
}

/** A YAML `key: value` line: its indentation, its key and the value after the colon. */
function yamlPair(
  raw: string,
): { indent: number; key: string; rest: string; at: number } | null {
  const pair =
    /^(\s*)("[^"]*"|'[^']*'|[^\s#:'"{}[\],&*!|>%@`-][^:#]*?)\s*:(?:\s+(.*))?$/.exec(
      raw,
    );
  if (!pair) return null;
  const rest = (pair[3] ?? "").replace(/\s+#.*$/, "");
  const before = (pair[1]?.length ?? 0) + (pair[2]?.length ?? 0);
  return {
    indent: pair[1]?.length ?? 0,
    key: (pair[2] ?? "").replace(/^(["'])(.*)\1$/, "$2"),
    rest,
    at: rest ? raw.indexOf(rest, before) : 0,
  };
}

/** The span of the YAML scalar `rest` starting at `at`: inside its quotes, if any; null for what is not a plain scalar. */
function yamlScalar(rest: string, at: number): Span | null {
  if (/^(["'])(.*)\1$/.test(rest)) return [at + 1, at + rest.length - 1];
  return /^[|>[{&*!]/.test(rest) ? null : [at, at + rest.length];
}

/** Whether a YAML line carries no key: blank, a comment or a document marker. */
const yamlBlank = (raw: string): boolean =>
  !raw.trim() || raw.trimStart().startsWith("#") || /^(---|\.\.\.)/.test(raw);

/**
 * The positions of the scalar values at `target` in YAML text, as the content
 * between any quotes. Only block mappings are followed; a value in a
 * sequence, flow collection or block scalar is never found.
 */
function yamlSpans(text: string, target: readonly string[]): Span[] {
  const found: Span[] = [];
  const stack: { indent: number; key: string }[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    if (yamlBlank(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    // A sequence item breaks the path: nothing under it is a key of ours.
    const pair = raw.trimStart().startsWith("- ") ? null : yamlPair(raw);
    stack.push(pair ?? { indent, key: "\0item" });
    if (
      !pair?.rest ||
      !same(
        stack.map((s) => s.key),
        target,
      )
    )
      continue;
    const span = yamlScalar(pair.rest, lineStart + pair.at);
    if (span) found.push(span);
  }
  return found;
}

/** The positions of the values at a key, per kind of file. */
const SPANS = { json: jsonSpans, toml: tomlSpans, yaml: yamlSpans };

/**
 * Where in `text` the release step writes the version: the one span
 * `withVersion` edits, holding the version `readVersion` reads. Null when the
 * file holds no readable version there, or holds it in a form `withVersion`
 * refuses (written twice, escaped, or inside an inline table).
 */
export function versionSpan(file: VersionFile, text: string): Span | null {
  const version = versionIn(file, text);
  if (version === null) return null;
  const kind = kindOf(file.path);
  if (kind === "plain") {
    const start = text.indexOf(version);
    return [start, start + version.length];
  }
  let spans: Span[];
  try {
    spans = SPANS[kind](text, parseField(file.key));
  } catch (error) {
    swallow(error, `${file.path}: ${file.key} is not written in place`);
    return null;
  }
  const [start, end] = spans.length === 1 ? (spans[0] ?? [0, 0]) : [0, 0];
  return spans.length === 1 && text.slice(start, end) === version
    ? [start, end]
    : null;
}

/** The most values an expanded version file may hold. */
const MAX_VALUES = 100_000;

/**
 * A copy of `value` that shares nothing: a YAML alias parses to one object
 * reachable from two paths, and a copy that kept that sharing would expect
 * an edit at one path to show at the other. Expanding aliases can grow a
 * small file without bound, and an alias inside its own anchor never ends,
 * so a cycle or more than `MAX_VALUES` values is refused before it is built.
 */
function unshared(name: string, value: unknown): unknown {
  let values = 0;
  const within = new Set<object>();
  const copy = (node: unknown): unknown => {
    if (++values > MAX_VALUES)
      throw new ChangelogError(
        `${name}: its aliases expand to more than ${MAX_VALUES} values, so the file is left alone`,
      );
    if (node === null || typeof node !== "object" || node instanceof Date)
      return node;
    if (within.has(node))
      throw new ChangelogError(
        `${name}: an alias refers to its own anchor, so the file is left alone`,
      );
    within.add(node);
    const result = Array.isArray(node)
      ? node.map(copy)
      : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, copy(v)]));
    within.delete(node);
    return result;
  };
  return copy(value);
}

/** A copy of `value` with the string at `path` replaced, and only there. */
function withValueAt(
  name: string,
  value: unknown,
  path: readonly string[],
  to: string,
): unknown {
  const copy = unshared(name, value) as Record<string, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1))
    node = node[key] as Record<string, unknown>;
  node[path.at(-1) ?? ""] = to;
  return copy;
}

/**
 * A file's text with its version moved from `from` to `to`, editing only
 * that value. Throws, and a release then writes nothing, when the key holds
 * something else than `from`, is ambiguous (written twice, or in a form that
 * is not edited in place), or when the edited file does not parse to exactly
 * the old content with that one value changed.
 */
export function withVersion(
  file: VersionFile,
  text: string,
  from: string,
  to: string,
): string {
  const kind = kindOf(file.path);
  const name = file.path;
  if (kind === "plain") {
    if (text.trim() !== from)
      throw new ChangelogError(
        `${name}: expected the version ${from}, found ${text.trim()}`,
      );
    return text.replace(from, to);
  }
  const path = parseField(file.key);
  const before = parse(kind, text);
  const held = valueAt(before as Record<string, unknown>, path);
  if (held !== from)
    throw new ChangelogError(
      `${name}: ${file.key} holds ${JSON.stringify(held)}, not the version ${from}`,
    );
  const spans = SPANS[kind](text, path);
  if (spans.length !== 1)
    throw new ChangelogError(
      `${name}: expected ${file.key} to be written once as "${from}", found ${spans.length}`,
    );
  const [start, end] = spans[0] ?? [0, 0];
  const updated = `${text.slice(0, start)}${to}${text.slice(end)}`;
  if (
    !Bun.deepEquals(
      parse(kind, updated),
      withValueAt(name, before, path, to),
      true,
    )
  )
    throw new ChangelogError(
      `${name}: editing ${file.key} did not change exactly that value, so the file is left alone`,
    );
  return updated;
}
