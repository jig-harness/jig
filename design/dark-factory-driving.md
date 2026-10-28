# Driving any pull request from anywhere, with autonomy that fits the hour: design

**What problem this solves.** A pull request should reach its merge decision
without a person watching the agent that drives it. Today the driver assumes
the working tree that opened the pull request: that tree holds the branch,
the clone holds the state, and the lock names a process on one machine. The
moment a pull request has to be driven from somewhere else, the drive does
not happen: a second working tree cannot check out the branch and invents a
suffixed one; a session that finds a driver already registered stands down
even when that driver stopped making progress an hour ago; a drive that
stopped on a usage limit or a parked decision will not restart, and a session
on another subscription or another machine has no sanctioned way to take it
over. On top of that, drives stop for decisions an agent could take: filing a
follow-up issue, deferring a finding where the tracker adapter cannot file,
a choice one pull request can undo. A person who runs several drives wakes
up to find most of them stopped early, each for a reason the handoff file
states only partly, and spends the morning restarting them.

With this built, a pull request is the unit of work and the forge is its
shared truth. Any session, in any checkout of the repository or none, on any
machine and any subscription, can arm the drive, take over a driver that is
dead or stuck, and resume from the state the previous driver left on the
pull request itself. The drive stops for a person only on a decision class
the [human-in-the-loop (HITL) registry](../modules/M7-pr-lifecycle-review/templates/HITL-REGISTRY.md)
names, and when it does, it hands over a framed decision: the question, the
options and their consequences, the recommended option, and what a person
must do. Everything else it decides, records where a person can see and
reverse it, and keeps going. A repository can widen that autonomy, and widen
it further during the hours nobody is there to ask, because the one
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
| A registered driver is a live driver | Liveness is a process id plus a heartbeat the driver's own timer refreshes, so a pass that hangs keeps its locks indefinitely and every re-arm is refused as "another driver is live" | [Liveness is progress, and takeover is sanctioned](#liveness-is-progress-and-takeover-is-sanctioned) |
| The drive's state lives in the clone | A session in another clone, on another machine, starts at round zero and cannot see what was parked, held or verified | [The ledger on the pull request](#the-ledger-on-the-pull-request) |
| A successor would hit the same usage wall | A quota-parked drive refuses to hand off even to a session on a different subscription | [The ledger on the pull request](#the-ledger-on-the-pull-request) |
| Unsure means ask | The decide ladder's last row escalates whatever it did not clearly decide, the park command accepts any reason, filing an issue asks first, and a deferral that cannot file becomes a park | [Autonomy is a policy](#autonomy-is-a-policy) |
| A park needs only a reason | The handoff lists a parked key and a sentence; the person has to rediscover the options, the consequences and what to do | [A park is a framed decision](#a-park-is-a-framed-decision) |
| A guard's refusal is a human decision | A thread whose fix is pushed and verified stays open because a review bot acknowledged the reply, the guard against resolving over a newer comment refuses, and the agent parks it rather than waive a rule it did not own | [A tool's refusal is not a human decision](#a-tools-refusal-is-not-a-human-decision) |

## How it works

### Driving from any checkout

The driver stops requiring the pull request's head branch to be checked out.
A new script, `drive-pr/scripts/attach-pr.ts <PR>`, prepares whatever
working tree it runs in:

- it fetches the head branch from the configured remote and resolves the
  pull request's head commit;
- when the head branch is free in this clone, it checks it out; when another
  working tree of the clone holds it, it checks out the head commit
  **detached** and records `drivenBranch` in the drive state. A suffixed
  branch is never created: the pull request's head branch is the only branch
  a drive pushes to, and the push already names it by explicit refspec from
  a resolved commit (`guarded-push.ts`), so a detached tree pushes exactly as
  a named one does;
- when the tree is dirty or on an unfinished git operation, it refuses with
  the state named, as the clean-tree gate does today.

`drive.ts` runs it before taking the locks, and every round's commit works on
whatever `attach-pr.ts` left: a branch or a detached head. The pickup's
branch policy (`pr-plan.ts branch`) keeps naming the branch of a **new** pull
request; for an existing one the branch is the pull request's head, and the
instructions say so where they say "create the branch".

A pull request with no working tree at all (one an update bot opened, one a
session in another repository opened with the forge's command line, one whose
tree was deleted) is driven from the clone's primary checkout:
`/jig:drive-pr <PR>` there creates a working tree with the
[workspace tool](../tools/herdr/README.md)'s provider when one is configured
and with `git worktree add --detach` otherwise, under the roots
`gc.worktree_roots` names, attaches the pull request in it and arms the drive
there. The tree is the drive's, so [resource collection](resource-gc.md)
reaps it once the pull request merges or closes.

A pull request in **another repository** is named as `owner/repo#N` or by
its URL. The user layer of the configuration (`~/.jig/jig.yaml`) gains a
`clones` map from repository slug to local clone path; a session that names a
pull request outside its own repository arms the drive in that clone's
primary checkout as above, and, with no clone mapped, prints the exact
command for a person or another session to run, as `do-item` prints an arm
command it cannot spawn.

### Liveness is progress, and takeover is sanctioned

A driver's claim carries a **progress stamp** beside its heartbeat: the time
of the last state-mutating command, the last line of pass output and the
last head change. `drives.ts --doctor` reports a driver whose heartbeat is
fresh but whose progress stamp is older than `drive.progress_stale_minutes`
(default 30) as `STUCK`, with the stamp's age and the pass's last output
line, instead of `HEALTHY`. A pass that legitimately runs long keeps its
stamp fresh by producing output, which the test suites and the foreground
wait both do.

Taking a drive over becomes one sanctioned command instead of a lease
clearance a reader is warned against:

```bash
bun "<skill-dir>/scripts/drive.ts" <PR> --take-over -- claude -p "/jig:drive-pr --bots-only <PR>"
```

It is admitted only when the holder is in one of the states a successor may
replace, each checked at that moment: dead (its process gone), `STUCK` by the
progress rule, `QUOTA_PARKED` while the caller's account differs from the
holder's (the claim already records the account), `HITL_PARKED` with every
parked decision answered, or ended by a pass deadline. Against a holder
making progress it refuses exactly as exit `11` does today. When admitted it
stops the holder with the identity check `drives.ts --stop` performs, writes
a **takeover record** to the drive state and to the ledger on the pull
request (from which actor and account, to which, the holder's state and the
reason), and resumes from the durable state at the same round.

The exit-`11` refusal says which of these states the holder is in and, when
takeover is admitted, prints the command. The skill's rule changes from "do
nothing; do not kill the other driver" to "do not stop a driver that is
making progress; take over one that is not, with `--take-over`". A session
that meets a stuck driver therefore has one thing to do, and it is the same
thing whether the session is the person's, a pickup's or a scheduled sweep's.

### The ledger on the pull request

The drive state's resumable subset is mirrored into one hidden-marker comment
on the pull request, the **drive ledger** (`<!-- drive-pr-ledger -->`),
rewritten by the same code path that regenerates the handoff file: the round,
the phase, the last counted and verified heads, the Ready mark, every parked
item with its framed decision, every held item with its outcome and pushed
commit, the takeover records, the decisions taken unattended
([below](#every-autonomous-decision-is-recorded)), and the driver's actor and
account with the time of its last progress. The agent-authored narrative of
the handoff file travels with it, kept to its budget.

A drive that starts in a clone with **no state** for the pull request seeds
its state from the ledger when the ledger's state version is one it reads,
and refuses with the version named when it is not. A drive that finds the
ledger's driver fresher than `drive.progress_stale_minutes` and not itself
refuses as the per-tree admission does today (exit `13`), unless
`--take-over` is admitted by the states above; the ledger is how two clones
see each other, since the per-clone locks cannot. The locks stay per clone:
the ledger seeds and arbitrates, it does not lock, and a lost race between
two clones is caught where it is caught today, by the held-batch claims and
the reply markers on the threads.

The quota rule changes with it. "Do not dispatch a successor" stays for a
successor on the **same** account; a `QUOTA_PARKED` exit now prints the
takeover command and names the account the wall belongs to, so a session on
another subscription, on this machine or another, takes over at once.

### Autonomy is a policy

A new configuration section, `autonomy`, says how far an agent may go
without asking. It is read through the shared reader like every other
section, at every decision point rather than once, so a window that opens
mid-drive applies to the next decision. The user layer may set it (a person's
machine may be more autonomous than the team's default) and the environment
layer may override it for one run.

```yaml
autonomy:
  level: unattended          # attended | unattended | wide
  off_hours:
    level: wide              # the level during the windows below; unset: off_hours is off
    schedule:                # default once off_hours is on, in the machine's local time
      - "Mon-Fri 20:00-07:00"
      - "Sat-Sun"
```

The effective level is the greatest of: the section's `level`, the off-hours
level when the clock is inside a window, and the environment override. A
session with a person in it (an interactive run, not a driver pass) reads
`attended` unless the person set otherwise. The pass prints the level and
its source at the start of every round; the round report and the ledger say
which level each decision was taken under.

What each level permits, per decision class. A row the HITL registry owns is
not on this table and no level changes it: the merge, a release, a
destructive operation, a human-authored thread, a scope expansion past the
size budget, a change to the rules agents follow.

| Decision | `attended` | `unattended` | `wide` |
|---|---|---|---|
| File a tracker issue a skill needs (a deferral, a follow-up, a reflection escalation) | Confirm first | File it; the body says which skill filed it, from which pull request, and why | Same |
| Defer a finding where no adapter can file | Park | Record it in the pull request's deferral section ([below](#deferral-without-a-tracker)) | Same |
| A technical choice `decide` rules reversible inside one pull request | Decide and record | Same | Same |
| A technical choice `decide` would escalate for being underdetermined | Escalate | Gather the missing evidence within the round's budget, then rule | Same |
| A technical choice `decide` would escalate as "anything else", with no sensitivity flag and no registry class | Escalate | Escalate | Decide, marked provisional |
| A bot-review thread the arbiter rules `escalate`, with no registry class | Park | Park | Reply with a provisional outcome and the rationale, resolve, list it in the morning report |
| Take over a dead or stuck driver | Report and stop | Take over | Same |
| Re-arm after `HITL_PARKED` | Never | Never | Once every parked item is answered or provisionally decided |
| Pick the next work item | Registry: a person | Same | Same |

**Provisional** is a new outcome token beside the triage vocabulary. A
provisional decision is one a level above `unattended` took because nobody
was there to ask; it is marked as such in the thread reply and the ledger,
it is listed first in the morning report, and the person who reads it can
reverse it by unresolving the thread or commenting on the decision record,
which the next round reads as a human verdict. It is admissible because the
merge is still a person's: a provisional decision changes a draft the person
will read, never what is released.

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

- `--class`: the HITL registry class that stops the agent (`merge`,
  `release`, `destructive`, `human-thread`, `scope`, `rules`, `legal`,
  `copy`, `dark-dial`, `ready`). A park with no registry class is refused
  with "decide and record it", at every level: the registry is the whole
  list of what a person must decide, and a decision outside it is the
  agent's to take;
- a **decision record** on stdin: the question in one sentence; each option
  with what it changes and what it costs; the recommended option and why;
  the registry class that keeps the agent from taking it; the operational
  steps a person must perform, if any, each as a command or a named action;
  and what the agent already did about it, so partial progress is visible.
  The [writing rules for text that asks a human to decide](../plugin/skills/decide/references/human-call-elaboration.md#writing-rules-for-text-that-asks-a-human-to-decide)
  apply.

The drive keeps working around a park: everything the parked item does not
block is driven to its end before the drive stops, so `HITL_PARKED` means
"only these remain", never "stopped at the first question". The exit prints
each parked decision in full, the handoff file and the ledger carry them,
and `drives.ts --doctor`'s `NEEDS_HUMAN` row names the questions instead of
the count.

### A tool's refusal is not a human decision

A guard in the tooling protects one fact: the push a reply promised is the
one that landed, the comment after a reply does not change the outcome, the
tree is the one the plan was made for. When the agent has established that
fact, the guard's refusal is not a question for a person; it is the guard
asking for the evidence. Each guard that can refuse a verified state gains
the override that names the evidence, recorded with the action:
`resolve-held-thread.ts --after-reply <comment-id>:acknowledgement` says the
comment that landed after the held reply is a review bot's acknowledgement
that asks for nothing, and the guard checks that claim against the comment
(its author is in `review.bots`, its body carries no finding and no
question) before resolving; `finish-round.ts` takes the same form for the
push it verifies.

The common case needs no override at all. A review bot answers an accepted
reply on its own thread with an acknowledgement that asks for nothing ("the
thread stays open until the pushed change is verified", or a thanks), on
every accepted thread, every round. To the resolve guard such a comment is
**transparent**: a comment whose author is in `review.bots`, on a thread
that bot opened, that carries no new finding and no question, does not
count as a newer comment, and the held item resolves on the verified push
as if the acknowledgement were not there. The guard classifies it by what
the comment lacks, not by its wording, so a bot's acknowledgement that does
embed a finding or a question stays a newer comment and is triaged as one.
The override is for the comment the guard cannot classify.

A refusal with no override, or one whose evidence the agent cannot
establish, is a [reflection](../plugin/skills/reflect/README.md) finding
about the guard, filed in the same round, and the item is parked under the
registry class the guard protects (`human-thread` for a person's comment,
`rules` for a rule the agent may not waive), with the framed decision
saying what was verified and what the guard still refuses. A park with
"the guard is the drive's rule, not mine to waive" as its whole reason is
refused: the rule names its class, and the class names its override.

### Deferral without a tracker

A deferral whose adapter cannot file (the batch step is bound to one tracker
until [plan item 10](plan.md#10-values-the-skills-still-assume) moves it onto
the interface) is recorded in a `## Deferred` section of the pull request
body under a hidden marker, with the finding quoted, the reason and the
thread link, and the thread is resolved with the `**deferred**` token
linking the section. The post-merge follow-up step files the section's
entries where the tracker allows and replaces each with its link. A deferral
is therefore never a park.

### The morning report

`drives.ts --report [--since <time>]` says, for every drive this clone or
this ledger's pull requests touched since the time (default: the last
report): its terminal state and what it means for the person; the
provisional decisions, first; the takeovers; the parked decisions in their
framed form; the issues filed. It is the one thing a person reads after an
unattended night, and it reads from the ledgers, so it covers drives run
from other machines on the same account. `/jig:followup`'s pre-merge list
includes the pull request's provisional decisions.

## Build order

Each pull request is shippable alone and carries its change note; the drive
suite's consistency checks run on each.

1. **Drive from any checkout.** `attach-pr.ts`, detached-head rounds,
   `drivenBranch` in the state, the pickup and drive instructions that stop
   creating a branch for an existing pull request, the tree created for a
   pull request with none, and the `clones` map for another repository's
   pull request.
2. **Progress-based liveness and takeover.** The progress stamp, the `STUCK`
   verdict, `--take-over` with its admission states and takeover record, the
   exit-`11` message and the skill rule that replaces "do not kill".
3. **The ledger on the pull request.** The mirrored subset, seeding a new
   clone from it, the cross-clone refusal, and the quota rule that admits a
   successor on another account.
4. **The autonomy section and the framed park.** `autonomy.level`, the
   shared resolver and its source line, the `unattended` column: issues filed
   without confirmation, deferral without a tracker, `decide`'s
   underdetermined row gathering evidence, `park --class` with the decision
   record on stdin, the drive working around a park, and the HITL registry
   row that says a park is reserved for its classes, and the guard overrides
   that take evidence. Its ADR, numbered next,
   records that parking is reserved for the registry's classes and that
   every autonomous decision is recorded where a person can reverse it.
5. **Off-hours and the morning report.** The schedule, the `wide` column
   with the provisional outcome, re-arming after a park once every item is
   provisionally decided, the ledger's decisions section and
   `drives.ts --report`.

## Left out

- **The merge, the release and the next item** stay a person's. A dark
  factory with no person at the merge is a different doctrine
  ([plan item 9](plan.md#9-delegated-merge-pull_requestsmerge-auto-on-converged)
  has the conditions); this design makes the night productive up to that
  decision, not past it.
- **A lock shared across clones.** The forge has no primitive for one, and
  the held-batch claims and reply markers already make a lost race between
  two drivers harmless at the thread level. The ledger arbitrates; it does
  not lock.
- **Reading a session's context usage.** The handoff dial stays
  agent-judged; nothing here measures it.
- **Pacing against a usage window in advance.** The wall is detected after
  the fact, as today; what changes is who may pick the drive up afterwards.
