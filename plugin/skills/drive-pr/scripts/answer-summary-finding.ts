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
 *   --outcome      REQUIRED. accepted | rejected | wont-fix | deferred | moot
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
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT TRY TO PROVE, and why (PR #4049
 * rounds 4-7, four threads from two independent reviewers):
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
 *    fix for one satisfied the check for the other, description-only or not
 *    (chatgpt-codex-connector, round 7).
 *  - Its necessary escape hatch was forgeable. A marker already standing at
 *    the SHA was read as "an earlier commit-backed answer landed here", but
 *    `findExactMarkers` accepts any comment from a trusted association
 *    carrying the grammar, and markers posted before the gate existed satisfy
 *    it too — so the induction "the first marker could only have come through
 *    this gate" was simply false (docomply-review, rounds 6 and 7).
 *  - It refused a legitimate answer. A first-time `moot` whose removal
 *    predates the hold needs no commit by definition, and neither does a
 *    re-answer renewing a marker over a fix that landed rounds ago — both
 *    deadlock unless the driver manufactures an unrelated commit
 *    (chatgpt-codex-connector, rounds 4 and 7).
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
 * more (docomply-review, round 8). At the head a drive CONVERGES on, no later
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
 * in otherwise, corrupting the audit trail before the API ever sees it
 *. Use a QUOTED heredoc (<<'EOF'), or pipe from `printf '%s'`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, isDigits, readStdinAll, runMain } from "./lib/cli.ts";
import { ghCall, git, resolvePr, run, tsArgv } from "./lib/proc.ts";
import {
  assertRemoteMutationAllowed,
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";
import { lockHeartbeatMs } from "./lib/state/lock.ts";
import { MARKER_SAFE_FINGERPRINT } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));

// `as const`, so `Outcome` is the closed vocabulary rather than `string`. As a
// plain `string[]` the comparisons further down (`outcome === 'accepted'`) were
// unchecked string literals, and a typo in one would have compiled
// (coderabbitai, PR #4034 round 2).
const OUTCOMES = [
  "accepted",
  "rejected",
  "wont-fix",
  "deferred",
  "moot",
] as const;
type Outcome = (typeof OUTCOMES)[number];
const isOutcome = (v: string): v is Outcome =>
  (OUTCOMES as readonly string[]).includes(v);
const TOKENS = OUTCOMES.map((o) => `**${o}**`);

async function main(): Promise<number> {
  let outcome = "";
  let pr = "";
  let pushedSha = "";
  const fingerprints: string[] = [];

  const argv = process.argv.slice(2);
  const take = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) fail(2, `${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "--outcome":
        outcome = take(a, i++);
        break;
      case "--fingerprint":
        fingerprints.push(take(a, i++));
        break;
      case "--pushed-sha":
        pushedSha = take(a, i++);
        break;
      default:
        if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
        pr = a;
    }
  }

  if (!isOutcome(outcome)) {
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

  if (fingerprints.length === 0) {
    fail(
      2,
      "answer-summary-finding.ts: at least one --fingerprint is required (from summary-findings.ts)",
    );
  }

  // The fingerprint travels to summary-findings.ts through the marker and
  // nowhere else, and the marker is lossy: its regex captures `[^\s>]+`, so
  // whitespace truncates the value and `>` ends the comment early, while a `@`
  // is read back as a fix-dependent SHA suffix. Any of those keys an answer to
  // a fingerprint that is not the finding's, so the finding stays unaddressed
  // on every later head and the drive can NEVER converge. Reject at the
  // boundary rather than posting an answer that cannot be read — the grammar
  // is MARKER_SAFE_FINGERPRINT in summary-findings.ts; keep the two identical.
  // The grammar is imported, not restated: `summary-findings.ts` owns
  // MARKER_SAFE_FINGERPRINT and reads the marker back with it, so a second copy
  // here drifting by one character produces markers that never round-trip and a
  // drive that never converges (coderabbitai, PR #4034 round 2). The two
  // messages stay separate because they diagnose different halves of it.
  for (const fp of fingerprints) {
    if (!/^[A-Za-z0-9]/.test(fp)) {
      fail(
        2,
        `answer-summary-finding.ts: fingerprint '${fp}' must start with a letter or digit`,
      );
    }
    if (!MARKER_SAFE_FINGERPRINT.test(fp)) {
      fail(
        2,
        `answer-summary-finding.ts: fingerprint '${fp}' contains a character the`,
        "drive-pr-addressed marker cannot carry (allowed: letters, digits, . _ -).",
        "An answer under a mangled key never marks the finding addressed, so the",
        "drive would never converge. Copy the fingerprint from summary-findings.ts.",
      );
    }
  }

  // Read verbatim, trailing newlines preserved — the bash original went out of
  // its way (a sentinel byte) to keep a reason ending in a blank line intact
  // after a closed code fence.
  const reason = await readStdinAll();

  // `=== ''` rejected only a zero-byte stdin, so a lone newline or a run of
  // spaces posted `**accepted** — ` with nothing after it, and the marker went
  // up regardless: the finding then reads as answered by a reply that explains
  // nothing, which is the exact case this guard exists to refuse (coderabbitai,
  // PR #4034 round 2). Trim to decide, but keep `reason` itself verbatim — the
  // trailing newlines are deliberately preserved for fenced reasons below.
  if (reason.trim() === "") {
    fail(
      2,
      "answer-summary-finding.ts: the reason (stdin) was empty — a bare outcome classifies the finding while explaining nothing",
    );
  }

  // The outcome arrives as a FLAG and the token is composed below, so a
  // reason that ALREADY opens with one produces `**accepted** — **accepted**
  // — …`. The harvester keys on the leading token, so a doubled one is a
  // malformed sample of exactly the kind this vocabulary exists to keep clean
  // — and the marker posts anyway, so the finding reads as answered and no
  // later pass revisits it.
  //
  // Measured, not hypothesised: it happened on this skill's own PR (#3995
  // round 10). `drive-state.ts hold --kind finding` takes the reason on
  // stdin, held between the fix and the push; writing that held reason the
  // way a THREAD reply is written — token first, since that is what
  // reply-to-thread.ts demands — is the natural mistake, and nothing caught
  // it until four comments were already posted and had to be PATCHed. Refuse
  // instead, naming the fix.
  //
  // Checked after stripping LEADING whitespace, not on the reason verbatim: a
  // reason can naturally start with indentation or a blank line (pasted from
  // an indented code block, say), and a byte-zero-only check reads
  // "  **rejected** — …" as not carrying a token at all, posting the doubled
  // token this guard exists to refuse.
  const reasonCheck = reason.replace(/^\s+/, "");
  if (TOKENS.some((t) => reasonCheck.startsWith(t))) {
    const leading = reasonCheck.split(/\s/, 1)[0];
    fail(
      2,
      `answer-summary-finding.ts: the reason already opens with an outcome token (${leading}).`,
      "",
      "The token is composed from --outcome here; passing it on stdin too posts",
      `"**${outcome}** — ${leading} — …", which the reviewer-scoring harvester reads as a`,
      "malformed sample. Unlike reply-to-thread.ts, whose callers write the WHOLE",
      "reply and so must supply the token, this script wants the reason alone:",
      "",
      `  answer-summary-finding.ts --outcome ${outcome} --fingerprint FP PR <<'EOF'`,
      "  the concrete reason, with no leading token",
      "  EOF",
      "",
      "If this reason came from 'drive-state.ts held', fix it at the 'hold' call —",
      "that stdin is the same reason text, and it must not carry a token either.",
    );
  }

  pr = await resolvePr(pr);
  if (!isDigits(pr)) {
    fail(2, "answer-summary-finding.ts: could not resolve a PR number");
  }

  // Enforce the held-batch ordering for the fix-dependent outcomes. The
  // durable ones assert something about the finding's merit that no commit
  // changes, so nothing downstream can invalidate them and they may post
  // immediately.
  const fixDependent = outcome === "accepted" || outcome === "moot";
  if (fixDependent) {
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
    const localRes = await git(["rev-parse", "HEAD"], { stderr: "ignore" });
    if (localRes.code !== 0) {
      fail(
        1,
        `answer-summary-finding.ts: cannot read local HEAD — refusing to post a '${outcome}' marker`,
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
    const dirtyRes = await git(["status", "--porcelain"], { stderr: "ignore" });
    if (dirtyRes.code !== 0) {
      fail(
        1,
        `answer-summary-finding.ts: cannot read the working tree — refusing to post a '${outcome}' marker`,
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

  // Reconcile against the PR's ACTUAL comments before posting anything.
  //
  // This script is not idempotent — every call posts a NEW top-level comment —
  // and the held-batch's per-item claim only guards the CONCURRENT
  // double-dispatch case. It says nothing about the sequential one: a driver
  // calls this script, the POST to GitHub succeeds, and the process is killed
  // before the caller's `release-held` runs. The claim file is now an orphan;
  // once it crosses the staleness window a later round reclaims the same held
  // key and, believing nothing has happened yet, calls this script again for
  // the identical fingerprint — producing a second, duplicate comment with no
  // error anywhere.
  //
  // `summary-findings.ts --check-addressed` looks for a marker with this EXACT
  // fingerprint and this EXACT `@sha` suffix (`--marker-sha`, the SHA this call
  // is itself about to stamp) already sitting on the PR — deliberately NOT the
  // main report's `collectAddressed`/`reviewerPosition` pairing, even though
  // that looks like the obvious thing to reuse. That pairing expires a
  // fix-dependent marker once the reviewer has read its SHA (reaching it, for a
  // finding outside the reviewer's backlog blob; moving past it for any
  // finding), which answers "is this finding still open" — the wrong question
  // here, and routing this reconciliation through it reintroduced the exact
  // duplicate-post bug this block exists to close (docomply-review round 2,
  // a reference-implementation pull request): a driver reconciling moments after its OWN successful post, once
  // the reviewer had simply caught up to that SHA, saw its own marker as expired
  // and posted a second one. An exact fingerprint+sha match has no such expiry
  // — whether the reviewer has read a marker is irrelevant to whether posting it
  // again would duplicate it. It goes through the CLI rather than importing
  // `findExactMarkers` and re-fetching the comments here, so there stays one
  // fetch-and-trust-filter path over that world-writable stream rather than a
  // second one to drift from it.
  //
  // This is a plain read-then-write, not an atomic check-and-post: it narrows
  // the window rather than eliminating it.
  //
  // In-flight overlap: two claimants can each pass this check before either's
  // POST below is visible to the other — reachable if a genuinely slow (not
  // crashed) dispatch outlives the claim's staleness window and a second driver
  // reclaims and redispatches while the first POST is still in flight. See
  // DRIVE_PR_CLAIM_STALE_MIN's own comment in lib/state/claims.ts for why
  // closing that residual with a heartbeat/lease-renewal isn't worth it here.
  //
  // Head-moved reclaim: a driver can die AFTER its POST succeeds but BEFORE
  // `release-held`. If the PR head moves on before that stale claim is
  // reclaimed, a later reclaimer's `--marker-sha` is the NEW head, the check
  // looks for a marker there, and misses the one sitting at the OLD head.
  //
  // an earlier change changed what happens NEXT, and this comment is the honest version
  // of it: that reclaimer used to go on and post a second, duplicate answer.
  // It no longer gets that far — `claim-held --kind finding --pushed-sha` now
  // refuses, because the held record's `verifiedSha` is still the OLD head. So
  // the duplicate comment is gone and a STUCK held entry takes its place: no
  // `--pushed-sha` will ever match it again, and nothing re-enumerates it
  // either, since `summary-findings.ts`'s `unaddressed` list already excludes
  // an answered finding. That refusal names both recoveries (release the stale
  // entry if the answer is genuinely already posted; re-hold it if not) —
  // deliberately, since a mechanical one does not exist: recovery cannot tell
  // "already posted" from "about to post" without reading the PR.
  //
  // The residual is not closed by a cheaper local fix. Matching ANY SHA here
  // directly regresses the round-2 rule above (a later, legitimate re-answer of
  // the same fingerprint under a new SHA would read as already-answered and be
  // silently skipped, which is a live finding lost, not a re-asked one).
  // Persisting the dispatched SHA before the POST only relocates the crash
  // window one step earlier, since no ordering of a local state write and a
  // remote POST is atomic. Same accepted-residual class as the
  // in-flight-overlap route above, reached a third way — traded from a
  // permanent wrong comment on the PR to a stale local entry with a documented
  // one-command cleanup.
  const checkArgs = [pr, "--check-addressed", fingerprints.join(",")];
  if (fixDependent) checkArgs.push("--marker-sha", pushedSha);
  const check = await run(
    tsArgv(join(here, "summary-findings.ts"), checkArgs),
    {
      stderr: "ignore",
    },
  );
  if (check.code !== 0) {
    fail(
      1,
      `answer-summary-finding.ts: could not reconcile PR #${pr}'s existing comments before posting — refusing to dispatch without knowing whether this outcome was already answered by an earlier, interrupted pass. Retry once the PR's comments are readable.`,
    );
  }
  let stillUnanswered: string[];
  // The reviewer round the sticky under evaluation describes, read back from
  // the same reconciliation call rather than fetched separately or passed in by
  // the caller: `collectAddressed` measures the winddown exemption's bound
  // against that exact field of that exact comment, so producing it from any
  // other source is a second thing to drift — and a marker stamped with a round
  // the consumer does not compare against is a suppression nobody can bound.
  let stickyRound: number | null = null;
  try {
    const parsed = JSON.parse(check.stdout);
    stillUnanswered = parsed.unaddressed as string[];
    stickyRound = typeof parsed.round === "number" ? parsed.round : null;
  } catch {
    return fail(
      1,
      `answer-summary-finding.ts: could not parse the reconciliation report for PR #${pr} — refusing to dispatch without knowing whether this outcome was already answered.`,
    );
  }
  const toPost = fingerprints.filter((fp) => stillUnanswered.includes(fp));
  const alreadyAnswered = fingerprints.filter(
    (fp) => !stillUnanswered.includes(fp),
  );
  if (toPost.length === 0) {
    console.error(
      `answer-summary-finding.ts: every fingerprint in this call already carries a live 'drive-pr-addressed' marker on PR #${pr} — treating as already dispatched by an earlier pass and skipping the duplicate post (idempotent no-op).`,
    );
    return 0;
  }
  if (alreadyAnswered.length > 0) {
    fail(
      2,
      `answer-summary-finding.ts: refusing a MIXED batch — ${alreadyAnswered.join(" ")} already carry a live marker, but ${toPost.join(" ")} do not. Posting now would either re-answer the already-marked ones or leave their reasoning inconsistent with a partial comment. Retry with only the still-unanswered fingerprint(s): ${toPost.join(" ")}`,
    );
  }

  // A fix-dependent marker carries the SHA the change landed on; a durable
  // one carries the bare fingerprint. The difference is not cosmetic:
  // `rejected`, `wont-fix` and `deferred` are claims about the finding's
  // MERIT, which no later commit changes, while `accepted` and `moot` claim
  // only "answered as of THIS head". summary-findings.ts stops honouring a
  // SHA-stamped marker once the reviewer's own review has caught up to that
  // head (`collectAddressed` says exactly where the line falls) — so an
  // incomplete fix, a revert, or a later round reintroducing the
  // code a `moot` said was gone re-surfaces the finding instead of being
  // suppressed by a stale answer whose fingerprint never changed.
  //
  // The round rides along on the fix-dependent form because one class of
  // finding is EXEMPT from that expiry — the reviewer's `winddown-deferred`
  // backlog entries, which it forwards without re-verifying, so their
  // re-emission falsifies nothing. Unbounded, that exemption suppressed a
  // reverted fix forever; bounded by elapsed rounds, it expires on
  // its own and the finding is re-asked once. Stamped on EVERY fix-dependent
  // marker, not just the winddown ones: which set a fingerprint belongs to is
  // the reviewer's to say and it can change between rounds, so deciding it here
  // would be a second, staler copy of that judgement. `collectAddressed` reads
  // the round only inside the exemption, where it means something.
  //
  // A null round — no sticky, or a sticky stamping none — omits the suffix,
  // which withholds the exemption from this marker. That is the pre-exemption
  // behaviour: it costs one re-answer, and the re-answer stamps a round.
  const roundSuffix = stickyRound === null ? "" : `#${stickyRound}`;
  const suffix = fixDependent ? `@${pushedSha}${roundSuffix}` : "";
  let body = `**${outcome}** — ${reason}`;
  for (const fp of fingerprints) {
    body += `\n<!-- drive-pr-addressed: ${fp}${suffix} -->`;
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
  // `assertTreeMutationAllowed` below also succeeds (docomply-review, PR
  // #4164 round 3 — the mechanically identical gap `guarded-push.ts` had):
  // that call's own `acquire()` can itself wait up to `LOCK_ACQUIRE_MAX_SEC`
  // (300s) under genuine contention on the TREE lock, and until this round
  // `remoteLock` sat un-heartbeated for that whole wait. `treeLock` is
  // declared here (not assigned) purely so this closure can reference it
  // before it exists; `?.` makes touching a not-yet-acquired lock a no-op.
  let treeLock: Awaited<ReturnType<typeof assertTreeMutationAllowed>> | null =
    null;
  // Heartbeat both held locks' mtimes for as long as this POST runs
  // (docomply-review, a reference-implementation pull request round 2): `$GH_CALL_TIMEOUT` (30s by
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
  // The TREE-WIDE half, alongside the per-PR one above — and,
  // unlike `assert-post-allowed.ts`'s own point-in-time check, HELD across
  // the POST itself: the fence and the mutation are in the SAME process
  // here, so a replacement session's takeover between the check and the
  // `ghCall` below is a window this call can actually close, the identical
  // fix `guarded-push.ts` already carries for `git push` (docomply-review
  // round 10, PR #4131).
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
