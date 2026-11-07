/**
 * jest: `testMatch`, `testRegex` and `roots`, with `rootDir` and
 * `testPathIgnorePatterns`, from `jest.config.{js,ts,mjs,cjs,json}` or, in a
 * folder without one, the `jest` key of `package.json`. A rule holds under
 * the configuration's roots; `roots` alone means jest's default `testMatch`
 * under them. A configuration that declares none of the three claims
 * nothing: jest's defaults are what the built-in conventions already say.
 *
 * Not read: `projects` (each project's own configuration file is read where
 * it is tracked), a `preset`'s values, and a `testMatch` pattern that is
 * neither `<rootDir>/…` nor `**`/…, since jest matches it against absolute
 * paths and its meaning depends on where the repository is checked out.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { globMatcher, globUnder } from "./glob.ts";
import {
  exportedObject,
  fromJson,
  isLiteralObject,
  type LiteralObject,
  stringAt,
  stringsAt,
} from "./js-literal.ts";
import {
  commonFolder,
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

const READER = "jest";
const CONFIG = /^jest\.config\.(js|ts|mjs|cjs|json)$/;
const ROOT_DIR = "<rootDir>";
/** jest's default `testMatch`, which `roots` alone applies. */
const DEFAULT_TEST_MATCH = [
  "**/__tests__/**/*.?([mc])[jt]s?(x)",
  "**/?(*.)+(spec|test).?([mc])[jt]s?(x)",
];
const DEFAULT_IGNORE = ["/node_modules/"];

/** What a configuration's keys resolve to, before they become rules. */
interface Settings {
  file: string;
  rootDir: string;
  roots: string[];
  /** The deepest folder that holds every root. */
  scope: string;
  ignored: (path: string) => boolean;
}

/** `/path`: what a jest regular expression is tested against, from the repository root. */
const absolute = (path: string) => `/${path}`;

function regex(source: string, key: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    throw new UnreadableError(
      `${key} ${JSON.stringify(source)} is not a regular expression`,
    );
  }
}

function settings(file: string, obj: LiteralObject): Settings {
  const dir = folderOf(file);
  const declared = stringAt(obj, ["rootDir"]);
  const rootDir = declared === null ? dir : inside(dir, declared, "rootDir");
  const fromRoot = (value: string, key: string) =>
    inside(rootDir, value.replace(/^<rootDir>\/?/, ""), key);
  const roots = (stringsAt(obj, ["roots"]) ?? [ROOT_DIR]).map((r) =>
    fromRoot(r, "roots"),
  );
  const ignore = (
    stringsAt(obj, ["testPathIgnorePatterns"]) ?? DEFAULT_IGNORE
  ).map((p) => {
    if (p.startsWith("^") && !p.startsWith(`^${ROOT_DIR}`))
      throw new UnreadableError(
        `testPathIgnorePatterns ${JSON.stringify(p)} is anchored to an absolute path`,
      );
    return regex(
      p.replaceAll(ROOT_DIR, rootDir ? `/${rootDir}` : ""),
      "testPathIgnorePatterns",
    );
  });
  return {
    file,
    rootDir,
    roots,
    scope: commonFolder(roots),
    ignored: (path) => ignore.some((re) => re.test(absolute(path))),
  };
}

function rule(
  s: Settings,
  key: string,
  pattern: string,
  test: (path: string) => boolean,
): RunnerRule {
  return {
    reader: READER,
    file: s.file,
    key,
    pattern,
    scope: s.scope,
    matches: (path) =>
      s.roots.some((root) => under(root, path)) &&
      !s.ignored(path) &&
      test(path),
  };
}

/** A `testMatch` glob as a matcher over repository paths. */
function testMatchGlob(
  s: Settings,
  pattern: string,
): (path: string) => boolean {
  if (pattern.startsWith(ROOT_DIR))
    return globMatcher(
      globUnder(s.rootDir, pattern.slice(ROOT_DIR.length).replace(/^\//, "")),
    );
  if (pattern.startsWith("**")) return globMatcher(pattern);
  throw new UnreadableError(
    `testMatch ${JSON.stringify(pattern)} is matched against absolute paths, so what it matches depends on where the repository is checked out`,
  );
}

/**
 * One rule per positive pattern. jest reads the patterns in order, each
 * matching one setting the path in or (with `!`) out, so a path is a test
 * when the last pattern that matches it is positive; that pattern's rule is
 * the one that claims it.
 */
function testMatchRules(
  s: Settings,
  key: string,
  patterns: string[],
  shown?: string,
): RunnerRule[] {
  const globs = patterns.map((p) => ({
    negated: p.startsWith("!"),
    glob: testMatchGlob(s, p.startsWith("!") ? p.slice(1) : p),
  }));
  return patterns.flatMap((p, i) => {
    const own = globs[i] as (typeof globs)[number];
    if (own.negated) return [];
    const later = globs.slice(i + 1);
    return [
      rule(
        s,
        key,
        shown ?? p,
        (path) => own.glob(path) && !later.some((g) => g.glob(path)),
      ),
    ];
  });
}

/** The rules a jest configuration object declares. */
export function jestRules(file: string, obj: LiteralObject): RunnerRule[] {
  const testMatch = stringsAt(obj, ["testMatch"]);
  const testRegex = stringsAt(obj, ["testRegex"]);
  const roots = stringsAt(obj, ["roots"]);
  if (testMatch === null && testRegex === null && roots === null) return [];
  const s = settings(file, obj);
  // Each root's rule claims only the files under that root.
  if (testMatch === null && testRegex === null)
    return (roots ?? []).flatMap((root, i) => {
      const own = s.roots[i] as string;
      return testMatchRules(
        { ...s, roots: [own], scope: own },
        "roots",
        DEFAULT_TEST_MATCH,
        root,
      );
    });
  return [
    ...testMatchRules(s, "testMatch", testMatch ?? []),
    ...(testRegex ?? []).map((source) => testRegexRule(s, source)),
  ];
}

/** A `testRegex` rule, tested against the path from the repository root. */
function testRegexRule(s: Settings, source: string): RunnerRule {
  if (source.startsWith("^"))
    throw new UnreadableError(
      `testRegex ${JSON.stringify(source)} is anchored to an absolute path`,
    );
  const re = regex(source, "testRegex");
  return rule(s, "testRegex", source, (path) => re.test(absolute(path)));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UnreadableError(
      `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function asObject(value: unknown, what: string): LiteralObject {
  const literal = fromJson(value);
  if (!isLiteralObject(literal)) throw new UnreadableError(what);
  return literal;
}

/** The configuration object a file holds; null for a package.json without a jest key. */
function configObject(path: string, text: string): LiteralObject | null {
  if (nameOf(path) === "package.json") {
    if (!/"jest"\s*:/.test(text)) return null;
    const doc = parseJson(text);
    const jest = isRecord(doc) ? doc.jest : undefined;
    if (jest === undefined) return null;
    return asObject(
      jest,
      "its jest key names another file or is not an object",
    );
  }
  if (path.endsWith(".json"))
    return asObject(parseJson(text), "is not a JSON object");
  return exportedObject(text);
}

/** Every jest configuration among the repository's files. */
export function readJest(files: RepoFiles): Reading {
  const configs = files.paths.filter((p) => CONFIG.test(nameOf(p)));
  const configured = new Set(configs.map(folderOf));
  const manifests = files.paths.filter(
    (p) => nameOf(p) === "package.json" && !configured.has(folderOf(p)),
  );
  return readEach(READER, files, [...configs, ...manifests], (path, text) => {
    const obj = configObject(path, text);
    return obj === null ? null : jestRules(path, obj);
  });
}
