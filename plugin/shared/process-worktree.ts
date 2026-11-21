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
import {
  type DetachedHolder,
  releaseHiddenHolder,
} from "./orca-workspace/holder.ts";
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
  reserve?: (worktree: WorkspaceCheckout) => Outcome<void>;
  /** Told the moment an idle checkout is detached, so a later failure of the open still reports it. */
  onDetached?: (holder: DetachedHolder) => void;
}

/** Publication is part of admission, so a stalled publisher must cooperate. */
const PUBLICATION_TIMEOUT_MS = 30_000;

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
    signal: AbortSignal,
  ) => Outcome<void> | Promise<Outcome<void>>,
): Promise<
  Outcome<{
    worktree: WorkspaceCheckout;
    reattached: boolean;
    hookRan: boolean;
    /** An idle checkout of another opener held the branch, and this open detached it there. */
    detached?: DetachedHolder;
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
        let detached: DetachedHolder | undefined;
        const opened = openWorkspace(port, repository, options, {
          existing: (branch) => {
            const path = findGitWorktree(port.host, repository, branch);
            if (path === null) return null;
            assertLinkedWorktree(port.host, path, `reattach to ${branch}`);
            const owner = readWorktreeOwner(gitDirOf(port, path));
            if (!owner.ok)
              throw new OrcaError(owner.failure.reason, {
                cause: owner.failure.cause ?? owner.failure,
              });
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
            detached = releaseHiddenHolder(
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
            options.onDetached?.(detached);
            return null;
          },
          prepare: (worktree) => {
            const admin = gitDirOf(port, worktree.path);
            const previous = readWorktreeOwner(admin);
            if (!previous.ok)
              throw new OrcaError(previous.failure.reason, {
                cause: previous.failure.cause ?? previous.failure,
              });
            const owner = previous.value ?? {
              version: 1 as const,
              runtime: "process" as const,
              repository,
              branch: options.branch,
              launches: [],
              processes: [],
            };
            const reserved = options.reserve?.(worktree);
            if (reserved !== undefined && !reserved.ok)
              throw new OrcaError(reserved.failure.reason, {
                cause: reserved.failure.cause,
              });
            const written = writeWorktreeOwner(admin, {
              ...owner,
              launches: [...new Set([...owner.launches, options.launch])],
            });
            if (!written.ok)
              throw new OrcaError(written.failure.reason, {
                cause: written.failure.cause ?? written.failure,
              });
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
        // Do not race publication: a publisher that ignores cancellation
        // remains under admission rather than continuing after collection is
        // allowed to enter. The publisher's contract is to settle only after
        // it has stopped its own work.
        const signal = AbortSignal.timeout(PUBLICATION_TIMEOUT_MS);
        const published = await publish(opened.worktree, signal);
        return signal.aborted
          ? failed(
              "publish-timed-out",
              "worktree publication exceeded its deadline",
            )
          : published.ok
            ? ok(detached === undefined ? opened : { ...opened, detached })
            : published;
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
