/** Confirm historical reviewer evidence independently of a drive ledger. */
import { ghRepoEnvFor } from "../../../../shared/gh-repo-env.ts";
import { OVERLAY_RELPATH } from "../../../../shared/config-layers.ts";
import { proveBaseMerge } from "./base-merge-proof.ts";
import { isGitSha } from "./cli.ts";
import type { ReadyRules } from "./merge-ready.ts";
import { git, gitIdentityEnv } from "./proc.ts";
import { checkRunsFor, type CheckRun } from "./status/commit-observations.ts";

export async function basePreservesReview(
  cwd: string,
  verified: string,
  head: string,
  base: string,
): Promise<boolean> {
  if (!(await proveBaseMerge(cwd, verified, head, base))) return false;
  const gitRead = (args: string[]) =>
    git(["--no-replace-objects", ...args], {
      cwd,
      env: gitIdentityEnv(),
      timeoutSec: 5,
    });
  const ancestor = await gitRead(["merge-base", "--all", verified, base]);
  const fork = ancestor.stdout.trim();
  if (ancestor.code !== 0 || !isGitSha(fork)) return false;
  // The live base may be ahead of the commit merged into the PR. Check
  // its policy as well as the two PR commits.
  const [policy, change] = await Promise.all([
    gitRead(["diff", "--quiet", fork, base, "--", OVERLAY_RELPATH]),
    gitRead(["diff", "--quiet", verified, head, "--", OVERLAY_RELPATH]),
  ]);
  return policy.code === 0 && change.code === 0;
}

function latestReviewerRuns(
  runs: CheckRun[],
  rules: ReadyRules,
): Map<string, CheckRun> | null {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    if (run.app !== rules.reviewerApp || !rules.reviewerCheck.test(run.name))
      continue;
    if (!Number.isSafeInteger(run.id) || run.id < 1) return null;
    if (run.id > (latest.get(run.name)?.id ?? 0)) latest.set(run.name, run);
  }
  return latest;
}

export async function witnessedReview(
  slug: string | null,
  hash: string,
  rules: ReadyRules,
): Promise<boolean> {
  if (!isGitSha(hash) || rules.reviewerApp === null) return false;
  const [owner, repo] = slug?.split("/") ?? ["{owner}", "{repo}"];
  if (owner === undefined || repo === undefined) return false;
  // The placeholders resolve from the checkout, as the facts read does: an
  // inherited GH_REPO never redirects the read to another repository.
  const runs = await checkRunsFor(
    owner,
    repo,
    hash,
    "observed",
    ghRepoEnvFor(slug),
  );
  if (runs === null) return false;
  const latest = latestReviewerRuns(runs, rules);
  if (latest === null) return false;
  return (
    latest.size > 0 &&
    [...latest.values()].every(
      (run) =>
        run.status === "completed" &&
        (run.conclusion === "success" || run.conclusion === "neutral"),
    )
  );
}

/** A caller without the Git objects or the review cannot reuse either. */
export async function confirmCarriedReview(
  checkout: string | null | undefined,
  slug: string | null,
  from: unknown,
  head: string,
  base: string | undefined,
  rules: ReadyRules,
): Promise<{ reviewCarriedFrom?: string; reviewCarriedUnavailable?: true }> {
  if (typeof from !== "string" || base === undefined) return {};
  if (checkout == null) return { reviewCarriedUnavailable: true };
  return (await basePreservesReview(checkout, from, head, base)) &&
    (await witnessedReview(slug, from, rules))
    ? { reviewCarriedFrom: from }
    : {};
}
