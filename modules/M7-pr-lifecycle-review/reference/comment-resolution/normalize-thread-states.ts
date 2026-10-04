// Verdict exporter: forge thread rows -> the unresolved-threads gate's input.
//
// The gate (./check-threads-resolved.ts) reads a CLOSED vocabulary as the first
// whitespace-delimited token of each line. A forge hands you a boolean plus a
// free-text reply. Nothing in between happens by itself: `**accepted** — fixed in
// a1b2c3d` is not the token `addressed`, a trailing `Verdict: deferred` is not
// first, and a reply that declares nothing is not a state at all. Dropping the
// reply body in verbatim makes every one of those an unknown state — the gate
// fails, but for the wrong reason and with no way to tell a typo from a
// convention mismatch.
//
// This script is that missing step, and it is the ONLY place the reply encoding
// is decoded: one adapter per repo, not one per workflow.
//
// Input: TAB-separated rows from your forge (see ../../mappings.md):
//     <thread-id>\t<resolved: true|false>\t<reply body, newlines flattened>
// A thread id may repeat across consecutive rows — its replies, NEWEST FIRST — and
// the freshest reply that actually declares a verdict wins. Sending only the last
// comment loses verdicts: a reviewer answering "confirmed" after the author's
// `**accepted** — fixed in a1b2c3d` would export as `unclassified` and block a
// correctly resolved thread. One row per thread still behaves as it always did.
// Blank lines and `# comments` are ignored.
//
// Output (stdout): the gate's states file, `<thread-id> <state> [trail...]`.
//
// Encodings (VERDICT_ENCODING, default `token`):
//     token     leading verdict word, markdown emphasis and trailing punctuation
//               stripped:   `**accepted** — added the guard in a1b2c3d`
//     trailer   trailing `Verdict: <state>` — flattening a multi-line reply turns
//               "on its own line" into "at the end of the body", so with this
//               encoding the trailer must be the LAST thing in the reply
//
// Both are ANCHORED — start of body, or end of body. Neither searches for a state
// word anywhere in the text, because an unanchored match reads narration as a
// verdict: a reply explaining why something was intended contains "intended"
// long after its actual verdict. A forge that models a real verdict field (a
// label, a reaction) is better than either; none of the forges in ../../mappings.md
// does today, so fetch that field and extend `canon()` if yours is the exception.
//
// A resolved thread whose verdict cannot be read emits `unclassified`, which the
// gate fails with its own message. That is deliberate: "cannot tell" is its own
// value, and folding it into a real state is the same corruption as scoring a
// `moot` as a rejection, one layer down.
//
// Synonyms live HERE. An adopting repo whose tooling says `accepted` / `wontfix` /
// `obsolete` maps them in `canon()` below — the exporter is already forge- and
// repo-specific, and the gate's vocabulary stays closed.
//
// Conventions: exit 0 on success, 2 on a usage / input-format error. Rows file
// via arg or ROWS env so the self-test drives it with fixtures.
//
// Usage:
//   normalize-thread-states.ts pr-thread-rows.tsv > pr-threads.txt
//   VERDICT_ENCODING=trailer ROWS=rows.tsv normalize-thread-states.ts > states.txt
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main)
  process.exitCode = await runGate("normalize-thread-states");
