import { keepMarks, withoutMarks } from "./port.ts";

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
export function noticeComment(
  card: { comment: string | null; unread: boolean },
  message: string,
  preserveRead: boolean,
): string | null {
  // A notice marker proves presence, not ownership of accompanying text.
  // Only an exact ownership snapshot lets a named destination replace read text.
  if (preserveRead && !card.unread && withoutMarks(card.comment ?? "") !== "")
    return argumentSafe(`${card.comment}\n\n${message}`);
  if (
    !card.unread ||
    card.comment === null ||
    withoutMarks(card.comment) === ""
  )
    return argumentSafe(keepMarks(card.comment ?? "", message));
  const carried = card.comment;
  const missing = entriesOf(message).filter((entry) => {
    const key = keyLineOf(entry);
    return !carried.includes(key ?? entry);
  });
  if (missing.length === 0) return null;
  return argumentSafe(`${carried}\n\n${missing.join("\n\n")}`);
}
