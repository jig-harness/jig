#!/usr/bin/env bun
// A migration that has merged is never edited, renamed or deleted.
//
// The rule it holds. Once a migration file is on the branch a change merges
// into, it is presumed applied to some environment, and the runner there
// recorded its content hash when it applied it. Editing the file makes that
// environment refuse every later migration; renaming or deleting it leaves
// the runner with a ledger entry and no file to check it against. The fix
// for a wrong migration is a new one (fix forward), never a changed one.
//
// What it does. Lists the migration files that changed between the merge
// base of `--base` and `--head` and the head, and reports each that was
// modified, deleted, renamed or changed type. A modification is allowed in
// one case: when the head's content (mode and bytes) is a state this path
// held in some commit of the base branch, which repairs an earlier illegal
// edit and is what makes the apply-time hash check pass again. A deletion
// or a rename is never allowed. Files added on the head are not checked:
// nothing has applied them.
//
// A migration file is a path under the directory that matches `--match`
// (default: it ends in `.sql`); the ledger and snapshots beside the files
// are metadata, legitimately edited when a migration is added, so they do
// not match.
//
// Exit codes: 0 no applied migration changed, 1 findings, 2 could not check
// (a reference that does not resolve, no merge base, a directory with no
// migration file at either side, a repository git cannot read, a bad
// option).
//
// Usage:
//   check-no-migration-edits.ts --base <ref> [--head <ref>] [--repo <dir>]
//     [--match <extended regular expression>] <migrations directory>
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cli, ere } from "../../../../lib/cli.ts";
import { type Finding, reportFindings } from "../../../../lib/findings.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";

const RULE = "applied-migration-edited";
const usage =
  "usage: check-no-migration-edits.ts --base <ref> [--head <ref>] [--repo <dir>] [--match <ERE>] <migrations directory>";

/**
 * An input the gate cannot read or use. The boundary (`lib/cli.ts`) prints
 * its message and exits 2, so a bad input never reads as a pass.
 */
export class InputError extends Error {}

/** One changed path between the merge base and the head. */
export interface Change {
  /** `M` modified, `D` deleted, `R` renamed, `T` type changed. */
  status: "M" | "D" | "R" | "T";
  /** The path at the merge base. */
  path: string;
  /** The path at the head, for a rename. */
  renamedTo?: string;
}

/**
 * The entries of `git diff --name-status -z`: a status token, then the
 * path, or two paths for a rename or copy (`R100`, `C75`). A status this
 * gate did not ask for, or a truncated entry, throws: the output is not
 * what the command was given.
 */
export function parseNameStatus(output: string): Change[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] ?? "";
    const width = status.startsWith("R") || status.startsWith("C") ? 3 : 2;
    const entry = tokens.slice(i, i + width);
    if (entry.length < width)
      throw new InputError(`git diff output ends mid-entry at: ${status}`);
    changes.push(changeOf(status, entry[1] ?? "", entry[2]));
    i += width;
  }
  return changes;
}

/** One entry as a change; a status this gate did not ask for throws. */
function changeOf(
  status: string,
  path: string,
  second: string | undefined,
): Change {
  const letter = status[0];
  if (letter === "M" || letter === "D" || letter === "T")
    return { status: letter, path };
  if (letter === "R" && second !== undefined)
    return { status: "R", path, renamedTo: second };
  throw new InputError(`unexpected status in git diff output: ${status}`);
}

type Env = Record<string, string | undefined>;

/**
 * The environment for git, without the variables that would route it at a
 * repository other than `--repo` (a hook exports them pointing at the
 * repository it runs in). Matched case-insensitively: Windows reads
 * `Git_Dir` as `GIT_DIR`.
 */
export function gitEnv(source: Env = process.env): Env {
  const leaky = new Set<string>(LEAKY_GIT_ENV);
  const env: Env = {};
  for (const [key, value] of Object.entries(source))
    if (!leaky.has(key.toUpperCase())) env[key] = value;
  return env;
}

/** A git repository the gate reads, through one command runner. */
export class Repository {
  readonly root: string;
  private readonly env: Env;

  constructor(root: string, env: Env) {
    this.root = root;
    this.env = env;
  }

  /** The command's standard output; a failed command throws. */
  run(args: string[]): string {
    const result = spawnSync("git", args, {
      cwd: this.root,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error)
      throw new InputError(`git could not run: ${result.error.message}`);
    if (result.status !== 0)
      throw new InputError(
        `git ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`,
      );
    return result.stdout;
  }

  /** The commit a reference names, as a full id; throws when it names none. */
  commit(ref: string, what: string): string {
    const result = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd: this.root, env: this.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error)
      throw new InputError(`git could not run: ${result.error.message}`);
    if (result.status !== 0)
      throw new InputError(`${what} does not name a commit: ${ref}`);
    return result.stdout.trim();
  }

  /** `mode blob-id` of `path` in `ref`'s tree, or undefined when absent. */
  treeEntry(ref: string, path: string): string | undefined {
    const line = this.run(["ls-tree", "-z", ref, "--", path]);
    if (line === "") return undefined;
    const [meta] = line.split("\t");
    const [mode, , oid] = (meta ?? "").split(" ");
    if (mode === undefined || oid === undefined)
      throw new InputError(`git ls-tree printed an unreadable entry: ${line}`);
    return `${mode} ${oid}`;
  }

  /** The paths under `dir` in `ref`'s tree. */
  paths(ref: string, dir: string): string[] {
    return this.run(["ls-tree", "-r", "-z", "--name-only", ref, "--", dir])
      .split("\0")
      .filter((path) => path !== "");
  }

  /** Every state (`mode blob-id`) `path` held in a commit reachable from `ref`. */
  priorStates(ref: string, path: string): Set<string> {
    const states = new Set<string>();
    for (const commit of this.run(["rev-list", ref, "--", path]).split("\n")) {
      if (commit === "") continue;
      const entry = this.treeEntry(commit, path);
      if (entry !== undefined) states.add(entry);
    }
    return states;
  }
}

export interface Options {
  base: string;
  head: string;
  repo: string;
  match: RegExp;
  dir: string;
}

function parseArgs(args: string[]): Options {
  let base: string | undefined;
  let head = "HEAD";
  let repo = process.cwd();
  let match = "\\.sql$";
  let dir: string | undefined;
  const value = (i: number, name: string): string => {
    const v = args[i];
    if (v === undefined || v.startsWith("--"))
      throw new InputError(`${name} needs a value\n${usage}`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--base") base = value(++i, arg);
    else if (arg === "--head") head = value(++i, arg);
    else if (arg === "--repo") repo = value(++i, arg);
    else if (arg === "--match") match = value(++i, arg);
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else if (dir !== undefined)
      throw new InputError(`more than one migrations directory\n${usage}`);
    else dir = arg;
  }
  if (base === undefined) throw new InputError(`--base is required\n${usage}`);
  if (dir === undefined)
    throw new InputError(`the migrations directory is required\n${usage}`);
  let pattern: RegExp;
  try {
    pattern = ere(match);
  } catch (error) {
    throw new InputError(
      `--match is not a regular expression: ${match} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return { base, head, repo, match: pattern, dir };
}

/**
 * `path` as the file system spells it where it exists, else as given: links
 * resolved and, on Windows, 8.3 short names expanded, as git spells its top
 * level.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * `dir` relative to the repository's top level, with forward slashes. Both
 * sides are compared as real paths: git prints the top level with links
 * resolved, and a temporary directory is often reached through one.
 */
function relativeDir(repo: Repository, dir: string): string {
  const top = realPath(repo.run(["rev-parse", "--show-toplevel"]).trim());
  const full = realPath(
    isAbsolute(dir) ? dir : resolve(realPath(repo.root), dir),
  );
  const rel = relative(top, full).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new InputError(
      `the migrations directory is not inside the repository: ${dir}`,
    );
  return rel;
}

function finding(change: Change, base: string): Finding {
  const problem =
    change.status === "D"
      ? "an applied migration was deleted"
      : change.status === "R"
        ? `an applied migration was renamed to ${change.renamedTo}`
        : change.status === "T"
          ? "an applied migration changed type (a file became a link, or the reverse)"
          : `an applied migration was modified to content it never held on ${base}`;
  return {
    rule: RULE,
    file: change.path,
    problem,
    remedy: `fix forward: restore the file as ${base} holds it and put the change in a new migration; an environment that never applied it is reset instead`,
  };
}

export function main(args = process.argv.slice(2)): number {
  const options = parseArgs(args);
  const repo = new Repository(options.repo, gitEnv());
  const base = repo.commit(options.base, "--base");
  const head = repo.commit(options.head, "--head");
  const dir = relativeDir(repo, options.dir);
  const mergeBase = repo.run(["merge-base", options.base, options.head]).trim();
  const isMigration = (path: string) => options.match.test(path);
  const atHead = repo.paths(head, dir).filter(isMigration);
  const atBase = repo.paths(mergeBase, dir).filter(isMigration);
  if (atHead.length === 0 && atBase.length === 0)
    throw new InputError(
      `no migration file matching ${options.match.source} under ${dir} at ${options.base} or ${options.head}: is the directory right?`,
    );
  const changes = parseNameStatus(
    repo.run([
      "diff",
      "--name-status",
      "-z",
      "-M",
      "--diff-filter=MDRT",
      mergeBase,
      head,
      "--",
      dir,
    ]),
  ).filter((change) => isMigration(change.path));
  const findings: Finding[] = [];
  let restored = 0;
  for (const change of changes) {
    if (change.status === "M") {
      const now = repo.treeEntry(head, change.path);
      if (now !== undefined && repo.priorStates(base, change.path).has(now)) {
        restored += 1;
        continue;
      }
    }
    findings.push(finding(change, options.base));
  }
  if (findings.length > 0) {
    reportFindings(findings);
    console.error(
      `${RULE}: ${findings.length} applied migration(s) under ${dir} changed since the merge base with ${options.base}`,
    );
    return 1;
  }
  const applied = new Set(atBase);
  const added = atHead.filter((path) => !applied.has(path)).length;
  console.log(
    `OK — ${atBase.length} applied migration(s) under ${dir} unchanged since the merge base with ${options.base}${restored ? `, ${restored} restored to a prior state` : ""}; ${added} added on ${options.head}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
