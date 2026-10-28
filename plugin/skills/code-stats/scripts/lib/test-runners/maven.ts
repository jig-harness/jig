/**
 * Maven: each `pom.xml`'s `<build><testSourceDirectory>`, relative to the
 * POM's folder (`${project.basedir}` and `${basedir}` stand for it), or
 * Maven's default `src/test/java` when the POM does not set it. A POM with
 * `<packaging>pom</packaging>` aggregates other modules and has no test
 * code of its own.
 *
 * Not read: a value inside a `<profile>`, which applies only when the
 * profile is active, and one a module inherits from a parent POM. A
 * `testSourceDirectory` built from another property (`${tests.dir}`) is
 * reported unreadable, and nothing is claimed from that POM.
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

/** The POM's own build, without comments and profiles. */
function ownBuild(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
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
