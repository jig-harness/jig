/**
 * `notify` on Orca: the workspace's comment set to the message and the
 * workspace marked unread, in one call (`orca worktree set --worktree
 * path:<path> --comment <message> --unread`), which Orca's phone app shows
 * as an unread workspace with its comment. The comment is then read back
 * (`orca worktree show`): that read is the receipt, and the tick counts a
 * message as sent only once it finds the message's key in it. Each call
 * runs under the runtime's deadline; an answer past it is lost. The write
 * and the read-back hold the card's comment lock, shared with the skills'
 * board helper; a lock not taken in time sends nothing, and the receipt says
 * so (not lost: nothing was written).
 */
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { MAX_COMMENT, type RuntimeReceipt } from "./port.ts";

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

async function call(
  args: string[],
  timeoutMs: number,
): Promise<
  { ok: true; result: unknown } | { ok: false; lost: boolean; why: string }
> {
  const done = await run(
    [orcaCommand(process.env) ?? "orca", ...args, "--json"],
    {
      timeoutSec: seconds(timeoutMs),
      stderr: "pipe",
    },
  );
  if (done.timedOut)
    return {
      ok: false,
      lost: true,
      why: `orca ${args.slice(0, 2).join(" ")} gave no answer within ${seconds(timeoutMs)}s`,
    };
  const envelope = orcaEnvelope(done.stdout);
  if (done.code === 0 && envelope?.ok === true)
    return { ok: true, result: envelope.result };
  return {
    ok: false,
    // An answer that is not Orca's envelope says nothing about what was written.
    lost: envelope === null,
    why: `orca ${args.slice(0, 2).join(" ")} failed (exit ${done.code}): ${(done.stderr || done.stdout).trim().slice(0, 200)}`,
  };
}

/** The card's comment and unread mark in `worktree show`'s answer; `null` when it names neither. */
function cardOf(
  result: unknown,
): { comment: string | null; unread: boolean } | null {
  const worktree = isRecord(result) ? result.worktree : undefined;
  if (!isRecord(worktree)) return null;
  const { comment, isUnread } = worktree;
  if (typeof isUnread !== "boolean") return null;
  if (comment !== undefined && comment !== null && typeof comment !== "string")
    return null;
  // An unread card that names no comment may be hiding text a person has not read.
  if (isUnread && typeof comment !== "string") return null;
  return { comment: comment ?? null, unread: isUnread };
}

/** The comment in `worktree show`'s answer; `null` when it names none. */
function commentOf(result: unknown): string | null {
  const worktree = isRecord(result) ? result.worktree : undefined;
  return isRecord(worktree) && typeof worktree.comment === "string"
    ? worktree.comment
    : null;
}

/** The entries a message joins: each opens with its key line. */
function entriesOf(message: string): string[] {
  return message.split(/\n\n(?=\[jig dispatch: )/);
}

/** The key line an entry opens with; `null` for text that has none. */
function keyLineOf(entry: string): string | null {
  return entry.match(/^\[jig dispatch: .*\]$/m)?.[0] ?? null;
}

/** Orca reads a value that opens with `-` as a flag of its own. */
function argumentSafe(comment: string): string {
  return comment.startsWith("-") ? `Unread notes:\n${comment}` : comment;
}

/**
 * The comment to write over the card as it is now: the entries it does not
 * carry yet appended to a comment still unread, so nothing a person has not
 * read is replaced; the message alone otherwise. `null` when the unread
 * comment already carries every entry.
 */
function merged(
  card: { comment: string | null; unread: boolean },
  message: string,
): string | null {
  if (!card.unread || card.comment === null || card.comment.trim() === "")
    return message;
  const carried = card.comment;
  const missing = entriesOf(message).filter((entry) => {
    const key = keyLineOf(entry);
    return !carried.includes(key ?? entry);
  });
  if (missing.length === 0) return null;
  return `${carried}\n\n${missing.join("\n\n")}`;
}

export async function orcaNotify(
  target: { id: string; path: string },
  message: string,
  timeoutMs: number,
  lock: CardLock = withCardLock,
): Promise<RuntimeReceipt> {
  // One deadline covers the lock's wait and every call after it.
  const start = performance.now();
  const remaining = (): number => timeoutMs - (performance.now() - start);
  // The read, the write and the read-back hold the card's lock, the one
  // every comment writer takes (`shared/orca-card-lock.ts`), so no writer's
  // read-then-write falls between them.
  let locked: { value: RuntimeReceipt } | null;
  try {
    locked = await lock(
      target.path,
      () => notifyUnlocked(target, message, remaining),
      { waitMs: Math.max(0, Math.min(timeoutMs, 5000)) },
    );
  } catch (error) {
    return {
      ok: false,
      lost: false,
      detail: `${target.path}: the card's comment lock could not be taken: ${error instanceof Error ? error.message : String(error)}; nothing written`,
    };
  }
  return (
    locked?.value ?? {
      ok: false,
      lost: false,
      detail: `${target.path}: another writer held the card's comment past the lock's deadline; nothing written`,
    }
  );
}

async function notifyUnlocked(
  target: { id: string; path: string },
  message: string,
  remaining: () => number,
): Promise<RuntimeReceipt> {
  const selector = `path:${target.path}`;
  const spent = (): RuntimeReceipt | null =>
    remaining() > 0
      ? null
      : {
          ok: false,
          lost: false,
          detail: `${target.path}: the runtime's deadline passed before the comment was written; nothing written`,
        };
  let late = spent();
  if (late !== null) return late;
  const before = await call(
    ["worktree", "show", "--worktree", selector],
    remaining(),
  );
  if (!before.ok) return { ok: false, lost: before.lost, detail: before.why };
  const card = cardOf(before.result);
  if (card === null)
    return {
      ok: false,
      lost: false,
      detail: `${target.path}: orca worktree show named no readable comment and unread mark; nothing written`,
    };
  const comment = merged(card, message);
  if (comment !== null) {
    // The budget the sender computed from an earlier listing; the card read
    // under the lock is the one the written comment is measured on.
    if (comment.length > MAX_COMMENT)
      return {
        ok: false,
        lost: false,
        detail: `${target.path}: the card's unread comment and the message would pass ${MAX_COMMENT} characters; nothing written, it goes once the comment is read`,
      };
    late = spent();
    if (late !== null) return late;
    const set = await call(
      [
        "worktree",
        "set",
        "--worktree",
        selector,
        "--comment",
        argumentSafe(comment),
        "--unread",
      ],
      remaining(),
    );
    if (!set.ok) return { ok: false, lost: set.lost, detail: set.why };
  }
  late = spent();
  if (late !== null)
    return {
      ...late,
      lost: true,
      detail: `the comment was written; ${late.detail}`,
    };
  const shown = await call(
    ["worktree", "show", "--worktree", selector],
    remaining(),
  );
  if (!shown.ok)
    return {
      ok: false,
      lost: true,
      detail: `the comment was written, and could not be read back: ${shown.why}`,
    };
  late = spent();
  if (late !== null)
    return {
      ...late,
      lost: true,
      detail: `the comment was written; the read-back came after the deadline`,
    };
  const read = commentOf(shown.result);
  return read === null
    ? {
        ok: false,
        lost: true,
        detail: "orca worktree show named no comment to read back",
      }
    : {
        ok: true,
        detail: `${target.path} marked unread with the message as its comment`,
        comment: read,
      };
}
