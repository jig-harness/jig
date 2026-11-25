#!/usr/bin/env bun
/**
 * Answer a summary-only finding — one the reviewer could not anchor to a diff
 * line, so it has no thread to reply in and no thread to resolve.
 *
 * The answer is a top-level PR comment that still opens with an outcome token,
 * because replies are harvested to score the reviewer and a finding answered
 * outside that vocabulary is dropped from the sample. It also carries a
 * `drive-pr-addressed` marker per finding, which is what `summary-findings.ts`
 * reads to decide the finding is answered — so convergence stops being blocked
 * by it. Prose is never parsed for either purpose.
 *
 * The outcome arrives as a FLAG, not as the first token of the body, and the
 * body is composed here. reply-to-thread.ts has to parse its token out of free
 * text (its callers write the whole reply), and that parser has been through
 * three rounds of locale bugs. Nothing here needs to re-derive it: a check
 * over the closed vocabulary is exact, and there is no second implementation
 * to drift.
 *
 * Usage:
 *   answer-summary-finding.ts --outcome accepted --fingerprint abc123 [PR] <<'EOF'
 *   the concrete reason, verbatim — no shell expansion
 *   EOF
 *
 *   --batch        Read [{fingerprint,outcome,reason}] on stdin for a held round.
 *   --outcome      REQUIRED for a manual reply. accepted | rejected | wont-fix | deferred | moot
 *   --fingerprint  REQUIRED, repeatable. From `summary-findings.ts`. Several
 *                  findings sharing one decision answer in a single comment
 *                  rather than one comment each.
 *   --pushed-sha   REQUIRED for the FIX-DEPENDENT outcomes — `accepted` and
 *                  `moot`. Must be the PR's live head AND this worktree's
 *                  HEAD, with a clean tree — see below.
 *
 * `accepted` and `moot` are held exactly like an accepted THREAD is. The
 * marker this posts is what `summary-findings.ts` reads as proof the finding
 * is answered, so posting it before the fix lands means a failed gate, a
 * rejected push, or an abandoned worktree leaves proof of a fix that never
 * reached the PR — and the next status check converges over it. Threads get
 * that protection from the resolve-after-push ordering; a summary finding has
 * no thread to hold, so the ordering is enforced here instead: --pushed-sha
 * must equal the PR's current head AND this worktree's HEAD, with nothing
 * uncommitted. The API check alone is satisfied before any push at all —
 * local HEAD already equals the API head then — so it proves the SHA is the
 * head without proving the fix is in it.
 *
 * `moot` is in that set because of what it MEANS: the code the finding
 * describes is gone, and what removed it is almost always this drive's own
 * edit. A later round that reintroduces the code reintroduces the finding
 * verbatim, under the same content fingerprint — so a durable moot marker
 * would suppress the live occurrence forever. A moot that predates this round
 * costs nothing to stamp: HEAD already is the PR head, so the flag is
 * satisfied immediately.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT TRY TO PROVE, and why:
 *
 * A fix applied ONLY to the PR description (`gh pr edit`) produces no commit,
 * so `--pushed-sha "$(git rev-parse HEAD)"` is satisfied whether or not that
 * edit ran, reached the right PR, or changed the right text. An earlier
 * revision of this script tried to close that with `--held-at-sha`: the local
 * HEAD captured at triage, with `--pushed-sha` required to be a STRICT
 * descendant of it, on the theory that a real fix always produces a commit and
 * a description edit never does. It is removed, because it could not hold what
 * it advertised, in each of the ways below at once:
 *
 *  - It proved a commit landed in the ROUND, never that the commit was this
 *    finding's. Two findings held in one round share a `heldAtSha`, so a code
 *    fix for one satisfied the check for the other, description-only or not.
 *  - Its necessary escape hatch was forgeable. A marker already standing at
 *    the SHA was read as "an earlier commit-backed answer landed here", but
 *    `findExactMarkers` accepts any comment from a trusted association
 *    carrying the grammar, and markers posted before the gate existed satisfy
 *    it too — so the induction "the first marker could only have come through
 *    this gate" was simply false.
 *  - It refused a legitimate answer. A first-time `moot` whose removal
 *    predates the hold needs no commit by definition, and neither does a
 *    re-answer renewing a marker over a fix that landed rounds ago — both
 *    deadlock unless the driver manufactures an unrelated commit.
 *
 * The tie-break rule that settles those, and the one to apply if a future
 * round proposes reinstating some variant: NO LOCAL CHECK CAN BIND A COMMIT TO
 * A FINDING, so no local check can prove a fix is real — not for a description
 * edit and not for a code commit either, as the old gate's own doc conceded.
 * A proxy that cannot make that binding must not be presented as proof, and an
 * exemption keyed on a pre-existing artifact the gate itself did not emit is a
 * bypass rather than a compatibility measure.
 *
 * What limits a false answer WHILE THE DRIVE CONTINUES is the EXPIRY, not a
 * gate here: a fix-dependent marker stops being honoured once the reviewer's
 * own review passes the head it names (`collectAddressed` in
 * `summary-findings.ts`), so a wrong answer survives at most the one head of
 * the `at`-position grace — or `WINDDOWN_EXEMPTION_ROUNDS` for a
 * winddown-deferred backlog entry — and is then re-asked.
 *
 * That is a bound on intermediate rounds only, and deliberately not claimed as
 * more. At the head a drive CONVERGES on, no later
 * reviewer pass ever runs, so nothing expires the marker and the answer stands
 * on the driver's word. That residual is accepted rather than closed, because
 * it is not specific to a description-only fix: a code commit that does not
 * actually fix the finding reaches merge by the identical path, and the
 * removed gate never validated that either — by its own doc, it was "proof
 * positive of a commit, not proof the commit is the RIGHT one". Both are the
 * same unclosable claim, that the driver answered honestly.
 *
 * What carries the residual instead is disclosure, at the point a human acts:
 * `announce-merge-ready.ts` says in the announcement body that a fix-dependent
 * answer at the announced head rests on the driver's claim rather than on a
 * reviewer re-evaluation. The audit trail is the posted comment itself — an
 * outcome token, a reason, and a SHA, on the PR to read back.
 *
 * The reason comes from stdin — never as an argument. Reviewer-authored text
 * containing a backtick, `$(...)`, or `$VAR` gets shell-evaluated on the way
 * in otherwise, corrupting the audit trail before the API ever sees it.
 * Use a QUOTED heredoc (<<'EOF'), or pipe from `printf '%s'`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fail, isDigits, readStdinAll, runMain } from "./lib/cli.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  resolvePr,
  run,
  summaryAnswerReconcileTimeoutSeconds,
  tsArgv,
} from "./lib/proc.ts";
import {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs } from "./lib/state/lock.ts";
import { summaryAnswerProblem } from "./lib/summary-answer.ts";
import { FORGE_BODY_LIMIT } from "../../../shared/records/comment-limit.ts";

import {
  isOutcome,
  isFixDependentOutcome,
  type Outcome,
} from "./lib/outcome.ts";
import { SUMMARY_ANSWER_SEPARATOR } from "../../../shared/summary-answer-blocks.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface Answer {
  fingerprint: string;
  outcome: Outcome;
  reason: string;
}

function isAnswer(answer: unknown): answer is Answer {
  return (
    typeof answer === "object" &&
    answer !== null &&
    "fingerprint" in answer &&
    typeof answer.fingerprint === "string" &&
    "outcome" in answer &&
    isOutcome(answer.outcome) &&
    "reason" in answer &&
    typeof answer.reason === "string"
  );
}

function parseBatch(raw: string): Answer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail(2, `answer-summary-finding.ts: invalid batch JSON: ${error}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isAnswer)
  ) {
    fail(
      2,
      "answer-summary-finding.ts: --batch expects a non-empty array of { fingerprint, outcome, reason }",
    );
  }
  if (new Set(parsed.map((item) => item.fingerprint)).size !== parsed.length) {
    fail(2, "answer-summary-finding.ts: --batch expects distinct fingerprints");
  }
  return parsed;
}

function options() {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        batch: { type: "boolean", default: false },
        fingerprint: { type: "string", multiple: true, default: [] },
        outcome: { type: "string", default: "" },
        "pushed-sha": { type: "string", default: "" },
      },
    });
    return {
      batch: values.batch,
      fingerprints: values.fingerprint,
      outcome: values.outcome,
      pushedSha: values["pushed-sha"],
      requestedPr: positionals.at(-1) ?? "",
    };
  } catch (error) {
    return fail(2, `answer-summary-finding.ts: ${error}`);
  }
}

async function main(): Promise<number> {
  const { batch, fingerprints, outcome, pushedSha, requestedPr } = options();

  if (!batch && !isOutcome(outcome)) {
    fail(
      2,
      "answer-summary-finding.ts: --outcome must be one of the closed-vocabulary values.",
      "",
      "  accepted   the finding is real and you fixed it",
      "  rejected   the reviewer was WRONG — the code is right, or the behaviour is",
      '             intended. Not a polite decline, and not "already handled"',
      "  wont-fix   valid but deliberately declined (triage rubric); no follow-up filed",
      "  deferred   real and obligatory but out of scope; a follow-up issue is filed",
      "  moot       no longer applies — the code it describes is gone, ALREADY HANDLED",
      "             by another fix, or superseded by a later round",
      "",
      "Definitions are canonical in <skill-dir>/../resolve-review-comments/SKILL.md § 3;",
      "the gloss above is a reminder, not a second source. The `rejected` / `moot` line",
      "is the one worth restating, because this script's durability split rides on it:",
      "`rejected` claims something about the finding’s MERIT and its marker therefore",
      'holds on every later head, so filing an "already handled" decision there makes a',
      "head-scoped claim permanent — a revert or a later regression re-emits the",
      'identical finding and the stale marker suppresses it. "Already handled" is a',
      "`moot`, which is stamped with its SHA and expires. Collapsing the two also",
      "poisons the reviewer's own quality signal: a correct finding filed under",
      "`rejected` reads as a false positive it should learn from.",
      "",
      "These are harvested to score the reviewer, so the value is a machine-read",
      "contract rather than a label. There is no --no-outcome escape hatch here: a",
      "summary finding has no thread to hold a clarifying exchange, so an answer that",
      "is not an outcome would leave it blocking convergence forever.",
    );
  }

  if (!batch && fingerprints.length === 0) {
    fail(
      2,
      "answer-summary-finding.ts: at least one --fingerprint is required (from summary-findings.ts)",
    );
  }

  const raw = await readStdinAll();
  if (batch && (outcome !== "" || fingerprints.length > 0)) {
    fail(
      2,
      "answer-summary-finding.ts: --batch cannot be combined with --outcome or --fingerprint",
    );
  }
  const answers = batch
    ? parseBatch(raw)
    : fingerprints.map((fingerprint) => ({
        fingerprint,
        outcome: outcome as Outcome,
        reason: raw,
      }));

  for (const { fingerprint, reason } of answers) {
    const problem = summaryAnswerProblem(fingerprint, reason);
    if (problem !== undefined) fail(2, `answer-summary-finding.ts: ${problem}`);
  }

  const pr = await resolvePr(requestedPr);
  if (!isDigits(pr)) {
    fail(2, "answer-summary-finding.ts: could not resolve a PR number");
  }

  // Enforce the held-batch ordering for the fix-dependent outcomes. The
  // durable ones assert something about the finding's merit that no commit
  // changes, so nothing downstream can invalidate them and they may post
  // immediately.
  const fixDependentAnswer = answers.find((answer) =>
    isFixDependentOutcome(answer.outcome),
  );
  if (fixDependentAnswer !== undefined) {
    const { outcome } = fixDependentAnswer;
    if (pushedSha === "") {
      fail(
        2,
        `answer-summary-finding.ts: --outcome ${outcome} requires --pushed-sha <sha>.`,
        "",
        "`accepted` and `moot` both claim the finding is answered BY A CHANGE — one",
        "fixed the code, the other removed it. The marker this posts is what",
        "summary-findings.ts reads as proof, so posted before the change lands, a failed",
        "gate or rejected push leaves proof of work that never reached the PR and the",
        "next status check converges over it. Stamped with the SHA, the marker also stops",
        "counting once the reviewer has seen that head, so a later round that undoes the",
        "change re-surfaces the finding instead of inheriting a stale answer.",
        "",
        "Push first, then pass the SHA you pushed:",
        '  --pushed-sha "$(git rev-parse HEAD)"',
      );
    }
    const apiRes = await ghCall(
      ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
      { stderr: "ignore" },
    );
    if (apiRes.code !== 0 || apiRes.stdout.trim() === "") {
      fail(
        1,
        `answer-summary-finding.ts: cannot read PR #${pr}'s head — refusing to post a '${outcome}' marker on an unknown state`,
      );
    }
    const apiHead = apiRes.stdout.trim();
    if (apiHead !== pushedSha) {
      fail(
        2,
        `answer-summary-finding.ts: --pushed-sha ${pushedSha} is not PR #${pr}'s head (${apiHead}).`,
        "The change is not on the pull request yet, so the finding is not answered.",
        "If you have just pushed, the API lags a few seconds — wait for",
        "drive-status.ts to stop reporting HEAD_LAG, then retry.",
      );
    }

    // The API check alone proves the SHA is the PR's head — NOT that the fix
    // is in it. Before any push, local HEAD already equals the API head, so
    // the documented `--pushed-sha "$(git rev-parse HEAD)"` satisfies it
    // while the fix is still an uncommitted edit, and the marker becomes
    // permanent proof of work that never happened. The conditions below close
    // that, and each is about the WORKING TREE, which is the thing the API
    // cannot see:
    //
    //   local HEAD == the SHA   the caller is answering for this checkout,
    //                           not quoting a SHA read off the PR page
    //   clean tree              nothing is still uncommitted
    //
    // "Clean" INCLUDES untracked files, deliberately: a brand-new file is the
    // most common shape of a fix that is not in the commit, and excluding it
    // would let exactly that case through. The cost is a stray scratch file
    // blocking the answer — which prints the offending paths and is fixed in
    // one command, against a permanent marker for a fix that never landed.
    //
    // Together with the API check they mean: everything in this worktree is
    // committed, and that commit IS the PR's head. Which is what "the fix
    // landed" means. A read that fails answers "cannot confirm", never
    // "fine".
    const localRes = await git(["rev-parse", "HEAD"], {
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
    });
    if (localRes.code !== 0) {
      fail(
        1,
        `answer-summary-finding.ts: cannot read local HEAD (${localRes.timedOut ? "deadline exceeded" : localRes.stderr.trim() || `exit ${localRes.code}`}) — refusing to post a '${outcome}' marker`,
        "without confirming the change is committed here.",
      );
    }
    const localHead = localRes.stdout.trim();
    if (localHead !== pushedSha) {
      fail(
        2,
        `answer-summary-finding.ts: --pushed-sha ${pushedSha} is not this worktree's HEAD (${localHead}).`,
        "Answer for the commit you actually made, not a SHA read off the PR.",
      );
    }
    const dirtyRes = await git(["status", "--porcelain"], {
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
    });
    if (dirtyRes.code !== 0) {
      fail(
        1,
        `answer-summary-finding.ts: cannot read the working tree (${dirtyRes.timedOut ? "deadline exceeded" : dirtyRes.stderr.trim() || `exit ${dirtyRes.code}`}) — refusing to post a '${outcome}' marker`,
        "without confirming the change is committed.",
      );
    }
    if (dirtyRes.stdout !== "") {
      console.error(
        "answer-summary-finding.ts: the working tree is dirty, so the change is not fully committed:",
      );
      process.stderr.write(dirtyRes.stdout);
      fail(2, "Commit and push it, then answer for the SHA it landed on.");
    }

    // `--pushed-sha` being the clean, live head proves this checkout has not
    // touched a file since the finding was held — it does NOT prove a COMMIT
    // happened, and nothing here tries to. See the module doc's "what this
    // script deliberately does not try to prove": the check that attempted it
    // could not bind a commit to a finding, so it neither caught a
    // description-only answer in a multi-finding round nor allowed a
    // no-commit-needed `moot`. The expiry in `summary-findings.ts` is what
    // bounds a false answer.
  }

  // Exact marker lookup makes the POST recoverable if the process stops
  // after delivery and before releasing its held claims. Match fix-dependent
  // markers only on this head, so a later fix can answer the same fingerprint.
  const fixKeys = answers
    .filter((answer) => isFixDependentOutcome(answer.outcome))
    .map((answer) => answer.fingerprint);
  const durableKeys = answers
    .filter((answer) => !isFixDependentOutcome(answer.outcome))
    .map((answer) => answer.fingerprint);
  const checkArgs = [
    pr,
    "--check-addressed",
    (fixKeys.length ? fixKeys : durableKeys).join(","),
  ];
  if (fixKeys.length > 0) {
    checkArgs.push("--marker-sha", pushedSha);
    if (durableKeys.length > 0)
      checkArgs.push("--check-durable-addressed", durableKeys.join(","));
  }
  const check = await run(
    tsArgv(join(here, "summary-findings.ts"), checkArgs),
    { stderr: "pipe", timeoutSec: summaryAnswerReconcileTimeoutSeconds() },
  );
  if (check.code !== 0) {
    fail(
      1,
      `answer-summary-finding.ts: could not reconcile PR #${pr}'s existing comments before posting — refusing to dispatch without knowing whether this outcome was already answered by an earlier, interrupted pass. Retry once the PR's comments are readable.`,
      check.stderr.trim(),
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(check.stdout);
  } catch (error) {
    return fail(
      1,
      `answer-summary-finding.ts: could not parse the reconciliation report for PR #${pr}: ${error}`,
    );
  }
  const requested = new Set([...fixKeys, ...durableKeys]);
  if (
    typeof report !== "object" ||
    report === null ||
    !("unaddressed" in report) ||
    !Array.isArray(report.unaddressed) ||
    !report.unaddressed.every(
      (key: unknown) => typeof key === "string" && requested.has(key),
    )
  ) {
    fail(
      1,
      `answer-summary-finding.ts: malformed reconciliation report for PR #${pr}`,
    );
  }
  const unanswered = new Set(report.unaddressed);
  const stickyRound =
    "round" in report && typeof report.round === "number" ? report.round : null;
  const toPost = answers.filter((answer) => unanswered.has(answer.fingerprint));
  if (toPost.length === 0) {
    console.error(
      `answer-summary-finding.ts: every fingerprint in this call already carries a live 'drive-pr-addressed' marker on PR #${pr} — treating as already dispatched by an earlier pass and skipping the duplicate post (idempotent no-op).`,
    );
    return 0;
  }
  const alreadyAnswered = answers.filter(
    (answer) => !unanswered.has(answer.fingerprint),
  );
  if (!batch && alreadyAnswered.length > 0) {
    fail(
      2,
      `answer-summary-finding.ts: refusing a MIXED batch — ${alreadyAnswered.map((item) => item.fingerprint).join(" ")} already carry a live marker, but ${toPost.map((item) => item.fingerprint).join(" ")} do not. Posting now would either re-answer the already-marked ones or leave their reasoning inconsistent with a partial comment. Retry with only the still-unanswered fingerprint(s): ${toPost.map((item) => item.fingerprint).join(" ")}`,
    );
  }

  const roundSuffix = stickyRound === null ? "" : `#${stickyRound}`;
  const marker = ({ fingerprint, outcome }: Answer) => {
    const suffix = isFixDependentOutcome(outcome)
      ? `@${pushedSha}${roundSuffix}`
      : "";
    return `<!-- drive-pr-addressed: ${fingerprint}${suffix} -->`;
  };
  const body = batch
    ? toPost
        .map(
          (answer) =>
            `**${answer.outcome}** — ${answer.reason}\n${marker(answer)}`,
        )
        .join(SUMMARY_ANSWER_SEPARATOR)
    : `**${outcome}** — ${raw}\n${toPost.map(marker).join("\n")}`;

  const bodyBytes = Buffer.byteLength(body);
  if (batch && bodyBytes > FORGE_BODY_LIMIT) {
    fail(
      2,
      `answer-summary-finding.ts: the held answers need ${bodyBytes} UTF-8 bytes, beyond GitHub's ${FORGE_BODY_LIMIT}-byte comment limit. Shorten their reasons and re-hold the findings before retrying.`,
    );
  }

  // LAST act before the POST: is this session still the one driving PR #pr
  // from this working tree?
  //
  // The per-key claim protocol narrows the concurrent-dispatch
  // window and says nothing about this one. Its claim file is taken and
  // released around a POST that runs OUTSIDE the state mutex, so a session
  // whose lease was taken over between `claim-held` and here still reaches
  // this line — and unlike every drive-state write, what it does here cannot
  // be undone: a duplicate top-level answer stands on the PR, carries its own
  // `drive-pr-addressed` marker, and enters the reviewer-scoring sample twice.
  //
  // Placed after the reconciliation rather than before it, so the fence sits
  // as close to the irreversible act as anything local can. It cannot be
  // atomic with the POST — GitHub has no conditional-write primitive for a
  // comment — which is the residual `lease.ts`'s header states rather than
  // implies.
  // HELD across the POST itself, unlike `assert-post-allowed.ts`'s own
  // point-in-time check: the fence and the mutation are in the
  // SAME process here, so a replacement worktree's admission landing between
  // the check and the `ghCall` below is a window this call can actually
  // close — the identical fix `guarded-push.ts` carries for `git push`, and
  // for the identical reason: before this, `assertRemoteMutationAllowed`
  // returned `void` having taken no lock at all, so nothing stopped a
  // DIFFERENT worktree from claiming this PR's per-PR lease and mutating it
  // in the gap between this check and the POST actually landing.
  const fence = await resolveFenceContext("answer-summary-finding.ts");
  const remoteLock =
    fence === null
      ? null
      : await assertRemoteMutationAllowed(
          fence,
          pr,
          "answer-summary-finding.ts",
        );
  // Heartbeat starts the INSTANT `remoteLock` is acquired, not after
  // `assertTreeMutationAllowed` below also succeeds (the mechanically identical
  // gap `guarded-push.ts` closes): that call's own `acquire()` can itself wait
  // up to `LOCK_ACQUIRE_MAX_SEC` (300s) under genuine contention on the TREE
  // lock, and otherwise `remoteLock` would sit un-heartbeated for that whole
  // wait. `treeLock` is declared here (not assigned) purely so this closure can
  // reference it before it exists; `?.` makes touching a not-yet-acquired lock
  // a no-op.
  let treeLock: Awaited<ReturnType<typeof assertTreeMutationAllowed>> | null =
    null;
  // Heartbeat both held locks' mtimes for as long as this POST runs:
  // `$GH_CALL_TIMEOUT` (30s by
  // default) is normally well under either lock's own default 10-minute
  // staleness window, but it is operator-configurable, and nothing else
  // touches these mtimes while the only thing running is the `ghCall`
  // below. Without this, a `GH_CALL_TIMEOUT` raised past that window lets a
  // contending `acquire()` elsewhere treat a still-live hold as abandoned
  // and break it out from under this still-in-flight POST — reopening the
  // exact takeover gap holding these locks through the POST exists to
  // close, the identical fix `guarded-push.ts` already carries for its own
  // (far longer-running) `git push`. `null` only when nothing was acquired
  // at all (no repository in play), so there is nothing to heartbeat.
  const lockHeartbeat =
    fence === null
      ? null
      : setInterval(() => {
          remoteLock?.touch();
          treeLock?.touch();
        }, lockHeartbeatMs());
  // The TREE-WIDE half, alongside the per-PR one above — and, unlike
  // `assert-post-allowed.ts`'s own point-in-time check, HELD across the POST
  // itself: the fence and the mutation are in the SAME process here, so a
  // replacement session's takeover between the check and the `ghCall` below is
  // a window this call can actually close, the identical fix `guarded-push.ts`
  // already carries for `git push`.
  //
  // Wrapped for the identical reason `guarded-push.ts` wraps its own second
  // acquisition: a throw here
  // — including this fence's own expected exit-11 refusal — must stop the
  // heartbeat and release the ALREADY-ACQUIRED `remoteLock` before
  // propagating, rather than leaving either running until process exit's
  // safety net eventually clears them.
  try {
    treeLock =
      fence === null
        ? null
        : await assertTreeMutationAllowed(
            fence,
            pr,
            "answer-summary-finding.ts",
          );
  } catch (e) {
    if (lockHeartbeat !== null) clearInterval(lockHeartbeat);
    if (remoteLock !== null) {
      remoteLock.release();
      remoteLock.dispose();
    }
    throw e;
  }

  // The body travels as a JSON string, verbatim: `gh api -f` has no safe
  // stdin-body form and `-F` applies JSON type coercion, so a body that is
  // exactly "true" or an integer would become a non-string field.
  let post: Awaited<ReturnType<typeof ghCall>>;
  try {
    post = await ghCall(
      [
        "api",
        `repos/{owner}/{repo}/issues/${pr}/comments`,
        "--input",
        "-",
        "-q",
        ".html_url",
      ],
      { stdin: JSON.stringify({ body }), stderr: "inherit" },
    );
  } finally {
    if (lockHeartbeat !== null) clearInterval(lockHeartbeat);
    if (remoteLock !== null) {
      remoteLock.release();
      remoteLock.dispose();
    }
    if (treeLock !== null) {
      treeLock.release();
      treeLock.dispose();
    }
  }
  process.stdout.write(post.stdout);
  return post.code;
}

runMain("answer-summary-finding.ts", main);
