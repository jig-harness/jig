#!/usr/bin/env bun
/**
 * Check, before a push, that every commit of the current branch starts with
 * the repository's commit prefix (`pull_requests.commit_prefix`, such as
 * `{key}: `), rendered for the issue key the branch name carries under
 * `pull_requests.branch_name`. Some organisations refuse, by ruleset, any
 * commit on a protected branch whose message lacks a tracker key, so one
 * commit without it can get the merge refused.
 *
 * Type: Gate
 *
 * Usage:
 *     bun commit-prefix.ts [--branch <name>] [--check] [--json]
 *
 * The branch's own commits are those reachable from HEAD and from no
 * remote-tracking branch of `repository.remote` other than its own: the
 * base, a stacked predecessor and a release line are left out whatever the
 * pull request's base. Of those, a commit the remote's branches do not hold
 * yet is unpushed. An unpushed commit without the prefix is reworded: it and
 * the unpushed commits above it are re-created with the same tree, parents
 * and author and the prefix put before the message, merge commits included,
 * and the branch moved to the new head; the working tree and the index are
 * not touched, and no hook runs. A rewritten commit loses a signature it
 * had. A pushed commit without the prefix is reported, never rewritten: that
 * would need a force-push a person decides on.
 *
 * `--branch` names the branch whose key is read, for a detached HEAD (a
 * drive's working tree); the commits checked are still HEAD's. `--check`
 * reports without rewording.
 *
 * Exit codes:
 *   0  every commit of the branch starts with the prefix (any unpushed one
 *      lacking it was reworded), or no prefix is configured
 *   1  the configuration or git could not be read, or a reword failed
 *   2  usage error, or a detached HEAD without --branch
 *   3  cannot check: the branch name carries no issue key, the tracker's key
 *      shape is unknown, or a merge, rebase, cherry-pick or revert is in
 *      progress
 *   4  a pushed commit lacks the prefix (the unpushed ones were reworded)
 *   5  --check only: an unpushed commit lacks the prefix, which a run
 *      without --check rewords
 */

import { ExitError, runMain } from "../../../shared/cli.ts";
import { consumerRoot, remoteName } from "../../../shared/consumer.ts";
import { JigError } from "../../../shared/errors.ts";
import { parseArgs } from "../../do-item/scripts/lib/cli.ts";
import {
  issueKeysOrNull,
  keyFromBranch,
} from "../../do-item/scripts/lib/tracker/keys.ts";
import { renderCommitPrefix } from "./lib/pr-conventions.ts";
import { type PrPolicy, prPolicy } from "./lib/pr-policy.ts";
import { git, unconcludedGitOpMarker } from "./lib/proc.ts";

const USAGE = "usage: commit-prefix.ts [--branch <name>] [--check] [--json]";

/** Deadline of each local git call, in seconds. */
const GIT_TIMEOUT = 60;

/** One commit of the branch: its id, parents, whether pushed, and its message. */
export interface BranchCommit {
  sha: string;
  parents: string[];
  pushed: boolean;
  message: string;
}

export interface PrefixReport {
  branch: string;
  key: string;
  prefix: string;
  /** Unpushed commits reworded: the old id, the new one and the subject. */
  reworded: Array<{ from: string; to: string; subject: string }>;
  /** Pushed commits without the prefix. */
  pushed: Array<{ sha: string; subject: string }>;
  /** `--check` only: unpushed commits without the prefix, left as they are. */
  unpushed: Array<{ sha: string; subject: string }>;
}

const subjectOf = (message: string) => message.split("\n")[0] ?? "";

async function gitOut(root: string, args: string[]): Promise<string> {
  const r = await git(["-C", root, ...args], {
    stderr: "pipe",
    timeoutSec: GIT_TIMEOUT,
  });
  if (r.code !== 0)
    throw new JigError(
      "git-failed",
      `git ${args.join(" ")} exited ${r.code}: ${r.stderrTail.trim()}`,
    );
  return r.stdout;
}

/**
 * The ref HEAD points to (`refs/heads/<name>`, or `<name>` with `short`),
 * or `null` for a detached HEAD.
 */
async function headRef(root: string, short: boolean): Promise<string | null> {
  const r = await git(
    [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      ...(short ? ["--short"] : []),
      "HEAD",
    ],
    { stderr: "pipe", timeoutSec: GIT_TIMEOUT },
  );
  if (r.code === 1) return null;
  if (r.code !== 0 || r.stdout.trim() === "")
    throw new JigError(
      "git-failed",
      `git symbolic-ref HEAD exited ${r.code}: ${r.stderrTail.trim()}`,
    );
  return r.stdout.trim();
}

/**
 * The branch's own commits, oldest first, parents before children: reachable
 * from HEAD and from no remote-tracking branch of `remote` but `branch`'s own.
 */
export async function branchCommits(
  root: string,
  remote: string,
  branch: string,
): Promise<BranchCommit[]> {
  const refs = (
    await gitOut(root, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/remotes/${remote}/`,
    ])
  )
    .split("\n")
    .filter(
      (r) =>
        r !== "" &&
        r !== `refs/remotes/${remote}/${branch}` &&
        r !== `refs/remotes/${remote}/HEAD`,
    );
  if (refs.length === 0)
    throw new JigError(
      "git-failed",
      `no remote-tracking branch of ${remote} but ${branch} is fetched, so the branch's own commits cannot be told from the base's history: fetch ${remote}'s base branch, then re-run`,
    );
  const own = await gitOut(root, [
    "rev-list",
    "--topo-order",
    "--reverse",
    "--parents",
    "HEAD",
    "--not",
    `--exclude=${remote}/${branch}`,
    `--remotes=${remote}`,
  ]);
  const unpushed = new Set(
    (await gitOut(root, ["rev-list", "HEAD", "--not", `--remotes=${remote}`]))
      .split("\n")
      .filter((l) => l !== ""),
  );
  const commits: BranchCommit[] = [];
  for (const line of own.split("\n")) {
    const [sha, ...parents] = line.split(" ").filter((w) => w !== "");
    if (sha === undefined) continue;
    const message = await gitOut(root, ["log", "-1", "--format=%B", sha]);
    commits.push({
      sha,
      parents,
      pushed: !unpushed.has(sha),
      message: message.replace(/\n+$/, ""),
    });
  }
  return commits;
}

/** Re-create `commit` with `parents` and `message`, keeping its tree and author. */
async function recreate(
  root: string,
  commit: BranchCommit,
  parents: string[],
  message: string,
): Promise<string> {
  const author = (
    await gitOut(root, [
      "log",
      "-1",
      "--format=%an%x00%ae%x00%ad",
      "--date=raw",
      commit.sha,
    ])
  ).replace(/\n$/, "");
  const [name = "", email = "", date = ""] = author.split("\0");
  const r = await git(
    [
      "-C",
      root,
      "commit-tree",
      `${commit.sha}^{tree}`,
      ...parents.flatMap((p) => ["-p", p]),
    ],
    {
      stdin: `${message}\n`,
      stderr: "pipe",
      timeoutSec: GIT_TIMEOUT,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
      },
    },
  );
  if (r.code !== 0)
    throw new JigError(
      "git-failed",
      `git commit-tree for ${commit.sha} exited ${r.code}: ${r.stderrTail.trim()}`,
    );
  return r.stdout.trim();
}

/** Where HEAD stood when the rewrite started: its commit and the ref it points to. */
interface HeadAt {
  sha: string;
  /** `refs/heads/<name>`, or `null` for a detached HEAD. */
  ref: string | null;
}

/**
 * Re-create every unpushed commit that lacks `prefix`, and those above it,
 * oldest first; answers the old-to-new map and what was reworded.
 */
async function rewrite(
  root: string,
  commits: readonly BranchCommit[],
  prefix: string,
): Promise<{
  moved: Map<string, string>;
  reworded: PrefixReport["reworded"];
}> {
  const moved = new Map<string, string>();
  const reworded: PrefixReport["reworded"] = [];
  for (const commit of commits) {
    if (commit.pushed) continue;
    const lacks = !commit.message.startsWith(prefix);
    const parents = commit.parents.map((p) => moved.get(p) ?? p);
    if (!lacks && parents.every((p, i) => p === commit.parents[i])) continue;
    const message = lacks ? `${prefix}${commit.message}` : commit.message;
    const to = await recreate(root, commit, parents, message);
    moved.set(commit.sha, to);
    if (lacks)
      reworded.push({ from: commit.sha, to, subject: subjectOf(message) });
  }
  return { moved, reworded };
}

/** Move HEAD (its branch, or a detached HEAD) from `at` to `newHead`, refusing when it moved meanwhile. */
async function moveHead(root: string, at: HeadAt, newHead: string) {
  if (
    (await headRef(root, false)) !== at.ref ||
    (await gitOut(root, ["rev-parse", "HEAD"])).trim() !== at.sha
  )
    throw new JigError(
      "git-failed",
      "HEAD or its branch changed while the commits were rewritten; nothing was moved: re-run",
    );
  await gitOut(root, [
    "update-ref",
    ...(at.ref === null ? ["--no-deref"] : []),
    "-m",
    "commit-prefix: put the issue key before unpushed commit messages",
    at.ref ?? "HEAD",
    newHead,
    at.sha,
  ]);
}

/**
 * Reword every unpushed commit that lacks `prefix`, re-creating the unpushed
 * commits above it, and move HEAD's branch (or a detached HEAD) to the new
 * head. Returns what was reworded.
 */
export async function rewordUnpushed(
  root: string,
  commits: readonly BranchCommit[],
  prefix: string,
): Promise<PrefixReport["reworded"]> {
  const at: HeadAt = {
    sha: (await gitOut(root, ["rev-parse", "HEAD"])).trim(),
    ref: await headRef(root, false),
  };
  if (commits.length > 0 && !commits.some((c) => c.sha === at.sha))
    throw new JigError(
      "git-failed",
      `HEAD moved to ${at.sha.slice(0, 12)} after the branch's commits were read; nothing was rewritten: re-run`,
    );
  const { moved, reworded } = await rewrite(root, commits, prefix);
  const newHead = moved.get(at.sha);
  if (newHead !== undefined) await moveHead(root, at, newHead);
  return reworded;
}

/** The branch whose key is read: `--branch`, else HEAD's; exit 2 on a detached HEAD. */
async function branchOf(root: string, explicit: string | undefined) {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const branch = await headRef(root, true);
  if (branch === null)
    return fail(
      2,
      `HEAD is detached: pass --branch <the pull request's head branch>\n${USAGE}`,
    );
  return branch;
}

function fail(code: number, message: string): never {
  console.error(message);
  throw new ExitError(code, message);
}

function readPolicy(): PrPolicy {
  try {
    return prPolicy();
  } catch (e) {
    return fail(1, `ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The report as lines for a person or an agent. */
export function formatReport(report: PrefixReport): string {
  const lines = [
    `prefix:    ${JSON.stringify(report.prefix)} (pull_requests.commit_prefix, ${report.key} from ${report.branch})`,
  ];
  for (const r of report.reworded)
    lines.push(
      `reworded:  ${r.from.slice(0, 12)} -> ${r.to.slice(0, 12)}  ${r.subject}`,
    );
  for (const p of report.unpushed)
    lines.push(
      `unpushed:  ${p.sha.slice(0, 12)}  ${p.subject} (lacks the prefix; run without --check to reword it)`,
    );
  for (const p of report.pushed)
    lines.push(
      `pushed:    ${p.sha.slice(0, 12)}  ${p.subject} (lacks the prefix and is already pushed: rewording it needs a force-push a person decides on, or the merge may be refused)`,
    );
  if (lines.length === 1)
    lines.push("every commit of the branch carries the prefix");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: ["check", "json"],
    values: ["branch"],
    usage: USAGE,
    noPositional: true,
  });
  if (!parsed.ok) return fail(2, parsed.message);
  const { flags, values } = parsed.args;
  const policy = readPolicy();
  if (policy.commitPrefix === null) {
    console.log(
      flags.has("json")
        ? JSON.stringify({ prefix: null })
        : "pull_requests.commit_prefix is not set: nothing to check",
    );
    return 0;
  }
  const root = consumerRoot();
  const branch = await branchOf(root, values.get("branch"));
  const keys = issueKeysOrNull();
  if (keys === null)
    return fail(
      3,
      "the tracker's key shape is unknown (set issue_tracker.team, or the tracker's settings), so the key the prefix needs cannot be read from the branch",
    );
  const key = keyFromBranch(branch, keys, policy.branchName);
  if (key === null)
    return fail(
      3,
      `the branch ${branch} carries no issue key under pull_requests.branch_name (${policy.branchName}), so pull_requests.commit_prefix cannot be rendered`,
    );
  const operation = await unconcludedGitOpMarker(GIT_TIMEOUT, { cwd: root });
  if (!operation.ok) return fail(1, `ERROR: ${operation.reason}`);
  if (operation.marker !== null)
    return fail(
      3,
      `a git operation is in progress (${operation.marker}): conclude or abort it, then re-run`,
    );
  const prefix = renderCommitPrefix(policy.commitPrefix, key);
  const remote = remoteName(root);
  const commits = await branchCommits(root, remote, branch);
  const lacking = commits.filter((c) => !c.message.startsWith(prefix));
  const listed = (pushed: boolean) =>
    lacking
      .filter((c) => c.pushed === pushed)
      .map((c) => ({ sha: c.sha, subject: subjectOf(c.message) }));
  const check = flags.has("check");
  const report: PrefixReport = {
    branch,
    key,
    prefix,
    reworded:
      check || !lacking.some((c) => !c.pushed)
        ? []
        : await rewordUnpushed(root, commits, prefix),
    pushed: listed(true),
    unpushed: check ? listed(false) : [],
  };
  console.log(
    flags.has("json") ? JSON.stringify(report, null, 2) : formatReport(report),
  );
  if (report.pushed.length > 0) return 4;
  return report.unpushed.length > 0 ? 5 : 0;
}

if (import.meta.main) runMain("commit-prefix", main);
