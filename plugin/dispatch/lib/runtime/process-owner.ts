/** Mirror a run's witnessed process identities in its checkout's owner. */
import { realpathSync } from "node:fs";
import { withFileLock } from "../../../shared/file-lock.ts";
import { sharedGcLock } from "../../../shared/gc-lock.ts";
import type { ProcessIdentity } from "../../../shared/liveness.ts";
import { gitDirOf } from "../../../shared/orca-workspace/hooks.ts";
import {
  localContext,
  withLimit,
} from "../../../shared/orca-workspace/runner.ts";
import {
  processWorktreeRoot,
  readWorktreeOwner,
  writeWorktreeOwner,
} from "../../../shared/process-worktree-owner.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import type { LaunchRecord } from "../launches.ts";

const OWNER_TIMEOUT_MS = 5000;

export async function rememberProcessOwner(
  record: LaunchRecord,
  identity: ProcessIdentity,
): Promise<Outcome<void>> {
  if (record.runtime !== "process" || record.workspace === null)
    return ok(undefined);
  let release: (() => void) | undefined;
  try {
    const repository = realpathSync(record.repoPath);
    const path = record.workspace.path;
    const host = withLimit(
      localContext(() => undefined),
      OWNER_TIMEOUT_MS,
    );
    release = sharedGcLock("worktrees");
    const admin = gitDirOf({ host }, path);
    const first = readWorktreeOwner(admin);
    // A recovery may run where its original actor left work, including a
    // checkout opened before this runtime. That tree has launch evidence
    // but no process ownership to update.
    if (!first.ok) return first;
    if (first.value === null) return ok(undefined);
    const { branch } = first.value;
    const locked = await withFileLock(
      `${repository}\0${branch}`,
      async () => {
        const read = readWorktreeOwner(admin);
        if (!read.ok) return read;
        const owner = read.value;
        if (
          owner === null ||
          owner.repository !== repository ||
          owner.branch !== branch
        )
          return failed(
            "owner-changed",
            "the process worktree's owner changed",
          );
        const present = owner.processes.some(
          (seen) =>
            seen.hostId === identity.hostId &&
            seen.bootId === identity.bootId &&
            seen.pid === identity.pid &&
            seen.start === identity.start,
        );
        return writeWorktreeOwner(admin, {
          ...owner,
          launches: [...new Set([...owner.launches, record.id])],
          processes: present ? owner.processes : [...owner.processes, identity],
        });
      },
      {
        root: processWorktreeRoot(repository),
        name: "owner-publication",
        waitMs: OWNER_TIMEOUT_MS,
      },
    );
    return (
      locked?.value ??
      failed("owner-busy", "the worktree owner publication lock is busy")
    );
  } catch (error) {
    return failed(
      "owner-unreadable",
      "the run could not update its worktree's owner",
      error,
    );
  } finally {
    release?.();
  }
}
