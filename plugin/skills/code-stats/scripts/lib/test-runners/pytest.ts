/**
 * pytest: `testpaths` and `python_files`, from the first of `pytest.ini`,
 * `.pytest.ini`, `pyproject.toml` (`[tool.pytest.ini_options]`), `tox.ini`
 * (`[pytest]`) and `setup.cfg` (`[tool:pytest]`) in a folder that holds
 * pytest's section, as pytest itself chooses. A file under a `testpaths`
 * entry (relative to the configuration's folder; a glob is read as one)
 * whose name matches `python_files` (pytest's default, `test_*.py` and
 * `*_test.py`, when not set) is a test; a file a `testpaths` entry names
 * itself is a test whatever its name. Without `testpaths`, `python_files`
 * applies under the configuration's folder. A configuration that sets
 * neither claims nothing.
 *
 * Every value is static text, so nothing here is computed; a
 * `pyproject.toml` that is not valid TOML, or whose `testpaths` or
 * `python_files` is neither a string nor a list of strings, is reported
 * unreadable.
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
  { name: "pytest.ini", section: "pytest" },
  { name: ".pytest.ini", section: "pytest" },
  { name: "pyproject.toml", section: "tool.pytest.ini_options" },
  { name: "tox.ini", section: "pytest" },
  { name: "setup.cfg", section: "tool:pytest" },
];

/** The settings of a pytest section: each key's value, split as pytest splits it. */
type Section = Map<string, string[]>;

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
  const separator = line.search(/[=:]/);
  if (separator === -1) return;
  const key = line.slice(0, separator).trim();
  if (key === "" || /\s/.test(key)) return;
  state.key = key;
  state.raw.set(key, line.slice(separator + 1).trim());
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

function tomlSection(text: string): Section | null {
  if (!/\[\s*tool\.pytest\.ini_options\s*\]/.test(text)) return null;
  const options = tableAt(parseToml(text), ["tool", "pytest", "ini_options"]);
  if (!isRecord(options)) return null;
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

function sectionOf(path: string, text: string): Section | null {
  const source = SOURCES.find((s) => s.name === nameOf(path));
  if (!source) return null;
  if (source.name === "pyproject.toml") return tomlSection(text);
  const section = iniSection(text, source.section);
  // A pytest.ini is pytest's configuration even without its section.
  return (
    section ??
    (source.section === "pytest" && source.name.endsWith("pytest.ini")
      ? new Map()
      : null)
  );
}

/** Where `path`'s pytest section is: `[pytest]`, or the pyproject table. */
function sectionName(path: string): string {
  return `[${SOURCES.find((s) => s.name === nameOf(path))?.section ?? "pytest"}]`;
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
export function pytestRules(file: string, section: Section): RunnerRule[] {
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
  const key = `${sectionName(file)} ${keys.join(" and ")}`;
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
  "pytest.ini": /^/,
  ".pytest.ini": /^/,
  "pyproject.toml": /^[ \t]*\[[ \t]*tool\.pytest\.ini_options[ \t]*\]/m,
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
    const section = sectionOf(path, text);
    return section === null ? null : pytestRules(path, section);
  });
}
