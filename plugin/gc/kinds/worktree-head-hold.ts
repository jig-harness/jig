/**
 * Holding a worktree's HEAD from the final identity comparison through its
 * removal, by `git worktree remove` for an agent tool's tree and by `orca
 * worktree rm` for one Orca manages. Git offers no atomic check-and-remove,
 * and a commit on a detached head is on no ref: one made after the
 * comparison would go with the tree's HEAD and its log. Git takes `HEAD.lock`
 * in the worktree's git directory, with an exclusive create, before it moves
 * HEAD, so while gc holds that file a commit, checkout, switch or reset in
 * the tree fails with git's own "cannot lock ref" error instead of moving the
 * head. Neither removal moves HEAD itself: Orca's removal reads the tree's
 * status, stops its terminals, runs `git worktree remove` and then deletes
 * only the branch ref, so the hold stands across it. `git worktree remove`
 * deletes the git directory, the lock with it.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { swallow } from "../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  decodeIdentity,
  encodeIdentity,
  isAliveSync,
  lockIdentity,
} from "../../shared/liveness.ts";
import { gcGit as git } from "../git.ts";
import {
  unchangedSinceProof,
  type WorktreeIdentity,
} from "./worktree-proof.ts";

/** A held head, released once the removal ran or was refused. */
export interface HeadHold {
  /** The lock file the hold wrote. */
  readonly lock: string;
  /** Delete the lock while it is still the one this hold wrote. */
  release(): Outcome<undefined, "release-failed">;
}

/**
 * The identity a tree's collection holds it to, or why the collection stops
 * before its remove hook runs: no final proof recorded the tree's commit and
 * branch, or its head cannot be held (`headHoldRefusal`).
 */
export async function holdableIdentity(
  path: string,
  identity: WorktreeIdentity | undefined,
): Promise<
  | { identity: WorktreeIdentity }
  | { stop: { outcome: "failed" | "refused"; reason: string } }
> {
  if (identity === undefined)
    return {
      stop: {
        outcome: "failed",
        reason: "kept: no final proof recorded the tree's commit and branch",
      },
    };
  const refusal = await headHoldRefusal(path);
  if (!refusal.ok)
    return { stop: { outcome: "failed", reason: refusal.failure.reason } };
  if (refusal.value !== null)
    return { stop: { outcome: "refused", reason: refusal.value } };
  // A lock already there would refuse the hold only after the hook ran.
  const lock = join(identity.admin, "HEAD.lock");
  return !existsSync(lock) || endedRunsLock(lock) !== null
    ? { identity }
    : {
        stop: {
          outcome: "refused",
          reason: `kept: ${lock} exists: a git process holds the worktree's HEAD, or one that stopped left the lock; the next run tries again, and a lock no process holds is deleted by hand`,
        },
      };
}

/**
 * The text of a lock an ended gc run wrote, which a later collection takes
 * over: the head has stayed held since that run's last comparison. Null for
 * a lock git or a running gc holds, or one whose writer cannot be judged.
 */
function endedRunsLock(lock: string): string | null {
  let text: string;
  try {
    text = readFileSync(lock, "utf8");
  } catch (error) {
    // Gone since it was seen, or unreadable: not one to take over.
    swallow(error, "a HEAD.lock that cannot be read is not taken over");
    return null;
  }
  const match = /^jig gc (\{.*\}) [0-9a-f-]{36}\n$/.exec(text);
  const writer = match === null ? null : decodeIdentity(match[1]);
  if (writer === null) return null;
  const verdict = isAliveSync(writer);
  return verdict.ok && verdict.value.state === "dead" ? text : null;
}

/**
 * The comparison with the proof's identity that every check before removal
 * ends with. Before the `final` one, the last before removal, the head is
 * held, the hold added to `holds`, so no commit, switch or reset moves it
 * between the comparison and the removal.
 */
export function unchangedAndHeld(
  path: string,
  identity: WorktreeIdentity,
  final: boolean,
  holds: HeadHold[],
): Promise<Outcome<undefined, string>> {
  return unchangedSinceProof(
    path,
    identity,
    final
      ? async () => {
          const taken = await holdHead(path, identity);
          if (!taken.ok) return taken;
          holds.push(taken.value);
          return ok(undefined);
        }
      : undefined,
  );
}

/**
 * Leave every hold taken in place, emptying `holds`, for a removal that may
 * still be under way: its lock goes with the tree's git directory, and a
 * later collection of a tree that stayed takes it over. What the receipt says
 * of each lock left.
 */
export function keepHolds(holds: HeadHold[]): string | null {
  const locks = holds.splice(0).map((hold) => hold.lock);
  return locks.length === 0
    ? null
    : `gc leaves ${locks.join(" and ")} in place, so the head stays held while the removal may still run; the next collection takes it over`;
}

/** Release every hold taken, emptying `holds`; why one could not be, or null. */
export function releaseHolds(
  holds: HeadHold[],
  log: (line: string) => void,
): string | null {
  const reasons: string[] = [];
  for (const hold of holds.splice(0)) {
    const released = hold.release();
    if (released.ok) continue;
    reasons.push(released.failure.reason);
    log(String(released.failure.cause ?? released.failure.reason));
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * Null when the tree's head can be held, or the reason it is kept: the
 * repository keeps its refs in a store other than files, where `HEAD.lock`
 * holds nothing. Read before the remove hook, so a tree that would be kept
 * anyway is not torn down on every run.
 */
export async function headHoldRefusal(
  path: string,
): Promise<Outcome<string | null, "git-failed">> {
  const store = await refStore(path);
  return store.ok ? ok(refusalUnder(store.value)) : store;
}
function refusalUnder(store: string): string | null {
  return store === "files"
    ? null
    : `kept: a worktree's head cannot be held through removal under git's ${store} ref store`;
}

/**
 * Hold the worktree's HEAD. Fails, and the tree is kept, when git already
 * holds it, when the tree's git directory is no longer the one the proof
 * read, when the lock cannot be written, or as `headHoldRefusal` says. The
 * lock names `jig gc` and its process, for a person who finds one a stopped
 * run left behind and for the next collection, which takes over the lock of
 * a run that has ended.
 */
export async function holdHead(
  path: string,
  identity: WorktreeIdentity,
  write: (fd: number, token: string) => number = writeSync,
): Promise<Outcome<HeadHold, "head-unheld" | "git-failed">> {
  const store = await refStore(path);
  if (!store.ok) return store;
  const refusal = refusalUnder(store.value);
  if (refusal !== null) return failed("head-unheld", refusal);
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  if (!dir.ok) return dir;
  const admin = isAbsolute(dir.value) ? dir.value : resolve(path, dir.value);
  if (admin !== identity.admin)
    return failed(
      "head-unheld",
      "kept: the worktree's git directory changed after the proof",
    );
  const lock = join(admin, "HEAD.lock");
  const token = `jig gc ${encodeIdentity(lockIdentity())} ${randomUUID()}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(lock, "wx");
    const written = write(fd, token);
    if (written !== Buffer.byteLength(token))
      return failed(
        "head-unheld",
        `kept: the worktree's HEAD cannot be held: wrote ${written} of ${Buffer.byteLength(token)} bytes to HEAD.lock${discard(lock, fd)}`,
      );
    closeSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const left = code === "EEXIST" ? endedRunsLock(lock) : null;
    if (fd === null && left !== null) return ok(heldAs(lock, left));
    if (fd === null && code === "EEXIST")
      return failed(
        "head-unheld",
        "kept: a git process holds the worktree's HEAD (HEAD.lock exists)",
        error,
      );
    const stranded = fd === null ? "" : discard(lock, fd);
    return failed(
      "head-unheld",
      `kept: the worktree's HEAD cannot be held: ${error instanceof Error ? error.message : String(error)}${stranded}`,
      error,
    );
  }
  return ok(heldAs(lock, token));
}

/** The hold of `lock` while it carries `token`. */
function heldAs(lock: string, token: string): HeadHold {
  return {
    lock,
    release: () => {
      try {
        if (readFileSync(lock, "utf8") === token) rmSync(lock);
        return ok(undefined);
      } catch (error) {
        // Removed with the tree's git directory.
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return ok(undefined);
        return failed(
          "release-failed",
          `gc could not release ${lock}, which keeps git from moving the tree's HEAD; remove it by hand: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },
  };
}

/**
 * Remove the lock this call created, through the descriptor that created it:
 * a pathname another process has since taken is left alone. The sentence to
 * append when removal fails.
 */
function discard(lock: string, fd: number): string {
  try {
    const mine = fstatSync(fd);
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    const current = statSync(lock, { throwIfNoEntry: false });
    if (current && current.ino === mine.ino && current.dev === mine.dev)
      rmSync(lock, { force: true });
    return "";
  } catch (error) {
    return `; gc could not remove ${lock}, which keeps git from moving the tree's HEAD, remove it by hand: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The ref store git actually uses. `--show-ref-format` answers from the
 * repository's setup, which a worktree's own config cannot override; git
 * that predates it reads the shared config instead.
 */
async function refStore(path: string): Promise<Outcome<string, "git-failed">> {
  const format = await git(path, ["rev-parse", "--show-ref-format"]);
  if (format.ok && format.value !== "" && !format.value.startsWith("--"))
    return ok(format.value.toLowerCase());
  const store = await git(path, [
    "config",
    "--default",
    "files",
    "--get",
    "extensions.refStorage",
  ]);
  return store.ok ? ok(store.value.toLowerCase()) : store;
}
