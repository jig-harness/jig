#!/usr/bin/env bun
/**
 * Show a piece of work's stage on Orca's workspace board, when the session
 * runs in an Orca worktree; do nothing anywhere else.
 *
 * Usage: bun orca-board.ts <status> [--pr <number>]
 *
 * Orca (https://www.onorca.dev) shows its worktrees as cards on a board whose
 * columns are statuses (`todo`, `in-progress`, `in-review`, `completed` by
 * default), on the desktop app and on Orca Mobile, and links a card to its
 * pull request. A skill that picks work up or opens its pull request calls
 * this so the card says where the work stands without anyone moving it.
 *
 * Nothing turns it on: it acts only when the session runs in a terminal Orca
 * opened (Orca puts its command in `ORCA_CLI_COMMAND`, or its directory in
 * `ORCA_CLI_BIN_DIR`) and Orca knows the working directory as one of its
 * worktrees (`orca worktree current`). Outside Orca it makes no call at all.
 * The board is a convenience, so every Orca failure only warns and the exit
 * is 0; only a malformed command line exits 2.
 */
import { fail, isDigits, runMain } from "../../../shared/cli.ts";
import {
  type OrcaRunner,
  orcaCommand,
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  runOrca,
} from "../../../shared/orca.ts";

const USAGE = "usage: orca-board.ts <status> [--pr <number>]";

/** A board status id: Orca's defaults, or a custom column's id. */
const STATUS = /^[a-z][a-z0-9-]*$/;

export interface BoardUpdate {
  status: string;
  pr?: string;
}

export function parseArgs(args: string[]): BoardUpdate {
  const [status, ...rest] = args;
  if (status === undefined || !STATUS.test(status)) fail(2, USAGE);
  if (rest.length === 0) return { status };
  const [flag, pr, ...extra] = rest;
  if (flag !== "--pr" || pr === undefined || !isDigits(pr) || extra.length > 0)
    fail(2, USAGE);
  return { status, pr };
}

/** The error code Orca answers with when no worktree contains the directory. */
const NOT_A_WORKTREE = "selector_not_found";

/**
 * The Orca worktree id of the working directory, with the pull request it is
 * linked to (null or absent when none): `none` when Orca answers
 * that no worktree contains it, a warning when the lookup itself failed (no command, a timeout, an answer that is not Orca's).
 */
export async function currentWorktree(
  command: string,
  runner: OrcaRunner,
): Promise<{ id: string; linkedPR: unknown } | "none" | { warning: string }> {
  const done = await runner(command, ["worktree", "current", "--json"]);
  const result = orcaResult(done);
  const worktree = result?.worktree as
    | { id?: unknown; linkedPR?: unknown }
    | undefined;
  if (typeof worktree?.id === "string" && worktree.id !== "")
    return { id: worktree.id, linkedPR: worktree.linkedPR };
  const envelope = orcaEnvelope(done.stdout);
  if (envelope?.ok === false && envelope.code === NOT_A_WORKTREE) return "none";
  return {
    warning: `orca-board: ⚠ could not ask Orca which worktree this is ${orcaFailure(done)}`,
  };
}

/**
 * Set the working directory's card to `update.status`, linking `update.pr`.
 * Returns the line to report: what was set, or why nothing was.
 */
export async function updateBoard(
  update: BoardUpdate,
  env: Record<string, string | undefined> = process.env,
  runner: OrcaRunner = runOrca,
): Promise<string> {
  const command = orcaCommand(env);
  if (command === null) return "orca-board: not in Orca; nothing to do";
  const current = await currentWorktree(command, runner);
  if (current === "none")
    return "orca-board: Orca does not list this directory as a worktree; nothing to do";
  if ("warning" in current) return current.warning;
  const id = current.id;
  const done = await runner(command, [
    "worktree",
    "set",
    "--worktree",
    `id:${id}`,
    "--workspace-status",
    update.status,
    ...(update.pr === undefined ? [] : ["--pr", update.pr]),
    "--json",
  ]);
  if (orcaResult(done) === null)
    return `orca-board: ⚠ could not set the board status ${orcaFailure(done)}`;
  return `orca-board: ${update.status}${update.pr === undefined ? "" : `, PR #${update.pr} linked`}`;
}

if (import.meta.main)
  runMain("orca-board", async () => {
    const update = parseArgs(process.argv.slice(2));
    console.error(await updateBoard(update));
    return 0;
  });
