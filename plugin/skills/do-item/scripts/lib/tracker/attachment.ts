/**
 * Files attached to an issue: what the tracker port says of them, and the
 * one rule every adapter's caller follows when a new file replaces older
 * ones.
 *
 * Each adapter holds a file the way its tracker offers. Linear and Jira
 * upload it; GitHub Issues, which has no API to upload a file to an issue,
 * carries a text file that fits in one comment inside a marked comment, or
 * links a copy the caller has already hosted. `form` says which. When the
 * tracker can hold the file in none of those ways, `attachFile` throws
 * `AttachmentRefused` and writes nothing.
 */
import { isRateLimited } from "../../../../../shared/outbound/budget.ts";

/** A file to attach to an issue. */
export interface AttachmentFile {
  /** The file's name, as a reader saves it. */
  filename: string;
  /** Its media type, such as `text/html`. */
  contentType: string;
  bytes: Uint8Array;
  /** What the issue shows it as. Jira keeps no title: its attachments are known by file name. */
  title: string;
  subtitle?: string;
  /**
   * An address where a copy of the file is already hosted. Only an adapter
   * that cannot carry the file itself (GitHub Issues) uses it, and links it.
   */
  url?: string;
}

/**
 * How the tracker holds an attachment: `upload`, the tracker's own file
 * store; `comment`, the file's text inside a marked comment; `link`, a link
 * to a copy hosted elsewhere.
 */
export type AttachmentForm = "upload" | "comment" | "link";

/** One attachment of an issue. */
export interface IssueAttachment {
  /** The tracker's id for it: what `removeAttachment` and `readAttachment` take. */
  id: string;
  /** Its title; on Jira, its file name. */
  title: string;
  subtitle: string | null;
  /** Its file name; `null` when the tracker did not record one (a plain link). */
  filename: string | null;
  /** Where a person opens it; may need the tracker's sign-in. */
  url: string | null;
  form: AttachmentForm;
  createdAt: string | null;
}

/**
 * The tracker cannot hold this file in any form it offers. Nothing was
 * written; `reason` says why and what would make it fit.
 */
export class AttachmentRefused extends Error {}

/** The tracker port's attachment operations, part of `Tracker`. */
export interface TrackerAttachments {
  /** Every file attached to an issue, in the form each adapter holds it. */
  listAttachments(
    key: string,
    signal?: AbortSignal,
  ): Promise<IssueAttachment[]>;
  /**
   * Attach a file to an issue; resolves to the attachment as
   * `listAttachments` lists it. Throws `AttachmentRefused`, having written
   * nothing, when the tracker can hold the file in no form it offers.
   */
  attachFile(
    key: string,
    file: AttachmentFile,
    signal?: AbortSignal,
  ): Promise<IssueAttachment>;
  /** Remove an attachment of the issue; throws when the issue has none with that id. */
  removeAttachment(
    key: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * The bytes of an attachment of the issue. Throws `AttachmentRefused` for
   * one the tracker only links: its bytes are wherever the link points.
   */
  readAttachment(
    key: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

/** What `attachReplacing` did. */
export interface AttachResult {
  attachment: IssueAttachment;
  /** Older attachments removed: the same file name or title as the new one. */
  removed: string[];
  /** Older attachments left in place, each with the reason. */
  kept: Array<{ id: string; reason: string; failed?: true }>;
}

/** Whether an older attachment is one the new one replaces. */
export function replacedBy(
  newer: IssueAttachment,
  older: IssueAttachment,
  titlePrefix?: string,
): boolean {
  if (older.id === newer.id) return false;
  return (
    (newer.filename !== null && older.filename === newer.filename) ||
    older.title === newer.title ||
    (titlePrefix !== undefined &&
      titlePrefix !== "" &&
      older.title.startsWith(titlePrefix))
  );
}

/**
 * Attach `file` to the issue, then, with `replace`, remove every older
 * attachment with the same file name or the same title, or whose title starts
 * with `titlePrefix` (a sheet whose name carries a key that can change). Only
 * attachments the issue listed before this call are removed, so two
 * concurrent replacements never remove each other's new attachment (two that overlap may each leave their own, since the tracker offers no cross-process lock). The new attachment
 * comes first, so a failed upload never leaves the issue without one; and an
 * older one is removed only once the issue lists the new one, so a new
 * attachment the tracker does not show yet never leaves it with none.
 */
export async function attachReplacing(
  tracker: Pick<
    TrackerAttachments,
    "attachFile" | "listAttachments" | "removeAttachment"
  >,
  key: string,
  file: AttachmentFile,
  replace: boolean,
  signal?: AbortSignal,
  titlePrefix?: string,
): Promise<AttachResult> {
  const before = replace
    ? new Set((await tracker.listAttachments(key, signal)).map((a) => a.id))
    : new Set<string>();
  const attachment = await tracker.attachFile(key, file, signal);
  const result: AttachResult = { attachment, removed: [], kept: [] };
  if (!replace) return result;
  const listed = await tracker.listAttachments(key, signal);
  const older = listed.filter(
    (a) => before.has(a.id) && replacedBy(attachment, a, titlePrefix),
  );
  if (!listed.some((a) => a.id === attachment.id)) {
    result.kept = older.map((a) => ({
      id: a.id,
      reason: `the new attachment ${attachment.id} is not listed on ${key}; older ones stay until it is`,
    }));
    return result;
  }
  for (const a of older) {
    try {
      await tracker.removeAttachment(key, a.id, signal);
      result.removed.push(a.id);
    } catch (err) {
      // A cancelled or rate-limited call is not a row to keep: let it stop
      // the operation with its own exit code.
      if (signal?.aborted === true || isRateLimited(err)) throw err;
      result.kept.push({
        id: a.id,
        reason: err instanceof Error ? err.message : String(err),
        failed: true,
      });
    }
  }
  return result;
}

/** The attachment of the issue with this id; throws naming the issue when it has none. */
export function attachmentOf(
  listed: ReadonlyArray<IssueAttachment>,
  key: string,
  id: string,
  fail: (message: string) => Error,
): IssueAttachment {
  const found = listed.find((a) => a.id === id);
  if (found === undefined) throw fail(`${key} has no attachment ${id}`);
  return found;
}
