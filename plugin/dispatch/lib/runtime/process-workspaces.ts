/** Worktree opening and publication for the process runtime. */
import type { HolderPolicy } from "../../../shared/orca-workspace/holder.ts";
import { failed, ok } from "../../../shared/outcome.ts";
import {
  captureIdentity,
  type ProcessIdentity,
} from "../../../shared/liveness.ts";
import { openProcessWorktree } from "../../../shared/process-worktree.ts";
import {
  localContext,
  withLimit,
} from "../../../shared/orca-workspace/runner.ts";
import { supervisedHook } from "../../../shared/orca-workspace/supervised-hook.ts";
import { treeDrivers } from "../../../skills/drive-pr/scripts/lib/state/tree-drivers.ts";
import { currentIso } from "../../../shared/time.ts";
import type { LaunchRecord } from "../launches.ts";
import { stateDb } from "../state.ts";
import type { DetachedCheckout, RepoTarget } from "../types.ts";
import { resolvePullRequestHead } from "./orca-pr-head.ts";
import { detachedField } from "./port.ts";
import {
  marksIn,
  type ItemTarget,
  type NoticesTarget,
  type PullRequestTarget,
  type RuntimeReceipt,
} from "./port.ts";

type Target = ItemTarget | NoticesTarget | PullRequestTarget;

function reserve(
  repo: RepoTarget,
  target: Target,
  id: string,
  workspace: { id: string; path: string },
  identity: ProcessIdentity,
) {
  // Until the real launch is recorded, collection sees the tick which
  // reserved this checkout. If the tick declines the launch or dies, this
  // completed reservation protects the checkout until that process exits.
  const now = currentIso();
  const record: LaunchRecord = {
    version: 1,
    runtime: "process",
    id,
    token: "",
    action:
      "item" in target
        ? "pickup"
        : "notices" in target
          ? "steward"
          : target.purpose === "followup"
            ? "followup"
            : "rearm",
    repo: repo.slug,
    repoPath: repo.path,
    item: "item" in target ? target.item : null,
    pr: "pr" in target ? target.pr : null,
    account: "",
    vendor: "codex",
    configDir: "",
    wallBackoffMs: 0,
    facts: "worktree open reservation",
    createdAt: now,
    replaces: null,
    workspace,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  };
  try {
    stateDb()
      .query(
        `INSERT INTO process_worktree_completions (id, record, claim, exit)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(record),
        JSON.stringify({ ...identity, claimedAt: now }),
        JSON.stringify({ at: now, code: 0, signal: null }),
      );
    return ok(undefined);
  } catch (error) {
    return failed(
      "worktree-publication",
      "the worktree reservation could not be published",
      error,
    );
  }
}

export async function processOpen(
  repo: RepoTarget,
  target: Target,
  timeoutMs: number,
  holders?: HolderPolicy,
): Promise<RuntimeReceipt> {
  const launch = marksIn(target.dispatched.mark)[0]?.launch;
  if (launch == null)
    return { ok: false, detail: "a process worktree needs a launch record" };
  const branch =
    "pr" in target
      ? target.head
      : "item" in target
        ? target.branch
        : target.notices;
  const host = withLimit(
    localContext(() => undefined),
    timeoutMs,
  );
  const identity = await captureIdentity();
  if (!identity.ok) return { ok: false, detail: identity.failure.reason };
  const expected =
    "pr" in target && target.purpose !== "followup"
      ? await resolvePullRequestHead(host, repo.path, target.pr, branch)
      : null;
  if (expected !== null && !expected.ok)
    return { ok: false, detail: expected.failure.reason };
  let left: DetachedCheckout | undefined;
  const opened = await openProcessWorktree(
    {
      host,
      runHook: supervisedHook,
      drivers: treeDrivers,
      ...(holders === undefined ? {} : { holders }),
    },
    {
      repository: repo.path,
      branch,
      launch,
      ...(expected === null ? {} : { expectedHead: expected.value }),
      onDetached: (holder) => {
        left = holder;
      },
      reserve: (worktree) =>
        reserve(repo, target, launch, worktree, identity.value),
    },
    () => ok(undefined),
  );
  if (!opened.ok)
    return {
      ok: false,
      detail: opened.failure.reason,
      ...detachedField(left),
    };
  const { worktree, reattached, hookRan, detached } = opened.value;
  return {
    ok: true,
    workspace: {
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch,
    },
    detail: `${reattached ? "reattached" : "opened"} ${worktree.path}${hookRan ? ", create hook ran" : ""}`,
    ...detachedField(detached),
  };
}
