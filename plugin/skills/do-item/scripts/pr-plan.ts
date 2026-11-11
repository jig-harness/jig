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
 *     bun pr-plan.ts open [--issue <KEY>] [--issue-json <file>]
 *                         [--stack-on <branch>]
 *                         [--accept-oversize <reason>] [--json]
 *
 * `branch` prints the branch name the policy gives the issue (one line, or
 * `{ "branch": ... }` with `--json`). Run it before the first commit.
 *
 * `open` prints the plan for opening the current branch's pull request:
 * the base branch, the git remote to push to (`repository.remote`, else
 * `origin`), the `gh pr create` arguments the policy fixes (base,
 * draft or Ready, labels), the commands to run after it (linking a native
 * stack), the title convention (under a `pull_requests.title_pattern`, the
 * title with the issue key filled in), the template(s) to fill in, the line linking
 * the issue, the size against its budget (leaving out, and naming, the files
 * in `UNCOUNTED` such as the audit record), and warnings. `--stack-on` asks to base the pull request on
 * another open pull request's head branch instead of the trunk; the policy
 * decides whether that is allowed. Run it after the validation plan passes,
 * before `gh pr create`.
 *
 * `--issue-json` is the issue as do-item's Step 1 wrote it: its `labels`
 * are matched, in any case, against `pull_requests.labels_from_issue` and
 * `pull_requests.reviewers_from_issue`, and the touched change areas' `pr`
 * blocks add theirs, so the plan adds those labels and requests those
 * reviewers (`--reviewer`). Each such label must exist in the repository.
 *
 * Exit codes:
 *   0  the plan (or branch name) is printed
 *   2  usage error
 *   3  the policy refuses this pull request; stderr says why and what to do
 *      (stack on nothing, wait for the predecessor, split the change, or
 *      state why it cannot be split with --accept-oversize)
 *   1  the policy or a repository fact could not be read
 */

import { parsePostMerge } from "./lib/post-merge.ts";
import { readFileSync } from "node:fs";
import {
  consumerRoot,
  readConfig,
  remoteName,
} from "../../../shared/consumer.ts";
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
  type TitleFormat,
  walkChain,
} from "../../drive-pr/scripts/lib/pr-policy.ts";
import { ghCall, git } from "../../drive-pr/scripts/lib/proc.ts";
import { uniqueLogins } from "../../../shared/forge-logins.ts";
import { renderTitle } from "../../../shared/title-pattern.ts";
import { JigError } from "../../../shared/errors.ts";
import { isRecord } from "../../../shared/guards.ts";
import { parseArgs, runEntry } from "./lib/cli.ts";
import { prDiffContext, type Signal } from "./lib/pr-diff-context.ts";
import { trackerConfigFrom } from "./lib/tracker/config.ts";
import {
  ANY_TEAM_KEY,
  type IssueKeys,
  issueKeysOf,
} from "./lib/tracker/keys.ts";

/** Stands for the URL `gh pr create` prints for the new pull request. */
const PR_PLACEHOLDER = "<PR URL>";

const USAGE = [
  "usage: pr-plan.ts branch --issue <KEY> --title <issue title> [--json]",
  "       pr-plan.ts open [--issue <KEY>] [--issue-json <file>] [--stack-on <branch>] [--accept-oversize <reason>] [--json]",
].join("\n");

/**
 * The issue `--issue` names, in canonical form, and the segment a branch
 * name carries for it; `null` when it names no issue. The configured
 * tracker's key shape reads it (any case, and for GitHub a bare number or
 * the issue's web address too); with no team configured, any team's key
 * as given.
 */
export function readIssueArg(
  input: string,
  keys: IssueKeys | null,
): { key: string; branchKey: string } | null {
  if (keys === null)
    return ANY_TEAM_KEY.test(input) ? { key: input, branchKey: input } : null;
  const key = keys.normalize(input);
  return key === null ? null : { key, branchKey: keys.toBranch(key) };
}

/** A policy refusal: exit 3 with these lines on stderr. */
class Refusal extends Error {
  readonly lines: string[];
  constructor(...lines: string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}

export interface OpenPlan {
  /** The git remote the branch is pushed to: `repository.remote`, else `origin`. */
  remote: string;
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
  title: {
    format: TitleFormat;
    source: string;
    /** Under `pattern`: the pull-request title with the issue key filled in and `<summary>` left for the title. */
    pattern: string | null;
  };
  body: { templates: string[]; issueLink: string | null };
  size: {
    changedLines: number;
    budget: number | null;
    over: boolean;
    acceptedReason: string | null;
    /** Files changed but not counted in `changedLines` (`UNCOUNTED`). */
    uncounted: Uncounted[];
  };
  codeowners: string | null;
  /** The labels and reviewers the issue's labels and the touched areas add, each with where it came from. */
  signals: { labels: Signal[]; reviewers: Signal[] };
  warnings: string[];
}

/**
 * The labels and reviewers the issue's labels map to under
 * `pull_requests.labels_from_issue` and `pull_requests.reviewers_from_issue`,
 * matched in any case, in the issue's label order.
 */
export function issueSignals(
  policy: Pick<PrPolicy, "labelsFromIssue" | "reviewersFromIssue">,
  issueLabels: readonly string[],
): { labels: Signal[]; reviewers: Signal[] } {
  const labels: Signal[] = [];
  const reviewers: Signal[] = [];
  for (const label of issueLabels) {
    const key = label.toLowerCase();
    const from = `issue label ${label}`;
    const mapped = policy.labelsFromIssue.get(key);
    if (mapped !== undefined) labels.push({ value: mapped, from });
    for (const value of policy.reviewersFromIssue.get(key) ?? [])
      reviewers.push({ value, from });
  }
  return { labels, reviewers };
}

/** `signals` without a value seen before (labels and logins in any case), keeping the first. */
export function firstOfEach(signals: readonly Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((s) => {
    const k = s.value.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The repository's label names, lowercased, or why they cannot be read. */
async function readRepoLabels(
  root: string,
): Promise<Set<string> | { unreadable: string }> {
  const r = await ghCall(
    ["label", "list", "--limit", "1000", "--json", "name"],
    { cwd: root, stderr: "pipe" },
  );
  if (r.code !== 0)
    return { unreadable: r.stderrTail.trim() || `gh exited ${r.code}` };
  try {
    const list: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(list)) return { unreadable: "not a label listing" };
    return new Set(
      list.flatMap((l) =>
        isRecord(l) && typeof l.name === "string" ? [l.name.toLowerCase()] : [],
      ),
    );
  } catch (e) {
    return { unreadable: errorText(e) };
  }
}

/** The mapped labels the repository does not have, each with where it came from. */
export function missingLabels(
  signals: readonly Signal[],
  existing: ReadonlySet<string>,
): Signal[] {
  return signals.filter((s) => !existing.has(s.value.toLowerCase()));
}

/**
 * Files whose changed lines the size budget does not count, and why: the
 * audit record (`/jig:audit`) is rewritten whole by every audit, so counting
 * it would put any pull request that commits it over a budget its own change
 * fits.
 */
export const UNCOUNTED: ReadonlyMap<string, string> = new Map([
  [".config/jig-audit.yaml", "the audit record, rewritten by every audit"],
]);

/** A file left out of the size, with its changed lines and why. */
export interface Uncounted {
  path: string;
  lines: number;
  why: string;
}

/**
 * Changed lines (added plus deleted, binary files ignored) of `git diff
 * --numstat`, and the files in `UNCOUNTED` left out of that total.
 */
export function measureChange(numstat: string): {
  changedLines: number;
  uncounted: Uncounted[];
} {
  let changedLines = 0;
  const uncounted: Uncounted[] = [];
  for (const line of numstat.split("\n")) {
    const [added, deleted, path] = line.split("\t");
    if (added === undefined || deleted === undefined) continue;
    const lines =
      (/^\d+$/.test(added) ? Number(added) : 0) +
      (/^\d+$/.test(deleted) ? Number(deleted) : 0);
    const why = path === undefined ? undefined : UNCOUNTED.get(path);
    if (path !== undefined && why !== undefined)
      uncounted.push({ path, lines, why });
    else changedLines += lines;
  }
  return { changedLines, uncounted };
}

/** Changed lines between `baseRef` and HEAD, as `measureChange` counts them. */
export function countChangedLines(numstat: string): number {
  return measureChange(numstat).changedLines;
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

/**
 * The labels and reviewers the issue's labels and the touched areas add:
 * the labels the pull request opens with (the policy's and the areas'
 * tracker labels first) and the reviewers to request. A mapped label the
 * repository does not have stops planning; one whose existence cannot be
 * read is a warning.
 */
async function planSignals(
  root: string,
  policy: PrPolicy,
  issueLabels: string[] | null,
  context: { labels: string[]; areaLabels: Signal[]; areaReviewers: Signal[] },
  warnings: string[],
): Promise<{
  signals: OpenPlan["signals"];
  labels: string[];
  reviewers: string[];
}> {
  const fromIssue = issueSignals(policy, issueLabels ?? []);
  if (
    issueLabels === null &&
    (policy.labelsFromIssue.size > 0 || policy.reviewersFromIssue.size > 0)
  )
    warnings.push(
      "pull_requests.labels_from_issue or reviewers_from_issue is set, but the issue's labels were not read: pass --issue-json <the issue JSON> so the plan adds what they map to",
    );
  const signals = {
    labels: firstOfEach([...fromIssue.labels, ...context.areaLabels]),
    reviewers: firstOfEach([...fromIssue.reviewers, ...context.areaReviewers]),
  };
  if (signals.labels.length > 0)
    await checkMappedLabels(root, signals.labels, warnings);
  const labels = [...context.labels];
  for (const { value } of signals.labels)
    if (!labels.some((l) => l.toLowerCase() === value.toLowerCase()))
      labels.push(value);
  const reviewers = uniqueLogins(signals.reviewers.map((r) => r.value));
  return { signals, labels, reviewers };
}

/**
 * Stop on a mapped label the repository does not have, since `gh pr create`
 * would fail on it; warn when the repository's labels cannot be read.
 */
async function checkMappedLabels(
  root: string,
  mapped: readonly Signal[],
  warnings: string[],
): Promise<void> {
  const existing = await readRepoLabels(root);
  if ("unreadable" in existing) {
    warnings.push(
      `could not read the repository's labels (${existing.unreadable}): whether ${mapped.map((l) => l.value).join(", ")} exist is unchecked`,
    );
    return;
  }
  const missing = missingLabels(mapped, existing);
  if (missing.length > 0)
    throw new JigError(
      "pr-label-missing",
      `${missing.map((m) => `${m.value} (from ${m.from})`).join(", ")} does not exist in the repository; create it (gh label create <name>) or change pull_requests.labels_from_issue or the area's pr.labels`,
    );
}

/** Reviewers requested on a draft hear of it only once it is marked Ready. */
function draftReviewersWarning(
  policy: PrPolicy,
  reviewers: readonly string[],
  warnings: string[],
): void {
  if (reviewers.length > 0)
    warnings.push(
      `the reviewers requested on a draft are not notified until it is marked Ready (pull_requests.mark_ready: ${policy.markReady})`,
    );
}

/** How the pull request opens: draft or not, and the `gh pr create` arguments for its base, labels and reviewers. */
async function planOpening(
  opts: {
    root: string;
    policy: PrPolicy;
    base: string;
    issueLabels: string[] | null;
  },
  context: Awaited<ReturnType<typeof prDiffContext>>,
  warnings: string[],
) {
  const { root, policy, base } = opts;
  const openAs = resolveOpenAs(policy, reviewsDrafts());
  const { signals, labels, reviewers } = await planSignals(
    root,
    policy,
    opts.issueLabels,
    context,
    warnings,
  );
  const createArgs = ["--base", base];
  if (openAs.value === "draft") createArgs.push("--draft");
  createArgs.push(
    ...labels.flatMap((label) => ["--label", label]),
    ...reviewers.flatMap((reviewer) => ["--reviewer", reviewer]),
  );
  if (openAs.value === "draft")
    draftReviewersWarning(policy, reviewers, warnings);
  return { openAs, signals, labels, createArgs };
}

async function buildOpenPlan(opts: {
  root: string;
  policy: PrPolicy;
  issue: string | null;
  stackOn: string | null;
  acceptOversize: string | null;
  /** The issue's labels from `--issue-json`; `null` when it was not given. */
  issueLabels: string[] | null;
}): Promise<OpenPlan> {
  const { root, policy, issue, stackOn } = opts;
  const warnings: string[] = [];
  const remote = remoteName(root);
  const trunk = await baseBranch(root);
  if (trunk === null)
    throw new Error(
      `the integration branch is unknown: set repository.base_branch in .config/jig.yaml, or give this clone a ${remote}/HEAD (git remote set-head ${remote} --auto)`,
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
  const baseRef = `${remote}/${base}`;
  if (!(await revParses(root, baseRef)))
    throw new Error(
      `${baseRef} is not available locally; run git fetch ${shellQuote(remote)} ${shellQuote(base)}`,
    );
  const numstat = await git(
    ["-C", root, "diff", "--numstat", `${baseRef}...HEAD`],
    {
      stderr: "ignore",
    },
  );
  if (numstat.code !== 0)
    throw new Error(`git diff --numstat ${baseRef}...HEAD failed`);
  const { changedLines, uncounted } = measureChange(numstat.stdout);
  const over = policy.sizeBudget !== null && changedLines > policy.sizeBudget;
  if (over && (opts.acceptOversize ?? "").trim() === "")
    throw new Refusal(
      `refused: this change is ${changedLines} changed lines against ${baseRef}${uncountedNote(uncounted)}, over pull_requests.size_budget (${policy.sizeBudget}).`,
      policy.stacking === "none"
        ? "Split it into pull requests that each fit and land one after another, or, if it cannot be split, re-run with --accept-oversize <reason> and put that reason in the pull request body."
        : `Split it into a stack (pull_requests.stacking is ${policy.stacking}; re-run with --stack-on for each upper layer), or, if it cannot be split, re-run with --accept-oversize <reason> and put that reason in the pull request body.`,
    );

  // --- Opening ------------------------------------------------------------
  const context = await prDiffContext(root, baseRef, policy.labels);
  warnings.push(...context.warnings);
  const { openAs, signals, labels, createArgs } = await planOpening(
    { root, policy, base, issueLabels: opts.issueLabels },
    context,
    warnings,
  );

  const title = await detectTitleFormat(root, policy, `${remote}/${trunk}`);
  if (labels.length > 0)
    warnings.push(
      `gh pr create fails when a label does not exist in the repository; the labels are ${labels.join(", ")}`,
    );

  return {
    remote,
    base,
    trunk,
    stack: { mode: policy.stacking, on, depth, maxDepth: policy.maxStackDepth },
    createArgs,
    afterCreate,
    openAs,
    title: titlePlan(policy, issue, title),
    body: {
      templates: findPrTemplates(root),
      issueLink: issue === null ? null : issueLinkLine(policy.issueLink, issue),
    },
    size: {
      changedLines,
      budget: policy.sizeBudget,
      over,
      acceptedReason: over ? opts.acceptOversize : null,
      uncounted,
    },
    codeowners: findCodeowners(root),
    signals,
    warnings,
  };
}

/** The plan's title: the convention, and under a pattern the title with the key filled in. */
function titlePlan(
  policy: PrPolicy,
  issue: string | null,
  title: { value: TitleFormat; source: string },
): OpenPlan["title"] {
  return {
    format: title.value,
    source: title.source,
    pattern:
      policy.titlePattern === null
        ? null
        : renderTitle(policy.titlePattern, issue ?? "<KEY>", "<summary>"),
  };
}

/** What the size leaves out, as a clause after it: `, not counting <path> (<n> lines, <why>)`. */
function uncountedNote(uncounted: readonly Uncounted[]): string {
  if (uncounted.length === 0) return "";
  return `, not counting ${uncounted.map((u) => `${u.path} (${u.lines} lines, ${u.why})`).join(", ")}`;
}

/** One argument as POSIX shell text, so a printed command runs as planned. */
export function shellQuote(arg: string): string {
  if (arg === PR_PLACEHOLDER || /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Each added label and reviewer with where it came from. */
function signalLines(signals: OpenPlan["signals"]): string[] {
  return [
    ...signals.labels.map((l) => `label:       ${l.value} (${l.from})`),
    ...signals.reviewers.map((r) => `reviewer:    ${r.value} (${r.from})`),
  ];
}

/** The title convention as a person reads it: the form the title takes. */
function titleConvention(title: OpenPlan["title"]): string {
  if (title.pattern !== null) return title.pattern;
  return title.format === "conventional"
    ? "Conventional Commits, type(scope): summary"
    : "free-form";
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
  lines.push(`remote:      ${plan.remote}`);
  lines.push(`open as:     ${plan.openAs.value} (${plan.openAs.source})`);
  lines.push(
    `create:      gh pr create ${plan.createArgs.map(shellQuote).join(" ")} --title <title> --body-file <body>`,
  );
  for (const cmd of plan.afterCreate)
    lines.push(`then:        ${cmd.map(shellQuote).join(" ")}`);
  lines.push(
    `title:       ${titleConvention(plan.title)} (${plan.title.source})`,
  );
  lines.push(
    `template:    ${plan.body.templates.length === 0 ? "none" : plan.body.templates.join(", ")}`,
  );
  if (plan.body.issueLink !== null)
    lines.push(`issue link:  ${plan.body.issueLink}`);
  lines.push(
    `size:        ${plan.size.changedLines} changed lines${plan.size.budget === null ? "" : ` of ${plan.size.budget}`}${plan.size.acceptedReason === null ? "" : ` (over budget, accepted: ${plan.size.acceptedReason})`}${uncountedNote(plan.size.uncounted)}`,
  );
  lines.push(...signalLines(plan.signals));
  if (plan.codeowners !== null)
    lines.push(
      `codeowners:  ${plan.codeowners} (GitHub requests the reviewers)`,
    );
  for (const w of plan.warnings) lines.push(`warning:     ${w}`);
  return lines.join("\n");
}

/** Ends the command with `code`, `message` on stderr. */
class CliExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** The configured key shape; exit 1 when the tracker settings are invalid. */
function readKeys(): IssueKeys | null {
  try {
    return issueKeysOf(trackerConfigFrom(readConfig()));
  } catch (e) {
    throw new CliExit(1, `ERROR: ${errorText(e)}`);
  }
}

/**
 * The pull-request policy; exit 1 when it is invalid, or when
 * `do_item.post_merge_state` needs an issue link the policy does not set.
 */
function readPolicy(): PrPolicy {
  try {
    parsePostMerge(readConfig());
    return prPolicy();
  } catch (e) {
    throw new CliExit(1, `ERROR: ${errorText(e)}`);
  }
}

type IssueArg = NonNullable<ReturnType<typeof readIssueArg>>;

/** The issue `--issue` names, `null` without one; exit 2 when it names none. */
function issueOf(
  values: Map<string, string>,
  keys: IssueKeys | null,
): IssueArg | null {
  const input = values.get("issue");
  if (input === undefined) return null;
  const issue = readIssueArg(input, keys);
  if (issue === null)
    throw new CliExit(
      2,
      `--issue must be an issue key such as ${keys?.example ?? "ENG-123"} (got ${input})\n${USAGE}`,
    );
  return issue;
}

/** `branch`: print the branch name the policy gives the issue. */
async function branchCommand(
  values: Map<string, string>,
  issue: IssueArg | null,
  policy: PrPolicy,
  json: boolean,
): Promise<number> {
  const title = values.get("title");
  if (issue === null || title === undefined || title.trim() === "")
    throw new CliExit(2, `branch needs --issue and --title\n${USAGE}`);
  for (const v of ["stack-on", "accept-oversize", "issue-json"])
    if (values.has(v))
      throw new CliExit(2, `--${v} applies to open, not branch\n${USAGE}`);
  const branch = renderBranchName(policy.branchName, issue.branchKey, title);
  const check = await git(["check-ref-format", "--branch", branch], {
    stderr: "ignore",
  });
  if (check.code !== 0)
    throw new CliExit(
      1,
      `ERROR: pull_requests.branch_name (${policy.branchName}) renders ${JSON.stringify(branch)}, which is not a valid branch name`,
    );
  console.log(json ? JSON.stringify({ branch }) : branch);
  return 0;
}

/**
 * The labels of the issue JSON `--issue-json` names; `null` without it.
 * Exit 2 when it cannot be read, is no issue, or is another issue than
 * `--issue` names.
 */
export function readIssueLabels(
  file: string | undefined,
  issue: string | null,
): string[] | null {
  if (file === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliExit(2, `--issue-json ${file}: ${errorText(e)}\n${USAGE}`);
  }
  return issueLabelsOf(data, file, issue);
}

/** The labels of a parsed issue JSON, checked as `readIssueLabels` says. */
function issueLabelsOf(
  data: unknown,
  file: string,
  issue: string | null,
): string[] {
  if (!isRecord(data))
    throw new CliExit(
      2,
      `--issue-json ${file}: not an issue (expected a JSON object)`,
    );
  const labels = data.labels ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string"))
    throw new CliExit(
      2,
      `--issue-json ${file}: \`labels\` must be an array of strings`,
    );
  if (issue !== null) {
    if (typeof data.identifier !== "string")
      throw new CliExit(
        2,
        `--issue-json ${file}: \`identifier\` must be the issue's key (${issue})`,
      );
    if (data.identifier !== issue)
      throw new CliExit(
        2,
        `--issue-json ${file} is ${data.identifier}, not ${issue}`,
      );
  }
  return labels as string[];
}

/** `open`: print the plan for opening the current branch's pull request. */
async function openCommand(
  values: Map<string, string>,
  issue: string | null,
  policy: PrPolicy,
  json: boolean,
): Promise<number> {
  if (values.has("title"))
    throw new CliExit(2, `--title applies to branch, not open\n${USAGE}`);
  const acceptOversize = values.get("accept-oversize") ?? null;
  const issueLabels = readIssueLabels(values.get("issue-json"), issue);
  if (acceptOversize !== null && acceptOversize.trim() === "")
    throw new CliExit(2, `--accept-oversize needs a reason\n${USAGE}`);
  let plan: OpenPlan;
  try {
    plan = await buildOpenPlan({
      root: consumerRoot(),
      policy,
      issue,
      stackOn: values.get("stack-on") ?? null,
      acceptOversize,
      issueLabels,
    });
  } catch (e) {
    if (e instanceof Refusal) throw new CliExit(3, e.lines.join("\n"));
    throw new CliExit(1, `ERROR: ${errorText(e)}`);
  }
  console.log(json ? JSON.stringify(plan, null, 2) : formatOpenPlan(plan));
  return 0;
}

async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    flags: ["json"],
    values: ["issue", "title", "issue-json", "stack-on", "accept-oversize"],
    usage: USAGE,
  });
  if (!parsed.ok) throw new CliExit(2, parsed.message);
  const { flags, values, positional } = parsed.args;
  const json = flags.has("json");
  const issue = issueOf(values, readKeys());
  const policy = readPolicy();
  if (positional === "branch")
    return branchCommand(values, issue, policy, json);
  if (positional === "open")
    return openCommand(values, issue?.key ?? null, policy, json);
  throw new CliExit(
    2,
    `unknown command ${JSON.stringify(positional)}\n${USAGE}`,
  );
}

async function main(): Promise<number> {
  try {
    return await run(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    console.error(e.message);
    return e.code;
  }
}

if (import.meta.main) runEntry(main);
