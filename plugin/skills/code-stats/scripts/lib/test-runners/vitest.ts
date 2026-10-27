/**
 * vitest: `test.include` and `test.exclude` from `vitest.config.*` or,
 * in a folder without one, `vite.config.*` (vitest reads the vite
 * configuration only then). Patterns are relative to the configuration's
 * folder, or to `test.dir`, `test.root` or `root` where one is a literal.
 * Without `test.exclude`, vitest's default exclusions apply; a spread of
 * `configDefaults.exclude` or `configDefaults.include` stands for those
 * defaults. The exclusions are the widest vitest has shipped, so a file any
 * version leaves out is never claimed.
 *
 * Not read: `test.projects` and workspace files (each project's own
 * configuration is read where it is tracked). A `vite.config.*` that
 * cannot be read is reported only when it mentions `test:` or vitest; one
 * that does neither configures no tests.
 */
import { globMatcher } from "./glob.ts";
import {
  exportedObject,
  type LiteralObject,
  stringAt,
  stringsAt,
} from "./js-literal.ts";
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
  within,
} from "./model.ts";

const READER = "vitest";
const VITEST = /^vitest\.config\.[cm]?[jt]s$/;
const VITE = /^vite\.config\.[cm]?[jt]s$/;
const DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];
const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
];
const SPREADS: Record<string, readonly string[]> = {
  "configDefaults.include": DEFAULT_INCLUDE,
  "configDefaults.exclude": DEFAULT_EXCLUDE,
  defaultInclude: DEFAULT_INCLUDE,
  defaultExclude: DEFAULT_EXCLUDE,
};

/** The folder vitest's patterns are relative to. */
function base(file: string, obj: LiteralObject): string {
  const dir = folderOf(file);
  for (const keys of [["test", "dir"], ["test", "root"], ["root"]]) {
    const value = stringAt(obj, keys);
    if (value !== null) return inside(dir, value, keys.join("."));
  }
  return dir;
}

function relativeGlob(pattern: string, key: string): (path: string) => boolean {
  if (pattern.startsWith("/") || pattern.split("/").includes(".."))
    throw new UnreadableError(
      `${key} ${JSON.stringify(pattern)} leaves the configuration's folder`,
    );
  return globMatcher(pattern);
}

/** The rules a vitest configuration object declares. */
export function vitestRules(file: string, obj: LiteralObject): RunnerRule[] {
  const include = stringsAt(obj, ["test", "include"], SPREADS);
  if (include === null) return [];
  const folder = base(file, obj);
  const exclude = [
    ...(stringsAt(obj, ["test", "exclude"], SPREADS) ?? DEFAULT_EXCLUDE),
    ...include.filter((p) => p.startsWith("!")).map((p) => p.slice(1)),
  ].map((p) => relativeGlob(p, "test.exclude"));
  return include
    .filter((p) => !p.startsWith("!"))
    .map((pattern) => {
      const glob = relativeGlob(pattern, "test.include");
      return {
        reader: READER,
        file,
        key: "test.include",
        pattern,
        scope: folder,
        matches: (path: string) => {
          if (!under(folder, path)) return false;
          const relative = within(folder, path);
          return glob(relative) && !exclude.some((x) => x(relative));
        },
      };
    });
}

/** Whether an unreadable vite configuration may configure tests. */
const mentionsTests = (text: string) => /\btest\s*:|vitest/.test(text);

/** Every vitest configuration among the repository's files. */
export function readVitest(files: RepoFiles): Reading {
  const vitest = files.paths.filter((p) => VITEST.test(nameOf(p)));
  const configured = new Set(vitest.map(folderOf));
  const vite = files.paths.filter(
    (p) => VITE.test(nameOf(p)) && !configured.has(folderOf(p)),
  );
  return readEach(READER, files, [...vitest, ...vite], (path, text) => {
    if (VITE.test(nameOf(path)) && !mentionsTests(text)) return null;
    return vitestRules(path, exportedObject(text));
  });
}
