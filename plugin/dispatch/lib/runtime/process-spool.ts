/** A run's private files are in dispatcher state, outside branch control. */
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { maskCredentials } from "../../../shared/credentials.ts";
import { stateRoot } from "../../receipts.ts";

export function processRunDirectory(id: string): string {
  return join(stateRoot(), "runs", id);
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 250;
// Keep enough context to recognise credentials which straddle an arbitrary
// pipe-read boundary.  The mask recognises both named values and unstructured
// tokens, so its look-behind must be retained as well as the possible value.
const REDACTION_TAIL_BYTES = 32 * 1024;
// A line longer than this is not held for redaction: it is dropped up to its
// newline, so pending state and the work per chunk stay bounded.
const REDACTION_PENDING_LIMIT = 2 * REDACTION_TAIL_BYTES;
const TRUNCATED_LINE = "[redacted: oversized line dropped]";

// What a line may end with while its credential value is still to come: a
// key's separator, a Bearer or Basic scheme, or an opened quote. The mask reads
// across line breaks there, so a cut after such an ending separates them.
const OPEN_CONTEXT = /(?:[=:"']|\b(?:Bearer|Basic))\s*$/i;

/**
 * Whether text ends inside a quoted value opened after a separator. The mask
 * reads a quoted value across line breaks, so a cut inside one separates the
 * value from its key.
 */
function endsInsideQuote(text: string): boolean {
  let quote = "";
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote === "") {
      if ((c === '"' || c === "'") && (last === "=" || last === ":")) quote = c;
      if (!/\s/.test(c)) last = c;
    } else if (c === "\\") {
      i++;
    } else if (c === quote) {
      if (text[i + 1] === quote) i++;
      else {
        quote = "";
        last = c;
      }
    }
  }
  return quote !== "";
}

const BOUNDARY_ATTEMPTS = 16;

/**
 * Return the part that is safe to redact and write now: everything up to the
 * last line break before the fixed look-behind window whose preceding text
 * leaves no credential context open.
 */
function redactionBoundary(text: string): number {
  let from = text.length - REDACTION_TAIL_BYTES - 1;
  for (let attempt = 0; from >= 0 && attempt < BOUNDARY_ATTEMPTS; attempt++) {
    const cut = text.lastIndexOf("\n", from);
    if (cut < 0) return 0;
    if (
      !OPEN_CONTEXT.test(text.slice(Math.max(0, cut - 256), cut)) &&
      !endsInsideQuote(text.slice(0, cut))
    )
      return cut + 1;
    from = cut - 1;
  }
  return 0;
}

/** Keep the tail in memory and bound the file even while a large chunk arrives. */
export function openSpool(
  id: string,
  reportError: (error: unknown) => void,
): {
  write(chunk: Buffer): void;
  close(): void;
} {
  const fd = openOutput(id, "w");
  let chunks: Buffer[] = [];
  let size = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let redactionTail = "";
  let dropping = false;
  const redact = (chunk: Buffer, final = false): Buffer => {
    let text = chunk.toString("utf8");
    if (dropping) {
      const lineEnd = text.indexOf("\n");
      if (lineEnd < 0) return Buffer.alloc(0);
      text = text.slice(lineEnd);
      dropping = false;
    }
    redactionTail += text;
    if (!final && Buffer.byteLength(redactionTail) <= REDACTION_TAIL_BYTES)
      return Buffer.alloc(0);
    const boundary = final
      ? redactionTail.length
      : redactionBoundary(redactionTail);
    if (boundary === 0) {
      if (redactionTail.length <= REDACTION_PENDING_LIMIT)
        return Buffer.alloc(0);
      // No cut is provably safe, and the mask reads credentials across line
      // breaks. Drop the oversized line; when it ends with a credential
      // context still open, drop what follows it too, so no value survives
      // apart from its key.
      const lineEnd = redactionTail.indexOf("\n");
      const head =
        lineEnd < 0 ? redactionTail : redactionTail.slice(0, lineEnd);
      if (
        lineEnd < 0 ||
        OPEN_CONTEXT.test(head.slice(-256)) ||
        endsInsideQuote(head)
      ) {
        redactionTail = "";
        dropping = true;
      } else {
        redactionTail = redactionTail.slice(lineEnd);
      }
      return Buffer.from(TRUNCATED_LINE);
    }
    const ready = redactionTail.slice(0, boundary);
    redactionTail = redactionTail.slice(boundary);
    return Buffer.from(maskCredentials(ready, "[redacted]"));
  };
  const flush = () => {
    const bytes = Buffer.concat(chunks, size);
    writeSync(fd, bytes, 0, bytes.length, 0);
  };
  // Once the log is full, moving its tail costs a whole-file write. At
  // most one flush per interval keeps a verbose pass from blocking its
  // wrapper on a rewrite for every chunk. Close always writes the final tail.
  const flushSoon = () => {
    if (pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      try {
        flush();
      } catch (error) {
        reportError(error);
      }
    }, FLUSH_INTERVAL_MS);
  };
  return {
    write(raw) {
      const chunk = redact(raw);
      if (chunk.length === 0) return;
      if (chunk.length >= OUTPUT_LIMIT) {
        chunks = [chunk.subarray(chunk.length - OUTPUT_LIMIT)];
        size = OUTPUT_LIMIT;
        flushSoon();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      if (size <= OUTPUT_LIMIT) {
        writeSync(fd, chunk, 0, chunk.length, size - chunk.length);
        return;
      }
      while (size - (chunks[0]?.length ?? 0) >= OUTPUT_LIMIT) {
        size -= (chunks.shift() as Buffer).length;
      }
      const first = chunks[0];
      if (first !== undefined) chunks[0] = first.subarray(size - OUTPUT_LIMIT);
      size = OUTPUT_LIMIT;
      flushSoon();
    },
    close() {
      try {
        const tail = redact(Buffer.alloc(0), true);
        if (tail.length > 0) {
          chunks.push(tail);
          size += tail.length;
          if (size > OUTPUT_LIMIT) {
            while (size - (chunks[0]?.length ?? 0) >= OUTPUT_LIMIT)
              size -= (chunks.shift() as Buffer).length;
            const first = chunks[0];
            if (first !== undefined)
              chunks[0] = first.subarray(size - OUTPUT_LIMIT);
            size = OUTPUT_LIMIT;
            flush();
          } else if (pending === undefined) {
            writeSync(fd, tail, 0, tail.length, size - tail.length);
          }
        }
        if (pending !== undefined) {
          clearTimeout(pending);
          flush();
        }
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Retain bootstrap errors without keeping the tick's descriptors open. */
export function openProcessStartupLog(id: string): number {
  return openOutput(id, "a");
}

function openOutput(id: string, flags: "w" | "a"): number {
  const dir = processRunDirectory(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return openSync(join(dir, "output.log"), flags, 0o600);
}

export function removeProcessSpool(id: string): void {
  rmSync(join(processRunDirectory(id), "output.log"), { force: true });
}
