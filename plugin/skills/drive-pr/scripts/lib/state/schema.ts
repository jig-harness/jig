/**
 * The drive-state document: its shape, its validator, and its fresh default.
 *
 * ABSENT and MALFORMED are different answers, and collapsing them is a
 * fail-open. A drive with no state file has nothing to lose, so a fresh empty
 * object is correct. A file that EXISTS but does not parse is the opposite
 * case: it is the only record of the parked human decisions, the durable round
 * budget and the verified SHA, and substituting fresh state there silently
 * grants a new round budget and re-arms work a human deliberately parked —
 * precisely the re-arm loop drive-state exists to close, reached by the one
 * path where the evidence that it is happening has just been discarded.
 * `store.ts` owns that refusal; this module owns the predicate it refuses on.
 *
 * The check is the SHAPE, not merely the syntax. `{}` is valid JSON, and under
 * a syntax-only predicate it read as usable state: `.rounds` emitted `null`,
 * drive.ts coerced that to zero, and a resumed drive was handed a fresh round
 * budget with its parked decisions silently gone — the exact outcome the
 * reader exists to refuse, reached by a file that parses. The PR identity is
 * checked too, so a file copied or mis-named cannot lend one PR's budget to
 * another.
 *
 * The shape check reaches INSIDE `parked`, not just to the container. Checking
 * only that it is an array stops one level short of the thing the array is
 * for: `{"parked":[{}]}` passed, `parked-keys` then emitted `null` for that
 * entry, drive-status matched no thread or fingerprint against it, and the
 * drive re-armed work a human had parked — the re-arm loop the parked set
 * exists to close, reached through the validator that exists to protect it.
 * Every field a consumer reads is required: `key` (the match token), `kind`,
 * `reason` and `round` (rendered into the handoff table). The predicate is
 * deliberately the same one `park` enforces at the write side — non-empty key
 * with no CR or LF in it, one of the two kinds, non-empty reason — so the
 * validator restates the writer's invariant rather than inventing a second,
 * weaker one for it to drift from. The newline ban is load-bearing on BOTH
 * sides: `parked-keys` is a line-delimited channel, so a key containing one is
 * read back as two match tokens, and the phantom second token suppresses live
 * work nobody parked.
 */

import { isGitSha } from "../cli.ts";
import { isActorId } from "./actor.ts";
import { type DrivenBranch, isOptionalDrivenBranch } from "./driven-branch.ts";
import { isAccountHash } from "../identity.ts";
import { type TakeoverRecord, isOptionalTakeovers } from "./takeover.ts";

/**
 * The persisted shape of a recorded quota park — what
 * `detectQuotaBlock`/`planFor` (`lib/quota/`) decided, frozen at the instant
 * `drive-state.ts quota-park` was called, so a later reader (`--doctor`) does
 * not have to re-derive it from vendor-specific evidence that may no longer
 * be on disk by the time anyone looks.
 *
 * `vendor` and `window` are stored as plain `string`, not the richer
 * `QuotaBlock`/`QuotaWindow` types `lib/quota/types.ts` defines — this module
 * intentionally does not import from `lib/quota/`, the same layering
 * `lib/quota/index.ts`'s own header describes ("holds no vendor knowledge and
 * no policy arithmetic"): the STATE schema should not need to change every
 * time a new vendor adapter or window classification is added, and nothing
 * here branches on which one it got.
 */
export interface QuotaParkRecord {
  vendor: string;
  window: string;
  /**
   * When the window reopens, or `null` — the same nullability
   * `QuotaBlock.resetAt` carries, and for the same reason: the adapter can
   * genuinely fail to resolve one and must say so rather than invent it.
   */
  resetAt: string | null;
  /** When THIS park was recorded — not when the wall was first observed. */
  at: string;
  /** The billing account the wall belongs to, hashed (`accountHash`); absent when unknown. */
  account?: string;
}

export interface ParkedItem {
  key: string;
  kind: "thread" | "finding";
  reason: string;
  round: number;
  /** When it was parked; an answer must be later. Absent on an older park. */
  at?: string;
}

/**
 * Which files this PR's reviewer findings anchored to, in one round — the
 * durable evidence `structuralEscalationDue` is derived from.
 *
 * A ROUND-KEYED RECORD rather than a running set, because the question the
 * signal asks is about CONSECUTIVENESS ("the same file two rounds running"),
 * which a flattened set cannot answer: a file found in rounds 1 and 7 with
 * five clean rounds between them is a different fact from a file found in
 * rounds 6 and 7, and only the second is evidence that the last round's own
 * fix drew the next finding.
 *
 * `paths` is a SET, stored sorted and de-duplicated — three findings on one
 * file in one round is one file, not three, and the comparison the predicate
 * makes is set intersection.
 */
export interface RoundPaths {
  round: number;
  paths: string[];
}

export interface HeldItem {
  key: string;
  kind: "thread" | "finding";
  outcome: "accepted" | "moot";
  round: number;
  /**
   * The qualifying comment's own permalink — REQUIRED for `kind: 'thread'` on
   * every writer (`hold`, `restore-held`), absent for `kind: 'finding'`, which
   * has no single GitHub comment to point at. It is what tells "the SAME reply
   * this hold already represents" from "a newer comment that happens to share
   * the outcome word", so a superseding reply cannot inherit an existing
   * hold's round-currency.
   */
  commentUrl?: string;
  reason?: string;
  /**
   * WHICH driver created this hold — `lib/state/actor.ts`'s worktree-derived
   * id, recorded by every writer (`hold`, `restore-held`) for both kinds.
   *
   * The state file is shared by every driver working one PR (`store.ts` keys
   * it per clone, by default under `~/.local/state/jig/drive-pr/<cloneKey>/`,
   * on purpose), so without this the batch is one anonymous list and nothing
   * can tell driver A's holds from driver B's.
   * `stamp-held` vouches for "a push landed", and with no actor on the record
   * it would vouch for EVERY held item, including ones whose promised fix that
   * push never contained.
   */
  actor: string;
  /**
   * The pushed SHA that carries THIS hold's promised fix — absent until the
   * holding actor's own `stamp-held` stamps it, which is the point.
   *
   * Optional in the type because a fresh hold legitimately has none: it is
   * created at reply time (SKILL.md § 3), before any push exists. `hold`
   * constructs a new record, so re-holding a key CLEARS a previous stamp —
   * which is what makes the ordering hold → push → resolve structural rather
   * than incidental. `claim-held --kind thread` reads this field, NOT the
   * PR-global `DriveState.verifiedSha`, so a concurrent driver's unrelated push
   * can no longer vouch for a fix it never contained.
   */
  verifiedSha?: string;
}

/**
 * Durable ownership/evidence for the repository's temporary CI hold label
 * (`ci.hold_label`).
 *
 * A labelled event id is the compare-and-set token: the driver may remove the
 * label only while that event is still the newest transition of the label.
 * Once removed, the unlabeled event's server timestamp becomes the lower bound
 * for the required check-runs, which proves the full-CI rerun belongs to that
 * removal rather than to an earlier, skipped synchronize run.
 */
/** The hold label of every drive written before `ci.hold_label` existed. */
export const LEGACY_CI_HOLD_LABEL = "ci:hold";

export type CiHoldState =
  | {
      phase: "acquiring";
      previousEventId: string | null;
      /**
       * The label this acquisition adds. A first acquisition names no
       * transition yet, so this is what ties it to the configured label.
       * Absent only in a record written before the label was configurable,
       * when it was always `LEGACY_CI_HOLD_LABEL`.
       */
      label?: string;
      head: string;
      actor: string;
      createdAt: string;
      /** Highest check-run id observed before adding ci:hold. */
      checkRunWatermark: number;
    }
  | {
      phase: "held";
      eventId: string;
      addedAtHead: string;
      actor: string;
      createdAt: string;
      /** Highest check-run id observed before adding ci:hold. */
      checkRunWatermark: number;
    }
  | {
      phase: "releasing";
      heldEventId: string;
      addedAtHead: string;
      heldActor: string;
      heldCreatedAt: string;
      head: string;
      actor: string;
      createdAt: string;
      checkRunWatermark: number;
    }
  | {
      phase: "released";
      eventId: string;
      head: string;
      actor: string;
      createdAt: string;
      /** Highest check-run id observed immediately before removing ci:hold. */
      checkRunWatermark: number;
      source: "drive" | "external";
    };

/**
 * The persisted shape. EVERY field `freshState` emits is required — there is no
 * optional-and-defaulted tier.
 *
 * Four of these once carried `?`, with the validator and every consumer reading
 * them through `?? 0` / `?? []`, so a state file written before the field
 * existed and one written after were both accepted by one parser. That is the
 * accepts-both-shapes tolerance this state format deliberately does not carry
 * before general availability, and it was reported as such on the two newest of
 * them — but the shape, not the pair, is the defect: `attempts`, `attemptsHead`
 * and `held` were the identical construct and would have kept the dual-shape
 * path alive on their own.
 *
 * An older file is now rejected by `isUsableState`, which surfaces as the
 * explicit refusal in `store.read()` — never truncated, never silently
 * migrated. Recovering one is a deliberate `drive-state.ts reset`.
 */
export interface DriveState {
  pr: number;
  rounds: number;
  lastCountedHead: string;
  attempts: number;
  attemptsHead: string;
  lastReflectedRound: number;
  lastReflectedAttempts: number;
  /**
   * The last SHA any driver green-verified for this PR — a PR-global "how far
   * have the gates got" pointer, which is the right shape for its remaining
   * consumers (`round-plan.ts`'s Testbox decay, the handoff header).
   *
   * It is NOT push provenance and no longer used as such. It was, and a
   * PR-global pointer cannot be: driver B's `set-verified` moved it, and driver
   * A's held thread then read it as vouching for A's own unpushed fix.
   * `HeldItem.verifiedSha` is the per-hold answer; this field
   * answers a different question: `stamp-held` writes the per-item value,
   * while final-CI-only `set-verified` writes this PR-global value.
   */
  verifiedSha: string;
  phase: string;
  /**
   * The round at which this drive marked the PR Ready for review, or `0` for
   * never. A POSITION rather than a boolean only because it is worth reading in
   * a handoff; every consumer treats it as "non-zero means done".
   *
   * ONCE per PR, durably, and that is the whole point of persisting it rather
   * than re-deriving it from `isDraft` — the once-only property matters
   * because: a human who converts the PR back to draft has made a deliberate
   * decision, and a drive that re-derived the answer from the live flag would
   * undo it on the next round and keep undoing it — the re-arm shape, aimed at a
   * human this time. And `gh pr ready` is an outward-facing event: it fires
   * `ready_for_review`, which is what summons the reviewers that skip drafts, so
   * re-firing it re-triggers paid external review of a head that already had it.
   *
   * Written through `claim-ready-mark`, which is a compare-and-set precisely so
   * two drivers on one PR (different worktrees — the clone-wide PR lock is what
   * they contend for) cannot both decide they are the one to mark it.
   */
  readyMarkedRound: number;
  ciHold: CiHoldState | null;
  parked: ParkedItem[];
  held: HeldItem[];
  /**
   * ISO-8601 instant of the last GENUINE progress event, or `''` for never —
   * `touchLock`'s heartbeat timer proves the driver PROCESS is
   * alive; it says nothing about whether the drive is making PROGRESS. Six
   * drivers were observed live at once with two silently stale locks nobody
   * had reported — every one of them heartbeated
   * identically, whether it was mid-round or wedged on a head-sync wait that
   * would never resolve. This field is the second signal `--doctor` needs to
   * tell those apart.
   *
   * Written ONLY through {@link withProgress}, from a closed, named set of
   * call sites (a round advancing, a push landing, a held batch draining, a
   * pass being spawned, global CI verification landing) — never from
   * `store.update` generally. Folding the
   * stamp into every mutation would make `bump-attempt`'s own `--no-count`
   * re-read, or a future migration, read as "progress" when neither moved the
   * drive forward at all; the whole value of this field is that its absence
   * of movement means something.
   *
   * REQUIRED, not `?? ''`-defaulted — the same "no optional-and-defaulted
   * tier" stance this interface already takes for `lastEscalatedRound` and
   * `lastEscalatedInvariant` (see their own comments), for the identical
   * reason: a state file written before this field existed has no opinion on
   * whether the drive it describes ever progressed, and defaulting that
   * silence to `''` ("never") would be indistinguishable from a REAL "never"
   * on a drive that is in fact healthy — exactly the false reading a
   * `--doctor` sweep exists to prevent. `isUsableState` refuses such a file
   * outright; `drive-state.ts reset` is the deliberate recovery, same as
   * every other field in this class.
   */
  lastProgressAt: string;
  /**
   * The quota wall this drive parked on, or `null`. Recorded by
   * `drive-state.ts quota-park`, called from `drive.ts` immediately before
   * its `QUOTA_PARKED_EXIT` return (§1c): the process is about to exit, its
   * claim will stop refreshing and eventually read `stale`, and without this
   * record a later `--doctor` sweep sees only "no live driver" and cannot
   * tell a drive that parked ON PURPOSE from one that simply died — the exact
   * distinction `DoctorVerdict.QUOTA_PARKED` exists to draw (`lib/doctor.ts`).
   *
   * Deliberately NOT stamped by {@link withProgress} — parking is the
   * opposite of progress, so the two fields are cleared/set by disjoint
   * writers. Cleared to `null` the moment ANY genuine progress event fires
   * next (`withProgress`'s own contract): a drive that parked, was resumed by
   * a human or the next scheduled re-arm, and then advanced a round has
   * already answered the question this field exists to ask, and leaving a
   * stale park on the record would misreport a currently-healthy drive as
   * still sitting on a wall it left rounds ago.
   *
   * REQUIRED, same stance as `lastProgressAt` immediately above and for the
   * same reason: an absent park and a park that was never recorded are only
   * the same thing if the field cannot have existed at all, which is exactly
   * what refusing an older file (rather than defaulting) preserves.
   *
   * Best-effort and PR-global, so two residuals are accepted: a lost progress
   * stamp leaves a stale park (`--doctor` reads `QUOTA_PARKED` one sweep
   * longer, never a false `HEALTHY`), and any driver's progress clears it,
   * which is what a re-arm from another account relies on.
   */
  quotaPark: QuotaParkRecord | null;
  /**
   * The round at which a structural escalation was last acknowledged — the
   * `lastReflectedRound` of `structuralEscalationDue`, and a POSITION for the
   * same reason: the duty has to be able to RE-ARM. A boolean discharged once
   * would silence the signal for the rest of the drive, which is the failure
   * mode the whole issue is about (the same file drawing a finding every round
   * while nothing says so).
   */
  lastEscalatedRound: number;
  /**
   * The claim `set-escalated --invariant` recorded at `lastEscalatedRound` —
   * what that round believed it had closed, in one sentence.
   * `''` when the round acknowledged without stating one, which is also the
   * value every acknowledgment starts from: a call with no `--invariant`
   * REPLACES whatever was here, it does not preserve it. Leaving a stale
   * claim in place after a round that didn't restate one would let a much
   * later recurrence echo back a sentence nobody standing behind it this
   * time ever wrote — worse than echoing nothing.
   *
   * `set-reflected` clears this to `''` too, in the same update that advances
   * `lastEscalatedRound` for the reason its own comment gives: a `/reflect`
   * subsumes `set-escalated` but is a step back from the whole class, not a
   * restatement of one file's prior claim — carrying that claim forward past
   * a reflect would attribute the reflect's broader acknowledgment to a
   * narrower sentence it may never have revisited.
   *
   * PR-GLOBAL, not per-file — one string, not a map keyed by path — for the
   * same reason `lastEscalatedRound` itself is PR-global: `structuralEscalationArmed`
   * arms on ANY path shared between two consecutive rounds' whole touched
   * sets, not on one tracked file, so there is no single path to key this
   * claim by even in principle. In the common case this repo's own evidence
   * shows (one file recurring across several rounds), the echoed claim is
   * about the file that just re-armed. But a round can touch several files at
   * once, so a claim recorded for one recurring file CAN be echoed back
   * against an unrelated file's later, unconnected recurrence — the same
   * imprecision `drive-status.ts`'s `work.unresolvedThreadPaths` doc already
   * flags for the boolean signal itself ("does not say which one is the file
   * that recurred"). Treat an echoed claim as "what the last acknowledgment
   * believed it closed," not as a guarantee that it was about the specific
   * file the CURRENT finding anchors to.
   *
   * Read back only through {@link structuralEscalationInvariant}, which
   * echoes it ONLY while {@link structuralEscalationArmed} is true — never
   * surfaced while the duty it was recorded against is discharged.
   */
  lastEscalatedInvariant: string;
  /**
   * Per-round finding anchors, most recent last, bounded to the newest
   * `ROUND_PATHS_WINDOW` entries ONCE THEY ARE ACKNOWLEDGED
   * (`round <= lastEscalatedRound` — see `pruneRoundPaths`). Bounded, when
   * acknowledged, because this file is rewritten under a lock on every state
   * mutation and a 40-round drive on a wide diff would otherwise grow it
   * without limit; the window is far past the two consecutive rounds the
   * predicate reads, so the bound can never change an answer it would
   * otherwise have given FOR AN ACKNOWLEDGED ENTRY.
   *
   * NOT unconditionally bounded: an entry more recent than `lastEscalatedRound`
   * survives past the window regardless, so a drive that never acknowledges a
   * standing escalation can retain more than `ROUND_PATHS_WINDOW` entries
   * indefinitely — accepted, and bounded in practice by the reviewer's own
   * round ceiling instead (`pruneRoundPaths`'s own header).
   */
  roundPaths: RoundPaths[];
  /** The tree the last attach prepared, `null` before one (`driven-branch.ts`). */
  drivenBranch?: DrivenBranch | null;
  /** Every `drive.ts --take-over` of this drive, oldest first (`takeover.ts`). */
  takeovers?: TakeoverRecord[];
  /** The drive ledger's generation this state was last written or seeded at (`ledger.ts`). */
  ledgerGeneration?: number;
  [extra: string]: unknown;
}

/**
 * How many rounds of finding anchors to keep, once every entry outside the
 * window is safely ACKNOWLEDGED (`foldRoundPaths` below). The predicate reads
 * exactly two adjacent entries, so anything ≥2 is behaviourally sufficient;
 * the surplus is for a human reading `drive-state.ts round-paths` (or the
 * state file), who wants the shape of the whole drive rather than only its
 * last two rounds. This is a floor, not a hard cap — see `foldRoundPaths`.
 */
export const ROUND_PATHS_WINDOW = 12;

/** Cap on distinct anchor paths recorded per round. */
export const ROUND_PATHS_MAX_PER_ROUND = 200;

/** Cap on a single recorded path's length. */
export const ROUND_PATH_MAX_LENGTH = 512;

/**
 * Cap on `lastEscalatedInvariant`'s length — generous for "one
 * sentence" while still bounding a state file rewritten under a lock on every
 * mutation. The CLI refuses an over-cap `--invariant` outright rather than
 * silently truncating it: a truncated claim can read as a DIFFERENT, narrower
 * claim than the one actually made, which is worse than asking the caller to
 * shorten it (the same reasoning `record-paths`'s truncation WARNING gives
 * for why silent truncation is unacceptable here — this field has no warning
 * channel, so refusing is the only fail-closed option).
 */
export const ESCALATION_INVARIANT_MAX_LENGTH = 500;

/**
 * Normalize one round's raw anchor paths into the stored form: trimmed,
 * newline-free, non-empty, length-capped, de-duplicated, sorted, count-capped.
 *
 * The newline ban is the same one `parked`/`held` keys carry, though for a
 * weaker reason than theirs: those keys travel on line-delimited channels
 * (`parked-keys`, `held-keys`), where a newline is read back as two tokens and
 * the phantom second one suppresses live work nobody parked. Nothing reads
 * `paths` line-delimited today — `round-paths` emits JSON, and the handoff
 * does not render them at all. It is banned anyway because the ONE consumer
 * that would want a line-delimited channel is the `--stdin` writer that
 * already exists, and a value it could not round-trip has no business being
 * stored by the flag-based one either.
 *
 * Shared by the writer (`record-paths`) and the validator, so a stored value
 * can never be one the writer would not have produced.
 */
export function normalizeRoundPaths(raw: readonly string[]): string[] {
  return normalizeRoundPathsUncapped(raw).slice(0, ROUND_PATHS_MAX_PER_ROUND);
}

/**
 * The same trim/empty/newline/length filtering and de-duplication as
 * `normalizeRoundPaths`, but WITHOUT the `ROUND_PATHS_MAX_PER_ROUND` cap —
 * so a caller that needs to know whether the cap actually dropped anything
 * can compare this length against the capped one, rather than re-deriving
 * the same filtering by hand and risking it drift from the writer's real
 * rule. `record-paths` uses this to warn when a round's real anchor count
 * exceeds what gets stored: sorting then slicing is silent by construction,
 * so without this comparison a truncated round drops real evidence with
 * nothing in state or the report recording that it happened.
 */
export function normalizeRoundPathsUncapped(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const p of raw) {
    // `.trim()` is used ONLY to test for a whitespace-only/oversized entry —
    // the ORIGINAL, untrimmed `p` is what gets stored. Two legitimate,
    // distinct repository paths can differ only by leading or trailing
    // whitespace (`a.ts` vs ` a.ts`); storing the trimmed form would alias
    // them to the same recurrence key, arming `structuralEscalationDue` on
    // findings from two different files — the same identity bug
    // `evaluate.ts`'s `openThreadPaths` had.
    if (p.trim() === "" || p.length > ROUND_PATH_MAX_LENGTH) continue;
    if (/[\n\r]/.test(p)) continue;
    seen.add(p);
  }
  return [...seen].sort();
}

/**
 * Every counter in this state is a NON-NEGATIVE INTEGER — round positions,
 * attempt counts, the ready-mark position. `typeof x === 'number'` was the
 * whole check for all of them, and it is the wrong one in both directions:
 * `-1` and `0.5` are numbers, and neither is a value any writer here can
 * produce, so reading one back means a hand-edited or corrupted file.
 *
 * Tolerating them is not neutral, because the consumers treat these fields as
 * positions and sentinels rather than as arbitrary numbers. A persisted
 * `readyMarkedRound: 0.5` is non-zero, so every consumer reads it as "already
 * marked" and the draft→Ready transition is suppressed forever. Fail closed
 * instead: an unusable state is the store's documented, recoverable refusal
 * (`drive-state.ts reset`). Every counter and every item `round` here is
 * held to it.
 */
function isCount(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** A parked item every reader can match and render (`ParkedItem`). */
function isParkedItem(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const e = p as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    e.key.length > 0 &&
    !/[\n\r]/.test(e.key) &&
    (e.kind === "thread" || e.kind === "finding") &&
    typeof e.reason === "string" &&
    e.reason.length > 0 &&
    isCount(e.round) &&
    (e.at === undefined ||
      (typeof e.at === "string" && Number.isFinite(Date.parse(e.at))))
  );
}

/**
 * A recorded quota park (`QuotaParkRecord`). `vendor`/`window` are
 * newline-free for the same reason every other free-text field here is: the
 * record round-trips through `console.error` lines in `drive.ts`, and a
 * hand-edited value containing one could make a single park read, on a
 * terminal, as two.
 */
function isQuotaParkRecord(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const park = v as Record<string, unknown>;
  const text = (f: unknown) =>
    typeof f === "string" && f.length > 0 && !/[\n\r]/.test(f);
  const instant = (f: unknown) =>
    typeof f === "string" && Number.isFinite(Date.parse(f));
  return (
    text(park.vendor) &&
    text(park.window) &&
    (park.resetAt === null || instant(park.resetAt)) &&
    instant(park.at) &&
    (park.account === undefined || isAccountHash(park.account))
  );
}

/** The fields a state written before they existed may lack, each well-formed when present. */
function optionalFieldsUsable(s: Record<string, unknown>): boolean {
  return (
    isOptionalDrivenBranch(s.drivenBranch) &&
    isOptionalTakeovers(s.takeovers) &&
    (s.ledgerGeneration === undefined || isCount(s.ledgerGeneration))
  );
}

export function isUsableState(v: unknown, pr: number): v is DriveState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.pr !== "number" || s.pr !== pr) return false;
  if (!isCount(s.rounds)) return false;
  if (typeof s.lastCountedHead !== "string") return false;
  if (typeof s.verifiedSha !== "string") return false;
  if (typeof s.phase !== "string") return false;
  if (!optionalFieldsUsable(s)) return false;
  if (!Array.isArray(s.parked)) return false;
  if (!(s.parked as unknown[]).every(isParkedItem)) return false;
  // Present AND well-typed, not "well-typed if present" — see `DriveState`.
  if (!isCount(s.attempts)) return false;
  if (typeof s.attemptsHead !== "string") return false;
  if (!isCount(s.lastReflectedRound)) return false;
  if (!isCount(s.lastReflectedAttempts)) return false;
  if (!isCount(s.readyMarkedRound)) return false;
  if (s.ciHold !== null) {
    if (typeof s.ciHold !== "object" || Array.isArray(s.ciHold)) return false;
    const hold = s.ciHold as Record<string, unknown>;
    if (
      hold.phase !== "acquiring" &&
      hold.phase !== "held" &&
      hold.phase !== "releasing" &&
      hold.phase !== "released"
    )
      return false;
    if (
      (hold.phase === "held" || hold.phase === "released") &&
      (typeof hold.eventId !== "string" || hold.eventId.length === 0)
    )
      return false;
    if (hold.phase === "acquiring") {
      if (
        hold.previousEventId !== null &&
        (typeof hold.previousEventId !== "string" ||
          hold.previousEventId.length === 0)
      )
        return false;
      if (typeof hold.head !== "string" || !isGitSha(hold.head)) return false;
      if (
        hold.label !== undefined &&
        (typeof hold.label !== "string" || hold.label.length === 0)
      )
        return false;
    }
    if (hold.phase === "held") {
      if (typeof hold.addedAtHead !== "string" || !isGitSha(hold.addedAtHead))
        return false;
    } else if (
      hold.phase !== "acquiring" &&
      (typeof hold.head !== "string" || !isGitSha(hold.head))
    ) {
      return false;
    }
    if (
      (hold.phase === "acquiring" ||
        hold.phase === "held" ||
        hold.phase === "released" ||
        hold.phase === "releasing") &&
      (typeof hold.checkRunWatermark !== "number" ||
        !Number.isSafeInteger(hold.checkRunWatermark) ||
        hold.checkRunWatermark < 0)
    )
      return false;
    if (
      hold.phase === "released" &&
      hold.source !== "drive" &&
      hold.source !== "external"
    )
      return false;
    if (
      hold.phase === "released" &&
      hold.source === "drive" &&
      hold.checkRunWatermark === 0
    )
      return false;
    if (hold.phase === "releasing") {
      if (
        typeof hold.heldEventId !== "string" ||
        hold.heldEventId.length === 0 ||
        typeof hold.addedAtHead !== "string" ||
        !isGitSha(hold.addedAtHead) ||
        typeof hold.heldActor !== "string" ||
        hold.heldActor.length === 0 ||
        /\r|\n/.test(hold.heldActor) ||
        typeof hold.heldCreatedAt !== "string" ||
        !Number.isFinite(Date.parse(hold.heldCreatedAt))
      )
        return false;
    }
    if (typeof hold.actor !== "string" || hold.actor.length === 0) return false;
    if (/\r|\n/.test(hold.actor)) return false;
    if (
      typeof hold.createdAt !== "string" ||
      !Number.isFinite(Date.parse(hold.createdAt))
    )
      return false;
  }
  // Present AND well-typed, on the same terms as every other counter here —
  // backward compatibility before general availability is deliberately not
  // offered, so a state file written before this field existed is REFUSED by
  // `store.read` rather than silently migrated to a zeroed baseline. A
  // tolerated-absent `lastEscalatedRound` would read as "never acknowledged",
  // which re-arms a duty a human already discharged — the same re-arm shape
  // the rest of this validator exists to refuse.
  //
  // Also bounded by `s.rounds`, the same bound every `roundPaths[].round`
  // below is held to: both acknowledging writers (`set-reflected`,
  // `set-escalated`) assign `lastEscalatedRound = s.rounds`, so a value
  // beyond it is not writer-producible. Left unchecked, a hand-edited or
  // corrupted `{rounds: 2, lastEscalatedRound: 999}` would silence
  // `structuralEscalationArmed` for every pair ending at round 999 or
  // earlier — effectively forever — since its `since` gate is read straight
  // from this field.
  if (
    !isCount(s.lastEscalatedRound) ||
    (s.lastEscalatedRound as number) > (s.rounds as number)
  )
    return false;
  // Same REQUIRED-not-optional stance as `lastEscalatedRound` above, added in
  // the same PR that added the field: a state file written before
  // it existed is refused rather than tolerated with a `?? ''` default,
  // consistent with this interface's own "no optional-and-defaulted tier"
  // rule. Length-capped and newline-free against the writer's own refusal
  // (`ESCALATION_INVARIANT_MAX_LENGTH`, `set-escalated`'s own newline check),
  // so a hand-edited file cannot carry a value `set-escalated` itself would
  // never have accepted.
  if (
    typeof s.lastEscalatedInvariant !== "string" ||
    s.lastEscalatedInvariant.length > ESCALATION_INVARIANT_MAX_LENGTH ||
    /[\n\r]/.test(s.lastEscalatedInvariant)
  )
    return false;
  // REQUIRED-not-optional, same stance as every field above — see
  // `lastProgressAt`'s own comment on `DriveState` for why defaulting a
  // missing value to `''` would be indistinguishable from a genuine "never
  // progressed". `''` (never) is the only string this validator accepts
  // without also being a parsable instant, because `withProgress` and
  // `freshState` are the only two producers and neither ever writes a
  // different unparsable string.
  if (
    typeof s.lastProgressAt !== "string" ||
    (s.lastProgressAt !== "" && !Number.isFinite(Date.parse(s.lastProgressAt)))
  )
    return false;
  if (s.quotaPark !== null && !isQuotaParkRecord(s.quotaPark)) return false;
  if (!Array.isArray(s.roundPaths)) return false;
  // Collection-level invariants, restating `foldRoundPaths`'s own writer
  // contract rather than a weaker one the validator could drift from — the
  // same reason the per-entry `paths` check below re-derives its expectation
  // from `normalizeRoundPaths`. `foldRoundPaths` never produces a round
  // beyond the state's own `rounds`, and never two entries for one round —
  // it replaces, sorted ascending. A hand-edited file violating either of
  // those changes what `structuralEscalationArmed`'s adjacency check is even
  // looking at: duplicate or descending rounds can make two SNAPSHOTS of one
  // round look like consecutive ones, and a future round beyond `s.rounds`
  // can pre-arm a recurrence nothing has measured yet.
  //
  // The length itself is NOT capped at `ROUND_PATHS_WINDOW` outright:
  // `foldRoundPaths` only evicts an entry outside the window once it is
  // acknowledged (`round <= lastEscalatedRound`) — an unacknowledged entry
  // beyond the window is exactly what keeps `structuralEscalationArmed` honest
  // past round `ROUND_PATHS_WINDOW`. So the per-entry check below restates THAT
  // invariant instead: an entry outside the window is refused only when it
  // could no longer have a legitimate reason to survive.
  const roundPathsArr = s.roundPaths as unknown[];
  const windowCut = roundPathsArr.length - ROUND_PATHS_WINDOW;
  const lastEscalatedRound = s.lastEscalatedRound as number;
  let lastRound = -1;
  for (let i = 0; i < roundPathsArr.length; i++) {
    const rp = roundPathsArr[i];
    if (typeof rp !== "object" || rp === null || Array.isArray(rp))
      return false;
    const e = rp as Record<string, unknown>;
    if (!isCount(e.round)) return false;
    const round = e.round as number;
    // Round 0 is not a counted round (`freshState`'s own baseline, before
    // `bump-round`/`bump-attempt` ever runs) and `record-paths` now refuses
    // to write one — so an entry naming it can only be a hand-edited or
    // pre-guard file, and admitting it would let round 1's real entry look
    // adjacent to a round that measured nothing.
    if (round < 1) return false;
    if (round > (s.rounds as number)) return false;
    if (round <= lastRound) return false;
    lastRound = round;
    if (i < windowCut && round <= lastEscalatedRound) return false;
    if (!Array.isArray(e.paths)) return false;
    for (const p of e.paths as unknown[]) {
      if (typeof p !== "string") return false;
    }
    // The validator restates the WRITER's invariant rather than a weaker one
    // it could drift from — the same rule `parked` follows. Comparing against
    // `normalizeRoundPaths` output is the strongest available form of that:
    // sorted, de-duplicated, newline-free, capped. A hand-edited file carrying
    // an unsorted or duplicated list is refused, because the predicate's set
    // intersection is only as trustworthy as the sets it reads.
    const norm = normalizeRoundPaths(e.paths as string[]);
    if (norm.length !== (e.paths as string[]).length) return false;
    for (let i = 0; i < norm.length; i++) {
      if (norm[i] !== (e.paths as string[])[i]) return false;
    }
  }
  if (!Array.isArray(s.held)) return false;
  for (const h of s.held as unknown[]) {
    if (typeof h !== "object" || h === null) return false;
    const e = h as Record<string, unknown>;
    if (typeof e.key !== "string" || e.key.length === 0) return false;
    // Same newline ban as `parked` above: `held-keys` is line-delimited, so a
    // key carrying one reads back as two tokens and the phantom second releases
    // an item nobody held.
    if (/[\n\r]/.test(e.key)) return false;
    if (e.kind !== "thread" && e.kind !== "finding") return false;
    if (e.outcome !== "accepted" && e.outcome !== "moot") return false;
    // An INTEGER, but not a `isCount` one: `hold --unconfirmed` deliberately
    // writes `round: -1`, a position `claim-held` can never match, so a
    // reply found already posted stays unresolved until a live pass re-holds
    // it for real. -1 is therefore a legal, writer-produced value
    // here where it is nowhere else — the integer half of the check still
    // holds, since a fractional round matches no round and would strand the
    // item exactly as -1 deliberately does, but without saying so.
    if (typeof e.round !== "number" || !Number.isInteger(e.round)) return false;
    if (e.round < -1) return false;
    // A thread hold with no `commentUrl` is provenance-free, and the writers
    // refuse to create one — so reading one back means either a hand-edited
    // file or a writer that skipped the requirement. Either way the
    // supersession comparison it exists to feed cannot be made, so the
    // validator restates the writer's invariant rather than tolerating a
    // record no consumer can use.
    if (e.kind === "thread") {
      if (typeof e.commentUrl !== "string" || e.commentUrl.length === 0)
        return false;
    }
    if (e.kind === "finding") {
      if (typeof e.reason !== "string" || e.reason.length === 0) return false;
    }
    // Required on BOTH kinds, and for the same reason `commentUrl` is required
    // on a thread: a record that cannot be attributed to a driver is one
    // `stamp-held` has no basis to vouch for or to skip, so it would have to
    // fall back to vouching for everything — the PR-global behaviour `actor`
    // exists to prevent. Both writers stamp it, so reading one back without it
    // means a hand-edited file, and the validator restates the writer's
    // invariant rather than tolerating a record no consumer can use.
    //
    // The EXACT grammar `resolveActor()` produces (`wt-` + 16 lowercase hex),
    // not merely "non-empty, no newline". `restore-held` already enforces this
    // at the write side (its own comment explains why: a hand-edited value
    // like `"x|forged"` both names a DIFFERENT worktree — letting that tree's
    // `stamp-held` wrongly vouch for this hold — and breaks the handoff's
    // backtick-delimited table row, which a bare newline ban never caught).
    // Backward compatibility before general availability is deliberately not
    // offered, so a wider stored shape is refused rather than tolerated.
    if (typeof e.actor !== "string" || !isActorId(e.actor)) return false;
    // Optional (absent until the holding actor pushes), but when present must
    // be the exact grammar `stamp-held`/`restore-held` write — a full
    // 40-character lowercase hex SHA-1 — for the same reason: `''` would
    // compare equal to an empty SHA argument the CLI already refuses, and a
    // wider shape (short SHA, stray punctuation, a backtick/pipe that breaks
    // the handoff's table row) is a hand-edited file the validator must not
    // tolerate.
    if (e.verifiedSha !== undefined) {
      if (typeof e.verifiedSha !== "string" || !isGitSha(e.verifiedSha))
        return false;
    }
  }
  return true;
}

export function freshState(pr: number): DriveState {
  return {
    pr,
    rounds: 0,
    lastCountedHead: "",
    attempts: 0,
    attemptsHead: "",
    lastReflectedRound: 0,
    lastReflectedAttempts: 0,
    verifiedSha: "",
    phase: "",
    readyMarkedRound: 0,
    ciHold: null,
    parked: [],
    held: [],
    lastEscalatedRound: 0,
    lastEscalatedInvariant: "",
    roundPaths: [],
    lastProgressAt: "",
    quotaPark: null,
    drivenBranch: null,
  };
}

/**
 * Stamp a GENUINE progress event — a load-bearing design decision.
 *
 * This is the ONLY function that may set `lastProgressAt`, and every writer
 * that records progress goes through it rather than folding the stamp into
 * its own `store.update` inline. That is deliberate, not stylistic: a
 * PROGRESS field with no gate on who may move it degrades to exactly the
 * heartbeat `lastProgressAt` exists to be distinguished from — `store.update`
 * runs on `bump-attempt`'s own `--no-count` re-read and on every future
 * migration, none of which is evidence the drive moved forward. Routing every
 * writer through one named function makes "which events count as progress" a
 * single, auditable list (this file's own `DriveState.lastProgressAt` comment
 * enumerates it) instead of a property every future `store.update` caller
 * has to remember to preserve or deliberately opt out of.
 *
 * `now` is INJECTED, not read (`new Date` inline) — not because an
 * injected-clock rule binds this file (these are one-shot CLI entrypoints,
 * which such a rule would exclude), but because an injected instant is what
 * lets a test pin the exact stamp and assert `lastProgressAt ===
 * now.toISOString` rather than parsing back whatever the wall clock produced —
 * the identical reasoning `lib/quota/index.ts`'s `planFor(block, now)` already
 * gives for its own `now` parameter.
 *
 * `phase` is set only when non-empty, so a caller that has nothing new to say
 * about the phase (a bare progress stamp) does not blow away whatever the
 * last named phase was — mirroring how `set-escalated`'s own `--invariant`
 * only overwrites when given, never on an empty default that would silently
 * erase a prior value with something the caller never actually said.
 *
 * `quotaPark` is unconditionally cleared to `null`: progress is definitionally
 * the opposite of a park sitting unresolved. A drive that parked, was
 * resumed, and has now advanced a round has already answered "is this drive
 * still stuck on that wall" — leaving the park on the record here would
 * misreport a currently-healthy drive as still parked.
 *
 * `phase` itself stays a plain `string`, not this literal union, so an
 * internal call site naming one of these five values is unchanged — the
 * union exists for the one BOUNDARY that accepts a caller-supplied string,
 * `drive-state.ts progress`'s `--phase` flag, to validate against (see that
 * verb). Widening `phase` itself to the union would force every internal
 * call site to import it for no benefit they do not already have from
 * passing one of these literals directly.
 */
export const PROGRESS_PHASES = [
  "round-advanced",
  "push-landed",
  "ci-verified",
  "held-drained",
  "pass-spawned",
] as const;

export function withProgress(
  s: DriveState,
  phase: string,
  now: Date,
): DriveState {
  return {
    ...s,
    lastProgressAt: now.toISOString(),
    phase: phase === "" ? s.phase : phase,
    quotaPark: null,
  };
}

/**
 * An INPUT contract, the same shape and for the same reason as
 * `ReflectCounters`: a caller legitimately holds a partial set (drive-status
 * reads it back out of `drive-state.ts get`'s stdout), and tolerating absence
 * at a FUNCTION boundary is not the accepts-both-stored-shapes tolerance
 * `DriveState` documents rejecting. Nothing here decides whether a state FILE
 * is usable.
 */
export interface EscalationState {
  roundPaths?: RoundPaths[];
  lastEscalatedRound?: number;
  lastEscalatedInvariant?: string;
}

/**
 * Is a structural escalation owed — has a reviewer finding landed on the same
 * file in two CONSECUTIVE rounds since the last acknowledgment?
 *
 * Deliberately SHARPER than `reflectDue`'s round-depth trigger, and the
 * sharpness is the point. `reflectDue` fires on depth — "this drive has run
 * long" — which was measured arriving at round 4 when the signal had been
 * unambiguous since round 2. This one fires on RECURRENCE, so it arms while
 * there is one narrow fix to reconsider rather than three. The two do not
 * substitute for each other and neither is derived from the other.
 *
 * What it does NOT try to be: a claim that the recurrence is self-inflicted.
 * That question is answered per-finding, against the commits, by
 * `self-inflicted.ts` — a file drawing findings two rounds running is evidence
 * enough to stop and ask, whoever wrote the line.
 *
 * ARMED-UNTIL-DISCHARGED, mirroring `reflectDue`: once a qualifying pair
 * exists it keeps answering true until `set-escalated` (or a `/reflect`, which
 * subsumes it) stamps a round past it. A signal that un-armed itself on the
 * next round would be silent exactly when the pattern is worst — the round
 * after the one that should have stopped to generalize.
 *
 * The acknowledgment comparison is against the pair's LATER round, strictly:
 * an escalation acknowledged at round 3 is not re-armed by the (2,3) pair it
 * was raised on, but IS re-armed by (3,4), because round 4 is new evidence
 * that the acknowledgment did not settle the class.
 */
export function structuralEscalationArmed(s: EscalationState): boolean {
  const entries = [...(s.roundPaths ?? [])].sort((a, b) => a.round - b.round);
  const since = s.lastEscalatedRound ?? 0;
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.round !== prev.round + 1) continue;
    if (cur.round <= since) continue;
    const prevSet = new Set(prev.paths);
    if (cur.paths.some((p) => prevSet.has(p))) return true;
  }
  return false;
}

/**
 * The claim the last `set-escalated --invariant` recorded, echoed back ONLY
 * while {@link structuralEscalationArmed} is true — never while
 * the duty it was recorded against is discharged, which is what would happen
 * if this read `lastEscalatedInvariant` unconditionally: a drive that is
 * currently clean on every file would surface a sentence about a recurrence
 * that is no longer live, reading as active guidance for a round that owes
 * nothing.
 *
 * `null`, not `''`, both when nothing is armed and when it is armed but the
 * acknowledging round stated no invariant — the same "null is not the
 * positive claim of an empty measurement" convention `drive-status.ts`'s own
 * JSON payload documents for `drift`/`draft`. A consumer branching on this
 * field never needs to distinguish the two `null` causes: either way, there
 * is no prior claim for this round to check its own finding against.
 *
 * PR-GLOBAL, not per-file, for the reason `lastEscalatedInvariant`'s own doc
 * gives — a non-null result is "what the last acknowledgment believed it
 * closed," not a guarantee that it was about the specific file the CURRENT
 * arming's finding anchors to.
 */
export function structuralEscalationInvariant(
  s: EscalationState,
): string | null {
  if (!structuralEscalationArmed(s)) return null;
  const text = s.lastEscalatedInvariant ?? "";
  return text === "" ? null : text;
}

/**
 * Keep the newest `ROUND_PATHS_WINDOW` entries — PLUS any entry more recent
 * than `lastEscalatedRound`, whichever is more. `entries` must already be
 * sorted ascending by round, the shape both callers below maintain.
 *
 * That second clause is not an enlargement of the window for its own sake:
 * without it, a drive that runs past `ROUND_PATHS_WINDOW` rounds while an
 * escalation from its early rounds sits unacknowledged has that evidence
 * evicted out from under `structuralEscalationArmed` — the qualifying pair
 * simply falls off the stored history, and the ARMED-UNTIL-DISCHARGED duty
 * that function documents goes silent with no `set-escalated` or `/reflect`
 * ever having discharged it. An entry at
 * or before `lastEscalatedRound` carries no such risk — `set-escalated`
 * already silenced every pair ending at or before it — so ONLY those are
 * still safe to prune once the window is full; the acknowledgment is what
 * makes eviction sound, not the passage of rounds by itself. A drive that
 * never acknowledges therefore grows `roundPaths` without the window bound —
 * accepted, because the same drive is already bounded by the reviewer's own
 * round ceiling (SKILL.md § "When the reviewer will not answer") long before
 * this could matter in practice.
 *
 * Exported separately from `foldRoundPaths` (not just inlined there) because
 * `drive-state.ts`'s `set-reflected`/`set-escalated` need to re-apply this SAME
 * filter the instant they advance `lastEscalatedRound`, not only on the next
 * `record-paths` call. Advancing the acknowledgment without re-pruning left a
 * state `isUsableState` immediately rejected: a drive retaining more than the
 * window's worth of unacknowledged entries writes `lastEscalatedRound:
 * s.rounds`, and on the very next read `isUsableState`'s own invariant — an
 * entry outside the window with `round <= lastEscalatedRound` is refused — now
 * condemns the entries THIS update just newly acknowledged, because nothing
 * pruned them in the same write. Every acknowledging writer must therefore
 * prune in the same update that advances the acknowledgment, not rely on the
 * next fold.
 */
export function pruneRoundPaths(
  entries: readonly RoundPaths[],
  lastEscalatedRound: number,
): RoundPaths[] {
  const windowCut = entries.length - ROUND_PATHS_WINDOW;
  return entries.filter(
    (e, i) => i >= windowCut || e.round > lastEscalatedRound,
  );
}

/**
 * Fold one round's anchor paths into the stored window: replace the entry for
 * that round if it already exists (a second pass on an unmoved head re-reads
 * the same threads and must not create a second entry for one round), append
 * otherwise, then prune via {@link pruneRoundPaths}.
 *
 * Lives here rather than in the CLI command for the reason
 * `reflectDepthPastLast` does: the writer and the validator have to agree
 * about what a stored entry looks like, and two copies of that would drift.
 */
export function foldRoundPaths(
  existing: readonly RoundPaths[],
  round: number,
  paths: readonly string[],
  lastEscalatedRound = 0,
): RoundPaths[] {
  const entry: RoundPaths = { round, paths: normalizeRoundPaths(paths) };
  const kept = existing.filter((e) => e.round !== round);
  const merged = [...kept, entry].sort((a, b) => a.round - b.round);
  return pruneRoundPaths(merged, lastEscalatedRound);
}

/**
 * How much work has happened since the last recorded `/reflect`, in whichever
 * of the two counters has moved furthest.
 *
 * `rounds` and `attempts` are NOT coordinates on one timeline, which is why
 * this cannot be `max(rounds, attempts) - oneStamp`: `rounds` is cumulative,
 * while `attempts` is per-head and RESETS to 1 whenever the head changes
 * (`drive-state.ts bump-attempt`). A single stamp is therefore wrong in both
 * directions, and both were reported — stamping `.rounds` alone re-armed the
 * duty on the very next attempt after a reflect discharged at attempt depth,
 * and stamping the max suppressed it for the next several genuine rounds after
 * a reflect discharged at round depth.
 *
 * Two baselines, one per counter, and the larger delta wins. Neither counter
 * can mask progress in the other, but that alone was not enough: a stale
 * attempts baseline could still suppress the duty by contributing a delta that
 * is merely SMALLER, leaving the rounds delta — which grows by one per head —
 * as the only live signal, and a reflect recorded at attempt 8 then kept the
 * duty off for the first eleven passes on the next head. The baseline is
 * therefore rebased to zero whenever `bump-attempt` resets the counter for a
 * new head, so both deltas are always measured on an axis that currently
 * exists.
 *
 * The predicate lives HERE rather than in each consumer because `drive.ts`,
 * `drive-status.ts`'s `reflectDue` report field, and this state module all
 * have to agree: three copies of it disagreed with each other before.
 */
/**
 * An INPUT contract, not the persisted shape — which is why these four stay
 * optional while their `DriveState` counterparts are required. `drive.ts` reads
 * the counters one at a time out of `drive-state.ts`'s stdout and assembles
 * them here, so a caller legitimately holds a partial set. Tolerating absence
 * at a function boundary is not the accepts-both-stored-shapes tolerance
 * `DriveState` documents rejecting; nothing here decides whether a state FILE
 * is usable.
 */
export interface ReflectCounters {
  rounds?: number;
  attempts?: number;
  lastReflectedRound?: number;
  lastReflectedAttempts?: number;
}

export function reflectDepthPastLast(s: ReflectCounters): number {
  const depth = Math.max(
    (s.rounds ?? 0) - (s.lastReflectedRound ?? 0),
    (s.attempts ?? 0) - (s.lastReflectedAttempts ?? 0),
  );
  // A state file that PARSES but carries a non-numeric counter (`{"rounds":"x"}`)
  // yields NaN, and every consumer compares with `depth > threshold`, which NaN
  // makes false — the duty would go silently OFF on the one input that cannot
  // be trusted, against the stated fail-open. The
  // guard belongs here rather than in each consumer, for the same reason the
  // predicate does: three copies of this arithmetic disagreed with each other
  // before.
  return Number.isFinite(depth) ? depth : Number.POSITIVE_INFINITY;
}
