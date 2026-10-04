// Unresolved-threads merge gate: no PR merges with an open review thread, and
// every non-fix resolution carries an audit trail.
//
// This is the comment-resolution loop (address / reject / defer / moot — see
// ../../templates/PR-LIFECYCLE.md) made mechanical. A forge's own branch
// protection can require "all threads resolved", but that is a bare boolean; it
// cannot tell an addressed thread from one a bot marked resolved with no
// reason. This gate reads a small, forge-exported states file so it can enforce
// the *trail*, not just the flag.
//
// Input: a states file, one thread per line, whitespace-separated:
//     <thread-id> <state> [reason / follow-up reference ...]
// States and their rule:
//     addressed   accepted, fixed in this PR           -> pass ONLY with a commit/change reference
//     rejected    finding is wrong / intended          -> pass ONLY with a reason (prose is enough)
//     deferred    accepted, filed as a follow-up       -> pass ONLY with a follow-up reference
//     moot        no longer applies; the code is gone  -> pass ONLY with a superseding reference
//     open        not yet terminal                     -> FAIL (blocks merge)
//     unclassified  resolved, but no verdict declared  -> FAIL (see below)
//     <other>     typo / unknown                       -> FAIL
//
// Three of the four terminal states make a claim ABOUT A CHANGE — "fixed here",
// "tracked there", "superseded by that" — so their trail has to name one: a
// commit sha, a `#123`, a tracker key like `ISSUE-482`, or a URL. Only `rejected`
// is a claim about the finding itself, where prose is the whole answer. Accepting
// any nonblank text for the other three fails open: `moot x` would pass, and
// `moot` is precisely the state that must not become the frictionless dismissal.
//
// `moot` is a distinct terminal state, not a polite `rejected`. Rejected asserts
// the reviewer was WRONG; moot asserts it may have been RIGHT about code that no
// longer exists. Where a learning loop mines these states (M8), collapsing the
// two feeds it false positives the reviewer never committed — so the distinction
// has to survive all the way into the export, not just into the reply prose.
//
// `unclassified` is what the exporter emits for a resolved thread whose reply
// declares no verdict (../../mappings.md § Encoding the declared verdict). It fails,
// with its own message, rather than being folded into a real state: "cannot tell"
// counted as a rejection is the same corruption as a `moot` counted as one.
//
// Blank lines and `# comments` are ignored. An empty file means zero threads
// (pass). Produce the file from your forge per ../../mappings.md — the shipped
// adapter is ./normalize-thread-states.ts — and export it EMPTY when there are
// no threads rather than skipping the gate.
//
// Conventions: exit 0 pass, 1 on an unresolved / trail-less / unknown thread, 2
// on a usage error; states file via arg or THREADS env so the self-test drives
// it with fixtures.
//
// Usage:
//   check-threads-resolved.ts pr-threads.txt
//   THREADS=pr-threads.txt check-threads-resolved.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main)
  process.exitCode = await runGate("check-threads-resolved");
