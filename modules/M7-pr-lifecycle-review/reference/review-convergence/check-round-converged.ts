// Review-round convergence: may this review loop stop, keep going, wait, or is it
// already pointless?
//
// A push that resolves one round of review comments re-triggers the reviewers and
// produces the next round, so the loop's stop condition is not "are there open
// threads?". That question is wrong in two directions, and both failures are
// silent — no error is raised in either case:
//
//   * Zero open threads while a reviewer is still running is NOT convergence.
//     That round's comments have not posted yet. Stopping there abandons live
//     findings and looks exactly like success.
//   * A merge (or close) that lands mid-loop orphans every later fix onto a
//     branch nothing will merge. Liveness has to be re-checked each round, not
//     assumed from the round before.
//
// Both are properties of any asynchronous review loop, not of a forge or a bot,
// which is why this is a portable gate over a tiny exported status file rather
// than a forge API script.
//
// Input: a status file, `key: value` per line (see ../../mappings.md for producing it):
//     pr_state:      open | merged | closed
//     open_threads:  count of threads not yet terminal — count every thread the
//                    merge gate would REJECT, not only those marked `open`
//     round:         1-based round counter, carried by the caller (>= 1)
//     reviewer:      <identity> <reported|pending>   — repeated, one per reviewer
// Counts are canonical decimal: no leading zeros, which bash reads as octal. The
// first three keys are required and appear exactly once; at least one `reviewer:`
// line is required. A missing key is schema drift, and defaulting one would
// manufacture the very confidence this gate exists to withhold. Blank lines and
// `# comments` are ignored.
//
// Reviewers are IDENTITIES, deliberately, not a pair of counts. Two counts look
// simpler and are quietly wrong: a bot that leaves two artifacts behind — a check
// run AND a posted review — gets counted twice by any naive producer, so with one
// bot finished and one human still pending you get 2 of 2 reported and a false
// CONVERGED. One settled signal per identity makes that unrepresentable, and a
// repeated identity is an error rather than a second vote. It also means
// "reported exceeds expected" cannot happen by construction.
//
// Output: one machine-readable decision line on stdout (the reasoning goes to
// stderr), so a caller can act on it and a learning loop can consume the round
// count from it (M8's reflection trigger does exactly that):
//     <DECISION> round=<n> open_threads=<n> reviewers=<reported>/<expected> pr_state=<s>
//
// Decisions and exit codes:
//     CONVERGED  0  settled, everyone reported, nothing open — the loop may stop
//     WORK       1  threads to resolve; fix them, push, and run the next round
//     WAIT       3  nothing open but the round has not settled — do NOT stop
//     ABORT      4  the PR is no longer open; stop, do not push
//     (usage / format error exits 2, per the other gates here)
//
// Order is deliberate: liveness first (a merged PR makes every other question
// moot), then work-in-hand, then settling. WORK outranks WAIT because open
// threads are worth resolving whether or not the round has finished arriving;
// WAIT is reserved for the case that actually misleads — an empty thread list.
//
// Usage:
//   check-round-converged.ts round-status.txt
//   STATUS=round-status.txt check-round-converged.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-round-converged");
