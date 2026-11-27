/**
 * The tracker port's comment facts: a comment as pickup reads it, as the
 * fleet metrics and the claim marker read it (with its author's trust), and
 * as the dispatcher reads a person's answer to a pickup's decision (with its
 * author, its link and its last edit).
 */

/** A user of the tracker: its own id and the name it shows. */
export interface TrackerUser {
  id: string;
  name: string;
}

export interface IssueComment {
  body: string;
  createdAt?: string;
  /** The author's login (the name the tracker shows, where it has no login); absent when the tracker names none. */
  author?: string;
  /**
   * What the tracker vouches for about the author, in GitHub's
   * `author_association` words: `OWNER`, `MEMBER` and `COLLABORATOR` can write
   * to the repository or belong to the tracker workspace and are trusted
   * (`shared/trusted-authors.ts` decides); another word (`NONE`, `GUEST`) is
   * not. A tracker without the notion gives its nearest equivalent, and
   * `UNKNOWN` when it cannot say.
   */
  authorAssociation?: string;
}

/** The association of a comment whose author the tracker cannot vouch for. */
export const UNKNOWN_ASSOCIATION = "UNKNOWN";

export interface CommentFact {
  /** The tracker's own id for the comment, which `deleteComment` takes. */
  id?: string;
  body: string;
  createdAt: string;
  /**
   * The author is a real, non-guest member of the tracker workspace. Only a
   * trusted comment may carry a marker the metrics act on: anyone able to
   * comment could otherwise post a marker-shaped line.
   */
  trusted: boolean;
  /** The author's association in `IssueComment.authorAssociation`'s words, where the adapter reads it. */
  association?: string;
  /**
   * Who wrote the comment, where the adapter names comment authors
   * (`Tracker.commentAuthors`); `null` when the tracker names no user (a
   * deleted account, an integration). Absent from an adapter that cannot
   * name one.
   */
  author?: TrackerUser | null;
  /** A link a person opens to read the comment; absent when the tracker gives none. */
  url?: string;
  /** When the comment was last edited; `null` or absent when it never was. */
  editedAt?: string | null;
}

/** A comment found by a text search, with the issue it sits on. */
export interface FoundComment extends CommentFact {
  issue: string;
}

/** Every comment on one issue, and the tracker id to post a reply to. */
export interface IssueComments {
  uuid: string;
  comments: CommentFact[];
}
