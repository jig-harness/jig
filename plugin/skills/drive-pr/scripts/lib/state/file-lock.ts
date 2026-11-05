/**
 * A lock on one file in the working tree, for a read-decide-write span on it
 * that two processes must not interleave: the drive mailbox's append and
 * repair (`mailbox.ts`). People and editors read the mailbox's files, so it
 * stays files beside them, not rows of the drive's database.
 *
 * The lock is `<file>.lock`, created exclusively, holding its holder's
 * process identity (`shared/liveness.ts`) and a token minted for this
 * acquisition. Releasing it removes the file while it still carries that
 * token, so a release leaves nothing behind, and a holder whose lock was
 * broken cannot remove its successor's. A lock whose holder is judged dead,
 * or that is older than `DRIVE_PR_LOCK_STALE_MIN` (the work it guards takes
 * milliseconds), is broken: removed while it still carries the token that was
 * read, then taken the ordinary way, so of two contenders only one creates
 * the new one.
 *
 * Breaking is a read and a removal, not one step: two breakers of the same
 * stale lock, one taking it between the other's read and its removal, could
 * remove a lock just taken. The mailbox's traffic is a few messages an hour
 * and each hold lasts milliseconds, so that interleaving is not a case this
 * lock is built for.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { errnoCode, swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  decodeIdentity,
  isAliveSync,
  lockIdentity,
} from "../../../../../shared/liveness.ts";
import { lockStaleMinutes, lockWaitSec, pollForLock } from "./lock.ts";

export interface FileLock {
  acquire(): Promise<void>;
  /** Remove the lock while it is still this acquisition's. Idempotent. */
  release(): void;
}

/** The lock file's text: the holder's identity and the acquisition's token. */
function contents(token: string): string {
  return `${JSON.stringify({ token, holder: lockIdentity() })}\n`;
}

/** The lock file's fields; `null` when its text is not a JSON object. */
function parsed(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch (err) {
    swallow(err, "a lock file is not JSON");
    return null;
  }
}

function readHeld(path: string): { text: string; token: string } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
  const token = parsed(text)?.token;
  return { text, token: typeof token === "string" ? token : "" };
}

/** Whether the lock file's holder may be broken: judged dead, or older than the window. */
function stale(path: string, text: string, staleMs: number): boolean {
  const identity = decodeIdentity(parsed(text)?.holder ?? null);
  if (identity !== null) {
    const verdict = isAliveSync(identity);
    if (verdict.ok && verdict.value.state === "dead") return true;
  }
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch (err) {
    swallow(err, "a lock file is gone before its age was read");
    return false;
  }
}

/** The lock on `file`. `label` names the owning script in a timeout's message. */
export function fileLock(file: string, label: string): FileLock {
  const path = `${file}.lock`;
  let token: string | null = null;

  function attempt(staleMs: number): boolean {
    const mine = randomBytes(12).toString("hex");
    try {
      writeFileSync(path, contents(mine), { flag: "wx" });
      token = mine;
      return true;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    }
    const held = readHeld(path);
    if (held === null || !stale(path, held.text, staleMs)) return false;
    // Remove the stale lock only while it is still the one just judged.
    if (readHeld(path)?.text === held.text) {
      try {
        unlinkSync(path);
      } catch (err) {
        if (errnoCode(err) !== "ENOENT") throw err;
      }
    }
    return false;
  }

  async function acquire(): Promise<void> {
    if (token !== null) return;
    const limit = lockWaitSec();
    const staleMs = lockStaleMinutes() * 60_000;
    await pollForLock(() => attempt(staleMs), 20, limit, [
      `${label}: could not acquire ${path} within ${limit}s.`,
      "Another process is writing this file.",
    ]);
  }

  function release(): void {
    if (token === null) return;
    const mine = token;
    token = null;
    try {
      if (readHeld(path)?.token === mine) unlinkSync(path);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") throw err;
    }
  }

  return { acquire, release };
}
