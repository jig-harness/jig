# The dispatch board, what is driven and what is ready to merge: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) keeps the
execution line moving between its stages, but one stage stays a person's:
the merge ([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)). That stage
sets the pace of the rest. Each merge moves the base branch, which lets the
dispatcher re-drive the pull requests that now conflict with it and lets the
next pull request in a [serialized area](../GLOSSARY.md) start. A pull request
that is ready and not merged waits while the base moves under it, and once
it conflicts, a re-drive repeats work that was already done. Yet the
dispatch dashboard does not show the merge queue at all. A drive that
converged, at the head it verified and mergeable, is one the tick reports
and then leaves alone, so the page shows it nowhere. So is a drive a person
armed by hand, or one another machine runs: the page lists only sessions
holding this machine's slots. A person who opens the page to ask "what can
I merge, and what is being worked on" gets the stops and this machine's
sessions, and must open the forge's list of pull requests for the rest. And
nothing on the page tells work that settles by itself (a drive running,
checks running) from work that waits until a person acts (an approval
nobody gave, a park): left alone, the second kind waits forever.

**Phone access is a first-class requirement of the board.** Merge, Needs
you, Running, Queue and History, opened work and decisions must be readable
in any phone browser, with visible controls to copy commands and answer
lines and open pull requests or issues. The phone stays read-only and
needs neither Orca nor keyboard shortcuts. The hub's
[phone scope and access contract](hub.md#phone-scope-and-access) defines
the exclusions, supported setup, availability and phone acceptance checks.
They apply to the board as it ships in stage 1.

How much ready work waits, and how much of it is lost to a conflict, is
measured first, as a baseline ([Build order](#build-order)): the outcome log
already holds the re-drives of converged pull requests that went stale, with
their cause.

With this built, a **Ready to merge** list, the Merge view, leads the page: the converged
pull requests grouped by the next known act
(merge now, with a merge command pinned to the head the drive verified;
approve first, naming requested reviewers and unread protection rules;
update next). Only merge now confirms merge readiness. Every pull request
carries the same status row (conflicts, checks with the failing ones named,
unresolved threads, and the derived merge state with its conditions as a
checklist), and every card says whether it settles by waiting or waits on a
person, and which act. Then a **board**: every piece of work the
dispatcher knows, placed in one column (coming, picking up, driven, needs
you, ready to merge, merged), the columns shown as views of one column
of cards each (Merge, Needs you, Running, Queue, History). A card moves in any direction, because
each tick places it again from the records, and a card that moved back (a
ready pull request that came to conflict, say) shows where it came from and
why. A person is told once when a pull request becomes ready, and the
history view says how long ready work waited and how much was lost.

This is the design of [plan.md](plan.md) item 36. It builds on item 33,
[the dispatcher](dark-factory-dispatch.md), every step of which is built:
the tick, its ledger classes, the serialized areas and the outcome log the
board reads. The [hub](../GLOSSARY.md), the page the dashboard grows into
([hub.md](hub.md), item 42), builds the board as its first stage, adds the
round, the threads by bot and not a bot and the CI hold to the status row,
and lets a tick for one repository refresh its part of the line.
The [dispatcher reference](../plugin/README.md#the-dispatcher) describes
how the page shows it: the five views,
Merge first with its flash on every other view, the act every need opens
with, and the keys ([§ Five views](#five-views-one-column-of-cards)).

## How it works

### One card per piece of work, in one column

The board shows what the tick reads: every open pull request with a drive
ledger in a repository the machine file lists (whoever drives it: a
session this machine launched, a person, another machine), every pull
request a person labelled `drive` that has no drive yet, every item a
pickup is starting or holds, and the pull requests merged today. A pull
request with no ledger and no label is not on the board, since nothing
drives it. With `only_labeled`, the tick reads only labelled pull requests,
so a drive a person armed by hand on an unlabelled one is not on the board
either; the Help view says so.

The tick places each card in one column, from the records alone, by a
pure function (`plugin/dispatch/lib/board.ts`), so a column is a fact the
line carries, never a guess the page makes. The columns, in the order work
passes through them:

| Column | What is in it | Read from |
| --- | --- | --- |
| Coming | an item assigned to the factory identity or to a [served person](../GLOSSARY.md) and not started, in rank order with each held item's reason; a drive the tick re-arms or re-drives when a slot frees; a pull request held behind another in a serialized area; a pull request labelled `drive`; a converged pull request behind its base, updated after the one in update next | the queue the line holds today, and the board read |
| Picking up | an item a pickup session is working on, with no pull request yet | the pickup's launch record and the assigned items the tick already reads; no tracker read of its own |
| Driven | a pull request whose drive runs: its ledger says running, on any machine | the ledger (`driven`, and `silent` marked as such) |
| Needs you | a pull request or item stopped on something only a person settles: a park, a drive stopped on a failure, a stalled pickup, a double claim, a converged pull request the forge refuses to merge for a reason no drive fixes | the needs the line holds today, and the board read |
| Ready to merge | a converged pull request grouped by its next known act, with merge readiness confirmed only in merge now ([§ Ready, exactly](#ready-exactly)) | the ledger and the board read |
| Merged | a pull request merged since the start of the host's day, with its follow-up's state | the merged listing, the follow-up's launch record and marker |

A drive a person stopped (`stopped-by-person`), and a pull request a person
labelled `hold`, are in Needs you, in a group of their own named "stood
down", folded to its count: they wait on a person, who already knows.

A card says what it is (pull request or item, its title and link, its
repository), how long it has been in its column, the status row below when
it is an open pull request, and what the column needs said:

- **Driven:** the drive's rounds with their times and unresolved threads,
  from the ledger's `rounds[]` whichever machine launched it (for a ledger
  without them, the samples the line carries where this machine launched
  it), and who drives it: "this machine, account X" when a launch record
  confirms it, else "claimed in its ledger by host Y", a claim the board
  shows as a claim. A
  claimed drive whose heartbeat passes the lease window is the `silent`
  class and is marked so.
- **Needs you:** the framed decisions, one row each to pick an answer on,
  with the picks, notes and own words kept in the browser, and the stop's
  reason as quoted record text.
- **Ready to merge:** the head the drive verified, the merge state as the
  forge reported it at the tick, the pull requests waiting behind it in a
  serialized area, and the act left.
- **Merged:** when it merged, and its follow-up: coming, running, done, or
  in Needs you when it failed.

The accounts and their slots, with the host's load factor, stand at the
top of the Running view as one row, so a person still sees why a card in
Coming has not started.

### Ready, exactly

One predicate decides it, a pure function in
`plugin/skills/drive-pr/scripts/lib/merge-ready.ts`. The tick calls it to
place a card, `announce-merge-ready.ts` calls it before it posts, and
`jig ask` calls it for what a converged drive waits on and for the `merge`
station ([addresses](addresses.md#an-address-names-a-station-on-a-piece-of-work)),
so the board, the drive's announcement and the answer a person gets about
one pull request cannot disagree. It takes the facts
of one pull request and returns its lane and, for each condition not met,
whether waiting settles it or which person's act does. A pull request is in
Ready to merge, lane **merge now**, when all of these hold at the tick:

1. Its ledger stopped `0`, converged. `drive.ts` exits `0` only when the
   review converged on the exact head and every required check completed
   green on it
   ([What `CONVERGED` requires](../plugin/skills/drive-pr/references/terminal-states.md#what-converged-requires)).
2. Its head is the head the drive verified (`verifiedSha`).
3. The forge itself witnesses a review of that head: where the repository
   names a reviewer (`review.reviewer_app`), the reviewer's posting check
   run on the head, matched as the drive's convergence matches it (the app
   and the check name, with `review.reviewer_check_pattern` where the
   repository sets one), completed and neither failed nor was skipped; any
   other check the app published on the head does not count; where the
   repository names none, a person's approving review stands on the head.
4. The forge reports it mergeable with its base (`mergeable` is
   `MERGEABLE`).
5. It is not a draft.
6. It has no unresolved review thread.
7. The forge's merge state says branch protection lets it merge now
   (`mergeStateStatus` is `CLEAN` or `HAS_HOOKS`), or its base requires a
   merge queue (`isMergeQueueEnabled`), whose own rules then decide.
8. Its author is the repository's own (association `OWNER`, `MEMBER` or
   `COLLABORATOR`), or a person approved it.
9. It carries neither the `hold` label nor the
   [CI hold](../GLOSSARY.md) label (`ci.hold_label`), under which its
   required checks fail on purpose.

Condition 2 is Jig's own, and no repository setting turns it off.
Convergence is a claim about one head: the reviewer reviewed that head,
and every thread and summary finding on it was settled. Branch protection
cannot see that claim. A commit pushed after the drive converged can leave
the forge's merge state `CLEAN`: the checks run green on it, and an
approval survives unless the repository dismisses stale ones, while
nothing reviewed the commit. A head past the verified one is the stale
class the tick re-drives today, so the card goes back to Coming with that
cause.

Condition 3 is there because conditions 1 and 2 come from the ledger, a
pull request comment the drive trusts on its author's association alone.
Anyone the repository counts as a collaborator can post or edit one, and a
ledger that says `0` at an unreviewed head would otherwise put that head
in merge now. A reviewer app's check run is posted by the app's own
identity, which no person's token can post as, and a person's approval is
recorded by the forge against the head it approved. So merge now never
rests on the ledger alone. Condition 8 keeps a pull request from outside
the repository from reaching merge now on an agent's review alone, so text
written to steer the reviewer never becomes a "merge now" for a person.

`announce-merge-ready.ts` posts only when the predicate says merge now or
approve first, and words the second as "an approval is still required".
The predicate adds the forge's protection and review requirements to the
helper's gates; it replaces none of them. The helper keeps requiring that
the drive `CONVERGED`, that CI is green, that the head is the verified head
with the CI-hold evidence, that its worktree is clean and matches the
reviewed head, and that the live pull request is neither conflicting nor a
draft. Extracting the predicate takes the forge facts out of the helper and
leaves those gates where they are.

The board reads the facts conditions 3 to 8 need with its own query
([§ The board read](#the-board-read)); conditions 1 and 2 come from the
ledger the tick already reads. A converged pull request that fails a
condition goes where its reason says. The forge reports `BLOCKED` without
saying why, so the predicate reads the reason from the facts behind it, in
this order:

| The facts | Column, lane | What the card says | Waits on |
| --- | --- | --- | --- |
| a draft | Needs you | converged as a draft: marking it ready summons the reviewers that skip drafts | a person: mark it ready |
| the CI hold label | Needs you | held, never "failing"; the drive removes the label as it converges, so it was added again after | a person: remove the label (the checks run again on the same head), or re-arm the drive |
| an unresolved thread | Needs you | a thread was opened after the drive converged | a person: answer it, or re-arm the drive |
| the reviewer app's check on the head is missing, failed or skipped | Needs you | the review the ledger reports is not witnessed on this head | a person: re-arm the drive |
| `reviewDecision` `CHANGES_REQUESTED` | Needs you | who requested changes, and when | a person: that reviewer re-reviews, or the drive is re-armed to address it |
| `BLOCKED` or `UNSTABLE`, a check failing | Needs you | a check failed after the drive converged, by name; a check still running beside it does not change this | a person: re-run it, or re-arm the drive |
| `BLOCKED`, a required check running, none failing | the column it was in | the required checks still running | waiting |
| `UNKNOWN`, or mergeability `UNKNOWN` | the column it was in, marked not read | the forge is still computing | waiting |
| `BEHIND`, the first in Ready order of its repository | Ready to merge, update next | the repository requires an up-to-date branch; updating moves its head, which costs a re-drive (a review round and a CI run); where an approval is also required, the card says it is still owed | a person: update the branch |
| `BEHIND`, any other | Coming | behind its base, updated after the one in update next | waiting |
| an approval is required (`REVIEW_REQUIRED` with `BLOCKED`; or condition 3 or 8 asks for one and condition 7 holds) and a review is requested | Ready to merge, approve first | waits on an approval, and says the board has not read the repository's other protection rules (signatures, deployments); the reviewers or teams requested are named as requested, and since when | a person: an approval |
| an approval is required, as in the row above, and no review is requested | Ready to merge, approve first | needs a review and approval from someone other than its author, and nobody is asked | a person: request a review |
| `BLOCKED` for none of these | Needs you | the forge blocks the merge on a rule the board cannot tell (signed commits, a deployment): open the pull request | a person |

The rows are first match, and every row that names a blocker other than an
approval (a CI hold, a failed or running check, a thread, an unread or
behind branch) comes before the approval rows, with a confirmed failure
ahead of a pending check, so a pull request enters approve first only once
the other conditions the board reads are established. The board reads no
signature or deployment requirement, and `REVIEW_REQUIRED` with `BLOCKED`
does not rule one out, so an approve-first card never says approval is the
only act left: it says the other rules are unread. Where the approval is
owed under condition 3 or 8 rather than by the forge, the forge's own merge
state must already read `CLEAN`, `HAS_HOOKS` or a merge queue; a `BLOCKED`
with no approval owed goes to the last row. A review request does not say whose approval satisfies
branch protection: the repository may require several approvals or a code
owner's, and the board reads neither. So a card names the people or teams
requested as requested, never as the ones whose approval completes the
gate, and says the forge may ask for more once an approval is given.

Update next holds one pull request per repository at a time. In a
repository that requires up-to-date branches, every merge puts every other
ready pull request behind its base; asking a person to update each of them
would cost a re-drive per pull request per merge, about n(n−1)/2 for a
queue of n. Updating only the next in order costs one per merge, about
n−1. The card names the cost, and the Help view names the forge's merge
queue as the way such a repository avoids it: a base that requires a merge
queue is never `BEHIND` to the board, since the queue tests each pull
request against the base itself.

How the forge reports the merge state of a pull request whose base
requires a merge queue is checked against a repository with that rule on
before the step that builds the predicate is done; until it is, such a
pull request is placed by `isMergeQueueEnabled` and the other conditions,
never by `mergeStateStatus`.

### The merge command

The page shows a tick's facts, minutes old, and a person acts on them, so
the merge never rests on that read. A card in merge now offers a command
pinned to the verified head:

```sh
gh pr merge <n> --repo <owner/name> --match-head-commit <verifiedSha> --<method>
```

The forge refuses it when the head moved since the drive verified it, and
applies its own branch protection at that moment. Where the base requires a
merge queue, the command names no method, and the forge adds the pull
request to the queue. Otherwise the method is the first of squash, merge
and rebase the repository allows (`squashMergeAllowed`,
`mergeCommitAllowed`, `rebaseMergeAllowed`).

The command is built only from values that pass a strict form: the number
an integer, `<owner/name>` the repository slug the machine file lists,
`verifiedSha` forty lowercase hexadecimal characters, the method one of
squash, merge and rebase. A value that fails its form withholds the command, and the card
says which value did; nothing is escaped into a command a person pastes
into a shell that holds forge credentials. The card's link goes to the pull
request, where the forge's own merge button does the same checks.

### What each card waits on

The board's most useful signal is the difference between work that
settles if left alone and work that waits until a person acts. A drive
that is running, checks that are running, a forge still computing, a slot
about to free and a pull request held behind its area's leader all settle
by themselves. An approval nobody gave, a park, a failed check after
convergence and a draft do not.

So the predicate and the tick give every card a `waitsOn`: `waiting`, with
what it waits for, or `person`, with the act that settles it, from a
closed list: merge, approve, request a review, update the branch, answer,
re-arm, re-run a check, mark ready, open the pull request. The act is in
the table above for a converged pull request, and is the stop's own for a
card in Needs you. A card that waits on a person is marked so wherever it
is, its act named on its face, and those cards are what the tabs' counts
add up. On the page that act is grouped under the acts a need opens
with ([§ Five views](#five-views-one-column-of-cards)): merge is Merge;
approve and request a review are Authorize; answer is Decide, or Reply for
a person's thread or a waiting session; update the branch, re-run a check,
mark ready and open the pull request are Do; and re-arm, once the steward
and the recovery budget have left it to a person, is Investigate. A card that waits for something already running says what, and
says nothing is asked of anyone.

### The status row on every pull request card

Every open pull request carries the same marks, in the same order and
the same place on the card, whatever its column or list, so a person
learns to read them once. Each mark is a short symbol and word, and opens a
hint with its detail on hover, tap or focus, as the page's other hints do:

| Mark | On the card | In its hint |
| --- | --- | --- |
| Round | the round and its time, as "round 4 · 18 min": how long the current round has run, or the last round's length once the drive stopped; none before a drive | each round the ledger keeps, with its start, its end and its unresolved threads at the end |
| Conflicts | none, conflicting, behind, or not known yet | the forge's mergeability and merge state, and the base branch |
| Checks | running, green, failing, held, or none | for a failing pull request, each failing check by name with its app, "required" or "not required", and its run; for the others, the state |
| CI hold | "held: not built since `a1b2c3d`", "held: not built at this head", or none | the label, that its required checks fail on purpose while it stays, and that removing it runs them again on the same head |
| Threads | the unresolved review threads: "2 bot · 1 not a bot" for a pull request in the detail set whose authors were read, the total for the others | the count, each thread's author for the split, linked to the pull request's conversation |
| Merge | merge now, approve first, update next, or not ready | the [Ready conditions](#ready-exactly) as a checklist, each met or not with the fact behind it, and for each one not met whether waiting settles it or which person's act does |

The merge mark is the one derived state among them: the predicate's
answer, so "why is this not ready" is answered on the card. Every hint ends
with the tick it was read at. The round, the CI hold and the split threads
are the hub's ([hub.md](hub.md#a-piece-of-work-and-its-views)):

- **Round.** The ledger's `rounds[]` keeps the last 10 rounds, so every
  machine shows them, not only the one that launched the drive. A ledger
  without `rounds[]` gives its round number with the times not known,
  never zero rounds.
- **CI hold.** Under the CI hold label the required checks fail on purpose
  (the [held-head check](../GLOSSARY.md)), so they read held, never
  failing, and a held pull request is never in merge now (condition 9). A
  failing check that is not required still reads failing. From step 4, the
  head the mark names is the last one a tick saw with its required checks
  completed and the label off, kept with the card in `board_seen`; before
  step 4, and wherever no tick saw one, the mark says "held: not built at
  this head".
- **Threads, by bot and not a bot.** An unattended drive works only the
  threads an app opened (on GitHub, a GitHub App: `--bots-only`) and
  leaves the rest to a person, so the split shows which of the unresolved
  threads wait on one. A thread's author is its first comment's, as the
  drive tells who opened a thread. It is a bot when the forge types it as
  one (`__typename` `Bot`), the test `--bots-only` applies, so an account
  `review.bots` names that the forge types as a user counts as not a bot,
  as the drive treats it. Any other author is "not a bot", never called a
  person, since an account the forge types as a user may be a script's.
  An author costs more to read than a thread's resolution, so the split
  covers the detail set only, under a cap of its own per repository and
  tick ([§ The board read](#the-board-read)), and a card with a thread
  whose author the cap or the budget floor left unread shows the total.

### The board read

The facts the predicate and the status row need beyond the tick's own
reads come from one read per repository, the **board read**, a GraphQL
query of its own that the tick makes in its observe phase
([dark-factory-dispatch.md § One tick, step by step](dark-factory-dispatch.md#one-tick-step-by-step)),
once the repository's ledgers name its converged drives. Planning runs
under the act lock, so a read made after planning would hold that lock
across forge calls and lengthen every other tick's wait. The board read is
kept apart from the per-repository query the planning reads
(`plugin/dispatch/lib/forge-batch.ts`): nothing the tick plans or launches
reads it, and the listing, the ledgers and the mergeability the planning
uses stay as they are. A board read that fails or runs past its
deadline (30 seconds per repository) marks that repository's cards "not
read at this tick" with the reason and writes it on the receipt; launches,
re-drives and notifications of stops are untouched.

It is a listing query and a detail query, both GraphQL through the
signed-in `gh`, the same login the drives use, so they share one hourly
budget with them:

- **The listing**, paged over the repository's open pull requests, 100 at a
  time, since a paged listing cannot be narrowed to the board's: per pull
  request its head commit's id (`headRefOid`), a few fields (`isDraft`,
  `mergeStateStatus`, `reviewDecision`, `isMergeQueueEnabled`,
  `authorAssociation`), its head commit's check rollup state, and its
  review threads' id and resolution (up to 100).
- **The detail**, one query naming each pull request of the detail set by
  number: the converged pull requests, the ones in Needs you, and any whose
  rollup is failing. Per pull request: its head commit's id, its head's
  check contexts (up to 100, each with whether it is required, its app and
  its link), its labels (for the `hold` and CI hold labels), its review
  requests and its reviewers' latest reviews (up to 20 each). The same
  query reads, by the ids the listing found, the first comment's author
  (`login` and `__typename`) of each unresolved thread the board has not
  seen before, for the split of the thread mark, within the author cap
  below.

A held pull request the marks must tell from a broken build is in the
detail set already: it is converged, or its required checks fail and its
rollup with them.

Every fact about a pull request is bound to one head. The head commit's id
in the planning listing, the board listing and the detail must be the same,
and equal to the ledger's verified head for any card that reaches merge now.
Where they differ, a push landed between the reads: the detail is read once
more for that pull request, and where they still differ the card is "not
read at this tick" and is never in Ready to merge, so a card never combines
one head's verification with another head's checks.

The comments under a thread are where a query's cost multiplies: the forge
prices a query by the requests its connections need, one per connection
per parent node, at 100 requests a point. So nothing reads more than one
comment of a thread, and only of an unresolved thread in the detail set,
fetched by its id, 100 ids a query at most: about one point per 100 such
threads. A thread's first author never changes, so from step 4 each author
read is kept by thread id with the card's history (`board_seen`), and only
a thread the board has not seen before is read. The author reads have a
cap of their own, 2 points per repository per tick (200 threads). A detail
set at the [size this is built for](#the-size-it-is-built-for) holds 6,000
unresolved threads, about 60 points to read once: uncapped, a tick that
reads them all, as a first tick does and as every tick before step 4
would, spends that per repository, and ten repositories at twelve ticks an
hour would spend more than the hour's budget on authors alone. A card with
a thread whose author the cap or the budget floor left unread shows the
total only, and the next tick reads the next threads. Before step 4 keeps
authors, nothing records which threads were read, so each tick reads the
authors of the first 200 unresolved threads of the detail set again, and a
card past them shows the total. The listing costs about two
points per 100 open pull requests and the rest of the detail about one
point per 20 pull requests in its set, so a repository at that size costs
at most about 5 points a tick, about 60 an hour at a five-minute interval,
and ten repositories about an eighth of the 5,000 points an hour one login
gets. The receipt records each board read's cost, the author split's
apart, and the budget left (the query's `rateLimit`), so the figure is
measured, not assumed. When the budget left is below a fifth of the
hour's, the tick skips the board read, and the cards say "not read: the
forge budget is kept for the drives".

A connection that reports another page (`hasNextPage`) on one pull request,
whether checks, threads, review requests or latest reviews, gets follow-up
queries for that pull request alone, by cursor, up to the
[size this is built for](#the-size-it-is-built-for): 300 entries per
connection, counted in entries, not pages. The first page holds 100 checks
or threads and 20 review requests or latest reviews; each follow-up asks
for at most 100 and never more than the entries left of the 300, so no
connection is read past it. A connection still reporting another page once 300 entries are
read is marked partial on its card ("more than 300 checks: open the pull
request"), and a partial pull request is never in
merge now or approve first, since an unread failing check, an unread
thread, an unread approval or an unread reviewer cannot be ruled out. It
never fails the read of its repository.

A pull request whose mergeability reads `UNKNOWN` (the forge recomputes it
for every open pull request after its base moves, so after every merge) is
read once more 15 seconds later, within the board read's deadline, so the
tick after a merge does not leave the ready list "not read" for a whole
interval.

### The size it is built for

Per machine, 10 repositories; per repository, 100 open pull requests, 50 on
the board, 20 in the detail set and 10 ready at once; on one pull request,
300 check contexts and 300 review threads. One machine dispatches a
repository, by the dispatcher's own rule, so a repository's board read,
notifications and history rows are written once. The fixtures of the
board's tests are built at that size, and a test fails a tick whose board
read or line grows past it unbounded.

### The order within Ready to merge

The lanes stand in the order of the work they ask: merge now, approve
first, update next. Each merge should release as much waiting work as it
can, so within a lane come, first, the pull requests that others wait
behind in a serialized area (the card says "unblocks #12, #14"), then the
rest by how long each has been in the lane, the longest first: the longest
wait has had the most time to drift from its base. Where no area is
serialized, the order is by wait alone.

### A card moves in any direction

Nothing on the board is moved by hand: each tick places every card again
from the records, so a card goes wherever they say, backwards as readily as
forwards. The moves a person meets:

| Move | Cause the card shows |
| --- | --- |
| Driven → Ready to merge | the drive converged, the review is witnessed on its head and the forge allows the merge |
| Ready to merge → Coming or Driven | the base came to conflict, or its head moved past the verified head: the dispatcher re-drives it |
| Ready to merge → Coming | another pull request merged and this one is now behind its base |
| Ready to merge → Needs you | a check failed after convergence, a reviewer requested changes or opened a thread, the CI hold label was added, the forge blocks the merge, it became a draft, or its re-drive stopped |
| Approve first → Merge now | a requested reviewer approved |
| Ready to merge → Merged | a person merged it |
| Driven → Needs you | the drive parked or stopped |
| Needs you → Coming → Driven | the park was answered and the drive is re-armed |
| any → off the board | the pull request closed unmerged; the history view keeps it |

When each card entered its column and its lane, and where it was before,
is kept in a table of the state database (`board_seen`), keyed by
repository and target, not in the line: a tick for one repository, or one
that could not write the line, keeps every other card's time. With each
card, `board_seen` also keeps, for the split of the thread mark, the first
author of each of its unresolved threads by thread id. A card that moved
back (left Ready to merge for anything but Merged, or moved left on the
board) shows where it came from, when, and the cause ("was ready 3 h; its
base now conflicts") until it moves again or the host's day ends. Those are
the moves a person most needs to see: work that was ready and was lost to
waiting.

A card whose facts did not read at this tick stays in the column it was in,
marked "not read at this tick" with the reason, as an unplaced ledger is
today: the board never moves a card on a guess.

### Text the board did not write

A card carries text from records the dispatcher does not own: titles, stop
reasons, framed decisions, check names, reviewer logins, a ledger's driver
host. Any collaborator, and any app installed on a repository, can write
some of it. So the board keeps its own words and the records' apart:

- **The act and the cause are the board's own**, from the closed lists
  above. A card's face never presents record text as the act to take.
- **Record text is shown as quoted text**, set apart on the page, and in
  `jig dispatch --json` under fields that say they are quoted record text,
  so an agent that reads the report can tell them from the dispatcher's.
- **Notifications carry no record text**: the repository, the numbers and
  the lane.
- **A link is rendered only to the forge's own host over HTTPS.** A check's
  link elsewhere is shown as text. A check that is not required says so,
  beside the app that posted it.

### Five views, one column of cards

The page's views are one per question a person brings to it, each a tab
with its count and each one column of full-width cards, with Help beside
them as the page that explains them:

| View | It answers | Its cards |
| --- | --- | --- |
| **Merge** | What can I merge now? | Ready to merge's lanes: merge now, approve first, update next |
| **Needs you** | What waits on me? | the Needs you column, grouped by act, each card naming the person it waits on |
| **Running** | What is being worked on? | Driven and Picking up, under the host's load gauge ([load factor](../plugin/CONFIGURATION.md#the-machines-dispatch-file)) |
| **Queue** | What starts next, and why not yet? | Coming, with the served people's ranked queue and each held item's reason ([served pickups](../plugin/README.md#the-dispatcher)) |
| **History** | What ended, and why? | Merged, the outcome log and the tick strip |

The columns of [§ One card per piece of work](#one-card-per-piece-of-work-in-one-column)
stay the tick's placement of each card; the views are how the page shows
them. No two cards ever sit side by side, at any width: a view is read top
to bottom.

**Merge comes first.** The page opens on Merge while merge now holds a pull
request, and on Needs you otherwise. While merge now holds anything, every
other view shows one line above its cards, the **merge flash**: "2 pull
requests are safe to merge: #451, #452". Dismissed, the flash stays hidden
until a pull request reaches merge now at a head it has not shown. The
counts on the tabs and the flash answer the morning glance, so no view has
to carry another's cards.

**A card shows the act first.** A Needs-you card opens with its act from
the closed list in
[a need's act](../plugin/README.md#the-dispatcher)
(Merge, Decide, Authorize, Reply, Do, Investigate), then the ask in one
sentence, then the recommended option with what it changes and what it
costs. A parked need shows a short row for each of its decisions, with the
count of decisions and of picks: its question, its act where it differs
from the card's, how it bears on another decision (`interplay`), the
recommended option and the pick. Each row folds its other options; the
card folds a park's steps for a person (as a checklist), the whole decision
and the evidence. A full framed decision is never shown in place, since one
park would fill a phone. On a phone an option's row is what is tapped and
no number is shown; every key has a button
([structured-answers.md](structured-answers.md#picking-an-answer)).

**The keys.** Every view is driven from the keyboard, and the keys never
fire inside a text field:

| Key | Does |
| --- | --- |
| ⌘K or Ctrl-K | the palette: go to a view, jump to `#N` or an item, run a card's command |
| j / k | the next or previous card (roving focus, so Tab still works) |
| Enter or o | expand or collapse the card |
| p / i | open its pull request or its issue |
| 1 to 9, h, l, u, r | on a parked need, pick an option of the current decision (1 is the recommended one) and move to the next with no pick, move between its decisions, clear the last pick, or write a note beside a pick or an answer in the person's own words ([structured-answers.md](structured-answers.md#picking-an-answer)) |
| Escape | leave the note or answer field, so the card's keys work again |
| c | copy its primary command: the pinned merge command, or the need's answers as one comment with their digests (with no picks, as [picking an answer](structured-answers.md#picking-an-answer) says); a guarded pick copies on the second step, from the key, the card's Copy and the palette alike |
| g, then m, n, r, q or h | go to Merge, Needs you, Running, Queue or History |
| / and ? | filter the view; list the keys |

The palette is a dialog with `aria-activedescendant`, so a screen reader
follows its choice. The rest of the visual design comes from the hub's
design round ([Build order](#build-order)), which starts from these views.

The page stays as it is in what it never does: it holds no merge button
and opens no write route to the host. Merging is a person's act on the
forge; the page gives the link and the pinned command, as it gives the
answer lines a card's picks make. When
[delegated merge](plan.md#9-delegated-merge-pull_requestsmerge-auto-on-converged)
is built, it arms the forge's auto-merge on the same predicate, and a card
it armed says so.

### Who reads it

The board is read by whoever holds the dashboard's address, as the page is
today: the token in it is minted when `jig dispatch dashboard` starts, so
restarting the server revokes an address that leaked, and the server
listens only on a private or loopback address. The board shows more than
the page did (every listed repository's driven and ready pull requests,
reviewer logins, check names), all of it what each repository's own
readers see on the forge, and it shows all the machine file's repositories
to one address. The dashboard reads one state root, and its history
aggregates every repository found there without restricting by machine
file, so two machine files that share a state root expose each other's
work through either address. Repositories whose readers must not see each
other's work are therefore dispatched from different machine files with
separate state roots, each served by its own dashboard instance; a shared
root with per-repository scoping on every dashboard read is not offered
until that scoping is specified and enforced.

The page that grows from the dashboard is the [hub](hub.md), which serves
the board beside its other views and is reached in other ways: a host's
hub listens on loopback with no token and only answers reads, a laptop's
hub reads each host over SSH (Secure Shell), and a phone reaches a host's hub through an
recommended HTTPS front on a private network that names the viewer and scopes what
each person sees ([hub.md § Where it runs](hub.md#where-it-runs)). Until
the hub serves it, the board is read as above, with the hub design's
explicit private-HTTP fallback for phones. Responsive layout alone does
not complete the access requirement.

The [Jig panel in Orca](orca-integration.md#the-jig-plugin-for-orca) is a
second reader. It reads the same line through the plugin's worker, which
runs `jig` as the person on their own machine, so it has no listen address
and no token, and nothing outside Orca's window reaches it. Its inbox panel
shows the cards that wait on the person running Orca there, and the board
itself opens on the hub in Orca's browser.

The person the dispatcher reaches is the board's first reader, but not the
only person who merges or approves. A merge-now card names no merger: the
forge decides who may merge, and the command works for anyone with that
right. An approve-first card names the reviewers the forge requested, never
the person the dispatcher reaches, and asks for a review, not a click.

### Telling a person

A pull request entering Ready to merge (merge now or approve first) is
notified once per pull request and verified head, through the notifications
the tick sends today, with one message per tick and repository naming
every pull request that entered, by lane ("Ready to merge in owner/name:
#451, #452. Waiting on an approval: #453, nobody asked"). A move between
lanes does not notify again, and neither does entering update next, which
the page shows. The suppression record is keyed by the pull request and
the head, so a pull request that comes back at a new head is notified
again, and one that flickers on a forge read is not. The cause is `ready`,
added to the notification causes.

The dispatch labels do not change: the `converged` state label still
follows the ledger, and it is not the merge queue (see Left out).

### What waiting cost

The outcome log gains event rows. A pull request can leave and re-enter
Ready to merge at one verified head (a check fails and is re-run, a thread
opens and is resolved, a hold is added and removed), and each period is its
own [**ready episode**](../GLOSSARY.md). An episode's key is the pull request, its verified
head and the episode's start (the tick that saw it enter), so a later
episode is never discarded as a duplicate of an earlier one, and all of an
episode's rows share it:

- **became ready**, when a card enters Ready to merge, with its lane;
- **changed lane**, when the card moves between the lanes of Ready to
  merge, with the lane left, the lane entered and the time spent in the
  lane left as its duration;
- **left ready**, when it leaves, with the cause as the reason (`merged`,
  `conflicting`, `head moved`, `behind`, `check failed`, `ci hold`,
  `blocked`, `draft`, `closed`), the lane it left from and the time it was
  in that lane as its duration.

The wait of an episode is the sum of its lane durations, so a pull request
that waited a day for an approval and an hour to be merged shows both. The
card's time in its current lane comes from `board_seen`, which keeps the
lane's entry as well as the column's, and orders Ready to merge by it.

The notification record is separate from the event rows: it is keyed by the
pull request and the head, so a re-entry at the same head is recorded as an
episode and does not notify again.

The lanes and the causes are closed lists in the dashboard contract, fixed
before the first row is written; the design round may change how the page
names them, never the values the rows store.

The history view shows, over its window: the pull requests that became
ready; those merged, with the median wait from ready to merged, split by
the lane they waited in; those still ready at the window's end, with the
oldest one's wait, since a median of the merged leaves out the longest
waits; and the ready work lost, left ready for anything but a merge, by
cause. Every wait is measured from the tick that saw the change, so it is
precise to one interval, and the view says so.

The history view's existing read filters log rows to the window by time,
which cannot answer these questions: a pull request that became ready before
the window and stayed ready through it has no row inside it. So the ready
counts are an episode query of their own: an episode belongs to the window
when it began before the window's end and has no left-ready row before the
window's start, and its became-ready row is read whatever its time. The ones
without a left-ready row at the window's end are the ones still ready, with
their wait up to that end; a merge in the window takes its wait from its
episode's lane durations, not from a row the window may not hold. The
index on time is extended to the rows' kind and episode key.

### The line grows one list

`LineSnapshot` gains `board`, a list of cards, each carrying its column, its
lane, the time it entered the column and its previous column with the time
and cause of the move (from `board_seen`), its `waitsOn`, its driver, the
status row's facts for an open pull request, the predicate's answer, and
for Ready to merge the verified head, the method and the pull requests it
unblocks. Each card names the need, session or queue entry it was placed
from, so the decisions and the picks the page keeps for them hang off the
card unchanged. The list is bounded: 100 cards a column, with the count of
the rest; 10 failing checks a card, with the count of the rest; the stood
down group as its count and its 20 newest. A line written by a tick from
before the board has no `board`, and the page says the board appears at the
next tick rather than placing cards itself. The line stays at version 1:
`board` and the hub's other additions are optional fields, and the line's
`minReader` names the oldest reader that can still read it
([hub.md § The source feed](hub.md#the-source-feed-from-a-host-to-a-hub)).

A tick for one repository, such as one `jig send` wakes, replaces that
repository's part of the line and leaves the rest as the last tick wrote
it. The part of one repository is its entries in `sessions`, `needs`,
`queue` and `board`, each of which names its repository, and its entry in
`repos`, which carries the `runId` and `readAt` of the tick that last read
it. The rest belongs to the whole machine, and only a tick the timer asked
for every repository the machine file lists writes it, whether or not
another tick held some of them busy: the line's own `version`,
`runId`, `startedAt`, `finishedAt` and `exitStatus`, `apply` and
`applyWithheld`, `intervalMs`, `plugin`, `timeZone`, `minReader`, the accounts with their slots and
walls, `lastAccount`, and the receipt kept beside the line. The one exception is the
duration history, `longestTickMs` and `recentTicksMs`: a woken tick adds its
own duration to it even when the machine's other fields stay the last full
tick's, so the freshness checks take their maximum over every tick that ran.
So a timer that stopped still shows as
overdue while woken ticks run, and a session a woken tick launched shows in
its repository's sessions at once and in its account's slots at the next
full tick.

The receipt records, per tick, the board read's duration and cost, the
forge budget left, the cards placed per column and the line's size in
bytes, so a board grown slow or costly is seen from one tick to the next.

## Build order

The [hub](hub.md#build-order) builds these steps as its first stage, in the
order its build order gives: the drive ledger carries its rounds before
step 2 shows them, and the line takes a tick for one repository before
step 4.

1. **Measure the waiting loss with what the log holds** (built: the counts
   are in plan item 36). No code: on the
   host that dispatches a working repository, `jig dispatch log --since
   <30 days ago> --jsonl` gives the re-drives of a stale converged pull
   request with their cause (the ended rows' reason names them), and, per
   pull request, the time from its drive's converged row to the forge's
   `mergedAt`, read per pull request with `gh pr view <number> --repo <repository>
   --json mergedAt` for each repository and number the log names, since a
   `gh pr list` read stops at 30 pull requests unless given a larger
   `--limit`, which would leave part of the log without a merge time.
   A follow-up's launch is not used as the merge time: a follow-up can be
   wanted or held until a slot frees, and the ended rows carry the end time
   and duration, not the launch time (launch is end minus duration), and
   rate a successful follow-up as `converged` too, so the rows are told
   apart by stage before they are counted. The
   counts go into the plan item as a baseline, not a gate: every later
   step is built whatever they show, and steps 2 and 3 measure the loss
   from then on.
2. **Ready to merge in the tick** (built in part: the predicate, its use by
   `announce-merge-ready.ts` and `jig ask`, the board read with its
   deadline, budget floor and `UNKNOWN` re-read, the merge command's strict
   forms, the `ready` notification and the line's lanes; the rest of the
   step is open). The predicate in `lib/merge-ready.ts`
   with a test for each condition and each row of the placement table,
   `announce-merge-ready.ts` calling it, and `jig ask` calling it: a
   converged drive's `waitsOn` names the lane's act in place of saying the
   approval and the branch were not read, and the `merge` station joins
   the addresses; the board read with its deadline,
   budget floor, overflow follow-up and `UNKNOWN` re-read, in the observe
   phase and apart from the planning's query; the status row with the round, the CI hold and the threads by
   bot and not a bot; the merge command's strict forms; `jig dispatch`'s
   report listing the merge queue; the `ready` notification; the event
   rows; the receipt's figures. Done when, on a repository with a required merge
   queue and one without: a converged, witnessed, mergeable pull request
   is reported in merge now with its pinned command; one blocked on a
   required review is in approve first naming the reviewers requested or
   saying nobody was; one by an outside author is in approve first; one
   whose ledger says `0` at a head its reviewer never checked is in Needs
   you; one whose base then conflicts leaves with a left-ready row and its
   cause; a merge puts one pull request in update next and the rest in
   Coming; one under the CI hold reads held, never failing, and is never
   in merge now; one with a bot's thread and another author's reads
   "1 bot · 1 not a bot"; each reaches a person's phone once; `jig ask`
   on each names the same lane and act as its card; and a board read made
   to fail leaves that tick's launches as they were.
3. **Ready to merge on the page**, built with the
   [dispatcher's five views](../plugin/README.md#the-dispatcher): the Merge
   view with its lanes, the status rows, `waitsOn`
   and the pinned command; the counts on every tab; the merge flash; the
   keys and the palette; the history view's counts. Done when the
   browser suites open it for a quiet line, a full queue and a morning of
   lost ready work, at phone and desktop width, and no two cards sit side
   by side at 1440 px.
4. **Every card placed.** `lib/board.ts` places every card in its column,
   with a test for each row of the column and move tables; `board_seen`
   keeps each card's column history and its threads' authors; the line
   carries `board` within its bounds, a tick for one repository replacing that repository's cards
   ([§ The line grows one list](#the-line-grows-one-list)); the status row
   reaches every open pull request. Done when a drive a person armed by
   hand shows in Driven as claimed, a tick for one repository keeps the
   other repositories' cards and column times, and a tick at the design
   size keeps the line within its bounds.
5. **The design round** is the hub's
   ([hub.md § Build order](hub.md#build-order)): one brief from
   [`design-brief-builder`](../plugin/skills/design-brief-builder/SKILL.md)
   for the whole hub, starting from the five views, from the fixtures of
   steps 2 to 4. It keeps this design's scenarios (a quiet line, a full
   merge queue, a morning of backward moves and a long Needs you) at
   desktop and phone widths, light and dark, and adds the hub's. The round
   lands under [`prototypes/`](prototypes/rubric.md) with its scorecard,
   which covers every scenario, width and theme.
6. **The Running and Queue views as the round designed them**, every
   column's cards placed in its view; the Help view explains each column,
   the Ready conditions, the status row's marks and what `only_labeled`
   leaves out. Done when the browser suites open each view for each
   scenario at phone and desktop width in one theme, the scorecard
   covering the rest.

## Left out

- **A merge button on the dashboard.** It would give the page a write
  route to the host and have the dispatcher's server act for a person on
  the forge; the pinned command and the forge's own button already let a
  person merge from the page in one step, so the dashboard keeps link and
  copy only. The Jig panel in Orca carries one: a panel has no network
  route, so a person's click runs the drive's pinned merge command as that
  person, in their own app
  ([orca-integration.md](orca-integration.md#the-jig-plugin-for-orca)).
  The hub gains one in its third stage, on a laptop and behind proof that
  a person is there
  ([hub.md § When the hub writes](hub.md#when-the-hub-writes)).
- **Moving a card by hand.** A column is derived from the records, so a
  dragged card would be overruled at the next tick. A person moves work by
  acting on its record: answering, labelling `hold` or `drive`, merging.
- **The `converged` label following the board.** The label says the drive
  converged, from the ledger, which is what a repository that filters on
  it relies on. It is not the merge queue: anyone who can triage can add
  it, and it knows nothing of approvals, checks or the forge's witness.
  Making it follow the lanes would change a public signal, add a label
  write (and, where workflows run on label events, a CI run) per pull
  request per merge, and still not be a verification.
- **Updating every branch that is behind.** One pull request at a time is
  updated, by a person, as update next; a repository that wants the rest
  done for it turns on the forge's merge queue.
- **Accepting a head the drive did not verify.** A head that differs from
  the verified one only by a clean merge of the base might keep the drive's
  verification, which would spare a repository that requires up-to-date
  branches a re-drive per merge. Whether it is safe is a question for the
  drive's convergence contract, not the board, which reads the drive's
  verdict and never widens it.
- **An early tick on a merge.** A tick started by a forge event would
  shorten the time a merged card stays in the list, but needs a route into
  the host, which the dispatcher opens for nothing; the ready list is at
  most one interval and one tick old, and says how old.
- **Reporting a stopped host to someone not looking.** The page already
  says when its newest tick is overdue, and the Jig plugin's status bar
  item flags an overdue tick while Orca runs. A host that is off cannot
  send that itself, and flags nothing in either place; telling a person
  needs a watcher elsewhere, which is outside the dispatcher.
- **Who wrote each thread, outside the detail set.** A thread's author
  costs a request per thread, so the split by bot and not a bot covers the
  detail set only; on every other card the thread mark shows the total and
  links to the conversation, which shows the authors.
- **Ordering the queue by predicted conflict.** Knowing which ready pull
  requests touch the same files as others would need a file read per pull
  request each tick; the serialized areas already name the contention a
  repository knows of.
- **Pull requests nothing drives.** A pull request with no ledger and no
  label is a person's own; the forge lists it.

## Review

Critiqued by four reviewers with fresh context (subagents that did not
write it, as a critical chief technology officer, a security auditor, a
performance engineer and a cost optimizer) on 2026-11-04 against commit
`08703e16`.
What the hub adds to it was critiqued with the hub's design on 2026-11-06
([hub.md § Review](hub.md#review)).
