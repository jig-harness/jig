# Terminal states, exit codes, and the evidence behind each

`drive-status.ts` is the only thing in this skill entitled to say a PR has
converged. This file is the contract it implements: what each state means, what
evidence produced it, and — for the states that look identical from a thread
count alone — which measured failure each guard exists to prevent.

## Exit codes

`drive-status.ts` and `drive.ts` share one numbering, so a caller never parses
prose to know what happened. `drive.ts` maps a converged drive to `0` (a
successful run) — after certifying its own working tree is clean, since exit
`0` is the signal an operator merges on and an edit no round shipped would
otherwise die silently with the worktree — and leaves every other code
verbatim.

The canonical (exit, state) pairing below is code, not this table:
[`terminal-states.ts`](../scripts/lib/status/terminal-states.ts), checked
against this and the other prose restatements by
[`__tests__/terminal-states-consistency.ts`](https://github.com/jig-harness/jig/blob/main/plugin/skills/drive-pr/__tests__/terminal-states-consistency.ts).
A backtick-wrapped **State** cell names a real `state` value (or, on row `4`,
the five that share that exit code — `4` has no `state` of its own); an em
dash means the row does not identify a single canonical state. Usually that is
because the code carries none at all — `drive.ts` returns it directly, outside
`drive-status.ts`'s `--json` report entirely — except row `10`, which is
reserved and never emitted (see that row). Row `11` is a second, different
exception: `drive-status.ts`'s own lease check *does* set `report.state =
'SESSION_LEASE_HELD'` for it in some paths, but the same exit is also raised
directly by `drive-state.ts`, `reply-to-thread.ts` and `answer-summary-
finding.ts` for mechanisms that never populate that report at all (see that
row) — so the table cell stays an em dash because no single name covers every
path that produces the exit, not because none of them name one.

| Exit | State | Terminal? | Meaning |
|---|---|---|---|
| `0` | `ROUND_READY` | no | Unresolved threads and/or unaddressed summary-only findings exist. On a mergeable head the reviewer gates below also proved it reviewed that head; on a **conflicting** one they are skipped, so the findings may predate it — the `reason` and `reviewer.reviewedSha` say which (§ 14) |
| `3` | `CONVERGED` | **yes** | Every convergence condition below holds |
| `4` | `HEAD_LAG` / `AWAITING_REVIEWER` / `STALE_REVIEW` / `HEAD_MOVED` / `MERGEABILITY_UNKNOWN` | no | Not judgeable yet. With `--once` this returns immediately; otherwise after `--timeout`. `drive.ts` also reuses this code for a case `drive-status.ts` cannot see: the reviewer converged, but the Ready-mark lease is held by another driver — `claimed-by-other` is not proof that driver will finish, and reporting `0` would claim a still-draft PR that the draft-skipping reviewers have never seen is done (§ A draft PR is reviewed, and then marked Ready). And for a second such case: the reviewer converged, nothing is failing, and no fresh exact-head required-check witness arrived within `DRIVE_PR_FINAL_CI_WITNESS_POLLS` polls (default 180 × 10s = 30 min, `0` waits forever) — a required check whose fresh run completed `skipped` is passing to the aggregate verdict and no witness here, and no amount of waiting converts one into the other, so the drive names the rerun and hands back rather than sleeping until a human notices |
| `5` | `PR_NOT_OPEN` | **yes** | Merged or closed. Checked first, every pass |
| `6` | — | **yes** | `drive.ts` only: hit `--max-rounds` without converging |
| `7` | `REVIEWER_FAILED` | **yes** | The posting reviewer's check-run did not pass |
| `8` | `HITL_PARKED` | **yes** | Everything still open is parked awaiting a human. The drive never wakes itself up: a re-arm unparks the items, and hands their answers to its passes until one completes, only once **every** one has an answer from an owner, member or collaborator later than the park (§ Picking up a stopped drive); with any unanswered it stops `8` again |
| `9` | `PR_CONFLICTING` | **yes**, from `drive.ts` only once its conflict-repair budget is spent | The PR conflicts with its base **and** has no workable findings. A conflict alone does not stop the loop — see mode 14. `drive.ts` first spends `DRIVE_PR_CONFLICT_REPAIR_ROUNDS` (default 1) `conflict-resolve` passes on it (§ Repair rounds) |
| `10` | — | — | **Reserved**, never emitted. A draft PR is not a stop: drafts are driven — see § A draft PR is reviewed, and then marked Ready. The code is kept unused so it never takes on a second meaning |
| `12` | — | **yes** | `drive.ts` only: the review converged, but the worktree is not clean — uncommitted state, an unconcluded merge/cherry-pick/revert/rebase/am (present even over an otherwise-empty `git status`), local HEAD no longer matching the reviewed head (a commit landed here that was never pushed or reviewed, also invisible to `git status`), or any of those probes being unreadable; every one of them fails closed to the same refusal. The convergence is real; the leftovers are edits no round shipped, an unfinished git operation, or an unreviewed local commit. Commit/push/discard as appropriate, or resolve/abort the operation, then re-run. The draft→Ready transition sits **behind** this gate, so a PR still owed that transition when 12 fires stays a draft, and the retry after the cleanup marks it. It never *reverts* one already made: `mark-ready.ts` runs at the end of every completed round from the round `pull_requests.mark_ready` declares (default `1`) and is durably once-only, so a drive that completed that round has already marked the PR and exit 12 leaves it Ready over an unclean tree. The PR is still a draft, then, when no completed round reached the declared one (convergence before it, including at the very first gate), when the repository marks Ready only at convergence (`converged`), or when it never does (`never`, or a drive started with `--keep-draft`, which skips `mark-ready.ts` entirely no matter how many rounds run) — in the last case the draft state is the requested outcome, not a transition still owed — see § A draft PR is reviewed, and then marked Ready |
| `11` | — | **yes** | `drive.ts` only: a single-instance lock is already held — either this PR's (`pr-drive-<PR>.lock`) or this working tree's (`pr-drive-worktree-<key>.lock`), both in the clone-wide state dir, so a driver in another managed worktree of the same clone collides too. The drive is already armed. The refusal names the holder's `drives.ts` `--doctor` verdict and, when that verdict admits a takeover (`WEDGED`), prints the `--take-over` command; do not stop a driver that is making progress (§ Picking up a stopped drive). `drive.ts` with `--take-over` refused for the holder's verdict, or for a dead holder's leftovers, exits `11` too. `drive-state.ts` raises the same code for its own **session lease** over *(working tree, PR)* when a second live agent session in one checkout attempts a state mutation — a different mechanism with the same exit — and for its **tree lease** when that second session is driving a *different* PR from the same tree, which the per-PR lease alone cannot see. `reply-to-thread.ts` and `answer-summary-finding.ts` raise it too, refusing to `POST` rather than refusing to write state — both check **both** fences, the per-PR session lease and the tree lease, so either one can produce this refusal — `reply-to-thread.ts` through the spawned `assert-post-allowed.ts` (it lives in the sibling skill), `answer-summary-finding.ts` through `lib/state/lease.ts` directly (it lives in this one). All of these — a *live* conflicting holder — name that holder's pid; confirm that process is gone before clearing either. Two exceptions, both on the tree lease, neither naming a pid because neither has a live holder to name: the unreadable-but-fresh case (a file that exists but cannot be parsed as a lease, mirroring `unreadableLeaseFilesFor`'s fail-closed ruling for the PR-wide gate) points at the path instead; and `assertTreeLeaseUnchanged`'s "the lease is simply gone" case (an admitted lease that no longer exists by the time the fence re-checks — `clear-lease` is the common cause but not the only one an operator could have caused, so the message deliberately does not guess which) |
| `13` | `DRIVE_HELD_BY_OTHER_WORKTREE` | **yes** | Another live **working tree** is driving this PR, and this one attempted a state mutation. Raised by `drive-state.ts`, propagated by `drive-status.ts`, and raised by `drive.ts` at its own round-opening `bump-attempt` — the worktree/PR locks above do **not** subsume it, because those are only ever held by another `drive.ts` and an interactive pass in another tree takes no lock at all. The cross-tree twin of `11`, and deliberately not the same code: `11` names a session in the reader's own tree, which they can see and clear where they stand, while `13` names a tree they are not in — and whose driver is very likely the one that should finish. The refusal carries that tree's path, and — when the holder is a session rather than a working tree — its pid and the platform's own liveness check. It **self-clears**: the gate is derived from the live lease set by the same `leaseAlive` test the session lease uses, so a dead or idle worktree never wedges the PR. Inspect with `bun "<skill-dir>/scripts/drive-state.ts" lease <PR> --all`; take the PR over deliberately — the only route that reaches a tree you cannot stand in — with `bun "<skill-dir>/scripts/drive-state.ts" clear-lease <PR> --all`. Reading the drive is never gated, from any tree. `drive.ts` raises it at arm for a tree in **another clone**, which no lease reaches: when the drive ledger names a running driver there, the arm is refused, naming its heartbeat's age and, once that is past the lease window, the `--take-over` command (§ Picking up a stopped drive) |
| `1` | `INDETERMINATE` | **yes** | The state could not be read. Never reported as settled. `drive.ts` also reuses this code for two cases `drive-status.ts` itself never produces: a round-agent pass that returned a nonzero exit other than `5` (mapped straight to `1` — the agent's own logs are the recovery path), and a **second consecutive** failed or unconfirmed `mark-ready.ts` call after a completed round. The latter's recovery depends on why it failed: an ordinary failure is cleared with `bun "<skill-dir>/../../shared/command.ts" -- gh pr ready <PR>` by hand, but a repeated `claimed-by-other` is an orphaned Ready-mark lease and needs `bun "<skill-dir>/scripts/drive-state.ts" release-ready-mark <PR>` — never `gh pr ready` directly, which fires the remote transition the lease exists to hold once |
| `14` | — | **yes** | `drive.ts` only: the loop **stalled** — `$DRIVE_PR_STALL_ROUNDS` (default 2, `0` disables) consecutive completed passes changed nothing observable: the reviewed head did not move, local HEAD (measured in the driven tree) did not move, and the unresolved-thread, summary-finding and parked **key sets** came back identical — set equality, not equal counts, because thread A resolved and thread B posted leaves the count untouched across a round that did real work. A pass that exits 0 without acting — the measured case is a pass standing down after mistaking its own parent driver for a competing drive — otherwise burns the whole `--max-rounds` budget while every round header looks like progress, and the exhausted-budget `6` then reads as "the reviewer kept finding things". This stop fires early and names what did not happen instead, after **one extra round**: the first time the streak reaches the threshold the driver runs one more pass with the stand-down diagnostics in its notice (`$DRIVE_PR_PASS_NOTICE`), and stops only when the gate after it reads the same fingerprint again, printing what the passes recorded deciding at the end of the handoff narrative. Recovery: **read the leftover report first** — the stop prints what the driven worktree still holds (uncommitted paths, an unconcluded git operation such as a stray `MERGE_HEAD` even over an otherwise-clean porcelain status, a positive "clean", or "unreadable"; never silence), because a pass can make substantive, correct edits and still trip this stop by standing down before committing them, and the stall predicate keys on head/threads/findings, none of which an uncommitted edit or a dangling merge state moves. Recover that work before anything that discards state; then read the pass output for what it decided, fix why it did not act, re-arm. A *different* code from `13` deliberately: `13` names another working tree owning the PR (recoverable by waiting or handing off), and `14` names this pass being stuck (recoverable by reading its own output) — sharing one code would collapse a distinction a caller reading the exit alone needs. See § 8 |
| `15` | `PASS_DEADLINE` | **yes** | `drive.ts` only: the pass hit `$DRIVE_PR_PASS_TIMEOUT` (default 5400s = 90 minutes; `--pass-timeout`, `0` disables) and drive.ts sent its process tree a kill signal. **The one stop in this loop that can fire while a round is still in flight**, which is the gap it exists to close: `--max-rounds`, the stall streak (`14`) and the status poll's `--timeout` all fire only *between* rounds, while the driver's claim heartbeat keeps refreshing from a timer throughout — so a pass that never returns waits forever and `drives.ts` reports it *live* and healthy the entire time (measured: a pass dead mid-`git merge`, the driver polling 24 minutes for a head change that could never arrive). Distinguished from a pass that merely *exited* 124 by `RunResult.timedOut`, never by the code, since the pass is an arbitrary command whose exit space is its own. Termination is then re-witnessed (`passHandle.stop()`) before the locks are released — a descendant in uninterruptible sleep survives the signal, and the POSIX witness (`groupGone()`, polling `kill(-pgid, 0)`) correctly keeps the locks held rather than reporting the tree gone in that case. A group whose only remaining member is a *zombie* — unreaped under a container PID 1 that does not reap orphans — would strand this witness for the full window too, since `kill(-pgid, 0)` cannot tell a zombie from a running process; `hasLiveGroupMember()` (`lib/proc.ts`) therefore checks each member's actual state and reports the group gone once nothing left in it can act. A descendant that itself escaped the process group (`setpgid`/`setsid`) is a *separate*, still-open **known gap, not a covered case**: `kill(-pgid, 0)`, and `hasLiveGroupMember()`'s own per-member scan alike, answer about membership of the *original* group only, so an escaped survivor is invisible to either and `stop()` can report a false witness. **A witnessed kill is restarted from**: the driver runs the two checks below itself, prints what they find, leaves it in the tree, resets the stall streak (a killed pass is not a completed one) and starts the next round, whose pass is told what it inherits. A committed-but-unpushed leftover puts local HEAD ahead of the PR head, so the driver records that HEAD after the kill and passes it to every gate until a pass completes (the gate's `--inherited-head` flag): the head-sync guard accepts exactly that HEAD when the PR head is its ancestor, and reports `HEAD_LAG` for any other mismatch; the round is judged on the PR head, and where no live work is left, `CONVERGED` or `HITL_PARKED` is handed out as `ROUND_READY` instead (`PR_CONFLICTING` still goes to its repair pass), so a pass pushes them rather than the drive ending over them. Restarts happen up to `drive.pass_deadline_retries` (default 2) per drive, counted in the drive state (`deadlineRetries`) so a re-arm or a takeover shares the budget, and cleared when the drive converges or the PR closes. This exit is the deadline recurring past that budget, and the stop says the budget is spent; an unwitnessed termination exits here at once, locks held. **Recovery: a witnessed-killed pass was not rolled back.** Check `bun "<skill-dir>/../../shared/command.ts" -- git status --short` for an uncommitted fix and `bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count 'origin/<head-branch>..HEAD'` for a committed-but-unpushed one before re-arming — the same checks exit `14` and a `HEAD_LAG` death need, and for the same reason: each is a pass ending somewhere in the fix→gates→commit→push sequence. Widen the deadline if a legitimate round reaches it; it is a backstop against a wedge, not a budget |
| `16` | `QUOTA_PARKED` | **yes** | `drive.ts` only: the pass died on a subscription usage wall that will not reopen within the sleep bound. **Not a failure of the drive loop or of `drive.ts` itself** — nothing about the PR or the mechanism needs fixing, and reporting it as `1` would send an operator to read a pass that did nothing wrong. That does not mean the *working tree* is necessarily clean, though: the pass could have modified or committed locally before it hit the wall. **Recovery: check for that leftover work before re-arming.** Check `bun "<skill-dir>/../../shared/command.ts" -- git status --short` for an uncommitted fix and `bun "<skill-dir>/../../shared/command.ts" -- git rev-list --count 'origin/<head-branch>..HEAD'` for a committed-but-unpushed one — the same checks exit `15` needs, and for the same reason: a pass can end anywhere in the fix→gates→commit→push sequence. Detected by `lib/quota/`, one adapter per vendor, from the vendor's own durable record rather than from the pass's stdout (which `drive.ts` deliberately does not capture): for Claude Code an `{"error":"rate_limit","apiErrorStatus":429}` transcript entry reading `You've hit your session limit · resets <clock> (<zone>)`; for Codex a `token_count` event carrying `used_percent`, `window_minutes` and an absolute `resets_at`. A **short** window whose reset resolves inside `$DRIVE_PR_QUOTA_MAX_SLEEP_SEC` (default 6h) never reaches this code at all — the driver sleeps through it, locks held and refreshing, and resumes. This code is every other case: a weekly window, an unclassifiable one, a reset that could not be resolved, or one beyond the bound. A reset already in the past is deliberately NOT one of them: `planFor()` clamps it to `sleep(0)` and the driver retries immediately, since the window is open right now, not merely likely to be. The asymmetry is deliberate — sleeping when it should have stopped strands a drive and its locks for days; stopping when it could have slept costs a re-arm — so every uncertainty resolves here. **Do not dispatch a successor session on the same account in this state**: one on the same subscription is behind the same wall, so a handoff converts one parked drive into two. The park records the wall's account (hashed, `accountHash`), the exit names it and prints the re-arm command, and `drive.ts` admits a re-arm while the wall is in effect only for a pass that bills a different, known account; it refuses (exit `16`) when either side is unknown or both are equal. After the reset any account may re-arm; `--window-reopened` is a person's statement that an unresolved window is open again (§ Picking up a stopped drive). The `.context/pr-drive-<PR>.md` trail is unaffected and stays current — it is written at the top of every round, and it is what makes that re-arm cheap. The round it consumed is not refunded, because unwinding a durable counter from a failure path would mutate the state the loop's own bounds are read from |
| `18` | `MAILBOX_STOPPED` | **yes** | `drive.ts` only: a mailbox `stop` was observed at a round boundary. A pass already running finishes and completes its post-round bookkeeping before the stop takes effect; no new pass starts. Normal exit releases the drive locks. Resume the stop directive before re-arming |
| `19` | `MAILBOX_PAUSE_TIMEOUT` | **yes** | `drive.ts` only: a mailbox `pause` stayed active for `$DRIVE_PR_PAUSE_MAX_SEC` (default 1800 seconds). The driver held and refreshed its locks during the wait, then exited and released them. Resume the pause directive and re-arm. An unreadable mailbox instead fails closed with exit `1`; `stop` takes precedence over pause |
| `20` | `TAKEN_OVER` | **yes** | `drive.ts` only: another clone took the drive over. At a round boundary the driver read a takeover claim in force on the PR, from another clone, newer than its own position (its own claim, or the newest claim in force when it started), and stopped without another pass, so it never replies beside its successor; it writes no further ledger. A `--take-over` whose own claim lost to a rival's earlier claim on the same ledger generation stops with it too. Nothing to recover here: that clone drives now. Re-arming beside it is refused with exit `13` while the ledger names it running (§ Picking up a stopped drive) |
| `2` | `UNSUPPORTED_CLI` | **yes** | A `gh` that cannot report every required PR field, including draft state and mergeability. Reported through the JSON contract; an argument error, which precedes any PR to describe, exits without one |

The JSON report (`--json`) carries `state`, `exit`, `reason`, the head pair, the
`base` block (`refName`, `oid`, `drift`), the `merge` pair (`mergeable`,
`stateStatus`), the reviewer's identity/status/reviewed-SHA, the work counts,
and a `ci` verdict.

`base.drift` is the one field in the report that is **not** an input
to any verdict. It is measured once per *counting* invocation — `--no-count`
re-reads (`finish-round.ts`'s head-sync wait, `announce-merge-ready.ts`) report
`null` and pay no network round-trip for it, the same rule the replied-thread
sweep uses and for the same reason: neither is a round that could act on drift.
Every failure — an unresolvable merge-base, a `gh` that never reported a base
ref, an unreadable worktree — also degrades to `null`, never to a zeroed
measurement, because a zero there is the positive claim "the base has not
moved". A failed `git fetch` is the one degradation that still produces a
measurement: it is carried in `drift.fetched: false`, and every line derived
from it says so, since the numbers were then read off a remote-tracking ref of
unknown age. What the fields mean, and why `overlapCount` rather than `behind`
is the predicate a round acts on, is in `scripts/lib/base-drift.ts`.

Every count under `work` is **`null` when `evaluate()` never measured it**, and a
number only when it did. The liveness, head-sync and reviewer gates all return
before anything is enumerated, so a report from one of them has nothing to say
about open work — and `0` there is a claim, not a silence: initialised to
zero, an `AWAITING_REVIEWER` report would read `unresolvedThreads: 0` while
threads are live. A consumer that treats `null` as `0` reintroduces exactly
that.

## Repair rounds

Two stops name work the loop can do itself, so `drive.ts` spends a bounded
budget of **repair passes** on each before taking the stop. Neither changes what `drive-status.ts` returns or what
any code *means* — this is entirely about whether `drive.ts` hands a given answer
to a human or to a pass.

| Trigger | Pass | Budget (env, `0` disables) | Falls back to |
|---|---|---|---|
| Converged head, fresh exact-head verdict `failing: …` | `ci-repair` (repair the failing checks) | `DRIVE_PR_CI_REPAIR_ROUNDS`, default 2 | exit `1`, handing the red CI back for repair |
| `PR_CONFLICTING` with no workable finding | `conflict-resolve` (`base-sync.ts`, then resolve the conflict) | `DRIVE_PR_CONFLICT_REPAIR_ROUNDS`, default 1 | exit `9`, with its `Fix:` command |

The task reaches the pass in its **environment** (`DRIVE_PR_ROUND_TASK`,
`DRIVE_PR_ROUND_TASK_DETAIL`), never by rewriting the argv after `--`: that
argv belongs to whichever agent the operator armed the drive with, and a driver
editing it would be guessing at another tool's command grammar. `SKILL.md` § 0
is the pass-side half. `passEnv()` **deletes both variables before setting
either**, so an ordinary review round can never inherit a repair task — from
this driver's environment or an operator's shell — and skip triage believing
itself a repair.

Properties worth stating because each closes a way this could go wrong:

- **A repair kind that cannot state its own task declines the budget.** On the
  CI side that is a verdict naming no failing check; on the conflict side it is
  an unreadable base ref name, where dispatching a pass would have to guess the
  base branch — the guess the operator-facing message deliberately does not
  make — one level further away where nobody can see it being made.
- **Only positively-named failures spend CI budget.** `failing: …` yes;
  `unknown:` and an unparseable report no. Those are absences of evidence, and
  a CI-repair pass handed no run and no check name has nothing to work from.
- **A repair re-gates from the top, never re-checks in place.** A repair that
  pushed moved the head, staling `reviewedHead` and every witness gathered
  under it — the reviewer's own stamp included. Rebuilding that evidence is
  the loop head's job alone.
- **A failed repair pass falls straight through to the stop.** It does not
  retry, and it does not park: the operator gets the same stop a drive with
  no repair budget would give, one pass later.
- **The budgets are in-memory, so a re-armed drive gets fresh ones.** Same
  semantics as the `noopRounds` stall streak, and for the same reason: a
  `DriveState` field would be *refused* by `isUsableState` on every file written
  before it existed, stopping every in-flight drive on the fleet at its next
  state read.

A repair pass deliberately does **not** get the quota handling a review round
gets. One that dies on a subscription wall is an ordinary failed pass, and the
drive takes the fallback stop rather than parking — a deliberate limit of
the repair path, which leaves the review round's own quota handling intact.

## What `CONVERGED` requires

`drive-status.ts` exit 3 is the review verdict described below. The unattended
`drive.ts` deliberately has a stronger exit-0 contract: every required check
must have completed on the exact head, and if it applied the repository's CI
hold label during intermediate rounds, it must still own the newest labelled
timeline event, remove that label, and observe successful exact-head required
checks whose runs started after the `unlabeled` event and whose ids exceed the
pre-unlabel watermark, plus an overall green non-reviewer-CI verdict. Until
then the PR remains visibly held/non-green and
the PR-global `verifiedSha` does not advance. A human remove/re-add makes the
new event externally owned; the driver never removes it.

All of these, simultaneously (1 and 2 only where the repository names an AI
reviewer, [below](#the-reviewer-is-identified-by-app-slug-not-by-check-name)):

1. The **posting reviewer's** check-run exists for the current PR head, with
   `status: completed` and a conclusion that is not a failure and not `skipped`
   — **or** the check-run is `in_progress` and the stranded-check-run bypass
   below applies. That is the one exception; every other non-`completed`
   status still blocks.
2. The reviewer's **recorded reviewed-SHA** equals that head — read from the
   `ai-reviewed-sha` marker in its own sticky comment, which must be **present**.
   The check-run fallback below is enough to work a round on; it is not enough
   to declare one finished.
3. **Zero** unresolved review threads (scoped by `--bots-only` when given).
4. **Zero** unaddressed summary-only findings.

If any parked item remains while 3 and 4 are otherwise satisfied, the state is
`HITL_PARKED`, not `CONVERGED`.

## The reviewer is identified by app slug, not by check name

The repository's `review.reviewer_app`
([README.md § Consumer configuration](../README.md#consumer-configuration)),
overridden by `DRIVE_PR_REVIEWER_APP`, names the GitHub App that posts
findings. Names are decoration and there are decoys: a repository can carry a
dormant reviewer workflow owned by `github-actions` whose `if:` gate is off,
so it concludes `SKIPPED` forever while matching every reasonable
reviewer-name pattern. The app slug separates the identity that actually posts
findings from every reviewer-*shaped* check that does not.

The app slug alone is not the whole identity, though: one app may publish
several checks on a SHA, and a sibling's success must not attest a review the
posting check never performed. So the reviewer is the pair `(app, check name)`,
and `DRIVE_PR_REVIEWER_CHECK` is matched as an **anchored** regular expression
(default `^ai[ _-]?review(\s*\(.+\))?$`) that tolerates a parenthesised arm
suffix and nothing else. Unanchored it would be a substring match, so a sibling
named `AI review telemetry` would rejoin the very set the pair exists to split.

With neither an app nor a check pattern configured, **no reviewer is
expected**: every reviewer gate in this section is skipped, no reviewer
check run, sticky comment or stamp is read, and a check named like a reviewer's
is an ordinary check in the CI verdict. `CONVERGED` then needs only the zero
unresolved threads and zero unaddressed summary findings below, and says in its
reason that no reviewer was configured.

With no app configured but a check pattern, the name is the whole identity: a check run matching
`DRIVE_PR_REVIEWER_CHECK` from any app counts, and the reviewer's sticky
comment is accepted only from a login listed in `review.bots`. That cannot
separate the decoy above from the real reviewer, so configure the app wherever
the reviewer is one.

Override for another reviewer:

```bash
bun "<skill-dir>/../../shared/command.ts" --env DRIVE_PR_REVIEWER_APP some-other-review-app --env DRIVE_PR_SHA_MARKER reviewed-sha -- bun "<skill-dir>/scripts/drive-status.ts" 123 --json
```

## The stranded-check-run bypass

Measured live: the posting reviewer's check-run for one head sat
`in_progress` for 3.5+ hours (a transient 503 on the completion `PATCH`), while
the review had already published — its sticky named that exact head, plus three
inline threads and a two-entry wind-down backlog. `drive-status.ts` reported
`AWAITING_REVIEWER` and kept reporting it: an unattended drive burns its
`--timeout` every round, never reaches a terminal state, and nothing
distinguishes "genuinely still reviewing" from "stuck" — the same
not-yet-vs-never gap as mode 4 above.

The fix does not invent a new trust assumption — but be precise about which
branch establishes the precedent, because it is **not** the no-check-run one.
That branch (`reviewer === null` in `evaluate.ts`) returns `AWAITING_REVIEWER`
immediately and never reads a sticky at all. The precedent is the **main-line
reviewed-SHA gate further down**, which resolves the reviewed head from the
sticky's `ai-reviewed-sha` marker (`reviewedShaSource: "comment-marker"`) and
which `CONVERGED` already certifies against — the marker is not a weaker
witness the gate distrusts, it is one already used, just never when a
check-run exists but is stuck. So when the check-run reads `in_progress`
specifically (never `queued`, which has not started at all — there is nothing
yet a marker could have overtaken), the gate reads the sticky and proceeds
past the block **only** when all of the following hold:

1. Its `ai-reviewed-sha` names **this exact head** — a prefix match is not
   enough, the same rule the main-line reviewed-SHA gate applies; a marker
   naming an *older* head means the review really is still running, and the
   block stays.
2. Its `ai-review-round` is **strictly greater** than `bun "<skill-dir>/scripts/drive-state.ts" rounds
   <PR>` — the count of heads *this drive* has already dispatched a round for.
   **This is weaker than it reads, and deliberately kept anyway.** The two
   counters answer different questions: `rounds` is per-drive and restarts at
   zero whenever a fresh drive starts on the PR, while `ai-review-round` is
   cumulative over the PR's **whole life** — the exact mismatch § "The
   reviewer stops after roughly thirteen or fourteen rounds" documents for
   `--max-rounds`. On any PR carrying pre-drive reviewer history (an earlier
   drive, `resolve-review-comments` passes, plain human pushes — the normal
   case) `sticky.round > counted` is close to always true, so this condition
   mostly just rejects a roundless or malformed sticky rather than proving
   the marker is fresher than something this drive has already consumed. Kept
   because it costs nothing when it does fire; conditions 1, 4 and 5 are what
   actually carry the safety margin.
3. Its `ai-reviewed-sha` and `ai-review-round` are read **off the same
   comment**, in one fetch (`reviewerStickyMarkers` in `lib/status/evidence.ts`,
   reused — not re-fetched — by the reviewed-SHA gate further down when the
   bypass ran), so an edited-in-place sticky (the reviewer edits its one
   sticky each round rather than posting a new one) cannot pair a fresh round
   from one read with a stale SHA from another, and the bypass's own snapshot
   can never disagree with what the gate below judges.
4. **The sticky itself** was last updated (`updated_at` on that same comment)
   at least `$DRIVE_PR_STALLED_MIN_AGE_SEC` ago. The default is
   `STALLED_MIN_AGE_SEC` in `lib/status/evaluate.ts`, which owns both the value
   and the reasoning for it; a non-positive or non-numeric setting falls back
   to that default rather than disabling the floor, because coercing an empty
   or negative value to `0` would switch the whole guard off while reading like
   it had set a bound.
   A review publishes its sticky and its inline threads as **separate,
   non-atomic** GitHub calls (publication is a multi-step sequence, not one
   atomic write). Reading between those steps
   would see a matching, round-advanced sticky with **zero** threads yet
   posted and reach a false `CONVERGED` — condition 2 cannot catch this,
   because a live review's round is legitimately newer than what this drive
   has counted. That window is seconds-to-low-minutes in the worst case; the
   measured incident this bypass exists for was 3.5+ hours stranded.

   The floor therefore has to age the **evidence**, not the run. Flooring the
   check-run's own `started_at` does
   not exclude that window at all: the stranded run is by definition hours
   old, so it clears any run-age floor no matter how recently the sticky was
   rewritten, which is precisely the read the floor was meant to reject. Because condition 5 forces the sticky to
   post-date the run's start, a sticky old enough to clear this floor implies
   a run at least as old — so the run-age guarantee is kept, not traded away.
5. That sticky **post-dates the current run's own `started_at`**. Condition 1's
   exact-SHA pin does not imply this, and this is the condition that binds the
   evidence to **this** check-run attempt: a re-run on an **unchanged** head
   never rewrites `ai-reviewed-sha`, so a sticky from an earlier,
   already-completed review of this very head still names it. With condition 2
   near-vacuous (above), such a stale sticky would satisfy every other
   condition the moment the re-run crossed the age floor, authorizing
   convergence on evidence the current attempt never produced. A run whose `started_at` is
   missing or unparseable fails this condition and keeps blocking — the
   fail-closed direction.

When the bypass fires, `evaluate()` proceeds exactly as it would with a
genuinely completed check-run — reaching `ROUND_READY` when work remains,
`CONVERGED` when it does not, or `HITL_PARKED` if every remaining item is
parked — and the terminal `reason` names the discrepancy explicitly (`…
check-run on <head> reads 'in_progress' (running Ns), but its sticky — last
updated Ms ago, after that run began — already records round N reviewing this
exact head (M round(s) counted so far) — trusting the comment-marker witness
over the stranded check-run`), so the operator can see which witness was used,
and how old it is relative to the run it overruled, rather than reading a
report identical to an ordinary clean completion.

Deliberately NOT covered: a check-run that is `in_progress` with no sticky at
all, one whose sticky names an earlier head, and one whose sticky predates the
run's own start (a re-run on an unchanged head), all keep blocking (see mode
2c in `__tests__/drive-pr-status-convergence-evidence.test.ts`) — the bypass must not race a review
that is genuinely still running. Also not built: naming the stall itself (a
`REVIEWER_STALLED` state once a check-run has been `in_progress` past some
multiple of its observed duration). Opt-in `JIG_TRACE` spans record drive and
command durations, but a reviewer-stall policy still needs to distinguish a
slow reviewer from one that will never finish.

**And one residual the floor cannot close, stated rather than implied.**
Elapsed time is not a completion witness. Condition 4 proves the reviewer's
non-atomic publish sequence had *time* to finish; it cannot distinguish "slow,
but will finish" from "the worker died after writing the sticky and will never
post its threads". In that second case `unresolvedThreads()` legitimately
returns zero, and a long-enough wait ends in a bypass over findings that were
orphaned rather than absent. What actually repairs it is the reviewer service,
not this drive: a reviewer service can publish through an
outbox, and a reconciliation pass reactivates a head still missing its
`posted` record. The floor's default is therefore derived from how long that
repair can take in the *worst* case, so the drive waits for it instead of racing
it — the reactivation threshold, plus one full pass interval (the threshold is
only evaluated when a pass runs), plus one review's publication time (a
reactivated head has not rewritten its sticky or posted its threads until it
publishes). `STALLED_MIN_AGE_SEC` in `lib/status/evaluate.ts` owns that sum and
names each term; do not restate the number here. A shorter floor — one under
the threshold, or one that clears the threshold while dropping the other two
terms — leaves the same false convergence reachable later rather than closed.
Past that, a reviewer service whose repair fails permanently has to raise it to
a human; that alarm, not this constant, is what bounds the remaining case. A
reviewer deployed differently needs a floor derived from its own repair path.

## The false-convergence modes, and the guard for each

Each of these is an observed way for a status check to report exit-3
"converged" while findings are live. Each has a
probe in the `<skill-dir>/__tests__/drive-pr-*.test.ts` suite.

### 1. Summary-only findings create no thread

The reviewer emits findings it cannot anchor to a diff line in its sticky
comment — in the `ai-review-backlog` blob, or as body bullets whose path never
received an inline comment. Thread count is `0` while a real medium finding is
live, and there is no `threadId` to reply to.

**Guard**: `summary-findings.ts` enumerates them from the backlog blob, from
unanchored body bullets, and from the reviewer's own "N finding(s) without a
diff-anchorable line" declaration when it exceeds what was classified; and
`drive-status.ts` counts unaddressed ones as open work. Answered via
`answer-summary-finding.ts`, which writes a `drive-pr-addressed` marker the
enumerator reads back — addressed-ness is never inferred from prose. A
*fix-dependent* marker (`accepted`, `moot`) is additionally scoped to the SHA its
change landed on and stops counting once the reviewer's review has moved past
that head — or merely reached it, for a finding the reviewer is not carrying
forward in its own backlog blob — so
a finding that reappears after an incomplete fix, a revert, or a later round
reintroducing the code is not retired by the answer that preceded it.
`collectAddressed` in `summary-findings.ts` states that rule.

A body bullet counts as anchored only when the reviewer's inline comments cover
its whole `path:line` group (falling back to bare-path slots left by outdated
anchors, per file, on the same all-or-nothing basis). `path:line` is a position,
not an identity, so a partial cover cannot say *which* bullet was threaded — and
picking by document order hides the genuinely unthreaded one while duplicating
the threaded one as summary work.

### 2. A draft-parked or rate-limited external reviewer reports `success`

`CodeRabbit | success | Review skipped: draft pull request` — and later
`Review rate limited` — is a **success** status for a review that never ran.
Where this was measured, the rate-limited form was the standing state,
not an edge case, so a veto set built from "reviewer-shaped checks that are not
pending" settled within seconds of every push.

**Guard**: convergence consults exactly one reviewer — the one that posts
findings (§ The reviewer is identified by app slug). A non-posting reviewer's
verdict is not evidence either way.

The draft-parked form is the **routine** state for the first rounds of any
drive, not a rarity: drives run on drafts (§ A draft PR is reviewed, and then
marked Ready), so `Review skipped: draft pull request` is what a draft-skipping
reviewer reports on every head until the transition fires. That is precisely
why the transition exists — and why this guard is load-bearing rather than
defensive. The posting reviewer alone decides convergence, so a drive cannot
mistake another reviewer's skip-success for a review; and once the PR is
marked Ready, whether that reviewer has answered *yet* is the ordinary
late-poster race this skill does not gate on, not a draft-specific
problem.

### 3. PR-head replication lag

Seconds after a push, `git ls-remote` shows the new tip but
`gh pr view` still reports the **previous** SHA in `headRefOid` — where all
checks had settled and all threads were resolved. Measured at ~40s to catch up.

**Guard**: `drive-status.ts` compares the API head against local `HEAD` and
returns `HEAD_LAG` until they agree. Disable only with `--no-head-sync`, and
only when the local tree genuinely is not the PR branch.

### 4. A satisfied non-posting reviewer masks the posting reviewer's missing check-run

Measured more than once: on a fresh head, `gh pr checks`
listed only a dormant `AI review` workflow (`SKIPPED`) and an external review
bot (`SUCCESS`), while `gh api` reading `.../commits/<SHA>/check-runs` showed the posting
reviewer's own `AI review (…)` check run had not been created yet. "Some live reviewer settled" was treated as "the reviewers
settled".

**Guard**: the check-runs API, queried by the exact SHA, for the posting app
only. An absent check-run is `AWAITING_REVIEWER` — never `settled`.

### 5. A stale reviewed-SHA marker

The checks can read settled while the newest reviewer comment still carries
an `ai-reviewed-sha` naming the *previous* commit, with findings on it.

**Guard**: the marker must name the current head. When the reviewer has never
stamped one, the report says so (`reviewedShaSource: "check-run"`) rather than
passing the weaker single witness off as corroborated — and that weaker witness
cannot reach `CONVERGED` at all. The zeroes convergence rests on are read out of the
sticky comment's neighbourhood (`summary-findings.ts` reads a missing sticky as
zero findings; a review that posted nothing leaves zero threads), so a completed
check-run with no published sticky makes "nothing left to say" and "nothing was
ever said" the same observation. That state reports `AWAITING_REVIEWER` (exit
`4`).

### 6. HITL threads spin forever

Once the only unresolved threads await a human, the loop wakes, re-enumerates
the same undeferrable threads, discovers nothing it may act on, and burns turns.

**Guard**: `bun "<skill-dir>/scripts/drive-state.ts" park` records the item and the decision it needs;
parked items stop counting as live work, so the drive reaches `HITL_PARKED` and
`drive.ts` does not wake itself up. What picks it up is an answer, not a clock:
a re-arm admits itself only once every parked item is answered.

### 7. Merged mid-loop

A PR that merges while the loop runs orphans every subsequent fix onto a branch
nothing will merge, silently. A push whose output prints `* [new branch]` has
already gone somewhere wrong.

**Guarded at both the start and the push, because either alone is not enough.** `drive.ts` checks liveness
**first** on every pass and exits `5` before handing a round to an agent — that
stops the loop *starting* work it cannot land. But the pass then triages, fixes,
gates and commits, which takes minutes, and a check taken before all that says
nothing about the moment of the push. So the push itself goes through
`guarded-push.ts`, which re-checks at that instant, refuses on a merged or
closed PR, and additionally fails loudly when the push **created** a ref rather
than advancing the PR's.

It also refuses to push somewhere the driver cannot name, and to push without
the gates. **Every** configured push destination must be the PR's head
repository — `remote.origin.pushurl` is multi-valued and a `git push` to `origin`
writes to all of them, so checking only the first leaves a second repository
advanced irreversibly by a push this guard called safe. And `--no-verify` is
rejected in the forwarded extra arguments: a successful guarded push is the
evidence on which held `accepted` threads are resolved, and that evidence is
worth exactly what the mandatory pre-push gates behind it are worth.

### 8. Unbounded spinning

**Guard**: `bun "<skill-dir>/scripts/drive.ts" --max-rounds` (default `drive.max_rounds`, else 10). Hitting it exits `6` with an
explicit non-convergence report naming the state that was still live — not a
quiet stop that reads like success.

**A second, earlier guard catches the spin `--max-rounds` only bounds**: the
stall stop (exit `14`). Each ROUND_READY gate fingerprints the observable
outcome surface — reviewed head, local head when measured, and the
unresolved-thread, summary-finding and parked **key arrays** (identity sets,
not counts — required fields, so a gate that measured counts but published no
keys cannot attest sameness) — and `$DRIVE_PR_STALL_ROUNDS` (default 2, `0`
disables) consecutive gates reading an identical fingerprint stop the drive,
because the only way between two gates is a completed pass, so sameness
indicts the pass that just ran: it exited 0 having resolved nothing, addressed
nothing and pushed nothing. That is the shape — a pass
standing down against its own parent driver ran 5 and 10 full no-op rounds on
two PRs with every round header looking healthy, and the first of them merged
over six live findings. The detector only ever stops on **positive evidence of
sameness**: a gate whose head or key arrays could not be measured produces no
fingerprint and resets the streak, so degraded telemetry falls back to the
plain `--max-rounds` bound rather than a guessed stop.

What that rule turns on, each clause measured as a stall stop
firing over a pass that *had* worked:

- **The local head is measured in the tree being driven.** `drive.ts` exports
  `$DRIVE_PR_WORKTREE` and `drive-status.ts` reads HEAD there, because a pass is
  an agent whose shell cwd persists across tool calls, and a directory it can
  wander into — the git common dir, say — reports the **main** worktree's
  HEAD (usually the default branch). Measured: after one `cd` there every later
  gate reported `HEAD_LAG` against a head that could never arrive, so the pass
  did nothing while the driver counted the round. With no anchor, a reading taken from
  inside a git *directory* is refused rather than reported — unreadable beats
  wrong, since `unavailable` disarms the guard and produces no fingerprint
  where a confident wrong SHA wedges the drive.
- **The local head must be measured.** `head.local` carries a real SHA, or the
  gate attests nothing and no fingerprint is produced — `head.localSource` says
  where it came from (`git`, `flag`, `disabled`, `unavailable`) and rides in the
  fingerprint as evidence, but it cannot substitute for the measurement.
  Neither an attempted-and-failed read nor a deliberate `--no-head-sync` opt-out
  is an assertion that no local commit happened: under either, a pass can commit
  — or commit and push, while the API head this gate read is still stale — with
  every other field standing, and the report would then state, falsely, that
  nothing was pushed. Note what *measured* excludes: a caller-supplied
  `bun "<skill-dir>/scripts/drive-status.ts" --head SHA` (`localSource: flag`) is an assertion about one
  instant, not a continuing measurement, so a driver forwarding one frozen value
  to every gate would see a local head that never moves however much the pass
  pushes. `drive.ts` therefore has no `--head` to forward — it drives the tree
  it runs in, and `$DRIVE_PR_WORKTREE` re-measures there every gate. A drive
  with no measurement at all keeps the `--max-rounds` bound and loses only this
  earlier stop.
- **Identities, not cardinalities.** `work.unresolvedThreadKeys`,
  `summaryUnaddressedKeys` and `parkedKeys` are fingerprinted rather than the
  counts beside them, because a count calls a *substitution* unchanged: a pass
  resolves thread A while the reviewer posts thread B and the total stays 1
  across a round that did real work. Parking has the same shape twice over —
  parking a summary-only finding posts no marker, so both summary counts stand,
  and one parked item traded for another leaves the parked count alone.

The counters below share that one bound, because neither covers the other's runaway
and **both are durable**. `rounds` counts distinct reviewed heads, so it cannot
see a pass that never pushes; `attempts` counts passes on the current head, and
resets when the head moves. A per-process attempt counter was the hole: on an
unchanged head `rounds` stays flat, so every restart of the driver started from
zero and granted another full `--max-rounds`, and any harness that restarts
`drive.ts` ran unbounded passes against a loop advertised as bounded.

## State that outlives the session

`drive-state.ts` keeps per-PR state in the per-clone state dir (`SKILL.md`'s
"State directory" bullet; override with `$DRIVE_PR_STATE_DIR`): round count keyed on **head** rather than invocation,
the per-head attempt count above, the last green-verified SHA that bases an
opt-in `--delta` plan, the parked set, and the **held batch**. The handoff file
is written to `.context/pr-drive-<PR>.md` (override with
`$DRIVE_PR_HANDOFF_DIR`).

The state's resumable subset also lives on the PR, as the **drive ledger**
(`lib/state/ledger.ts`): one comment opening with `<!-- drive-pr-ledger -->`,
carrying `ledgerVersion`, a monotonic `generation`, the round, phase, last
counted and verified heads, the Ready mark, the parked items with their
decisions, the held items by key, outcome and pushed commit, the quota park
without its account,
the takeover records and the claims in force, an empty section for the
decisions taken unattended, the driver's tree, clone and
heartbeat, and the handoff narrative's last twenty lines, as JSON inside a
second HTML comment with every `<` and `>` escaped. A driver publishes itself
in `$DRIVE_PR_LEDGER_DRIVER` once it holds its locks, and `drive-state.ts`'s `handoff` (every round boundary, after a takeover, and as the driver stops)
and its `park` write the ledger from the state they hold, so a
session that is not a drive's child never writes one. Each write is a
read-modify-write against the canonical comment: the comments are read, the
body built, and the comments read again just before the `PATCH`; a ledger
whose `updated_at` or body moved (the stamp has one-second precision, so the
body is compared too) is rebuilt from the newer read, up to three times. After
the `PATCH` the ledger is read back, and a write another writer replaced at
once is reported rather than counted. The forge has no compare-and-set on a
comment, so two writers can still interleave inside one request's latency,
which the per-round claim check below makes a driver that has been taken
over stop doing. Two creations that race leave two comments: the lower id is
canonical, and each writer deletes its own higher-id copy on its next write.
A ledger is trusted only when its author is the drive's own login or carries
the owner, member or collaborator association; any other comment opening with
the marker is ignored and reported, and so is a trusted comment opening with
it whose data does not read (a person's comment, a damaged body), which is
never taken for the ledger or overwritten. Nothing that identifies an account
is posted: neither the ledger nor a claim carries an account hash, and
email-shaped text in the narrative and the parked reasons is replaced with
`<redacted>`. The driver's last write marks it stopped, naming its exit, on
a returned exit and on a thrown refusal; a stop by signal or by `drives.ts`'s `--stop` starts no new command once shutdown begins, so that ledger keeps
saying "running" until its heartbeat ages past the lease window. The body is cut to the forge's 65,536 limit by dropping
held items' outcomes first, the narrative second and the visible list of
parked decisions third; a parked decision is never dropped from the data, so
a ledger that still does not fit is not written, and says so. A canonical
ledger in a `ledgerVersion` this code does not read is never overwritten.

At arm, once its locks are held, `drive.ts` seeds this clone's state from a
trusted ledger whose generation is newer than the state's own
(`ledgerGeneration`, which a fresh state lacks): `drive-state.ts`'s `seed-ledger`
lays the resumable subset over the local state under the state lock and
regenerates the handoff. It keeps this clone's own quota park, since the
ledger carries no account to judge a wall by. A held item whose outcome the
size cut dropped is not seeded, and the round triages it afresh. A seed the
state store refuses keeps its exit (`13` when another working tree holds the
PR). A `ledgerVersion` it does not read refuses with exit `1`, naming the
version. `drive-state.ts`'s `reset` keeps the generation the state had
reached, so the next arm does not seed back what the reset forgot. A forge
that cannot be read starts the drive without the ledger, and says so.

The following properties of that file are load-bearing rather than incidental. Updates
take a per-PR `mkdir` lock (`$DRIVE_PR_LOCK_TIMEOUT`,
`$DRIVE_PR_LOCK_STALE_MIN`), because a managed parallel worktree setup runs many worktrees against one
clone and an unserialised read-modify-write silently drops one driver's parked
decision. And a state file that exists but does not parse is **indeterminate**,
never a fresh drive: it is preserved as found and every command refuses, since
substituting empty state there discards the parked decisions and the round
budget the file exists to carry. `bun "<skill-dir>/scripts/drive-state.ts" reset <PR>` is the deliberate
way out.

A held item's per-key claim (below) has its own, separate staleness knob —
`$DRIVE_PR_CLAIM_STALE_MIN` (default 10 minutes, clamped to `[1, 1440]`) — not
the lock's. There is no renewal while a claim's owner is mid-dispatch: staleness
is judged purely from the claim file's original mtime, so a genuinely slow
dispatch that outlives the window is indistinguishable from a crashed one and
can be reclaimed. That is deliberate, not an oversight — the owner is an agent
issuing discrete `drive-state.ts` invocations, not a resident process, so a
heartbeat would need a renewer that outlives a killed driver and would wedge
the crash recovery this primitive exists for. `answer-summary-finding.ts`'s
pre-dispatch reconciliation against the PR's real comments narrows — but does
not fully close — the residual risk of two drivers both posting for the same
key: it is a plain read-then-write, not an atomic check-and-post, so it only
catches a reclaim that lands after the *original* dispatch's `POST` has already
returned. Two claimants whose `--check-addressed` reads both land before
either's `POST` is visible can still both post — the reconciliation shrinks that
window to "both POSTs in flight past the whole staleness window" rather than
eliminating it. See the reconciliation comment in `answer-summary-finding.ts`.

### The single-instance locks (exit `11`)

`drive.ts` holds **two** locks for the life of a drive, because a drive has two
shared resources and neither key covers the other:

| Lock | Where | Protects against |
|---|---|---|
| worktree | `<state dir>/pr-drive-worktree-<hash of `git rev-parse --show-toplevel`>.lock` | two drivers in *one* worktree — they edit, commit and push the same working tree, so they cross-ship each other's uncommitted edits whatever PR each targets. Keyed by the tree itself, never by `$DRIVE_PR_HANDOFF_DIR`: two drivers in one checkout setting that variable differently would compute different locks and both run |
| per-PR | `<state dir>/pr-drive-<PR>.lock` | two drivers in *different* worktrees on one PR — separate working trees, but one head branch and one clone-wide state file |

They are taken in that order, always, so contending drivers cannot deadlock.
Either refusal exits `11` and names which lock and which owner — plus, when
the holder's claim carries its diagnostics line (below), the PR that
owner is driving, its worktree, and its durable log — without touching state.

Staleness is keyed to the **owner's liveness**, not to an age window like the
state mutex's. A lock holds exactly one entry, `claim.<nonce>` — the random
**nonce** names this acquisition, the file's first line holds `pid` and
hostname (everything the protocol ever reads), an optional second line carries
the owner's operator diagnostics as one JSON object — PR, worktree, start
time, log path (`lib/claim.ts`); advisory by design, so liveness and
recovery never read it and a claim without one is simply an older driver's —
and the file's mtime is the heartbeat. It is published *inside* the directory before that
directory becomes visible, by staging-then-`rename`, so no wall-clock guess is
needed to interpret an empty one. The exclusion is `rename(2)`'s refusal to
replace a **non-empty** directory: a staging directory always carries a claim,
so once any instance is installed every later publisher fails. It does replace
an *empty* one, which is exactly the shape a retired or released lock is left
in, and so is how the slot is reused rather than wedged. An entry that is not a
`claim.*` names no acquisition and is debris.

The generation is in the **name**, not in the record, and that is what makes
every destructive step an **identity** operation rather than a path one (the
difference was measured). A path names a slot, and the
slot's occupant changes between any two syscalls. So recovering a dead owner's
lock *retires* it: the entries one `readdir` listed are removed **by name**,
and nothing else is touched. Release does the same for its own claim, then
`rmdir`s the slot — which refuses a directory that is not empty, so a successor
that has already moved in is what stops it. An actor still acting on generation
N after N was replaced therefore removes `claim.N`, which is already gone: a
no-op, whatever occupies the path now, however long that actor was suspended.

Addressing the path instead fails in two measured ways. Renaming to a
destination keyed by the recovering process's own pid gives every contender a
private destination and so fences nothing — contender B moves contender A's
*live replacement* aside and both drive; the same shape in release lets a
suspended owner move its successor's lock and briefly vacate the canonical
path. Keying the destination to the **observed generation**
(`<lock>.stale.<nonce>`) does close both, because `rename(2)` refuses a
non-empty destination — but only for as long as that destination stays
non-empty, so every recovery and every release has to leave a permanent
tombstone — one for the worktree lock and one for the per-PR lock, every drive
run, with no reclamation and no correct age threshold to sweep them by. Naming
the source needs no fence, so there is nothing left to bound.

`drives.ts` is the standing form of the same answer: it lists every
drive lock in the state dir with its owner and a verdict — live by exactly the
recovery rule (`lib/claim.ts`'s `claimLive`), stale, empty, or the fail-closed
`contested`/`unreadable` shapes, which it reports rather than drops — and
`--stop <PR>` requests that a live driver stop its pass tree and release
its locks on the way out. It acts only on a process it can bind to the claim,
using `ps` on POSIX and a PowerShell process snapshot on Windows. A Windows
driver polls for the stop request and runs its own cleanup; a process-table
failure refuses the stop. Recovery stays `acquire`'s alone. The driver's own narrative survives the arming session at
`<state dir>/drive-pr-<PR>.log`.

A stop request names the claim's generation, so a request left by an older
driver cannot cancel its successor. The driver checks for requests every
250 milliseconds. After a 30-second grace, the stop command forces captured
process identities to exit and verifies their disappearance; it leaves
abandoned locks for the next acquire to recover. Forced termination uses
individually verified identities rather than trusting a tree-kill command's
exit status. A process created outside the captured tree remains outside
this guarantee; containment of arbitrary escaped descendants is separate work.

After confirming helper, pass, and registered-runner cancellation, a driver
handling a cooperative stop atomically publishes
`drive-pr-<PR>.stop-complete.<nonce>.json` beside its PR lock. The receipt binds
that acquisition and stop request. It is published before claims are released;
a publication failure retains the claims. When a temporary cancellation marker
made the operator's registry snapshot incomplete, only this matching receipt
plus disappearance of its captured process identities can confirm the stop.
Missing, malformed, or other-generation receipts cannot turn an unreadable or
missing registry into proof of completion.

The operator removes its receipt after confirming completion. Receipts and
publication temporaries left by an interrupted operator belong to the PR's
artifact family and follow its existing migration and retirement policy.

A registered foreground supervisor keeps its terminal proof inside the
acquisition's process registry. Later launches may remove older command logs
and result directories without removing that proof. Confirmed completion stays
available until the registry is retired, including when an identity handoff
finishes late. An unverified or malformed terminal record retains uncertainty
and the known process identities.

A pid recorded on **another host or platform** is unanswerable here and counts as alive; the
cost is a refusal a human clears by removing the directory, against two live
drivers if it guessed the other way.

A live pid is not on its own proof that the *driver* lives: after a driver dies
the OS may hand its pid to any unrelated long-lived process, and `kill(pid, 0)`
then reports that stranger as alive forever. The owner therefore **refreshes**
its claim (a `utimes` on `claim.<own nonce>`, which is why the claim *is* the
heartbeat) on a timer of its own — a sixth of the staleness
window, capped at a minute — and a claim left unrefreshed longer than
`$DRIVE_PR_LOCK_HEARTBEAT_MIN` (default 6 hours, clamped to `[5, 10080]`
minutes) is recoverable even though its pid answers. The timer, not the round
boundary, is the mechanism: refreshing once per round made a claim only as
fresh as the round was short, and a round that runs an agent pass, the full gate
suite and a remote test box can outlast the window on its own — at which point another
start retires the locks of a driver that is alive and working. A lease has
to be renewed while the work happens.

If a claim is recovered anyway, the owner finds out on its next refresh — the
`utimes` fails because `claim.<own nonce>` is gone — and the drive **stops with
exit `11`** rather than continuing without the lock. It releases nothing a
successor can feel on the way out either, since the only entry release removes
is that same name.

Stopping the *loop* is not enough (measured): the loop
reads the takeover flag only at a round boundary, and a pass already running
does not pause at one. So the refresh that discovers the loss also **terminates
the running pass**, immediately — otherwise it goes on editing, committing and
pushing under a claim another driver now holds, and the two cross-ship exactly
the work the lock exists to separate. `SIGINT`/`SIGTERM` take the same route in
the other order: stop the pass, wait for it to be gone, and only then release
the locks. Releasing first was the same defect by a second path — a signal
delivered to the driver pid alone (a supervisor, `kill <pid>`) never reaches the
pass, so the locks came free while the agent kept writing the tree.

On POSIX, both stops signal the pass's whole **process group**, which is why
the pass is spawned detached: signalling the pass alone leaves `guarded-push.ts` and the
`git push` under it running. The cost of detaching is that the pass no longer
receives the terminal's own Ctrl-C, or has a controlling terminal at all — the
handlers above are what replace the first, and the second is correct for a
driver whose premise is running unattended (an unanswerable credential prompt
is a hang no deadline here covers). If a pass somehow survives a group
`SIGKILL`, the locks are deliberately **not** released: a live pass under a
free lock is the concurrency being prevented, while a lock left behind costs a
refusal a human clears in one command.

`$DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS` overrides the derived refresh period
(floor 50ms). It exists so the renewal can be exercised at a scale a test will
wait for, and for an operator running a deliberately short window.

### Picking up a stopped drive

A drive that stopped holds no lock (except an unwitnessed `PASS_DEADLINE`,
which exits with its locks held), so picking it up is a **re-arm** from its
durable state, admitted on mechanical states: after `QUOTA_PARKED` by a
pass that bills a different account from the one the park recorded (or after
the reset), and after `HITL_PARKED` once every parked item has an answer later
than its park (a park records when it was made; an older park without that
time is never read as answered). A comment the drive itself writes (one
opening with an outcome token, or carrying a hidden marker) is never an answer.

Replacing a driver that still holds its locks is a **takeover**,
`drive.ts` with `--take-over`, decided before any lock is taken by the holder's
`drives.ts` `--doctor` row: admitted against a live holder whose verdict is
`WEDGED`, which it stops through `drives.ts` `--stop` (the identity check above,
bound by `--expect-started` to the acquisition that row named: a holder that
took the lock since is refused with `--stop`'s exit `3`, and left running),
and against a stale holder whose process is confirmed gone (a stale lock
whose process still runs, with an old heartbeat, is refused) and whose
working tree holds no uncommitted changes,
unpushed commits or unconcluded git operation (inspected on this machine;
otherwise refused until they are pushed or discarded). Every other holder is
refused with exit `11`, naming the verdict; an empty lock is exit `2`, since
there is nothing to take over. Once the takeover holds the locks it appends a
record to the drive state's `takeovers` (from which actor and hashed account,
to which, the verdict, the round), runs `reconcile-replied-threads.ts` before
the first triage — the first gate's own sweep covers a failed run — and
carries the held batch over: a hold stamped with its pushed fix is left to the
round's ordinary resolve; a hold of the previous actor not stamped as pushed is
reopened into the state reconciliation gives a reply it finds — a thread
re-held `--unconfirmed` (round `-1`) on the same reply, which `claim-held`
refuses until a pass confirms the fix or supersedes the reply, a finding
released — and each reopen is read back from the held batch: the record's
`reopened` lists those that took and `reopenFailed` those that did not, and
the first pass is told both. The takeover
stops only a driver of this clone: across clones no process can be stopped
and no lock is shared, so the takeover goes through the ledger.

When no driver of this clone holds the drive, `--take-over` reads the ledger:
it is admitted (verdict `STALE`) only when the ledger names a running driver
in another clone whose heartbeat is older than the lease window, the doctor's
stall threshold (`stallThresholdMs`, the same floor that keeps an honest long
round from reading `WEDGED`); a fresher heartbeat refuses with exit `11`, and
no running driver elsewhere is exit `2`. Once it holds its locks the taker
re-reads the ledger (a heartbeat that moved since refuses with `11`) and
posts an append-only claim, `<!-- drive-pr-takeover-claim -->` with its tree,
clone, the ledger generation it read and the time, and reads the claims
back; a read-back that fails refuses the takeover with exit `1`, since it
cannot tell a won claim from a lost one. The forge
assigns increasing comment ids, so of the claims on one generation the
earliest wins; a later claimant reads the earlier one back and stands down
with exit `20`. The winner seeds, completes the takeover as above, and writes
the ledger at once. A driver's own position is its own claim's id, or the
highest id among the claims in force when it started (for a driver that
could not read the comments at arm, the highest at the first round boundary
that reads them); at every round boundary it reads the claims and exits `20`
when a claim in force from another clone is newer than that position, or,
for a driver that took the drive by its own claim, when another clone's
earlier claim on the same generation shows up after a lagging read hid it.
A write from a pass of that driver (a park) is skipped for the same
reasons. The arbitration holds only once
every driver of a PR runs a plugin version that reads the ledger: an older
driver writes no heartbeat and reads no claim.

### The session lease (exit `11`, from `drive-state.ts`, the round gate, **and** the posting scripts)

The locks above are what makes the working tree a sound stand-in for a driver —
and they cover `drive.ts` only. An **interactive** pass (an agent walking
SKILL.md's steps by hand) takes no lock, so two agent sessions in *one* tree
derive the same actor and the state model cannot separate them: `hold` upserts
by key, so the second session's hold silently replaces the first's; `stamp-held`
stamps "the holds this tree owns", which is now both; nothing in the claim path
can tell them apart. Measured: all seventeen threads
one session had just replied to carried **two** `**accepted**` replies, its own
and a concurrent session's minutes later — which corrupts the reviewer-scoring
sample the outcome vocabulary feeds, and is unrepairable once posted.

Every **state-mutating** `drive-state.ts` command except `clear-lease` therefore
takes a lease over *(this working tree, this PR)* first, and exits `11` when
another live session holds it, naming that session's pid and the liveness check
that settles it. Run the process-check command printed in the refusal. It is
chosen for the holder's platform and qualified for the recorded host when
remote: a pid has meaning only on its own host. Do not substitute a local
process probe for a remote holder's check.

The remote form uses the lease's **own recorded** `platform`, rather than the
reader's platform. When the writer recorded no platform, the refusal names
the pid and host and asks for that host's process check rather than guessing a
command. `pidCheckCommand` in `lib/proc.ts`
owns all of that and `leaseLivenessHint` in `lib/state/lease.ts` owns the
wording, so the two refusal sites cannot drift. The readers take nothing: the
session being refused is the one that most needs to see the state and the lease
it lost.

**`drive-status.ts` raises the same `11`**, with `state: "SESSION_LEASE_HELD"`
in its JSON report, and it is the one a second interactive session meets first:
the gate is SKILL.md § 1's opening command of every pass, and its round-counting
`bump-round` is a mutating call like any other. It propagates that exit and the
child's diagnostic verbatim rather than folding it into `INDETERMINATE` — a
refusal that reaches the caller as "the state could not be read" sends it
looking for an unwritable state dir and withholds the pid, the liveness check
and `clear-lease` that are the refusal's entire value. It is the only `11` in that
script's contract, and it means what `drive-state.ts`'s means. The same call
propagates the cross-tree `13` the same way, as
`state: "DRIVE_HELD_BY_OTHER_WORKTREE"` — see § PR-wide admission below for why
the two are not one code.

**`reply-to-thread.ts` and `answer-summary-finding.ts` raise it too** —
the first through the spawned `assert-post-allowed.ts` (a cross-skill spawn, since the fence lives in
`drive-pr`), the second through `lib/state/lease.ts` directly (it lives in
this skill already). Everything above fences drive *state*. The irreversible act is the `POST`: a script
that met the lease only *afterwards* — at the `hold` that records what it had
already put on the PR — would let a pass whose driver had died, its lease
already taken over by the replacement, land its `**accepted**` first. So the
fence is the last local act before each mutation, with the same exit and the
same diagnostic. It differs from the state-side fence in the
following ways:

- It compares **no admitted lease**, because those callers never claimed one.
  It asks only "is another live session driving this tree", matched on
  (pid, host) **and the session's acquisition token** (`sessionStarted`,
  from `$DRIVE_PR_SESSION_STARTED`). Both sides must agree about the token:
  a token-bearing caller matches only a lease carrying the *same* token, and
  a token-less caller matches only a token-less lease. Pid and host alone are
  not ownership — a pid the OS recycled onto a dead driver would otherwise
  make an unrelated live session's lease read as this session's own, skipping
  the refusal it exists to produce. So a **same-pid lease can still be
  refused**, and that is the reason why.
- **Absence is not a refusal, but it has to be established.** No lease, or one
  whose owner is gone, posts — `resolve-review-comments` is usable standalone,
  and a pass holds no lease before its first mutating `drive-state.ts` call. A
  **tier-3** session (no identity at all) is *not* exempt though, unlike for
  claiming: it provably holds no lease, so any live lease it finds is another
  session's. Anything the fence cannot *read* refuses instead, with exit `1`:
  an enumerated lease file it cannot parse or open, a failed `git` probe in a
  tree that *is* a repository, or a `drive-pr` installed with its fence script
  missing. Whether this is a repository at all is answered from the filesystem
  (`.git` up the tree, plus the `GIT_*` variables), never from git's exit
  status — `128` is its generic fatal and covers dubious ownership and
  corruption too, where a live lease may already exist. That filesystem probe
  distinguishes **confirmed absence** (`ENOENT`/`ENOTDIR`, which keeps walking
  up) from a filesystem that merely **declined to answer**, which refuses:
  `existsSync` reports `false` for both, so a `.git` that became a broken
  symlink or slipped under an unsearchable ancestor *after* a lease was written
  would otherwise read as "no repository, therefore no lease" — the same
  fail-open as the exit-128 check, one step further in.
- A marker **deleted or renamed** after a lease was written is the case no
  probe can reach: that is a genuine `ENOENT`, identical to a tree that never
  held a repository. What answers it is memory rather than inspection, so
  `drive.ts` exports **`$DRIVE_PR_STATE_DIR`** to every pass it spawns; that
  override short-circuits the repository probe entirely, so a driven pass reads
  the real lease whatever became of its `.git`. A lease exists only because a
  drive wrote one, and a drive owns its passes, so that covers the path where
  an unread lease could actually double an outcome reply. The **residual** is
  an interactive session that claimed a lease and then lost its marker — it has
  no driver to inherit the directory from, and closing it needs durable state
  outside the repository, with a staleness story of its own.
- Its **residual is a real one**: GitHub has no conditional write for a
  comment, so the check and the `POST` are two moments and a lease revoked
  between them still lets that one comment through. Stated in
  `lib/state/lease.ts`'s header alongside the module's other residuals rather
  than papered over.

A session is a **pid**, resolved in this order — `$DRIVE_PR_SESSION` (which
`drive.ts` exports as its own pid, so a whole unattended drive, driver plus
every round's pass, is one session), then the harness's agent process
(`$CLAUDE_PID`), then no lease at all. The same pid carries the
**self-recognition rule** (stated in full next to SKILL.md's
refusal guidance): a live lock holder is this pass's own parent driver — never a
second driver, so proceed with the round — when its pid equals
`$DRIVE_PR_SESSION`, its host equals this one, **and**, whenever the *caller*'s
own environment carries `$DRIVE_PR_SESSION_STARTED`, its claim's acquisition
token equals it too — refusing outright over a claim with no diagnostics at
all, since our own real parent would always write them alongside a token it
exports . Only a caller with no
token of its own still falls back to pid+host, and even then only against an
equally diagnostics-free claim. All of it, not the pid alone: a pid the OS
recycled onto your parent would otherwise vouch for a dead driver's claim, and
that same-pid/different-token holder is a genuinely foreign lock that every
second-driver protection below still governs. `drives.ts` says so on every
surface a pass can read — the `self:` label
in the text listing, `"self": true` on the `--json` row, and a `--here` banner
that names the parent driver rather than warning about a rival — all from one
predicate, after a pass reading `--json` alone found no signal there and stood
down. Every
second-driver protection in this file applies to every holder that fails that
predicate — a different pid, a different host, or a mismatched token on a
matching pid. The last tier is deliberate: the
tempting fallback is the parent pid, and under an agent that spawns a fresh
shell per tool call every invocation would be its own "session", so two
concurrent calls from *one* agent would refuse each other. A false refusal wedges
work that was never in conflict, and a refusal with no live holder to name
could not satisfy its own contract anyway.

Liveness is the same two-part test the locks use, for the same reason: a pid
that is gone is stale however young, and a pid that answers is honoured only
while the session keeps **renewing** — every mutating command is the renewal —
because the OS hands a dead process's number to a stranger and a stranger never
renews. `$DRIVE_PR_LEASE_STALE_MIN` (default 6 hours, clamped to `[1, 10080]`
minutes and then floored at 330s) is that window. Unlike the locks it is not
refreshed on a timer of its own: renewal here is driven by the work, and an
agent may think, run gates or wait on a remote test box for a long time between two
mutations.

That floor is not a taste call. A command is *admitted* the moment `claimLease`
returns, and then waits on the state mutex — for up to `LOCK_ACQUIRE_MAX_SEC`
(300s). Its lease is at most 30s old at admission (the renewal cap), so a window
shorter than 330s could expire it *while its own command is still in flight*,
and a concurrent `reset` would then sweep it as abandoned. That is exactly the
lease `clearAllLeases` preserves on purpose, so losing it re-opens the
same-actor concurrency this whole mechanism closes. Flooring the window is
sufficient on its own: the quantity an admission token would have to fence
against is bounded, so it can simply be out-waited.

`bun "<skill-dir>/scripts/drive-state.ts" clear-lease [PR]` is the way out for a human taking over from a
session they know is gone; it reports the record it dropped, so the evidence for
whether that was right survives the override. `lease [PR]` reads it without
changing anything, and `reset [PR]` sweeps the PR's leases from every tree — the
tree holding a wedged lease need not be the tree the human is standing in.

**It deletes nothing while any other tree's lease is still live: it refuses
outright, exit `9`, before touching shared state.** The all-or-nothing guarantee
is exact up to that point and no further — classification and lock acquisition
either complete for every lease or change nothing — but the *deletion* phase can
still fail per-file (`force: true` only makes a missing target harmless, not
`EACCES`/`EPERM`/`EROFS`/`EIO`). When it does, `clearAllLeases` throws `PARTIAL sweep`
naming exactly which leases were removed and which remain, and that outcome is
reported as partial rather than as no-change. So the two non-zero results mean
different things and must not be conflated: a refusal or an acquisition failure
leaves the lease set untouched; a `PARTIAL sweep` has changed it and says so. Wedged
means the session behind a lease is gone or has stopped driving, exactly
`leaseAlive`'s test, so a live lease is never the thing anyone ran `reset` for.
Preserving that lease is necessary but is not sufficient, because the state file
and the **claim files** are shared by every tree driving the PR: a live session
mid-dispatch of a held finding has already created its claim file and may not
have posted yet, and deleting it lets the resetting tree rebuild state, see the
finding as unaddressed, and post the same non-idempotent answer again. So the
classification happens before any deletion, and a mixed set — some stale leases
plus one live foreign one — deletes nothing at all rather than sweeping the
stale half behind a refusal that claims otherwise.

The caller's *own* live lease is preserved too but does not trigger the refusal:
it is taken by the resetting command itself, since `reset` is a leased mutation
like any other. Only another tree's is news, and only another tree's can be
mid-dispatch behind this one's back. A human overriding a genuinely live foreign
lease uses `clear-lease` from that tree — or `clear-lease --all` from anywhere,
when that tree is one they cannot stand in — then resets.

Deleting a live lease would also re-open that tree to a second session: a
command there can already be *admitted*, past `claimLease` and waiting on the
state mutex `reset` itself holds, and it takes no new lease when it wakes.

The lease above is keyed by tree **and PR**, so on its own it is narrower than
the worktree lock: two sessions in one tree driving *different* PRs resolve two
different lease files and neither refuses the other — the identical damage
measured within one tree, reached by a different route, and not
hypothetical: it is the exact failure the worktree lock itself was built to
close for `drive.ts` (two unattended drivers in one checkout cross-shipping
uncommitted edits across different PRs). The worktree lock does not cover this
case for an *interactive* pass — it excludes at most one `drive.ts` process,
and an interactive pass takes no lock of any kind — so without the tree lease
below this gap would be open for exactly the sessions the per-PR lease exists to protect.

### The tree lease across PRs

A *second* lease closes it, keyed by the working tree **alone** — every
state-mutating command claims both leases, identified or not, and refuses
with the identical `exit 11` on either one. It is not a lock (see "why a
lease rather than a lock" above — the same reasoning applies here unchanged:
no long-lived process exists behind a `drive-state.ts` invocation to hold one
for) and it is not
derived the way the PR-wide gate (§ PR-wide admission) is — it is a genuinely separate lease
file (`drive-tree-lease-<actor>.json`), because deriving tree-wide admission
from the *existing* per-PR files would still need one PR's own file to exist
before it could say anything about a session driving a *different* PR.

The no-session tier's own claim here (`claimSessionlessTreeLease`)
writes a `holder: 'worktree'` record — the *same* presence-record pattern
the per-PR axis uses, extended to this file. A tier that only *checked* the
tree lease for a live foreign holder and never claimed one itself would always
get back a `null` `treeLease` — closing the cross-PR admission gap only for
identified sessions and leaving two sessionless resolvers on *different* PRs
from the *same* tree both admitted, free to cross-ship edits in the same
checkout. So every tier-3 admission claims a tree lease of its own, and `LeaseAdmission`'s
variants — `{ lease, treeLease }` both non-null, or both null — do not
distinguish identified from sessionless.

Ownership for an identified session's claim is (pid, host, `sessionStarted`)
exactly like the per-PR lease, so one session juggling several PRs from one
tree renews its *own* tree lease on every one of them and never refuses itself.
Ownership for the no-session tier's claim cannot use that test — every
sessionless caller in one tree resolves the same actor and carries no pid to
tell two of them apart — so it turns on `pr` instead: a live record for the
*same* pr this claim names is a renewal, a live record for *any other* pr (or a
live *session*-held record, whichever pr it names) is foreign and refused. That
is the residual this leaves, stated rather than papered over: a
sessionless resolver that finishes with PR X and moves straight to PR Y, with
no intervening `clear-lease` and no full staleness window elapsed, is refused
— indistinguishable, on the evidence this runtime provides, from a second
sessionless resolver starting on PR Y while the first is still working PR X.
`clear-lease` already drops this record unconditionally regardless of which
pr it names (see below), so it is the documented way to move on immediately;
left alone, the record clears itself the same way every tier-3 record does.
Note which release does NOT apply to that case: `release-sessionless-lease.ts`
(§ A tier-3 record also clears on *completion* below) drops the tree
record only while it still *names* the pr being released — precisely so a tree
that has moved on to another PR is not stripped of live protection — so it is
no shortcut through this residual.
Two sessionless resolvers on the *same* PR from *different* trees are
unaffected either way — that axis is the per-PR presence lease's own, and stays exactly as it was.

That `pr`-based ownership test is not merely the no-session tier's own
concern: an *identified* session's `claimTreeLease` and the irreversible-post
fence (`assertTreeMutationAllowed`) both read this *same* file too. Deciding
ownership there with `isMine` — correct for the per-PR presence record it was
built for (already scoped to (tree, pr) by its own filename, so actor equality
is the only question left) — is silently wrong once this file can also hold a
`holder: 'worktree'` record, since `isMine`'s worktree branch answers actor
equality alone and never even looks at the caller's session: an identified
session claiming PR 888 would silently take over — no refusal, no takeover
diagnostic — a live sessionless resolver's claim on PR 999 in the same tree,
and the post fence would let a post through under the identical condition.
`treeIsMine` (lease.ts) is what both share instead: a `holder: 'worktree'`
record is "mine" only when its `pr` matches the caller's, the tree-wide
mirror of `claimSessionlessTreeLease`'s own reasoning; a `holder: 'session'`
record is unaffected, still exactly `isMine`. A matching pr is a deliberate,
intentional smooth handoff (the tree-wide mirror of the per-PR
ruling that an identified session may take over its own tree's presence
record freely), not a hole reopened.

One further residual, unaffected by any of this: `assertTreeLeaseUnchanged`'s fence compares `(pid, host, generation)`,
which is `(0, host, generation)` for every no-session claim — so it cannot
tell two *different* sessionless admissions for the *same* pr apart from one
another, only from a takeover (which always mints a fresh `generation`).
That is the sessionless tier's identity floor stated everywhere else in this
document, not a new gap.

A takeover — the previous holder confirmed dead or gone quiet past the
staleness window — additionally takes the state mutex of the PR *this claim
itself is for*, the identical "any write that mints a new generation takes
the state mutex" rule the per-PR lease already applies to itself: without it,
a takeover can land while an already-admitted command for that same PR is
still finishing inside its locked section, and the fence below would then
refuse that harmless, already-in-flight completion. That coordination is
scoped to the PR being claimed; a takeover for a *different* PR than one an
in-flight command is finishing is not ordered against it, and the admission
fence (`assertTreeLeaseUnchanged`, run alongside `assertLeaseUnchanged`
inside every locked section, per the per-PR lease's own admission-fence pattern, and
shared by both ladder tiers) is what catches that narrower residual
instead.

`clear-lease [PR]` drops *both* this tree's per-PR lease and its tree lease in
one call — a refusal whose documented remedy left the tree still locked would
not be a remedy at all.

### PR-wide admission across working trees

The lease above is scoped to *(working tree, PR)*, which left the cross-tree
case open: nothing stopped two linked worktrees enumerating the same
unresolved threads and each replying with its own outcome — the same doubled
outcome replies measured within one tree, and the same
unrepairability. So a claim also refuses, with **exit `13`**, while any *other*
tree holds a live lease on the PR.

It is **derived, not stored**: `leaseFilesFor` already enumerates every tree's
lease for a PR and `leaseAlive` already says which are still being driven, so
the gate is a rule read off files that exist rather than a second lease to
expire. That is what makes it self-clearing for free — a dead or idle worktree
stops being live by exactly the per-session test, so it can never wedge the PR
for the others, which a stored PR-wide lease would have had to re-solve.

The check runs **inside the state-mutex hold**, on every claim that could newly
grant this tree the PR: a creation, a takeover, or a renewal of a lease that has
gone quiet past half the staleness window. Renewals *inside* that margin skip it
deliberately, and the skip is an argument rather than an optimisation — a
foreign tree may only be admitted after observing this lease as not alive, under
that same mutex, and a `lastSeen` hours from the boundary is unambiguous to that
read. It is also what keeps `claim-held`'s per-key fan-out off the state mutex.

It gates **mutations only**. Every read (`get`, `held`, `held-keys`,
`parked-keys`, `verified`, `rounds`, `lease`) is ungated from any tree, and the
gate is per-PR, so two worktrees driving two PRs are unaffected — the
linked-worktree topology the per-hold `actor` provenance serves is intact, and
that provenance stays load-bearing for a different question:
admission says who may drive *now*, provenance says whose push answers a promise
made earlier, which outlives the tree that made it.

`lease [PR] --all` is the read surface — every live lease on the PR with its
worktree path, its `holder`, its `pid` field (`0` for a `worktree` holder, which has no session to name) and a `self` flag, `[]` for none. It is the only
sound other-worktree check; a hold's durable `actor` is not, because a hold
deliberately outlives its driver so a successor can finish it, so a foreign
`actor` never proves anyone is still driving. `clear-lease [PR] --all` is the
takeover: it drops every tree's lease, live ones included, and is the only route
that reaches a tree the operator cannot stand in.

`reset` is gated too, and that is a decision rather than an inheritance — an
exemption would still take a lease on the way to being refused, and this
session's next command would fast-path off it without ever meeting the gate.
`reset`'s own exit `9` above stays reachable for a tree already admitted before
the foreign lease existed.

A tree in **another clone** has no lease here to read, so the same question
is put to the drive ledger instead: at arm, while the ledger names a running
driver in another clone, `drive.ts` refuses with exit `13`, naming the age of
that driver's heartbeat and, once it is past the lease window, printing the
`--take-over` command (§ Picking up a stopped drive).

A runtime with **no session identity** is inside the gate rather than outside it. It claims a record whose `holder` is the *working tree* rather than a
session — the cross-tree question needs a tree, not a pid, and `actor.ts` already
supplies one — so two such resolvers in two trees refuse each other, which
they could not if neither wrote anything for the other to read. It is scoped
to the tree, so it cannot refuse a sibling invocation of its own agent; and it
has no pid, so it clears by staleness alone, exactly as a lease held on another
host does. The one case that still claims nothing is a sessionless caller whose
tree *already* holds a live session lease: the tree is represented already, and
overwriting that lease would be a takeover the caller cannot justify.

### A tier-3 record also clears on *completion*

If staleness were the only way one cleared, the asymmetry between the two
holders would be wider than the missing pid alone requires: an identified
session is released the instant its pid stops answering, however it ended, while
a sessionless resolver that finished its work *perfectly* would leave a record
refusing every other working tree (exit `13`) for a whole staleness window. A pid is
missing evidence of *liveness*; it is not missing evidence of *completion*, and
something in the arrangement does hold that second fact.

`converge.ts` in `resolve-review-comments` is what holds it — the loop that
spawns each sessionless pass, and therefore the only process that knows when it
will spawn no further one (`drive-pr`'s own `drive.ts` never needs this: it
exports `$DRIVE_PR_SESSION`, so a drive it runs is ladder tier 1 and never
sessionless in the first place). At the terminal exits of that loop it spawns
`scripts/release-sessionless-lease.ts`, the same cross-skill shape, and for the
same reasons, as `assert-post-allowed.ts` — a spawn of this skill's own
executable rather than an import of `lib/state/lease.ts`, since
`resolve-review-comments` is usable standalone, in repositories that have no
`drive-pr` at all (`post-fence.md`).

Which exits, precisely, is a gate rather than a placement, and the distinction
is load-bearing: converge.ts releases only when that run *actually spawned a
pass*. **Reaching a terminal return is not evidence of having claimed
anything**, and neither is the pass's exit code. **Every one of converge.ts's
`finish` call sites is reachable with no pass having run** — all of them, which
is what makes a per-site rule the wrong shape, since there is no subset for it
to be right about. Worked routes, as examples of that universal rather than as
a list to keep complete:

- a `--dry-run` against an already-converged PR, which exits through the
  converged branch *above* its own dry-run early return;
- a forwarded-flag typo that `await-round.ts` refuses with exit 2 on
  iteration 0;
- the ordinary already-converged run, converging at round 0;
- a pass command that fails to *spawn* — `run()` never rejects, and reports 127,
  which a real child may also exit with. This one does not add a return site;
  it reaches an existing one with the flag in the wrong state, which is why the
  gate reads `proc.ts`'s `spawnFailed` rather than the code;
- `--max-rounds 0`, where the loop body never executes and control falls to the
  `finish(6)` at the bottom. Listed because it is the route an enumeration most
  easily misses — which is the argument for stating the
  universal above rather than trusting any list, this one included.

Gating on which `return` was reached would release on the dry-run,
forwarded-flag and already-converged routes; gating on `code !== 0` would
release on the failed-spawn route. A run that claimed nothing can only be holding a
*sibling* resolver's record, so dropping it strips a live drive's protection and
admits another worktree: the hazard, reintroduced by a cleanup step.
That is emphatically not the "two sessionless resolvers in one tree" residual
at the end of this section — that one is about a resolver *finishing*; these
fired when the invocation had started nothing.

The flag's own honest bound, since it is a proxy: it proves a pass *ran*, not
that a claim was taken. A pass that died before its first mutating
`drive-state.ts` call took none, and nothing observable separates that from one
that took several — so the release errs toward firing there, inside the same
bound as the residual below.

What it removes is deliberately narrower than `clear-lease`'s human override,
and each narrowing closes a hazard rather than expressing caution:

- **Only a `holder: 'worktree'` record**, decided by the *record*'s own holder
  field and never by the releasing process's identity (a `converge.ts` running
  under Claude Code spawns passes that inherit `$CLAUDE_PID` and so hold tier-2
  *session* leases; it then correctly releases nothing). A session lease already
  self-releases with its pid, so there is no asymmetry there to close, and
  dropping one would put an automated path inside the pid-recycling reasoning
  `isMine` carries.
- **The tree record only while its `pr` still equals the PR being released.**
  That file is one per working tree, naming whichever PR the tree drives now, so
  an unconditional drop at PR A's completion would strip a live sessionless
  drive of PR B — a new hazard, not a leftover one.

Everything else about it is best-effort by design, and the direction is what
makes that legitimate rather than a fail-open: the release authorises nothing,
so a `drive-pr` that is not installed beside the caller, a failed spawn, a
contended state mutex or an unreadable record all leave the record to expire by
staleness — exactly the behaviour that existed before this, and never a changed
exit code for `converge.ts`. (Contrast `assert-post-allowed.ts`, which guards an
irreversible `POST` and must therefore refuse on any unreadable answer.) It runs
under the PR's state mutex, like `clear-lease`, so a removal can only land
*between* locked sections and never between an admitted command's fence and its
write.

What it does not cover, stated rather than implied. A bare interactive
pass run without the `converge.ts` wrapper has no defined "done" moment to hook,
so it still clears by staleness alone. And two sessionless resolvers in *one* tree
on one PR remain indistinguishable — tier 3's identity floor everywhere else in
this document — so one finishing releases a record the other also relies on;
bounded, because that record never excluded a caller in its own tree, and the
sibling's next mutating command re-claims it.

### The held batch

The items replied to with a fix-dependent outcome — `accepted`, or a `moot`
whose premise is this round's unpushed fix — and deliberately not yet resolved,
because the change answering them is not on the PR. SKILL.md § 3 records each
one at reply time through the `hold` command of `drive-state.ts`, supplying its
key, kind and outcome; § 6 reads them back (`held`), resolves them after the push, and
releases each key immediately after its own resolve succeeds
(`release-held --key K --token T`, the token from `claim-held`) — a `finding`
answer is not idempotent, so batching every release to one end-of-batch `--all`
call would re-post duplicate comments for a crash mid-batch. `release-held
--key` also refuses a key that isn't actually in the batch (a typo or an
already-released key) rather than succeeding as a silent no-op, since that
success would read as "released" while the real item stays held.

A `finding` hold additionally requires the reply reason on stdin — a thread's
reply is already posted to GitHub by hold time and survives independently, but
a finding's answer can't post until step 6, so the reasoning exists nowhere
else until then. `STATE_SCHEMA` validates every held entry's full shape (a
non-empty `key`, `kind` in `thread|finding`, `outcome` in `accepted|moot`, a
numeric `round`, a non-empty `actor`), not just that `.held` is an array — a
well-formed array of ill-shaped entries would otherwise pass the check while
being unusable by `held-keys` or the release path.

Each entry also carries its own **push provenance**: `actor`, the
working tree that made the promise, and `verifiedSha`, the push that carries
its fix — written by `stamp-held` onto the calling tree's own holds only, and
absent until that push happens. `claim-held` compares `--pushed-sha` against
that per-item stamp rather than the PR-global `.verifiedSha`, which every
driver of the PR shares and which therefore vouched for holds whose fix a push
never contained. `restore-held` takes both back verbatim rather than
re-deriving either.

It is durable because otherwise that window lives only in the agent's
context, and losing it is silent in **both** directions: a thread replied `**accepted**` and
never resolved returns next round as an unfixed finding, or the agent re-replies
and puts two outcome tokens on one thread — corrupting the reviewer-scoring
sample the outcome vocabulary exists to feed.

Only the fix-dependent outcomes are holdable; `hold` rejects the rest. `rejected`
/ `wont-fix` / `deferred` are claims about the finding's **merit**, which no
later commit changes, so they are replied to and resolved in one step and have no
waiting period to survive. That is the same split `answer-summary-finding.ts`
enforces with `--pushed-sha`, so a compaction-confused agent is stopped on the
thread path exactly as on the summary-finding path.

### The parked entry shape check

The shape check reaches **inside** `parked`, not just to the container. Checking
only that it is an array stops one level short of the thing the array is for:
`{"parked":[{}]}` would pass, `parked-keys` would emit the literal `null` for
that entry, `drive-status.ts` would match it against no thread id and no
fingerprint, and the drive would re-arm work a human had parked — the mode-6
loop above, reached through the validator that exists to protect the parked
set. Every entry must carry a non-empty `key`, a `kind` of `thread` or `finding`, a non-empty
`reason` and a numeric `round`: deliberately the same predicate `park` enforces
at the write side, so the validator restates the writer's invariant rather than
inventing a second, weaker one to drift from.

### Accepted residuals in the state layer

These residuals are known and deliberately not closed. They are recorded here
so a later round re-derives the decision instead of the finding.

**`release()` (`lib/state/lock.ts`) still has narrow, accepted residuals in its
rename-then-verify restore path.** `release()` renames the lock to a
generation-keyed quarantine path *first*, and only afterward verifies the moved
copy still carries this process's own marker — restoring it if not. That
closes the "verify, then have the lock replaced before acting on the verified
answer" race a check-then-act shape (verify the owner marker, *then* rename)
would have.
What remains is the restore step's own vacancy window: between the rename-out and a
verified-mismatched rename-back, the canonical path is briefly vacant, and
`.recovering` — a second, short-lived mkdir-based gate every rename-out/maybe-
restore dance (`release()`'s own, and `acquire()`'s stale-break) must hold for
that whole sequence — is what fences it. `.recovering` is itself
generation-fenced and permanently tombstoned on break/release (not deleted),
matching `lock`'s own scheme, mitigating — but not fully closing — the "gate
protecting the gate" class one level down: `.recovering`'s *own* acquisition
(`acquireRecoveringGate()`) is the identical `mkdirSync` + separate
`writeFileSync`-marker two-step `lock` itself has, so a process suspended
between those two calls can have its unmarked directory broken and replaced,
then still publish its own marker into the successor — both processes then
believe they hold the gate. That case is open: the fencing and tombstoning
described above do not close it.

The genuinely open residual is therefore two-fold — not just fresh-acquisition's
*initial* `mkdirSync(lock)` (the very first claim, before this process ever
attempts `.recovering`'s gate at all, not itself covered by any of the above
since a concurrent restore dance's rename can still land on that
freshly-created, still-unmarked directory) but `.recovering`'s own acquisition
too, per the paragraph above. Closing either needs collapsing the claim and its
identity-publication into one atomic filesystem operation (a `wx`-flagged file
write, matching `lib/state/claims.ts`'s own already-proven pattern) rather than
the current mkdir-a-directory-then-separately-write-a-marker shape — a
redesign of the acquisition primitive
itself, not a residual of the release path this note is about. **Accepted**
given this lock's actual blast radius, stated precisely rather than
softened: `lib/state/lock.ts`'s header is explicit that two believed-holders
means "the earlier parked decision is gone — a HITL decision forgotten, or a
durable round bound weakened, with no error anywhere" — a silent, unrecoverable
loss of `drive-pr`'s own tracking state, not a duplicate dispatch a rerun
reconstructs. It is scoped to that tracking state alone — the reviewed PR's
code, CI results, and GitHub's own thread/comment records are untouched by
this lock either way — but within that scope it *is* data corruption, and
re-running the loop recovers a lost round budget or a re-derivable decision,
not a human's original parked answer once it is gone.

**Sessions sharing one agent process are one session to the lease.** An
in-process subagent inherits its parent's `$CLAUDE_PID` by construction, so the
lease does not separate a background subagent from the session that spawned it
— only two agent *processes*, which is the observed case.
Separating them needs an identity that outlives a subagent's individual tool
calls but expires when the subagent does; the per-subagent id the harness does
expose is not liveness-checkable, so a finished subagent's lease would block its
own parent for a whole staleness window. **Accepted**: refusing to guess in the
direction that wedges live work is the same trade `lib/state/actor.ts` records
for its own derivation.

**State in a legacy location is refused or reported, never adopted.** Two
older layouts kept the state inside the repository's git directory: a
worktree-private `.git/worktrees/<name>/` and the clone-wide
`--git-common-dir`. Both are wrong places for it — the first fragments one
PR's state per worktree, and the second grows a permanent lock-quarantine
entry per acquire/release cycle inside the directory every git-aware tool
walks. A drive that cannot see state left there would read an absent file and
start fresh, with its round budget, verified SHA and **parked human
decisions** gone — silently, because an absent file is a legitimate fresh
start.

- **`--git-common-dir` state refuses.** `resolveStateDir()` exits `2`, naming
  the entries it found, while that location still holds unmigrated state, so a
  drive never starts on the wrong (empty) side. Fix:
  `bun "<skill-dir>/scripts/migrate-legacy-state.ts" --apply` (bare, without
  `--apply`, it is a dry run that changes nothing — the same posture as
  `reap-state.ts`'s `--delete`). `lib/state/legacy-state.ts`'s doc comment
  states the full guarantee, and `SKILL.md`'s "State directory" bullet the
  day-to-day summary. State already outside the repository under another
  default moves with `bun "<skill-dir>/scripts/migrate-state-dir.ts" --from <old dir>`.
- **Worktree-private state is not detected.** `drive-state.ts` carries a
  one-time warning for orphans of that layout (`lib/state/orphans.ts`), but it
  looks for them under the resolved state directory's `worktrees/` and is
  skipped whenever `$DRIVE_PR_STATE_DIR` is set, so under the current layout
  it never fires. A clone that still has state in `.git/worktrees/<name>/`
  must adopt it with `bun "<skill-dir>/scripts/portable.ts" recover-state <source> <destination>`. Recovery refuses an existing destination, preserving
  state a concurrent driver created in the meantime.

### 9. Everything else that can read green when it is not

The `ci` verdict is not part of the convergence decision — an unrelated failing
suite is a normal mid-review state — but `announce-merge-ready.ts` trusts it,
and that announcement is the artefact a human acts on. Each of these produced a
false "green":

- **A superseded check-run.** One SHA carries several runs per name after a
  re-run or a cancelled attempt, and GitHub returns them **newest-first** — so
  the `last` that reads as "newest" in most jq idioms is the oldest. Reduced to
  the newest per `(app, name)`; grouping by name alone would let one app's newer
  success discard another app's failing verdict for a same-named check.
- **A pending legacy commit status.** `pending` is excluded from the failing set,
  so it has to be collected into the pending set explicitly or it lands in
  neither and the verdict reads green mid-flight.
- **An unreadable commit-status API.** A timeout or 403 must become
  `unknown: …`, never an empty (therefore clean) set.

### 10. A finding marked answered by someone who cannot merge

PR comments are world-writable and fingerprints are visible in the sticky
comment, so without an author check any passer-by could post a
`drive-pr-addressed` marker and let the drive converge over live work. Markers
count only from authors GitHub's own `author_association` reports as `OWNER`,
`MEMBER`, or `COLLABORATOR` — computed server-side, so comment content cannot
spoof it.

Related orderings, all enforced rather than documented:

- An `accepted` or `moot` summary answer requires `--pushed-sha` equal to the
  PR's live head, so its marker cannot exist before the change that answers it
  is on the PR. This is the summary-finding equivalent of holding an accepted
  thread until after the push.
- That SHA is stamped into the marker, and the marker stops counting once the
  reviewer's own review moves past that head — or merely reaches it, for a
  finding the reviewer is not carrying forward in its backlog blob. The
  *fix-dependent* outcomes expire
  this way — `accepted` claims "fixed as of this head" and `moot` claims "the
  code it describes is gone as of this head", and the reviewer re-emitting the
  finding falsifies either. `rejected` / `wont-fix` / `deferred` are claims
  about the finding's *merit*, which no commit changes, so they stay
  content-keyed. Without the split, an incomplete fix, a revert, or a later
  round reintroducing the code reproduces the finding verbatim, so its
  fingerprint is unchanged and the old answer retires the live occurrence
  permanently. Which outcomes are fix-dependent is decided once, at the point of
  answering, and read back off the marker's shape — the enumerator holds no
  second copy of the taxonomy. The ancestry question is deliberately "*where* is
  the reviewer relative to this commit", not "has it been reviewed": a rebase or
  force-push leaves a reviewed head that does not descend from the marked commit
  at all, and asking it the other way round reads that as "not seen yet" and
  goes on suppressing a finding the reviewer is re-emitting on the rewritten
  branch. `collectAddressed` in `summary-findings.ts` says which positions
  honour a marker — strictly behind for any finding, the marked head itself only
  for one the reviewer is carrying forward in its own backlog blob — and every
  other position, including cannot-tell on a shallow clone, expires it rather
  than restoring the suppression.
- Past that, one class of finding is exempt from the expiry for longer, and the
  exemption is itself
  bounded. The reviewer forwards its `winddown-deferred` backlog entries by
  their original round without re-verifying them, so re-emission at a fix's head
  falsifies nothing, and expiring their markers re-asked a verified-fixed
  finding every round. The same missing signal is why the
  exemption cannot be permanent: a later round that *reverts* the fix re-emits the
  identical fingerprint under the identical reason, indistinguishable from a
  routine carry-forward, and an unbounded exemption suppresses it forever. The marker therefore also carries the round it was posted in
  (`<fingerprint>@<sha>#<round>`), and the exemption holds through round
  `<posted-round> + WINDDOWN_EXEMPTION_ROUNDS` inclusive, lapsing the round
  after that — bounding silent suppression at a known size instead of trading
  it against an unwinnable loop. A marker with no round, or a sticky with none
  to measure against, gets no exemption at all.
- `unaccounted-…` slot keys are scoped to the reviewed **head**, not the sticky
  comment id. The sticky is upserted, so its id never changes; keying a slot on
  it means a later round's unidentifiable finding inherits an older answer.

### 11. Anchoring judged across the PR's whole history

A body finding is summary-only when its path received no inline comment. Testing
that against *every* inline comment the PR ever received means one thread on
`a.ts` in round 1 hides every later summary-only finding on `a.ts`, forever.
Anchoring is scoped to the round the sticky describes, using the
`ai-review-round` marker the reviewer stamps into both.

### 12. The PR changes while the witnesses are being gathered

`api_head` is read at the top of `evaluate()`. The thread query, the summary
enumerator and the check-run reads all follow it, each with its own 120s
deadline, so a push by another actor anywhere in that window leaves every
witness describing a head the PR no longer has — and the terminal claim would
then name a SHA nobody reviewed. The same window reopens, later and wider, in
`announce-merge-ready.ts`, between its status call and its `POST`.

**Guard**: both re-read the head at the last possible moment. In
`drive-status.ts` that is one function (`still_on_head`) called before **every**
terminal return — `CONVERGED`, `HITL_PARKED`, `REVIEWER_FAILED` and
`PR_CONFLICTING` alike — reporting `HEAD_MOVED` (exit `4`) if it changed
(and, per § 15, if the PR's **base** changed instead — the same window
reopens for a mergeability verdict that depends on both);
`announce-merge-ready.ts` re-reads immediately before posting and refuses.

One function rather than a check written out at each site, because the first
version guarded `CONVERGED` alone and review immediately found `HITL_PARKED`
with the same hole: also terminal, also stopping `drive.ts`, returning a few
lines earlier. A per-site check has to be remembered again at the next terminal
state anyone adds.

Non-terminal returns are deliberately unguarded — a stale `ROUND_READY` just
re-enumerates against the newer head next pass, which is what the loop does
anyway, whereas the terminal states are the ones that stop it.

**And the witness reads both halves, because a merge moves no ref.** Re-reading
`headRefOid` alone would leave the guard blind to the one transition it most
needs to see: a PR that merges mid-evaluation keeps the exact same head, so the
comparison passes and the drive is told `CONVERGED` / `HITL_PARKED` /
`REVIEWER_FAILED` about a pull request that is no longer open — where the
required answer is `PR_NOT_OPEN` (`5`), the state that stops the loop without a
push. That is the same class the single function closes, arriving through the
other half of the witness, so liveness and head are one API call and are
asserted together. `announce-merge-ready.ts` reads both
too, and exits `5` rather than posting "safe to merge" about a decision that has
already been taken.

Deliberately left reading the head alone: `answer-summary-finding.ts` reads only the
head, to check `--pushed-sha` is the PR's tip. A merge does not falsify that
claim — the fix did land — so the marker it posts stays true; the cost is a
stray comment on a finished PR, not a wrong statement on a live one.

### 12b. The announcement is written before the world is re-checked

The pre-`POST` re-read narrows that window; it cannot close it. The `GET` and the
`POST` stay separate operations, so a push landing between them still publishes
"Safe to merge" for a head nobody reviewed, and the duplicate reconciliation
below does not help — it dedupes marker **ids**, and one announcement for an
unreviewed head is not a duplicate of anything.

**Guard**: after the `POST`, re-run the **same** `check_live_state` the pre-`POST`
gate uses — state, head **and mergeability** in one snapshot — and **withdraw
this process's own comment** unless it returns clean. Deleting by the id the
create returned means the withdrawal can never touch a comment written by anyone
else — the same property the duplicate-race reconciliation relies on.

Mergeability is in that set because the comment claims it, and state-plus-head
cannot witness it: a **base** branch advancing between the pre-`POST` check and
the `POST` flips this PR to `CONFLICTING` with the head sitting exactly where it
was, so a head-only confirmation passes and leaves "Safe to merge" standing on a
PR that no longer merges (measured). Asking
the identical question on both sides of the write is also what stops the two
predicates drifting apart.

Every non-zero return withdraws here, including the two the **pre-`POST`**
withdrawal guard deliberately refuses to act on — an unreadable read, and a
`mergeable` that is `UNKNOWN` or malformed. That is not a contradiction of §
12a's narrow rule but a different question: pre-`POST` the target is an *earlier
run's* announcement, which may still be correct, so it demands positively
parsed `CONFLICTING`; here the target is this process's own comment from seconds
ago, and being wrong costs a re-run rather than a destroyed artefact.

"Unless confirmed", not "if changed": an **unreadable** post-write read also
withdraws, exiting `1` where a confirmed change exits `4`. Cannot-confirm and
confirmed-changed are the same absence of proof that the PR is still open on the
reviewed head; treating only the second as unsafe — logging "verify by eye"
and falling through to exit `0` with the announcement standing — would reopen
the gap this guard exists to close through the one read it could not make
succeed.

Residual, stated rather than papered over: a reader who saw the comment in the
seconds before the withdrawal has still seen it.

**And the withdrawal can itself be interrupted**, which the post-write re-read
alone does not cover: a process killed between the `POST` and that re-read — or
one whose `DELETE` failed — leaves an announcement standing for a head the PR has
since moved past. Scoped to the live head, the idempotence sweep could never see
it: it asks "have I announced *this* head", and an announcement for an older one
carries a different marker, so every later invocation looked straight past it
forever.

**Guard**: the sweep matches **any** `drive-pr-merge-ready` head, and each run
retracts every announcement for a head the PR has **demonstrably moved past** —
a strict ancestor of the live one — before doing anything else, including on the
already-announced path, since a stale announcement is wrong regardless. That
cleanup is best-effort by design: a `DELETE` that fails is reported, never fatal,
because one un-deletable comment must not block every future announcement on the
PR. It is also skipped entirely under `--dry-run`, which promises no mutation.

Ancestry, **not** "a head I do not recognise". Nothing can read the head
atomically with the `DELETE`, so an unfamiliar head may be a *newer* one another
driver validly announced, and deleting that destroys the correct artefact. A
descendant is never an ancestor, however the timing falls, so the destructive
direction is closed by the predicate rather than by narrowing a window.

**Accepted residual: a rebase or force-push strands its announcement.** If the
PR is force-pushed to a head that does not descend from the announced one, that
announcement is neither ancestor nor descendant, so this cleanup leaves it —
standing next to a later valid announcement, vouching for a commit the branch no
longer contains. Closing it would mean deleting on "unrelated", and *unrelated*
is exactly the shape a concurrent driver's newer announcement has: the two are
indistinguishable from ancestry alone, and no ordering of the reads separates
them. Between leaving a stale comment and deleting a correct one, this leaves
the stale comment. Retract it by hand after a force-push.

## When the reviewer will not answer, so `CONVERGED` is unreachable

`CONVERGED` is defined against the posting reviewer publishing a check-run and
an `ai-reviewed-sha` stamp for the **current** head. Measured conditions stop
that happening at all, and in each the driver reports `AWAITING_REVIEWER` (or
`STALE_REVIEW`) until `--timeout` — a wait state for something that is not
coming. None of them depends on which files a PR touches: where they were
measured, PRs changing only agent-instruction files were reviewed normally, and
one was reviewed fourteen times.

### A draft PR is reviewed, and then marked Ready

Whether a draft is reviewed at all is a property of the reviewer's deployment.
In one measured deployment the posting reviewer reviewed drafts:

| PR | Created | Posting reviewer posted | Still a draft when it did |
|---|---|---|---|
| A | 14:45:02Z | 14:46:16Z | yes — never marked Ready |
| B | 08:23:42Z | 08:24:49Z | yes — never marked Ready |

That is an **operator setting** of the reviewer service, not an invariant: the
same reviewer can be configured to skip drafts, and a CI-hosted reviewer job
commonly does. A repository declares which it has with `drive.reviews_drafts`
([README.md § Consumer configuration](../README.md#consumer-configuration)).

What does not vary is the other half. Many external review bots refuse a draft
outright (CodeRabbit posts "Review skipped / Draft detected", measured on the
same PRs), and a CI-hosted reviewer job typically carries
`!github.event.pull_request.draft`. So the reviewer populations disagree, and
that asymmetry is worth spending on purpose:

- the drive works the draft normally, clearing what the draft-reviewing
  reviewer found;
- **after the first completed round** (by default; `pull_requests.mark_ready`
  can name a later round, convergence, or never) it marks the PR Ready (`mark-ready.ts`),
  which fires `ready_for_review` and summons the reviewers that skip drafts;
- so the pass of each reviewer that skips drafts — one per push, often
  billed — lands on a head whose obvious
  findings are already gone, instead of on the branch's first draft.

Marking at the *start* would spend that pass on the untouched branch; marking at
*convergence* would summon findings onto a PR nobody is driving any more. The
end of round 1 is the only point that is neither — with one deliberate
exception: a PR that is already `CONVERGED` at the very first gate has no round
to end. There, `drive.ts` marks it Ready and re-gates once anyway (SKILL.md
§ Terminal states), on the judgment that one pass by those reviewers on a
genuinely converged head is worth more than never summoning it at all — accepting that
this specific path exits without driving whatever that pass then finds, unlike
every other round.

`isDraft` is still read in the opening snapshot, still validated as a boolean,
and still `INDETERMINATE` when it is neither — it stopped being a gate and
stayed decision evidence, because `mark-ready.ts` reads it to decide whether
the transition is owed and `false` means "already Ready, nothing to do". A
partial response accepted there would silently skip the transition on the one
PR that needs it.

The transition is once per PR and durable, and the facts that make it so are
recorded separately because they are different claims about the world:

- `readyMarkedRound` in the drive state is written **only after `gh pr ready` is
  confirmed**, so a non-zero value means the event genuinely fired. That is the
  record `mark-ready.ts` reads first, before it looks at the PR at all, and it
  is what refuses to undo a human's later conversion back to draft.
- The in-flight claim is a **filesystem lease** (`drive-pr-<PR>.ready-claim`,
  the same primitive and staleness window as the held-batch claims), which is
  what stops drivers in different worktrees from both firing the event.

Collapsing the two into one field — set before the call, cleared by the failure
branch — would be permanent in the one case that runs no failure branch at all.
A driver killed between claiming and firing would leave the field non-zero
forever, every later invocation would answer `already-marked` without asking
GitHub, and the PR would stay a draft nothing would ever mark. A lease needs no rollback: it expires,
and the next round takes the transition over.

Consequences worth expecting rather than diagnosing. `claimed-by-other` is
**not** proof the transition completed — another driver holds the lease and may
still be in flight, or may die holding it; the drive reports it and relies on the
lease expiring rather than waiting on that driver. And a **non-zero
`gh pr ready`** is not proof the transition did not apply: a request that landed
and lost its response exits non-zero with the PR already Ready, so `mark-ready.ts`
re-reads before deciding, and records rather than retries when the PR is Ready.
Firing the event twice is what re-triggers the review (often a billed one)
this ordering exists to spend deliberately.

One wait a draft can enter that a Ready PR cannot: if the posting reviewer does
not review drafts, it will not publish and the drive polls `AWAITING_REVIEWER`
to `--timeout`. The gate cannot read the reviewer's own settings, so it
**explains the wait in the reason** rather than gating on it, using
`drive.reviews_drafts`: `false` says to mark the PR Ready, `true` says to check
that the reviewer's draft setting is still on, and unset says some reviewers
skip drafts. Refusing to drive drafts on the chance the reviewer skips them
would reinstate exactly the stall that driving drafts removed.

The per-PR reviewer ceiling below gets no such treatment: it lives in a
service the drive cannot read, and it has no setting to name.

### The reviewer stops after roughly thirteen or fourteen rounds

A reviewer service can cap how many rounds it reviews on one PR. In one
measured deployment, counting heads carrying the posting reviewer's check-run:

| PR | Heads | Reviewed | Unreviewed | Sticky's last `ai-review-round` |
|---|---|---|---|---|
| A | 19 | 14 | 5 | 14 |
| B | 23 | 13 | 10 | — |

The unreviewed heads are the **last** ones in both cases. The reviewer does
re-review pushed heads normally — other PRs, one of them six commits long,
carry a check-run on their final head — so this is a per-PR ceiling, not a poller that
never returns. The cap was not in the repository's own reviewer configuration;
it lived in the reviewer service, which the repository cannot read.

This is why **PR A never converged.** It ran seventeen rounds; the reviewer
stopped after fourteen, and the last three rounds' findings came from a second
review bot the driver deliberately
does not gate on. Every round past the ceiling is unconvergeable by
construction.

**`--max-rounds` does not bound this, and reading it as a safety margin is a
mistake.** The ceiling is cumulative over the PR's whole life; `--max-rounds`
(default 10) counts from the *driver's* durable state, which starts at zero
whenever a drive starts. A PR that already absorbed reviewer rounds — from an
earlier drive, from `resolve-review-comments` passes, or from plain human
pushes — crosses the ceiling well before a tenth new round. The two counters
answer different questions and only coincide on a PR whose first push was also
its first drive.

So the check is not "how many rounds has this drive run" but "what round is the
reviewer on", which it stamps as `ai-review-round: N` into its own sticky. Read that marker
in the returned bodies:

```bash
bun "<skill-dir>/../../shared/command.ts" -- gh api --paginate "repos/{owner}/{repo}/issues/<PR>/comments?per_page=100" --jq '.[] | select(.user.login == "<reviewer-app>[bot]") | .body'
```

Past the ceiling the driver cannot distinguish "the reviewer has not got here
yet" from "the reviewer is finished with this PR forever", because both are the
absence of a check-run — the same shape as a `CONFLICTING` PR (§ 14). Naming
the ceiling as its own state is not built yet.

### A reply posted before the gate got stuck outlives the stuck gate

Step 1's gate (`drive-status.ts`) answers "is there *new* reviewer work" — it has
nothing to say about a reply that was already posted and is only waiting on its
own resolve. Every path to that resolve — SKILL.md § 3's reconciliation for a
crash-recovered thread, § 6 for an ordinary held one — ran **inside a pass**,
and `drive.ts` never hands a round to a pass unless the gate itself returns
`ROUND_READY` first. So for as long as the gate was stuck on either mode above —
a `CONFLICTING` PR with zero `pull_request` CI, or a PR past the reviewer's
~13–14-round ceiling — an already-answered thread stayed unresolved on GitHub
for exactly that long, which can be indefinite: nothing about the stuck gate
is guaranteed to resolve itself.

Measured: three threads on one PR were replied to `**accepted**` within a
quarter of an hour. All three eventually resolved, but not on the same
timeline: two were reconciled within hours by a later round once the gate
cleared, while the third stayed open for a further stretch after the gate had
already cleared for it too (the reviewer had moved on by dozens of rounds) —
simply because no pass had re-enumerated it yet. The design
recovers every one of these eventually, on its own; the gap this closes is the
"eventually" for however long a PR's gate happens to stay stuck, which nothing
bounds.

**Guard**: `bun "<skill-dir>/scripts/reconcile-replied-threads.ts" [PR...] [--all-open] [--dry-run]`
mirrors `triage-thread.ts`'s own inline reconciliation predicate (SKILL.md § 3) — a trusted
(`OWNER`/`MEMBER`/`COLLABORATOR`) author's last *qualifying* comment on an
unresolved, non-truncated thread opening with a bold outcome token (not
necessarily the literal last comment — a later trusted comment that doesn't
open with the grammar doesn't supersede an earlier qualifying one) — but runs
it standing alone, against GitHub's live state, with no dependency on
`drive-status.ts`
returning anything at all. `rejected` / `wont-fix` / `deferred` are merit
claims and get resolved immediately (releasing any stale prior fix-dependent
hold for the same thread — a trusted author can supersede their own earlier
`accepted`/`moot` reply with a merit outcome, and a hold left standing after
that would have step 6 later try to resolve an already-resolved thread);
`accepted` / `moot` are fix-dependent and get re-held via `bun "<skill-dir>/scripts/drive-state.ts" hold
--unconfirmed --comment-url <url>` (insert-if-absent by key, outcome, **and**
the qualifying comment's own permalink — required and recorded on the
ordinary, live-pass-confirmed `hold` path too, so a later comment that
supersedes the one a hold represents, confirmed or not, whether or not it
changes the outcome word, cannot inherit that hold's round; a fresh
unconfirmed entry replaces it at a sentinel round `claim-held` can never
match) rather than resolved, because this script
has no more ability than a fresh pass would to verify the promised fix
actually landed — that verification stays `resolve-held-thread.ts`'s job, for
whenever a real round next runs and its own step 3 confirms the fix and
re-holds it for real. A thread GitHub's code scanning account opened is
judged on its alert instead: a declined reply resolves only once the alert is
confirmed dismissed, a `moot` (never held there) only once it is fixed,
closed or dismissed, and either stays open while the alert is unconfirmed,
unreadable or unidentified, still releasing any hold the reply superseded.

Because it needs nothing from `drive-status.ts`, `drive-status.ts` runs it —
first, before it evaluates anything, on every *counting* invocation, i.e. every
pass entry. The gate reaching one of its **stuck** verdicts
therefore means the sweep has run and *succeeded* — not that it was skipped, and
not merely that it was tried — because those verdicts are withheld until it
does (the guard below). Its own failure is always reported.

That guarantee is scoped to the stuck verdicts and does not generalise to the
re-arming ones. `ROUND_READY` and `NOT_SETTLED` are returned over a sweep that
failed, and over one that never ran at all: the `--timeout` budget can be spent
before it starts, in which case it is skipped and deferred to the next pass
entry. Both re-arm, so the deferral is bounded by
the next invocation rather than by nothing — which is exactly why they are
excluded from the guard.

What sits ahead of the sweep can consume the budget that way. A
liveness read, because resolving threads on a PR that merged since the last
round is a mutation the round is not entitled to make; only `OPEN` sweeps, only
`CLOSED`/`MERGED` count as finished, and every other answer is unreadable. And
the loop-top budget check itself, which refuses to start any spawn once
`--timeout` is gone.

Neither that read failing nor the sweep itself failing can leave a stuck
verdict standing over an unreconciled PR, because the guard is on the verdict
rather than on either step: **every member of `UNRECONCILED_STOPPERS` is
withheld until a sweep has run and succeeded on this invocation**, degrading to
`INDETERMINATE` (1) instead. Named, not copied: `drive-status.ts` declares that
set once, and a prose copy of its membership goes stale the moment a code
joins or leaves it.
Nothing else licenses one, which is deliberate — a guard built as "successful
sweep, or any of these signals" has a hole per signal. Exit 2 is not one of
those signals: "2 is a property of the `gh` binary no retry clears" ignores that the sweep talks to GitHub over GraphQL, which an
old `gh` unable to report `--json mergeable` can still serve, so the sweep
runs, and can succeed, before exit 2 is reached. 5 has nothing to reconcile; 4
does not assert the drive is over, so every caller answers it by coming back
and that next invocation's pass entry sweeps. (In polling mode a failing sweep
is additionally re-attempted on every poll, so a 4 returned after the window
has been retried throughout — but that is a property of polling, not of the
exclusion: under `--once` there is a single iteration and no in-invocation
retry at all.) `--no-reconcile` and `--no-count` both suppress the sweep, so
neither certifies an `UNRECONCILED_STOPPERS` verdict.

3 (`CONVERGED`) is the one code where "requires zero unresolved threads, so no
failed sweep can be hiding one behind it" is true of GitHub's own thread state
but not of this script's `held`-state bookkeeping, which a resolved-thread's
cleanup can leave stale (a superseding merit reply resolves the thread and
then fails to release a stale prior hold for it) — and because the resolved
thread has already left every future unresolved-thread listing, no later
sweep ever revisits that cleanup.
That gap is real, but folding 3 into `UNRECONCILED_STOPPERS` blanket — the same
way 2 joined it — is NOT the fix: `--no-count`/`--no-reconcile` suppress the
sweep unconditionally, so blanket membership would make `CONVERGED` unreachable
through exactly the path built to reach it without a sweep — see the
`announce-merge-ready.ts` paragraph just below. Nor is "the sweep was not
suppressed" the fix on its own: the loop-top spent-budget skip and the
"liveness read just spent the budget" skip both leave neither flag set
either, so that reads as "ran and failed" on a sweep that never got a turn.
`drive-status.ts` instead gates `CONVERGED` with its own narrower condition,
checked separately from set membership: withheld only when the sweep
subprocess genuinely spawned this invocation and exited nonzero
(`sweepRanAndFailed`) — never on a suppressed invocation, never on a skipped
one either.

State precisely what that closes: for a single `--once` invocation it is the
whole fix. `drive.ts` never passes `--once` — it polls `drive-status.ts`
internally via `--timeout`/`--interval` — so on that path the withheld verdict
just re-arms the sweep for the next poll; by then the offending thread has
already left the unresolved listing, the retry sweep exits 0 with nothing left
to do, and `CONVERGED` is certified one interval later with the stale `held`
entry still unrevisited. The guard delays certification; it does not make the
cleanup durable across invocations; that is a separate, open gap.
`--no-count` re-reads (SKILL.md
§§ 3 and 6, `announce-merge-ready.ts`) do not re-sweep, and `--no-reconcile`
opts out. Run the script directly for what a gate on one PR cannot do: sweeping
a PR nobody is driving (`--all-open`, on a schedule or by hand), and previewing
one with `--dry-run`. A **scheduled** sweep carries `--bots-only` like the gate
does: the human-thread exception the flag protects is about running unattended, not
about which entry point ran, so a schedule gets the narrow scope and only a
human-attended one-shot gets the wide one.

### 13. Unbounded network calls

`--timeout` bounds the poll loop, never any one call. A stalled connection
therefore parks the driver past every advertised deadline.

**Every outbound `gh` call in this skill carries its own deadline** — the
status path (`drive-status.ts`, plus the helpers it invokes that reach the
network without going through it: `list-unresolved-threads.ts` and
`summary-findings.ts`'s own spawns) and the action scripts alike
(`announce-merge-ready.ts`'s comment reads, post and withdrawal;
`answer-summary-finding.ts`'s head read and post; `guarded-push.ts`'s liveness
and head reads; `drive.ts` and `drive-state.ts`'s PR resolution). The action
scripts matter as much as the status path a round's judgement depends on:
`announce-merge-ready.ts`'s last-moment read carries mergeability, a
load-bearing safety check that must not be an unbounded call.

That universal claim is **mechanized, not asserted** —
`__tests__/drive-pr-proc.test.ts` sweeps every `scripts/**/*.ts` under
drive-pr and resolve-review-comments for a spawn of `gh` outside each root's
sanctioned chokepoints, and asserts that no shell script (`.sh`) exists under
either root. It is a test because, merely stated, a claim like this drifts:
one migration can leave a single read on raw `gh` while the documentation
still claims otherwise, and a raw call degrades to an unbounded one wherever
the platform has no `timeout` utility (stock macOS).

Three properties make it a guard rather than a gesture:

- **Only the chokepoints are exempt** — `lib/proc.ts` for drive-pr, where
  `ghCall()` carries the deadline; `lib/gh.ts` and `lib/proc.ts` for
  resolve-review-comments. Nothing else, `summary-findings.ts` included: it
  goes through the chokepoint rather than a kill timer of its own over
  `Bun.spawn`, which would also make the documented `node` entry point
  unusable. A companion probe asserts the pattern matches each chokepoint's
  own spawn, so the sweep cannot go vacuously green.
- **Every spelling of the spawn is matched**, not just the one this repository
  happens to use. Enumerating API names leaks — an import alias
  (`import { spawn as launch }`) walks through it — so the matcher does not
  care what the callee is called: an argv array head, or *any* identifier
  applied to `'gh'` in argv-head position. It scans whole constructs rather
  than single lines, because the formatter's own output for a long argv
  (`run([⏎ 'gh', …])`) spans several. Indirection through a variable is the
  one form a pattern on literals cannot follow, so it is closed at its source
  instead — binding the bare string `'gh'` to a name is itself a violation.
  Deliberate obfuscation (`String('gh')`, `'g' + 'h'`) is out of scope by
  design: this is a gate against accidental regression, not an adversary.
- **The enumeration is recursive and cross-checked** against an independent
  `find`, because a count alone cannot notice a lost nested file.

Each of those is pinned by its own mutation probe, so a typo in the pattern or
the walker cannot make the sweep vacuously green.

The deadline lives in **one** place, `scripts/lib/proc.ts`: the timer runs in
the same process that spawned the child, so there is no external binary
(coreutils `timeout`) to depend on and no watchdog to outlive the script. A
shell background-and-`kill` watchdog would fire `kill` at a reused PID — it
has been measured terminating an unrelated later invocation — and a
same-process timer removes that class outright.

### 14. A merge conflict, reported as a slow reviewer

Measured: the base branch advanced mid-drive and
produced one conflict in a CI workflow file:

- `gh pr view` → `mergeable=CONFLICTING`, `mergeStateStatus=DIRTY`.
- **Zero** `pull_request`-triggered CI ran on the head. The only check-run on the
  commit was a dormant `github-actions / AI review` workflow, `completed/skipped`.
- So the posting reviewer never posted a check-run, and mode 4's guard — correctly —
  reported `AWAITING_REVIEWER` (exit `4`) and re-polled every 30s to `--timeout`.
- Work state was genuinely clean: 0 unresolved threads, 0 unaddressed summary
  findings. The drive had nothing to do and no way to finish.

Exit `4` means "not judgeable **yet** — becomes something else with time", which
is exactly what a conflict does not do. `drive.ts` propagated it verbatim, so the
operator was told a reviewer was slow about a PR that needed a `git merge`.

**Guard**: `drive-status.ts` reads `mergeable`, `mergeStateStatus`,
`baseRefName` and `baseRefOid` from the same `gh pr view` snapshot as `state`
and `headRefOid`. A conflict makes it **skip every reviewer gate** — each of
those returns `AWAITING_REVIEWER`, which is the wait being eliminated — but it
still enumerates the work, and reports `PR_CONFLICTING` (exit `9`) only when
that enumeration is empty. `drive.ts` stops on it with a message naming the fix
rather than flattening it into a generic failure.

**A conflict alone does not stop the loop.** Short-circuiting on the premise
that a conflicting head has no findings, "because GitHub runs no
`pull_request` CI on it", is wrong whenever the posting reviewer is not a
`pull_request` workflow. Such a reviewer can be a **poller**
whose eligibility predicate is *expected base branch, same-repository head,
head SHA not yet reviewed* — plus drafts, which it reviews (§ A draft PR is
reviewed, and then marked Ready) — and mergeability appears nowhere in it. A
poller is not stopped by a conflict, so real findings can sit on a conflicting
head; short-circuiting would discard them unread. Live work therefore returns
`ROUND_READY`, with the conflict named in the `reason` so the pass knows CI
will not run on what it pushes and can merge the base as part of the round.

**Skipping the reviewer gates is not skipping the reviewer evidence.** Skipping
the reviewed-SHA marker read too would leave a conflicting `ROUND_READY` saying
nothing about whether its findings were current or left over from an earlier
review — a state contradicting its own documented meaning, and a pass launched
on possibly stale findings. The marker is therefore **read and reported** on
this path: published as
`reviewer.reviewedSha` and spelled out in the `reason` as one of *reviewed this
exact head* / *last reviewed an earlier commit, so these findings predate it* /
*never stamped this PR at all*.

It is **not** gated on. Gating reinstates precisely the stall this mode exists
to remove — the reviewer may never review a conflicting head, so waiting for a
current-head marker is the 30-minute `AWAITING_REVIEWER` poll under a different
name — and the premise behind gating does not hold anyway: an unresolved thread
is open work regardless of which head it was posted on, and a fix for a real
finding is still a fix. What staleness changes is what the pass should *expect*
after it pushes, which is a thing to be told, not blocked on. Report, do not
gate. For the same reason the check-run fallback (`reviewedShaSource:
check-run`, "queried by SHA so it always matches") is **never** applied here:
on a path where no reviewer gate ran it would assert a review this script has
no evidence of. An absent marker is reported absent.

When the enumeration *is* empty, `PR_CONFLICTING` is checked **before**
`HITL_PARKED`: an operator handed both a merge and a question should be told the
mechanical one first, and the parked counts are named in the `reason` so the
precedence hides nothing.

The following properties of that guard are deliberate:

- **One snapshot, not one more call.** `mergeable` describes a *specific* head,
  so reading it separately from `headRefOid` would let the two name different
  commits — and since the verdict is terminal, that window is a false-terminal
  window. Folding the mergeability fields in alongside `state` and `headRefOid`
  is also one call fewer than before.
- **After head sync, before the reviewer gates.** Before them because they are
  what a conflict starves; leaving them armed reproduces the 30-minute wait this
  exists to prevent. After head sync because judging mergeability against a head
  the local tree has not caught up to is mode 3 in different clothing: a driver
  that pushes the base merge and re-polls inside GitHub's ~40s replication window
  would read the *pre*-push `CONFLICTING` and report a terminal state for a
  conflict it had just fixed. Deferring costs at most one `HEAD_LAG` poll —
  a conflict does not resolve on its own — and removes that false terminal.
- **`UNKNOWN` is not treated as "not conflicting".** It is what GitHub publishes
  while it recomputes after a push to the PR or its base, and it settles to
  `MERGEABLE` or `CONFLICTING` within seconds. It is reported as
  `MERGEABILITY_UNKNOWN` (exit `4` — the same "becomes something else with
  time" bucket as `HEAD_LAG`), never let fall through to the reviewer/work
  checks: nothing downstream is safe to judge against a mergeability verdict
  GitHub itself had not finished computing, and treating `UNKNOWN` as settled
  is `CONVERGED`'s exposure to exactly the false-terminal risk `PR_CONFLICTING`
  exists to close on the other side: letting `UNKNOWN` proceed unchecked can
  converge over a conflict GitHub had not finished detecting.

**Every field in the snapshot is required of the CLI, not negotiated.**
`mergeable`, `mergeStateStatus`, `baseRefName` and `baseRefOid` have been available
as JSON fields from `gh pr view` for years, so a `gh` without them is an unmet
**prerequisite**: the script reports `UNSUPPORTED_CLI` and exits `2` naming the
fix (upgrade the CLI), and never degrades into a weaker guard the caller
believes is armed. That report goes through the normal JSON contract — a
`--json` caller gets `state`, `exit` and the evidence here as everywhere else,
because an `exit` from inside `evaluate()` would skip the reporter entirely and
emit no object at all.

Required **of the CLI** is a narrower rule than "validated after the read", and
the next two paragraphs are the other half of it. They are separate rules on
purpose, and conflating them makes this section read as self-contradictory.

Requiring the fields is a deletion, and the deletion is the point. The
alternative — a three-tier CLI-version fallback ladder plus a second REST
parser speaking a different response dialect — was built once, and every tier
then needed its own binding and validation guards, each of which produced the
next defect: the REST fallback needed its verdict bound to REST's own
`(head, base)` pair, which then needed both halves of that pair required
rather than optional. That is the shape a rule against compatibility shims
forbids — dual paths, accepts-both-shapes parsers — and the premise was thin
to begin with. One path, one dialect, nothing to keep consistent.

**A transient failure is still distinguished from a missing field**, and that
distinction is load-bearing in the opposite direction. `gh` validates a
`--json` field list client-side before any network call, so a missing field
fails deterministically with `Unknown JSON field: "..."` and will not clear on
a retry — that is the prerequisite exit. A timeout, a 5xx, a rate limit or an
auth blip *will* clear, so it is `INDETERMINATE` and the existing
`MAX_QUERY_ERRORS` retry handles it. Conflating them would treat noise as a
capability gap and silently disable a real guard, and the evaluation that ran
blind can be the one reporting `CONVERGED`.

**A nominally successful read is validated, not trusted — over the fields a
state is decided from.** A partial or malformed response — `mergeable` null,
absent, or an enum value this script does not handle; an empty `baseRefOid` —
would otherwise collapse to `""` and fall through as though the PR were
mergeable, or silently disarm the base-race guard. Both are `INDETERMINATE`.

`baseRefName` and `mergeStateStatus` are deliberately **not** in that set. They
are reported, never branched on: an absent one costs a branch name in the
`git merge` hint and a parenthetical in the `reason`, and both degrade to a
named "unavailable" at the point of use rather than blocking the report.
Hard-failing on them would stop `PR_CONFLICTING` from ever being emitted over
evidence that path never consumes — the same regression the check-runs read
would have.

**Not** auto-resolved. Merging the base is ordinary in-scope work for an agent a
human points at the PR, but `drive.ts` does not hand a `PR_CONFLICTING` result
to a pass — that state is emitted only when no workable findings remain, so
there is nothing for a triage pass to do with it. A conflict that still *has*
findings never reaches this state; it comes back as `ROUND_READY`, and merging
the base is part of that round.

### 15. Mergeability is a function of (head, base), not head alone

Rechecking only
`headRefOid` before every terminal return — the guard from § 12 — is not
enough, because GitHub's `mergeable` describes a *pair*: the
PR's head **and** the base branch's tip at the moment it was last computed. The
base can advance while the PR's own head stays put entirely, and nothing in the
head-only recheck would notice: an old `CONFLICTING` verdict (and the reviewer
witnesses gathered alongside it) could survive into a terminal `PR_CONFLICTING`
after the base had since resolved the conflict — or, the more dangerous
direction, an old `MERGEABLE` verdict could survive into `CONVERGED` after the
base had since gone `CONFLICTING`.

This is not a theoretical race. Measured:
`gh pr view` can report a live PR's `baseRefOid` as a SHA that
already **lags** the real branch tip (`git ls-remote` reading `origin`'s
`refs/heads/<base>` disagrees with it) — GitHub's mergeability computation is
keyed to a base snapshot it recomputes lazily, not to whatever the base
branch's HEAD is at query time. The base moving mid-evaluation is therefore the
*standing* state, not an edge case, in exactly the sense mode 2's rate-limited
external reviewer is.

**What the guard proves is narrower than it first reads**, and deliberately so:
that the *(base, mergeability)* pair stayed **internally consistent** across the
evaluation — not that the base branch's live tip is unchanged. The stronger form
(compare against `git ls-remote`, fail closed until verified) was measured and
rejected: on one PR, while healthy and `MERGEABLE`, `baseRefOid` lagged the
live base tip — and the base moved *again*
between two measurements minutes apart. Failing closed
on that difference would refuse to settle on essentially every evaluation
against an active base branch, so the drive would never converge at all. The lag
*is* the normal state.

That trade is sound because the pair is what the verdict depends on: while
GitHub has not refreshed `baseRefOid`, it has not recomputed `mergeable` either,
so the two still agree with each other. The window this closes is the one where
it refreshes **between** the snapshot and the terminal return, leaving them
describing different bases.

**The residual is real and is stated here rather than papered over**: a live
base that has already advanced into a conflict, while both API reads still
return the old base SHA and `MERGEABLE`, produces a `CONVERGED` that no later
round re-evaluates. It is accepted at *this* layer, because
`CONVERGED` is a claim about the **review** — the reviewer had nothing left to
say about this head, which stays true — and the only stronger test available is
the live-tip comparison ruled out above: it would fire on essentially every
evaluation, so the loop would never converge at all.

It is closed at the layer where it can actually mislead. `CONVERGED` stops a
drive; **`announce-merge-ready.ts` tells a human "safe to merge"**, and that
claim does depend on mergeability. So that script re-reads `mergeable` on the
same last-moment call it already makes for the head, and refuses to post
anything other than `MERGEABLE` — the narrowest the window gets, at the one
place a stale verdict reaches a person. GitHub itself blocks the merge behind
that, so the failure mode is a re-run, not a bad merge.

**Guard**: `still_on_head` re-reads `headRefOid` **and** `baseRefOid`
together and reports `HEAD_MOVED` (exit `4`) if *either* changed since the
opening snapshot — one function, called before every terminal return
(`CONVERGED`, `HITL_PARKED`, `REVIEWER_FAILED`, `PR_CONFLICTING` alike), per §
12's reasoning for why this lives in one place rather than at each call site.

The guard is **unconditional**: `baseRefOid` is a required field (mode 14), so
there is no "base tracking is off" mode to reason about, and head and base are
re-read in one call for the same reason the opening snapshot reads them together
— two calls are two instants, and the pair is what the verdict depends on.

An **empty** `baseRefOid` in the recheck is `INDETERMINATE`, not "unchanged" —
the same treatment the head half next to it gets. Skipping the comparison and
returning success would let a terminal claim stand on a base half that was
never re-verified. An unreadable recheck is evidence of nothing.

### 16. Draftness can flip while the witnesses are being gathered

A PR's state can change between the opening snapshot and the moment a verdict
is returned. Draftness is deliberately **not** rechecked: a draft recheck would
rest on "no reviewer looks at a draft", which is false (§ A draft PR is
reviewed, and then marked Ready). `still_on_head` does not read `isDraft`, and
the standalone recheck is `closedSinceOpen`, which does not depend on that
premise.

**A `ROUND_READY` must not be dispatched onto a PR that closed during
enumeration.** `still_on_head` runs only before a **terminal** return, and
`ROUND_READY` is not one — § 12 documents that as deliberate, since a stale
`ROUND_READY` ordinarily just re-enumerates against the newer head on the next
pass, which the loop does anyway. A closed PR breaks that trade: a
`ROUND_READY` does not merely get re-read, it **dispatches an entire
triage-fix-push round** to a pass, all of it spent on a PR nothing will merge.

**Guard**: a standalone `closedSinceOpen` check — a bare `state` read,
deliberately **not** the full `still_on_head` — runs immediately before
`ROUND_READY` is set, reporting `PR_NOT_OPEN` if the PR is no longer `OPEN`.
Deliberately not the full guard: folding this into `still_on_head` would also
gate `ROUND_READY` on head/base movement, silently reversing § 12's design for
every ordinary staleness case rather than closing only the closed-PR hole. An
unreadable recheck is `INDETERMINATE`, the same fail-closed rule the rest of
this section follows.

**`PR_NOT_OPEN` wins.** GitHub keeps `isDraft` `true` on a closed draft, so a
recheck that read draftness could not tell "became a draft" from "was a draft
and then got closed". With nothing on that path reading draftness, the
precedence holds by construction.

The *opening* snapshot needs no recheck of its own: `state` and `isDraft` there
are both read from the *same* snapshot, in one network call, checked with no
`await` between them, so there is no elapsed time between "the snapshot
arrived" and the synchronous return for anything to change in. This is the
same class of proposal § 15 rejects for mergeability — closing a window that
does not exist there costs a second read racing the same server-side commit,
not a real guard, and generalizing it would mean re-verifying every
synchronous branch derived from one read, which is exactly the "refuses to
ever settle" trade § 15 measured and declined.

## The context-economy dial (`--handoff-at`)

`bun "<skill-dir>/scripts/drive.ts" --handoff-at <pct|never>` sets when the driving session should hand off
rather than degrade, and exports it to the pass as `$DRIVE_PR_HANDOFF_AT`.
`50` is the default; `75` and `never` trade late-session quality for fewer
session boundaries. `careful` / `eager` / `continuous` are aliases for `50` /
`75` / `never`, resolved to the canonical two shapes before export, so the pass
reads a number or the literal `never` and never a vocabulary.

**It is the one setting in this skill that is not enforced, and that is stated
rather than glossed.** Nothing here can observe a session's context usage, so the
dial is an agent-side instruction in the same shape as `$DRIVE_PR_REFLECT_DUE` —
`drive.ts` exports it, SKILL.md makes acting on it part of the round, and a shell
script cannot check that it happened. It belongs in the same register as
SKILL.md § Session-budget honesty's refusal to pace against the unobservable
5-hour usage window. A programmatic context measure in the harness is the upgrade
path; this becomes a real guard when one exists, and not before.

Under `drive.ts` each round is a fresh agent process, so context resets per round
by construction. The dial therefore bites only where that is not true: one round
large enough to strain a single context, the interactive `/loop /jig:drive-pr --interactive` path
where one session spans rounds, and `never`, whose point is surviving compaction
*within* a round.

`never` is **gated** on the held batch above: `drive.ts` probes `bun "<skill-dir>/scripts/drive-state.ts"
held-keys` and refuses (exit `2`) if it is unavailable — an older or vendored
`drive-state.ts`, or state this driver cannot read. Running continuously is
precisely the case where a mid-round compaction is expected, so the setting whose
whole premise is surviving one must not start without the state that makes it
survivable.

## The turn budget (`Reached maximum number of turns`), which *is* measured

A different quantity from the dial above, and do not conflate them: the harness
caps **agentic turns — API round-trips — per user message**, and when a session
reaches that cap it dies immediately with `Claude Code error: Reached maximum
number of turns (1000)`. It is not a degradation the way a full context is; it
is an abort, mid-action, with no handoff written and no summary produced, so
a long interactive round that reaches it leaves its successor nothing.

Unlike context usage, this one is observable: the session transcript records
every round-trip, and distinct `requestId`s since the last real user message
count them. The plugin ships the counter as an agent-runtime hook,
`<plugin-dir>/hooks/turn-budget-guard.ts`, registered by `hooks/hooks.json` to
run before every tool call: it counts those ids off the transcript since its
last call and injects a wrap-up instruction once the count is within a margin
of the cap, 50 turns under a cap of 1000, with one later reminder when half
the margin remains. `JIG_TURN_BUDGET`, `JIG_TURN_BUDGET_MARGIN` and
`JIG_TURN_BUDGET_REFIRE` change those, and a budget of `0` turns the guard
off; its tests are in `hooks/__tests__/`. That holds under Claude Code only:
Codex's transcript is not in the format the guard reads, so under Codex it
counts nothing and reports could not check
([plugin README § Codex notes](../../../README.md#codex-notes)).

**When such a warning fires mid-drive, the round is over.** Finish only the
step in flight — a push already underway, a reply already promised — then
`bun "<skill-dir>/scripts/drive-state.ts" handoff [PR]`, report, and end the turn. Starting another
triage-fix-validate cycle inside the margin buys one more finding and risks
losing the handoff for the whole round.

The count is an approximation, and a counter should be biased early:
compaction and session resume replay earlier messages into the same
transcript, which deduplicating by `requestId` absorbs, but a resume that also
resets the harness's own counter is not observable from the transcript, so
the guard can run ahead of the real number when counting succeeds. That is not
a guarantee against ever running behind — a counter that cannot check (an
unreadable transcript, state it cannot write, a transcript in a format it does
not read) does not count for that call; the guard then lets the tool call
through and reports a hook error, so a session it is not guarding says so
rather than staying silent. Treat the margin as the signal, not the number.

`drive.ts`'s per-round `claude -p` processes each start a fresh session, so the
budget resets per round there and the guard bites hardest exactly where
`--handoff-at` does: one very large round, and the interactive `/loop /jig:drive-pr --interactive`
path.
