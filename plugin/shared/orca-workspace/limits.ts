/**
 * How long the steps of opening a workspace may take, and the limit a whole
 * open is held to (`withLimit` in runner.ts). The Herdr and Orca workspace
 * tools in tools/ read these, and so does the plugin code that opens an Orca
 * workspace, so one open is bounded alike wherever it starts.
 */
import { COMMAND_TIMEOUT_MS } from "./runner.ts";

/** Where a repository keeps its worktree hooks, relative to the worktree. */
export const HOOKS_DIR = ".config/worktree-hooks";
/** The longest a create or remove hook may run; a dependency install is slow. */
export const HOOK_TIMEOUT_MS = 15 * 60_000;
/** The time a clone may take: a large repository over a slow link. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;
/** How long a kickoff waits for another launch of the same key. */
export const CLAIM_WAIT_MS = 120_000;
/** How often an open that waits for another's hook run or agent start looks again. */
export const WAIT_POLL_MS = 1_000;

/**
 * The calls around the hook: git probes, fetches and the clone checks, Orca's
 * list, create, link and launch, the worktree's git directory, the hook's
 * claim and mark, the worktree's token, where the journal is and its read.
 */
export const COMMAND_ALLOWANCE = 30;
/** The time an Orca open may take: a clone, the create hook, waiting for another open's start of the agent, and the calls around them. */
export const OPEN_LIMIT_MS =
  CLONE_TIMEOUT_MS +
  HOOK_TIMEOUT_MS +
  CLAIM_WAIT_MS +
  COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS;
