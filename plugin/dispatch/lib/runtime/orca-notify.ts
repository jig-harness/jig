/**
 * `notify` on Orca: the workspace's comment set to the message and the
 * workspace marked unread, in one call (`orca worktree set --worktree
 * path:<path> --comment <message> --unread`), which Orca's phone app shows
 * as an unread workspace with its comment. The comment is read first
 * (`orca worktree show`), so the dispatched marks it holds stay in the one
 * written (`keepMarks`), and read back after: that read is the receipt, and
 * the tick counts a message as sent only once it finds the message's key in
 * it. Each call runs under the runtime's deadline; an answer past it is
 * lost.
 */
import { call, readComment } from "./orca-comment.ts";
import { keepMarks, type RuntimeReceipt } from "./port.ts";

export async function orcaNotify(
  target: { id: string; path: string },
  message: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const before = await readComment(target.path, timeoutMs);
  if ("why" in before)
    return {
      ok: false,
      lost: before.lost,
      detail: `nothing was written: the comment could not be read first, to keep its marks: ${before.why}`,
    };
  const set = await call(
    [
      "worktree",
      "set",
      "--worktree",
      `path:${target.path}`,
      "--comment",
      keepMarks(before.comment, message),
      "--unread",
    ],
    timeoutMs,
  );
  if (!set.ok) return { ok: false, lost: set.lost, detail: set.why };
  const shown = await readComment(target.path, timeoutMs);
  if ("why" in shown)
    return {
      ok: false,
      lost: true,
      detail: `the comment was written, and could not be read back: ${shown.why}`,
    };
  return {
    ok: true,
    detail: `${target.path} marked unread with the message as its comment`,
    comment: shown.comment,
  };
}
