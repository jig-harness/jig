#!/usr/bin/env bun
// Tests come with changes: every changed source file has a test, or a
// registered exemption that says why it needs none.
//
// The gate knows nothing about a repository's layout. Which paths are source
// (`--source`), where a source file's test lives (`--test`, a template) and
// which paths are exempt (`--exemptions`, a file of `<glob> <reason>` lines)
// all arrive as arguments, so one script serves any language whose tests sit
// at a path derived from the source path.
//
// Templates use these placeholders, taken from the changed path:
//   {dir}           its directory ("." at the repository root)
//   {dir:FROM=TO}   its directory with the leading FROM replaced by TO; a
//                   source outside FROM gets no test path from this template
//   {name}          its file name without the last extension
//   {ext}           its last extension, without the dot; a template using it
//                   names no test for a file without an extension
// A placeholder may repeat ({dir} excepted: one per template), and stands for
// the same text each time. A template, and FROM and TO, are written in normal
// form: no empty, `.` or `..` segment, no leading or trailing `/`, and no
// `{dir}` as the last segment.
// so `{dir}/{name}.test.{ext}` maps src/orders.ts to src/orders.test.ts, and
// `{dir:src/main/java=src/test/java}/{name}Test.java` maps
// src/main/java/shop/Orders.java to src/test/java/shop/OrdersTest.java.
// A changed file that matches a template's shape is a test, never a source
// that needs one, so test files may sit inside the source globs. In that
// shape `{ext}` matches one extension, without a dot, as it does when a test
// path is made.
//
// A test is a regular file. A directory at a test path does not count, and
// neither does a symbolic link, at the path or at a directory above it: git
// records a link, not the files it points at, so following it on disk would
// let the two modes disagree.
//
// The changed paths come from git (`--base <ref>`: files added, copied,
// modified, renamed or changed in type since the merge base of <ref> and
// HEAD, with tests looked up in HEAD) or from a list (`--changed <file>`, `-` for standard
// input, with tests looked up on disk under `--root`). With
// `--require-changed`, the test must be part of the same change, not merely
// exist.
//
// Exemptions prune themselves: an exemption whose glob matches no file in the
// tree the gate checks (HEAD with `--base`, the `--root` tree on disk with
// `--changed`) fails the gate, whatever the change touched. Otherwise it
// would outlive the code it excused and silently exempt new code created at
// that path later. An exemption whose only file the change deletes is stale
// in that same change, so it leaves with what it excused.
//
// Exit codes: 0 every changed source file has a test or an exemption and
// every exemption matches a file; 1 at least one changed source has neither,
// or an exemption matches no file; 2 a usage error (including an empty source
// glob or test template), an exemption without a reason, or git failing. A
// failure to read the change is never a pass.
//
// Usage:
//   bun check-tests-with-changes.ts --base origin/main \
//     --source 'src/**/*.ts' --test '{dir}/{name}.test.{ext}' \
//     --test '{dir}/__tests__/{name}.test.{ext}' --exemptions .config/test-exemptions.txt
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";

const USAGE =
  "usage: check-tests-with-changes.ts (--base <ref> | --changed <file|->) --source <glob>... --test <template>... [--exemptions <file>] [--root <dir>] [--require-changed]";

interface Change {
  changed: string[];
  exists: (path: string) => boolean;
  /** Where the tree is, for a report: "HEAD" or the root directory. */
  tree: string;
  /** Every file in the tree, a symbolic link included, a directory not. */
  files: () => Iterable<string>;
}

interface Exemption {
  glob: Bun.Glob;
  pattern: string;
  /** 1-based line number in the exemptions file. */
  line: number;
}

const DIR = /\{dir(?::([^=}]*)=([^}]*))?\}/g;
const PLACEHOLDER = /\{dir(?::([^=}]*)=([^}]*))?\}|\{name\}|\{ext\}/g;

/** The directory a `{dir}` or `{dir:FROM=TO}` placeholder stands for, or null when FROM does not apply. */
function mapDir(dir: string, from?: string, to?: string): string | null {
  if (from === undefined || to === undefined) return dir;
  if (dir === from) return to;
  return dir.startsWith(`${from}/`) ? to + dir.slice(from.length) : null;
}

/** Whether a relative path is already in the form `posix.normalize` gives it. */
const isNormal = (path: string) =>
  path.split("/").every((segment) => !["", ".", ".."].includes(segment));

/**
 * Refuse a `{dir:FROM=TO}` with an empty side, which would match every source
 * or none; a second directory placeholder, whose test shape could not
 * require both to stand for the same directory; and a template not in normal
 * form. The test path is normalized once made but the test shape matches the
 * template as written, so they agree only when normalizing has nothing to do
 * beyond dropping a `{dir}` that stands for the root.
 */
function checkTemplate(template: string): void {
  const dirs = [...template.matchAll(DIR)];
  for (const [, from, to] of dirs) {
    if (from === "" || to === "")
      throw new Error(
        `test template ${template}: {dir:FROM=TO} needs both FROM and TO`,
      );
    if (
      from !== undefined &&
      to !== undefined &&
      !(isNormal(from) && isNormal(to))
    )
      throw new Error(
        `test template ${template}: {dir:FROM=TO} is not in normal form`,
      );
  }
  if (dirs.length > 1)
    throw new Error(
      `test template ${template}: use at most one {dir} or {dir:FROM=TO}`,
    );
  // Each placeholder stands for text that is itself in normal form.
  const literal = template.replace(DIR, "d").replace(/\{(name|ext)\}/g, "x");
  if (!isNormal(literal) || /(^|\/)\{dir\}$/.test(template))
    throw new Error(`test template ${template}: not in normal form`);
}

/** One template's test path for a source, or null when the template does not apply to it. */
function testPath(
  template: string,
  parts: { dir: string; name: string; ext: string },
): string | null {
  if (template.includes("{ext}") && !parts.ext) return null;
  let applies = true;
  // One pass over the template, so text a placeholder inserts is never read
  // as a placeholder; a callback inserts it literally, where a string would
  // read `$&` and `$$`.
  const path = template.replace(
    PLACEHOLDER,
    (whole, from?: string, to?: string) => {
      if (whole === "{name}") return parts.name;
      if (whole === "{ext}") return parts.ext;
      const mapped = mapDir(parts.dir, from, to);
      if (mapped === null) applies = false;
      return mapped ?? "";
    },
  );
  return applies ? posix.normalize(path) : null;
}

/**
 * The test paths the templates name for one source path. A template using
 * `{ext}` names none for a file without an extension.
 */
export function testPaths(source: string, templates: string[]): string[] {
  for (const template of templates) checkTemplate(template);
  const ext = posix.extname(source);
  const parts = {
    dir: posix.dirname(source),
    name: posix.basename(source, ext),
    ext: ext.slice(1),
  };
  return templates.flatMap((template) => testPath(template, parts) ?? []);
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher for exactly the paths a template can produce, so a test is never
 * treated as a source and a source is never excused as a test. A placeholder
 * used twice stands for the same text both times, as it does in `testPath`.
 */
function testShape(template: string): RegExp {
  const parts = template.split(/(\{dir(?::[^}]*)?\}\/?|\{name\}|\{ext\})/);
  const seen = new Set<string>();
  const capture = (group: string, text: string) => {
    if (seen.has(group)) return `\\k<${group}>`;
    seen.add(group);
    return `(?<${group}>${text})`;
  };
  const pattern = parts
    .map((part) => {
      if (part === "{name}") return capture("name", "[^/]+");
      if (part === "{ext}") return capture("ext", "[^/.]+");
      const dir = /^\{dir(?::[^=}]*=([^}]*))?\}(\/?)$/.exec(part);
      if (!dir) return escapeRegExp(part);
      const [, to, slash] = dir;
      if (to === undefined) return slash ? "(?:.*/)?" : ".*";
      return `${escapeRegExp(to)}(?:/.*)?${slash}`;
    })
    .join("");
  return new RegExp(`^${pattern}$`);
}

function readExemptions(file: string | undefined): Exemption[] {
  if (!file) return [];
  const exemptions: Exemption[] = [];
  for (const [index, raw] of readFileSync(file, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern = "", ...reason] = line.split(/\s+/);
    if (!reason.length)
      throw new Error(
        `${file}:${index + 1}: an exemption needs a reason after its glob: ${line}`,
      );
    exemptions.push({ glob: new Bun.Glob(pattern), pattern, line: index + 1 });
  }
  return exemptions;
}

/**
 * The exemptions no file in the tree matches. The tree is read once, and the
 * read stops as soon as every exemption has matched a file.
 */
function staleExemptions(exemptions: Exemption[], change: Change) {
  const unmatched = new Set(exemptions);
  if (!unmatched.size) return [];
  for (const path of change.files()) {
    for (const exemption of unmatched)
      if (exemption.glob.match(path)) unmatched.delete(exemption);
    if (!unmatched.size) break;
  }
  return [...unmatched];
}

function git(args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`,
    );
  return run.stdout.toString();
}

const nulList = (out: string) => out.split("\0").filter(Boolean);

function fromGit(base: string): Change {
  const changed = nulList(
    git(["diff", "--name-only", "-z", "--diff-filter=ACMRT", `${base}...HEAD`]),
  );
  // Each entry is "<mode> <type> <object>\t<path>". A test must be a regular
  // file; an exemption may match any file, a symbolic link included.
  const entries = nulList(
    git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]),
  ).map((entry) => ({
    mode: entry.slice(0, entry.indexOf(" ")),
    path: entry.slice(entry.indexOf("\t") + 1),
  }));
  const regular = new Set(
    entries
      .filter(({ mode }) => mode === "100644" || mode === "100755")
      .map(({ path }) => path),
  );
  const files = entries
    .filter(({ mode }) => mode !== "160000")
    .map(({ path }) => path);
  return {
    changed,
    exists: (path) => regular.has(path),
    tree: "HEAD",
    files: () => files,
  };
}

/**
 * Every file under `root`, relative to it with `/` between segments: links
 * are listed but not followed, and the `.git` directory is left out.
 */
function* walk(root: string, dir = ""): Generator<string> {
  for (const entry of readdirSync(posix.join(root, dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) yield path;
    else if (path !== ".git") yield* walk(root, path);
  }
}

/**
 * Whether a path under `root` is a regular file reached through real
 * directories only, which is what git's inventory of HEAD records: a link at
 * the path or at any directory above it within `root` does not count. A
 * missing path is no file; any other failure to read it throws (exit 2).
 */
function isRegularFile(root: string, path: string): boolean {
  const parts = posix.normalize(path).split("/");
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = posix.join(at, part);
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (index === parts.length - 1) return stat?.isFile() ?? false;
    if (!stat?.isDirectory()) return false;
  }
  return false;
}

function fromList(list: string, root: string): Change {
  const text =
    list === "-" ? readFileSync(0, "utf8") : readFileSync(list, "utf8");
  const changed = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    changed,
    exists: (path) => isRegularFile(root, path),
    tree: root,
    files: () => walk(root),
  };
}

interface Options {
  change: Change;
  sources: Bun.Glob[];
  templates: string[];
  shapes: RegExp[];
  exemptions: Exemption[];
  requireChanged: boolean;
  exemptionsFile: string | undefined;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      changed: { type: "string" },
      root: { type: "string", default: "." },
      source: { type: "string", multiple: true, default: [] },
      test: { type: "string", multiple: true, default: [] },
      exemptions: { type: "string" },
      "require-changed": { type: "boolean", default: false },
    },
  });
  const bothOrNeither = !values.base === !values.changed;
  if (!values.source.length || !values.test.length || bothOrNeither)
    throw new Error(USAGE);
  for (const [flag, list] of [
    ["--source", values.source],
    ["--test", values.test],
  ] as const)
    if (list.some((item) => !item.trim()))
      throw new Error(`${flag} must not be empty\n${USAGE}`);
  for (const template of values.test) checkTemplate(template);
  return {
    change: values.base
      ? fromGit(values.base)
      : fromList(values.changed ?? "-", values.root),
    sources: values.source.map((pattern) => new Bun.Glob(pattern)),
    templates: values.test,
    shapes: values.test.map(testShape),
    exemptions: readExemptions(values.exemptions),
    requireChanged: values["require-changed"],
    exemptionsFile: values.exemptions,
  };
}

/** Whether a changed path is a source file the rule covers. */
function needsTest(path: string, o: Options): boolean {
  return (
    o.sources.some((glob) => glob.match(path)) &&
    !o.shapes.some((shape) => shape.test(path)) &&
    !o.exemptions.some(({ glob }) => glob.match(path))
  );
}

/** The line reporting a source without a test, or null when it has one. */
function missingTest(path: string, o: Options, inChange: Set<string>) {
  const candidates = testPaths(path, o.templates);
  const found = candidates.some(
    (test) =>
      o.change.exists(test) && (!o.requireChanged || inChange.has(test)),
  );
  return found ? null : `  ${path} (looked for: ${candidates.join(", ")})`;
}

export function checkTestsWithChanges(argv: string[]): number {
  const o = parseOptions(argv);
  const inChange = new Set(o.change.changed);
  const missing = o.change.changed
    .filter((path) => needsTest(path, o))
    .flatMap((path) => missingTest(path, o, inChange) ?? []);
  const stale = staleExemptions(o.exemptions, o.change);
  if (missing.length) {
    const alongside = o.requireChanged ? " changed alongside" : "";
    const where = o.exemptionsFile
      ? ` in ${o.exemptionsFile}`
      : " (--exemptions <file>)";
    console.error(
      `ERROR: ${missing.length} changed source file(s) without a test${alongside}:\n${missing.join("\n")}\nAdd the test, or register an exemption with its reason${where}.`,
    );
  }
  if (stale.length) {
    const tree =
      o.change.tree === "HEAD" ? "in HEAD" : `under ${o.change.tree}`;
    const lines = stale.map(
      ({ pattern, line }) =>
        `  ${o.exemptionsFile}:${line}: ${pattern} matches no file ${tree}`,
    );
    console.error(
      `ERROR: ${stale.length} exemption(s) matching no file:\n${lines.join("\n")}\nDelete each line: what it excused is gone, and it would exempt new code at that path.`,
    );
  }
  if (missing.length || stale.length) return 1;
  const exemptions = o.exemptions.length
    ? `, ${o.exemptions.length} exemption(s) each matching a file in ${o.change.tree}`
    : "";
  console.log(
    `OK: every changed source file has a test or an exemption (${o.change.changed.length} changed path(s) checked${exemptions}).`,
  );
  return 0;
}

if (import.meta.main) cli(() => checkTestsWithChanges(process.argv.slice(2)));
