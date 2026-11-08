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
 */
import { holderVerdict } from "../idle-holder.ts";
import { OrcaError } from "./envelope.ts";
import { fetchBranchRef, findGitWorktree } from "./git.ts";
import type { OpenPort } from "./port.ts";
import { output } from "./runner.ts";

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
 * commit as the old value refuses a `HEAD` that moved. The working tree and
 * index are untouched, which the same commit makes right, and no hook runs.
 */
function detachAt(
  port: OpenPort,
  branch: string,
  path: string,
  head: string,
): void {
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

/**
 * Free `branch` from the checkout at `path`, which Orca does not list:
 * detach it when it is idle, else throw what keeps it busy. `clone` is the
 * repository's own clone, whose worktree list must no longer name the
 * branch afterwards.
 */
export function releaseHiddenHolder(
  port: OpenPort,
  clone: string,
  branch: string,
  path: string,
  repoId: string,
): void {
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
  if (!verdict.idle) {
    if (verdict.timedOut)
      throw new OrcaError(
        `${branch} is checked out at ${path}, which Orca${port.where} does not list, and the check of whether it is idle ran out of time: ${verdict.reasons.join("; ")}`,
      );
    throw new BusyHolderError(branch, path, verdict.reasons, port.where);
  }
  detachAt(port, branch, path, verdict.head);
  const still = findGitWorktree(port.host, clone, branch);
  if (still !== null)
    throw new OrcaError(
      `detached the checkout at ${path}, but ${branch} is still checked out at ${still}`,
    );
  port.host.log(
    `↺ detached the idle checkout at ${path} from ${branch} (at ${verdict.head.slice(0, 12)})`,
  );
}
