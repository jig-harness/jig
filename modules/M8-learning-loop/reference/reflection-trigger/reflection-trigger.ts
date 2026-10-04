// Reflection trigger: fire session reflection on an observable, and write the
// measurement that made it fire into the record.
//
// "Reflect when the session felt hard" reliably under-fires — the sessions with
// the most to say are the ones that end tired and late. So this reads the
// strongest observable available: how many review rounds a change took to
// converge (M7's review-convergence gate emits exactly that line). A change that
// needed many rounds is rarely a noisy reviewer; it usually means the scaffolding
// under-served it, and each of those is a lever this module's flywheel consumes.
//
// Two properties make the trigger work, and both are mechanical here rather than
// left to habit:
//
//   * It fires AT CONVERGENCE, not afterwards. Only a `CONVERGED` decision line
//     fires; the detail is richest at the moment the loop ends and decays fast
//     once the session closes. A prompt that arrives the next day gets a summary.
//   * The record CARRIES THE MEASUREMENT. The tool writes `change:` and `rounds:`
//     itself, so the inbox can answer "which changes fought the scaffolding
//     hardest" — which is the question that ranks the levers. A reflection entry
//     nobody can aggregate is an anecdote.
//
// Input: a file holding M7's convergence decision line, e.g.
//     CONVERGED round=5 open_threads=0 reviewers=2/2 pr_state=open
//
// Windows atomically hard-links a prewritten owner record instead of creating
// a symbolic link, avoiding symbolic-link privilege requirements.
//
// Environment:
//     CHANGE           required — the change identifier (PR number, branch, ticket
//                      key). This is the aggregation key; there is no useful default
//     INBOX            required — path to the reflection inbox to append to. It must
//                      already exist (copy templates/reflection-inbox.md): creating
//                      one on demand means a typo'd path silently swallows records
//     ROUND_THRESHOLD  rounds at or above which to fire (default 3). A local
//                      calibration — set it where it fires on the genuinely hard
//                      reviews and not on ordinary ones, and keep it adjustable
//     ARCHIVE          optional — a file processed inbox entries are moved to. The
//                      dedup guard reads it too, so archiving (rather than
//                      deleting) keeps a retry from re-appending an old record
//     LOCK_TIMEOUT     seconds to wait for the inbox lock (default 30). The
//                      check-and-append is serialized; see below
//
// Exit codes (mirroring M7's convergence gate — a skip is NOT a failure):
//     0  PROMPT  — threshold reached; run reflection. Either a record was appended,
//                  or an earlier record for this change is still unfilled and needs
//                  finishing (no second record is written in that case)
//     3  SKIP    — nothing to do (not converged yet, under threshold, or already
//                  recorded AND filled in for this change and round count)
//     2  usage / format error
//
// On re-prompting: an unfilled record cannot be told apart from one another process
// wrote a moment ago, so two invocations racing on the same change may both prompt.
// That is the deliberate direction to err in — the record count, which is what the
// ranking reads, stays at one either way, whereas the opposite error (treating an
// abandoned stub as done) suppresses that change's reflection permanently.
//
// Wire it so a skip cannot fail the job — but so ONLY a skip is forgiven. A bare
// `if trigger; then …; fi` also swallows exit 2, which means a malformed decision
// file, a lock failure or a failed write silently disables reflection with nothing
// reporting it:
//     CHANGE=$PR INBOX=docs/reflection-inbox.md ARCHIVE=docs/reflection-archive.md \
//       ./reflection-trigger.ts decision.txt && rc=0 || rc=$?
//     case "$rc" in
//       0) <run your runtime's reflect command> ;;
//       3) : ;;                                  # ordinary review, nothing to do
//       *) echo "reflection trigger failed ($rc)" >&2; exit "$rc" ;;
//     esac
//
// Note what this does NOT decide: whether the rounds were the scaffolding's fault.
// "The reviewer was wrong repeatedly" is itself a finding, and routes to the
// reviewer's config or its eval corpus rather than to the instruction files. That
// judgement is the reflection's job; the trigger only guarantees it gets asked.
//
// Usage:
//   CHANGE=PR-482 INBOX=docs/reflection-inbox.md ./reflection-trigger.ts decision.txt
//   CHANGE=PR-482 INBOX=inbox.md DECISION=decision.txt ROUND_THRESHOLD=4 ./reflection-trigger.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("reflection-trigger");
