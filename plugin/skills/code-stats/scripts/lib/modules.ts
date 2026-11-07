/**
 * Modules: the units of a repository its own workspace manifests name
 * (pnpm, npm/Yarn/Bun workspaces, Go workspaces, Cargo, Gradle, uv), or
 * `code_stats.modules` when set. A file belongs to the deepest module folder
 * that holds it. Without either, a file's module is its first two folders
 * under a common container folder (`apps/web`), else its first folder.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../../shared/yaml.ts";
import type { Pattern } from "./config.ts";
import { closeAt } from "./count.ts";
import { CodeStatsError, unreadableFile } from "./errors.ts";
import type { Decision } from "./model.ts";

/** Folders whose children are modules when no manifest names any. */
export const CONTAINER_FOLDERS = new Set([
  "apps",
  "packages",
  "services",
  "libs",
  "crates",
  "cmd",
  "internal",
  "modules",
  "plugins",
  "tools",
  "projects",
  "components",
  "examples",
  "extensions",
]);

/** The name of the module the repository root itself is. */
export const ROOT_MODULE = "<root>";

/** One manifest's member patterns, `!`-negated or excluded ones apart. */
export interface MemberList {
  source: string;
  include: string[];
  exclude: string[];
  /** A file a matched folder must hold to be a member (`package.json`). */
  marker?: string;
}

/** Module folders (`""` for the root) and the rule that named each. */
export type ModuleMap = Map<string, string>;

/** The value at `keys` inside nested mappings, or undefined. */
function at(value: unknown, ...keys: string[]): unknown {
  let node = value;
  for (const key of keys) node = isRecord(node) ? node[key] : undefined;
  return node;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * A glob as a folder pattern: no `./`, no trailing `/`. Its backslashes are
 * glob escapes (`a\[b\]` is the folder `a[b]`) and stay as written.
 */
function normalizeGlob(glob: string): string {
  const trimmed = glob
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  return trimmed === "." ? "" : trimmed;
}

/** A manifest's member path or glob as a folder pattern, `\` read as `/`. */
function normalize(member: string): string {
  return normalizeGlob(member.trim().replace(/\\/g, "/"));
}

/** Split `!pattern` negations out of a workspace list. */
function withNegations(source: string, members: string[]): MemberList {
  return {
    source,
    marker: "package.json",
    include: members.filter((m) => !m.startsWith("!")).map(normalize),
    exclude: members
      .filter((m) => m.startsWith("!"))
      .map((m) => normalize(m.slice(1))),
  };
}

function readText(root: string, file: string): string | null {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw unreadableFile(file, error);
  }
}

function parsed<T>(file: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new CodeStatsError(
      `cannot read ${file} to find the repository's modules: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function pnpmMembers(text: string): MemberList {
  const doc = parsed("pnpm-workspace.yaml", () => load(text));
  return withNegations(
    "pnpm-workspace.yaml packages",
    strings(isRecord(doc) ? doc.packages : undefined),
  );
}

export function packageJsonMembers(text: string): MemberList {
  const doc: unknown = parsed("package.json", () => JSON.parse(text));
  const workspaces = isRecord(doc) ? doc.workspaces : undefined;
  const list = isRecord(workspaces) ? workspaces.packages : workspaces;
  return withNegations("package.json workspaces", strings(list));
}

/**
 * A go.work line's tokens: an interpreted ("…") or raw (`…`) string as its
 * decoded text, a parenthesis, or a bare word; a `//` comment ends the line.
 */
function goWorkTokens(line: string): { value: string; bare: boolean }[] {
  const tokens: { value: string; bare: boolean }[] = [];
  const token = /"((?:[^"\\]|\\.)*)"|`([^`]*)`|(\/\/)|([()])|([^\s()"`]+)/g;
  for (const m of line.matchAll(token)) {
    if (m[3]) break;
    if (m[1] !== undefined) tokens.push({ value: goString(m[1]), bare: false });
    else if (m[2] !== undefined) tokens.push({ value: m[2], bare: false });
    else tokens.push({ value: (m[4] ?? m[5]) as string, bare: true });
  }
  return tokens;
}

/** The text of a Go interpreted string's body; its escapes are JSON's for paths. */
function goString(body: string): string {
  try {
    const text: unknown = JSON.parse(`"${body}"`);
    return typeof text === "string" ? text : body;
  } catch {
    return body;
  }
}

const isBare = (t: { value: string; bare: boolean } | undefined, v: string) =>
  t?.bare === true && t.value === v;

/** `use ./a`, `use "./a b"` and `use ( ./a ./b )` directives of a go.work file. */
export function goWorkMembers(text: string): MemberList {
  const tokens = text.split("\n").flatMap(goWorkTokens);
  const include: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isBare(tokens[i], "use")) continue;
    if (isBare(tokens[i + 1], "(")) {
      for (i += 2; i < tokens.length && !isBare(tokens[i], ")"); i++)
        include.push((tokens[i] as { value: string }).value);
    } else if (i + 1 < tokens.length) {
      i++;
      include.push((tokens[i] as { value: string }).value);
    }
  }
  return {
    source: "go.work use",
    include: include.map(normalize),
    exclude: [],
  };
}

export function cargoMembers(text: string): MemberList {
  const doc: unknown = parsed("Cargo.toml", () => Bun.TOML.parse(text));
  const workspace = at(doc, "workspace");
  if (!isRecord(workspace))
    return { source: "Cargo.toml", include: [], exclude: [] };
  const include = strings(workspace.members);
  // A root package beside the workspace is a member too.
  if (isRecord(at(doc, "package"))) include.push(".");
  return {
    source: "Cargo workspace members",
    marker: "Cargo.toml",
    include: include.map(normalize),
    exclude: strings(workspace.exclude).map(normalize),
  };
}

/**
 * A Gradle settings script read as code: `code` has every comment and string
 * blanked, `strings` every comment only, both the length of `text` with its
 * line breaks kept, so a position in one is the same position in the other.
 */
export function gradleLayers(text: string): { code: string; strings: string } {
  const code: string[] = [];
  const strings: string[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let i = 0;
  while (i < text.length) {
    const span = gradleSpan(text, i);
    if (span === null) {
      code.push(text[i] as string);
      strings.push(text[i] as string);
      i++;
      continue;
    }
    const part = text.slice(i, span.end);
    code.push(blank(part));
    strings.push(span.comment ? blank(part) : part);
    i = span.end;
  }
  return { code: code.join(""), strings: strings.join("") };
}

const GRADLE_QUOTES = ['"""', "'''", '"', "'"];

/** The comment or string that starts at `i`, with the index after it; null for code. */
function gradleSpan(
  text: string,
  i: number,
): { end: number; comment: boolean } | null {
  const upTo = (end: number, extra: number) =>
    end === -1 ? text.length : end + extra;
  if (text.startsWith("//", i))
    return { end: upTo(text.indexOf("\n", i), 0), comment: true };
  if (text.startsWith("/*", i))
    return { end: upTo(text.indexOf("*/", i + 2), 2), comment: true };
  const quote = GRADLE_QUOTES.find((q) => text.startsWith(q, i));
  if (!quote) return null;
  return {
    end: upTo(closeAt(text, i + quote.length, quote), 0),
    comment: false,
  };
}

/**
 * Where each `include` statement's arguments lie: up to the closing `)` of
 * `include(…)`, or, for Groovy's bare `include ':a', ':b'`, the line and each
 * following line while a line ends with a comma. Read from `code`, so an
 * `include` or a parenthesis inside a string or comment is not one.
 */
function includeArguments(code: string): [number, number][] {
  return [...code.matchAll(/\binclude\b([ \t]*\()?/g)].map((m) => {
    const start = (m.index as number) + m[0].length;
    return [start, m[1] ? closingParen(code, start) : bareEnd(code, start)];
  });
}

/** Where `include(` closes: its `)`, or the end of the text. */
function closingParen(body: string, start: number): number {
  const end = body.indexOf(")", start);
  return end === -1 ? body.length : end;
}

/** Where a bare `include`'s arguments end: the first line not ending in a comma. */
function bareEnd(body: string, start: number): number {
  let at = start;
  for (;;) {
    const eol = body.indexOf("\n", at);
    if (eol === -1) return body.length;
    const continues = body.slice(at, eol).trimEnd().endsWith(",");
    at = eol + 1;
    if (!continues) return at;
  }
}

/** `include(":a", ":b:c")` and `include ':a', ':b'` of a Gradle settings file. */
export function gradleMembers(text: string, file: string): MemberList {
  const { code, strings } = gradleLayers(text);
  const include: string[] = [];
  for (const [start, end] of includeArguments(code))
    for (const m of strings.slice(start, end).matchAll(/["']([^"']+)["']/g))
      include.push((m[1] as string).replace(/^:/, "").replaceAll(":", "/"));
  return {
    source: `${file} include`,
    include: include.map(normalize),
    exclude: [],
  };
}

export function uvMembers(text: string): MemberList {
  const doc: unknown = parsed("pyproject.toml", () => Bun.TOML.parse(text));
  const workspace = at(doc, "tool", "uv", "workspace");
  if (!isRecord(workspace))
    return { source: "pyproject.toml", include: [], exclude: [] };
  return {
    source: "uv workspace members",
    marker: "pyproject.toml",
    include: strings(workspace.members).map(normalize),
    exclude: strings(workspace.exclude).map(normalize),
  };
}

/** The member lists of every workspace manifest at the root. */
export function manifestMembers(root: string): MemberList[] {
  const lists: MemberList[] = [];
  const readers: [string, (text: string) => MemberList][] = [
    ["pnpm-workspace.yaml", pnpmMembers],
    ["package.json", packageJsonMembers],
    ["go.work", goWorkMembers],
    ["Cargo.toml", cargoMembers],
    ["settings.gradle", (t) => gradleMembers(t, "settings.gradle")],
    ["settings.gradle.kts", (t) => gradleMembers(t, "settings.gradle.kts")],
    ["pyproject.toml", uvMembers],
  ];
  for (const [file, read] of readers) {
    const text = readText(root, file);
    if (text !== null) {
      const list = read(text);
      if (list.include.length) lists.push(list);
    }
  }
  return lists;
}

/** Every folder that holds a tracked file, the root (`""`) included. */
export function trackedFolders(paths: readonly string[]): Set<string> {
  const folders = new Set<string>([""]);
  for (const path of paths) {
    let at = path.lastIndexOf("/");
    while (at > 0) {
      const folder = path.slice(0, at);
      if (folders.has(folder)) break;
      folders.add(folder);
      at = folder.lastIndexOf("/");
    }
  }
  return folders;
}

function matcher(pattern: string): (folder: string) => boolean {
  if (pattern === "") return (folder) => folder === "";
  const glob = new Bun.Glob(pattern);
  return (folder) => folder !== "" && glob.match(folder);
}

/**
 * The folders a member list names, among the tracked ones: a folder a
 * pattern matches, no exclusion matches, and that holds the list's marker
 * file when it has one.
 */
export function expandMembers(
  list: MemberList,
  folders: ReadonlySet<string>,
  files: ReadonlySet<string>,
  map: ModuleMap = new Map(),
): ModuleMap {
  const excluded = list.exclude.map(matcher);
  const marked = (folder: string) =>
    list.marker === undefined ||
    files.has(folder === "" ? list.marker : `${folder}/${list.marker}`);
  for (const pattern of list.include) {
    const matches = matcher(pattern);
    for (const folder of folders)
      if (
        matches(folder) &&
        !excluded.some((x) => x(folder)) &&
        marked(folder) &&
        !map.has(folder)
      )
        map.set(folder, `${list.source} ${JSON.stringify(pattern || ".")}`);
  }
  return map;
}

/** The module folders: from `code_stats.modules` when set, else the manifests. */
export function detectModules(
  root: string,
  paths: readonly string[],
  configured: readonly Pattern[] | null,
): ModuleMap {
  const folders = trackedFolders(paths);
  const files = new Set(paths);
  if (configured !== null) {
    return expandMembers(
      {
        source: "code_stats.modules glob",
        include: configured.map((p) => normalizeGlob(p.pattern)),
        exclude: [],
      },
      folders,
      files,
    );
  }
  const map: ModuleMap = new Map();
  for (const list of manifestMembers(root))
    expandMembers(list, folders, files, map);
  return map;
}

/** The module of `path`: the deepest module folder holding it, else the fallback. */
export function moduleOf(path: string, modules: ModuleMap): Decision {
  let at = path.lastIndexOf("/");
  while (at > 0) {
    const folder = path.slice(0, at);
    const rule = modules.get(folder);
    if (rule !== undefined) return { value: folder, rule };
    at = folder.lastIndexOf("/");
  }
  const rootRule = modules.get("");
  if (rootRule !== undefined) return { value: ROOT_MODULE, rule: rootRule };
  return fallbackModule(path);
}

function fallbackModule(path: string): Decision {
  const parts = path.split("/");
  if (parts.length === 1)
    return { value: ROOT_MODULE, rule: "fallback: a file at the root" };
  const [first, second] = parts as [string, string];
  if (CONTAINER_FOLDERS.has(first) && parts.length > 2)
    return {
      value: `${first}/${second}`,
      rule: `fallback: the first two folders under the container folder ${first}/`,
    };
  return { value: first, rule: "fallback: the first folder" };
}
