/** Bounded Git and forge observations; no checkout-provided commands run. */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { GcError } from "../../shared/gc-error.ts";
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
    ["git", "-C", root, "merge-base", "--is-ancestor", head, ancestor],
    { timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code === 0) return true;
  return result.code === 1 ? false : null;
}
function commitIds(output: string): string[] {
  if (!output) return [];
  return output.split("\n").map((line) => {
    const match = /^(\S+)\trefs\/heads\/.+$/.exec(line);
    if (!match || !COMMIT.test(match[1] ?? ""))
      throw new GcError("Malformed remote branch inventory");
    return match[1] as string;
  });
}
export async function localOnlyCommits(
  root: string,
  head: string,
): Promise<boolean | null> {
  const names = (await git(root, ["remote"])).split("\n").filter(Boolean);
  let unknown = false;
  for (const name of names) {
    const url = await git(root, ["remote", "get-url", name]);
    const heads = commitIds(
      await git(root, ["ls-remote", "--heads", "--", url]),
    );
    for (const tip of heads) {
      const covered = await ancestry(root, head, tip);
      if (covered === true) return false;
      if (covered === null) unknown = true;
    }
  }
  return unknown ? null : true;
}
function forgeRepository(remote: string): string {
  const ssh = /^(?:[^@/]+@)?([^:/]+):([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  let url: URL;
  try {
    url = new URL(remote);
  } catch (error) {
    throw new GcError("Cannot derive a forge repository from the remote URL", {
      cause: error,
    });
  }
  const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(path))
    throw new GcError("Remote URL does not identify one forge repository");
  return `${url.host}/${path}`;
}
function requestSource(value: Record<string, unknown>): string {
  if (
    !isMapping(value.headRepository) ||
    !isMapping(value.headRepositoryOwner) ||
    typeof value.headRepository.name !== "string" ||
    !value.headRepository.name ||
    typeof value.headRepositoryOwner.login !== "string" ||
    !value.headRepositoryOwner.login
  )
    throw new GcError("Pull request source repository could not be verified");
  return `${value.headRepositoryOwner.login}/${value.headRepository.name}`;
}
function request(value: unknown, source: string): WorktreeRequest | null {
  if (!isMapping(value)) throw new GcError("Malformed pull request record");
  if (requestSource(value).toLowerCase() !== source.toLowerCase()) return null;
  if (typeof value.headRefOid !== "string" || !COMMIT.test(value.headRefOid))
    throw new GcError("Malformed pull request head");
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(value.state)))
    throw new GcError("Malformed pull request state");
  return {
    state: value.state as WorktreeRequest["state"],
    head: value.headRefOid,
  };
}
export async function requests(
  root: string,
  remote: string,
  branch: string,
): Promise<WorktreeRequest[]> {
  const repository = forgeRepository(
    await git(root, ["remote", "get-url", remote]),
  );
  const result = await run(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      "state,headRefOid,headRepository,headRepositoryOwner",
    ],
    { cwd: root, timeoutSec: 30, env: gitEnvironment() },
  );
  if (result.code !== 0)
    throw new GcError(`Forge inventory unavailable: ${result.stderr}`);
  const values: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(values) || values.length >= 200)
    throw new GcError("Pull request inventory is incomplete");
  // --head matches branch names in forks too; only this remote is evidence.
  const source = repository.slice(repository.indexOf("/") + 1);
  return values.flatMap((value) => {
    const matched = request(value, source);
    return matched ? [matched] : [];
  });
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
export function worktreeActivity(
  path: string,
  admin: string,
  deadline = Date.now() + 30_000,
): number {
  let newest = 0;
  // Checked per entry: one flat directory can hold enough files to overrun.
  const check = (): void => {
    if (Date.now() > deadline)
      throw new GcError("Worktree activity scan exceeded its deadline");
  };
  const walk = (dir: string): void => {
    check();
    newest = Math.max(newest, lstatSync(dir).mtimeMs);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      check();
      const child = join(dir, entry.name);
      newest = Math.max(newest, lstatSync(child).mtimeMs);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk(path);
  try {
    newest = Math.max(newest, lstatSync(join(admin, "logs", "HEAD")).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Date.now() - newest;
}
export async function aheadOfBase(
  root: string,
  remote: string,
  base: string,
): Promise<number> {
  await git(root, ["check-ref-format", `refs/heads/${base}`]);
  const url = await git(root, ["remote", "get-url", remote]);
  const tips = commitIds(
    await git(root, ["ls-remote", "--heads", "--", url, `refs/heads/${base}`]),
  );
  if (tips.length !== 1)
    throw new GcError("The configured base has no unique remote tip");
  const count = Number(
    await git(root, ["rev-list", "--count", `${tips[0]}..HEAD`]),
  );
  if (!Number.isSafeInteger(count) || count < 0)
    throw new GcError("Cannot determine commits ahead of the base");
  return count;
}
