import { GcError } from "./gc-error.ts";
/**
 * Cooperative reader/writer admission for resource publication. Stale tokens
 * are retained: without captured ownership evidence a lock is never stolen.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function gcLockRoot(): string {
  return join(homedir(), ".local", "state", "jig", "gc-locks");
}
/**
 * Only a recorded writer process that no longer exists proves a writer token
 * stale; an unreadable token or a reused pid keeps it held.
 */
function writerGone(writer: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(writer, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
export function sharedGcLock(kind: string, root = gcLockRoot()): () => void {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, `reader-${process.pid}-${randomUUID()}`);
  writeFileSync(token, "", { flag: "wx", mode: 0o600 });
  try {
    // A reader publishes before checking the writer. The writer publishes
    // before enumerating readers, so at least one side observes the other.
    // A writer whose process is gone collects nothing, so it cannot race
    // this creation; it stays for the next collector to report.
    const writer = join(dir, "writer");
    if (readdirSync(dir).includes("writer") && !writerGone(writer))
      throw new GcError(
        `gc ${kind}: collection in progress (${writer}); retry creation`,
      );
  } catch (error) {
    rmSync(token);
    throw error;
  }
  return () => rmSync(token, { force: true });
}
export async function exclusiveGcLock<T>(
  kind: string,
  body: () => Promise<T>,
  root = gcLockRoot(),
): Promise<T> {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const writer = join(dir, "writer");
  try {
    writeFileSync(writer, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new GcError(
      writerGone(writer)
        ? `gc ${kind}: ${writer} names a process that has exited; remove it after inspection`
        : `gc ${kind}: another collection holds ${writer}`,
    );
  }
  try {
    if (readdirSync(dir).some((name) => name.startsWith("reader-")))
      throw new GcError(
        `gc ${kind}: a creator holds the lock; stale admission tokens require inspection`,
      );
    return await body();
  } finally {
    rmSync(writer);
  }
}
