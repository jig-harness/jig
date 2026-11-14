/** Read-only tree facts for a steward; unavailable facts never become clean trees. */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { gitIdentityEnv, run } from "../../shared/proc.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { durableSummary } from "./pass-output.ts";

export type EvidenceRead<T> = Outcome<T, "unreadable">;
export type EvidenceRoom = () => number | null;
export interface TreeEvidence {
  path: string;
  branch: string | null;
  head: string;
  unpushed: EvidenceRead<{
    against: string;
    commits: string[];
    truncated: boolean;
  }>;
  uncommitted: string[];
  uncommittedTruncated?: boolean;
  operation: string | null;
}

/** A read fits within both the tick's remaining room and a short command deadline. */
export async function evidenceCommand(
  argv: string[],
  cwd: string,
  room: EvidenceRoom,
  env?: Record<string, string | undefined>,
  runner: typeof run = run,
): Promise<EvidenceRead<string>> {
  const left = room();
  if (left !== null && left < 1000)
    return failed(
      "unreadable",
      "the tick budget has no room for another steward evidence read",
    );
  try {
    const result = await runner(argv, {
      cwd,
      timeoutSec: Math.max(1, Math.min(10, Math.floor((left ?? 10000) / 1000))),
      stderr: "pipe",
      ...(env === undefined ? {} : { env }),
    });
    return result.code === 0
      ? ok(result.stdout)
      : failed(
          "unreadable",
          `${argv[0]} ${argv[1]} did not read (exit ${result.code})`,
          {
            untrusted: true,
            code: result.code,
            signal: result.signal,
            timedOut: result.timedOut,
            spawnFailed: result.spawnFailed,
            bufferExceeded: result.bufferExceeded,
            stderrTail: durableSummary(result.stderrTail),
          },
        );
  } catch (error) {
    return failed(
      "unreadable",
      `${argv[0]} ${argv[1]} could not be started`,
      error,
    );
  }
}

export async function treeEvidence(
  path: string,
  room: EvidenceRoom,
): Promise<EvidenceRead<TreeEvidence>> {
  // This evidence is about `path`, not a caller-selected Git directory.
  const git = (args: string[]) =>
    evidenceCommand(["git", ...args], path, room, gitIdentityEnv());
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return head;
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return branch;
  const status = await git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) return status;
  const directory = await git(["rev-parse", "--absolute-git-dir"]);
  if (!directory.ok) return directory;
  const operation = operationEvidence(directory.value.trim());
  if (!operation.ok) return operation;
  const unpushed = await unpushedEvidence(git);
  return ok({
    path,
    branch: branch.value.trim() === "HEAD" ? null : branch.value.trim(),
    head: head.value.trim(),
    unpushed,
    uncommitted: status.value.split("\0").filter(Boolean).slice(0, 200),
    ...(status.value.split("\0").filter(Boolean).length > 200
      ? { uncommittedTruncated: true }
      : {}),
    operation: operation.value,
  });
}

function operationEvidence(directory: string): EvidenceRead<string | null> {
  for (const [marker, name] of [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or am"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ] as const) {
    try {
      statSync(resolve(directory, marker));
      return ok(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return failed(
          "unreadable",
          "the workspace operation markers are inaccessible",
          error,
        );
    }
  }
  return ok(null);
}

async function unpushedEvidence(
  git: (args: string[]) => Promise<EvidenceRead<string>>,
): Promise<TreeEvidence["unpushed"]> {
  const upstream = await git([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (!upstream.ok)
    return failed(
      "unreadable",
      "no upstream could be established; unpushed commits are unknown",
      upstream.failure,
    );
  const commits = await git([
    "log",
    "--format=%H",
    "--max-count=51",
    `${upstream.value.trim()}..HEAD`,
    "--",
  ]);
  if (!commits.ok) return commits;
  const list = commits.value.trim().split("\n").filter(Boolean);
  return ok({
    against: upstream.value.trim(),
    commits: list.slice(0, 50),
    truncated: list.length > 50,
  });
}
