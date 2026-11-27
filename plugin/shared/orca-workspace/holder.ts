/**
 * A checkout Orca does not list that holds the branch an open asks for: one
 * made with plain git, such as an agent's isolation worktree from the
 * session that built the pull request, or another tool's. Git lets a branch
 * be checked out in only one worktree, so the open cannot give the branch a
 * workspace of its own while that checkout holds it.
 *
 * Where the caller's port can read what drives a tree (`OpenPort.drivers`),
 * an idle holder (`shared/idle-holder.ts`) is detached at the commit it is
 * at, its tree and everything in it left as they were, and the open goes on
 * to create the workspace. The idle check runs after the remote's copy of
 * the branch is refreshed and immediately before the detach, which happens
 * only while `HEAD` is still at the commit the check read. A check cut short
 * by the open's time limit is an ordinary refusal, retried by the next
 * open, never a busy holder a person is told of. A holder that
 * is not idle refuses the open with a `BusyHolderError`, which names it and
 * what keeps it busy, so a caller can tell a person once rather than log the
 * refusal on every attempt. Without the reader, every such checkout is
 * refused, with how to have Orca show it instead.
 *
 * The host may widen what is detached without asking (`HolderPolicy`, the
 * machine file's `detach_idle_holders` and `rescue_unpushed`): a holder
 * busy only with changes in its tree, which the detach leaves where they
 * are, and, with the rescue on as well, one whose commits the remote lacks.
 * Those commits are first kept on a rescue branch, a local branch of the
 * clone named for the tree and the time (`jig-rescue/<tree>-<time>`) that
 * nothing pushes or collects; a rescue that fails refuses the open as a busy
 * holder and leaves the tree as it was. Once the holder is detached, the
 * branch is moved back to the remote's copy where the remote has one, so the
 * open can check it out; its commits stay on the rescue branch. A holder
 * with any other reason (a process, a lease, an unfinished operation, a probe
 * that could not answer, the time running out) is never touched.
 */
import { basename } from "node:path";
import { type HolderVerdict, holderVerdict } from "../idle-holder.ts";
import { currentIso } from "../time.ts";
import { OrcaError } from "./envelope.ts";
import { fetchBranchRef, findGitWorktree } from "./git.ts";
import type { OpenPort } from "./port.ts";
import { output } from "./runner.ts";

/** What the host lets an open detach beyond an idle holder, without asking a person. */
export interface HolderPolicy {
  /** A holder busy only with changes in its tree or index (`detach_idle_holders`). */
  detachIdle: boolean;
  /** With `detachIdle`, also one whose commits the remote lacks, once they are kept on a rescue branch (`rescue_unpushed`). */
  rescueUnpushed: boolean;
}

/** The rescue branch a holder's unpushed commits were kept on, and the clone it is a branch of. */
export interface RescueBranch {
  branch: string;
  clone: string;
}

/** An idle checkout the open detached: where it is, the branch it gave up (kept, with its commits) and the commit it was left at; `rescue` where its unpushed commits were kept on a rescue branch first. */
export interface DetachedHolder {
  path: string;
  branch: string;
  head: string;
  rescue?: RescueBranch;
}

/** The prefix every rescue branch's name starts with. */
export const RESCUE_PREFIX = "jig-rescue/";

/**
 * Whether `policy` lets a holder `verdict` found busy be detached anyway,
 * and whether that needs a rescue branch first; `null` when it does not.
 */
export function waived(
  policy: HolderPolicy | undefined,
  verdict: HolderVerdict,
): { head: string; rescue: boolean } | null {
  if (policy?.detachIdle !== true || verdict.idle) return null;
  if (verdict.timedOut || verdict.head === undefined) return null;
  const allowed = (kind: string) =>
    kind === "changes" || (kind === "unpushed" && policy.rescueUnpushed);
  if (!verdict.kinds.every(allowed)) return null;
  return { head: verdict.head, rescue: verdict.kinds.includes("unpushed") };
}

/** A rescue branch's name for the tree at `path`, at the moment `at`: `jig-rescue/<tree>-<YYYYMMDDTHHMMSSZ>`. */
export function rescueBranchName(path: string, at: string): string {
  const tree =
    basename(path)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/\.{2,}/g, ".")
      .replace(/\.lock$/, "")
      .slice(0, 60) || "tree";
  const stamp = at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${RESCUE_PREFIX}${tree}-${stamp}`;
}

/**
 * Keep `head` on a new rescue branch of `clone`, or say why it could not be
 * kept. The branch is created only where no branch of that name is, with
 * hooks off, and read back before the detach may go on.
 */
function keepOnRescue(
  port: OpenPort,
  clone: string,
  path: string,
  head: string,
): RescueBranch | { failed: string } {
  const branch = rescueBranchName(path, currentIso());
  const git = (args: string[]) =>
    port.host.run([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      clone,
      ...args,
    ]);
  const valid = git(["check-ref-format", "--branch", branch]);
  if (valid.status !== 0)
    return { failed: `${branch} is not a valid branch name: ${output(valid)}` };
  const made = git([
    "update-ref",
    "-m",
    `jig: kept the unpushed commits of ${path}`,
    `refs/heads/${branch}`,
    head,
    "",
  ]);
  if (made.status !== 0)
    return { failed: `${branch} could not be created: ${output(made)}` };
  const read = git([
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}^{commit}`,
  ]);
  if (read.status !== 0 || read.stdout.trim() !== head)
    return { failed: `${branch} does not read back at ${head.slice(0, 12)}` };
  return { branch, clone };
}

/**
 * Move `branch` in `clone` back to the remote's copy, only while it is still
 * at `head`: its own commits are on the rescue branch, and the open can then
 * check the branch out from the remote. Nothing to do where the remote has
 * no copy or the branch is already there.
 */
function backToRemote(
  port: OpenPort,
  clone: string,
  branch: string,
  head: string,
): void {
  const remote = port.host.run([
    "git",
    "-C",
    clone,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${REMOTE}/${branch}^{commit}`,
  ]);
  const tip = remote.stdout.trim();
  if (remote.status !== 0 || tip === "" || tip === head) return;
  const moved = port.host.run([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    clone,
    "update-ref",
    "-m",
    `jig: moved ${branch} back to ${REMOTE}/${branch}, its commits on a rescue branch`,
    `refs/heads/${branch}`,
    tip,
    head,
  ]);
  if (moved.status !== 0)
    throw new OrcaError(
      `kept the commits of ${branch} on a rescue branch and detached its checkout, but ${branch} could not be moved back to ${REMOTE}/${branch}: ${output(moved)}`,
    );
}

/** The remote the open reads and checks branches out from. */
const REMOTE = "origin";

/** A checkout Orca does not list holds the branch and is in use: where it is, and what keeps it busy. */
export class BusyHolderError extends OrcaError {
  override name = "BusyHolderError";
  readonly branch: string;
  readonly path: string;
  readonly reasons: string[];
  constructor(branch: string, path: string, reasons: string[], where: string) {
    super(
      `${branch} is checked out at ${path}, which Orca${where} does not list and which is in use: ${reasons.join("; ")}; once it is idle an open detaches it, or remove that checkout`,
    );
    this.branch = branch;
    this.path = path;
    this.reasons = reasons;
  }
}

/**
 * Detach the checkout at `path` from `branch`, only while its `HEAD` is still
 * at `head`, the commit the idle check read: `git update-ref` with that
 * commit as the old value refuses a `HEAD` that moved, and a `HEAD` read
 * just before it must still name `branch`, so a holder that switched to
 * another branch at the same commit is left alone. Git cannot compare the
 * branch a symbolic `HEAD` names in the same transaction as a detach, so a
 * switch between those two calls is not caught; it needs a process in a tree
 * the idle check found empty, the same race the check itself has. The
 * working tree and index are untouched, which the same commit makes right,
 * and no hook runs.
 */
function detachAt(
  port: OpenPort,
  branch: string,
  path: string,
  head: string,
): void {
  const current = port.host.run([
    "git",
    "-C",
    path,
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  if (current.status !== 0 || current.stdout.trim() !== `refs/heads/${branch}`)
    throw new BusyHolderError(
      branch,
      path,
      ["its checked-out branch changed during the check"],
      port.where,
    );
  const detached = port.host.run([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    path,
    "update-ref",
    "--no-deref",
    "-m",
    `jig: detached from ${branch} so another checkout can take it`,
    "HEAD",
    head,
    head,
  ]);
  if (detached.status === 0) return;
  const now = port.host.run(["git", "-C", path, "rev-parse", "HEAD"]);
  if (now.status === 0 && now.stdout.trim() !== head)
    throw new BusyHolderError(
      branch,
      path,
      ["its head moved during the check"],
      port.where,
    );
  throw new OrcaError(
    `could not detach the idle checkout at ${path} from ${branch}: ${output(detached)}`,
  );
}

/** The log's words for a rescue branch, none without one. */
function rescueText(rescue: RescueBranch | null): string {
  return rescue === null
    ? ""
    : `, its unpushed commits kept on ${rescue.branch} in ${rescue.clone}`;
}

/**
 * The commit a holder `verdict` read may be detached at, and the rescue
 * branch its unpushed commits were kept on first where the host's policy
 * asked for one; else throw why it stays: busy, out of time, or a rescue
 * that could not be made, which leaves the tree as it was.
 */
function detachable(
  port: OpenPort,
  clone: string,
  branch: string,
  path: string,
  verdict: HolderVerdict,
): { head: string; rescue: RescueBranch | null } {
  if (verdict.idle) return { head: verdict.head, rescue: null };
  const waiver = waived(port.holders, verdict);
  if (waiver === null) {
    if (verdict.timedOut)
      throw new OrcaError(
        `${branch} is checked out at ${path}, which Orca${port.where} does not list, and the check of whether it is idle ran out of time: ${verdict.reasons.join("; ")}`,
      );
    throw new BusyHolderError(branch, path, verdict.reasons, port.where);
  }
  if (!waiver.rescue) return { head: waiver.head, rescue: null };
  const rescue = keepOnRescue(port, clone, path, waiver.head);
  if ("failed" in rescue)
    throw new BusyHolderError(
      branch,
      path,
      [
        ...verdict.reasons,
        `its unpushed commits could not be kept on a rescue branch, so it was left as it is: ${rescue.failed}`,
      ],
      port.where,
    );
  return { head: waiver.head, rescue };
}

/**
 * Free `branch` from the checkout at `path`, which Orca does not list:
 * detach it when it is idle, and say where it was left, else throw what
 * keeps it busy. `clone` is the repository's own clone, whose worktree list
 * must no longer name the branch afterwards. `detached` is told the moment
 * the detach has happened, before the checks that follow it can throw.
 */
export function releaseHiddenHolder(
  port: OpenPort,
  clone: string,
  branch: string,
  path: string,
  repoId: string,
  detached?: (holder: DetachedHolder) => void,
): DetachedHolder {
  if (port.drivers === undefined)
    throw new OrcaError(
      `${branch} is checked out at ${path}, which Orca${port.where} does not list; show the repository's non-Orca worktrees (orca repo set --repo id:${repoId} --external-worktree-visibility show) and open it again, or remove that checkout`,
    );
  fetchBranchRef(port.host, clone, branch);
  const verdict = holderVerdict(port.host, {
    path,
    branch,
    remote: REMOTE,
    drivers: port.drivers,
  });
  const { head, rescue } = detachable(port, clone, branch, path, verdict);
  detachAt(port, branch, path, head);
  const left: DetachedHolder = {
    path,
    branch,
    head,
    ...(rescue === null ? {} : { rescue }),
  };
  // Told before any check that can throw: the checkout is already detached.
  detached?.(left);
  if (rescue !== null) backToRemote(port, clone, branch, head);
  const still = findGitWorktree(port.host, clone, branch);
  if (still !== null)
    throw new OrcaError(
      `detached the checkout at ${path}, but ${branch} is still checked out at ${still}`,
    );
  port.host.log(
    `↺ detached the ${verdict.idle ? "idle " : ""}checkout at ${path} from ${branch} (at ${head.slice(0, 12)})${rescueText(rescue)}`,
  );
  return left;
}
