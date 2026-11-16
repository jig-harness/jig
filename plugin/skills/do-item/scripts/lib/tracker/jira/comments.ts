/**
 * One Jira comment as the client reads it from the issue's comment list:
 * its body as Markdown, when it was written and last edited, and its author
 * as Jira names it, all from the one list request.
 */
import { isRecord } from "../../../../../../shared/guards.ts";
import { adfToMarkdown } from "./adf.ts";
import type { TrackerUser } from "../comment-port.ts";
import { iso } from "./read.ts";

/** One comment, with its author. */
export interface JiraComment {
  id: string;
  body: string;
  createdAt: string;
  /** When it was last edited; `null` when it never was. */
  editedAt: string | null;
  /** `null` for a deleted account. */
  author: Record<string, unknown> | null;
}

/** Comment `c`, the `i`th of `key`'s list; an edit is a `updated` time later than `created`. */
export function commentOf(
  c: Record<string, unknown>,
  key: string,
  i: number,
): JiraComment {
  const createdAt = iso(c.created, `comments of ${key}[${i}].created`);
  const updated =
    typeof c.updated === "string"
      ? iso(c.updated, `comments of ${key}[${i}].updated`)
      : null;
  return {
    id: String(c.id ?? i),
    body: adfToMarkdown(c.body),
    createdAt,
    editedAt: updated !== null && updated > createdAt ? updated : null,
    author: isRecord(c.author) ? c.author : null,
  };
}

/** The link a person opens to read comment `id` of issue `key` on `site`. */
export function commentUrl(site: string, key: string, id: string): string {
  return `${site}/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(id)}`;
}

/** The user a comment's author names, or `null` for a deleted account or one with no id. */
export function commentAuthor(
  author: Record<string, unknown> | null,
): TrackerUser | null {
  const id = author?.accountId;
  if (typeof id !== "string" || id === "") return null;
  const name = author?.displayName;
  return { id, name: typeof name === "string" && name !== "" ? name : id };
}
