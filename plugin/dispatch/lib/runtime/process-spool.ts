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
// key's separator or a Bearer or Basic scheme. The mask reads across line
// breaks there, so a cut after such an ending separates the key from its value.
const OPEN_CONTEXT = /(?:[=:]|\b(?:Bearer|Basic))\s*$/i;

/**
 * Where a scan stands in the output: inside a quoted value opened after a key
 * separator, or after one. The mask reads a quoted value across line breaks,
 * so a cut inside one separates the value from its key.
 */
interface ScanState {
  quote: string;
  last: string;
  escaped: boolean;
  // A quote seen inside a value: it closes it unless the next character
  // repeats it.
  closing: boolean;
  // The last characters seen, for the context test across chunks.
  recent: string;
}

function freshScan(): ScanState {
  return { quote: "", last: "", escaped: false, closing: false, recent: "" };
}

/** A quote that closed its value: the line break after it ends the value. */
function settle(s: ScanState): void {
  if (!s.closing) return;
  s.closing = false;
  s.last = s.quote;
  s.quote = "";
}

/** Step inside a quoted value; false when the character is outside it now. */
function scanQuoted(s: ScanState, c: string): boolean {
  if (s.escaped) {
    s.escaped = false;
    return true;
  }
  if (s.closing && c === s.quote) {
    s.closing = false;
    return true;
  }
  settle(s);
  if (s.quote === "") return false;
  if (c === "\\") s.escaped = true;
  else if (c === s.quote) s.closing = true;
  return true;
}

function scanChar(s: ScanState, c: string): void {
  if (s.quote !== "" && scanQuoted(s, c)) return;
  if ((c === '"' || c === "'") && (s.last === "=" || s.last === ":"))
    s.quote = c;
  if (!/\s/.test(c)) s.last = c;
}

/** Whether a line break right here may end a cut without splitting a value. */
function safeBreak(s: ScanState, text: string, at: number): boolean {
  if (s.quote !== "" && !s.closing) return false;
  const before =
    at >= 256 ? text.slice(at - 256, at) : s.recent + text.slice(0, at);
  return !OPEN_CONTEXT.test(before.slice(-256));
}

/**
 * Scan text from the state given, calling `onBreak` with each line break a cut
 * may end at until it answers true. The state is left at the end of the text
 * scanned, or at the break scanning stopped.
 */
function scan(
  s: ScanState,
  text: string,
  onBreak: (index: number) => boolean,
): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\n") {
      settle(s);
      if (safeBreak(s, text, i) && onBreak(i)) return;
    }
    scanChar(s, c);
  }
  s.recent = (s.recent + text).slice(-256);
}

/** The first line break at which a cut leaves no value open, or -1. */
function firstSafeBreak(s: ScanState, text: string): number {
  let found = -1;
  scan(s, text, (i) => {
    found = i;
    return true;
  });
  return found;
}

/**
 * Return the part that is safe to redact and write now: everything up to the
 * last line break before the fixed look-behind window that leaves no credential
 * context open.
 */
function redactionBoundary(text: string): number {
  const limit = text.length - REDACTION_TAIL_BYTES - 1;
  let found = -1;
  scan(freshScan(), text, (i) => {
    if (i <= limit) found = i;
    return false;
  });
  return found < 0 ? 0 : found + 1;
}

/** Redact a stream chunk by chunk, holding back what may still straddle one. */
function createRedactor(): (chunk: Buffer, final?: boolean) => Buffer {
  let redactionTail = "";
  let dropping: ScanState | null = null;
  return (chunk, final = false) => {
    let text = chunk.toString("utf8");
    if (dropping !== null) {
      // The dropped text may have left a value open: keep scanning it until
      // a line break that ends it, and resume there.
      const resume = firstSafeBreak(dropping, text);
      if (resume < 0) return Buffer.alloc(0);
      text = text.slice(resume);
      dropping = null;
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
      // No cut is provably safe. Drop the oversized text up to the first line
      // break that ends no credential value, and keep what follows it; when
      // there is none yet, keep scanning the dropped text's state so no value
      // survives apart from its key.
      const state = freshScan();
      const resume = firstSafeBreak(state, redactionTail);
      if (resume < 0) {
        redactionTail = "";
        dropping = state;
      } else {
        redactionTail = redactionTail.slice(resume);
      }
      return Buffer.from(TRUNCATED_LINE);
    }
    const ready = redactionTail.slice(0, boundary);
    redactionTail = redactionTail.slice(boundary);
    return Buffer.from(maskCredentials(ready, "[redacted]"));
  };
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
  const redact = createRedactor();
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
