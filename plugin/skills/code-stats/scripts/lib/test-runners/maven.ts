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

/** The markup opening at a `<`: where it ends, the text it adds, and the tag it is. */
interface Markup {
  end: number;
  adds: string;
  tag: { closing: boolean; name: string; empty: boolean } | null;
}

/** The markup at `open`; an `UnreadableError` when it never closes. */
function markupAt(text: string, open: number): Markup {
  const skipped = SKIPPED.find(([o]) => text.startsWith(o, open));
  const [opener, closer, kind] = skipped ?? ["<", ">", "a tag"];
  const close = text.indexOf(closer, open + opener.length);
  if (close === -1) throw new UnreadableError(`has ${kind} it never closes`);
  const end = close + closer.length;
  if (skipped) {
    const cdata = opener === "<![CDATA[";
    return {
      end,
      adds: cdata ? text.slice(open + opener.length, close) : "",
      tag: null,
    };
  }
  const tag = /^<(\/?)([^\s/>]+)/.exec(text.slice(open, end));
  return {
    end,
    adds: "",
    tag: tag && {
      closing: tag[1] === "/",
      name: tag[2] as string,
      empty: text[close - 1] === "/",
    },
  };
}

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
  for (
    let open = text.indexOf("<");
    open !== -1;
    open = text.indexOf("<", at)
  ) {
    const { end, adds, tag } = markupAt(text, open);
    value += text.slice(at, open) + adds;
    at = end;
    if (!tag) continue;
    if (tag.closing) {
      values.set(path.join("/"), value);
      path.pop();
    } else if (!tag.empty) path.push(tag.name);
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
