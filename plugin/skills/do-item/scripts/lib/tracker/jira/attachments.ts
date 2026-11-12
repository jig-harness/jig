/**
 * The Jira adapter's attachments: Jira Cloud's own file store. A file is
 * uploaded to the issue (`POST issue/{key}/attachments`, a multipart form
 * with Jira's no-check header), listed from the issue's `attachment` field,
 * removed with `DELETE attachment/{id}` and read from
 * `attachment/content/{id}`. Jira keeps no title or subtitle for an
 * attachment, only its file name, which therefore stands as its title.
 * A file the caller hosts elsewhere (`url`) is uploaded all the same.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import {
  attachmentOf,
  type IssueAttachment,
  type TrackerAttachments,
} from "../attachment.ts";
import { JiraApiError, type JiraTransport } from "./transport.ts";

const path = (key: string) => `issue/${encodeURIComponent(key)}`;

/** An attachment as Jira answers it. */
export function attachmentOfJira(v: unknown, where: string): IssueAttachment {
  if (!isRecord(v) || (typeof v.id !== "string" && typeof v.id !== "number"))
    throw new JiraApiError(`${where}: an attachment without an id`);
  const filename = typeof v.filename === "string" ? v.filename : "";
  return {
    id: String(v.id),
    title: filename,
    subtitle: null,
    filename,
    url: typeof v.content === "string" ? v.content : null,
    form: "upload",
    createdAt: typeof v.created === "string" ? v.created : null,
  };
}

/** The Jira adapter's attachment operations. */
export function jiraAttachments(transport: JiraTransport): TrackerAttachments {
  async function list(
    key: string,
    signal?: AbortSignal,
  ): Promise<IssueAttachment[]> {
    const issue = await transport(
      { method: "GET", path: path(key), query: { fields: "attachment" } },
      signal,
    );
    const fields = isRecord(issue) ? issue.fields : null;
    const items = isRecord(fields) ? fields.attachment : undefined;
    if (!Array.isArray(items))
      throw new JiraApiError(`issue ${key}: its attachments could not be read`);
    return items.map((a, i) =>
      attachmentOfJira(a, `attachments of ${key}[${i}]`),
    );
  }
  const missing = (message: string) =>
    new JiraApiError(message, { status: 404, notFound: true });

  return {
    listAttachments: list,

    async attachFile(key, file, signal) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([file.bytes], { type: file.contentType }),
        file.filename,
      );
      const answer = await transport(
        { method: "POST", path: `${path(key)}/attachments`, form },
        signal,
      );
      if (!Array.isArray(answer) || answer.length !== 1)
        throw new JiraApiError(
          `Jira answered the upload of ${file.filename} to ${key} with no single attachment`,
        );
      return attachmentOfJira(answer[0], `the upload of ${file.filename}`);
    },

    async removeAttachment(key, id, signal) {
      attachmentOf(await list(key, signal), key, id, missing);
      await transport(
        { method: "DELETE", path: `attachment/${encodeURIComponent(id)}` },
        signal,
      );
    },

    async readAttachment(key, id, signal) {
      attachmentOf(await list(key, signal), key, id, missing);
      const bytes = await transport(
        {
          method: "GET",
          path: `attachment/content/${encodeURIComponent(id)}`,
          // The content itself, not a redirect: the transport follows none.
          query: { redirect: false },
          bytes: true,
        },
        signal,
      );
      if (!(bytes instanceof Uint8Array))
        throw new JiraApiError(`attachment ${id} of ${key}: no content`);
      return bytes;
    },
  };
}
