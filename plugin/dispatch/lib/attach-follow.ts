/**
 * Follow a process run's spool (`runtime/process-spool.ts`) the way `tail -f`
 * would, until the run ends or the person detaches. The spool is a bounded
 * file: once it is full the wrapper rewrites it from its start with the
 * newest tail, so a read that finds it no longer begins with what the last
 * read held finds its place again where the end of that begins what is
 * there now, and prints what follows, or the whole tail behind a line saying
 * output was skipped.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { swallow } from "../../shared/errors.ts";

/** How often the spool and the run are read again. */
const FOLLOW_INTERVAL_MS = 1000;

export interface FollowDeps {
  /** Whether the run has ended: its record ended or gone, and none of its processes alive. */
  over: () => Promise<boolean>;
  /** Write output through to the person. */
  write: (chunk: Buffer | string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Aborted when the person detaches. */
  signal: AbortSignal;
  intervalMs?: number;
}

/** The spool as an open descriptor; `null` while it does not exist yet; the reason when it cannot be opened. */
function openSpool(path: string): number | null | { unreadable: string } {
  try {
    return openSync(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      return {
        unreadable: `the run's output ${path} cannot be read: ${code ?? String(error)}`,
      };
    swallow(error, "the run's spool does not exist yet");
    return null;
  }
}

/** Everything in an open spool; the reason when it cannot be read. */
function readFd(fd: number, path: string): Buffer | { unreadable: string } {
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      unreadable: `the run's output ${path} cannot be read: ${code ?? String(error)}`,
    };
  }
}

/** For each prefix of `bytes`, the length of its longest proper prefix that is also its suffix. */
function failureFunction(bytes: Buffer): Int32Array {
  const fail = new Int32Array(bytes.length);
  for (let i = 1, k = 0; i < bytes.length; i++) {
    while (k > 0 && bytes[i] !== bytes[k]) k = fail[k - 1] as number;
    if (bytes[i] === bytes[k]) k++;
    fail[i] = k;
  }
  return fail;
}

/** The length of the longest prefix of `next` that ends `prev`, in linear time: the failure function of `next` run over `prev`. */
function overlap(prev: Buffer, next: Buffer): number {
  const fail = failureFunction(next);
  let matched = 0;
  for (const byte of prev) {
    if (matched === next.length) matched = fail[matched - 1] as number;
    while (matched > 0 && byte !== next[matched]) {
      matched = fail[matched - 1] as number;
    }
    if (byte === next[matched]) matched++;
  }
  return matched;
}

/**
 * What `next` adds to `prev`, when `next` is `prev` with its start dropped
 * and new bytes appended (the bounded rewrite): the first place a suffix of
 * `prev` is a prefix of `next`. `null` when no suffix is.
 */
function addedTo(prev: Buffer, next: Buffer): Buffer | null {
  if (prev.length === 0) return next;
  if (next.length === 0) return next;
  const matched = overlap(prev, next);
  return matched > 0 ? next.subarray(matched) : null;
}

/** A cursor over the spool: what is new since the last call, or why it cannot be read; `close` frees the descriptor it keeps. */
export type SpoolCursor = (() => Buffer | string | { unreadable: string }) & {
  close: () => void;
};

/**
 * A cursor over the spool. It keeps the descriptor it last read, so output
 * the wrapper flushes and then deletes the file behind is still read, and
 * compares the whole of what it read before with what is there now, so a
 * rewrite that ends as the last one did is not taken for no new output.
 */
export function spoolCursor(path: string): SpoolCursor {
  let prev = Buffer.alloc(0);
  let held: number | null = null;
  const release = () => {
    if (held !== null) closeSync(held);
    held = null;
  };
  const cursor = () => {
    const opened = openSpool(path);
    if (opened !== null && typeof opened === "object") return opened;
    if (opened !== null) {
      release();
      held = opened;
    }
    if (held === null) return "";
    const all = readFd(held, path);
    if (!Buffer.isBuffer(all)) return all;
    const added = addedTo(prev, all);
    prev = Buffer.from(all);
    return (
      added ??
      Buffer.concat([
        Buffer.from("[jig dispatch attach: earlier output was skipped]\n"),
        all,
      ])
    );
  };
  return Object.assign(cursor, { close: release });
}

/** Write what the cursor has that is new; why the spool cannot be read, else null. */
function flush(
  next: SpoolCursor,
  write: FollowDeps["write"],
): { unreadable: string } | null {
  const got = next();
  if (typeof got === "object" && !Buffer.isBuffer(got)) return got;
  if (got.length > 0) write(got);
  return null;
}

/** Print the spool as it grows: `ended` once the run is over and its last output printed, `detached` when the person stopped watching, or why the spool cannot be read. */
export async function followSpool(
  path: string,
  deps: FollowDeps,
): Promise<"ended" | "detached" | { unreadable: string }> {
  const next = spoolCursor(path);
  const interval = deps.intervalMs ?? FOLLOW_INTERVAL_MS;
  try {
    for (;;) {
      if (deps.signal.aborted) return "detached";
      // Read before and after the check: the descriptor of the first read
      // outlives a spool the wrapper deletes at the run's end.
      const before = flush(next, deps.write);
      if (before !== null) return before;
      if (await deps.over()) return flush(next, deps.write) ?? "ended";
      await deps.sleep(interval);
    }
  } finally {
    next.close();
  }
}
