/**
 * The Linear adapter's attachments. A file goes to Linear's own file store:
 * `fileUpload` returns a signed address and the headers to send, the bytes
 * go there with `PUT`, and `attachmentCreate` attaches the stored file
 * (its asset address) to the issue with the title and subtitle. The file's
 * name and media type travel in the attachment's metadata, since Linear's
 * attachment has no field for them. Reading a stored file back needs the API
 * key (`LINEAR_API_KEY`): Linear serves its uploads only to a signed-in
 * request. An attachment whose address is anywhere else is a link.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import {
  AttachmentRefused,
  attachmentOf,
  type IssueAttachment,
  type TrackerAttachments,
} from "./attachment.ts";
import { pager } from "./graphql.ts";
import { record, ShapeError, str } from "./linear-shapes.ts";
import {
  LINEAR_TIMEOUT_MS,
  LinearApiError,
  type LinearTransport,
  resolveLinearToken,
} from "./linear-transport.ts";

/** The host Linear stores uploaded files on; only it is sent the API key. */
export const LINEAR_UPLOAD_HOST = "uploads.linear.app";

const PAGE = 100;

const ATTACHMENT_FIELDS = "id title subtitle url createdAt metadata";

export const ATTACHMENTS_QUERY = `
query TrackerAttachments($id: String!, $after: String) {
  issue(id: $id) {
    attachments(first: ${PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ATTACHMENT_FIELDS} }
    }
  }
}`;

export const FILE_UPLOAD_MUTATION = `
mutation TrackerFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

export const ATTACHMENT_CREATE_MUTATION = `
mutation TrackerAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment { ${ATTACHMENT_FIELDS} }
  }
}`;

export const ATTACHMENT_DELETE_MUTATION = `
mutation TrackerAttachmentDelete($id: String!) {
  attachmentDelete(id: $id) { success }
}`;

/** The two requests to Linear's file store, which do not go through GraphQL. */
export interface LinearFiles {
  /** Send the bytes to a signed upload address with exactly these headers. */
  put(
    url: string,
    headers: Record<string, string>,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void>;
  /** The bytes of a file Linear stores, read with the API key. */
  get(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

function bounded(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(LINEAR_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** Linear's file store over HTTPS; `token` is the API key, `null` when only the client holds one. */
export function linearFiles(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): LinearFiles {
  return {
    async put(url, headers, bytes, signal) {
      const res = await fetchImpl(url, {
        method: "PUT",
        headers,
        body: bytes,
        signal: bounded(signal),
      });
      if (!res.ok)
        throw new LinearApiError(
          `Linear's file store refused the upload (HTTP ${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`,
          res.status,
        );
    },
    async get(url, signal) {
      if (new URL(url).hostname !== LINEAR_UPLOAD_HOST)
        throw new LinearApiError(
          `${url} is not a file Linear stores; it is not sent the API key`,
          null,
        );
      if (token === null)
        throw new LinearApiError(
          "reading a file Linear stores needs an API key: set LINEAR_API_KEY (or LINEAR_API_TOKEN)",
          null,
        );
      const res = await fetchImpl(url, {
        headers: { Authorization: token },
        redirect: "error",
        signal: bounded(signal),
      });
      if (!res.ok)
        throw new LinearApiError(
          `Linear's file store answered HTTP ${res.status} for ${url}`,
          res.status,
        );
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

const pageAll = pager({
  idOf: (node) => node.id,
  fail: (message) => new ShapeError(message),
});

function succeeded(payload: unknown, what: string): Record<string, unknown> {
  if (!isRecord(payload) || payload.success !== true)
    throw new LinearApiError(
      `Linear reported that ${what} did not succeed`,
      200,
    );
  return payload;
}

/** An attachment node as Linear answers it. */
export function attachmentOfNode(v: unknown, where: string): IssueAttachment {
  const n = record(v, where);
  const url = typeof n.url === "string" ? n.url : null;
  const meta = isRecord(n.metadata) ? n.metadata : {};
  let host = "";
  try {
    host = url === null ? "" : new URL(url).hostname;
  } catch {
    // An address Linear keeps but `URL` cannot parse is a plain link.
  }
  return {
    id: str(n.id, `${where}.id`),
    title: typeof n.title === "string" ? n.title : "",
    subtitle: typeof n.subtitle === "string" ? n.subtitle : null,
    filename: typeof meta.filename === "string" ? meta.filename : null,
    url,
    form: host === LINEAR_UPLOAD_HOST ? "upload" : "link",
    createdAt: typeof n.createdAt === "string" ? n.createdAt : null,
  };
}

/** The Linear adapter's attachment operations. */
export function linearAttachments(
  transport: LinearTransport,
  given: LinearFiles | undefined,
  issueId: (key: string, signal?: AbortSignal) => Promise<string>,
): TrackerAttachments {
  async function list(
    key: string,
    signal?: AbortSignal,
  ): Promise<IssueAttachment[]> {
    const nodes = await pageAll(
      transport,
      ATTACHMENTS_QUERY,
      { id: key },
      (d) => record(d.issue, `issue ${key}`).attachments,
      `attachments of ${key}`,
      signal,
    );
    return nodes.map((n, i) =>
      attachmentOfNode(n, `attachments of ${key}[${i}]`),
    );
  }
  const missing = (message: string) => new LinearApiError(message, null, true);
  const files = given ?? linearFiles(resolveLinearToken());

  return {
    listAttachments: list,

    async attachFile(key, file, signal) {
      const id = await issueId(key, signal);
      const upload = succeeded(
        record(
          await transport(
            FILE_UPLOAD_MUTATION,
            {
              contentType: file.contentType,
              filename: file.filename,
              size: file.bytes.byteLength,
            },
            signal,
          ),
          "data",
        ).fileUpload,
        `preparing the upload of ${file.filename}`,
      );
      const target = record(upload.uploadFile, "fileUpload.uploadFile");
      const headers: Record<string, string> = {
        "Content-Type": file.contentType,
        "Cache-Control": "public, max-age=31536000",
      };
      if (Array.isArray(target.headers))
        for (const h of target.headers)
          if (isRecord(h) && typeof h.key === "string")
            headers[h.key] = String(h.value ?? "");
      await files.put(
        str(target.uploadUrl, "fileUpload.uploadFile.uploadUrl"),
        headers,
        file.bytes,
        signal,
      );
      const created = succeeded(
        record(
          await transport(
            ATTACHMENT_CREATE_MUTATION,
            {
              input: {
                issueId: id,
                title: file.title,
                ...(file.subtitle === undefined
                  ? {}
                  : { subtitle: file.subtitle }),
                url: str(target.assetUrl, "fileUpload.uploadFile.assetUrl"),
                metadata: {
                  filename: file.filename,
                  contentType: file.contentType,
                  size: file.bytes.byteLength,
                },
              },
            },
            signal,
          ),
          "data",
        ).attachmentCreate,
        `attaching ${file.filename} to ${key}`,
      );
      return attachmentOfNode(
        created.attachment,
        "attachmentCreate.attachment",
      );
    },

    async removeAttachment(key, id, signal) {
      attachmentOf(await list(key, signal), key, id, missing);
      succeeded(
        record(
          await transport(ATTACHMENT_DELETE_MUTATION, { id }, signal),
          "data",
        ).attachmentDelete,
        `removing attachment ${id} from ${key}`,
      );
    },

    async readAttachment(key, id, signal) {
      const a = attachmentOf(await list(key, signal), key, id, missing);
      if (a.form !== "upload" || a.url === null)
        throw new AttachmentRefused(
          `attachment ${id} of ${key} is a link, not a file Linear stores: open ${a.url ?? "its address"}`,
        );
      return files.get(a.url, signal);
    },
  };
}
