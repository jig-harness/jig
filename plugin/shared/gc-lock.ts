import { GcError } from "./gc-error.ts";
/**
 * Cooperative reader/writer admission for resource publication. Stale tokens
 * are retained: without captured ownership evidence a lock is never stolen.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function gcLockRoot(): string {
  return join(homedir(), ".local", "state", "jig", "gc-locks");
}
export function sharedGcLock(kind: string, root = gcLockRoot()): () => void {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, `reader-${process.pid}-${randomUUID()}`);
  writeFileSync(token, "", { flag: "wx", mode: 0o600 });
  try {
    // A reader publishes before checking the writer. The writer publishes
    // before enumerating readers, so at least one side observes the other.
    if (readdirSync(dir).includes("writer"))
      throw new GcError(`gc ${kind}: collection in progress; retry creation`);
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
  writeFileSync(writer, String(process.pid), { flag: "wx", mode: 0o600 });
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
