/**
 * Shared harness for the drive-pr-*.test.ts files: the stubbed `gh`, the
 * fixture writers, the scratch repositories and the probes. It was one
 * test file; it is split by describe block so each file stays within the
 * formatter's size limit. The suite-level notes on probe cost and the
 * spawn-boundary rule are in drive-pr-parsing.test.ts's header.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveActor } from "../scripts/lib/state/actor";
import { freshState } from "../scripts/lib/state/schema";
import { worktreeLockName } from "../scripts/lib/state/store";
// Imported, never restated: every fixture age below is derived from the
// production floor, so raising it cannot silently leave a probe sitting
// underneath it and passing vacuously.
import { STALLED_MIN_AGE_SEC } from "../scripts/lib/status/evaluate";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Seed historical global verification without bypassing the production gate. */
export function writeVerifiedSha(stateDir: string, sha: string): void {
  const path = join(stateDir, "drive-pr-999.json");
  const state = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : freshState(999);
  writeFileSync(path, JSON.stringify({ ...state, verifiedSha: sha }));
}
/**
 * The worktree lock's file name, resolved through the SAME function drive.ts
 * calls. Recomputing the hash here instead would let the two derivations drift
 * and still agree with each other's fixtures.
 */
export const WORKTREE_LOCK = await worktreeLockName();
/**
 * Opaque head tokens: 40 hex characters, and deliberately NOT objects this
 * repository contains. Almost every probe treats them as identity strings the
 * stubbed forge echoes back, so their only requirement is being distinct —
 * but a handful of paths (`reviewerPosition`, the abbreviation witness in
 * `drive-status.ts`) hand a fixture SHA to `git rev-parse`, and there a token
 * that happens to resolve silently changes what is under test.
 *
 * `HEAD` used to be a literal real commit (`c93a19d8`), reachable only from an
 * unrelated, long-idle `feature/…` branch on origin. Every probe that needed
 * it to resolve therefore passed only in a checkout that had fetched that
 * branch — CI's `fetch-depth: 0` does, a shallow or single-branch clone does
 * not — so the suite's verdict depended on a branch nobody would think twice
 * about deleting. `mode 5b` below already names this exact hazard for its own
 * fixture; the module constants must not have it either.
 * `realHead()` is what a probe
 * that genuinely needs git to answer uses instead, and
 * `the head tokens are not objects in this repository` pins the property.
 */
export const HEAD = "a91d4f7c05444444444444444444444444444444";
export const PREV = "7bd2ca906c111111111111111111111111111111";
// Keep the fake git push contract independent of guarded-push.ts's own
// forwarding allowlist. Both the fully stubbed and recording git shims use it.
export const GIT_PUSH_FLAG_GUARD = `(
  [[ "$1" == push ]] || exit 2
  shift
  # guarded-push.ts always calls \`git(['push', ...extra, 'origin', refspec])\`
  # — the remote comes immediately before the refspec, never after it. Track
  # POSITION, not mere presence: checking "did 'origin' and a refspec token
  # occur somewhere" would still pass an accidentally swapped invocation
  # (\`git push <refspec> origin\`), which git itself rejects (the refspec is
  # not a valid remote name), but which recording only presence cannot catch.
  stage=remote
  for argument in "$@"; do
    case "$argument" in
      --force-with-lease|--force-with-lease=*|--atomic|--quiet|-q|--verbose|-v|--dry-run|--porcelain|--verify) continue ;;
    esac
    # Recognize (and reject) anything flag-shaped BEFORE the stage machine
    # below sees it — otherwise a misspelled flag like --forse-with-lease
    # would be judged as the remote/refspec positional instead of reported
    # as the unknown flag it actually is.
    case "$argument" in
      -*) echo "git push: unknown argument: $argument" >&2; exit 2 ;;
    esac
    case "$stage" in
      remote)
        [[ "$argument" == origin ]] || {
          echo "git push: expected remote 'origin' first, got '$argument'" >&2; exit 2;
        }
        stage=refspec ;;
      refspec)
        case "$argument" in
          ?*:refs/heads/?*) stage=done ;;
          *) echo "git push: expected a refs/heads/* refspec after the remote, got '$argument'" >&2; exit 2 ;;
        esac ;;
      done) echo "git push: unexpected extra argument: $argument" >&2; exit 2 ;;
    esac
  done
  [[ "$stage" == done ]] || {
    echo 'git push: missing remote or refspec' >&2; exit 2;
  }
) || exit $?
`;
/**
 * This working tree's actor id, resolved through the SAME function the scripts
 * call, for the same reason `WORKTREE_LOCK` is: a literal copied from one
 * machine's output is a fixture that only holds on that machine, and a
 * re-implementation of the hash here is a second derivation to drift.
 *
 * Every `state()` call below runs with the suite's own cwd, so this is the
 * actor stamped onto every hold they make. The tests that need a SECOND actor
 * make a second real worktree (see the per-hold-provenance block) — the
 * derivation is not overridable, deliberately.
 */
export const ACTOR = await resolveActor();
/**
 * Real, correctly-ordered ISO instants for the `isRecycledPid` ordering
 * probes — NOT arbitrary string labels. A label
 * like `'dead-predecessor-token'` sorting before `'new-successor-token'` only
 * by lexicographic accident ('d' < 'n') pins the WRONG invariant: the
 * fixture would stay green even if the ordering comparison were removed
 * entirely, since it never actually exercises chronological order. These
 * round-trip through `new Date(ms).toISOString`, matching exactly what
 * `parseStrictIsoInstantMs` in `lease.ts` requires to trust them.
 */
export const OLDER_SESSION_TOKEN = new Date(Date.now() - 120_000).toISOString();
export const NEWER_SESSION_TOKEN = new Date(Date.now() - 60_000).toISOString();
/**
 * A `lastSeen` safely past `leaseStaleFloorMs()` (`LOCK_ACQUIRE_MAX_SEC * 1000
 * + RENEW_AFTER_MAX_MS` = 5.5 real minutes, `lease.ts`) — NOT past
 * `DRIVE_PR_LEASE_STALE_MIN`, which `leaseStaleMs()` floors at that same 5.5
 * minutes regardless of what the env var requests, so a naively "1-minute"
 * fixture would silently not be stale at all. 6 minutes clears the floor
 * without depending on any env override.
 */
export const STALE_LASTSEEN = new Date(Date.now() - 6 * 60_000).toISOString();
/** The SHA a held item's own `set-verified` stamps in the claim tests. */
export const HELD_PUSH = "11ea9f4c5b444444444444444444444444444444";
export const BASE = "de7e10ba5e222222222222222222222222222222";
export const BASE_MOVED = "de7e10ba5e333333333333333333333333333333";

/**
 * A commit that REALLY exists in whatever checkout the suite is running in,
 * resolved live rather than hardcoded. `HEAD` (the working tree's own tip) is
 * the one revision every checkout resolves — a depth-1 clone included — so a
 * probe keyed on it demands nothing of the environment.
 */
export async function realHead(): Promise<string> {
  return (await Bun.$`git rev-parse HEAD`.text()).trim();
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const backlogJson = JSON.stringify([
  {
    fingerprint: "b9a7a18089043564",
    path: "AGENTS.md",
    line: null,
    severity: "medium",
    dimension: "correctness",
    // Present on one fixture entry and absent on the sibling below,
    // so `decodeBacklog`'s value-present and value-absent (→ 'unknown') paths
    // are both exercised by the same shared fixture every other test here
    // already reuses.
    category: "drift",
    comment:
      "The Linear section claims issue creation is blocked unless Context is present.",
    firstRound: 6,
    reason: "winddown-deferred",
  },
  // No `reason`/`firstRound`: a plain "Beyond this PR" carry-forward. The
  // one-head grace keys on backlog MEMBERSHIP, so this entry must
  // get exactly the same treatment there as the wind-down-reasoned one above.
  // `reason` is NOT retired: past that one head it still selects the separate,
  // round-bounded exemption, which this entry does not get — the
  // two rules are stacked, not one superseding the other.
  {
    fingerprint: "c773d9fdb7974e6d",
    path: "AGENTS.md",
    line: null,
    severity: "low",
    dimension: "maintainability",
    comment:
      "hand-maintains the count of the four bullets immediately below it.",
  },
]);

export function stickyBody(
  opts: {
    sha?: string;
    backlog?: boolean;
    unanchored?: number;
    /** `null` omits the `ai-review-round` marker, as a format regression would. */
    round?: number | null;
  } = {},
): string {
  const sha = opts.sha ?? HEAD;
  return [
    "<!-- ai-code-review -->",
    "### 🟡 Some headline",
    "",
    "Found 1 cross-file contract gap in the latest delta.",
    "",
    "### 🎯 correctness",
    "",
    "- `.claude/agents/review-arbiter.md:31` — 🟡 **medium** (high confidence, quick) — The arbiter’s sensitivity input omits the shared-schema exception.",
    ...(opts.unanchored
      ? [
          "",
          `> ${opts.unanchored} finding(s) without a diff-anchorable line are in the summary above only.`,
        ]
      : []),
    "",
    ...(opts.backlog === false
      ? []
      : [
          "<details><summary>🗂️ <b>Beyond this PR</b></summary>",
          "",
          "- `AGENTS.md` — 🟡 **medium** (correctness · adjacent) — The Linear section claims…",
          "",
          "</details>",
        ]),
    "",
    `<!-- ai-reviewed-sha: ${sha} -->`,
    ...(opts.round === null
      ? []
      : [`<!-- ai-review-round: ${opts.round ?? 7} -->`]),
    ...(opts.backlog === false
      ? []
      : [
          `<!-- ai-review-backlog: ${Buffer.from(backlogJson).toString("base64")} -->`,
        ]),
  ].join("\n");
}

// ── Scripted probes: drive-status.ts against a stubbed forge ────────────────

export interface Fixture {
  prState?: string;
  head?: string;
  ciHeld?: boolean;
  /** Create an untracked file during set-verified's first exact PR snapshot. */
  dirtyOnFinalVerify?: boolean;
  /** check-runs on `head`. Omit the reviewer entry to model modes 2 and 4. */
  checkRuns?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    app: string;
    /** ISO timestamp, or null for a queued attempt that has not started. */
    started?: string | null;
  }>;
  statuses?: Array<{ context: string; state: string; description: string }>;
  /** Statuses reachable only on a SECOND API page — i.e. only with --paginate. */
  statusesPage2?: Array<{
    context: string;
    state: string;
    description: string;
  }>;
  /** Owner of the PR head repository; differs from base for a fork PR. */
  headRepoOwner?: string;
  /** Make the commit-status API unreadable, as a timeout or 403 would. */
  statusesUnreadable?: boolean;
  /**
   * Fail the FIRST `graphql` call of the whole invocation and succeed every
   * one after — targeting the reconciliation sweep's own thread listing
   * specifically, since the sweep issues it before `evaluate` ever runs
   * (SKILL.md § 1: "the gate reconciles it for you, before it evaluates
   * anything"). Models a sweep whose own enumeration failed (a transient
   * timeout, an auth blip) while `evaluate`'s later, independent listing —
   * graphql call #2 — succeeds normally, letting a `threads: []` fixture
   * still reach zero unresolved threads despite the sweep itself having run
   * and failed.
   */
  sweepThreadListingFailsOnce?: boolean;
  /**
   * Make the check-runs API unreadable, the same way — by removing the
   * fixture. On a MERGEABLE head that is INDETERMINATE; on a conflicting one
   * every consumer of it is skipped, so it must not block `PR_CONFLICTING`.
   */
  checkRunsUnreadable?: boolean;
  /**
   * The mergeability GitHub reports changes between the first `gh pr view`
   * read and later ones — the window `announce-merge-ready.ts` closes with its
   * last-moment re-read. Rides the same counter as `headMovesTo`.
   */
  mergeableMovesTo?: string;
  /**
   * Same mechanism, for `state`: models the last-moment re-read coming back
   * with a missing/null or unrecognized value on an otherwise-successful
   * response, distinct from `prState` (which would also change what
   * `drive-status.ts`'s OWN two reads see, and a non-OPEN prState there stops
   * the pass before it ever reaches CONVERGED). `null` models the field coming
   * back absent; any other string models a value that is not one of
   * OPEN/MERGED/CLOSED.
   */
  stateMovesTo?: string | null;
  /** Sticky-comment SHA. `null` posts no reviewer comment at all. */
  reviewedSha?: string | null;
  threads?: Array<{
    id: string;
    /**
     * Optional so a fixture can model a PR-LEVEL thread — GitHub answers
     * `path: null` for one, and `openThreadPaths` must not turn that into a
     * pseudo-path that then "recurs" every round. Serialised as
     * `null`, not omitted: the two are different wire shapes, and `null` is
     * the one GitHub actually sends.
     */
    path?: string;
    bot: boolean;
    /** `authorAssociation` of the thread's first comment. Default 'NONE'. */
    authorAssociation?: string;
    /** GitHub's `isResolved`. Default false — every listing reads open threads. */
    isResolved?: boolean;
    /**
     * The thread's comments, replacing the default single `a finding` one.
     * Only the reconciliation sweep reads bodies and per-comment
     * associations — every other consumer here cares about the thread's
     * existence, so the default stays a one-comment thread rather than making
     * every existing fixture spell out a comment list it never looks at.
     */
    comments?: Array<{
      author?: string;
      authorAssociation?: string;
      body: string;
      bot?: boolean;
    }>;
  }>;
  addressed?: string[];
  /** `author_association` for the addressed-marker comments. Default OWNER. */
  addressedBy?: string;
  /**
   * A trusted FIX-DEPENDENT marker naming a specific head — the
   * `<fingerprint>@<sha>` shape `answer-summary-finding.ts --pushed-sha`
   * writes, as opposed to `addressed`'s durable (no-`@sha`) shape. Posted as
   * an OWNER comment, exactly what a real driver's answer looks like.
   */
  fixDependentAddressed?: Array<{
    fingerprint: string;
    sha: string;
    outcome?: "accepted" | "moot";
    /**
     * The `#<round>` suffix a real answer stamps. Omitted writes a roundless
     * marker (the shape a roundless sticky produces); supplying one far enough
     * behind the sticky's own round is how a probe models a marker whose
     * winddown exemption has LAPSED — present on the PR, but no longer live.
     */
    round?: number;
  }>;
  /**
   * Anchored paths — a path here is treated as having an inline comment. The
   * round each was posted in defaults to the sticky's round, i.e. current.
   */
  anchored?: string[];
  /** Round stamped on the anchored inline comments (sticky is always 7). */
  anchoredRound?: number;
  /** Drop the sticky's own `ai-review-round` marker, as a regression would. */
  stickyRound?: null;
  /**
   * The sticky comment's own `updated_at` (ISO). Defaults to
   * `DEFAULT_STICKY_UPDATED_AT` — old enough to clear the stranded-bypass age
   * floor, and later than the `started` every bypass fixture uses, so probes
   * that are not about the sticky's dating are unaffected by it.
   */
  stickyUpdatedAt?: string;
  /**
   * Another actor pushes MID-EVALUATION: every head read after the first
   * answers with this SHA instead. Models the window between `evaluate()`'s
   * opening head read and its terminal one.
   */
  headMovesTo?: string;
  /** How many head reads still answer truthfully before the move. Default 1. */
  headMovesAfter?: number;
  /**
   * A head-carrying `gh pr view` read becomes UNREADABLE (non-zero exit) after
   * this many have already answered truthfully. Models a timeout or a 403 on
   * the confirmation read, as distinct from `headMovesTo` modelling a read that
   * succeeds but reports a change.
   */
  prViewUnreadableAfter?: number;
  /**
   * The PR MERGES (or closes) mid-evaluation: every `state` read after the
   * first answers with this, while the head stays exactly where it was. Models
   * the window between `evaluate()`'s opening liveness check and its terminal
   * return — invisible to a head-only witness, because a merge moves no ref.
   */
  stateChangesTo?: string;
  /** How many state reads still answer OPEN before the change. Default 1. */
  stateChangesAfter?: number;
  /** Extra reviewer comments that are NOT the sticky (no ai-code-review marker). */
  decoyReviewerComments?: string[];
  backlog?: boolean;
  /**
   * GitHub's mergeability verdict: `MERGEABLE`, `CONFLICTING`, or `UNKNOWN`
   * while it recomputes. Defaults to `MERGEABLE`.
   */
  mergeable?: string;
  /** `DIRTY`, `CLEAN`, `BEHIND`, … Evidence only; never decides a state. */
  mergeStateStatus?: string;
  /**
   * The PR is still a draft, which no reviewer arm looks at. `null` models the
   * field coming back WITH a null value on an otherwise-successful read — the
   * shape that would coerce to "Ready for review" and silently disarm the
   * gate, so it must be INDETERMINATE rather than a pass. Defaults to `false`.
   * For the field coming back OMITTED entirely (a distinct wire shape from
   * `null`), see `isDraftAbsent`.
   */
  isDraft?: boolean | null;
  /**
   * Omits `isDraft` from the `gh pr view` response entirely, rather than
   * answering it with `null` — the genuinely-absent-key shape `isDraft: null`
   * cannot model, since JSON.stringify always serialises a `null` value's key.
   * `evaluate()` reads both the same way (`typeof draft !== 'boolean'`), so
   * this and `isDraft: null` are expected to reach the identical
   * INDETERMINATE outcome.
   */
  isDraftAbsent?: boolean;
  /**
   * The PR is converted (back) to a draft mid-evaluation: every `isDraft`-
   * carrying read after the first answers `true` instead of `false`. Rides the
   * same read counter as `headMovesTo` — `still_on_head` reads `isDraft`
   * together with `state`, `headRefOid` and `baseRefOid` in one call.
   */
  isDraftMovesTo?: boolean;
  /**
   * `gh pr view --json` rejects one of the fields the script requests, as a
   * `gh` too old to know it does. That is an unmet PREREQUISITE, not a
   * supported configuration — the script reports UNSUPPORTED_CLI and exits 2
   * rather than degrading.
   */
  mergeabilityUnreadable?: boolean;
  /** The PR's base branch tip SHA. Defaults to `BASE`. */
  base?: string;
  /**
   * Another actor pushes to the BASE branch mid-evaluation, head unchanged.
   * Same mechanism as `headMovesTo` — the stub's read counter is shared,
   * since `still_on_head` reads head and base together.
   */
  baseMovesTo?: string;
  /** How many head/base reads still answer truthfully before the move. */
  baseMovesAfter?: number;
  /**
   * `baseRefName` comes back `null` even though the read otherwise succeeds —
   * drive.ts must report "unavailable", never guess a fallback branch name.
   */
  baseRefNameMissing?: boolean;
  /**
   * `mergeStateStatus` comes back `null` on an otherwise successful read. Like
   * `baseRefName` it is reported, never branched on, so it must NOT block the
   * state it merely annotates.
   */
  mergeStateStatusMissing?: boolean;
  /**
   * Every `gh pr view` call fails with a TRANSIENT error (not a missing-field
   * one) — a network blip, a timeout, a rate limit. Must report INDETERMINATE
   * (exit 1) and stay retryable, never be mistaken for a prerequisite failure.
   */
  transientMergeabilityFailure?: boolean;
  /**
   * ONLY the reconciliation sweep's own liveness probe fails — the `--json
   * state` (exact field, nothing else) read drive-status.ts makes immediately
   * ahead of the sweep. Every other `gh pr view` succeeds, so `evaluate()`
   * still reaches a verdict normally.
   *
   * That is the precise reachable path a fail-closed SKIP would have opened:
   * probe blips, sweep silently does not run, evaluation succeeds and returns
   * a verdict that does NOT re-arm — leaving nothing to retry the sweep ever
   * again.
   */
  liveProbeFails?: boolean;
  /**
   * The sweep's own liveness probe answers `CLOSED` the FIRST time and `OPEN`
   * thereafter — the reopen window. `evaluate()`'s snapshot asks for a
   * comma-joined field list, so it is unaffected and sees the PR as open,
   * which is precisely the disagreement the skip-retraction exists to catch.
   */
  liveProbeSaysClosedOnce?: boolean;
  /**
   * `evaluate()`'s own fuller snapshot (the comma-joined `--json` field list)
   * fails, while the sweep's single-field `state` probe still answers. Pairs
   * with `liveProbeSaysClosedOnce` to model the two reads disagreeing in the
   * one way that has to terminate rather than loop.
   */
  snapshotUnreadable?: boolean;
  /**
   * The sweep's liveness probe answers `CLOSED` on EVERY call while
   * `evaluate()`'s snapshot keeps reporting the PR open — a persistent
   * disagreement between the two reads, as opposed to
   * `liveProbeSaysClosedOnce`'s single-shot one. Only this shape reaches the
   * skip retraction repeatedly, which is what its own bound is about.
   */
  liveProbeSaysClosedAlways?: boolean;
}

export const STICKY_ROUND = 7;

export type CheckRunFixture = NonNullable<Fixture["checkRuns"]>[number];

export const REVIEWER_RUN: CheckRunFixture = {
  name: "AI review (shadow)",
  status: "completed",
  conclusion: "neutral",
  app: "example-review",
};
/** The permanently-dormant CI arm. Matches every reviewer-NAME pattern. */
export const DORMANT_ARM: CheckRunFixture = {
  name: "AI review",
  status: "completed",
  conclusion: "skipped",
  app: "github-actions",
};
const REQUIRED_CI_RUNS: CheckRunFixture[] = [
  "code-quality-and-build",
  "tests",
  "Schema gate",
].map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
  app: "github-actions",
  started: "2026-09-10T10:01:00Z",
}));

export let tmpRoot: string;
export let binDir: string;
/**
 * A per-suite scratch `$HOME`, so a probe that resolves `resolveStateDir`'s
 * default (no `$DRIVE_PR_STATE_DIR` override — deliberately, to test the
 * default itself) writes under `<suiteHome>/.local/state/jig/`, never the real
 * `~/.local/state/jig` on whatever machine runs this suite.
 * `gitCleanEnv` sets this for every subprocess the suite spawns; a test
 * that wants the real value (none currently do) overrides it explicitly in
 * its own `env`, which still wins over `gitCleanEnv`'s spread.
 *
 * A SUBPROCESS env, never an in-process `process.env.HOME =`: under Bun,
 * `os.homedir` ignores a runtime `$HOME` change, so an in-process fake is
 * silently ineffective.
 */
export let suiteHome: string;
/**
 * Env vars `beforeAll` overrides for the whole suite, and their values from
 * BEFORE it ran (`undefined` = the caller had them unset).
 *
 * bun runs every test FILE of one invocation in a single process, so these are
 * process-global: whatever `afterAll` leaves behind is what sibling files
 * observe. Deleting them unconditionally is not a restore — a caller that ran
 * `DRIVE_PR_LOCK_RETRY_MS=500 bun test` would have siblings see it UNSET, so
 * their timing depends on whether this file ran first.
 *
 * Every override is captured, not just the reported one: the others were
 * never restored at all, which leaks a VALUE into siblings rather than an
 * unset — the same defect, one degree worse.
 */
const SUITE_ENV_OVERRIDES = [
  "GH_CALL_TIMEOUT",
  "DRIVE_PR_HELPER_TIMEOUT",
  "DRIVE_PR_LOCK_RETRY_MS",
  "DRIVE_PR_CLAUDE_PROJECTS_DIR",
  "DRIVE_PR_CODEX_SESSIONS_DIR",
  "JIG_OVERLAY",
] as const;
let priorSuiteEnv: Map<string, string | undefined>;
/**
 * The suite's own test pacing seams while it runs, empty outside it. Set on
 * `process.env` like every override above, and also carried through
 * `gitCleanEnv()`, whose `DRIVE_PR_*` scrub would otherwise drop them from
 * every spawn built on it.
 */
let suitePacing: Record<string, string> = {};
/** Scratch repos for the probes that read local HEAD and the working tree. */
export let scratchClean: { dir: string; head: string };
export let scratchOther: { dir: string; head: string };

/**
 * `process.env` minus every `GIT_*` pointer.
 *
 * Git hooks export `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` into their
 * children, so a suite invoked from a hook inherits them — and `git init` in a
 * temp directory then operates on the REAL repository, committing into it and
 * rewriting its index. Scrub before touching any scratch repo.
 */
export function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // `DRIVE_PR_*` is scrubbed for the same reason `GIT_*` is: this suite runs
    // INSIDE a drive as often as not (drive.ts spawns a pass, the pass runs
    // the gates), and `drive.ts` exports `DRIVE_PR_TARGET` / `DRIVE_PR_SESSION`
    // / `DRIVE_PR_STATE_DIR` into everything beneath it. Inheriting those makes
    // a scratch-repo probe's `finish-round.ts` spawn (via `guarded-push.ts`)
    // read the REAL drive target and refuse a push to its own throwaway PR
    // #999 — measured: every `finish-round.ts` test in this file
    // fails when the suite is run from inside a live drive-pr pass, passing
    // only when launched from a plain shell. Same fix as
    // `resolve-review-comments/__tests__/scripts.test.ts`'s `gitCleanEnv()`.
    // Every test that wants one of these sets it EXPLICITLY in its
    // own `env` afterward, which still wins.
    //
    // `CLAUDE_PID` is the identical hazard through a harness-level variable
    // rather than a drive-pr one: it is NOT `DRIVE_PR_`-prefixed, so it
    // survived every fix above, and `lib/state/lease.ts#resolveSession`'s own
    // tier-2 fallback reads it — a suite run from inside a live Claude Code
    // session (this file's own doc comment above already says that is common,
    // not exotic) inherits the REAL session's pid through it, so a `999`-PR
    // probe can read back a lease as "already held by session pid <the real
    // one>" (measured on the `drive.ts loop control` `set-ci-hold` fixtures
    // specifically, the same shape as the `DRIVE_PR_SESSION` measurement
    // above).
    if (
      k.startsWith("GIT_") ||
      k.startsWith("DRIVE_PR_") ||
      k === "CLAUDE_PID" ||
      v === undefined
    ) {
      continue;
    }
    env[k] = v;
  }
  // The suite's own pacing seams are set by `useDrivePrSuite()`, not inherited
  // from a drive, so the scrub above must not drop them.
  Object.assign(env, suitePacing);
  // Set AFTER the copy, unconditionally, so it wins over whatever the real
  // process.env carries — see `suiteHome`'s own doc comment for why.
  env.HOME = suiteHome;
  return env;
}

/**
 * Writes a real, resolvable, parentless commit into THIS repository's object
 * store — touching no ref, index, or worktree — so a probe can hand
 * `drive-status.ts` a SHA it can actually `git rev-parse` in the same repo the
 * script runs its own git calls against. A hardcoded literal SHA is only ever
 * resolvable on the machine that happened to have the object lying around
 * (e.g. via local-only Conductor refs); this is created fresh, on THIS
 * checkout, every run — CI included.
 *
 * The identity is supplied explicitly: `commit-tree` needs an author and will
 * not invent one, so on a machine with no `user.email` — every CI runner — it
 * exits 128 with "Author identity unknown" without it.
 */
export function makeOrphanCommit(message: string): string {
  const gitOut = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      env: {
        ...gitCleanEnv(),
        GIT_AUTHOR_NAME: "drive-pr probe",
        GIT_AUTHOR_EMAIL: "probe@example.invalid",
        GIT_COMMITTER_NAME: "drive-pr probe",
        GIT_COMMITTER_EMAIL: "probe@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Surface git's own message; a bare empty string here would fail the
    // assertions below for a reason nobody could read off the output.
    expect(`git ${args[0]}: ${r.stderr.toString().trim()}`).toBe(
      `git ${args[0]}: `,
    );
    return r.stdout.toString().trim();
  };
  const tree = gitOut("rev-parse", "HEAD^{tree}");
  return gitOut("commit-tree", tree, "-m", message);
}

/**
 * A two-commit repo, hooks disabled, whose HEAD a probe can name. Two commits
 * rather than one because the retraction probes resolve HEAD~1, which a
 * single-commit repo has no answer for.
 */
export function makeScratchRepo(name: string): {
  dir: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "seed.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `seed ${name}`, "--no-verify");
  // A second commit, so the retraction probes have a real HEAD~1 to resolve.
  writeFileSync(join(dir, "seed.txt"), `${name} fixed\n`);
  git("add", "-A");
  git("commit", "-qm", `fix ${name}`, "--no-verify");
  const head = git("rev-parse", "HEAD").stdout.toString().trim();
  return { dir, head };
}

/**
 * A repo with a merge conflict resolved back to a tree that matches what was
 * already committed — `git checkout --ours` + `git add`, never `git commit` —
 * so `MERGE_HEAD` sits in the git-dir while `git status --porcelain` (even
 * hardened with `--untracked-files=normal --ignore-submodules=none`) reports
 * empty. Reproduces that gap.
 */
export function makeUnresolvedMergeRepo(name: string): {
  dir: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base", "--no-verify");
  git("checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "f.txt"), "other\n");
  git("commit", "-qam", "other", "--no-verify");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "f.txt"), "mainline\n");
  git("commit", "-qam", "mainline", "--no-verify");
  git("merge", "-q", "other", "--no-edit");
  // Resolve, but stop short of the commit that would clear MERGE_HEAD — the
  // whole point.
  git("checkout", "--ours", "f.txt");
  git("add", "f.txt");
  const head = git("rev-parse", "HEAD").stdout.toString().trim();
  return { dir, head };
}

/**
 * A repo with an interactive rebase paused at an `edit` instruction — clean
 * index/worktree (the paused commit is fully checked out), `rebase-merge`
 * sitting in the git-dir because the rebase itself was never continued or
 * aborted. Reproduces the gap where `unconcludedGitOpMarker()` checked only
 * MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD, missing rebase/am state.
 *
 * The sequence editor is a script FILE, not an inline `sed -i` invocation:
 * BSD sed (macOS, local runs) and GNU sed (CI's Linux runners) take the
 * in-place-edit flag differently, but piping through a temp file and `mv`
 * needs no `-i` at all, so the same script works on both.
 */
export function makeRebasePausedRepo(name: string): {
  dir: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "f.txt"), "commit1\n");
  git("add", "-A");
  git("commit", "-qm", "commit1", "--no-verify");
  writeFileSync(join(dir, "f.txt"), "commit2\n");
  git("add", "-A");
  git("commit", "-qm", "commit2", "--no-verify");
  writeFileSync(join(dir, "f.txt"), "commit3\n");
  git("add", "-A");
  git("commit", "-qm", "commit3", "--no-verify");
  // OUTSIDE `dir`, or it lands as an untracked file inside the very repo
  // this helper is trying to leave clean.
  const seqEditorPath = join(tmpRoot, `${name}-seq-editor.sh`);
  writeFileSync(
    seqEditorPath,
    [
      "#!/usr/bin/env bash",
      'sed -e "1s/^pick/edit/" "$1" > "$1.tmp" && mv "$1.tmp" "$1"',
      "",
    ].join("\n"),
  );
  chmodSync(seqEditorPath, 0o755);
  Bun.spawnSync(["git", "rebase", "-i", "HEAD~2"], {
    cwd: dir,
    env: { ...env, GIT_SEQUENCE_EDITOR: seqEditorPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const head = git("rev-parse", "HEAD").stdout.toString().trim();
  return { dir, head };
}

/**
 * A repo shaped like a real driven PR that has been through a base-sync
 * merge: C0 (seed.txt) → C1 (fix seed.txt, doubling as this round's own last
 * VERIFIED sha) → D (a commit on a stand-in "develop" tip, sibling to C1, off
 * a file `origin/develop` alone ever touches) → M (`git merge D`, a
 * base-sync-style merge with parents [C1, D]) → R (the round's OWN
 * single-parent commit on top of M, touching a THIRD file). `origin/develop`
 * is pointed at D.
 *
 * Exercises the base-sync exclusion:
 * `changedFilesSinceExcludingMerges(root, pr, verifiedSha)` must report ONLY
 * `round-only.txt` (R's own file) as touched by this round — never
 * `develop-only.txt` (D's file, imported solely by the base-sync merge M) —
 * even though a plain `git diff verifiedSha` (what `changedFilesSince` used
 * to compute, and what `round-plan.ts` still deliberately computes for its
 * own cumulative purpose) contains both.
 */
export function makeBaseSyncMergeRepo(name: string): {
  dir: string;
  verifiedSha: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Every call here used to run unchecked, so a failed setup step would
    // silently hand the probes below a repo shape they then assert against for
    // the wrong reason. Matches the `gitOut` pattern at `makeOrphanCommit`
    // (line 2591's own comment).
    expect(`git ${args[0]}: ${r.stderr.toString().trim()}`).toBe(
      `git ${args[0]}: `,
    );
    return r;
  };
  const gitOut = (...args: string[]) =>
    git(...args)
      .stdout.toString()
      .trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");

  writeFileSync(join(dir, "seed.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `seed ${name}`, "--no-verify");
  writeFileSync(join(dir, "seed.txt"), `${name} fixed\n`);
  git("add", "-A");
  git("commit", "-qm", `fix ${name}`, "--no-verify");
  const verifiedSha = gitOut("rev-parse", "HEAD");

  // D — a sibling commit off the SAME parent (verifiedSha), never checked
  // out as `main`: a stand-in for `origin/develop` advancing independently
  // while this round's branch sat at `verifiedSha`.
  git("branch", "-q", "devtip", "HEAD");
  git("checkout", "-q", "devtip");
  writeFileSync(join(dir, "develop-only.txt"), "from develop\n");
  git("add", "-A");
  git("commit", "-qm", "develop advances", "--no-verify");
  const devTip = gitOut("rev-parse", "HEAD");
  git("checkout", "-q", "main");

  // M — a base-sync-style merge, parents [verifiedSha, devTip].
  git("merge", "-q", "--no-ff", "devtip", "--no-edit");

  // R — the round's OWN commit, on top of the merge, touching a THIRD file.
  writeFileSync(join(dir, "round-only.txt"), "from the round\n");
  git("add", "-A");
  git("commit", "-qm", "round work", "--no-verify");
  const head = gitOut("rev-parse", "HEAD");

  git("remote", "add", "origin", "git@github.com:example-org/example-repo.git");
  git("update-ref", "refs/remotes/origin/develop", devTip);

  return { dir, verifiedSha, head };
}

/**
 * A repo whose round commit RENAMES its only file (`git mv`). Exercises the
 * rename case: without `--no-renames` on `changedFilesSinceExcludingMerges`'s
 * `git log`, a rename reports only the destination path, so a thread still
 * anchored to the pre-rename path never lands in `touched` and the guard misses
 * it.
 */
export function makeRenameRepo(name: string): {
  dir: string;
  verifiedSha: string;
  head: string;
} {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const env = gitCleanEnv();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`git ${args[0]}: ${r.stderr.toString().trim()}`).toBe(
      `git ${args[0]}: `,
    );
    return r;
  };
  const gitOut = (...args: string[]) =>
    git(...args)
      .stdout.toString()
      .trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");

  writeFileSync(join(dir, "old-name.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `seed ${name}`, "--no-verify");
  const verifiedSha = gitOut("rev-parse", "HEAD");

  // `changedFilesSinceExcludingMerges` unconditionally excludes
  // `^origin/develop` regardless of which base `roundBase()` resolved, so
  // this ref must exist even though this fixture has no base-sync merge of
  // its own — point it at the same commit the round started from.
  git("remote", "add", "origin", "git@github.com:example-org/example-repo.git");
  git("update-ref", "refs/remotes/origin/develop", verifiedSha);

  git("mv", "old-name.txt", "new-name.txt");
  git("commit", "-qm", `rename ${name}`, "--no-verify");
  const head = gitOut("rev-parse", "HEAD");

  return { dir, verifiedSha, head };
}

/**
 * Register the suite-wide setup and teardown. Every drive-pr-*.test.ts
 * file calls this once at its top level.
 */
export function useDrivePrSuite(): void {
  beforeAll(() => {
    // The scripts carry their OWN deadlines — `GH_CALL_TIMEOUT` (30s per `gh`
    // call) and `DRIVE_PR_HELPER_TIMEOUT` (120s per helper) — and the stub `gh`
    // here is a bash+jq process tree, so on a loaded machine those fire well
    // before bun's per-test budget does. A fired SCRIPT deadline presents as an
    // empty state, which reads like a parse bug rather than a timeout, and it
    // lands on a different test each run. Nothing in this file asserts a deadline
    // path, so bounding them generously removes a false failure without weakening
    // any probe.
    priorSuiteEnv = new Map(
      SUITE_ENV_OVERRIDES.map((k) => [k, process.env[k]] as const),
    );
    process.env.GH_CALL_TIMEOUT = "120";
    process.env.DRIVE_PR_HELPER_TIMEOUT = "300";
    // Compress the state lock's poll pacing for every subprocess this suite
    // spawns. The per-PR lock is a POLLING mutex, so its
    // retry interval is the handoff latency between contending claimants — at
    // the production default (1s) the concurrency probes spend almost all of
    // their wall-clock sleeping between polls, and under machine load that
    // quantum amplified into per-test-budget blowups that present as failures
    // (the stale-claim race probe: 49s idle, 423s at load ~9 against a 90s
    // budget). 25ms keeps every probe's CONTENTION real — same processes, same
    // syscalls, same interleavings — while removing only the sleeping. A test
    // that needs the production pacing sets its own value in its spawn env
    // (per-call env wins over this inherited default).
    suitePacing = { DRIVE_PR_LOCK_RETRY_MS: "25" };
    Object.assign(process.env, suitePacing);
    // The consumer configuration every probe reads: the reviewer app the
    // fixtures post as, the base branch the scratch repositories carry, and
    // the plan command the round-plan probes stub.
    process.env.JIG_OVERLAY = join(import.meta.dir, "fixtures", "overlay.yaml");

    tmpRoot = mkdtempSync(join(tmpdir(), "drive-pr-test-"));
    binDir = join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    // Point BOTH vendor state roots at empty fixture dirs for the whole suite.
    // `drive.ts` now snapshots them before EVERY round, not only
    // when diagnosing a failed pass, so without this every spawned drive in
    // this file synchronously walks the developer's real `~/.claude/projects`
    // and `~/.codex/sessions` — measured at 5932 files here — on every round.
    // That is both wall time across the repo's most timing-sensitive suite and
    // a dependency on machine state, which quota.test.ts's own header rejects
    // ("FIXTURES, NOT THE MACHINE'S REAL STATE").
    //
    // Set on `process.env` rather than at each spawn site: every spawn here
    // builds its env as `{ ...process.env, … }`, so this is the default and
    // the two tests that need a populated tree still override it by naming
    // the key explicitly after the spread.
    for (const [key, name] of [
      ["DRIVE_PR_CLAUDE_PROJECTS_DIR", "empty-claude-projects"],
      ["DRIVE_PR_CODEX_SESSIONS_DIR", "empty-codex-sessions"],
    ] as const) {
      const emptyDir = join(tmpRoot, name);
      mkdirSync(emptyDir, { recursive: true });
      process.env[key] = emptyDir;
    }
    suiteHome = mkdtempSync(join(tmpdir(), "drive-pr-test-home-"));
    scratchClean = makeScratchRepo("scratch-clean");
    scratchOther = makeScratchRepo("scratch-other");

    // A `gh` that serves fixture files from $DRIVE_PR_FIXTURES. It honours the
    // flags the scripts actually use — `-q`/`--jq` filters, `--slurp` page
    // wrapping — so the probes exercise the real jq expressions in the scripts
    // rather than a paraphrase of them.
    const stub = `#!/usr/bin/env bash
set -euo pipefail
# One line per call a script makes, for a probe that checks each one was
# traced; the stub's own nested calls are not the script's.
if [ -n "\${DRIVE_PR_STUB_GH_LOG:-}" ] && [ -z "\${DRIVE_PR_STUB_GH_NESTED:-}" ]; then
  printf '%s\\n' "\${1:-} \${2:-}" >> "$DRIVE_PR_STUB_GH_LOG"
fi
export DRIVE_PR_STUB_GH_NESTED=1
(
  # Model gh's flag parser before any fixture response. A newly misspelled
  # production flag must fail even when a canned API response exists.
  command="$1 $2"
  requires_json=0
  json_fields=''
  case "$1 $2" in
    'pr view') allowed=' --json -q --jq --repo ' ; shift 2 ; requires_json=1 ;;
    'pr checks') allowed=' --json -q --jq --repo ' ; shift 2 ; requires_json=1 ;;
    'pr ready') allowed=' --repo --undo ' ; shift 2 ;;
    'pr edit') allowed=' --repo --add-label --remove-label --body-file --title ' ; shift 2 ;;
    'repo view') allowed=' --json -q --jq ' ; shift 2 ; requires_json=1 ;;
    *)
      if [[ "$1" == api ]]; then
        allowed=' -X --method -f -F --input -q --jq --paginate --slurp -H --header --hostname --cache -i --include '
        is_api=1
        shift
      else
        echo "gh-stub: unknown command: $*" >&2; exit 2
      fi ;;
  esac
  needs_value=0
  value_flag=''
  has_positional=0
  selector=''
  for argument in "$@"; do
    if [[ "$needs_value" -eq 1 ]]; then
      [[ -n "$argument" && "$argument" != --* ]] || { echo "gh: missing flag value" >&2; exit 2; }
      if [[ "$value_flag" == --json ]]; then json_fields="$argument"; fi
      needs_value=0; continue
    fi
    case "$argument" in
      -*)
        case "$allowed" in
          *" $argument "*) ;;
          *) echo "gh: unknown flag: $argument" >&2; exit 2 ;;
        esac
        case "$argument" in --paginate|--slurp|--undo|-i|--include) ;; *) needs_value=1; value_flag="$argument" ;; esac ;;
      *)
        [[ -n "$argument" ]] || { echo 'gh: empty positional argument' >&2; exit 2; }
        selector="$argument"
        has_positional=$(( has_positional + 1 )) ;;
    esac
  done
  [[ "$needs_value" -eq 0 ]] || { echo 'gh: missing flag value' >&2; exit 2; }
  if [[ "$requires_json" -eq 1 ]]; then
    case "$command:$json_fields" in
      'pr checks:name,bucket,state'|'repo view:owner,name'|\
      'pr view:number'|'pr view:state'|'pr view:headRefOid'|\
      'pr view:baseRefName'|'pr view:baseRefName,url'|'pr view:state,isDraft'|\
      'pr view:state,headRefOid,labels'|\
      'pr view:state,headRefOid,baseRefOid'|\
      'pr view:state,baseRefName,headRefName,headRefOid'|\
      'pr view:state,headRefName,headRepositoryOwner,headRepository'|\
      'pr view:state,headRefName,title,body'|\
      'pr view:state,headRefOid,mergeable,mergeStateStatus,isDraft,labels'|\
      'pr view:state,isDraft,headRefOid,mergeable,mergeStateStatus,baseRefName,headRefName,baseRefOid') ;;
      *) echo "gh: unexpected --json projection: $json_fields" >&2; exit 2 ;;
    esac
  fi
  # \`gh api\` always needs its endpoint as a non-flag argument SOMEWHERE in
  # argv — not necessarily first: \`checkRunsFor()\` in
  # lib/status/evidence.ts puts \`--paginate --slurp\` ahead of the endpoint,
  # so this cannot be a first-argument check. Real \`gh api\` with no endpoint
  # at all refuses outright ("Error: no endpoint provided"); this fake must
  # too, rather than waving a missing endpoint straight through to a canned
  # fixture response.
  if [[ "\${is_api:-0}" -eq 1 && "$has_positional" -ne 1 ]]; then
    echo "gh-stub: gh api requires exactly one endpoint" >&2; exit 2
  fi
  # Every non-api subcommand modelled here takes at most one selector
  # (\`gh pr view [<number>]\`, \`gh repo view [<repository>]\`), so a flag that
  # lost its dashes shows up as a surplus positional — reject it the way gh
  # does ("accepts at most 1 arg(s)").
  if [[ "\${is_api:-0}" -eq 0 && "$has_positional" -gt 1 ]]; then
    echo "gh: accepts at most 1 arg(s), received $has_positional" >&2; exit 2
  fi
  if [[ "\${is_api:-0}" -eq 0 ]]; then
    case "$command:$json_fields" in
      'pr view:number'|'repo view:owner,name')
        [[ "$has_positional" -eq 0 ]] || { echo "gh: unexpected selector: $selector" >&2; exit 2; } ;;
      *)
        [[ "$has_positional" -eq 1 && "$selector" == 999 ]] || { echo "gh: expected PR selector 999, got: $selector" >&2; exit 2; } ;;
    esac
  fi
) || exit $?
F="\${DRIVE_PR_FIXTURES:?fixture dir not set}"
gh_kind="$1 $2"
filter=""
json_fields=""
query=""
slurp=0
paginate=0
prev=""
for a in "$@"; do
  case "$prev" in
    --jq|-q) filter="$a" ;;
    --json) json_fields="$a" ;;
  esac
  # Capture the literal GraphQL query text submitted via \`-f query=...\` /
  # \`-F query=...\` so a test can assert against what the SCRIPT actually sent,
  # not against the script's source file (which a stray comment or string
  # elsewhere in the file could satisfy just as well).
  case "$prev" in
    -f|-F)
      if [[ "$a" == query=* ]]; then
        query="\${a#query=}"
        printf '%s' "$query" > "$F/last-graphql-query.txt"
      fi
      ;;
  esac
  [ "$a" = "--slurp" ] && slurp=1
  [ "$a" = "--paginate" ] && paginate=1
  prev="$a"
done
has_input=0
for a in "$@"; do [ "$a" = "--input" ] && has_input=1; done

# Stall mode, for probing a deadline. \`$DRIVE_PR_STUB_HANG\` is the duration;
# \`$DRIVE_PR_STUB_HANG_ON\` narrows it to calls whose argv contains that
# substring, so a probe can stall the calls one HELPER makes while every other
# call in the same run — including the caller's own — answers normally.
#
# The sleep's stdout goes to /dev/null DELIBERATELY. A stub that handed its
# \`sleep\` child the caller's command-substitution pipe would keep that pipe
# open past the deadline, and the probe would pass while measuring the sleep
# rather than the deadline.
if [ -n "\${DRIVE_PR_STUB_HANG:-}" ]; then
  hang=1
  if [ -n "\${DRIVE_PR_STUB_HANG_ON:-}" ]; then
    hang=0
    for a in "$@"; do
      case "$a" in *"$DRIVE_PR_STUB_HANG_ON"*) hang=1 ;; esac
    done
  fi
  if [ "$hang" -eq 1 ]; then
    sleep "$DRIVE_PR_STUB_HANG" >/dev/null 2>&1
    exit 0
  fi
fi

# Real \`gh\` REFUSES \`--slurp\` together with \`--jq\`/\`--template\` (measured on
# 2.97.0). A stub that quietly honours both lets a script ship a combination
# that exits non-zero for every user — and this one fails closed on that, so the
# announcement could never be posted. Mirror the refusal.
if [ "$slurp" -eq 1 ] && [ -n "$filter" ]; then
  echo "the \\\`--slurp\\\` option is not supported with \\\`--jq\\\` or \\\`--template\\\`" >&2
  exit 1
fi

emit() {
  local body
  if [[ "$gh_kind" == 'pr view' || "$gh_kind" == 'repo view' ]]; then
    # gh returns ONLY the requested fields. A canned full object would hide a
    # caller that accidentally dropped one field from its --json projection.
    body=$(jq -c --arg fields "$json_fields" 'with_entries(select(.key as $key | ($fields | split(",") | index($key)) != null))' "$1")
  else
    body=$(cat "$1")
  fi
  [ "$slurp" -eq 1 ] && body="[$body]"
  if [ -n "$filter" ]; then printf '%s' "$body" | jq -r "$filter"; else printf '%s' "$body"; fi
}

# Unconditional poll counter, distinct from \`head-reads\` below: every \`gh pr
# view\` call whose --json list names \`isDraft\` is one evaluate() OPENING
# snapshot, and exactly one — no recheck asks for the field any more, since
# draftness stopped being a state either recheck can trip on. So this counts
# evaluate() calls, which is what a probe asserting "the wait loop polled N
# times" actually wants. Written on EVERY such call, not gated behind one of
# the move-fixture files \`head-reads\` requires, so a probe can assert "no
# retry happened" without wiring in an unrelated move mechanism just to get a
# counter file to exist.
#
# mark-ready.ts also reads \`--json state,isDraft\`, so a fixture that both
# drives and marks sees this counter advance for that read too — assert on it
# only where the drive does not mark, or account for the extra call.
if [ "\${1:-}" = "pr" ]; then
  for a in "$@"; do
    case "$a" in
      *isDraft*)
        n=0
        [ -f "$F/opening-reads" ] && n=$(cat "$F/opening-reads")
        printf '%s' "$(( n + 1 ))" > "$F/opening-reads"
        ;;
    esac
  done
fi

# A REST pull read — \`gh api -i repos/{owner}/{repo}/pulls/<N>\`, which
# lib/gh-conditional.ts's readPrLiveness issues in place of \`gh pr view --json
# state\` for the state-ONLY liveness reads. Answered BY the
# \`pr view\` fixtures rather than from a second copy of them, so every fixture
# that models a moving, unreadable or lying state keeps modelling it, and every
# counter (\`live-probes\`, \`state-reads\`, \`head-reads\`) keeps counting the same
# reads it did before the reads changed transport.
#
# The two callers share an endpoint, and the fixtures DO tell them apart: the
# sweep's probe was \`--json state -q .state\` (never a head read),
# closedSinceOpen's was the bare \`--json state\` (a head read). Each REST read
# carries an \`X-Drive-Pr-Caller\` header naming which it is (\`sweep\` /
# \`recheck\`, from lib/gh-conditional.ts's \`CallContext.caller\`), so the
# answer is decided by this call's own argv. It used to be inferred from call
# order and timing, which no fixture can make sound: an evaluation that returns
# before closedSinceOpen leaves nothing to say which read comes next. A read
# with no label is answered as the sweep's, the narrower form.
#
# No ETag header is emitted: nothing is cached, so a probe cannot be answered
# from an entry a neighbour wrote.
rest_pr=""
if [ "\${1:-}" = "api" ]; then
  for a in "$@"; do
    case "$a" in
      repos/*/pulls/*)
        rest_n="\${a##*/pulls/}"
        case "$rest_n" in ''|*[!0-9]*) ;; *) rest_pr="$rest_n" ;; esac ;;
    esac
  done
fi
if [ -n "$rest_pr" ]; then
  rest_read=(--json state -q .state)
  for a in "$@"; do
    if [ "$a" = "X-Drive-Pr-Caller: recheck" ]; then rest_read=(--json state); fi
  done
  rest_rc=0
  rest_out=$("$0" pr view "$rest_pr" "\${rest_read[@]}") || rest_rc=$?
  if [ "$rest_rc" -ne 0 ]; then
    printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n'
    exit 1
  fi
  if printf '%s' "$rest_out" | jq -e 'type == "object"' >/dev/null 2>&1; then
    rest_state=$(printf '%s' "$rest_out" | jq -r '.state // ""')
  else
    rest_state="$rest_out"
  fi
  rest_head=$(jq -r '.headRefOid // ""' "$F/pr-view.json" 2>/dev/null || true)
  rest_body=$(jq -nc --arg st "$rest_state" --arg head "$rest_head" \\
    '{state: (if $st == "OPEN" then "open"
              elif ($st == "CLOSED" or $st == "MERGED") then "closed"
              else ($st | ascii_downcase) end),
      merged: ($st == "MERGED"),
      head: {sha: $head}}')
  printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n%s' "$rest_body"
  exit 0
fi

delete_id=""
prev=""
for a in "$@"; do
  case "$prev" in
    -X|--method) if [ "$a" = "DELETE" ]; then delete_id="pending"; fi ;;
  esac
  case "$a" in
    */issues/comments/*)
      if [ "$delete_id" = "pending" ]; then delete_id="\${a##*/}"; fi ;;
  esac
  prev="$a"
done
if [ -n "$delete_id" ] && [ "$delete_id" != "pending" ]; then
  # Model a scratch edit landing DURING this DELETE — the duplicate-race
  # withdrawal path's own round-trip, distinct from the POST's. Same real
  # filesystem side effect as the other dirty-* hooks: lands in the CURRENT
  # DIRECTORY, this stub's inherited cwd.
  if [ -f "$F/dirty-on-delete" ]; then
    echo "an edit no round shipped, landed during the DELETE" > leftover-delete.txt
  fi
  printf '%s\\n' "$delete_id" >> "$F/deleted.jsonl"
  exit 0
fi

# A posted comment answers with the real API shape — an object carrying \`id\`
# and \`html_url\` — because announce-merge-ready.ts reads the id back to know
# which comment is ITS OWN when reconciling a race. Returning a bare URL would
# make that unreachable. Ids are monotonic, as GitHub's are; the base is
# overridable so a test can place the post above or below an existing one.
if [ "$has_input" -eq 1 ]; then
  # Model a scratch edit landing DURING the POST itself — the window on the
  # FAR side of the write, which the pre-POST clean check cannot see no
  # matter how late it runs. A real filesystem side effect, same as
  # dirty-after-reads above: it lands in the CURRENT DIRECTORY, which is
  # announce-merge-ready.ts's own cwd since this stub inherits it.
  if [ -f "$F/dirty-on-post" ]; then
    echo "an edit no round shipped, landed during the POST" > leftover-post.txt
  fi
  # Models the state file becoming unreadable AFTER a held finding's answer
  # posts successfully but BEFORE finish-round.ts's own subsequent
  # release-held call — a window the claim-step's own exit-3 abort cannot
  # cover, since the claim already succeeded before this point.
  if [ -f "$F/corrupt-state-on-post" ]; then
    printf 'not json' > "\${DRIVE_PR_STATE_DIR:?}/drive-pr-999.json"
  fi
  cat >> "$F/posted.jsonl"
  n=1
  [ -f "$F/posted-seq" ] && n=$(( $(cat "$F/posted-seq") + 1 ))
  printf '%s' "$n" > "$F/posted-seq"
  id=$(( \${DRIVE_PR_POSTED_ID_BASE:-9000} + n ))
  out=$(jq -nc --argjson id "$id" \\
    '{id: $id, html_url: "https://example.invalid/posted/\\($id)"}')
  if [ -n "$filter" ]; then printf '%s' "$out" | jq -r "$filter"; else printf '%s' "$out"; fi
  exit 0
fi

# Is this announce-merge-ready.ts's idempotence sweep? Discriminated by the
# ENDPOINT it asks for: it is the only caller that leaves gh's own
# \`{owner}/{repo}\` placeholders in the path. drive-status.ts paginates the very
# same comments endpoint (and the check-runs one) with the repository already
# interpolated and a jq filter, and summary-findings.ts slurps it with the
# repository interpolated too. Both must keep working, or the fixture could
# never reach CONVERGED to exercise the announcement at all.
announce_sweep=0
for a in "$@"; do
  case "$a" in
    *'{owner}/{repo}'*issues/*comments*) announce_sweep=1 ;;
  esac
done

# Model a scratch edit landing DURING one of THIS run's own comment sweeps —
# counted independently of head-reads, since the ordinary flow makes THREE
# sweep calls in total, and the third is the reconciliation one this hook
# targets: retract_stale's, this script's own idempotence-decision sweep, and
# then the post-POST reconciliation sweep itself. $F/dirty-after-sweeps names
# how many of those may answer over a clean tree before this one dirties it.
# Falls through rather than answering here, same as dirty-after-reads above.
if [ "$announce_sweep" -eq 1 ] && [ -f "$F/dirty-after-sweeps" ]; then
  n=0
  [ -f "$F/sweep-reads" ] && n=$(cat "$F/sweep-reads")
  n=$(( n + 1 ))
  printf '%s' "$n" > "$F/sweep-reads"
  if [ "$n" -gt "$(cat "$F/dirty-after-sweeps")" ]; then
    echo "an edit no round shipped, landed during a sweep" > leftover-sweep.txt
  fi
fi

if [ -f "$F/paginate-fails" ] && [ "$announce_sweep" -eq 1 ]; then
  echo "gh-stub: simulated comment-sweep failure" >&2
  exit 1
fi

# Model the residue of an INTERRUPTED earlier run: a real announcement, from a
# trusted author, whose marker names a head the PR has since moved past. Present
# in every sweep from the start — unlike the race fixture below, nothing this run
# does creates it. Scoped to the live head the sweep cannot see it at all, so
# this is the fixture that says whether the stale-announcement retraction works.
if [ -f "$F/stale-announcement" ] && [ "$announce_sweep" -eq 1 ]; then
  # DELETED comments stop being returned, as the real API would have it.
  # Without that, a sweep taken AFTER a retraction still sees the comment it
  # just removed — so any probe about what the script does with a post-cleanup
  # read would be answering from pre-cleanup data, and could pass while the bug
  # it targets stands.
  gone='[]'
  if [ -f "$F/deleted.jsonl" ]; then
    gone=$(jq -R -s 'split("\\n") | map(select(length > 0) | tonumber)' "$F/deleted.jsonl")
  fi
  jq -nc --arg o "\${DRIVE_PR_ANNOUNCE_OPENER_FIXTURE:-}" \\
         --arg stale "$(cat "$F/stale-announcement")" \\
         --argjson gone "$gone" \\
    '[{id: 7, body: ($o + "\\n\\nan earlier run was killed before it could withdraw this\\n\\n<!-- drive-pr-merge-ready: " + $stale + " -->"),
       user: {login: "other"}, author_association: "OWNER"}]
     | map(select(.id as $i | ($gone | index($i)) == null))' \\
    > "$F/stale-comments.json"
  emit "$F/stale-comments.json"
  exit 0
fi

# Model the concurrent-driver race: the FIRST marker sweep sees nothing, and a
# rival's announcement (id 1, below anything this stub posts) appears only in
# the sweep that runs after our own post. That is exactly the interleaving
# check-then-act cannot prevent, so it is the one the reconciliation must settle.
#
# OUR OWN posted comment is in the list too, as the real API would return it —
# without it the sweep sees only the rival, the lowest id is trivially the
# rival's, and the reconciliation's tie-break is never actually exercised.
#
# The rival body is a REAL announcement — opener first, marker last — because
# the sweep now matches on that shape. $DRIVE_PR_QUOTER, when set, adds a
# lower-id comment that merely QUOTES the marker: it must neither suppress a
# genuine announcement nor become the \`lowest\` that makes a driver delete its own.
# $DRIVE_PR_FORGER adds a lower-id comment that reproduces the announcement
# EXACTLY — both strings are public — from an author GitHub does not vouch for.
if [ -f "$F/race-after-post" ] && [ -f "$F/posted-seq" ] \\
   && [ "$announce_sweep" -eq 1 ]; then
  jq -nc --arg m "\${DRIVE_PR_MERGE_MARKER_FIXTURE:-}" \\
         --arg o "\${DRIVE_PR_ANNOUNCE_OPENER_FIXTURE:-}" \\
         --arg quoter "\${DRIVE_PR_QUOTER:-}" \\
         --arg forger "\${DRIVE_PR_FORGER:-}" \\
         --argjson rid "\${DRIVE_PR_RIVAL_ID:-1}" \\
         --argjson ours "$(( \${DRIVE_PR_POSTED_ID_BASE:-9000} + $(cat "$F/posted-seq") ))" \\
    '[{id: $rid, body: ($o + "\\n\\nthe rival driver got there first\\n\\n" + $m),
       user: {login: "other"}, author_association: "OWNER"},
      {id: $ours, body: ($o + "\\n\\nthe announcement this run posted\\n\\n" + $m),
       user: {login: "us"}, author_association: "OWNER"}]
     + (if $quoter == "" then [] else
         [{id: 0, body: ("discussing the script: it stamps " + $m + " at the end"),
           user: {login: "human"}, author_association: "COLLABORATOR"}] end)
     + (if $forger == "" then [] else
         [{id: 0, body: ($o + "\\n\\nthe review drive converged\\n\\n" + $m),
           user: {login: "drive-by"}, author_association: "NONE"}] end)' \\
    > "$F/raced-comments.json"
  emit "$F/raced-comments.json"
  exit 0
fi

if [ -f "$F/no-mergeability" ]; then
  for a in "$@"; do
    case "$a" in
      *mergeable*)
        echo 'Unknown JSON field: "mergeable"' >&2
        exit 1 ;;
    esac
  done
fi

# A TRANSIENT failure — a network blip, a rate limit, a timeout — as opposed
# to the two fixtures above, which model a permanently unsupported field. The
# distinguishing property under test: this must NOT degrade the merge-conflict
# guard, only report INDETERMINATE (exit 1) for the caller to retry. Fails
# every \`gh pr view\` call while present, so a probe that expects retry-then-
# succeed removes the file between polls itself (see the test).
if [ -f "$F/transient-failure" ]; then
  case "\${1:-}" in
    pr) echo "gh-stub: simulated transient network failure" >&2; exit 1 ;;
  esac
fi

# A transient failure of the sweep's liveness probe ALONE. Matched on an
# argument that is EXACTLY \`state\` — the sweep's probe asks for that one field
# and nothing else, while evaluate()'s opening snapshot and still_on_head()
# both ask for comma-joined lists (\`state,isDraft,…\`), so this fails the probe
# and leaves every verdict-bearing read working. That separation is the whole
# fixture: it models the one path where a silent skip would have stranded the
# sweep behind a verdict that never re-arms.
# Counts the sweep's OWN liveness probes and nothing else: the \`--json state\`
# reads that carry a \`-q\` filter. closedSinceOpen's recheck is the bare
# \`--json state\` and is deliberately NOT counted, so one sweep attempt is one
# count even when the evaluation goes on to reach its recheck — this is the
# sweep-attempt count. (When the REST arm above cannot tell the two apart, the
# counter can only UNDER-count sweeps, never over-count them, so an assertion
# that attempts exceeded a bound cannot pass falsely.) Unconditional, like
# \`opening-reads\` above, so a probe can assert how many times the gate
# ATTEMPTED a sweep without wiring in an unrelated fixture just to make a
# counter file exist. Placed AHEAD of the failure branches below, so an
# attempt that FAILS is still counted — a probe asserting how many attempts a
# bound allowed needs the failed ones most of all.
if [ "\${1:-}" = "pr" ]; then
  has_state=""
  has_q=""
  for a in "$@"; do
    if [ "$a" = "state" ]; then has_state=1; fi
    if [ "$a" = "-q" ]; then has_q=1; fi
  done
  if [ -n "$has_state" ] && [ -n "$has_q" ]; then
    n=0
    [ -f "$F/live-probes" ] && n=$(cat "$F/live-probes")
    printf '%s' "$(( n + 1 ))" > "$F/live-probes"
  fi
fi

if [ -f "$F/live-probe-fails" ] && [ "\${1:-}" = "pr" ]; then
  for a in "$@"; do
    if [ "$a" = "state" ]; then
      echo "gh-stub: simulated liveness-probe failure" >&2; exit 1
    fi
  done
fi

# evaluate()'s fuller snapshot is unreadable while the sweep's single-field
# probe still answers. Matched on a MULTI-field \`--json\` list (it contains a
# comma), which is exactly what distinguishes the two reads.
if [ -f "$F/snapshot-unreadable" ] && [ "\${1:-}" = "pr" ]; then
  for a in "$@"; do
    case "$a" in
      *,*) echo "gh-stub: simulated snapshot read failure" >&2; exit 1 ;;
    esac
  done
fi

# A PERSISTENT disagreement: the sweep's own liveness probe answers CLOSED on
# EVERY call while evaluate()'s snapshot keeps reporting the PR open. Distinct
# from the once-only fixture below — a one-shot disagreement resolves itself on
# the next iteration and so cannot exercise the retraction's own bound at all.
#
# The SWEEP's probe only — the \`-q .state\` form, never closedSinceOpen's bare
# \`--json state\`. This arm used to match either, so closedSinceOpen (which
# parses JSON) choked on the raw \`CLOSED\`, returned exit 1, and the retraction
# — which requires \`code !== 1\` — was never reached: the probe passed while
# asserting ordinary \`case 1\` termination, the vacuity its own comment above
# records having fixed once before. Now that closedSinceOpen reads a real
# (REST) document, the two are told apart by the filter, as the fixture always
# claimed.
if [ -f "$F/live-probe-closed-always" ] && [ "\${1:-}" = "pr" ] && [ -n "$filter" ]; then
  for a in "$@"; do
    if [ "$a" = "state" ]; then printf 'CLOSED'; exit 0; fi
  done
fi

# The reopen window: the sweep's own liveness probe answers CLOSED on its FIRST
# call and OPEN on every later one, while evaluate()'s snapshot (a comma-joined
# field list, so it does not match here) keeps seeing an open PR. That is the
# disagreement between the two independent reads that the skip-retraction is
# there to catch.
if [ -f "$F/live-probe-closed-once" ] && [ "\${1:-}" = "pr" ] && [ -n "$filter" ]; then
  for a in "$@"; do
    if [ "$a" = "state" ]; then
      if [ ! -f "$F/live-probe-closed-used" ]; then
        : > "$F/live-probe-closed-used"
        printf 'CLOSED'
        exit 0
      fi
    fi
  done
fi


# Model the PR MERGING mid-run. State reads are counted the same way head reads
# are below, and every read past the number in \`state-changes-after\` answers
# with a different \`state\` while the head STAYS PUT — which is the whole point:
# a merge does not move the head, so a head-only witness cannot see it.
#
# Matched on the \`--json\` field list, so both \`--json state\` (evaluate()'s
# opening liveness read) and \`--json state,headRefOid\` (the terminal witness)
# count, and \`-q .state\` does not double-count the same call.
if [ -f "$F/state-changes-after" ] && [ "\${1:-}" = "pr" ]; then
  wants_state=0
  for a in "$@"; do
    case "$a" in state|state,*|*,state|*,state,*) wants_state=1 ;; esac
  done
  if [ "$wants_state" -eq 1 ]; then
    n=0
    [ -f "$F/state-reads" ] && n=$(cat "$F/state-reads")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/state-reads"
    if [ "$n" -gt "$(cat "$F/state-changes-after")" ]; then
      emit "$F/pr-view-state-changed.json"; exit 0
    fi
  fi
fi

# Model another actor pushing MID-RUN. Head reads are counted, and every read
# past the number in \`head-moves-after\` answers with a different SHA. The
# count is what lets one fixture target any of several windows: drive-status.ts
# reads the head once in evaluate()'s opening snapshot (\`1\`), then again in
# still_on_head() immediately before a terminal return (\`2\`) — whether that
# recheck runs inside a direct drive-status.ts probe, or inside the
# drive-status.ts SUBPROCESS announce-merge-ready.ts spawns to decide
# CONVERGED. A probe that drives announce-merge-ready.ts shares this SAME
# counter across both processes, so ITS OWN re-reads — the up-front liveness
# check, check_live_state() before the idempotence decision, check_live_state()
# immediately before POSTing, and the post-write confirmation read — extend the
# count past \`2\`, in the order the script actually issues them.
#
# Matched as a SUBSTRING of the \`--json\` argument, not as a whole token or by
# equality: real \`gh\` takes a comma-separated field list, drive-status.ts reads
# the head in one snapshot together with \`state\`, \`mergeable\` and
# \`mergeStateStatus\` so the mergeability verdict cannot name a different commit
# than the head does, and announce-merge-ready.ts's own reads ask for
# \`--json state,headRefOid\` in yet another combination. A whole-token or
# equality test silently stops counting one of those snapshots as a head read,
# and every head-moved probe built on it opens its window one read too late —
# or never. \`*isDraft*\` also matches, for the opening snapshot and for
# mark-ready.ts's own \`--json state,isDraft\` read.
#
# The bare \`state\` arm is an EXACT match, not a substring: \`closedSinceOpen\`'s
# ROUND_READY recheck asks for \`--json state\` and nothing else, so no other
# pattern here sees it and a fixture targeting THAT window would never advance
# the counter. It has to be exact because \`state\` as a substring appears in
# almost every field list the stub is asked for (\`state,isDraft,headRefOid,...\`),
# which would double-count the opening snapshot and shift every existing
# head-moved window by one.
#
# …and it is additionally gated on there being NO \`-q\` filter, because a second
# caller now issues \`--json state\` too: the reconcile sweep's liveness probe,
# which asks \`--json state -q .state\`. That one is not a head read at all — it
# decides whether the sweep may run — so counting it advanced every
# \`headMovesAfter\` window by one the moment the sweep became the harness
# default, breaking every head-race probe at once. \`closedSinceOpen\` passes no
# \`-q\`; the sweep's probe always does. Distinguishing on that keeps both
# fixtures honest without either production read changing shape to suit the
# stub.
if [ -f "$F/head-moves-after" ]; then
  wants_head=0
  for a in "$@"; do
    case "$a" in
      *headRefOid*|*isDraft*) wants_head=1 ;;
      state) [ -z "$filter" ] && wants_head=1 ;;
    esac
  done
  if [ "$wants_head" -eq 1 ]; then
    n=0
    [ -f "$F/head-reads" ] && n=$(cat "$F/head-reads")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/head-reads"
    if [ "$n" -gt "$(cat "$F/head-moves-after")" ]; then
      emit "$F/pr-view-moved.json"; exit 0
    fi
  fi
fi

# Model a scratch edit landing only after final-ready has established the
# exact-head CI registration and set-verified starts its own evidence chain.
# Both use this exact field list; call 1 is final-ready and call 2 is the first
# set-verified snapshot. The write lands in drive.ts's real cwd so only its
# post-verification worktree certificate can catch it.
if [ -f "$F/dirty-on-final-verify" ] && [ "\${1:-}" = "pr" ]; then
  for a in "$@"; do
    if [ "$a" = "state,headRefOid,labels" ]; then
      n=0
      [ -f "$F/final-verify-reads" ] && n=$(cat "$F/final-verify-reads")
      n=$(( n + 1 ))
      printf '%s' "$n" > "$F/final-verify-reads"
      if [ "$n" -eq 2 ]; then
        echo "an edit landed during final verification" > leftover-final-verify.txt
      fi
    fi
  done
fi

# Model a SCRATCH EDIT landing mid-run — the tree was clean when this script's
# own up-front pass ran, and a probe (or a stray edit) lands in the working
# directory some number of head-reads later. Shares the head-reads counter
# above; never combined with head-moves-after / pr-view-unreadable-after in
# the same fixture. The write is a REAL filesystem side effect, not a
# response substitution — it lands in the CURRENT DIRECTORY, which is
# announce-merge-ready.ts's own cwd since this stub inherits it, so the
# script's later \`git status --porcelain\` calls actually see it. Falls
# through rather than answering here, since the caller still needs the
# ordinary JSON response for whichever call this is.
if [ -f "$F/dirty-after-reads" ]; then
  wants_head=0
  for a in "$@"; do case "$a" in *headRefOid*|*isDraft*) wants_head=1 ;; esac; done
  if [ "$wants_head" -eq 1 ]; then
    n=0
    [ -f "$F/head-reads" ] && n=$(cat "$F/head-reads")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/head-reads"
    if [ "$n" -gt "$(cat "$F/dirty-after-reads")" ]; then
      echo "an edit no round shipped, landed mid-run" > leftover-midrun.txt
    fi
  fi
fi

# Model a COMMIT landing mid-run — distinct from the uncommitted-edit fixture
# above: this one is fully committed, so it advances local HEAD past what
# drive-status.ts already read and verified, while leaving \`git status\`
# reporting nothing uncommitted. Shares the head-reads counter; never
# combined with the other head-reads fixtures. \`-after-done\` guards against
# committing again on every later read once the threshold is passed.
if [ -f "$F/commit-after-reads" ]; then
  wants_head=0
  for a in "$@"; do case "$a" in *headRefOid*|*isDraft*) wants_head=1 ;; esac; done
  if [ "$wants_head" -eq 1 ]; then
    n=0
    [ -f "$F/head-reads" ] && n=$(cat "$F/head-reads")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/head-reads"
    if [ "$n" -gt "$(cat "$F/commit-after-reads")" ] \\
       && [ ! -f "$F/commit-after-reads-done" ]; then
      touch "$F/commit-after-reads-done"
      echo "an unreviewed commit, landed mid-run" > unreviewed-midrun.txt
      git add -A >/dev/null 2>&1
      git commit -qm "unreviewed local commit, landed mid-run" --no-verify \\
        >/dev/null 2>&1
    fi
  fi
fi

# Model the confirmation read itself becoming UNREADABLE (a timeout, a 403) —
# distinct from a read that succeeds but reports a moved PR. Shares the
# head-reads counter above; fixtures use one mechanism or the other, never both.
if [ -f "$F/pr-view-unreadable-after" ]; then
  wants_head=0
  for a in "$@"; do case "$a" in *headRefOid*) wants_head=1 ;; esac; done
  if [ "$wants_head" -eq 1 ]; then
    n=0
    [ -f "$F/head-reads" ] && n=$(cat "$F/head-reads")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/head-reads"
    if [ "$n" -gt "$(cat "$F/pr-view-unreadable-after")" ]; then
      echo "gh-stub: simulated unreadable pr view" >&2
      exit 1
    fi
  fi
fi

# \`gh pr ready <PR>\` — the draft→Ready transition mark-ready.ts fires. Recorded
# so a probe can assert it happened exactly once (the transition is durably
# once-only, and firing it twice re-triggers the paid external review it exists
# to spend deliberately).
#
# The fixture's own pr-view.json is REWRITTEN to isDraft:false, because that is
# what GitHub does: every later snapshot in the same run must see the PR as
# Ready. Without it a drive would re-read \`isDraft: true\` after marking and the
# once-only property would be tested only against the durable claim, never
# against the live flag it is supposed to agree with.
#
# $F/pr-ready-no-flip suppresses exactly that rewrite, modelling GitHub's
# replication lag — a \`pr view\` inside the window still answering \`isDraft:
# true\` after the transition landed. That is the ONLY condition under which the
# durable claim is load-bearing, so a probe that wants to test the claim rather
# than the flag has to ask for it: with the flip in place, "marked once" passes
# even with the claim disabled entirely (measured by mutation, 2026-08-13).
# A PR that stops being OPEN between drive-status.ts's gate and mark-ready.ts's
# own re-read. Keyed on the exact field set mark-ready.ts asks for
# (\`--json state,isDraft\`), which no other caller here requests, so the
# fixture can move that one read without disturbing the gate that ran before it.
if [ -f "$F/pr-closes-before-mark-ready" ]; then
  for a in "$@"; do
    if [ "$a" = "state,isDraft" ]; then
      printf '{"state":"MERGED","isDraft":true}\\n'
      exit 0
    fi
  done
fi

# The owner converts an already-Ready PR back to draft in the window BEFORE
# the pre-pass --record-only call's own read — distinct from the sentinel
# above (which models the PR CLOSING in that window). Same exact field-set
# match as mark-ready.ts's own signature, so drive-status.ts's broader
# opening snapshot (which reports isDraft:false, the guard for even calling
# --record-only) is undisturbed.
if [ -f "$F/draft-flip-before-record-only-read" ]; then
  for a in "$@"; do
    if [ "$a" = "state,isDraft" ]; then
      printf '{"state":"OPEN","isDraft":true}\\n'
      exit 0
    fi
  done
fi

# The owner converts an already-Ready PR back to DRAFT while a round's PASS is
# running — a wall-clock event, not a read count: a counter cannot tell "the
# pre-pass call's read" from "the post-pass call's read" apart, since exactly
# one of the two ever issues a live \`state,isDraft\` read in either case (the
# other short-circuits on the durable record) and it is always that read's
# FIRST ever occurrence. So this is keyed on the PASS's own side effect
# instead: the fixture's pass command touches \`$F/mid-pass-draft-flip\` as it
# runs, and any \`state,isDraft\` read from THAT point on sees isDraft:true.
# Keyed on the same exact field set as the sentinel above — mark-ready.ts's
# own signature, never the opening gate's broader read.
if [ -f "$F/mid-pass-draft-flip" ]; then
  for a in "$@"; do
    if [ "$a" = "state,isDraft" ]; then
      printf '{"state":"OPEN","isDraft":true}\\n'
      exit 0
    fi
  done
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "ready" ]; then
  printf '%s\\n' "\${3:-}" >> "$F/ready-calls"
  if [ -f "$F/pr-ready-fails" ]; then
    echo "gh-stub: simulated 'pr ready' failure" >&2
    exit 1
  fi
  # The LOST RESPONSE: the request lands (the PR really is Ready afterwards)
  # and the call still exits non-zero, because the response was lost or the
  # deadline fired first. Distinguished from pr-ready-fails above precisely
  # because the caller must not read the two the same way.
  if [ -f "$F/pr-ready-fails-after-applying" ]; then
    for v in pr-view.json pr-view-moved.json; do
      if [ -f "$F/$v" ]; then
        jq '.isDraft = false' "$F/$v" > "$F/$v.tmp" && mv "$F/$v.tmp" "$F/$v"
      fi
    done
    echo "gh-stub: simulated lost response after 'pr ready' applied" >&2
    exit 1
  fi
  if [ ! -f "$F/pr-ready-no-flip" ]; then
    for v in pr-view.json pr-view-moved.json; do
      if [ -f "$F/$v" ]; then
        jq '.isDraft = false' "$F/$v" > "$F/$v.tmp" && mv "$F/$v.tmp" "$F/$v"
      fi
    done
  fi
  exit 0
fi

# The owner converts the PR back to draft in the window WHILE
# checkLiveState()'s own re-reads run — distinct from the opening gate's
# read, which uses a different field list. Matched on the EXACT field list
# checkLiveState() requests (unique to it in this script), with its own
# counter: the FIRST such call still sees the fixture's own isDraft (letting
# the opening CONVERGED gate and this function's first call, liveRc, pass
# normally), and any call after that sees isDraft:true.
if [ -f "$F/draft-after-live-state-reads" ]; then
  for a in "$@"; do
    if [ "$a" = "state,headRefOid,mergeable,mergeStateStatus,isDraft,labels" ]; then
      n=0
      [ -f "$F/live-state-reads" ] && n=$(cat "$F/live-state-reads")
      n=$(( n + 1 ))
      printf '%s' "$n" > "$F/live-state-reads"
      if [ "$n" -gt "$(cat "$F/draft-after-live-state-reads")" ]; then
        jq '.isDraft = true' "$F/pr-view.json" > "$F/pr-view.json.tmp" && mv "$F/pr-view.json.tmp" "$F/pr-view.json"
      fi
    fi
  done
fi

# checkLiveState()'s OWN isDraft read answers with a malformed value (field
# omitted) from its very FIRST call — distinct from the fixture's own
# pr-view.json, which the opening gate reads and which must still be a
# valid boolean for the PR to converge at all. Unconditional (no counter):
# every checkLiveState() call after this sentinel is armed sees it.
if [ -f "$F/malformed-isdraft-on-live-state-reads" ]; then
  for a in "$@"; do
    if [ "$a" = "state,headRefOid,mergeable,mergeStateStatus,isDraft,labels" ]; then
      jq 'del(.isDraft)' "$F/pr-view.json" > "$F/pr-view.json.tmp" && mv "$F/pr-view.json.tmp" "$F/pr-view.json"
    fi
  done
fi

if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "edit" ]; then
  action=""
  for a in "$@"; do
    [ "$a" = "--add-label" ] && action="labeled"
    [ "$a" = "--remove-label" ] && action="unlabeled"
  done
  [ -n "$action" ] || { echo "gh-stub: unsupported pr edit" >&2; exit 1; }
  if [ "$action" = "labeled" ]; then
    jq '.labels = ((.labels + [{name:"ci:hold"}]) | unique_by(.name))' "$F/pr-view.json" > "$F/pr-view.json.tmp"
  else
    jq '.labels = [.labels[] | select(.name != "ci:hold")]' "$F/pr-view.json" > "$F/pr-view.json.tmp"
    jq '(.check_runs[] | select(.name == "code-quality-and-build" or .name == "tests" or .name == "Schema gate")) |= (.id += 20000 | .created_at = "2026-09-10T10:02:00Z" | .started_at = "2026-09-10T10:02:00Z")' "$F/check-runs.json" > "$F/check-runs.json.tmp"
    mv "$F/check-runs.json.tmp" "$F/check-runs.json"
  fi
  mv "$F/pr-view.json.tmp" "$F/pr-view.json"
  n=$(jq 'length + 1' "$F/timeline.json")
  jq --arg event "$action" --arg node "LE_$n" \
    '. + [{node_id:$node,event:$event,label:{name:"ci:hold"},actor:{login:"drive-user"},created_at:"2026-09-10T10:00:00Z"}]' \
    "$F/timeline.json" > "$F/timeline.json.tmp"
  mv "$F/timeline.json.tmp" "$F/timeline.json"
  exit 0
fi

if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "user" ]; then
  printf '%s\n' 'drive-user'
  exit 0
fi

case "\${1:-}" in
  pr)   emit "$F/pr-view.json"; exit 0 ;;
  repo) emit "$F/repo-view.json"; exit 0 ;;
  api) ;;
  *) echo "gh-stub: unhandled command $*" >&2; exit 1 ;;
esac

# The resolveReviewThread mutation, discriminated from an ordinary thread-list
# graphql query by name (it appears in the \`-f query=...\` string). Answered
# with a REAL success shape rather than falling through to threads.json (whose
# \`.data.resolveReviewThread...\` path is simply absent) so a probe can assert
# the wrapper's \`exec\` handoff actually reached the mutation, and WHICH thread
# id it carried — recorded to \`resolved-threads.jsonl\` for exactly that.
#
# $F/resolve-thread-fails models the mutation itself failing (a stalled
# connection, a transient GraphQL error) AFTER resolve-held-thread.ts has
# already atomically claimed the held item — the one failure mode that needs a
# restore, since every check ahead of the claim is read-only.
# The review skill reads the owning PR's liveness immediately before every
# thread mutation. Answered from the same pr-view.json fixture the PR reads use.
for a in "$@"; do
  case "$a" in
    *"pullRequest { number state }"*)
      tid=""
      for b in "$@"; do case "$b" in threadId=*) tid="\${b#threadId=}" ;; esac; done
      st=$(jq -r '.state // "OPEN"' "$F/pr-view.json")
      printf '{"data":{"node":{"__typename":"PullRequestReviewThread","id":"%s","pullRequest":{"number":999,"state":"%s"}}}}' "$tid" "$st"
      exit 0 ;;
  esac
done

for a in "$@"; do
  case "$a" in
    *resolveReviewThread*)
      if [ -f "$F/resolve-thread-fails" ]; then
        echo "gh-stub: simulated resolveReviewThread failure" >&2
        exit 1
      fi
      for b in "$@"; do
        case "$b" in
          threadId=*) printf '%s\\n' "\${b#threadId=}" >> "$F/resolved-threads.jsonl" ;;
        esac
      done
      # Models a CONCURRENT driver resolving a DIFFERENT held thread between
      # finish-round.ts's own batch snapshot and THIS item's dispatch: a key
      # gone from \`held\` by the time its own resolve-held-thread.ts call runs
      # must read as a stale snapshot (re-read), not a permanent refusal.
      # $F/vanish-key-on-resolve holds the OTHER key to release; \`--if-present\`
      # because a retry of THIS same mutation must not fail a second release.
      if [ -f "$F/vanish-key-on-resolve" ]; then
        vk=$(cat "$F/vanish-key-on-resolve")
        ${JSON.stringify(join(SCRIPTS, "drive-state.ts"))} release-held 999 --key "$vk" --if-present >/dev/null 2>&1 || true
      fi
      out='{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
      if [ -n "$filter" ]; then printf '%s' "$out" | jq -r "$filter"; else printf '%s' "$out"; fi
      exit 0 ;;
  esac
done

# \`resolve-held-thread.ts\`'s own single-thread \`node(id:...)\` staleness
# recheck — discriminated from the PR-wide \`threads.json\` listing the same
# way \`triage-thread.test.ts\`'s
# own stub already discriminates it (by literal substring, since both this
# and the ordinary query arrive as \`gh api graphql ...\`). Answered from the
# SAME \`threads.json\` fixture data \`writeFixture({ threads: [...] })\`
# already wrote, rather than a second fixture format: looks up the node whose
# \`id\` matches the query's own \`id=...\` argument and re-wraps its
# \`comments\` and \`isResolved\` fields (the only ones this caller reads) as
# \`{data: {node: {comments: ..., isResolved: ...}}}\`.
for a in "$@"; do
  case "$a" in
    *"node(id:"*)
      tid=""
      for b in "$@"; do case "$b" in id=*) tid="\${b#id=}" ;; esac; done
      node=$(jq --arg id "$tid" 'first(.data.repository.pullRequest.reviewThreads.nodes[] | select(.id == $id)) | {comments, isResolved}' "$F/threads.json")
      if [ -z "$node" ] || [ "$node" = "null" ]; then
        echo "gh-stub: node(id:) query matched no thread for id '$tid'" >&2
        exit 1
      fi
      # \`resolve-held-thread.ts\`'s own dropReheldKey() re-verification:
      # models a thread that reads resolved on the FIRST \`node(id:\` call
      # (\`staleCheck\`) but UNRESOLVED — reopened — by the SECOND
      # \`node(id:\` call this same invocation makes (dropReheldKey's own
      # re-check, immediately before its delete). A per-thread counter file
      # is what tells "first" from "second" apart, since both calls hit
      # this identical branch. Two independent, composable opt-ins:
      #   $F/reopen-on-second-noderead — flips \`isResolved\` to false from
      #     the SECOND read onward.
      #   $F/rehold-key-after-first-noderead — a CONCURRENT driver's own
      #     re-triage landing in the same window: as a SIDE EFFECT of the
      #     FIRST read (before dropReheldKey's own \`held-keys\` check ever
      #     runs), re-adds the held key GitHub-side-effect style, the same
      #     pattern $F/vanish-key-on-resolve above already uses for the
      #     opposite mutation.
      if [ -f "$F/rehold-key-after-first-noderead" ]; then
        cnt_file="$F/noderead-count-$tid"
        n0=$(cat "$cnt_file" 2>/dev/null || echo 0)
        if [ "$n0" = "0" ] || [ -z "$n0" ]; then
          rk=$(cat "$F/rehold-key-after-first-noderead")
          if [ "$rk" = "$tid" ]; then
            ${JSON.stringify(join(SCRIPTS, "drive-state.ts"))} hold 999 --key "$tid" --kind thread --outcome accepted --comment-url "https://example.invalid/$tid/rehold" >/dev/null 2>&1 || true
          fi
        fi
      fi
      if [ -f "$F/reopen-on-second-noderead" ]; then
        cnt_file="$F/noderead-count-$tid"
        n=$(( $(cat "$cnt_file" 2>/dev/null || echo 0) + 1 ))
        echo "$n" > "$cnt_file"
        if [ "$n" -ge 2 ]; then
          node=$(printf '%s' "$node" | jq '.isResolved = false')
        fi
      fi
      printf '{"data":{"node":%s}}' "$node"
      exit 0 ;;
  esac
done

# Model the reconciliation SWEEP's OWN thread-listing call failing — distinct
# from every other graphql-call fixture above, all of which target
# drive-status.ts's evaluate() snapshot. The sweep issues the FIRST graphql
# call of the whole invocation, since it runs before evaluate() ever does
# (SKILL.md § 1); failing graphql call #1 and succeeding every one after
# models a sweep whose own enumeration failed while evaluate()'s later,
# independent listing (call #2) succeeds normally.
if [ -f "$F/sweep-thread-listing-fails-once" ]; then
  is_graphql=0
  for a in "$@"; do case "$a" in graphql) is_graphql=1 ;; esac; done
  if [ "$is_graphql" -eq 1 ]; then
    n=0
    [ -f "$F/graphql-calls" ] && n=$(cat "$F/graphql-calls")
    n=$(( n + 1 ))
    printf '%s' "$n" > "$F/graphql-calls"
    if [ "$n" -eq 1 ]; then
      echo "gh-stub: simulated sweep thread-listing failure (call #1)" >&2
      exit 1
    fi
  fi
fi

# loop-metrics.ts --severity-warnings samples the same complete review
# population as the terminal report. Keep that traffic distinct from the
# drive-status thread listing above: its GraphQL connections have different
# shapes and a generic threads.json response would make the reporter fail
# before the drive can exercise the round-time warning.
case "$query" in
  *'number title state additions deletions changedFiles'*)
    emit "$F/metrics-meta.json"; exit 0 ;;
  *'commits(first:100'*)
    emit "$F/metrics-commits.json"; exit 0 ;;
  *'reviews(first:100'*)
    emit "$F/metrics-reviews.json"; exit 0 ;;
esac

for a in "$@"; do
  case "$a" in
    graphql)             emit "$F/threads.json"; exit 0 ;;
    *issues/*/timeline*) emit "$F/timeline.json"; exit 0 ;;
    *check-runs*)        emit "$F/check-runs.json"; exit 0 ;;
    # Query string included: drive-status.ts paginates this endpoint with an
    # explicit \`?per_page=\`, and a stub matching only the bare path would make
    # every commit-status test read as "API unreadable" instead of exercising it.
    #
    # \`status-all.json\` is the FULL set and \`status.json\` only page one, so a
    # caller that forgets \`--paginate\` sees exactly what the real API shows it:
    # the first page, silently.
    */status|*/status'?'*)
      if [ "$paginate" -eq 1 ] && [ -f "$F/status-all.json" ]; then
        emit "$F/status-all.json"
      else
        emit "$F/status.json"
      fi
      exit 0 ;;
    *issues/*/comments*) emit "$F/issue-comments.json"; exit 0 ;;
    *pulls/*/comments*)  emit "$F/pull-comments.json"; exit 0 ;;
  esac
done
echo "gh-stub: unhandled api call $*" >&2
exit 1
`;
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, stub);
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    // RESTORE the beforeAll overrides rather than deleting them: bun runs every
    // test FILE of one invocation in a single process, so what is left here is
    // what lock.test.ts and every other sibling observes. See
    // SUITE_ENV_OVERRIDES for why a delete is not a restore.
    //
    // Guarded because bun runs afterAll even when beforeAll THREW, in which
    // case the map was never built — an unguarded iteration would replace the
    // real beforeAll failure with a TypeError from teardown.
    suitePacing = {};
    if (priorSuiteEnv) {
      for (const [key, value] of priorSuiteEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // Same beforeAll-threw guard as above: `rmSync(undefined)` is a TypeError,
    // and setup dying before mkdtemp would have teardown mask the real error.
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    if (suiteHome) rmSync(suiteHome, { recursive: true, force: true });
  });
}

let fixtureSeq = 0;

export type FixtureThread = NonNullable<Fixture["threads"]>[number];

/**
 * A thread's GraphQL comment nodes. Default — no `comments` given — is the
 * single `a finding` comment every older fixture assumed, at the
 * thread's own permalink; an explicit list gets a permalink PER comment,
 * because the reconciliation sweep keys a re-hold on the qualifying comment's
 * own url and one url shared across a thread could not tell "the same reply"
 * from "a different one" (same reason reconcile-replied-threads.test.ts builds
 * its fixtures that way).
 */
function threadCommentNodes(
  t: FixtureThread,
  originalCommitOid = HEAD,
): Array<Record<string, unknown>> {
  const cs: NonNullable<FixtureThread["comments"]> = t.comments ?? [
    { authorAssociation: t.authorAssociation ?? "NONE", body: "a finding" },
  ];
  return cs.map((c, i) => ({
    url:
      t.comments === undefined
        ? `https://example.invalid/${t.id}`
        : `https://example.invalid/${t.id}/comment-${i}`,
    author: {
      login: c.author ?? "example-review[bot]",
      __typename: (c.bot ?? t.bot) ? "Bot" : "User",
    },
    authorAssociation: c.authorAssociation ?? "NONE",
    createdAt: "2026-09-10T10:00:00Z",
    lastEditedAt: "2026-09-10T10:00:00Z",
    body: c.body,
    originalCommit: { oid: originalCommitOid },
  }));
}

/**
 * Default `updated_at` for the fixture's sticky comment.
 *
 * Chosen against the two bypass conditions it interacts with, so that probes
 * NOT about the sticky's dating stay unaffected — it clears the age floor
 * (condition 4) and post-dates `OLD_ENOUGH_STARTED`, the start every bypass
 * fixture uses (condition 5). A probe that IS about the dating overrides
 * `stickyUpdatedAt` explicitly.
 *
 * Derived from `STALLED_MIN_AGE_SEC` rather than written as a wall-clock
 * figure: at a hardcoded 15 minutes, raising the production floor past that
 * would leave every bypass probe failing condition 4 — the CONVERGED and
 * ROUND_READY probes would redden honestly, but the four AWAITING_REVIEWER
 * probes would keep passing for the wrong reason, asserting nothing about the
 * condition each is named for (a fail-closed conjunction needs each clause to
 * be the sole decider in its own probe).
 */
const DEFAULT_STICKY_UPDATED_AT = new Date(
  Date.now() - STALLED_MIN_AGE_SEC * 2 * 1000,
).toISOString();

export function writeFixture(f: Fixture): { dir: string; stateDir: string } {
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  const stateDir = join(dir, "state");
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const head = f.head ?? HEAD;

  const w = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value));

  const baseHead = f.base ?? BASE;
  const prView = (
    oid: string,
    baseOid: string,
    mergeable?: string,
    state?: string | null,
    isDraftOverride?: boolean,
  ) => ({
    number: 999,
    state: state !== undefined ? state : (f.prState ?? "OPEN"),
    // `null` (not omitted) models GitHub answering the field WITH a null
    // value — the partial-response shape the draft gate must refuse rather
    // than read as "Ready for review". `isDraftAbsent` models the field
    // OMITTED entirely, a distinct wire shape from `null`: `undefined` here
    // relies on `JSON.stringify` dropping an `undefined`-valued key from its
    // output, which is what actually serialises the key away.
    isDraft:
      isDraftOverride !== undefined
        ? isDraftOverride
        : f.isDraftAbsent
          ? undefined
          : f.isDraft === null
            ? null
            : (f.isDraft ?? false),
    headRefOid: oid,
    headRefName: "feature/ENG-9999-probe",
    // `null`, not omitted: models GitHub answering the field but with no
    // value, which is what the drive.ts fallback message (not a guessed
    // "develop") is written to survive.
    baseRefName: f.baseRefNameMissing ? null : "develop",
    baseRefOid: baseOid,
    mergeable: mergeable ?? f.mergeable ?? "MERGEABLE",
    // `null` models the same partial-response shape as `baseRefName` above:
    // answered, but with no value. Both are REPORTED fields, never branched
    // on, so neither is validated — see the mergeStateStatus test below.
    mergeStateStatus: f.mergeStateStatusMissing
      ? null
      : (f.mergeStateStatus ?? "CLEAN"),
    labels: f.ciHeld ? [{ name: "ci:hold" }] : [],
    headRepositoryOwner: { login: f.headRepoOwner ?? "example-org" },
    headRepository: { name: "example-repo" },
    nameWithOwner: "example-org/example-repo",
    url: "https://github.com/example-org/example-repo/pull/999",
  });
  w("pr-view.json", prView(head, baseHead));
  if (f.dirtyOnFinalVerify) {
    writeFileSync(join(dir, "dirty-on-final-verify"), "");
  }
  if (f.mergeabilityUnreadable) writeFileSync(join(dir, "no-mergeability"), "");
  if (f.transientMergeabilityFailure) {
    writeFileSync(join(dir, "transient-failure"), "");
  }
  // Every one of these drives the stub's SINGLE-FIELD `state` read — the one
  // drive-status.ts makes immediately ahead of the sweep — and the stub
  // evaluates them in a fixed order (`fails`, then `closed-always`, then
  // `closed-once`). A fixture setting two therefore gets whichever comes first
  // and silently models neither of the windows it asked for. Same rule, same
  // reason, and the same mechanism as the head-read-counter throw below: a
  // comment saying "never combine them" is a guard held in memory, which is the
  // thing this whole skill exists to replace (applied to the class, not only
  // the `Once`/`Always` pair, since `liveProbeFails` shares the identical
  // read).
  //
  // `stateChangesTo` is deliberately NOT in this set: it is layered behind
  // these branches on purpose and matches the multi-field snapshot read as
  // well, so it models a different thing rather than competing for one.
  const probeFlags = (
    [
      ["liveProbeFails", f.liveProbeFails],
      ["liveProbeSaysClosedOnce", f.liveProbeSaysClosedOnce],
      ["liveProbeSaysClosedAlways", f.liveProbeSaysClosedAlways],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (probeFlags.length > 1) {
    throw new Error(
      `fixture sets ${probeFlags.join(" and ")}; they share the stub’s ` +
        "single-field `state` read, so the probe would target neither window",
    );
  }
  if (f.liveProbeFails) writeFileSync(join(dir, "live-probe-fails"), "");
  if (f.liveProbeSaysClosedOnce) {
    writeFileSync(join(dir, "live-probe-closed-once"), "");
  }
  if (f.snapshotUnreadable) writeFileSync(join(dir, "snapshot-unreadable"), "");
  if (f.liveProbeSaysClosedAlways) {
    writeFileSync(join(dir, "live-probe-closed-always"), "");
  }
  if (f.stateChangesTo) {
    writeFileSync(
      join(dir, "state-changes-after"),
      String(f.stateChangesAfter ?? 1),
    );
    w("pr-view-state-changed.json", {
      number: 999,
      state: f.stateChangesTo,
      // The SAME head. A merge does not move it, and a fixture that moved it
      // too would let the head comparison catch the case the state read exists
      // to catch — a probe that passes for the wrong reason.
      headRefOid: head,
      headRefName: "feature/ENG-9999-probe",
      headRepositoryOwner: { login: f.headRepoOwner ?? "example-org" },
      headRepository: { name: "example-repo" },
      nameWithOwner: "example-org/example-repo",
    });
  }
  if (f.prViewUnreadableAfter !== undefined) {
    // ENFORCED, not documented: every one of these mechanisms consumes the
    // SAME `head-reads` counter in the stub — `still_on_head` reads head and
    // base together, and the mergeability/state recheck below rides that same
    // read — so a fixture setting more than one would have each advance it and
    // none fire where the test expects. A comment saying "never combine them"
    // is the kind of guard this whole skill exists to move out of memory and
    // into mechanism — so it throws instead.
    if (
      f.headMovesTo !== undefined ||
      f.baseMovesTo !== undefined ||
      f.mergeableMovesTo !== undefined ||
      f.stateMovesTo !== undefined ||
      f.isDraftMovesTo !== undefined
    ) {
      throw new Error(
        "fixture sets both prViewUnreadableAfter and one of headMovesTo/" +
          "baseMovesTo/mergeableMovesTo/stateMovesTo/isDraftMovesTo; they " +
          "share the stub’s head-read counter, so the probe would target " +
          "neither window",
      );
    }
    writeFileSync(
      join(dir, "pr-view-unreadable-after"),
      String(f.prViewUnreadableAfter),
    );
  }
  // `!== undefined`, not truthy: `baseMovesTo: ''` (modelling the recheck
  // coming back with an EMPTY baseRefOid) is a deliberate, valid fixture value
  // that a truthy check would silently treat as "not set".
  if (
    f.headMovesTo !== undefined ||
    f.baseMovesTo !== undefined ||
    f.mergeableMovesTo !== undefined ||
    f.stateMovesTo !== undefined ||
    f.isDraftMovesTo !== undefined
  ) {
    writeFileSync(
      join(dir, "head-moves-after"),
      String(f.headMovesAfter ?? f.baseMovesAfter ?? 1),
    );
    // The stub's counter fires on any read whose --json argument mentions
    // headRefOid — which is every read `still_on_head` makes, since it reads
    // head, isDraft and base together. So a base-only move (head unchanged), a
    // mergeability-only move, a state-only move and a draft-only flip all ride
    // the SAME counter as a head move; only the served fixture differs.
    w(
      "pr-view-moved.json",
      prView(
        f.headMovesTo ?? head,
        f.baseMovesTo ?? baseHead,
        f.mergeableMovesTo,
        f.stateMovesTo,
        f.isDraftMovesTo,
      ),
    );
  }
  w("repo-view.json", {
    owner: { login: "example-org" },
    name: "example-repo",
    nameWithOwner: "example-org/example-repo",
  });
  if (!f.checkRunsUnreadable)
    w("check-runs.json", {
      check_runs: [
        ...(f.checkRuns ?? [REVIEWER_RUN, DORMANT_ARM]),
        ...REQUIRED_CI_RUNS,
      ].map((c, i) => ({
        ...c,
        head_sha: head,
        output: { title: "No findings" },
        app: { slug: c.app },
        // DESCENDING: GitHub lists check-runs newest-first and the newest carries
        // the HIGHEST id, which is what the reduction orders by.
        id: 10000 - i,
        created_at: c.started ?? "2026-09-10T10:00:00Z",
        started_at: c.started,
      })),
    });
  w("timeline.json", []);
  w("metrics-meta.json", {
    data: {
      repository: {
        pullRequest: {
          number: 999,
          title: "fixture PR",
          state: f.prState ?? "OPEN",
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          baseRefName: "develop",
          headRefOid: head,
          createdAt: "2026-09-10T10:00:00Z",
          mergedAt: null,
          mergeCommit: null,
        },
      },
    },
  });
  w("metrics-commits.json", {
    data: {
      repository: {
        pullRequest: {
          commits: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  });
  const metricAuthors = [
    ...new Set(
      (f.threads ?? [])
        .filter((thread) => thread.bot)
        .map((thread) => thread.comments?.[0]?.author ?? "example-review[bot]"),
    ),
  ];
  w("metrics-reviews.json", {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: metricAuthors.map((author, index) => ({
              id: `review-${index}`,
              submittedAt: "2026-09-10T10:00:00Z",
              body: "review complete",
              commit: { oid: head },
              author: { login: author, __typename: "Bot" },
              comments: { pageInfo: { hasNextPage: false }, nodes: [] },
            })),
          },
        },
      },
    },
  });
  // An unreadable status API is modelled by removing the fixture, so the stub's
  // `cat` fails and `gh` exits non-zero — the shape a timeout or 403 takes.
  if (!f.statusesUnreadable) {
    w("status.json", { state: "success", statuses: f.statuses ?? [] });
    // A second page exists only when the test asks for one. `status.json` stays
    // page ONE, so an unpaginated read gets exactly what the real API gives it.
    if (f.statusesPage2) {
      w("status-all.json", {
        state: "success",
        statuses: [...(f.statuses ?? []), ...f.statusesPage2],
      });
    }
  }

  // Every real GitHub issue comment carries `updated_at`; the fixture does
  // too, so a probe can never pass merely because the field was absent.
  const stickyUpdatedAt = f.stickyUpdatedAt ?? DEFAULT_STICKY_UPDATED_AT;
  const comments: Array<{
    id: number;
    body: string;
    user: { login: string };
    author_association: string;
    updated_at: string;
  }> = [];
  if (f.reviewedSha !== null) {
    comments.push({
      id: 5165287731,
      body: stickyBody({
        sha: f.reviewedSha ?? head,
        backlog: f.backlog ?? false,
        ...(f.stickyRound === null ? { round: null } : {}),
      }),
      user: { login: "example-review[bot]" },
      author_association: "NONE",
      updated_at: stickyUpdatedAt,
    });
  }
  for (const body of f.decoyReviewerComments ?? []) {
    comments.push({
      id: 800 + comments.length,
      body,
      user: { login: "example-review[bot]" },
      author_association: "NONE",
      updated_at: stickyUpdatedAt,
    });
  }
  for (const fp of f.addressed ?? []) {
    comments.push({
      id: 900 + comments.length,
      body: `**wont-fix** — declined per the rubric.\n<!-- drive-pr-addressed: ${fp} -->`,
      user: { login: "example-user-2" },
      author_association: f.addressedBy ?? "OWNER",
      updated_at: stickyUpdatedAt,
    });
  }
  for (const { fingerprint, sha, outcome, round } of f.fixDependentAddressed ??
    []) {
    comments.push({
      id: 950 + comments.length,
      body: `**${outcome ?? "accepted"}** — fixed.\n<!-- drive-pr-addressed: ${fingerprint}@${sha}${round === undefined ? "" : `#${round}`} -->`,
      user: { login: "example-user-2" },
      author_association: "OWNER",
      updated_at: stickyUpdatedAt,
    });
  }
  w("issue-comments.json", comments);
  w(
    "pull-comments.json",
    (f.anchored ?? [".claude/agents/review-arbiter.md"]).map((p) => ({
      // `path` or `path:line` — the latter models an inline comment anchored to
      // a specific finding rather than merely to the file.
      path: p.includes(":") ? p.slice(0, p.lastIndexOf(":")) : p,
      line: p.includes(":")
        ? Number.parseInt(p.slice(p.lastIndexOf(":") + 1), 10)
        : null,
      body: `a finding\n<!-- ai-review-round: ${f.anchoredRound ?? STICKY_ROUND} -->`,
      user: { login: "example-review[bot]" },
    })),
  );
  if (f.sweepThreadListingFailsOnce) {
    writeFileSync(join(dir, "sweep-thread-listing-fails-once"), "");
  }
  w("threads.json", {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: (f.threads ?? []).map((t) => ({
              id: t.id,
              isResolved: t.isResolved ?? false,
              isOutdated: false,
              path: t.path ?? null,
              line: 1,
              originalLine: 1,
              comments: {
                pageInfo: { hasNextPage: false },
                nodes: threadCommentNodes(t, head),
              },
            })),
          },
        },
      },
    },
  });

  return { dir, stateDir };
}

export interface ProbeResult {
  exitCode: number;
  state: string;
  json: Record<string, unknown>;
  stderr: string;
}

/**
 * Run drive-status.ts against an ALREADY-WRITTEN fixture. Split out of `probe`
 * so a test that has to mutate the state dir first — parking an item, say —
 * shares one launcher with every other probe instead of hand-rolling a spawn.
 */
export async function probeIn(
  dir: string,
  stateDir: string,
  head: string = HEAD,
  extraArgs: string[] = [],
  opts: {
    once?: boolean;
    reconcile?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<ProbeResult> {
  const proc = Bun.spawn(
    [
      join(SCRIPTS, "drive-status.ts"),
      "999",
      "--json",
      ...(opts.once === false ? [] : ["--once"]),
      // The sweep is on in production, so it is on HERE, and a probe
      // that wants an isolated status evaluation opts out explicitly. This
      // used to be inverted, on the theory that making every probe pay for a
      // `reconcile-replied-threads.ts` spawn would push the `drive-pr-selftest`
      // hook past a budget it has already outgrown once.
      //
      // Both halves of that were wrong, and the second was MEASURED wrong on
      // this suite. Correctness first: an inverted
      // default silently moves every pre-existing probe onto the exceptional
      // path, so a change to sweep ordering, output, failure handling or state
      // mutation can break ordinary production invocations while the suite
      // stays green — which is exactly what happened when `--no-reconcile`
      // stopped vouching for a sweep it suppressed, and every probe reaching a
      // terminal verdict turned out to have been asserting the flagged path
      // all along. Then cost: flipping it measured FASTER, 346s against 426s
      // on the same machine, because the degrade those probes were taking
      // polls and retries where a real sweep just runs.  <!-- measured -->
      ...(opts.reconcile === false ? ["--no-reconcile"] : []),
      "--head",
      head,
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        ...opts.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const json = out.trim() ? JSON.parse(out) : {};
  return { exitCode, state: String(json.state ?? ""), json, stderr };
}

export async function probe(
  f: Fixture,
  extraArgs: string[] = [],
  /**
   * Drop `--once`, so the script takes its WAITING path. Only a state that is
   * genuinely terminal returns promptly then — a `4` polls to `--timeout` —
   * which is the difference a conflict probe has to be able to observe.
   */
  opts: { once?: boolean; env?: Record<string, string> } = {},
): Promise<ProbeResult> {
  const { dir, stateDir } = writeFixture(f);
  return probeIn(dir, stateDir, f.head ?? HEAD, extraArgs, opts);
}

/** Park an item before probing, to model an arbiter escalation. */
export async function park(
  stateDir: string,
  key: string,
  kind: "thread" | "finding",
) {
  const proc = Bun.spawn(
    [
      join(SCRIPTS, "drive-state.ts"),
      "park",
      "999",
      "--key",
      key,
      "--kind",
      kind,
      "--reason",
      "arbiter escalated",
    ],
    {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await proc.exited;
}

/**
 * Hold an `accepted`/`moot` item before probing, to model a triaged-but-
 * not-yet-pushed fix-dependent disposition (`triage-thread.ts` step 3 /
 * `drive-state.ts hold`). A `thread` needs `--comment-url`; a `finding` reads
 * its reason from stdin — same asymmetry `hold`'s own CLI enforces.
 */
export async function hold(
  stateDir: string,
  key: string,
  kind: "thread" | "finding",
  commentUrl = "https://github.com/o/r/pull/999#discussion_r1",
) {
  const proc = Bun.spawn(
    [
      join(SCRIPTS, "drive-state.ts"),
      "hold",
      "999",
      "--key",
      key,
      "--kind",
      kind,
      "--outcome",
      "accepted",
      ...(kind === "thread" ? ["--comment-url", commentUrl] : []),
    ],
    {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdin: kind === "finding" ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (kind === "finding") {
    proc.stdin.write("fixed already; posting once pushed.");
    proc.stdin.end();
  }
  await proc.exited;
}
