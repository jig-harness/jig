/**
 * `finish-round.ts`'s commit-prefix step: before the CI hold and the push,
 * when the repository sets `pull_requests.commit_prefix`, run
 * `commit-prefix.ts` on the pull request's head branch so every commit the
 * round pushes starts with the issue key. A reword moves local HEAD, so the
 * step answers the head to use from then on: everything after it (the hold's
 * `--expect-head`, the push, `stamp-held`, the head-sync wait) records the
 * reworded commit, never the one it replaced.
 *
 * A pushed commit without the prefix is reported on stderr and the push goes
 * ahead: rewriting it needs a force-push a person decides on. Any other
 * failure of the check (the branch carries no key, a git operation is open,
 * an unreadable configuration, repository or pull request) refuses the push.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { prPolicy } from "./pr-policy.ts";
import { ghCall, git, helperTimeoutSeconds, run, tsArgv } from "./proc.ts";
import {
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./state/lease.ts";

const commitPrefixScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "commit-prefix.ts",
);

/** `commit-prefix.ts`'s exit when a pushed commit lacks the prefix. */
const PUSHED_WITHOUT_PREFIX_EXIT = 4;

export type PrefixStep =
  | { ok: true; head: string; reworded: boolean }
  | { ok: false; reason: string };

/** Whether the repository sets a commit prefix; an unreadable policy counts as set, so the check reports it. */
function prefixConfigured(): boolean {
  try {
    return prPolicy().commitPrefix !== null;
  } catch (err) {
    swallow(err, "commit-prefix.ts reports the unreadable policy itself");
    return true;
  }
}

/** The pull request's head branch, or why it cannot be read. */
async function headBranch(
  pr: string,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  // The projection `drive-status.ts` reads too, so one cached answer serves both.
  const r = await ghCall(
    ["pr", "view", pr, "--json", "state,baseRefName,headRefName,headRefOid"],
    { stderr: "pipe" },
  );
  let branch = "";
  try {
    const view: unknown = JSON.parse(r.stdout);
    if (isRecord(view) && typeof view.headRefName === "string")
      branch = view.headRefName.trim();
  } catch (err) {
    swallow(err, "an unreadable answer is reported below as no head branch");
  }
  if (r.code !== 0 || branch === "")
    return {
      ok: false,
      reason: `cannot read PR #${pr}'s head branch, whose name carries the key pull_requests.commit_prefix needs (gh exited ${r.code}${r.stderrTail.trim() === "" ? "" : `: ${r.stderrTail.trim()}`})`,
    };
  return { ok: true, branch };
}

/**
 * Put the prefix on every unpushed commit of the round, and answer the head
 * to push. `head` is local HEAD as read before the step; it is returned
 * unchanged when nothing needs the step.
 */
export async function applyCommitPrefix(
  pr: string,
  head: string,
  gitTimeoutSec: number,
): Promise<PrefixStep> {
  if (!prefixConfigured()) return { ok: true, head, reworded: false };
  const branch = await headBranch(pr);
  if (!branch.ok) return branch;
  // The rewrite moves the branch, so it runs under the tree-mutation fence
  // `guarded-push.ts` takes: a second session in a tree another live session
  // drives is refused before it recreates a commit.
  const fenceCtx = await resolveFenceContext("finish-round.ts commit-prefix");
  const lock =
    fenceCtx === null
      ? null
      : await assertTreeMutationAllowed(fenceCtx, pr, "finish-round.ts");
  try {
    return await prefixUnderFence(pr, head, branch.branch, gitTimeoutSec);
  } finally {
    lock?.release();
    lock?.dispose();
  }
}

async function prefixUnderFence(
  pr: string,
  head: string,
  branch: string,
  gitTimeoutSec: number,
): Promise<PrefixStep> {
  const r = await run(
    tsArgv(commitPrefixScript, ["--branch", branch, "--expect-head", head]),
    { stderr: "pipe", timeoutSec: helperTimeoutSeconds() },
  );
  if (r.code !== 0 && r.code !== PUSHED_WITHOUT_PREFIX_EXIT)
    return {
      ok: false,
      reason: `commit-prefix.ts exited ${r.code}: ${(r.stderrTail.trim() || r.stdout.trim()).split("\n")[0] ?? ""} — fix what it names, then re-run`,
    };
  if (r.code === PUSHED_WITHOUT_PREFIX_EXIT)
    console.error(
      `finish-round.ts: a commit already on PR #${pr} lacks pull_requests.commit_prefix; pushing anyway, since rewording it needs a force-push a person decides on:\n${r.stdout.trimEnd()}`,
    );
  const after = await git(["rev-parse", "HEAD"], {
    stderr: "pipe",
    timeoutSec: gitTimeoutSec,
  });
  const now = after.stdout.trim();
  if (after.code !== 0 || now === "")
    return {
      ok: false,
      reason: `cannot read local HEAD after commit-prefix.ts (git exited ${after.code}) — re-run against a settled tree`,
    };
  if (now !== head) {
    // A reword keeps the tree of the head it started from: any other tree is
    // a commit this round never validated.
    const trees = await git(["rev-parse", `${head}^{tree}`, `${now}^{tree}`], {
      stderr: "pipe",
      timeoutSec: gitTimeoutSec,
    });
    const [was, is] = trees.stdout.trim().split("\n");
    if (trees.code !== 0 || was === undefined || was !== is)
      return {
        ok: false,
        reason: `local HEAD moved to ${now.slice(0, 12)} during commit-prefix.ts and its tree is not the validated ${head.slice(0, 12)}'s — re-run against a settled tree`,
      };
  }
  return { ok: true, head: now, reworded: now !== head };
}
