#!/usr/bin/env bun
/**
 * Per-PR drive state that survives the driving session.
 *
 * Some state has to outlive a single agent process. The round count, so a
 * bounded loop bounds rounds rather than invocations. And the PARKED set — the
 * threads and summary findings whose disposition now waits on a human. Without
 * somewhere durable to record that, an autonomous loop wakes, re-enumerates the
 * same undeferrable threads, discovers nothing it may act on, and burns turns
 * forever.
 *
 * And the HELD batch — the items replied to with a fix-dependent outcome
 * (`accepted`, `moot`) and deliberately NOT yet resolved, because the fix that
 * answers them has not been pushed (SKILL.md § 3 → § 6). Between those two
 * steps that list used to live only in the agent's context, so a compaction or
 * an interruption in the window dropped it silently and in both directions: a
 * thread replied `**accepted**` but never resolved stays open and gets
 * re-triaged next round as an unfixed finding, or the agent re-replies and puts
 * two outcome tokens on one thread, which corrupts the reviewer-scoring sample
 * the outcome vocabulary exists to feed. Neither shows up as an error.
 *
 * This entry is the CLI dispatcher; the mechanisms live in focused modules —
 * `lib/state/schema.ts` (shape + fail-closed predicate), `lib/state/lock.ts`
 * (the cross-driver mutex), `lib/state/store.ts` (fail-closed read, atomic
 * write, one-lock-hold update), `lib/state/handoff.ts` (the machine half of
 * the handoff file), `lib/state/orphans.ts` (the one-time orphan warning).
 *
 * Usage:
 *   drive-state.ts get          [PR]                 # whole state as JSON
 *   drive-state.ts rounds       [PR]                 # round count
 *   drive-state.ts bump-round   [PR] --head SHA      # count a NEW head as a round
 *   drive-state.ts attempts     [PR]                 # passes made on the current head
 *   drive-state.ts bump-attempt [PR] --head SHA      # count a pass on this head
 *   drive-state.ts verified     [PR]                 # last green-verified SHA ('' if none)
 *   drive-state.ts stamp-held  [PR] --sha SHA        # stamp the pushed SHA onto
 *                                     # the held items THIS
 *                                     # working tree holds — their per-hold push
 *                                     # provenance. Another driver's
 *                                     # holds are left untouched. A held FINDING
 *                                     # with an outstanding claim file (a dispatch
 *                                     # that may already have posted) keeps its
 *                                     # existing stamp instead of advancing to
 *                                     # this push, closing an interrupted-dispatch
 *                                     # duplicate-answer risk without wedging
 *                                     # every other pending hold.
 *   drive-state.ts set-verified [PR] --sha SHA       # record final full-CI proof
 *   drive-state.ts reflected    [PR]                 # round a /reflect was last recorded at
 *   drive-state.ts set-reflected [PR]                # record a completed /reflect at the current round
 *   drive-state.ts park         [PR] --key K --kind thread|finding --reason R
 *   drive-state.ts unpark       [PR] --key K
 *   drive-state.ts parked-keys  [PR]                 # newline-delimited keys
 *   drive-state.ts hold         [PR] --key K --kind thread|finding --outcome accepted|moot
 *                                     [--comment-url URL] [--unconfirmed]
 *                                     (--kind finding also requires the reason body on stdin)
 *                                     --comment-url: REQUIRED for --kind thread (either path) — the
 *                                     qualifying comment's own permalink (from reply-to-thread.ts's
 *                                     printed url, or list-unresolved-threads.ts's .comments[].url).
 *                                     Insert-if-absent/upsert is keyed on it alongside (key, outcome),
 *                                     so a later comment that supersedes the one a hold represents —
 *                                     confirmed or not, same outcome word or not — cannot silently
 *                                     inherit that hold's round-currency.
 *                                     --unconfirmed: insert-if-absent at a round (-1) that can
 *                                     never equal a real one, so claim-held always refuses it
 *                                     until a live pass's own step 3 re-holds it for real, having
 *                                     actually confirmed the promised fix. For reconcile-replied-
 *                                     threads.ts's re-hold of a reply it found already posted, not
 *                                     one it verified — the ordinary (no-flag) upsert grants
 *                                     round-currency unconditionally, which is only sound when the
 *                                     caller just confirmed the fix itself.
 *   drive-state.ts held         [PR]                 # the held batch as JSON
 *   drive-state.ts held-keys    [PR]                 # newline-delimited keys
 *   drive-state.ts claim-held   [PR] --key K --kind thread --pushed-sha SHA
 *                                     # atomic compare-and-delete for a held THREAD:
 *                                     # removes it iff item.round == .rounds AND the
 *                                     # ITEM's own verifiedSha == SHA, in one lock hold:
 *                                     # two concurrent claims on the same key can never
 *                                     # both succeed, and neither reads a round/SHA
 *                                     # pair the other has since changed. Used by
 *                                     # resolve-held-thread.ts.
 *                                     # Exit 1 = a round or verifiedSha mismatch — a
 *                                     # property of THIS item; 3 = state unreadable;
 *                                     # 4 = the key is no longer held at all (already
 *                                     # claimed/resolved elsewhere since the caller's own
 *                                     # batch read — a stale snapshot, not a refusal);
 *                                     # 11 = another live session holds the lease (below).
 *   drive-state.ts claim-held   [PR] --key K --kind finding --pushed-sha SHA
 *                                     # per-key filesystem mutex over a held FINDING,
 *                                     # printing the claim token — plus the same
 *                                     # per-hold provenance check the thread branch
 *                                     # makes. Exit 1 = a live claim elsewhere, or the
 *                                     # SHA is not this hold's own, (or the coordination
 *                                     # lock could not be taken); 3 = state unreadable;
 *                                     # 4 = the key is no longer held;
 *                                     # 11 = another live session holds the lease (below).
 *   drive-state.ts unclaim-held [PR] --key K --token T
 *                                     # give up a FINDING claim without releasing the
 *                                     # item, so a transiently-failed dispatch is
 *                                     # immediately retryable instead of waiting out the
 *                                     # staleness window.
 *   drive-state.ts restore-held [PR] --key K --kind thread --outcome accepted|moot
 *                                     --round R --comment-url URL --actor A
 *                                     --verified-sha SHA
 *                                     # undo a claim-held removal when the mutation it
 *                                     # cleared the way for did not happen — every field
 *                                     # the EXACT value claim-held printed, never "now"
 *                                     # and never re-derived (*                                     #). Fails loudly, never swallowed. thread-only
 *                                     # (a finding's claim never removes the held entry — see
 *                                     # unclaim-held above).
 *   drive-state.ts release-held [PR] --key K [--if-present] [--token T]
 *                                     [--if-comment-url URL] | --all
 *                                     # after the push landed. --if-present: exit 0 instead
 *                                     # of failing loudly when the key isn't held — for a
 *                                     # caller that doesn't know in advance whether a stale
 *                                     # hold exists (a single atomic check-and-release, not
 *                                     # two locked calls). --token is required when the key
 *                                     # carries a live claim; --all refuses while any held
 *                                     # item does. --if-comment-url: only release if the
 *                                     # currently-held commentUrl still equals this value —
 *                                     # a compare-and-delete so a superseding hold created
 *                                     # after the caller last observed this key is never
 *                                     # silently destroyed.
 *   drive-state.ts phase        [PR] --set NAME      # record the current phase
 *   drive-state.ts progress     [PR] --phase NAME    # stamp a GENUINE progress event
 *                                     #: lastProgressAt + phase, clears any
 *                                     # recorded quota park. NOT the same as 'phase'
 *                                     # above — that one carries no progress semantics.
 *   drive-state.ts quota-park   [PR] --vendor V --window W [--reset-at ISO] [--account HASH]
 *                                     # record the quota wall this drive parked on
 *                                     #, called by drive.ts immediately
 *                                     # before its QUOTA_PARKED_EXIT return. Does NOT
 *                                     # stamp progress — parking is its opposite.
 *   drive-state.ts takeover     [PR]                 # record a drive.ts --take-over (JSON on stdin)
 *   drive-state.ts handoff      [PR]                 # (re)write the handoff file, and the ledger under a driver
 *   drive-state.ts seed-ledger  [PR]                 # lay a newer ledger over this state (its body on stdin)
 *   drive-state.ts lease        [PR]                 # who is driving this PR from this
 *                                     # tree, as JSON ('' if nobody)
 *   drive-state.ts lease        [PR] --all           # every LIVE lease on this PR from
 *                                     # ANY working tree, as a JSON array ([] if
 *                                     # nobody), each with its tree, session and a
 *                                     # `self` flag. The only way to detect another
 *                                     # live worktree — a hold's durable `actor`
 *                                     # cannot, since holds outlive their driver
 *                                     #
 *   drive-state.ts admit        [PR]                 # 0 = this tree may act on this PR,
 *                                     # 13 = another working tree is driving it.
 *                                     # No lease taken, nothing mutated — for a
 *                                     # caller whose side effect is on GITHUB and
 *                                     # so is never gated by the session lease
 *                                     # (drive-status.ts's reconciliation sweep)
 *   drive-state.ts clear-lease  [PR]                 # drop that lease — the one command
 *                                     # the lease itself does not gate, because it
 *                                     # is how a human takes over from a session
 *                                     # that is gone
 *   drive-state.ts clear-lease  [PR] --all           # drop EVERY tree's lease on this PR,
 *                                     # live ones included — the deliberate override
 *                                     # for taking a PR back from a tree you cannot
 *                                     # stand in
 *   drive-state.ts reset        [PR]                 # forget everything for this PR
 *                                                    #   (normally exit 13 at admission
 *                                                    #    when another tree's lease is
 *                                                    #    live; exit 9, no change, from
 *                                                    #    its own later sweep — see
 *                                                    #    `reset` for when each fires)
 *
 * Every state-MUTATING command above EXCEPT `clear-lease` takes a session lease
 * over (this working tree, this PR) first, and refuses on any of these
 * conditions:
 *
 *   exit 11 — another live SESSION in THIS working tree holds it. The actor a
 *     hold records is the working TREE, so two agent sessions in one tree
 *     silently overwrite each other's holds and double-reply every thread.
 *   exit 13 — another live WORKING TREE is driving this PR. Same damage,
 *     reached across trees rather than within one: nothing used to stop two
 *     worktrees enumerating the same unresolved threads and each replying with
 *     its own outcome. Derived from the lease files themselves, so
 *     it self-clears exactly as the per-session half does.
 *
 * `clear-lease` is the explicit recovery command for both — gating it behind
 * the lease it removes would make a refusal unrecoverable — so it is excluded
 * by design, not by omission. See `lib/state/lease.ts` for who "a session" is,
 * why the read-only commands take nothing, and why a second worktree keeps
 * every one of them.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  ciHoldTransitions,
  completedRequiredCi,
  parseCheckRuns,
  parsePrSnapshot,
  requirementsWithoutRun,
} from "./lib/ci-hold.ts";
import { type CiPolicy, ciPolicy } from "./lib/ci-policy.ts";
import { ciHoldLabelSetting } from "./lib/overlay.ts";
import {
  ExitError,
  fail,
  isDigits,
  isGitSha,
  readStdinAll,
  runMain,
  sleep,
  testDelaySeconds,
} from "./lib/cli.ts";
import {
  ghCall,
  ghCallTimeoutSeconds,
  KILL_ESCALATE_MS,
  resolvePr,
} from "./lib/proc.ts";
import { isActorId, resolveActor } from "./lib/state/actor.ts";
import { recordTakeover } from "./lib/state/takeover.ts";
import { mirrorLedger, seedLedgerCommand } from "./lib/state/ledger-mirror.ts";
import { quotaPark } from "./lib/state/quota-park.ts";
import {
  breakStaleClaimLocked,
  claimCreate,
  claimFilesFor,
  claimIsLive,
  claimPathFor,
  claimStaleMin,
  claimTokenMatches,
  newClaimToken,
  readyClaimPath,
  removeClaimFile,
  tryBreakStaleClaim,
} from "./lib/state/claims.ts";
import { removeHandoff, renderHandoff } from "./lib/state/handoff.ts";
import {
  acquireIdentifiedTreeGuardNow,
  acquireSessionlessTreeGuardNow,
  assertLeaseUnchanged,
  assertNoForeignDriveNow,
  assertRemoteMutationAllowed,
  claimLease,
  clearAllLeases,
  clearLease,
  type Lease,
  leaseFilesFor,
  leaseHolderLabel,
  leaseLivenessHint,
  leasePathFor,
  leaseStaleMin,
  liveLeasesFor,
  readLease,
  resolveFenceContext,
  unreadableLeaseFilesFor,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs, sweepLockQuarantine } from "./lib/state/lock.ts";
import { orphanMarkerPath } from "./lib/state/orphans.ts";
import {
  type DriveState,
  ESCALATION_INVARIANT_MAX_LENGTH,
  foldRoundPaths,
  normalizeRoundPathsUncapped,
  PROGRESS_PHASES,
  pruneRoundPaths,
  ROUND_PATHS_MAX_PER_ROUND,
  structuralEscalationArmed,
  withProgress,
} from "./lib/state/schema.ts";
import { openStore } from "./lib/state/store.ts";
import {
  attributeStatuses,
  checkRunsFor,
  ciVerdictOf,
  commitStatusesFor,
  hasNonReviewerCi,
} from "./lib/status/evidence.ts";

function usage(): void {
  console.error(`usage: drive-state.ts <command> [PR] [flags]

  get          [PR]                 whole state as JSON
  rounds       [PR]                 round count
  bump-round   [PR] --head SHA      count a NEW head as a round
  attempts     [PR]                 passes made on the current head
  bump-attempt [PR] --head SHA      count a pass on this head
  verified     [PR]                 last green-verified SHA ('' if none)
  stamp-held  [PR] --sha SHA        stamp this pushed SHA onto this working
                                    tree's own held items (no global verify)
  set-verified [PR] --sha SHA       record a globally green-verified SHA;
                                    refuses held, stale, non-open, or pre-unlabel CI
  set-ci-hold [PR] --set held|released --event-id ID --head SHA --check-run-watermark ID
               --actor-name LOGIN --created-at ISO [--check-run-watermark ID]
                                    TEST-ONLY fixture seeding (requires env
                                    DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED=1) — no
                                    production caller; unvalidated evidence
  ready-marked [PR]                 round 'gh pr ready' was CONFIRMED at
                                    (0 = never); see mark-ready.ts
  claim-ready-mark [PR]             take the transition's lease; prints
                                    'claimed <token>' or 'already'
  renew-ready-mark [PR] --token T   prove the lease is still yours and reset
                                    its clock, right before 'gh pr ready'
  commit-ready-mark [PR] --token T  record the CONFIRMED transition and
                                    release the lease
  release-ready-mark [PR] [--token T]
                                    give the lease back recording nothing, so
                                    the next round retries immediately
  reflected    [PR]                 round a /reflect was last recorded at
  set-reflected [PR]                record a completed /reflect at the current round
                                    (also discharges any armed structural
                                    escalation — a /reflect IS the step-back)
  record-paths [PR] [--path P]... | [--stdin]
                                    record THIS round's reviewer-finding anchor
                                    paths (--stdin: newline-delimited on stdin
                                    instead); replaces the entry for the current
                                    round, so a re-read of one head cannot
                                    double-count it. NO --path and no --stdin
                                    records an EMPTY round, which is a real
                                    answer — the reviewer found nothing on any
                                    file — not a no-op
  round-paths  [PR]                 the recorded per-round anchor paths as JSON
  escalation-due [PR]               'true' when a finding anchored to the same
                                    file in two CONSECUTIVE rounds since the
                                    last acknowledgment
  escalated    [PR]                 round a structural escalation was last
                                    acknowledged at (0 = never)
  set-escalated [PR] [--invariant "<one sentence>"]
                                    acknowledge the armed structural escalation
                                    at the current round; --invariant persists
                                    what this round believes it closed, so the
                                    next recurrence on this file can read the
                                    claim back instead of re-deriving it
. Omitting it clears any prior
                                    claim rather than preserving it.
  park         [PR] --key K --kind thread|finding --reason R
  unpark       [PR] --key K
  parked-keys  [PR]                 newline-delimited keys
  hold         [PR] --key K --kind thread|finding --outcome accepted|moot
               [--comment-url URL] [--unconfirmed]
                    (--kind finding also requires the reason body on stdin)
                    (--comment-url: REQUIRED for --kind thread — the qualifying comment's url)
                    (--unconfirmed: insert-if-absent at a round claim-held can never match)
  held         [PR]                 the held batch as JSON
  held-keys    [PR]                 newline-delimited keys
  claim-held   [PR] --key K --kind thread --pushed-sha SHA
                    atomic compare-and-delete for a held thread
  claim-held   [PR] --key K --kind finding --pushed-sha SHA
                    claim a held finding before dispatching; prints a token
  unclaim-held [PR] --key K --token T
                    give up a finding claim without dispatching
  restore-held [PR] --key K --kind thread --outcome accepted|moot
               --round R --comment-url URL --actor A --verified-sha SHA
                    undo a claim-held removal (EXACT values claim-held printed)
  release-held [PR] --key K [--if-present] [--token T]
               [--if-comment-url URL] | --all
                    after the push landed (--if-present: exit 0 if not held;
                    --token proves a live claim is yours; no-op for a
                    thread — claim-held already removed it; --if-comment-url:
                    compare-and-delete against the currently-held commentUrl)
  phase        [PR] --set NAME      record the current phase
  progress     [PR] --phase NAME    stamp a GENUINE progress event:
                                    sets lastProgressAt and phase, clears any
                                    recorded quota park. Distinct from 'phase'
                                    above, which has no progress semantics
  quota-park   [PR] --vendor V --window W [--reset-at ISO] [--account HASH]
                                    record the quota wall this drive parked on,
                                    and the hashed account it belongs to
; does NOT stamp progress —
                                    parking is the opposite of it. Cleared by
                                    the next progress event
  takeover     [PR]                 record a drive.ts --take-over (JSON on stdin)
  handoff      [PR]                 (re)write the handoff file, and the ledger under a driver
  seed-ledger  [PR]                 lay a newer ledger over this state (its body on stdin)
  admit        [PR]                 exit 0 if this tree may act on this PR, 13 if
                                    another working tree is driving it. Takes no
                                    lease and mutates nothing — for callers whose
                                    side effects leave the machine (GitHub) and so
                                    are never gated by the session lease
  lease        [PR] [--all]         the session driving this PR from this tree;
                                    --all: every LIVE lease from ANY tree, as a
                                    JSON array, each with its tree and a 'self'
                                    flag (the only reliable other-worktree check)
  clear-lease  [PR] [--all]         drop it, to take over from a session that is
                                    gone; --all drops EVERY tree's, live ones
                                    included — the deliberate cross-tree override
  reset        [PR]                 forget everything for this PR. Changes
                                    nothing while another tree's session lease
                                    is live — exit 13 at admission, or exit 9
                                    from its own sweep when that tree started
                                    driving after this one was admitted: the
                                    state and claim files are shared with it

Every state-mutating command EXCEPT clear-lease takes a session lease over (this
working tree, this PR). It exits 11 when another live session in THIS tree holds
it, and 13 when another live WORKING TREE is driving this PR. clear-lease is the
way out of both, so it is deliberately not gated behind one — see
lib/state/lease.ts.`);
}

interface Args {
  cmd: string;
  pr: string;
  key: string;
  kind: string;
  reason: string;
  sha: string;
  phaseName: string;
  outcome: string;
  unconfirmed: boolean;
  commentUrl: string;
  all: boolean;
  pushedSha: string;
  restoreRound: string;
  ifPresent: boolean;
  token: string;
  ifCommentUrl: string;
  actor: string;
  verifiedSha: string;
  eventId: string;
  actorName: string;
  createdAt: string;
  checkRunWatermark: string;
  /** Repeatable `--path`, in argv order; normalized by the writer. */
  paths: string[];
  /** `--stdin`: read newline-delimited paths from stdin instead of `--path`. */
  stdin: boolean;
  /** `set-escalated --invariant "<one sentence>"`; `''` if omitted. */
  invariant: string;
  /**
   * `progress --phase NAME` — deliberately a SEPARATE flag from
   * `--set` (the pre-existing `phase --set NAME`, which stamps `phase` alone
   * with no progress semantics): the two verbs answer different questions
   * ("what is the phase" vs "did the drive just progress"), and sharing one
   * flag name across them would make a caller's typo silently pick the wrong
   * verb's behavior rather than a wrong flag for the same one.
   */
  phaseArg: string;
  /** `quota-park --vendor V` — the wall's vendor, verbatim. */
  vendor: string;
  /** `quota-park --window W` — the wall's classified window. */
  window: string;
  /** `quota-park --reset-at ISO`; `''` when the adapter could not resolve one. */
  resetAt: string;
  /** `quota-park --account HASH`: whose wall it is; `''` when unknown. */
  account: string;
}

/** The `Args` fields a flag sets to its one value. */
type ValueField = Exclude<
  { [K in keyof Args]: Args[K] extends string ? K : never }[keyof Args],
  "cmd" | "pr"
>;

/** Every flag that takes one value, and the field it sets. */
const VALUE_FLAGS: Readonly<Record<string, ValueField>> = {
  "--key": "key",
  "--kind": "kind",
  "--reason": "reason",
  "--head": "sha",
  "--sha": "sha",
  "--pushed-sha": "pushedSha",
  "--round": "restoreRound",
  "--token": "token",
  "--set": "phaseName",
  "--outcome": "outcome",
  "--comment-url": "commentUrl",
  "--if-comment-url": "ifCommentUrl",
  "--actor": "actor",
  "--actor-name": "actorName",
  "--event-id": "eventId",
  "--created-at": "createdAt",
  "--check-run-watermark": "checkRunWatermark",
  "--verified-sha": "verifiedSha",
  "--invariant": "invariant",
  "--phase": "phaseArg",
  "--vendor": "vendor",
  "--window": "window",
  "--reset-at": "resetAt",
  "--account": "account",
};

function parseArgs(argv: string[]): Args {
  const cmd = argv.shift() ?? "";
  const a: Args = {
    cmd,
    pr: "",
    key: "",
    kind: "",
    reason: "",
    sha: "",
    phaseName: "",
    outcome: "",
    unconfirmed: false,
    commentUrl: "",
    all: false,
    pushedSha: "",
    restoreRound: "",
    ifPresent: false,
    token: "",
    ifCommentUrl: "",
    actor: "",
    verifiedSha: "",
    eventId: "",
    actorName: "",
    createdAt: "",
    checkRunWatermark: "",
    paths: [],
    stdin: false,
    invariant: "",
    phaseArg: "",
    vendor: "",
    window: "",
    resetAt: "",
    account: "",
  };
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const field = Object.hasOwn(VALUE_FLAGS, arg)
      ? VALUE_FLAGS[arg]
      : undefined;
    if (field !== undefined) {
      a[field] = take(arg, i++);
      continue;
    }
    switch (arg) {
      case "--unconfirmed":
        a.unconfirmed = true;
        break;
      case "--if-present":
        a.ifPresent = true;
        break;
      // Repeatable rather than a delimited list: an anchor path is an
      // arbitrary repository path, and every delimiter a list could use is a
      // legal character in one. A comma-split `--paths a,b` would silently
      // shard `dir,with,commas/file.ts` into three paths that match nothing,
      // and the failure would be invisible — the predicate would just answer
      // "not armed" forever.
      case "--path":
        a.paths.push(take(arg, i++));
        break;
      case "--stdin":
        a.stdin = true;
        break;
      case "--all":
        a.all = true;
        break;
      default:
        if (arg.startsWith("--")) fail(2, `unknown flag: ${arg}`);
        a.pr = arg;
    }
  }
  return a;
}

/**
 * Does an otherwise-unparseable JSON text still contain a string-literal
 * property KEY that DECODES to `target`, anywhere in the text?
 *
 * A byte-substring check misses an escaped spelling of the same key, so this
 * scans the text as JSON string literals (respecting `\`-escapes) and lets
 * `JSON.parse` decode each candidate; the document need not be valid JSON. Only
 * a literal followed by `:` is a key: a match in value position
 * (`{"reason":"ciHold"}`) would refuse `reset` over corruption that never named
 * the key.
 */
function rawTextMentionsJsonKey(text: string, target: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        // Skip the backslash and the character immediately after it. For a
        // `\uXXXX` escape this skips only the `\u`, leaving the four hex
        // digits to be scanned normally on subsequent iterations — none of
        // which can themselves be `"` or `\`, so they safely fall through
        // to the plain-character path below without special-casing the
        // escape's length.
        j += 2;
        continue;
      }
      if (text[j] === '"') break;
      j++;
    }
    if (j >= text.length) {
      // Unterminated string literal — nothing further to scan.
      break;
    }
    const literal = text.slice(i, j + 1);
    let decoded: unknown;
    try {
      decoded = JSON.parse(literal);
    } catch {
      // Not actually a valid string literal despite the scan above (should
      // not happen for well-formed escape sequences) — skip and continue.
      decoded = undefined;
    }
    if (decoded === target) {
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k] ?? "")) k++;
      if (text[k] === ":") return true;
    }
    i = j + 1;
  }
  return false;
}

/** The repository's CI-hold label (`ci.hold_label`), or `null` when it has none. */
function holdLabel(): string | null {
  return ciHoldLabelSetting() ?? null;
}

/** How messages name the hold label. */
function holdLabelName(): string {
  return holdLabel() ?? "CI hold";
}

/**
 * The PR's CI-hold label-transition timeline, straight from GitHub — the live
 * source of truth a local state file can only ever cache. Shared by
 * `set-verified` (freshness proof) and `reset` (destructive-recovery guard): a
 * local file's raw bytes can be truncated before the `ciHold` key was ever
 * serialized — `freshState()` emits it after several other fields — so scanning
 * only those bytes for evidence produces a false "no evidence" on a transition
 * that is very much live on GitHub. Unreadable (`null`) for a repository
 * without a hold label: an older drive may have held under a label the
 * configuration no longer names, and no timeline read can rule that out.
 * `set-verified` does not read it in that mode.
 */
async function readCiHoldTimeline(
  pr: string,
): Promise<ReturnType<typeof ciHoldTransitions>> {
  const label = holdLabel();
  if (label === null) return null;
  const result = await ghCall([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
  ]);
  if (result.code !== 0) return null;
  try {
    const pages = JSON.parse(result.stdout) as unknown;
    return Array.isArray(pages) ? ciHoldTransitions(pages.flat(), label) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === "") {
    usage();
    return 2;
  }

  const pr = await resolvePr(a.pr);
  if (!isDigits(pr)) {
    fail(2, `drive-state.ts: could not resolve a numeric PR (got '${pr}')`);
  }
  const store = await openStore(pr);

  /**
   * The commands that CHANGE what this PR's drive believes, and therefore the
   * ones a second concurrent session must not run behind the first's back —
   * whether that session is in the same working tree or in
   * another one. ONE list gates both, because the question
   * each asks is the same: may this process mutate this PR's drive state?
   *
   * `reset` is on it for the cross-tree case too, and that is a decision rather
   * than an inheritance. It has its own live-foreign-lease refusal (exit 9,
   * with a better diagnostic — it names the shared state and claim files it
   * declines to delete), but that fires INSIDE the command, after admission has
   * already written this tree's lease. Left off the PR-wide gate, a refused
   * `reset` would leave a live lease behind that this session's next command
   * fast-paths off, having never met the gate at all — a bypass, reached by the
   * one command an operator runs when things are already wrong. The exit-9
   * branch stays as the backstop for a tree that starts driving in the window
   * between admission and the sweep.
   *
   * Named exhaustively rather than derived from "everything except the readers"
   * so that adding a command is a decision about this list, not a silent
   * inheritance either way — a new mutator that forgot to be gated is exactly
   * the hole this closes, and a new reader wrongly gated would refuse work that
   * conflicts with nothing.
   *
   * `handoff` is absent because it only re-renders a projection of state it does
   * not change; `lease` and `clear-lease` because the lease cannot gate the
   * commands that inspect and release it — `clear-lease` IS the way out of a
   * lease whose holder is gone.
   *
   * The four `*-ready-mark` commands mutate the READY-MARK claim, a distinct
   * lease from this one (`readyClaimPath`, guarding the draft→Ready transition
   * across WORKTREES) — but that distinction does not exempt them from THIS
   * one, which guards against a second SESSION in the same worktree. Left
   * off this list, `release-ready-mark`'s tokenless recovery path let a second
   * session delete the first session's live ready-mark claim and take the
   * transition itself without ever reaching the refusal above — the exact
   * "new mutator that forgot to be gated" this comment already warned about.
   */
  const LEASED_COMMANDS = new Set([
    "bump-round",
    "bump-attempt",
    "stamp-held",
    "set-verified",
    "set-ci-hold",
    "set-reflected",
    // Mutating, so leased like every other writer here — `record-paths` writes
    // the evidence the duty is derived from, and `set-escalated` discharges
    // it. The pure readers (`round-paths`, `escalation-due`, `escalated`) are
    // deliberately absent, exactly as `rounds`/`reflected`/`held` are.
    "record-paths",
    "set-escalated",
    "park",
    "unpark",
    "hold",
    "claim-held",
    "unclaim-held",
    "restore-held",
    "release-held",
    "phase",
    // Mutators of `lastProgressAt`, `quotaPark` and `takeovers`, leased on
    // the same terms as `phase` above.
    "progress",
    "quota-park",
    "takeover",
    "seed-ledger",
    "reset",
    "claim-ready-mark",
    "renew-ready-mark",
    "commit-ready-mark",
    "release-ready-mark",
  ]);
  // Kept for `reset`, which must distinguish "this live lease is MINE" from
  // "same tree, but I hold nothing" — see `clearAllLeases`. Null under the
  // no-session tier, which is exactly the case that distinction exists for.
  let admittedLease: Lease | null = null;
  if (LEASED_COMMANDS.has(a.cmd)) {
    const admission = await claimLease(store.stateDir, pr, a.cmd);
    admittedLease = admission.lease;
    // Admission is not the mutation. Between here and the locked section below,
    // another process can sweep or take over either lease — and would then run
    // beside this command under one actor or one tree. Re-checked inside every
    // locked section instead of trusted.
    if (admission.lease !== null && admission.treeLease !== null) {
      // `admission.lease`/`admission.treeLease` are narrowed together HERE —
      // every admission that claims one also claims the other in the same
      // call, identified or not, ladder tier 3 included (`LeaseAdmission`'s
      // own doc comment). The `{ lease: null, treeLease: null }` alternative,
      // the narrower defer-to-a-live-session case, is the `else` branch below.
      const { lease: admitted, treeLease: admittedTree } = admission;
      // A plain re-check here still leaves the identical gap already closed for
      // the deferred branch below: a DIFFERENT pr's `claimTreeLease` takes only
      // THAT pr's state mutex before reaching for `treeLeaseLock`, so it can
      // land between "the fence found no takeover" and "the mutation actually
      // ran". `acquireIdentifiedTreeGuardNow` holds `treeLeaseLock` through the
      // mutation itself, the same fix `acquireSessionlessTreeGuardNow` gives
      // the deferred no-claim tier below — and now applies here regardless of
      // which ladder tier wrote `admittedTree`, since
      // `assertTreeLeaseUnchanged` compares only the (pid, host, generation)
      // identity tuple every tree lease carries, `holder: 'worktree'` included.
      store.setFence(async () => {
        assertLeaseUnchanged(store.stateDir, pr, admitted);
        store.setExtraLock(
          await acquireIdentifiedTreeGuardNow(
            store.stateDir,
            admitted.actor,
            admittedTree,
          ),
        );
      });
    } else {
      // Reached ONLY for the narrow DEFERRED case now: this
      // tree's own per-PR lease already belongs to a live identified
      // session, so `claimLease`'s tier-3 branch claimed neither lease of
      // its own — see its own comment. `assertNoForeignDrive` ran once
      // already, as a preflight OUTSIDE any mutex, before that decision —
      // an identified resolver, in another tree or elsewhere in THIS tree
      // on a different PR, could take the state mutex and write its lease
      // immediately after the check passed, and this command would then
      // take the same mutex and mutate beside it — the serialisation the
      // gate claims, defeated by a check that is not part of the admission
      // protocol it guards. Every OTHER
      // tier-3 admission now claims a genuine `TreeLease` of its own
      // (`claimSessionlessTreeLease`) and is fenced by the branch above
      // instead, via `assertLeaseUnchanged`/`assertTreeLeaseUnchanged` —
      // this branch fences the one case that still holds no admitted lease
      // to compare against by construction.
      //
      // Re-running the PR-wide check here closes ITS half the identical way
      // `assertNoForeignDriveNow`'s own comment describes: the fence fires
      // inside the locked section, so a foreign tree's write cannot land
      // between the check and this command's mutation.
      //
      // The tree-wide half needs MORE than a re-check at this one instant —
      // `acquireSessionlessTreeGuardNow` holds `treeLeaseLock` through the
      // mutation itself (`store.setExtraLock`, released by `locked()` right
      // after `fn()`), not merely at the moment the fence runs, because a
      // DIFFERENT pr's claim (`claimTreeLease` or `claimSessionlessTreeLease`)
      // takes only THAT pr's state mutex — never this one — before it ever
      // reaches for `treeLeaseLock`, so a check-then-release fence still leaves
      // the gap between "the fence said clear" and "the mutation actually ran"
      // open.
      //
      // Not `assertLeaseUnchanged`/`assertTreeLeaseUnchanged`, which need an
      // admitted lease to compare — this branch holds none by construction
      // (writing one here would downgrade the live session it deferred to —
      // see `claimLease`'s own tier-3 comment), so "has anyone else taken
      // the PR / tree since?" is the only question it can ask, and the only
      // one it needs.
      store.setFence(async () => {
        await assertNoForeignDriveNow(store.stateDir, pr);
        store.setExtraLock(
          await acquireSessionlessTreeGuardNow(store.stateDir),
        );
      });
    }
  }

  /**
   * `claim-held --kind finding`. Win the per-key mutex, then prove
   * — under the state lock — that the key is still a held `finding` whose own
   * push provenance matches `--pushed-sha`, and print the token that
   * `release-held`/`unclaim-held` will demand back.
   *
   * A finding needs the provenance half MORE than a thread does, not less:
   * `answer-summary-finding.ts` checks only that `--pushed-sha` is the PR's
   * live head and this worktree's clean HEAD, which a concurrent driver's
   * unrelated push satisfies perfectly — without this, the finding path would
   * have no round check and no provenance check at all. It is enforced here
   * rather than there because this is where the state, and the lock over it,
   * already are.
   */
  async function claimFinding(): Promise<number> {
    // Validated BEFORE the mutex is taken: a usage error must not leave a claim
    // file behind for a dispatch that was never going to be allowed.
    if (a.pushedSha === "") {
      fail(
        2,
        "claim-held --kind finding requires --pushed-sha — the push that carries this",
        "finding's promised fix (`$(git rev-parse HEAD)`, after guarded-push.ts and",
        "stamp-held, per SKILL.md § 6). Every held finding is fix-dependent by",
        "construction ('hold' refuses any outcome that is not accepted|moot), so there",
        "is no claim of one that legitimately has no push to name.",
      );
    }
    const path = claimPathFor(store.stateDir, pr, a.key);
    const tok = newClaimToken();
    if (!claimCreate(path, tok)) {
      if (claimIsLive(path)) {
        fail(
          1,
          `claim-held: '${a.key}' is already claimed (live) — another driver appears to be dispatching it. Skip it this round.`,
        );
      }
      // Stale by the check above — but breaking it needs a TRUE mutex, not
      // another snapshot: see `tryBreakStaleClaim`'s own comment for why three
      // earlier attempts at approximating one without the per-PR lock all
      // reproduced a double-winner under enough concurrent contention.
      if (!(await tryBreakStaleClaim(path, store.lock))) {
        fail(
          1,
          `claim-held: '${a.key}' is already claimed (live) — found live once the coordination lock was actually held, or the lock itself could not be acquired. Skip it this round.`,
        );
      }
      if (!claimCreate(path, tok)) {
        fail(
          1,
          `claim-held: could not claim '${a.key}' — a concurrent claimant just beat us to it. Skip it this round.`,
        );
      }
      console.error(
        `claim-held: broke an abandoned claim (>${claimStaleMin()}m old) on '${a.key}'`,
      );
    }
    // From here on, every failure path that would normally clean up after
    // itself must NOT remove `path` unconditionally: a cleanup may remove it
    // only when `claimTokenMatches` proves our own token is still the one
    // there. This should always be true now that staleness-breaking is
    // lock-protected (nobody else can legitimately remove a claim as young as
    // ours), but the check costs nothing and this file does not trust "should
    // never happen" without verifying it.
    const releaseOwn = (): void => {
      if (claimTokenMatches(path, tok)) removeClaimFile(path);
    };
    // The membership re-check below must be a LOCKED read, for the same reason
    // `unclaim-held` and `release-held` lock theirs.
    // `release-held --all` decides "is any key contended" and clears `.held`
    // inside ONE lock hold; an UNLOCKED read here could observe the pre-clear
    // snapshot after that hold's contended check already missed our brand-new
    // claim file. Both sides would then believe they own the key, and `--all`'s
    // cleanup deletes our claim out from under us while we go on to dispatch —
    // the duplicate top-level comment this whole primitive exists to prevent,
    // reached through the one read-then-act that skipped the mutex.
    //
    // `claimCreate` above stays lock-free and atomic on purpose — winning the
    // slot is still a single `O_CREAT|O_EXCL` syscall, not a check-then-act a
    // mutex could substitute for. Only the JSON READ is serialised here, and
    // create-then-check ordering is unchanged. `tryBreakStaleClaim` has already
    // fully released the lock before we get here, so this never nests.
    try {
      await store.lock.acquire();
    } catch (e) {
      releaseOwn();
      if (e instanceof ExitError) {
        fail(
          1,
          `claim-held: could not take PR #${pr}'s state lock to confirm '${a.key}' is still held — skip it this round.`,
        );
      }
      throw e;
    }
    try {
      // The admission fence, run EXPLICITLY because this is the one path that
      // takes the lock directly rather than through `store.locked` — so the
      // fence installed at admission would otherwise never fire here. That
      // matters more on this path than on any other: a revoked session would
      // go on to validate the held record, return a claim token, and dispatch
      // a NON-idempotent summary answer beside its successor's, which is a
      // duplicate standing claim on the PR that no later round undoes.
      //
      // The claim file is removed before the refusal propagates: it was
      // created lock-free moments ago, and leaving it behind would wedge the
      // key behind a claim no dispatch will ever follow.
      try {
        await store.runFence();
      } catch (e) {
        releaseOwn();
        throw e;
      }
      let state: DriveState;
      try {
        state = store.read().state;
      } catch (e) {
        releaseOwn();
        console.error(
          `claim-held: could not read state for PR #${pr} while claiming '${a.key}' — see 'drive-state.ts get ${pr}' for what the reader reported. Refusing to guess whether '${a.key}' is still held.`,
        );
        throw e;
      }
      const item = state.held.find((h) => h.key === a.key);
      if (!item) {
        releaseOwn();
        fail(
          4,
          `claim-held: '${a.key}' is not in the held batch — nothing to claim (already released, or never held).`,
        );
      }
      if (item.kind !== "finding") {
        releaseOwn();
        fail(
          2,
          `claim-held: '${a.key}' is a held '${item.kind}', not a 'finding'.`,
        );
      }
      // Exit 1, the same "skip this key this round" class as a live claim:
      // nothing is wrong with the batch, this particular item just is not
      // dispatchable against this push. See the `--kind thread` branch below
      // for why the HOLD's own stamp — not the PR-global `.verifiedSha` — is
      // what a fix-dependent answer may be posted against.
      //
      // The message names BOTH recoveries rather than only the re-hold,
      // because a finding has no round-based recovery of its own and one
      // reachable interleaving lands here with no way out otherwise: a driver
      // that dies AFTER its POST succeeded but BEFORE `release-held` leaves an
      // already-answered finding held at the SHA it answered under. Once the
      // head moves, no `--pushed-sha` will ever match it again — and unlike a
      // thread, nothing re-enumerates it (`summary-findings.ts`'s `unaddressed`
      // list already excludes an answered finding), so no § 3 pass will re-hold
      // it either. Without this check the reclaimer would simply claim and post
      // a SECOND answer; the check that stops that duplicate is the same one
      // that strands the entry, so this refusal owes the reader the way out.
      if (item.verifiedSha !== a.pushedSha) {
        releaseOwn();
        fail(
          1,
          `claim-held: --pushed-sha ${a.pushedSha} is not the push recorded against`,
          `'${a.key}' itself (${item.verifiedSha === undefined ? "none — no push by the driver that holds it has been verified since it was held" : item.verifiedSha}).`,
          "",
          "Answering a summary finding is NOT idempotent — it posts a new top-level",
          "comment every call — so dispatching one against a push that does not carry",
          "its fix leaves a standing, wrong claim on the PR that no later round undoes.",
          "",
          "Two recoveries, and which one applies is decided by the PR, not by this",
          "state file. Check whether this finding was ALREADY answered — an earlier",
          "pass may have posted and then died before releasing it ('summary-findings.ts",
          `${pr} --json' reports its marker). If it was, the answer stands and the`,
          `entry is just stale: 'drive-state.ts release-held ${pr} --key ${a.key}`,
          "--if-present'. If it was not, re-hold it (SKILL.md § 3) so it is stamped by",
          "the push that actually carries the fix, then answer it.",
        );
      }
      // Final check, immediately before declaring victory: prove OUR token is
      // still the content actually sitting at `path` right now. Nothing
      // legitimate should be able to remove a claim this young — staleness-
      // breaking is lock-protected and re-verifies liveness under the lock, and
      // the membership check just above is now ALSO lock-protected — so this
      // should always pass. It stays as defense in depth rather than a
      // load-bearing guarantee: `claimCreate` proves we owned `path` at the
      // INSTANT we created it, and refusing to report success on an unexpected
      // mismatch costs nothing against the alternative of trusting a proof
      // that is, by this point, no longer current.
      if (!claimTokenMatches(path, tok)) {
        fail(
          1,
          `claim-held: '${a.key}' was claimed, then something unexpected happened to it before we could confirm it — skip it this round.`,
        );
      }
    } finally {
      // Whatever the sessionless fence registered via `setExtraLock`
      // must be released here too — this is the one
      // path that takes `store.lock` directly instead of through `locked()`,
      // so `locked()`'s own `releaseExtraLock()` never runs for it.
      store.releaseExtraLock();
      store.lock.release();
    }
    process.stdout.write(`${tok}\n`);
    return 0;
  }

  switch (a.cmd) {
    case "get": {
      const { raw } = store.read();
      process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
      return 0;
    }

    case "rounds": {
      process.stdout.write(`${store.read().state.rounds}\n`);
      return 0;
    }

    case "bump-round": {
      if (a.sha === "") fail(2, "bump-round requires --head SHA");
      // Count HEADS, not calls. A retried pass against an unchanged push is
      // the same round; counting it would make a round budget measure driver
      // retries. Progress is stamped ONLY on the genuine advance
      // — the no-op branch below is exactly the re-read `withProgress`'s own
      // header warns must not look like forward motion.
      await store.update((s) =>
        s.lastCountedHead === a.sha
          ? s
          : withProgress(
              { ...s, rounds: s.rounds + 1, lastCountedHead: a.sha },
              "round-advanced",
              new Date(),
            ),
      );
      process.stdout.write(`${store.read().state.rounds}\n`);
      return 0;
    }

    case "reflected": {
      process.stdout.write(`${store.read().state.lastReflectedRound}\n`);
      return 0;
    }

    case "set-reflected": {
      // Stamp "a /reflect happened at this point" inside one update, so the
      // reads of .rounds/.attempts and the writes of their baselines cannot
      // straddle a concurrent bump. Recording a POSITION rather than a boolean
      // is what lets the duty re-arm: reflectDepthPastLast measures forward
      // from here, so a drive that runs long enough past the last reflect owes
      // another one (SKILL.md § 3).
      //
      // BOTH counters are stamped because they are independent axes —
      // `reflectDepthPastLast` documents why one stamp cannot serve them.
      //
      // `lastEscalatedRound` is stamped HERE TOO, in the same update: a
      // `/reflect` is the step-back a structural escalation asks for, and the
      // deeper one — it names the class across PRs, where `set-escalated` only
      // records that this PR's recurrence was addressed. Leaving the escalation
      // armed after a reflect would make the very next round demand a second
      // step-back for a pattern that had just been examined, which is how an
      // advisory signal gets learned as noise and then ignored when it is real.
      // The reverse does NOT hold: `set-escalated` discharges only itself,
      // because a narrow "I generalized the fix" is not a reflect.
      //
      // `lastEscalatedInvariant` is CLEARED here too, not carried
      // forward: a `/reflect` is a step back from the whole class, not a
      // restatement of whatever one file's prior `set-escalated --invariant`
      // claimed. Leaving that text in place would let a later recurrence echo
      // a narrow sentence as if the reflect had re-examined and re-affirmed
      // it, when the reflect may never have touched that specific claim at
      // all.
      //
      // `roundPaths` is re-pruned in this SAME update against the NEW
      // `lastEscalatedRound` — see `pruneRoundPaths`'s own header for why
      // advancing the acknowledgment without doing so writes a state
      // `isUsableState` immediately rejects on the very next read.
      await store.update((s) => {
        const lastEscalatedRound = s.rounds;
        return {
          ...s,
          lastEscalatedRound,
          lastEscalatedInvariant: "",
          lastReflectedRound: s.rounds,
          lastReflectedAttempts: s.attempts,
          roundPaths: pruneRoundPaths(s.roundPaths, lastEscalatedRound),
        };
      });
      process.stdout.write(`${store.read().state.lastReflectedRound}\n`);
      return 0;
    }

    // The three commands below are the durable half of
    // `structuralEscalationDue`: one writes each round's finding anchors, one
    // reads the derived duty, one discharges it. The predicate itself lives in
    // `lib/state/schema.ts` and is SHARED with drive-status.ts's report field,
    // for the reason `reflectDepthPastLast` gives for living there: three
    // divergent formulations of one duty drift apart, and this signal has the
    // same two consumers.
    case "record-paths": {
      // Keyed to the CURRENT round rather than to a `--round` argument, and
      // read inside the same locked update that writes it. A caller-supplied
      // round could name one that never happened, or straddle a concurrent
      // `bump-round` and file this round's anchors under the last one — which
      // would fabricate a same-file pair out of one round's findings read
      // twice, the single false positive this signal cannot afford.
      //
      // Replace-not-append for the same reason `bump-round` counts heads: a
      // second pass on an unmoved head re-enumerates the SAME threads, and an
      // appended second entry for one round would let a drive that pushed
      // nothing arm an escalation against itself.
      //
      // Reading stdin is behind an EXPLICIT `--stdin`, never inferred from
      // "no `--path` was given". Inferring it makes two indistinguishable
      // cases ambiguous — a round that genuinely found nothing on any file,
      // and a caller that meant to pipe paths — and resolves them by BLOCKING
      // on whatever descriptor happens to be attached: an inherited pipe that
      // never closes hangs the command with no output to say why, and a
      // terminal hangs it forever. An empty `--path` list is a real answer
      // here, so it must not be the trigger for asking a different source.
      if (a.stdin && a.paths.length > 0) {
        fail(2, "record-paths takes --path or --stdin, not both");
      }
      // Round 0 is not a counted round — `freshState` starts there and
      // `bump-round`/`bump-attempt` is what advances past it. Recording anchors
      // under it would store a `{round: 0, ...}` entry that becomes adjacent to
      // round 1's real entry the moment counting begins, letting
      // `structuralEscalationArmed` treat a pre-counting call and the actual
      // first round as a false two-round recurrence on any shared path.
      // `drive-status.ts`'s own path here always bumps first, so this only ever
      // refuses a direct, out-of-order call.
      if (store.read().state.rounds < 1) {
        fail(
          2,
          `record-paths: #${pr} has not counted a round yet (rounds=0) — run drive-status.ts (which bumps first) or drive-state.ts bump-round/bump-attempt before recording anchors`,
        );
      }
      const raw = a.stdin ? (await readStdinAll()).split("\n") : a.paths;
      // The cap `foldRoundPaths` applies is silent by construction — sort,
      // then slice — so a round with genuinely more distinct anchor paths
      // than the cap loses the overflow with nothing in the stored state
      // recording that it happened. Measured here, before the write, against
      // the SAME filtering `foldRoundPaths` itself applies (never a
      // hand-rolled trim/dedupe that could drift from it), so the warning is
      // never wrong about what the cap actually dropped.
      const distinct = normalizeRoundPathsUncapped(raw);
      if (distinct.length > ROUND_PATHS_MAX_PER_ROUND) {
        console.error(
          `record-paths: #${pr} round ${store.read().state.rounds} has ${distinct.length} distinct anchor path(s), exceeding the ${ROUND_PATHS_MAX_PER_ROUND}-path cap — ${distinct.length - ROUND_PATHS_MAX_PER_ROUND} dropped and will not feed structuralEscalationDue`,
        );
      }
      await store.update((s) => ({
        ...s,
        roundPaths: foldRoundPaths(
          s.roundPaths,
          s.rounds,
          raw,
          s.lastEscalatedRound,
        ),
      }));
      process.stdout.write(
        `${JSON.stringify(store.read().state.roundPaths)}\n`,
      );
      return 0;
    }

    case "round-paths": {
      process.stdout.write(
        `${JSON.stringify(store.read().state.roundPaths)}\n`,
      );
      return 0;
    }

    case "escalation-due": {
      process.stdout.write(
        `${structuralEscalationArmed(store.read().state)}\n`,
      );
      return 0;
    }

    case "escalated": {
      process.stdout.write(`${store.read().state.lastEscalatedRound}\n`);
      return 0;
    }

    case "set-escalated": {
      // A POSITION, not a boolean, for exactly `set-reflected`'s reason: the
      // duty must re-arm. Acknowledging at round 3 silences the (2,3) pair it
      // was raised on and nothing else — a (3,4) pair is fresh evidence that
      // the acknowledgment did not settle the class, and says so.
      //
      // `--invariant "<one sentence>"`: what THIS round
      // believes it closed, persisted so the round that finds the next pair
      // on this file can read the prior claim back instead of re-deriving it
      // from the GitHub thread and diff by hand — see
      // `structuralEscalationInvariant`'s own doc for when it is echoed.
      // ALWAYS overwrites, never merges with a prior value: an acknowledgment
      // that states no invariant this time means nothing survives to be
      // echoed, not "whatever the last round said still holds" — the caller
      // that stated it is the only one who can vouch for it.
      //
      // Length-checked BEFORE the update, and refused rather than silently
      // truncated — `ESCALATION_INVARIANT_MAX_LENGTH`'s own doc gives the
      // reason a truncated claim is worse than an outright refusal here.
      // Validated on the RAW `a.invariant`, never a normalized copy —
      // trimming first would accept newline-padded text ("\nclaim\n")
      // instead of refusing it, let an over-cap value that is mostly
      // surrounding whitespace slip under the cap, and silently drop
      // leading/trailing spaces the verbatim-echo contract above promises to
      // preserve.
      //
      // Newline-free too, like every other short free-text field this schema
      // treats as single-line (`hold.actor`) — "one sentence" is the
      // documented shape, and this text is echoed verbatim into a JSON
      // payload SKILL.md reads as a single claim, not a multi-line block.
      const invariant = a.invariant;
      if (invariant.length > ESCALATION_INVARIANT_MAX_LENGTH) {
        fail(
          2,
          `set-escalated: --invariant is ${invariant.length} chars, over the ${ESCALATION_INVARIANT_MAX_LENGTH}-char cap — state the claim more tersely rather than relying on truncation`,
        );
      }
      if (/[\n\r]/.test(invariant)) {
        fail(
          2,
          "set-escalated: --invariant must not contain a newline — state the claim as one sentence",
        );
      }
      // Both prerequisites — a COUNTED round, and an ARMED escalation — are
      // checked INSIDE this locked update, against the very snapshot
      // `lastEscalatedRound` is about to be derived from, never against an
      // earlier `store.read()`. A check taken before the lock is stale by
      // the time the write happens: a concurrent `reset` landing in between
      // would let this write through against a fresh `rounds === 0` state,
      // persisting an unattributable invariant at the exact sentinel round
      // (0) `freshState` starts from — indistinguishable from "never escalated"
      // to every other reader of that field. And a counted round alone is not
      // evidence of a real recurrence: without the armed check, acknowledging
      // on a round that never armed persists `lastEscalatedInvariant` under a
      // `lastEscalatedRound` that a LATER, genuine arming then echoes back as
      // though it were that arming's own acknowledgment.
      //
      // `roundPaths` is re-pruned in this SAME update — see
      // `set-reflected`'s identical comment and `pruneRoundPaths`'s header.
      await store.update((s) => {
        if (s.rounds < 1) {
          fail(
            2,
            `set-escalated: #${pr} has not counted a round yet (rounds=0) — run drive-status.ts (which bumps first) or drive-state.ts bump-round/bump-attempt before acknowledging an escalation`,
          );
        }
        if (!structuralEscalationArmed(s)) {
          fail(
            2,
            `set-escalated: #${pr} has no armed structural escalation to acknowledge — record-paths a qualifying same-file pair (or check drive-status.ts's structuralEscalationDue) before acknowledging one`,
          );
        }
        const lastEscalatedRound = s.rounds;
        return {
          ...s,
          lastEscalatedRound,
          lastEscalatedInvariant: invariant,
          roundPaths: pruneRoundPaths(s.roundPaths, lastEscalatedRound),
        };
      });
      process.stdout.write(`${store.read().state.lastEscalatedRound}\n`);
      return 0;
    }

    case "bump-attempt": {
      if (a.sha === "") fail(2, "bump-attempt requires --head SHA");
      // Attempts, unlike rounds, count PASSES on a head — including the ones
      // that never pushed. `rounds` cannot bound those: it counts distinct
      // reviewed heads, so a pass that fixes nothing leaves it flat forever.
      // drive.ts's own per-process counter did bound them, but only within one
      // process, so any harness that restarts the driver handed it a fresh
      // full budget each time and the "bounded" unattended loop ran without a
      // bound. Making the count durable is what closes that, and keying it to
      // the head is what keeps a genuine new round from inheriting the
      // previous head's exhausted budget.
      //
      // A head change REBASES the reflect baseline for this counter along with
      // the counter itself. `lastReflectedAttempts` is a position on the old
      // head's attempt axis, and that axis does not survive the reset: a
      // reflect recorded at attempt 8, followed by a new head where attempts
      // restart at 1, leaves a delta of -7 that the `max` in
      // `reflectDepthPastLast` prefers to ignore — so the duty stays off
      // through several genuine passes on the new head and does not re-arm
      // until it reaches attempt 12. The
      // rounds baseline is cumulative and needs no such treatment; this is the
      // per-head counter paying for being per-head.
      await store.update((s) =>
        s.attemptsHead === a.sha
          ? { ...s, attempts: s.attempts + 1 }
          : {
              ...s,
              attempts: 1,
              attemptsHead: a.sha,
              lastReflectedAttempts: 0,
            },
      );
      process.stdout.write(`${store.read().state.attempts}\n`);
      return 0;
    }

    case "attempts": {
      process.stdout.write(`${store.read().state.attempts}\n`);
      return 0;
    }

    case "verified": {
      process.stdout.write(`${store.read().state.verifiedSha}\n`);
      return 0;
    }

    case "set-ci-hold": {
      // This command persists CALLER-SUPPLIED ci:hold ownership/freshness
      // evidence with no validation against GitHub — `release()` later trusts
      // the persisted event id against the live timeline, and `finalReady()`
      // trusts the persisted watermark/timestamp for CI freshness. Fabricating
      // either is exactly what a real driver must never be able to do (a caller
      // could record a human-owned labeled event as its own `held`, then have
      // `release()` remove a label that belongs to someone else). No production
      // script calls this — only tests, as a fixture-seeding helper — so gate
      // it behind an explicit opt-in only the test harness sets, rather than
      // trusting "nothing calls it today" to stay true.
      if (process.env.DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED !== "1") {
        fail(
          2,
          "set-ci-hold: test-only fixture seeding, requires DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED=1 — a real driver must never write unvalidated ci:hold evidence; use ci-hold.ts ensure/release instead",
        );
      }
      if (a.phaseName !== "held" && a.phaseName !== "released") {
        fail(2, "set-ci-hold requires --set held|released");
      }
      if (
        a.eventId === "" ||
        !isGitSha(a.sha) ||
        a.actorName === "" ||
        /\r|\n/.test(a.actorName) ||
        !Number.isFinite(Date.parse(a.createdAt))
      ) {
        fail(
          2,
          "set-ci-hold requires --event-id ID --head SHA --actor-name LOGIN --created-at ISO",
        );
      }
      const checkRunWatermark = Number.parseInt(a.checkRunWatermark, 10);
      if (
        (a.phaseName === "held" || a.phaseName === "released") &&
        (!/^\d+$/.test(a.checkRunWatermark) ||
          !Number.isSafeInteger(checkRunWatermark) ||
          checkRunWatermark <= 0)
      ) {
        fail(
          2,
          "held/released ci-hold state requires --check-run-watermark ID",
        );
      }
      await store.update((s) => ({
        ...s,
        ciHold:
          a.phaseName === "held"
            ? {
                phase: "held",
                eventId: a.eventId,
                addedAtHead: a.sha,
                actor: a.actorName,
                createdAt: a.createdAt,
                checkRunWatermark,
              }
            : {
                phase: "released",
                eventId: a.eventId,
                head: a.sha,
                actor: a.actorName,
                createdAt: a.createdAt,
                checkRunWatermark,
                source: "drive",
              },
      }));
      return 0;
    }

    // The per-hold stamp is push provenance, scoped to the holds THIS
    // actor created. A hold this actor does not own is left untouched, so a
    // concurrent driver's `stamp-held` can no longer be what lets one of our
    // held threads resolve — and ours cannot be what resolves one of theirs.
    // Scoping it here rather than at claim time is deliberate: the claim then
    // needs no actor comparison of its own, so a driver that dies mid-round
    // does not strand its holds — once the fix IS on the PR, any driver may
    // finish them, which is the recovery path SKILL.md § 3 already documents.
    //
    // Advances every held item's stamp to this push EXCEPT one narrow case: a
    // `finding` that ALREADY carries a stamp AND has a currently outstanding
    // claim file. `claim-held --kind finding` locks a key with a SEPARATE
    // filesystem claim rather than removing it from `held` (unlike a thread,
    // whose claim atomically removes the entry) — so a finding can sit in
    // `held`, still bearing its OLD stamp, for the whole window between a
    // successful `claim-held` and an eventual `release-held`. If
    // `answer-summary-finding.ts` POSTed successfully in that window and the
    // process then died before `release-held`, the claim file is still there
    // — live or gone stale, it does not matter, nothing removed it — and it
    // is exactly the signal that this item's stamp may already have been
    // dispatched under. Blindly advancing it to a later, unrelated push would
    // let `claim-held` accept that new SHA, dispatch again, and
    // `--check-addressed --marker-sha` miss the marker actually sitting at
    // the old SHA — a silent duplicate (the interrupted-dispatch scenario
    // this case exists to close).
    //
    // The `h.verifiedSha !== undefined` guard is the freeze's actual
    // boundary, not an extra condition bolted onto it: freeze exactly when a
    // dispatch COULD have happened under the recorded stamp. An unstamped
    // finding provably cannot have dispatched yet — `claimFinding` rejects an
    // empty `--pushed-sha` before ever creating a claim file, and then
    // refuses whenever `item.verifiedSha !== a.pushedSha`, which an absent
    // stamp can never satisfy — so a claim file sitting over an unstamped
    // record is, by construction, a claim still in flight and not yet
    // validated, never a completed dispatch. Without this guard, a driver B
    // racing `claim-held` against driver A's own first-ever `stamp-held`
    // for a brand-new hold could create a claim file a moment before A's
    // call takes the lock; A's stamp would then be skipped (the raw
    // `existsSync` check alone can't tell "in-flight, unvalidated claim"
    // apart from "already dispatched"), and B's own claim attempt fails and
    // cleans up its file right after — leaving A's item permanently
    // unstamped even though nothing was ever actually dispatched against it.
    //
    // Every OTHER held item — a thread (whose claim removes it from `held`
    // outright, so it is never around to see a second `stamp-held`; a failed
    // resolve mutation restores it with its EXACT original stamp rather than
    // leaving it exposed here) or a finding that was never claimed, or whose
    // claim was cleanly released/unclaimed — has none of that risk and MUST
    // advance normally: in the ordinary (non-crash) case a later verified push
    // is a descendant commit that still contains the fix, and freezing its
    // stamp instead would leave it refusing every future claim the moment its
    // own SHA stops being the PR's live head — permanently wedging an item
    // nothing dispatched yet.
    case "stamp-held": {
      if (a.sha === "") fail(2, "stamp-held requires --sha SHA");
      if (!isGitSha(a.sha)) {
        fail(
          2,
          `stamp-held: --sha must be a full 40-character lowercase hex SHA-1 (got '${a.sha}') — the exact grammar 'git rev-parse HEAD' emits.`,
          "A looser check here (e.g. merely non-empty) lets a malformed value —",
          "CR/LF, a short SHA, stray punctuation — persist successfully and only",
          "fail isUsableState on the NEXT read, fail-closing the whole shared",
          "state file for every driver of this PR.",
        );
      }
      const me = await resolveActor();
      // A push landed — one of the named progress events (`PROGRESS_PHASES`),
      // stamped unconditionally on this call rather than conditioned on the
      // `.map()` below actually changing anything: SKILL.md orders this call
      // strictly AFTER a real push (§ 3 → § 6), so the push already happened
      // whether or not THIS actor currently holds anything to stamp a SHA onto.
      await store.update((s) => ({
        ...withProgress(s, "push-landed", new Date()),
        held: s.held.map((h) => {
          if (h.actor !== me) return h;
          if (
            h.kind === "finding" &&
            h.verifiedSha !== undefined &&
            existsSync(claimPathFor(store.stateDir, pr, h.key))
          ) {
            return h;
          }
          return { ...h, verifiedSha: a.sha };
        }),
      }));
      return 0;
    }

    // Global verification is deliberately a different transition from
    // `stamp-held`. Intermediate pushes are locally validated and may drain
    // their accepted holds, but while `ci:hold` suppresses synchronize CI
    // they are not globally green. This command re-reads every witness itself
    // so it cannot be used to manufacture that pointer early.
    case "set-verified": {
      if (a.sha === "") fail(2, "set-verified requires --sha SHA");
      if (!isGitSha(a.sha)) {
        fail(
          2,
          `set-verified: --sha must be a full 40-character lowercase hex SHA-1 (got '${a.sha}') — the exact grammar 'git rev-parse HEAD' emits.`,
        );
      }
      const remoteFence = await resolveFenceContext("set-verified");
      const remoteLock =
        remoteFence === null
          ? null
          : await assertRemoteMutationAllowed(remoteFence, pr, "set-verified");
      const remoteHeartbeat =
        remoteLock === null
          ? null
          : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
      try {
        const live = await ghCall([
          "pr",
          "view",
          pr,
          "--json",
          "state,headRefOid,labels",
        ]);
        if (live.code !== 0) fail(1, "set-verified: cannot read the PR");
        let snapshot: ReturnType<typeof parsePrSnapshot>;
        try {
          snapshot = parsePrSnapshot(
            JSON.parse(live.stdout) as unknown,
            holdLabel(),
          );
        } catch {
          fail(1, "set-verified: cannot parse the PR snapshot");
        }
        if (snapshot === null)
          fail(1, "set-verified: PR snapshot is malformed");
        if (snapshot.state !== "OPEN") {
          fail(5, `set-verified: PR #${pr} is not open`);
        }
        if (snapshot.head !== a.sha) {
          fail(4, `set-verified: PR head is ${snapshot.head}, not ${a.sha}`);
        }
        if (snapshot.held) {
          fail(4, `set-verified: '${holdLabelName()}' is still present`);
        }

        const current = store.read().state;
        if (current.ciHold !== null && current.ciHold.phase !== "released") {
          fail(
            4,
            `set-verified: '${holdLabelName()}' transition is not settled`,
          );
        }
        // Without a hold label every push ran full CI, so a released record
        // left by an earlier drive is settled history, not evidence this head
        // must be measured against.
        const settledHold = holdLabel() === null ? null : current.ciHold;
        if (settledHold !== null && settledHold.head !== a.sha) {
          fail(4, "set-verified: the recorded unlabel belongs to another head");
        }
        let policy: CiPolicy;
        try {
          policy = await ciPolicy(pr);
        } catch (error) {
          fail(
            1,
            `set-verified: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const readTimeline = async () =>
          policy.holdLabel === null ? [] : await readCiHoldTimeline(pr);
        const expectedTransition = settledHold?.eventId ?? null;
        const timeline = await readTimeline();
        if (
          timeline === null ||
          (expectedTransition === null
            ? timeline.length !== 0
            : timeline.at(-1)?.id !== expectedTransition)
        ) {
          fail(
            4,
            `set-verified: ${holdLabelName()} transition history is not settled`,
          );
        }
        // ONE predicate for "does CI genuinely prove this head is done and
        // green" — called for the INITIAL proof below AND, unchanged, for every
        // later re-check `stillFullyCurrent()` performs. Two rounds running, a
        // re-check implemented as a SEPARATE, cheaper approximation of this
        // same question fell out of sync with it: a aggregate-only
        // `ciVerdictOf` re-check treats `skipped` as passing, so a newer
        // skipped run for a required check could supersede the successful
        // post-unlabel run without either refresh noticing, even though
        // `completedRequiredCi` — the INITIAL proof's own predicate — would
        // reject it. Sharing one implementation for "prove CI green" makes that
        // class of drift impossible rather than merely unlikely, the same
        // reasoning `stillFullyCurrent()` itself already applies to
        // state/head/held/ timeline.
        async function proveCiGreen(): Promise<
          { ok: true } | { ok: false; reason: string }
        > {
          const checks = await ghCall([
            "api",
            "--paginate",
            "--slurp",
            `repos/{owner}/{repo}/commits/${a.sha}/check-runs?per_page=100`,
          ]);
          if (checks.code !== 0) {
            return { ok: false, reason: "cannot read check-runs" };
          }
          let runs: ReturnType<typeof parseCheckRuns>;
          try {
            runs = parseCheckRuns(JSON.parse(checks.stdout) as unknown);
          } catch {
            runs = null;
          }
          if (runs === null) {
            return { ok: false, reason: "check-runs are malformed" };
          }
          const [allRuns, statuses] = await Promise.all([
            checkRunsFor("{owner}", "{repo}", a.sha),
            commitStatusesFor("{owner}", "{repo}", a.sha),
          ]);
          if (allRuns === null || statuses === null) {
            return { ok: false, reason: "cannot read complete CI evidence" };
          }
          const apps = policy.requiredApps;
          const attributed =
            settledHold !== null
              ? statuses
              : await attributeStatuses(
                  "{owner}",
                  "{repo}",
                  a.sha,
                  statuses,
                  requirementsWithoutRun(
                    runs,
                    policy.requiredChecks,
                    a.sha,
                    apps,
                  ).flatMap((r) => (r.appId === undefined ? [] : [r.context])),
                );
          if (attributed === null) {
            return {
              ok: false,
              reason: "cannot read commit status publishers",
            };
          }
          const requiredFresh =
            settledHold !== null
              ? completedRequiredCi(
                  runs,
                  policy.requiredChecks,
                  a.sha,
                  settledHold.createdAt,
                  true,
                  settledHold.checkRunWatermark,
                  settledHold.source === "external",
                  false,
                  { apps },
                )
              : completedRequiredCi(
                  runs,
                  policy.requiredChecks,
                  a.sha,
                  undefined,
                  true,
                  0,
                  false,
                  policy.holdLabel === null,
                  { apps, statuses: attributed },
                );
          if (!requiredFresh) {
            return {
              ok: false,
              reason:
                "the required checks have not all succeeded on this head since the hold was last released",
            };
          }
          const verdict = ciVerdictOf(allRuns, statuses, false, a.sha);
          if (verdict !== "green") {
            return {
              ok: false,
              reason: `final non-reviewer CI is '${verdict}'`,
            };
          }
          // Branch protection names no check, and with nothing registered
          // on the head the verdict above reads green.
          if (
            policy.requiredChecks.length === 0 &&
            policy.derived &&
            !hasNonReviewerCi(allRuns, statuses)
          ) {
            return { ok: false, reason: "no CI has registered on this head" };
          }
          return { ok: true };
        }
        const initialCi = await proveCiGreen();
        if (!initialCi.ok) {
          fail(4, `set-verified: ${initialCi.reason}`);
        }
        // ONE predicate for "is the PR still exactly what we verified", called
        // identically before AND after the write below — a compensating
        // post-write check that asked a NARROWER question than its pre-write
        // counterpart (state/head/held only, no timeline re-check) let a human
        // remove/re-add/remove `ci:hold` between `readTimeline()` and the write
        // leave `verifiedSha` set over a superseded transition that `ci-hold.ts
        // final-ready` would now reject. Sharing one implementation makes that
        // drift impossible rather than merely unlikely. Delegates CI freshness
        // to `proveCiGreen()` above for the same reason.
        //
        // CI proof FIRST, PR/timeline snapshot LAST — the opposite order
        // this function used before, matching the reorder `ci-hold.ts`'s
        // `stillCurrentForFinalReady()` already applies for the identical
        // reason. Narrower
        // benefit here than there, and worth stating precisely rather than
        // overclaiming: the POST-write call already has nothing checking
        // it, so for THAT call this only avoids a doomed extra network
        // round trip. The PRE-write call is where the reorder earns its
        // keep — it stops `store.update()` below from ever writing a
        // certificate this same function's own compensating post-write
        // check would immediately have to clear again; a black-box CLI
        // test cannot observe that difference (the FINAL exitCode/
        // verifiedSha end up identical either way, since the post-write
        // check catches whatever the pre-write check misses), but a reader
        // of `verified` in the narrow window between the write and that
        // clear genuinely could.
        async function stillFullyCurrent(): Promise<
          { ok: true } | { ok: false; reason: string }
        > {
          const ci = await proveCiGreen();
          if (!ci.ok) return ci;
          const timeline = await readTimeline();
          if (
            timeline === null ||
            (expectedTransition === null
              ? timeline.length !== 0
              : timeline.at(-1)?.id !== expectedTransition)
          ) {
            return { ok: false, reason: `${holdLabelName()} changed` };
          }
          const live = await ghCall([
            "pr",
            "view",
            pr,
            "--json",
            "state,headRefOid,labels",
          ]);
          let snap: ReturnType<typeof parsePrSnapshot> = null;
          if (live.code === 0) {
            try {
              snap = parsePrSnapshot(
                JSON.parse(live.stdout) as unknown,
                holdLabel(),
              );
            } catch {
              snap = null;
            }
          }
          if (snap?.state !== "OPEN" || snap.head !== a.sha || snap.held) {
            return {
              ok: false,
              reason: `PR state, head, or ${holdLabelName()} changed`,
            };
          }
          return { ok: true };
        }
        const preWrite = await stillFullyCurrent();
        if (!preWrite.ok) {
          fail(
            4,
            `set-verified: ${preWrite.reason} while final evidence was read`,
          );
        }
        await store.update((s) => {
          if (JSON.stringify(s.ciHold) !== JSON.stringify(current.ciHold)) {
            fail(
              4,
              `set-verified: ${holdLabelName()} changed before verification commit`,
            );
          }
          return { ...s, verifiedSha: a.sha };
        });
        // The write above cannot be made atomic with a remote read — GitHub's
        // REST API has no compare-and-swap. A push, ci:hold re-add, or
        // remove/re-add/remove landing in the narrow window between the
        // pre-write check above and this write would otherwise leave
        // `verifiedSha` certifying a head or transition that is no longer
        // current, invisible to every later reader of this pointer
        // (round-plan.ts's Testbox decay, the handoff header). Close it with
        // a compensating check-and-clear immediately after the write instead.
        const postWrite = await stillFullyCurrent();
        if (!postWrite.ok) {
          await store.update((s) =>
            s.verifiedSha === a.sha ? { ...s, verifiedSha: "" } : s,
          );
          fail(
            4,
            `set-verified: ${postWrite.reason} immediately after the verification commit; certificate cleared`,
          );
        }
        // Global CI verification landed — stamped only here, AFTER both the
        // pre-write and post-write `stillFullyCurrent()` checks passed, never
        // on the earlier `verifiedSha` write above: that write is provisional
        // (the compensating clear a few lines up can still undo it), and a
        // stamp made before the outcome is known would record "progress" for a
        // certificate this same call goes on to revoke. Phased `'ci-verified'`,
        // NOT `'push-landed'` — this call proves an ALREADY-pushed SHA is
        // globally green; it pushes nothing itself, unlike `stamp-held`'s use
        // of `'push-landed'` above, which genuinely does run strictly after a
        // real push (the two calls shared one label that was only accurate for
        // one of them).
        await store.update((s) => withProgress(s, "ci-verified", new Date()));
        return 0;
      } finally {
        if (remoteHeartbeat !== null) clearInterval(remoteHeartbeat);
        remoteLock?.release();
        remoteLock?.dispose();
      }
    }

    case "ready-marked": {
      process.stdout.write(`${store.read().state.readyMarkedRound}\n`);
      return 0;
    }

    // The draft→Ready transition's commands (claim, renew, commit, release).
    // The CLAIM and the RECORD are different facts, and collapsing them into
    // one field made each one lie about the other.
    //
    // The collapsed version set `readyMarkedRound` before `gh pr ready` and
    // cleared it on an ordinary failure. Against a second driver that order is
    // right — two drivers must not both fire `ready_for_review`, which is what
    // re-triggers paid external review of a head that already had it. Against a
    // CRASH it is wrong in the worst available direction: a process killed
    // between the claim and the call left the field non-zero forever, so every
    // future invocation answered `already-marked` without ever asking GitHub,
    // and the PR stayed a draft nothing would ever mark. An ordinary-failure
    // release does not help — a crash runs no failure branch by definition.
    //
    // So the claim is a LEASE on the filesystem (`readyClaimPath`, the same
    // primitive and the same staleness window as the held-batch claims) and
    // `readyMarkedRound` is written only AFTER the event fires. Each says only
    // what it can prove: the lease says "someone is attempting this right now"
    // and expires by itself if that someone dies; the field says "the event
    // genuinely fired", which no crash can fabricate.
    case "claim-ready-mark": {
      // Committed already? Then there is nothing to claim, and this is the
      // answer the human-conversion case depends on: a PR someone converted
      // BACK to draft after this drive marked it must not be re-marked, ever.
      if (store.read().state.readyMarkedRound !== 0) {
        process.stdout.write("already\n");
        return 0;
      }
      // The pre-emption this command's re-check below defends against, made
      // reachable. The gap between the read above and the `claimCreate` below
      // is microseconds in practice and unbounded in principle, and NOTHING
      // else in a single-process test can land inside it — so without this
      // hook the re-check is code no probe can turn red, which is exactly the
      // state that let the CAS go untested for two rounds. Same cap and
      // validation as every other hook here.
      const claimStall = testDelaySeconds(
        "DRIVE_PR_CLAIM_READY_TEST_DELAY",
        "claim-ready-mark",
      );
      const claimSignal = process.env.DRIVE_PR_CLAIM_READY_TEST_SIGNAL;
      if (claimSignal) writeFileSync(claimSignal, "");
      if (claimStall > 0) await sleep(claimStall);
      const path = readyClaimPath(store.stateDir, pr);
      const tok = newClaimToken();
      if (!claimCreate(path, tok)) {
        // `claimCreate` swallows the reason it failed, and exactly one of the
        // two possible reasons means "someone else has it". A create that
        // failed with nothing at the path — an unwritable state directory, a
        // full disk — is an ERROR, and answering `already` to it would tell
        // the caller a driver it could wait for exists when none does, then
        // spend the lock timeout discovering the same thing again below.
        if (!existsSync(path)) {
          fail(
            1,
            `claim-ready-mark: cannot create PR #${pr}'s ready-mark lease at ${path}.`,
            "Nothing is at that path, so this is not another driver holding it — the state",
            "directory is unwritable. Refusing to report contention that does not exist.",
          );
        }
        if (claimIsLive(path)) {
          // Another driver is mid-transition. Theirs to finish — and if they
          // die instead, the lease goes stale and the next caller takes it.
          process.stdout.write("already\n");
          return 0;
        }
        // Stale — abandoned by a driver that died between claiming and
        // firing. Breaking it needs the true mutex, never another snapshot:
        // see `tryBreakStaleClaim` for why three attempts at approximating
        // one all reproduced a double winner.
        if (!(await tryBreakStaleClaim(path, store.lock))) {
          process.stdout.write("already\n");
          return 0;
        }
        if (!claimCreate(path, tok)) {
          process.stdout.write("already\n");
          return 0;
        }
        console.error(
          `claim-ready-mark: broke an abandoned ready-mark claim (>${claimStaleMin()}m old) on PR #${pr} — its driver died before 'gh pr ready' landed.`,
        );
      }
      // RE-CHECK after winning the lease.
      // The read above and `claimCreate` are not one atomic step: a caller can
      // read `readyMarkedRound === 0`, be pre-empted for arbitrarily long, and
      // only resume after some OTHER caller has fully committed AND removed
      // its lease — at which point THIS caller's `claimCreate` succeeds
      // against the now-vacant path even though the transition already
      // happened. The commit that made it happen strictly happens-before the
      // remove that freed the path (same process, program order), which
      // strictly happens-before this `claimCreate` could ever succeed, so a
      // plain re-read of `readyMarkedRound` here is guaranteed to observe it —
      // no lock required for THAT half.
      //
      // The cleanup that follows is a second half, and IS lock-protected: this
      // caller can itself be suspended between winning the lease above and
      // reaching this point, long enough for its own claim to go stale and be
      // replaced by a THIRD caller's fresh generation. An unconditional
      // `removeClaimFile` here would then delete that generation, not the one
      // this caller ever owned — the exact cross-generation delete
      // `commit-ready-mark`/`release-ready-mark` already guard against, reached
      // through the one cleanup path that hadn't been.
      if (store.read().state.readyMarkedRound !== 0) {
        await store.locked(async () => {
          if (claimTokenMatches(path, tok)) removeClaimFile(path);
        });
        process.stdout.write("already\n");
        return 0;
      }
      process.stdout.write(`claimed ${tok}\n`);
      return 0;
    }

    // Prove the lease is STILL ours, and reset its clock, immediately before
    // the outbound `gh pr ready`.
    //
    // Winning a lease and firing the event are two moments, and everything
    // between them is this process's own runtime — which can be suspended for
    // arbitrarily long (a laptop sleeping is the ordinary case, not the exotic
    // one). Past `$DRIVE_PR_CLAIM_STALE_MIN` another driver may legitimately
    // reclaim the lease and fire the event itself, while this process resumes
    // believing it holds a lease that is now someone else's and fires a second
    // `ready_for_review` — the duplicate paid review the lease exists to
    // prevent, reached by the one path the lease alone cannot see.
    //
    // Verify-and-renew rather than verify alone, because a check on its own
    // leaves the same hole one call later: the lease could be seconds from
    // stale when it passes, and `gh pr ready` still has `$GH_CALL_TIMEOUT` to
    // run. Resetting mtime here buys a FULL staleness window for a call
    // bounded inside it, so the reclaim cannot land mid-dispatch.
    //
    // "Bounded inside it" is a RELATION BETWEEN TWO INDEPENDENT KNOBS, so it
    // is checked rather than assumed.
    // `DRIVE_PR_CLAIM_STALE_MIN=1` with `GH_CALL_TIMEOUT=120` lets the lease
    // become reclaimable while the very call it is protecting is still
    // running — a second driver reclaims, fires, and the first request may
    // land too. Neither knob knows about the other, and the renewal cannot
    // make the guarantee its own comment claims when they contradict, so this
    // refuses instead of renewing into a window it cannot cover.
    //
    // It does not make the sequence atomic — nothing can, since the event
    // happens on GitHub — but it converts an unbounded exposure (however long
    // this process was suspended) into one bounded by a deadline the driver
    // sets, which is the same trade every other outbound call here makes.
    case "renew-ready-mark": {
      if (a.token === "") fail(2, "renew-ready-mark requires --token T");
      const staleMs = claimStaleMin() * 60_000;
      // `ghCall` does not settle AT `$GH_CALL_TIMEOUT` — it SIGTERMs there and
      // waits `KILL_ESCALATE_MS` more before force-killing and returning.
      // Comparing the staleness window only against the timeout let
      // `DRIVE_PR_CLAIM_STALE_MIN=1` / `GH_CALL_TIMEOUT=59` pass (`60 > 59`)
      // while the protected call could still be in flight for ~61s —
      // reclaimable and running at once.
      const callMs = ghCallTimeoutSeconds() * 1000 + KILL_ESCALATE_MS;
      if (staleMs <= callMs) {
        fail(
          2,
          `renew-ready-mark: the staleness window (${staleMs}ms, $DRIVE_PR_CLAIM_STALE_MIN=${claimStaleMin()}m) does not`,
          `exceed one outbound call's worst-case deadline (${callMs}ms — $GH_CALL_TIMEOUT=${ghCallTimeoutSeconds()}s`,
          `plus its ${KILL_ESCALATE_MS}ms kill-escalation grace), so no renewal can keep this lease live`,
          "for the whole of the 'gh pr ready' it is protecting.",
          "Another driver could reclaim it mid-call and fire the same event. Raise",
          "$DRIVE_PR_CLAIM_STALE_MIN or lower $GH_CALL_TIMEOUT — refusing rather than",
          "renewing into a window this configuration cannot cover.",
        );
      }
      const path = readyClaimPath(store.stateDir, pr);
      // Locked for the same reason `commit-ready-mark` is: a bare
      // check-then-touch can renew a lease that a stale-claim recovery
      // replaced in between, handing this caller a fresh clock on a file it
      // no longer owns.
      return store.locked(async () => {
        if (!claimTokenMatches(path, a.token)) {
          fail(
            1,
            `renew-ready-mark: PR #${pr}'s ready-mark lease is no longer yours (token mismatch, or it is gone).`,
            "Another driver reclaimed it — most likely this process was suspended past",
            `the staleness window (>${claimStaleMin()}m). Do NOT fire 'gh pr ready': that`,
            "driver may have already done so, and firing again re-triggers paid review.",
          );
        }
        const now = new Date();
        utimesSync(path, now, now);
        return 0;
      });
    }

    case "commit-ready-mark": {
      // Called ONLY after `gh pr ready` has actually succeeded (or after a
      // reconciliation proved the PR is no longer a draft). This is the write
      // that makes the transition permanent, and the token is what proves the
      // caller is the one that holds the lease.
      //
      // The recorded value is floored at 1 because 0 is the "never" sentinel:
      // a transition made before any round has been counted (a drive that
      // converges on its first gate, having pushed nothing) would otherwise
      // record a mark indistinguishable from no mark, and the next driver
      // would mark the PR Ready a second time.
      if (a.token === "") fail(2, "commit-ready-mark requires --token T");
      const path = readyClaimPath(store.stateDir, pr);
      // The token CHECK, the durable WRITE, and the lease REMOVAL are one
      // atomic step under the per-PR lock — the same reasoning `unclaim-held`
      // already documents for its own check-then-remove: without the lock, an
      // owner returning right at the edge of the staleness window can pass the
      // token check against its own still-on-disk (but now stale) file, then
      // have a DIFFERENT driver legitimately break that same stale claim and
      // create a fresh one for itself in the gap before this call's own removal
      // runs — which then deletes the FRESH claimant's file, not the one this
      // caller ever owned, corrupting that claimant's bookkeeping even though
      // nothing it did was wrong. `store.locked` also serialises this against
      // `tryBreakStaleClaim`'s own lock hold, so no reclaim can land mid-way
      // through this sequence.
      return store.locked(async () => {
        if (!claimTokenMatches(path, a.token)) {
          fail(
            1,
            `commit-ready-mark: PR #${pr}'s ready-mark claim is not yours (token mismatch, or the claim is gone).`,
            "Refusing to record a transition on a lease this process does not hold —",
            "another driver may have reclaimed it after this one went stale.",
          );
        }
        const { state } = store.read();
        const next: DriveState = {
          ...state,
          readyMarkedRound: Math.max(state.rounds, state.attempts, 1),
        };
        store.write(next);
        removeClaimFile(path);
        await store.renderHandoff(next);
        return 0;
      });
    }

    case "release-ready-mark": {
      // Give the lease back without recording anything — for a transition that
      // was attempted and did NOT land, so the next round retries immediately
      // rather than waiting out the staleness window.
      //
      // It deliberately does NOT touch `readyMarkedRound`: with the claim
      // split off, that field is only ever written by a confirmed success, so
      // there is no longer any such thing as a mark to roll back. `--token` is
      // checked when given and the release is unconditional when it is not,
      // which is what makes this usable as the by-hand escape for a lease
      // whose owner is gone.
      //
      // Lock-protected for the same reason `commit-ready-mark` is: an unlocked
      // check-then-remove can delete a DIFFERENT driver's fresh reclaim of a
      // lease that went stale between this call's own check and its removal.
      const path = readyClaimPath(store.stateDir, pr);
      return store.locked(async () => {
        if (a.token !== "" && !claimTokenMatches(path, a.token)) {
          fail(
            1,
            `release-ready-mark: PR #${pr}'s ready-mark claim is not yours (token mismatch, or the claim is gone).`,
          );
        }
        removeClaimFile(path);
        return 0;
      });
    }

    case "park": {
      if (a.key === "")
        fail(
          2,
          "park requires --key (a thread node id or finding fingerprint)",
        );
      // A key carrying CR or LF is not one key. `parked-keys` emits keys
      // newline-delimited and drive-status splits that output on LF, so
      // `PRRT_x<LF>PRRT_unrelated` parks ONE item and yields TWO match tokens
      // — the second suppressing live work nobody parked, which is the
      // opposite of what parking is for and is invisible in the state file's
      // own shape. The channel is line-delimited, so the constraint belongs on
      // what may enter it.
      if (/[\n\r]/.test(a.key)) {
        fail(
          2,
          "park: --key may not contain a newline or carriage return.",
          "parked-keys is a line-delimited channel, so such a key becomes TWO",
          "match tokens and the extra one suppresses work nobody parked.",
        );
      }
      if (a.kind !== "thread" && a.kind !== "finding")
        fail(2, `park requires --kind thread|finding (got '${a.kind}')`);
      if (a.reason === "")
        fail(
          2,
          "park requires --reason — a parked item with no framed decision is not a checkpoint, it is a dropped finding",
        );
      const kind = a.kind;
      await store.update((s) => ({
        ...s,
        parked: [
          ...s.parked.filter((p) => p.key !== a.key),
          {
            key: a.key,
            kind,
            reason: a.reason,
            round: s.rounds,
            at: new Date().toISOString(),
          },
        ],
      }));
      await mirrorLedger(pr, store);
      return 0;
    }

    case "unpark": {
      if (a.key === "") fail(2, "unpark requires --key");
      await store.update((s) => ({
        ...s,
        parked: s.parked.filter((p) => p.key !== a.key),
      }));
      return 0;
    }

    case "parked-keys": {
      for (const p of store.read().state.parked)
        process.stdout.write(`${p.key}\n`);
      return 0;
    }

    case "hold": {
      if (a.key === "")
        fail(
          2,
          "hold requires --key (a thread node id or finding fingerprint)",
        );
      // The SAME newline ban `park` applies, and for the same mechanical
      // reason: `held-keys` is a line-delimited channel too, so an embedded LF
      // holds ONE item and emits TWO tokens, the second of which resolves a
      // thread nobody held. The validator in
      // schema.ts restates this rather than inventing a weaker one.
      if (/[\n\r]/.test(a.key)) {
        fail(
          2,
          "hold: --key may not contain a newline or carriage return.",
          "held-keys is a line-delimited channel, so such a key becomes TWO match",
          "tokens and the extra one releases work nobody held.",
        );
      }
      if (a.kind !== "thread" && a.kind !== "finding")
        fail(2, `hold requires --kind thread|finding (got '${a.kind}')`);
      // Only the FIX-DEPENDENT outcomes are ever held. `rejected`, `wont-fix`
      // and `deferred` are claims about the finding's MERIT, which no later
      // commit changes, so they are replied to AND resolved in the same step
      // and there is nothing to carry across the push. Recording one here
      // would leave a thread that is already resolved sitting in a batch a
      // later round tries to resolve again. The vocabulary is canonical in
      // /resolve-review-comments § 3; this is the subset of it that has a
      // waiting period, not a second taxonomy.
      if (a.outcome !== "accepted" && a.outcome !== "moot") {
        fail(
          2,
          `hold requires --outcome accepted|moot (got '${a.outcome}')`,
          "Those are the only outcomes whose reply must wait on a push. rejected /",
          "wont-fix / deferred are answered and resolved in the same step.",
        );
      }
      // The kind decides which script releases it, so it is recorded rather
      // than re-derived: a thread is resolved with resolve-held-thread.ts
      // --pushed-sha (never the raw resolve-thread.ts, which has no
      // notion of which push justifies the resolve), a summary finding is
      // answered with answer-summary-finding.ts --pushed-sha. A successor that
      // has to guess picks wrong on one of them.
      //
      // A `finding` also needs its REASON persisted, and a `thread` does not —
      // asymmetric because the two kinds are at different points in their own
      // lifecycle by hold time. A thread's reply is already posted to GitHub
      // (the `reply-to-thread.ts` call that precedes this one put it there),
      // so the text survives independently of this state file. A finding's is
      // not: the only place `answer-summary-finding.ts --pushed-sha` can
      // legally run is step 6, after the push — so at hold time nothing has
      // been posted yet, and the reasoning exists nowhere but the triaging
      // agent's own context. Losing that context (the exact crash this batch
      // exists to survive) would leave a successor an outcome with nothing to
      // explain it.
      //
      // Read from STDIN, not a `--reason` argument like `park` uses: this text
      // is the verbatim reply body headed for `answer-summary-finding.ts`'s
      // own stdin, i.e. the same class of arbitrary reviewer-adjacent prose
      // (quotes, backticks, `$(...)`) that hardened that script's
      // body handling against — a shell argument would let a caller's OWN
      // quoting evaluate those before this script ever saw them. `park`'s
      // reason is short, agent-authored decision framing, not reply prose; the
      // two are not the same risk class.
      let heldReason: string | undefined;
      if (a.kind === "finding") {
        const body = await readStdinAll();
        if (body === "") {
          fail(
            2,
            "hold --kind finding requires the reason body on stdin — it is what",
            "step 6 pipes to 'answer-summary-finding.ts --pushed-sha' once the push",
            "lands, and there is nowhere else it survives a crash until then.",
          );
        }
        heldReason = body;
      }
      const kind = a.kind;
      const outcome = a.outcome;
      // `--comment-url` is REQUIRED for `--kind thread` on BOTH paths (below)
      // — the qualifying comment's own permalink. A `finding` is exempt: it is
      // unanchored, summary-only text with no single GitHub comment to point
      // at, answered via `answer-summary-finding.ts` instead.
      //
      // Every caller of `hold --kind thread` always HAS one available: a live
      // pass either just posted a fresh reply via `reply-to-thread.ts` (which
      // prints the new comment's url) or is re-holding one it read off
      // `list-unresolved-threads.ts`'s own `.comments[].url` field — so this
      // is a real requirement, not a theoretical one with no answer.
      if (kind === "thread" && a.commentUrl === "") {
        fail(
          2,
          "hold --kind thread requires --comment-url — the qualifying comment's",
          "own permalink (from reply-to-thread.ts's printed url, or from",
          "list-unresolved-threads.ts's .comments[].url), so a later superseding",
          "comment — confirmed hold or not, same outcome word or not — is",
          "distinguishable from the one this hold represents.",
        );
      }
      // The inverse of the check above: `--comment-url` and `--unconfirmed`
      // are both THREAD-only concepts. A finding has no single GitHub comment
      // to point at — persisting a URL for one contradicts the state
      // contract's own invariant that the field is absent for `kind:
      // 'finding'`. `--unconfirmed` is worse than a no-op: it writes `round:
      // -1`, but a finding's claim protocol (`claim-held --kind finding` /
      // `unclaim-held`) is a filesystem mutex with no round-based recovery
      // path — nothing re-holds a stranded round -1 finding the way a live
      // pass's step 3 re-holds a thread, so an accidental invocation would
      // strand it indefinitely.
      if (kind === "finding" && (a.unconfirmed || a.commentUrl !== "")) {
        fail(
          2,
          "hold --kind finding does not accept --comment-url or --unconfirmed —",
          "both are thread-only. A finding has no single comment to point at, and",
          "its claim protocol has no round-based recovery for an unconfirmed entry.",
        );
      }
      const commentUrl = a.commentUrl;
      // WHICH driver is promising this fix. Derived, never passed
      // in: a caller that could name its own actor could name someone else's,
      // and the whole value of the field is that two concurrent drivers cannot
      // be confused for each other. `stamp-held` stamps only the holds
      // carrying this value, so a hold created here can only ever be vouched
      // for by a push THIS working tree made.
      //
      // Resolved before the update rather than inside the transform because
      // the transform is synchronous and runs under the lock — shelling out to
      // git there would hold the mutex across a subprocess.
      const actor = await resolveActor();
      // `--unconfirmed` exists for exactly ONE caller:
      // reconcile-replied-threads.ts, re-holding a reply it found already
      // posted rather than one a live pass just confirmed by reading the fix
      // into the tree. The ordinary upsert below stamps `round: s.rounds`
      // UNCONDITIONALLY — correct for a live pass's own step-3 triage, which
      // only calls this after confirming the promised fix, so refreshing round
      // is exactly what SKILL.md § 6 says makes that verification pass a
      // moment later. A caller with no such confirmation must not grant that
      // same round-currency: doing so let a stale, never-verified
      // `**accepted**` reply ride an UNRELATED later push's `stamp-held` to
      // a false resolve — round and `.verifiedSha` both matched, because
      // neither is scoped to which specific hold's fix that push actually
      // contained. `round: -1` can never
      // equal a real `.rounds` (bump-round only ever increments from 0), so
      // `claim-held`'s round-equality check refuses it deterministically until
      // a live pass's step 3 finds the same qualifying reply and re-holds it
      // for real — the confirm-then-re-hold path this was always supposed to
      // go through.
      //
      // Insert-if-absent BY (key, outcome, commentUrl) — EXACT equality, no
      // leniency for a missing commentUrl on either side: if the key is already
      // held representing the SAME comment, its existing round is left
      // untouched — a held item midway through a real pass's own confirmed
      // workflow must not be quietly downgraded by a standalone sweep running
      // concurrently. If a NEWER comment now qualifies — whether it changed the
      // outcome word or merely restates a different promise under the SAME one
      // — the stale entry (confirmed OR unconfirmed) is replaced with a fresh
      // unconfirmed one at round -1 rather than left standing. Outcome-only
      // comparison left this open for a superseding same-outcome reply;
      // treating an absent commentUrl as an automatic match (an earlier version
      // of this fix) left it open specifically for a LIVE-PASS-CONFIRMED hold,
      // since the ordinary path never recorded one — closed now that BOTH paths
      // require and record it.
      if (a.unconfirmed) {
        await store.update((s) =>
          (s.held ?? []).some(
            (h) =>
              h.key === a.key &&
              h.outcome === outcome &&
              h.commentUrl === commentUrl,
          )
            ? s
            : {
                ...s,
                held: [
                  ...(s.held ?? []).filter((h) => h.key !== a.key),
                  {
                    key: a.key,
                    kind,
                    outcome,
                    round: -1,
                    commentUrl,
                    actor,
                    ...(heldReason === undefined ? {} : { reason: heldReason }),
                  },
                ],
              },
        );
        return 0;
      }
      // A `finding`'s claim file lives OUTSIDE `.held` (a separate filesystem
      // mutex), so re-holding the state record alone leaves a prior
      // dispatch's claim file standing. `stamp-held` refuses to stamp a held
      // item while its claim file exists (see that case's own comment) — so an
      // un-cleared stale one would make the fresh record permanently
      // unstampable, defeating the exact "re-hold via § 3" recovery this
      // command exists to provide.
      //
      // Only a STALE claim is broken, via the same DECISION `claim-held`
      // itself uses — never a LIVE one: a live claim means another driver is
      // genuinely mid-dispatch on this key right now, and clearing its claim
      // file out from under it would let that driver's eventual
      // `release-held --token T` fail and risk a second dispatch, exactly the
      // race the claim file exists to prevent. Refuse instead, so the operator
      // waits for the claim to be released or to age out.
      //
      // The staleness check/break and the held-record replacement below both
      // run inside ONE hold of the per-PR lock (`store.locked`, not
      // `tryBreakStaleClaim` + a separate `store.update`) — every sibling
      // coordination command (`claim-held` both kinds, `unclaim-held`,
      // `release-held`, `stamp-held`'s own claim-file check) already folds
      // its decision and its state mutation into a single lock hold; `hold`
      // was the last one that did not. Splitting them left a window: a
      // `claim-held --kind finding` could create its own fresh claim file and
      // take the lock BETWEEN this decision and the later `store.update`,
      // validate against the OLD (pre-replacement) record, and let its
      // caller's external dispatch proceed to POST an answer for a promise
      // this command was about to overwrite — leaving `held` holding a fresh,
      // unstamped record nothing would ever re-surface (`summary-
      // findings.ts`'s `unaddressed` already excludes the now-answered
      // fingerprint), a permanently orphaned entry silently blocking
      // convergence. Use
      // `breakStaleClaimLocked`, not `tryBreakStaleClaim`, inside this hold:
      // the per-PR lock is not reentrant (`lock.ts`'s `acquire` retries its
      // own `mkdir` until it wins or times out), so the acquiring variant
      // would spin to `$DRIVE_PR_LOCK_TIMEOUT` and exit 1 rather than
      // deadlocking visibly.
      await store.locked(async () => {
        if (kind === "finding") {
          const claimPath = claimPathFor(store.stateDir, pr, a.key);
          if (existsSync(claimPath) && !breakStaleClaimLocked(claimPath)) {
            fail(
              1,
              `hold: '${a.key}' has a LIVE claim — another driver appears to be`,
              "dispatching it right now. Re-holding underneath an in-flight dispatch",
              "would let this record and that dispatch disagree about which push",
              `answers it. Wait for the claim to be released, or to go stale (>${claimStaleMin()}m),`,
              "and retry.",
            );
          }
        }
        // A fresh record every time, carrying NO `verifiedSha` — re-holding a
        // key clears whatever push a previous hold of it had been stamped
        // with. That is the point rather than a side effect: the promise
        // this reply makes is about a fix that is not pushed yet, so the
        // only push that may answer it is one that comes AFTER this call.
        // Carrying the old stamp forward would let a re-hold inherit
        // provenance from a push that predates the promise it now
        // represents.
        const { state } = store.read();
        const next: DriveState = {
          ...state,
          held: [
            ...state.held.filter((h) => h.key !== a.key),
            {
              key: a.key,
              kind,
              outcome,
              round: state.rounds,
              ...(commentUrl === "" ? {} : { commentUrl }),
              actor,
              ...(heldReason === undefined ? {} : { reason: heldReason }),
            },
          ],
        };
        store.write(next);
        await store.renderHandoff(next);
      });
      return 0;
    }

    case "held": {
      process.stdout.write(`${JSON.stringify(store.read().state.held)}\n`);
      return 0;
    }

    case "held-keys": {
      for (const h of store.read().state.held)
        process.stdout.write(`${h.key}\n`);
      return 0;
    }

    // Call BEFORE dispatching a held item's external mutation. Both kinds make
    // the SAME provenance check — `--pushed-sha` must equal the item's own
    // `verifiedSha` — and differ only in what else they do with the
    // batch.
    //
    // `--kind thread` is a compare-and-delete: the check and the removal in one
    // lock hold. `--kind finding` is a per-key filesystem mutex that does NOT
    // remove the item, because a finding's dispatch and its release are
    // separate steps. Exclusivity is what findings needed on top of provenance:
    // two concurrent drivers reading the same `held` snapshot could both decide
    // to dispatch the same finding, and `answer-summary-finding.ts` posts a NEW
    // top-level comment on every call — not idempotent like a thread's resolve.
    // `release-held` removes a claimed finding afterward, once the dispatch
    // actually succeeded.
    //
    // The finding branch did NOT always make the provenance check, and the
    // reasoning that left it out is worth naming so it is not reinstated:
    // `answer-summary-finding.ts --pushed-sha` verifies that SHA against the
    // PR's live head and this worktree's clean HEAD, which reads like a
    // provenance check and is not one — every current pushed head satisfies
    // it, including a concurrent driver's. That left the finding path with no
    // round check and no provenance check at all.
    //
    // Exit codes are NOT interchangeable — SKILL.md § 6 documents the
    // caller-facing contract in full, restated here so this comment cannot
    // drift out of sync with it: 1 = USUALLY someone else's claim/hold is
    // still live, or `--pushed-sha` is not the push recorded against this
    // item (either kind), or its round no longer matches (thread) — safe to
    // skip only this key while the rest of the current `held` read stays
    // trustworthy — but for `--kind finding` this same exit also fires when
    // the coordination lock itself could not be acquired, a batch-level
    // fault, not per-key contention; a caller that sees 1 recur across
    // several different keys in one pass should stop and inspect rather than
    // keep skipping; 2 = a usage error (bad flags, or the item's actual kind
    // does not match `--kind`); 3 = the state file itself could not be read
    // — not a per-key problem, stop the round entirely; 4 = (finding only)
    // the key is not (or no longer) in the held batch at all — the snapshot
    // the caller is iterating is stale, so it must re-read `held` before
    // trusting anything else in it.
    //
    // resolve-held-thread.ts's predecessor read `held` and `rounds` as two
    // separate, unlocked calls,
    // decided the item was resolvable, and only THEN called the GraphQL
    // mutation — a window in which a concurrent driver could re-hold, release,
    // or advance the round on the same key, so the resolve went ahead against
    // state that had already changed. Folding "is
    // this item still exactly what the hold promised" and "remove it" into one
    // lock hold closes that: two concurrent claims on the same key can never
    // both see it present, and neither can act on a round/SHA pair the other
    // has since replaced.
    //
    // The predicate is BOTH provenance checks resolve-held-thread.ts needs —
    // round equality AND `item.verifiedSha == --pushed-sha`.
    // Round equality alone does not prove the live push is the one the reply
    // promised: the round only advances when a COUNTING drive-status gate
    // runs, so an unrelated push that lands without one leaves rounds equal
    // while never having been the push this hold was waiting on. The stamp
    // closes that, because it is written by exactly one call site (SKILL.md
    // § 6's `stamp-held`, immediately after a real `guarded-push.ts`) and so
    // cannot name a SHA that never went through validate → push →
    // stamp-held.
    //
    // The stamp is read off the ITEM, not off `state.verifiedSha`.
    // The PR-global field is moved by whichever driver pushed last, and this
    // state file is shared by every driver working the PR — so on the
    // concurrent-driver case Conductor makes ordinary, it vouched for holds
    // whose fix the push never contained: driver A holds a thread and stalls
    // before pushing, driver B pushes unrelated work and calls `stamp-held`
    // without a counting gate (so `.rounds` does not move either), A's tree
    // later syncs to B's head, and every check here passed. `stamp-held`
    // stamps only the holds created by the tree that calls it, so the item's
    // own field answers "was this hold's promised fix in that push", which is
    // the question actually being asked.
    //
    // Deliberately NOT the only gate: resolve-held-thread.ts calls this LAST,
    // after confirming --pushed-sha is the PR's live head, this worktree's
    // clean HEAD. Ordering it that way means a claim failure here never needs
    // to restore anything (nothing was removed yet on any earlier check), and
    // a claim SUCCESS only ever precedes an actual attempt to resolve.
    case "claim-held": {
      if (a.key === "")
        fail(
          2,
          "claim-held requires --key (a held item's thread node id or finding fingerprint)",
        );
      if (a.kind === "finding") return claimFinding();
      if (a.kind !== "thread") {
        fail(
          2,
          `claim-held requires --kind thread|finding (got '${a.kind === "" ? "<empty>" : a.kind}')`,
        );
      }
      if (a.pushedSha === "")
        fail(2, "claim-held --kind thread requires --pushed-sha");
      return store.locked(async () => {
        // Test-only concurrency hook, both unset (no-op) by default. Proving
        // two concurrent `claim-held` calls on the same key can never both
        // succeed needs a way to FORCE the overlap deterministically — two
        // calls merely launched close together race real process-scheduling
        // jitter and, on a fast/idle machine, may simply run one after the
        // other without ever contending for the lock, which asserts nothing
        // about the mutex itself. `$DRIVE_PR_CLAIM_HELD_TEST_SIGNAL` is
        // touched the instant the lock is held, so a test can block a second
        // process until this one is DEFINITELY holding it;
        // `$DRIVE_PR_CLAIM_HELD_TEST_DELAY` then holds the lock open for that
        // long, giving the second process's own lock attempt a guaranteed
        // window in which it must wait rather than merely might.
        //
        // These hooks are live in the shipped script, not stripped for
        // production — `testDelaySeconds` owns the validation and the hard cap
        // every one of them shares, and validates BEFORE the signal fires: a
        // rejected delay must never let a waiting test believe this process is
        // holding the lock and about to sleep, when it is actually about to
        // exit without either.
        const delaySec = testDelaySeconds(
          "DRIVE_PR_CLAIM_HELD_TEST_DELAY",
          "claim-held",
        );
        const signal = process.env.DRIVE_PR_CLAIM_HELD_TEST_SIGNAL;
        if (signal) writeFileSync(signal, "");
        if (delaySec > 0) await sleep(delaySec);

        const { state } = store.read();
        const item = state.held.find((h) => h.key === a.key);
        if (!item) {
          // Exit 4, mirroring the finding branch's identical case just below
          // — not 1, which this branch also uses for a round/SHA mismatch.
          // "Not in the held batch at all" is the one case a caller can tell
          // apart from every other refusal without reading the message: it is
          // the snapshot going stale (another operation, most often this same
          // thread's own resolve, removed the item after finish-round.ts's
          // batch read), never a property of THIS item's own round or SHA —
          // so it is the one case worth re-reading the batch over rather than
          // recording a permanent refusal.
          fail(
            4,
            `claim-held: no held item with key '${a.key}' for PR #${pr}.`,
          );
        }
        if (item.kind !== "thread") {
          fail(
            2,
            `claim-held: '${a.key}' is a held '${item.kind}', not a 'thread'.`,
          );
        }
        if (item.round !== state.rounds) {
          fail(
            1,
            `claim-held: '${a.key}' was held in round ${item.round}, but the current`,
            `round is ${state.rounds}.`,
            "",
            "A round boundary was crossed since the accepted/moot reply was posted, without",
            "this thread being re-confirmed — so the push you are about to resolve it",
            "against is not verified to be the one its reply promised. Reconcile it via",
            "SKILL.md § 3 first: if the reply still stands, re-run 'drive-state.ts hold' to",
            "refresh its round before resolving; if it does not, resolve it under whichever",
            "outcome actually applies now.",
          );
        }
        if (item.verifiedSha !== a.pushedSha) {
          fail(
            1,
            `claim-held: --pushed-sha ${a.pushedSha} is not the push recorded against`,
            `'${a.key}' itself (${item.verifiedSha === undefined ? "none — no push by the driver that holds it has been verified since it was held" : item.verifiedSha}).`,
            "",
            'This is the HOLD\'s own stamp, not the PR-global ".verifiedSha": that field is',
            "moved by whichever driver pushed last, so on a PR two drivers are working",
            "concurrently it vouched for every held item, including this one's promised fix",
            "that the push never contained. The stamp is written by",
            "'drive-state.ts stamp-held' — but only onto the holds the CALLING working",
            "tree created, so a mismatch means one of: no push of yours has been verified",
            "since this hold was made; the SHA reached the PR some other way (an",
            "intervening push, a manual push, a push whose 'stamp-held' never ran); or a",
            "DIFFERENT driver made this push and it is not the one this reply was waiting",
            "on. Reconcile via SKILL.md § 3.",
          );
        }
        const next: DriveState = {
          ...state,
          held: state.held.filter((h) => h.key !== a.key),
        };
        store.write(next);
        // Best-effort: the state mutation above is what makes this claim real —
        // an unwritable/full `$DRIVE_PR_HANDOFF_DIR` failing the regeneration
        // AFTER that rename has already succeeded must not turn a genuine claim
        // into a reported failure. The caller (resolve-held-thread.ts) reads a
        // claim failure as "nothing was removed, safe to just stop", which is
        // exactly wrong the one time the removal already happened. The handoff
        // file is a best-effort orientation artifact by its own design; it must
        // never be what decides whether a destructive state mutation is
        // reported as having succeeded.
        await store.renderHandoff(next);
        process.stdout.write(`${JSON.stringify(item)}\n`);
        return 0;
      });
    }

    // Give up a FINDING claim WITHOUT touching the held batch — for a dispatch
    // that failed transiently (a network blip, a rate limit) rather than
    // crashing, so the key is immediately reclaimable instead of waiting out
    // the whole staleness window. A crash needs no explicit call here at all:
    // an abandoned claim recovers on its own once `claim-held` finds it stale.
    // Meaningless for a thread — its claim-held is a one-shot atomic remove
    // with no separate claim file to give back; `restore-held` is its failure
    // path instead.
    case "unclaim-held": {
      if (a.key === "") fail(2, "unclaim-held requires --key");
      if (a.token === "")
        fail(2, "unclaim-held requires --token (the one claim-held gave you)");
      const path = claimPathFor(store.stateDir, pr, a.key);
      // The match-then-remove must be ONE atomic step, under the SAME per-PR
      // lock `tryBreakStaleClaim` takes to break a stale claim — not two
      // separate, unlocked operations. Without the lock, an owner returning
      // right at the edge of the staleness window can pass the token check
      // against its own still-on-disk (but now stale) file, then have a
      // DIFFERENT driver legitimately break that same stale claim and create a
      // fresh one for itself in the gap before this call's own removal runs —
      // which then deletes the FRESH claimant's file, not the one this caller
      // ever owned, leaving a third driver free to claim the key while the
      // second still believes it holds it exclusively. That is the exact
      // double-dispatch this whole primitive exists to prevent, reached through
      // the one recovery path that skipped the lock. `tryBreakStaleClaim`
      // already establishes the pattern: a rare, crash-recovery-adjacent path
      // takes the lock; the hot, first-time-claim path never does.
      return store.locked(async () => {
        if (!claimTokenMatches(path, a.token)) {
          fail(
            1,
            `unclaim-held: '${a.token}' is not the live claim on '${a.key}' — nothing to release. It may already have expired or been reclaimed by someone else.`,
          );
        }
        removeClaimFile(path);
        return 0;
      });
    }

    // Undo a `claim-held` removal when the mutation it was clearing the way
    // for did NOT actually happen — a failed or timed-out resolveReviewThread
    // call, or a live-head recheck refusing right after the claim
    // (resolve-held-thread.ts). Thread-only, mirroring `claim-held`'s own
    // scope.
    //
    // `--round` is REQUIRED and is the claimed item's OWN original round —
    // never `.rounds` read fresh here. `claim-held` releases its lock before
    // the network operation that follows runs, so by the time a caller
    // restores, an intervening `bump-round` (a concurrent driver's counting
    // gate) may already have moved `.rounds` forward. Stamping "now" would
    // silently launder that: the restored item would compare equal to a round
    // it was never actually re-confirmed against, defeating `claim-held`'s
    // round check. Restoring the ORIGINAL round instead means a later claim
    // attempt sees the same mismatch a stale hold would — refuses, and routes
    // back through SKILL.md § 3's reconciliation exactly as intended.
    //
    // No failure is swallowed anywhere in this command: a lock timeout or a
    // write failure here propagates as a normal nonzero exit, so a caller that
    // swallowed it would be caught reporting "restored" for an item that
    // silently stayed lost. The caller MUST treat a nonzero exit here as
    // fatal, not best-effort.
    case "restore-held": {
      if (a.key === "") fail(2, "restore-held requires --key");
      // The same newline ban `hold` and `park` carry. This is a WRITER into
      // `held`, so it needs the writer's invariant: without it a direct
      // `restore-held --key` call persists an entry `isUsableState` rejects on
      // the next read, and the store's refusal is fail-closed — so the drive
      // stops entirely until a human edits the state file by hand. Fixing
      // `hold` alone missed this sibling; every writer into a line-delimited
      // channel needs this, not just the one that was reported.
      if (/[\n\r]/.test(a.key)) {
        fail(
          2,
          "restore-held: --key may not contain a newline or carriage return.",
          "held-keys is a line-delimited channel, so such a key becomes TWO match",
          "tokens and the extra one releases work nobody held.",
        );
      }
      if (a.kind !== "thread") {
        fail(
          2,
          `restore-held requires --kind thread (got '${a.kind === "" ? "<empty>" : a.kind}') — it exists only to undo a claim-held removal, which is thread-only.`,
        );
      }
      if (a.outcome !== "accepted" && a.outcome !== "moot")
        fail(
          2,
          `restore-held requires --outcome accepted|moot (got '${a.outcome}')`,
        );
      if (!isDigits(a.restoreRound)) {
        fail(
          2,
          "restore-held requires --round — the EXACT round 'claim-held' reported for this item before removing it, not the current round.",
        );
      }
      // `claim-held` removes the entry WITH its `commentUrl`; a restore that
      // drops it reconstructs a provenance-free entry that the next standalone
      // reconciliation reads as "a different comment" and downgrades to an
      // unconfirmed round -1 — stranding a hold that was never actually
      // superseded, purely because the mutation that follows a claim happened
      // to fail. The caller
      // (resolve-held-thread.ts) always has it: it read the claimed entry back
      // from `claim-held`'s own stdout before ever attempting the mutation.
      if (a.commentUrl === "") {
        fail(
          2,
          "restore-held requires --comment-url — the EXACT value 'claim-held' returned",
          "for this item before removing it, so the restored entry still represents",
          "the same reply a later reconciliation pass would compare against.",
        );
      }
      // Provenance is restored EXACTLY too, and for a sharper reason than the
      // fields above: a restore that dropped it would put the item back in a
      // state no retry can leave. `claim-held` only ever succeeds when the
      // hold's own stamp equals `--pushed-sha`, so an item that reaches a
      // restore provably had one; recreating it without would leave the retry
      // refused for want of a stamp, and the only thing that writes one —
      // `stamp-held` — has already run for this push. The item would sit
      // there unresolvable until a whole further round pushed again.
      //
      // Taken as arguments rather than re-derived here: the actor especially.
      // Re-deriving would stamp the RESTORING tree, which is the same tree in
      // every path that exists today — and would silently launder ownership on
      // the first path where it is not, handing one driver's hold to another:
      // a cross-resolve, one driver resolving a thread another driver
      // promised to fix.
      if (a.actor === "") {
        fail(
          2,
          "restore-held requires --actor — the EXACT value 'claim-held' returned for",
          "this item, so the restored hold still belongs to the driver that made its",
          "promise rather than to whichever one happened to restore it.",
        );
      }
      if (a.verifiedSha === "") {
        fail(
          2,
          "restore-held requires --verified-sha — the EXACT value 'claim-held' returned",
          "for this item. A claim only succeeds when that stamp matches --pushed-sha, so",
          "an item being restored always has one, and restoring it without would leave",
          "the retry refused for want of a stamp nothing is going to write again.",
        );
      }
      // The exact shape `claim-held` prints, not merely "no newline". Both
      // fields are rendered into the handoff's held table INSIDE backtick code
      // spans (`handoff.ts`), so a hand-composed value carrying a backtick or
      // `|` breaks the row's markdown just as surely as a newline would, and
      // one naming a different worktree would silently hand that worktree's
      // hold to whoever restores it — the exact cross-resolve this check exists
      // to prevent. Every caller of `restore-held` reads these back verbatim
      // from `claim-held`'s own stdout (the comment on provenance above), so a
      // value that fails this grammar is always a hand-composed call, never the
      // documented path.
      if (!isActorId(a.actor)) {
        fail(
          2,
          `restore-held: --actor must be the exact 'wt-' + 16 lowercase hex form 'claim-held' printed (got '${a.actor}').`,
          "A looser check (e.g. merely non-newline) lets a hand-composed value name",
          "a DIFFERENT worktree, handing that worktree's hold to whoever restores it.",
        );
      }
      if (!isGitSha(a.verifiedSha)) {
        fail(
          2,
          `restore-held: --verified-sha must be a full 40-character lowercase hex SHA-1 (got '${a.verifiedSha}') — the exact grammar 'claim-held' printed.`,
          "A looser check here lets a malformed value persist and only fail",
          "isUsableState on the NEXT read, fail-closing the whole shared state file.",
        );
      }
      const outcome = a.outcome;
      const commentUrl = a.commentUrl;
      const actor = a.actor;
      const verifiedSha = a.verifiedSha;
      const round = Number.parseInt(a.restoreRound, 10);
      return store.locked(async () => {
        const { state } = store.read();
        if (state.held.some((h) => h.key === a.key)) {
          fail(
            1,
            `restore-held: '${a.key}' is already present in held — something else already restored or re-held it. Refusing to duplicate it.`,
          );
        }
        const next: DriveState = {
          ...state,
          held: [
            ...state.held,
            {
              key: a.key,
              kind: "thread",
              outcome,
              round,
              commentUrl,
              actor,
              verifiedSha,
            },
          ],
        };
        store.write(next);
        // Best-effort for the same reason claim-held's is: the restore already
        // succeeded once this rename lands, so a handoff-rendering failure
        // afterward must not report the restore itself as failed — the caller
        // (resolve-held-thread.ts's restoreOrDie) would print the "LOST from
        // local state" message for an item that is, in fact, sitting safely
        // back in `held`.
        await store.renderHandoff(next);
        return 0;
      });
    }

    case "release-held": {
      // After the push has landed and the batch has been resolved. `--all` is
      // explicit rather than the default for a bare invocation: releasing the
      // whole batch is the normal end-of-round act, but a typo'd `--key`
      // silently falling back to "clear everything" would drop the very items
      // the batch exists to remember, which is the failure this command was
      // added to close.
      if (a.all) {
        if (a.key !== "")
          fail(2, "release-held takes --key OR --all, not both");
        if (a.ifCommentUrl !== "")
          fail(2, "--if-comment-url is a per-key guard, not valid with --all");
        // A bulk release cannot carry a per-item token, so it refuses outright
        // while ANY held item still has a live claim — that claimant may be
        // mid-dispatch right now, and clearing its bookkeeping out from under
        // it is exactly the corruption per-item claiming exists to prevent. In
        // the ordinary, uncontended case (nobody ever called claim-held for any
        // of these keys) no claim is ever live, so this check is always a no-op
        // and `--all` behaves exactly as it always has.
        return store.locked(async () => {
          const { state } = store.read();
          const heldKeys = state.held.map((h) => h.key);
          // An already-empty batch is a no-op, not a drain: nothing changed, so
          // stamping progress here would let a caller retrying `release-held
          // --all` after it already drained the batch — or simply calling it on
          // a PR with nothing held — manufacture GENUINE-looking progress that
          // never happened, concealing a real stall from `--doctor`. Checked
          // before the contended-claim scan below since there is nothing to
          // scan.
          if (heldKeys.length === 0) return 0;
          const contended = heldKeys.filter((k) =>
            claimIsLive(claimPathFor(store.stateDir, pr, k)),
          );
          if (contended.length > 0) {
            fail(
              1,
              `release-held --all: refusing — still has a LIVE claim on: ${contended.join(", ")}.`,
              "Another driver may be mid-dispatch on one of these. Release each key",
              "individually with --key/--token once its own dispatch finishes, or wait",
              "for the claim to go stale.",
            );
          }
          // Test-only hooks, unset (no-op) by default, and live in the shipped
          // script for the reason every sibling hook is (see
          // `testDelaySeconds`). This branch holds the lock across THREE steps
          // — the contended check, the clear, and the claim-file cleanup — and
          // the two regression probes that keep it that way each need a
          // different one of the gaps between them held open deterministically:
          // a claimant racing the CLEAR must observe the clear rather than the
          // pre-clear snapshot, and a re-`hold` racing the CLEANUP must not have
          // its fresh claim carried off by it. A PATH shim on `mv` gave the
          // bash original both windows; `renameSync` cannot be stalled that way.
          const preClearStall = testDelaySeconds(
            "DRIVE_PR_RELEASE_ALL_TEST_DELAY",
            "release-held --all",
          );
          if (preClearStall > 0) await sleep(preClearStall);
          // A held batch drained — reached only past the
          // empty-batch no-op and the contended-claim refusal above, so this
          // call is a genuine drain, never a no-op.
          const next: DriveState = {
            ...withProgress(state, "held-drained", new Date()),
            held: [],
          };
          store.write(next);
          // Best-effort, as `store.update` (what this branch used before the
          // contended check forced a bespoke lock hold) makes every handoff
          // render: the clear is already durable by this point, and a caller
          // that read a render failure as a release failure would retry a
          // release that has in fact happened.
          await store.renderHandoff(next);
          // The claim-file cleanup runs INSIDE this same lock hold, for the
          // reason `unclaim-held` states in full above: a removal decided
          // against one snapshot and executed against the path LATER deletes
          // whatever generation happens to occupy that path at execution time,
          // not the one it was ever responsible for. `claimPathFor` is a pure
          // function of the key STRING — it encodes no generation — so once
          // `.held` is cleared and the lock released, a concurrent `hold` can
          // legitimately re-add the same key and a concurrent `claim-held` can
          // legitimately confirm a claim on it (its membership re-check now
          // passes against the NEW `.held`, which the existing lock orders
          // correctly and says nothing about — it only orders a claimant
          // against this CLEAR, not against this CLEANUP). An unlocked cleanup
          // then deletes that live claim, and a third driver claims a key
          // someone is already dispatching — the duplicate top-level comment
          // this primitive exists to prevent, reached through the last
          // read-then-act that ran outside the mutex. Under the lock, no claim
          // can be CONFIRMED while we clean up (confirmation needs this lock,
          // and a fresh generation needs a `hold` that needs it too), so every
          // file we remove is one from the batch we actually cleared.
          const preCleanupStall = testDelaySeconds(
            "DRIVE_PR_RELEASE_ALL_CLEANUP_TEST_DELAY",
            "release-held --all",
          );
          if (preCleanupStall > 0) await sleep(preCleanupStall);
          for (const k of heldKeys)
            removeClaimFile(claimPathFor(store.stateDir, pr, k));
          return 0;
        });
      }
      if (a.key === "") fail(2, "release-held requires --key K or --all");
      // A mistyped or already-released key must fail loudly, not succeed as a
      // silent no-op: filtering removes nothing for a key that was never
      // there, and the caller — having seen exit 0 — moves on believing the
      // real item is released. For a `finding`, the next thing that happens
      // on a wrong belief is `answer-summary-finding.ts` firing again on a
      // later round, which is NOT idempotent (posts a new comment every call)
      // unlike a thread's `resolve-thread.ts`.
      //
      // The check and the removal run under ONE continuous lock hold, not a
      // precheck before `update`'s own separate acquisition: a precheck that
      // releases the lock before the write reopens exactly the TOCTOU this
      // mutex exists to close everywhere else — a concurrent hold or release
      // for this same key between the check and the write makes the
      // precheck's answer stale by the time the write happens, and either the
      // exists-check passes against a key already removed by someone else, or
      // the removal itself operates on a snapshot the check never actually
      // validated.
      return store.locked(async () => {
        const { state } = store.read();
        const current = state.held.find((h) => h.key === a.key);
        // `--if-comment-url` is the compare-and-delete this caller needs:
        // reconcile-replied-threads.ts's merit-cleanup observes a thread's
        // comments ONCE per PR (not per-thread), then — after its OWN
        // resolveThread mutation succeeds — releases whatever hold sits at this
        // key. Between that read and this release, a concurrent driver can
        // legitimately create/replace the hold with a NEWER one (a different
        // accepted/moot reply this process never saw). Checked INSIDE this same
        // lock hold, against the LIVE state, not the caller's own earlier
        // snapshot — a stale value here refuses exactly like a missing key
        // does, leaving the newer entry untouched. Deliberately narrower than
        // the round+outcome match that was reverted for the UNCONDITIONAL
        // caller (resolve-held-thread.ts's own cleanup, whose own comment above
        // explains why ANY entry it finds is provably stale) — this flag is
        // opt-in, so that caller's behavior is unchanged.
        if (
          a.ifCommentUrl !== "" &&
          current !== undefined &&
          current.commentUrl !== a.ifCommentUrl
        ) {
          return 0;
        }
        if (!current) {
          // `--if-present` exists for exactly ONE class of caller: cleaning up
          // a POSSIBLY-stale hold whose existence was never guaranteed — most
          // callers of release-held know for certain the key was held (they
          // just resolved/answered it), where a missing key IS the bug this
          // fail-loud default exists to catch. reconcile-replied-threads.ts's
          // merit-resolve cleanup is different: most resolved threads never
          // had a stale hold at all, so "missing" is the ordinary case, not an
          // error — and doing the presence check as a SEPARATE locked call
          // before this one reopens the exact TOCTOU the single-call design
          // above exists to close: a
          // concurrent driver could create or replace the key in the window
          // between the two calls. `--if-present` collapses "check, then
          // release" into this one already-locked operation instead.
          if (a.ifPresent) return 0;
          fail(
            1,
            `release-held: no held item with key '${a.key}' — check for a typo. Releasing`,
            "nothing and reporting success would leave the real item still held,",
            "invisibly, while the caller believes it is done.",
          );
        }
        // A LIVE claim on this key demands the matching token — proof this
        // caller is the one who claimed it (and therefore the one who legally
        // dispatched it). This is a check on RUNTIME LOCK STATE, not a
        // version-discriminated dual protocol: no live claim at all means
        // nobody currently holds this key (a thread's own claim-held already
        // removed it before we ever got here, or nobody called `claim-held` for
        // a finding, or a prior claim already expired/released), so there is no
        // owner to prove membership against and release proceeds exactly as an
        // uncontended release always has.
        const claim = claimPathFor(store.stateDir, pr, a.key);
        if (claimIsLive(claim) && !claimTokenMatches(claim, a.token)) {
          fail(
            1,
            `release-held: '${a.key}' has a live claim — pass the --token claim-held gave`,
            "you, or it belongs to another driver that is still (or was recently)",
            "dispatching it. Releasing it out from under that claim is exactly the",
            "double-dispatch this check exists to prevent.",
          );
        }
        // Unconditional-by-key otherwise, not matched against round/outcome (a
        // conditional match here, guarding against a concurrent driver's
        // "newer" re-hold of this key, was tried and reverted for
        // resolve-held-thread.ts's own post-resolve cleanup call, which reaches
        // here strictly AFTER its own resolveThread mutation has already
        // succeeded: a re-hold of this key can only exist there if SOME
        // driver's own step-2 enumeration (list-unresolved- threads.ts, scoped
        // to `isResolved == false`) still saw this thread open — which, for the
        // thread THIS process just resolved, is only possible from a scan taken
        // BEFORE that resolve landed. So for THAT caller, any leftover record
        // is provably stale regardless of its round/outcome, and matching
        // against it would leave exactly that stale record behind forever.
        // reconcile-replied- threads.ts's own merit-cleanup does NOT get that
        // same guarantee for free — its comment enumeration runs once per PR,
        // long before any individual thread's resolve — so it opts into the
        // narrower `--if-comment-url` guard above instead of relying on this
        // unconditional path.
        //
        // A held batch drained — reached only past every early
        // no-op `return 0` above (`--if-comment-url` mismatch, a missing key
        // with `--if-present`), so this branch is a genuine release.
        const next: DriveState = {
          ...withProgress(state, "held-drained", new Date()),
          held: state.held.filter((h) => h.key !== a.key),
        };
        store.write(next);
        await store.renderHandoff(next, { rethrow: true });
        // Same class as the `--all` cleanup above: remove BEFORE releasing the
        // lock. The claim path is a pure function of the key's string, so a
        // re-`hold` plus a fresh `claim-held` for this same key, landing in the
        // gap between an unlocked clear and an unlocked removal, would have
        // this call delete a generation it never owned.
        removeClaimFile(claim);
        return 0;
      });
    }

    case "phase": {
      if (a.phaseName === "") fail(2, "phase requires --set NAME");
      await store.update((s) => ({ ...s, phase: a.phaseName }));
      return 0;
    }

    // The minimal verb whose whole job is the progress stamp, so `drive.ts` can
    // mark "a pass was spawned" without inventing a state mutation it does not
    // otherwise need. See `withProgress`'s own header (`lib/state/schema.ts`)
    // for why this goes through a NAMED verb rather than an inline
    // `store.update()`.
    case "progress": {
      if (a.phaseArg === "") fail(2, "progress requires --phase NAME");
      // Validated against the CLOSED set every other named event is stamped
      // with internally (`bump-round`, `stamp-held`, `set-verified`,
      // `release-held`) — this is the one CLI-exposed entry point that takes an
      // arbitrary caller-supplied string, and only emptiness was checked
      // before. A misspelled or unauthorized `--phase` would otherwise persist
      // as an indistinguishable stand-in for the real event it was meant to
      // name.
      if (!(PROGRESS_PHASES as readonly string[]).includes(a.phaseArg)) {
        fail(
          2,
          `progress: --phase must be one of ${PROGRESS_PHASES.join(", ")} (got '${a.phaseArg}')`,
        );
      }
      // Test-only hook, unset (no-op) by default: holds this write open so a
      // test can prove `drive.ts` joins the `pass-spawned` stamp before a
      // later `recordQuotaPark()` write, which the stamp would otherwise clear.
      const delaySec = testDelaySeconds(
        "DRIVE_PR_PROGRESS_TEST_DELAY",
        "progress",
      );
      if (delaySec > 0) await sleep(delaySec);
      await store.update((s) => withProgress(s, a.phaseArg, new Date()));
      return 0;
    }

    // Called by `drive.ts` on BOTH quota paths — see its own
    // `recordQuotaPark`'s header for why: the EXITING path is the more urgent
    // of the two (the process is about to return, and `release()`'s `rmdir` on
    // its way out leaves no lock behind — nothing else would distinguish a
    // deliberate park from a driver that simply died), and the SLEEPING path
    // holds its locks live for up to six hours with no pass running and nothing
    // to stamp, which would otherwise read as a textbook `WEDGED` (the
    // sleeping-drive test in `doctor.test.ts`). Deliberately does NOT go
    // through `withProgress` — parking is progress's opposite, and
    // `quotaPark`'s own comment on `DriveState` explains why the next genuine
    // progress event (not this call) is what clears it.
    case "quota-park":
      return quotaPark(store, a);

    case "takeover":
      return recordTakeover(store, await readStdinAll(), await resolveActor());

    case "seed-ledger":
      return seedLedgerCommand(store, await readStdinAll());

    case "handoff": {
      await store.locked(async () => {
        const out = await renderHandoff(pr, store.read().state);
        process.stdout.write(`${out}\n`);
      });
      await mirrorLedger(pr, store);
      return 0;
    }

    case "lease": {
      // Read-only, and ungated: asking who is driving must work FROM the
      // session that is being refused, which is the only session that needs to
      // ask. Prints nothing but a newline when nobody holds it, so a caller can
      // test the output rather than parse an exit code.
      //
      // `--all` is the FOREIGN-lease read surface. Without it there
      // was no way for a resolver to answer "is another working tree driving
      // this PR right now?" — `lease` resolves this tree's actor and reports
      // that tree and nothing else, and the tempting alternative was wrong in a
      // way worth recording: the durable per-hold `actor` (`held [PR]`) proves
      // only that some tree made a promise once, because a hold deliberately
      // OUTLIVES its driver so a successor can finish it (SKILL.md § 6).
      // Stopping on a foreign actor wedges that legitimate successor forever.
      // Liveness lives in the lease, and this is the read of it.
      //
      // A JSON ARRAY, always — `[]` for nobody, never a blank line — because a
      // caller of this one is asking a question whose empty answer is load-
      // bearing, and an empty array says "enumerated, found none" where a blank
      // line is indistinguishable from a command that printed nothing.
      // `leaseFilesFor` throws rather than answering `[]` when the directory
      // cannot be read, so `[]` is always a measurement.
      if (a.all) {
        const self = await resolveActor();
        const live: unknown[] = liveLeasesFor(store.stateDir, pr).map((l) => ({
          ...l,
          // Which of these is the caller's own, so a reader does not have to
          // re-derive the actor to tell "someone else is driving" from "I am".
          self: l.actor === self,
        }));
        // The files the gate BLOCKS on but cannot parse belong in this report
        // too. Reporting only the readable ones let this command print `[]`
        // immediately after an exit-13 refusal that one of these caused —
        // telling an operator nobody holds the PR at the exact moment they
        // were refused for the opposite reason, which is worse than no
        // diagnostic.
        //
        // Same shape as a lease (`actor`, `worktree`, `self`) so one consumer
        // reads both, with `unreadable: true` as the discriminant and no
        // fabricated pid/session — the point is that those are exactly what
        // could not be read.
        for (const f of unreadableLeaseFilesFor(store.stateDir, pr)) {
          live.push({
            unreadable: true,
            file: f,
            actor: null,
            worktree: null,
            self: f === leasePathFor(store.stateDir, pr, self),
            blocksUntil: "mtime + the staleness window",
          });
        }
        process.stdout.write(`${JSON.stringify(live, null, 2)}\n`);
        return 0;
      }
      const l = readLease(
        leasePathFor(store.stateDir, pr, await resolveActor()),
      );
      process.stdout.write(
        l === null ? "\n" : `${JSON.stringify(l, null, 2)}\n`,
      );
      return 0;
    }

    case "admit": {
      // "May this tree act on this PR at all?" — the PR-wide gate, asked
      // WITHOUT taking a lease and without mutating anything. Exits 0 when no
      // other working tree is driving, 13 when one is (same code, same
      // diagnostic as every other PR-wide refusal).
      //
      // It exists for callers that mutate something OTHER than drive state and
      // so are never gated by `claimLease`. The measured one is
      // `drive-status.ts`'s replied-thread reconciliation sweep: it invokes
      // `resolve-thread.ts`, which resolves threads ON GITHUB, and it runs
      // well before the leased `bump-round` where exit 13 was previously first
      // raised — so a second worktree could resolve threads and only then be
      // told it was not admitted.
      //
      // Honestly a PREFLIGHT, not a fence, and the difference is worth stating
      // because this file is careful about it elsewhere: a GitHub mutation
      // cannot be fenced by a local mutex, so there is no continuous protocol
      // to join. What this buys is that the window shrinks from "the entire
      // sweep, always" to "a lease that appears during the sweep". Drive STATE
      // remains fully fenced via `claimLease`; this is the best available
      // answer for a side effect that leaves the machine.
      await assertNoForeignDriveNow(store.stateDir, pr);
      return 0;
    }

    case "clear-lease": {
      // The ONE mutating command the lease does not gate — see LEASED_COMMANDS.
      // It reports what it dropped rather than clearing silently: a human
      // running this is overriding a refusal, and the record they are
      // overriding is the evidence for whether that was right.
      //
      // Taken under the STATE mutex, though it mutates no state itself. The
      // admission fence (`assertLeaseUnchanged`) runs inside a locked section
      // and is then followed by that section's write, and those two are not
      // atomic against a revocation that needs only the LEASE mutex: clearing
      // between the check and the write let the admitted command write anyway,
      // after which a successor could claim the absent lease and write under
      // the same actor — the corruption the fence exists to exclude, in a
      // narrower window. Holding the state
      // mutex here means a clear can only land between locked sections, never
      // inside one, which is what makes the fence hold through the mutation
      // rather than merely at its start.
      //
      // Lock ORDER is state → lease, matching `reset` (which sweeps lease files
      // while holding this same mutex). `claimLease` takes the lease mutex and
      // never reaches for the state one, so no cycle exists in either
      // direction.
      //
      // `--all` drops EVERY tree's lease on this PR, live ones included: the
      // documented way to take a PR back from a working tree the operator
      // cannot stand in — one that was deleted, or is on another machine, or
      // whose session they have already stopped by hand. Plain
      // `clear-lease` cannot reach those, because it resolves the caller's own
      // actor, and a PR-wide refusal whose only remedy is a command that must
      // be run from the refusing tree is not a remedy.
      //
      // Deliberately overriding, and reported as such: it prints every record
      // it dropped, because the operator is overruling a live claim and those
      // records are the evidence for whether that was right. Same state-mutex
      // hold as the single-tree path above, for the same fence-coordination
      // reason.
      if (a.all) {
        return await store.locked(async () => {
          // Read for the REPORT before the sweep, since deletion is what makes
          // them unreadable. Unreadable ones are still swept — `removed` below
          // is the authoritative count, and these details are the addendum.
          const before = leaseFilesFor(store.stateDir, pr)
            .map(readLease)
            .filter((l): l is Lease => l !== null);
          const { removed } = await clearAllLeases(
            store.stateDir,
            pr,
            admittedLease,
            false,
          );
          if (removed.length === 0) {
            console.error(
              `drive-state.ts: no drive leases on PR #${pr} from any working tree — nothing to clear.`,
            );
            return 0;
          }
          console.error(
            `drive-state.ts: cleared ${removed.length} drive lease(s) on PR #${pr}, from EVERY working tree:`,
          );
          for (const l of before) {
            console.error(
              `  ${l.worktree || l.actor} — ${leaseHolderLabel(l)}, last seen ${l.lastSeen} ('${l.command}')`,
            );
          }
          if (before.length < removed.length) {
            console.error(
              `  (+${removed.length - before.length} lease file(s) that could not be read as a lease record)`,
            );
          }
          return 0;
        });
      }
      const gone = await store.locked(() => clearLease(store.stateDir, pr));
      // Reported independently — `clearLease` always drops BOTH, and a report
      // naming only the per-PR half left the tree lease's removal invisible on
      // the exact call an operator makes most often: `clear-lease
      // <requested-pr>`, where there is normally no PER-PR record for that pr
      // at all.
      if (gone.lease === null && gone.treeLease === null) {
        console.error(
          `drive-state.ts: no drive lease on PR #${pr} from this working tree — nothing to clear.`,
        );
        return 0;
      }
      if (gone.lease !== null) {
        console.error(
          `drive-state.ts: cleared PR #${pr}'s drive lease (${leaseHolderLabel(gone.lease)}, last seen ${gone.lease.lastSeen}).`,
        );
      }
      if (gone.treeLease !== null) {
        console.error(
          `drive-state.ts: cleared this working tree's TREE lease (${leaseHolderLabel(gone.treeLease)}, was on PR #${gone.treeLease.pr}, last seen ${gone.treeLease.lastSeen}).`,
        );
      }
      return 0;
    }

    case "reset": {
      // The orphan-warning marker too — leaving it means a `reset` that makes
      // the state file absent again (with a worktree-private orphan still
      // sitting there) is judged against a marker written for the PREVIOUS
      // absence, and the warning that condition exists to re-arm never fires
      // again.
      //
      // The handoff is a snapshot of THIS file — deleting the JSON without it
      // leaves a stale .md still showing the round/phase/held/parked state
      // that `reset` just discarded, while its own text tells a compacted
      // agent to prefer it. Same lock as every other mutator, for the same
      // reason: a concurrent `hold`/`park` racing this reset must not have
      // its handoff write land after reset's removal and resurrect a file for
      // state that no longer exists.
      const resetResult = await store.locked(async () => {
        let ownsCiHold = false;
        // `released` is deliberately included, not just the in-flight
        // held/acquiring/releasing phases: GitHub's label timeline is immutable
        // and cumulative, so once any ci:hold transition has ever happened for
        // this PR, the remote timeline can never go back to empty.
        // `finalReady()`'s no-persisted-hold branch only accepts a null
        // `ciHold` when that timeline IS empty (`timeline.length !== 0 → return
        // 4`) — so erasing a `released` record here would make it return 4
        // forever, with no way to reconstruct which transition was current (the
        // same root cause as the now-removed `clear-ci-hold` command).
        let hasCiHoldEvidence = false;
        // Structural rule, not a per-shape enumeration (each earlier version of
        // this check proved too narrow — an unparseable file, then an escaped
        // key, then a truncated-before-the-key file, then a perfectly PARSEABLE
        // file whose `ciHold` is simply missing or malformed, each slipped
        // through the version before it in turn): local state can only ever
        // PROVE a hold's presence (a recognized `phase`) or its CONFIRMED
        // absence — `freshState()`'s own explicit `ciHold: null`, written by
        // this tool's own schema and nothing else. Every other local shape —
        // unparseable text, a missing `ciHold` key, a malformed or
        // unrecognized-phase value — is INCONCLUSIVE, not evidence of absence,
        // and only GitHub's live timeline can settle it. A truncated write can
        // cut off before `ciHold` was ever serialized (`freshState()` emits it
        // after several other fields) — indistinguishable, from local bytes
        // alone, from a file that never held one; an inconclusive live read
        // (network/auth failure) is refused for the identical reason an
        // inconclusive parse already is.
        let ciHoldEvidenceInconclusive = false;
        if (existsSync(store.file)) {
          const text = readFileSync(store.file, "utf8");
          let rawMentionsCiHold = false;
          let localEvidenceConfirmsAbsence = false;
          try {
            const raw = JSON.parse(text) as Record<string, unknown>;
            if (raw.ciHold === null) {
              localEvidenceConfirmsAbsence = true;
            } else if (
              typeof raw.ciHold === "object" &&
              raw.ciHold !== null &&
              !Array.isArray(raw.ciHold)
            ) {
              const ciHold = raw.ciHold as Record<string, unknown>;
              ownsCiHold =
                ciHold.phase === "held" ||
                ciHold.phase === "acquiring" ||
                ciHold.phase === "releasing";
              hasCiHoldEvidence = ownsCiHold || ciHold.phase === "released";
              localEvidenceConfirmsAbsence = hasCiHoldEvidence;
            }
          } catch {
            rawMentionsCiHold = rawTextMentionsJsonKey(text, "ciHold");
          }
          if (!localEvidenceConfirmsAbsence && !hasCiHoldEvidence) {
            const liveTimeline = await readCiHoldTimeline(pr);
            ciHoldEvidenceInconclusive =
              rawMentionsCiHold ||
              liveTimeline === null ||
              liveTimeline.length !== 0;
          }
        }
        if (ciHoldEvidenceInconclusive) {
          console.error(
            `drive-state.ts: refusing to reset PR #${pr} — its state file exists but does not confirm the absence of a ${holdLabelName()} transition, and live evidence could not rule one out either.`,
            `\n  A missing/malformed \`ciHold\` field, or a file that fails to parse at all, is not evidence the transition it may have recorded is gone — only an explicit \`ciHold: null\` or GitHub's live '${holdLabelName()}' timeline can confirm there is nothing to preserve. Inspect ${store.file} and PR #${pr}'s timeline by hand: if there is truly no ${holdLabelName()} evidence worth preserving, remove the file directly rather than through reset; if there is, reconcile the live label with ci-hold.ts first.`,
          );
          return 9;
        }
        if (ownsCiHold) {
          console.error(
            `drive-state.ts: refusing to reset PR #${pr} while this drive still owns '${holdLabelName()}'.`,
            `\n  Resetting would erase the only event id that authorizes its eventual removal. Let the drive converge and release it, or reconcile the live label with ci-hold.ts first.`,
          );
          return 9;
        }
        if (hasCiHoldEvidence) {
          console.error(
            `drive-state.ts: refusing to reset PR #${pr} while it holds a released '${holdLabelName()}' transition.`,
            `\n  GitHub's label timeline never returns to empty once any transition has happened, so erasing this record would make ci-hold.ts final-ready reject every future head permanently — there would be no persisted transition to validate freshness against, and no way to reconstruct which one used to be current. Reconcile the live label with ci-hold.ts instead of resetting.`,
          );
          return 9;
        }
        // The FALLIBLE work first, before anything durable is discarded.
        //
        // `clearAllLeases` enumerates a directory and takes a lock per lease
        // file, and either can throw — so running it after the deletions meant
        // a throw left the state file, handoff, orphan marker and claim files
        // already gone, with only a PREFIX of the leases swept, and exited
        // non-zero. A caller cannot tell that apart from a reset that changed
        // nothing, so a retry is reasoning from a false transactional
        // assumption.
        //
        // Ordered this way the failure is clean instead: nothing of THIS
        // command's has been deleted yet, so the retry a caller reaches for is
        // operating on the state they think it is. The deletions below are
        // `rmSync(..., { force: true })` and `removeHandoff`, which do not
        // throw on a missing target, so nothing after this point reintroduces
        // the same problem.
        //
        // NOT "a non-zero exit means no change", which an earlier version of
        // this comment claimed and turned out false: `clearAllLeases` can
        // itself throw `PARTIAL sweep` when a lease deletion fails on
        // EACCES/EPERM/EROFS, having removed some leases. That error names both
        // halves precisely so this case is distinguishable. The three non-zero
        // outcomes are distinct and a caller must read which it got: exit 9 (a
        // live foreign lease) and an acquisition failure both leave everything
        // untouched; a `PARTIAL sweep` has changed the lease set. Every session
        // lease for this PR, from EVERY working tree — not just this one's.
        // `reset` is the command a human reaches for to unwedge a drive, and
        // the tree holding the wedged lease need not be the tree they are
        // standing in.
        //
        // Except one that is still LIVE, in ANY tree including this one, which
        // is preserved and returned. A live lease is by definition not the
        // wedge anyone ran this to clear, and deleting it re-opens that tree to
        // a second session alongside a command that may already be admitted —
        // see `clearAllLeases`. Only the REPORT below is scoped to other trees:
        // the caller's own preserved lease is not news to the caller, while a
        // tree they cannot see from here is the only case they need told about.
        const { preservedForeign: preservedLeases, removed: removedLeases } =
          await clearAllLeases(store.stateDir, pr, admittedLease);

        // A live FOREIGN lease aborts the reset outright, before anything
        // shared is deleted.
        //
        // Preserving that tree's lease is not enough on its own: the state file
        // and the CLAIM FILES are shared by every tree driving this PR. A live
        // session mid-dispatch of a held finding has already created its claim
        // file and may not have posted yet — deleting it lets this tree rebuild
        // fresh state, see the finding as unaddressed, and dispatch the same
        // non-idempotent answer a second time, which is a duplicate standing
        // claim on the PR that no later round undoes.
        //
        // Refusing is the right default because `reset` exists to unwedge a
        // drive, and a lease that is demonstrably live is not the wedge: its
        // session is still working. The message names the holder and both ways
        // out — wait for it, or take the lease over from that tree with
        // `clear-lease`, which is the deliberate override.
        if (preservedLeases.length > 0) {
          for (const l of preservedLeases)
            console.error(
              `drive-state.ts: refusing to reset PR #${pr} — another working tree is driving it right now (${l.actor}, ${leaseHolderLabel(l)}, last seen ${l.lastSeen}).`,
              `\n  Nothing has been deleted. The state file and the claim files are SHARED with that tree: dropping them while it is mid-dispatch lets this tree re-answer a finding it has already claimed, which duplicates a comment that cannot be withdrawn.`,
              `\n  ${leaseLivenessHint(l)}`,
              `\n  If it is gone, it clears itself once ${leaseStaleMin()}m pass with drive state untouched — or run 'drive-state.ts clear-lease ${pr}' from that tree to take it over, then reset.`,
            );
          return 9;
        }

        // A LIVE CLAIM aborts the reset too, whoever owns it.
        //
        // Checked AFTER the lease, deliberately: when both apply the lease
        // refusal is the more actionable diagnostic — it names another tree and
        // session, and how to verify or override them — whereas this one can
        // only say "wait". Nothing is lost by the ordering, since a re-run once
        // the lease clears still meets this check while the claim is live.
        //
        // The lease check below is not sufficient for this, and the reason is
        // structural: a `claim-held --kind finding` dispatch runs OUTSIDE the
        // state mutex, between claiming and posting. So the claiming session's
        // own lease is `isOwn` — deliberately, since the session running this
        // reset may be the very same one — and yet its in-flight POST has not
        // landed. Deleting the claim file there lets any later command see the
        // finding as unaddressed and answer it again, which is the duplicate
        // top-level comment the claim protocol exists to prevent.
        //
        // Keyed on the CLAIM, not on who holds it: ownership is exactly what
        // fails to discriminate here, and a live claim means a dispatch may be
        // in flight regardless of whose it is. Stale claims are not live by
        // `claimIsLive`'s own staleness test, so an abandoned one still does
        // not block the reset a human ran to clear it.
        const liveClaims = claimFilesFor(store.stateDir, pr).filter(
          claimIsLive,
        );
        if (liveClaims.length > 0) {
          // NOT the blanket "Nothing has been deleted" this branch used to
          // print unconditionally: `clearAllLeases` above already ran its own
          // phase 2 whenever it did not refuse outright, so a refusal reached
          // here can follow a real, completed lease sweep. Claiming otherwise
          // was accurate for the lease-refusal branch above (which returns
          // before phase 2 ever runs) but false for this one.
          const leaseNote =
            removedLeases.length > 0
              ? `${removedLeases.length} stale session lease(s) were already swept as part of this attempt (they were not live, so nothing driving was lost) — but the state file and the claim files were NOT.`
              : "Nothing has been deleted.";
          console.error(
            `drive-state.ts: refusing to reset PR #${pr} — ${liveClaims.length} live claim(s) on held finding(s), which means a dispatch may be in flight right now.`,
            `\n  ${leaseNote} A finding's answer is posted OUTSIDE the state mutex, so deleting its claim file here would let the finding be answered a second time — a duplicate top-level comment that cannot be withdrawn.`,
            `\n  ${liveClaims.map((f) => `  ${f}`).join("\n")}`,
            `\n  A claim clears itself once ${claimStaleMin()}m pass untouched, or the dispatching driver releases it. Re-run the reset after that.`,
          );
          return 9;
        }

        rmSync(store.file, { force: true });
        rmSync(orphanMarkerPath(store.stateDir, pr), { force: true });
        await removeHandoff(pr);
        // Every claim file for this PR too — live, or an abandoned
        // `.released.` leftover. Without this, "forget everything for this PR"
        // is a lie for up to a full staleness window: a live claim `reset`
        // leaves behind still blocks `claim-held` on that key ("already
        // claimed") after the JSON that would have explained why is already
        // gone, and a human running `reset` specifically to unwedge a drive
        // gets ten more minutes of exactly the wedge they were trying to
        // clear.
        for (const f of claimFilesFor(store.stateDir, pr))
          rmSync(f, { force: true });
        // The ready-mark lease is NOT one of those: it deliberately sits
        // outside `claimPrefix` so the held-batch sweep never sees it, which
        // means this sweep never saw it either.
        // Same lie, same duration, same operator: `reset` recreates the JSON
        // with `readyMarkedRound: 0` while an orphaned lease keeps
        // `claim-ready-mark` reporting contention for a full staleness window
        // — the PR cannot be marked Ready and the state gives no hint why.
        rmSync(readyClaimPath(store.stateDir, pr), { force: true });
        // No report loop here any more: a live foreign lease returns 9 above
        // before anything is deleted, so by this point `preservedLeases` is
        // necessarily empty. Reaching here means the reset was complete.
        return 0;
      });
      if (resetResult === 0) {
        // Every quarantine directory this PR's lock has ever tombstoned
        // — `lock.ts`'s own `tombstone` never sweeps these, and
        // `sweepLockQuarantine` does not either: it COMPACTS each one to an
        // empty file rather than deleting it, so the permanent fence
        // survives intact and this needs no precondition of its own (see its
        // doc comment for why even this reset's own lease/claim checks above
        // do not prove "no future observer"). `reset` is simply a
        // convenient, low-traffic place to trigger it, not a safety
        // requirement for it — which is exactly why this call sits OUTSIDE
        // the `store.locked()` hold above, not inside it: `locked()`
        // releases `lock` only after that callback returns, and releasing
        // ALWAYS mints a fresh pair of tombstones (`release`'s own rename,
        // plus `releaseRecoveringGate`'s own) for the generation this very
        // reset just held. Sweeping before that release ran, as an earlier
        // draft of this code did, left those two fresh tombstones
        // uncompacted until some LATER reset happened to run — this way,
        // reaching `resetResult === 0` (this reset actually completed, not
        // refused) means the release has already happened, and this call
        // compacts everything, including its own reset's trailing pair.
        sweepLockQuarantine(store.file);
      }
      return resetResult;
    }

    default:
      console.error(`unknown command: ${a.cmd}`);
      usage();
      return 2;
  }
}

runMain("drive-state.ts", main);
