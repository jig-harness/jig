/**
 * Follow a process run's spool (`runtime/process-spool.ts`) the way `tail -f`
 * would, until the run ends or the person detaches. The spool is a bounded
 * file: once it is full the wrapper rewrites it from its start with the
 * newest tail, so a read that finds it shorter, or no longer ending where
 * the last read left it, finds its place again by the last bytes it printed
 * and prints what follows them, or the whole tail behind a line saying
 * output was skipped.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { swallow } from "../../shared/errors.ts";

/** How often the spool and the run are read again. */
const FOLLOW_INTERVAL_MS = 1000;
/** The bytes kept to find the place again in a rewritten spool. */
const ANCHOR_BYTES = 256;

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

/** The spool's bytes; `null` while it does not exist yet; the reason when it cannot be opened. */
function readAll(path: string): Buffer | null | { unreadable: string } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      return {
        unreadable: `the run's output ${path} cannot be read: ${code ?? String(error)}`,
      };
    swallow(error, "the run's spool does not exist yet");
    return null;
  }
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** A cursor over the spool: what is new since the last call, or why it cannot be read. */
export function spoolCursor(
  path: string,
): () => Buffer | string | { unreadable: string } {
  let offset = 0;
  let anchor = Buffer.alloc(0);
  return () => {
    const all = readAll(path);
    if (all === null) return "";
    if (!Buffer.isBuffer(all)) return all;
    let fresh: Buffer | string;
    const anchorAt = offset - anchor.length;
    const inPlace =
      all.length >= offset && all.subarray(anchorAt, offset).equals(anchor);
    if (inPlace) fresh = all.subarray(offset);
    else {
      const found = anchor.length === 0 ? -1 : all.lastIndexOf(anchor);
      fresh =
        found === -1
          ? Buffer.concat([
              Buffer.from(
                "[jig dispatch attach: earlier output was skipped]\n",
              ),
              all,
            ])
          : all.subarray(found + anchor.length);
    }
    offset = all.length;
    anchor = Buffer.from(all.subarray(Math.max(0, all.length - ANCHOR_BYTES)));
    return fresh;
  };
}

/** Print the spool as it grows: `ended` once the run is over and its last output printed, `detached` when the person stopped watching, or why the spool cannot be read. */
export async function followSpool(
  path: string,
  deps: FollowDeps,
): Promise<"ended" | "detached" | { unreadable: string }> {
  const next = spoolCursor(path);
  const interval = deps.intervalMs ?? FOLLOW_INTERVAL_MS;
  for (;;) {
    if (deps.signal.aborted) return "detached";
    const over = await deps.over();
    // Read after the check, so output written before the end is printed.
    const fresh = next();
    if (typeof fresh === "object" && !Buffer.isBuffer(fresh)) return fresh;
    if (fresh.length > 0) deps.write(fresh);
    if (over) return "ended";
    await deps.sleep(interval);
  }
}
