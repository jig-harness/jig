/**
 * `notify` on Orca: the workspace's comment set to the message and the
 * workspace marked unread, in one call (`orca worktree set --worktree
 * path:<path> --comment <message> --unread`), which Orca's phone app shows
 * as an unread workspace with its comment. The comment is then read back
 * (`orca worktree show`): that read is the receipt, and the tick counts a
 * message as sent only once the read-back confirms the written comment and
 * unread mark. The destination's selected branch and comment policy are
 * checked under the write lock. Each call
 * runs under the runtime's deadline; an answer past it is lost. The write
 * and the read-back hold the card's comment lock, shared with the skills'
 * board helper; a lock not taken in time sends nothing, and the receipt says
 * so (not lost: nothing was written). The dispatched marks the comment holds
 * stay in the one written (`keepMarks`).
 */
import { isRecord } from "../../../shared/guards.ts";
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { call, withCardDeadline } from "./orca-comment.ts";
import { holdsNotice } from "../notices.ts";
import {
  keepMarks,
  MAX_COMMENT,
  type NotifyTarget,
  type RuntimeReceipt,
  withoutMarks,
} from "./port.ts";

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

/** Whether the fresh workspace still holds the selected branch. */
async function sameBranch(
  target: NotifyTarget,
  remaining: () => number,
): Promise<boolean> {
  if (target.branch === undefined) return true;
  if (remaining() <= 0) return false;
  const listed = await call(["worktree", "ps", "--limit", "2000"], remaining());
  const ps = listed.ok ? listed.result : null;
  if (!isRecord(ps) || !Array.isArray(ps.worktrees)) return false;
  const rows = ps.worktrees.filter(
    (row) => isRecord(row) && row.path === target.path,
  );
  const row = rows.length === 1 ? rows[0] : null;
  return (
    isRecord(row) &&
    row.worktreeId === target.id &&
    row.branch === `refs/heads/${target.branch}`
  );
}

/** The destination policy is evaluated against the card read under the lock. */
async function destinationCard(
  target: NotifyTarget,
  result: unknown,
  remaining: () => number,
): Promise<NonNullable<ReturnType<typeof cardOf>> | RuntimeReceipt> {
  const refused = (problem: string): RuntimeReceipt => ({
    ok: false,
    lost: false,
    detail: `${target.path}: ${problem}; nothing written`,
  });
  const card = cardOf(result);
  if (card === null)
    return refused(
      "orca worktree show named no readable comment and unread mark",
    );
  if (!(await sameBranch(target, remaining)))
    return refused(
      "the selected notification branch changed or could not be read",
    );
  const comment = card.comment ?? "";
  if (
    target.dispatcherOnly &&
    withoutMarks(comment) !== "" &&
    !holdsNotice(comment)
  )
    return refused("the destination now holds a personal comment");
  return card;
}

/** Only the exact delivered comment, unread mark and selected branch confirm a write. */
async function confirmedReceipt(
  target: NotifyTarget,
  result: unknown,
  expected: string | null,
  remaining: () => number,
): Promise<RuntimeReceipt> {
  const read = cardOf(result);
  if (
    read === null ||
    !read.unread ||
    read.comment !== expected ||
    !(await sameBranch(target, remaining)) ||
    remaining() <= 0
  )
    return {
      ok: false,
      lost: true,
      detail:
        "the read-back did not confirm the delivered comment, unread mark and selected branch",
    };
  return {
    ok: true,
    detail: `${target.path} marked unread with the message as its comment`,
    comment: read.comment ?? "",
    unread: read.unread,
  };
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
 * read is replaced; the message otherwise, behind the dispatched marks. `null` when the unread
 * comment already carries every entry.
 */
function merged(
  card: { comment: string | null; unread: boolean },
  message: string,
  preserveRead: boolean,
): string | null {
  // A notice marker proves presence, not ownership of accompanying text.
  // Named destinations retain read text too, including personal additions.
  if (preserveRead && !card.unread && withoutMarks(card.comment ?? "") !== "")
    return `${card.comment}\n\n${message}`;
  if (
    !card.unread ||
    card.comment === null ||
    withoutMarks(card.comment) === ""
  )
    return keepMarks(card.comment ?? "", message);
  const carried = card.comment;
  const missing = entriesOf(message).filter((entry) => {
    const key = keyLineOf(entry);
    return !carried.includes(key ?? entry);
  });
  if (missing.length === 0) return null;
  return `${carried}\n\n${missing.join("\n\n")}`;
}

export async function orcaNotify(
  target: NotifyTarget,
  message: string,
  timeoutMs: number,
  lock: CardLock = withCardLock,
): Promise<RuntimeReceipt> {
  // The read, the write and the read-back hold the card's lock, the one
  // every comment writer takes (`shared/orca-card-lock.ts`), so no writer's
  // read-then-write falls between them.
  let locked: { value: RuntimeReceipt } | null;
  try {
    locked = await withCardDeadline(
      target.path,
      timeoutMs,
      (remaining) => notifyUnlocked(target, message, remaining),
      lock,
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
  target: NotifyTarget,
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
  const card = await destinationCard(target, before.result, remaining);
  if ("ok" in card) return card;
  const merge = merged(card, message, target.dispatcherOnly === true);
  if (merge !== null) {
    const comment = argumentSafe(merge);
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
        comment,
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
  const expected = merge === null ? card.comment : argumentSafe(merge);
  return confirmedReceipt(target, shown.result, expected, remaining);
}
