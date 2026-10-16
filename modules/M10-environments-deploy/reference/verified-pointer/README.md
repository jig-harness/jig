# Verified-pointer watchdog

Part of [M10 Environments & deploy](../../README.md).

A [freshness gate](../../../../GLOSSARY.md) on a *pointer* instead of a file,
that says *why* the pointer lags and what to do about it. It heals the one
cause a machine can heal, a [dropped trigger](../../../../GLOSSARY.md), within
a budget of attempts; fails on the faults a person must repair (a pointer that
verified but did not move, a stalled runner queue, a diverged pointer, heals
that keep ending without a verdict, an observation it cannot read); and
passes the lags that need nothing (verification running, gates that failed,
only documentation ahead). So a frozen `verified` pointer never quietly ships
stale code.

## Why it exists

The delivery architecture
([`../../templates/CI-ARCHITECTURE.md`](../../templates/CI-ARCHITECTURE.md))
advances an explicit `verified` pointer, a branch or tag, to the newest commit
that passed post-merge verification, and deploys **only** what the pointer
names. That promise holds only while verification keeps up. When it stops, the
pointer freezes while the integration branch moves on, and nothing fails:
verification just stopped happening.

A threshold on how far the pointer trails ("more than 20 commits", "older than
a day") makes that silence loud, but cannot say what to do, and it is wrong in
both directions: a pointer behind a documentation-only tip is fine, a pointer
behind a verification that failed is correctly held, and a pointer behind a
push the CI provider never turned into a run needs verification started
again, which nothing else will do. The same move
[M2](../../../M2-generated-artifact-freshness/) makes for a generated file,
applied to a pointer, with the decision tree a pointer needs.

## The decision

The check reads an observation the workflow collects (the recipes per
provider are in [`../../mappings.md`](../../mappings.md#the-verified-pointer-watchdog))
and gives independent verdicts for the **queue** and the **pointer**. Each is
written as a `key=value` line to the file `--output` names, so the workflow
can branch on it.

| Observation | `queue=` / `pointer=` | Exit | What happens next |
|-------------|------------------------|------|-------------------|
| a verification job has waited for a runner longer than `MAX_QUEUE_WAIT_SECONDS` | `queue=stalled` | 1 | cancel the run that holds the slot and page: the cancel frees the slot, and the missing runner is a capacity fault only a person can repair. No gate is bypassed, since the next run verifies the whole range |
| the pointer is not an ancestor of the tip | `pointer=diverged` | 1 | page; recover with a [back-merge](../../../../GLOSSARY.md), never a force reset |
| nothing ahead of the pointer changes a path verification builds or tests | `pointer=no-code-ahead` | 0 | nothing: the pointer is legitimately where it is |
| verification for the tip is queued or in progress | `pointer=verifying` | 0 | nothing |
| verification for the tip succeeded and the pointer did not move | `pointer=ran-but-stale` | 1 | page: the step that advances the pointer was skipped or is broken. Never re-run, which reproduces the skip |
| verification for the tip failed | `pointer=blocked` | 0 | nothing: the gates held the pointer back, which is what they are for |
| no conclusive run for the tip, and the oldest unverified change is at most `GRACE_SECONDS` old | `pointer=within-grace` | 0 | nothing yet: the run may be on its way |
| no conclusive run for the tip, older than the grace, and fewer than `--max-heal-attempts` heals dispatched at the tip | `pointer=dropped-trigger` | 1 | **heal**: dispatch verification at the tip. The only case the watchdog heals |
| no conclusive run for the tip, older than the grace, and `HEAL_ATTEMPTS` at or over `--max-heal-attempts` (default 3) | `pointer=heal-exhausted` | 1 | page: the heals at this tip keep ending without a verdict, so another dispatch would only repeat them on every scheduled observation. Stop healing until a person repairs why the runs end early |

"No conclusive run" covers both no run at all and a run that ended without a
verdict (cancelled, timed out, never started): either way the gates never
decided. A success is sticky: a later aborted retry does not turn
`ran-but-stale` back into a heal, because running verification again never
fixes an advance step that did not run.

The queue is judged first and both verdicts are always reported: a stalled
queue makes a `verifying` pointer meaningless, and a heal dispatched into a
stalled queue waits behind the stall. The stall rule is
[M13](../../../M13-pipeline-economy/README.md#4-bound)'s: a job timeout counts
no time spent waiting for a runner, so the watchdog bounds that wait; its
[queue-stall check](../../../M13-pipeline-economy/reference/queue-watchdog/)
measures the same wait over every workflow.

## Input

Cause mode takes these keys, as environment variables or as `<KEY> <value>`
lines of an input file (blank lines and `#` comments ignored):

| Key | Value | Required |
|-----|-------|----------|
| `ANCESTOR` | `yes` when the pointer is an ancestor of the tip, else `no` | always |
| `QUEUE_WAIT_SECONDS` | the longest any job of a verification run has waited for a runner; `0` when none waits | always |
| `CODE_AHEAD` | `yes` when `verified..tip` changes a path verification builds or tests | when the pointer is an ancestor |
| `VERIFICATION` | the tip's verification runs: `running` (queued or in progress), `succeeded` (any run passed), `failed` (the newest run failed), `aborted` (the newest run ended without a verdict), `none` | when code is ahead |
| `UNVERIFIED_AGE_SECONDS` | seconds since the oldest code-bearing change in `verified..tip` reached the branch, as the forge recorded the push or merge (never the commit's own timestamp, which says when it was written) | when code is ahead |
| `HEAL_ATTEMPTS` | verification runs the watchdog already dispatched at the tip that ended without a conclusive result | never; absent is `0`, and present but empty is malformed |

The tip is the right commit to ask about because verification covers the whole
`verified..tip` range, never just the tip ([the doctrine](../../README.md#the-watchdog-decides-by-cause)):
a run at the tip verifies every commit behind it, so a dropped push behind a
documentation-only tip is healed by a dispatch at the tip. The age is a
different question, so it is not the tip's: it is how long the oldest change
the pointer lacks has waited. Measured from the tip, pushes that land faster
than the grace window would keep resetting it, and a pointer frozen for days
behind a busy branch whose every trigger is dropped would never leave the
grace.

Threshold mode, for a repository that collects no run state, takes `BEHIND`
(commits the pointer trails the tip, counting only commits that change a
path verification builds or tests) and `AGE_SECONDS` (seconds the oldest such
commit has waited), either or both, against `MAX_BEHIND` (default 20) and
`MAX_AGE_SECONDS` (86400): strictly over either lags (`pointer=lagging`, exit
1); otherwise `pointer=fresh`. It says that the pointer lags, not why.

The settings, `MAX_QUEUE_WAIT_SECONDS` (default 2700), `GRACE_SECONDS` (1200),
`MAX_BEHIND` and `MAX_AGE_SECONDS`, come from the environment, and the heal
budget `--max-heal-attempts` (a positive integer, default 3) from the command
line; all are checked before any verdict depends on them. At a bound is within it; only strictly
over counts.

```sh
bun check-verified-fresh.ts [--output <file>] [--max-heal-attempts <n>] [observation.txt]
```

## Fail closed

The check exits 2, and writes nothing to the output file, on anything it
cannot read: no observation, keys of both modes in one observation, an unknown
key, a value of the wrong shape (a `VERIFICATION` state it does not know, a
negative or non-numeric number, a value beyond 18 digits), a key given twice
in the file or in both the file and the environment, a required key missing,
or a bad setting or heal budget. A collector whose query failed must leave the key out, so
the check refuses, rather than pass a default. The same holds inside the
collector: an ancestry check that errors is not "not an ancestor", and a run
listing that fails is not "no runs".

## Where it runs

A **scheduled** job (every few minutes to hourly), not a per-change gate: it
watches a background process, not a diff. Run it on a runner pool other than
the one it watches, or a stalled pool stalls the watchdog too
([M13](../../../M13-pipeline-economy/reference/queue-watchdog/README.md#what-it-leaves-to-the-team)).
The workflow dispatches verification on `pointer=dropped-trigger`, cancels the
holding run on `queue=stalled`, and fails on every exit 1 except a healed
dropped trigger with a healthy queue (`pointer=dropped-trigger`, `queue=ok`),
which stays green; a check that could not decide (exit 2) fails. So the
verification workflow must accept a manual dispatch, and the collector counts
the watchdog's own dispatches at the current tip that ended without a
conclusive result into `HEAL_ATTEMPTS` (a dispatched run, not a push-triggered
one), each dispatch once however often it was retried, and a dispatch that
ran no verification job at all as one that ended without a result. A success
in any attempt of any run stays sticky: a retry that was cancelled after it
does not turn it back into an abort.
[CI](../../../../GLOSSARY.md) is the authority for running it
([M1](../../../M1-gates-enforcement-ladder/)).

## Files

| File | Role |
|------|------|
| `check-verified-fresh.ts` | the check: cause mode or threshold mode, `--output` for the verdict lines |
| `check-verified-fresh.test.ts` | the self-test: every fixture's exit code, the output lines per cause, the bounds, the settings, the environment and file paths, each fail-closed case |
| `fixtures/cause-no-code-ahead.txt`, `cause-verifying.txt`, `cause-blocked.txt`, `cause-within-grace.txt`, `cause-grace-boundary.txt` | one per cause that needs nothing: exit 0 |
| `fixtures/cause-dropped-trigger.txt`, `cause-aborted-run.txt`, `cause-heal-below-budget.txt`, `cause-heal-exhausted.txt`, `cause-ran-but-stale.txt`, `cause-diverged.txt`, `cause-queue-stalled.txt`, `cause-stalled-and-diverged.txt` | one per cause that must act, and both failures at once: exit 1 |
| `fixtures/cause-bad-state.txt`, `cause-bad-yes-no.txt`, `cause-bad-heal-attempts.txt`, `cause-missing-queue.txt`, `cause-missing-verification.txt`, `cause-mixed-modes.txt` | input the check refuses: exit 2 |
| `fixtures/fresh.txt`, `boundary.txt` | threshold mode keeping up, and exactly at both bounds: exit 0 |
| `fixtures/lagging-behind.txt`, `lagging-age.txt` | threshold mode over either bound: exit 1 |
| `fixtures/bad-value.txt`, `huge-value.txt`, `duplicate-key.txt`, `unknown-key.txt`, `empty.txt` | threshold-mode input the check refuses: exit 2 |

Run the self-test with `bun test ./check-verified-fresh.test.ts`. The check
imports the command-line boundary and the findings format from the Jig
repository's `lib/`, so run it from a pinned Jig checkout or vendor `lib/`
with it.

## Known limits

It judges an observation the workflow collected; it does not itself talk to
git or the CI provider. A collector that answers from the wrong ref, or
reports `VERIFICATION none` because its query returned nothing it could read,
misleads it. The heal budget holds only while the collector counts the
watchdog's own dispatches at the current tip: a collector that loses that
count, or leaves `HEAL_ATTEMPTS` out, heals on every observation again.
Keep the collector beside the check, make each of its reads fail closed, and test it the way the mappings' recipes are written to be tested.
