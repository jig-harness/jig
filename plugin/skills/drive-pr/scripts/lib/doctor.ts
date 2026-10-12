/**
 * `--doctor`'s classifier — an earlier change §2. Pure: no filesystem, no subprocess,
 * no clock read of its own. `drives.ts` does every read (the state file, the
 * `ps` probe via `hasPassChild`, the per-worktree `git` calls) and hands the
 * results here as a plain record; this file only DECIDES.
 *
 * WHY THE SEAM MATTERS. The real argument for a separate, pure classifier is
 * not that `drives.ts` is untestable in principle — `drives.test.ts` already
 * spawns it against real lock directories, real state files and real
 * worktrees — but that comparing WEDGED and HEALTHY side by side requires
 * holding two OTHERWISE-IDENTICAL inputs apart from each other and from
 * whatever `ps` happens to report on the host the suite runs on. A real
 * process table is exactly the thing this classifier's own INPUT — `passChild`
 * — is meant to abstract away from at decision time, so building the fixture
 * from a live `ps` snapshot would make the comparison depend on what else is
 * running on that machine, not on the two facts the test is actually about.
 * Every branch below is instead a comparison over plain data, so the test
 * suite can construct "wedged" and "healthy" as two literal objects and
 * assert they classify differently — the acceptance criterion this module
 * exists to satisfy.
 *
 * PRECEDENCE IS THE WHOLE DESIGN, so it is stated once here rather than
 * scattered across the branches below:
 *
 *   1. Fail closed first — an unreadable/contested lock or an unreadable
 *      state file is `UNKNOWN` before anything else is even asked.
 *   2. No live driver + leftovers in the worktree → `DEAD_WITH_LEFTOVERS`.
 *      Checked BEFORE the quota-park and human-parked checks below, because a
 *      drive that parked (or had items parked) and then had its DRIVER die is
 *      still, first and foremost, a tree with stranded work — the park or the
 *      parked items are a REASON the driver stopped, but the leftovers are a
 *      LOSS nothing else on this list reports, and a human acting on this row
 *      needs to know about the loss before the reason. Only the POSITIVE
 *      finding jumps the queue this way: an UNINSPECTABLE worktree
 *      (`leftovers === null`, e.g. a state-only row with no worktree known
 *      at all) is a weaker "could not tell" that must NOT outrank 3 or 5
 *      below, so it is deferred to the trailing `UNKNOWN` default (7)
 *      instead of returned here — see `classifyDrive`'s own comment on
 *      `uninspectableLeftoversReason` for the bug this closed.
 *   3. A recorded quota park → `QUOTA_PARKED`. Outranks both `WEDGED` and
 *      `NEEDS_HUMAN` below because a park is TIME-BOUNDED and self-resolving
 *      in the ordinary case (the window reopens) — including the SLEEP path
 *      (`drive.ts`'s `recordQuotaPark`, called on both the sleeping and the
 *      exiting quota branches), which holds its locks live, refreshing, with
 *      no pass running and nothing to stamp for up to six hours: every
 *      condition `WEDGED` below checks for is otherwise met by a drive doing
 *      exactly what it was designed to do. EXCEPT when the park's own
 *      `resetAt` has already passed AND every fact branch 4 checks is
 *      independently true (live lock, stale progress, confirmed no pass
 *      child): there the "self-resolving" premise has demonstrably failed —
 *      the window reopened and nothing resumed — so this falls through to
 *      `WEDGED` instead of reporting a park that no future progress event
 *      will ever clear.
 *   4. A live lock, stale progress, and a confirmed ABSENCE of a pass child
 *      → `WEDGED`. Outranks `NEEDS_HUMAN` (moved below it
 *      round 2 M4) because `parked` is cleared only by an explicit human
 *      `unpark` and a drive keeps running for rounds with items still
 *      parked — so a drive that parked one thread early and then wedged
 *      later would report `NEEDS_HUMAN` forever under the OLD order, and the
 *      wedge — the more urgent fact, and the more PERISHABLE one (the
 *      pass-child evidence a later sweep reads may no longer be there) —
 *      would never surface. A human decision waiting is not going anywhere;
 *      a drive that is actually stuck right now is.
 *   5. `parkedCount > 0` → `NEEDS_HUMAN`.
 *   6. A live lock with either a currently-running pass or recent progress →
 *      `HEALTHY` — the only branch that reaches it; the function's own
 *      default is `UNKNOWN`.
 *   7. Everything else (a live lock that has never progressed at all;
 *      `passChild === null`; an uninspectable worktree with no live driver
 *      opinion; …) falls through to the default `UNKNOWN`.
 *
 * NEVER DEFAULT TO HEALTHY. `HEALTHY` is returned from exactly one `return`
 * statement in this file, reached only once every earlier, more specific
 * question has been asked and answered negatively. Every other exit either
 * names a specific verdict for a specific, positively-established condition,
 * or falls through to the function's trailing `UNKNOWN` — there is no
 * `else { return HEALTHY }` anywhere in this function, by design: a case this
 * file did not anticipate must read as "cannot tell", never as "fine".
 */

import { isDigits, shellQuote } from "./cli.ts";
import type { PassChildAnswer } from "./pass-child.ts";
import type { QuotaParkRecord } from "./state/schema.ts";

/**
 * How long `lastProgressAt` may go unrefreshed on a LIVE lock before it
 * counts toward `WEDGED`, in minutes.
 *
 * TWO HUNDRED FORTY, derived rather than guessed. `drive.ts` never invokes
 * `await-round.ts` at all (that script belongs to the SIBLING
 * `resolve-review-comments` skill, and if a pass happens to use it, that
 * wait is NESTED inside the pass's own deadline below, not additional to
 * it) — the two genuinely SEQUENTIAL, out-of-pass components are:
 * `passTimeoutSeconds`'s own default (`drive.ts`) budgeting 90 minutes for
 * one honest round — merge a base, run the full cumulative validation plan,
 * wait on a machine-wide test mutex (such as M12's resource lock) if
 * another worktree is mid-gate — and the GATE POLL `drive.ts` itself runs
 * BEFORE spawning that round's pass: its own `--timeout` flag is forwarded
 * straight to `drive-status.ts`'s poll, defaulting to 1800s (30 minutes),
 * which gives up and exits 4 rather than looping forever. Both sit strictly
 * between two consecutive progress stamps (the poll before a pass is
 * spawned, the pass's own deadline once it is), so 90 + 30 = 120 minutes of
 * genuinely-idle-looking work one round can produce without ever failing
 * anything, and this constant doubles it rather than shaving the
 * difference: a threshold set exactly at the sum would flag the FIRST round
 * that is merely a little slower than the measured worst case, which is the
 * false-alarm failure mode `lib/pass-child.ts`'s own header explains this
 * classifier is built to avoid. Widen it if a real, honest round ever needs
 * more; do not tighten it to make `--doctor` feel more responsive — that is
 * exactly the trade `passTimeoutSeconds`'s own header already refused to
 * make once.
 */
export const STALL_THRESHOLD_MIN_DEFAULT = 240;

/**
 * `DRIVE_PR_STALL_MIN`, clamped — mirrors `heartbeatStaleMs()`'s own
 * clamping shape in `lib/claim.ts` (same file family, same reasoning): an
 * unparsable or absent override falls back to the default rather than
 * producing `NaN`, and a parsed value is still bounded on both ends so a
 * fat-fingered `DRIVE_PR_STALL_MIN=0` cannot flag every live round as WEDGED
 * a moment after it starts, and an absurd `DRIVE_PR_STALL_MIN=999999` cannot
 * silence the signal for a year. The floor is `STALL_THRESHOLD_MIN_DEFAULT`
 * itself, not some smaller number, so this can never be configured BELOW the
 * legitimately-long-round budget it was derived from — a floor of, say, 90
 * would let an operator "fix" a noisy WEDGED alarm by dialing the threshold
 * back under the very pass deadline that produces long-but-honest rounds.
 * The ceiling (one week, in minutes) mirrors `heartbeatStaleMs()`'s own —
 * there is no reason for this signal's outer bound to differ from that
 * sibling's.
 */
export function stallThresholdMs(): number {
  const raw = process.env.DRIVE_PR_STALL_MIN ?? "";
  const n = isDigits(raw)
    ? Number.parseInt(raw, 10)
    : STALL_THRESHOLD_MIN_DEFAULT;
  return Math.min(Math.max(n, STALL_THRESHOLD_MIN_DEFAULT), 10_080) * 60_000;
}

export type DoctorVerdict =
  | "HEALTHY"
  | "WEDGED"
  | "DEAD_WITH_LEFTOVERS"
  | "QUOTA_PARKED"
  | "NEEDS_HUMAN"
  | "UNKNOWN";

export interface DoctorLeftovers {
  uncommitted: boolean;
  unpushed: boolean;
  /** The marker basename (`MERGE_HEAD`, …), or `null` when none is present. */
  unconcludedOp: string | null;
}

export interface DoctorInput {
  /** Lock liveness as `drives.ts` already computes it (`readLock`). */
  lockState: "live" | "stale" | "empty" | "contested" | "unreadable";
  /** ms since `DriveState.lastProgressAt`, `null` when unknown/never/unreadable. */
  progressAgeMs: number | null;
  /** Whether the state file could be read (and shape-validated) at all. */
  stateReadable: boolean;
  passChild: PassChildAnswer;
  quotaPark: QuotaParkRecord | null;
  parkedCount: number;
  /** Worktree leftovers; `null` when the worktree could not be inspected. */
  leftovers: DoctorLeftovers | null;
  stallThresholdMs: number;
  /**
   * The PR number, verbatim from the lock row — plain data, not I/O; folded
   * in ONLY so `recovery` can name a concrete command (`shellQuote`, a pure
   * function, is all this file uses it for). Not part of the issue's own
   * literal `DoctorInput` sketch, but `recovery` cannot be "the command to
   * run" without it — see the module header's seam argument for why that
   * still keeps this file pure rather than reopening it to I/O.
   */
  pr: string;
  /** The driven worktree's absolute path, or `null` when it is unknown. */
  worktreePath: string | null;
  /** Absolute path to `drives.ts` itself, for building its own `--stop` hint. */
  selfPath: string;
  /**
   * Can `--stop` (and therefore this host's `ps`/`kill`) act on this lock's
   * owner at all — is the recorded claim host either unset (legacy debris,
   * conventionally "this host") or equal to THIS host's own hostname?
   * an earlier change M2.
   *
   * Gates two things a foreign host makes meaningless: `passChild`, which
   * `drives.ts` must compute as `null` (never walk a REMOTE pid against the
   * LOCAL process table — a same-numbered local pid with children would
   * otherwise misreport `HEALTHY` for a drive that isn't even on this
   * machine), and `WEDGED`'s `recovery` command, which names a `--stop`
   * this host cannot execute (`stop` itself refuses on sight — see its own
   * host check). `false` is the fail-closed default a caller must supply
   * when the lock's host cannot be resolved at all.
   */
  hostIsLocal: boolean;
}

export interface DoctorRow {
  verdict: DoctorVerdict;
  reason: string;
  recovery: string | null;
}

/**
 * Is there NO live driver on this lock — the one condition under which
 * `classifyDrive` consults `DoctorInput.leftovers` at all (branch 2)?
 *
 * Exported so `drives.ts` can skip the four `git` subprocesses a leftovers
 * probe costs on a row whose answer this classifier provably never reads,
 * WITHOUT keeping a second copy of the condition. A hand-written
 * `row.state === 'stale' || …` at the gather site would be exactly the
 * "two places that must agree with the classifier's precedence order" hazard
 * the gather was uniform to avoid; one exported predicate, used by both the
 * gather and the branch, has no second copy to drift.
 *
 * This predicate governs whether branch 2 is reached at all — it does NOT
 * govern whether the probe it gates actually ran. `drives.ts` also skips the
 * probe (leaving `leftovers: null`) whenever `worktreePath` is `null` — an
 * `empty` lock has no claim to read a worktree from, and a older
 * diag-less claim never recorded one — and BOTH of those reach branch 2 too,
 * since `noLiveDriver('empty')` is `true` regardless of whether a worktree
 * was ever known. So a `null` `leftovers` inside branch 2 is ambiguous
 * between "the probe was attempted and failed" and "there was never a
 * worktree to probe" — `classifyDrive` distinguishes the two in its own
 * `reason` text by reading `worktreePath` directly, precisely because this
 * predicate alone cannot (an earlier change minor finding — an earlier
 * revision of this comment claimed reaching branch 2 implied the probe had
 * run, which is the false claim that finding was about).
 */
export function noLiveDriver(lockState: DoctorInput["lockState"]): boolean {
  return lockState === "stale" || lockState === "empty";
}

/**
 * `bun <drives.ts> --stop <PR>`, shell-quoted — the identical shape
 * `drives.ts`'s own `stopHint` already prints, factored out here so both
 * call sites format it once. Absolute and quoted for the same reason
 * `stopHint`'s own comment gives: the copied command must resolve from any
 * cwd and survive a repository path containing whitespace.
 */
export function formatStopCommand(selfPath: string, pr: string): string {
  return `bun ${shellQuote(selfPath)} --stop ${pr}`;
}

function describeLeftovers(l: DoctorLeftovers): string {
  const parts: string[] = [];
  if (l.unconcludedOp !== null) {
    parts.push(`an unconcluded git operation (${l.unconcludedOp})`);
  }
  if (l.uncommitted) parts.push("uncommitted changes");
  if (l.unpushed) parts.push("unpushed commits");
  return parts.join(", ");
}

/**
 * `now` distinguishes a park that is still waiting out its window from one
 * whose window has ALREADY reopened but no drive has re-armed since — the
 * same class of information the `--doctor` reader is trying to establish
 * (is this drive actually stuck, or merely paused). Without it, a park
 * recorded hours ago with a long-past `resetAt` reads identically to one
 * from a minute ago, and a human skimming the fleet has to do that
 * arithmetic themselves for every QUOTA_PARKED row instead of once here.
 */
function describeQuotaPark(park: QuotaParkRecord, now: Date): string {
  const reset =
    park.resetAt === null
      ? "unresolved"
      : Date.parse(park.resetAt) <= now.getTime()
        ? `resets ${park.resetAt} — already past, not yet re-armed`
        : `resets ${park.resetAt}`;
  return `parked on a ${park.vendor} ${park.window}-window quota wall at ${park.at} (${reset})`;
}

export function classifyDrive(input: DoctorInput, now: Date): DoctorRow {
  // 1. Fail closed first. `contested` (more than one claim file in the lock
  // dir) and `unreadable` (the lock directory or its single claim could not
  // be parsed) have established NOTHING positive about this drive — neither
  // "a driver is working it" nor "nobody is". Same for an unreadable state
  // file: every other field this function reads comes FROM that file, so a
  // failure to read it poisons the rest of the record, not just one field.
  if (input.lockState === "unreadable" || input.lockState === "contested") {
    return {
      verdict: "UNKNOWN",
      reason: `the drive lock is ${input.lockState} — cannot tell whether a driver is working this PR`,
      recovery: null,
    };
  }
  // Unreadable state does NOT preempt an independently-established
  // DEAD_WITH_LEFTOVERS: `gatherDoctorInput` runs the leftovers probe off the
  // WORKTREE, unconditionally on whether the state snapshot parsed (review
  // finding) — so a stale claim with an old or malformed state file, sitting
  // over confirmed uncommitted changes, unpushed commits, or an unconcluded
  // git operation, has already answered "is something lost in this tree"
  // before this function ever looks at the state file. Reporting UNKNOWN
  // over that would discard evidence this classifier already has, and is
  // reachable immediately after a rollout that (like this PR) intentionally
  // rejects every pre-existing state shape. Every other unreadable-state case
  // still returns UNKNOWN here exactly as before — branch 2 below cannot
  // itself construct DEAD_WITH_LEFTOVERS unless this same combination holds.
  if (
    !input.stateReadable &&
    !(
      noLiveDriver(input.lockState) &&
      input.leftovers !== null &&
      (input.leftovers.uncommitted ||
        input.leftovers.unpushed ||
        input.leftovers.unconcludedOp !== null)
    )
  ) {
    return {
      verdict: "UNKNOWN",
      reason:
        "the drive state file could not be read — every other signal this classifier reads comes from it",
      recovery: null,
    };
  }

  // 2. No live driver + leftovers → DEAD_WITH_LEFTOVERS. Outranks the
  // quota-park and parked-count checks below — see the module header for why
  // a loss in the tree takes precedence over a reason for the drive's own
  // stop.
  //
  // Only the POSITIVE finding (DEAD_WITH_LEFTOVERS) returns immediately here.
  // An uninspectable worktree (`leftovers === null`) is NOT a positive
  // finding — it is "this branch could not answer", a WEAKER fact than a
  // quota park or a parked item this classifier already knows for certain
  // from the state file directly. Returning it immediately would let it
  // preempt branches 3 and 5 below, which is exactly backwards: a
  // state-file-only row (no lock at all, hence `worktreePath === null` —
  // an earlier change's own C1) that recorded a real quota park was reaching this
  // early return and reporting UNKNOWN, never QUOTA_PARKED, because THIS
  // branch's inconclusive answer was allowed to outrank a fact the state
  // file settles outright (found reviewing this round's own C1 test — see
  // `doctor.test.ts`'s "an uninspectable worktree does not preempt a KNOWN
  // quota park"). So it is DEFERRED to the trailing fallback (7) instead,
  // and used there ONLY if nothing more specific claimed the row first.
  let uninspectableLeftoversReason: string | null = null;
  if (noLiveDriver(input.lockState)) {
    if (input.leftovers === null) {
      // `worktreePath === null` means the probe was never even ATTEMPTED
      // (no claim to read a worktree from at all — an `empty` lock, or a
      // older diag-less one); anything else with `leftovers: null`
      // means a real worktree path was probed and the probe itself failed.
      // These are different facts, and the wording must not claim an
      // inspection happened when none did (an earlier change minor
      // finding — `noLiveDriver`'s own doc comment has the full case).
      uninspectableLeftoversReason =
        input.worktreePath === null
          ? "no live driver, and this lock records no worktree to inspect for leftovers"
          : "no live driver, and the worktree could not be inspected for leftovers";
    } else if (
      input.leftovers.uncommitted ||
      input.leftovers.unpushed ||
      input.leftovers.unconcludedOp !== null
    ) {
      return {
        verdict: "DEAD_WITH_LEFTOVERS",
        reason: `no live driver, and the worktree still holds ${describeLeftovers(input.leftovers)}`,
        recovery:
          input.worktreePath !== null
            ? `git -C ${shellQuote(input.worktreePath)} status --short`
            : null,
      };
    }
  }

  // 3. A recorded quota park → QUOTA_PARKED, whether or not the lock has
  // decayed to `stale` yet (a driver that just called `quota-park` and is
  // about to exit can still read `live` for a while — see `drive.ts`'s own
  // §1c comment). Outranks WEDGED and NEEDS_HUMAN below — see the module
  // header for the sleeping-drive false-alarm this precedence exists to
  // prevent — UNLESS the park's own `resetAt` has ALREADY passed and the
  // live-lock/stale-progress/no-pass-child facts branch 4 checks are ALL
  // independently true. That combination is exactly the "self-resolving"
  // assumption this precedence rests on having failed: the window reopened,
  // and by the time it did the driver had not resumed, is not currently
  // running a pass, and has recorded no progress since — the wedge this
  // classifier exists to surface, indistinguishable from a wedge with no
  // park at all except for a stale record nothing will ever clear (no
  // future progress event is coming from a drive that is actually stuck).
  // Reported as QUOTA_PARKED forever in that case would permanently mask
  // it, defeating branch 4 for the one drive shape it is most needed on.
  // `resetPast` and `wedgeFacts` are computed once here, ahead of the
  // return, rather than duplicating branch 4's own predicate at the end of
  // this function — a later divergence between the two copies would silently
  // reopen this gap for one of the two callers.
  const resetPast =
    input.quotaPark !== null &&
    input.quotaPark.resetAt !== null &&
    Date.parse(input.quotaPark.resetAt) <= now.getTime();
  const wedgeFacts =
    input.lockState === "live" &&
    input.progressAgeMs !== null &&
    input.progressAgeMs > input.stallThresholdMs &&
    input.passChild === false;
  if (input.quotaPark !== null && !(resetPast && wedgeFacts)) {
    return {
      verdict: "QUOTA_PARKED",
      reason: describeQuotaPark(input.quotaPark, now),
      // No single command re-arms a park: the pass command that must resume
      // it is arbitrary argv this classifier never sees (see
      // `lib/pass-child.ts`'s header) and is not persisted anywhere. Naming
      // one here would be a guess dressed as an instruction.
      recovery: null,
    };
  }

  // 4. Stale progress with a CONFIRMED absence of a pass child → WEDGED.
  // `passChild === false` specifically, never merely falsy: `null` (the
  // probe could not run, or the lock's host is not this one — see
  // `hostIsLocal`) has not established the absence this verdict asserts, and
  // defaulting an unprobeable answer to "wedged" would be the false-alarm
  // direction `lib/pass-child.ts`'s own header explains this classifier is
  // built to avoid. Outranks `NEEDS_HUMAN` (5) — see the module header for
  // why a perishable wedge takes precedence over a standing human decision.
  // Reached both for a drive with no park at all, and — per branch 3 above —
  // for one whose park's `resetAt` has already passed while `wedgeFacts`
  // holds; `wedgeFacts` is exactly this branch's own guard, so the two never
  // disagree about which drives land here. The redundant-looking
  // `&& input.progressAgeMs !== null` is for TypeScript, not logic:
  // `wedgeFacts` already implies it, but a `boolean` carries no narrowing of
  // its own, and the `reason` string below needs `progressAgeMs` as `number`.
  if (wedgeFacts && input.progressAgeMs !== null) {
    return {
      verdict: "WEDGED",
      reason: `no recorded progress for ${Math.round(input.progressAgeMs / 60000)} minute(s) (threshold ${Math.round(input.stallThresholdMs / 60000)}) and no pass process is running under this driver`,
      // `--stop` cannot act on a foreign host — `stop()` itself refuses on
      // sight — so naming the command there would be a recovery a human
      // could copy-paste and watch fail.
      recovery: input.hostIsLocal
        ? formatStopCommand(input.selfPath, input.pr)
        : null,
    };
  }

  // 5. A human decision is outstanding → NEEDS_HUMAN, live driver or not — a
  // parked thread/finding does not resolve itself merely because a driver is
  // (or isn't) currently attached. Below WEDGED (4): a drive keeps running
  // for rounds with items still parked (`parked` is cleared only by an
  // explicit human `unpark`), so checking this FIRST would report a stale
  // park forever on a drive that has since wedged, hiding the more urgent —
  // and more perishable — fact.
  if (input.parkedCount > 0) {
    return {
      verdict: "NEEDS_HUMAN",
      reason: `${input.parkedCount} item(s) parked awaiting a human decision`,
      recovery: null,
    };
  }

  // 6. A pass is currently running, OR progress is still within the
  // threshold — either one alone is positive evidence of health: an ACTIVE
  // pass justifies arbitrarily stale progress (a long legitimate round may
  // stamp only once, at its own start), and fresh progress justifies an
  // unprobeable or absent pass child (the stamp itself is newer evidence
  // than the process-table snapshot). The reason names BOTH facts rather
  // than a blanket "recent activity" — a live pass with hours-stale progress
  // reaching this branch is a real, intended case (a long round with one
  // early stamp), and a reason that implied recent activity there would be
  // false (an earlier change M3(a)): a pass running honestly reports
  // running, whatever `progressAgeMs` says.
  if (input.lockState === "live" && input.progressAgeMs !== null) {
    const stale = input.progressAgeMs > input.stallThresholdMs;
    if (input.passChild === true || !stale) {
      const passNote =
        input.passChild === true
          ? "a pass is currently running"
          : input.passChild === false
            ? "no pass is currently running"
            : "whether a pass is running could not be determined";
      return {
        verdict: "HEALTHY",
        reason: `${passNote}; last progress ${Math.round(input.progressAgeMs / 60000)} minute(s) ago`,
        recovery: null,
      };
    }
    // Stale progress with an UNPROBEABLE pass-child answer: neither
    // WEDGED's nor HEALTHY's condition is positively established. Falls
    // through.
  }

  // 7. The default. Every case this function did not name explicitly above
  // — including a live lock with `progressAgeMs === null` (never stamped),
  // a live lock with stale progress but an unprobeable `passChild`, and the
  // DEFERRED "could not inspect the worktree" answer from branch 2 (used
  // here, rather than at branch 2 itself, only once quotaPark and
  // parkedCount have both had their chance to claim the row instead) —
  // lands here, deliberately: see the module header's "never default to
  // HEALTHY" note.
  if (uninspectableLeftoversReason !== null) {
    return {
      verdict: "UNKNOWN",
      reason: uninspectableLeftoversReason,
      recovery: null,
    };
  }
  return {
    verdict: "UNKNOWN",
    reason:
      input.lockState === "live" && input.progressAgeMs === null
        ? "a live driver has never recorded a progress stamp (armed before an earlier change, or died before its first one)"
        : "insufficient evidence to classify this drive",
    recovery: null,
  };
}
