/**
 * pytest: `testpaths` and `python_files`, from the first of `pytest.toml`,
 * `.pytest.toml` (`[pytest]`), `pytest.ini`, `.pytest.ini`, `pyproject.toml`
 * (`[tool.pytest]`, or `[tool.pytest.ini_options]`), `tox.ini` (`[pytest]`)
 * and `setup.cfg` (`[tool:pytest]`) in a folder that holds pytest's
 * section, as pytest itself chooses. A file under a `testpaths`
 * entry (relative to the configuration's folder; a glob is read as one)
 * whose name matches `python_files` (pytest's default, `test_*.py` and
 * `*_test.py`, when not set) is a test; a file a `testpaths` entry names
 * itself is a test whatever its name. Without `testpaths`, `python_files`
 * applies under the configuration's folder. A configuration that sets
 * neither claims nothing.
 *
 * Every value is static text, so nothing here is computed; a TOML file
 * that is not valid TOML, whose `testpaths` or `python_files` is neither a
 * string nor a list of strings, or a `pyproject.toml` that sets both
 * `[tool.pytest]` and `[tool.pytest.ini_options]`, is reported unreadable.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { globRegExp, globUnder } from "./glob.ts";
import {
  folderOf,
  inside,
  nameOf,
  type Reading,
  type RepoFiles,
  type RunnerRule,
  readEach,
  UnreadableError,
  under,
} from "./model.ts";

const READER = "pytest";
const DEFAULT_PYTHON_FILES = ["test_*.py", "*_test.py"];
/** The keys the rules are built from. */
const READ_KEYS = ["testpaths", "python_files"];

/** Where pytest looks, in its order, and the section each must hold. */
const SOURCES: readonly { name: string; section: string }[] = [
  { name: "pytest.toml", section: "pytest" },
  { name: ".pytest.toml", section: "pytest" },
  { name: "pytest.ini", section: "pytest" },
  { name: ".pytest.ini", section: "pytest" },
  { name: "pyproject.toml", section: "tool.pytest" },
  { name: "tox.ini", section: "pytest" },
  { name: "setup.cfg", section: "tool:pytest" },
];

/** The settings of a pytest section: each key's value, split as pytest splits it. */
type Section = Map<string, string[]>;

/** A file's pytest section and the name of the section it was read from. */
interface Found {
  name: string;
  section: Section;
}

/** One section of an INI file, its continuation lines joined; null when absent. */
export function iniSection(text: string, name: string): Section | null {
  const state: IniState = {
    inside: false,
    found: false,
    key: null,
    raw: new Map(),
  };
  for (const line of text.split(/\r?\n/)) iniLine(state, line, name);
  if (!state.found) return null;
  return new Map([...state.raw].map(([k, v]) => [k, splitArgs(v)]));
}

interface IniState {
  /** Whether the lines read are in the wanted section. */
  inside: boolean;
  found: boolean;
  /** The key a continuation line adds to. */
  key: string | null;
  raw: Map<string, string>;
}

/** Read one line of an INI file into `state`. */
function iniLine(state: IniState, line: string, name: string): void {
  const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  if (header) {
    state.inside = (header[1] as string).trim() === name;
    state.found ||= state.inside;
    state.key = null;
    return;
  }
  if (!state.inside || /^\s*[#;]/.test(line) || line.trim() === "") return;
  if (/^\s/.test(line) && state.key !== null) {
    state.raw.set(state.key, `${state.raw.get(state.key)} ${line.trim()}`);
    return;
  }
  const pair = iniPair(line);
  if (pair === null) return;
  state.key = pair[0];
  state.raw.set(pair[0], pair[1]);
}

/** The key and value one `key = value` or `key: value` line sets, or null. */
function iniPair(line: string): [key: string, value: string] | null {
  const separator = line.search(/[=:]/);
  if (separator === -1) return null;
  const key = line.slice(0, separator).trim();
  if (key === "" || /\s/.test(key)) return null;
  return [key, line.slice(separator + 1).trim()];
}

/** A value split on whitespace, quotes kept together and removed. */
function splitArgs(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => (m[1] ?? m[2] ?? m[3]) as string,
  );
}

function parseToml(text: string): unknown {
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new UnreadableError(
      `is not valid TOML (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The value at `keys` inside nested tables, or undefined. */
function tableAt(doc: unknown, keys: readonly string[]): unknown {
  let node = doc;
  for (const key of keys) node = isRecord(node) ? node[key] : undefined;
  return node;
}

/**
 * A `pyproject.toml`'s pytest section: `[tool.pytest]`, pytest's native
 * table, or `[tool.pytest.ini_options]`; null when it holds neither.
 */
function pyprojectSection(text: string): Found | null {
  if (!/\[\s*tool\.pytest(?:\.ini_options)?\s*\]/.test(text)) return null;
  const pytest = tableAt(parseToml(text), ["tool", "pytest"]);
  if (!isRecord(pytest)) return null;
  const { ini_options: ini, ...native } = pytest;
  const setsNative = Object.keys(native).length > 0;
  if (setsNative && ini !== undefined)
    throw new UnreadableError(
      "sets both [tool.pytest] and [tool.pytest.ini_options]",
    );
  if (setsNative || ini === undefined)
    return { name: "tool.pytest", section: tomlSection(native) };
  return isRecord(ini)
    ? { name: "tool.pytest.ini_options", section: tomlSection(ini) }
    : null;
}

/** A `pytest.toml`'s `[pytest]` table; the file is pytest's configuration even without it. */
function pytestTomlSection(text: string): Found {
  const table = tableAt(parseToml(text), ["pytest"]);
  return {
    name: "pytest",
    section: isRecord(table) ? tomlSection(table) : new Map(),
  };
}

/** The read keys of a TOML table, as strings. */
function tomlSection(options: Record<string, unknown>): Section {
  const section: Section = new Map();
  for (const key of READ_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value === "string") section.set(key, splitArgs(value));
    else if (
      Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
    )
      section.set(key, value);
    else
      throw new UnreadableError(
        `${key} is neither a string nor a list of strings`,
      );
  }
  return section;
}

function sectionOf(path: string, text: string): Found | null {
  const source = SOURCES.find((s) => s.name === nameOf(path));
  if (!source) return null;
  if (source.name === "pyproject.toml") return pyprojectSection(text);
  if (source.name.endsWith("pytest.toml")) return pytestTomlSection(text);
  const section = iniSection(text, source.section);
  // A pytest.ini is pytest's configuration even without its section.
  if (section === null && !source.name.endsWith("pytest.ini")) return null;
  return { name: source.section, section: section ?? new Map() };
}

/** A matcher for a file's name against a `python_files` pattern. */
function nameMatcher(pattern: string): (path: string) => boolean {
  if (pattern.includes("/")) {
    const re = globRegExp(`**/${pattern}`);
    return (path) => re.test(path);
  }
  const re = globRegExp(pattern);
  return (path) => re.test(nameOf(path));
}

/** The rules a pytest section declares. */
export function pytestRules(
  file: string,
  { name, section }: Found,
): RunnerRule[] {
  const testpaths = section.get("testpaths");
  const pythonFiles = section.get("python_files");
  if (testpaths === undefined && pythonFiles === undefined) return [];
  const dir = folderOf(file);
  const names = (pythonFiles ?? DEFAULT_PYTHON_FILES).map(nameMatcher);
  const named = (path: string) => names.some((m) => m(path));
  const keys = [
    ...(testpaths ? ["testpaths"] : []),
    ...(pythonFiles ? ["python_files"] : []),
  ];
  const key = `[${name}] ${keys.join(" and ")}`;
  const filesShown = (pythonFiles ?? DEFAULT_PYTHON_FILES).join(" ");
  const rule = (
    pattern: string,
    scope: string,
    matches: (path: string) => boolean,
  ) => ({ reader: READER, file, key, pattern, scope, matches });
  if (!testpaths)
    return [rule(filesShown, dir, (path) => under(dir, path) && named(path))];
  return testpaths.map((entry) => {
    const folder = inside(
      dir,
      entry,
      `testpaths entry ${JSON.stringify(entry)}`,
    );
    const re = globRegExp(globUnder("", folder));
    const below =
      folder === "" ? /.+/ : new RegExp(`${re.source.slice(0, -1)}/.+$`);
    return rule(
      `${entry} (${filesShown})`,
      fixedFolder(folder),
      (path) => re.test(path) || (below.test(path) && named(path)),
    );
  });
}

/**
 * The deepest folder that holds everything a `testpaths` entry matches: its
 * segments before the first glob character, without the last, which may
 * name a file.
 */
function fixedFolder(entry: string): string {
  const segments = entry.split("/");
  const glob = segments.findIndex((s) => /[*?[{]/.test(s));
  const fixed = glob === -1 ? segments.slice(0, -1) : segments.slice(0, glob);
  return fixed.join("/");
}

/** The candidates in one folder, in the order pytest tries them. */
function inOrder(candidates: readonly string[]): string[] {
  return SOURCES.map((s) =>
    candidates.find((c) => nameOf(c) === s.name),
  ).filter((c): c is string => c !== undefined);
}

/** Whether a candidate holds pytest's section, by its text alone. */
const HOLDS: Record<string, RegExp> = {
  "pytest.toml": /^/,
  ".pytest.toml": /^/,
  "pytest.ini": /^/,
  ".pytest.ini": /^/,
  "pyproject.toml": /^[ \t]*\[[ \t]*tool\.pytest(?:\.ini_options)?[ \t]*\]/m,
  "tox.ini": /^[ \t]*\[pytest\]/m,
  "setup.cfg": /^[ \t]*\[tool:pytest\]/m,
};

/** The configuration pytest uses in one folder: the first candidate that holds its section. */
function chosen(files: RepoFiles, candidates: readonly string[]): string[] {
  const path = inOrder(candidates).find((c) => {
    const text = files.read(c);
    return text !== null && (HOLDS[nameOf(c)] as RegExp).test(text);
  });
  return path === undefined ? [] : [path];
}

/** Each folder's pytest configuration: the first source that holds the section. */
export function readPytest(files: RepoFiles): Reading {
  const byFolder = new Map<string, string[]>();
  for (const path of files.paths.filter((p) => nameOf(p) in HOLDS)) {
    const folder = folderOf(path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
  }
  const configs = [...byFolder.values()].flatMap((c) => chosen(files, c));
  return readEach(READER, files, configs, (path, text) => {
    const found = sectionOf(path, text);
    return found === null ? null : pytestRules(path, found);
  });
}
