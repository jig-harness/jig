# Reflection trigger

The reflection cycle's *when* made mechanical. Session reflection only compounds
if it actually happens, and "reflect when it felt hard" reliably under-fires: the
sessions with the most to say are the ones that end tired and late.

So this fires on an **observable** instead — the number of review rounds a change
took to converge, read straight off
[M7](../../../M7-pr-lifecycle-review/)'s
[convergence gate](../../../M7-pr-lifecycle-review/reference/review-convergence/).
A change that needed many rounds is rarely evidence of a noisy reviewer; it
usually means the scaffolding under-served it — an instruction that did not land,
a rule the reviewer had to teach repeatedly, a convention that should have been
mechanised, a reviewer config that let a known class through. Each of those is a
**lever**, which is what this module's flywheel consumes.

## What it guarantees

| Property | How |
|----------|-----|
| Fires **at** convergence, not afterwards | only a `CONVERGED` decision line fires; the detail is richest as the loop ends and decays once the session closes |
| The record is **aggregable** | the tool writes `change:` and `rounds:` itself, so the inbox answers "which changes fought the scaffolding hardest" — the question that ranks the levers |
| Firing is **calibrated**, not constant | `ROUND_THRESHOLD` (default 3); a threshold of 0 is rejected, because firing on every change is how a reflection habit gets switched off |
| A re-run does not **double-count** | a record already present for that change *and* round count is skipped — and the check-and-append is serialized under a lock, so two concurrent runs *sharing a filesystem* cannot both pass the check (see the scope note below) |
| The record lands **whole or not at all** | the replacement inbox is built beside the real one and atomically renamed into place; a failed write leaves the original byte-identical, so no marker can survive over a truncated record |
| A near-miss cannot write evidence | the decision file must hold exactly one complete M7 record; a partial line, or a stale record above the current one, is an error rather than a firing |
| Shape is not agreement | the decision is re-derived from the record's own fields and must match. `CONVERGED … open_threads=2 … pr_state=merged` is well-formed and self-contradictory — the gate would have said `ABORT` — so it errors instead of laundering a convergence that never happened |

## Mechanism

```sh
CHANGE=PR-482 INBOX=docs/reflection-inbox.md bun ./reflection-trigger.ts decision.txt
# PROMPT change=PR-482 rounds=5 threshold=3
```

`decision.txt` holds M7's convergence line
(`CONVERGED round=5 open_threads=0 reviewers=2/2 pr_state=open`) and **only** that
line — the record is matched whole, so a partial line or a stale record above the
current one is an error, not a firing. `INBOX` must already exist — copy
[`reflection-inbox.md`](../../templates/reflection-inbox.md). This script will not
create it, because a typo'd path that silently swallows records is worse than a
failure.

`ARCHIVE` is optional and wanted in practice. Unset means "no archive"; **set but
unreadable is an error**, not a skip — it is part of the duplicate census, so
quietly dropping it would let an already-processed change be recorded again. A
symlinked `INBOX` is resolved to its target before anything is written, since
replacing the link would leave the canonical file untouched while reporting
success. The inbox is worked down as entries become levers, so the inbox alone only guards a retry that arrives *before* anyone
processed the entry. Move processed entries to an archive rather than deleting
them and the guard keeps holding, because it reads the archive too.

The duplicate check and the append run under a lock on the inbox (a symlink whose
target is the holder's PID — the same atomic technique as
[M12](../../../M12-parallel-agent-ergonomics/reference/resource-lock/)'s resource
lock). `LOCK_TIMEOUT` bounds the wait, default 30s. Three differences from M12's
wrapper, all deliberate:

- **No CI bypass.** M12 skips locking under `CI=1` because each job gets an
  isolated machine. Here a re-run on the *same* runner is a real race, so
  bypassing would remove the guard where it is needed.
- **No automatic stale-lock reclamation.** M12 reclaims a lock whose holder PID is
  gone; this does not. The filesystem API has atomic *create* but no atomic
  *replace-if-unchanged*, so a naive PID-liveness scheme is a read then a delete,
  and two processes racing on the same dead owner can each remove what the other
  just created — ending in concurrent appends, the exact failure the lock exists
  to prevent. M12 closes that race with a claim protocol; this trigger runs
  rarely enough that it stays simpler instead: the wait is bounded and the error
  names the file to remove. A stale lock costs one `rm`; a subtly wrong reclaim
  costs a duplicate record that nothing reports.
- **A foreign lock path is fatal, not cleared.** `$INBOX` is caller-selected, so
  `$INBOX.lock` may hold data this script never created. M12's lock lives under a
  path it owns and can afford to clear leftovers; this one refuses and exits. A
  lock helper that deletes unrelated data to recover is worse than what it
  recovers from.

| Exit | Meaning |
|------|---------|
| 0 | `PROMPT` — a record was written, or an earlier one is still unfilled; run your runtime's reflect command |
| 3 | `SKIP` — not converged, under threshold, or already recorded. **Not a failure** |
| 2 | usage / format error, a contradictory record, a foreign lock path, or a failed write |

Wire it so a skip cannot fail the job — but so **only** a skip is forgiven. A bare
`if …; then` swallows exit 2, and a malformed `decision.txt` then stops reflection
from ever firing with nothing reporting it:

```sh
CHANGE=$PR INBOX=docs/reflection-inbox.md ARCHIVE=docs/reflection-archive.md \
  bun ./reflection-trigger.ts decision.txt && rc=0 || rc=$?
case "$rc" in
  0) <your runtime's reflect command> ;;
  3) : ;;                                     # ordinary review, nothing to do
  *) echo "reflection trigger failed ($rc)" >&2; exit "$rc" ;;
esac
```

Per-runtime wiring is in [`mappings.md`](../../mappings.md).

### What the lock does and does not cover

A PID-keyed symlink serializes processes that **share a filesystem**: several
agents in one workspace, a re-run on the same runner, a resumed session. It does
**not** serialize two isolated CI runners — each has its own checkout and therefore
its own `$INBOX.lock`, so both acquire, both append, both prompt.

The cross-runner guard is the one already in the workflow: the inbox is
**git-tracked**, so the second job's push loses the race and has to rebase, and on
the retry this script finds the marker and skips. That makes the commit — not the
lock — the durable deduplication point, which is the right place for it.

For anything a `PROMPT` then *causes* downstream (an issue, a post, a message), key
it idempotently on `change`+`rounds` rather than assuming reflection ran once. The
trigger can promise at most one record per change and round; it cannot promise one
side effect.

## What it deliberately does not decide

Whether the rounds were the *scaffolding's* fault. "The reviewer was wrong
repeatedly" is itself a finding, and routes to the reviewer's config or its
[eval corpus](../corpus-lint/) rather than to the instruction files. That
judgement is the reflection's job — and the `disposition:` field's. The trigger
only guarantees the question gets asked, while the answer is still available.

## Files

| File | Role |
|------|------|
| `reflection-trigger.ts` | the trigger; `CHANGE` / `INBOX` / `ARCHIVE` / `ROUND_THRESHOLD` / `LOCK_TIMEOUT` env, decision file via arg or `DECISION` |
| `reflection-trigger.test.ts` | paired self-test (the firing rule, the record contents, the repeat-run guard, and 8 **concurrent** runs writing exactly one record) |
| `fixtures/converged-hard.txt` | five rounds — must fire |
| `fixtures/converged-ordinary.txt` | one round — must skip |
| `fixtures/work.txt` | still mid-loop — must skip |
| `fixtures/abort.txt` | the PR was merged out from under the loop — must skip |
| `fixtures/no-round.txt` | a decision line with no `round=` — must error |
| `fixtures/bad-decision.txt` | not one of M7's decisions — must error |
| `fixtures/empty.txt` | no decision line at all — must error |
| `fixtures/partial-record.txt` | right first word, incomplete record — must error |
| `fixtures/multiple-records.txt` | a stale `CONVERGED` above the current `ABORT` — must error |
| `fixtures/contradictory-*.txt` | M7-shaped records whose decision contradicts their own fields — must error |
| `fixtures/zero-reviewers.txt` | `reviewers=0/0` — cannot describe a settled round; must error |
| `fixtures/over-reported.txt` | `reviewers=3/2` — must error |

Run the self-test with `bun test ./reflection-trigger.test.ts` (and run the shared cases with
`bun test ../../../../lib/module-gates.test.ts` from this directory).

The native gate uses the shared implementation in Groundwork’s
[`lib/module-gates.ts`](../../../../lib/module-gates.ts). Keep the module and
`lib/` together in the pinned Groundwork checkout when adopting it.

On Windows, the lock publishes a prewritten owner file through an atomic hard
link, so reflection does not require symbolic-link privileges. On macOS and
Linux it keeps the PID-keyed symbolic link. Both protocols establish ownership
before acquisition, preserve foreign lock paths, and require manual stale-lock
recovery. The eight-process concurrency test runs on every platform.
