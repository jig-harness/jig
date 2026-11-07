/**
 * The change-area resolver: a list of changed files to the areas it touches,
 * and the git layer that finds the changed files for a CI event.
 *
 * Two layers, kept apart so the semantics that matter are tested without
 * running git:
 *
 *   1. The pure resolver: files to seed areas by glob, then the transitive
 *      closure of the one-directional `impliedBy` relation.
 *   2. The git layer (`changedFilesFromGit`): the diff that fits the event,
 *      through an injectable `GitRunner`.
 *
 * The resolver over-triggers on purpose: a shared library listed in every
 * consumer's `impliedBy` fans a change out to all of them. A redundant job
 * is cheap; a skipped one is a missed defect.
 */
import { swallow } from "../../../../shared/errors.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../shared/guarded-git-spawn.ts";
import { matchesGlob } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { Catalog } from "./catalog.ts";

export { matchesGlob };

/**
 * The globs that make an area a seed: its own `paths`, then every
 * `generated[].source`. A generator's source may live in another area; matching
 * `paths` alone would drop the generator's checks for an edit to its source.
 * Every static projection of the catalog derives membership from this, so it
 * agrees with the resolver by construction.
 */
export function seedGlobs(catalog: Catalog, key: string): string[] {
  const area = catalog.areas[key];
  if (!area) return [];
  return [...area.paths, ...(area.generated ?? []).flatMap((g) => g.source)];
}

/**
 * The areas a changed file matches by one of their seed globs. Membership is
 * multi-valued: a file may seed several areas.
 */
export function matchSeedAreas(files: string[], catalog: Catalog): Set<string> {
  const seed = new Set<string>();
  for (const key of Object.keys(catalog.areas)) {
    const globs = seedGlobs(catalog, key);
    if (files.some((f) => globs.some((g) => matchesGlob(f, g)))) seed.add(key);
  }
  return seed;
}

/**
 * The forward closure of `impliedBy`: add every area whose `impliedBy` names
 * an area already included, until the set stops growing. One direction
 * only: two areas that both list a shared library do not reach each other.
 */
export function applyImpliedClosure(
  seed: Iterable<string>,
  catalog: { areas: Readonly<Record<string, { impliedBy: string[] }>> },
): Set<string> {
  const included = new Set(seed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, area] of Object.entries(catalog.areas)) {
      if (!included.has(key) && area.impliedBy.some((r) => included.has(r))) {
        included.add(key);
        grew = true;
      }
    }
  }
  return included;
}

/** Changed files to affected areas: seed match, then the `impliedBy` closure. */
export function resolveAreas(files: string[], catalog: Catalog): Set<string> {
  return applyImpliedClosure(matchSeedAreas(files, catalog), catalog);
}

/**
 * The areas whose change implies `target`, transitively: every B for which
 * resolving B reaches `target`. A path filter built from their globs matches
 * exactly when `target` is affected.
 */
export function transitiveImpliedBy(
  target: string,
  catalog: Catalog,
): Set<string> {
  const out = new Set<string>();
  const stack = [...(catalog.areas[target]?.impliedBy ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    const area = catalog.areas[next];
    if (out.has(next) || !area) continue;
    out.add(next);
    stack.push(...area.impliedBy);
  }
  return out;
}

// ── git layer ──────────────────────────────────────────────────────────────

export type GitEvent = "push" | "pull_request" | "workflow_dispatch";

export interface GitContext {
  /** The CI event; defaults to `push`. */
  eventName?: GitEvent | undefined;
  /** A pull request's base branch, diffed as `origin/<baseRef>...<head>`. */
  baseRef?: string | undefined;
  /** The commit to resolve; defaults to `HEAD`. */
  head?: string | undefined;
  /** The last verified commit a dispatched run covers the gap from. */
  sinceRef?: string | undefined;
  /**
   * The commit a push moved its branch from. With it a push resolves every
   * commit it carried, not only the tip; an all-zero SHA (a push that
   * created the branch) has none and falls back to the tip.
   */
  beforeRef?: string | undefined;
}

/** A context that names no diff to take: the caller's error, not git's. */
export class GitContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitContextError";
  }
}

/** A git command that failed: the resolution cannot be made. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs a git subcommand and returns its stdout; throws when git fails. The
 * file-listing commands are called with `-z`, so their output is
 * NUL-separated paths.
 */
export type GitRunner = (args: string[]) => string;

/**
 * How long one git command may run. The `workflow_dispatch` fetch reaches the
 * network, and a remote or credential helper that never answers would
 * otherwise hold a gate open with nothing to end it.
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * git in the working directory, with the variables that reroute it removed,
 * no terminal prompt, and a deadline: a git command that does not finish in
 * `GIT_TIMEOUT_MS` is killed and fails the resolution.
 */
export const defaultGitRunner: GitRunner = (args) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync("git", args, {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason =
      result.signal !== null
        ? `killed by ${result.signal} (deadline ${GIT_TIMEOUT_MS / 1000}s)`
        : (result.stderr || result.error?.message || "").trim();
    throw new GitError(`git ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
};

const splitLines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

// The file lists are read with `-z`: without it, git quotes a path holding a
// non-ASCII or special character (`"docs/caf\303\251.md"` under the default
// `core.quotePath`), and the quoted form matches no glob, so the file would
// seed nothing.
const splitPaths = (out: string): string[] =>
  out.split("\0").filter((p) => p.length > 0);

/**
 * Each ref the context supplies must be a revision git reads as one: an
 * empty value, or one shaped like an option (`--cached`), would be taken
 * for something else and diff a range the event never named, resolving a
 * code change to no areas.
 */
function assertRevisions(ctx: GitContext): void {
  const refs: Array<[string, string | undefined]> = [
    ["head", ctx.head],
    ["base ref", ctx.baseRef],
    ["since ref", ctx.sinceRef],
    ["before ref", ctx.beforeRef],
  ];
  for (const [name, ref] of refs)
    if (ref !== undefined && !/^[^-\s\0][^\s\0]*$/.test(ref))
      throw new GitContextError(
        `the ${name} ${JSON.stringify(ref)} is not a revision: it is empty, starts with \`-\` or holds whitespace`,
      );
}

/** The diff range for the event, before any merge-parent files. */
function eventRange(ctx: GitContext, head: string, git: GitRunner): string[] {
  const event = ctx.eventName ?? "push";
  if (event === "pull_request") {
    if (!ctx.baseRef)
      throw new GitContextError(
        "pull_request event requires a baseRef (--base <ref>)",
      );
    return [`origin/${ctx.baseRef}...${head}`];
  }
  if (event === "push") return pushRange(ctx.beforeRef, head);
  return dispatchRange(ctx.sinceRef, head, git);
}

/** A push's range: from its before SHA, else (none, or all zeros) the tip. */
function pushRange(before: string | undefined, head: string): string[] {
  return before !== undefined && !/^0+$/.test(before)
    ? [before, head]
    : [`${head}~1`, head];
}

/** A dispatched run's range: the whole gap since the last verified commit. */
function dispatchRange(
  since: string | undefined,
  head: string,
  git: GitRunner,
): string[] {
  if (!since)
    throw new GitContextError(
      "workflow_dispatch event requires a since ref (--since <ref>): the last verified commit the run covers the gap from",
    );
  // A fresh clone may not hold the remote ref yet. The refspec names the
  // remote-tracking ref to write: a bare branch name would land only in
  // FETCH_HEAD in a single-branch clone, leaving `origin/<branch>` missing.
  // Fetching is best effort: without the network the diff still runs, and
  // fails loudly if the ref is missing.
  if (since.startsWith("origin/")) {
    const branch = since.slice("origin/".length);
    try {
      git([
        "fetch",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        "--quiet",
      ]);
    } catch (err) {
      swallow(
        err,
        "fetching the since ref failed; diffing with what the clone has",
      );
    }
  }
  return [`${since}...${head}`];
}

/** Each parent's own files when `head` is a merge commit, else none. */
function mergeParentFiles(head: string, git: GitRunner): string[] {
  // `rev-list --parents -n 1` prints "<sha> <parent1> <parent2> …": more than
  // one parent is a merge commit.
  const revList = splitLines(git(["rev-list", "--parents", "-n", "1", head]));
  const parents = (revList[0]?.split(/\s+/).slice(1) ?? []).filter(Boolean);
  if (parents.length <= 1) return [];
  // `-m --first-parent` lists a parent's own files whether or not that
  // parent is itself a merge.
  return parents.flatMap((parent) =>
    splitPaths(
      git([
        "diff-tree",
        "--no-renames",
        "--no-commit-id",
        "--name-only",
        "-z",
        "-r",
        "-m",
        "--first-parent",
        parent,
      ]),
    ),
  );
}

/**
 * The changed files for a CI event:
 *
 *   - pull_request: `origin/<baseRef>...<head>`;
 *   - workflow_dispatch: `<sinceRef>...<head>`, the whole gap since the last
 *     verified commit, so a run that recovers from a dropped push event
 *     covers every commit since, not only the tip;
 *   - push: `<beforeRef> <head>`, every commit the push carried; without a
 *     before SHA (none given, or a push that created the branch)
 *     `<head>~1 <head>`, the tip alone;
 *
 * then, for any event, when `head` is a merge commit, the union of each
 * parent's own files: a first-parent diff of a merge can show only non-code
 * paths and hide code that arrived through the other parent.
 */
export function changedFilesFromGit(
  ctx: GitContext = {},
  git: GitRunner = defaultGitRunner,
): string[] {
  assertRevisions(ctx);
  const head = ctx.head ?? "HEAD";
  const range = eventRange(ctx, head, git);
  const base = splitPaths(
    git(["diff", "--no-renames", "--name-only", "-z", ...range]),
  );
  const parents = mergeParentFiles(head, git);
  return parents.length ? [...new Set([...base, ...parents])] : base;
}

/** Resolve the complete workspace change, including new files, without shell pipelines. */
export function changedFilesFromWorktree(
  base: string,
  git: GitRunner = defaultGitRunner,
): string[] {
  if (!base.trim() || base.startsWith("-") || /[\r\n\0]/.test(base))
    throw new GitContextError(
      "--worktree needs a base revision, not an option",
    );
  const ancestor = git(["merge-base", base, "HEAD"]).trim();
  if (!ancestor || ancestor.startsWith("-") || /\s/.test(ancestor))
    throw new GitError("git merge-base returned no usable revision");
  const tracked = git([
    "diff",
    "-z",
    "--no-renames",
    "--name-only",
    ancestor,
    "--",
  ]);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...new Set([...splitPaths(tracked), ...splitPaths(untracked)])];
}
