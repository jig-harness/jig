# Unresolved-threads merge gate

The comment-resolution loop (address / reject / defer / moot — see
[`PR-LIFECYCLE.md`](../../templates/PR-LIFECYCLE.md)) made mechanical: no PR
merges with an open review thread, and every non-fix resolution carries an
audit trail.

## Why it exists

A forge's branch protection can require "all conversations resolved," but that
is a bare boolean — it cannot distinguish a thread that was *addressed* from one
a bot (or an impatient author) marked resolved with no reason. The loop
contract says every thread reaches one of four terminal states, each leaving a
trail: **addressed** (a fix), **rejected** (a stated reason), **deferred** (a
filed follow-up), **moot** (what superseded it). This gate reads a small
forge-exported states file so it can enforce the *trail*, not just the flag.

## Mechanism

One thread per line: `<thread-id> <state> [reason / reference]`.

| State | Rule |
|-------|------|
| `addressed` | accepted and fixed here — passes **only** with a reference to the commit/change that fixed it |
| `rejected` | the finding is wrong or intended — passes **only** with a reason (prose is the whole answer here) |
| `deferred` | accepted but not fixed here — passes **only** with a reference to the follow-up it was filed as |
| `moot` | no longer applies; the code it anchored to is gone — passes **only** with a reference to what superseded it |
| `unclassified` | fails — the forge says resolved but the reply declares no verdict (see [§ the undeclared verdict](#the-undeclared-verdict)) |
| `open` | fails — resolve it before merge |
| anything else | fails — unknown state (catches typo'd resolutions) |

A **reference** is a commit sha *containing at least one digit*, a `#123`, a tracker
key (`ISSUE-482`), or a URL. The digit is not fussiness: English is full of valid
hex, so `defaced`, `effaced` and `deadbeef` would otherwise pass as commits and
`moot defaced` would be exactly the frictionless dismissal the trail requirement
refuses. An all-letter sha (about 1 in 700) needs the explicit `commit <sha>` form,
which reads better in a trail regardless — and there the sha must be the *whole*
following word, or `commit defacedly` would smuggle the same trick back in.
Three of the four terminal states make a claim about a *change* — "fixed here",
"tracked there", "superseded by that" — so a nonblank-text check is not enough
for them: `moot x` and `deferred later` would both pass, and those are the
resolutions worth catching. Only `rejected` is a claim about the finding itself,
where there is nothing to point at.

### Why `moot` is its own state

`moot` is not a polite `rejected`. **Rejected** asserts the reviewer was
*wrong*. **Moot** asserts it may have been perfectly *right about code that no
longer exists* — the anchored lines were deleted or rewritten by a later commit.

The distinction matters most one module over. Where a learning loop
([M8](../../../M8-learning-loop/)) mines these states to score an automated
reviewer, `rejected` is evidence of a false positive and pushes the loop toward
suppressing that whole class of finding. Feeding it a `moot` as a `rejected`
therefore teaches the reviewer to stop surfacing findings it got *right*. A
review process without a `moot` state has nowhere to put those threads, so they
end up as rejections, as silent resolutions, or as threads left open forever —
all three corrupt something.

It still requires a trail, for the same reason the others do: claiming a
finding no longer applies is itself a claim about the code, and without "what
superseded it" `moot` becomes the frictionless way to dismiss anything.

### On the state labels

The four states are semantic, not lexical — an adopting repo whose tooling emits
different words (`accepted` for `addressed`, say) maps them **in the exporter**,
which is already forge-specific. What must not vary is that the set is *closed*:
an unrecognised state fails rather than passing silently, which is what makes a
typo'd resolution visible.

An **empty** file means zero threads and passes. Blank lines and `#` comments
are ignored. Export the file empty when a PR has no threads rather than skipping
the gate — a skipped gate and a clean gate must not look the same.

## The exporter

The forge does not hand you these states. It hands you an id, a resolved boolean,
and free-text replies, and the gate reads the **first whitespace-delimited token**
as the state. Nothing bridges that by itself: a reply reading
`**accepted** — fixed in a1b2c3d` arrives as the state `**accepted**` and fails as
an unknown state, and so does every other documented verdict encoding.

[`normalize-thread-states.ts`](normalize-thread-states.ts) is that bridge, and is
the **only** place a reply encoding is decoded — one adapter per repo, not one per
workflow:

```sh
# rows out of the forge:  <thread-id>\t<resolved>\t<reply body>
# one row per REPLY, newest first; a thread id repeats across its replies
VERDICT_ENCODING=token bun ./normalize-thread-states.ts pr-thread-rows.tsv > pr-threads.txt
THREADS=pr-threads.txt bun ./check-threads-resolved.ts
```

Export **every** reply, newest first — not just the last comment. The newest
comment is not reliably the verdict: a reviewer answering "confirmed" after the
author's `**accepted** — fixed in a1b2c3d` would bury it, and the thread would
export as `unclassified` and block a resolution that was in fact correct. The
exporter scans a thread's replies newest-first and takes the first that declares a
verdict, so acknowledgements, questions and thanks are passed over while the
freshest *declared* verdict still wins.

It supports the two encodings that any forge can carry — a leading token
(`VERDICT_ENCODING=token`, the default) and a trailing `Verdict:` trailer
(`=trailer`) — both **anchored** to a fixed position, never a search for a state
word anywhere in the body. Adopter synonyms live in its `canon()` function (the
`verdicts` table in [`lib/module-gates.ts`](../../../../lib/module-gates.ts)). Full
per-forge recipes are in [`mappings.md`](../../mappings.md).

Its self-test runs every documented encoding through the exporter *and then
through the gate*, asserting both the states file and the gate's exit code — a
mapping that is never run against the thing it feeds is how a documented encoding
ends up unreadable.

### The undeclared verdict

A reply that declares nothing exports as `unclassified`, which fails with its own
message rather than being guessed at. That is the point: "cannot tell" is a real
outcome — a legacy reply written before the convention, or a deliberate opt-out
mid-thread — and folding it into a real state is the same corruption as scoring a
`moot` as a rejection, one layer down. The failure message names the encoding
rather than reporting a typo, because the fix is to write the verdict, not to
correct a word.

## Where it runs

Wire it as a **merge gate**: a required [CI](../../../../GLOSSARY.md) check on the
PR, after the forge-export step produces the states file (recipes per forge in
[`mappings.md`](../../mappings.md) — GitHub review threads via GraphQL, GitLab
resolvable discussions). The two loop rules that are **not** an agent's call —
scope expansion and overruling a *human* thread — stay
[HITL](../../../../GLOSSARY.md); this gate enforces the mechanical half.

```sh
THREADS=pr-threads.txt bun ./check-threads-resolved.ts
```

## Files

| File | Role |
|------|------|
| `check-threads-resolved.ts` | the gate; states file via arg or `THREADS` |
| `check-threads-resolved.test.ts` | paired self-test |
| `normalize-thread-states.ts` | the exporter; forge rows → gate states. `VERDICT_ENCODING` selects the encoding |
| `normalize-thread-states.test.ts` | paired self-test — golden states files **and** the gate's verdict on each |
| `fixtures/clean.txt` | all terminal with trails — must pass |
| `fixtures/open.txt` | an open thread — must fail |
| `fixtures/no-reason.txt` | trail-less rejection/deferral — must fail |
| `fixtures/no-reason-moot.txt` | trail-less `moot` — must fail |
| `fixtures/no-fix-ref.txt` | `addressed` with no commit/change reference — must fail |
| `fixtures/bad-ref-moot.txt` | `moot` whose trail names nothing (`moot x`) — must fail |
| `fixtures/bad-ref-deferred.txt` | `deferred` promising instead of pointing (`deferred later`) — must fail |
| `fixtures/bad-ref-hexword.txt` | English words that are valid hex (`defaced`, `deadbeef`), and `commit defacedly` — must fail |
| `fixtures/unclassified.txt` | resolved, no verdict declared — must fail, with its own message |
| `fixtures/unknown.txt` | a typo'd state — must fail |
| `fixtures/empty.txt` | no threads — must pass |
| `fixtures/raw/*.tsv` | forge rows for the exporter, one file per encoding / edge case |
| `fixtures/raw/verdict-then-ack.tsv` | several replies per thread — a verdict buried under an acknowledgement must still win |
| `fixtures/raw/*.expected` | the gate input each one must produce (golden files) |

Run the self-tests with `bun test ./check-threads-resolved.test.ts
./normalize-thread-states.test.ts` (and the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.
