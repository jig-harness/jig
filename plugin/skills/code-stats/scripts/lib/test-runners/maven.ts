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
 * POM that is not well-formed XML as far as these values depend on it (a
 * comment that never closes, a closing tag that does not match the element
 * open, an element still open at the end, an `&` that is not one of XML's
 * predefined or numeric references) makes the POM unreadable, and nothing
 * is claimed from it. Character data is read with its references replaced.
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

/** The `>` ending the tag that opens at `open`, past any `>` inside a quoted attribute value; -1 when none does. */
function tagClose(text: string, open: number): number {
  let quote = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** The markup at `open`; an `UnreadableError` when it never closes. */
function markupAt(text: string, open: number): Markup {
  const skipped = SKIPPED.find(([o]) => text.startsWith(o, open));
  const [opener, closer, kind] = skipped ?? ["<", ">", "a tag"];
  const close = skipped
    ? text.indexOf(closer, open + opener.length)
    : tagClose(text, open);
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
  const scan: Scan = { values: new Map(), path: [], rooted: false };
  let value = "";
  let at = 0;
  for (
    let open = text.indexOf("<");
    open !== -1;
    open = text.indexOf("<", at)
  ) {
    const { end, adds, tag } = markupAt(text, open);
    value += characterData(text.slice(at, open)) + adds;
    at = end;
    if (!tag) continue;
    onTag(scan, tag, value);
    value = "";
  }
  const { path } = scan;
  if (path.length)
    throw new UnreadableError(
      `leaves <${path[path.length - 1]}> open at the end of the file`,
    );
  if (!scan.rooted) throw new UnreadableError("has no root element");
  return scan.values;
}

/** The elements read so far: their values, the path of those open, and whether any opened. */
interface Scan {
  values: Values;
  path: string[];
  rooted: boolean;
}

/** One tag read into `scan`; `value` is the text since the tag before. */
function onTag(scan: Scan, tag: NonNullable<Markup["tag"]>, value: string) {
  const { path } = scan;
  if (!tag.closing) {
    scan.rooted = true;
    if (!tag.empty) path.push(tag.name);
    return;
  }
  if (path[path.length - 1] !== tag.name)
    throw new UnreadableError(
      `closes <${tag.name}> where ${path.length ? `<${path[path.length - 1]}>` : "no element"} is open`,
    );
  scan.values.set(path.join("/"), value);
  path.pop();
}

/** The five references XML predefines. */
const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Whether `code` is a character XML allows: tab, line feed, carriage return, and the Unicode ranges outside surrogates, U+FFFE and U+FFFF. */
const isXmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/**
 * Character data with its references replaced, as XML reads it
 * (`qa&amp;checks` is `qa&checks`). An entity a DTD would declare cannot be
 * resolved from the text alone, so it makes the file unreadable.
 */
function characterData(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (ref, name: string) => {
    if (!ref.endsWith(";"))
      throw new UnreadableError(`has an & that starts no reference (${ref})`);
    const numeric = /^#(?:x([\da-fA-F]+)|(\d+))$/.exec(name);
    if (numeric) {
      const code = numeric[1]
        ? Number.parseInt(numeric[1], 16)
        : Number(numeric[2]);
      if (!isXmlChar(code))
        throw new UnreadableError(`has a reference to no character (${ref})`);
      return String.fromCodePoint(code);
    }
    const predefined = Object.hasOwn(PREDEFINED, name)
      ? PREDEFINED[name]
      : undefined;
    if (predefined === undefined)
      throw new UnreadableError(
        `has an entity reference it cannot resolve (${ref})`,
      );
    return predefined;
  });
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
