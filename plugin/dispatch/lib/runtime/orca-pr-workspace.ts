/**
 * Prove that a workspace a launch did not open is still a checkout of the
 * pull request it runs for: a joined workspace, a recovery's tree, a pending
 * launch's recorded workspace replayed. The open proves its own checkout
 * (`orca-open.ts`); every other way a drive reaches a workspace goes through
 * this proof before anything runs in it.
 *
 * The workspace is proven in three steps, each refusing with its reason:
 *
 * 1. it is a checkout of the repository's own clone (the git common
 *    directories match);
 * 2. its origin is the pull request's head repository and holds the head
 *    commit the forge reports, by `resolvePullRequestHead`, run in the
 *    workspace;
 * 3. its commit is on the head's line of history: the head itself; a
 *    descendant of it, whose commits past the head are local work the drive
 *    inherits and pushes; or an ancestor of it, which the drive's attach
 *    fast-forwards and which holds no work of its own. A commit off that
 *    line (a stale checkout of an earlier branch of the same name, or one
 *    of another history) is refused, since the drive would run the
 *    repository's configuration from content the pull request does not hold.
 *
 * The proof only fetches the head branch into origin's remote-tracking ref when its commit is
 * not yet in the clone, so local commits, edits and branches stay as they
 * were, and a refusal leaves the work where it is for a person.
 */
import { realpathSync } from "node:fs";
import {
  type Context,
  localContext,
  output,
  withLimit,
} from "../../../shared/orca-workspace/runner.ts";
import { failureText } from "../text.ts";
import { type HeadReader, resolvePullRequestHead } from "./orca-pr-head.ts";
import { workspaceHeadReader } from "./orca-workspace-head.ts";

/** The canonical git common directory of the checkout at `path`, or why it does not read. */
function commonDir(
  ctx: Context,
  path: string,
): { dir: string } | { why: string } {
  const read = ctx.run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const dir = read.stdout.trim();
  if (read.status !== 0 || dir === "")
    return {
      why: `cannot read the git common directory of ${path} (exit ${read.status}): ${output(read)}`,
    };
  try {
    return { dir: realpathSync(dir) };
  } catch {
    return { dir };
  }
}

/** Why the workspace is not a checkout of the repository's clone; `null` when it is. */
function otherClone(
  ctx: Context,
  clone: string,
  workspace: string,
): string | null {
  const own = commonDir(ctx, clone);
  if ("why" in own) return own.why;
  const its = commonDir(ctx, workspace);
  if ("why" in its) return its.why;
  return own.dir === its.dir
    ? null
    : `${workspace} belongs to the clone at ${its.dir}, not to ${clone}'s (${own.dir})`;
}

/** Whether `commit` is in the workspace's object store. */
function present(ctx: Context, path: string, commit: string): boolean {
  return (
    ctx.run(["git", "-C", path, "cat-file", "-e", `${commit}^{commit}`])
      .status === 0
  );
}

/** Whether `a` is an ancestor of `b`, or why Git could not establish that relationship. */
function ancestor(
  ctx: Context,
  path: string,
  a: string,
  b: string,
): { yes: boolean } | { why: string } {
  const read = ctx.run([
    "git",
    "-C",
    path,
    "merge-base",
    "--is-ancestor",
    a,
    b,
  ]);
  if (read.status === 0 || read.status === 1) return { yes: read.status === 0 };
  return {
    why: `cannot compare ancestry in ${path} (exit ${read.status}): ${output(read)}`,
  };
}

/** Why the workspace's commit is off the head's line of history; `null` when it is on it. */
function offHistory(
  ctx: Context,
  path: string,
  head: string,
  branch: string,
): string | null {
  const read = ctx.run(["git", "-C", path, "rev-parse", "--verify", "HEAD"]);
  const at = read.stdout.trim();
  if (read.status !== 0 || at === "")
    return `cannot read HEAD in ${path} (exit ${read.status}): ${output(read)}`;
  if (at === head) return null;
  if (!present(ctx, path, head)) {
    const fetched = ctx.run([
      "git",
      "-C",
      path,
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `refs/heads/${branch}`,
    ]);
    if (fetched.status !== 0 || !present(ctx, path, head))
      return `the pull request head ${head} cannot be fetched into ${path} to compare with its commit ${at} (exit ${fetched.status}): ${output(fetched) || "the head commit is absent after the fetch"}`;
  }
  for (const [a, b] of [
    [head, at],
    [at, head],
  ] as const) {
    const read = ancestor(ctx, path, a, b);
    if ("why" in read) return read.why;
    if (read.yes) return null;
  }
  return `${path} is at ${at}, which is neither the pull request head ${head} nor on its history; reconcile the checkout, or remove it, before driving it`;
}

/** The proof, in a context the caller limits; why the workspace is refused, or `null` once proven. */
export async function proveWorkspace(
  ctx: Context,
  clone: string,
  workspace: string,
  pr: number,
  branch: string,
  repository: string,
  readForge?: HeadReader,
): Promise<string | null> {
  const clones = otherClone(ctx, clone, workspace);
  if (clones !== null) return clones;
  const head = await resolvePullRequestHead(
    ctx,
    workspace,
    pr,
    branch,
    repository,
    readForge,
  );
  if (!head.ok) return head.failure.reason;
  return offHistory(ctx, workspace, head.value, branch);
}

/**
 * Prove the workspace at `workspace` for pull request `pr`, whose head
 * branch is `branch`, within `timeoutMs`: why it is refused, or `null` once
 * proven. A proof that cannot finish is a refusal too, naming why.
 */
export async function verifyPullRequestWorkspace(
  clone: string,
  workspace: string,
  pr: number,
  branch: string,
  timeoutMs: number,
  repository: string,
): Promise<string | null> {
  const lines: string[] = [];
  const ctx = withLimit(
    localContext((line) => lines.push(line)),
    timeoutMs,
  );
  try {
    return await proveWorkspace(
      ctx,
      clone,
      workspace,
      pr,
      branch,
      repository,
      workspaceHeadReader(ctx),
    );
  } catch (error) {
    return [failureText(error), ...lines.slice(-3)].join("; ");
  }
}
