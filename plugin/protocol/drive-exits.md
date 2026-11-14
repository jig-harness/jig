# Drive end states and exit codes

Version 1 · stable

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

## The states and exits of `drive-status.ts` and `drive.ts`

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts#TERMINAL_STATES,DRIVE_EXIT -->

| State | Kind | `drive-status.ts` exits | `drive.ts` exits | Ends the drive | Meaning |
| --- | --- | --- | --- | --- | --- |
| `ROUND_READY` | state | 0 | — | no | Work is left for this round: open review threads or unanswered summary findings. The caller runs a pass; `drive.ts` runs it itself and never ends with this state. |
| `INDETERMINATE` | state | 1 | 1 | yes | The state could not be read, or a step failed: `drive.ts` also ends with it when a pass fails. Never a settled state; read what the drive printed before re-arming. |
| `UNSUPPORTED_CLI` | state | 2 | 2 | yes | A prerequisite is missing: the installed `gh` cannot report a field the round needs. `drive.ts` also exits `2`, with no report, when it refuses to start: a command line it cannot use, or a working tree or pull request it cannot drive as they stand (uncommitted changes, commits the pull request does not have, a head in a fork). It prints which. |
| `CONVERGED` | state | 3 | 0 | yes | The pull request is ready to merge: the reviewer reviewed this exact head and nothing is left open. `drive.ts` exits `0` for it, once its own working tree is clean. |
| `HEAD_LAG` | state | 4 | 4 | no | The pull request's head on the forge and the local head disagree, and the reason says how: a local head ahead with no record of a push (push it through `guarded-push.ts`), a push the forge does not show yet (wait), a tree behind (update it), or diverged history (reconcile it). Then read again. |
| `AWAITING_REVIEWER` | state | 4 | 4 | no | The reviewer has not reviewed this head yet. Wait, then read again. |
| `STALE_REVIEW` | state | 4 | 4 | no | The reviewer's latest review describes an earlier head. Wait for its review of this one, then read again. |
| `HEAD_MOVED` | state | 4 | 4 | no | The head or the base moved while the round was being judged, so nothing read about it holds. Read again. |
| `MERGEABILITY_UNKNOWN` | state | 4 | 4 | no | The forge has not yet worked out whether the pull request merges cleanly. Read again. |
| `NOT_SETTLED` | class-label | 4 | 4 | no | The name of every state that shares exit `4`: the pull request is not ready to judge yet. Never itself a `state`; the caller waits and runs the drive again. `drive.ts` also exits `4` after the review converged when another driver holds the mark-Ready lease, when the head moved or the CI hold label changed as the hold was released, when no fresh result of a required check came in time (where a skipped or cancelled check means waiting cannot help: re-run the check, then re-arm), and when the drive keeps a draft that the reviewer skips (mark it Ready, then re-arm). |
| `PR_NOT_OPEN` | state | 5 | 5 | yes | The pull request was merged or closed. Stop, and push nothing to it. |
| `MAX_ROUNDS` | driver-only | — | 6 | yes | The drive spent its round budget (`--max-rounds`) without converging. Read the handoff file before re-arming. |
| `REVIEWER_FAILED` | state | 7 | 7 | yes | The reviewer's own check did not pass, so the absence of findings proves nothing. A person looks at the reviewer before re-arming. |
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
| `CI_REPAIR_SPENT` | driver-only | — | 21 | yes | The review converged, but required checks still fail after the drive's CI-repair passes were spent. A re-armed drive repairs again. |
| `REVIEW_SKIPPED` | state | 22 | 22 | yes | The reviewer skipped this head and its review of an earlier head does not cover it, so no review will come. A person has this head reviewed, then re-arms. |
| `CI_INFRA_PERSISTED` | driver-only | — | 23 | yes | The review converged, but checks kept failing on the CI service's own infrastructure after the drive re-ran them. Nothing in the code needs repair; re-arm once the service recovers. |

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
