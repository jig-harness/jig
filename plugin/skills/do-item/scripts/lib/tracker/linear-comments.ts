/**
 * An issue's comments as the Linear adapter reads them: each node checked,
 * its author named and its trust read, and the list put in creation order,
 * the id breaking a tie, so that every reader of one issue lists its
 * comments alike (the claim marker's earliest-wins rule rests on it).
 */

import { isRecord } from "../../../../../shared/guards.ts";
import { ShapeError } from "./linear-shapes.ts";
import type { CommentFact, TrackerUser } from "./port.ts";
import { parseMs } from "../../../../../shared/time.ts";

/**
 * Every comment of an issue, a hundred to a page. The author's name, the
 * comment's link and its last edit ride in the same request, so a reader
 * of a person's answer needs no second one.
 */
export const COMMENTS_QUERY = `
query TrackerComments($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id url body createdAt editedAt user { id name guest } }
    }
  }
}`;

/** A comment's author counts when it is a real, non-guest member of the workspace. */
export function trustedUser(u: unknown): boolean {
  return isRecord(u) && typeof u.id === "string" && u.guest === false;
}

/** The user a comment names, or `null` for one an integration wrote or whose account is gone. */
function authorOf(u: unknown): TrackerUser | null {
  if (!isRecord(u) || typeof u.id !== "string" || u.id === "") return null;
  return {
    id: u.id,
    name: typeof u.name === "string" && u.name !== "" ? u.name : u.id,
  };
}

/** The comment nodes of issue `key`, checked and in creation order. */
export function commentFacts(nodes: unknown[], key: string): CommentFact[] {
  const comments = nodes.map((c): CommentFact => {
    // A dropped comment could be the one carrying a marker.
    if (
      !isRecord(c) ||
      typeof c.body !== "string" ||
      typeof c.createdAt !== "string" ||
      !Number.isFinite(parseMs(c.createdAt))
    )
      throw new ShapeError(`issue ${key}: an unreadable comment node`);
    return {
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      body: c.body,
      createdAt: c.createdAt,
      trusted: trustedUser(c.user),
      author: authorOf(c.user),
      ...(typeof c.url === "string" && c.url !== "" ? { url: c.url } : {}),
      // A supplied but malformed edit time is kept as written so the answer
      // reader rejects the comment; only an absent one reads as never edited.
      editedAt: typeof c.editedAt === "string" ? c.editedAt : null,
    };
  });
  return comments.sort(
    (a, b) =>
      parseMs(a.createdAt) - parseMs(b.createdAt) ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
}
