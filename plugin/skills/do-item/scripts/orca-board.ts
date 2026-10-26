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
import { fail, isDigits, runMain } from "../../../shared/cli.ts";
import { swallow } from "../../../shared/errors.ts";
import { run } from "../../../shared/proc.ts";

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

/**
 * Orca's command when this session runs in a terminal Orca opened; null
 * otherwise. From the directory alone, the command is the one Orca installs
 * there: `orca-ide` on Linux, `orca` elsewhere.
 */
export function orcaCommand(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const command = env.ORCA_CLI_COMMAND?.trim();
  if (command) return command;
  const dir = env.ORCA_CLI_BIN_DIR?.trim();
  return dir ? join(dir, platform === "linux" ? "orca-ide" : "orca") : null;
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

type Envelope =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string | null };

interface RawEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

/** `stdout` parsed as a JSON object; null when it is not one. */
function parsedObject(stdout: string): RawEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as RawEnvelope)
      : null;
  } catch (error) {
    swallow(error, "orca output that is not JSON: no envelope");
    return null;
  }
}

/** Orca's JSON envelope in `stdout`; null when there is none. */
function envelopeOf(stdout: string): Envelope | null {
  const raw = parsedObject(stdout);
  if (raw?.ok === true && typeof raw.result === "object" && raw.result !== null)
    return { ok: true, result: raw.result as Record<string, unknown> };
  if (raw?.ok !== false) return null;
  const code = raw.error?.code;
  return { ok: false, code: typeof code === "string" ? code : null };
}

/** The `result` of a call that exited 0 with a successful envelope; null for anything else. */
function resultOf(done: {
  code: number;
  stdout: string;
}): Record<string, unknown> | null {
  const envelope = envelopeOf(done.stdout);
  return done.code === 0 && envelope?.ok === true ? envelope.result : null;
}

/** A failed call's exit code and first output, for a warning. */
function failure(done: { code: number; stdout: string; stderr: string }) {
  return `(exit ${done.code}): ${(done.stdout || done.stderr).trim().slice(0, 300)}`;
}

/**
 * The Orca worktree id of the working directory: `none` when Orca answers
 * that no worktree contains it, a warning when the lookup itself failed (no command, a timeout, an answer that is not Orca's).
 */
async function currentWorktree(
  command: string,
  runner: OrcaRunner,
): Promise<{ id: string } | "none" | { warning: string }> {
  const done = await runner(command, ["worktree", "current", "--json"]);
  const result = resultOf(done);
  const worktree = result?.worktree as { id?: unknown } | undefined;
  if (typeof worktree?.id === "string" && worktree.id !== "")
    return { id: worktree.id };
  const envelope = envelopeOf(done.stdout);
  if (envelope?.ok === false && envelope.code === NOT_A_WORKTREE) return "none";
  return {
    warning: `orca-board: ⚠ could not ask Orca which worktree this is ${failure(done)}`,
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
  if (resultOf(done) === null)
    return `orca-board: ⚠ could not set the board status ${failure(done)}`;
  return `orca-board: ${update.status}${update.pr === undefined ? "" : `, PR #${update.pr} linked`}`;
}

if (import.meta.main)
  runMain("orca-board", async () => {
    const update = parseArgs(process.argv.slice(2));
    console.error(await updateBoard(update));
    return 0;
  });
