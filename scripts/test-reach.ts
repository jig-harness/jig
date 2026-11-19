// Scope: which test files a change can affect, derived from the repository's
// own files rather than declared in the change-area catalog. Walking back from
// the changed files, a file reaches what imports it (static imports, re-exports,
// `require` and dynamic imports with literal paths; `import type` loads nothing
// and gives no edge) and, since tests also start scripts and read data files
// by path, each file of the test code that names its file name. A Markdown file
// gives no such edge unless it is a fixture (under a `fixtures/` directory),
// so a change to prose alone reaches no test. CI's test legs run the test files the walk reaches (scripts/area-validation.ts).
//
// Every doubt falls toward running more: a code file that cannot be read or
// scanned may import anything, so it counts as reached by every change. The
// walk runs in CI's areas job, which installs nothing, so it uses Bun's own
// scanner and this repository's code alone.
import { join, posix } from "node:path";
import { readRegularFile } from "../lib/files.ts";
import { swallow } from "../plugin/shared/errors.ts";

/** A repository file's text by its relative path; throws when unreadable. */
export type ReadFile = (file: string) => string;

export interface TestReach {
  /** The test files the change reaches, a changed test file among them. */
  tests: string[];
  /** Changed files every test run loads: its configuration, launcher and preloads. */
  everyRun: string[];
}

/** The reach of a change nothing was walked for. */
export const NO_REACH: TestReach = { tests: [], everyRun: [] };

const BUNFIG = "bunfig.toml";

/** The launcher every test run goes through (`package.json`'s `test`). */
const LAUNCHER = "scripts/test.ts";

/** What a code file's extension loads as; declaration files load nothing. */
const LOADERS: Record<string, Bun.JavaScriptLoader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

/** What a relative specifier may leave out, in Bun's order of trying. */
const IMPLIED = [
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * A script's or data file's name as a test's text spells it, with any path.
 * It starts only where a name starts, so a long run of name characters is
 * scanned once rather than from every position.
 */
const FILE_NAME =
  /(?<![\w./-])[\w./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|sh|py|ya?ml|json|toml|txt|tsv|md)\b/g;

/** An import or re-export of types alone: its path names nothing that runs. */
const TYPE_ONLY =
  /\b(?:import|export)\s+(?:type\b[^;"'`]*?|\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*(?:,\s*)?)+\}\s*)from\s*["'`][^"'`]*["'`]/g;

/** Helpers beside the tests: they start scripts on the tests' behalf. */
const TEST_SUPPORT = /(?:^|\/)(?:__tests__|test-helpers)\//;

/** Prose leads to tests only as a fixture, which a test reads as data. */
const isProse = (file: string) =>
  /\.md$/.test(file) && !/(?:^|\/)fixtures\//.test(file);

const isDeclaration = (file: string) => /\.d\.[cm]?ts$/.test(file);

/** Reads the repository at `root`. */
export const fileReader =
  (root: string): ReadFile =>
  (file) =>
    readRegularFile(join(root, file));

function loaderOf(file: string): Bun.JavaScriptLoader | undefined {
  return isDeclaration(file) ? undefined : LOADERS[posix.extname(file)];
}

const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>();

/** The specifiers `source` loads at run time; throws when it does not parse. */
function scanSpecifiers(file: string, source: string): string[] {
  const loader = loaderOf(file);
  if (loader === undefined) return [];
  let transpiler = transpilers.get(loader);
  if (transpiler === undefined) {
    transpiler = new Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  // The scanner refuses a `#!` line, which Bun itself skips when running.
  const body = source.startsWith("#!") ? `//${source}` : source;
  return transpiler.scanImports(body).map((entry) => entry.path);
}

/** The known file a relative specifier in `from` loads, if any. */
function resolveSpecifier(
  specifier: string,
  from: string,
  known: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const path = specifier.replace(/[?#].*$/, "");
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  // TypeScript sources are imported under their compiled `.js` name too.
  const compiled = target.replace(/\.[cm]?jsx?$/, "");
  const candidates = [
    target,
    ...IMPLIED.map((suffix) => target + suffix),
    ...(compiled === target ? [] : [`${compiled}.ts`, `${compiled}.tsx`]),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

function append(lists: Map<string, string[]>, key: string, value: string) {
  const list = lists.get(key);
  if (list === undefined) lists.set(key, [value]);
  else list.push(value);
}

/** What `bunfig.toml` says about test runs; undefined when it cannot be read. */
function testConfig(
  known: Set<string>,
  read: ReadFile,
): { preload: string[]; ignored: Bun.Glob[] } | undefined {
  if (!known.has(BUNFIG)) return { preload: [], ignored: [] };
  try {
    const { test } = Bun.TOML.parse(read(BUNFIG)) as {
      test?: { preload?: string[]; pathIgnorePatterns?: string[] };
    };
    return {
      preload: (test?.preload ?? []).map((file) => posix.normalize(file)),
      ignored: (test?.pathIgnorePatterns ?? []).map((p) => new Bun.Glob(p)),
    };
  } catch (error) {
    swallow(error, `${BUNFIG} unreadable: every test run counts as affected`);
    return undefined;
  }
}

/** The files `bun test` runs: test names outside its ignored paths. */
export function runnableTests(tracked: string[], read: ReadFile): string[] {
  const ignored = testConfig(new Set(tracked), read)?.ignored ?? [];
  return tracked.filter(
    (file) => /\.test\.tsx?$/.test(file) && !ignored.some((g) => g.match(file)),
  );
}

/** Whether `file` is `path` or ends in it at a directory boundary. */
const pathEndsWith = (file: string, path: string) =>
  file === path || file.endsWith(`/${path}`);

/** What the walk follows, read from the code files of the repository. */
interface Edges {
  imports: Map<string, string[]>;
  importers: Map<string, string[]>;
  /** By file name: the test code spelling it, and the path it spells. */
  namedBy: Map<string, { by: string; path: string }[]>;
  /** The code files that could not be read or scanned. */
  opaque: string[];
}

/** Adds what `file` imports and, for test code, the file names it spells. */
function addEdges(
  edges: Edges,
  file: string,
  source: string,
  specifiers: string[],
  known: Set<string>,
  tests: Set<string>,
) {
  const targets = specifiers.flatMap(
    (specifier) => resolveSpecifier(specifier, file, known) ?? [],
  );
  edges.imports.set(file, targets);
  for (const target of targets) append(edges.importers, target, file);
  if (!tests.has(file) && !TEST_SUPPORT.test(file)) return;
  const text = source.replace(TYPE_ONLY, "");
  for (const spelled of new Set(text.match(FILE_NAME))) {
    const path = spelled.replace(/^(?:\.{0,2}\/)+/, "");
    const name = posix.basename(path);
    const named = edges.namedBy.get(name);
    if (named === undefined) edges.namedBy.set(name, [{ by: file, path }]);
    else named.push({ by: file, path });
  }
}

function readEdges(
  tracked: string[],
  known: Set<string>,
  tests: Set<string>,
  read: ReadFile,
): Edges {
  const edges: Edges = {
    imports: new Map(),
    importers: new Map(),
    namedBy: new Map(),
    opaque: [],
  };
  for (const file of tracked) {
    if (loaderOf(file) === undefined) continue;
    try {
      const source = read(file);
      const specifiers = scanSpecifiers(file, source);
      addEdges(edges, file, source, specifiers, known, tests);
    } catch (error) {
      swallow(error, `${file} unscanned: it counts as reached`);
      edges.opaque.push(file);
    }
  }
  return edges;
}

/** How many of `files` carry each file name. */
function nameCounts(files: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const name = posix.basename(file);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/** The test code that names `file`, as far as its text can tell. */
function namersOf(
  file: string,
  edges: Edges,
  counts: Map<string, number>,
): string[] {
  const name = posix.basename(file);
  const shared = (counts.get(name) ?? 0) > 1;
  // A bare name could mean any file of that name, so it keeps them all.
  return (edges.namedBy.get(name) ?? [])
    .filter(
      ({ path }) => !shared || !path.includes("/") || pathEndsWith(file, path),
    )
    .map(({ by }) => by);
}

/** The changed files, the opaque ones and everything leading back to them. */
function walkBack(
  changed: string[],
  edges: Edges,
  known: Set<string>,
  tests: Set<string>,
): Set<string> {
  const counts = nameCounts(known);
  const reached = new Set([...changed, ...edges.opaque]);
  for (const file of reached) {
    for (const importer of edges.importers.get(file) ?? [])
      reached.add(importer);
    // A test is run, never started by another, so a name leads on from code only.
    if (tests.has(file) || isProse(file)) continue;
    for (const namer of namersOf(file, edges, counts)) reached.add(namer);
  }
  return reached;
}

/**
 * The test files `changed` can affect, walking back through `tracked`, and
 * the changed files every test run loads (`bunfig.toml`, the launcher, its
 * preloads and what they import), which no selection of tests can narrow. A file name several
 * files share leads on only where the text spells enough of the path to tell
 * which is meant; a bare name leads on from every file of that name.
 */
export function testReach(
  changed: string[],
  tracked: string[],
  read: ReadFile,
): TestReach {
  if (changed.length === 0) return NO_REACH;
  // A deleted file is no longer tracked, and what imported it is still owed.
  const known = new Set([...tracked, ...changed]);
  const config = testConfig(known, read);
  const tests = new Set(runnableTests(tracked, read));
  const edges = readEdges(tracked, known, tests, read);
  const reached = walkBack(changed, edges, known, tests);
  return {
    tests: [...reached].filter((file) => tests.has(file)).sort(),
    everyRun: everyRunFiles(
      changed,
      config,
      edges.imports,
      new Set(edges.opaque),
    ),
  };
}

/** The changed files among what every test run loads. */
function everyRunFiles(
  changed: string[],
  config: ReturnType<typeof testConfig>,
  imports: Map<string, string[]>,
  opaque: Set<string>,
): string[] {
  if (config === undefined) return changed;
  const loaded = new Set([BUNFIG, LAUNCHER, ...config.preload]);
  for (const file of loaded)
    for (const target of imports.get(file) ?? []) loaded.add(target);
  // A preload that cannot be scanned may load any file.
  if ([...loaded].some((file) => opaque.has(file))) return changed;
  return changed.filter((file) => loaded.has(file));
}
