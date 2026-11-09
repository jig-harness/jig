#!/usr/bin/env bun
/** Release only the explicitly named implementer tree after its PR opens.
 * Every uncertain safety check keeps the tree attached and reports why.
 * Exit 0 reports released/held; exit 2 means malformed arguments.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fail, runMain } from "../../../shared/cli.ts";
import { git, type RunResult } from "../../../shared/proc.ts";
import { parseArgs } from "./lib/cli.ts";

interface Request {
  tree: string;
  branch: string;
  remote: string;
}
interface Report {
  outcome: "released" | "held";
  tree: string;
  reason: string;
  /** Argument arrays; inspect and settle the reported blocker before detaching. */
  commands: string[][];
}
const OPERATIONS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "BISECT_LOG",
  "index.lock",
  "HEAD.lock",
];

type Reader = (cwd: string, ...args: string[]) => Promise<string | null>;
type Tree = { target: string; admin: string };

function gitFailure(command: string, result: RunResult): string {
  const detail = result.stderr.trim();
  return `git ${command}: exit ${result.code}${detail ? `: ${detail}` : ""}`;
}

function inspection() {
  let failure: string | null = null;
  const read: Reader = async (cwd, ...args) => {
    const result = await git(["-C", cwd, ...args], { timeoutSec: 20 });
    if (result.code !== 0) {
      failure = gitFailure(args[0] ?? "read", result);
      return null;
    }
    return result.stdout.trim();
  };
  return {
    read,
    reason: (why: string) => (failure === null ? why : `${why}; ${failure}`),
  };
}

async function cloneIdentity(
  target: string,
  session: string,
  read: Reader,
): Promise<{ admin: string } | string> {
  const common = await read(
    target,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const ownCommon = await read(
    session,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const admin = await read(target, "rev-parse", "--absolute-git-dir");
  if (common === null || ownCommon === null || admin === null)
    return "the delegate is not in this clone";
  if (realpathSync(common) !== realpathSync(ownCommon))
    return "the delegate is not in this clone";
  if (realpathSync(common) === realpathSync(admin))
    return "the delegate is the primary worktree";
  return { admin };
}

async function identifyTree(
  tree: string,
  sessionRoot: string,
  read: Reader,
): Promise<Tree | string> {
  const target = realpathSync(tree);
  const session = await read(sessionRoot, "rev-parse", "--show-toplevel");
  if (session === null) return "cannot identify the session worktree";
  if (target === realpathSync(session))
    return "the delegate path is the session's own worktree";
  const top = await read(target, "rev-parse", "--show-toplevel");
  if (top === null || realpathSync(top) !== target)
    return "the delegate path is not a worktree root";
  const identity = await cloneIdentity(target, session, read);
  return typeof identity === "string"
    ? identity
    : { target, admin: identity.admin };
}

async function localBlocker(
  tree: Tree,
  branch: string,
  read: Reader,
): Promise<string | null> {
  const { target, admin } = tree;
  if (
    (await read(target, "symbolic-ref", "--quiet", "HEAD")) !==
    `refs/heads/${branch}`
  )
    return "the delegate no longer holds the requested branch";
  const status = await read(
    target,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  if (status === null || status !== "")
    return "the delegate has local changes or its status is unreadable";
  const index = await read(target, "ls-files", "-v");
  if (index === null || index.split("\n").some((line) => /^[a-zS] /.test(line)))
    return "index flags may hide local changes";
  if (OPERATIONS.some((name) => existsSync(resolve(admin, name))))
    return "an unfinished git operation or lock is present";
  return null;
}

async function remoteBlocker(
  target: string,
  request: Request,
  read: Reader,
): Promise<string | null> {
  const head = await read(target, "rev-parse", "HEAD");
  // Read the server, not a potentially stale local tracking ref.
  const advertised = await read(
    target,
    "ls-remote",
    "--exit-code",
    "--",
    request.remote,
    `refs/heads/${request.branch}`,
  );
  const remoteHead = advertised?.split(/\s+/)[0];
  if (!head || !remoteHead || !/^[a-f0-9]{40,64}$/.test(remoteHead))
    return "the remote branch cannot be verified";
  const contained = await git(
    ["-C", target, "merge-base", "--is-ancestor", head, remoteHead],
    { timeoutSec: 20 },
  );
  if (contained.code === 0) return null;
  if (contained.code === 1)
    return "the delegate has commits not verified on the remote branch";
  return `the remote branch ancestry cannot be verified; ${gitFailure("merge-base", contained)}`;
}

function heldReport(tree: string, reason: string): Report {
  return {
    outcome: "held",
    tree,
    reason,
    commands: [
      ["git", "-C", tree, "status", "--ignore-submodules=none"],
      [
        "git",
        "-C",
        tree,
        "log",
        "--oneline",
        "--branches",
        "--not",
        "--remotes",
      ],
      ["git", "-C", tree, "checkout", "--detach"],
    ],
  };
}

export async function releaseImplementerWorktree(
  request: Request,
  sessionRoot = process.cwd(),
): Promise<Report> {
  const { read, reason } = inspection();
  const held = (why: string) => heldReport(request.tree, reason(why));
  try {
    const tree = await identifyTree(request.tree, sessionRoot, read);
    if (typeof tree === "string") return held(tree);
    const local = await localBlocker(tree, request.branch, read);
    if (local !== null) return held(local);
    const remote = await remoteBlocker(tree.target, request, read);
    if (remote !== null) return held(remote);
    const detached = await git(["-C", tree.target, "checkout", "--detach"], {
      timeoutSec: 20,
    });
    if (detached.code !== 0)
      return held(`git refused to detach; ${gitFailure("checkout", detached)}`);
    return {
      outcome: "released",
      tree: request.tree,
      reason: "clean, pushed implementer worktree detached",
      commands: [],
    };
  } catch (error) {
    return held(
      `cannot verify the delegate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requestFromArgs(args: string[]): Request {
  const parsed = parseArgs(args, {
    flags: [],
    values: ["tree", "branch", "remote"],
    noPositional: true,
    usage:
      "usage: release-implementer-worktree.ts --tree <path> --branch <head> --remote <remote>",
  });
  if (!parsed.ok) fail(2, parsed.message);
  const { values } = parsed.args;
  const tree = values.get("tree");
  const branch = values.get("branch");
  const remote = values.get("remote");
  if (!tree || !branch || !remote)
    fail(2, "--tree, --branch and --remote are required");
  return { tree, branch, remote };
}

if (import.meta.main)
  runMain("release-implementer-worktree", async () => {
    console.log(
      JSON.stringify(
        await releaseImplementerWorktree(
          requestFromArgs(process.argv.slice(2)),
        ),
      ),
    );
    return 0;
  });
