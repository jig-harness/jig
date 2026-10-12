/**
 * Recognise an OpenAI/Codex subscription wall from the pass's rollout file.
 *
 * Codex is the better-instrumented vendor and this adapter is correspondingly
 * more certain than the Claude one. Every turn appends a `token_count` event
 * carrying the account's live window state:
 *
 *   {"timestamp":"…","type":"event_msg","payload":{"type":"token_count",
 *     "info":{…},
 *     "rate_limits":{"limit_id":"codex",
 *       "primary":{"used_percent":20.0,"window_minutes":10080,"resets_at":1784969664},
 *       "secondary":null,
 *       "rate_limit_reached_type":null,"plan_type":"prolite"}}}
 *
 * `resets_at` is an absolute epoch — no wall-clock parsing, no zone, no
 * next-occurrence guess. That is the whole reason `QuotaBlock.resetAt` is
 * nullable rather than required: this adapter always has one and the Claude
 * adapter frequently does not.
 *
 * TRAPS, measured across this machine's 1342 rollouts:
 *
 *   1. `primary` IS NOT THE SHORT WINDOW. In older rollouts `primary` is the
 *      300-minute window and `secondary` the 10080-minute one; in newer ones
 *      `primary` is 10080 and `secondary` is null. Position is a version
 *      artefact. Classify by `window_minutes`, never by which slot it sat in.
 *   2. `window_minutes` IS NOT EXACT. The samples carry 299/300 and
 *      10079/10080 — the server reports a window that has already been
 *      ticking. An equality test on 300 silently classifies a 299 as unknown
 *      and stops a drive that should have slept, so the split is a threshold.
 *
 * Runs under Bun and Node >= 22.18: `node:` APIs only, erasable syntax only.
 */

import { closeSync, fstatSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  belongsToWorktree,
  type CandidateScan,
  type DetectOpts,
  forEachDirEntry,
  isConfirmedAbsence,
  MAX_CANDIDATE_FILES_SCANNED,
  MAX_CLOCK_SKEW_MS,
  maxCandidateScanMs,
  type QuotaAdapter,
  type QuotaBlock,
  type QuotaWindow,
  readBoundedTail,
  readFullySync,
  scanBudgetExceeded,
} from "./types.ts";

function sessionsRoot(): string {
  const override = process.env.DRIVE_PR_CODEX_SESSIONS_DIR;
  if (override !== undefined && override !== "") return override;
  // `CODEX_HOME` relocates the vendor's own state directory — an execution
  // service that provisions a per-slot config home outside the worktree sets it
  // the way it sets, for example, `CLAUDE_CONFIG_DIR=/srv/agents/<slot>/claude`
  // (and the Cursor equivalent). Falling back to `~/.codex` unconditionally
  // means this adapter never finds a rollout written under a provisioned home,
  // degrading a real quota wall to a generic exit-1 failure.
  const codexHome = process.env.CODEX_HOME;
  return codexHome !== undefined && codexHome !== ""
    ? join(codexHome, "sessions")
    : join(homedir(), ".codex", "sessions");
}

/**
 * Anything at or under 24 hours is a window a drive may sleep through; the
 * weekly window is the one it must not. The gap between the two observed
 * values (300 vs 10080 minutes) is enormous, so a threshold anywhere inside it
 * is robust to the vendor retuning either one — which an equality test on the
 * exact numbers would not be.
 */
function classify(windowMinutes: number): QuotaWindow {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return "unknown";
  if (windowMinutes <= 24 * 60) return "short";
  return "weekly";
}

/** Rollouts live in `sessions/YYYY/MM/DD/rollout-*.jsonl`; walk to the files. */
function candidateFiles(sinceMs: number): CandidateScan {
  const out: string[] = [];
  let scanned = 0;
  // Set on a NON-ENOENT stat failure — see the catch block below. Kept
  // separate from `stoppedEarly`/`hitCap`: a lone failed stat is not a
  // budget exhaustion, so it must not abort the rest of the walk the way the
  // circuit breakers below do, only mark the overall result unreliable.
  let statFailed = false;
  // Wall-clock half of the same circuit breaker as the entry count below —
  // see `maxCandidateScanMs()`'s own doc comment for why a count alone
  // cannot bound how long a degraded filesystem keeps this walk running.
  const deadlineAt = Date.now() + maxCandidateScanMs();
  // Walked entry-by-entry via `forEachDirEntry`, never `readdirSync`: an
  // eager `readdirSync` materializes the WHOLE listing before the
  // `scanned` budget below gets to check even once, so a single Y/M/D
  // directory (or a root containing far more of them than the cap) with
  // enough entries still pays the full enumeration cost upfront — the
  // exact failure the cap exists to prevent.
  const walk = (dir: string, depth: number): boolean => {
    let stoppedEarly = false;
    // `forEachDirEntry`'s own return distinguishes an I/O failure (EACCES, a
    // vanished mount, ...) from a clean walk — an outcome the budget check
    // below cannot see, since it never runs when the directory could not be
    // read at all.
    const dirComplete = forEachDirEntry(dir, (entry) => {
      // A circuit breaker on the AGGREGATE enumeration/stat cost across the
      // whole tree, not on how many of its files turn out relevant — see
      // MAX_CANDIDATE_FILES_SCANNED's own doc comment for the residual gap
      // this accepts.
      if (
        scanBudgetExceeded(
          scanned,
          MAX_CANDIDATE_FILES_SCANNED,
          deadlineAt,
          Date.now(),
        )
      ) {
        stoppedEarly = true;
        return false;
      }
      scanned++;
      if (entry.isDirectory()) {
        // Y/M/D is exactly three levels; bound the walk rather than trusting
        // the layout, so an unexpected nested dir cannot turn this into a
        // full-home scan on the driver's error path.
        if (depth < 3) {
          const hitCap = walk(join(dir, entry.name), depth + 1);
          if (hitCap) {
            stoppedEarly = true;
            return false;
          }
        }
        return true;
      }
      if (!entry.name.endsWith(".jsonl")) return true;
      const path = join(dir, entry.name);
      try {
        if (statSync(path).mtimeMs >= sinceMs) out.push(path);
      } catch (err) {
        // A confirmed disappearance (ENOENT: rotated or removed mid-scan) is
        // not evidence and not truncation. Any OTHER stat failure is NOT
        // confirmed absence — if it is transient and clears before detect()'s
        // own separate walk moments later, that walk would find the rollout,
        // it would be missing from `preexistingSessions` purely because THIS
        // walk's stat failed, and detect() would misattribute a pre-existing
        // rollout to this pass (same class as the Claude adapter's identical
        // fix, this file's sibling).
        if (!isConfirmedAbsence(err)) {
          statFailed = true;
        }
      }
      return true;
    });
    if (!dirComplete) stoppedEarly = true;
    return stoppedEarly;
  };
  const truncated = walk(sessionsRoot(), 0) || statFailed;
  return { files: out, truncated };
}

interface Window {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

function readWindow(v: unknown): Window | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  // Finite and positive, not merely `typeof === 'number'`: `classify()` and
  // the clear-on-healthy path both trust this value once a window reaches
  // them, and NaN/Infinity/0 would otherwise slip through as a "valid" window
  // that proves neither exhaustion nor recovery yet still clears a real
  // earlier candidate as if it did.
  if (
    typeof o.window_minutes !== "number" ||
    !Number.isFinite(o.window_minutes) ||
    o.window_minutes <= 0
  ) {
    return null;
  }
  if (typeof o.resets_at !== "number" || !Number.isFinite(o.resets_at))
    return null;
  // A syntactically valid JSON number (e.g. `1e300`) can still be outside the
  // range `Date` supports (±8,640,000,000,000,000ms), which yields an Invalid
  // Date whose `toISOString()` throws later, inside the pass-failure handler
  // this module exists to keep from crashing. Reject it here instead — a
  // window whose reset cannot be represented is malformed telemetry, not a
  // reset of "now".
  if (Number.isNaN(new Date(o.resets_at * 1000).getTime())) return null;
  // Defaulting a missing/malformed `used_percent` to 0 used to be a harmless
  // "no positive evidence" reading. It stopped being harmless once a healthy
  // reading could actively CLEAR an earlier exhausted candidate (the
  // clear-on-healthy path above): a malformed `used_percent` on a newer record
  // would then read as proof of recovery it never actually provided. Reject the
  // whole window instead — malformed telemetry proves nothing, in either
  // direction.
  // Finite alone still let a semantically impossible value (e.g. `-1`)
  // through as a "valid" window: it is never >= 100 (so `mostRestrictiveExhausted`
  // never selects it), yet it also satisfies the healthy branch, so a
  // negative reading could clear a real exhausted candidate the same way an
  // out-of-range positive one could.
  if (
    typeof o.used_percent !== "number" ||
    !Number.isFinite(o.used_percent) ||
    o.used_percent < 0 ||
    o.used_percent > 100
  ) {
    return null;
  }
  return {
    usedPercent: o.used_percent,
    windowMinutes: o.window_minutes,
    resetsAt: o.resets_at,
  };
}

/**
 * The most RESTRICTIVE exhausted window, or `undefined` if none is. "Most
 * restrictive" is the longest `windowMinutes`, not array order: in the
 * documented older rollout shape `primary` is the short window and
 * `secondary` the weekly one, so `.find()` in slot order would pick the
 * short window's reset and sleep the drive through it while the weekly wall
 * — the one actually blocking every retry — is still standing.
 */
function mostRestrictiveExhausted(
  windows: readonly Window[],
): Window | undefined {
  return windows
    .filter((w) => w.usedPercent >= 100)
    .reduce<Window | undefined>(
      (longest, w) =>
        longest === undefined || w.windowMinutes > longest.windowMinutes
          ? w
          : longest,
      undefined,
    );
}

/**
 * Read just the file's first line, bounded to a small fixed prefix — a
 * `session_meta` head line is a small fixed-shape record, nowhere near the
 * size the rollout's BODY can reach. Kept as its own read, separate from the
 * bounded TAIL read the main loop uses: once a rollout exceeds that tail
 * bound, the tail no longer contains byte offset 0 at all, so deriving the
 * head line from it (as an earlier revision did) would read some unrelated
 * mid-file line instead and silently reject every large rollout as
 * belonging to no worktree.
 */
function readHeadLine(path: string, maxBytes = 65536): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    // `readFullySync`, not a bare `readSync` call: a short read (legal, and
    // plausible on this actively-appended rollout) would otherwise decode
    // trailing NUL bytes as part of the head line, truncating it and making
    // `rolloutCwd()` return null — flattening a real quota wall to a
    // generic pass failure (the sibling `readBoundedTail()` already used this
    // loop, this call site was the one that had not been brought in line with
    // it).
    const filled = readFullySync(fd, buf, 0);
    const text = buf.subarray(0, filled).toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(0, firstNewline);
  } finally {
    closeSync(fd);
  }
}

/** The rollout's first line is a `session_meta` carrying `payload.cwd`. */
function rolloutCwd(headLine: string): string | null {
  try {
    const parsed: unknown = JSON.parse(headLine);
    if (typeof parsed !== "object" || parsed === null) return null;
    const payload = (parsed as Record<string, unknown>).payload;
    if (typeof payload !== "object" || payload === null) return null;
    const cwd = (payload as Record<string, unknown>).cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

export const codexAdapter: QuotaAdapter = {
  vendor: "codex",
  /**
   * `0` as the mtime floor, so every rollout is returned rather than only
   * recently-touched ones — `statSync(path).mtimeMs >= 0` is true for all of
   * them. The snapshot's question is "what already exists", and a rollout
   * dormant for a month is still one this pass did not create.
   */
  snapshotSessions(): CandidateScan {
    return candidateFiles(0);
  },
  // No `prepareSpawn`. `codex exec` takes no caller-supplied session id — its
  // id is assigned, and only addressable after the fact (`codex exec resume
  // <id>`) — so there is nothing to mint here the way the Claude adapter
  // can. Pointing `CODEX_HOME` at a per-pass directory WOULD isolate this
  // vendor's rollouts exactly, and `sessionsRoot()` above already honours
  // that variable, but it relocates `auth.json` along with the sessions tree.
  // Deferred until something measures the residual as worth that risk;
  // until then this vendor relies on
  // `DetectOpts.preexistingSessions`.
  detect(opts: DetectOpts): QuotaBlock | null {
    const sinceMs = opts.since.getTime();
    // Floored to the second — same defensive symmetry as the Claude adapter's
    // identical comparison: `since` is millisecond-precise, and neither a
    // rollout's own `timestamp` field nor its filesystem mtime is guaranteed
    // to be. A genuine event in the same second the pass started must not be
    // rejected as "older than the pass" over sub-second precision alone.
    const sinceFloorMs = Math.floor(sinceMs / 1000) * 1000;
    const untilMs = opts.now.getTime() + MAX_CLOCK_SKEW_MS;
    let best: QuotaBlock | null = null;
    // The newest record CONSIDERED, hit or not — deliberately not "the newest
    // record that produced a block". A `token_count` event is written every
    // turn, so a session that hits a wall and later recovers writes a HEALTHY
    // event after the exhausted one; gating this only on hits (as an earlier
    // revision did) left `best` stuck on the stale exhausted block forever,
    // because a later healthy record never advanced anything and the skip
    // guard below never got a chance to reject an even-later record either.
    // Every record considered — healthy
    // or not — both advances this and decides whether `best` still stands.
    let newestAt = -1;
    let newestPath = "";
    // Unlike Claude, this adapter has no `prepareSpawn` — no exact session-id
    // to fall back on when `preexistingSessions` cannot be trusted. So a
    // truncated pre-spawn snapshot (`opts.preexistingSessionsTruncated`)
    // leaves NOTHING to verify a candidate's absence against; every candidate
    // not found in the snapshot must be discarded rather than assumed new,
    // or a pre-existing rollout the snapshot's walk simply did not reach
    // would be misattributed to this pass — the same misattribution, reached
    // below `MAX_CANDIDATE_FILES_SCANNED` via the wall-clock cap.
    const snapshotUnreliable = opts.preexistingSessionsTruncated === true;
    let discardedByTruncatedSnapshot = 0;

    // This is a SEPARATE walk from `snapshotSessions()` above — taken now,
    // at detection time, over files touched since `sinceMs` rather than
    // every file that exists — so it can truncate independently of the
    // pre-spawn snapshot even below `MAX_CANDIDATE_FILES_SCANNED`, the same
    // wall-clock-cap divergence `preexistingSessionsTruncated`'s own doc
    // comment describes for the other walk. Its own `.truncated` used to be
    // discarded here, which meant a rollout this walk never reached read as
    // "no wall" with nothing to say detection was incomplete rather than
    // genuinely clean.
    const scan = candidateFiles(sinceFloorMs);
    for (const path of scan.files) {
      // A rollout that already existed when the pass was spawned is another
      // session's — a human's interactive Codex run in this same worktree
      // being the normal case. Its telemetry is not this pass's, and that
      // cuts both ways here: not only can its WALL park an unrelated failed
      // pass, its later HEALTHY `token_count` event can clear the failed
      // pass's real wall via the newest-record-wins rule below.
      //
      // NAMED RESIDUAL, because this filter is not a pure win.
      // `rate_limits` is ACCOUNT-scoped telemetry, not session-scoped: it
      // is the server's report about the whole account, which another
      // session merely happens to be the one writing down. So a stranger's
      // newer healthy reading IS genuine evidence the account recovered,
      // and discarding it can leave a stale wall of ours standing that the
      // old behaviour would have cleared — turning a stop into a sleep.
      // Per-session attribution is the right model for "whose wall is
      // this" and the wrong one for "has the account recovered"; the two
      // questions are not separated here.
      //
      // Accepted rather than fixed, for now, because the exposure is
      // bounded on both ends: the sleep can never exceed the window's own
      // `resets_at`, and `maxSleepMs()` caps it again at six hours. Undoing
      // it would mean letting other sessions' records back in, which is the
      // defect this exists to close. Separating the two questions is a
      // design change, not a tweak.
      if (opts.preexistingSessions?.has(path)) continue;
      if (snapshotUnreliable) {
        discardedByTruncatedSnapshot++;
        continue;
      }
      let body: string;
      let headLine: string;
      try {
        body = readBoundedTail(path);
        headLine = readHeadLine(path);
      } catch {
        continue;
      }
      if (!body.includes('"rate_limits"')) continue;
      if (!belongsToWorktree(rolloutCwd(headLine), opts.cwd)) continue;

      for (const line of body.split("\n")) {
        if (!line.includes('"rate_limits"')) continue;
        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null) continue;
          record = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts =
          typeof record.timestamp === "string"
            ? Date.parse(record.timestamp)
            : Number.NaN;
        if (!Number.isFinite(ts) || ts < sinceFloorMs || ts > untilMs) continue;
        // `newestAt` deliberately does NOT advance yet. `readdirSync` file
        // order is not a chronological contract, so a record from one file
        // can be visited before a genuinely valid, older-timestamped record
        // from another — advancing here on timestamp alone would then
        // permanently block that valid record via the `ts <= newestAt` guard
        // below. Advance only once this record reaches a CONCLUSIVE decision
        // (a hit, confirmed health, or a fail-closed unknown block) further
        // down — never merely for having parsed far enough to be considered.

        // The OUTER discriminator: the documented shape is a `type:
        // "event_msg"` rollout line wrapping the `token_count` payload. Any
        // OTHER outer record type whose payload happens to carry a
        // similarly-shaped `token_count`/`rate_limits` structure must not
        // become authoritative account telemetry either — the inner
        // discriminators just below narrow WHICH payload inside an
        // already-recognised envelope, they do not stand in for recognising
        // the envelope itself.
        if (record.type !== "event_msg") continue;
        const payload = record.payload;
        if (typeof payload !== "object" || payload === null) continue;
        // The discriminators the documented PAYLOAD shape carries: without
        // them, any event whose payload happens to carry a similarly-shaped
        // `rate_limits` property (or a differently-sourced limit object)
        // becomes authoritative account telemetry — able to clear a real
        // exhausted block as healthy, or turn an unrelated pass failure into
        // a sleep/QUOTA_PARKED.
        if ((payload as Record<string, unknown>).type !== "token_count") {
          continue;
        }
        const limits = (payload as Record<string, unknown>).rate_limits;
        if (typeof limits !== "object" || limits === null) continue;
        const l = limits as Record<string, unknown>;
        if (l.limit_id !== "codex") continue;

        const primaryWindow = readWindow(l.primary);
        const secondaryWindow = readWindow(l.secondary);
        const windows = [primaryWindow, secondaryWindow].filter(
          (w): w is Window => w !== null,
        );
        // No early `windows.length === 0` bailout here: a record whose
        // windows are both unreadable/absent can still carry a genuine
        // `rate_limit_reached_type` naming a real wall — bailing out before
        // that field is even read discarded that positive signal entirely,
        // falling through to drive.ts's generic exit-1 pass failure instead
        // of the fail-closed unknown/QUOTA_PARKED block SKILL.md promises
        // for an unclassifiable wall.
        // A slot that is genuinely absent (`null`/missing) is a real signal —
        // this account tier has no secondary window at all — never a
        // validation failure. A slot that is PRESENT but failed to parse is
        // different: readWindow() collapses both into the same `null`
        // return, so without tracking presence separately, a malformed
        // secondary alongside a healthy primary would read as "no exhausted
        // window found" and let the healthy branch below clear a real
        // exhausted block the unreadable slot might still represent.
        const isPresent = (v: unknown): boolean =>
          v !== null && v !== undefined;
        const anyPresentSlotUnreadable =
          (isPresent(l.primary) && primaryWindow === null) ||
          (isPresent(l.secondary) && secondaryWindow === null);

        // `rate_limit_reached_type` names the window that closed when the
        // vendor says so. When it is null we fall back to exhaustion by
        // percentage, because a `token_count` event is written on every turn
        // and most of them describe a perfectly healthy account. The only
        // names ever observed are "primary"/"secondary" — anything else is
        // validated, not trusted, and neither is a NAMED slot whose own window
        // record turns out malformed: in both cases the only trustworthy
        // signal left is an ACTUALLY exhausted window, never an arbitrary
        // `windows[0]` guess — that can select a perfectly healthy window and
        // read an account the vendor just said hit a limit as fine.
        const reached = l.rate_limit_reached_type;
        const named = reached === "primary" || reached === "secondary";
        const limitReached = typeof reached === "string" && reached !== "";
        // The vendor's documented healthy sentinel is exactly `null` — never
        // "anything that isn't a non-empty string". Missing, `''`, `false`,
        // or a number all satisfied the old `!limitReached` check the same
        // way `null` legitimately does, letting malformed telemetry clear a
        // real exhausted candidate as if the vendor had actually reported
        // health.
        // Confirmed healthy requires ALL of: the vendor's exact `null`
        // sentinel; every present window slot having actually parsed — an
        // unreadable slot might have been the exhausted one, so its presence
        // must not be silently forgiven just because the readable sibling
        // looks fine; and at least one window actually READ — a record with
        // zero parseable windows at all proves nothing about health, it just
        // means nothing was checked (now that `windows.length === 0` no
        // longer bails out before this point).
        const confirmedHealthy =
          reached === null && !anyPresentSlotUnreadable && windows.length > 0;
        // A named slot is always a valid candidate — the vendor's own word
        // that IT closed, trusted regardless of what its usedPercent shows —
        // but it is not necessarily the MOST restrictive one: a weekly window
        // can be exhausted too while a short slot is what got named. Compare
        // it against whichever window is actually most restrictive and keep
        // the longer of the two.
        //
        // `exhaustedWindow` and `namedWindow` are withheld entirely
        // when a sibling slot is present-but-unreadable: a readable window —
        // genuinely exhausted, or the one the vendor named — must not become
        // a confident `hit` while an unreadable sibling could be an EVEN
        // MORE restrictive window we simply cannot see. Selecting the
        // readable one anyway is a guess dressed as a fact, and sleeping on
        // it can wake straight into the wall the unreadable slot actually
        // represents. Withholding only `exhaustedWindow` is not enough;
        // `namedWindow` needs the identical guard.
        const namedWindow =
          named && !anyPresentSlotUnreadable ? readWindow(l[reached]) : null;
        // Computed unconditionally (never suppressed): even when an
        // unreadable sibling means we cannot CONFIDENTLY select this as the
        // most restrictive wall, a readable window genuinely at 100% is
        // still positive evidence a wall exists — silently dropping it to
        // "no signal" (below) would be wrong in the opposite direction from
        // the bug the withholding fixes.
        const exhaustedAmongReadable = mostRestrictiveExhausted(windows);
        const exhaustedWindow = anyPresentSlotUnreadable
          ? undefined
          : exhaustedAmongReadable;
        const candidates = [namedWindow, exhaustedWindow].filter(
          (w): w is Window => w !== null && w !== undefined,
        );
        const hit =
          candidates.length > 0
            ? candidates.reduce((longest, w) =>
                w.windowMinutes > longest.windowMinutes ? w : longest,
              )
            : undefined;

        // Compute what this record CONCLUDES, if anything, before touching
        // `newestAt` or `best` — an inconclusive record (no confirmed hit,
        // no confirmed health, no usable name) must advance neither: with
        // arbitrary `readdirSync` file order, advancing on an inconclusive
        // record would let it permanently block a genuinely older-but-valid
        // record from another file the same way a wholly malformed one
        // already could not.
        let decision:
          | { clearsBest: true }
          | { clearsBest: false; block: QuotaBlock }
          | null = null;
        if (hit !== undefined && hit !== null) {
          decision = {
            clearsBest: false,
            block: {
              vendor: "codex",
              window: classify(hit.windowMinutes),
              resetAt: new Date(hit.resetsAt * 1000),
              observedAt: new Date(ts),
              evidence:
                `${named ? `rate_limit_reached_type=${String(reached)}; ` : ""}` +
                `${hit !== namedWindow ? "a more restrictive exhausted window: " : ""}` +
                `used ${hit.usedPercent}% of a ${hit.windowMinutes}-minute window`,
              source: path,
            },
          };
        } else if (confirmedHealthy) {
          // A HEALTHY turn, newer than any earlier candidate: the account
          // was fine as of this point, which supersedes whatever an earlier
          // record in this same file said. Clear a stale exhausted/unknown
          // block rather than leaving it standing — otherwise an unrelated
          // LATER pass failure reads as still hitting a wall the account had
          // already recovered from.
          decision = { clearsBest: true };
        } else if (limitReached) {
          // The vendor says a limit was reached — under a name we recognise
          // but whose own window record is malformed, or under a name we do
          // not recognise at all — and no window measures 100% either (or an
          // unreadable sibling made an otherwise-exhausted reading
          // unusable). Do not read that as a healthy account — but do not
          // guess which window closed either. Report the block with a
          // window classification that fails closed to "stop and notify"
          // rather than a guessed reset.
          decision = {
            clearsBest: false,
            block: {
              vendor: "codex",
              window: "unknown",
              resetAt: null,
              observedAt: new Date(ts),
              evidence: `rate_limit_reached_type=${String(reached)} (${named ? "named slot malformed" : "unrecognised"}); no window confirmed at 100%`,
              source: path,
            },
          };
        } else if (
          anyPresentSlotUnreadable &&
          exhaustedAmongReadable !== undefined
        ) {
          // `reached === null` (no vendor name at all) but a READABLE window is
          // genuinely exhausted while a sibling slot is present-but-unreadable:
          // `hit` above deliberately withholds this as a confident answer (the
          // unreadable-sibling guard), but a window truly at 100% is still
          // positive evidence a wall exists — silently falling through to "no
          // signal" here would let the driver sleep or exit non-fail-closed on
          // a real quota wall. This branch does not know which window is the
          // true most-restrictive one either, so it does not guess a reset
          // time.
          decision = {
            clearsBest: false,
            block: {
              vendor: "codex",
              window: "unknown",
              resetAt: null,
              observedAt: new Date(ts),
              evidence: `a readable window used ${exhaustedAmongReadable.usedPercent}% of a ${exhaustedAmongReadable.windowMinutes}-minute window, but an unreadable sibling window prevents confirming it is the most restrictive wall`,
              source: path,
            },
          };
        }
        // else: neither the vendor's healthy sentinel, a usable name, nor a
        // readable-but-exhausted window, or an unreadable sibling with
        // nothing else to go on — missing, `''`, `false`, a number. No
        // confirmed signal either way; `decision` stays `null` and neither
        // `newestAt` nor `best` moves.

        if (decision === null) continue;
        // A strict `<=` discarded every later conclusive event sharing a
        // timestamp with the current newest — the rollout's own comment
        // above already concedes its precision "is not guaranteed", so two
        // genuinely distinct events (e.g. exhaustion immediately followed
        // by a healthy retry) can round to the identical value. A 100%
        // event followed by a same-timestamp healthy one then left the
        // exhausted block standing.
        // This file's own append-only line order is real evidence for a
        // same-timestamp tie; a tie against a DIFFERENT file is not
        // reordered, since `readdirSync` order across files is not a
        // chronological contract (the identical asymmetry the Claude
        // adapter's own same-second fix uses).
        if (ts < newestAt) continue;
        if (ts === newestAt && path !== newestPath) continue;
        newestAt = ts;
        newestPath = path;
        best = decision.clearsBest ? null : decision.block;
      }
    }
    if (best === null && discardedByTruncatedSnapshot > 0) {
      // The same "never fail quiet" posture the Claude adapter's own
      // truncated-snapshot diagnostic follows: silently reporting no wall
      // when detection was actually DEGRADED is the failure mode this file
      // exists to avoid.
      console.error(
        `drive-pr quota: discarded ${discardedByTruncatedSnapshot} candidate Codex rollout(s) because the pre-spawn snapshot scan was truncated (see MAX_CANDIDATE_FILES_SCANNED/DRIVE_PR_QUOTA_MAX_SCAN_MS) and this adapter has no session-id correlation to verify them independently.`,
      );
      console.error(
        "  If this recurs, the ~/.codex/sessions tree may be too large to scan within budget; DRIVE_PR_QUOTA_MAX_SCAN_MS raises the wall-clock allowance.",
      );
    }
    if (best === null && scan.truncated) {
      // A DIFFERENT walk from the one above: this is the detection-time scan
      // itself giving up before reaching every rollout touched since the pass
      // started, not the pre-spawn snapshot. "No wall found" here is not the
      // same claim as "no wall exists" — the walk may simply not have reached
      // the rollout carrying one. Say so rather than letting the caller read
      // this as an ordinary, fully-investigated pass failure.
      console.error(
        "drive-pr quota: the detection scan over ~/.codex/sessions was truncated (see MAX_CANDIDATE_FILES_SCANNED/DRIVE_PR_QUOTA_MAX_SCAN_MS) before it finished — a Codex quota wall may exist in a rollout this walk did not reach.",
      );
    }
    return best;
  },
};
