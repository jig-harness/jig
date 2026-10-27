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
 * `pyproject.toml` that is not valid TOML is reported unreadable.
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
  UnreadableError,
  under,
} from "./model.ts";

const READER = "pytest";
const DEFAULT_PYTHON_FILES = ["test_*.py", "*_test.py"];

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
  let inside = false;
  let found = false;
  let key: string | null = null;
  const raw = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inside = (header[1] as string).trim() === name;
      found ||= inside;
      key = null;
      continue;
    }
    if (!inside || /^\s*[#;]/.test(line) || line.trim() === "") continue;
    if (/^\s/.test(line) && key !== null) {
      raw.set(key, `${raw.get(key)} ${line.trim()}`);
      continue;
    }
    const pair = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!pair) continue;
    key = pair[1] as string;
    raw.set(key, (pair[2] as string).trim());
  }
  if (!found) return null;
  return new Map([...raw].map(([k, v]) => [k, splitArgs(v)]));
}

/** A value split on whitespace, quotes kept together and removed. */
function splitArgs(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => (m[1] ?? m[2] ?? m[3]) as string,
  );
}

function tomlSection(text: string): Section | null {
  if (!/\[\s*tool\.pytest\.ini_options\s*\]/.test(text)) return null;
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    throw new UnreadableError(
      `is not valid TOML (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const tool = isRecord(doc) ? doc.tool : undefined;
  const pytest = isRecord(tool) ? tool.pytest : undefined;
  const options = isRecord(pytest) ? pytest.ini_options : undefined;
  if (!isRecord(options)) return null;
  const section: Section = new Map();
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string") section.set(key, splitArgs(value));
    else if (Array.isArray(value))
      section.set(
        key,
        value.filter((v): v is string => typeof v === "string"),
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
  const rule = (pattern: string, matches: (path: string) => boolean) => ({
    reader: READER,
    file,
    key,
    pattern,
    scope: dir,
    matches,
  });
  if (!testpaths)
    return [rule(filesShown, (path) => under(dir, path) && named(path))];
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
      (path) => re.test(path) || (below.test(path) && named(path)),
    );
  });
}

/** The candidates in one folder, in the order pytest tries them. */
function inOrder(candidates: readonly string[]): string[] {
  return SOURCES.map((s) =>
    candidates.find((c) => nameOf(c) === s.name),
  ).filter((c): c is string => c !== undefined);
}

/** Each folder's pytest configuration: the first source that holds the section. */
export function readPytest(files: RepoFiles): Reading {
  const byFolder = new Map<string, string[]>();
  for (const path of files.paths) {
    if (!SOURCES.some((s) => s.name === nameOf(path))) continue;
    const folder = folderOf(path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
  }
  const reading: Reading = { rules: [], unreadable: [] };
  for (const candidates of byFolder.values())
    for (const path of inOrder(candidates)) {
      const text = files.read(path);
      if (text === null) continue;
      try {
        const section = sectionOf(path, text);
        if (section === null) continue;
        reading.rules.push(...pytestRules(path, section));
      } catch (error) {
        if (!(error instanceof UnreadableError)) throw error;
        reading.unreadable.push({ reader: READER, path, why: error.message });
      }
      break;
    }
  return reading;
}
