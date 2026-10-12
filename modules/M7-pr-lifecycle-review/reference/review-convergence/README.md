# Review-round convergence

Review is a **loop over rounds**, not a single pass: resolving one round's
comments means pushing, and pushing re-triggers the reviewers. So the loop needs
a stop condition, and the obvious one — "are there any open threads?" — is wrong
in two directions. This gate is that stop condition, made mechanical.

## What it decides

Both failure modes below are **silent**. Neither raises an error, and both look
like success from inside the loop, which is why a person driving the loop by eye
does not catch them and a gate does.

| Trap | What it looks like | What actually happened |
|------|--------------------|------------------------|
| Stopping too early | zero open threads → "converged" | a reviewer was still running; that round's comments had not posted yet, and the loop just abandoned live findings |
| Pushing into a corpse | fixes committed and pushed, no error | the PR merged (or closed) mid-loop; every fix from that point on landed on a branch nothing will merge |
| A reviewer counted twice | "2 of 2 reported" → converged | one bot left *two* artifacts (a check run **and** a posted review) and a producer summing signals counted it twice, while a human had not looked yet |

Liveness is re-checked **each round**, not assumed from the round before — the
merge that orphans the loop happens *while* the loop is running, which is exactly
when nothing re-reads it.

## Mechanism

A tiny exported status file, `key: value` per line:

```
pr_state: open
open_threads: 0
round: 2
reviewer: coderabbit reported
reviewer: alice pending
```

```sh
bun ./check-round-converged.ts round-status.txt
# WAIT round=2 open_threads=0 reviewers=1/2 pr_state=open
```

The first three keys are required and appear once; **at least one `reviewer:` line
is required**. A missing key is an error rather than a default, because every
plausible default manufactures the confidence this gate exists to withhold —
including "no reviewers", which is an unenumerated producer, not a settled round.
`round` is **1-based** and `open_threads` is **canonical decimal** — a zero-padded
`08` is octal to bash, so it would kill the comparisons and leave a control-flow
gate emitting no decision at all, which is worse than a wrong one. Produce the
file from your forge per [`mappings.md`](../../mappings.md).

### Why reviewers are named, not counted

A pair of `reviewers_expected` / `reviewers_reported` counts is the obvious design
and it is quietly wrong. Reviewers leave *different numbers of artifacts* behind:
a bot may register a check run **and** post a review, a human posts a review and
nothing else. Any producer that counts settled *signals* therefore double-counts
the bot — so with one bot finished and one human still pending you get "2 of 2
reported" and a confident `CONVERGED` on a review nobody senior has read.

One line per **identity**, each with exactly one state, makes that
unrepresentable. Two consequences fall out for free:

- a repeated identity is an **error**, not a second vote — which is how the
  producer bug surfaces instead of silently inflating the settled count;
- "reported exceeds expected" cannot happen at all, so there is no arithmetic
  sanity check to get wrong.

`WAIT` names who is still out, so the loop's driver can act on it rather than
just knowing a number is short. That output is also the fastest way to spot the
census being built wrong: a name that never settles — a reviewer-registry
*category* like `humans`, or a tool that was never invoked on this PR — shows up
in every round's `WAIT` line instead of quietly holding the loop open.

| Decision | Exit | Meaning |
|----------|------|---------|
| `CONVERGED` | 0 | settled, every reviewer reported, nothing open — the loop may stop |
| `WORK` | 1 | threads to resolve; fix, push, run the next round (the normal case, not a failure) |
| `WAIT` | 3 | nothing open but the round has not settled — do **not** stop |
| `ABORT` | 4 | the PR is no longer open; stop, do not push |
| — | 2 | usage / format error, as in the other gates here |

The precedence is liveness → work-in-hand → settling. A merged PR outranks
everything (every other question is moot). `WORK` outranks `WAIT` because open
threads are worth resolving whether or not the round has finished arriving;
`WAIT` is reserved for the case that actually misleads, an empty thread list.

The decision line goes to **stdout** and the reasoning to **stderr**, so a caller
can act on the line and [M8](../../../M8-learning-loop/)'s
[reflection trigger](../../../M8-learning-loop/reference/reflection-trigger/)
can read the round count straight out of it.

## Where it runs

Not a merge gate — a **loop step**, run by whatever drives the review loop (an
agent skill, a script, a CI job that re-runs per push). Its exit code is control
flow. The merge-blocking half of the contract is the
[unresolved-threads gate](../comment-resolution/); this one keeps the loop that
feeds it honest.

## Files

| File | Role |
|------|------|
| `check-round-converged.ts` | the decision; `STATUS` env or arg selects the input |
| `check-round-converged.test.ts` | paired self-test (all four decisions, the format errors, and the two traps) |
| `fixtures/converged.txt` | settled, nothing open — `CONVERGED` |
| `fixtures/threads-open.txt` | threads to resolve — `WORK` |
| `fixtures/reviewer-pending.txt` | the early-stop trap — `WAIT`, not `CONVERGED` |
| `fixtures/double-counted-bot.txt` | the counting trap — one bot, two artifacts, still `WAIT` at 1/2 |
| `fixtures/work-before-wait.txt` | unsettled *with* open threads — `WORK` |
| `fixtures/pr-merged.txt` | the orphaning trap — `ABORT` |
| `fixtures/pr-closed.txt` | closed without merging — `ABORT` |
| `fixtures/duplicate-reviewer.txt` | the same identity twice — must error, not count twice |
| `fixtures/no-reviewers.txt` | no reviewer named — must error |
| `fixtures/bad-reviewer-line.txt` | an identity with no state — must error, not be assumed |
| `fixtures/bad-reviewer-state.txt` | a state that is neither reported nor pending — must error |
| `fixtures/missing-key.txt` | a key left out — must error |
| `fixtures/unknown-key.txt` | producer schema drift — must error |
| `fixtures/non-numeric.txt` | an unfilled count — must error |
| `fixtures/bad-state.txt` | an unknown `pr_state` — must error |
| `fixtures/empty-value.txt` | a key declared with nothing after the colon — must error |
| `fixtures/empty-then-dup-*.txt` | an empty declaration then a real one — must error as a duplicate |
| `fixtures/round-zero.txt` | `round: 0` — must error; the counter is 1-based |
| `fixtures/leading-zero.txt` | a zero-padded count bash would read as octal — must error |

Run the self-test with `bun test ./check-round-converged.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Jig’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Jig checkout when adopting it.
