/** Re-read local identity; preserve unknown evidence and the session-lock veto. */
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { layeredConfig, remoteName } from "../../shared/consumer.ts";
import { readDrivenTree, type DrivenTree } from "../../shared/driven-tree.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
import { gcGit as git } from "../git.ts";
import type { Proof } from "../types.ts";
import {
  classifyWorktree,
  localWorktreeVeto,
  type WorktreeEvidence,
  type WorktreeRequest,
} from "./worktree-evidence.ts";
import {
  aheadOfBase,
  ancestry,
  localOnlyCommits,
  processHolder,
  requestByNumber,
  requests,
  worktreeActivity,
} from "./worktree-git.ts";

export interface WorktreePolicy {
  remote: string;
  base: string;
}
/**
 * The remote and integration branch a branched worktree's evidence is read
 * against: `repository.remote` (`remoteName`, else `origin`) and
 * `repository.base_branch`, else that remote's `HEAD`.
 */
export async function worktreePolicy(root: string): Promise<WorktreePolicy> {
  const remote = worktreeRemote(root);
  const config = layeredConfig(root).values;
  const repository = isMapping(config.repository) ? config.repository : {};
  const base =
    typeof repository.base_branch === "string"
      ? repository.base_branch
      : await remoteHeadBranch(root, remote);
  return { remote, base };
}
/** `repository.remote` (`remoteName`, else `origin`), as a collection error. */
export function worktreeRemote(root: string): string {
  try {
    return remoteName(root);
  } catch (error) {
    throw new GcError(error instanceof Error ? error.message : String(error));
  }
}
/** The branch `remote`'s `HEAD` points at. */
export async function remoteHeadBranch(
  root: string,
  remote: string,
): Promise<string> {
  const prefix = `refs/remotes/${remote}/`;
  return (await git(root, ["symbolic-ref", `${prefix}HEAD`])).replace(
    prefix,
    "",
  );
}
async function operation(admin: string): Promise<string | null> {
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    try {
      lstatSync(resolve(admin, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}
async function mergedHeadCoverage(
  root: string,
  head: string,
  prs: WorktreeRequest[],
): Promise<boolean | null> {
  let unknown = false;
  for (const pr of prs.filter((entry) => entry.state === "MERGED")) {
    const covered = await ancestry(root, head, pr.head);
    if (covered === true) return true;
    if (covered === null) unknown = true;
  }
  return unknown ? null : false;
}
/**
 * Whether a detached tree's record still names the work its head holds.
 * Descent from the attached commit does not tell the pull request's commits
 * from a stacked pull request's, whose head descends from it too: a head some
 * remote-tracking branch holds is that branch's work unless the record's own
 * branch is among them, or the pull request's head contains it. The own
 * branch is not required, since a merged pull request's is often deleted.
 */
async function describesHead(
  path: string,
  record: DrivenTree,
  prs: WorktreeRequest[],
): Promise<boolean> {
  const holders = (
    await git(path, [
      "for-each-ref",
      "--contains",
      "HEAD",
      "--format=%(refname)",
      "refs/remotes",
    ])
  )
    .split("\n")
    .filter((ref) => ref !== "");
  if (
    holders.length === 0 ||
    holders.includes(`refs/remotes/${record.remote}/${record.branch}`)
  )
    return true;
  for (const pr of prs)
    if ((await ancestry(path, "HEAD", pr.head)) === true) return true;
  return false;
}
/** The recorded pull request of a detached tree whose head is still its work. */
async function drivenRequests(
  path: string,
  record: DrivenTree,
): Promise<WorktreeRequest[]> {
  const prs = await requestByNumber(path, record.remote, record.pr);
  if (!(await describesHead(path, record, prs)))
    throw new GcError(
      "HEAD is detached on another branch's work since a drive attached the worktree",
    );
  return prs;
}
export async function worktreeProof(
  path: string,
  policy: WorktreePolicy,
  idleDays: number,
): Promise<Proof> {
  if (!lstatSync(path).isDirectory())
    return { state: "finding", reason: "worktree root is not a directory" };
  const name = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await git(path, ["rev-parse", "HEAD"]);
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  const admin = isAbsolute(dir) ? dir : resolve(path, dir);
  // A detached tree a drive attached names its pull request, and the remote
  // that pull request was fetched through, in its record, for as long as its
  // head still descends from the commit attached and holds no other branch's
  // work (`describesHead`). Unlike
  // the drive's readers, no remote branch is required: a merged pull
  // request's branch is often deleted, and that is when the tree is reported.
  const record = name === "HEAD" ? readDrivenTree(admin) : null;
  const driven =
    record !== null && (await ancestry(path, record.head, head)) === true
      ? record
      : null;
  if (name === "HEAD" && driven === null)
    throw new GcError("HEAD is detached and no drive attached the worktree");
  const flags = await git(path, ["ls-files", "-v", "-z"]);
  const facts: WorktreeEvidence = {
    dirty: !!(await git(path, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "-z",
    ])),
    hiddenIndexChanges: flags
      .split("\0")
      .some((entry) => /^[a-zS] /.test(entry)),
    operation: await operation(admin),
    ignoredContent: !!(await git(path, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ])),
    requests: null,
    localOnlyCommits: null,
    mergedHeadCovers: null,
    aheadOfBase: null,
    held: null,
    idleMs: null,
  };
  const local = localWorktreeVeto(facts);
  if (local) return local;
  facts.requests =
    driven === null
      ? await requests(path, policy.remote, name)
      : await drivenRequests(path, driven);
  if (facts.requests.some((pr) => pr.state === "OPEN"))
    return classifyWorktree(facts, idleDays * 86_400_000);
  facts.localOnlyCommits = await localOnlyCommits(path, head);
  if (facts.localOnlyCommits)
    facts.mergedHeadCovers = await mergedHeadCoverage(
      path,
      head,
      facts.requests,
    );
  if (facts.requests.length === 0)
    facts.aheadOfBase = await aheadOfBase(path, policy.remote, policy.base);
  facts.held = await processHolder(path);
  facts.idleMs = worktreeActivity(path, admin);
  if (
    (await git(path, ["rev-parse", "HEAD"])) !== head ||
    (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])) !== name
  )
    throw new GcError("Worktree identity changed during the proof");
  return classifyWorktree(facts, idleDays * 86_400_000);
}
