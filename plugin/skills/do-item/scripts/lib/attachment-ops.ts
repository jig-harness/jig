/**
 * `tracker.ts`'s attachment operations: `attachments`, `attach` and
 * `fetch-attachment`, through the consumer's tracker.
 *
 * `attach` reads a JSON object: the `attachment` fields a sheet renderer
 * prints (`path`, `filename`, `contentType`, `size`, `title`, `subtitle`,
 * `replace`), or that whole summary, which carries them under `attachment`;
 * and `url`, the address of a copy already hosted, for an adapter that can
 * only link a file. `size`, when given, must be the file's size now, so a
 * file changed since it was rendered is not attached in its place.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";
import {
  AttachmentRefused,
  type AttachmentFile,
  attachReplacing,
} from "./tracker/attachment.ts";
import { openTracker } from "./tracker/index.ts";
import { TrackerRequestError } from "./tracker/port.ts";

/** One operation, as `tracker.ts` runs it. */
export interface AttachmentOperation {
  arity: number;
  takes: string;
  input: "input" | "out" | undefined;
  indent?: boolean;
  run: (args: string[], flags: Set<string>, input?: string) => Promise<unknown>;
  exitOf?: (out: unknown) => number;
}

/** The exit code of an attachment the tracker refused, nothing written. */
export const REFUSED_EXIT = 3;

const invalid = (message: string) =>
  new TrackerRequestError("invalid", message);

/** What `attach` reads: where the file is, and what the issue shows. */
export interface AttachRequest {
  file: Omit<AttachmentFile, "bytes">;
  path: string;
  size: number | null;
  replace: boolean;
}

function text(
  v: unknown,
  field: string,
  required: boolean,
): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim() === "")
    throw invalid(`attach: '${field}' must be a non-empty string`);
  return v;
}

/** Parse `attach`'s input; throws a usage error naming the field at fault. */
export function parseAttachRequest(raw: string): AttachRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("attach: the input is not JSON");
  }
  const o =
    isRecord(parsed) && isRecord(parsed.attachment)
      ? parsed.attachment
      : parsed;
  if (!isRecord(o)) throw invalid("attach: the input must be a JSON object");
  const known = [
    "path",
    "filename",
    "contentType",
    "size",
    "title",
    "subtitle",
    "url",
    "replace",
  ];
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length > 0)
    throw invalid(
      `attach: unknown field ${unknown.join(", ")} (known: ${known.join(", ")})`,
    );
  const path = text(o.path, "path", true) as string;
  if (
    o.size !== undefined &&
    !(Number.isInteger(o.size) && (o.size as number) >= 0)
  )
    throw invalid("attach: 'size' must be a whole number of bytes");
  if (o.replace !== undefined && typeof o.replace !== "boolean")
    throw invalid("attach: 'replace' must be true or false");
  const subtitle = text(o.subtitle, "subtitle", false);
  const url = text(o.url, "url", false);
  return {
    path,
    size: (o.size as number | undefined) ?? null,
    replace: o.replace === true,
    file: {
      filename: text(o.filename, "filename", false) ?? basename(path),
      contentType: text(o.contentType, "contentType", true) as string,
      title: text(o.title, "title", true) as string,
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(url === undefined ? {} : { url }),
    },
  };
}

const refusedExit = (out: unknown) =>
  isRecord(out) && "refused" in out ? REFUSED_EXIT : 0;

/** Run `work`, answering a refusal as `{ issue, refused }`. */
async function refusable(
  issue: string,
  work: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof AttachmentRefused)) throw err;
    console.error(err.message);
    return { issue, refused: err.message };
  }
}

export const ATTACHMENT_OPERATIONS: Record<string, AttachmentOperation> = {
  attachments: {
    arity: 1,
    takes: "one issue key",
    input: undefined,
    indent: true,
    run: ([key]) => openTracker().listAttachments(key as string),
  },
  attach: {
    arity: 1,
    takes: "one issue key; the attachment comes as JSON on stdin",
    input: "input",
    run: async ([key], _flags, input) => {
      const raw =
        input === undefined
          ? await Bun.stdin.text()
          : await readFile(input, "utf8");
      const request = parseAttachRequest(raw);
      const path = resolve(request.path);
      const bytes = new Uint8Array(await readFile(path));
      if (request.size !== null && request.size !== bytes.byteLength)
        throw invalid(
          `attach: ${path} is ${bytes.byteLength} bytes, not the ${request.size} its summary names; render it again`,
        );
      return refusable(key as string, async () => ({
        issue: key,
        ...(await attachReplacing(
          openTracker(),
          key as string,
          { ...request.file, bytes },
          request.replace,
        )),
      }));
    },
    exitOf: refusedExit,
  },
  "fetch-attachment": {
    arity: 2,
    takes: "an issue key and an attachment id, with --out <file>",
    input: "out",
    run: async ([key, id], _flags, out) => {
      if (out === undefined)
        throw invalid("fetch-attachment needs --out <file>");
      return refusable(key as string, async () => {
        const bytes = await openTracker().readAttachment(
          key as string,
          id as string,
        );
        await writeFile(out, bytes);
        return { issue: key, id, path: resolve(out), size: bytes.byteLength };
      });
    },
    exitOf: refusedExit,
  },
};
