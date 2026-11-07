#!/usr/bin/env bun
import { definedFields } from "../../../shared/defined-fields.ts";
/**
 * Pin the Refocus intent chain to a PR — once per PR, at drive arm.
 *
 * The writer emits an immutable pickup token. Supply it for the first capture,
 * even if another pickup has since overwritten the item alias or session copy.
 * The library verifies PR ownership; without a token it only keeps existing pins.
 *
 * Usage: capture-intent-chain.ts [PR] [--pickup <token>] [--refresh]
 *   With PR omitted, resolves the current branch's PR.
 *   --refresh   overwrite an existing pin (a deliberate act: see the header
 *               above for why re-arming does not do it on its own).
 *
 * Exit codes:
 *   0  a pin now exists for this PR: `captured` or `kept`
 *   3  nothing was pinned, on purpose — the verification refused. Not a
 *      drive failure: the round reports a missing chain. STDERR says which
 *      check refused.
 *   1  the PR or the worktree could not be read
 *   2  usage error, or no PR could be resolved from the current branch
 *
 * STDOUT is one JSON line on every outcome that reaches the capture logic —
 * `{ pr, kind: captured | kept | skipped, ... }` — so `drive.ts` can log it.
 * A usage or read failure prints to stderr only.
 * Best-effort by contract: the driver never stops because a pin was refused.
 */

import { fail, isDigits, runMain } from "./lib/cli.ts";
import { drivenBranchName } from "./lib/driven-branch.ts";
import { captureIntentChain } from "./lib/intent-chain-capture.ts";
import {
  ghCall,
  ghRepoEnv,
  git,
  gitIdentityEnv,
  resolvePr,
} from "./lib/proc.ts";
import { intentChainRoot } from "./lib/state/handoff.ts";

const USAGE =
  "usage: capture-intent-chain.ts [PR] [--pickup <token>] [--refresh]";

async function main(): Promise<number> {
  let pr = "";
  let refresh = false;
  let pickupId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--pickup") {
      if (pickupId !== undefined || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ""))
        fail(2, "--pickup requires one immutable pickup token", USAGE);
      pickupId = args[++i];
    } else if (arg === "--refresh") refresh = true;
    else if (arg.startsWith("-")) fail(2, `unknown flag: ${arg}`, USAGE);
    else if (pr !== "") fail(2, `unexpected extra argument: ${arg}`, USAGE);
    else pr = arg;
  }
  // ONE verified worktree for every lookup below — the PR, its branch check and
  // the chain root the pin is written under. `intentChainRoot()` already
  // anchors to `$DRIVE_PR_WORKTREE`; resolving the PR and the branch from
  // `process.cwd()` instead would let a pass that `cd`'d into another checkout
  // on the same branch name verify THAT checkout's PR and then copy the driven
  // tree's chain into the pin. Binding `gh` here also keeps an inherited
  // GH_REPO from outranking local discovery.
  const cwd = process.env.DRIVE_PR_WORKTREE || process.cwd();
  if (pr === "") pr = await resolvePr("", cwd);
  if (!isDigits(pr)) fail(2, `'${pr}' is not a PR number`, USAGE);

  const view = await ghCall(
    ["pr", "view", pr, "--json", "state,headRefName,title,body"],
    { stderr: "ignore", cwd, env: ghRepoEnv() },
  );
  if (view.code !== 0) fail(1, `cannot read PR #${pr}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(view.stdout) as Record<string, unknown>;
  } catch {
    return fail(1, `the PR #${pr} response was not JSON`);
  }
  const str = (k: string): string =>
    typeof parsed?.[k] === "string" ? (parsed[k] as string) : "";

  // Scrubbed git env: an inherited GIT_DIR (hook-launched pass) outranks `cwd`.
  // A detached tree an attach prepared drives the branch its record names.
  const branch = await drivenBranchName(git, cwd, {
    timeoutSec: 10,
    env: gitIdentityEnv(),
  });
  if (branch === null) fail(1, "cannot read the checked-out branch");

  const result = captureIntentChain({
    pr,
    state: str("state"),
    headRefName: str("headRefName"),
    title: str("title"),
    body: str("body"),
    checkedOutBranch: branch,
    contextDir: await intentChainRoot(),
    refresh,
    ...definedFields({ pickupId }),
  });
  console.log(JSON.stringify({ pr, ...result }));
  if (result.kind === "skipped") {
    console.error(
      `capture-intent-chain: PR #${pr} not pinned — ${result.reason}`,
    );
    return 3;
  }
  return 0;
}

runMain("capture-intent-chain", main);
