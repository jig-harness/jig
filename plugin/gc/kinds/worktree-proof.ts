/** Re-read local identity; preserve unknown evidence and the session-lock veto. */
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { layeredConfig } from "../../shared/consumer.ts";
import { readDrivenTree } from "../../shared/driven-tree.ts";
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
export async function worktreePolicy(root: string): Promise<WorktreePolicy> {
  const config = layeredConfig(root).values;
  const repository = isMapping(config.repository) ? config.repository : {};
  const base =
    typeof repository.base_branch === "string"
      ? repository.base_branch
      : (await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"])).replace(
          /^refs\/remotes\/origin\//,
          "",
        );
  return { remote: "origin", base };
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
  // A detached tree a drive attached names its pull request in its record,
  // for as long as its head still descends from the commit attached. Unlike
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
      : await requestByNumber(path, policy.remote, driven.pr);
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
