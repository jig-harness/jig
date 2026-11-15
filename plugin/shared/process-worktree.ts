/** Plain git checkout publication, kept inside collection's shared admission. */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sharedGcLock } from "./gc-lock.ts";
import { withFileLock } from "./file-lock.ts";
import { failed, ok, type Outcome } from "./outcome.ts";
import { OrcaError } from "./orca-workspace/envelope.ts";
import { assertLinkedWorktree, findGitWorktree } from "./orca-workspace/git.ts";
import { gitDirOf } from "./orca-workspace/hooks.ts";
import { releaseHiddenHolder } from "./orca-workspace/holder.ts";
import type { OpenPort } from "./orca-workspace/port.ts";
import { output } from "./orca-workspace/runner.ts";
import {
  openWorkspace,
  type WorkspaceCheckout,
  type WorkspaceOpenOptions,
} from "./workspace-open.ts";
import {
  processWorktreeRoot,
  readWorktreeOwner,
  writeWorktreeOwner,
} from "./process-worktree-owner.ts";

export interface ProcessWorktreeOptions extends WorkspaceOpenOptions {
  repository: string;
  launch: string;
  home?: string;
}

/**
 * `publish` must persist this launch's checkout before returning success.
 * Admission is held through the owner, the hook and that publication, including
 * reattachment. A failure leaves an owner naming the uncompleted launch, which
 * keeps collection closed until the launch can be reconciled.
 */
export async function openProcessWorktree(
  port: Pick<OpenPort, "host" | "runHook" | "drivers">,
  options: ProcessWorktreeOptions,
  publish: (
    worktree: WorkspaceCheckout,
  ) => Outcome<void> | Promise<Outcome<void>>,
): Promise<
  Outcome<{
    worktree: WorkspaceCheckout;
    reattached: boolean;
    hookRan: boolean;
  }>
> {
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(options.launch))
    return failed(
      "invalid-launch",
      "the worktree opener needs a valid launch record id",
    );
  let release: (() => void) | undefined;
  try {
    release = sharedGcLock("worktrees");
    const repository = realpathSync(options.repository);
    const root = processWorktreeRoot(repository, options.home);
    const locked = await withFileLock(
      `${repository}\0${options.branch}`,
      async () => {
        const opened = openWorkspace(port, repository, options, {
          existing: (branch) => {
            const path = findGitWorktree(port.host, repository, branch);
            if (path === null) return null;
            assertLinkedWorktree(port.host, path, `reattach to ${branch}`);
            const owner = readWorktreeOwner(gitDirOf(port, path));
            if (!owner.ok) throw new OrcaError(owner.failure.reason);
            if (owner.value !== null) {
              if (
                owner.value.repository !== repository ||
                owner.value.branch !== branch
              )
                throw new OrcaError(
                  `the owner of ${path} names another repository or branch`,
                );
              return { id: path, path, branch };
            }
            // A checkout made by another opener is detached only with its full
            // idle proof. No reader means refusal, never an assumed idle tree.
            releaseHiddenHolder(
              {
                ...port,
                where: "",
                orcaCall: () =>
                  failed("no-envelope", "process opener makes no Orca calls"),
              },
              repository,
              branch,
              path,
              repository,
            );
            return null;
          },
          prepare: (worktree) => {
            const admin = gitDirOf(port, worktree.path);
            const previous = readWorktreeOwner(admin);
            if (!previous.ok) throw new OrcaError(previous.failure.reason);
            const owner = previous.value ?? {
              version: 1 as const,
              runtime: "process" as const,
              repository,
              branch: options.branch,
              launches: [],
              processes: [],
            };
            const written = writeWorktreeOwner(admin, {
              ...owner,
              launches: [...new Set([...owner.launches, options.launch])],
            });
            if (!written.ok) throw new OrcaError(written.failure.reason);
          },
          create: (branch, from, start) => {
            mkdirSync(root, { recursive: true, mode: 0o700 });
            const digest = createHash("sha256")
              .update(branch)
              .digest("hex")
              .slice(0, 12);
            const name = `${branch.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}-${digest}`;
            const path = join(root, name);
            const done = port.host.run([
              "git",
              "-C",
              repository,
              "worktree",
              "add",
              ...(start === "create-from-base"
                ? ["-b", branch]
                : start === "create-from-origin"
                  ? ["-B", branch]
                  : []),
              "--",
              path,
              from,
            ]);
            if (done.status !== 0)
              throw new OrcaError(`cannot open ${path}: ${output(done)}`);
            return { id: path, path, branch };
          },
        });
        const published = await publish(opened.worktree);
        return published.ok ? ok(opened) : published;
      },
      { root, name: "owner-publication" },
    );
    return locked === null
      ? failed(
          "open-busy",
          "another opener holds the worktree publication lock; retry",
        )
      : locked.value;
  } catch (error) {
    return failed(
      "open-failed",
      error instanceof Error ? error.message : String(error),
      error,
    );
  } finally {
    release?.();
  }
}
