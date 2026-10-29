/**
 * Detect the git operation that stopped on conflicts and name its two sides
 * by role.
 *
 * git calls the two sides of every conflict "ours" and "theirs", but what
 * they mean depends on the operation. In a merge, "ours" is the checked-out
 * branch. In a rebase it is the other way round: "ours" is the upstream the
 * branch is being replayed onto, and "theirs" is the branch's own commit
 * being replayed. This module states the role of each side explicitly so a
 * resolver never has to remember which way round it is.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumerRoot, readRemoteName } from "../../../../shared/consumer.ts";
import {
  readDrivenTree,
  recordChecks,
} from "../../../../shared/driven-tree.ts";
import { git, gitPath, gitRaw, resolveCommit, subject } from "./git.ts";

export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert";
export type SideName = "ours" | "theirs";

export interface Side {
  /**
   * The commit that holds this side's version of every file; the empty tree
   * for the state before a reverted root commit.
   */
  commit: string;
  /** A branch or tag name for the side, when one is known. */
  ref: string | null;
  subject: string;
  role: string;
}

export interface Operation {
  kind: OperationKind;
  /** HEAD when the operation stopped. */
  head: string;
  /** The commit being merged, replayed, picked or reverted. */
  incoming: string;
  /**
   * The commit both sides are compared against (the merge base of a merge;
   * the parent of a replayed or picked commit; the reverted commit itself in
   * a revert). Null when there is none (unrelated histories, a root commit).
   */
  base: string | null;
  ours: Side;
  theirs: Side;
  /** The side carrying the base branch or upstream: derived files start from it. */
  integration: SideName;
  integrationWhy: string;
  /** A warning to print before anything else, or null. */
  warning: string | null;
}

/** Thrown when no operation stopped on conflicts is in progress. */
export class NoOperation extends Error {}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function currentBranch(root: string): string | null {
  const r = gitRaw(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code === 0) return r.stdout.trim();
  // A detached tree a drive attached is on the branch its record names.
  const dir = gitRaw(root, ["rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return null;
  const record = readDrivenTree(dir.stdout.trim());
  if (record === null) return null;
  return recordChecks(record).every((check) => gitRaw(root, check).code === 0)
    ? record.branch
    : null;
}

function parentOf(root: string, commit: string): string | null {
  return resolveCommit(root, `${commit}^`);
}

/** A single replay does not reliably retain the selected mainline parent. */
function requireSingleParent(root: string, commit: string, kind: string): void {
  if (resolveCommit(root, `${commit}^2`) !== null)
    throw new NoOperation(
      `unsupported: ${kind} of a merge commit does not reliably preserve its selected mainline parent. Resolve and validate this operation manually; this skill cannot certify its automatic result.`,
    );
}

/** The recreated merge's parents, or the inputs of an ordinary replay. */
function replayInputs(
  root: string,
  head: string,
  incoming: string,
): { theirs: string; base: string | null } {
  const mergeHead = resolveCommit(root, "MERGE_HEAD");
  if (mergeHead === null)
    return { theirs: incoming, base: parentOf(root, incoming) };
  const result = gitRaw(root, ["merge-base", head, mergeHead]);
  return {
    theirs: mergeHead,
    base: result.code === 0 ? result.stdout.trim() : null,
  };
}

/** The id of the empty tree in this repository's hash format. */
function emptyTree(root: string): string {
  return git(root, ["hash-object", "-t", "tree", "--stdin"], "").trim();
}

/** A ref name pointing exactly at `commit`, preferring remote-tracking branches. */
function refAt(root: string, commit: string): string | null {
  const r = gitRaw(root, [
    "for-each-ref",
    "--points-at",
    commit,
    "--format=%(refname)",
    "refs/remotes",
    "refs/heads",
    "refs/tags",
  ]);
  if (r.code !== 0) return null;
  const refs = r.stdout
    .split("\n")
    .filter((ref) => ref !== "" && !ref.endsWith("/HEAD"));
  const first = refs[0];
  if (first === undefined) return null;
  return git(root, ["rev-parse", "--abbrev-ref", first]).trim() || first;
}

/** The branch name `git merge` wrote into the prepared merge message. */
function mergedRef(root: string): string | null {
  const message = read(gitPath(root, "MERGE_MSG"));
  const match = message?.match(
    /^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/,
  );
  return match?.[1] ?? null;
}

/**
 * The repository's default branch name ("main"), when its remote
 * (`repository.remote`, else `origin`) declares it. A configuration that
 * cannot be read (it may be one of the conflicted files) leaves the guess to
 * the usual names.
 */
function defaultBranch(root: string): string[] {
  const read = readRemoteName(consumerRoot(root));
  if ("error" in read) return ["main", "master"];
  // A remote name may hold a `/`, so the whole `<remote>/` prefix is removed,
  // never just the first component.
  const prefix = `${read.remote}/`;
  const r = gitRaw(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${read.remote}/HEAD`,
  ]);
  const head = r.code === 0 ? r.stdout.trim() : "";
  if (head.startsWith(prefix) && head.length > prefix.length)
    return [head.slice(prefix.length)];
  return ["main", "master"];
}

function shortName(ref: string): string {
  return ref.replace(/^(refs\/)?(remotes\/|heads\/)?/, "");
}

function isDefault(ref: string | null, defaults: string[]): boolean {
  if (ref === null) return false;
  const name = shortName(ref);
  return defaults.some(
    (branch) => name === branch || name.endsWith(`/${branch}`),
  );
}

function side(
  root: string,
  commit: string,
  ref: string | null,
  role: string,
): Side {
  return { commit, ref, subject: subject(root, commit), role };
}

/**
 * The operation stopped on conflicts. `integrationOverride` replaces the
 * merge heuristic for which side is the integration side.
 */
export function detectOperation(
  root: string,
  integrationOverride?: SideName,
): Operation {
  const has = (name: string) => existsSync(gitPath(root, name));
  const head = resolveCommit(root, "HEAD");
  if (head === null) throw new NoOperation("HEAD does not name a commit.");
  const short = (commit: string) => commit.slice(0, 12);

  const rebaseDir = has("rebase-merge")
    ? "rebase-merge"
    : has("rebase-apply")
      ? "rebase-apply"
      : null;
  const rebaseHead = has("REBASE_HEAD")
    ? resolveCommit(root, "REBASE_HEAD")
    : null;

  if (rebaseDir !== null && has(join(rebaseDir, "applying")))
    throw new NoOperation(
      "a 'git am' session is in progress; this skill maps merges, rebases, cherry-picks and reverts.",
    );

  if (rebaseDir !== null && rebaseHead !== null) {
    const replay = replayInputs(root, head, rebaseHead);
    const dir = gitPath(root, rebaseDir);
    const headName = read(join(dir, "head-name"));
    const branch =
      headName === null || headName === "detached HEAD"
        ? null
        : shortName(headName);
    const onto = read(join(dir, "onto"));
    const ontoRef = onto === null ? null : refAt(root, onto);
    const upstream = ontoRef ?? (onto === null ? "the upstream" : short(onto));
    return {
      kind: "rebase",
      head,
      incoming: replay.theirs,
      base: replay.base,
      ours: side(
        root,
        head,
        ontoRef,
        `the upstream being rebased onto (${upstream}) plus this branch's commits already replayed`,
      ),
      theirs: side(
        root,
        replay.theirs,
        branch,
        `the commit being replayed from ${branch ?? "the branch being rebased"}`,
      ),
      integration: integrationOverride ?? "ours",
      integrationWhy:
        integrationOverride !== undefined
          ? "set with --integration"
          : "in a rebase the upstream is 'ours'",
      warning: `Rebase: 'ours' is the upstream (${upstream}) and 'theirs' is ${branch ?? "the branch"}'s own commit being replayed, the reverse of a merge.`,
    };
  }

  if (has("MERGE_HEAD")) {
    const incoming = resolveCommit(root, "MERGE_HEAD");
    if (incoming === null)
      throw new NoOperation("MERGE_HEAD does not name a commit.");
    const branch = currentBranch(root);
    const theirsRef = mergedRef(root) ?? refAt(root, incoming);
    const mergeBase = gitRaw(root, ["merge-base", head, incoming]);
    let integration: SideName = "theirs";
    let why =
      "assumed: merging another branch into the checked-out branch brings in its base; pass --integration ours to override";
    const defaults = defaultBranch(root);
    if (integrationOverride !== undefined) {
      integration = integrationOverride;
      why = "set with --integration";
    } else if (isDefault(theirsRef, defaults)) {
      why = `${shortName(theirsRef as string)} is the default branch`;
    } else if (isDefault(branch, defaults)) {
      integration = "ours";
      why = `the checked-out branch, ${branch}, is the default branch`;
    }
    return {
      kind: "merge",
      head,
      incoming,
      base: mergeBase.code === 0 ? mergeBase.stdout.trim() : null,
      ours: side(
        root,
        head,
        branch,
        `the checked-out branch${branch === null ? "" : ` (${branch})`}`,
      ),
      theirs: side(
        root,
        incoming,
        theirsRef,
        `the branch being merged in (${theirsRef ?? short(incoming)})`,
      ),
      integration,
      integrationWhy: why,
      warning: null,
    };
  }

  const branch = currentBranch(root);
  const checkedOut = `the checked-out branch${branch === null ? "" : ` (${branch})`}`;
  const integrationWhy =
    integrationOverride !== undefined
      ? "set with --integration"
      : "the branch receiving the change";

  if (has("CHERRY_PICK_HEAD")) {
    const incoming = resolveCommit(root, "CHERRY_PICK_HEAD");
    if (incoming === null)
      throw new NoOperation("CHERRY_PICK_HEAD does not name a commit.");
    requireSingleParent(root, incoming, "cherry-pick");
    return {
      kind: "cherry-pick",
      head,
      incoming,
      base: parentOf(root, incoming),
      ours: side(root, head, branch, checkedOut),
      theirs: side(
        root,
        incoming,
        null,
        `the commit being cherry-picked (${short(incoming)})`,
      ),
      integration: integrationOverride ?? "ours",
      integrationWhy,
      warning: null,
    };
  }

  if (has("REVERT_HEAD")) {
    const incoming = resolveCommit(root, "REVERT_HEAD");
    if (incoming === null)
      throw new NoOperation("REVERT_HEAD does not name a commit.");
    requireSingleParent(root, incoming, "revert");
    // Reverting a root commit goes back to the state before any file
    // existed: the empty tree.
    const parent = parentOf(root, incoming) ?? emptyTree(root);
    return {
      kind: "revert",
      head,
      incoming,
      base: incoming,
      ours: side(root, head, branch, checkedOut),
      theirs: {
        commit: parent,
        ref: null,
        subject: subject(root, incoming),
        role: `the state before ${short(incoming)}, which is being reverted`,
      },
      integration: integrationOverride ?? "ours",
      integrationWhy,
      warning: null,
    };
  }

  if (rebaseDir !== null)
    throw new NoOperation(
      "a rebase is in progress but is not stopped on a commit it is replaying.",
    );
  throw new NoOperation(
    "no merge, rebase, cherry-pick or revert is in progress.",
  );
}
