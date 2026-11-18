/** Branch choice, upstream repair and create-hook ordering shared by workspace runtimes. */
import { OrcaError } from "./orca-workspace/envelope.ts";
import {
  assertBranchName,
  defaultBase,
  decideBranchAction,
  ensureUpstreamTracking,
  probeBranch,
  refreshBaseRef,
} from "./orca-workspace/git.ts";
import { ensureCreateHook, gitDirOf } from "./orca-workspace/hooks.ts";
import type { OpenPort } from "./orca-workspace/port.ts";
import { output } from "./orca-workspace/runner.ts";

export interface WorkspaceCheckout {
  id: string;
  path: string;
  branch: string;
}
export interface WorkspaceOpenOptions {
  branch: string;
  base?: string;
  createHook?: boolean;
  expectedHead?: string;
}
export interface WorkspaceBackend<T extends WorkspaceCheckout> {
  existing(branch: string): T | null;
  /** Publish ownership before the create hook can fail or start a process. */
  prepare?(worktree: T): void;
  create(
    branch: string,
    from: string,
    start: "create-from-base" | "create-from-origin" | "use-local",
  ): T;
}

/** An existing checkout first; otherwise choose origin, local, or a refreshed base. */
export function attachWorkspace<T extends WorkspaceCheckout>(
  port: Pick<OpenPort, "host">,
  repository: string,
  branch: string,
  backend: WorkspaceBackend<T>,
  base?: string,
): { worktree: T; reattached: boolean } {
  const found = backend.existing(branch);
  let worktree: T;
  if (found !== null) worktree = found;
  else {
    const action = decideBranchAction(
      probeBranch(port.host, repository, branch),
    );
    if (action.kind === "refuse-diverged")
      throw new OrcaError(
        `${branch} has ${action.ahead.length} commit(s) origin lacks; reconcile the branch with origin before opening it`,
      );
    let from: string;
    if (action.kind === "create-from-origin") from = `origin/${branch}`;
    else if (action.kind === "use-local") from = branch;
    else {
      from = base ?? defaultBase(port.host, repository);
      refreshBaseRef(port.host, repository, from);
    }
    worktree = backend.create(branch, from, action.kind);
  }
  // A process-backed checkout must be owned before upstream repair can make
  // another opener observe and reuse it.  Keep this before every operation
  // that can fail after the checkout exists, including expected-head checks.
  backend.prepare?.(worktree);
  ensureUpstreamTracking(port.host, repository, branch);
  return { worktree, reattached: found !== null };
}

/** Validate before attachment; the expected commit is checked before any hook runs. */
export function openWorkspace<T extends WorkspaceCheckout>(
  port: Pick<OpenPort, "host" | "runHook">,
  repository: string,
  options: WorkspaceOpenOptions,
  backend: WorkspaceBackend<T>,
): { worktree: T; reattached: boolean; hookRan: boolean } {
  assertBranchName(port.host, options.branch);
  const opened = attachWorkspace(
    port,
    repository,
    options.branch,
    backend,
    options.base,
  );
  if (options.expectedHead !== undefined) {
    const head = port.host.run([
      "git",
      "-C",
      opened.worktree.path,
      "rev-parse",
      "HEAD",
    ]);
    if (head.status !== 0)
      throw new OrcaError(
        `cannot read HEAD in ${opened.worktree.path} (exit ${head.status}): ${output(head)}`,
      );
    if (head.stdout.trim() !== options.expectedHead)
      throw new OrcaError(
        `${opened.worktree.path} does not match the pull request head ${options.expectedHead}; reconcile the checkout before driving it`,
      );
  }
  const hookRan =
    options.createHook !== false &&
    ensureCreateHook(
      port,
      opened.worktree.path,
      gitDirOf(port, opened.worktree.path),
    );
  return { ...opened, hookRan };
}
