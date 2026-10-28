/**
 * Maven: each `pom.xml`'s `<build><testSourceDirectory>`, relative to the
 * POM's folder (`${project.basedir}` and `${basedir}` stand for it), or
 * Maven's default `src/test/java` when the POM does not set it. A POM with
 * `<packaging>pom</packaging>` aggregates other modules and has no test
 * code of its own.
 *
 * Not read: a value inside a `<profile>`, which applies only when the
 * profile is active, and one a module inherits from a parent POM. A
 * `testSourceDirectory` built from another property (`${tests.dir}`), or a
 * comment that never closes, makes the POM unreadable, and nothing is
 * claimed from it.
 */
import {
  folderOf,
  folderRule,
  inside,
  nameOf,
  type Reading,
  type RepoFiles,
  type RunnerRule,
  readEach,
  UnreadableError,
} from "./model.ts";

const READER = "Maven";
const DEFAULT = "src/test/java";

/** The markup that holds no elements, each with what closes it. */
const SKIPPED: readonly [open: string, close: string, kind: string][] = [
  ["<!--", "-->", "a comment (<!--)"],
  ["<![CDATA[", "]]>", "a CDATA section"],
  ["<?", "?>", "a processing instruction (<?)"],
  ["<!", ">", "a declaration (<!)"],
];

/** The element values a POM's text holds, by their path from the root (`project/build/…`). */
type Values = Map<string, string>;

/**
 * The text of every element, keyed by its path, scanned from the start as
 * XML reads it: a comment adds nothing (`qa<!-- x -->/java` is `qa/java`),
 * a CDATA section adds its text, and markup inside either is not markup.
 * Markup that never closes leaves no build to read, so the file is
 * unreadable.
 */
function elementValues(text: string): Values {
  const values: Values = new Map();
  const path: string[] = [];
  let value = "";
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) break;
    value += text.slice(at, open);
    const skipped = SKIPPED.find(([o]) => text.startsWith(o, open));
    const close = skipped
      ? text.indexOf(skipped[1], open + skipped[0].length)
      : text.indexOf(">", open);
    if (close === -1)
      throw new UnreadableError(
        `has ${skipped ? skipped[2] : "a tag"} it never closes`,
      );
    if (skipped?.[0] === "<![CDATA[")
      value += text.slice(open + skipped[0].length, close);
    at = close + (skipped ? skipped[1].length : 1);
    if (skipped) continue;
    const tag = /^<(\/?)([^\s/>]+)/.exec(text.slice(open, close + 1));
    if (!tag) continue;
    if (tag[1]) {
      values.set(path.join("/"), value);
      path.pop();
    } else if (text[close - 1] !== "/") path.push(tag[2] as string);
    value = "";
  }
  return values;
}

/** The rules one POM declares. */
export function mavenRules(file: string, text: string): RunnerRule[] {
  const values = elementValues(text);
  if (values.get("project/packaging")?.trim() === "pom") return [];
  const dir = folderOf(file);
  const declared = values.get("project/build/testSourceDirectory")?.trim();
  const rule = (key: string, pattern: string, folder: string) =>
    folderRule({ reader: READER, file, key, pattern }, folder);
  if (!declared)
    return [
      rule(`the ${DEFAULT} default`, DEFAULT, inside(dir, DEFAULT, DEFAULT)),
    ];
  const value = declared;
  const relative = value.replace(/^\$\{(?:project\.)?basedir\}\/?/, "");
  if (relative.includes("${"))
    throw new UnreadableError(
      `testSourceDirectory ${JSON.stringify(value)} is built from a property`,
    );
  return [
    rule(
      "testSourceDirectory",
      value,
      inside(dir, relative || ".", "testSourceDirectory"),
    ),
  ];
}

/** Every Maven POM among the repository's files. */
export function readMaven(files: RepoFiles): Reading {
  const poms = files.paths.filter((p) => nameOf(p) === "pom.xml");
  return readEach(READER, files, poms, mavenRules);
}
