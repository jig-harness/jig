/**
 * An issue carries one decision sheet, attached under a title that names
 * the issue (`SHEET_ATTACHMENT_TITLE_PREFIX` and its key). A regenerated sheet
 * is attached with `/jig:do-item`'s `tracker.ts attach` and its `replace`
 * option, which removes the older sheet of the same file name or title only
 * once the issue lists the new one.
 */
import { SHEET_ATTACHMENT_TITLE_PREFIX } from "./labels.ts";

export function sheetAttachmentTitle(issueId: string): string {
  return `${SHEET_ATTACHMENT_TITLE_PREFIX}${issueId}`;
}
