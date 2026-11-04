# The dispatch board, what is driven and what is ready to merge: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) keeps the
execution line moving between its stages, but one stage stays a person's:
the merge ([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)). That stage
sets the pace of the rest. Each merge moves the base branch, which lets the
dispatcher re-drive the pull requests that now conflict with it and lets the
next pull request in a [serialized area](../GLOSSARY.md) start. A pull request
that is ready and not merged waits while the base moves under it, until it
conflicts and a re-drive repeats work that was already done. Yet the dispatch
dashboard does not show the merge queue at all. A drive that converged, at the
head it verified and mergeable, is one the tick reports and then leaves
alone, so the page shows it nowhere. So is a drive a person armed by
hand, or one another machine runs: the page lists only sessions holding
this machine's slots. A person who opens the page to ask "what can I merge,
and what is being worked on" gets the stops and this machine's sessions, and
must open the forge's list of pull requests for the rest.

With this built, the page's first view is a **board**: one card for each
piece of work the dispatcher knows, in exactly one column (coming, picking
up, driven, needs you, ready to merge, merged). The ready-to-merge column
holds only pull requests a person can merge now: converged, green, and
allowed by the forge, each with a merge command pinned to the head the drive
verified. A card moves in any direction, because each tick places it again
from the records, and a card that moved back (a ready pull request that came
to conflict, say) shows where it came from and why. The page says how long
each ready pull request has waited, and the history view says how much
ready work was lost to waiting.

This is the design of [plan.md](plan.md) item 36. It builds on item 33,
[the dispatcher](dark-factory-dispatch.md), whose tick already reads every
fact the board places a card by except three fields of the pull request
listing.

## How it works

### One card per piece of work, in one column

The board shows what the tick reads: every open pull request with a drive
ledger in a repository the machine file lists (whoever drives it: a
session this machine launched, a person, another machine), every pull
request a person labelled `drive` that has no drive yet, every item a
pickup is starting or holds, and the pull requests merged today. A pull
request with no ledger and no label is not on the board, since nothing
drives it. With `only_labeled`, the board holds the labelled pull requests
only, as the tick does.

The tick places each card in one column, from the records alone, by a
pure function (`plugin/dispatch/lib/board.ts`), so a column is a fact the
line carries, never a guess the page makes. The columns, in the order work
passes through them:

| Column | What is in it | Read from |
| --- | --- | --- |
| Coming | an item assigned to the factory identity and not started; a drive the tick re-arms or re-drives when a slot frees; a pull request held behind another in a serialized area; a pull request labelled `drive` | the queue the line holds today |
| Picking up | an item a pickup session is working on, with no pull request yet | the pickup's launch record, the tracker |
| Driven | a pull request whose drive runs: its ledger says running, on any machine | the ledger (`driven`, and `silent` marked as such) |
| Needs you | a pull request or item stopped on something only a person settles: a park, a drive stopped on a failure, a stalled pickup, a double claim, a converged pull request the forge refuses to merge for a reason no drive fixes | the needs the line holds today, and the forge's merge state |
| Ready to merge | a pull request a person can merge now ([§ Ready, exactly](#ready-exactly)) | the ledger and the pull request listing |
| Merged | a pull request merged since the start of the host's day, with its follow-up's state | the merged listing, the follow-up's launch record and marker |

A drive a person stopped (`stopped-by-person`), and a pull request a person
labelled `hold`, are in Needs you, in a group of their own named for what
stopped them ("stood down"), folded by default: they wait on a person, who
already knows.

A card says what it is (pull request or item, its title and link, its
repository), how long it has been in its column, the status row below when
it is an open pull request, and what the column needs said:

- **Driven:** the drive's round, its unresolved threads per round (the
  samples the line carries), and who drives it: this machine on which
  account, or "armed elsewhere" with the ledger's driver host.
- **Needs you:** what it carries today: the framed decisions with their
  reply drafts, the stop's reason verbatim.
- **Ready to merge:** the head the drive verified, the merge state as the
  forge reported it at the tick, the pull requests waiting behind it in a
  serialized area, and the merge command.
- **Merged:** when it merged, and its follow-up: coming, running, done, or
  in Needs you when it failed.

The accounts and their slots, which the page shows today beside the
sessions, stay above the board as one row, so a person still sees why a
card in Coming has not started.

### The status row on every pull request card

Every open pull request on the board carries the same four marks, in the
same order and the same place on the card, whatever its column, so a
person learns to read them once. Each mark is a short symbol and word, and
opens a hint with its detail on hover, tap or focus, as the page's other
hints do:

| Mark | On the card | In its hint |
| --- | --- | --- |
| Conflicts | none, conflicting, behind, or not known yet | the forge's mergeability and merge state, and the base branch |
| Checks | running (3 of 8 done), green, failing (2), or none | each failing check by name, linked to its run; the checks still running; whether each is required |
| Threads | the number of unresolved review threads | how many are a reviewer bot's and how many a person's, linked to the pull request's conversation |
| Merge | ready, needs an approval, behind, or not ready | the [Ready conditions](#ready-exactly) as a checklist, each met or not with the fact behind it |

The merge mark is the one derived state of the four: it is the board's own
predicate, computed by the tick, and its checklist says which condition
keeps a pull request out of Ready to merge, so "why is this not ready" is
answered on the card. Every hint ends with the tick it was read at.

The checks and threads are read for the pull requests on the board only,
in one paged query per repository per tick (each pull request's head-commit
check rollup and its review threads' resolution and authors), beside the
listing the tick reads today.

### Ready, exactly

A pull request is in Ready to merge when all of these hold at the tick,
each read with the pull request:

1. Its ledger stopped `0`, converged. `drive.ts` exits `0` only when the
   review converged on the exact head and every required check completed
   green on it
   ([What `CONVERGED` requires](../plugin/skills/drive-pr/references/terminal-states.md#what-converged-requires)).
2. Its head is the head the drive verified (`verifiedSha`).
3. The forge reports it mergeable with its base (`mergeable` is
   `MERGEABLE`).
4. It is not a draft.
5. The forge's merge state says branch protection lets it merge now
   (`mergeStateStatus` is `CLEAN` or `HAS_HOOKS`).
6. It has no unresolved review thread.
7. It carries no `hold` label.

Conditions 1 to 3 are the tick's `done` class today; 4 and 5 are what
`announce-merge-ready.ts` re-reads before it says a pull request is safe to
merge, so the board and the drive's own announcement hold the same bar.
`isDraft`, `mergeStateStatus` and `reviewDecision` join the fields the
tick's open pull request listing already reads (`lib/forge.ts`); condition
6 reads the threads the status row reads. The drive converged with no
unresolved thread, so a thread there now was opened after it: someone
reviewed the pull request since.

A converged pull request that fails 4, 5 or 6 goes where its reason says:

| The forge reports | Column | What the card says |
| --- | --- | --- |
| a draft | Needs you | converged as a draft: marking it ready summons the reviewers that skip drafts |
| `BLOCKED`, `reviewDecision` `REVIEW_REQUIRED` or `CHANGES_REQUESTED` | Ready to merge, group "needs an approval" | branch protection wants an approving review first |
| `BEHIND` | Ready to merge, group "behind its base" | the repository requires an up-to-date branch: updating moves its head, and the dispatcher re-drives it |
| `UNSTABLE` | Needs you | a check failed after the drive converged |
| `BLOCKED` for any other reason | Needs you | the forge blocks the merge, with its merge state |
| (any state) an unresolved thread | Needs you | a thread was opened after the drive converged: answer it, or re-arm the drive to address it |
| `UNKNOWN`, or mergeability `UNKNOWN` | the column it was in at the last tick, marked not read | the forge is still computing |

The approval and behind groups are in Ready to merge because the next act
in both is a person's at the merge (an approval, an update), but they sit
below the pull requests that merge now, and carry no merge command.

The page shows a tick's facts, minutes old, and a person acts on them, so
the merge never rests on that read. The merge command the card offers is
pinned to the verified head:

```sh
gh pr merge <n> --repo <owner/name> --match-head-commit <verifiedSha> --<method>
```

The forge refuses it when the head moved since the drive verified it, and
applies its own branch protection at that moment. The method is the first
of squash, merge and rebase the repository allows, read with the
repository (`squashMergeAllowed`, `mergeCommitAllowed`,
`rebaseMergeAllowed`). The card's link goes to the pull request, where the
forge's own merge button does the same checks.

### The order within Ready to merge

Each merge should release as much waiting work as it can, so the column
lists, first, the pull requests that others wait behind in a serialized
area (the card says "unblocks #12, #14"), then the rest by how long each has
been ready, the longest first: the longest wait has had the most time to
drift from its base. The groups that cannot merge now follow.

### A card moves in any direction

Nothing on the board is moved by hand: each tick places every card again
from the records, so a card goes wherever they say, backwards as readily as
forwards. The moves a person meets:

| Move | Cause the card shows |
| --- | --- |
| Driven → Ready to merge | the drive converged, the checks are green and the forge allows the merge |
| Ready to merge → Coming or Driven | the base came to conflict, or its head moved past the verified head: the dispatcher re-drives it (the stale class today) |
| Ready to merge → Needs you | a check failed after convergence, the forge blocks the merge, it became a draft, or its re-drive stopped |
| Ready to merge → Merged | a person merged it |
| Driven → Needs you | the drive parked or stopped |
| Needs you → Coming → Driven | the park was answered and the drive is re-armed |
| any → off the board | the pull request closed unmerged; the history view keeps it |

The line keeps, for each card, when it entered its column and where it was
before, the way it keeps a need's first sighting today: the tick reads the
previous line, and a card in the same column keeps its time. A card that
moved back (left Ready to merge for anything but Merged, or moved left on
the board) shows where it came from, when, and the cause ("was ready
3 h; its base now conflicts") until it moves again or the host's day ends.
Those are the moves a person most needs to see: work that was ready and was
lost to waiting.

A card whose facts did not read at this tick stays in the column it was in,
marked "not read at this tick" with the reason, as an unplaced ledger is
today: the board never moves a card on a guess.

### What the page says first

The strip's Now tab carries two counts, "3 to merge · 2 to answer", and the
answer at the top of the view leads with the merge queue when it holds
anything: "3 pull requests are ready to merge; the oldest has waited 5 h."
On a phone the columns stack, Ready to merge first, then Needs you, Driven,
Picking up, Coming and Merged, each folded to its count beyond its first
cards. On a wide screen the six columns stand side by side in the order work
passes through them, Ready to merge marked apart, and an empty column
narrows to its heading. The rest of the visual design comes from a design
round ([Build order](#build-order)).

The page stays as it is in what it never does: it holds no merge button
and opens no write route to the host. Merging is a person's act on the
forge; the page gives the link and the pinned command, as it gives a reply
draft and its answer line today. When
[delegated merge](plan.md#9-delegated-merge-pull_requestsmerge-auto-on-converged)
is built, it arms the forge's auto-merge on the same predicate, and a card
it armed says so.

### Telling a person, and the dispatch labels

A pull request entering Ready to merge is notified once per pull request
and verified head, through the notifications the tick sends today, with one
message per tick and repository naming every pull request that became
ready ("Ready to merge in owner/name: #451, #452"). Its suppression record
is keyed by the pull request and the head, so a pull request that leaves
and comes back at a new head is notified again, and one that flickers on a
forge read is not. The cause is `ready`, added to the notification causes.

Where a repository turns dispatch labels on, the `converged` state label
follows the column: it is on a pull request while it is in Ready to merge
and its merge-now group, so the forge's list filtered by that label is the
same queue.

### What waiting cost

The outcome log gains two event rows, each written once per cause as event
rows are today:

- **became ready**, keyed by the pull request and its verified head, when
  a card enters Ready to merge's merge-now group;
- **left ready**, keyed the same way, when it leaves, with the cause as the
  reason (`merged`, `conflicting`, `head moved`, `check failed`, `blocked`,
  `draft`, `closed`) and the time it was ready as its duration.

The history view counts, over its window, the pull requests that became
ready, those merged, the median wait from ready to merged, and the ready
work lost: left ready for anything but a merge, by cause. Those are the
numbers that say whether merging often is keeping the line moving.

### The line grows one list

`LineSnapshot` gains `board`, a list of cards, each carrying its column, its
group, the time it entered the column, its previous column with the time
and cause of the move, the reason verbatim, its driver, and, for Ready to
merge, the verified head, the merge state, the review decision, the method
and the pull requests it unblocks, and for every open pull request the
status row's facts. Each card names the need, session or
queue entry it was placed from, so the decisions and reply drafts the page
shows today hang off the card unchanged. A line written by a tick from
before the board has no `board`, and the page says the board appears at the
next tick rather than placing cards itself.

## Build order

1. **The tick places the cards.** The listing reads `isDraft`,
   `mergeStateStatus` and `reviewDecision`, the repository view its
   allowed merge methods, and one query per repository the board's checks
   and review threads; `lib/board.ts` places every card with a test for
   each row of the column and move tables; the line carries `board` with
   each card's column history; `jig dispatch`'s report lists the merge
   queue; the `converged` label follows the column. Done when a tick over a
   repository with a converged, green, mergeable pull request reports it in
   Ready to merge with its pinned command and its status row, one with a
   failing check carries the check's name and run, and one whose base then
   conflicts is placed in Coming at the next tick with "was ready" and the
   cause.
2. **The design round.** A brief from
   [`design-brief-builder`](../plugin/skills/design-brief-builder/SKILL.md)
   for the board as the page's first view: the six columns at desktop and
   phone widths, the scenarios of a quiet line, a full merge queue, a
   morning of backward moves and a long Needs you, light and dark. The round
   lands under [`prototypes/`](prototypes/rubric.md) with its scorecard.
3. **The page shows the board.** The first view renders `board` as the
   round designed it, replacing the needs, running and coming panels whose
   content moves onto the cards; the Help view explains each column and the
   Ready conditions. Done when the browser suites open the board for every
   scenario, width and theme.
4. **Notifications and the history.** The `ready` notification and the two
   event rows, and the history view's counts. Done when a pull request that
   becomes ready reaches a person's phone once, and the history view
   filtered to yesterday shows yesterday's ready, merged and lost counts.

## Left out

- **A merge button.** It would give the page a write route to the host and
  have the dispatcher's server act for a person on the forge; the pinned
  command and the forge's own button already let a person merge from the
  page in one step.
- **Moving a card by hand.** A column is derived from the records, so a
  dragged card would be overruled at the next tick. A person moves work by
  acting on its record: answering, labelling `hold` or `drive`, merging.
- **Updating a branch that is behind.** Where a repository requires an
  up-to-date branch, every merge puts the other ready pull requests behind
  their base. The drive does not treat "behind" as a reason to merge the
  base in (`base-drift.ts`: it merges only when the base touched the pull
  request's files), and an update moves the head, which the dispatcher
  already re-drives. The forge's merge queue is the tool for such a
  repository; the board shows these pull requests in their own group.
- **Ordering the queue by predicted conflict.** Knowing which ready pull
  requests touch the same files as others would need a file read per pull
  request each tick; the serialized areas already name the contention a
  repository knows of.
- **Pull requests nothing drives.** A pull request with no ledger and no
  label is a person's own; the forge lists it.
