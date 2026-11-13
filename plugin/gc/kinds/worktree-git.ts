/** Bounded Git and forge observations; no checkout-provided commands run. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import { gcGit as git, gitEnvironment } from "../git.ts";
import type { WorktreeRequest } from "./worktree-evidence.ts";

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export async function ancestry(
  root: string,
  head: string,
  ancestor: string,
): Promise<boolean | null> {
  const result = await run(
    [
      "git",
      "--no-optional-locks",
      // A replacement ref would fabricate ancestry between unrelated commits.
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      "merge-base",
      "--is-ancestor",
      head,
      ancestor,
    ],
    { timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code === 0) return true;
  return result.code === 1 ? false : null;
}
function commitIds(output: string): Outcome<string[], "malformed"> {
  if (!output) return ok([]);
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\S+)\trefs\/heads\/.+$/.exec(line);
    if (!match || !COMMIT.test(match[1] ?? ""))
      return failed("malformed", "Malformed remote branch inventory");
    ids.push(match[1] as string);
  }
  return ok(ids);
}
/** The commits a remote's branches point at, read through its URL. */
async function remoteHeads(
  root: string,
  name: string,
): Promise<Outcome<string[]>> {
  const url = await git(root, ["remote", "get-url", name]);
  if (!url.ok) return url;
  const listed = await git(root, ["ls-remote", "--heads", "--", url.value]);
  if (!listed.ok) return listed;
  return commitIds(listed.value);
}
/** Whether one of `tips` contains `head`; null when some could not be told and none does. */
async function coveredByTip(
  root: string,
  head: string,
  tips: string[],
): Promise<boolean | null> {
  let unknown = false;
  for (const tip of tips) {
    const covered = await ancestry(root, head, tip);
    if (covered === true) return true;
    if (covered === null) unknown = true;
  }
  return unknown ? null : false;
}
export async function localOnlyCommits(
  root: string,
  head: string,
): Promise<Outcome<boolean | null>> {
  const remotes = await git(root, ["remote"]);
  if (!remotes.ok) return remotes;
  const names = remotes.value.split("\n").filter(Boolean);
  let unknown = false;
  for (const name of names) {
    const heads = await remoteHeads(root, name);
    if (!heads.ok) return heads;
    const covered = await coveredByTip(root, head, heads.value);
    if (covered === true) return ok(false);
    if (covered === null) unknown = true;
  }
  return ok(unknown ? null : true);
}
function forgeRepository(remote: string): Outcome<string, "unknown-forge"> {
  const ssh = /^(?:[^@/]+@)?([^:/]+):([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return ok(`${ssh[1]}/${ssh[2]}`);
  let url: URL;
  try {
    url = new URL(remote);
  } catch (error) {
    return failed(
      "unknown-forge",
      "Cannot derive a forge repository from the remote URL",
      error,
    );
  }
  const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(path))
    return failed(
      "unknown-forge",
      "Remote URL does not identify one forge repository",
    );
  return ok(`${url.host}/${path}`);
}
function requestSource(
  value: Record<string, unknown>,
): Outcome<string, "malformed"> {
  if (
    !isMapping(value.headRepository) ||
    !isMapping(value.headRepositoryOwner) ||
    typeof value.headRepository.name !== "string" ||
    !value.headRepository.name ||
    typeof value.headRepositoryOwner.login !== "string" ||
    !value.headRepositoryOwner.login
  )
    return failed(
      "malformed",
      "Pull request source repository could not be verified",
    );
  return ok(`${value.headRepositoryOwner.login}/${value.headRepository.name}`);
}
function request(
  value: unknown,
  source: string,
): Outcome<WorktreeRequest | null, "malformed"> {
  if (!isMapping(value))
    return failed("malformed", "Malformed pull request record");
  const from = requestSource(value);
  if (!from.ok) return from;
  if (from.value.toLowerCase() !== source.toLowerCase()) return ok(null);
  if (typeof value.headRefOid !== "string" || !COMMIT.test(value.headRefOid))
    return failed("malformed", "Malformed pull request head");
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(value.state)))
    return failed("malformed", "Malformed pull request state");
  const number = requestNumber(value.number);
  if (!number.ok) return number;
  return ok({
    state: value.state as WorktreeRequest["state"],
    head: value.headRefOid,
    ...(number.value === null ? {} : { number: number.value }),
  });
}
/** A pull request's number, null when the forge did not answer one. */
function requestNumber(value: unknown): Outcome<number | null, "malformed"> {
  if (value === undefined) return ok(null);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : failed("malformed", "Malformed pull request number");
}
/** The forge repository `remote` names, as `owner/name` under its host. */
async function remoteRepository(
  root: string,
  remote: string,
): Promise<Outcome<string>> {
  const url = await git(root, ["remote", "get-url", remote]);
  return url.ok ? forgeRepository(url.value) : url;
}
export async function requests(
  root: string,
  remote: string,
  branch: string,
): Promise<Outcome<WorktreeRequest[]>> {
  const repository = await remoteRepository(root, remote);
  if (!repository.ok) return repository;
  const result = await run(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repository.value,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      "number,state,headRefOid,headRepository,headRepositoryOwner",
    ],
    { cwd: root, timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code !== 0)
    return failed(
      "forge-unavailable",
      `Forge inventory unavailable: ${result.stderr}`,
    );
  const values: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(values) || values.length >= 200)
    return failed("incomplete", "Pull request inventory is incomplete");
  // --head matches branch names in forks too; only this remote is evidence.
  const source = repository.value.slice(repository.value.indexOf("/") + 1);
  const matched: WorktreeRequest[] = [];
  for (const value of values) {
    const one = request(value, source);
    if (!one.ok) return one;
    if (one.value) matched.push(one.value);
  }
  return ok(matched);
}
/**
 * The pull request numbered `pr` on `remote`'s repository, as `requests`
 * reports one: for a detached tree a drive attached, which has no branch to
 * list pull requests by (`shared/driven-tree.ts`).
 */
export async function requestByNumber(
  root: string,
  remote: string,
  pr: number,
): Promise<Outcome<WorktreeRequest[]>> {
  const repository = await remoteRepository(root, remote);
  if (!repository.ok) return repository;
  const result = await run(
    [
      "gh",
      "pr",
      "view",
      String(pr),
      "--repo",
      repository.value,
      "--json",
      "number,state,headRefOid,headRepository,headRepositoryOwner",
    ],
    { cwd: root, timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code !== 0)
    return failed(
      "forge-unavailable",
      `Forge inventory unavailable: ${result.stderr}`,
    );
  const matched = request(
    JSON.parse(result.stdout),
    repository.value.slice(repository.value.indexOf("/") + 1),
  );
  if (!matched.ok) return matched;
  return ok(matched.value ? [matched.value] : []);
}
/** How the forge refuses a commit it does not have (HTTP 422). */
const UNKNOWN_COMMIT = /No commit found for SHA[\s\S]*HTTP 422/;
/** The most pull requests one commit lookup reads; a full page is incomplete. */
const COMMIT_REQUESTS_PAGE = 100;
/** A REST pull request record's state, as `gh pr` names it. */
function commitRequestState(
  value: Record<string, unknown>,
): Outcome<WorktreeRequest["state"], "malformed"> {
  if (value.state !== "open" && value.state !== "closed")
    return failed("malformed", "Malformed pull request state");
  const merged = value.merged_at;
  if (merged !== null && typeof merged !== "string")
    return failed("malformed", "Malformed pull request merge time");
  if (value.state === "open") return ok("OPEN");
  return ok(merged ? "MERGED" : "CLOSED");
}
/**
 * One entry of the forge's pull requests for a commit, as `request` reads a
 * `gh pr` record: the REST form names its state in lower case and a merge by
 * `merged_at`. The endpoint is scoped to this repository, so a record from a
 * fork, or from one the forge no longer has, is still this repository's
 * pull request and counts.
 */
function commitRequest(value: unknown): Outcome<WorktreeRequest, "malformed"> {
  if (!isMapping(value) || !isMapping(value.head))
    return failed("malformed", "Malformed pull request record");
  return commitRequestFields(value, value.head);
}
/** The head, state and number of a REST pull request record. */
function commitRequestFields(
  value: Record<string, unknown>,
  head: Record<string, unknown>,
): Outcome<WorktreeRequest, "malformed"> {
  if (typeof head.sha !== "string" || !COMMIT.test(head.sha))
    return failed("malformed", "Malformed pull request head");
  const state = commitRequestState(value);
  if (!state.ok) return state;
  const number = requestNumber(value.number);
  if (!number.ok) return number;
  return number.value === null
    ? failed("malformed", "Malformed pull request number")
    : ok({ state: state.value, head: head.sha, number: number.value });
}
/**
 * The pull requests of `remote`'s repository whose commits include `commit`,
 * as `requests` reports a branch's: for a detached tree no drive record
 * describes, which has no branch to list pull requests by. The forge answers
 * the pull request that brought a commit into its default branch, else the
 * open and merged ones that carry it; every one it names is evidence.
 */
export async function requestsForCommit(
  root: string,
  remote: string,
  commit: string,
): Promise<Outcome<WorktreeRequest[]>> {
  if (!COMMIT.test(commit))
    return failed("malformed", "Malformed worktree commit");
  const repository = await remoteRepository(root, remote);
  if (!repository.ok) return repository;
  const host = repository.value.slice(0, repository.value.indexOf("/"));
  const source = repository.value.slice(host.length + 1);
  const result = await run(
    [
      "gh",
      "api",
      "--hostname",
      host,
      `repos/${source}/commits/${commit}/pulls?per_page=${COMMIT_REQUESTS_PAGE}`,
    ],
    { cwd: root, timeoutSec: 30, env: gitEnvironment() },
  );
  // A commit only this machine has is in no pull request.
  if (result.code !== 0 && UNKNOWN_COMMIT.test(result.stderr)) return ok([]);
  if (result.code !== 0)
    return failed(
      "forge-unavailable",
      `Forge inventory unavailable: ${result.stderr}`,
    );
  let values: unknown;
  try {
    values = JSON.parse(result.stdout);
  } catch (error) {
    return failed("malformed", "Malformed pull request inventory", error);
  }
  if (!Array.isArray(values) || values.length >= COMMIT_REQUESTS_PAGE)
    return failed("incomplete", "Pull request inventory is incomplete");
  const matched: WorktreeRequest[] = [];
  for (const value of values) {
    const one = commitRequest(value);
    if (!one.ok) return one;
    matched.push(one.value);
  }
  return ok(matched);
}
export async function processHolder(path: string): Promise<boolean | null> {
  const result = await run(["lsof", "-nP", "-F", "pfn", "+D", path], {
    timeoutSec: 30,
    env: gitEnvironment(),
  });
  if (result.stderr.trim()) return null;
  if (result.code === 0 && result.stdout.trim()) return true;
  return result.code === 1 && !result.stdout.trim() ? false : null;
}
/**
 * How long ago anything in the worktree, or its `HEAD` log, last changed.
 * The walk is bounded by `deadline`, checked per entry, and fails
 * `timed-out` once it passes.
 */
export function worktreeActivity(
  path: string,
  admin: string,
  deadline = Date.now() + 30_000,
): Outcome<number, "timed-out"> {
  let newest = 0;
  const late = () =>
    failed("timed-out", "Worktree activity scan exceeded its deadline");
  // Checked per entry: one flat directory can hold enough files to overrun.
  const walk = (dir: string): boolean => {
    if (Date.now() > deadline) return false;
    newest = Math.max(newest, lstatSync(dir).mtimeMs);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() > deadline) return false;
      const child = join(dir, entry.name);
      newest = Math.max(newest, lstatSync(child).mtimeMs);
      if (entry.isDirectory() && !walk(child)) return false;
    }
    return true;
  };
  if (!walk(path)) return late();
  try {
    newest = Math.max(newest, lstatSync(join(admin, "logs", "HEAD")).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return ok(Date.now() - newest);
}
export async function aheadOfBase(
  root: string,
  remote: string,
  base: string,
): Promise<Outcome<number>> {
  const format = await git(root, ["check-ref-format", `refs/heads/${base}`]);
  if (!format.ok) return format;
  const url = await git(root, ["remote", "get-url", remote]);
  if (!url.ok) return url;
  const listed = await git(root, [
    "ls-remote",
    "--heads",
    "--",
    url.value,
    `refs/heads/${base}`,
  ]);
  if (!listed.ok) return listed;
  const tips = commitIds(listed.value);
  if (!tips.ok) return tips;
  if (tips.value.length !== 1)
    return failed(
      "no-base-tip",
      "The configured base has no unique remote tip",
    );
  const counted = await git(root, [
    "rev-list",
    "--count",
    `${tips.value[0]}..HEAD`,
  ]);
  if (!counted.ok) return counted;
  const count = Number(counted.value);
  if (!Number.isSafeInteger(count) || count < 0)
    return failed("malformed", "Cannot determine commits ahead of the base");
  return ok(count);
}
