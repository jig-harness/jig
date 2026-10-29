#!/usr/bin/env bun
/**
 * Label each enumerated review thread with whether its anchor line was written
 * by THIS PR's own earlier commits — the `SELF-INFLICTED` label.
 *
 * By round 3 of a driven PR, a finding against the PR's own prior-round fix is
 * the single most likely case (the ratio was measured worsening per round: 2/5
 * → 4/10 → ≥4/8). The label exists because that changes triage posture:
 * `resolve-review-comments/SKILL.md` § 3's "Check the fix's own blast radius"
 * and "Two rounds on one root cause → stop patching variants" both turn on
 * exactly this question, and both were left to session memory to ask — which
 * was measured failing on the very PR that added the rule.
 *
 * A FILTER, not a second enumerator. It reads
 * `resolve-review-comments/scripts/list-unresolved-threads.ts`'s NDJSON on
 * stdin and writes the same records back with fields added — `selfInflicted`/
 * `selfInflictedCommit` (see below), `severity` (`severityOf` applied to the
 * thread's own finding text, mechanizing what `SKILL.md` § 3 otherwise asks a
 * triaging agent to read by hand), and `category` (`categoryOf`, same source
 * text, same fallback contract). That keeps the one canonical
 * enumerator canonical — it is the only place a thread id is obtainable, and
 * it owns the `$RRC_TARGET_PR` / `--bots-only` guards — while keeping git out
 * of a script whose whole contract is a GitHub query.
 *
 * Usage:
 *   list-unresolved-threads.ts <PR> --bots-only | self-inflicted.ts [PR] [flags]
 *
 *   --base REF     the PR's base. DEFAULT: read from the PR itself
 *                  (`gh pr view --json baseRefName`, as `<remote>/<name>`,
 *                  the remote being `repository.remote`, else `origin`) —
 *                  never a hardcoded `develop`, for the reason base-sync.ts
 *                  states about the identical question. A PR filed against a
 *                  release branch would otherwise have its whole base
 *                  mislabelled as this PR's own work. Unreadable → every
 *                  record is `null`, loudly, rather than measured against a
 *                  guess.
 *   --head REV     the revision to blame against (default HEAD).
 *   --repo DIR     the worktree to run git in (default $DRIVE_PR_WORKTREE,
 *                  else the cwd).
 *
 * The PR's own commits are `<base>..<head>` in git's exclusion sense, so a
 * commit that arrived in the branch by MERGING the base is reachable from the
 * base and correctly excluded.
 *
 * `--head` defaults to the local `HEAD`, which is the PR head by construction
 * on the driven path: SKILL.md § 1's gate refuses a tree whose local head lags
 * the API head (`HEAD_LAG`) before § 2 ever runs. Invoked by hand against a
 * stale tree it blames a commit the reviewer never saw — pass `--head`
 * explicitly there.
 *
 * Added fields, and why the vocabulary is three-valued:
 *
 *   selfInflicted   true  — the last-touching commit of SOME line in the
 *                           comment's range (see below) is one of this PR's
 *                           own.
 *                   false — none of them are: every line in the range
 *                           predates the PR, or came in with a base merge.
 *                   null  — NOT MEASURED. No path, no line, an outdated
 *                           anchor, a file that is not in the tree, or a git
 *                           call that failed on some line the range could not
 *                           therefore rule out.
 *
 *   selfInflictedCommit  the blamed commit when `selfInflicted` is true, so a
 *                        reader can `git show` the round that wrote the line
 *                        instead of taking the label's word for it.
 *
 * A multi-line GitHub comment's `line` names only the range's END — a
 * `startLine` field names the start when the two differ. Blaming `line` alone
 * would emit `false` for a comment whose selected range covers PR-authored
 * lines but happens to end on an unchanged context line, silently suppressing
 * the exact safeguard this label exists to trigger. So every line from
 * `startLine` through `line` is blamed, in order, stopping at the first hit.
 *
 * `null` is a third value rather than a fold into `false`, and the distinction
 * is the whole point of the field. `false` is the positive claim "I checked
 * every line in range, and none of it is your own doing" — a claim that
 * licenses skipping the blast-radius re-read. A git failure partway through
 * the range means some of it went unchecked, so the honest answer is `null`,
 * not a `false` that silently narrowed its own claim. Reporting `false` for a
 * thread nobody could fully blame would make the label most confidently wrong
 * exactly where it is least informed, which is the shape `AGENTS.md` calls out
 * on every other measurement in this skill (`drive-status.ts`'s work counts
 * are `null`-not-`0` for the same reason).
 *
 * An OUTDATED thread is `null`, not `false`. GitHub's `line`/`startLine` on an
 * outdated thread refer to a diff that is no longer the head's, so blaming
 * those line numbers against HEAD reads lines the reviewer never commented on
 * — a confident answer about the wrong code, which is worse than no answer.
 *
 * A `LEFT`-side thread is `null` too, and for the same underlying reason —
 * distinct from `isOutdated`, which only fires once a LATER push moves the
 * diff. A comment anchored to the pre-image (a deleted or unchanged-context
 * line shown on the diff's left) numbers the BASE version of the file, not
 * HEAD's, from the moment it is posted — no later push required. Blaming
 * those numbers against HEAD reads unrelated current content and can
 * confidently mislabel it `true`/`false`.
 * `list-unresolved-threads.ts` is the source of `diffSide`; see its header.
 *
 * A MULTI-line comment (`startLine` present and distinct from `line`) is
 * `null` unless `startDiffSide === 'RIGHT'` too. GitHub allows `startDiffSide`
 * to differ from `diffSide`, so `diffSide === 'RIGHT'` alone describes only
 * the range's endpoint — a LEFT-to-RIGHT range would otherwise have its
 * LEFT-numbered lines blamed against HEAD using RIGHT-side line numbers,
 * reading unrelated current content the same way a whole-LEFT thread does.
 *
 * ADVISORY. Every failure degrades to `null` and the exit code stays 0 as long
 * as the stream itself was readable: a triage pass must not be blocked because
 * `git blame` could not run. A malformed stdin line IS fatal (exit 1) — this
 * script's output is the pass's thread list, and silently dropping a record
 * from it would hide a finding, not a label.
 *
 * --- `--summary-report`: the SUMMARY-ONLY findings --------------
 *
 * A finding that exists only in the reviewer's sticky summary has no inline
 * thread, so it never reaches the NDJSON path above and used to carry no
 * `selfInflicted` label at all. Because `.config/review-triage.yaml` lists
 * `self_inflicted` in `fail_open.inert_when_unknown`, the honest `unknown` that
 * was passed in its place held the decline ladder INERT for every summary-only
 * finding in every round — the whole convergence policy disarmed by the one
 * class of finding late rounds produce most (observed twice, independently).
 *
 * `--summary-report` reads `summary-findings.ts`'s report JSON on stdin and
 * writes the same report back with `selfInflicted` and
 * `selfInflictedGranularity` added to every finding. The measurement is
 * deliberately FILE-level, not line-level:
 *
 *   A summary bullet's `path:line` is PROSE the reviewer wrote, not a GitHub
 *   anchor. It carries none of the `isOutdated`/`diffSide`/`startDiffSide`
 *   signal `labelRecord` relies on to know whether a line number still
 *   addresses HEAD, so blaming it would produce exactly the confidently-wrong
 *   answer this script refuses everywhere else. The FILE, by contrast, is
 *   stale-proof: "is this path among the paths this PR's own commits touched"
 *   needs no line number and cannot be invalidated by a later push moving the
 *   diff.
 *
 * The granularity is sound in the direction the ladder uses it. `false` — the
 * PR never touched this file — is a STRONGER claim than a line-level `false`,
 * since no line in an untouched file can be the PR's own work. `true` is
 * WEAKER: the PR wrote somewhere in the file, not necessarily at the finding.
 * That weakness is safe here and nowhere else, because `self_inflicted: true`
 * is only ever an `accept_if` clause (`.config/review-triage.yaml` § bands) —
 * over-claiming it can only ADMIT a finding the ladder would otherwise
 * decline, which is the fail-open direction the config already takes for an
 * unmeasured anchor. `selfInflictedGranularity: 'file'` is emitted alongside
 * so no later consumer can mistake it for `labelRecord`'s line-level claim.
 *
 * `null` still means NOT MEASURED, on the same three-valued contract: no
 * path, an unresolvable commit/path set, or a path that is neither in the
 * PR's own changed set nor present in the head tree — a reviewer's prose
 * naming a file that does not exist establishes nothing about who wrote it.
 */

import { consumerRoot, readRemoteName } from "../../../shared/consumer.ts";
import { verifyRemoteIsPrRepo } from "./lib/base-drift.ts";
import { runMain } from "./lib/cli.ts";
import { cachedRepoView } from "./lib/gh-conditional.ts";
import {
  ghCall,
  ghRepoEnv,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  resolvePr,
} from "./lib/proc.ts";
import {
  categoryOfRecord,
  type LabelledRecord,
  severityOfRecord,
} from "./lib/record-labels.ts";
import { MARKER_SAFE_FINGERPRINT } from "./summary-findings.ts";

/**
 * The aggregate wall-clock budget for ONE record's range scan (`labelRecord`'s
 * `deadlineAt`) — a small multiple of the per-call `GIT_CALL_TIMEOUT`, not a
 * per-line multiplication of it. A single-line comment (the overwhelming
 * majority) makes exactly one `blame()` call regardless of this value; a
 * multi-line one gets a fixed ceiling on total scan time instead of one that
 * grows with the range's length.
 *
 * A FUNCTION, evaluated per record rather than a module-scope constant:
 * `gitCallTimeoutSeconds()` validates `$GIT_CALL_TIMEOUT` and exits the
 * process on a malformed value, so computing it at import time would make
 * merely IMPORTING this module for `labelRecord`/`gitDeps` alone — as the
 * test suite does — fail on an env var neither of those touches otherwise.
 * Every other timeout read in this file (`gitDeps`'s own `opts.timeoutSec`)
 * is already lazy for the same reason.
 */
function rangeScanDeadlineMs(): number {
  return gitCallTimeoutSeconds() * 4 * 1000;
}

export interface LabelDeps {
  /** Resolve the set of commit SHAs belonging to this PR. `null` = unknown. */
  prCommits(): Promise<Set<string> | null>;
  /** The commit that last touched `path:line`, or `null` if unanswerable. */
  blame(path: string, line: number): Promise<string | null>;
  /**
   * Every path this PR's own commits touched, `null` when unanswerable. The
   * FILE-level counterpart to `prCommits`, used by `labelSummaryFinding` for
   * findings that have a path but no trustworthy line — see the header's
   * `--summary-report` section.
   */
  prPaths(): Promise<Set<string> | null>;
  /**
   * Every path present in the head tree, `null` when unanswerable. Only ever
   * consulted to tell a real untouched file (`false`) apart from a path the
   * reviewer's prose named that does not exist at all (`null`).
   */
  headPaths(): Promise<Set<string> | null>;
}

/** The subset of a thread record this labeller reads. */
export interface AnchoredRecord {
  path?: unknown;
  line?: unknown;
  /** The range's start, for a multi-line comment. See the header. */
  startLine?: unknown;
  isOutdated?: unknown;
  /** `'LEFT'` | `'RIGHT'` | `null`/absent. See the header. */
  diffSide?: unknown;
  /**
   * The side of `startLine`, independently of `diffSide` (the side of
   * `line`, the range's end). See the header's multi-line paragraph.
   */
  startDiffSide?: unknown;
  /** The thread's replies (finding + any back-and-forth) — see the header. */
  comments?: unknown;
}

export interface SelfInflictedLabel {
  selfInflicted: boolean | null;
  // Always present — `undefined`, not omitted, when there is no commit to
  // name. A record piped back through this script twice (or a hand-crafted
  // fixture) can already carry a `selfInflictedCommit` from an earlier pass;
  // an omitted key in a `{ ...rec, ...label }` spread does not clear it, so
  // every non-`true` branch must set the key explicitly to overwrite it.
  selfInflictedCommit: string | undefined;
}

/**
 * The labelling decision, extracted from its I/O so it is fixture-testable
 * without a repository — the seam `round-plan.ts` uses for `checkLoad()`.
 *
 * `prCommits` is resolved ONCE by the caller and passed in, not re-derived per
 * record: it is a property of the PR, not of a thread, and re-deriving it
 * would let two threads in one stream be labelled against different commit
 * sets if the tree moved mid-run.
 *
 * `deadlineAt` is an absolute `Date.now()`-comparable epoch-ms bound on the
 * WHOLE range scan below, checked before every `blame()` call rather than
 * threaded into git as an `AbortSignal`. Each `blame()` call already carries
 * its own `GIT_CALL_TIMEOUT` (default 30s), which bounds any ONE call; what
 * it does not bound is the range as a whole — a comment spanning N lines
 * makes up to N sequential calls, so a range large enough turns "one slow
 * call" into "N times that timeout".
 * Checking between calls closes that multiplication without a call already
 * IN FLIGHT needing to be cancelled — the per-call timeout is still the
 * backstop for that half, and adding cancellation on top of it was judged
 * not worth threading an `AbortSignal` through `LabelDeps.blame`, `gitDeps`
 * and `lib/proc.ts`'s `run()`/`git()` for a caller nothing here has: the
 * range scan is not embedded in anything a human is watching mid-call, so
 * there is nothing for a mid-call abort to unblock sooner than the per-call
 * timeout already does. Defaults to `Infinity` (no bound) for the many
 * existing single-line callers/tests, where the loop runs at most once.
 */
export async function labelRecord(
  rec: AnchoredRecord,
  prCommits: Set<string> | null,
  blame: LabelDeps["blame"],
  deadlineAt: number = Infinity,
): Promise<SelfInflictedLabel> {
  if (prCommits === null)
    return { selfInflicted: null, selfInflictedCommit: undefined };
  // A PR-level or file-level comment names no line to blame. `line` is checked
  // for INTEGRALITY, not merely `typeof number`: `git blame -L 1.5,1.5` is a
  // parse error, and a NaN would stringify into the argument as `NaN`.
  const path = rec.path;
  const line = rec.line;
  if (typeof path !== "string" || path.trim() === "") {
    return { selfInflicted: null, selfInflictedCommit: undefined };
  }
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return { selfInflicted: null, selfInflictedCommit: undefined };
  }
  // See the header: an outdated anchor's line number addresses a diff that is
  // no longer the head's.
  if (rec.isOutdated === true)
    return { selfInflicted: null, selfInflictedCommit: undefined };
  // See the header: a LEFT-side anchor numbers the PRE-image, not HEAD, from
  // the moment it is posted — never outdated, so the check above cannot catch
  // it.
  if (rec.diffSide === "LEFT")
    return { selfInflicted: null, selfInflictedCommit: undefined };
  // `startLine` names a multi-line comment's start; `line` alone is only the
  // range's end. `undefined`/`null` is a legitimate ABSENCE — the canonical
  // enumerator's own convention for a single-line comment
  // (list-unresolved-threads.ts: "populated only when it differs from `line`")
  // — and degrades to the single-line behavior exactly like a record with no
  // field at all. A rawStart that is PRESENT but invalid (wrong type,
  // non-integer, < 1, or past `line`) is a different claim: the record asserts
  // range metadata this function cannot trust, so silently substituting `line`
  // would produce a `false` that quietly narrowed its own claim to a single
  // line without saying so — exactly the confidently-wrong shape the header
  // warns about. NOT MEASURED, not a guessed single-line answer.
  const rawStart = rec.startLine;
  let startLine: number;
  if (rawStart === undefined || rawStart === null) {
    startLine = line;
  } else if (
    typeof rawStart === "number" &&
    Number.isInteger(rawStart) &&
    rawStart >= 1 &&
    rawStart <= line
  ) {
    startLine = rawStart;
  } else {
    return { selfInflicted: null, selfInflictedCommit: undefined };
  }
  // See the header: a range that actually SPANS multiple lines can straddle a
  // hunk boundary, where `startDiffSide` names the START's side independently
  // of `diffSide` (the END's side, already checked above). Only a range whose
  // start is confirmed RIGHT-side too may be blamed against HEAD throughout.
  if (startLine !== line && rec.startDiffSide !== "RIGHT") {
    return { selfInflicted: null, selfInflictedCommit: undefined };
  }
  // `path` is passed to `blame()` UNCHANGED, never a `.trim()`'d copy: the
  // check at the top of this function uses `.trim() === ''` only to detect a
  // whitespace-only path, and `path` itself already satisfies that check —
  // trimming it here would substitute a different filename for a legitimate
  // path that begins or ends with whitespace, silently blaming (or failing to
  // find) the wrong file.
  let sawFailure = false;
  for (let l = startLine; l <= line; l++) {
    // Checked BEFORE starting the next call, never after: the aggregate
    // budget bounds how many calls this scan may START, not how long an
    // already-started one may run (that is `GIT_CALL_TIMEOUT`'s job). A range
    // that runs out of budget partway through is exactly the `sawFailure`
    // case below — some lines went unchecked, so `false` would overclaim.
    //
    // The bare `Date.now()` here is NOT a lapse in clock injection, despite the
    // resemblance: clock injection is for business temporal logic (retention,
    // disposal eligibility, SLA deadlines), not for operational timestamps, and
    // this is one: a subprocess call budget, the same unchallenged pattern used
    // throughout this skill (`drive.ts`, `drive-status.ts`, `lib/proc.ts`,
    // `lib/state/lock.ts`, `lib/state/claims.ts`, `lib/state/lease.ts`,
    // `lib/status/evaluate.ts`) where `IClock`/`SystemClock`/`FixedClock`
    // appears nowhere. This comment exists so the question is not re-opened.
    // `deadlineAt` is still the injected, test-controlled seam (see the
    // header): only the internal "has the deadline passed" read is a bare
    // wall-clock call, same as every sibling timeout check in this skill.
    if (Date.now() >= deadlineAt) {
      sawFailure = true;
      break;
    }
    const sha = await blame(path, l);
    if (sha === null) {
      sawFailure = true;
      continue;
    }
    if (prCommits.has(sha))
      return { selfInflicted: true, selfInflictedCommit: sha };
  }
  // No line in the range blamed to a PR commit. `false` is a confident claim
  // only when every line in the range was actually checked — see the header.
  return sawFailure
    ? { selfInflicted: null, selfInflictedCommit: undefined }
    : { selfInflicted: false, selfInflictedCommit: undefined };
}

/** The subset of a `summary-findings.ts` finding this labeller reads. */
export interface SummaryFindingRecord {
  path?: unknown;
}

/** What `labelSummaryFinding` adds to a summary finding. */
export interface SummaryInflictedLabel {
  selfInflicted: boolean | null;
  /**
   * Always `'file'`, and always present — including on a `null`. A consumer
   * that saw the field only on a measured answer could read its absence as
   * "line-level" rather than "not measured", which is the one reading the
   * field exists to prevent.
   */
  selfInflictedGranularity: "file";
}

/**
 * The FILE-level self-infliction decision for one summary-only finding,
 * extracted from its I/O so it is fixture-testable without a repository —
 * the same seam `labelRecord` offers for the line-level path.
 *
 * The three-valued vocabulary is `labelRecord`'s, at file granularity; the
 * header's `--summary-report` section owns why that granularity is the right
 * one here and why over-claiming `true` is safe. The order of the branches
 * below is load-bearing:
 *
 *   1. no usable path            -> null   nothing to measure at all
 *   2. `prPaths` unresolvable    -> null   NOT MEASURED, never "clean"
 *   3. path in `prPaths`         -> true   this PR wrote in this file. Checked
 *                                          BEFORE the head-tree probe, so a
 *                                          file this PR DELETED still labels
 *                                          `true` rather than falling through
 *                                          to a `null` for "absent at head".
 *   4. path absent from head     -> null   the reviewer's prose named a file
 *                                          that is not in the tree; "the PR
 *                                          did not touch it" would be a
 *                                          confident answer about nothing.
 *      (an unresolvable `headPaths` lands here too — same NOT MEASURED)
 *   5. otherwise                 -> false  a real file this PR never touched
 */
export async function labelSummaryFinding(
  rec: SummaryFindingRecord,
  prPaths: Set<string> | null,
  headPaths: Set<string> | null,
): Promise<SummaryInflictedLabel> {
  const notMeasured = {
    selfInflicted: null,
    selfInflictedGranularity: "file",
  } as const;
  const path = rec.path;
  // `.trim() === ''` matches `labelRecord`'s own whitespace-only check; the
  // path itself is compared UNTRIMMED, for the reason stated there — trimming
  // would substitute a different filename for a path that legitimately begins
  // or ends with whitespace.
  if (typeof path !== "string" || path.trim() === "") return notMeasured;
  if (prPaths === null) return notMeasured;
  if (prPaths.has(path))
    return { selfInflicted: true, selfInflictedGranularity: "file" };
  if (headPaths === null || !headPaths.has(path)) return notMeasured;
  return { selfInflicted: false, selfInflictedGranularity: "file" };
}

/**
 * Git-backed dependencies.
 *
 * Every call carries `env: gitIdentityEnv()` and an explicit `cwd`, for the
 * reason `lib/proc.ts` gives: a leaked `GIT_DIR` overrides `cwd` outright, and
 * this script would then blame a different repository's history while
 * reporting confidently about this PR's.
 *
 * `head` is a caller-supplied REVISION (typically the literal ref `HEAD`),
 * not a pinned SHA — and `prCommits()` and `blame()` each resolve it
 * independently, at whatever moment they happen to run. `prCommits()` runs
 * once and memoizes its result; `blame()` runs once per line in a
 * multi-line range, each a fresh git invocation. If something else commits,
 * checks out, or resets this worktree between those calls — another process
 * sharing the tree, or simply a slow multi-line scan racing a concurrent
 * write — `prCommits()`'s memoized set can be built against one revision
 * while a later `blame()` call resolves `head` again and reads a different
 * one, silently comparing a blamed commit against the wrong commit set.
 * `resolveHead()` below closes that by
 * resolving `head` to one immutable SHA on first use and memoizing it — the
 * same one-shot-then-freeze shape as `commitsMemo` — so every call in this
 * `LabelDeps` instance blames and excludes against the identical revision.
 */
export function gitDeps(repo: string, base: string, head: string): LabelDeps {
  const opts = {
    cwd: repo,
    env: gitIdentityEnv(),
    stderr: "ignore" as const,
    timeoutSec: gitCallTimeoutSeconds(),
  };
  let commitsMemo: Set<string> | null | undefined;
  let headMemo: string | null | undefined;
  let prPathsMemo: Set<string> | null | undefined;
  let headPathsMemo: Set<string> | null | undefined;
  // Resolves `head` to one full-hex SHA, once, and freezes it — see the
  // function-level doc above. `--verify` so an unresolvable revision fails
  // loudly here rather than being passed through to `rev-list`/`blame`
  // verbatim, where git would report its own, harder-to-attribute error.
  async function resolveHead(): Promise<string | null> {
    if (headMemo !== undefined) return headMemo;
    const r = await git(["rev-parse", "--verify", `${head}^{commit}`], opts);
    headMemo = r.code === 0 ? r.stdout.trim() : null;
    return headMemo;
  }
  return {
    async prCommits(): Promise<Set<string> | null> {
      if (commitsMemo !== undefined) return commitsMemo;
      commitsMemo = null;
      // An empty base is UNRESOLVED, and must never reach `rev-list`: `..head`
      // is legal git and means `HEAD..head`, which resolves to the empty set —
      // "this PR wrote nothing", labelling every finding `false` on the one
      // input that established nothing at all. The guard lives here rather
      // than only in `main()` so the exported seam cannot be misused either.
      if (base === "") return commitsMemo;
      const resolvedHead = await resolveHead();
      if (resolvedHead === null) return commitsMemo;
      // `<base>..<head>` in git's two-dot exclusion sense: `rev-list
      // base..head` excludes everything reachable from base, which is what
      // "this PR's own commits" means — commits that arrived in the branch by
      // MERGING the base are reachable from it and correctly excluded, so a
      // base merge cannot make the whole base look self-inflicted.
      const r = await git(["rev-list", `${base}..${resolvedHead}`], opts);
      if (r.code !== 0) return commitsMemo;
      const set = new Set(
        r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== ""),
      );
      // An EMPTY set is a real answer (`head` is at `base`, nothing pushed
      // yet), and it labels every thread `false` — correctly: nothing on this
      // branch can have written those lines.
      commitsMemo = set;
      return commitsMemo;
    },
    async prPaths(): Promise<Set<string> | null> {
      if (prPathsMemo !== undefined) return prPathsMemo;
      prPathsMemo = null;
      // Same guard, and the same reason, as `prCommits`: an empty base is
      // UNRESOLVED, and `..head` is legal git that would quietly answer with
      // the empty set — "this PR wrote nothing" — labelling every summary
      // finding `false` off an input that established nothing.
      if (base === "") return prPathsMemo;
      const resolvedHead = await resolveHead();
      if (resolvedHead === null) return prPathsMemo;
      // `--diff-filter` is deliberately NOT passed: a file this PR deleted is
      // still a file this PR wrote in, and excluding it would label a finding
      // about the deletion `false`.
      //
      // Three-dot `<base>...<head>` — NOT two-dot, despite `prCommits` using
      // two-dot for `rev-list`. The two commands' dot notation means opposite
      // things: `rev-list base..head` IS exclusion (commits reachable from
      // head, not from base), but `git diff base..head` has no merge-base logic
      // at all — it is exactly `git diff base head`, a direct two-tree
      // comparison. So once the base has advanced past this branch's fork
      // point, a file the base changed but this branch never touched still
      // shows up as "different" between the two endpoint trees, and gets
      // labelled `selfInflicted: true` on a line this PR never wrote — measured
      // on this exact line, reachable any round the fetched base moves.
      // Three-dot diffs against the merge base instead — the same notation
      // `git log` and GitHub's own PR view use — which isolates only what THIS
      // branch changed since it diverged. That holds whether or not the base
      // has since advanced further, and — the case the old two-dot choice here
      // was guarding against, incorrectly — whether or not this branch has
      // since MERGED the base in: once merged, the merge-base of `base` and
      // `head` becomes the merged-in base tip itself, so the three-dot diff
      // still reports only this branch's own changes, never the base's
      // (verified empirically for both the unmerged and merged cases before
      // making this change).
      //
      // `-z` is load-bearing, not a style match with `headPaths` below.
      // Without it, `core.quotePath` (on by default) C-QUOTES any path with a
      // non-ASCII or otherwise special character — `git diff --name-only`
      // emits `"src/caf\303\251.ts"` where `ls-tree -z` emits the raw
      // `src/café.ts`. The two sets are then not comparable, so a file this
      // PR genuinely touched misses `prPaths.has(path)`, falls through the
      // head-tree probe, and labels `selfInflicted: FALSE` — a confident
      // wrong answer on the STRONGER half of the tri-state, which can decline
      // a regression the PR itself authored. `-z` also removes the need to
      // `.trim()`, which would silently rename a path that legitimately
      // begins or ends with whitespace (the same hazard `labelRecord`
      // documents about its own path handling).
      const r = await git(
        [
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          `${base}...${resolvedHead}`,
        ],
        opts,
      );
      if (r.code !== 0) return prPathsMemo;
      prPathsMemo = new Set(r.stdout.split("\0").filter((l) => l !== ""));
      return prPathsMemo;
    },
    async headPaths(): Promise<Set<string> | null> {
      if (headPathsMemo !== undefined) return headPathsMemo;
      headPathsMemo = null;
      const resolvedHead = await resolveHead();
      if (resolvedHead === null) return headPathsMemo;
      // ONE call for the whole tree, memoized — not a `cat-file -e` per
      // finding. A summary report carries tens of findings, and this probe
      // only ever separates `false` from `null`; paying a subprocess apiece
      // for that would cost more than the whole line-level scan it replaces.
      const r = await git(
        ["ls-tree", "-r", "--name-only", "-z", resolvedHead],
        opts,
      );
      if (r.code !== 0) return headPathsMemo;
      // NUL-delimited (`-z`), for the reason spelled out on `prPaths` above:
      // git's default output quotes and escapes any path with a non-ASCII or
      // special character, and the two sets are compared against each other.
      headPathsMemo = new Set(r.stdout.split("\0").filter((l) => l !== ""));
      return headPathsMemo;
    },
    async blame(path: string, line: number): Promise<string | null> {
      const resolvedHead = await resolveHead();
      if (resolvedHead === null) return null;
      // `--porcelain` so the first token of the first line is the commit id in
      // a stable, locale-independent format — `git blame`'s human output is
      // not. `-L n,n` bounds the read to one line, so this costs the same on a
      // 10k-line file as on a 10-line one.
      //
      // `--` before the path is load-bearing: a repository path that happens
      // to look like a revision (`HEAD`, a branch name) would otherwise be
      // parsed as one, and blame would answer for something else entirely.
      const r = await git(
        [
          "blame",
          "--porcelain",
          "-L",
          `${line},${line}`,
          resolvedHead,
          "--",
          path,
        ],
        opts,
      );
      if (r.code !== 0) return null;
      const first = r.stdout.split("\n", 1)[0] ?? "";
      const token = first.split(" ", 1)[0] ?? "";
      // A full 40-hex id and nothing else. `git blame` prefixes an uncommitted
      // line's id with `^` (boundary) or emits the all-zero id for a working-
      // tree change; neither is a commit this PR could have pushed, and both
      // would read as "not one of ours" — a `false` on evidence that says
      // nothing about who wrote the line.
      if (!/^[0-9a-f]{40}$/.test(token)) return null;
      if (/^0{40}$/.test(token)) return null;
      return token;
    },
  };
}

/**
 * The PR's base branch as a remote-tracking ref, read from the PR itself.
 *
 * NEVER a hardcoded `develop` fallback. `base-sync.ts` states the rule for the
 * identical question — "`baseRefName`, never a hardcoded `develop`" — and the
 * cost of breaking it here is specific: a PR filed against a release branch
 * would have every commit on that branch counted as `base..HEAD`, so the whole
 * base history would label as this PR's own work and every finding on it would
 * read `SELF-INFLICTED: true`. An unreadable answer therefore returns `''`,
 * which the caller turns into an all-`null` stream with a loud diagnostic —
 * not measured, rather than measured against a guess.
 *
 * Also REFRESHES `<remote>/<base>` (`<remote>` is `repository.remote`, else
 * `origin`) before returning it — REQUIRED, not
 * best-effort. Without this, a base the branch has since merged newer commits
 * INTO — the gate's own drift fetch failed, or this filter ran standalone with
 * nothing having fetched recently — leaves a stale local `<remote>/<base>`, and
 * `rev-list <remote>/<base>..HEAD` then counts those newer base commits as this
 * PR's own, mislabelling a finding on one of them a confident
 * `selfInflicted: true` that can license skipping the blast-radius reread.
 * An EARLIER revision made this
 * best-effort, on the reasoning that `lib/base-drift.ts`'s own fetch degrades
 * the same way — but that probe's `fetched` flag only ever feeds an advisory
 * "N commits behind" line, while a stale answer HERE feeds a `true`/`false`
 * claim a caller acts on directly. A failed fetch is therefore UNRESOLVED
 * (`''`), the same NOT-MEASURED posture as every other failure in this
 * function, rather than a confident answer read off a possibly-stale ref. The
 * refspec is explicit (`+refs/heads/<name>:refs/remotes/<remote>/<name>`), not a
 * plain branch name, for `base-drift.ts`'s own reason: a plain name resolves
 * through `<remote>`'s configured `remote.<remote>.fetch`, which can update a ref
 * other than the exact one this function is about to read.
 *
 * `repo` is caller-controlled (`--repo`/`$DRIVE_PR_WORKTREE`), so it can name
 * any checkout on disk — and that checkout's `<remote>` is whatever it is, not
 * necessarily this PR's own repository. `git fetch` cannot detect a wrong
 * `<remote>` itself: it happily writes `refs/remotes/<remote>/<name>` from
 * whatever `<remote>` answers with, under the name asked for, so a
 * wrong-repository fetch reads exactly like a right one — dereferencing an
 * attacker-chosen or merely stale host with no signal that anything was wrong.
 * `verifyRemoteIsPrRepo` — the same check
 * `base-sync.ts` runs before its own identical fetch — resolves the
 * expected `owner/name` via `gh repo view` and confirms `<remote>`'s fetch URL
 * actually names it, BEFORE the fetch below ever runs. Unresolvable or
 * mismatched is UNRESOLVED, not a guess.
 *
 * Both `gh` calls below run with `cwd: repo` — the same worktree the `git`
 * calls above already run in — rather than the process's own ambient cwd.
 * `--repo`/`$DRIVE_PR_WORKTREE` exists precisely so this filter can run
 * against a checkout other than the one it was invoked from, and `gh` with no
 * cwd override resolves the PR and its base against whatever repository the
 * process happens to be sitting in: an omitted PR becomes unresolvable, and
 * an explicit number that also exists in the ambient repository can resolve
 * against the WRONG base. Both also carry
 * `env: ghRepoEnv()` for the same reason `resolvePr` itself does: `cwd` alone
 * is not authoritative over `gh`'s repository selection, since an inherited
 * `GH_REPO` outranks it.
 */
async function resolveBaseRef(pr: string, repo: string): Promise<string> {
  const env = process.env.DRIVE_PR_BASE_REF ?? "";
  if (env !== "") return env;
  const target = await resolvePr(pr, repo);
  if (target === "") return "";
  const r = await ghCall(
    ["pr", "view", target, "--json", "baseRefName", "-q", ".baseRefName"],
    { stderr: "ignore", cwd: repo, env: ghRepoEnv() },
  );
  if (r.code !== 0) return "";
  const name = r.stdout.trim();
  if (name === "") return "";
  const remote = await verifiedRemote(repo);
  if (remote === null) return "";

  const fetched = await git(
    [
      "fetch",
      "--quiet",
      remote,
      `+refs/heads/${name}:refs/remotes/${remote}/${name}`,
    ],
    {
      cwd: repo,
      env: gitIdentityEnv(),
      stderr: "ignore",
      timeoutSec: gitCallTimeoutSeconds(),
    },
  );
  if (fetched.code !== 0) {
    console.error(
      `self-inflicted: could not refresh ${remote}/${name} — refusing to measure against a possibly stale local ref.`,
    );
    return "";
  }
  return `${remote}/${name}`;
}

/** `owner/name` of the repository `gh` resolves at `repo`, or `""`. */
async function ghRepository(repo: string): Promise<string> {
  const view = await cachedRepoView(["--json", "owner,name"], {
    stderr: "ignore",
    cwd: repo,
    env: ghRepoEnv(),
  });
  let repository = "";
  if (view.code !== 0) return repository;
  try {
    const meta = JSON.parse(view.stdout) as {
      owner?: { login?: string };
      name?: string;
    };
    const owner = meta.owner?.login ?? "";
    const repoName = meta.name ?? "";
    if (owner !== "" && repoName !== "") repository = `${owner}/${repoName}`;
  } catch {
    // Left empty — refused by the caller, as an unreadable `gh repo view` is.
  }
  return repository;
}

/**
 * The remote of the checkout at `repo` (`repository.remote`, else `origin`)
 * once its fetch URL is verified to name the repository `gh` resolved there,
 * or `null` with the reason on stderr.
 */
async function verifiedRemote(repo: string): Promise<string | null> {
  const remote = readRemoteName(consumerRoot(repo));
  const why =
    "error" in remote
      ? remote.error
      : await remoteMismatch(repo, remote.remote);
  if (why === null && "remote" in remote) return remote.remote;
  console.error(`self-inflicted: ${why}`);
  return null;
}

/** Why `remote` cannot be trusted as the PR's repository, or `null`. */
async function remoteMismatch(
  repo: string,
  remote: string,
): Promise<string | null> {
  const expectedRepo = await ghRepository(repo);
  if (expectedRepo === "")
    return `could not resolve this repository via \`gh repo view\` — refusing to fetch the base branch from an unverified '${remote}'.`;
  const check = await verifyRemoteIsPrRepo(
    git,
    repo,
    expectedRepo,
    gitIdentityEnv(),
    remote,
  );
  return check.ok ? null : check.why;
}

/**
 * `--summary-report`: label every finding in a `summary-findings.ts` report
 * with the FILE-level `selfInflicted` measurement. See the header.
 *
 * Reads ONE JSON document, not NDJSON — the report is the unit
 * `summary-findings.ts` emits and the unit the triaging agent reads, and
 * splitting it into lines here would leave the caller to reassemble the
 * envelope (`total`, `unaddressed`, `stickyCommentId`) that its own
 * convergence checks read.
 *
 * `unaddressed` is rebuilt from the labelled `findings` by fingerprint rather
 * than labelled independently: the two arrays share findings, and labelling
 * each pass separately is how the same finding ends up carrying two different
 * answers in one document.
 *
 * FAIL-CLOSED on a malformed document (exit 1), matching the NDJSON path's
 * treatment of an unparsable line: this output IS the pass's summary-finding
 * list, and emitting a silently truncated one hides findings.
 */
async function runSummaryReport(
  deps: LabelDeps,
  base: string,
  head: string,
  repo: string,
): Promise<number> {
  const prPaths = base === "" ? null : await deps.prPaths();
  const headPaths = prPaths === null ? null : await deps.headPaths();
  if (prPaths === null) {
    // Said out loud, for the same reason the NDJSON path says it: an
    // unexplained absence of labels reads as "nothing was self-inflicted".
    console.error(
      base === ""
        ? 'self-inflicted: could not resolve the PR\'s base branch — every summary finding will be labelled null, which means NOT MEASURED, not "clean". Pass --base explicitly, or $DRIVE_PR_BASE_REF.'
        : `self-inflicted: could not resolve this PR's changed paths (${base}..${head} in ${repo}) — every summary finding will be labelled null, which means NOT MEASURED, not "clean"`,
    );
  } else if (headPaths === null) {
    // A narrower degradation, and worth its own line: the PR's own paths ARE
    // known, so `true` is still measured; only the `false`/`null` split
    // collapses, and every untouched file reads NOT MEASURED.
    console.error(
      `self-inflicted: could not list the head tree (${head} in ${repo}) — findings on files this PR did not touch will be labelled null rather than false`,
    );
  }

  // REQUIRED before iterating, exactly as the NDJSON path below does it.
  // Without it Bun yields `Buffer` chunks (measured: 65536 bytes, then the
  // remainder), and `raw += chunk` stringifies EACH ONE independently — so a
  // multi-byte character straddling a chunk boundary becomes U+FFFD.
  // `JSON.parse` still succeeds, so the corruption is silent: a mangled
  // `fingerprint` makes the marker the agent posts unmatchable (the drive
  // never converges), a mangled `path` collapses a measured label to `null`,
  // and mangled `text` reaches the triaging agent as garbled prose. Verified
  // by a fixture that puts an em-dash across byte 65536 — two U+FFFD without
  // this line, none with it.
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error(
      "self-inflicted: --summary-report expects one summary-findings.ts JSON document on stdin",
    );
    return 1;
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    console.error("self-inflicted: --summary-report stdin is not a report");
    return 1;
  }
  const findings = (report as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    console.error(
      "self-inflicted: --summary-report stdin has no `findings` array",
    );
    return 1;
  }
  const labelled: unknown[] = [];
  for (const f of findings) {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      console.error(
        "self-inflicted: --summary-report finding is not an object",
      );
      return 1;
    }
    labelled.push({
      ...(f as object),
      ...(await labelSummaryFinding(
        f as SummaryFindingRecord,
        prPaths,
        headPaths,
      )),
    });
  }
  // Rebuilt from the labelled set, keyed on the fingerprint that identifies a
  // finding. A report whose `unaddressed` names a fingerprint absent from
  // `findings` is malformed — every `unaddressed` entry is by construction one
  // of them — and dropping it silently would hide a live finding, so it is the
  // same fail-closed exit as an unparsable document.
  //
  // The key must be a MARKER_SAFE_FINGERPRINT-shaped string, unique across
  // `findings`, before anything is looked up against it. An absent or
  // non-string `fingerprint` on two findings would otherwise both key under
  // the single JS value `undefined`, at which point a MALFORMED `unaddressed`
  // entry that also carries no usable fingerprint would resolve — silently —
  // to whichever finding wrote there last, instead of failing closed like
  // every other shape violation here.
  const byFingerprint = new Map<string, unknown>();
  for (const f of labelled) {
    const fp = (f as { fingerprint?: unknown }).fingerprint;
    if (typeof fp !== "string" || !MARKER_SAFE_FINGERPRINT.test(fp)) {
      console.error(
        `self-inflicted: --summary-report finding has an unusable fingerprint (${JSON.stringify(fp)})`,
      );
      return 1;
    }
    if (byFingerprint.has(fp)) {
      console.error(
        `self-inflicted: --summary-report repeats fingerprint \`${fp}\` — two findings under one key would silently become one`,
      );
      return 1;
    }
    byFingerprint.set(fp, f);
  }
  const rawUnaddressed = (report as { unaddressed?: unknown }).unaddressed;
  let unaddressed: unknown = rawUnaddressed;
  // ABSENT is fine — a caller may hand us a report shape that carries no
  // `unaddressed` at all. PRESENT BUT NOT AN ARRAY is a malformed document,
  // and passing it through would emit an `unaddressed` carrying no
  // `selfInflicted` while every other shape violation here exits 1 — making
  // this function's own fail-closed promise false.
  if (rawUnaddressed !== undefined && !Array.isArray(rawUnaddressed)) {
    console.error(
      "self-inflicted: --summary-report stdin has a non-array `unaddressed`",
    );
    return 1;
  }
  if (Array.isArray(rawUnaddressed)) {
    const rebuilt: unknown[] = [];
    for (const u of rawUnaddressed) {
      const fp =
        typeof u === "object" && u !== null
          ? (u as { fingerprint?: unknown }).fingerprint
          : undefined;
      // A non-string fingerprint is malformed on its own terms and must never
      // be looked up at all — otherwise it could silently borrow whatever
      // finding happens to sit under a coincidental Map key (e.g. two
      // findings that both lack a fingerprint, above).
      if (typeof fp !== "string") {
        console.error(
          `self-inflicted: --summary-report unaddressed entry has no usable fingerprint (${JSON.stringify(fp)})`,
        );
        return 1;
      }
      const match = byFingerprint.get(fp);
      if (match === undefined) {
        console.error(
          `self-inflicted: --summary-report unaddressed entry ${fp} is not in findings`,
        );
        return 1;
      }
      rebuilt.push(match);
    }
    unaddressed = rebuilt;
  }
  console.log(
    JSON.stringify({ ...(report as object), findings: labelled, unaddressed }),
  );
  return 0;
}

async function main(): Promise<number> {
  let base = "";
  let head = "HEAD";
  let repo = process.env.DRIVE_PR_WORKTREE || process.cwd();
  let pr = "";
  let prGiven = false;
  let summaryReport = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      // A second positional argument is not this call naming a different PR
      // — silently overwriting `pr` would measure against whichever one came
      // last, with nothing saying the first was ever discarded.
      if (prGiven) {
        console.error(
          `self-inflicted: unexpected extra positional argument: ${arg} (PR already given as ${pr})`,
        );
        return 2;
      }
      pr = arg;
      prGiven = true;
      continue;
    }
    // A valueless boolean, checked before the value-taking flags below so it
    // is not reported as needing one.
    if (arg === "--summary-report") {
      summaryReport = true;
      continue;
    }
    if (arg !== "--base" && arg !== "--head" && arg !== "--repo") {
      console.error(`self-inflicted: unknown argument: ${arg}`);
      return 2;
    }
    // A flag with no value is a usage error, not a flag with an empty value:
    // `--repo` swallowing the next flag, or defaulting to the cwd, would blame
    // a different repository than the caller asked about and label every
    // record confidently against it. A value that itself LOOKS like a flag
    // (`--base --repo /tmp`) is the same failure one token later: silently
    // consuming `--repo` as `--base`'s value leaves `--repo`'s own value
    // (`/tmp`) to fall through as an unintended positional PR.
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`self-inflicted: ${arg} requires a value`);
      return 2;
    }
    i += 1;
    if (value === "") {
      console.error(`self-inflicted: ${arg} requires a non-empty value`);
      return 2;
    }
    if (arg === "--base") base = value;
    else if (arg === "--head") head = value;
    else repo = value;
  }

  if (base === "") base = await resolveBaseRef(pr, repo);
  // An unresolved base is NOT_MEASURED, never a guess. `gitDeps` is still
  // constructed so the stream is passed through and labelled — `prCommits`
  // returns null for an empty base, which labels every record null.
  const deps = gitDeps(repo, base, head);
  if (summaryReport) return await runSummaryReport(deps, base, head, repo);
  const prCommits = base === "" ? null : await deps.prCommits();
  if (prCommits === null) {
    // Said out loud rather than swallowed. Every record will carry
    // `selfInflicted: null`, and a reader who does not know WHY would read the
    // absence of labels as "nothing was self-inflicted" — the exact inversion
    // the three-valued vocabulary exists to prevent.
    console.error(
      base === ""
        ? 'self-inflicted: could not resolve the PR\'s base branch — every record will be labelled null, which means NOT MEASURED, not "clean". Pass --base explicitly, or $DRIVE_PR_BASE_REF.'
        : `self-inflicted: could not resolve this PR's commits (${base}..${head} in ${repo}) — every record will be labelled null, which means NOT MEASURED, not "clean"`,
    );
  }

  process.stdin.setEncoding("utf8");
  let buf = "";
  let out = "";
  const handle = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      console.error("self-inflicted: unparsable line on stdin");
      throw new Error("bad-input");
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      console.error("self-inflicted: stdin line is not a thread record");
      throw new Error("bad-input");
    }
    // A fresh budget PER RECORD, not one shared across the whole stream: a
    // shared deadline would let one record's slow or multi-line range starve
    // every later record's own scan, turning one bad range into a `null`
    // flood for records that had nothing to do with it.
    //
    // `Date.now()` here is the same operational timeout pattern, exempt from
    // clock injection, documented at `labelRecord`'s own deadline check above —
    // see that comment for the precedent.
    const label = await labelRecord(
      rec as AnchoredRecord,
      prCommits,
      deps.blame,
      Date.now() + rangeScanDeadlineMs(),
    );
    const severity = severityOfRecord(rec as LabelledRecord);
    const category = categoryOfRecord(rec as LabelledRecord);
    out += `${JSON.stringify({ ...(rec as object), ...label, severity, category })}\n`;
  };

  try {
    for await (const chunk of process.stdin) {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        await handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    // A final line with no trailing newline is still a record.
    await handle(buf);
  } catch {
    return 1;
  }
  process.stdout.write(out);
  return 0;
}

if (import.meta.main) runMain("self-inflicted", main);
