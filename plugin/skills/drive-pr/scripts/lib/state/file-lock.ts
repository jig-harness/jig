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
 * Every removal of the lock file, a break or a release, is a read followed by
 * an unlink, and two of them interleaving could remove a lock just taken:
 * both read stale token A, the first unlinks A and a third process takes B,
 * the second unlinks B. So each removal happens under a second exclusive
 * file, held for the read and the unlink only, and named for the generation
 * it removes: `<file>.lock.unlink.<token>`. Taking the lock never removes
 * anything, it only creates the file when it is absent, so with removals
 * serialized a removal always acts on the file it just read. Because the guard
 * is keyed to one generation, a guard left behind by a removal that died can
 * only ever block the removal of the lock it was taken for, never a
 * successor's: it is broken when older than the staleness window, by an
 * unlink and nothing else, since no live holder of a newer lock owns it.
 *
 * A guard whose lock generation never comes back (the removal died after the
 * lock file was gone) is reclaimed by whoever next takes the lock: it sweeps
 * the guards older than the staleness window, whatever generation they name.
 *
 * A remover that is suspended for longer than the staleness window while
 * holding its guard can lose it to a breaker, so it checks that the guard is
 * still its own immediately before it unlinks the lock file. That leaves only
 * the instant between that check and the unlink, not the window.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { errnoCode, swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  decodeIdentity,
  isAliveSync,
  lockIdentity,
} from "../../../../../shared/liveness.ts";
import { lockStaleMinutes, lockWaitSec, pollForLock } from "./lock.ts";
import { currentMs } from "../../../../../shared/time.ts";

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
    return currentMs() - statSync(path).mtimeMs > staleMs;
  } catch (err) {
    swallow(err, "a lock file is gone before its age was read");
    return false;
  }
}

/** Sleep `ms` without yielding, for the one synchronous wait a release makes. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The guard's text, when it is there to read. */
function readGuard(guard: string): string | null {
  try {
    return readFileSync(guard, "utf8");
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") throw err;
    return null;
  }
}

/**
 * Run `fn` while holding the removal file `guard`, which belongs to one lock
 * generation; `false` when it could not be taken. The guard carries a token
 * minted for this call, and only a guard still carrying it is removed
 * afterwards. A guard older than `staleMs` is unlinked so a later call takes
 * it.
 */
function underGuard(
  guard: string,
  staleMs: number,
  fn: (stillMine: () => boolean) => void,
): boolean {
  const mine = randomBytes(12).toString("hex");
  try {
    writeFileSync(guard, mine, { flag: "wx" });
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") throw err;
    try {
      if (currentMs() - statSync(guard).mtimeMs > staleMs) unlinkSync(guard);
    } catch (inner) {
      swallow(inner, "a removal guard is gone before it could be judged");
    }
    return false;
  }
  try {
    fn(() => readGuard(guard) === mine);
  } finally {
    try {
      if (readGuard(guard) === mine) unlinkSync(guard);
    } catch (err) {
      swallow(err, "a removal guard was already removed");
    }
  }
  return true;
}

/** Unlink the removal guards of `path` older than `staleMs`, of any generation. */
function sweepObsoleteGuards(path: string, staleMs: number): void {
  const prefix = `${basename(path)}.unlink.`;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix)) continue;
      const guard = join(dirname(path), name);
      try {
        if (currentMs() - statSync(guard).mtimeMs > staleMs) unlinkSync(guard);
      } catch (err) {
        swallow(err, "a removal guard is gone before it could be swept");
      }
    }
  } catch (err) {
    swallow(err, "the lock's directory could not be listed for guards");
  }
}

/** The lock on `file`. `label` names the owning script in a timeout's message. */
export function fileLock(file: string, label: string): FileLock {
  const path = `${file}.lock`;
  /** The removal guard of the lock generation carrying `token`. */
  const guardFor = (token: string): string => `${path}.unlink.${token}`;
  let token: string | null = null;

  function attempt(staleMs: number): boolean {
    const mine = randomBytes(12).toString("hex");
    try {
      writeFileSync(path, contents(mine), { flag: "wx" });
      token = mine;
      sweepObsoleteGuards(path, staleMs);
      return true;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
    }
    const held = readHeld(path);
    if (held === null || !stale(path, held.text, staleMs)) return false;
    // Remove the stale lock only while it is still the one just judged.
    underGuard(
      guardFor(
        held.token ||
          createHash("sha256").update(held.text).digest("hex").slice(0, 24),
      ),
      staleMs,
      (stillMine) => {
        if (readHeld(path)?.text !== held.text || !stillMine()) return;
        try {
          unlinkSync(path);
        } catch (err) {
          if (errnoCode(err) !== "ENOENT") throw err;
        }
      },
    );
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
    const staleMs = lockStaleMinutes() * 60_000;
    // A guard held by another removal lasts milliseconds; if it outlasts the
    // wait, the lock file stays and is broken once it reads stale.
    for (let tries = 0; tries < 100; tries++) {
      const done = underGuard(guardFor(mine), staleMs, (stillMine) => {
        try {
          if (readHeld(path)?.token === mine && stillMine()) unlinkSync(path);
        } catch (err) {
          if (errnoCode(err) !== "ENOENT") throw err;
        }
      });
      if (done) return;
      pause(20);
    }
  }

  return { acquire, release };
}
