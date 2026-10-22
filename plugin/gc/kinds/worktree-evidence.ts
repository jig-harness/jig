/** Each live condition vetoes on its own; age never establishes lifecycle death. */
import type { Proof } from "../types.ts";
export interface WorktreeRequest {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
}
export interface WorktreeEvidence {
  dirty: boolean;
  hiddenIndexChanges: boolean;
  operation: string | null;
  ignoredContent: boolean;
  requests: WorktreeRequest[] | null;
  localOnlyCommits: boolean | null;
  mergedHeadCovers: boolean | null;
  aheadOfBase: number | null;
  held: boolean | null;
  idleMs: number | null;
}
const unknown = (reason: string): Proof => ({ state: "unverified", reason });
const live = (reason: string): Proof => ({ state: "live", reason });
export function localWorktreeVeto(
  facts: Pick<
    WorktreeEvidence,
    "dirty" | "hiddenIndexChanges" | "operation" | "ignoredContent"
  >,
): Proof | null {
  if (facts.dirty) return live("uncommitted or untracked changes");
  if (facts.hiddenIndexChanges)
    return live("index flags hide possible changes from git status");
  if (facts.operation) return live(`in-progress ${facts.operation}`);
  if (facts.ignoredContent)
    return {
      state: "finding",
      reason: "ignored local content has no independent preservation proof",
    };
  return null;
}
function lifecycle(facts: WorktreeEvidence): Proof {
  if (facts.localOnlyCommits === null)
    return unknown("remote commit coverage could not be verified");
  if (!facts.requests?.length) return withoutRequest(facts.aheadOfBase);
  const merged = facts.requests.some((request) => request.state === "MERGED");
  if (!merged && facts.localOnlyCommits)
    return live("closed pull request has commits on no remote branch");
  if (merged && facts.localOnlyCommits)
    return mergedCoverage(facts.mergedHeadCovers);
  return candidate(
    merged
      ? "pull request merged; commits are retained on remote branches"
      : "pull request closed; every commit is retained on a remote branch",
  );
}
function withoutRequest(aheadOfBase: number | null): Proof {
  if (aheadOfBase === null)
    return unknown("base ancestry could not be verified");
  if (aheadOfBase > 0)
    return live("branch without a pull request is ahead of the base");
  return {
    state: "finding",
    reason: "worktree without a pull request has no registered session owner",
  };
}
function mergedCoverage(covered: boolean | null): Proof {
  if (covered === null)
    return unknown("merged pull request head ancestry could not be verified");
  return covered
    ? candidate("merged pull request head covers the worktree's commits")
    : live("commits are outside remote branches and merged pull request heads");
}
function candidate(reason: string): Proof {
  return {
    state: "dead",
    reason,
    reportOnly:
      "workspace opener does not hold shared session admission; report only",
  };
}
function holderGuard(facts: WorktreeEvidence, guardMs: number): Proof | null {
  if (facts.held === null)
    return unknown("process holders could not be enumerated");
  if (facts.held)
    return live(
      "a process has a working directory or open file inside the worktree",
    );
  if (facts.idleMs === null)
    return unknown("worktree idleness could not be verified");
  if (facts.idleMs < guardMs)
    return live("worktree idle guard has not elapsed");
  return null;
}
export function classifyWorktree(
  facts: WorktreeEvidence,
  guardMs: number,
): Proof {
  const veto = localWorktreeVeto(facts);
  if (veto) return veto;
  if (facts.requests === null)
    return unknown("pull request inventory could not be verified");
  if (facts.requests.some((request) => request.state === "OPEN"))
    return live("branch has an open pull request");
  return holderGuard(facts, guardMs) ?? lifecycle(facts);
}
