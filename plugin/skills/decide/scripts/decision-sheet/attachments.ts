/**
 * An issue carries exactly one decision sheet. A regenerated sheet is attached
 * first, then every older sheet attachment is deleted, so a failed upload
 * never leaves the issue with no sheet and a stale recommendation never stays
 * beside the current one.
 */
import { SHEET_ATTACHMENT_TITLE_PREFIX } from "./labels.ts";

export interface AttachmentRow {
  id: string;
  title?: string | null;
}

export function sheetAttachmentTitle(issueId: string): string {
  return `${SHEET_ATTACHMENT_TITLE_PREFIX}${issueId}`;
}

export function isSheetAttachment(row: AttachmentRow): boolean {
  return (
    typeof row.title === "string" &&
    row.title.startsWith(SHEET_ATTACHMENT_TITLE_PREFIX)
  );
}

/**
 * The sheet attachments to delete once `keepId` is attached. Throws when
 * `keepId` is not in the list: then the new sheet is not confirmed on the
 * issue, and deleting the old one could leave none.
 */
export function staleSheetAttachments(
  rows: AttachmentRow[],
  keepId: string,
): string[] {
  const keep = rows.find((row) => row.id === keepId);
  if (!keep)
    throw new Error(
      `attachment ${keepId} is not on the issue; refusing to delete older sheets`,
    );
  if (!isSheetAttachment(keep))
    throw new Error(
      `attachment ${keepId} is not titled "${SHEET_ATTACHMENT_TITLE_PREFIX}…"; refusing to delete older sheets`,
    );
  return rows
    .filter((row) => row.id !== keepId && isSheetAttachment(row))
    .map((row) => row.id);
}
