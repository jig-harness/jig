/**
 * Recognise a Claude Code subscription wall from the pass's own transcript.
 *
 * WHY THE TRANSCRIPT AND NOT THE PASS OUTPUT. The wall text is printed on the
 * pass's stdout, which would be the obvious place to read it — and `drive.ts`
 * deliberately does not capture that stream (SKILL.md § Running it: routing it
 * through a pipe changes `run()`'s close semantics, and a detached descendant
 * holding the pipe open wedges the round). That decision is load-bearing for
 * reasons that have nothing to do with quota, so this reads the durable copy
 * instead. The transcript is strictly better evidence anyway: it is structured,
 * it survives the pass, and it carries the `cwd` that proves whose wall it is.
 *
 * WHAT THE RECORD LOOKS LIKE, measured on this machine's transcripts:
 *
 *   {"type":"assistant","cwd":"/…/worktree","timestamp":"2026-08-20T00:20:37Z",
 *    "error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,
 *    "message":{"content":[{"type":"text",
 *      "text":"You've hit your session limit · resets 3:20am (Europe/Amsterdam)"}]}}
 *
 * WHAT THIS ADAPTER CANNOT DO, stated rather than papered over: it has never
 * seen a WEEKLY wall. Every `rate_limit` record in 371 samples here is the
 * five-hour "session limit" wording. So `session limit` is the only phrasing
 * classified `short`; every other recognised `rate_limit` is `unknown`, which
 * the caller treats exactly like `weekly` — stop and notify. That is the
 * correct behaviour for a weekly wall arriving in wording we have not seen,
 * and adding its recogniser later is additive. Guessing `short` from an
 * unrecognised phrase is the one mistake that would sleep a drive for days.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  belongsToWorktree,
  type CandidateScan,
  type DetectOpts,
  forEachDirEntry,
  isConfirmedAbsence,
  MAX_CANDIDATE_FILES_SCANNED,
  MAX_CLOCK_SKEW_MS,
  maxCandidateScanMs,
  type PreparedSpawn,
  type QuotaAdapter,
  type QuotaBlock,
  readBoundedTail,
  scanBudgetExceeded,
} from "./types.ts";
import {
  matchResetClauseText,
  parseResetClause,
  RESET_CLAUSE_RE,
} from "./wallclock.ts";

// The measured notice (this file's header comment) is a SELF-CONTAINED text
// block — the phrase, then the reset clause, and nothing else. Every earlier
// version of this recognizer instead looked for the phrase as a substring, or
// required only that it transition directly into "resets", which left a bypass
// at whichever position (before the phrase, between it and "resets", or after
// the reset clause) that version had not yet closed. Anchoring the WHOLE block
// — built from `RESET_CLAUSE_RE` itself rather than a second, hand-copied
// reset-clause fragment, so the two can never drift apart — closes every
// position at once: a block satisfies this only by being EXACTLY the phrase
// followed by EXACTLY a reset clause, with nothing before, between, or after
// either.
const SESSION_LIMIT_NOTICE_RE = new RegExp(
  `^you(?:'|’)ve hit your session limit\\s*·\\s*${RESET_CLAUSE_RE.source}$`,
  "i",
);

/**
 * Where Claude Code keeps transcripts. Overridable so the tests can point at a
 * fixture tree without writing to a developer's real one.
 */
function projectsRoot(): string {
  const override = process.env.DRIVE_PR_CLAUDE_PROJECTS_DIR;
  if (override !== undefined && override !== "") return override;
  // `CLAUDE_CONFIG_DIR` relocates Claude Code's own state directory — an
  // execution service may provision it per slot outside the worktree (for
  // example `CLAUDE_CONFIG_DIR=/srv/agents/<slot>/claude`). See the Codex
  // adapter's identical `CODEX_HOME` handling.
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && configDir !== ""
    ? join(configDir, "projects")
    : join(homedir(), ".claude", "projects");
}

/**
 * Files are found by MTIME and confirmed by CONTENT, never by the directory
 * name. Claude Code derives a project directory from the cwd by a punctuation
 * substitution it has changed before and does not document; a driver that
 * computed that slug would silently stop finding evidence the day it changes,
 * and silently-stops-detecting is the failure mode this module is here to
 * remove. The mtime filter keeps the scan small; the `cwd` field inside the
 * record is what actually binds evidence to this worktree.
 */
function candidateFiles(sinceMs: number): CandidateScan {
  const root = projectsRoot();
  const out: string[] = [];
  let scanned = 0;
  let truncated = false;
  // Wall-clock half of the same circuit breaker as the entry count below —
  // see `maxCandidateScanMs()`'s own doc comment for why a count alone
  // cannot bound how long a degraded filesystem keeps this walk running.
  const deadlineAt = Date.now() + maxCandidateScanMs();
  // Walked entry-by-entry via `forEachDirEntry`, never `readdirSync`: an
  // eager `readdirSync` materializes the WHOLE listing before the
  // `scanned` budget below gets to check even once, so a root (or a single
  // project directory) with far more entries than the cap still pays the
  // full enumeration cost upfront — the exact failure the cap exists to
  // prevent.
  const rootComplete = forEachDirEntry(root, (rootEntry) => {
    if (
      scanBudgetExceeded(
        scanned,
        MAX_CANDIDATE_FILES_SCANNED,
        deadlineAt,
        Date.now(),
      )
    ) {
      truncated = true;
      return false;
    }
    scanned++;
    if (!rootEntry.isDirectory()) return true;
    const dirPath = join(root, rootEntry.name);
    // `forEachDirEntry`'s own return distinguishes an I/O failure (EACCES, a
    // vanished mount, ...) from a clean walk — an outcome the budget check
    // above cannot see, since it never runs when the directory could not be
    // read at all.
    const dirComplete = forEachDirEntry(dirPath, (fileEntry) => {
      // A circuit breaker on the AGGREGATE enumeration/stat cost across
      // every project directory, not on how many turn out relevant — see
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
        truncated = true;
        return false;
      }
      scanned++;
      if (fileEntry.name.endsWith(".jsonl")) {
        const path = join(dirPath, fileEntry.name);
        try {
          if (statSync(path).mtimeMs >= sinceMs) out.push(path);
        } catch (err) {
          // A confirmed disappearance (ENOENT: rotated or removed mid-scan) is
          // not evidence and not truncation — the file genuinely does not exist
          // right now. Any OTHER stat failure (EACCES, a stalled or degraded
          // mount, ...) is NOT confirmed absence: if it is transient and clears
          // before detect()'s own separate walk moments later, that walk would
          // find the file, it would be missing from `preexistingSessions`
          // purely because THIS walk's stat failed, and detect() would
          // misattribute a pre-existing transcript to this pass — the same
          // misattribution MAX_CANDIDATE_FILES_SCANNED and maxCandidateScanMs()
          // already close, through a different door. Mark the walk truncated so
          // the caller degrades exactly as it does for those circuit breakers,
          // rather than trusting this file's absence.
          if (!isConfirmedAbsence(err)) {
            truncated = true;
          }
        }
      }
      return true;
    });
    if (!dirComplete) truncated = true;
    return true;
  });
  if (!rootComplete) truncated = true;
  return { files: out, truncated };
}

/**
 * Flags that make `--session-id` either meaningless or an outright conflict,
 * so seeing any of them means this adapter does not inject `--session-id`.
 *
 * `--resume`/`--continue`/`--fork-session`/`--from-pr`/`--teleport` all
 * select an EXISTING session, which is the one thing a freshly-minted id
 * cannot name; `--cloud` runs the session somewhere this machine has no
 * transcript for at all; `--bg` detaches it, so the process `drive.ts` waits
 * on is not the session doing the work. A caller that already passed
 * `--session-id` has chosen an identity of its own, and overriding it would
 * silently discard a deliberate choice.
 *
 * This set decides only whether `--session-id` may be INJECTED — it does not
 * mean every member leaves the command's evidence uncorrelated. `--resume
 * <value>` and a caller-supplied `--session-id <value>` are both handled
 * specially in `prepareSpawn` below: the CLI's own long-form syntax (`-r,
 * --resume [value]`, confirmed via `claude --help`; `--session-id` takes its
 * value the same unambiguous way) hands each an explicit target id, so that
 * value — not a freshly minted one — becomes the correlation id when no OTHER
 * conflict is present, with argv left completely unchanged either way (a
 * caller's own `--session-id` used to be treated as an outright conflict and
 * correlate on nothing, even though the value it supplies is exactly as exact a
 * key as one this adapter would mint itself). Every other member (and
 * `--resume`/`--session-id` in a form this adapter cannot safely read a value
 * from — bundled/attached short flags, or `--resume` paired with
 * `--fork-session`, which mints a NEW id instead of reusing the resumed one)
 * still leaves the command fully unclaimed.
 */
const SPAWN_PREP_CONFLICTS: ReadonlySet<string> = new Set([
  "--session-id",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--fork-session",
  "--from-pr",
  "--teleport",
  "--cloud",
  "--bg",
  "--background",
]);

/**
 * Whether `argv[0]` is Claude Code's own CLI rather than something that
 * merely runs it. An absolute path is normal (`/Users/…/.local/bin/claude`),
 * so the BASENAME is what is compared — but only the basename, never a
 * substring: a wrapper called `claude-pass.sh` is a wrapper, and appending a
 * flag it does not parse would turn every round into a usage error.
 *
 * The Windows extensions are stripped because the launcher there is
 * `claude.cmd`/`claude.exe` — the same program under the name the shell
 * actually resolves.
 *
 * KNOWN BOUNDARY: this looks at argv[0] only, so a SUBCOMMAND form
 * (`claude mcp serve`) is claimed too, and the flag lands before the
 * subcommand. Left alone deliberately — telling the two apart needs a list
 * of the CLI's subcommands, which is precisely the kind of undocumented
 * vendor detail that drifts and then silently misclassifies. It is also
 * unreachable from a real pass: whenever the driver was given a PR number
 * explicitly it refuses a pass argv that does not name it, and a subcommand
 * invocation names none — and a pass command that runs no prompt is not a
 * pass in the first place.
 */
function isClaudeCli(command: string): boolean {
  const name = basename(command).toLowerCase();
  return (
    name === "claude" ||
    name === "claude.exe" ||
    name === "claude.cmd" ||
    name === "claude.bat"
  );
}

/**
 * Every text block of the message's `content` array, each independently
 * whitespace-normalised — NOT concatenated into one string. A vendor message
 * can bundle more than one block, and classifying from the JOIN risks an
 * incidental "session limit" mention in one block combining with an
 * unrelated `resets ...` clause substring from a DIFFERENT block into a
 * false SHORT classification for a wall that is actually unknown or weekly.
 * The caller decides per block.
 */
function textBlocks(record: Record<string, unknown>): string[] {
  const message = record.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const t = (block as Record<string, unknown>).text;
    if (typeof t === "string") out.push(t.replace(/\s+/g, " ").trim());
  }
  return out;
}

/**
 * This adapter's vendor tag. A named constant because `DetectOpts.correlation`
 * is matched against it, and a correlation that silently fails to match its
 * own adapter would degrade exact detection back to "newest wall in the
 * worktree" with nothing to show for it.
 */
const claudeVendor = "claude";

export const claudeAdapter: QuotaAdapter = {
  vendor: claudeVendor,
  /**
   * `0` as the mtime floor, so every transcript is returned rather than only
   * recently-touched ones — `statSync(path).mtimeMs >= 0` is true for all of
   * them. The snapshot's question is "what already exists", and a transcript
   * dormant for a month is still one this pass did not create.
   */
  snapshotSessions(): CandidateScan {
    return candidateFiles(0);
  },
  prepareSpawn(
    argv: readonly string[],
    env: NodeJS.ProcessEnv,
  ): PreparedSpawn | null {
    const command = argv[0];
    if (command === undefined || !isClaudeCli(command)) return null;
    // `resumeValue` is read ONLY from the unambiguous long form
    // (`--resume <value>` / `--resume=<value>`) — never from a bundled or
    // attached short flag, for the identical reason the short-flag loop
    // below still refuses to claim those: `-r<value>` cannot be told apart
    // from an unrelated bundle without the CLI's own undocumented option
    // table. `sawResume` tracks the flag's mere PRESENCE separately from
    // whether a value was read, because a bare `--resume` (interactive
    // picker; unusable in a non-interactive pass, but not this adapter's
    // business to validate) must still be treated as a conflict, never as
    // "no resume seen at all, safe to inject --session-id".
    let resumeValue: string | null = null;
    let sawResume = false;
    let hasForkSession = false;
    let otherHardConflict = false;
    // A caller-supplied `--session-id` has already chosen an identity of its
    // own — this adapter must not inject a second, conflicting one — but
    // that identity is exactly as exact a correlation key as one this
    // adapter would have minted itself, so it is read the same way
    // `resumeValue` is: only from the unambiguous long form, never inferred.
    // There is no short form to worry about (`--session-id` has no `-s`
    // entry in `SPAWN_PREP_CONFLICTS`), so unlike `--resume` there is no
    // bundled/attached-value ambiguity here at all.
    let callerSessionId: string | null = null;
    let sawCallerSessionId = false;
    // Set for the long-form `--continue` ONLY — the sibling case, a bare
    // long-form `--resume` with no readable value, is decided directly below
    // from `sawResume && resumeValue === null` instead, since `--resume`
    // already has its own tracking variables and a separate flag here would
    // just be a second name for the same fact. Both cases mean the same thing
    // to the caller: the command is CONFIRMED to be Claude's own CLI
    // deliberately targeting an EXISTING session, but no exact id is available
    // to correlate on. Deliberately scoped to the LONG forms only: the
    // short-flag loop below cannot tell an actual `-c`/`-r` from a value
    // character that merely happens to be one (see its own comment), so it
    // classifies every match as `otherHardConflict` instead, never this.
    // Distinct from `otherHardConflict` (`--session-id`, `--cloud`, `--bg`,
    // `--background`, and every short-flag match): those either name an
    // identity this adapter must not override, run somewhere/somehow this
    // module's evidence cannot follow, or are too ambiguous to trust as resume
    // intent at all — regardless, a command classified there gets no
    // correlation. A pass in one of THESE (long-form) forms still appends to a
    // transcript that predates the spawn, and `sessionId: null` is still a
    // positive claim worth returning — for the argv-injection decision above
    // (do not append a fresh `--session-id`) and for `drive.ts`'s own log line
    // — but `detect()` does NOT let it bypass the file-level
    // `preexistingSessions` exclusion: without an exact id there is no way to
    // tell the resumed file apart from an unrelated preexisting file in the
    // same worktree, so a genuine wall here is a missed detection, not a
    // misattribution (a bypass here was tried and reverted over the
    // two-candidate gap — see `detect()`'s own comment on the exclusion). The
    // unambiguous long-form `--resume <value>` above is unaffected: its exact
    // id both bypasses the exclusion and narrows the per-record match.
    let deliberateResumeNoId = false;
    const rest = argv.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === undefined) continue;
      // The conventional end-of-options marker: everything after it is a
      // positional argument (prompt content), never a flag — so a quoted
      // `"--resume"` passed as prompt text past `--` must not be read as the
      // real flag. Stop inspecting rather than let the loop below match it.
      if (arg === "--") break;
      if (arg.startsWith("--")) {
        // `--flag=value` counts as the flag. Comparing whole tokens only
        // would miss `--resume=<id>`, claim the command anyway, and hand
        // Claude Code two conflicting session selectors.
        const eq = arg.indexOf("=");
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
        if (flag === "--fork-session") {
          hasForkSession = true;
          continue;
        }
        if (flag === "--resume") {
          sawResume = true;
          if (inlineValue !== undefined) {
            if (inlineValue !== "") resumeValue = inlineValue;
            continue;
          }
          // Commander's optional-value option: the NEXT token is the value
          // only when it doesn't itself look like another flag — the same
          // "does the next token look like a flag" heuristic every other
          // value-taking option in this repo's tooling uses.
          const next = rest[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            resumeValue = next;
            i++;
          }
          continue;
        }
        if (flag === "--continue") {
          deliberateResumeNoId = true;
          continue;
        }
        if (flag === "--session-id") {
          sawCallerSessionId = true;
          if (inlineValue !== undefined) {
            if (inlineValue !== "") callerSessionId = inlineValue;
            continue;
          }
          const next = rest[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            callerSessionId = next;
            i++;
          }
          continue;
        }
        if (SPAWN_PREP_CONFLICTS.has(flag)) otherHardConflict = true;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        // A single-dash token can carry several short flags at once, and
        // Commander reads BOTH forms this repo's pass commands can produce:
        // bundled (`-pr` → `-p -r`) and attached-value (`-r<session-id>`).
        // Matching whole tokens catches neither, and a regex over
        // all-alphabetic tokens catches only the first — an attached UUID
        // has digits in it, so `-r550e8400-…` slipped through, got claimed,
        // and would have been spawned as a resume selector AND a fresh
        // `--session-id` at once (a usage error, every round).
        //
        // So: walk the LEADING letters and stop at the first non-letter,
        // which is where a short flag's attached value begins. One rule for
        // both forms, and no enumeration of bundle permutations.
        //
        // Deliberately OVER-rejects, because the two forms are genuinely
        // ambiguous without the CLI's own option table: in `-pr` both
        // letters are flags, while in `-mclaude-opus-5` only `-m` is and
        // the rest is a value that merely happens to contain a `c`.
        // Telling them apart needs to know which short options take
        // values — undocumented, and it drifts. Refusing to claim is the
        // safe side of that ambiguity: the pass runs exactly as the caller
        // wrote it and correlation falls back to `preexistingSessions`,
        // whereas claiming wrongly appends a flag to a command that may
        // already be resuming a session. Unlike the long form above, no
        // value is ever extracted here — a match only ever sets a conflict
        // flag, never `resumeValue`.
        //
        // Classified as `otherHardConflict`, deliberately NOT
        // `deliberateResumeNoId`, even though the only single-letter members of
        // SPAWN_PREP_CONFLICTS (`-r`, `-c`) are themselves resume/continue
        // selectors: this loop cannot tell an ACTUAL `-c`/`-r` flag from a
        // value character that merely happens to be one, which is exactly the
        // `-mclaude-opus-5` case just above — its embedded `c` matched `-c`
        // here too. Marking that as a CONFIRMED deliberate resume would let
        // `detect()` trust a resumed-file's evidence for a command that was
        // never resuming anything, reopening the misattribution this whole
        // module exists to prevent — a strictly worse failure than the missed
        // detection `otherHardConflict` settles for.
        for (const ch of arg.slice(1)) {
          if (!/[a-zA-Z]/.test(ch)) break;
          if (SPAWN_PREP_CONFLICTS.has(`-${ch}`)) otherHardConflict = true;
        }
      }
    }
    if (otherHardConflict) return null;
    if (sawResume || hasForkSession) {
      // `--fork-session` mints a NEW id instead of reusing the resumed one,
      // so correlating on `resumeValue` there would name a session that is
      // about to stop existing under that id — worse than no correlation,
      // since the pass's REAL evidence would then be rejected as "not our
      // session" (the exact "silently-stops-detecting" failure `detect()`'s
      // own diagnostic exists to surface). It also mints a genuinely NEW
      // file rather than appending to the resumed one, so that file is never
      // in `preexistingSessions` in the first place — nothing here to fix.
      if (resumeValue !== null && !hasForkSession) {
        return {
          argv: [...argv],
          env,
          correlation: { vendor: claudeVendor, sessionId: resumeValue },
        };
      }
      // A bare long-form `--resume` (no readable value — `sawResume` true,
      // `resumeValue` still null) still deliberately targets an existing
      // session, unless paired with `--fork-session` (handled above: that
      // mints a new file instead). Tested directly rather than through
      // `deliberateResumeNoId`, which this branch never sets — that flag is
      // reserved for `--continue`, checked below once this whole
      // `sawResume || hasForkSession` branch has already returned.
      if (sawResume && resumeValue === null && !hasForkSession) {
        return {
          argv: [...argv],
          env,
          correlation: { vendor: claudeVendor, sessionId: null },
        };
      }
      return null;
    }
    if (deliberateResumeNoId) {
      return {
        argv: [...argv],
        env,
        correlation: { vendor: claudeVendor, sessionId: null },
      };
    }
    if (sawCallerSessionId) {
      // A readable value is exact, so correlate on it directly — argv is
      // already exactly what the caller wrote, nothing to inject.
      if (callerSessionId !== null) {
        return {
          argv: [...argv],
          env,
          correlation: { vendor: claudeVendor, sessionId: callerSessionId },
        };
      }
      // A bare/unreadable `--session-id` gives nothing to correlate on and
      // is not this adapter's business to fix — leave the command fully
      // unclaimed, the same as any other ambiguous form.
      return null;
    }
    const sessionId = randomUUID();
    // Inserted immediately after the command, never appended: a trailing
    // position would put the flag after the positional prompt, and whether a
    // parser accepts options there is its own business rather than something
    // this adapter should depend on. Directly after `argv[0]` is
    // unambiguous for any CLI that takes options at all.
    const prepared = [command, "--session-id", sessionId, ...argv.slice(1)];
    return {
      argv: prepared,
      env,
      correlation: { vendor: claudeVendor, sessionId },
    };
  },
  detect(opts: DetectOpts): QuotaBlock | null {
    const sinceMs = opts.since.getTime();
    // Floored to the second: the measured record shape's `timestamp` field and
    // some runner filesystems' transcript mtimes have whole-second precision,
    // while `since` (`passStartedAt` in drive.ts) is millisecond-precise.
    // Comparing either directly rejects a genuine wall recorded in the SAME
    // second the pass started as "older than the pass", turning correct quota
    // handling into a generic exit-1 failure.
    const sinceFloorMs = Math.floor(sinceMs / 1000) * 1000;
    const untilMs = opts.now.getTime() + MAX_CLOCK_SKEW_MS;
    let best: QuotaBlock | null = null;
    let bestAt = -1;
    let bestPath = "";

    // Only meaningful when the correlation names THIS adapter. A Codex
    // correlation says nothing about which Claude transcript is ours — the
    // pass could still have spawned a Claude subagent — so it must not be
    // read as this vendor's session id and silently match nothing.
    const claudeCorrelation =
      opts.correlation !== undefined && opts.correlation.vendor === claudeVendor
        ? opts.correlation
        : undefined;
    const ourSessionId = claudeCorrelation?.sessionId ?? null;
    // Otherwise-valid walls discarded ONLY because they carry a different
    // session id. Zero is the expected reading; a nonzero one with nothing
    // reported means we are looking at real walls and refusing all of them.
    let rejectedBySession = 0;
    // A candidate's absence from `preexistingSessions` is only trustworthy
    // proof of newness when that snapshot enumerated the WHOLE tree. If it
    // was truncated (`opts.preexistingSessionsTruncated`), the only remaining
    // way to tell "genuinely this pass's session" from "a pre-existing one the
    // snapshot missed" is the exact session-id match below — and that check
    // only exists when `ourSessionId !== null`. Without it, treating absence
    // as newness would misattribute a pre-existing transcript to this pass,
    // reachable BELOW `MAX_CANDIDATE_FILES_SCANNED` via the wall-clock cap.
    // Counted, not silently skipped, for the
    // same "never fail quiet" reason `rejectedBySession` is.
    const snapshotUnreliable =
      opts.preexistingSessionsTruncated === true && ourSessionId === null;
    let discardedByTruncatedSnapshot = 0;

    // A SEPARATE walk from `snapshotSessions()` above — taken now, at
    // detection time, over files touched since `sinceMs` rather than every
    // file that exists — so it can truncate independently of the pre-spawn
    // snapshot even below `MAX_CANDIDATE_FILES_SCANNED`, the same wall-clock
    // divergence `preexistingSessionsTruncated`'s own doc comment describes
    // for the other walk. Its `.truncated` used to be discarded here, so a
    // transcript this walk never reached read as "no wall" indistinguishably
    // from a genuinely clean one.
    const scan = candidateFiles(sinceFloorMs);
    for (const path of scan.files) {
      const isPreexisting = opts.preexistingSessions?.has(path) ?? false;
      // A file that already existed when the pass was spawned ORDINARILY
      // belongs to a session that started before it — a human's chat in this
      // same worktree being the normal case, whose wall is not this pass's
      // however recently it was appended to. That inference breaks for a
      // deliberate `--resume <id>` pass: it appends to a transcript that
      // legitimately predates the spawn, so a genuine wall from THIS pass
      // would otherwise be discarded here before ever reaching the exact-id
      // check below. Skip this
      // blanket exclusion when `ourSessionId !== null`: the exact id lets the
      // per-record match a few lines down narrow the resumed file down to
      // just the records this pass wrote, so the file-level exclusion has
      // nothing further to add.
      //
      // An earlier version widened this to every `vendorConfirmed` command —
      // including `--continue`/`-c`/an ambiguous `--resume`, none of which
      // carry an exact id — reasoning that `prepareSpawn` having confirmed the
      // command deliberately continues an EXISTING Claude session was already
      // more than file identity alone could tell us. That reasoning missed a
      // case with more than one candidate: with two pre-existing session files
      // in the worktree, a human's own concurrent session can append a wall to
      // the file THIS pass did NOT resume, after `since` — the `since` floor
      // narrows by TIME, not by WHICH file, so that unrelated wall passed every
      // remaining check and could park or sleep this pass on someone else's
      // evidence. Without an exact id there is no way to tell the resumed file
      // apart from any other preexisting file in the same worktree, so the
      // invariant is: a preexisting file's evidence is trusted only when it can
      // be bound to THIS pass by an exact session id. A genuine wall from a
      // `--continue`/no-id-resume pass is therefore a missed detection
      // (degrades to an ordinary pass failure, same as the no-correlation case
      // below) rather than the misattribution risk the wider bypass reopened —
      // the same fail-closed direction this module takes everywhere else.
      if (isPreexisting && ourSessionId === null) {
        continue;
      }
      // Only a file NOT found in `preexistingSessions` needs this check: one
      // that WAS found there is already positively known old (or, once an
      // exact id let it through above, already trusted regardless of
      // `snapshotUnreliable`, since that flag can only be true when
      // `ourSessionId === null` — exactly the case the exclusion above never
      // lets through anymore) — that fact does not become less true because
      // the snapshot walk missed some OTHER, unrelated file. Scoping to
      // `!isPreexisting` keeps this check from re-discarding an already-
      // trusted exact-id file for a reason that has nothing to do with it.
      if (!isPreexisting && snapshotUnreliable) {
        discardedByTruncatedSnapshot++;
        continue;
      }
      let body: string;
      try {
        body = readBoundedTail(path);
      } catch {
        continue;
      }
      // Cheap reject before parsing tens of thousands of JSON lines: a
      // transcript with no rate-limit record anywhere cannot contribute one.
      if (!body.includes('"rate_limit"')) continue;

      for (const line of body.split("\n")) {
        if (!line.includes('"rate_limit"')) continue;
        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null) continue;
          record = parsed as Record<string, unknown>;
        } catch {
          // A torn final line while the pass is still writing. Skip it.
          continue;
        }
        // The OUTER discriminator, matching the Codex adapter's identical
        // `type: "event_msg"` check: the documented shape (this file's
        // header comment) is a `type: "assistant"` record. Without it, a
        // different transcript record type that happens to carry compatible
        // `error`/`isApiErrorMessage`/`apiErrorStatus`/`cwd`/`timestamp`/
        // text fields becomes authoritative account telemetry too.
        if (record.type !== "assistant") continue;
        if (record.error !== "rate_limit") continue;
        // The documented shape (this file's header comment) carries further
        // discriminators alongside `error: "rate_limit"`:
        // `isApiErrorMessage: true` and `apiErrorStatus: 429`. Without them,
        // any record that merely reuses the `rate_limit` error string for an
        // unrelated reason becomes authoritative account telemetry — able to
        // manufacture a sleep/QUOTA_PARKED for an unrelated pass failure.
        if (record.isApiErrorMessage !== true) continue;
        if (record.apiErrorStatus !== 429) continue;
        if (!belongsToWorktree(record.cwd, opts.cwd)) continue;
        const ts =
          typeof record.timestamp === "string"
            ? Date.parse(record.timestamp)
            : Number.NaN;
        if (!Number.isFinite(ts) || ts < sinceFloorMs || ts > untilMs) continue;
        // The exact, authoritative binding when we have one: every record
        // Claude Code writes carries the `sessionId` of the session that
        // wrote it, and `prepareSpawn` above chose that id itself before the
        // spawn. Matching on it means no other session's wall can be read as
        // this pass's, even one that started inside the snapshot window —
        // the residual `preexistingSessions` alone cannot close.
        //
        // Checked on the RECORD rather than inferred from the filename,
        // even though the file is named `<sessionId>.jsonl` today. That
        // naming is undocumented vendor behaviour, and this file already
        // refuses to derive anything from a transcript's path for exactly
        // that reason (see `candidateFiles`). A record missing the field
        // entirely fails this check too, which is the fail-closed direction:
        // the caller stops on an ordinary pass failure rather than sleeping
        // on evidence it cannot attribute.
        //
        // Placed AFTER every other validity gate on purpose. A record
        // rejected here has satisfied the record shape, the worktree and
        // the time window — so it is a wall we WOULD have reported but for
        // the id, which is exactly the population `rejectedBySession`
        // counts below.
        if (ourSessionId !== null && record.sessionId !== ourSessionId) {
          rejectedBySession++;
          continue;
        }
        // Newest wins: a pass can hit the wall, retry, and hit it again, and
        // only the last reset time is the one still in force. Claude's
        // whole-second precision means two genuinely distinct records in the
        // SAME file can round to the identical displayed second — a strict `<=`
        // rejected every record after the first of a tie, leaving an earlier
        // SHORT record standing over a later, more restrictive one recorded
        // moments afterward. This file's own line order is real chronological
        // evidence for a tie, since it is written append-only: let a
        // same-second record from the SAME file win. A tie against a DIFFERENT
        // file gets no such benefit — `readdirSync` order across files is not a
        // chronological contract, so an equal timestamp there is left exactly
        // as strict as before.
        if (ts < bestAt) continue;
        if (ts === bestAt && path !== bestPath) continue;

        const blocks = textBlocks(record);
        // Classified from a SINGLE block, never the join of all of them: a
        // vendor message can bundle more than one block, and an incidental
        // "session limit" mention in one block combined with an unrelated
        // `resets ...` clause substring from a DIFFERENT block would report a
        // false SHORT classification for a wall that is actually unknown or
        // weekly — defeating the fail-closed policy this file otherwise
        // follows. First block that itself contains the phrase wins; its OWN
        // reset clause is the only one ever trusted. Matched against the WHOLE
        // block via `SESSION_LIMIT_NOTICE_RE` (defined above, next to why it is
        // anchored end to end) — see that comment for why a partial match at
        // any position kept leaving a fresh bypass, one position after another.
        let isSession = false;
        let reset: { at: Date; zone: string } | null = null;
        let sessionBlock = "";
        for (const block of blocks) {
          if (SESSION_LIMIT_NOTICE_RE.test(block)) {
            isSession = true;
            reset = parseResetClause(block, new Date(ts));
            sessionBlock = block;
            break;
          }
        }
        bestAt = ts;
        bestPath = path;
        // `evidence` is what a human reads via `describeQuota()`, and what
        // drive.ts logs unattended to a clone-wide log file. A vendor
        // message's blocks can include ordinary reply content bundled
        // alongside its own rate-limit line, not just the limit notice
        // itself. Storing all of it risks logging unrelated transcript
        // content the user typed, with no classification, redaction, or
        // retention bound. Record only what was actually RECOGNISED: the
        // session-limit phrase (a fixed label, not a quote) and the `resets
        // ...` clause substring itself — never the free text either was
        // found in. For an
        // unrecognised wall, still surface any resets clause found in ANY
        // block purely as evidence — it is never trusted for `resetAt` or
        // `window` unless it came from the block that also matched the
        // session-limit phrase.
        const resetClauseText = isSession
          ? matchResetClauseText(sessionBlock)
          : (blocks
              .map((b) => matchResetClauseText(b))
              .find((m) => m !== null) ?? null);
        const recognised = [
          isSession ? "session limit" : null,
          resetClauseText,
        ].filter((p): p is string => p !== null);
        best = {
          vendor: claudeVendor,
          window: isSession ? "short" : "unknown",
          // A reset clause is only trusted for wording we classified. On an
          // unrecognised phrase the instant may well parse, but it would be an
          // instant for a window whose LENGTH we do not know — and length is
          // what decides sleepability. Report the block, withhold the reset.
          resetAt: isSession && reset !== null ? reset.at : null,
          observedAt: new Date(ts),
          evidence:
            recognised.length > 0
              ? recognised.join(" · ")
              : "(rate_limit record with no recognised wording)",
          source: path,
        };
      }
    }
    if (best === null && rejectedBySession > 0) {
      // The one failure mode this file says out loud it exists to remove:
      // "silently-stops-detecting" (see `candidateFiles`). If a future CLI
      // makes `--session-id` a no-op, or a reconnect re-mints the id
      // mid-pass, every wall in this worktree is discarded by the id clause
      // alone and the driver reports ordinary pass failures forever with
      // nothing to distinguish that from a quiet account. Fail closed, but
      // never fail QUIET — the operator gets the way out by name.
      console.error(
        `drive-pr quota: discarded ${rejectedBySession} otherwise-valid Claude rate-limit record(s) whose sessionId is not this pass's (${ourSessionId}).`,
      );
      console.error(
        "  If this recurs, the injected --session-id may not be taking effect; DRIVE_PR_QUOTA_NO_SPAWN_PREP=1 falls back to worktree-scoped matching.",
      );
    }
    if (best === null && discardedByTruncatedSnapshot > 0) {
      // The same "never fail quiet" posture as the block above, for the other
      // way a candidate can be discarded rather than trusted: the pre-spawn
      // snapshot did not finish enumerating the tree, and with no session-id
      // correlation to fall back on there is no way left to tell a
      // pre-existing transcript from this pass's own.
      console.error(
        `drive-pr quota: discarded ${discardedByTruncatedSnapshot} candidate Claude transcript(s) because the pre-spawn snapshot scan was truncated (see MAX_CANDIDATE_FILES_SCANNED/DRIVE_PR_QUOTA_MAX_SCAN_MS) and no exact session correlation was available to verify them independently.`,
      );
      console.error(
        "  If this recurs, the ~/.claude/projects tree may be too large to scan within budget; DRIVE_PR_QUOTA_MAX_SCAN_MS raises the wall-clock allowance.",
      );
    }
    if (best === null && scan.truncated) {
      // A DIFFERENT walk from the two above: this is the detection-time scan
      // itself giving up before reaching every transcript touched since the
      // pass started, not the pre-spawn snapshot. "No wall found" here is not
      // the same claim as "no wall exists" — the walk may simply not have
      // reached the transcript carrying one. Say so rather than letting the
      // caller read this as an ordinary, fully-investigated pass failure.
      console.error(
        "drive-pr quota: the detection scan over ~/.claude/projects was truncated (see MAX_CANDIDATE_FILES_SCANNED/DRIVE_PR_QUOTA_MAX_SCAN_MS) before it finished — a Claude quota wall may exist in a transcript this walk did not reach.",
      );
    }
    return best;
  },
};
