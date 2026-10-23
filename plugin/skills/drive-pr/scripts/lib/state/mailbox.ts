/**
 * The drive mailbox: a one-way-per-file channel between a live session (a
 * human, or the orchestrating session that spawned this drive) and a
 * headless `drive.ts` run in the same working tree.
 *
 * Nothing in this skill previously let a live session get a message INTO a
 * running headless drive at all, short of `drives.ts --stop` (a hard kill).
 * This is deliberately the smallest thing that closes that gap:
 * append-only JSONL logs under `.context/drive-mailbox/` (gitignored,
 * workspace-scoped — the same granularity as the worktree lock in
 * `store.ts`'s `worktreeLockName`, and NOT the clone-wide state dir: a
 * mailbox is a conversation with THIS tree's driver, not with whichever
 * driver a shared clone-wide file happens to belong to).
 *
 *   inbox.jsonl   one line per message, APPENDED BY ANY SENDER (a human, an
 *                 orchestrating session). Never mutated, never truncated.
 *   outbox.jsonl  one line per ack/response, APPENDED BY THE DRIVER ONLY.
 *
 * Separate files rather than one, so a sender never has to coordinate a write
 * with the driver's own — `fsutil.ts`'s `atomicWrite` (temp-then-rename) is
 * the right primitive for a SINGLE writer replacing a whole file, and the
 * wrong one here: two independent senders racing the same temp name would
 * have one's rename clobber the other's message.
 *
 * ── Why every append IS lock-guarded, despite the name of this section ──
 *
 * Originally: a plain `write(2)` in `a`-mode, no lock — the kernel does not
 * interleave two `write` calls on an append-mode fd against the same file, so
 * concurrent appends from independent processes were safe without one, and a
 * lock file per append (`lib/state/lock.ts`'s mutex) would have bought
 * correctness this channel did not need. That reasoning held only as long as an
 * append WAS a single `write(2)` call with no decision attached to it.
 *
 * The self-healing fix (below) broke that premise: healing a prior interrupted
 * write means READING the file, DECIDING whether to prepend a delimiter, and
 * THEN writing — a multi-step span, not one atomic syscall. Two concurrent
 * appenders can interleave across that span (sender A's read observes a clean
 * file; sender B's own interrupted write leaves an undelimited tail before A's
 * write lands; A's healthy record ends up glued to B's garbage anyway), and
 * `repairInbox` then drops the combined, unparsable line WHOLESALE —
 * permanently losing A's record, not merely poisoning the fold.
 * `MAILBOX_LINE_MAX_BYTES` closes a DIFFERENT gap (a high-level `writeFileSync`
 * is not contractually one `write(2)` syscall even for content under the cap)
 * that this same lock also closes as a side effect: while it is held, no other
 * process's append can even begin, so a short-write retry inside
 * `writeFileSync` can never have another writer's bytes land in the gap.
 *
 * So every append (`appendLine`, below) and every `repairInbox` run now
 * holds the SAME per-file lock (`lib/state/lock.ts`'s `createLock`, keyed
 * on the target path) for its entire read-decide-write span, making all of
 * them fully mutually exclusive against each other. Traffic here is still
 * human-rate (a handful of messages an hour, not a queue), so the lock's
 * cost is negligible in practice; what changed is that self-healing made
 * "no lock needed" genuinely false, not merely conservative.
 *
 * ── Absent vs unreadable, and which callers may treat them alike ───────
 *
 * `readMailboxFile` mirrors `lease.ts`'s `readLeaseForFence` (though it has
 * since diverged on one point — see below): a file that does not exist (ENOENT)
 * is `absent`, and everything else the filesystem could not answer (EACCES, a
 * directory where a file was expected, ENOTDIR from a broken path component, …)
 * is `unreadable`. The two must not collapse into one `null` here, because they
 * mean opposite things for a mechanism whose whole job is to be checked before
 * an irreversible action: no `inbox.jsonl` is the overwhelmingly common case —
 * nobody has ever sent a directive — and must read as CLEAR, or every push on
 * every drive would be gated by a file that was never created. A file that
 * exists but cannot be read is the opposite: something is there and this
 * process cannot see what, so a gate consulting it must fail CLOSED rather than
 * guess "no hold".
 *
 * That polarity applies ONLY to directives, deliberately. A NOTE that fails
 * to parse is dropped with a warning and never blocks anything — it carries
 * no gate, so there is nothing for a fail-closed ruling to protect. A
 * DIRECTIVE line that is present but does not parse (bad JSON, an unknown
 * `command`, a `resume` with no `target`) poisons `foldGateState` the same
 * way an unreadable FILE does: a hand-edited or half-written directive line
 * is exactly the "something is there and unreadable" case, not a reason to
 * fall back to "no hold". `send`'s own validation is what keeps every
 * directive this module WRITES from ever reaching that state; the poisoning
 * rule exists for the file this module did not write itself.
 *
 * A line that fails to parse as JSON AT ALL (not merely shape validation) is a
 * DIFFERENT case, and — after several attempts at narrowing a classifier for it
 * — is handled by NOT classifying it at all: it always poisons,
 * unconditionally. `foldGateState` cannot invoke the strict per-kind parser on
 * unparsable text, so there is no reliable way to tell "a truncated NOTE" apart
 * from "a truncated DIRECTIVE" from the raw bytes alone — every attempt at a
 * heuristic (substring markers, field-order proofs) was a hand-rolled
 * text-matching classifier over adversarial input, which can be defeated
 * indefinitely, one decoy at a time (and was: an early-truncation
 * counterexample defeated the first, then a conflicting/decoy-marker
 * construction defeated its replacement in turn — see `foldGateState`'s own
 * inline comment for the specifics). Unconditional poisoning has no classifier
 * left to defeat. This is safe against the original concern (a malformed NOTE
 * blocking pushes) only because of the `appendLine` self-healing fix below:
 * once every append is guaranteed to start its own delimited line, an
 * unparsable line can only ever be a genuine, ISOLATED interrupted-write tail
 * or deliberate hand-editing — never glued to later complete records — and
 * `repairInbox` is the explicit, human-invoked recovery for it.
 *
 * ── Self-healing a prior interrupted write ──────────────────────────────
 *
 * `appendLine` checks, before every append, whether the file already has
 * content that does not end in a newline — the exact signature of a truncated
 * tail from a crash mid-`write(2)` — and prepends one if so. Only one extra
 * read of a small, human-rate-traffic file, but this decide-then- write span is
 * exactly why appends are now lock-guarded (see "Why every append IS
 * lock-guarded" above) — without the lock, TWO concurrent senders could still
 * interleave across it. Without self-healing at all, a later complete record
 * appended directly onto an undelimited truncated tail would combine into ONE
 * unparsable line carrying both — which no classifier of the corrupted text
 * could safely pull apart, and which unconditional poisoning alone could not
 * make safe either.
 *
 * ── Recovering from a poisoned inbox ────────────────────────────────────
 *
 * Every ordinary path treats `inbox.jsonl` as append-only, but a poisoned
 * line is a standing refusal nothing else in this module can clear — a
 * later valid append is scanned AFTER the corrupt line, never before it, so
 * it can never out-vote a `return { ok: false, ... }` that already fired.
 * `repairInbox` (`mailbox.ts repair <pr>`) is the one deliberate, explicit,
 * human-invoked exception to "never mutated, never truncated": it rewrites
 * the file keeping every line that parses as JSON, however it later
 * shape-validates, and drops only lines JSON.parse itself rejects — the
 * interrupted-write artifact this section describes, never a merely
 * malformed-but-intentional directive a human should see and decide about.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, isDigits } from "../cli.ts";
import { worktreeRoot } from "./actor.ts";
import {
  atomicWrite,
  fsyncDirectoryBestEffort,
  writeAllSync,
} from "./fsutil.ts";
import { createLock } from "./lock.ts";

export const MAILBOX_DIRNAME = "drive-mailbox";

/** One JSONL line, whole, must fit in a single atomic `write(2)` — see header. */
export const MAILBOX_LINE_MAX_BYTES = 4096;

export const DIRECTIVE_COMMANDS = [
  "hold-push",
  "pause",
  "stop",
  "resume",
] as const;
export type DirectiveCommand = (typeof DIRECTIVE_COMMANDS)[number];

/** The directive classes `resume` may target — never `resume` itself. */
export const GATE_NAMES = ["hold-push", "pause", "stop"] as const;
export type GateName = (typeof GATE_NAMES)[number];

export interface NoteMessage {
  id: string;
  ts: string;
  kind: "note";
  from: string;
  pr: string;
  body: string;
}

export interface DirectiveMessage {
  id: string;
  ts: string;
  kind: "directive";
  from: string;
  pr: string;
  command: DirectiveCommand;
  /** Required (and only meaningful) when `command === 'resume'`. */
  target?: GateName;
  body?: string;
}

export type InboxMessage = NoteMessage | DirectiveMessage;

export interface OutboxRecord {
  id: string;
  ts: string;
  /**
   * The PR this ack/response belongs to. Required so `unseenMessages` can
   * scope the ack cursor per PR — see that function's own comment: without
   * this, a message id is the ONLY key, and a worktree reused across PRs (or
   * a collision among the 64-bit random ids `newId()` mints) lets one PR's
   * outbox record silently acknowledge another PR's still-unseen message.
   */
  pr: string;
  status: "received" | "done";
  response?: string;
}

export function mailboxDir(worktreeRootPath: string): string {
  return join(worktreeRootPath, ".context", MAILBOX_DIRNAME);
}

/**
 * `mailboxDir(await worktreeRoot())`, with the same escape hatch
 * `store.ts`'s `resolveStateDir` and `finish-round.ts`'s handoff dir give an
 * operator or a test: `$DRIVE_PR_MAILBOX_DIR` overrides it outright. Tests
 * need this because the shared `guarded-push.ts` test fixture stubs `git
 * rev-parse --show-toplevel` to a fixed path unrelated to any real mailbox
 * directory (see `__tests__/drive-pr.test.ts`'s `guardedPush()` helper) —
 * without an override, every mailbox-aware test would read and write the
 * real repository checkout's own `.context/drive-mailbox`.
 */
export async function resolveMailboxDir(): Promise<string> {
  const override = process.env.DRIVE_PR_MAILBOX_DIR ?? "";
  if (override !== "") return resolve(override);
  return mailboxDir(await worktreeRoot());
}

export function inboxPath(dir: string): string {
  return join(dir, "inbox.jsonl");
}

export function outboxPath(dir: string): string {
  return join(dir, "outbox.jsonl");
}

// 8 bytes (64 bits), not 4 (32): `unseenMessages` builds its acknowledgement
// cursor from `(pr, id)` alone, so a same-PR collision would let acking EITHER
// message silently hide both. 32 bits made that a real (if low-probability)
// risk at this traffic level; 64 bits pushes the birthday-bound collision point
// to billions of messages per PR — well past anything this human-rate channel
// will ever see.
function newId(): string {
  return `m-${randomBytes(8).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** `readLeaseForFence`'s absent/unreadable/ok split, ported for this module. */
export type MailboxFileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; why: string }
  | { kind: "ok"; raw: string };

export function readMailboxFile(path: string): MailboxFileRead {
  // `lstat` first, not `readFileSync`'s own errno — see `readLeaseForFence`'s
  // own comment on why: it is the one call that can tell "gone" apart from
  // "here, but broken" for a dangling symlink at this exact path.
  try {
    lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ENOENT alone, not ENOTDIR too: POSIX only raises ENOTDIR when a path
    // COMPONENT that traversal needs to descend through exists but is the WRONG
    // type (a regular file sitting where a directory belongs) — it can never
    // mean "genuinely nothing there", which is what ENOENT already covers on
    // its own. Treating ENOTDIR as `absent` folded a broken mailbox location
    // (e.g. `.context/drive-mailbox` existing as a FILE, not a directory) as
    // CLEAR: `foldGateState` would report every gate open and `guarded-push.ts`
    // could push with an active hold-push never actually inspected.
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", why: code ?? String(e) };
  }
  try {
    return { kind: "ok", raw: readFileSync(path, "utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { kind: "unreadable", why: code ?? String(e) };
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * A PR string in the ONE canonical form every writer in this module produces
 * (`resolvePrArg`'s own `BigInt(...).toString()`), not merely digits:
 * `isDigits` alone still accepts a leading-zero form like `'0999'`, which is a
 * DIFFERENT string from the canonical `'999'` this module compares against
 * everywhere with plain `===`. Treating `'0999'` as "a valid PR that just
 * happens to differ" let a corrupt or hand-edited directive naming that
 * non-canonical form be skipped as out-of-scope instead of poisoning —
 * identical malformed-PR risk to an empty or non-numeric string, just with a
 * subtler counterexample. `s !== '0'` closes the sibling gap in that same fix:
 * `'0'` is both `isDigits` AND its own canonical form (`BigInt('0').toString()
 * === '0'`), but GitHub PR numbers are never `0` — a directive naming it
 * identifies no REAL PR any more than `'0999'` does, and was still being
 * treated as a valid-but-different PR to skip rather than poisoning.
 */
function isCanonicalPr(s: string): boolean {
  return isDigits(s) && s !== "0" && BigInt(s).toString() === s;
}

/**
 * Shape-validate one already-parsed JSON value as an `InboxMessage`, or `null`
 * if it is not one — the per-LINE counterpart to `readMailboxFile`'s per-FILE
 * distinction. Every field is required, with no accepts-both-shapes leniency: a
 * partial record here is debris, not a legacy shape to tolerate.
 */
export function parseInboxMessage(v: unknown): InboxMessage | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) return null;
  if (!isNonEmptyString(r.ts) || !Number.isFinite(Date.parse(r.ts)))
    return null;
  if (!isNonEmptyString(r.from)) return null;
  if (!isNonEmptyString(r.pr)) return null;
  if (r.kind === "note") {
    if (typeof r.body !== "string") return null;
    return {
      id: r.id,
      ts: r.ts,
      kind: "note",
      from: r.from,
      pr: r.pr,
      body: r.body,
    };
  }
  if (r.kind === "directive") {
    if (!DIRECTIVE_COMMANDS.includes(r.command as DirectiveCommand))
      return null;
    const command = r.command as DirectiveCommand;
    if (command === "resume") {
      if (!GATE_NAMES.includes(r.target as GateName)) return null;
    } else if (r.target !== undefined) {
      // A non-resume directive carrying a target is not a shape this
      // module's own writer produces — refuse rather than silently ignore
      // the extra field, the same "partial/malformed record is debris"
      // ruling `schema.ts` applies to `DriveState`.
      return null;
    }
    if (r.body !== undefined && typeof r.body !== "string") return null;
    const msg: DirectiveMessage = {
      id: r.id,
      ts: r.ts,
      kind: "directive",
      from: r.from,
      pr: r.pr,
      command,
    };
    if (command === "resume") msg.target = r.target as GateName;
    if (typeof r.body === "string") msg.body = r.body;
    return msg;
  }
  return null;
}

export function parseOutboxRecord(v: unknown): OutboxRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) return null;
  if (!isNonEmptyString(r.ts) || !Number.isFinite(Date.parse(r.ts)))
    return null;
  if (!isNonEmptyString(r.pr)) return null;
  if (r.status !== "received" && r.status !== "done") return null;
  // A discriminated shape, not "response, if present, must be a string": a
  // malformed writer or a hand-edited recovery line could otherwise produce
  // `status: 'done'` with a missing or empty `response`, which `mailbox.ts
  // outbox` would then report as a completed answer with nothing IN it, while
  // `unseenMessages` treats the id as acknowledged and suppresses redelivery —
  // leaving the original sender with neither a response nor a warning. `done`
  // REQUIRES a non-empty response; `received` must NOT carry one, since it is
  // not an answer yet.
  if (r.status === "done") {
    if (!isNonEmptyString(r.response)) return null;
  } else if (r.response !== undefined) {
    return null;
  }
  const rec: OutboxRecord = { id: r.id, ts: r.ts, pr: r.pr, status: r.status };
  if (r.status === "done") rec.response = r.response as string;
  return rec;
}

/** Non-blank lines only — a trailing newline must not read as an empty record. */
function splitJsonl(raw: string): string[] {
  return raw.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Self-healing (see the module header) reads the file, decides whether to
 * prepend a delimiting newline, and THEN writes — a decide-then-act span that
 * is no longer a single atomic syscall, unlike an ordinary append. Two
 * concurrent senders can interleave across that span: A's read observes a clean
 * file, B's own interrupted write leaves an undelimited tail before A's write
 * lands, and A's healthy record ends up glued to B's garbage anyway — which
 * `repairInbox` then drops WHOLESALE, permanently losing A's record rather than
 * merely poisoning the fold. A lock around the whole decide-then-write span is
 * what actually closes it, not a smaller read-write gap: this is the one place
 * in the module where the header's "no lock needed" append-atomicity argument
 * no longer holds, because self-healing turned a single write(2) into a
 * read-then-write. Scoped per FILE (the lock key is `path` itself, inbox and
 * outbox locked independently) so an inbox sender is never blocked by outbox
 * traffic or vice versa.
 */
async function appendLine(path: string, line: string): Promise<void> {
  // `recursive: true` returns the SHALLOWEST directory it had to create
  // (`undefined` if the whole chain already existed). Used only to
  // EXTEND the fixed 2-level walk below for a `$DRIVE_PR_MAILBOX_DIR`
  // override deeper than the default layout — see that walk's own doc
  // for why it is not, on its own, a safe basis for deciding whether to
  // fsync at all.
  const firstCreatedDir = mkdirSync(dirname(path), { recursive: true });
  const lock = createLock(path, "mailbox.ts (append)", "mailbox");
  await lock.acquire();
  try {
    const existing = readMailboxFile(path);
    if (existing.kind === "unreadable") {
      // An unreadable-but-appendable file (write-only permissions, a transient
      // read error, ...) is NOT the same as absent-or-clean — this predicate
      // cannot see whether the existing tail already ends with a newline, so
      // appending blind risks gluing this record onto a truncated or
      // non-delimited line. `repairInbox` then drops that COMBINED line
      // wholesale, permanently losing this record instead of merely poisoning
      // the fold it would have poisoned on its own. Fail closed rather than
      // guess.
      fail(
        2,
        `mailbox: ${path} exists but could not be read (${existing.why}) — refusing to append blind.`,
        "Appending without knowing whether the existing tail already ends in a",
        "newline risks gluing this record onto a truncated line, which repair",
        "then drops WHOLESALE rather than merely poisoning the fold. Fix the",
        "underlying read failure (often a permissions issue) and retry, or run",
        "mailbox.ts repair once the file is readable again.",
      );
    }
    const needsLeadingNewline =
      existing.kind === "ok" &&
      existing.raw.length > 0 &&
      !existing.raw.endsWith("\n");
    const content = needsLeadingNewline ? `\n${line}` : line;
    // Checked against the FINAL content actually written, not just `line` — a
    // record already at the cap would otherwise pass this check and then grow
    // past it once the healing newline above is prepended, breaking the
    // single-write atomicity bound precisely during the recovery case this fix
    // exists for.
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAILBOX_LINE_MAX_BYTES) {
      fail(
        2,
        `mailbox: record is ${bytes} bytes, over the ${MAILBOX_LINE_MAX_BYTES}-byte cap.`,
        "Appends here rely on a single write(2) call being atomic, which this",
        "module only guarantees under that cap — see lib/state/mailbox.ts header.",
        "Shorten the body rather than raising the cap.",
      );
    }
    // A plain `writeFileSync(path, content, { flag: 'a' })` reports
    // success once the bytes reach the page cache, not stable storage —
    // on a crash or power loss immediately after, a `hold-push` directive
    // could be lost (or, for the FIRST record in a new file, the
    // directory entry itself could be lost) while `foldGateState` reads
    // the resulting absent/empty file as CLEAR and lets a push through it
    // should have blocked.
    // Explicit open+write+fsync+close instead, mirroring `atomicWrite`'s
    // own hardening in `fsutil.ts`.
    const fileIsNew = existing.kind === "absent";
    const fd = openSync(path, "a");
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
    if (primaryFailed || closeFailed) {
      // Lock-guarded, so `fileIsNew` (computed above, under the SAME lock) is a
      // race-free signal for "did THIS call create `path`": no other
      // `appendLine` caller can be concurrently touching the same path while
      // this lock is held. If this call is the one that created the file and
      // the write/fsync/close then failed, the empty-or-partial file left
      // behind would make a SUBSEQUENT retry observe `existing.kind === 'ok'` —
      // not `absent` — setting `fileIsNew` false and skipping the
      // ancestor-directory fsyncs below entirely, even though nobody has ever
      // run them. A power loss after that later, otherwise-successful retry
      // could then discard the directory entry (including a successfully
      // retried `hold-push`) despite the retry's own file content being
      // durable. Unlinking here restores the `absent` state for the next
      // attempt to correctly re-observe, mirroring `atomicWrite`'s own
      // established cleanup-on-failure pattern in `fsutil.ts`.
      if (fileIsNew) {
        try {
          unlinkSync(path);
        } catch {
          // Best-effort — the original error is what the caller needs to
          // see, not a secondary one from trying to tidy up after it.
        }
      }
      if (primaryFailed) throw primaryError;
      throw closeError;
    }
    if (fileIsNew) {
      // The write above only makes the FILE's own bytes durable. Its own
      // directory ENTRY (in `dirname(path)`) is a separate durability
      // concern a file's own fsync does not cover — and if THIS call is
      // also what created `dirname(path)` (or its own parent, e.g.
      // `.context` not existing yet either), that directory has the
      // identical problem one level up: its own entry lives in ITS
      // parent.
      //
      // Walking exactly as far as THIS call's own `mkdirSync(...,
      // {recursive:true})` reported creating would be racy: concurrent
      // first-senders on a fresh worktree can interleave so that whichever one
      // actually created `.context` is not the one whose `existing.kind`
      // observes `absent` (and so never reaches this branch at all), while the
      // one that DOES reach it sees its own `mkdirSync` return `undefined` (the
      // chain already existed by the time it ran) and has no way to know a
      // sibling level was created moments ago by someone else. The fixed floor
      // below closes that by not depending on per-process "who created what" at
      // all: `mailboxDir()` fixes this module's own directory nesting at
      // exactly two levels below the worktree root (`.context/drive-mailbox`),
      // so every sender that observes `fileIsNew` unconditionally fsyncs three
      // FIXED candidate levels regardless of who created any of them.
      //
      // That fixed depth is itself a gap under `$DRIVE_PR_MAILBOX_DIR`: the
      // override permits an ARBITRARILY deep path, and `mkdirSync`'s own
      // recursive create walks as far up as it needs to — a chain missing MORE
      // than two levels would leave the higher, still-new ancestors unfsynced.
      // `firstCreatedDir` (this call's own `mkdirSync` report) extends the walk
      // past the fixed floor whenever it reports something shallower than three
      // levels up — safe to use for EXTENDING (never for deciding whether to
      // fsync at all, which is exactly the race the fixed floor closes): the
      // two mechanisms are independent, so even if this call's own `mkdirSync`
      // under-reports depth due to a race, the fixed three-level floor below
      // still fires unconditionally.
      const fixedFloor = dirname(dirname(dirname(path)));
      const mkdirBound =
        firstCreatedDir === undefined
          ? dirname(path)
          : dirname(firstCreatedDir);
      let level = dirname(path);
      let reachedFixedFloor = false;
      let reachedMkdirBound = false;
      try {
        while (!reachedFixedFloor || !reachedMkdirBound) {
          fsyncDirectoryBestEffort(level);
          if (level === fixedFloor) reachedFixedFloor = true;
          if (level === mkdirBound) reachedMkdirBound = true;
          const parent = dirname(level);
          // Defensive only: `mkdirBound` is documented to be an ancestor
          // (or equal to) `dirname(path)`, and `fixedFloor` always is by
          // construction, so this should be unreachable — but the
          // filesystem root is its own `dirname`, and looping past it
          // would spin forever rather than merely over-fsync.
          if (parent === level) break;
          level = parent;
        }
      } catch (e) {
        // A genuine failure here (EIO, ENOSPC — the codes
        // `fsyncDirectoryBestEffort` does NOT swallow) leaves the file's own
        // bytes durable but an ancestor directory entry unflushed. Without
        // this cleanup, a caller's retry would observe the file via
        // `readMailboxFile` (`existing.kind !== 'absent'`), compute
        // `fileIsNew = false`, and skip this whole block on the retry —
        // silently abandoning the still-unflushed directory entry rather
        // than redoing it. Unlinking restores the `absent` state so the
        // retry re-observes `fileIsNew = true` and redoes the full walk,
        // mirroring the primary write/fsync/close cleanup above.
        try {
          unlinkSync(path);
        } catch {
          // Best-effort — the original error is what the caller needs to
          // see, not a secondary one from trying to tidy up after it.
        }
        throw e;
      }
    }
  } finally {
    lock.release();
    lock.dispose();
  }
}

export async function appendNote(
  dir: string,
  pr: string,
  from: string,
  body: string,
): Promise<NoteMessage> {
  const msg: NoteMessage = {
    id: newId(),
    ts: nowIso(),
    kind: "note",
    from,
    pr,
    body,
  };
  await appendLine(inboxPath(dir), `${JSON.stringify(msg)}\n`);
  return msg;
}

export async function appendDirective(
  dir: string,
  pr: string,
  from: string,
  command: DirectiveCommand,
  opts: { target?: GateName; body?: string } = {},
): Promise<DirectiveMessage> {
  if (command === "resume" && opts.target === undefined) {
    fail(2, "mailbox: 'resume' requires --target hold-push|pause|stop");
  }
  if (command !== "resume" && opts.target !== undefined) {
    fail(2, `mailbox: --target is only valid with 'resume', not '${command}'`);
  }
  const msg: DirectiveMessage = {
    id: newId(),
    ts: nowIso(),
    kind: "directive",
    from,
    pr,
    command,
  };
  if (opts.target !== undefined) msg.target = opts.target;
  if (opts.body !== undefined) msg.body = opts.body;
  await appendLine(inboxPath(dir), `${JSON.stringify(msg)}\n`);
  return msg;
}

export async function appendOutboxRecord(
  dir: string,
  rec: OutboxRecord,
): Promise<void> {
  await appendLine(outboxPath(dir), `${JSON.stringify(rec)}\n`);
}

/**
 * Read the inbox, scoped to `pr` — a message stamped for a different PR is
 * ignored rather than trusted, so a workspace later reused to drive a
 * different PR cannot inherit a stale directive. Malformed lines (bad JSON,
 * or JSON that fails `parseInboxMessage`) are dropped and counted in
 * `warnings`, never thrown — this reader is shared by the advisory `check`
 * path, where a bad line must not stop the read.
 */
export function readInboxMessages(
  dir: string,
  pr: string,
): { file: MailboxFileRead; messages: InboxMessage[]; warnings: string[] } {
  const file = readMailboxFile(inboxPath(dir));
  const messages: InboxMessage[] = [];
  const warnings: string[] = [];
  if (file.kind !== "ok") return { file, messages, warnings };
  for (const line of splitJsonl(file.raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`unparsable inbox line: ${line.slice(0, 120)}`);
      continue;
    }
    const msg = parseInboxMessage(parsed);
    if (msg === null) {
      warnings.push(`malformed inbox message: ${line.slice(0, 120)}`);
      continue;
    }
    if (msg.pr !== pr) continue;
    messages.push(msg);
  }
  return { file, messages, warnings };
}

/**
 * Malformed/unparsable lines are reported in `warnings`, mirroring
 * `readInboxMessages`'s own pattern — never silently dropped. A corrupted
 * `received` ack looking like "no ack at all" makes `unseenMessages`
 * redeliver that inbox message (the safe direction, matching this
 * module's delivery ordering elsewhere), and a corrupted `done` response
 * looking like "no response" leaves a polling sender waiting on one that
 * actually exists but is damaged — neither is dangerous, but both were
 * previously silent, with no diagnostic anywhere a human could act on.
 */
function readOutboxRecords(dir: string): {
  file: MailboxFileRead;
  records: OutboxRecord[];
  warnings: string[];
} {
  const file = readMailboxFile(outboxPath(dir));
  const records: OutboxRecord[] = [];
  const warnings: string[] = [];
  if (file.kind !== "ok") return { file, records, warnings };
  for (const line of splitJsonl(file.raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`unparsable outbox line: ${line.slice(0, 120)}`);
      continue;
    }
    const rec = parseOutboxRecord(parsed);
    if (rec === null) {
      warnings.push(`malformed outbox record: ${line.slice(0, 120)}`);
      continue;
    }
    records.push(rec);
  }
  return { file, records, warnings };
}

export type OutboxRecordsResult =
  | { ok: true; records: OutboxRecord[]; warnings: string[] }
  | { ok: false; why: string };

/**
 * Every outbox record for `pr`, in file order — what `mailbox.ts outbox`
 * exposes so a sender can poll for a `respond()` (the "second check-like
 * read" the module header promises, which had no command reaching it before
 * this). An UNREADABLE outbox is an explicit `ok: false`, never a silent
 * empty list — the earlier version discarded `readOutboxRecords`'s own
 * `file` status entirely, so an EACCES/I/O failure looked identical to "no
 * responses yet" to a polling sender. An
 * ABSENT outbox is a genuine `ok: true, records: []` — nobody has responded
 * yet, the overwhelmingly common case.
 */
export function outboxRecordsForPr(
  dir: string,
  pr: string,
): OutboxRecordsResult {
  const outbox = readOutboxRecords(dir);
  if (outbox.file.kind === "unreadable") {
    return {
      ok: false,
      why: `outbox.jsonl exists but could not be read (${outbox.file.why})`,
    };
  }
  return {
    ok: true,
    records: outbox.records.filter((r) => r.pr === pr),
    warnings: outbox.warnings,
  };
}

export type UnseenMessagesResult =
  | { ok: true; messages: InboxMessage[]; warnings: string[] }
  | { ok: false; why: string };

/**
 * Messages this driver has not yet acknowledged — the outbox IS the cursor
 * (no separate offset file that could fall out of sync with the log it
 * tracks): anything in the inbox whose id has no outbox record at all is
 * unseen. A pure read: acknowledging is `ack()`'s job alone (`mailbox.ts ack
 * <pr> --id ID`), invoked explicitly once the caller has actually acted on a
 * message — never folded into this read, so "the read succeeded" is never
 * mistaken for "the caller safely received it".
 *
 * Both reads' `file` status is checked explicitly rather than discarded —
 * the earlier version silently reported `{messages: [], warnings: []}` for
 * an UNREADABLE inbox (indistinguishable from "nothing pending" to a human
 * relying on `check` to see a `hold-push` others sent) and, worse, treated
 * an unreadable OUTBOX as an empty ack cursor, which would re-report every
 * historical inbox message as unseen — breaking the "acknowledged messages
 * are not re-reported" guarantee this function's own docs promise.
 */
export function unseenMessages(dir: string, pr: string): UnseenMessagesResult {
  const inbox = readInboxMessages(dir, pr);
  if (inbox.file.kind === "unreadable") {
    return {
      ok: false,
      why: `inbox.jsonl exists but could not be read (${inbox.file.why})`,
    };
  }
  const outbox = readOutboxRecords(dir);
  if (outbox.file.kind === "unreadable") {
    return {
      ok: false,
      why: `outbox.jsonl exists but could not be read (${outbox.file.why})`,
    };
  }
  // Scoped to `pr`: an id is a 16-hex-char (64-bit) random token, not a
  // guaranteed-unique key, and a worktree reused across PRs leaves an
  // earlier PR's outbox records in the same file — see `OutboxRecord.pr`'s
  // own comment.
  const acked = new Set(
    outbox.records.filter((r) => r.pr === pr).map((r) => r.id),
  );
  return {
    ok: true,
    messages: inbox.messages.filter((m) => !acked.has(m.id)),
    warnings: [...inbox.warnings, ...outbox.warnings],
  };
}

interface DirectiveState {
  active: boolean;
  since: string | null;
  by: string | null;
}

export interface GateState {
  "hold-push": DirectiveState;
  pause: DirectiveState;
  stop: DirectiveState;
}

function freshGateState(): GateState {
  const inactive = (): DirectiveState => ({
    active: false,
    since: null,
    by: null,
  });
  return { "hold-push": inactive(), pause: inactive(), stop: inactive() };
}

export type GateStateResult =
  | { ok: true; state: GateState; warnings: string[] }
  | { ok: false; why: string };

/**
 * Best-effort classifier for a line `JSON.parse` could not read at all —
 * the fallback `foldGateState` needs when the strict per-kind parser has
 * nothing to work with. See the module header's "That split has to hold
 * even when a line fails to parse as JSON AT ALL" section for why this
 * exists and what each branch means.
 *
 * A first version classified an unparsable line as "safe to drop" purely by
 * whether a directive marker appeared in it — defeated by a truncation before
 * `kind` was even reached. Its replacement required POSITIVE evidence of a note
 * (a complete `"kind":"note"` token, plus a readable-different-PR carve-out) —
 * defeated in turn by an adversarial construction with a conflicting or decoy
 * marker (`{"pr":"999","kind":"directive" garbage "kind":"note"}` matches the
 * note regex despite visibly attempting a directive; a decoy `pr` token ahead
 * of the real one defeats the different-PR carve-out the same way). Repeated
 * narrowing of the same regex-over-raw-text classifier shows the general hazard
 * in miniature: a hand-rolled text-matching model stays one counterexample
 * behind.
 *
 * So there is no classifier here anymore: a line JSON.parse itself rejects
 * ALWAYS poisons, unconditionally — no leniency, no substring matching, no
 * regex to defeat. This is safe to do without reopening the original concern (a
 * malformed NOTE blocking pushes) because the `appendLine` self-healing fix
 * changed what "unparsable" can even mean going forward: every append now
 * checks whether the file already ends in a newline and inserts one first if
 * not, so an interrupted write's truncated tail can never again be glued to a
 * LATER complete record — it stays isolated as its own line. The only way an
 * unparsable line can now exist at all is a genuine, isolated interrupted-write
 * tail, or deliberate hand- editing — and `mailbox.ts repair <pr>` (below) is
 * the explicit, auditable, human-invoked recovery for exactly that case. A
 * record that DOES parse but doesn't classify as either message type is a
 * separate, SAFE check further down — exact structural equality on a properly
 * parsed object's `kind` field, not regex-over-text, and not subject to this
 * class of bug at all.
 */

/**
 * Fold the inbox into the current directive state, latest-per-class wins —
 * the same construction `TreeLease`/`HeldItem` use for "what is true right
 * now" over an append-only or upsert log.
 *
 * `ok: false` is the fail-closed signal a gating caller (`guarded-push.ts`)
 * must treat as "blocked, not clear": either the file itself is unreadable,
 * or some DIRECTIVE line in it does not parse — see the header comment on
 * why a malformed directive poisons this fold while a malformed NOTE merely
 * gets dropped (`warnings`).
 */
export function foldGateState(dir: string, pr: string): GateStateResult {
  const file = readMailboxFile(inboxPath(dir));
  if (file.kind === "absent") {
    return { ok: true, state: freshGateState(), warnings: [] };
  }
  if (file.kind === "unreadable") {
    return {
      ok: false,
      why: `inbox.jsonl exists but could not be read (${file.why})`,
    };
  }
  const state = freshGateState();
  const warnings: string[] = [];
  for (const line of splitJsonl(file.raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Cannot classify a line JSON itself rejects — always poisons,
      // unconditionally. See the comment above this loop for why there is
      // no leniency here anymore, and `mailbox.ts repair <pr>` for the
      // explicit recovery path.
      return {
        ok: false,
        why: `unparsable inbox line: ${line.slice(0, 120)}`,
      };
    }
    const asRecord =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (asRecord === null) {
      // Valid JSON, but not a plain object at all — `null`, an array, a bare
      // string or number. Cannot be classified as either a note or a directive,
      // so — like an unparsable line with no positive note evidence — this is
      // ambiguous and must poison, not silently vanish from the scanned
      // population (unreadable input fails closed).
      return {
        ok: false,
        why: `malformed inbox line: ${line.slice(0, 120)}`,
      };
    }
    // PR-scope BEFORE the strict shape/kind validation below, so a malformed
    // record stamped for a DIFFERENT PR (a stale leftover in a worktree reused
    // across PRs, most plausibly) is skipped like any other out-of-scope line
    // rather than poisoning every OTHER PR's fold. Only a record naming a
    // VALID, CANONICAL PR that differs from this one is skipped this way —
    // `isCanonicalPr`, not merely `typeof === 'string'` or bare `isDigits`: a
    // malformed `pr` field (`""`, `"abc"`, or a leading-zero non-canonical form
    // like `"0999"`) does not name ANY identifiable other PR, so it is exactly
    // as ambiguous as a record naming no PR at all and must fall through to the
    // classification below rather than be silently skipped as out-of-scope
    // (`isDigits` alone misses the leading-zero form).
    if (
      typeof asRecord.pr === "string" &&
      isCanonicalPr(asRecord.pr) &&
      asRecord.pr !== pr
    )
      continue;
    // A record whose `kind` is LITERALLY `'note'` is not this fold's
    // concern — never poisons it, whatever its OTHER fields say (a note
    // missing its `body`, say — still unambiguously a note attempt, just an
    // invalid one, and it carries no gate). It IS reported in `warnings`
    // when malformed, though: silently dropping it with no diagnostic
    // anywhere contradicted this module's own "dropped with a warning"
    // promise. A genuinely well-formed
    // note produces no warning — nothing was actually dropped.
    if (asRecord.kind === "note") {
      // A record with `kind: 'note'` that ALSO carries a directive-only
      // field (`command`/`target`) is not "unambiguously a note attempt" —
      // `parseInboxMessage`'s note branch only reads `body` and silently
      // ignores the rest, so a well-formed note with `command: 'hold-push'`
      // riding along would pass this carve-out as clear even though it
      // looks exactly like an attempted, but malformed, directive.
      // `repairInbox` cannot clear this either: it only drops lines that
      // fail to parse as JSON at all, and this one parses fine. Checked
      // BEFORE the note carve-out decides to skip gating, so this poisons
      // the fold the same way any other ambiguous shape does, rather than
      // being waved through as a merely-malformed note.
      if (asRecord.command !== undefined || asRecord.target !== undefined) {
        return {
          ok: false,
          why: `note carries a directive-only field: ${line.slice(0, 120)}`,
        };
      }
      if (parseInboxMessage(parsed) === null) {
        warnings.push(`malformed note: ${line.slice(0, 120)}`);
      }
      continue;
    }
    if (asRecord.kind !== "directive") {
      // `kind` is missing, misspelled, or the wrong type — this is the narrower
      // gap: NEITHER a recognized note NOR a recognized directive is not "safe
      // to ignore", it is ambiguous (could have been an interrupted or
      // corrupted directive), so it poisons like the unclassifiable case above.
      return {
        ok: false,
        why: `malformed inbox line: ${line.slice(0, 120)}`,
      };
    }
    const msg = parseInboxMessage(parsed);
    if (msg === null || msg.kind !== "directive") {
      return {
        ok: false,
        why: `malformed directive line: ${line.slice(0, 120)}`,
      };
    }
    // `parseInboxMessage` only validates `pr` as a non-empty STRING (it is
    // shape validation, not business-logic PR matching), so a directive with a
    // malformed `pr` (`""`, `"abc"`, `"0999"`) can reach here successfully
    // parsed. The SAME sibling bug as the early `asRecord.pr` check above: only
    // a valid canonical PR that differs from this one is genuinely out-of-scope
    // and safe to skip; anything else does not identify ANY PR and must poison,
    // not be silently treated as scoped to THIS PR by falling through (an
    // `isDigits`-only check misses the leading-zero form).
    if (!isCanonicalPr(msg.pr)) {
      return {
        ok: false,
        why: `directive line has a malformed pr: ${line.slice(0, 120)}`,
      };
    }
    if (msg.pr !== pr) continue;
    if (msg.command === "resume") {
      // Validated at parse time: `target` is present for every 'resume'.
      const target = msg.target as GateName;
      state[target] = { active: false, since: msg.ts, by: msg.id };
    } else {
      state[msg.command] = { active: true, since: msg.ts, by: msg.id };
    }
  }
  return { ok: true, state, warnings };
}

/**
 * `guarded-push.ts`'s own question, answered here rather than re-derived
 * there: is a push blocked right now, and why. Fail-closed on anything
 * `foldGateState` could not resolve — see that function's own doc.
 */
export function isPushHeld(
  dir: string,
  pr: string,
): { blocked: boolean; reason: string } {
  const result = foldGateState(dir, pr);
  if (!result.ok) {
    return {
      blocked: true,
      reason: `mailbox gate state could not be read (${result.why}) — refusing to push on an unknown hold state`,
    };
  }
  const hold = result.state["hold-push"];
  if (hold.active) {
    return {
      blocked: true,
      reason: `an active 'hold-push' mailbox directive (${hold.by}, since ${hold.since}) is blocking this push`,
    };
  }
  return { blocked: false, reason: "" };
}

/**
 * Exit code for "a `hold-push` directive is blocking this push" — shared by
 * `guarded-push.ts` (its own pre-push refusal, and the mapping of a push the
 * hook aborted) and `push-hold-recheck.ts` (the hook step itself). See
 * `guarded-push.ts`'s exit-code doc for why 17 and not a lower number.
 */
export const PUSH_HELD_EXIT = 17;

/**
 * Printed by `push-hold-recheck.ts` when it aborts a push for a hold but could
 * not write its abort marker file, so `guarded-push.ts` can still report the
 * recoverable `PUSH_HELD_EXIT` instead of a generic failure.
 *
 * Carries the per-push nonce `guarded-push.ts` exported for exactly this push
 * (`$DRIVE_PR_HOLD_RECHECK_NONCE`): the captured output also holds every other
 * hook's and the remote's text, and a fixed string there would let a failed
 * gate that merely prints it be relabelled a hold abort. Only the recheck
 * step, which reads the nonce from its environment, is expected to emit it.
 */
export function holdAbortUnmarkedSentinel(nonce: string): string {
  return `push-hold-recheck: hold-abort-unmarked ${nonce}`;
}

/**
 * `isPushHeld`, evaluated under the SAME per-file lock `appendLine` holds for
 * its own read-decide-write span, and released again before returning.
 *
 * The lock is held for the READ only, never across the push. Holding it across
 * `git push` would block every `mailbox.ts send` for as long as the pre-push
 * hook runs — a `hold-push` sent during those minutes could not land at all,
 * which is the opposite of what a hold is for. Coordination with an in-flight
 * push is done at the other end instead: `push-hold-recheck.ts` re-reads this
 * as the LAST pre-push hook step, so a hold that landed at any point during
 * validation aborts the push before git transfers anything.
 *
 * Reading under the lock still matters: `appendLine` writes a directive as
 * one delimited append under it, so a read here observes either the whole
 * line or none of it — never a torn tail, which `foldGateState` would
 * (correctly) fail closed on and abort a push over a hold nobody intended.
 * `mkdirSync` mirrors `appendLine`'s own non-recursive-lock-needs-its-parent
 * requirement — harmless on a fresh worktree that never sent anything, since
 * an empty mailbox directory is equivalent to no mailbox everywhere else in
 * this module.
 */
export async function readPushHoldUnderLock(
  dir: string,
  pr: string,
  label: string,
): Promise<{ blocked: boolean; reason: string }> {
  const path = inboxPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const lock = createLock(path, label, "mailbox");
  await lock.acquire();
  try {
    return isPushHeld(dir, pr);
  } finally {
    lock.release();
    lock.dispose();
  }
}

/** Existence check used by callers deciding whether to bother resolving a dir at all. */
export function mailboxExists(dir: string): boolean {
  return existsSync(inboxPath(dir)) || existsSync(outboxPath(dir));
}

export type RepairResult =
  | {
      ok: true;
      path: string;
      totalLines: number;
      droppedLines: number;
      /** Truncated previews of the dropped lines, in file order. */
      dropped: string[];
    }
  | { ok: false; path: string; why: string };

/**
 * The one deliberate, human-invoked exception to "never mutated, never
 * truncated" — see the module header's "Recovering from a poisoned inbox"
 * section. Rewrites `inbox.jsonl` keeping every line that parses as JSON,
 * however it later shape-validates (a malformed-but-real directive is data
 * a human should look at, not silently discard) — and drops only the lines
 * `JSON.parse` itself rejects, the interrupted-write artifact this exists
 * to clear. `dryRun` reports without writing.
 *
 * `absent` and `unreadable` are NOT the same outcome, mirroring
 * `readMailboxFile`'s own split: absent is a genuine "nothing to repair"
 * (`ok: true`, zero lines), while unreadable (a permissions error, a
 * directory where a file was expected, …) is an explicit failure — a repair
 * that quietly reported "0 dropped" for both would read as "your inbox is
 * clean" to an operator on a run where the inbox was never even inspected,
 * while `foldGateState`/`isPushHeld` keep failing closed on the very same
 * unreadable file underneath them.
 *
 * The rewrite IS coordinated with `appendLine` — both hold the SAME per-file
 * lock (see the module header's "Why every append IS lock-guarded" section) for
 * their entire read-decide-write span, making repair and every append fully
 * mutually exclusive. An earlier design relied only on a re-read-before-write
 * reconciliation (`appendedSince`, below), which narrowed the window without
 * closing it; the lock replaced it because the SAME residual could produce a
 * glued line `repairInbox` would then drop wholesale, permanently losing a
 * valid directive, not merely poisoning the fold. `appendedSince` remains as
 * defense-in-depth for a writer that somehow does not go through this module's
 * own lock at all — there is none today — not as the primary guarantee it once
 * was.
 */
/**
 * The pure part of the concurrent-append guard described on `repairInbox`'s
 * own doc, pulled out so it is unit-testable without racing a real second
 * process against a synchronous function: `afterRaw` not extending
 * `beforeRaw` means nothing was appended (or the file was replaced
 * entirely, out of scope for this guard) — no suffix to preserve.
 */
export function appendedSince(beforeRaw: string, afterRaw: string): string {
  return afterRaw.startsWith(beforeRaw) ? afterRaw.slice(beforeRaw.length) : "";
}

/**
 * The read-and-classify half of `repairInbox`, shared by both its dry-run
 * and real-repair paths: read the inbox, split it into lines, and sort
 * each into `kept` (parses as JSON) or `dropped` (does not). Neither path
 * writes anything here — that decision (and the write itself) belongs to
 * the caller, which is exactly why this is safe to call WITHOUT the
 * mutating per-file lock on the dry-run path (see `repairInbox`'s own
 * doc).
 */
function readAndClassifyInbox(path: string):
  | { ok: false; why: string }
  | {
      ok: true;
      before: { raw: string };
      lines: string[];
      kept: string[];
      dropped: string[];
    } {
  const before = readMailboxFile(path);
  if (before.kind === "absent") {
    return { ok: true, before: { raw: "" }, lines: [], kept: [], dropped: [] };
  }
  if (before.kind === "unreadable") {
    return {
      ok: false,
      why: `inbox.jsonl exists but could not be read (${before.why})`,
    };
  }
  const lines = splitJsonl(before.raw);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    try {
      JSON.parse(line);
      kept.push(line);
    } catch {
      dropped.push(line.slice(0, 120));
    }
  }
  return { ok: true, before, lines, kept, dropped };
}

export async function repairInbox(
  dir: string,
  dryRun: boolean,
): Promise<RepairResult> {
  const path = inboxPath(dir);
  // If the mailbox directory doesn't exist at all, the inbox is unambiguously
  // absent — report that without ever touching the filesystem. This is not just
  // an optimization: unconditionally `mkdirSync`-ing the directory here (a
  // first attempt at fixing `createLock`'s own non-recursive `mkdirSync(lock)`
  // needing the parent to exist) made `repairInbox(dir, true)` — `--dry-run`,
  // documented as "reports without writing" — silently CREATE the mailbox
  // directory on a fresh worktree, contradicting its own contract.
  // Short-circuiting before any filesystem write closes both problems at once:
  // dry-run never mutates anything, and a real repair against a directory that
  // doesn't exist never reaches `lock.acquire()` at all, so there is nothing
  // for its own non-recursive `mkdirSync(lock)` to fail against.
  //
  // `existsSync` collapses EVERY lookup error to `false` — not just `ENOENT`,
  // but also an inaccessible directory (e.g. its own parent lacking search
  // permission). That reads a genuinely unreachable inbox as "confirmed absent,
  // zero lines, nothing to repair" instead of "never inspected", while
  // `gate-state` (which goes through `readMailboxFile`'s own error-preserving
  // `lstatSync`) still correctly reports the same path as unreadable and stays
  // blocked — making this command's advertised recovery path silently lie about
  // having run. `lstatSync` here mirrors `readMailboxFile`'s own
  // absent/unreadable split so the two agree.
  try {
    lstatSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ENOENT alone, matching `readMailboxFile`'s own narrowing: ENOTDIR means a
    // path component exists but is the WRONG type (e.g. `.context` existing as
    // a file, not a directory) — a broken location, not a genuinely absent one
    // — so it must stay `unreadable`/`ok: false` to keep agreeing with
    // `readMailboxFile` the way this comment already claims it does.
    if (code === "ENOENT") {
      return { ok: true, path, totalLines: 0, droppedLines: 0, dropped: [] };
    }
    return {
      ok: false,
      path,
      why: `mailbox directory ${dir} could not be inspected (${code ?? String(e)})`,
    };
  }
  // `lstatSync(dir)` succeeding only means SOMETHING exists at `dir` — not
  // that it's a directory. `dir` existing as a regular FILE used to sail
  // past this check and, on the real (non-dry-run) path below, reach
  // `lock.acquire()`; its `mkdirSync(inbox.jsonl.lock)` then fails with
  // ENOTDIR on every attempt (a path component, `dir` itself, is the wrong
  // type), which the lock treats as ordinary contention and eventually
  // reports as "another driver is updating state" — a misdiagnosis that
  // sends an operator chasing a nonexistent rival driver instead of the
  // actual broken path. Caught here, before either the dry-run or the
  // locking branch, so both report the same `ok: false` a broken location
  // deserves.
  //
  // The type check itself uses `statSync`, not `dirStat` (the earlier
  // `lstatSync`): `lstat` does not follow a symlink, so a mailbox
  // directory reached through one would report `isDirectory() === false`
  // and be rejected as broken even though `readMailboxFile`'s own
  // `readFileSync` calls read straight through it. `lstatSync` above still
  // owns the absent/unreadable split (a dangling symlink must not be
  // misread as a readable location by following it), and this second call
  // owns only the type question, which does want the followed target.
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      path,
      why: `mailbox directory ${dir} could not be inspected (${code ?? String(e)})`,
    };
  }
  if (!isDir) {
    return {
      ok: false,
      path,
      why: `mailbox directory ${dir} exists but is not a directory`,
    };
  }
  if (dryRun) {
    // A dry run never writes, so it needs no coordination against a
    // concurrent WRITER — only against reading a torn write mid-flight,
    // which only affects a REPORT here, never a decision (the write
    // itself, below, still goes through the lock). Acquiring the
    // mutating per-file lock anyway broke this command's own "reports
    // without writing" contract: it creates
    // .lock.stale.*/.lock.recovering.stale.* tombstone directories as a
    // side effect and fails outright against a genuinely read-only
    // mailbox directory.
    const r = readAndClassifyInbox(path);
    if (!r.ok) return { ok: false, path, why: r.why };
    return {
      ok: true,
      path,
      totalLines: r.lines.length,
      droppedLines: r.dropped.length,
      dropped: r.dropped,
    };
  }
  // The SAME per-file lock `appendLine` holds for its own read-decide-write
  // span, for the identical reason: a repair that reads, then writes, with
  // no coordination against a concurrent appender can still race one, and
  // the `appendedSince` reconciliation below narrows that window but does
  // not close it (see its own doc). Holding this lock for the WHOLE
  // function — both reads and the final write — makes repair and every
  // append fully mutually exclusive, so an appender either completes
  // entirely before repair starts, or waits until repair (and its
  // `atomicWrite`) has finished.
  const lock = createLock(path, "mailbox.ts (repair)", "mailbox");
  await lock.acquire();
  try {
    const before = readAndClassifyInbox(path);
    if (!before.ok) return { ok: false, path, why: before.why };
    const { lines, kept, dropped } = before;
    if (dropped.length > 0) {
      // Preserve anything appended between the read above and this write — now
      // only possible from a writer that does NOT go through this module's lock
      // at all (there is none), so this is defense-in-depth rather than the
      // primary guarantee it was before the lock above. Coercing a non-`ok`
      // second read to an empty string and proceeding anyway would let a file
      // that turned unreadable (or vanished) between the two reads overwrite
      // from the stale first snapshot, discarding whatever changed — or throw
      // out of `writeFileSync` entirely, outside this function's declared
      // `RepairResult` contract. Abort with an explicit `ok: false` instead;
      // nothing was written.
      const after = readMailboxFile(path);
      if (after.kind !== "ok") {
        return {
          ok: false,
          path,
          why:
            after.kind === "unreadable"
              ? `inbox.jsonl became unreadable while repairing (${after.why})`
              : "inbox.jsonl vanished while repairing",
        };
      }
      const suffix = appendedSince(before.before.raw, after.raw);
      // `atomicWrite` (temp-file-then-rename), not a plain `writeFileSync`,
      // which truncates the live file in place before writing the new content:
      // a kill, power loss, or write failure between truncation and completion
      // would leave the inbox empty (or partial) — and an EMPTY file folds as
      // CLEAR, so an active hold-push directive `repair` was in the middle of
      // rewriting could vanish and let a push through that should have been
      // blocked. `renameSync` is atomic on every filesystem this runs on: the
      // target either has the OLD complete content or the NEW complete content,
      // never a partial mixture.
      atomicWrite(path, kept.map((l) => `${l}\n`).join("") + suffix);
    }
    return {
      ok: true,
      path,
      totalLines: lines.length,
      droppedLines: dropped.length,
      dropped,
    };
  } finally {
    lock.release();
    lock.dispose();
  }
}
