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
  const redact = (chunk: Buffer, final = false): Buffer => {
    redactionTail += chunk.toString("utf8");
    if (!final && Buffer.byteLength(redactionTail) <= REDACTION_TAIL_BYTES)
      return Buffer.alloc(0);
    const keep = final ? "" : redactionTail.slice(-REDACTION_TAIL_BYTES);
    const ready = redactionTail.slice(0, redactionTail.length - keep.length);
    redactionTail = keep;
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
