// Scope: Jig's licence files. Exit 1 when one of these does not hold:
// - LICENSE (Apache-2.0), LICENSE-MIT-0 and NOTICE exist at the root, and
//   plugin/LICENSE and plugin/NOTICE are byte copies of the root files (agent
//   tools install only plugin/, so it carries its own copy);
// - NOTICE lists exactly the files under modules/*/templates/, the files
//   licensed under MIT-0, so a template added, moved or removed updates it;
// - every third-party entry NOTICE lists is a licence file that exists, every
//   licence file in the repository is listed (the root's own files and
//   plugin/'s copies aside), and every `vendor/` folder holds a listed one.
// The repository's files are those present on disk; seeds/ and test fixtures
// are out of scope for every list. Each of NOTICE's two sections holds one
// list: everything after its first line ending in a colon, blank lines
// included, up to the end of the section. Each unindented line in it is a path,
// whether or not the file exists, so a listed path that is gone is always
// reported.
// Exit 2 when the repository's files cannot be listed or none is found.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cli } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
import { couldNotCheck } from "../lib/findings.ts";

const ROOT_FILES = ["LICENSE", "LICENSE-MIT-0", "NOTICE"];
const PLUGIN_COPIES = ["LICENSE", "NOTICE"];
const THIRD_PARTY = "Third-party code";
const TEMPLATE = /^modules\/[^/]+\/templates\//;
const LICENCE_FILE = /^(licen[cs]e|copying)([.-].*)?$|\.licen[cs]e$/i;
const OWN = new Set([
  ...ROOT_FILES,
  ...PLUGIN_COPIES.map((f) => `plugin/${f}`),
]);

const inScope = (f: string) =>
  !f.startsWith("seeds/") && !f.split("/").includes("fixtures");

/**
 * The paths NOTICE names before and after its third-party heading, which starts
 * a line (a path that contains the heading's words is still an entry). A section's
 * list is all of it after its first line ending in a colon, and each unindented
 * line there is one path; indented lines describe the entry above.
 */
function noticeLists(notice: string): {
  templates: string[];
  licences: string[];
} {
  const text = notice.replaceAll("\r\n", "\n");
  const at = text.search(new RegExp(`^${THIRD_PARTY}`, "m"));
  const before = at < 0 ? text : text.slice(0, at);
  const after = at < 0 ? "" : text.slice(at);
  const paths = (section: string) => {
    const lines = section.split("\n");
    const heading = lines.findIndex((line) => line.trimEnd().endsWith(":"));
    return heading < 0
      ? []
      : lines
          .slice(heading + 1)
          .filter((line) => /^\S/.test(line))
          .map((line) => line.trimEnd());
  };
  return { templates: paths(before), licences: paths(after) };
}

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x));
}

function rootProblems(root: string): string[] {
  const missing = ROOT_FILES.filter((f) => !existsSync(join(root, f))).map(
    (f) => `${f}: missing`,
  );
  if (missing.length) return missing;
  return PLUGIN_COPIES.filter(
    (f) =>
      !existsSync(join(root, "plugin", f)) ||
      readFileSync(join(root, "plugin", f), "utf8") !==
        readFileSync(join(root, f), "utf8"),
  ).map((f) => `plugin/${f}: not a copy of ${f} (cp ${f} plugin/${f})`);
}

function listProblems(
  files: string[],
  { templates, licences }: { templates: string[]; licences: string[] },
): string[] {
  const actual = files.filter((f) => TEMPLATE.test(f)).sort();
  const found = files.filter(
    (f) => LICENCE_FILE.test(basename(f)) && !OWN.has(f),
  );
  const present = new Set(files);
  const listed = licences.filter(
    (f) => present.has(f) && LICENCE_FILE.test(basename(f)),
  );
  const vendored = [
    ...new Set(
      files
        .filter((f) => f.split("/").includes("vendor"))
        .map((f) => f.slice(0, f.lastIndexOf("vendor/") + "vendor/".length)),
    ),
  ];
  return [
    ...difference(actual, templates).map(
      (f) => `NOTICE: template ${f} is not listed under MIT No Attribution`,
    ),
    ...difference(templates, actual).map(
      (f) => `NOTICE: ${f} is listed as a template but does not exist`,
    ),
    ...difference(licences, files).map(
      (f) => `NOTICE: licence file ${f} does not exist`,
    ),
    ...licences
      .filter((f) => present.has(f) && !LICENCE_FILE.test(basename(f)))
      .map(
        (f) => `NOTICE: ${f} is listed as a licence but is not a licence file`,
      ),
    ...difference(found, licences).map(
      (f) => `NOTICE: licence file ${f} is not listed under ${THIRD_PARTY}`,
    ),
    ...vendored
      .filter((dir) => !listed.some((f) => f.startsWith(dir)))
      .map((dir) => `${dir}: vendored code with no licence file NOTICE lists`),
  ];
}

export function checkLicences(root = "."): number {
  const files = repoFiles(root)
    .filter((f) => existsSync(join(root, f)))
    .map((f) => f.replaceAll("\\", "/"))
    .filter(inScope);
  if (!files.length) return couldNotCheck("licences", `no file under ${root}`);
  const problems = rootProblems(root);
  if (problems.length === 0)
    problems.push(
      ...listProblems(
        files,
        noticeLists(readFileSync(join(root, "NOTICE"), "utf8")),
      ),
    );
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log(
    `licences: OK — ${files.length} files; LICENSE, LICENSE-MIT-0 and NOTICE present, plugin/ carries copies, and NOTICE lists every template and licence file (seeds and fixtures are skipped)`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkLicences(process.argv[2]));
