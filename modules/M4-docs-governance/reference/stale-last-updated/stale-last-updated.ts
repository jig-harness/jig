#!/usr/bin/env bun
// Stale last_updated gate: when a diff changes a document's body, the same
// diff must advance the frontmatter `last_updated`, or the date must already
// be today (UTC). A pure comparison of the two sides and their dates, no
// judgment of the change.
//
// Modes:
//   range   DIFF_RANGE (or --range=<range>) names the diff, such as
//           origin/main...HEAD. The new side is the working tree; the old side
//           is the merge base for A...B and A itself for A..B or a single ref.
//   staged  --staged, or no range outside CI: the index against HEAD, for a
//           pre-commit hook.
//   CI      --ci with no range at all skips the check and says so, rather
//           than passing silently. A range that is given but malformed
//           (`...HEAD`, an empty --range=) is an error in every mode.
//
// Changed documents come from `git diff --raw -M`: a renamed document is
// compared with its old path, only an added one is exempt, and a side that is
// not a regular file (a symlink, a submodule) fails.
import { readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  cli,
  type Frontmatter,
  isDate,
  readFrontmatter,
  splitLines,
} from "../docs";

interface Git {
  run(args: string[]): { ok: boolean; out: string; err: string };
  must(args: string[]): string;
}

function git(cwd = process.cwd()): Git {
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  };
  return {
    run,
    must(args) {
      const result = run(args);
      if (!result.ok)
        throw new Error(`git ${args.join(" ")} failed: ${result.err.trim()}`);
      return result.out;
    },
  };
}

/**
 * The body: every line after the frontmatter's closing `---`, line endings
 * normalised so a checkout's CRLF conversion is not a change. A document with
 * no frontmatter is all body; one whose frontmatter never closes has no body
 * that can be told apart, so it is undefined.
 */
export function bodyOf(
  text: string,
  frontmatter: Frontmatter,
): string | undefined {
  const lines = splitLines(text);
  if (!frontmatter.present) return lines.join("\n");
  if (frontmatter.end < 0) return undefined;
  return lines.slice(frontmatter.end + 1).join("\n");
}

/**
 * The `last_updated` value as the shared reader parses it, or "". Frontmatter
 * the reader rejects has no trustworthy date, so it reads as none.
 */
function dateOf(frontmatter: Frontmatter): string {
  if (frontmatter.errors.length) return "";
  const value = frontmatter.fields.get("last_updated");
  return typeof value === "string" ? value : "";
}

/**
 * Whether a changed body is covered by the date: the new date is a calendar
 * date later than the old one (or the old side had none), or it already
 * equals today. A value that is not a calendar date never counts.
 */
export function advanced(
  before: string,
  after: string,
  today: string,
): boolean {
  if (!isDate(after)) return false;
  return after === today || !isDate(before) || after > before;
}

/** A ref resolved to its commit id; the raw string never reaches another git call. */
function commit(ref: string, repo: Git): string {
  const id = repo.run([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!id.ok) throw new Error(`not a commit: ${ref}`);
  return id.out.trim();
}

export interface RangeSides {
  left: string;
  right: string;
  triple: boolean;
}

/**
 * Split a range into its sides: `A`, `A..B` or `A...B`, with exactly one
 * separator. An empty left side is not a range: defaulting it to HEAD would
 * compare HEAD with itself and pass every change. Returns why the range
 * cannot be used instead, when it cannot.
 */
export function rangeSides(range: string): RangeSides | string {
  const parts = range.split(/(\.\.\.?)/);
  if (parts.length > 3) return `the range '${range}' has more than one '..'`;
  const [left = "", separator = "", right = ""] = parts;
  if (!left.trim()) return `the range '${range}' has no left side`;
  return { left, right: right || "HEAD", triple: separator === "..." };
}

/**
 * The commit the range's old side is read from: the merge base for A...B,
 * else A. Both named sides are resolved, so a right side that does not exist
 * is an error even where only the left one is read.
 */
export function oldSide(range: string, repo: Git): string {
  const sides = rangeSides(range);
  if (typeof sides === "string") throw new Error(sides);
  const base = commit(sides.left, repo);
  const head = commit(sides.right, repo);
  if (!sides.triple) return base;
  return repo.must(["merge-base", "--end-of-options", base, head]).trim();
}

/** One changed document: its status, its paths, and whether both sides are regular files. */
export interface Change {
  status: "A" | "M" | "R" | "T";
  path: string;
  oldPath: string;
  /**
   * The file mode on each side that has one is a regular file (100644 or
   * 100755). A symlink or submodule holds no document text to compare.
   */
  regular: boolean;
}

const REGULAR = new Set(["100644", "100755"]);
const STATUSES = new Set(["A", "M", "R", "T"]);

/**
 * Read `git diff -z --raw` output: a `:<old mode> <new mode> <old> <new>
 * <status>` record, then its path (two for a rename, the old one first).
 * NUL-separated fields are never quoted, so a path with spaces or non-ASCII
 * characters arrives as written.
 */
export function readRawDiff(output: string): Change[] {
  const fields = output.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const [oldMode = "", newMode = "", , , code = ""] = (fields[i] ?? "")
      .slice(1)
      .split(" ");
    const status = code[0] ?? "";
    const paths = fields.slice(i + 1, i + (status === "R" ? 3 : 2));
    i += 1 + paths.length;
    if (!STATUSES.has(status)) continue;
    const modes = status === "A" ? [newMode] : [oldMode, newMode];
    changes.push({
      status: status as Change["status"],
      path: paths.at(-1) ?? "",
      oldPath: paths[0] ?? "",
      regular: modes.every((mode) => REGULAR.has(mode)),
    });
  }
  return changes;
}

interface Sides {
  /** The commit the old side is read from, or undefined when there is none. */
  oldCommit: string | undefined;
  /** The arguments that select the diff: the old commit, or --cached. */
  diffArgs: string[];
  /** The new content: the working tree in range mode, the index when staged. */
  read(path: string): string;
}

function rangeMode(range: string, repo: Git, root: string): Sides {
  const oldCommit = oldSide(range, repo);
  return {
    oldCommit,
    diffArgs: ["--end-of-options", oldCommit],
    read: (path) => readFileSync(join(root, path), "utf8"),
  };
}

function stagedMode(repo: Git): Sides {
  const head = repo.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return {
    oldCommit: head.ok ? head.out.trim() : undefined,
    diffArgs: ["--cached"],
    read: (path) => repo.must(["show", `:${path}`]),
  };
}

function changes(sides: Sides, repo: Git): Change[] {
  return readRawDiff(
    repo.must([
      "diff",
      "-z",
      "--raw",
      "--no-abbrev",
      "-M",
      "--diff-filter=AMRT",
      ...sides.diffArgs,
    ]),
  );
}

/**
 * During a merge, a staged file equal to one parent's version carries that
 * branch's content unchanged, and it already passed this gate there. A file
 * edited during the merge matches neither parent and is still checked.
 */
function carriedByMerge(change: Change, repo: Git): boolean {
  // Asked of git, not of a path, so the answer does not depend on the caller's directory.
  if (!repo.run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).ok)
    return false;
  const blob = (spec: string) => {
    const result = repo.run(["rev-parse", "--verify", "--quiet", spec]);
    return result.ok ? result.out.trim() : undefined;
  };
  const staged = blob(`:${change.path}`);
  return (
    staged !== undefined &&
    (staged === blob(`HEAD:${change.oldPath}`) ||
      staged === blob(`MERGE_HEAD:${change.path}`))
  );
}

/** Whether both sides have the same, readable body. */
function sameBody(
  old: string,
  before: Frontmatter,
  current: string,
  after: Frontmatter,
): boolean {
  const body = bodyOf(old, before);
  return body !== undefined && body === bodyOf(current, after);
}

/**
 * Judge one document from its old and new content: why it fails, or
 * undefined. A document that had no frontmatter on either side has no date
 * to keep; one whose frontmatter was removed, no longer closes, or holds a
 * construct the shared reader rejects cannot be checked, so it fails. An old
 * side the reader rejects has no date to compare with, so a corrected new
 * side passes on any calendar date: that is how such a document is migrated.
 */
export function judge(
  path: string,
  old: string,
  current: string,
  today: string,
): string | undefined {
  const before = readFrontmatter(old);
  const after = readFrontmatter(current);
  if (!before.present && !after.present) return undefined;
  if (!after.present || after.end < 0)
    return `${path}: its frontmatter was removed or no longer closes, so last_updated cannot be checked`;
  if (after.errors.length)
    return `${path}: its frontmatter cannot be read (${after.errors.join("; ")}), so last_updated cannot be checked`;
  if (sameBody(old, before, current, after)) return undefined;
  const date = dateOf(after);
  if (advanced(dateOf(before), date, today)) return undefined;
  return `${path}: the body changed but last_updated was not advanced (still '${date}'; today is ${today} UTC)`;
}

/**
 * Check one changed document. A new file (status A) is exempt: it has no
 * earlier date to advance, and the frontmatter check validates its date. Any
 * other side that cannot be read is an error, never a pass, and so is a side
 * that is not a regular file: a type change (T) included.
 */
function checkChange(
  change: Change,
  sides: Sides,
  repo: Git,
  today: string,
): string | undefined {
  if (!change.regular)
    return `${change.path}: it is not a regular file on both sides of the diff (a symlink or submodule), so last_updated cannot be checked`;
  if (change.status === "A" || !sides.oldCommit) return undefined;
  const old = repo.must(["show", `${sides.oldCommit}:${change.oldPath}`]);
  return judge(change.path, old, sides.read(change.path), today);
}

interface Options {
  /** The range given, or ""; staged mode resolves it without reading it. */
  range: string;
  staged: boolean;
  /** The note to print instead of checking, when CI was given no range. */
  skip: string;
  files: string[];
  today: string;
}

const FLAGS = new Set(["--staged", "--ci"]);

function readFlags(args: string[]): { range?: string; flags: Set<string> } {
  const flags = new Set<string>();
  let range: string | undefined;
  for (const arg of args.filter((a) => a.startsWith("--"))) {
    if (arg.startsWith("--range=")) range = arg.slice(8);
    else if (FLAGS.has(arg)) flags.add(arg);
    else
      throw new Error(
        `unknown option: ${arg} (use --staged, --ci or --range=<range>)`,
      );
  }
  return range === undefined ? { flags } : { range, flags };
}

const SKIP =
  "SKIP — no diff range (set DIFF_RANGE, e.g. origin/main...HEAD); the stale last_updated check did not run";

/** A given range, checked; "" when none was given. A malformed one is an error. */
function checkedRange(given: string | undefined): string {
  if (given === undefined) return "";
  const sides = rangeSides(given);
  if (typeof sides === "string") throw new Error(sides);
  return given;
}

function options(
  args: string[],
  env: Record<string, string | undefined>,
): Options {
  const { range: flagRange, flags } = readFlags(args);
  if (flags.has("--staged") && flagRange !== undefined)
    throw new Error("--staged and --range= select different diffs; give one");
  // An empty DIFF_RANGE reads as unset; an explicit empty --range= does not.
  // A supplied range is checked even where staged mode will not read it.
  const given = checkedRange(flagRange ?? (env.DIFF_RANGE || undefined));
  const staged = flags.has("--staged") || (!given && !flags.has("--ci"));
  return {
    range: given,
    staged,
    skip: staged || given ? "" : SKIP,
    files: args.filter((arg) => !arg.startsWith("--")),
    today: env.LAST_UPDATED_TODAY || new Date().toISOString().slice(0, 10),
  };
}

/**
 * A path in the operating system's canonical form, links resolved. The
 * native call also expands a Windows short (8.3) name, which a temporary
 * directory often carries and git never reports. A path that does not exist
 * keeps its name under its resolved directory.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return join(canonical(dirname(path)), basename(path));
  }
}

/**
 * Named files as repository-relative paths, whatever form they were given in:
 * each is placed relative to the working directory, then under the working
 * directory's own prefix as git reports it. Only the directory is
 * canonicalized: the file's own name is the path git tracks, so a document
 * that is itself a symlink is named as the link, not as its target. A path
 * outside the repository is an error, since it could never match a change and
 * would pass unchecked.
 */
function repoPaths(files: string[], cwd: Git): Set<string> {
  const prefix = cwd.must(["rev-parse", "--show-prefix"]).trim();
  const here = canonical(process.cwd());
  return new Set(
    files.map((file) => {
      const absolute = resolve(file);
      const local = relative(
        here,
        join(canonical(dirname(absolute)), basename(absolute)),
      );
      const path = posix.normalize(prefix + local.split(sep).join("/"));
      if (path === ".." || path.startsWith("../") || isAbsolute(local))
        throw new Error(`${file} is outside the repository`);
      return path;
    }),
  );
}

function failures(opts: Options): string[] {
  const cwd = git();
  const root = cwd.must(["rev-parse", "--show-toplevel"]).trim();
  const repo = git(root);
  // A supplied range that does not resolve is an error in every mode.
  if (opts.staged && opts.range) oldSide(opts.range, repo);
  const sides = opts.staged
    ? stagedMode(repo)
    : rangeMode(opts.range, repo, root);
  const named = repoPaths(opts.files, cwd);
  return changes(sides, repo)
    .filter((change) =>
      named.size ? named.has(change.path) : change.path.endsWith(".md"),
    )
    .filter((change) => !(opts.staged && carriedByMerge(change, repo)))
    .flatMap((change) => checkChange(change, sides, repo, opts.today) ?? []);
}

export function checkStale(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const opts = options(args, env);
  if (opts.skip) {
    console.log(opts.skip);
    return 0;
  }
  const found = failures(opts);
  if (found.length) {
    console.log(found.map((failure) => `FAIL ${failure}`).join("\n"));
    console.log(
      `\n${found.length} doc(s) changed without advancing last_updated: set it to today (${opts.today}).`,
    );
    return 1;
  }
  console.log("OK — last_updated advanced wherever a body changed");
  return 0;
}
if (import.meta.main) cli(() => checkStale());
