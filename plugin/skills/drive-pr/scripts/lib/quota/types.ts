/**
 * The vendor-neutral shape of "the agent that runs a pass has run out of
 * subscription quota", and the adapter contract that recognises one.
 *
 * WHY AN ADAPTER SEAM AT ALL. `drive.ts` spawns an arbitrary pass command —
 * `claude -p`, `codex exec`, or whatever else a caller puts after `--` — and
 * the skill's whole portability claim (SKILL.md § Runtime) is that the scripts
 * do not care which. Quota is the first thing in this skill that has to care,
 * because the wall is announced in a vendor-specific place, in a
 * vendor-specific format, with vendor-specific fidelity. The seam keeps that
 * knowledge in one file per vendor instead of letting a Claude-shaped regex
 * become the driver's idea of what running out of quota looks like.
 *
 * THE VENDORS ARE NOT EQUALLY OBSERVABLE, and the interface is shaped by the
 * weaker one:
 *
 *   - Codex writes STRUCTURED, PRE-EMPTIVE telemetry on every turn — a
 *     `token_count` event carrying `used_percent`, `window_minutes` and an
 *     absolute `resets_at` epoch for each window. It can answer "how close am
 *     I?" before the wall, exactly.
 *   - Claude Code writes NOTHING until it hits the wall, and then writes prose:
 *     an assistant record with `error: "rate_limit"` whose text is
 *     `You've hit your session limit · resets 3:20am (Europe/Amsterdam)`. A
 *     bare wall clock with no date, in a named zone.
 *
 * So `QuotaBlock` is REACTIVE — the common denominator — and `resetAt` is
 * nullable, because the Claude path can genuinely fail to resolve one and
 * must say so rather than invent it. Pre-emptive pacing needs a second,
 * optional capability that only some adapters can implement; it is deliberately
 * NOT in this interface yet (see the epic), because designing it around the one
 * vendor that supports it is how the seam would rot.
 */

/**
 * Which usage window closed.
 *
 * The distinction is load-bearing rather than descriptive: it selects the
 * driver's whole response. A `short` window reopens in hours, so the drive
 * SLEEPS through it and resumes — the round is delayed, not lost. A `weekly`
 * window reopens in days, which no unattended sleep should ever sit through,
 * so the drive stops and notifies.
 *
 * `unknown` exists because that choice must fail toward the safe branch. An
 * adapter that recognised a block but could not classify its window MUST
 * report `unknown`, and `unknown` is treated exactly like `weekly` — stop and
 * notify. Sleeping on a guess is the one outcome that can strand a drive for
 * days, which is the failure this whole module exists to prevent.
 */
import {
  closeSync,
  type Dirent,
  fstatSync,
  opendirSync,
  openSync,
  readSync,
} from "node:fs";

export type QuotaWindow = "short" | "weekly" | "unknown";

export interface QuotaBlock {
  /** The adapter that recognised this — `claude`, `codex`. */
  vendor: string;
  window: QuotaWindow;
  /**
   * When the window reopens, or `null` when the adapter recognised a block but
   * could not resolve an instant. `null` is never "reopens now": every
   * consumer treats an unresolved reset as unsleepable, the same as `weekly`.
   */
  resetAt: Date | null;
  /**
   * When the EVIDENCE was recorded — the record's own `timestamp` field, not
   * `resetAt`. This is what "newest wall across every vendor" means: an
   * `unknown`-window block with `resetAt: null` still has an observation
   * time, and comparing on `resetAt` would always lose to any block that
   * resolved a reset instant, regardless of which one was actually seen more
   * recently.
   */
  observedAt: Date;
  /**
   * The verbatim evidence, trimmed to one line — the vendor's own wording, so
   * a log or a handoff shows what was actually read rather than this module's
   * paraphrase of it.
   */
  evidence: string;
  /** Absolute path of the file the evidence was read from. */
  source: string;
}

export interface DetectOpts {
  /**
   * The worktree the pass ran in. The adapters record a `cwd` alongside the
   * evidence, and matching it is what stops one worktree's drive from reading
   * a SIBLING worktree's quota wall as its own — the normal case on this
   * machine, where many Conductor worktrees run agents against one account.
   */
  cwd: string;
  /**
   * Ignore evidence older than this — the instant the round's pass was
   * spawned. Without it the newest wall on the account is indistinguishable
   * from THIS pass's wall, and a drive re-armed after an earlier block would
   * immediately re-read that stale block and park itself again.
   */
  since: Date;
  /**
   * The instant detection is running, injected rather than read inline so a
   * test can pin it. A transcript or rollout is append-only but not
   * trustworthy about its OWN clock — a future-dated record (a corrupted
   * write, a container with a skewed clock) would otherwise satisfy `ts >=
   * since` on every later pass for as long as that file keeps being written
   * to, permanently winning the "newest wall" comparison and attributing an
   * unrelated pass failure to stale evidence. Bounded above by `now` plus a
   * small allowance for real clock skew between the writer and this process.
   */
  now: Date;
  /**
   * Every session file that ALREADY EXISTED when the pass was spawned —
   * `snapshotQuotaSessions`, called immediately before the spawn. Evidence
   * read from one of these is by construction NOT this pass's, because both
   * vendors create a session's file when the session starts and append to it
   * for its lifetime.
   *
   * This is what narrows `cwd` from "some session in this worktree" toward
   * "the session this drive started". `cwd` + `since` alone cannot tell the
   * two apart: a human's interactive Claude or Codex session sitting in the
   * same worktree — the normal condition while a drive runs, since the drive
   * locks are held against other DRIVERS, not against a chat — keeps
   * appending records that satisfy both. Its wall then makes an unrelated
   * failed pass sleep or park, and its healthy telemetry can clear the failed
   * pass's real wall.
   *
   * The pre-existing case is the dominant one precisely because a chat almost
   * always predates the pass it runs alongside. The residual this does NOT
   * close is a session of the same vendor that STARTS inside the spawn
   * window; `correlation` below closes that exactly, for the vendor that can
   * supply it.
   *
   * Optional because a caller may genuinely have nothing to offer — not as a
   * compatibility valve. Absent means "no snapshot was taken", and detection
   * falls back to `cwd` + `since` exactly as before.
   */
  preexistingSessions?: ReadonlySet<string>;
  /**
   * Whether the walk that produced `preexistingSessions` was cut short by
   * either circuit breaker (`MAX_CANDIDATE_FILES_SCANNED` or
   * `maxCandidateScanMs()`) before it finished enumerating the vendor's whole
   * state tree. This flat field is whatever the caller passes; a direct
   * `adapter.detect(opts)` call reads it as-is. `detectQuotaBlock()` in
   * `index.ts` does NOT pass through a blanket union across adapters here — it
   * overrides this field PER adapter from `QuotaSnapshot.truncatedByVendor`
   * before calling each one, so an adapter only ever sees whether ITS OWN walk
   * truncated. An aggregate flag let one vendor's truncated walk degrade a
   * DIFFERENT, fully-completed vendor's detection too — see
   * `QuotaSnapshot.truncatedByVendor`'s own doc comment.
   *
   * This is what tells "this file doesn't exist yet" apart from "the snapshot
   * walk never got far enough to find out": a
   * count-based cap enumerates the SAME set on every call given a stable
   * directory order, but the wall-clock cap does not — it stops wherever real
   * elapsed time happened to land, which can differ between the snapshot call
   * (immediately before spawn) and a later `detect()` call over the identical
   * tree, EVEN BELOW the entry-count cap. Below both caps the two calls agree
   * exactly, which is why this is reported only when a cap actually fired.
   *
   * When `true`, an adapter with no independent way to verify a candidate —
   * no exact session-id correlation for this record — MUST NOT trust
   * `preexistingSessions`' absence as proof the file is new: the snapshot may
   * simply have missed it. See each adapter's own `detect()` for how that
   * degrades (discarding the unverifiable candidate rather than risking a
   * misattributed wall).
   */
  preexistingSessionsTruncated?: boolean;
  /**
   * The identity of the session this drive actually spawned, when the pass
   * command was recognised well enough to MINT one — `prepareQuotaSpawn()`'s
   * return value, threaded through the spawn. Authoritative where it applies:
   * the adapter it names matches its own evidence on this id and discards
   * everything else, rather than choosing the newest wall among every session
   * in the worktree.
   *
   * NOT a filter on which adapters run. A Claude pass routinely spawns
   * `codex exec` underneath it (the shadow reviewer, the scout agents), so a
   * Codex wall during a Claude pass can be the genuine cause of that pass's
   * failure. Suppressing every other vendor because this one was recognised
   * would trade one misattribution for a blind spot. Adapters this does not
   * name fall back to `preexistingSessions` + `cwd` + `since`.
   */
  correlation?: SpawnCorrelation;
}

/**
 * A session identity this driver chose ITSELF and handed to the vendor,
 * rather than one read back out of the vendor's own state afterwards. That
 * direction is the whole point: a value we minted before the spawn cannot
 * belong to anyone else's session.
 */
export interface SpawnCorrelation {
  /** The adapter that minted this — matches `QuotaAdapter.vendor`. */
  vendor: string;
  /**
   * The vendor's own session identifier, as passed to its CLI — or `null` when
   * `prepareSpawn` confirmed the command is THIS vendor's CLI deliberately
   * targeting an existing session (Claude's long-form `--continue`, or a
   * long-form `--resume` it could not read a value from) but could not
   * determine which one. `null` here is still a positive claim, distinct from
   * no `SpawnCorrelation` at all — it tells the caller (the argv-injection
   * decision in `prepareSpawn`, and `drive.ts`'s own log line) that this pass
   * legitimately writes into a PRE-EXISTING transcript. It does NOT, on its
   * own, let `detect()`'s blanket `preexistingSessions` exclusion through:
   * without an exact id there is no way to tell the actually-resumed file apart
   * from an unrelated preexisting file in the same worktree, so a `null`
   * correlation still hits that exclusion and a genuine wall there is a missed
   * detection rather than a misattribution risk (bypassing the exclusion for
   * this case reopens the two-candidate gap). Deliberately NOT extended to a
   * short `-c`/`-r` form: an adapter cannot tell an actual short flag from a
   * value character that merely happens to match one.
   */
  sessionId: string | null;
}

/**
 * An amended spawn: the pass argv and env to actually use, plus the identity
 * they now carry. Returned by `QuotaAdapter.prepareSpawn`.
 */
export interface PreparedSpawn {
  argv: string[];
  env: NodeJS.ProcessEnv;
  correlation: SpawnCorrelation;
}

/**
 * Generous slack for real clock skew between the machine that wrote a
 * transcript/rollout record and this process reading it — not a tolerance
 * for a genuinely corrupted future timestamp, which an adapter's upper bound
 * on `DetectOpts.now` is meant to still reject.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether a record's `cwd` places it in the worktree this drive is running
 * in. Shared by the adapters — a pass wrapper that `cd`s into a subdirectory
 * before starting either vendor's CLI writes evidence at that deeper path,
 * regardless of which vendor it is.
 *
 * Equality is the normal case and a prefix match is the one widening: the
 * transcript/rollout records the session's CURRENT directory, and an agent
 * that `cd`s into a subdirectory mid-round would otherwise write a wall this
 * drive then fails to recognise as its own. That failure is safe (it
 * degrades to an ordinary pass failure, which also stops) but it is still a
 * missed detection, and it costs the drive the sleep-and-resume it was
 * entitled to.
 *
 * The widening cannot reach a SIBLING, which is the case that actually
 * matters here: Conductor worktrees are siblings under one parent, never
 * nested, so no sibling's path is ever a child of this one. The separator in
 * the prefix is what keeps that true — without it `/w/alpha` would match
 * `/w/alpha-v2`.
 *
 * Both sides are normalized to forward slashes before comparing, not just
 * checked against `/` and `\\` independently: trying each separator as if the
 * WHOLE path used it consistently still fails when the two sides mix
 * conventions with EACH OTHER — worktree `C:\repo\alpha` and record cwd
 * `C:/repo/alpha/apps/backend` matches neither a `\`-joined nor a `/`-joined
 * prefix, even though nothing here ever promised the two sides agree on a
 * convention. Case-folded too, but ONLY on Windows: NTFS (and virtually every
 * real Windows config) is case-insensitive, while POSIX is not — folding case
 * unconditionally would treat `/Users/Alpha` and `/users/alpha` as the same
 * worktree on macOS/Linux, which they are not.
 */
export function belongsToWorktree(
  recordCwd: unknown,
  worktree: string,
): boolean {
  if (typeof recordCwd !== "string") return false;
  const normalize = (p: string): string => {
    const slashed = p.replaceAll("\\", "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  const record = normalize(recordCwd);
  const root = normalize(worktree);
  if (record === root) return true;
  return record.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Bound on how much of a transcript/rollout file either adapter reads. Every
 * candidate file is found by mtime and can be actively appended to for the
 * lifetime of a long session — the mtime filter bounds which FILES are
 * scanned, never how BIG one of them is. A years-old, still-live project
 * transcript reaching hundreds of megabytes made `readFileSync(path, 'utf8')`
 * a synchronous, unbounded read on the event loop, able to delay this
 * drive's own lock-renewal heartbeat or exhaust its memory — precisely while
 * it is diagnosing a failed pass.
 */
export const MAX_TRANSCRIPT_READ_BYTES = 8 * 1024 * 1024;

/**
 * Bound on how many candidate files a single `candidateFiles` walk will
 * enumerate and `statSync`, across the whole vendor-state tree — the
 * aggregate side of the same problem `MAX_TRANSCRIPT_READ_BYTES` bounds per
 * file. The mtime filter only decides which of the already-discovered files
 * survive; discovering them at all means a synchronous `readdirSync`/
 * `statSync` over every entry first, with no bound on how many that tree
 * can accumulate over a machine's lifetime — hundreds of Conductor
 * worktrees' worth of project directories, or years of daily rollouts.
 *
 * A circuit breaker, not a recency-aware cutoff: neither vendor's file
 * names are chronologically sortable (Claude's are UUIDs; nothing here
 * assumes Codex's Y/M/D directories are visited in any particular order
 * either), so there is no way to guarantee "stop after the newest N" short
 * of stat-ing everything first — the exact cost this bound exists to cap.
 * Hitting it on a real machine would mean a tree many orders of magnitude
 * larger than anything measured so far; the honest residual is that a tree
 * THAT large could have its newest file skipped if the walk reaches the cap
 * before reaching it, which is a materially better failure mode than the
 * previously fully-unbounded scan.
 *
 * A SECOND residual appears once `snapshotSessions` shares this walk:
 * the snapshot and the later detection scan are two separate
 * walks, separated by a whole pass that itself creates files, and directory
 * iteration order is not a contract. They can therefore truncate at different
 * points — NOT only above this count cap, once `maxCandidateScanMs` is also
 * in play: a wall-clock cutoff depends on real elapsed time, which the two
 * calls do not share, so it can diverge the two walks even while both stay
 * under this entry count. Below both caps the two
 * walks enumerate the same set and the divergence cannot occur at all; the
 * measured tree on the machine this was written for scans ~7,400 entries,
 * well under the count cap. Once either walk truncates, `CandidateScan.truncated`
 * says so and `DetectOpts.preexistingSessionsTruncated` carries it to
 * `detect`, which is what stops the missed file from being silently read as
 * new — see that field's own doc comment for the (adapter-scoped) residual
 * this still leaves: an adapter that cannot verify a candidate by exact
 * session-id correlation discards it rather than guessing, so a truncated
 * snapshot can still cost a missed detection, never a misattributed one.
 */
export const MAX_CANDIDATE_FILES_SCANNED = 20_000;

const MAX_CANDIDATE_SCAN_MS_DEFAULT = 5_000;

/**
 * Bound on how long a single `candidateFiles` walk may run, wall-clock —
 * the second half of the circuit breaker `MAX_CANDIDATE_FILES_SCANNED`
 * began. The entry-count cap bounds how MANY `opendirSync`/`readSync`/
 * `statSync` calls a walk makes; it says nothing about how long any one of
 * them takes. A tree well under the count cap, sitting on a slow or
 * degraded filesystem (a stalled network mount, say), could still run for
 * minutes — this cap ends the walk early in that case, the same way the
 * count cap ends it early on a tree that is merely too WIDE.
 *
 * NAMED RESIDUAL: this bounds the AGGREGATE duration of a walk making
 * progress, never a SINGLE stalled syscall. `opendirSync`/`readSync`/
 * `statSync` are synchronous, and nothing in this process can preempt one
 * that is genuinely hung short of running the scan in a subprocess or
 * worker thread it can then kill on a timeout — a materially larger change
 * than this circuit breaker, in the same spirit as `prepareSpawn`'s own
 * `CODEX_HOME`-isolation deferral: deferred until a real hang is measured
 * rather than merely possible. Tracked as an earlier change rather than merely noted
 * here.
 *
 * Overridable via `DRIVE_PR_QUOTA_MAX_SCAN_MS` so a test can pin the
 * deadline to a value it controls, rather than asserting behaviour that
 * depends on real elapsed wall-clock time racing real filesystem I/O.
 */
export function maxCandidateScanMs(): number {
  const raw = process.env.DRIVE_PR_QUOTA_MAX_SCAN_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    return MAX_CANDIDATE_SCAN_MS_DEFAULT;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : MAX_CANDIDATE_SCAN_MS_DEFAULT;
}

/**
 * Whether a `candidateFiles()` walk has used up its budget — entries visited
 * or wall-clock time spent — and must stop. A pure function so the two
 * circuit breakers are tested deterministically: no test needs to
 * manufacture `MAX_CANDIDATE_FILES_SCANNED` files or wait real milliseconds
 * for `maxCandidateScanMs()` to elapse. Production call sites pass their own
 * `scanned` counter and `Date.now()` twice (once to compute `deadlineAt`,
 * once here) — this function itself reads no clock and counts nothing, so
 * it cannot drift from what its caller actually measured.
 */
export function scanBudgetExceeded(
  scanned: number,
  maxScanned: number,
  deadlineAt: number,
  now: number,
): boolean {
  return scanned >= maxScanned || now >= deadlineAt;
}

/**
 * Whether a caught filesystem error is a CONFIRMED disappearance — `ENOENT`,
 * the file or directory legitimately does not exist right now — as opposed to
 * any OTHER failure (`EACCES`, `ELOOP`, a stalled or degraded mount, ...) that
 * says nothing about whether the target exists. The two must never be
 * conflated: a confirmed absence is not evidence and not truncation, but any
 * other failure is NOT confirmed absence, and treating it as one lets a walk
 * silently miss a file that a LATER walk over the same tree (once the transient
 * failure has cleared) would find — exactly the divergence between the
 * pre-spawn snapshot and `detect()`'s own separate scan that
 * `MAX_CANDIDATE_FILES_SCANNED`'s own doc comment describes, reachable through
 * a different door than either circuit breaker. A pure function so both
 * adapters' `candidateFiles()` share one classification rather than each
 * hand-copying the same `.code` check — `forEachDirEntry` below already needed
 * exactly this distinction for its own `opendirSync` failure.
 */
export function isConfirmedAbsence(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Visit `dir`'s entries one at a time via `opendirSync`/`readSync` — never
 * `readdirSync`, which materializes the WHOLE directory into one array
 * before a caller's own budget check can run even once. A directory (or a
 * root containing many empty ones) large enough to matter for
 * `MAX_CANDIDATE_FILES_SCANNED` is exactly the case that cap exists to
 * bound, and a single eager `readdirSync` call pays that entire cost
 * upfront regardless of how quickly the caller's `onEntry` decides to stop.
 * `onEntry` returns `false` to stop
 * the walk early — checked BETWEEN every single entry, not merely between
 * whole directories.
 *
 * Returns `true` when the walk ran to completion — every entry the
 * directory actually has was either visited or skipped because `onEntry`
 * chose to stop — and `false` when an I/O failure cut it short instead: a
 * `readSync` throwing mid-directory, or `opendirSync` itself failing for a
 * reason OTHER than the root simply not existing (`ENOENT`), e.g. `EACCES`
 * or a filesystem going away mid-scan. An absent root is a legitimate empty
 * state — no vendor directory means no sessions to find, not an incomplete
 * scan — so it alone returns `true` with zero entries visited. Every caller
 * OR's a `false` here into its own `truncated` signal: a walk this function
 * could not finish is indistinguishable, to the caller, from one the
 * caller's own budget cut short.
 */
export function forEachDirEntry(
  dir: string,
  onEntry: (entry: Dirent) => boolean,
): boolean {
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(dir);
  } catch (err) {
    return isConfirmedAbsence(err);
  }
  try {
    for (;;) {
      let entry: Dirent | null;
      try {
        entry = handle.readSync();
      } catch {
        return false;
      }
      if (entry === null) return true;
      if (!onEntry(entry)) return true;
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Already closed, or gone mid-walk — nothing further to release.
    }
  }
}

/**
 * The result of one `candidateFiles()` walk: which paths survived the mtime
 * filter, and whether either circuit breaker
 * (`MAX_CANDIDATE_FILES_SCANNED`/`maxCandidateScanMs()`) cut the walk short
 * before it finished enumerating the tree.
 *
 * `truncated` is the signal that separates "this file does not exist" from
 * "this walk never got far enough to find out" — see
 * `MAX_CANDIDATE_FILES_SCANNED`'s own doc comment for why that distinction
 * matters once a snapshot and a later detection scan can diverge, and
 * `DetectOpts.preexistingSessionsTruncated` for how a caller acts on it.
 */
export interface CandidateScan {
  files: string[];
  truncated: boolean;
}

/**
 * Read at most the last `maxBytes` of `path`, as text. The adapters only
 * ever care about records from THIS pass's own timeframe (`DetectOpts.since`
 * onward), and a pass that hit a wall in the last few minutes wrote its
 * evidence recently — near the END of an actively-growing file, not
 * scattered through its whole history. Tail-reading trades a theoretical
 * miss (a relevant record sitting further back than `maxBytes`, in a file
 * so large that is implausible for one pass's evidence) for a hard bound on
 * how much any single file can cost to read.
 *
 * A byte offset can land mid multi-byte UTF-8 sequence, or mid-JSON-line —
 * either way the RESULT is a partial leading fragment no caller can parse,
 * so it is dropped up to and including the first newline; a caller that
 * reads whole `\n`-delimited lines loses nothing by starting one line later
 * than the exact byte bound.
 */
/**
 * `readSync` fills as much of `buf` as the underlying `read(2)` call returns in
 * ONE invocation, which is not guaranteed to be the whole requested length even
 * for a regular file — a short read is legal, and every file this module reads
 * is explicitly an ACTIVELY-APPENDED one, which is exactly the condition (a
 * concurrent write racing the read) most likely to produce one. Ignoring the
 * returned byte count and decoding the whole zero-initialized buffer regardless
 * would turn a short read into trailing NUL bytes decoded as if they were file
 * content (as happened in `readBoundedTail` below, and in Codex's own small
 * header-line read, which used a bare single `readSync` call instead of this
 * shared loop). Exported so every bounded-read call site loops until the buffer
 * is full or EOF (`bytesRead === 0`) the SAME way, rather than each
 * hand-rolling its own copy that the next one forgets.
 */
export function readFullySync(
  fd: number,
  buf: Buffer,
  position: number,
): number {
  let filled = 0;
  while (filled < buf.length) {
    const bytesRead = readSync(
      fd,
      buf,
      filled,
      buf.length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

export function readBoundedTail(
  path: string,
  maxBytes: number = MAX_TRANSCRIPT_READ_BYTES,
): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    if (start === 0) {
      const buf = Buffer.alloc(size);
      const filled = readFullySync(fd, buf, 0);
      return buf.subarray(0, filled).toString("utf8");
    }
    const length = size - start;
    const buf = Buffer.alloc(length);
    const filled = readFullySync(fd, buf, start);
    const text = buf.subarray(0, filled).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

export interface QuotaAdapter {
  readonly vendor: string;
  /**
   * Recognise a block, or return `null`.
   *
   * MUST NOT THROW. An adapter probes the filesystem of a tool that may not be
   * installed, whose state dir may not exist, whose transcript may be
   * half-written; every one of those is "nothing to report", not an error. The
   * driver calls this on a path that is already handling a pass failure, and a
   * throw here would replace a real diagnosis with this module's own stack.
   */
  detect(opts: DetectOpts): QuotaBlock | null;
  /**
   * Every session file this adapter would consider evidence, RIGHT NOW —
   * unfiltered by mtime, because the question is "what already exists", not
   * "what changed recently". A file untouched for a month is still one this
   * pass did not create, and it can be appended to a second later; filtering
   * the snapshot by recency would let exactly those files read as new.
   *
   * MUST NOT THROW, for the same reason `detect` must not: it probes a
   * vendor that may not be installed, and it is called on the hot path right
   * before a pass spawns.
   *
   * POTENTIALLY BLOCKING, with no cancellation handle of its own: an
   * implementation walks the vendor's whole state tree synchronously. Both
   * adapters bound that walk with `MAX_CANDIDATE_FILES_SCANNED` (quantity)
   * and `maxCandidateScanMs()` (wall-clock duration) — see the latter's own
   * doc comment for the residual neither one closes.
   *
   * Returns `CandidateScan` rather than a bare list so a caller can tell a
   * complete enumeration from a truncated one — see that type's own doc
   * comment, and `DetectOpts.preexistingSessionsTruncated` for how
   * `snapshotQuotaSessions()` propagates it to `detect()`.
   */
  snapshotSessions(): CandidateScan;
  /**
   * Claim an about-to-be-spawned pass and correlate it against an identity —
   * one this driver minted itself, or one the pass command already named —
   * or return `null` to leave it untouched.
   *
   * OPTIONAL because the vendors are not equally cooperative, the same
   * asymmetry `QuotaBlock` is already shaped by. Claude Code takes a
   * caller-supplied `--session-id`, so its adapter can mint one and match on
   * it exactly. `codex exec` has no equivalent flag — its session id is
   * assigned, addressable only after the fact (`codex exec resume <id>`) —
   * so its adapter implements nothing here and relies on
   * `DetectOpts.preexistingSessions` instead. Isolating Codex by pointing
   * `CODEX_HOME` at a per-pass directory would work, but it relocates
   * `auth.json` along with the sessions tree, and that risk is not worth the
   * last sliver of residual until something measures it.
   *
   * A returned identity need not be freshly minted: the Claude adapter also
   * reads an EXISTING id straight off an unambiguous `--resume <value>` —
   * `argv`/`env` pass through unchanged in that case, since injecting
   * `--session-id` alongside `--resume` would hand the CLI two conflicting
   * selectors.
   * "Leave a resumed session alone" below is about the AMBIGUOUS forms this
   * still cannot safely read a value from, not about resumption in general.
   *
   * MUST be conservative about claiming. The pass command is arbitrary argv —
   * the skill's whole portability claim — so an adapter may only amend a
   * command it positively recognises as its own CLI, and must leave a wrapper
   * script, a shell function, or an unreadable resume selector alone.
   * Appending a flag to a command that does not understand it turns every
   * round into an instant usage error.
   *
   * MUST NOT THROW.
   */
  prepareSpawn?(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
  ): PreparedSpawn | null;
}
