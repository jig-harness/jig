# Drive end states and exit codes

Version 2 · stable

A [drive](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the
loop that works a pull request's review rounds until it is ready to merge)
reports how a round, or the whole drive, ended in two places. The round
script, `drive-status.ts`, exits with a code and, with `--json`, writes a
report whose `state` field names the
[terminal state](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).
The driver, `drive.ts`, exits with a code and writes no report. The two
scripts share one numbering but not one meaning for every number:
`drive-status.ts` exits `0` for `ROUND_READY`, while `drive.ts` exits `0`
for `CONVERGED`, so that a harness reading a zero exit as success reads a
converged drive as one. A
[dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) reads
`drive.ts`'s column; a program that runs a round itself reads
`drive-status.ts`'s.

Several states share a code. A `drive-status.ts` report tells them apart by
its `state`; a `drive.ts` exit is only its code, and states that share one
are not told apart. A reader that meets a code this chapter does not list
treats the drive as failed and does not re-arm it. A withdrawn code stays
listed as a tombstone and is never given another meaning.

The kinds are the code's own categories: a `state` a report can carry; a
`class-label`, the name of a family of states that share a code; a
`tombstone`, a withdrawn code; a `driver-only` exit, which `drive.ts`
returns with no report; and a `helper` exit, which one of the drive's helper
scripts returns and neither `drive-status.ts` nor `drive.ts` ends with.
"Ends the drive" says whether the drive stops without the caller re-arming
it on its own.

How a drive reaches each state, and the evidence behind it:
[drive-pr's terminal states](../skills/drive-pr/references/terminal-states.md).
The same values, for a program in any language:
[data/drive-exits.json](data/drive-exits.json).

## When a converged pull request moves

A converged pull request waits for a person to merge it. A clean merge of
the base can carry forward the review of its unchanged contribution.
The dispatcher holds the re-drive while required checks on the new head
are pending. Once those checks pass, it refreshes the ledger and merge-ready
claim for the new head, and the board pins the merge command to that head.
The refresh runs without review rounds or commits.

A changed contribution or an unreadable proof takes the ordinary stale
re-drive path. A conflict re-drives once for the pull request head and
base head, then goes to a person if it remains at that pair. An explicit
rearm also starts a drive. Whenever a drive spends its round budget
(`MAX_ROUNDS`, exit `6`), the ended row hands it to a person to investigate
using the closing-report instruction below.

## The states and exits of `drive-status.ts` and `drive.ts`

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts#TERMINAL_STATES,DRIVE_EXIT -->

| State | Kind | `drive-status.ts` exits | `drive.ts` exits | Ends the drive | Meaning |
| --- | --- | --- | --- | --- | --- |
| `ROUND_READY` | state | 0 | — | no | Work is left for this round: open review threads or unanswered summary findings. The caller runs a pass; `drive.ts` runs it itself and never ends with this state. |
| `INDETERMINATE` | state | 1 | 1 | yes | The state could not be read, or a step failed: `drive.ts` also ends with it when a pass fails. Never a settled state; read what the drive printed before re-arming. |
| `UNSUPPORTED_CLI` | driver-only | — | 2 | yes | A prerequisite is missing. `drive.ts` exits `2`, with no state report (a dispatcher closing report may still be written), when it refuses to start: a command line it cannot use, or a working tree or pull request it cannot drive as they stand (uncommitted changes, commits the pull request does not have, a head in a fork). It prints which. `drive-status.ts` also exits `2`, before there is a pull request to report on and naming no state, on arguments it cannot use and when its startup cannot resolve the repository or the pull request selector, which can be a network or authentication failure rather than an argument error. The same exit can end a drive already running: when a later round's `drive-status.ts` fails that way, the driver passes the `2` on, after earlier rounds' passes may have changed the tree or the pull request, so read the handoff file before assuming no work occurred. |
| `CONVERGED` | state | 3 | 0 | yes | Review work is settled: either no AI reviewer is configured, the reviewer reviewed this exact head, the draft-only skip is provisional until the PR is marked Ready and reviewed, an earlier reviewed head has the same pull-request diff after a current-head skip notice, or a current-head skip notice and configured excluded-path proof establish there is nothing to review. Nothing is left open. `drive.ts` exits `0` only after its own working tree is clean and its exact-head required CI proof passes; convergence alone does not make the pull request ready to merge. |
| `HEAD_LAG` | state | 4 | 4 | no | The pull request's head on the forge and the local head disagree, and the reason says how: a local head ahead with no record of a push (push it through `guarded-push.ts`), a push the forge does not show yet (wait), a tree behind (update it), or diverged history (reconcile it). Then read again. |
| `AWAITING_REVIEWER` | state | 4 | 4 | no | The reviewer has not reviewed this head yet. Wait, then read again. |
| `STALE_REVIEW` | state | 4 | 4 | no | The reviewer's latest review describes an earlier head. Wait for its review of this one, then read again. |
| `HEAD_MOVED` | state | 4 | 4 | no | The head or the base moved while the round was being judged, so nothing read about it holds. Read again. |
| `MERGEABILITY_UNKNOWN` | state | 4 | 4 | no | The forge has not yet worked out whether the pull request merges cleanly. Read again. |
| `NOT_SETTLED` | class-label | 4 | 4 | no | The name of every state that shares exit `4`: the pull request is not ready to judge yet. Never itself a `state`; the caller waits and runs the drive again. `drive.ts` also exits `4` after the review converged when another driver holds the mark-Ready lease, when the head moved, the CI hold label changed or the forge could not be read as the hold was released, when a read of the cancelled-run recovery kept failing in a way waiting can clear, when no fresh result of a required check came in time (where a skipped or cancelled check means waiting cannot help: re-run the check, then re-arm), and when the drive keeps a draft that the reviewer skips (mark it Ready, then re-arm). |
| `PR_NOT_OPEN` | state | 5 | 5 | yes | The pull request was merged or closed. Stop, and push nothing to it. |
| `MAX_ROUNDS` | driver-only | — | 6 | yes | The drive spent its round budget (`--max-rounds`, with any rounds a re-arm granted) without converging. Read the handoff file before re-arming: a re-arm a person asks for grants one more round budget. |
| `REVIEWER_FAILED` | state | 7 | 7 | yes | The reviewer's check failed or says the review did not complete. The drive stops. The dispatcher can retry a neutral check that reports an incomplete review and escalate repeated stops on that head. |
| `HITL_PARKED` | state | 8 | 8 | yes | Everything left waits on a person's decision, each framed on its thread. The drive does not wake itself: once every one is answered, re-arm it. |
| `PR_CONFLICTING` | state | 9 | 9 | yes | The pull request conflicts with its base and has nothing else to work on; `drive.ts` ends with it once its conflict-repair passes are spent. Merge the base in, then re-arm. |
| `RETIRED` | tombstone | — | — | — | Withdrawn: it once stopped a drive on a draft pull request, which is now driven like any other. Never exited, and never given another meaning. |
| `SESSION_LEASE_HELD` | state | 11 | 11 | yes | Another live session in this working tree holds the drive's lease for this pull request. Nothing was changed: wait for it, or clear its lease once its process is gone. |
| `SINGLE_INSTANCE_LOCK` | driver-only | — | 11 | yes | Another driver already holds this pull request's or this working tree's lock, so the drive is already armed. Nothing was changed. |
| `WORKTREE_UNCLEAN` | driver-only | — | 12 | yes | The working tree holds work no round shipped: uncommitted edits, an unfinished git operation or a commit nobody reviewed. Settle it, then re-arm in this tree. |
| `DRIVE_HELD_BY_OTHER_WORKTREE` | state | 13 | 13 | yes | Another live working tree, or a driver in another clone, is driving this pull request. Nothing was changed; that driver is the one to finish. |
| `STALLED` | driver-only | — | 14 | yes | Rounds stopped changing anything the drive can see. Read what the passes decided, and what the tree still holds, before re-arming. |
| `PASS_DEADLINE` | driver-only | — | 15 | yes | A pass ran past its deadline and was stopped more often than the drive restarts one. Check the tree for the stopped pass's leftovers before re-arming. |
| `QUOTA_PARKED` | driver-only | — | 16 | yes | A pass hit an agent subscription's usage limit that does not reset soon. Re-arm after the reset, or from a session that bills another account. `drive.ts` also exits `16` when it refuses such a re-arm while the limit holds, from a session that bills the same account or one it cannot tell. |
| `MAILBOX_STOPPED` | driver-only | — | 18 | yes | A person or a tool told the drive to stop through its mailbox, and it stopped at a round boundary. A stop that names this driver's generation ends this driver alone; one that names none stops every later driver too, so resume it before re-arming. |
| `MAILBOX_PAUSE_TIMEOUT` | driver-only | — | 19 | yes | A pause sent through the drive's mailbox lasted longer than the drive waits. Resume it, then re-arm. |
| `TAKEN_OVER` | driver-only | — | 20 | yes | Another clone took the drive over and drives it now. Nothing to recover here. |
| `CI_REPAIR_SPENT` | driver-only | — | 21 | yes | The diagnosing CI-repair session could not complete the repair on the failing head. The handoff carries its diagnosis and tracker issue when available. |
| `REVIEW_SKIPPED` | state | 22 | 22 | yes | The reviewer reported a skip or pause for this Ready PR head. An earlier review does not cover it, a skip notice has no stamp and Jig cannot verify that the diff is empty after the configured exclusions, or a review-object check reports `Review paused…` or `Review skipped…`; a draft-only skip instead remains provisional while the drive marks the PR Ready and waits for review. A person resumes the reviewer or has this head reviewed, then re-arms. |
| `CI_INFRA_PERSISTED` | driver-only | — | 23 | yes | The review converged, but checks kept failing on the CI service's own infrastructure after the drive re-ran them. Nothing in the code needs repair; re-arm once the service recovers. |
| `FORGE_RATE_LIMITED` | state | 24 | 24 | yes | The forge's rate limit for the drive's credential is spent: nothing more is sent before it resets. The report names the reset (`rateLimit.until`). The driver then waits out a reset within its bound (`DRIVE_PR_RATE_LIMIT_WAIT`) and goes on, or stops on one further off. Re-arm after the reset. |
| `CHECK_RUNS_UNREADABLE` | state | 25 | 25 | yes | The head's check-runs listing could not be read whole: a page or the whole listing ran out of time, or it has more pages than a read may take. The reason names the pages read. Nothing about the pull request was judged; run the drive again, and treat a second such stop on the same head as a systematic read failure. |

<!-- /protocol:generated -->

## The exits the drive's helper scripts take from the same numbering

Most of the drive's helper scripts number their exits on their own. An exit
a caller could mistake for one of the drive's takes a code from this
numbering instead, and is listed here so that no state or exit is given it.

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts#TERMINAL_STATES -->

| State | Kind | Exit | Exited by | Ends the drive | Meaning |
| --- | --- | --- | --- | --- | --- |
| `PUSH_HELD` | helper | 17 | guarded-push.ts and push-hold-recheck.ts (PUSH_HELD_EXIT) | no | A `hold-push` directive in the drive's mailbox is in force, so nothing was pushed; the pre-push hook's recheck exits with it to stop a push already under way. Not an end state: clear the hold, then push again. |

<!-- /protocol:generated -->

## What `drive.ts`'s closing report says at each exit

When a [dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
runs a drive, `drive.ts` writes a
[closing report](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
when it stops (`closing-report/v1`, written by the driver). Its `concluded`
opens with the stop's text, after the pull request's name and before the
exit, followed by what the last
[round report](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) of
the same launch concluded; its `cause` and `suggested_next` are the ones this
table gives the exit. A park's text names the first parked decision's
question and how many more wait, and a usage-limit stop's names the limit and
when it resets. A pass failure (exit `1`) whose usage-limit scan was cut
short before it found a wall says so in its text, and has cause `unknown`
and a next step that looks for a usage-limit notice first: a limit the scan
did not reach is not a tool failure. An exit this table does not list has
cause `unknown` and a next step a person investigates. A `cause` is absent where the drive did not
fall short of its goal.

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts#TERMINAL_STATES.report -->

| State | `drive.ts` exits | The stop's text | `cause` | Next: owner | Next: act | Next: step |
| --- | --- | --- | --- | --- | --- | --- |
| `INDETERMINATE` | 1 | stopped on a failure; the drive's log says what failed | `tool-failed` | `person` | `Investigate` | Read what the drive's log says failed, then re-arm the drive. |
| `UNSUPPORTED_CLI` | 2 | stopped: a usage error, or a gh that cannot report the pull request | `environment` | `person` | `Investigate` | Read the drive's message, fix the command line, the working tree or the gh install it names, then re-arm the drive. |
| `CONVERGED` | 0 | converged: review evidence covers its head and nothing is left open | — | `person` | `Merge` | Merge the pull request once its required checks pass. |
| `NOT_SETTLED` | 4 | stopped before the pull request could be judged: it has not settled yet | — | `line` | — | The line drives it again once the pull request settles. |
| `PR_NOT_OPEN` | 5 | ended: the pull request was merged or closed | — | `none` | — | Nothing is left for the drive; a merge's follow-up settles what the merge owes. |
| `MAX_ROUNDS` | 6 | used its round budget without converging | `deadline` | `person` | `Investigate` | Read the handoff file for what keeps the review open, then re-arm the drive, which grants it one more round budget (`jig send drive@<repo> <PR> rearm`, or `--rearm-budget` on the arm command), or take the work over. |
| `REVIEWER_FAILED` | 7 | stopped: the posting reviewer's check reported a failure | `tool-failed` | `person` | `Investigate` | Look at the reviewer's failed check, then re-arm the drive. |
| `HITL_PARKED` | 8 | parked: a decision waits for a person | `needs-person` | `person` | `Decide` | Answer each parked decision on its thread, then re-arm the drive. |
| `PR_CONFLICTING` | 9 | stopped: it conflicts with its base and has nothing left to work | `needs-person` | `person` | `Do` | Merge the base in and resolve the conflicts, then re-arm the drive. |
| `SINGLE_INSTANCE_LOCK` | 11 | refused: another driver already holds this pull request's or this working tree's lock | `refused` | `line` | — | The driver that holds the lock goes on driving. |
| `WORKTREE_UNCLEAN` | 12 | converged, but its worktree holds changes no round shipped | `environment` | `line` | — | A re-armed drive settles the working tree, then reports convergence. |
| `DRIVE_HELD_BY_OTHER_WORKTREE` | 13 | refused: another working tree or clone drives this pull request | `refused` | `line` | — | The driver in the other working tree or clone finishes the drive. |
| `STALLED` | 14 | stalled: its passes changed nothing | `unknown` | `person` | `Investigate` | Read what the passes decided and what the working tree holds, then re-arm the drive. |
| `PASS_DEADLINE` | 15 | stopped: its passes kept running out of time | `deadline` | `person` | `Investigate` | Check the working tree for the stopped pass's leftovers, then re-arm the drive. |
| `QUOTA_PARKED` | 16 | stopped on a usage limit | `usage-limit` | `line` | — | The line re-arms the drive after the limit resets, or on an account the limit does not hold. |
| `MAILBOX_STOPPED` | 18 | stopped: a person or a tool told it to stop through its mailbox | — | `none` | — | Nothing until a person re-arms the drive. |
| `MAILBOX_PAUSE_TIMEOUT` | 19 | stopped: a pause sent through its mailbox outlasted its wait | `deadline` | `person` | `Do` | Resume the drive through its mailbox, then re-arm it. |
| `TAKEN_OVER` | 20 | stopped: another clone took the drive over | — | `line` | — | The clone that took the drive over drives it now. |
| `CI_REPAIR_SPENT` | 21 | stopped: the diagnosing CI-repair session could not complete the repair | `tool-failed` | `person` | `Investigate` | Read the diagnosing session’s handoff and address the blocker it recorded. |
| `REVIEW_SKIPPED` | 22 | stopped: the reviewer skipped its head and will not review it | `environment` | `person` | `Do` | Resume the reviewer or have this head reviewed, then re-arm the drive. |
| `CI_INFRA_PERSISTED` | 23 | stopped: checks kept failing on the CI service's own infrastructure | `environment` | `line` | — | The line re-arms the drive once the CI service recovers. |
| `FORGE_RATE_LIMITED` | 24 | stopped: the forge's rate limit for its credential is spent | `environment` | `line` | — | The line drives it again once the forge's rate limit resets. |
| `CHECK_RUNS_UNREADABLE` | 25 | stopped: its head's check-runs listing could not be read whole | `tool-failed` | `line` | — | The line re-drives it once for this head; a second such stop on the head is a systematic read failure for a person. |

<!-- /protocol:generated -->
