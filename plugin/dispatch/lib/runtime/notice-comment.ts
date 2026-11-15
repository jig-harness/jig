import { keepMarks, withoutMarks } from "./port.ts";

/** The entries a message joins: each opens with its key line. */
function entriesOf(message: string): string[] {
  return message.split(/\n\n(?=\[jig dispatch: )/);
}

/** The key line an entry opens with; `null` for text that has none. */
function keyLineOf(entry: string): string | null {
  return entry.match(/^\[jig dispatch: .*\]$/m)?.[0] ?? null;
}

/** The key an entry's first line names; `null` for text that does not open with a key line. */
function keyOf(entry: string): string | null {
  const first = entry.split("\n", 1)[0] ?? "";
  const found = /^\[jig dispatch: (.*)\]$/.exec(first);
  return found === null ? null : (found[1] as string);
}

/** The keys of the entries a comment holds, in order. */
export function entryKeys(comment: string): string[] {
  return entriesOf(comment)
    .map(keyOf)
    .filter((k): k is string => k !== null);
}

/** The comment without the entries whose key is in `settled`; every other part, marks and text alike, stays as it is. */
function withoutSettled(comment: string, settled: ReadonlySet<string>): string {
  if (settled.size === 0) return comment;
  return entriesOf(comment)
    .filter((entry) => {
      const key = keyOf(entry);
      return key === null || !settled.has(key);
    })
    .join("\n\n");
}

/** Orca reads a value that opens with `-` as a flag of its own. */
function argumentSafe(comment: string): string {
  return comment.startsWith("-") ? `Unread notes:\n${comment}` : comment;
}

/**
 * The comment to write over the card as it is now: the entries it does not
 * carry yet appended to a comment still unread, so nothing a person has not
 * read is replaced; the message otherwise, behind the dispatched marks. `null` when the unread
 * comment already carries every entry. An unread comment the caller knows to
 * be the dispatcher's alone gives up the entries whose key is in `settled`,
 * their causes gone, to make room for the new ones.
 */
export function noticeComment(
  card: { comment: string | null; unread: boolean },
  message: string,
  preserveRead: boolean,
  settled: ReadonlySet<string> = new Set(),
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
  const kept = withoutSettled(carried, settled);
  const added = missing.join("\n\n");
  return argumentSafe(
    withoutMarks(kept) === "" ? keepMarks(kept, added) : `${kept}\n\n${added}`,
  );
}
