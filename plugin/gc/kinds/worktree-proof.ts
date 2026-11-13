/** Re-read local identity; preserve unknown evidence and the session-lock veto. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { layeredConfig, remoteName } from "../../shared/consumer.ts";
import { readDrivenTree, type DrivenTree } from "../../shared/driven-tree.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  CHANGES_STATUS_ARGS,
  GIT_OPERATION_MARKERS,
  hidesIndexChanges,
} from "../../shared/idle-holder.ts";
import { orcaFailure, orcaResult, runOrca } from "../../shared/orca.ts";
import { gcGit as git, type GitOutcome } from "../git.ts";
import type { Proof } from "../types.ts";
import { guardLabel } from "./worktree-guard.ts";
import {
  classifyWorktree,
  localWorktreeVeto,
  namedPaths,
  type WorktreeEvidence,
  type WorktreeRequest,
} from "./worktree-evidence.ts";
import { classifyIgnored, type IgnoredContent } from "./worktree-ignored.ts";
import {
  archiveIgnored,
  measure,
  worktreeCreatedAt,
  type Archived,
  type LegacyPolicy,
} from "../legacy-archive.ts";

export { classifyIgnored };
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
  /** Where a worktree older than marking may have its unmarked ignored content archived; absent, none is. */
  legacy?: LegacyPolicy | undefined;
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
  for (const name of GIT_OPERATION_MARKERS) {
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
/** The worktree's ignored content, as git lists it and the rules account for it. */
async function ignoredContentOf(
  path: string,
): Promise<Outcome<IgnoredContent>> {
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
  return classifyIgnored(
    path,
    ignored.value.split("\0").filter((entry) => entry !== ""),
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
  const status = await git(path, [...CHANGES_STATUS_ARGS]);
  if (!status.ok) return status;
  const changes = hidesIndexChanges(flags.value);
  const state = await operation(admin);
  const ignoredContent = await ignoredContentOf(path);
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
 * A proof carrying what was set aside and by which rule, and the archive a
 * worktree older than marking would get, whatever its state, so the receipt
 * says it even for a worktree that goes on to report `would-collect`.
 */
function withSetAside(facts: WorktreeEvidence, proof: Proof): Outcome<Proof> {
  const { rebuildable, setAside } = facts.ignoredContent;
  const archive = facts.archive ?? null;
  const details = {
    ...(rebuildable.length ? { rebuildable } : {}),
    ...(setAside.length ? { setAside } : {}),
    ...(archive ? { archive } : {}),
  };
  const reason =
    archive && proof.state === "dead"
      ? `${proof.reason}; ignored content no rule accounts for (${namedPaths(archive.paths)}, ${archive.bytes} bytes) is archived once before removal, since the worktree predates marking`
      : proof.reason;
  return ok(
    Object.keys(details).length ? { ...proof, reason, details } : proof,
  );
}
/**
 * Plan the one-time archive of a worktree created before marking began on
 * this host: its ignored content no rule accounts for is archived before
 * removal, instead of vetoing it, when it fits the size bound. A worktree
 * whose creation time cannot be read is not shown to predate marking, so its
 * content still vetoes. Null to go on; a proof when the content is too large
 * to archive.
 */
function legacyArchivePlan(
  path: string,
  admin: string,
  facts: WorktreeEvidence,
  legacy: LegacyPolicy | undefined,
): Outcome<Proof | null> {
  const other = facts.ignoredContent.other;
  if (other.length === 0 || legacy === undefined || legacy.maxBytes === 0)
    return ok(null);
  const created = worktreeCreatedAt(admin);
  if (!created.ok || created.value >= legacy.since) return ok(null);
  const measured = measure(path, other, legacy.maxBytes, Date.now() + 30_000);
  if (!measured.ok) return measured;
  if (measured.value.bytes > legacy.maxBytes)
    return ok({
      state: "finding",
      reason: `ignored local content (${namedPaths(other)}) has no independent preservation proof and exceeds the ${legacy.maxBytes}-byte bound of the one-time archive`,
    });
  facts.archive = { paths: other, bytes: measured.value.bytes };
  return ok(null);
}
/**
 * Archive, right before removal, the ignored content no rule accounts for in
 * a worktree created before marking began: the content as it is now, which
 * may differ from what the proof saw. Null when there is none. Anything else
 * (a worktree created since, a creation time that cannot be read, content
 * past the bound, a copy that fails or does not verify) keeps the worktree.
 */
export async function preserveLegacyContent(
  path: string,
  legacy: LegacyPolicy | undefined,
  deadline: number,
): Promise<Outcome<Archived | null>> {
  const content = await ignoredContentOf(path);
  if (!content.ok) return content;
  const other = content.value.other;
  if (other.length === 0) return ok(null);
  const unpreserved = failed(
    "unpreserved",
    `kept: ignored local content (${namedPaths(other)}) has no independent preservation proof`,
  );
  if (legacy === undefined || legacy.maxBytes === 0) return unpreserved;
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  if (!dir.ok) return dir;
  const admin = isAbsolute(dir.value) ? dir.value : resolve(path, dir.value);
  const created = worktreeCreatedAt(admin);
  if (!created.ok || created.value >= legacy.since) return unpreserved;
  const archived = archiveIgnored(path, other, legacy, deadline);
  if (!archived.ok)
    return failed(archived.failure.code, `kept: ${archived.failure.reason}`);
  return archived;
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
  // Changes, index flags and an operation in progress veto before ignored
  // content is weighed for an archive.
  const unarchivable = localWorktreeVeto({
    ...facts,
    ignoredContent: { ...facts.ignoredContent, other: [] },
  });
  if (unarchivable) return withSetAside(facts, unarchivable);
  const planned = legacyArchivePlan(
    path,
    identity.value.admin,
    facts,
    policy.legacy,
  );
  if (!planned.ok) return planned;
  if (planned.value) return withSetAside(facts, planned.value);
  const veto = localWorktreeVeto(facts);
  if (veto) return withSetAside(facts, veto);
  const found =
    driven.value === null
      ? await requests(path, policy.remote, identity.value.name)
      : await drivenRequests(path, driven.value);
  if (!found.ok) return found;
  const proved = { ...facts, requests: found.value };
  if (proved.requests.some((pr) => pr.state === "OPEN"))
    return withSetAside(
      proved,
      classifyWorktree(proved, idleDays * 86_400_000),
    );
  const history = await historyEvidence(path, policy, identity.value, proved);
  if (!history.ok) return history;
  const unchanged = await identityUnchanged(path, identity.value);
  if (!unchanged.ok) return unchanged;
  return withSetAside(proved, classifyWorktree(proved, idleDays * 86_400_000));
}
