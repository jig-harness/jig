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

/**
 * `text` with each `<!-- … -->` comment replaced by a space, scanned from
 * the start as XML reads it: a comment ends at the first `-->`, so a
 * `<!--` inside it is part of it. A comment that never closes leaves no
 * build to read, so the file is unreadable.
 */
function withoutComments(text: string): string {
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open === -1) return parts.join("") + text.slice(at);
    const close = text.indexOf("-->", open + 4);
    if (close === -1)
      throw new UnreadableError("has a comment (<!--) it never closes");
    parts.push(text.slice(at, open), " ");
    at = close + 3;
  }
}

/** The POM's own build, without comments and profiles. */
function ownBuild(text: string): string {
  return withoutComments(text).replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
}

/** The rules one POM declares. */
export function mavenRules(file: string, text: string): RunnerRule[] {
  const pom = ownBuild(text);
  if (/<packaging>\s*pom\s*<\/packaging>/.test(pom)) return [];
  const dir = folderOf(file);
  const declared =
    /<testSourceDirectory>\s*([^<]*?)\s*<\/testSourceDirectory>/.exec(pom);
  const rule = (key: string, pattern: string, folder: string) =>
    folderRule({ reader: READER, file, key, pattern }, folder);
  if (!declared)
    return [
      rule(`the ${DEFAULT} default`, DEFAULT, inside(dir, DEFAULT, DEFAULT)),
    ];
  const value = declared[1] as string;
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
