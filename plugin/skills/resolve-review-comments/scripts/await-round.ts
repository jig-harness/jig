#!/usr/bin/env bun
import {
  reviewConfig,
  reviewerSelection,
  siblingSkill,
} from "./lib/consumer.ts";

/**
 * Block until the next review round is ready to work, or until the PR
 * converges.
 *
 * This is the portable convergence primitive. It exists because the stop
 * condition for "keep resolving comments until none are left" must be usable
 * from BOTH agent harnesses: Claude Code can wrap a pass in `/loop`, but Codex
 * has no recurring-run feature at all. Keeping the loop in a harness feature
 * would have made continuous mode Claude-only. So the wait/stop decision lives
 * here, in a script, and each harness only owns "run one pass".
 *
 * Usage: await-round.ts [PR_NUMBER] [--bots-only] [--job-pattern REGEX]
 *                       [--timeout SECONDS] [--interval SECONDS] [--once]
 *                       [--once-budget-sec SECONDS]
 *
 *   PR_NUMBER       defaults to the PR for the current branch.
 *   --bots-only     count only bot-authored threads, matching the set a
 *                   `--bots-only` pass actually resolves. Load-bearing: an
 *                   intentionally-open human thread otherwise keeps the count
 *                   above zero forever and the loop never converges.
 *   --job-pattern   only wait on checks whose name matches this JS regular
 *                   expression (e.g. the reviewer job). Default: wait for ALL
 *                   checks to settle. Narrow it when a repo's slowest check is
 *                   unrelated to review (a full test matrix) and you don't
 *                   want to block on it. Explicit patterns require exact
 *                   review.required_checks names in the consumer overlay.
 *                   Missing required checks wait; skipped required checks fail.
 *                   Dormant optional arms are omitted from required_checks.
 *   --timeout       give up waiting after this long (default 1800s). Exits 4.
 *   --interval      poll spacing while checks are pending (default 30s, min 5s).
 *   --once          evaluate a single time and exit; never sleep.
 *   --once-budget-sec  the total wall-clock seconds an OUTER caller allows
 *                   this whole invocation, if any (an external status board
 *                   passes its own command timeout, in seconds). Only
 *                   meaningful with `--once`. Unset by default: the ordinary
 *                   direct `--once` invocation (e.g. `/resolve-review-
 *                   comments`'s own loop) has no such outer deadline and must
 *                   not be refused as if it did.
 *   --no-count      do not count this as a worked round (for dry runs / probes).
 *   --no-ci         assert this PR genuinely has no checks, so an empty check
 *                   set is settled immediately instead of waiting out the
 *                   grace window. Explicit, because inferring "no CI" from a
 *                   transient empty read is what abandons a round seconds
 *                   before it posts.
 *
 * Exit codes — the loop contract:
 *   0  a round is ready: reviewers have settled AND unresolved threads exist
 *   3  converged: reviewers have settled AND zero unresolved threads AND no
 *      summary-only finding outstanding (below)
 *   4  timed out waiting for checks to settle (nothing was decided)
 *   5  the PR is no longer open (merged or closed) — abandon the loop
 *   7  a matching check FAILED — it may never have posted findings, so a zero
 *      thread count would not mean the round was clean
 *   8  zero unresolved threads, but the reviewer has summary-only findings
 *      no one has answered — they never became threads, so a thread-driven
 *      pass cannot see them
 *   1  the check state could not be read at all — never reported as settled
 *   2  usage error
 *
 * Polling cost. Every `gh pr view` / `gh pr checks` is a GraphQL
 * call, and one token's 5,000-point hourly bucket backs every driver on the
 * machine. So the PR's state and head SHA are read over conditional REST
 * (`lib/gh-conditional.ts`; an unchanged PR answers 304, which is free), and
 * `gh pr checks` — still the ONLY source of the checks verdict — is skipped
 * for a tick only when the PR's check runs and commit statuses are confirmed
 * unchanged since a keep-waiting read (`pending` or `no-reviewer`) in this same
 * process. Never for a terminal verdict, and a stored verdict is not reused once
 * it is AWAIT_ROUND_CHECKS_MAX_AGE seconds old (default 300; 0 = always read).
 * That bounds only the age of a reused verdict, tested when each tick decides
 * whether to reuse it — it is not a deadline on when a transition is seen, since
 * the tick's own `gh` calls and the polling sleep come on top. A reused verdict
 * is by construction a keep-waiting one, so reuse can never manufacture a
 * convergence.
 *
 * Exit 5 is checked FIRST, on every pass. A PR that merges mid-loop silently
 * orphans every subsequent fix: the agent keeps resolving threads and pushing
 * commits to a branch nothing will ever merge, and the work is lost with no
 * error anywhere. Re-checking liveness each round is the only thing that
 * catches it, so it is mechanised here rather than left to the agent to
 * remember.
 *
 * "Settled" means no matching check is still pending. A zero thread count
 * while a reviewer job is pending is NOT convergence — it just means that
 * round's comments have not posted yet. Conflating the two is the single most
 * common way a resolve loop exits early and leaves real findings unaddressed
 * on the PR.
 *
 * Exit 8. A finding the reviewer cannot anchor to a diff line is
 * posted only in its summary comment and never becomes a thread, so zero
 * unresolved threads is not zero findings: in practice that happened twice,
 * each time one step from a false "converged". Detecting and answering such
 * findings is `/drive-pr`'s job — its `summary-findings.ts` parses the
 * reviewer's summary and tracks which findings were answered — so this does
 * not re-derive it: before reporting convergence it spawns that script when
 * the repository has a `drive-pr` skill (the same optional-sibling
 * spawn `reply-to-thread.ts` and `converge.ts` make, `lstat`-probed), and
 * exits 8 when it reports any unaddressed finding. A script that fails or
 * answers in an unusable shape fails closed (exit 1). A STANDALONE install —
 * no `/drive-pr` beside it — skips the check: that is a documented residual
 * of that install shape, not a pass. (An earlier cut re-derived the count
 * from the reviewer's check-run and inline reviews; its edge cases proved
 * costly enough that it was replaced by this.)
 *
 * A second, narrower residual: this
 * check has no cross-pass memory of its own, only what `summary-findings.ts`
 * reads off the reviewer's CURRENT sticky comment. A caller relying solely
 * on this script's own exit codes across separate passes — never
 * independently re-enumerating findings itself, unlike `/drive-pr`'s own
 * loop, which does every round regardless of this exit code — has no way to
 * notice a finding that the reviewer's own regenerated sticky stops
 * repeating between two passes, for any reason short of a positive
 * `answered`/expired-backlog marker. Closing this fully would mean this
 * script keeping its own persistent finding ledger, duplicating
 * `summary-findings.ts`'s backlog/winddown carry-forward rather than relying
 * on it — a redesign, not a fix, and out of scope here.
 *
 * Drive one pass per exit-0, e.g.:
 *   while bun await-round.ts --bots-only; do <run one agent pass>; done
 * `converge.ts` in this directory wraps exactly that for either harness.
 *
 * Every `gh` call is bounded by GH_CALL_TIMEOUT (lib/proc.ts): --timeout only
 * bounds the poll/sleep loop and says nothing about any ONE call, which has no
 * timeout of its own — a connection that's accepted but never completes would
 * otherwise hang here forever regardless of --timeout, since this deadline is
 * only ever checked BETWEEN calls, never during one.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envOrDefault,
  fail,
  isDigits,
  isSafeDigits,
  runMain,
  sleep,
} from "./lib/cli.ts";
import { checkSignalsUnchanged, readPrLiveness } from "./lib/gh-conditional.ts";
import { ghCall, git, resolvePr, run, tsArgv } from "./lib/proc.ts";
import { skillsParentIsIntact } from "./reply-to-thread.ts";

const here = dirname(fileURLToPath(import.meta.url));
const listUnresolved = join(here, "list-unresolved-threads.ts");
/** `/drive-pr` — an optional sibling install. */
const DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
const SUMMARY_FINDINGS = join(DRIVE_PR_ROOT, "scripts", "summary-findings.ts");
/**
 * `/jig:reflect`'s capture helper, beside this skill in the plugin: absent
 * when this skill is installed on its own. Not looked up in the repository,
 * whose own `.claude/skills/reflect` may be an unrelated skill of that name.
 */
const REFLECT_CAPTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "reflect",
  "scripts",
  "lib",
  "capture.ts",
);

// Floor for --interval. A zero interval busy-loops against the forge API.
const MIN_INTERVAL = 5;
// Consecutive query failures tolerated before giving up. Never "settled".
const MAX_QUERY_ERRORS = 3;
// How long an empty check set may persist before we accept the repo has no
// CI. Covers the window after a push where the suite has not been created yet.
const NO_CHECKS_GRACE = 120;
// Longest a `pending` checks verdict may be reused on the strength of an
// unchanged REST signal before `gh pr checks` is asked again.
const DEFAULT_CHECKS_MAX_AGE = 300;

/**
 * Seconds slept between ticks: the `--interval`, or less when
 * `AWAIT_ROUND_POLL_MS` asks for it. That variable exists to compress the
 * loop's pacing in tests; it is not configuration. Clamped to
 * [10ms, the interval], so it can never slow the loop down or turn it into a
 * busy-spin; unset, empty or non-numeric leaves the interval in force.
 */
function pollSleepSeconds(interval: number): number {
  const raw = process.env.AWAIT_ROUND_POLL_MS ?? "";
  if (!isDigits(raw)) return interval;
  const ms = Number.parseInt(raw, 10);
  return Math.min(interval, Math.max(10, ms) / 1000);
}

// The flat timeout granted to the summary-findings.ts subprocess call when
// no caller-declared external budget applies — the ordinary case for every
// `--once` invocation except one bound by an outer wall-clock deadline (see
// `--once-budget-sec` below).
const SUMMARY_DEFAULT_TIMEOUT_SEC = 120;

// An external status board can run `--once --no-count` under its own command
// timeout (120s, for example), which kills this WHOLE process from outside if
// it runs long — losing the distinction between a genuine error and a
// slow-but-healthy read. This call is the last of several in a `--once` pass
// (PR state, checks, unresolved-thread count all run first), so it must not
// assume the full budget is still available to it.
//
// This only applies when the caller declares its own external budget via
// `--once-budget-sec` — the board passes its own 120s. A direct, interactive
// `--once` invocation (this skill's own SKILL.md documents one) has no such
// deadline and must not be refused as if it did: applying this
// unconditionally to every `--once` call was itself a defect.
//
// `SUMMARY_ONCE_MARGIN_SEC` is the slack left for the process to exit
// cleanly after this call returns. `SUMMARY_ONCE_MIN_TIMEOUT_SEC` is a
// REFUSAL threshold, never a floor granted to the call: flooring the
// timeout when little budget remains (an earlier version of this section
// did) can still push elapsed-so-far plus the granted call past the
// caller's declared deadline, which is the exact failure this section
// exists to prevent. Below this
// threshold, refuse without spawning the call at all.
const SUMMARY_ONCE_MARGIN_SEC = 10;
const SUMMARY_ONCE_MIN_TIMEOUT_SEC = 10;

type SummaryOnly =
  | { kind: "absent" }
  | { kind: "ok"; unaddressed: string[] }
  | { kind: "error" };

type DriveRootProbe =
  | { present: true }
  | { present: false; reason: "absent" | "error" };

/**
 * `lstat` on the `/drive-pr` skill root — the same probe `reply-to-thread.ts`
 * uses. Synchronous and effectively free, so callers may probe it BEFORE
 * paying for anything time-bounded: the
 * documented standalone case needs no subprocess at all, and applying a
 * remaining-budget refusal ahead of this check could refuse a call that was
 * about to return `absent` for free.
 */
function probeDriveRoot(): DriveRootProbe {
  try {
    lstatSync(DRIVE_PR_ROOT);
    return { present: true };
  } catch (e) {
    // ENOENT on the root alone is not proof: it also answers when the whole
    // skills directory was removed or renamed after this process loaded. Only
    // an intact parent with the root missing is a standalone install — the
    // same two-halves rule, and the same predicate, as reply-to-thread.ts's
    // fence.
    if (
      (e as NodeJS.ErrnoException)?.code === "ENOENT" &&
      skillsParentIsIntact(dirname(DRIVE_PR_ROOT))
    ) {
      return { present: false, reason: "absent" };
    }
    return { present: false, reason: "error" };
  }
}

/**
 * Unaddressed summary-only findings, from `/drive-pr`'s own enumerator
 * (see the header). `absent` only when the `/drive-pr` ROOT entry
 * positively does not exist. Any install that exists at all is attempted, so
 * a root with no `scripts/`, a dangling `scripts` symlink, or a `scripts/`
 * missing the script fails closed instead of reading as a standalone
 * install. Shape-checked the way `/drive-pr`'s own
 * `evidence.ts` reads the same payload.
 *
 * `rootProbe` is taken as a parameter, not re-derived here, so a caller can
 * probe it once ahead of a remaining-budget computation the probe itself
 * should not be charged against.
 */
async function summaryOnlyFindings(
  pr: string,
  timeoutSec: number,
  rootProbe: DriveRootProbe,
): Promise<SummaryOnly> {
  if (!rootProbe.present) {
    return rootProbe.reason === "absent"
      ? { kind: "absent" }
      : { kind: "error" };
  }
  const r = await run(tsArgv(SUMMARY_FINDINGS, [pr, "--json"]), {
    timeoutSec,
    stderr: "inherit",
  });
  if (r.code !== 0) return { kind: "error" };
  try {
    const parsed = JSON.parse(r.stdout) as {
      total?: unknown;
      unaddressed?: unknown;
    };
    if (typeof parsed.total !== "number" || !Array.isArray(parsed.unaddressed))
      return { kind: "error" };
    const fps: string[] = [];
    for (const f of parsed.unaddressed as Array<{ fingerprint?: unknown }>) {
      if (typeof f?.fingerprint !== "string") return { kind: "error" };
      fps.push(f.fingerprint);
    }
    return { kind: "ok", unaddressed: fps };
  } catch {
    return { kind: "error" };
  }
}

interface CheckRun {
  name: string;
  bucket: string;
  state: string;
}

type CheckState =
  | "pending"
  | "settled"
  | "failed"
  | "none"
  | "no-reviewer"
  | "missing-required"
  | "mismatch"
  | "error";

/** A classification plus, for `missing-required`, the names still absent. */
type CheckResult = { state: CheckState; missing: string[] };

/**
 * Classify the check set. Returns exactly one state of:
 *
 *   pending      a matching check is still running
 *   settled      required coverage is complete and matching checks are done
 *   failed       a matching check ended in failure — see below
 *   none         the RAW check set is empty (no checks created yet, or no CI
 *                at all) — the one state --no-ci may legitimately assert
 *   no-reviewer  checks exist, but no reviewer-shaped one has been observed
 *                yet (none matched the name pattern, or every match so far is
 *                a permanently-skipped arm) — checks exist, so --no-ci's "this
 *                PR genuinely has no checks" contract does not cover it
 *   missing-required  at least one consumer-required check has not appeared
 *   mismatch     checks exist but --job-pattern matched none: a config error,
 *                not an absence of CI, so it must not fall through to no-CI
 *   error        the query itself failed; we do NOT know the state
 *
 * The distinctions are the whole point. An earlier version collapsed all of
 * them into a boolean and mapped every failure to "not pending", so an auth
 * blip, a rate limit, or a not-yet-created check suite read as "settled" — and
 * a zero thread count then declared convergence while the round's comments had
 * not posted. Never infer settled from an absence of evidence.
 *
 * `gh pr checks` documents exit 8 as "checks pending", so that status is
 * authoritative pending rather than a failure. Handled explicitly because a
 * plain non-zero check inverts it into the most dangerous possible answer.
 * (Observed: gh 2.96.0 returns 0 with --json even while pending; the explicit
 * branch costs nothing and survives that behaviour changing back.)
 */
async function checkState(
  pr: string,
  jobPattern: RegExp | null,
  requiredChecks: string[],
): Promise<CheckResult> {
  const r = await ghCall(["pr", "checks", pr, "--json", "name,bucket,state"], {
    stderr: "ignore",
  });
  // Exit 8 is "checks pending", but the JSON it carries is still usable: a
  // required reviewer that already ended SKIPPED or failed must outrank the
  // pending answer. Only an unreadable body falls back to bare pending.
  const pendingExit = r.code === 8;
  if (r.code !== 0 && !pendingExit) return { state: "error", missing: [] };
  if (r.stdout.trim() === "") {
    return { state: pendingExit ? "pending" : "error", missing: [] };
  }

  let raw: CheckRun[];
  try {
    raw = JSON.parse(r.stdout) as CheckRun[];
    if (!Array.isArray(raw)) throw new Error("not an array");
  } catch {
    return { state: pendingExit ? "pending" : "error", missing: [] };
  }
  const state = (s: CheckState, missing: string[] = []): CheckResult => ({
    state: s,
    missing,
  });

  // Consumer policy declares coverage; regex alternation does not. Evaluate
  // each required name before the empty-set/no-CI path or SKIPPED filtering.
  // A required job that never ran cannot attest to a clean review round.
  const required = raw.filter((c) => requiredChecks.includes(c.name));
  if (required.some((c) => c.state === "SKIPPED")) return state("failed");

  // Which checks may veto a convergence. Scoping this to an explicit
  // --job-pattern was wrong in both directions: with no pattern an unrelated
  // failing build blocked the loop, but scoping it to the pattern meant the
  // DEFAULT invocation — the one every documented example uses — could never
  // notice a failed reviewer at all. Use the reviewer set instead: an explicit
  // pattern when given, otherwise checks whose name looks like a reviewer.
  // Unrelated CI failures stay out of it either way.
  //
  // "review" alone is too broad a fragment for the heuristic: common,
  // unrelated GitHub-native checks such as "Dependency Review" or a "Security
  // Review" gate would match it, get counted as evidence the reviewer ran, and
  // let a genuinely unreviewed round report settled the moment that unrelated
  // check appears (which can easily precede the real reviewer check's
  // creation). Requiring "ai"+"review" together for the bare word keeps every
  // common reviewer identity (AI review, AI review with an arm suffix such as
  // `(shadow)`, codex-named checks, CodeRabbit) while excluding that class of
  // decoy.
  //
  // Required names are always vetoes, in addition to whichever reviewer set
  // applies: declaring mandatory coverage must not switch off failure
  // detection for the other observed reviewers.
  const reviewerShaped = (c: CheckRun) =>
    jobPattern !== null
      ? jobPattern.test(c.name)
      : /ai[ _-]?review|codex|coderabbit/i.test(c.name);
  const vetoes = raw.filter(
    (c) => requiredChecks.includes(c.name) || reviewerShaped(c),
  );

  // Optional/fallback arms may intentionally never run. Only consumer-declared
  // required checks must attest to coverage; their SKIPPED state was refused
  // above.
  const liveVetoes = vetoes.filter((c) => c.state !== "SKIPPED");

  // A reviewer that FAILED never posted its findings, so "no open threads"
  // says nothing about whether the round was clean. This is judged before any
  // missing-coverage or pending answer: a failure already observed is more
  // useful to the driver (exit 7) than a wait for names that may never come.
  //
  // `fail` is not the only non-success terminal state. A cancelled or
  // timed-out reviewer posted no findings either, so treating those as settled
  // reports a clean round the reviewer never ran. NEUTRAL is deliberately
  // excluded from that list: some reviewers (e.g. a self-hosted shadow
  // check) are configured to always conclude neutral even on a clean run — see
  // the "informational only" check-run summary — so it is a completion state,
  // not a failure to report. Pending is not terminal.
  if (
    liveVetoes.some(
      (c) =>
        c.bucket !== "pass" && c.bucket !== "pending" && c.state !== "NEUTRAL",
    )
  ) {
    return state("failed");
  }

  const missing = requiredChecks.filter(
    (name) => !required.some((c) => c.name === name),
  );
  if (missing.length > 0) return state("missing-required", missing);

  // gh's documented "checks pending" exit is authoritative even when the
  // matching logic below cannot see the running check.
  if (pendingExit) return state("pending");

  // Filter to the checks we actually care about FIRST. Counting the raw set
  // ahead of the pattern means a PR with unrelated checks but no reviewer
  // check — never created, or a mistyped pattern — falls through every
  // predicate and reports `settled`, which is the false convergence this
  // function exists to prevent. An empty MATCHED set is the same ambiguity as
  // an empty check set.
  const matched =
    jobPattern === null ? raw : raw.filter((c) => jobPattern.test(c.name));
  if (matched.length === 0) {
    // No checks at all is ambiguous (no CI yet, or none ever). A pattern that
    // was explicitly supplied and matched nothing is NOT ambiguous — it is a
    // configuration error. Letting it fall through to the no-CI path means a
    // typo'd --job-pattern quietly waits out the grace window and then
    // declares convergence without the named reviewer ever being observed.
    if (jobPattern !== null && raw.length > 0) return state("mismatch");
    return state("none");
  }

  if (matched.some((c) => c.bucket === "pending")) return state("pending");

  // Other, non-reviewer checks can be visible and non-pending before the
  // reviewer job has even been created — an unrelated fast lint check
  // completing seconds after push is a common ordering, not an edge case. An
  // empty live reviewer set here is the SAME ambiguity as an empty check set
  // entirely: it must not fall through to `settled` below, or a zero thread
  // count declares convergence before the reviewer has had a chance to post.
  // This also covers a heuristic match that is only a permanently-skipped arm.
  if (liveVetoes.length === 0) return state("no-reviewer");

  return state("settled");
}

async function main(): Promise<number> {
  const mainStartedAt = Date.now();
  let pr = "";
  let botsOnly = false;
  let config: ReturnType<typeof reviewConfig>;
  try {
    config = reviewConfig();
  } catch (e) {
    fail(2, e instanceof Error ? e.message : String(e));
  }
  let jobPatternRaw = config.job_pattern ?? "";
  const requiredChecks = config.required_checks ?? [];
  let once = false;
  let noCi = false;
  let noCount = false;
  // `null` means the flag was never passed — distinct from an explicitly
  // supplied empty value (`--once-budget-sec ''`), which must still be
  // validated and refused rather than silently read as "not provided".
  let onceBudgetRaw: string | null = null;

  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    // A value-taking flag at the end of argv must fail as the usage error it
    // is, not as an unrelated crash.
    if (i + 1 >= argv.length) fail(2, `${flag} requires a value`);
    return argv[i + 1] ?? "";
  };
  let timeoutRaw = "1800";
  let intervalRaw = "30";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--bots-only":
        botsOnly = true;
        break;
      case "--job-pattern":
        jobPatternRaw = take(a, i++);
        break;
      case "--timeout":
        timeoutRaw = take(a, i++);
        break;
      case "--interval":
        intervalRaw = take(a, i++);
        break;
      case "--once":
        once = true;
        break;
      case "--no-ci":
        noCi = true;
        break;
      case "--no-count":
        noCount = true;
        break;
      case "--once-budget-sec":
        onceBudgetRaw = take(a, i++);
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  if (!isSafeDigits(timeoutRaw) || !isSafeDigits(intervalRaw)) {
    fail(2, "--timeout and --interval take whole seconds");
  }
  const timeout = Number.parseInt(timeoutRaw, 10);
  const interval = Number.parseInt(intervalRaw, 10);

  // A zero interval turns the pending branch into a busy loop that hammers
  // the forge API until the timeout. Floor it rather than trusting the caller.
  if (interval < MIN_INTERVAL) {
    fail(2, `--interval must be at least ${MIN_INTERVAL}s (got ${interval})`);
  }
  // `sleep(interval)` hands `interval * 1000` to `setTimeout`, which clamps a
  // delay beyond a 32-bit signed millisecond value to 1ms — silently turning
  // the floor above back into a busy loop.
  if (interval * 1000 > 2_147_483_647) {
    fail(2, `--interval must be at most 2147483s (got ${interval})`);
  }
  if (timeout < interval) {
    fail(
      2,
      `--timeout (${timeout}s) must be at least one --interval (${interval}s)`,
    );
  }

  // Unset by default — see SUMMARY_ONCE_MIN_TIMEOUT_SEC's doc comment: only
  // a caller that is genuinely bound by an EXTERNAL wall-clock deadline
  // (an external status board, via its own command timeout) declares one
  // here. Every other `--once` caller — including the direct, interactive
  // invocation this skill's own SKILL.md documents — has no such deadline
  // and must not be refused as if it did.
  //
  // Presence (`onceBudgetRaw !== null`) is checked separately from content
  // validity: an explicitly supplied empty value (`--once-budget-sec ''`)
  // must be refused, not silently read as "flag not passed". The value is
  // also bounded the same way `readTimeoutEnv` bounds every other
  // timeout-shaped flag/env var in this skill (`lib/proc.ts`): `setTimeout`
  // takes a 32-bit signed millisecond delay, so a digit-only value whose
  // `* 1000` overflows that range would otherwise fire immediately instead of
  // after the requested delay.
  let onceBudgetSec: number | null = null;
  if (onceBudgetRaw !== null) {
    const parsed = isDigits(onceBudgetRaw)
      ? Number.parseInt(onceBudgetRaw, 10)
      : Number.NaN;
    if (
      Number.isNaN(parsed) ||
      parsed <= 0 ||
      !Number.isSafeInteger(parsed) ||
      parsed * 1000 > 2_147_483_647
    ) {
      fail(
        2,
        "--once-budget-sec must be a positive whole number of seconds no greater than 2147483",
      );
    }
    onceBudgetSec = parsed;
  }

  // Compiled once, refused up front. A pattern applied fresh on every poll
  // would surface a malformed one as a query error and retry it as if the forge
  // had blipped — a config mistake misfiled as weather. (The dialect is a JS
  // RegExp; the simple name fragments this flag exists for parse the same in
  // any common regex dialect.)
  let jobPattern: RegExp | null = null;
  try {
    jobPattern = reviewerSelection(jobPatternRaw, requiredChecks);
  } catch (e) {
    fail(2, e instanceof Error ? e.message : String(e));
  }

  const checksMaxAgeRaw = envOrDefault(
    "AWAIT_ROUND_CHECKS_MAX_AGE",
    String(DEFAULT_CHECKS_MAX_AGE),
  );
  // Finite ceiling (one day): an absurdly long digit string would otherwise
  // parse to Infinity and make an unchanged-signals answer trusted forever.
  const checksMaxAgeSec = Number.parseInt(checksMaxAgeRaw, 10);
  if (
    !isDigits(checksMaxAgeRaw) ||
    !Number.isSafeInteger(checksMaxAgeSec) ||
    checksMaxAgeSec > 86400
  ) {
    fail(
      2,
      `AWAIT_ROUND_CHECKS_MAX_AGE must be a whole number of seconds, at most 86400 (got '${checksMaxAgeRaw}')`,
    );
  }
  const checksMaxAgeMs = checksMaxAgeSec * 1000;

  const reflectRaw = envOrDefault("REFLECT_THRESHOLD", "3");
  if (!isDigits(reflectRaw)) {
    fail(2, `REFLECT_THRESHOLD must be a whole number (got '${reflectRaw}')`);
  }
  const reflectThreshold = Number.parseInt(reflectRaw, 10);

  pr = await resolvePr(pr);
  if (pr === "") fail(1, "await-round: could not resolve a PR number");
  // Numeric only. `list-unresolved-threads.ts` has always refused anything
  // else (a URL or branch name reaches `gh -F` there), so a non-numeric PR used
  // to fail two stages in with an unrelated message. State and head are read
  // over REST by number, so say so here.
  if (!isDigits(pr)) {
    fail(2, `await-round: PR must be a number (got '${pr}')`);
  }

  // Round counting lives HERE, not in converge.ts, because this is the one
  // script both harness paths call: Claude wraps a single pass in /loop and
  // never invokes converge.ts at all. A counter held by one driver would
  // silently never fire for the other. Keeping it in the git dir also means
  // it survives across separate invocations — rounds worked hours apart in
  // one session still add up, which a per-process variable could not do.
  let roundsFile = "";
  let roundsHeadFile = "";
  const gitDir = await git(["rev-parse", "--git-dir"], { stderr: "ignore" });
  if (gitDir.code === 0 && gitDir.stdout.trim() !== "") {
    roundsFile = join(gitDir.stdout.trim(), `resolve-review-rounds-${pr}`);
    roundsHeadFile = `${roundsFile}.head`;
  }

  // The PR's current head SHA. A round is a distinct push, not a distinct
  // invocation — retrying the same pass after an agent failure must not count
  // twice, or the "more than N rounds" reflect signal measures driver retries
  // instead of reviewer rounds.
  const currentHead = async (): Promise<string> => {
    const l = await readPrLiveness(pr);
    return l.ok ? l.head : "";
  };

  const readCount = (file: string): number => {
    let n = "";
    try {
      n = readFileSync(file, "utf8").trim();
    } catch {
      return 0;
    }
    return isDigits(n) && n !== "" ? Number.parseInt(n, 10) : 0;
  };

  const bumpRounds = async (): Promise<void> => {
    // --no-count exists for callers that are only INSPECTING state (a dry
    // run). Counting those would inflate the session total and fire the
    // reflect prompt for rounds nobody worked.
    if (noCount || roundsFile === "") return;
    const head = await currentHead();
    // No head, no bump. An unresolved head (a transient `gh` failure or a
    // timeout) used to increment anyway AND leave `.head` unwritten, so the
    // dedup below could not fire and every retry against one unchanged push
    // counted again — a retried round 3 arriving as round 4. That was
    // tolerable while this ordinal only drove the advisory reflect nudge; it
    // is not, now that `current-round.ts` publishes it and the round-indexed
    // cutoff DECLINES trivial findings past round 4. Skipping the bump errs
    // toward a lower ordinal, which delays the cutoff and accepts more — the
    // opposite direction from declining valid findings on a round that never
    // happened.
    if (head === "") return;
    if (existsSync(roundsHeadFile)) {
      const lastHead = readFileSync(roundsHeadFile, "utf8").trim();
      // Same head as the last counted round means this call is a retry
      // against an unchanged push (e.g. the prior agent pass failed before it
      // could fix+push) — not a new round to count.
      if (head === lastHead) return;
    }
    // HEAD FIRST, then the count. These are two writes and nothing here makes
    // them one, so the ordering is what decides which way a kill between them
    // falls. Head-then-count loses a round (the next call sees its own head
    // already recorded and returns early) — the fail-open direction, which
    // only ever DELAYS the decline-only cutoff. Count-then-head, the previous
    // order, left a valid counter paired with a stale head, so the next call
    // re-incremented the SAME round and could arm the cutoff a round early
    //. Making it genuinely atomic would
    // take a single-file format that `current-round.ts` also reads; the
    // ordering buys the safety property without that.
    const n = readCount(roundsFile) + 1;
    writeFileSync(roundsHeadFile, `${head}\n`);
    writeFileSync(roundsFile, `${n}\n`);
    // Mid-loop structural-escalation nudge (distinct from the wind-down
    // reflect prompt below, which deliberately waits for convergence). Past
    // the threshold, the recorded failure mode is rounds spent patching one
    // variant of the same root cause at a time — measured chains ran
    // five-plus rounds before the structural fix landed anyway. Round count
    // is the only robust signal this script has (theme detection belongs to
    // the agent), so this prints every counted round past the threshold and
    // stays advisory.
    if (n > reflectThreshold) {
      console.error(
        `round ${n} on #${pr}: if this round's accepted fixes target the same root cause as the last round's (another race vector, another scanner depth, another heuristic), stop patching variants — propose the structural fix or defer it (SKILL.md step 3)`,
      );
    }
  };

  // Emitted only at wind-down — when the rounds have actually stopped.
  // Mid-loop the detail is still arriving and the session has nothing settled
  // to reflect on; at convergence it is complete and about to decay.
  const reportRoundsAndReset = async (): Promise<void> => {
    if (roundsFile === "") return;
    // A dry run (--no-count) only inspects; a converged preview must not
    // erase a real session's accumulated count or fire the reflect prompt in
    // its place.
    if (noCount) return;
    const n = readCount(roundsFile);
    const reset = (): void => {
      rmSync(roundsFile, { force: true });
      rmSync(roundsHeadFile, { force: true });
    };
    if (n <= reflectThreshold) return reset();
    // Asked for only when reflection is on; with it off, or without the
    // reflect skill installed, there is nowhere for the lesson to go and the
    // prompt would only be noise.
    if (!existsSync(REFLECT_CAPTURE)) return reset();
    const capture = (await import(
      REFLECT_CAPTURE
    )) as typeof import("../../reflect/scripts/lib/capture.ts");
    const reflection = capture.reflectionSwitch();
    if (reflection instanceof Error)
      console.error(
        `reflection settings unreadable, not asking for /jig:reflect: ${reflection.message}`,
      );
    if (reflection !== true) return reset();
    // The count is reset only once the journal holds it: after a failed
    // write, the next convergence reads the same count and tries again.
    let where =
      "The round count is in the reflection journal; now that the rounds have\n  wound down,";
    try {
      capture.noteReviewRounds({
        pullRequest: Number(pr),
        rounds: n,
        threshold: reflectThreshold,
        skill: "resolve-review-comments",
      });
      reset();
    } catch (error) {
      console.error(
        `could not note the round count in the reflection journal (kept for the next convergence): ${error instanceof Error ? error.message : String(error)}`,
      );
      where =
        "The round count could not be written to the reflection journal;\n  note it yourself, and now that the rounds have wound down,";
    }
    console.error(`
──────────────────────────────────────────────────────────────
  #${pr} converged after ${n} rounds (> ${reflectThreshold}).

  That many rounds usually means the scaffolding under-served
  this change, not that the reviewer was noisy. ${where}
  run /jig:reflect while the detail is still recoverable,
  and consider whether the fix belongs in an instruction file,
  a skill, a rule, or the reviewer config.
──────────────────────────────────────────────────────────────`);
  };

  const unresolvedCount = async (): Promise<number> => {
    const args = botsOnly ? [pr, "--bots-only"] : [pr];
    const r = await run(tsArgv(listUnresolved, args), { stderr: "inherit" });
    // A failed enumeration aborts the script rather than reading as a zero
    // count — a zero it did not measure must never converge the loop.
    if (r.code !== 0) {
      fail(
        1,
        `could not enumerate unresolved threads for #${pr} (exit ${r.code})`,
      );
    }
    return r.stdout.split("\n").filter((l) => l.trim() !== "").length;
  };

  const deadline = Date.now() + timeout * 1000;
  const pollSeconds = pollSleepSeconds(interval);
  let queryErrors = 0;
  let noChecksSince: number | null = null;

  // Sleep one interval, or fail if --once was given or the deadline has
  // passed. Returns false when the caller must exit 4.
  const waitOrGiveUp = async (): Promise<boolean> => {
    if (once) {
      console.error("not settled yet; --once given, not waiting");
      return false;
    }
    if (Date.now() >= deadline) {
      console.error(`timed out after ${timeout}s waiting for checks to settle`);
      return false;
    }
    await sleep(pollSeconds);
    return true;
  };

  // The last `pending`-class checks verdict, and the head SHA it was read for.
  // Reusable only while GitHub keeps confirming nothing moved (see the header).
  let lastWaiting: { state: CheckState; head: string; at: number } | null =
    null;

  for (;;) {
    const live = await readPrLiveness(pr);
    if (!live.ok) fail(1, `cannot read state of PR #${pr}`, live.reason);
    const liveHead = live.head;
    if (live.state !== "OPEN") {
      fail(
        5,
        `PR #${pr} is ${live.state} — abandoning the loop (further pushes would be orphaned)`,
      );
    }

    // `gh pr checks` is the only source of the verdict. Skip it for this tick
    // only when the previous read was a keep-waiting one, is recent, was for
    // this very head, and GitHub confirms no check run or status has changed
    // since. Any other outcome — including a failed or first REST read — falls
    // through to the authoritative read below.
    //
    // The detector is queried BEFORE the authoritative read on purpose, even
    // when there is nothing to reuse yet: that is what primes its ETags, and
    // priming AFTER the read would absorb a change that landed in between into
    // the ETag without it being in the verdict — a stale answer pinned until
    // the age bound. Not queried under `--once` (nothing to reuse) or when the
    // gate is disabled.
    const signalsUnchanged =
      liveHead !== "" && !once && checksMaxAgeMs > 0
        ? await checkSignalsUnchanged(liveHead)
        : false;
    let cs: CheckState;
    let missingRequired: string[] = [];
    if (
      lastWaiting !== null &&
      signalsUnchanged &&
      lastWaiting.head === liveHead &&
      Date.now() - lastWaiting.at < checksMaxAgeMs
    ) {
      cs = lastWaiting.state;
    } else {
      const result = await checkState(pr, jobPattern, requiredChecks);
      cs = result.state;
      missingRequired = result.missing;
      lastWaiting =
        liveHead !== "" && (cs === "pending" || cs === "no-reviewer")
          ? { state: cs, head: liveHead, at: Date.now() }
          : null;
    }

    switch (cs) {
      case "error": {
        queryErrors += 1;
        // With --once there is no retry to come, so report the real reason
        // now. Falling through to the wait path would exit 4 ("timed out"),
        // which describes a different failure than "the state could not be
        // read".
        if (once) {
          fail(1, `could not read checks for #${pr} — refusing to guess`);
        }
        if (queryErrors >= MAX_QUERY_ERRORS) {
          fail(
            1,
            `could not read checks for #${pr} after ${queryErrors} attempts — refusing to guess`,
          );
        }
        console.error(
          `check query failed (${queryErrors}/${MAX_QUERY_ERRORS}); retrying`,
        );
        if (!(await waitOrGiveUp())) return 4;
        continue;
      }

      case "pending":
        queryErrors = 0;
        // Checks exist now, so the earlier no-checks window is stale. Leaving
        // it set means a suite that appears late still gets measured from the
        // first empty read, and a later empty result would immediately exceed
        // the grace period instead of starting a fresh one.
        noChecksSince = null;
        if (!(await waitOrGiveUp())) return 4;
        continue;

      case "none":
        queryErrors = 0;
        // An empty check set is ambiguous: a repo with no CI, or a suite that
        // has not been created yet after a push. Treating it as settled
        // immediately is how a round's comments get abandoned seconds before
        // they post — so wait out a grace window first, and let --no-ci
        // assert the harmless case explicitly rather than inferring it from a
        // transient empty read.
        if (noCi) {
          console.error(
            `no checks on #${pr}; --no-ci given, treating as settled`,
          );
        } else {
          if (noChecksSince === null) noChecksSince = Date.now();
          if (Date.now() - noChecksSince < NO_CHECKS_GRACE * 1000) {
            console.error(
              `no checks yet on #${pr}; waiting ${NO_CHECKS_GRACE}s for the suite to appear`,
            );
            if (!(await waitOrGiveUp())) return 4;
            continue;
          }
          console.error(
            `no checks on #${pr} after ${NO_CHECKS_GRACE}s — assuming no CI (pass --no-ci to skip this wait)`,
          );
        }
        break;

      case "missing-required":
        queryErrors = 0;
        noChecksSince = null;
        console.error(
          `required reviewer coverage is incomplete on #${pr}; waiting for: ${missingRequired.join(", ")}`,
        );
        if (!(await waitOrGiveUp())) return 4;
        continue;

      case "no-reviewer":
        queryErrors = 0;
        // Checks plainly EXIST here (unlike `none`), so this is not the state
        // --no-ci asserts ("this PR genuinely has no checks") — there is no
        // escape hatch. Keep waiting for a reviewer-shaped check to appear,
        // same as `pending`; a stale no-checks timer from an earlier
        // truly-empty read is moot once checks exist at all.
        noChecksSince = null;
        console.error(
          `checks exist on #${pr} but no reviewer-shaped check has been observed yet; waiting`,
        );
        if (!(await waitOrGiveUp())) return 4;
        continue;

      case "mismatch":
        // `fail` throws, so the break is unreachable — it stands because the
        // linter cannot see `never` through the call and reads this as a
        // fall-through into 'failed'.
        fail(
          2,
          `--job-pattern '${jobPatternRaw}' matched none of this PR's checks.`,
          "Refusing to treat that as settled — fix the pattern, or omit it.",
        );
        break;

      case "failed":
        fail(
          7,
          `a matching check FAILED on #${pr} — it may never have posted its findings,`,
          "so a zero thread count here would not mean the round was clean.",
        );
        break;

      case "settled":
        queryErrors = 0;
        noChecksSince = null;
        break;
    }

    const count = await unresolvedCount();
    if (count > 0) {
      await bumpRounds();
      console.error(`round ready: ${count} unresolved thread(s) on #${pr}`);
      return 0;
    }

    // Zero threads is not zero findings (see the header). Probe
    // the `/drive-pr` sibling BEFORE computing or enforcing any budget: the
    // documented standalone case (`rootProbe.present === false`) needs no
    // subprocess at all, so charging it against the remaining budget could
    // refuse a call that was about to return for free.
    const rootProbe = probeDriveRoot();

    // Only a caller that declared its own external budget via
    // `--once-budget-sec`, AND is actually running in `--once` mode
    // (an external status board is both — a bare `--once-budget-sec` with
    // no `--once` has no external deadline to bound, since a polling loop's
    // elapsed time since process start is meaningless against it), is
    // subject to the remaining-budget check below. See
    // SUMMARY_DEFAULT_TIMEOUT_SEC's doc comment above for why an ordinary
    // `--once` caller with no declared budget must not be refused as if it had
    // one.
    //
    // A floor on the timeout (e.g. "never grant less than 10s") would still
    // let the SUM of elapsed-so-far plus the granted call exceed the
    // caller's declared deadline — the exact bug this section exists to
    // close. So when too little of the
    // declared budget remains to attempt the call at all, refuse without
    // spawning it: a call that would be killed by the external deadline
    // anyway is worse than an honest refusal, since the external kill loses
    // the `error` classification below entirely.
    let summaryTimeoutSec = SUMMARY_DEFAULT_TIMEOUT_SEC;
    if (once && onceBudgetSec !== null && rootProbe.present) {
      const remainingSec =
        onceBudgetSec -
        SUMMARY_ONCE_MARGIN_SEC -
        Math.floor((Date.now() - mainStartedAt) / 1000);
      if (remainingSec < SUMMARY_ONCE_MIN_TIMEOUT_SEC) {
        fail(
          1,
          `0 unresolved thread(s) on #${pr}, but too little of the declared --once-budget-sec (${onceBudgetSec}s) remains (${remainingSec}s left) to safely check /drive-pr's summary-findings.ts — refusing to report converged`,
        );
      }
      summaryTimeoutSec = remainingSec;
    }
    const so = await summaryOnlyFindings(pr, summaryTimeoutSec, rootProbe);
    if (so.kind === "error") {
      fail(
        1,
        `0 unresolved thread(s) on #${pr}, but /drive-pr's summary-findings.ts could not be read — cannot confirm no summary-only finding is outstanding; refusing to report converged`,
      );
    }
    if (so.kind === "ok" && so.unaddressed.length > 0) {
      console.error(
        `summary-only findings outstanding: 0 unresolved thread(s) on #${pr}, but ${so.unaddressed.length} finding(s) live only in the reviewer's summary comment (${so.unaddressed.join(", ")}).`,
      );
      console.error(
        `  A thread-driven pass cannot see them. Answer them with /drive-pr (answer-summary-finding.ts), fix and push, or hand them to a human.`,
      );
      return 8;
    }
    if (so.kind === "absent") {
      console.error(
        `note: no drive-pr skill was found for this repository, so summary-only findings on #${pr} were not checked (the standalone-install residual)`,
      );
    }

    console.error(
      `converged: 0 unresolved thread(s) on #${pr}, checks settled`,
    );
    await reportRoundsAndReset();
    return 3;
  }
}

if (import.meta.main) runMain("await-round", main);
