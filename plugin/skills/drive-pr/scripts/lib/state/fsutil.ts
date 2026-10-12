/** Filesystem helpers shared by the state modules. */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Random suffix for a unique temp path beside its target (mktemp XXXXXX). */
export function tempSuffix(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Write the entirety of `content` to `fd`, looping on `writeSync`'s return
 * value rather than trusting a single call wrote everything. `write(2)` makes
 * no promise to consume the whole buffer in one call — a short write that goes
 * unnoticed would let a caller fsync and rename/report success over silently
 * truncated content. A ZERO-byte result is distinct from a short-but-positive
 * one: trusting it was always positive turns `offset += 0` into an unbounded
 * synchronous spin rather than a corruption — treated as a failure, not
 * retried, since nothing in this loop's contract says a THIRD call would behave
 * any differently from the second.
 *
 * `content` accepts raw bytes as well as a string: every caller until
 * `migrate-legacy-state.ts` wrote its own JSON/text, so a `utf8`-encoded
 * string was the whole contract. Copying an arbitrary legacy state file
 * byte-for-byte cannot round-trip through a `utf8` string without risking
 * mangling content that is not valid UTF-8 (round-tripping through `utf8`
 * is lossy for invalid sequences), so a caller doing that passes the bytes
 * it already read straight through instead.
 */
export function writeAllSync(fd: number, content: string | Uint8Array): void {
  const buf =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      throw new Error(
        `writeSync returned ${written} bytes — no progress, refusing to spin`,
      );
    }
    offset += written;
  }
}

/**
 * Best-effort fsync of a directory's own entry-durability, given the path
 * TO the directory (not a target file inside it). Shared by `atomicWrite`
 * (after a rename lands a new/replaced directory entry) and `appendLine`
 * (after creating `inbox.jsonl`/`outbox.jsonl` for the first time) — both
 * need the identical "did the directory ENTRY itself survive a crash"
 * guarantee a file's own fsync does not provide.
 *
 * Skipped entirely on Windows: `openSync(dir, 'r')` fails there before
 * ever reaching the error-code allowlist below, and by the time this runs
 * the write it is protecting has ALREADY landed, so failing here would
 * report every caller as broken on Windows despite a successful write
 * — a real platform
 * carve-out, not a swallowed error, since NTFS does not share the
 * page-cache-vs-directory-entry durability gap this exists to close on
 * POSIX filesystems in the first place.
 *
 * `openSync` is deliberately OUTSIDE the ENOTSUP/EOPNOTSUPP/EINVAL allowlist
 * below: that allowlist exists for "fsync is not possible on this fd", a
 * statement about `fsyncSync`, not about `open(2)`. Wrapping both in one catch
 * classified by error code alone would swallow an EINVAL from the OPEN as
 * though fsync had been attempted and found unsupported — a false
 * classification an earlier version of this module's own test suite blessed
 * without noticing.
 *
 * Capture-then-rethrow OUTSIDE a `finally`, not `try { ... } finally {
 * closeSync(dirFd) }`: a `throw` inside `finally` silently overwrites whatever
 * the `try` was already propagating — standard JS semantics (and biome's own
 * `noUnsafeFinally` flags the shape directly) — which would hide the actual
 * ENOSPC/EIO/durability failure behind an unrelated close error. The primary
 * error, when there is one, is always the one that surfaces.
 */
export function fsyncDirectoryBestEffort(dirPath: string): void {
  if (process.platform === "win32") return;
  const dirFd = openSync(dirPath, "r");
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    fsyncSync(dirFd);
  } catch (e) {
    // "Best-effort" means "some platforms/filesystems genuinely don't
    // support fsync-ing a directory", not "swallow every error" — a
    // blanket catch also hides genuine durability failures (EIO, ENOSPC)
    // behind the same silent success as an unsupported operation.
    // The canonical "not
    // supported" codes are swallowed; everything else propagates. POSIX
    // also specifies EINVAL for "fsync is not possible on this fd", which
    // some filesystems return for a directory descriptor instead of
    // ENOTSUP/EOPNOTSUPP — omitting it would report a valid write as
    // failed on exactly the platforms this best-effort clause exists to
    // tolerate.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EINVAL") {
      primaryFailed = true;
      primaryError = e;
    }
  }
  let closeError: unknown;
  let closeFailed = false;
  try {
    closeSync(dirFd);
  } catch (e) {
    closeFailed = true;
    closeError = e;
  }
  if (primaryFailed) throw primaryError;
  if (closeFailed) throw closeError;
}

/**
 * Fsync a file this caller has already written and closed, by re-opening it
 * read-only — the same "did the bytes survive a crash" step `atomicWrite`
 * takes inline on its own write fd, split out for a caller that lands
 * content through some OTHER path (`copyFileSync`, in `migrate-legacy-state.ts`)
 * and only needs the durability half.
 *
 * No ENOTSUP/EOPNOTSUPP/EINVAL carve-out here, unlike
 * `fsyncDirectoryBestEffort`: that allowlist exists because some
 * filesystems genuinely cannot fsync a DIRECTORY, a real platform gap, not
 * "best-effort" as a synonym for "ignore failures". A plain file's fsync has
 * no equivalent unsupported-operation case worth swallowing, so any error
 * here propagates.
 *
 * Capture-then-rethrow OUTSIDE a `finally`, for the same reason
 * `fsyncDirectoryBestEffort` documents: a `throw` inside `finally` would
 * silently replace whatever `fsyncSync` was already propagating.
 */
export function fsyncFileSync(path: string): void {
  const fd = openSync(path, "r");
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    fsyncSync(fd);
  } catch (e) {
    primaryFailed = true;
    primaryError = e;
  }
  let closeError: unknown;
  let closeFailed = false;
  try {
    closeSync(fd);
  } catch (e) {
    closeFailed = true;
    closeError = e;
  }
  if (primaryFailed) throw primaryError;
  if (closeFailed) throw closeError;
}

/**
 * Thrown by `createExclusiveDurable` for any failure past the point where
 * this call is the one that owns the outcome: its own temp file's write,
 * fsync, or close, or the publishing `link` itself (other than `EEXIST`).
 * That is a structurally different failure from an `EEXIST` from the
 * publishing `link` (a genuine race lost to another process's own
 * already-complete publish): in THIS case `path` was never touched by this
 * call at all, so re-reading it afterward is safe. In the
 * `ExclusiveWriteOwnFailure` case, either `path` was never created (the temp
 * write or the link itself failed) or, if it somehow was, this call cannot
 * vouch for it — and a caller that re-reads and adopts it anyway cannot tell
 * either apart from a winning racer's committed value, silently accepting
 * corrupt or non-durable content instead of surfacing the failure.
 *
 * Reported via a dedicated error type rather than inferring ownership from
 * the raw error's `.code` (e.g. "non-EEXIST means this call owned it"):
 * `atomicWrite`'s own doc comment records exactly why that inference is
 * unsound in general — a wrapped call can fail before ownership is ever
 * established, for a reason other than `EEXIST`. This type exists so the
 * caller never has to re-derive that itself.
 * The original error survives as `cause` and as this error's own message,
 * so a plain `.toThrow('message')` assertion still matches it.
 */
export class ExclusiveWriteOwnFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ExclusiveWriteOwnFailure";
  }
}

/**
 * Thrown by `createExclusiveDurable` when the publishing `link` itself
 * SUCCEEDED but the post-publish `fsyncDirectoryBestEffort(dirname(path))`
 * that follows it then failed (EIO/ENOSPC, not one of the "not supported on
 * this fd" codes that best-effort swallows).
 *
 * Deliberately NOT an `ExclusiveWriteOwnFailure`: that type's whole contract
 * is "this call never created `path`, so re-reading it afterward is safe" —
 * true for every failure up to and including the `link`, false here. `link`
 * already succeeded, so THIS call did create `path`; what failed is only the
 * confirmation that the containing directory's own durability was flushed.
 * A caller cannot safely fold this into the "didn't touch it, re-read and
 * adopt whatever's there" path the way it does for a genuine `EEXIST` race —
 * doing so mistakes this call's own unconfirmed publish for a racing
 * winner's committed one. Nor is it a
 * clean success: a crash before the directory entry is actually durable can
 * still lose the very content this call just wrote. A caller must treat this
 * as its own outcome — typically refusing rather than trusting the value —
 * not silently collapse it into either neighboring case.
 */
export class ExclusiveDurabilityUnconfirmed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ExclusiveDurabilityUnconfirmed";
  }
}

/**
 * Create `path` EXCLUSIVELY — it comes into existence, for any reader, only
 * once — and fsync both its content and its containing directory before
 * returning, so a caller relying on "this call returned, therefore the
 * content is on disk" (`clone-key.ts`'s `persistedCloneId`, minting a
 * per-clone identity exactly once) is not left exposed to a crash losing an
 * apparently successful write.
 *
 * NOT a direct `wx` open on `path` itself, despite an earlier version of
 * this function doing exactly that: a
 * direct open creates the FINAL-path directory entry before any content is
 * written, so a concurrent reader that loses its own `wx` attempt in that
 * window sees `path` exist but empty (or, mid-write, non-empty but
 * truncated) — indistinguishable from a genuinely complete value without a
 * retry-and-hope loop. Publishing that way makes the loser's re-read a race
 * against the winner's own write, not just against the winner's *decision*
 * to write. Instead: write
 * `content` to a UNIQUE temp file beside `path` (so a same-suffix collision
 * with a concurrent writer only steals a name, never live data — same
 * property `atomicWrite` depends on, see its own doc), fsync it, and
 * publish with `linkSync(tmp, path)` — `link(2)` is exclusive exactly like
 * `open(2, O_EXCL)` (fails with `EEXIST` if `path` already exists, touching
 * nothing), but by the time it is attempted the content is already
 * complete and durable. `path` therefore has exactly two states to any
 * reader: absent, or fully written — never partial. This is what
 * `atomicWrite` cannot provide despite already using a temp file: it
 * unconditionally `rename`s over the target, so it can never fail on an
 * existing one — the opposite of the exclusivity `persistedCloneId`'s
 * race-safety argument depends on. `link`, not `rename`, is what keeps both
 * properties at once.
 *
 * Same capture-then-rethrow discipline as `atomicWrite`/`fsyncFileSync`, and
 * the same reasoning: a masked secondary error would hide the actual
 * ENOSPC/EIO durability failure a caller needs to see. Every failure after
 * the temp file's own `wx` open succeeds — the write, the fsync, the close,
 * *or* the publishing `link` itself (unless it is `EEXIST`) — is wrapped in
 * `ExclusiveWriteOwnFailure` (see that class's own doc): all of them mean
 * this call, not a racing winner, is the one that failed, so a caller must
 * not adopt whatever (if anything) `path` now holds. An `EEXIST` from the
 * `link` step is the one outcome where this call never touched `path` at
 * all, so it is propagated as-is, same as an `EEXIST` that used to come
 * from the direct-open version's own `openSync`.
 *
 * The final `fsyncDirectoryBestEffort` call below is past even the `link` —
 * it can fail with `path` already published — and a failure there is
 * reported as `ExclusiveDurabilityUnconfirmed` (see that class's own doc),
 * never as `ExclusiveWriteOwnFailure`: this call DID create `path` in that
 * case, so "never touched it" would be false.
 */
export function createExclusiveDurable(path: string, content: string): void {
  const tmp = `${path}.${tempSuffix()}`;
  let created = false;
  try {
    const fd = openSync(tmp, "wx");
    created = true;
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      writeAllSync(fd, content);
      fsyncSync(fd);
    } catch (e) {
      primaryFailed = true;
      primaryError = e;
    }
    let closeError: unknown;
    let closeFailed = false;
    try {
      closeSync(fd);
    } catch (e) {
      closeFailed = true;
      closeError = e;
    }
    if (primaryFailed) throw new ExclusiveWriteOwnFailure(primaryError);
    if (closeFailed) throw new ExclusiveWriteOwnFailure(closeError);
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw e;
      throw new ExclusiveWriteOwnFailure(e);
    }
  } finally {
    // `tmp`'s own directory entry is disposable either way: on success
    // `path` already links the same inode, so removing `tmp` only drops
    // the staging name, not the content; on failure nothing else will
    // ever reference `tmp` again. Best-effort — the outcome above (thrown
    // or not) is what the caller needs to see, not a secondary error from
    // tidying up after it.
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        // See above.
      }
    }
  }
  try {
    fsyncDirectoryBestEffort(dirname(path));
  } catch (e) {
    // `link` above already succeeded — `path` exists and its own content is
    // fsynced — so this is neither an own-failure-before-creation nor a
    // racing EEXIST. See `ExclusiveDurabilityUnconfirmed`'s own doc.
    throw new ExclusiveDurabilityUnconfirmed(e);
  }
}

/**
 * Write `content` to a UNIQUE temp file in the target's own directory, then
 * rename over the target. The rename is what makes a torn write impossible;
 * the unique name is what keeps two concurrent writers from interleaving into
 * one shared `.tmp` path and renaming the mixture.
 *
 * Fsyncs the temp file's data before the rename (via `writeAllSync`, then a
 * direct `fsyncSync`), and the containing directory after it (via
 * `fsyncDirectoryBestEffort`) — the standard "fsync-before-rename,
 * fsync-directory-after-rename" pattern for a crash-safe replacement. See
 * those two functions' own doc comments for the write/fsync hardening
 * itself; this function's remaining concern is temp-file OWNERSHIP and
 * cleanup.
 *
 * The ENTIRE create-through-rename sequence is one cleanup region: if any step
 * fails AFTER this invocation is confirmed to own `tmp`, it is unlinked rather
 * than left orphaned — nothing else in this module ever cleans up a temp file
 * that never made it to `rename`, and every caller of this shared helper
 * (mailbox repair, leases, handoff, state storage) would otherwise accumulate
 * one per failed write — not only after a failed fsync, but after a partial
 * write (e.g. ENOSPC mid-write, after the exclusive create already landed) or a
 * failed `renameSync` too. Ownership (`created`) is tracked separately from
 * completion (`renamed`), and is set the INSTANT `openSync(tmp, 'wx')` itself
 * returns — not inferred from an error code on some later step. The unique
 * suffix is only 24 bits, so a same-suffix collision with a concurrent writer
 * is possible, and `EEXIST` from the exclusive open is the one outcome where
 * this invocation never created `tmp` at all; unlinking in that case would
 * delete the COLLIDING writer's live temp file out from under its own in-flight
 * write/fsync/rename. An earlier fix that inferred ownership from "the error
 * code from `writeFileSync` wasn't EEXIST" was itself still wrong:
 * `writeFileSync` wraps open+write+close, so a non-EEXIST failure (ENOSPC,
 * EDQUOT, EACCES, EROFS, ...) can occur before the OPEN step ever created a
 * directory entry, in which case ownership was never established either, and a
 * same-suffix collision during the gap before this `finally` runs is unlinked
 * incorrectly all over again. Opening `tmp` directly (rather than through
 * `writeFileSync`) makes the open-succeeded moment observable, so `created` is
 * only ever true when this invocation's own `open(2)` genuinely won the
 * exclusive create.
 *
 * The `renameSync(tmp, target)` publish step is also what makes this the
 * canonical way to write to a `target` this process does not hold
 * exclusively for the write's whole duration: `rename(2)` replaces
 * whatever directory entry currently occupies `target` — including a
 * symlink — without ever opening or following it, unlike a direct
 * `writeFileSync`/`copyFileSync` onto `target`, both of which follow a
 * symlink there and write through to its external destination.
 * `migrate-legacy-state.ts` is the worked case: two of its own
 * writes went straight to `copyFileSync`/`writeFileSync` on a path it did
 * not hold exclusively between check and write, each independently
 * vulnerable to exactly that substitution — closed by routing both
 * through this already-reviewed primitive instead of adding another
 * check-then-write gap that would only narrow the window. That file's own
 * header already records the general lesson for the analogous `src`-side
 * race (three rounds of narrowing a read-before-delete window, still
 * closable one read later every time): a race that is real, not
 * theoretical, is closed by an operation with no window at all, not by
 * one more check.
 */
export function atomicWrite(
  target: string,
  content: string | Uint8Array,
): void {
  const tmp = `${target}.${tempSuffix()}`;
  let created = false;
  let renamed = false;
  try {
    // EXCLUSIVE create, because the unique name is the guarantee above and a
    // plain write does not enforce it: 24 bits of suffix is small enough to
    // collide, and a truncating write onto a concurrent writer's temp file
    // produces exactly the interleaved-then-renamed mixture this design
    // exists to prevent — silently. `wx`
    // turns that into a throw instead. Opened directly (not via
    // `writeFileSync`) so `created` can be set the instant `open(2)`
    // succeeds, rather than inferred from a later error's code.
    const fd = openSync(tmp, "wx");
    created = true;
    // Capture-then-rethrow OUTSIDE a `finally` — see `writeAllSync`'s own
    // doc for why a plain `try { ... } finally { closeSync(fd) }` is wrong
    // here.
    let primaryError: unknown;
    let primaryFailed = false;
    try {
      writeAllSync(fd, content);
      fsyncSync(fd);
    } catch (e) {
      primaryFailed = true;
      primaryError = e;
    }
    let closeError: unknown;
    let closeFailed = false;
    try {
      closeSync(fd);
    } catch (e) {
      closeFailed = true;
      closeError = e;
    }
    if (primaryFailed) throw primaryError;
    if (closeFailed) throw closeError;
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (created && !renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup on an already-failing path — the original
        // error is what the caller needs to see, not a secondary one from
        // trying to tidy up after it.
      }
    }
  }
  fsyncDirectoryBestEffort(dirname(target));
}
