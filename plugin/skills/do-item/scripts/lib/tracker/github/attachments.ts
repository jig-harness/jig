/**
 * The GitHub adapter's attachments. GitHub Issues has no API to upload a
 * file to an issue, and the adapter publishes nothing outside the issue
 * (no gist, no commit, no other host), so it holds a file in one of two
 * forms, each a comment that opens with a marker line naming the file:
 *
 * - `comment`: a text file whose comment fits GitHub's comment limit
 *   (`GITHUB_COMMENT_LIMIT` characters) is carried in it, in a collapsed
 *   block a reader saves as the file. The marker records its size, so a
 *   comment changed since is read as changed, never as the file.
 * - `link`: given the address of a copy the caller already hosts (`url`), the
 *   comment links it.
 *
 * Any other file, a binary one or a text one too long for a comment with no
 * `url`, is refused (`AttachmentRefused`) with nothing written. Only a marked
 * comment by a trusted author (one who can write to the repository, or the
 * credential's own) counts as an attachment.
 */

import {
  AttachmentRefused,
  attachmentOf,
  type AttachmentFile,
  type IssueAttachment,
  type TrackerAttachments,
} from "../attachment.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
import { attempt } from "../../../../../../shared/outcome.ts";
import type { Client } from "./client.ts";
import { PAGE, record, str } from "./read.ts";
import { GitHubApiError, pageAll } from "./transport.ts";

/** The most characters GitHub takes in one comment's body. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** The first line of every comment that holds an attachment. */
export const ATTACHMENT_MARKER = "<!-- jig:attachment ";

const COMMENTS = `
query TrackerAttachmentComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id url body createdAt authorAssociation viewerDidAuthor }
      }
    }
  }
}`;

export const ATTACH_COMMENT = `mutation TrackerAttachComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge { node { id url createdAt } }
  }
}`;

const DELETE_COMMENT = `mutation TrackerDeleteAttachment($id: ID!) {
  deleteIssueComment(input: { id: $id }) { clientMutationId }
}`;

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** What the marker line records. */
interface Marker {
  form: "comment" | "link";
  title: string;
  subtitle?: string;
  filename: string;
  contentType: string;
  /** The carried file's size in bytes. */
  size?: number;
  url?: string;
}

/** Media types whose files are text a comment can carry. */
export function isTextType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    /^application\/(json|xml|javascript|yaml|x-yaml)$/.test(type) ||
    /\+(xml|json)$/.test(type)
  );
}

/** Markdown-inert text: every character that could start markup is escaped. */
function inert(text: string): string {
  return text.replace(/[\\`*_<>[\]()#!|~]/g, (c) => `\\${c}`);
}

function markerLine(marker: Marker): string {
  // `<` and `>` escaped, so the JSON can never end the HTML comment early.
  const json = JSON.stringify(marker)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `${ATTACHMENT_MARKER}${json} -->`;
}

function headline(file: AttachmentFile, name: string): string {
  const subtitle =
    file.subtitle === undefined ? "" : ` ${inert(file.subtitle)}.`;
  return `**Attached file: ${name}** (${inert(file.title)}).${subtitle}`;
}

/** The comment carrying a text file, whatever its length. */
export function carriedBody(file: AttachmentFile, text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  const lang = /\.html?$/i.test(file.filename) ? "html" : "";
  const open = /\.html?$/i.test(file.filename)
    ? ", then open it in a browser"
    : "";
  return [
    markerLine({
      form: "comment",
      title: file.title,
      ...(file.subtitle === undefined ? {} : { subtitle: file.subtitle }),
      filename: file.filename,
      contentType: file.contentType,
      size: file.bytes.byteLength,
    }),
    headline(file, inert(file.filename)),
    "",
    `GitHub Issues stores no uploaded file, so the file's text is below. Save it as ${inert(file.filename)}${open}.`,
    "",
    `<details><summary>${inert(file.filename)}</summary>`,
    "",
    `${fence}${lang}`,
    text,
    fence,
    "",
    "</details>",
    "",
  ].join("\n");
}

/** The comment linking a copy hosted at `url`. */
export function linkBody(file: AttachmentFile, url: string): string {
  return [
    markerLine({
      form: "link",
      title: file.title,
      ...(file.subtitle === undefined ? {} : { subtitle: file.subtitle }),
      filename: file.filename,
      contentType: file.contentType,
      url,
    }),
    headline(file, `[${inert(file.filename)}](<${url}>)`),
    "",
  ].join("\n");
}

/** The comment that holds `file`, or why GitHub Issues cannot hold it. */
export function attachmentBody(file: AttachmentFile): string {
  if (file.url !== undefined) {
    let url: URL;
    try {
      url = new URL(file.url);
    } catch {
      throw new AttachmentRefused(`'${file.url}' is not an address`);
    }
    if (url.protocol !== "https:")
      throw new AttachmentRefused(
        `${file.url} is not an https address; GitHub Issues links only one`,
      );
    return linkBody(file, url.toString());
  }
  const noUpload = "GitHub Issues has no API to upload a file to an issue";
  const decoded = isTextType(file.contentType)
    ? attempt("binary", file.filename, () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          file.bytes,
        ),
      )
    : null;
  const text = decoded?.ok === true ? decoded.value : null;
  if (text === null || text.includes("\u0000"))
    throw new AttachmentRefused(
      `${noUpload}, and ${file.filename} (${file.contentType}) is not text a comment can carry: pass the address of a copy already hosted as url to link it`,
    );
  const body = carriedBody(file, text);
  if (body.length > GITHUB_COMMENT_LIMIT)
    throw new AttachmentRefused(
      `${noUpload}, and ${file.filename} needs a comment of ${body.length} characters, over GitHub's limit of ${GITHUB_COMMENT_LIMIT}: pass the address of a copy already hosted as url to link it`,
    );
  return body;
}

/** The marker of a comment body, `null` when it holds no attachment. */
export function markerOf(body: string): Marker | null {
  if (!body.startsWith(ATTACHMENT_MARKER)) return null;
  const end = body.indexOf(" -->");
  if (end === -1) return null;
  const read = attempt("unreadable", "the attachment marker", (): unknown =>
    JSON.parse(body.slice(ATTACHMENT_MARKER.length, end)),
  );
  const m = read.ok ? read.value : null;
  if (
    !isRecord(m) ||
    (m.form !== "comment" && m.form !== "link") ||
    typeof m.title !== "string" ||
    typeof m.filename !== "string"
  )
    return null;
  return m as unknown as Marker;
}

/** The file a carrying comment holds; throws when the comment changed since. */
export function carriedBytes(body: string, marker: Marker): Uint8Array {
  const openAt = body.search(/^`{3,}/m);
  const fence = openAt === -1 ? null : /^`+/.exec(body.slice(openAt));
  const close = fence === null ? -1 : body.lastIndexOf(`\n${fence[0]}\n`);
  const start = body.indexOf("\n", openAt) + 1;
  if (fence === null || close < start - 1)
    throw new GitHubApiError(
      `the comment carrying ${marker.filename} has no file block`,
    );
  const bytes = new TextEncoder().encode(body.slice(start, close));
  if (bytes.byteLength !== marker.size)
    throw new GitHubApiError(
      `the comment carrying ${marker.filename} changed since it was attached (${bytes.byteLength} bytes, not ${marker.size})`,
    );
  return bytes;
}

interface Held {
  attachment: IssueAttachment;
  marker: Marker;
  body: string;
}

function heldOf(node: Record<string, unknown>, where: string): Held | null {
  const body = str(node.body, `${where}.body`);
  const marker = markerOf(body);
  const trusted =
    TRUSTED.has(String(node.authorAssociation)) ||
    node.viewerDidAuthor === true;
  if (marker === null || !trusted) return null;
  return {
    marker,
    body,
    attachment: {
      id: str(node.id, `${where}.id`),
      title: marker.title,
      subtitle: marker.subtitle ?? null,
      filename: marker.filename,
      url:
        marker.form === "link"
          ? (marker.url ?? null)
          : typeof node.url === "string"
            ? node.url
            : null,
      form: marker.form,
      createdAt: typeof node.createdAt === "string" ? node.createdAt : null,
    },
  };
}

/** The GitHub adapter's attachment operations. */
export function gitHubAttachments(client: Client): TrackerAttachments {
  async function held(key: string, signal?: AbortSignal): Promise<Held[]> {
    const ref = client.ref(key);
    const nodes = await pageAll(
      client.transport,
      COMMENTS,
      { owner: ref.owner, name: ref.name, number: ref.number },
      (d) =>
        record(record(d.repository, "repository").issue, `issue ${key}`)
          .comments,
      `comments of ${key}`,
      signal,
    );
    return nodes.flatMap((n, i) => {
      const h = heldOf(
        record(n, `comments of ${key}[${i}]`),
        `comments of ${key}[${i}]`,
      );
      return h === null ? [] : [h];
    });
  }
  const missing = (message: string) =>
    new GitHubApiError(message, { notFound: true });
  async function one(key: string, id: string, signal?: AbortSignal) {
    const all = await held(key, signal);
    const a = attachmentOf(
      all.map((h) => h.attachment),
      key,
      id,
      missing,
    );
    return all.find((h) => h.attachment === a) as Held;
  }

  return {
    async listAttachments(key, signal) {
      return (await held(key, signal)).map((h) => h.attachment);
    },

    async attachFile(key, file, signal) {
      const body = attachmentBody(file);
      const subjectId = (await client.mustIssue(key, signal)).id;
      const data = record(
        await client.transport(ATTACH_COMMENT, { subjectId, body }, signal),
        "data",
      );
      const node = record(
        record(
          record(data.addComment, "addComment").commentEdge,
          "addComment.commentEdge",
        ).node,
        "addComment.commentEdge.node",
      );
      const h = heldOf(
        { ...node, body, viewerDidAuthor: true },
        "addComment.commentEdge.node",
      );
      if (h === null)
        throw new GitHubApiError(`the comment on ${key} holds no attachment`);
      return h.attachment;
    },

    async removeAttachment(key, id, signal) {
      await one(key, id, signal);
      await client.transport(DELETE_COMMENT, { id }, signal);
    },

    async readAttachment(key, id, signal) {
      const h = await one(key, id, signal);
      if (h.marker.form === "link")
        throw new AttachmentRefused(
          `attachment ${id} of ${key} links a copy hosted elsewhere: open ${h.marker.url ?? "its address"}`,
        );
      return carriedBytes(h.body, h.marker);
    },
  };
}
