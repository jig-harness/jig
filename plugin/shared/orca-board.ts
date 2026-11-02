#!/usr/bin/env bun
/**
 * Show a piece of work's stage on Orca's workspace board, when the session
 * runs in an Orca worktree; do nothing anywhere else.
 *
 * Usage: bun orca-board.ts [<stage>] [--pr <number>] [--unread] [--comment <text>]
 *
 * Orca (https://www.onorca.dev) shows its worktrees as cards on a board whose
 * columns are statuses (`todo`, `in-progress`, `in-review`, `completed` by
 * default), on the desktop app and on Orca Mobile, links a card to its pull
 * request, keeps a comment on it and marks it unread. Each stage of the
 * execution line calls this so the card says where the work stands without
 * anyone moving it: `do-item` at pickup and when it opens the pull request,
 * `drive-pr` when it marks the pull request Ready and when it stops on
 * something a person must look at, the follow-up after the merge.
 *
 * The stage is `in-progress`, `in-review` or `completed`; `orca.board` in the
 * repository's configuration maps each onto a custom column's id, and Orca's
 * own column of that name is the default. `--unread` marks the card unread
 * and `--comment` sets its comment; with either, the stage may be left out.
 *
 * Nothing turns it on: it acts only when the session runs in a terminal Orca
 * opened (Orca puts its command in `ORCA_CLI_COMMAND`, or its directory in
 * `ORCA_CLI_BIN_DIR`) and Orca knows the working directory as one of its
 * worktrees (`orca worktree current`). A comment never replaces one a person
 * has not read: while the card is unread, the new comment is appended to its
 * comment, read and written under the card's lock (`orca-card-lock.ts`),
 * which the dispatcher's notifications take too.
 *
 * Outside Orca it makes no call and reads no configuration. The board is a
 * convenience, so every Orca failure, a lock not taken in time and an
 * `orca.board` it cannot read only warn and the exit is 0; only a
 * malformed command line exits 2.
 */
import { fail, isDigits, runMain } from "./cli.ts";
import { readConfig } from "./consumer.ts";
import {
  type OrcaRunner,
  orcaCommand,
  currentWorktree,
  orcaFailure,
  orcaResult,
  runOrca,
} from "./orca.ts";
import { type CardLock, withCardLock } from "./orca-card-lock.ts";

const USAGE =
  "usage: orca-board.ts [in-progress|in-review|completed] [--pr <number>] [--unread] [--comment <text>]";

/** The stages of the execution line a card shows, by their default column. */
export const BOARD_STAGES = ["in-progress", "in-review", "completed"] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

/** Each stage's key under `orca.board`. */
export const BOARD_CONFIG_KEYS: Record<BoardStage, string> = {
  "in-progress": "in_progress",
  "in-review": "in_review",
  completed: "completed",
};

/** A board status id: Orca's defaults, or a custom column's id. */
export const COLUMN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface BoardUpdate {
  stage?: BoardStage;
  pr?: string;
  unread?: boolean;
  comment?: string;
}

function isStage(value: string): value is BoardStage {
  return (BOARD_STAGES as readonly string[]).includes(value);
}

/** Orca reads a value that opens with `-` as a flag of its own. */
function usableComment(text: string): boolean {
  return text.trim() !== "" && !text.startsWith("-");
}

/** Reads a flag's value into an update; the words it took, 0 when it refuses. */
type FlagReader = (update: BoardUpdate, value: string | undefined) => number;

const FLAGS = new Map<string, FlagReader>([
  [
    "--unread",
    (update) => {
      if (update.unread !== undefined) return 0;
      update.unread = true;
      return 1;
    },
  ],
  [
    "--pr",
    (update, value) => {
      if (update.pr !== undefined || value === undefined || !isDigits(value))
        return 0;
      update.pr = value;
      return 2;
    },
  ],
  [
    "--comment",
    (update, value) => {
      if (
        update.comment !== undefined ||
        value === undefined ||
        !usableComment(value)
      )
        return 0;
      update.comment = value;
      return 2;
    },
  ],
]);

/** Read the word at `args[i]` into `update`; returns how many words it took. */
function takeWord(update: BoardUpdate, args: string[], i: number): number {
  const arg = args[i] ?? "";
  const taken = FLAGS.get(arg)?.(update, args[i + 1]) ?? 0;
  if (taken > 0) return taken;
  if (update.stage !== undefined || !isStage(arg)) fail(2, USAGE);
  update.stage = arg;
  return 1;
}

export function parseArgs(args: string[]): BoardUpdate {
  const update: BoardUpdate = {};
  for (let i = 0; i < args.length; ) i += takeWord(update, args, i);
  if (
    update.stage === undefined &&
    update.unread === undefined &&
    update.comment === undefined
  )
    fail(2, USAGE);
  return update;
}

/** The columns `orca.board` maps the stages onto, or what is wrong with it. */
export type BoardColumns =
  | { ok: true; columns: Record<BoardStage, string> }
  | { ok: false; problem: string };

/** `value` when it is a mapping, `undefined` when unset, or what it must be. */
function mapping(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    return `${field} must be a mapping`;
  return value as Record<string, unknown>;
}

/**
 * The column each stage moves the card to: `orca.board` from the merged
 * configuration over Orca's default columns, or the problem with the
 * section, naming the field.
 */
export function boardColumns(config: Record<string, unknown>): BoardColumns {
  const columns: Record<BoardStage, string> = {
    "in-progress": "in-progress",
    "in-review": "in-review",
    completed: "completed",
  };
  const orca = mapping(config.orca, "orca");
  if (typeof orca === "string") return { ok: false, problem: orca };
  const board = mapping(orca?.board, "orca.board");
  if (typeof board === "string") return { ok: false, problem: board };
  for (const [key, id] of Object.entries(board ?? {})) {
    const stage = BOARD_STAGES.find((s) => BOARD_CONFIG_KEYS[s] === key);
    if (stage === undefined)
      return {
        ok: false,
        problem: `orca.board: unknown stage "${key}" (known: ${Object.values(BOARD_CONFIG_KEYS).join(", ")})`,
      };
    if (typeof id !== "string" || !COLUMN_ID.test(id))
      return {
        ok: false,
        problem: `orca.board.${key} must be a board status id`,
      };
    columns[stage] = id;
  }
  return { ok: true, columns };
}

/** The column `stage` moves the card to, or a warning naming what is wrong. */
function statusFor(
  stage: BoardStage,
  config: () => Record<string, unknown>,
): { status: string } | { warning: string } {
  let read: BoardColumns;
  try {
    read = boardColumns(config());
  } catch (error) {
    return {
      warning: error instanceof Error ? error.message : String(error),
    };
  }
  return read.ok ? { status: read.columns[stage] } : { warning: read.problem };
}

/** The `orca worktree set` arguments for `update` on worktree `id`. */
function setArgs(
  id: string,
  update: BoardUpdate,
  status: string | undefined,
): string[] {
  return [
    "worktree",
    "set",
    "--worktree",
    `id:${id}`,
    ...(status === undefined ? [] : ["--workspace-status", status]),
    ...(update.pr === undefined ? [] : ["--pr", update.pr]),
    ...(update.unread === true ? ["--unread"] : []),
    ...(update.comment === undefined ? [] : ["--comment", update.comment]),
    "--json",
  ];
}

/** What an update set, for the line it reports. */
function described(
  update: BoardUpdate,
  status: string | undefined,
  appended: boolean,
): string {
  return [
    ...(status === undefined ? [] : [status]),
    ...(update.pr === undefined ? [] : [`PR #${update.pr} linked`]),
    ...(update.unread === true ? ["marked unread"] : []),
    ...(update.comment === undefined
      ? []
      : [appended ? "comment appended" : "comment set"]),
  ].join(", ");
}

/**
 * The comment to write: while the card is unread, its comment is one a
 * person has not read, so the new line is appended to it (once); otherwise
 * the new comment replaces it.
 */
export function mergedComment(
  existing: string | null,
  unread: boolean,
  comment: string,
): string {
  if (!unread || existing === null || existing.trim() === "") return comment;
  if (`\n${existing}\n`.includes(`\n${comment}\n`)) return existing;
  return `${existing}\n${comment}`;
}

/** `comment` made safe to pass as Orca's argument: one that opens with `-` would read as a flag. */
function argumentSafe(comment: string): string {
  return usableComment(comment) ? comment : `Unread notes:\n${comment}`;
}

/** The workspace path an Orca worktree id names (`<repo id>::<path>`). */
function workspacePath(id: string): string {
  const at = id.indexOf("::");
  return at < 0 ? id : id.slice(at + 2);
}

/** The card's comment and unread mark, or a warning when they cannot be read. */
async function readCard(
  command: string,
  runner: OrcaRunner,
  id: string,
): Promise<{ comment: string | null; unread: boolean } | { warning: string }> {
  const done = await runner(command, [
    "worktree",
    "show",
    "--worktree",
    `id:${id}`,
    "--json",
  ]);
  const worktree = orcaResult(done)?.worktree;
  if (typeof worktree !== "object" || worktree === null)
    return {
      warning: `⚠ could not read the card's comment ${orcaFailure(done)}`,
    };
  const card = worktree as Record<string, unknown>;
  const { comment, isUnread } = card;
  const known =
    typeof isUnread === "boolean" &&
    (typeof comment === "string" || comment === null || comment === undefined);
  // A card that names no comment while unread, or whose fields have another
  // shape, may be hiding text a person has not read.
  if (!known || (isUnread && typeof comment !== "string"))
    return {
      warning: "⚠ the card's comment and unread mark could not be established",
    };
  return { comment: comment ?? null, unread: isUnread };
}

/** Write `update` to the card `id`; returns the line to report. */
async function writeCard(
  command: string,
  runner: OrcaRunner,
  id: string,
  update: BoardUpdate,
  status: string | undefined,
  appended = false,
): Promise<string> {
  const done = await runner(command, setArgs(id, update, status));
  if (orcaResult(done) === null)
    return `orca-board: ⚠ could not update the card ${orcaFailure(done)}`;
  return `orca-board: ${described(update, status, appended)}`;
}

/**
 * Write a comment under the card's lock: read the card, append to the
 * comment of an unread card, write. A lock not taken in time skips the
 * write with a warning.
 */
async function writeComment(
  command: string,
  runner: OrcaRunner,
  id: string,
  update: BoardUpdate & { comment: string },
  status: string | undefined,
  lock: CardLock,
): Promise<string> {
  let locked: { value: string } | null;
  try {
    locked = await lock(workspacePath(id), async () => {
      const card = await readCard(command, runner, id);
      if ("warning" in card) return `orca-board: ${card.warning}; nothing set`;
      const comment = argumentSafe(
        mergedComment(card.comment, card.unread, update.comment),
      );
      return await writeCard(
        command,
        runner,
        id,
        { ...update, comment },
        status,
        comment !== update.comment,
      );
    });
  } catch (error) {
    return `orca-board: ⚠ the card's comment lock failed: ${error instanceof Error ? error.message : String(error)}; nothing set`;
  }
  return (
    locked?.value ??
    "orca-board: ⚠ another writer held the card's comment past the lock's deadline; nothing set"
  );
}

/**
 * Apply `update` to the working directory's card: its stage's column, the
 * linked pull request, the unread mark and the comment, which is appended to
 * an unread card's comment rather than replacing it. Returns the line to
 * report: what was set, or why nothing was; a failure is that warning, never
 * a throw.
 */
export async function updateBoard(
  update: BoardUpdate,
  env: Record<string, string | undefined> = process.env,
  runner: OrcaRunner = runOrca,
  config: () => Record<string, unknown> = readConfig,
  lock: CardLock = withCardLock,
): Promise<string> {
  const command = orcaCommand(env);
  if (command === null) return "orca-board: not in Orca; nothing to do";
  if (update.comment !== undefined && !usableComment(update.comment))
    return "orca-board: ⚠ a comment must be text that does not open with '-'; nothing set";
  let status: string | undefined;
  if (update.stage !== undefined) {
    const column = statusFor(update.stage, config);
    if ("warning" in column)
      return `orca-board: ⚠ ${column.warning}; nothing set`;
    status = column.status;
  }
  const current = await currentWorktree(command, runner);
  if (current === "none")
    return "orca-board: Orca does not list this directory as a worktree; nothing to do";
  if ("warning" in current) return `orca-board: ${current.warning}`;
  const { comment } = update;
  return comment === undefined
    ? await writeCard(command, runner, current.id, update, status)
    : await writeComment(
        command,
        runner,
        current.id,
        { ...update, comment },
        status,
        lock,
      );
}

if (import.meta.main)
  runMain("orca-board", async () => {
    const update = parseArgs(process.argv.slice(2));
    console.error(await updateBoard(update));
    return 0;
  });
