# Driving any pull request from anywhere, with autonomy that fits the hour: design

**What problem this solves.** A pull request should reach its merge decision
without a person watching the agent that drives it. Today the driver assumes
the working tree that opened the pull request: that tree holds the branch,
the clone holds the state, and the lock names a process on one machine. The
moment a pull request has to be driven from somewhere else, the drive does
not happen: a second working tree cannot check out the branch and invents a
suffixed one; every stop the driver makes (a pass past its deadline, a
stalled round, a usage limit, a parked decision) ends the drive, and nothing
restarts it until a person does; a session on another subscription or
another machine has no sanctioned way to pick it up. On top of that, drives
stop for decisions an agent could take: filing a follow-up issue, deferring
a finding where the tracker adapter cannot file, a choice one pull request
can undo, a review bot's acknowledgement that a guard reads as a new
comment. A person who runs several drives wakes up to find most of them
stopped early, each for a reason the handoff file states only partly, and
spends the morning restarting them.

With this built, a pull request is the unit of work and the forge is its
shared truth. Any session, in any checkout of the repository or none, on any
machine and any subscription, can arm the drive, pick up a drive whose
driver is dead, wedged or parked, and resume from the state the previous
driver left on the pull request itself. The driver restarts itself from the
stops it can recover from. The drive stops for a person only on a decision
class the [human-in-the-loop (HITL) registry](../modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md)
names, and when it does, it hands over a framed decision: the question, the
options and their consequences, the recommended option, and what a person
must do. Everything else it decides, records where a person can see and
reverse it, and keeps going. A repository can widen that autonomy, and may
widen it further during the hours nobody is there to ask, because the one
irreversible act, the merge, stays with a person
([ADR-0003](../docs/adr/ADR-0003-a-person-merges.md)).

This is the design of [plan.md](plan.md) item 32. The drive it changes is
[`drive-pr`](../plugin/skills/drive-pr/README.md); the pickup that arms it is
[`do-item`](../plugin/skills/do-item/SKILL.md); the decision ladders it widens
are [`decide`](../plugin/skills/decide/SKILL.md)'s and the
[review arbiter](../plugin/agents/review-arbiter.md)'s; the skill that asks
before filing is [`file-issue`](../plugin/skills/file-issue/SKILL.md).

## What goes wrong today, by mechanism

Each failure below is a consequence of one assumption the tooling makes. The
design removes the assumption rather than patching the symptom.

| Assumption | What it produces | Removed by |
|---|---|---|
| The pull request's head branch is checked out in the driving tree | Git allows one checkout per branch, so a second working tree for the same pull request gets a branch with a numeric suffix, and a drive from it pushes nowhere or refuses to start | [Driving from any checkout](#driving-from-any-checkout) |
| A stop is for a person to undo | A pass killed at its deadline, a stalled round, a usage wall and a park all end the drive with the locks released; the next round waits for whoever notices | [A stopped drive restarts itself](#a-stopped-drive-restarts-itself) |
| The drive's state lives in the clone | A session in another clone, on another machine, starts at round zero, cannot see what was parked, held or verified, and cannot tell whether the other clone's driver is alive | [The ledger on the pull request](#the-ledger-on-the-pull-request) |
| A successor would hit the same usage wall | A quota-parked drive refuses to hand off even to a session on a different subscription | [Picking up a drive](#picking-up-a-drive) |
| Unsure means ask | The decide ladder's last row escalates whatever it did not clearly decide, the park command accepts any reason, filing an issue asks first, and a deferral that cannot file becomes a park | [Autonomy is a policy](#autonomy-is-a-policy) |
| A park needs only a reason | The handoff lists a parked key and a sentence; the person has to rediscover the options, the consequences and what to do | [A park is a framed decision](#a-park-is-a-framed-decision) |
| Every comment after a held reply is new work | A review bot's chat acknowledgement of an accepted reply, carrying no finding, stops the thread from resolving on the verified push and gets a second outcome reply | [A review bot's acknowledgement is transparent](#a-review-bots-acknowledgement-is-transparent) |

## How it works

### Driving from any checkout

The driver stops requiring the pull request's head branch to be checked out.
A new script, `drive-pr/scripts/attach-pr.ts <PR>`, prepares whatever
working tree it runs in:

- it fetches the head branch from the remote the drive pushes to and
  resolves the pull request's head commit;
- when the head branch is free in this clone, it checks it out; when another
  working tree of the clone holds it, it checks out the head commit
  **detached** and records `drivenBranch` in the drive state. A suffixed
  branch is never created: the pull request's head branch is the only branch
  a drive pushes to, and the push already names it by explicit refspec from
  a resolved commit (`guarded-push.ts`), so a detached tree pushes exactly as
  a named one does;
- it refuses, with the state named, when this tree is dirty or on an
  unfinished git operation, when the tree holding the branch is dirty or
  ahead of the remote (its unpushed work would be driven around), and when
  the pull request comes from a fork (the push path refuses those already).

The record is written twice: `drivenBranch` in the drive state, and a
small file in the tree's own git directory carrying the branch and the
commit the tree was last left at, so that code outside the skill (the shared
process helpers, `resolve-conflicts`) can read it from the tree alone. The
drive rewrites the commit after every commit and push it makes, and the file
is trusted only while the tree's head is exactly that commit, so a person's
`git checkout --detach`, a bisect or a rebase leaves a head the record does
not name and the record stops answering; it is also removed when the tree is
attached by name. A separate provenance file in the same directory carries
the repository, the pull request number and whether the drive created the
tree. Nothing removes it but resource collection, and it does not depend on
the branch or its remote ref, so a merged and pruned pull request's tree is
still identified as the drive's. Every script that reads
the branch name or the upstream reads the record instead, and the step that
builds this lists each site:
`base-sync.ts` and `lib/base-drift.ts` (which refuse a detached head by
name today), `capture-intent-chain.ts` with `lib/intent-chain-capture.ts`,
`verification-fit.ts`, `lib/state/handoff.ts` (the issue key from the
branch), `lib/overlay.ts`, `drives.ts`'s leftover detection and the
`@{u}` advice in `SKILL.md`, `lib/driver/review-quota.ts` and
`lib/driver/review-failure.ts` (which become `drivenBranch`'s remote ref),
every caller that resolves the pull request from the current branch
(`resolvePr("")` in `shared/proc.ts` and `lib/proc.ts`, which a detached
tree answers from the state), `resolve-conflicts`' operation detection,
the arm step's issue-key gate, which for a pull request in another
repository runs in the placed tree against that repository, and the
continuous-integration repair procedure's reads of the current branch. The
push's own checks, which already compare commits rather than names, stay as
they are. A tree detached at a commit that some branch or remote ref
reaches is attachable; the orphaning refusal counts only commits no ref
reaches.

`drive.ts` runs the attach after taking the worktree lock and before the
pull-request lock: a tree another driver holds is never moved, and a tree
this driver holds is attached before the drive it is about to run. Every
round's commit works on whatever the attach left: a branch or a detached
head. The pickup's
branch policy (`pr-plan.ts branch`) keeps naming the branch of a **new** pull
request; for an existing one the branch is the pull request's head, and the
instructions say so where they say "create the branch".

A pull request with no working tree at all (one an update bot opened, one a
session in another repository opened with the forge's command line, one whose
tree was deleted) is driven from the clone's primary checkout:
`/jig:drive-pr <PR>` there creates a working tree with `git worktree add
--detach` under the first root `gc.worktree_roots` names (default empty:
with no root the command refuses, naming the setting and the value to add,
and creates nothing) (the
[workspace tool](../tools/herdr/README.md)'s `open` wants a branch and runs
outside the plugin, so the drive does not go through it), attaches the pull
request in it and arms the drive there. The tree is the drive's, recorded by
`drivenBranch`, so [resource collection](resource-gc.md) reaps it by that
record once the pull request merges or closes.

A pull request in **another repository** is named as `owner/repo#N` or by
its URL. The user layer of the configuration (`~/.jig/jig.yaml`) gains a
`clones` map from repository slug to local clone path; a session that names a
pull request outside its own repository arms the drive in that clone's
primary checkout as above, and, with no clone mapped, prints the exact
command for a person or another session to run, as `do-item` prints an arm
command it cannot spawn.

### A stopped drive restarts itself

Liveness is not rebuilt: the claim already carries `lastProgressAt`, and
`drives.ts --doctor` already reports `WEDGED` when a live driver's progress
is older than `DRIVE_PR_STALL_MIN` (floor 240 minutes, derived from the pass
deadline and the gate poll so that an honest long round is never flagged),
`DEAD_WITH_LEFTOVERS` when a driver died with unpushed work, `QUOTA_PARKED`
and `NEEDS_HUMAN`. A running pass with stale progress is healthy by design,
since a `claude -p` pass prints only at its end. What is missing is that
every stop ends the drive, locks released, and the next round waits for a
person. The driver therefore recovers from the stops that need no decision:

- **Pass deadline (exit 15).** After the pass is witnessed killed, the
  driver runs the two checks the exit asks a person to run (uncommitted
  edits, unpushed commits), leaves both in the tree for the next pass to
  find, and starts the next round, up to `drive.pass_deadline_retries`
  (default 2) in one drive. A deadline that recurs past the budget stops as
  today, and the stop says the budget is spent. A kill the platform witness
  cannot confirm complete (on Windows, confirmed cleanup covers only the
  observed and registered processes) is not restarted from: it stops with
  exit 15 and keeps its locks, as today.
- **Stalled (exit 14).** Two passes that changed nothing are, in the
  measured cases, a pass that stood down. The driver runs one more round
  with the stand-down diagnostics in the pass prompt before it stops, and
  the stop names what the passes decided.
- **Short usage wall.** Already slept through. Unchanged.

A drive that cannot recover (a weekly wall, a park, a genuine stall) stops
as today and leaves its state and the ledger current, which is what makes
[picking it up](#picking-up-a-drive) cheap.

### Picking up a drive

A drive that stopped holds no lock, so picking it up is a **re-arm** from
its durable state, not a takeover, and it is admitted at every autonomy
level because an answered question or a cleared wall is not the agent's
decision:

- after `QUOTA_PARKED`, by a session whose pass will bill a **different
  account** from the one the wall belongs to. The quota-park record gains
  the account, kept in the clone's own state (the claim stores the identity
  as `lib/identity.ts` resolves it, an address for a file-backed login, so
  this record is hashed or kept local, never copied as the claim has it),
  the caller's account is resolved from the pass command it will spawn, and
  the re-arm is refused when either side is unknown. "Do not dispatch a
  successor" stays for a successor on the same account until the recorded
  reset has passed, or until a person says the window reopened with
  `--window-reopened`, a flag the skill forbids an agent to pass, as it
  forbids clearing a lease. The exit prints the re-arm command with the
  account the wall belongs to. From **another clone** the account is not
  known (the ledger never carries it), so that re-arm follows the same-account
  rule: after the recorded reset, which the ledger carries, or with
  `--window-reopened`;
- after `HITL_PARKED`, once every parked item is **answered**: a comment by
  an author with the repository's owner, member or collaborator association
  (the rule the summary-finding guard already uses), on the thread or the
  decision record, later than the park, that states a verdict on the parked
  decision (an option named in the record, or an outcome word) and is not
  one the driving agent posted through its own account. A question, a "still
  investigating" or a comment by the driver's own login is not an answer. A
  class that asks for an independent approver keeps that requirement. The
  re-arm unparks those items and passes the answers to the first round as
  human verdicts.

Replacing a driver that still holds its locks is a **takeover**, and it is
admitted only against a holder whose verdict is `WEDGED`, or whose process
is gone with `DEAD_WITH_LEFTOVERS` cleared (its leftovers pushed or
discarded first; on the same machine the takeover refuses until they are).
Against a holder with any other verdict it refuses exactly as exit `11` does
today, and the refusal says the verdict and, when a takeover is admitted,
prints the command:

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --take-over -- claude -p "/jig:drive-pr --bots-only <PR>"
```

In the same clone the takeover stops the holder with the identity check
`drives.ts --stop` performs, writes a takeover record to the state and the
ledger (from which actor, to which, the holder's verdict), runs
`reconcile-replied-threads.ts` before its first triage, and resumes at the
same round. The record names the actor and account only in the clone's own
state; the copy mirrored to the ledger carries the actor, the verdict and
the round, and never the account. Held items are carried over by their state: a hold whose fix is
pushed is resolved as today; a hold whose promised fix never landed is
reopened with a superseding reply that says so, and the successor either
redoes the fix and re-holds the item under itself or triages it afresh, each
recorded.

Across clones no process can be stopped and no lock is shared, so the
takeover goes through the ledger: it is admitted only when the ledger's
driver heartbeat is older than the lease window, which is the doctor's
stall threshold: it exceeds a pass's deadline plus the gate poll, so the
ledger writes at round boundaries keep a live driver fresh, and a write that
fails is retried at the next boundary (a stale heartbeat only makes a
takeover admissible, and the claim below arbitrates it). It is claimed by an
append-only comment on the pull request naming the ledger generation it read
(the forge assigns increasing comment ids). One winner is elected per
generation: the claim with the lowest comment id among those naming that
generation. A later claimant stands down after reading the elected claim, and
a driver exits only for an elected claim from another clone that is newer
than its own drive, never for a claim that lost its election; every driver
reads the ledger at each round boundary. The doubled replies a
second driver can produce are measured and not repairable, which is why
"do not kill the other driver" holds today; the ledger claim is what lets
the rule become "do not drive beside a driver whose claim is newer than
yours". The arbitration holds only once every driver of a pull request runs
a plugin version that reads the ledger, and the drive's documentation says
so.

### The ledger on the pull request

The drive state's resumable subset is mirrored into one hidden-marker comment
on the pull request, the **drive ledger** (`<!-- drive-pr-ledger -->`):
`ledgerVersion` and a monotonic `generation`; the round, the phase, the
last counted and verified heads and the Ready mark; every parked item with
its framed decision; every held item by key, outcome and pushed commit; the
takeover claims; the decisions taken unattended
([below](#every-autonomous-decision-is-recorded)); and the driver's actor
and last heartbeat. The account is never posted: a hash of an address can
be checked against a guessed address, so the account stays in the clone's
own state, where the same-clone re-arm reads it; the quota park travels
with its reset time and window kind but not its account, which is why a
re-arm from another clone follows the same-account rule above. The privacy
filter runs over the whole outgoing payload, not over chosen fields: every
free-text value (the narrative, parked reasons, framed decisions with their
options and operational steps, held outcomes, the decisions taken
unattended) has address-shaped strings replaced with `<redacted>` before it
is written. The narrative of the handoff file travels with it, cut to its
last twenty lines.

A parked decision record is bounded (a fixed length per record, longer
input refused at the park with "shorten it"), so the comment can hold every
parked decision. The comment is cut to the forge's body limit by dropping
held items' outcomes first and the narrative second, never a parked
decision; a park that still cannot fit stores its full record as its own
comment under a second marker, and the ledger carries that comment's link.

It is written at round boundaries and at every park and takeover. The forge
offers no conditional update of a comment, and a read-back cannot tell two
writers of one generation apart, so a change is never an overwrite: each
writer appends an operation record (its actor, the generation it read and
the fields it changed) as its own comment under a second marker, and the
ledger's state is the deterministic fold of those records in comment-id
order. A scalar field (the round, the phase, a head, the Ready mark) is won
by the later record that names it; a collection (parked items, held items,
the decisions taken unattended, the takeover claims) is never a field a record
replaces: a record adds, changes or removes one item by its key, and a removal
is a record of its own naming that key, so two writers that each add a
different parked item both survive the fold. No record is ever
edited, so no change is lost; the single ledger comment is a snapshot of
the fold that any writer may regenerate, and a reader that finds it behind
the records folds them itself. The records are cut to the same last-twenty
and body-limit rules as the snapshot. Two creations of the snapshot that
race leave two comments, of which the lower id is canonical and the other is
deleted by its author on its next write. A ledger is **trusted** only when its
comment's author is the drive's own login or carries the owner, member or
collaborator association; any other comment carrying the marker is ignored
and reported. Trust names who may write; the fields that gate an action
(the Ready mark, verified heads, held outcomes) are re-read from the forge
before the drive acts on them, so a trusted but wrong ledger seeds a drive
and does not decide for it.

A drive that starts in a clone with **no state** for the pull request seeds
its state from the ledger; a drive whose local state is **older** than the
ledger's generation seeds from the ledger too, since newer wins in both
directions; a `ledgerVersion` it does not read refuses with the version
named. The locks stay per clone: the ledger seeds and arbitrates, it does
not lock.

### Autonomy is a policy

A new configuration section, `autonomy`, says how far an agent may go
without asking. It is read through the shared reader at every decision
point rather than once, so a window that opens mid-drive applies to the next
decision.

```yaml
autonomy:
  level: attended            # the default: attended | unattended | wide
  max_level: unattended      # the ceiling this repository allows any layer to choose
  off_hours:
    level: wide              # the level during the windows below; unset: off_hours is off
    schedule:                # default once off_hours is on, in the machine's local time
      - "Mon-Fri 20:00-07:00"   # a window may cross midnight
      - "Sat-Sun"
      - "Mon 00:00-07:00"       # Sunday night, which the two above leave out
```

The repository sets the default `level` and the ceiling `max_level`; the
user layer and the environment layer may choose a level up to the ceiling
and no higher, which is how a person's machine runs more autonomously than
the team's default without any layer raising what the team allowed. The
effective level is the chosen level, or the off-hours level inside a window,
capped by `max_level`. An explicit choice in the environment layer wins over
the off-hours level, so `attended` set for one run stays `attended` inside a
window; precedence between the other layers is the configuration's usual
one, the higher layer overriding the lower.

The ceiling `max_level` and `park_classes` are a control plane, so the
reader takes them from the pull request's **base branch** snapshot, the
boundary the review skill already draws for independent review, and ignores
a `JIG_OVERLAY` redirect and the working tree's copy. A pull request that
edits them takes effect after it merges. When the snapshot cannot be read the
reader fails closed: ceiling `attended`, and no decision is taken
unattended until the policy reads, since a default class list could be
weaker than the repository's own, so everything that would be decided is
parked as a human decision. A session with a person in it (an interactive run,
not a driver pass) reads `attended` unless the person set otherwise. The
pass prints the level and its source at the start of every round; the round
report and the ledger say which level each decision was taken under.

The default is `attended`, which is today's behaviour, so an upgrade changes
nothing until a repository opts in. `wide` and `off_hours` are dark-by-default
dials, and Jig keeps those out until a working repository has validated them:
this design specifies them, and build step 5 is not imported into Jig until a
working repository has run them and the measure below holds.

What each level permits, per decision class. The decision classes the HITL
registry reserves are not on this table and no level changes them. Picking
up or taking over a drive is not on it either: those are admitted by
mechanical states, at every level.

| Decision | `attended` | `unattended` | `wide` |
|---|---|---|---|
| File a tracker issue a skill needs (a deferral, a follow-up, a reflection escalation) | Confirm first | File it; the body says which skill filed it, from which pull request, and why | Same |
| Defer a finding where no adapter can file | Record it in the pull request's deferral section ([below](#deferral-without-a-tracker)) | Same | Same |
| A technical choice `decide` rules reversible inside one pull request | Decide and record | Same | Same |
| A technical choice `decide` would rule underdetermined | Park under `technical-escalation` | Gather the missing evidence within the round's budget, then apply the ladder; still undetermined: park under `technical-escalation` | Same |
| A technical choice `decide`'s last row would escalate: no sensitivity flag, no stakeholder category, no persisted-data or published-contract consequence | Park under `technical-escalation` | Park under `technical-escalation` | Decide, marked provisional |
| A bot-review thread the arbiter rules `escalate` with no registry class and no recorded human decision behind it | Park under the class `escalated` | Same | Reply with a provisional outcome and the rationale, resolve, list it in the morning report |
| Re-arm after `HITL_PARKED` with parked items still unanswered | Never | Never | Once every unanswered item is provisionally decided, where the class allows it |

**Provisional** is a mark on a recorded decision, not an outcome token of its
own: it qualifies a reply outcome (`rejected`, `wont-fix`, `deferred`) or a
`decide` ruling recorded in the decision record format. A provisional
decision never produces a fix, so it never grows the diff, and the size
budget stays mechanical. It is marked as such in the thread reply or the
decision comment and in the ledger, listed first in the morning report, and skipped by
`reconcile-replied-threads.ts` and by triage, so a person's reversal is not
undone by the next round. The reversal is a comment on the thread or the
decision record by an owner, member or collaborator: the next round reads it
as a human thread and parks it under `human-thread`, never re-decides it.
An unresolve alone, which the forge records without an author, is not a
reversal. Provisional is admissible because the merge is still a person's: it
changes a draft the person will read, never what is released.

The measure that validates `wide`: the share of provisional decisions a
person reverses before the merge, over the first month a repository runs it.
With at least ten provisional decisions in that month and fewer than one in
ten reversed, the dial is documented as available; with fewer decisions, or
more reversals, the arbiter's `escalate` was right or the sample is too thin,
and the dial stays dark.

### Every autonomous decision is recorded

A decision taken without a person is written where a person can find and
reverse it, in the same step that takes it: a thread reply with the outcome
token and the rationale for a review finding; a comment in the decision
record format for a `decide` ruling; the issue body for an issue filed; the
ledger for all of them, under `## Decisions taken unattended`, with the
level, the class and how to reverse it. A decision with no record is a
defect the round report counts, the same way an unparked escalation is one
today.

### A park is a framed decision

`drive-state.ts park` stops accepting a bare reason. A park carries:

- `--class`: the decision class that stops the agent. The classes are read
  from the repository's configuration, `autonomy.park_classes`, whose
  default is the registry template's rows (`ready`, `merge`, `release`,
  `scope`, `human-thread`, `reviewer-posture`, `next-item`,
  `reopen-or-waive`, `dark-dial`, `rules`, `destructive`, `legal`, `copy`),
  plus `escalated` for a product or stakeholder call the arbiter or
  `decide` escalates (the `hitl:<stakeholder>` categories),
  `technical-escalation` for a technical choice `decide` could not settle
  (underdetermined after the evidence budget, or its last row) and
  `human-decision` for a value the pull request records as a person's
  decision or a rule inside a human-decided span, which the arbiter may only
  ever escalate. A repository whose registry has more rows adds their
  classes; the arbiter's `escalate` output gains a `class:` field so the
  class is the arbiter's ruling, not the agent's claim. A park with no class
  is refused with "decide and record it", at every level: the classes are
  the whole list of what a person must decide, and a decision outside them
  is the agent's to take. A registry row the repository has recorded as
  delegated (`ready`, under `pull_requests.mark_ready`) is not a park class
  for that repository;
- a **decision record** on stdin: the question in one sentence; each option
  with what it changes and what it costs; the recommended option and why;
  the class that keeps the agent from taking it; the operational steps a
  person must perform, if any, each as a command or a named action; and
  what the agent already did about it, so partial progress is visible. The
  [writing rules for text that asks a human to decide](../plugin/skills/decide/references/human-call-elaboration.md#writing-rules-for-text-that-asks-a-human-to-decide)
  apply.

The drive keeps working around a park: everything the parked item does not
block is driven to its end before the drive stops, so `HITL_PARKED` means
"only these remain", never "stopped at the first question". The exit prints
each parked decision in full, the handoff file and the ledger carry them,
and `drives.ts --doctor`'s `NEEDS_HUMAN` row names the questions instead of
the count.

### A review bot's acknowledgement is transparent

Two kinds of review-bot follow-up land after a held reply, and the guard
against resolving over a newer comment must know both. The bot's
**confirmation** ("synchronized as addressed"), which lands before or after
the push, is a review feature and carries the bot's confirmation marker. The
guard accepts it today only for CodeRabbit's login and marker, with no
outcome token, and fails closed for every other bot; accepting another bot's
confirmation is new work (`confirmation_marker` below). The bot's **chat auto-reply** to any comment on its thread
("acknowledged, nothing further requested, the unpushed fix remains
unverified") is a chat feature, carries the bot's generated-reply marker
instead, lands on every accepted thread every round, and is what the guard
refuses today, so that the held item never resolves and the next pass
answers the acknowledgement with a second outcome reply.

The guard's predicate stays mechanical and fail-closed. `review.bots`
entries gain two optional markers beside the login, `confirmation_marker`
(today's constant, as the default for the bot it was measured on) and
`chat_marker`. A comment after a held reply is transparent when its author
is a listed bot and its body carries that bot's chat marker, no outcome
token, and none of the bot's finding shape (its severity line); anything
else is a newer comment and is triaged. A measured confirmation marker
keeps applying to its bot whether or not the list names it, as it did
before; only the chat marker needs the listing, since it is the one that
admits a comment on the bot's word. A transparent comment is never
answered: a reply that is transparent is not work. No override exists for
the agent to assert that a comment is harmless; a comment the predicate
cannot classify is triaged, and a guard that refuses a state the agent has
verified is a [reflection](../plugin/skills/reflect/README.md) finding about
the guard, filed in the same round, with the item parked under the class
the guard protects.

A repository can also turn the chat replies off at the source, which is the
mechanical fix: for CodeRabbit, `chat.auto_reply: false` in
`.coderabbit.yaml` stops untagged replies while leaving its reviews,
confirmations and tagged commands as they are. The drive's documentation
names that setting beside `review.bots`.

### Deferral without a tracker

The deferral protocol's rule that nothing is deferred without a tracked
issue gains one alternative. A deferral whose adapter cannot file (the batch
step is bound to one tracker until
[plan item 10](plan.md#10-values-the-skills-still-assume) moves it onto the
interface) is recorded in a `## Deferred` section of the pull request body
under a hidden marker, with the finding quoted, the reason and the thread
link, projected from durable deferral operations: each deferral is an
append-only operation record under the ledger's operation marker (the finding,
the reason, the thread link, an item key), so none is lost to a concurrent
writer, and the body section is a projection the fold regenerates, never the
source. A person's edit to the section is read back as an operation of its own
(an added, changed or removed entry) before the projection is rewritten, and
an edit outside the section is carried over unchanged from the body read
immediately before the write; the thread is resolved with the `**deferred**`
token linking the section. A plugin script, `file-deferred.ts <PR>`, turns
the section's entries into issues where an adapter can file and replaces
each with its link; it runs from the consumer's own post-merge step or the
morning report, and on a pull request closed without merging. With no
tracker at all the entries stay in the merged pull request's body and the
morning report lists them until a person files them. A deferral is
therefore never a park.

### The morning report

`drives.ts --report [--since <time>]` says, for every pull request this
clone's state knows and every open pull request the account authored or
drove (found through the forge's search for the ledger marker), since the
time (default: the last report): its terminal state and what it means for
the person; the provisional decisions, first; the takeovers and re-arms;
the parked decisions in their framed form; the issues filed and the
deferred entries not yet filed, including those in a closed pull request's
body, found through the deferral section's hidden marker. It is the one thing a person reads after an
unattended night. Where a repository has a pre-merge follow-up step, that
step's list includes the pull request's provisional decisions.

### Observability and tests

`loop-metrics.ts` counts, per pull request, the self-restarts by cause, the
re-arms and takeovers, the provisional decisions and their reversals, and
the transparent acknowledgements. The validation measure for `wide` is
read from it. The tests add fault injection for a takeover claimed from two
clones at once and for two ledger writers racing on one generation, with
the fake forge the drive suite already uses; Windows runs the same suites,
and a pass command for another agent tool is out of scope as today (the
driver arms Claude Code's `claude -p` only, so "any subscription" means any
subscription that tool bills). The audit's M7 criterion for the published
registry checks for the row that reserves parking to the registry's
classes.

## Build order

The steps are serial: every one touches `drive.ts`, `drives.ts`, `SKILL.md`
and `README.md`, and each later step reads what the earlier one recorded.
Each pull request is shippable alone and carries its change note; the drive
suite's consistency checks run on each.

1. **Drive from any checkout.** `attach-pr.ts`, detached-head rounds,
   `drivenBranch` in the state and at every site listed above, the pickup
   and drive instructions that stop creating a branch for an existing pull
   request, the tree created for a pull request with none and reaped by its
   record, and the `clones` map for another repository's pull request.
2. **Self-restart, re-arm and same-clone takeover.** The pass-deadline and
   stall recoveries with their budgets, the quota-park record's account and
   the re-arm by another account, the re-arm on answered parks, `--take-over`
   against `WEDGED` and dead holders with the held-item carry-over and the
   takeover record, the exit-`11` message and the skill rule that replaces
   "do not kill".
3. **The ledger on the pull request.** The mirrored subset with its version
   and generation, trust and size rules, seeding from and yielding to a
   newer ledger, the append-only takeover claim and the per-round claim
   check, and the morning report's population through the ledger marker.
4. **The autonomy section and the framed park.** `autonomy.level`,
   `max_level`, the shared resolver and its source line, the `unattended`
   column (issues filed without confirmation, deferral without a tracker
   with `file-deferred.ts`, `decide`'s underdetermined row gathering
   evidence), `park --class` with the decision record on stdin and the
   classes from configuration, the arbiter's `class:` field, the drive
   working around a park, the transparent acknowledgement with the
   per-bot markers, the ledger's decisions section, the registry row that
   reserves parking to its classes, and the audit criterion.
   `park_classes` and `max_level` are read from the base branch's snapshot
   only: a layer an agent controls must not widen what it may park on. `park --class` is a **Breaking** change for a
   consumer whose own procedures call `park`. Its ADR, numbered next,
   records that parking is reserved for the registry's classes and that
   every autonomous decision is recorded where a person can reverse it.
5. **Off-hours and the morning report.** The schedule, the `wide` column
   with the provisional outcome and its reconciliation skip, re-arming after
   a park once every unanswered item is provisionally decided, the
   provisional entries in the ledger's decisions section, `drives.ts
   --report` and the loop-metrics counters.
   Imported only after the validation measure holds in a working repository
   that has run it.

## Left out

- **The merge, the release, the reviewer's posture and the next item** stay
  a person's. A dark factory with no person at the merge is a different
  doctrine
  ([plan item 9](plan.md#9-delegated-merge-pull_requestsmerge-auto-on-converged)
  has the conditions); this design makes the night productive up to that
  decision, not past it.
- **A lock shared across clones.** The forge has no primitive for one. The
  ledger's append-only claim and the per-round claim check are the
  arbitration; they hold once every driver reads the ledger, and not before.
- **Reading a session's context usage.** The handoff dial stays
  agent-judged; nothing here measures it.
- **Pacing against a usage window in advance.** The wall is detected after
  the fact, as today; what changes is who may pick the drive up afterwards.
- **A pass command for another agent tool.** The driver arms Claude Code's
  pass only, as today.

## Review

Reviewed on 2026-10-28 at commit `86abdc7` by a fresh-context reviewer
session, as an adversary. Verdict: approved for steps 1 to 4; step 5 once a
working repository has validated `wide`.
