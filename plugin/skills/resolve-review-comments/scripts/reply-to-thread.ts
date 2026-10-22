#!/usr/bin/env bun
import {
  hasLeaveOpenMarker,
  hasNoOutcomeMarker,
  LEAVE_OPEN_MARKER,
  LEAVE_OPEN_MARKER_PRODUCER_ENV,
  NO_OUTCOME_MARKER,
} from "../../../shared/reply-markers.ts";
import { siblingSkill } from "../../../shared/consumer.ts";
/**
 * Reply IN-THREAD on a review thread, keyed off its GraphQL node id — the SAME
 * id that drives resolve-thread.ts (one id for both actions, per
 * `/jig:resolve-review-comments` § Human threads). Uses addPullRequestReviewThreadReply so the reply
 * always lands inside the thread, never as a detached top-level comment, so
 * the fix/reject rationale stays attached to the finding. Prints the new
 * comment url.
 *
 * Usage: bun reply-to-thread.ts <THREAD_NODE_ID> [--no-outcome] --body-file reply.md
 * Programmatic callers may supply the body on standard input instead.
 * File and standard-input bodies are read verbatim; the text never becomes
 * shell source. Outcome validation and the mutation fences apply equally.
 *
 * On Windows, invoke through the runtime (`bun reply-to-thread.ts …`) — a
 * shebang only carries the POSIX direct-execution path.
 */

import { existsSync, lstatSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, readStdinAll, runMain } from "../../../shared/cli.ts";
import { ghCall, run } from "../../../shared/proc.ts";
import { assertThreadPrOpen } from "./lib/thread-liveness.ts";

const OUTCOME_HELP = `reply-to-thread.ts: body must begin with an outcome token.

  **accepted**  the finding is real and you fixed it
  **rejected**  the finding is wrong, already handled, or intended
  **wont-fix**  valid but deliberately declined (triage rubric); no follow-up
  **deferred**  real and obligatory but out of scope; a follow-up issue is filed
  **moot**      no longer applies; the anchored code is gone

Write it as the FIRST token of the first line, bold and lowercase, followed by
whitespace and a concrete reason, e.g.

  **accepted** — added the missing guard; not yet pushed.

The reason is required: a bare token classifies the thread while explaining
nothing, and \`**accepted**oops\` has no token boundary at all. Both would enter
the harvested dataset as a sample with nothing behind it.

These replies are harvested to score the review bot, so the token is a
machine-read contract rather than a formatting habit. For a reply that is
genuinely not an outcome (a clarifying question), pass --no-outcome.`;

/**
 * Enforce the outcome vocabulary at the chokepoint. Every reply must open with
 * exactly one of the bold, lowercase outcome tokens, because replies are
 * HARVESTED to score the review bot: accepted findings are hits, rejected ones
 * candidate false positives, wont-fix ones true positives declined on
 * materiality — and those ratios drive reviewer tuning. A reply whose outcome
 * has to be inferred from prose is dropped from the sample or — worse —
 * misclassified, which teaches the reviewer the wrong lesson.
 *
 * Checked here rather than left to the skill prose because every reply passes
 * through this script, and a convention that is merely documented drifts the
 * moment someone is in a hurry.
 *
 * The whole first-line SHAPE is validated, not just the prefix. A prefix-only
 * check accepts `**accepted**` (a verdict with no rationale) and
 * `**accepted**oops` (no token boundary, so a parser reads the token as
 * `accepted**oops`). Both would enter the harvested dataset as a classified
 * sample with nothing behind it, which is worse than an unclassified one.
 * Subsequent body lines are free form; only the first line is constrained.
 *
 * The bash original spent ~80 lines fighting locale-dependent bracket
 * expressions and multibyte segmentation here. JS strings are UTF-16 with no
 * locale in sight, so the same rules are literal: token, then ASCII space/tab
 * boundary (`[ \t]` — deliberately NOT `\s`, which matches Unicode spaces
 * like U+2003 that the token boundary must not accept), then a reason
 * containing at least one ASCII letter or digit (so a bare em dash is not a
 * reason).
 */
export function validateOutcomeBody(body: string): boolean {
  // A terminal `\r` is a line TERMINATOR, not content. A reply read from a
  // CRLF-encoded file — routine on Windows, which this script now runs on —
  // leaves one at the end of firstLine, and `.` does not match it, so an
  // otherwise valid reply failed validation and exited 2 before posting
  //. Stripped here only; the body
  // sent to GitHub is untouched, which renders identically either way.
  const firstLine = (body.split("\n", 1)[0] ?? "").replace(/\r$/, "");
  const m = firstLine.match(
    /^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\*([ \t]+)(.*)$/,
  );
  if (!m) return false;
  return /[A-Za-z0-9]/.test(m[3] ?? "");
}

/**
 * `drive-pr`'s read-only lease fence, addressed the way `current-round.ts`
 * addresses `drive-state.ts`: by path, spawned as a CLI, never imported.
 *
 * The import direction is the reason. `/drive-pr` depends on THIS skill (its
 * loop spawns `list-unresolved-threads.ts` and this script), so importing its
 * lease module here would close a cycle and make a standalone
 * `/resolve-review-comments` install unusable without its sibling. The spawn
 * has neither property: the file is either there or it is not, and its absence
 * is the ordinary answer for anyone who installed this skill alone.
 */
const DRIVE_PR_ROOT = siblingSkill("drive-pr", import.meta.dirname);
const DRIVE_PR_SCRIPTS = join(DRIVE_PR_ROOT, "scripts");
const ASSERT_POST_ALLOWED = join(DRIVE_PR_SCRIPTS, "assert-post-allowed.ts");
/** The `skills/` directory both this skill and `/drive-pr` live under. */
const SKILLS_ROOT = dirname(DRIVE_PR_ROOT);

/**
 * Is the directory `/drive-pr` would sit in still there, and still a directory?
 *
 * An ENOENT on `<skills>/drive-pr` says "this path does not resolve". It does
 * NOT say WHICH component failed to resolve, and the two answers are different
 * facts: the root alone being absent is the standalone install, while an
 * ANCESTOR having been removed or renamed is a damaged tree that says nothing
 * about whether a drive exists. Reachable for the same reason ENOTDIR is: this
 * process is already loaded, so the tree it loaded from can change underneath
 * it — the mid-run mutation this whole page is about. The ENOTDIR fix closed
 * the prefix-is-a-file half and left the prefix-is-GONE half open, because
 * ENOENT covers both.
 *
 * So the skip needs both halves stated separately: the parent intact AND the
 * child absent. `stat`, not `lstat` — a `skills/` reached through a symlink to
 * a real directory is an ordinary layout, and this asks whether the directory
 * is there, not how it is named. Any error, and anything that is not a
 * directory, answers false: this feeds a fail-closed decision, so an
 * unreadable answer must never read as an intact parent.
 *
 * Exported so the decision is covered directly against real temp paths (real
 * directory, removed, file-instead-of-directory, symlink-to-directory, dangling
 * symlink) rather than argued about in a comment.
 *
 * Those predicate probes are NOT the whole harness. A first cut claimed the
 * integration path "cannot be fixtured — a test cannot both host the running
 * script under `<skills>` and present that same `<skills>` to it as missing",
 * and used that to justify covering the predicate alone. The claim was false
 * and the gap it excused was exactly the one that matters: deleting the
 * `if (!skillsParentIsIntact())` branch below left every predicate probe green
 * while restoring the fail-open. The fixture the claim said was impossible is
 * straightforward — `main()` reads stdin BEFORE calling `assertPostAllowed`, so
 * a child spawned with an open stdin pipe parks with every module loaded and
 * the fence not yet run, and the skills root can simply be deleted in that
 * window. It is the real mid-run mutation rather than a simulation of one, and
 * it is now pinned by `fails CLOSED when the SKILLS PARENT disappears mid-run`.
 */
export function skillsParentIsIntact(parent = SKILLS_ROOT): boolean {
  try {
    return statSync(parent).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refuse to post when this session's drive lease has been taken over.
 *
 * A reply is IRREVERSIBLE. Every drive-STATE mutation is fenced behind
 * the lease, but this script met that fence only afterwards, when the caller
 * recorded the outcome via `drive-state.ts hold` — so a pass whose driver had
 * died, and whose lease a replacement driver had already taken over, still got
 * its `**accepted**` onto the thread first. Two such replies on one thread are
 * not repairable and corrupt the reviewer-scoring sample the outcome
 * vocabulary feeds.
 *
 * ABSENCE of a lease is not a refusal — that is the standalone path this skill
 * has to keep working, and the fence itself makes that call (it exits 0 when
 * there is no git dir for drive state to live in, no lease file, a lease that
 * is this session's own, or a foreign one whose owner is gone). Only a lease
 * held by another LIVE session refuses.
 *
 * That the fence is OPTIONAL — so post safety varies with what is installed —
 * is a decided design point, not an oversight awaiting one. It is
 * sound because `/drive-pr` is the only thing that WRITES a lease, because this
 * depends on its executable rather than on its file format (so its absence is
 * exactly a filesystem question, with no second policy to choose between), and
 * because a checkout with no `/drive-pr` AND NO DRIVE RUNNING IN IT reaches
 * no state the fence would have refused: with no `--pr` and no
 * `$DRIVE_PR_TARGET` — which only `drive.ts` exports — the fence checks this
 * working tree's own leases, and a tree that never ran a drive holds none.
 *
 * That second clause is checked rather than assumed, because the directory
 * going away does not stop a drive already running over it:
 * `assertNoDriveContext` below refuses whenever `$DRIVE_PR_TARGET` is set. What
 * neither clause can see — a process carrying no drive context at all, beside a
 * lease that outlived the directory — is the residual, stated and bounded in
 * `post-fence.md` rather than closed. Vendoring `/drive-pr`'s lease reader here, and
 * declaring the integration in a shared manifest, were both weighed and lose;
 * the pre-GA rule against dual-path tolerance is about one repository's data
 * shapes over time, not two live installations at once. The record, with the
 * residual and what would reverse it, is `/drive-pr`'s
 * `references/post-fence.md` — read it before re-raising this.
 *
 * The only skip: `/drive-pr` IS NOT INSTALLED — its whole skill directory is
 * absent AND this process carries no drive context (`assertNoDriveContext`).
 * Established BEFORE the spawn, never from its exit code, because the
 * executable is `process.execPath`, which always exists: a missing entrypoint
 * surfaces as the runtime's own ordinary failure and is indistinguishable from
 * a fence that ran and refused (`current-round.ts` hit exactly this).
 *
 * The skip is keyed on the SKILL ROOT (`/drive-pr`), not on `scripts/` and not
 * on this one file, and each narrowing closed a real gap. Keyed on the file
 * (the original shape), any `/drive-pr` that is present but incomplete or
 * stale — the fence script deleted, a partial checkout, a half-finished
 * upgrade — silently reverted to unfenced posting. Keyed on `scripts/` (the
 * fix for that), the SAME class of gap reopens one directory up: a checkout
 * that stopped between creating `/drive-pr` and populating `scripts/` — or any
 * other state where the root exists but `scripts/` does not — reads identically
 * to "the skill was never installed", so it skipped too. A missing `scripts/`
 * under a present root is exactly the "installed but broken" case the previous
 * fix was written to catch, just one level shallower than where it was looking.
 * Only a confirmed-absent ROOT is the standalone `/resolve-review-comments`
 * case; a confirmed-absent `scripts/` under a present root, and everything
 * below that (this file, `assert-post-allowed.ts` itself), refuses.
 *
 * Deliberately NOT also skipped when the environment names no session. That
 * looked like a free optimisation — the fence answers "allowed" for a runtime
 * it cannot identify, so why spawn — and it is wrong in the direction that
 * matters: a session with no identity provably holds no lease, so a live lease
 * it finds is definitionally another session's, and skipping would exempt
 * exactly the harnesses that cannot be told apart from a second driver in the
 * same tree. See `resolveFenceContext`'s note on tier 3.
 *
 * Anything non-zero fails CLOSED, including a timeout: a fence that could not
 * read its input has verified nothing, and this one guards a mutation with no
 * undo (an unreadable input is a refusal, never a pass). Its stderr is
 * inherited, so the refusal a human has to act on — the holder's pid, the
 * liveness check, the `clear-lease` recovery — arrives verbatim rather than
 * summarised.
 */
/**
 * Refuse the standalone-install skip when THIS PROCESS is carrying drive
 * context.
 *
 * The skip's argument is that a checkout with no `/drive-pr` cannot reach a
 * state the fence would have refused, because no drive can START there. True,
 * and not the same claim: a drive already RUNNING does not disappear when the
 * directory does. `drive.ts` starts while `/drive-pr` is installed, exports
 * `$DRIVE_PR_TARGET` / `$DRIVE_PR_SESSION` into every pass it spawns, and a
 * checkout, base merge, or sync that removes the skill mid-drive leaves that
 * pass alive with the root gone. Its `lstat` then reports a clean ENOENT and
 * the pass posts unfenced — holding exactly the PR-wide context (`--pr`
 * defaults to `$DRIVE_PR_TARGET` in `assert-post-allowed.ts`) that would have
 * swept every worktree's leases and refused: the unfenced post, reinstated
 * by a `git checkout`.
 *
 * So the skip is keyed on the absence of a drive, not on the absence of a
 * directory, and `$DRIVE_PR_TARGET` is what tells the two apart: `drive.ts`
 * sets it and nothing else does, so carrying one in a root-absent tree is
 * self-contradictory in exactly the unsound direction.
 *
 * `$DRIVE_PR_SESSION` is deliberately NOT also consulted, though `drive.ts`
 * exports it too. It is additionally documented as a hand-set opt-in, for
 * harnesses the session ladder cannot identify (`SKILL.md` § 6), so a genuine
 * standalone `/resolve-review-comments` install may legitimately carry one with
 * no drive anywhere — refusing on it would deny exactly the posts the skip
 * exists to allow, and would redden this file's own standalone-install test for
 * a reason unrelated to any drive.
 *
 * Refusing rather than fencing is the only sound answer available: the fence
 * this process would spawn is precisely what is missing, so it has verified
 * nothing, and this guards a mutation with no undo.
 *
 * The residual is narrower and stated in `/drive-pr`'s `references/post-fence.md`:
 * a session carrying NO drive context, in a tree whose root went absent while a
 * foreign live lease against that same tree survives, still skips. Closing that
 * needs a lease read, which is the vendoring that page rejects on its merits.
 */
function assertNoDriveContext(): void {
  if ((process.env.DRIVE_PR_TARGET ?? "") === "") return;
  fail(
    1,
    "reply-to-thread: /drive-pr is not installed here, but this process is running",
    "inside a drive ($DRIVE_PR_TARGET is set):",
    `  ${DRIVE_PR_ROOT}`,
    "",
    "Refusing to post. That variable is exported by /drive-pr's own drive.ts and",
    "nothing else, so a drive is live against a checkout that no longer carries",
    "the skill — the one root-absent state that is NOT the standalone install.",
    "The lease fence that would answer for it is the file that is missing, so",
    "skipping it here would reinstate the unfenced POST the fence prevents.",
    "",
    "Restore /drive-pr in this working tree, or stop the drive before posting.",
  );
}

async function assertPostAllowed(): Promise<void> {
  // `lstat`, not `existsSync`: the latter reports `false` for confirmed
  // absence AND for every indeterminate failure alike — a broken symlink at
  // this exact path, an ancestor that became unsearchable — so it cannot tell
  // "standalone install" from "a /drive-pr this process merely could not see"
  // (the same fail-open class `readLeaseForFence` and `repositoryIsInPlay`
  // both had). Only a positively-confirmed ENOENT may skip the fence;
  // anything else refuses.
  //
  // ENOENT ONLY — not ENOTDIR, which used to skip alongside it. The two are
  // not the same answer. ENOENT is "this path does not exist", which is the
  // standalone install. ENOTDIR is "a component of the path PREFIX is not a
  // directory" — measured, not assumed: `lstat` of `<file>/child` gives ENOTDIR
  // while `<missing>/child` gives ENOENT. Here the only prefix is the `skills/`
  // directory this very script is loaded from, so ENOTDIR means that directory
  // has become a non-directory underneath a running process. That is a corrupt
  // tree, and it is precisely the installed-but-broken case the paragraph below
  // refuses — a standalone consumer repo produces ENOENT, never this. Granting
  // it the skip gave the fail-open to exactly one population: trees too damaged
  // to reason about.
  //
  // It is a narrow state — the prefix must be replaced mid-run, since a
  // non-directory there would have stopped this module loading — but "narrow"
  // is the same argument the root-absent skip made about a drive outliving its
  // directory, and that one turned out to be an ordinary `git checkout`. A
  // guard over a mutation with no undo does not get to assume the tree holds
  // still. No test pins the ENOTDIR shape specifically — a fixture cannot
  // present a non-directory prefix to a script it is simultaneously hosting —
  // so its coverage is the error semantics measured above plus failing closed.
  // Do NOT read that as "this whole branch is untestable": the sibling
  // parent-REMOVED shape is pinned end to end by
  // `fails CLOSED when the SKILLS PARENT disappears mid-run`, which was written
  // after this same "unfixturable" claim turned out to be excusing a real gap.
  //
  // ENOENT is then split in TWO, which the ENOTDIR fix alone did not do and
  // needed to. "This path does
  // not resolve" is not "the root alone is absent": an ancestor REMOVED or
  // renamed after this process loaded returns ENOENT just as a genuinely
  // missing `/drive-pr` does, and that is a damaged tree telling us nothing
  // about whether a drive exists. The ENOTDIR fix closed the prefix-is-a-FILE
  // half and left the prefix-is-GONE half wide open through the very code
  // path it had just narrowed. `skillsParentIsIntact` supplies the missing
  // half, so the skip now requires the parent present AND the child absent.
  //
  // Probed at the ROOT, not at `scripts/`: a root that is confirmed absent is
  // the only state that is actually "no /drive-pr here", so it is the only
  // one that may skip. A root that exists makes this an installed-but-broken
  // question, not a standalone-install question, so from here on everything
  // — a missing `scripts/`, a missing `assert-post-allowed.ts`, an unreadable
  // path — refuses rather than skips.
  try {
    lstatSync(DRIVE_PR_ROOT);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      if (!skillsParentIsIntact()) {
        fail(
          1,
          "reply-to-thread: /drive-pr does not resolve here, and neither does the",
          "directory it would sit in:",
          `  ${SKILLS_ROOT}`,
          "",
          "Refusing to post. ENOENT on the root says the path does not resolve, not",
          "WHICH component of it failed — and a skills/ directory that has been",
          "removed or renamed underneath this already-loaded process is a damaged",
          "tree, not the standalone install. It is no evidence that no drive exists,",
          "so skipping the fence here would be the unfenced POST the fence prevents.",
          "",
          "Restore the checkout, or re-run once the tree has settled.",
        );
      }
      assertNoDriveContext();
      return;
    }
    fail(
      1,
      `reply-to-thread: could not tell whether /drive-pr is installed here (${code ?? String(e)}):`,
      `  ${DRIVE_PR_ROOT}`,
      "",
      "Refusing to post. An indeterminate look at this path is not evidence this",
      "is the standalone install — it could be a real /drive-pr this process",
      "merely could not see, and posting unfenced would be the exact behaviour",
      "the fence prevents.",
    );
  }
  if (!existsSync(DRIVE_PR_SCRIPTS)) {
    fail(
      1,
      `reply-to-thread: /drive-pr's skill directory is present but its scripts are missing:`,
      `  ${DRIVE_PR_SCRIPTS}`,
      "",
      "Refusing to post. This is not the standalone-install case — the skill root",
      "exists, so a checkout that stopped mid-way (or a half-finished upgrade)",
      "is at least as likely as a deliberate standalone install, and posting",
      "unfenced would be the exact behaviour the fence prevents.",
      "",
      "Restore /drive-pr fully, or remove it entirely if you mean to run without",
      "the fence.",
    );
  }
  if (!existsSync(ASSERT_POST_ALLOWED)) {
    fail(
      1,
      `reply-to-thread: /drive-pr is installed here but its lease fence is missing:`,
      `  ${ASSERT_POST_ALLOWED}`,
      "",
      "Refusing to post. A drive may be running in this working tree, and the one",
      "check that would say so is not there — so posting would be the unfenced",
      "behaviour the fence prevents, reinstated silently by a broken install.",
      "",
      "Restore the file, or remove the /drive-pr skill entirely if you mean to run",
      "without the fence.",
    );
  }
  const r = await run(
    [
      process.execPath,
      ASSERT_POST_ALLOWED,
      "--what",
      "reply-to-thread.ts (drive lease)",
    ],
    // Comfortably ABOVE the fence's own inner deadlines — it makes up to two
    // `git` calls, each bounded by `$GIT_CALL_TIMEOUT` (30s default), so a
    // tighter bound here would fire first and replace the fence's specific
    // "git could not say where drive state lives" with this script's vaguer
    // one. Both refuse; only one tells the reader what stalled.
    { timeoutSec: 120, stderr: "inherit" },
  );
  if (r.code === 0) return;
  if (r.timedOut) {
    fail(
      1,
      "reply-to-thread: the drive-lease fence timed out, so whether another session has taken this tree's drive lease is unknown.",
      "Refusing to post rather than assume: a reply cannot be withdrawn once it",
      "is on the thread.",
    );
  }
  // The fence's own exit code, propagated rather than remapped, so `11` still
  // means "another live session holds the lease" everywhere it is read.
  fail(r.code, "reply-to-thread: refusing to post — see the fence above.");
}

interface ReplyOptions {
  requireOutcome: boolean;
  bodyFile?: string;
}

const REPLY_USAGE =
  "usage: reply-to-thread.ts <thread-node-id> [--no-outcome] [--body-file <path>] (body must come from stdin or a file)";

function replyTarget(argv: string[]): string {
  const threadId = argv[0] ?? "";
  if (threadId === "")
    fail(2, "usage: reply-to-thread.ts <thread-node-id> [--body-file <path>]");
  return threadId;
}

function bodyFilePath(path: string | undefined): string {
  if (!path || path.startsWith("--")) fail(2, "--body-file requires a path");
  return path;
}

function noOutcomeOption(options: ReplyOptions): void {
  if (!options.requireOutcome) fail(2, REPLY_USAGE);
  options.requireOutcome = false;
}

function bodyFileOption(options: ReplyOptions, path: string | undefined): void {
  if (options.bodyFile !== undefined) fail(2, REPLY_USAGE);
  options.bodyFile = bodyFilePath(path);
}

function readReplyOption(
  argv: string[],
  index: number,
  options: ReplyOptions,
): number {
  switch (argv[index]) {
    case "--no-outcome":
      noOutcomeOption(options);
      return index;
    case "--body-file":
      bodyFileOption(options, argv[index + 1]);
      return index + 1;
    default:
      fail(2, REPLY_USAGE);
  }
}

function replyOptions(argv: string[]): ReplyOptions {
  const options: ReplyOptions = { requireOutcome: true };
  for (let index = 1; index < argv.length; index++)
    index = readReplyOption(argv, index, options);
  return options;
}

async function readReplyBody(options: ReplyOptions): Promise<string> {
  return options.bodyFile === undefined
    ? await readStdinAll()
    : readFileSync(options.bodyFile, "utf8");
}

function validateReplyBody(body: string, requireOutcome: boolean): void {
  if (body === "") {
    fail(
      2,
      "usage: reply-to-thread.ts <thread-node-id> [--no-outcome] [--body-file <path>] (body was empty)",
    );
  }

  // `--no-outcome` is the deliberate escape hatch for a reply that genuinely
  // is not an outcome — asking the reviewer a clarifying question, for
  // instance. It must be explicit, so a missing token is always a decision
  // and never a slip.
  if (requireOutcome && !validateOutcomeBody(body)) {
    fail(2, OUTCOME_HELP);
  }
}

function validateReplyMarkers(body: string): void {
  // Refuse a body already ending in LEAVE_OPEN_MARKER's trailing-line form
  // unless `triage-thread.ts` is the caller. Applies
  // regardless of `--no-outcome`: the marker's meaning is tied to
  // `--leave-open` semantics, so it is equally an accident on a
  // clarifying-question reply.
  if (
    hasLeaveOpenMarker(body) &&
    process.env[LEAVE_OPEN_MARKER_PRODUCER_ENV] !== "1"
  ) {
    fail(
      2,
      `reply-to-thread.ts: this body's own trailing line already matches LEAVE_OPEN_MARKER ('${LEAVE_OPEN_MARKER}') — refusing to post it.`,
      "Remove that trailing line, or use triage-thread.ts --leave-open instead — the only",
      "sanctioned producer of a reply carrying that marker.",
    );
  }

  // Same accident-class protection, unconditional: this script is the SOLE
  // producer of NO_OUTCOME_MARKER (appended below, never supplied by a
  // caller), so a body already ending in it has nothing legitimate to mean.
  if (hasNoOutcomeMarker(body)) {
    fail(
      2,
      `reply-to-thread.ts: this body's own trailing line already matches NO_OUTCOME_MARKER ('${NO_OUTCOME_MARKER}') — refusing to post it.`,
      "Remove that trailing line — this script appends it itself when --no-outcome is passed.",
    );
  }
}

async function postReply(threadId: string, postBody: string): Promise<number> {
  // The request document is built as JSON and delivered on stdin
  // (`--input -`), never through `gh api -f`/`-F`: `-f body=@-` sends the
  // LITERAL string "@-" (the `@file`/`@-` magic is `-F`-only), and `-F`
  // applies JSON type coercion (a body that's exactly "true"/"null"/an
  // integer would silently become a non-string GraphQL variable).
  // JSON.stringify is the jq-free version of the same guarantee: the body is
  // always a JSON string, verbatim, never shell- or type-evaluated.
  // `--no-outcome` replies carry NO_OUTCOME_MARKER as their own trailing
  // line — the durable evidence `isLeftOpenThread` requires (see that
  // constant's own header, above).
  const request = JSON.stringify({
    query:
      "mutation($threadId:ID!, $body:String!){ addPullRequestReviewThreadReply(input:{ pullRequestReviewThreadId:$threadId, body:$body }){ comment{ url } } }",
    variables: { threadId, body: postBody },
  });

  // The liveness read is a network round trip, so it runs BEFORE the lease
  // fence: a fence checked first could go stale while the read is pending (a
  // replacement driver takes the lease), and the superseded session would still
  // post the duplicate reply the fence exists to prevent. The fence is
  // therefore the last check before the irreversible POST. The liveness guard
  // applies to standalone and harness callers alike.
  await assertThreadPrOpen("reply-to-thread", threadId);
  await assertPostAllowed();
  const r = await ghCall(
    [
      "api",
      "graphql",
      "--input",
      "-",
      "-q",
      ".data.addPullRequestReviewThreadReply.comment.url",
    ],
    { stdin: request, stderr: "inherit" },
  );
  if (r.timedOut) {
    fail(
      1,
      "reply-to-thread: gh api graphql killed by the GH_CALL_TIMEOUT deadline",
    );
  }
  if (r.code !== 0) return r.code;
  process.stdout.write(r.stdout);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const threadId = replyTarget(argv);
  const options = replyOptions(argv);
  const body = await readReplyBody(options);
  validateReplyBody(body, options.requireOutcome);
  validateReplyMarkers(body);
  return postReply(
    threadId,
    options.requireOutcome ? body : `${body}\n\n${NO_OUTCOME_MARKER}`,
  );
}

// Guarded so the test suite can import validateOutcomeBody without spawning
// the CLI.
if (import.meta.main) runMain("reply-to-thread", main);
