/**
 * `notify` on Orca: the workspace's comment set to the message and the
 * workspace marked unread, in one call (`orca worktree set --worktree
 * path:<path> --comment <message> --unread`), which Orca's phone app shows
 * as an unread workspace with its comment. The comment is read first
 * (`orca worktree show`), so the dispatched marks it holds stay in the one
 * written (`keepMarks`), and read back after: that read is the receipt, and
 * the tick counts a message as sent only once it finds the message's key in
 * it. The whole sequence runs under one deadline, each call under what is
 * left of it; an answer past it is lost.
 */
import { call, readComment } from "./orca-comment.ts";
import { keepMarks, type RuntimeReceipt } from "./port.ts";

export async function orcaNotify(
  target: { id: string; path: string },
  message: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const until = Date.now() + timeoutMs;
  const left = () => until - Date.now();
  const expired = (detail: string): RuntimeReceipt => ({
    ok: false,
    lost: true,
    detail,
  });
  const before = await readComment(target.path, left());
  if ("why" in before)
    return {
      ok: false,
      lost: before.lost,
      detail: `nothing was written: the comment could not be read first, to keep its marks: ${before.why}`,
    };
  if (left() <= 0)
    return expired("nothing was written: the notify deadline passed");
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
    left(),
  );
  if (!set.ok) return { ok: false, lost: set.lost, detail: set.why };
  if (left() <= 0)
    return expired(
      "the comment was written, and could not be read back before the deadline",
    );
  const shown = await readComment(target.path, left());
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
