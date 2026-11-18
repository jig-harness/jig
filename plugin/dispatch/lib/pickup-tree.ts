/**
 * What a stalled pickup's tree holds that it has not shipped, read with
 * local git only, so the tick sends no outside call for it: the tree's head,
 * the commits on that head no remote-tracking branch has (unpushed), and
 * the tracked files changed and not committed (uncommitted edits). Untracked
 * files are not counted: a pass leaves scratch there, which is not work.
 */
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";
import { currentMs } from "../../shared/time.ts";

const GIT_TIMEOUT_MS = 10_000;

/** A tree as git read it: its head and what it has not shipped, or why it did not read. */
export type PickupTree =
  | { kind: "read"; head: string; unpushed: number; uncommitted: number }
  | { kind: "unread"; why: string };

/** Reads the tree at a path. */
export type TreeReader = (path: string) => PickupTree;

/** Whether a tree that read holds work it has not shipped. */
export function unshipped(tree: PickupTree): boolean {
  return tree.kind === "read" && (tree.unpushed > 0 || tree.uncommitted > 0);
}

/** What a tree that read holds, in words: its unpushed commits and uncommitted edits at its head. */
export function treeText(tree: Extract<PickupTree, { kind: "read" }>): string {
  return `${tree.unpushed} unpushed commit(s) and ${tree.uncommitted} uncommitted edit(s) at ${tree.head.slice(0, 12)}`;
}

/** Read the tree at `path`, each git call bounded by what is left of `deadlineMs` (epoch milliseconds). */
export function readPickupTree(path: string, deadlineMs?: number): PickupTree {
  const head = git(path, ["rev-parse", "--verify", "HEAD"], deadlineMs);
  if (!head.ok) return { kind: "unread", why: head.why };
  const ahead = git(
    path,
    ["rev-list", "--count", "HEAD", "--not", "--remotes"],
    deadlineMs,
  );
  if (!ahead.ok) return { kind: "unread", why: ahead.why };
  const status = git(
    path,
    ["status", "--porcelain", "--untracked-files=no"],
    deadlineMs,
  );
  if (!status.ok) return { kind: "unread", why: status.why };
  const unpushed = Number.parseInt(ahead.stdout.trim(), 10);
  if (!Number.isSafeInteger(unpushed))
    return {
      kind: "unread",
      why: `git rev-list answered ${JSON.stringify(ahead.stdout.trim())}, not a count`,
    };
  return {
    kind: "read",
    head: head.stdout.trim(),
    unpushed,
    uncommitted: status.stdout.split("\n").filter((l) => l.trim() !== "")
      .length,
  };
}

function git(
  cwd: string,
  args: string[],
  deadlineMs: number | undefined,
): { ok: true; stdout: string } | { ok: false; why: string } {
  const left = deadlineMs === undefined ? Infinity : deadlineMs - currentMs();
  if (left < 1)
    return {
      ok: false,
      why: `git ${args[0]} in ${cwd} not run: the tick's time is spent`,
    };
  const r = spawnSync("git", args, {
    cwd,
    timeout: Math.min(GIT_TIMEOUT_MS, Math.floor(left)),
    env: withoutLeakyGitEnv(process.env),
  });
  if (r.status === 0) return { ok: true, stdout: r.stdout };
  if (r.error !== undefined)
    return { ok: false, why: `git ${args[0]} in ${cwd}: ${r.error.message}` };
  if (r.signal !== null)
    return {
      ok: false,
      why: `git ${args[0]} in ${cwd} did not finish in time (${r.signal})`,
    };
  const last = (r.stderr ?? "").trim().split("\n").at(-1)?.trim();
  return {
    ok: false,
    why: `git ${args[0]} in ${cwd} exited ${r.status}${last ? `: ${last}` : ""}`,
  };
}
