/** Re-read local identity; preserve unknown evidence and the session-lock veto. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { layeredConfig, remoteName } from "../../shared/consumer.ts";
import { readDrivenTree, type DrivenTree } from "../../shared/driven-tree.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { detectPackageManager } from "../../shared/detect/package-manager.ts";
import { orcaFailure, orcaResult, runOrca } from "../../shared/orca.ts";
import { gcGit as git, type GitOutcome } from "../git.ts";
import type { Proof } from "../types.ts";
import { guardLabel } from "./worktree-guard.ts";
import {
  classifyWorktree,
  localWorktreeVeto,
  type IgnoredContent,
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
export async function worktreePolicy(
  root: string,
): Promise<Outcome<WorktreePolicy>> {
  const remote = worktreeRemote(root);
  if (!remote.ok) return remote;
  let config: Record<string, unknown>;
  try {
    config = layeredConfig(root).values;
  } catch (error) {
    return failed("unreadable", message(error), error);
  }
  const repository = isMapping(config.repository) ? config.repository : {};
  if (typeof repository.base_branch === "string")
    return ok({ remote: remote.value, base: repository.base_branch });
  const base = await remoteHeadBranch(root, remote.value);
  return base.ok ? ok({ remote: remote.value, base: base.value }) : base;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** `repository.remote` (`remoteName`, else `origin`), or why it cannot be read. */
export function worktreeRemote(root: string): Outcome<string, "unreadable"> {
  try {
    return ok(remoteName(root));
  } catch (error) {
    return failed("unreadable", message(error), error);
  }
}
/** The branch `remote`'s `HEAD` points at. */
export async function remoteHeadBranch(
  root: string,
  remote: string,
): Promise<GitOutcome<string>> {
  const prefix = `refs/remotes/${remote}/`;
  const head = await git(root, ["symbolic-ref", `${prefix}HEAD`]);
  return head.ok ? ok(head.value.replace(prefix, "")) : head;
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
/** The ignored-content scan's failure once its deadline has passed. */
type Late = { ok: false; failure: { code: "timed-out"; reason: string } };
function late(deadline: number): Late | null {
  return Date.now() > deadline
    ? failed("timed-out", "Ignored-content scan exceeded its deadline")
    : null;
}
/**
 * Whether `directory` (a path under `root`) holds nothing but dependency
 * directories: the shape of a wholly ignored workspace folder that git
 * reports as one collapsed entry, hiding the `node_modules` inside it. A
 * symbolic link or any other file is local state and fails it. The walk
 * is bounded by `deadline` (checked on entering a directory and per entry,
 * like `worktreeActivity`) and fails `timed-out` when it passes, so a huge
 * ignored cache cannot hold the collector.
 */
function onlyDependencyDirectories(
  directory: string,
  deadline: number,
): Outcome<boolean, "timed-out"> {
  const entering = late(deadline);
  if (entering) return entering;
  const children = readdirSync(directory);
  if (children.length === 0) return ok(false);
  for (const child of children) {
    const passed = late(deadline);
    if (passed) return passed;
    const path = join(directory, child);
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return ok(false);
    if (child === "node_modules") continue;
    const nested = onlyDependencyDirectories(path, deadline);
    if (!nested.ok || !nested.value) return nested;
  }
  return ok(true);
}
/** Whether the root holds a manifest and a recognised lockfile to rebuild from. */
function rebuildInputs(root: string): boolean {
  if (detectPackageManager(root).found === null) return false;
  try {
    return lstatSync(join(root, "package.json")).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/**
 * Ignored directories that a package manager's dependency directory accounts
 * for, wherever they sit (a monorepo's nested `node_modules` counts too):
 * rebuildable from the root's `package.json` and the lockfile
 * `detectPackageManager` found, never meaningful local state. Only a real
 * directory counts (git marks one with a trailing slash), so an ignored file
 * or link named `node_modules` stays local state, as does a collapsed
 * directory that holds anything beside dependency directories. No field
 * declares an override, since every ecosystem that module recognises needs
 * none; a lockfile-less ecosystem's own rebuildable directory would be
 * grounds to add one.
 */
export function classifyIgnored(
  root: string,
  paths: string[],
  deadline = Date.now() + 30_000,
): Outcome<IgnoredContent, "timed-out"> {
  const inputs = rebuildInputs(root);
  const rebuildable: string[] = [];
  const other: string[] = [];
  for (const path of paths) {
    const passed = late(deadline);
    if (passed) return passed;
    const dependency = inputs
      ? dependencyEntry(root, path, deadline)
      : ok(false);
    if (!dependency.ok) return dependency;
    (dependency.value ? rebuildable : other).push(path);
  }
  return ok({ rebuildable, other });
}
/**
 * Whether one ignored entry is a dependency directory: a directory named
 * `node_modules`, or a collapsed one holding nothing but dependency
 * directories.
 */
function dependencyEntry(
  root: string,
  path: string,
  deadline: number,
): Outcome<boolean, "timed-out"> {
  if (!path.endsWith("/")) return ok(false);
  const directory = path.slice(0, -1);
  if (directory.split("/").pop() === "node_modules") return ok(true);
  return onlyDependencyDirectories(join(root, directory), deadline);
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
): Promise<GitOutcome<boolean>> {
  const listed = await git(path, [
    "for-each-ref",
    "--contains",
    "HEAD",
    "--format=%(refname)",
    "refs/remotes",
  ]);
  if (!listed.ok) return listed;
  const holders = listed.value.split("\n").filter((ref) => ref !== "");
  if (
    holders.length === 0 ||
    holders.includes(`refs/remotes/${record.remote}/${record.branch}`)
  )
    return ok(true);
  for (const pr of prs)
    if ((await ancestry(path, "HEAD", pr.head)) === true) return ok(true);
  return ok(false);
}
/** The recorded pull request of a detached tree whose head is still its work. */
async function drivenRequests(
  path: string,
  record: DrivenTree,
): Promise<Outcome<WorktreeRequest[]>> {
  const prs = await requestByNumber(path, record.remote, record.pr);
  if (!prs.ok) return prs;
  const describes = await describesHead(path, record, prs.value);
  if (!describes.ok) return describes;
  if (!describes.value)
    return failed(
      "other-work",
      "HEAD is detached on another branch's work since a drive attached the worktree",
    );
  return prs;
}
/** A path as git spells a worktree: links resolved, where the path exists. */
export function canonicalWorktree(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return normalize(path);
    throw error;
  }
}
/**
 * Orca's own liveness evidence for a worktree it manages, from its registry
 * (`orca worktree ps --json`): an agent Orca reports in any state but done
 * (working, or waiting on a person) keeps the worktree, whatever git says.
 * A registry that cannot be read, is cut short, or does not list the worktree
 * proves nothing, so collection is refused. Null when Orca reports no agent
 * still at work in it.
 */
export async function orcaLiveness(
  command: string,
  path: string,
): Promise<Proof | null> {
  const unread = (why: string): Proof => ({
    state: "unverified",
    reason: `Orca's registry (orca worktree ps) ${why}`,
  });
  const done = await runOrca(command, ["worktree", "ps", "--json"]);
  const result = orcaResult(done);
  if (result === null) return unread(`could not be read ${orcaFailure(done)}`);
  if (result.truncated !== false || !Array.isArray(result.worktrees))
    return unread("answered an incomplete list");
  const own = canonicalWorktree(path);
  // Every row for the path counts: a second row must not hide an agent the first omits.
  const rows = result.worktrees.filter(
    (entry: unknown) =>
      isMapping(entry) &&
      typeof entry.path === "string" &&
      canonicalWorktree(entry.path) === own,
  );
  if (rows.length > 1) return unread("lists the worktree more than once");
  const row = rows[0];
  if (!isMapping(row)) return unread("does not list the worktree");
  if (!Array.isArray(row.agents)) return unread("lists no agents for it");
  for (const agent of row.agents) {
    if (!isMapping(agent) || typeof agent.state !== "string")
      return unread("lists an agent without a state");
    if (agent.state !== "done")
      return {
        state: "live",
        reason: `Orca's registry reports an agent ${agent.state} in the worktree`,
      };
  }
  return null;
}
/** The runtime that manages a worktree, when one does: Orca, by its command. */
export interface WorktreeRuntime {
  orca: string;
}
/**
 * The proof of a worktree a runtime manages. The runtime's registry is read
 * first: an agent at work there is the most direct evidence the worktree is
 * in use, and it is read again on every proof, the final one before removal
 * included. Its showing no agent stands in for session admission. The proof
 * says whether Jig's plugin for Orca guards launches now (`details.guard`),
 * so a report says whether its collection would be guarded.
 */
export async function runtimeWorktreeProof(
  path: string,
  policy: WorktreePolicy,
  idleDays: number,
  runtime: WorktreeRuntime,
): Promise<Outcome<Proof>> {
  if (!lstatSync(path).isDirectory())
    return ok({ state: "finding", reason: "worktree root is not a directory" });
  const registry = await orcaLiveness(runtime.orca, path);
  const proved =
    registry === null
      ? await worktreeProof(path, policy, idleDays, true)
      : ok(registry);
  if (!proved.ok) return proved;
  const proof = proved.value;
  const guard = guardLabel();
  return ok({
    ...proof,
    reason: `${proof.reason}; ${guard.reason}`,
    details: {
      ...(isMapping(proof.details) ? proof.details : {}),
      guard: guard.label,
    },
  });
}
/** What names a worktree: its branch (`HEAD` when detached), its commit and its Git directory. */
interface WorktreeIdentity {
  name: string;
  head: string;
  admin: string;
}
async function worktreeIdentity(
  path: string,
): Promise<Outcome<WorktreeIdentity>> {
  const name = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!name.ok) return name;
  const head = await git(path, ["rev-parse", "HEAD"]);
  if (!head.ok) return head;
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  if (!dir.ok) return dir;
  const admin = isAbsolute(dir.value) ? dir.value : resolve(path, dir.value);
  return ok({ name: name.value, head: head.value, admin });
}
/**
 * The drive record of a detached tree, null for a tree on a branch, and a
 * `detached` failure for a detached tree no drive attached. A detached tree
 * a drive attached names its pull request, and the remote that pull request
 * was fetched through, in its record, for as long as its head still descends
 * from the commit attached and holds no other branch's work
 * (`describesHead`). Unlike the drive's readers, no remote branch is
 * required: a merged pull request's branch is often deleted, and that is
 * when the tree is reported.
 */
async function attachedDrive(
  path: string,
  identity: WorktreeIdentity,
): Promise<Outcome<DrivenTree | null>> {
  if (identity.name !== "HEAD") return ok(null);
  const record = readDrivenTree(identity.admin);
  if (
    record !== null &&
    (await ancestry(path, record.head, identity.head)) === true
  )
    return ok(record);
  return failed(
    "detached",
    "HEAD is detached and no drive attached the worktree",
  );
}
/**
 * What the tree itself holds: uncommitted and index-hidden changes, an
 * operation in progress and its ignored content. Forge and history evidence
 * start unread.
 */
async function localEvidence(
  path: string,
  admin: string,
  coordinated: boolean,
): Promise<Outcome<WorktreeEvidence>> {
  const flags = await git(path, ["ls-files", "-v", "-z"]);
  if (!flags.ok) return flags;
  const status = await git(path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
    "-z",
  ]);
  if (!status.ok) return status;
  const changes = flags.value
    .split("\0")
    .some((entry) => /^[a-zS] /.test(entry));
  const state = await operation(admin);
  const ignored = await git(path, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    // A wholly ignored directory (node_modules, in the common case) is
    // one entry, not every file inside it: a dependency tree can hold
    // tens of thousands, which would otherwise bloat every veto reason
    // and receipt line that names it.
    "--directory",
    "-z",
  ]);
  if (!ignored.ok) return ignored;
  const ignoredContent = classifyIgnored(
    path,
    ignored.value.split("\0").filter((entry) => entry !== ""),
  );
  if (!ignoredContent.ok) return ignoredContent;
  return ok({
    dirty: !!status.value,
    hiddenIndexChanges: changes,
    operation: state,
    ignoredContent: ignoredContent.value,
    requests: null,
    localOnlyCommits: null,
    mergedHeadCovers: null,
    aheadOfBase: null,
    held: null,
    idleMs: null,
    coordinated,
  });
}
/**
 * Fills in what history says of a tree with no open pull request: commits
 * no remote branch holds and whether a merged pull request's head covers
 * them, how far a tree with no pull request is ahead of the base, the
 * process holding it and how long it has been idle.
 */
async function historyEvidence(
  path: string,
  policy: WorktreePolicy,
  identity: WorktreeIdentity,
  facts: WorktreeEvidence & { requests: WorktreeRequest[] },
): Promise<Outcome<void>> {
  const localOnly = await localOnlyCommits(path, identity.head);
  if (!localOnly.ok) return localOnly;
  facts.localOnlyCommits = localOnly.value;
  if (facts.localOnlyCommits)
    facts.mergedHeadCovers = await mergedHeadCoverage(
      path,
      identity.head,
      facts.requests,
    );
  if (facts.requests.length === 0) {
    const ahead = await aheadOfBase(path, policy.remote, policy.base);
    if (!ahead.ok) return ahead;
    facts.aheadOfBase = ahead.value;
  }
  facts.held = await processHolder(path);
  const idle = worktreeActivity(path, identity.admin);
  if (!idle.ok) return idle;
  facts.idleMs = idle.value;
  return ok(undefined);
}
/** A `changed` failure when the tree's commit or branch moved while it was proved. */
async function identityUnchanged(
  path: string,
  identity: WorktreeIdentity,
): Promise<Outcome<void>> {
  const headAfter = await git(path, ["rev-parse", "HEAD"]);
  if (!headAfter.ok) return headAfter;
  if (headAfter.value !== identity.head)
    return failed("changed", "Worktree identity changed during the proof");
  const nameAfter = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!nameAfter.ok) return nameAfter;
  if (nameAfter.value !== identity.name)
    return failed("changed", "Worktree identity changed during the proof");
  return ok(undefined);
}
/**
 * A proof carrying the paths set aside as rebuildable, whatever its state,
 * so the receipt says what was judged rebuildable even for a worktree that
 * goes on to report `would-collect`.
 */
function withRebuildable(
  facts: WorktreeEvidence,
  proof: Proof,
): Outcome<Proof> {
  return ok(
    facts.ignoredContent.rebuildable.length
      ? { ...proof, details: { rebuildable: facts.ignoredContent.rebuildable } }
      : proof,
  );
}
/**
 * The proof of a worktree no runtime manages, or the runtime's proof after
 * its registry showed no agent: what Git, the forge and the file system say.
 * Evidence that cannot be read fails it; the kind records that as
 * `unverified`.
 */
export async function worktreeProof(
  path: string,
  policy: WorktreePolicy,
  idleDays: number,
  coordinated = false,
): Promise<Outcome<Proof>> {
  if (!lstatSync(path).isDirectory())
    return ok({ state: "finding", reason: "worktree root is not a directory" });
  const identity = await worktreeIdentity(path);
  if (!identity.ok) return identity;
  const driven = await attachedDrive(path, identity.value);
  if (!driven.ok) return driven;
  const local = await localEvidence(path, identity.value.admin, coordinated);
  if (!local.ok) return local;
  const facts = local.value;
  const veto = localWorktreeVeto(facts);
  if (veto) return withRebuildable(facts, veto);
  const found =
    driven.value === null
      ? await requests(path, policy.remote, identity.value.name)
      : await drivenRequests(path, driven.value);
  if (!found.ok) return found;
  const proved = { ...facts, requests: found.value };
  if (proved.requests.some((pr) => pr.state === "OPEN"))
    return withRebuildable(
      proved,
      classifyWorktree(proved, idleDays * 86_400_000),
    );
  const history = await historyEvidence(path, policy, identity.value, proved);
  if (!history.ok) return history;
  const unchanged = await identityUnchanged(path, identity.value);
  if (!unchanged.ok) return unchanged;
  return withRebuildable(
    proved,
    classifyWorktree(proved, idleDays * 86_400_000),
  );
}
