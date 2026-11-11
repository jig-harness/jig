/**
 * An issue's comments as the Linear adapter reads them: each node checked,
 * its author's trust read, and the list put in creation order, the id
 * breaking a tie, so that every reader of one issue lists its comments
 * alike (the claim marker's earliest-wins rule rests on it).
 */

import { isRecord } from "../../../../../shared/guards.ts";
import { ShapeError } from "./linear-shapes.ts";
import type { CommentFact } from "./port.ts";

/** A comment's author counts when it is a real, non-guest member of the workspace. */
export function trustedUser(u: unknown): boolean {
  return isRecord(u) && typeof u.id === "string" && u.guest === false;
}

/** The comment nodes of issue `key`, checked and in creation order. */
export function commentFacts(nodes: unknown[], key: string): CommentFact[] {
  const comments = nodes.map((c): CommentFact => {
    // A dropped comment could be the one carrying a marker.
    if (
      !isRecord(c) ||
      typeof c.body !== "string" ||
      typeof c.createdAt !== "string" ||
      !Number.isFinite(Date.parse(c.createdAt))
    )
      throw new ShapeError(`issue ${key}: an unreadable comment node`);
    return {
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      body: c.body,
      createdAt: c.createdAt,
      trusted: trustedUser(c.user),
    };
  });
  return comments.sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
      (a.id ?? "").localeCompare(b.id ?? ""),
  );
}
