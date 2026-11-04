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

How much ready work waits, and how much of it is lost to a conflict, is
measured first ([Build order](#build-order)): the outcome log already holds
the re-drives of converged pull requests that went stale, with their cause.

With this built, a **Ready to merge** list leads the page: the converged
pull requests one person's act from the merge, in lanes named for that act
(merge now, with a merge command pinned to the head the drive verified;
approve first, naming who must approve; update next). Every pull request
carries the same status row (conflicts, checks with the failing ones named,
unresolved threads, and the derived merge state with its conditions as a
checklist), and every card says whether it settles by waiting or waits on a
person, and which act. Then, as a view of its own, a **board**: every piece
of work the dispatcher knows, in one column (coming, picking up, driven,
needs you, ready to merge, merged). A card moves in any direction, because
each tick places it again from the records, and a card that moved back (a
ready pull request that came to conflict, say) shows where it came from and
why. A person is told once when a pull request becomes ready, and the
history view says how long ready work waited and how much was lost.

This is the design of [plan.md](plan.md) item 36. It builds on item 33,
[the dispatcher](dark-factory-dispatch.md), every step of which is built:
the tick, its ledger classes, the serialized areas and the outcome log the
board reads.

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
| Coming | an item assigned to the factory identity and not started; a drive the tick re-arms or re-drives when a slot frees; a pull request held behind another in a serialized area; a pull request labelled `drive`; a converged pull request behind its base, updated after the one in update next | the queue the line holds today, and the board read |
| Picking up | an item a pickup session is working on, with no pull request yet | the pickup's launch record and the assigned items the tick already reads; no tracker read of its own |
| Driven | a pull request whose drive runs: its ledger says running, on any machine | the ledger (`driven`, and `silent` marked as such) |
| Needs you | a pull request or item stopped on something only a person settles: a park, a drive stopped on a failure, a stalled pickup, a double claim, a converged pull request the forge refuses to merge for a reason no drive fixes | the needs the line holds today, and the board read |
| Ready to merge | a converged pull request one person's act from the merge ([§ Ready, exactly](#ready-exactly)) | the ledger and the board read |
| Merged | a pull request merged since the start of the host's day, with its follow-up's state | the merged listing, the follow-up's launch record and marker |

A drive a person stopped (`stopped-by-person`), and a pull request a person
labelled `hold`, are in Needs you, in a group of their own named "stood
down", folded to its count: they wait on a person, who already knows.

A card says what it is (pull request or item, its title and link, its
repository), how long it has been in its column, the status row below when
it is an open pull request, and what the column needs said:

- **Driven:** the drive's round, its unresolved threads per round where
  this machine launched it (the samples the line carries), and who drives
  it: "this machine, account X" when a launch record confirms it, else
  "claimed in its ledger by host Y", a claim the board shows as a claim. A
  claimed drive whose heartbeat passes the lease window is the `silent`
  class and is marked so.
- **Needs you:** what it carries today: the framed decisions with their
  reply drafts, and the stop's reason as quoted record text.
- **Ready to merge:** the head the drive verified, the merge state as the
  forge reported it at the tick, the pull requests waiting behind it in a
  serialized area, and the act left.
- **Merged:** when it merged, and its follow-up: coming, running, done, or
  in Needs you when it failed.

The accounts and their slots stay above the board as one row, so a person
still sees why a card in Coming has not started.

### Ready, exactly

One predicate decides it, a pure function in
`plugin/skills/drive-pr/scripts/lib/merge-ready.ts`. The tick calls it to
place a card, and `announce-merge-ready.ts` calls it before it posts, so
the board and the drive's announcement cannot disagree. It takes the facts
of one pull request and returns its lane and, for each condition not met,
whether waiting settles it or which person's act does. A pull request is in
Ready to merge, lane **merge now**, when all of these hold at the tick:

1. Its ledger stopped `0`, converged. `drive.ts` exits `0` only when the
   review converged on the exact head and every required check completed
   green on it
   ([What `CONVERGED` requires](../plugin/skills/drive-pr/references/terminal-states.md#what-converged-requires)).
2. Its head is the head the drive verified (`verifiedSha`).
3. The forge itself witnesses a review of that head: where the repository
   names a reviewer (`review.reviewer_app`), that app's check run on the
   head completed and neither failed nor was skipped; where it names none,
   a person's approving review stands on the head.
4. The forge reports it mergeable with its base (`mergeable` is
   `MERGEABLE`).
5. It is not a draft.
6. It has no unresolved review thread.
7. The forge's merge state says branch protection lets it merge now
   (`mergeStateStatus` is `CLEAN` or `HAS_HOOKS`), or its base requires a
   merge queue (`isMergeQueueEnabled`), whose own rules then decide.
8. Its author is the repository's own (association `OWNER`, `MEMBER` or
   `COLLABORATOR`), or a person approved it.
9. It carries no `hold` label.

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
That is a stricter gate than it holds today, where it refuses only a
conflict or a draft.

The board reads the facts conditions 3 to 8 need with its own query
([§ The board read](#the-board-read)); conditions 1 and 2 come from the
ledger the tick already reads. A converged pull request that fails a
condition goes where its reason says. The forge reports `BLOCKED` without
saying why, so the predicate reads the reason from the facts behind it, in
this order:

| The facts | Column, lane | What the card says | Waits on |
| --- | --- | --- | --- |
| a draft | Needs you | converged as a draft: marking it ready summons the reviewers that skip drafts | a person: mark it ready |
| an unresolved thread | Needs you | a thread was opened after the drive converged | a person: answer it, or re-arm the drive |
| the reviewer app's check on the head is missing, failed or skipped | Needs you | the review the ledger reports is not witnessed on this head | a person: re-arm the drive |
| `reviewDecision` `CHANGES_REQUESTED` | Needs you | who requested changes, and when | a person: that reviewer re-reviews, or the drive is re-armed to address it |
| an approval is required (`REVIEW_REQUIRED`, or condition 3 or 8 asks for one) and a review is requested | Ready to merge, approve first | waits on a review and approval from the reviewers or teams requested, and since when | a person: one of them reviews and approves |
| an approval is required and no review is requested | Ready to merge, approve first | needs a review and approval from someone other than its author, and nobody is asked | a person: request a review |
| `BLOCKED`, a required check running | the column it was in | the required checks still running | waiting |
| `BLOCKED` or `UNSTABLE`, a check failing | Needs you | a check failed after the drive converged, by name | a person: re-run it, or re-arm the drive |
| `BLOCKED` for none of these | Needs you | the forge blocks the merge on a rule the board cannot tell (signed commits, a deployment): open the pull request | a person |
| `BEHIND`, the first in Ready order of its repository | Ready to merge, update next | the repository requires an up-to-date branch; updating moves its head, which costs a re-drive (a review round and a CI run) | a person: update the branch |
| `BEHIND`, any other | Coming | behind its base, updated after the one in update next | waiting |
| `UNKNOWN`, or mergeability `UNKNOWN` | the column it was in, marked not read | the forge is still computing | waiting |

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
`verifiedSha` forty lowercase hexadecimal characters, the method one of the
three. A value that fails its form withholds the command, and the card
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
is, its act named on its face, and those cards are what the strip's counts
add up. A card that waits for something already running says what, and
says nothing is asked of anyone.

### The status row on every pull request card

Every open pull request carries the same four marks, in the same order and
the same place on the card, whatever its column or list, so a person
learns to read them once. Each mark is a short symbol and word, and opens a
hint with its detail on hover, tap or focus, as the page's other hints do:

| Mark | On the card | In its hint |
| --- | --- | --- |
| Conflicts | none, conflicting, behind, or not known yet | the forge's mergeability and merge state, and the base branch |
| Checks | running, green, failing, or none | for a failing pull request, each failing check by name with its app, "required" or "not required", and its run; for the others, the state |
| Threads | the number of unresolved review threads | the count, linked to the pull request's conversation |
| Merge | merge now, approve first, update next, or not ready | the [Ready conditions](#ready-exactly) as a checklist, each met or not with the fact behind it, and for each one not met whether waiting settles it or which person's act does |

The merge mark is the one derived state of the four: the predicate's
answer, so "why is this not ready" is answered on the card. Every hint ends
with the tick it was read at.

### The board read

The facts the predicate and the status row need beyond the tick's own
reads come from one read per repository, the **board read**, which the
tick makes after it has planned and launched. Nothing the tick plans or
launches reads it: the listing, the ledgers and the mergeability the
planning uses stay as they are. A board read that fails or runs past its
deadline (30 seconds per repository) marks that repository's cards "not
read at this tick" with the reason and writes it on the receipt; launches,
re-drives and notifications of stops are untouched.

It is two GraphQL queries through the signed-in `gh`, the same login the
drives use, so the two share one hourly budget:

- **The listing**, paged over the repository's open pull requests, 100 at a
  time, since a paged listing cannot be narrowed to the board's: per pull
  request a few fields (`isDraft`, `mergeStateStatus`, `reviewDecision`,
  `isMergeQueueEnabled`, `authorAssociation`), its head commit's check
  rollup state, and its review threads' resolution (up to 100).
- **The detail**, one query naming each pull request of the detail set by
  number: the converged pull requests, the ones in Needs you, and any whose
  rollup is failing. Per pull request: its head's check contexts (up to
  100, each with whether it is required, its app and its link), its review
  requests and its reviewers' latest reviews (up to 20 each).

Nothing reads the comments under a thread, which is where a query's cost
multiplies: the forge prices a query by the requests its connections need,
one per connection per parent node, at 100 requests a point. The listing
costs about two points per 100 open pull requests and the detail about one
point per 25 pull requests in its set, so a repository at the
[size this is built for](#the-size-it-is-built-for) costs about 4 points a
tick, about 50 an hour at a five-minute interval, and ten repositories
about a tenth of the 5,000 points an hour one login gets. The receipt
records each board read's cost and the budget left (the query's
`rateLimit`), so the figure is measured, not assumed. When the budget left
is below a fifth of the hour's, the tick skips the board read, and the
cards say "not read: the forge budget is kept for the drives".

A connection that overflows its page (more than 100 checks or threads on
one pull request) gets one follow-up query for that pull request alone. A
pull request still over after it (more than 300) is marked partial on its
card ("more than 300 checks: open the pull request") and is never in merge
now, since an unread failing check cannot be ruled out. It never fails the
read of its repository.

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
| Ready to merge → Needs you | a check failed after convergence, a reviewer requested changes or opened a thread, the forge blocks the merge, it became a draft, or its re-drive stopped |
| Approve first → Merge now | a requested reviewer approved |
| Ready to merge → Merged | a person merged it |
| Driven → Needs you | the drive parked or stopped |
| Needs you → Coming → Driven | the park was answered and the drive is re-armed |
| any → off the board | the pull request closed unmerged; the history view keeps it |

When each card entered its column, and where it was before, is kept in a
table of the state database (`board_seen`), keyed by repository and
target, not in the line: a tick for one repository, or one that could not
write the line, keeps every other card's time. A card that moved back (left
Ready to merge for anything but Merged, or moved left on the board) shows
where it came from, when, and the cause ("was ready 3 h; its base now
conflicts") until it moves again or the host's day ends. Those are the
moves a person most needs to see: work that was ready and was lost to
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

### What the page says first

The strip's Now tab carries the counts of cards that wait on a person, by
act: "3 to merge · 1 to approve · 2 to answer". The answer at the top of
the view leads with the merge queue when it holds anything: "3 pull
requests are ready to merge, the oldest for 5 h; 1 waits on an approval
nobody was asked for." The Ready to merge list stands at the top of the Now
view, above the panels it has today, which stay.

The board is a view of its own beside Now, History and Help. On a phone its
columns stack, Ready to merge first, then Needs you, Driven, Picking up,
Coming and Merged, each folded to its count beyond its first cards. On a
wide screen the six columns stand side by side in the order work passes
through them, Ready to merge marked apart, and an empty column narrows to
its heading. Whether the board later replaces Now as the first view is
decided once it has been used on a working line. The rest of the visual
design comes from a design round ([Build order](#build-order)).

The page stays as it is in what it never does: it holds no merge button
and opens no write route to the host. Merging is a person's act on the
forge; the page gives the link and the pinned command, as it gives a reply
draft and its answer line today. When
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
to one address. Repositories whose readers must not see each other's work
are therefore dispatched from different machine files.

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

The outcome log gains two event rows, each written once per cause as event
rows are today:

- **became ready**, keyed by the pull request and its verified head, when
  a card enters Ready to merge, with its lane;
- **left ready**, keyed the same way, when it leaves, with the cause as the
  reason (`merged`, `conflicting`, `head moved`, `behind`, `check failed`,
  `blocked`, `draft`, `closed`) and the time it was ready as its duration.

The lanes and the causes are closed lists in the dashboard contract, fixed
before the first row is written; the design round may change how the page
names them, never the values the rows store.

The history view shows, over its window: the pull requests that became
ready; those merged, with the median wait from ready to merged, split by
the lane they waited in; those still ready at the window's end, with the
oldest one's wait, since a median of the merged leaves out the longest
waits; and the ready work lost, left ready for anything but a merge, by
cause. Every wait is measured from the tick that saw the change, so it is
precise to one interval, and the view says so. The counts are SQL
aggregates over the log table's time window, the read the history view
already makes, with its index on time extended to the row's kind.

### The line grows one list

`LineSnapshot` gains `board`, a list of cards, each carrying its column, its
lane, the time it entered the column and its previous column with the time
and cause of the move (from `board_seen`), its `waitsOn`, its driver, the
status row's facts for an open pull request, the predicate's answer, and
for Ready to merge the verified head, the method and the pull requests it
unblocks. Each card names the need, session or queue entry it was placed
from, so the decisions and reply drafts the page shows today hang off the
card unchanged. The list is bounded: 100 cards a column, with the count of
the rest; 10 failing checks a card, with the count of the rest; the stood
down group as its count and its 20 newest. A line written by a tick from
before the board has no `board`, and the page says the board appears at the
next tick rather than placing cards itself.

The receipt records, per tick, the board read's duration and cost, the
forge budget left, the cards placed per column and the line's size in
bytes, so a board grown slow or costly is seen from one tick to the next.

## Build order

1. **Measure the waiting loss with what the log holds.** No code: on the
   host that dispatches a working repository, `jig dispatch log --since
   <30 days ago> --jsonl` gives the re-drives of a stale converged pull
   request with their cause (the ended rows' reason names them), and, per
   pull request, the time from its drive's converged row to its
   follow-up's launch, which marks the merge to within an interval. The
   counts go into the plan item, and a person decides from them whether
   steps 4 to 6 are built. Steps 2 and 3 are built either way: they are
   the queue a person asked for, and they measure the loss from then on.
2. **Ready to merge in the tick.** The predicate in `lib/merge-ready.ts`
   with a test for each condition and each row of the placement table, and
   `announce-merge-ready.ts` calling it; the board read with its deadline,
   budget floor, overflow follow-up and `UNKNOWN` re-read, isolated from
   planning; the merge command's strict forms; `jig dispatch`'s report
   listing the merge queue; the `ready` notification; the two event rows;
   the receipt's figures. Done when, on a repository with a required merge
   queue and one without: a converged, witnessed, mergeable pull request
   is reported in merge now with its pinned command; one blocked on a
   required review is in approve first naming the reviewers requested or
   saying nobody was; one by an outside author is in approve first; one
   whose ledger says `0` at a head its reviewer never checked is in Needs
   you; one whose base then conflicts leaves with a left-ready row and its
   cause; a merge puts one pull request in update next and the rest in
   Coming; each reaches a person's phone once; and a board read made to
   fail leaves that tick's launches as they were.
3. **Ready to merge on the page.** A Ready to merge list at the top of the
   Now view, with its lanes, the status rows, `waitsOn` and the pinned
   command; the strip's counts; the history view's counts. Done when the
   browser suites open it for a quiet line, a full queue and a morning of
   lost ready work, at phone and desktop width.
4. **Every card placed.** `lib/board.ts` places every card in its column,
   with a test for each row of the column and move tables; `board_seen`
   keeps each card's column history; the line carries `board` within its
   bounds; the status row reaches every open pull request. Done when a
   drive a person armed by hand shows in Driven as claimed, a tick for one
   repository keeps the other repositories' column times, and a tick at
   the design size keeps the line within its bounds.
5. **The design round.** A brief from
   [`design-brief-builder`](../plugin/skills/design-brief-builder/SKILL.md)
   for the board view: the six columns at desktop and phone widths, the
   scenarios of a quiet line, a full merge queue, a morning of backward
   moves and a long Needs you, light and dark. The round lands under
   [`prototypes/`](prototypes/rubric.md) with its scorecard, which covers
   every scenario, width and theme.
6. **The board view.** The board as the round designed it, a view beside
   Now; the Help view explains each column, the Ready conditions and what
   `only_labeled` leaves out. Done when the browser suites open the board
   for each scenario at phone and desktop width in one theme, the
   scorecard covering the rest.

## Left out

- **A merge button.** It would give the page a write route to the host and
  have the dispatcher's server act for a person on the forge; the pinned
  command and the forge's own button already let a person merge from the
  page in one step.
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
  says when its newest tick is overdue. A host that has stopped cannot send
  that itself; telling a person needs a watcher elsewhere, which is
  outside the dispatcher.
- **Who wrote each thread.** Splitting the unresolved threads into a
  reviewer bot's and a person's needs each thread's comments, the most
  expensive read the board could make; the thread mark links to the
  conversation, which shows the authors.
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
