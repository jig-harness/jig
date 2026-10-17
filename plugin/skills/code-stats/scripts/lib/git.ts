/**
 * What the skill asks git: the tracked files, their attributes, and the
 * commit a report describes. A git call that fails is an error, never an
 * empty answer: an empty report would read as an empty repository.
 */
import { basename } from "node:path";
import { LEAKY_GIT_ENV } from "../../../../shared/guarded-git-spawn.ts";
import {
  MAX_BUFFER_BYTES,
  type RunOptions,
  type RunResult,
  git as runGit,
} from "../../../../shared/proc.ts";
import { CodeStatsError } from "./errors.ts";

/**
 * git in the repository `-C` names: the variables a hook exports to point git
 * at another repository are left out, so they cannot redirect the count.
 */
function git(args: string[], opts: RunOptions = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
    ),
  );
  return runGit(args, { ...opts, env });
}

/** The error for a git call that failed, saying plainly when its output overflowed. */
export function gitFailure(args: string[], result: RunResult): CodeStatsError {
  if (result.bufferExceeded)
    return new CodeStatsError(
      `git ${args[0]} printed more than the ${MAX_BUFFER_BYTES / 1024 / 1024} MiB of output the skill reads, and was stopped`,
    );
  return new CodeStatsError(
    `git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || "no error output"}`,
  );
}

async function gitOut(root: string, args: string[], stdin?: string) {
  const result = await git(
    ["-C", root, ...args],
    stdin === undefined ? {} : { stdin },
  );
  if (result.code !== 0) throw gitFailure(args, result);
  return result.stdout;
}

/** The tracked paths, and those of them that are submodules (gitlinks). */
export interface Listing {
  paths: string[];
  submodules: Set<string>;
}

/** Parse `git ls-files -s -z`: `<mode> <object> <stage>\t<path>` entries. */
export function parseLsFiles(out: string): Listing {
  const listing: Listing = { paths: [], submodules: new Set() };
  const seen = new Set<string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    // A file in a merge conflict is listed once per stage; count it once
    if (seen.has(path)) continue;
    seen.add(path);
    listing.paths.push(path);
    if (entry.startsWith("160000 ")) listing.submodules.add(path);
  }
  return listing;
}

/** Every tracked path, verbatim (`-z`: no quoting of unusual names), from one call. */
export async function listTracked(root: string): Promise<Listing> {
  const listing = parseLsFiles(await gitOut(root, ["ls-files", "-s", "-z"]));
  if (listing.paths.length === 0)
    throw new CodeStatsError(
      "git ls-files listed no tracked files: there is nothing to count",
    );
  return listing;
}

/** The `linguist-*` attributes set on each path, by attribute name. */
export type Attributes = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Parse `git check-attr -z -a` output: NUL-separated triples of path,
 * attribute and value (`set`, `unset` or the value). Only the `linguist-*`
 * attributes are kept.
 */
export function parseCheckAttr(out: string): Map<string, Map<string, string>> {
  const attributes = new Map<string, Map<string, string>>();
  if (out === "") return attributes;
  const fields = out.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0)
    throw new CodeStatsError(
      "git check-attr printed output that is not NUL-separated path, attribute and value triples",
    );
  for (let i = 0; i < fields.length; i += 3) {
    const [path, name, value] = fields.slice(i, i + 3) as [
      string,
      string,
      string,
    ];
    if (!name.startsWith("linguist-")) continue;
    let forPath = attributes.get(path);
    if (!forPath) {
      forPath = new Map();
      attributes.set(path, forPath);
    }
    forPath.set(name, value);
  }
  return attributes;
}

/** The attributes of every path in `paths`, from one `git check-attr` call. */
export async function readAttributes(
  root: string,
  paths: readonly string[],
): Promise<Attributes> {
  if (paths.length === 0) return new Map();
  const out = await gitOut(
    root,
    ["check-attr", "--stdin", "-z", "-a"],
    `${paths.join("\0")}\0`,
  );
  return parseCheckAttr(out);
}

/** What a report says about the commit it counted. */
export interface RepositoryInfo {
  name: string;
  commit: string;
  branch: string;
}

/**
 * The repository's name (from the `origin` remote, else its folder), its
 * commit with `-dirty` when tracked files differ from it (the counts are the
 * working tree's), and its branch. A repository without a commit says so.
 */
export async function repositoryInfo(root: string): Promise<RepositoryInfo> {
  const remote = await git([
    "-C",
    root,
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const fromRemote =
    remote.code === 0
      ? remote.stdout
          .trim()
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .pop()
      : undefined;
  const head = await git(["-C", root, "rev-parse", "--short", "HEAD"]);
  if (head.code !== 0)
    return {
      name: fromRemote || basename(root),
      commit: "no commit yet",
      branch: "",
    };
  const [branch, dirty] = await Promise.all([
    gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitOut(root, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  return {
    name: fromRemote || basename(root),
    commit: `${head.stdout.trim()}${dirty.trim() ? "-dirty" : ""}`,
    branch: branch.trim(),
  };
}
