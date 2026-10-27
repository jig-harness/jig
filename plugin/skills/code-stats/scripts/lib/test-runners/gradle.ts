/**
 * Gradle: the `test` source set of each `build.gradle` or
 * `build.gradle.kts`. By convention its code lies in `src/test/<language>`
 * (`java`, `kotlin`, `groovy`, `scala`) beside the build file; a script adds
 * folders with `srcDir` or `srcDirs +=` and replaces the convention with
 * `srcDirs =` or `setSrcDirs`, in the forms `sourceSets.test.java…`,
 * `sourceSets["test"]…`, `sourceSets.getByName("test")…` and a `test`,
 * `getByName("test")`, `named("test")` or `val test by getting` block inside
 * `sourceSets { … }`. Only string literals are read, in a list or through
 * `file`, `files` or `listOf`; `resources` folders are not test code.
 *
 * A script whose test folders exist only when it runs (a variable, a string
 * with `$`, a loop over the source sets) is reported unreadable, and nothing
 * is claimed from it, not even the convention.
 */
import { gradleLayers } from "../modules.ts";
import { globUnder } from "./glob.ts";
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

const READER = "Gradle";
const BUILD = /^build\.gradle(\.kts)?$/;
const LANGUAGES = ["java", "kotlin", "groovy", "scala"];
const DOTTED =
  /\bsourceSets\s*(?:\.\s*test\b|\[\s*["']test["']\s*\]|\.\s*(?:getByName|named|getting)\s*\(\s*["']test["']\s*\))/g;
const BLOCK = /\bsourceSets\s*\{/g;
const TEST_IN_BLOCK =
  /(?:(?<![\w.])test\b|\b(?:getByName|named|maybeCreate|create)\s*\(\s*["']test["']\s*\)|\bval\s+test\s+by\s+getting)\s*([.{])/g;
const ITERATING =
  /\bsourceSets\s*\.\s*(?:all|configureEach|matching|forEach|each|filter|withType|whenObjectAdded)\b/;
const SRC_DIR = /\b(srcDirs|srcDir|setSrcDirs)\b/g;
const LANGUAGE = /\b(java|kotlin|groovy|scala|resources)\b/g;
const WRAPPERS =
  /\b(?:project\s*\.\s*)?(?:files|file|listOf|setOf|arrayOf|mutableListOf|mutableSetOf)\b/g;
const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;

/** The index of the bracket that closes the one at `open`, in `code`. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    const c = code[j] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return j;
  }
  return code.length;
}

/**
 * Where the statement from `i` ends: a line break or `;` outside brackets,
 * unless the line ends with `=`, `,` or `.` or the next starts with `.`;
 * or a bracket that closes an enclosing one.
 */
function statementEnd(code: string, i: number): number {
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return j;
      depth--;
    } else if (depth === 0 && (c === ";" || c === "\n")) {
      const continues =
        c === "\n" &&
        (/[=,.]\s*$/.test(code.slice(i, j)) ||
          /^\s*\./.test(code.slice(j + 1)));
      if (!continues) return j;
    }
  }
  return code.length;
}

/** The spans of the script that configure the `test` source set. */
function testScopes(code: string, strings: string): [number, number][] {
  const scopes: [number, number][] = [];
  const scopeAt = (end: number) => {
    const open = code.slice(end).search(/\S/) + end;
    return code[open] === "{"
      ? ([open + 1, closing(code, open)] as [number, number])
      : ([end, statementEnd(code, end)] as [number, number]);
  };
  for (const m of strings.matchAll(DOTTED))
    if (code[m.index as number] !== " ")
      scopes.push(scopeAt((m.index as number) + m[0].length));
  for (const m of strings.matchAll(BLOCK)) {
    const open = (m.index as number) + m[0].length - 1;
    const body = strings.slice(open + 1, closing(code, open));
    for (const t of body.matchAll(TEST_IN_BLOCK)) {
      const at = open + 1 + (t.index as number);
      const end = at + t[0].length;
      scopes.push(
        t[1] === "{"
          ? [end, closing(code, end - 1)]
          : [end, statementEnd(code, end)],
      );
    }
  }
  return scopes;
}

interface SourceDirs {
  dirs: { language: string; keyword: string; literal: string }[];
  replaced: Set<string>;
}

/** The language a `srcDir` at `at` configures: the nearest one named before it. */
function languageBefore(code: string, from: number, at: number): string | null {
  let language: string | null = null;
  for (const m of code.slice(from, at).matchAll(LANGUAGE))
    language = m[1] as string;
  return language;
}

/** The literal folders one `srcDir`, `srcDirs` or `setSrcDirs` call names. */
function literalArguments(
  code: string,
  strings: string,
  start: number,
  what: string,
): string[] {
  const end = statementEnd(code, start);
  const rest = code.slice(start, end).replace(WRAPPERS, "");
  const literals = [...strings.slice(start, end).matchAll(LITERAL)];
  const interpolated = literals.some((l) => l[1]?.includes("$"));
  if (!/^[\s,()[\]]*$/.test(rest) || interpolated)
    throw new UnreadableError(
      `${what} is computed when the build runs (${strings.slice(start, end).trim()})`,
    );
  return literals.map((l) => (l[1] ?? l[2]) as string);
}

function sourceDirs(text: string): SourceDirs {
  const { code, strings } = gradleLayers(text);
  const found: SourceDirs = { dirs: [], replaced: new Set() };
  const seen = new Set<number>();
  if (ITERATING.test(strings) && /\bsrcDirs?\b/.test(code))
    throw new UnreadableError(
      "configures its source sets in a loop, so their folders exist only when the build runs",
    );
  for (const [from, to] of testScopes(code, strings))
    for (const m of code.slice(from, to).matchAll(SRC_DIR)) {
      const at = from + (m.index as number);
      if (seen.has(at)) continue;
      seen.add(at);
      const keyword = m[1] as string;
      const language = languageBefore(code, from, at);
      if (language === null || language === "resources") continue;
      let start = at + keyword.length;
      const op = /^[ \t]*(\+=|=)?/.exec(code.slice(start)) as RegExpExecArray;
      start += op[0].length;
      if (op[1] === "=" || keyword === "setSrcDirs")
        found.replaced.add(language);
      const what = `sourceSets.test.${language}.${keyword}`;
      for (const literal of literalArguments(code, strings, start, what))
        found.dirs.push({ language, keyword, literal });
    }
  return found;
}

/** The rules one Gradle build script declares. */
export function gradleRules(file: string, text: string): RunnerRule[] {
  const dir = folderOf(file);
  const { dirs, replaced } = sourceDirs(text);
  const rule = (key: string, pattern: string, folder: string): RunnerRule => ({
    reader: READER,
    file,
    key,
    pattern,
    scope: folder,
    matches: (path) => under(folder, path),
  });
  const rules = LANGUAGES.filter((l) => !replaced.has(l)).map((l) =>
    rule(
      `the src/test/${l} convention`,
      `src/test/${l}`,
      globUnder(dir, `src/test/${l}`),
    ),
  );
  for (const d of dirs) {
    const key = `sourceSets.test.${d.language}.${d.keyword}`;
    rules.push(rule(key, d.literal, inside(dir, d.literal, key)));
  }
  return rules;
}

/** Every Gradle build script among the repository's files. */
export function readGradle(files: RepoFiles): Reading {
  const scripts = files.paths.filter((p) => BUILD.test(nameOf(p)));
  return readEach(READER, files, scripts, gradleRules);
}
