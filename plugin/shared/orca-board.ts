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
import { join } from "node:path";
import { fail, isDigits, runMain } from "./cli.ts";
import { swallow } from "./errors.ts";
import { run } from "./proc.ts";

/** Seconds one Orca call may take. */
const ORCA_CALL_TIMEOUT_SEC = 20;

const USAGE = "usage: orca-board.ts <status> [--pr <number>]";

/** A board status id: Orca's defaults, or a custom column's id. */
const STATUS = /^[a-z][a-z0-9-]*$/;

export interface BoardUpdate {
  status: string;
  pr?: string;
}

/** Runs Orca's command with `args`; the seam tests replace. */
export type OrcaRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runOrca: OrcaRunner = (command, args) =>
  run([command, ...args], { timeoutSec: ORCA_CALL_TIMEOUT_SEC });

/** Orca's command when this session runs in a terminal Orca opened; null otherwise. */
export function orcaCommand(
  env: Record<string, string | undefined>,
): string | null {
  const command = env.ORCA_CLI_COMMAND?.trim();
  if (command) return command;
  const dir = env.ORCA_CLI_BIN_DIR?.trim();
  return dir ? join(dir, "orca") : null;
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

/** The `result` of a well-formed successful Orca envelope; null for anything else. */
function resultOf(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ok, result } = parsed as { ok?: unknown; result?: unknown };
    return ok === true && typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : null;
  } catch (error) {
    swallow(error, "orca output that is not JSON: no envelope");
    return null;
  }
}

/** The Orca worktree id of the working directory; null when Orca does not know it. */
async function currentWorktree(
  command: string,
  runner: OrcaRunner,
): Promise<string | null> {
  const done = await runner(command, ["worktree", "current", "--json"]);
  const worktree = resultOf(done.stdout)?.worktree as
    | { id?: unknown }
    | undefined;
  return typeof worktree?.id === "string" && worktree.id !== ""
    ? worktree.id
    : null;
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
  const id = await currentWorktree(command, runner);
  if (id === null)
    return "orca-board: Orca does not list this directory as a worktree; nothing to do";
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
  if (resultOf(done.stdout) === null)
    return `orca-board: ⚠ could not set the board status (exit ${done.code}): ${(done.stdout || done.stderr).trim().slice(0, 300)}`;
  return `orca-board: ${update.status}${update.pr === undefined ? "" : `, PR #${update.pr} linked`}`;
}

if (import.meta.main)
  runMain("orca-board", async () => {
    const update = parseArgs(process.argv.slice(2));
    console.error(await updateBoard(update));
    return 0;
  });
