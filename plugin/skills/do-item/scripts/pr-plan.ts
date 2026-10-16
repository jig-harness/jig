#!/usr/bin/env bun
/**
 * Apply the repository's pull-request policy (`pull_requests` in
 * `.config/jig.yaml`, plus the facts derived from the
 * repository itself) to one pull request about to be opened, so the agent
 * opening it follows the repository's rules instead of improvising them.
 *
 * Type: Decision
 *
 * Usage:
 *     bun pr-plan.ts branch --issue <KEY> --title <issue title> [--json]
 *     bun pr-plan.ts open [--issue <KEY>] [--stack-on <branch>]
 *                         [--accept-oversize <reason>] [--json]
 *
 * `branch` prints the branch name the policy gives the issue (one line, or
 * `{ "branch": ... }` with `--json`). Run it before the first commit.
 *
 * `open` prints the plan for opening the current branch's pull request:
 * the base branch, the `gh pr create` arguments the policy fixes (base,
 * draft or Ready, labels), the commands to run after it (linking a native
 * stack), the title convention, the template(s) to fill in, the line linking
 * the issue, the size against its budget, and warnings. `--stack-on` asks to base the pull request on
 * another open pull request's head branch instead of the trunk; the policy
 * decides whether that is allowed. Run it after the validation plan passes,
 * before `gh pr create`.
 *
 * Exit codes:
 *   0  the plan (or branch name) is printed
 *   2  usage error
 *   3  the policy refuses this pull request; stderr says why and what to do
 *      (stack on nothing, wait for the predecessor, split the change, or
 *      state why it cannot be split with --accept-oversize)
 *   1  the policy or a repository fact could not be read
 */

import { consumerRoot } from "../../../shared/consumer.ts";
import {
  baseBranch,
  reviewsDrafts,
} from "../../drive-pr/scripts/lib/overlay.ts";
import {
  detectTitleFormat,
  findCodeowners,
  findPrTemplates,
  issueLinkLine,
  listNativeStacks,
  listOpenPulls,
  OPEN_PULLS_LIMIT,
  planNativeLink,
  type PrPolicy,
  prPolicy,
  readLinkEligibility,
  readRepoSettings,
  renderBranchName,
  resolveOpenAs,
  walkChain,
} from "../../drive-pr/scripts/lib/pr-policy.ts";
import { ghCall, git } from "../../drive-pr/scripts/lib/proc.ts";
import { parseArgs, runEntry } from "./lib/cli.ts";

/** Stands for the URL `gh pr create` prints for the new pull request. */
const PR_PLACEHOLDER = "<PR URL>";

const USAGE = [
  "usage: pr-plan.ts branch --issue <KEY> --title <issue title> [--json]",
  "       pr-plan.ts open [--issue <KEY>] [--stack-on <branch>] [--accept-oversize <reason>] [--json]",
].join("\n");

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** A policy refusal: exit 3 with these lines on stderr. */
class Refusal extends Error {
  readonly lines: string[];
  constructor(...lines: string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}

export interface OpenPlan {
  base: string;
  trunk: string;
  stack: {
    mode: PrPolicy["stacking"];
    on: { branch: string; pr: number } | null;
    /** Pull requests in the stack once this one opens, this one included. */
    depth: number;
    maxDepth: number | null;
  };
  createArgs: string[];
  /** Run after `gh pr create`, `<PR URL>` replaced by the URL it prints for the new pull request. */
  afterCreate: string[][];
  openAs: { value: "draft" | "ready"; source: string };
  title: { format: "conventional" | "free"; source: string };
  body: { templates: string[]; issueLink: string | null };
  size: {
    changedLines: number;
    budget: number | null;
    over: boolean;
    acceptedReason: string | null;
  };
  codeowners: string | null;
  warnings: string[];
}

/** Changed lines (added plus deleted, binary files ignored) between `baseRef` and HEAD. */
export function countChangedLines(numstat: string): number {
  let total = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (added === undefined || deleted === undefined) continue;
    if (/^\d+$/.test(added)) total += Number(added);
    if (/^\d+$/.test(deleted)) total += Number(deleted);
  }
  return total;
}

async function revParses(root: string, ref: string): Promise<boolean> {
  const r = await git(
    ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    {
      stderr: "ignore",
    },
  );
  return r.code === 0;
}

/**
 * Whether `refs/heads/<name>` exists: `null` when git cannot say (a timeout,
 * a broken repository), which is not proof of absence.
 */
async function localBranchExists(
  root: string,
  name: string,
): Promise<boolean | null> {
  const r = await git(
    ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${name}`],
    { stderr: "ignore" },
  );
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

async function ghStackInstalled(root: string): Promise<boolean> {
  const r = await ghCall(["stack", "--version"], {
    cwd: root,
    stderr: "ignore",
  });
  return r.code === 0;
}

async function buildOpenPlan(opts: {
  root: string;
  policy: PrPolicy;
  issue: string | null;
  stackOn: string | null;
  acceptOversize: string | null;
}): Promise<OpenPlan> {
  const { root, policy, issue, stackOn } = opts;
  const warnings: string[] = [];
  const trunk = await baseBranch(root);
  if (trunk === null)
    throw new Error(
      "the integration branch is unknown: set repository.base_branch in .config/jig.yaml, or give this clone an origin/HEAD (git remote set-head origin --auto)",
    );

  const settings = await readRepoSettings(root);
  if (settings === null)
    warnings.push(
      "could not read the repository's settings from GitHub; delete-branch-on-merge is unknown",
    );

  // --- Base and stack -----------------------------------------------------
  let base = trunk;
  let on: OpenPlan["stack"]["on"] = null;
  let depth = 1;
  const afterCreate: string[][] = [];
  if (stackOn !== null && stackOn !== trunk) {
    if (policy.stacking === "none")
      throw new Refusal(
        `refused: this repository does not stack pull requests (pull_requests.stacking is none), so the pull request cannot be based on ${stackOn}.`,
        `Either wait until the pull request for ${stackOn} merges and open this one against ${trunk}, or deliver both changes in one pull request.`,
      );
    const pulls = await listOpenPulls(root);
    if (pulls === null)
      throw new Error(
        `could not list every open pull request of the repository to check the stack (unreadable, or ${OPEN_PULLS_LIMIT} or more open)`,
      );
    const chain = walkChain(stackOn, trunk, pulls);
    if (!chain.ok)
      throw new Refusal(
        `refused: ${stackOn} does not lead to ${trunk} through open pull requests: ${chain.reason}.`,
        `Stack only on the head branch of an open pull request whose chain reaches ${trunk}; otherwise open this one against ${trunk}.`,
      );
    // The chain is a lower bound on the stack's depth, so the cap is checked
    // on it before the native stacks are read and again on the stack after.
    const checkDepth = () => {
      if (policy.maxStackDepth !== null && depth > policy.maxStackDepth)
        throw new Refusal(
          `refused: this pull request would be layer ${depth} of a stack, and pull_requests.max_stack_depth is ${policy.maxStackDepth}.`,
          policy.stacking === "native"
            ? `A native stack keeps its merged members, so its depth does not fall as layers merge. Fold this change into the top layer (#${chain.layers[0]}), or wait until the stack has merged and open this pull request against ${trunk}.`
            : `Wait until the bottom of the stack (#${chain.layers[chain.layers.length - 1]}) merges, or fold this change into the top layer (#${chain.layers[0]}).`,
        );
    };
    depth = chain.layers.length + 1;
    checkDepth();
    const predecessor = chain.layers[0] as number;
    base = stackOn;
    on = { branch: stackOn, pr: predecessor };
    if (policy.stacking === "native") {
      if (!(await ghStackInstalled(root)))
        throw new Refusal(
          "refused: pull_requests.stacking is native, which links stacks with the gh-stack extension, and it is not installed.",
          "Install it (gh extension install github/gh-stack) and re-run.",
        );
      const stacks = await listNativeStacks(root);
      if (stacks === null)
        throw new Error(
          "could not read the repository's native stacks from GitHub's Stacks API (stacked pull requests may not be enabled for this repository)",
        );
      const urls = new Map(pulls.map((p) => [p.number, p.url]));
      const link = planNativeLink(
        chain.layers,
        trunk,
        stacks,
        PR_PLACEHOLDER,
        (n) => {
          const url = urls.get(n);
          if (url === undefined)
            throw new Error(
              `#${n} has no URL in the open pull-request listing`,
            );
          return url;
        },
      );
      if (!link.ok)
        throw new Refusal(
          `refused: ${stackOn} cannot be extended as a native stack: ${link.reason}.`,
          link.remedy,
        );
      // gh-stack checks both of these only after the pull request exists,
      // which would leave it created but outside the stack.
      const shadowed =
        link.appendsTo === null
          ? false
          : await localBranchExists(root, String(link.appendsTo));
      if (shadowed === null)
        throw new Error(
          `could not read whether a local branch is named ${link.appendsTo}, which gh stack link would read instead of native stack #${link.appendsTo}`,
        );
      if (shadowed)
        throw new Refusal(
          `refused: a local branch is named ${link.appendsTo}, so gh stack link would read ${link.appendsTo} as that branch instead of native stack #${link.appendsTo}.`,
          `Rename the local branch (git branch -m ${link.appendsTo} <new name>), then re-run.`,
        );
      const ineligible = await readLinkEligibility(root, link.newlyLinked);
      if (ineligible === null)
        throw new Error(
          `could not read whether ${link.newlyLinked.map((n) => `#${n}`).join(", ")} can be added to a native stack (auto-merge, merge queue)`,
        );
      if (ineligible.size > 0)
        throw new Refusal(
          `refused: gh-stack will not add ${[...ineligible].map(([n, why]) => `#${n} (${why})`).join(", ")} to a native stack.`,
          `Turn off auto-merge on those pull requests (gh pr merge --disable-auto <number>) and wait for any queued one to merge, then re-run; otherwise open this pull request against ${trunk}.`,
        );
      afterCreate.push(["gh", "stack", "link", ...link.linkArgs]);
      // A native stack keeps its merged members, which the chain omits, so
      // its depth comes from the stack gh-stack will append to.
      depth = link.depth;
      checkDepth();
    } else {
      if (settings?.deleteBranchOnMerge === false)
        warnings.push(
          `the repository does not delete head branches on merge, so when #${predecessor} merges GitHub will not retarget this pull request to ${trunk}; retarget it by hand (gh pr edit <PR> --base ${trunk}) or turn on "Automatically delete head branches"`,
        );
      else if (settings?.deleteBranchOnMerge === null || settings === null)
        warnings.push(
          `could not read whether the repository deletes head branches on merge; if it does not, retarget this pull request to ${trunk} by hand once #${predecessor} merges`,
        );
    }
  }

  // --- Size ---------------------------------------------------------------
  const baseRef = `origin/${base}`;
  if (!(await revParses(root, baseRef)))
    throw new Error(
      `${baseRef} is not available locally; run git fetch origin ${base}`,
    );
  const numstat = await git(
    ["-C", root, "diff", "--numstat", `${baseRef}...HEAD`],
    {
      stderr: "ignore",
    },
  );
  if (numstat.code !== 0)
    throw new Error(`git diff --numstat ${baseRef}...HEAD failed`);
  const changedLines = countChangedLines(numstat.stdout);
  const over = policy.sizeBudget !== null && changedLines > policy.sizeBudget;
  if (over && (opts.acceptOversize ?? "").trim() === "")
    throw new Refusal(
      `refused: this change is ${changedLines} changed lines against ${baseRef}, over pull_requests.size_budget (${policy.sizeBudget}).`,
      policy.stacking === "none"
        ? "Split it into pull requests that each fit and land one after another, or, if it cannot be split, re-run with --accept-oversize <reason> and put that reason in the pull request body."
        : `Split it into a stack (pull_requests.stacking is ${policy.stacking}; re-run with --stack-on for each upper layer), or, if it cannot be split, re-run with --accept-oversize <reason> and put that reason in the pull request body.`,
    );

  // --- Opening ------------------------------------------------------------
  const openAs = resolveOpenAs(policy, reviewsDrafts());
  const createArgs = ["--base", base];
  if (openAs.value === "draft") createArgs.push("--draft");
  for (const label of policy.labels) createArgs.push("--label", label);

  const title = await detectTitleFormat(root, policy, `origin/${trunk}`);
  if (policy.labels.length > 0)
    warnings.push(
      `gh pr create fails when a label does not exist in the repository; the labels are ${policy.labels.join(", ")}`,
    );

  return {
    base,
    trunk,
    stack: { mode: policy.stacking, on, depth, maxDepth: policy.maxStackDepth },
    createArgs,
    afterCreate,
    openAs,
    title: { format: title.value, source: title.source },
    body: {
      templates: findPrTemplates(root),
      issueLink: issue === null ? null : issueLinkLine(policy.issueLink, issue),
    },
    size: {
      changedLines,
      budget: policy.sizeBudget,
      over,
      acceptedReason: over ? opts.acceptOversize : null,
    },
    codeowners: findCodeowners(root),
    warnings,
  };
}

/** One argument as POSIX shell text, so a printed command runs as planned. */
export function shellQuote(arg: string): string {
  if (arg === PR_PLACEHOLDER || /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The plan as the lines a person or agent reads. */
export function formatOpenPlan(plan: OpenPlan): string {
  const lines: string[] = [];
  const stack =
    plan.stack.on === null
      ? `not stacked (pull_requests.stacking: ${plan.stack.mode})`
      : `layer ${plan.stack.depth} of a ${plan.stack.mode} stack on ${plan.stack.on.branch} (#${plan.stack.on.pr})${plan.stack.maxDepth === null ? "" : `, at most ${plan.stack.maxDepth}`}`;
  lines.push(
    `base:        ${plan.base}${plan.base === plan.trunk ? "" : ` (lands on ${plan.trunk})`}`,
  );
  lines.push(`stack:       ${stack}`);
  lines.push(`open as:     ${plan.openAs.value} (${plan.openAs.source})`);
  lines.push(
    `create:      gh pr create ${plan.createArgs.map(shellQuote).join(" ")} --title <title> --body-file <body>`,
  );
  for (const cmd of plan.afterCreate)
    lines.push(`then:        ${cmd.map(shellQuote).join(" ")}`);
  lines.push(
    `title:       ${plan.title.format === "conventional" ? "Conventional Commits, type(scope): summary" : "free-form"} (${plan.title.source})`,
  );
  lines.push(
    `template:    ${plan.body.templates.length === 0 ? "none" : plan.body.templates.join(", ")}`,
  );
  if (plan.body.issueLink !== null)
    lines.push(`issue link:  ${plan.body.issueLink}`);
  lines.push(
    `size:        ${plan.size.changedLines} changed lines${plan.size.budget === null ? "" : ` of ${plan.size.budget}`}${plan.size.acceptedReason === null ? "" : ` (over budget, accepted: ${plan.size.acceptedReason})`}`,
  );
  if (plan.codeowners !== null)
    lines.push(
      `codeowners:  ${plan.codeowners} (GitHub requests the reviewers)`,
    );
  for (const w of plan.warnings) lines.push(`warning:     ${w}`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: ["json"],
    values: ["issue", "title", "stack-on", "accept-oversize"],
    usage: USAGE,
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { flags, values, positional } = parsed.args;
  const json = flags.has("json");
  const issue = values.get("issue") ?? null;
  if (issue !== null && !ISSUE_KEY.test(issue)) {
    console.error(
      `--issue must be an issue key such as ENG-123 (got ${issue})\n${USAGE}`,
    );
    return 2;
  }

  let policy: PrPolicy;
  try {
    policy = prPolicy();
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (positional === "branch") {
    const title = values.get("title");
    if (issue === null || title === undefined || title.trim() === "") {
      console.error(`branch needs --issue and --title\n${USAGE}`);
      return 2;
    }
    for (const v of ["stack-on", "accept-oversize"])
      if (values.has(v)) {
        console.error(`--${v} applies to open, not branch\n${USAGE}`);
        return 2;
      }
    const branch = renderBranchName(policy.branchName, issue, title);
    const check = await git(["check-ref-format", "--branch", branch], {
      stderr: "ignore",
    });
    if (check.code !== 0) {
      console.error(
        `ERROR: pull_requests.branch_name (${policy.branchName}) renders ${JSON.stringify(branch)}, which is not a valid branch name`,
      );
      return 1;
    }
    console.log(json ? JSON.stringify({ branch }) : branch);
    return 0;
  }

  if (positional === "open") {
    if (values.has("title")) {
      console.error(`--title applies to branch, not open\n${USAGE}`);
      return 2;
    }
    const acceptOversize = values.get("accept-oversize") ?? null;
    if (acceptOversize !== null && acceptOversize.trim() === "") {
      console.error(`--accept-oversize needs a reason\n${USAGE}`);
      return 2;
    }
    try {
      const plan = await buildOpenPlan({
        root: consumerRoot(),
        policy,
        issue,
        stackOn: values.get("stack-on") ?? null,
        acceptOversize,
      });
      console.log(json ? JSON.stringify(plan, null, 2) : formatOpenPlan(plan));
      return 0;
    } catch (e) {
      if (e instanceof Refusal) {
        for (const line of e.lines) console.error(line);
        return 3;
      }
      console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  console.error(`unknown command ${JSON.stringify(positional)}\n${USAGE}`);
  return 2;
}

if (import.meta.main) runEntry(main);
