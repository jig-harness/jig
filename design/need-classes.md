# The classes of need, and where each is settled: design

**What problem this solves.** The [dispatcher](../GLOSSARY.md) hands a
person every wait it cannot settle itself: a drive stopped for them, a
pickup that stalled, a follow-up that failed, a host fault. Each arrives on
the dispatch dashboard's What needs you as one **need**. Most of them are
not decisions. Measured on a dispatch host over ten days in November 2026,
about 300 pull requests and items needed a person, and parks on a decision
class the [human-in-the-loop registry](../GLOSSARY.md) reserves for a person
were 22 of them. The rest came from defects and from mechanics the line
lacks: a flaky check that spent both CI-repair passes, a check that fails by
design while a CI hold is on, a stage that ended without recording a
result, work that landed in a pull request its item was not linked to, one
host fault raised once per repository or per pull request. A person spends
the time the decisions do not need, and the decisions wait behind the
rest. With this built, every kind of need has a class, and every class a
place where it is settled: most are stopped at their source, the tick
settles the mechanical remainder, the steward settles what needs reading,
and what reaches a person is framed and answered in a word, or, where only
a person can act, raised once per cause.

This is the design of [plan.md](plan.md) item 50. It builds on what is
there: the dispatcher's re-drives and recovery budget
([dark-factory-dispatch.md](dark-factory-dispatch.md)), every need framed
as a decision the tick carries out on a person's answer
([structured-answers.md § Every need framed](structured-answers.md#every-need-framed)),
the answer sent from the dashboard (item 46), and the
[steward](../plugin/skills/steward/README.md).
[ADR-0017](../docs/adr/ADR-0017-the-steward-proposes-within-a-remit-the-host-widens.md)
records the steward's widened remit.

## The rule

Every need belongs to one [need class](../GLOSSARY.md), and every class is
settled at the first of these places that applies:

1. **At its source.** A mechanism stops the class, so the need is never
   raised. A defect is fixed; a mechanic the line lacks is added.
2. **By the tick.** What remains is settled by the tick's own rule, from
   facts it reads itself, the way a re-drive is: idempotent work, once per
   change, within the recovery budget.
3. **By the steward.** What needs reading (a pull request's diff, a log, a
   check's history) is settled by a steward record the next tick checks
   against its own reads and applies, within the host's
   [steward remit](../GLOSSARY.md).
4. **By a person's answer.** What is a person's to choose arrives as a
   framed decision with options the tick carries out on one word
   ([structured-answers.md](structured-answers.md#the-tick-frames-what-it-detects)).
5. **By a person alone.** What only a person can do (fix a credential,
   approve an environment, clear a stuck deployment) is raised once per
   cause, saying exactly what to do.

A class may be settled in several places: its bulk at the source, the
remainder framed. A registry class stays a person's whatever the evidence
([ADR-0010](../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md)).
A [recurring class](../GLOSSARY.md) in the outcome log that matches no row
below is a gap, and its weekly reflection finding proposes a row.

## How it works

### The classes

| Class | Shows on the line as | Settled |
| --- | --- | --- |
| CI repair spent, or a CI verdict misread | a drive handed to a person (exit `21`, or `1`), a park on a cancelled run | at the source; by the steward; by an answer |
| A stage ended without a result | a failed follow-up, a pickup's question, a stage that died | at the source; by the tick |
| A stalled pickup | `stalled` | at the source; by the tick; by the steward; by an answer |
| A release blocked | a failed follow-up on every merge after the release | at the source; by an answer under `release`; a stuck deployment by a person alone |
| A registry park | a parked drive (exit `8`) | by an answer |
| A stall re-drive spent | a drive handed to a person (exit `14`) | at the source; by an answer |
| A pickup that could not claim its item | a pickup's question | at the source; by an answer |
| A conflict re-drive spent | a drive handed to a person (exit `9`) | at the source; by the steward; by an answer |
| Someone else's work read as a stalled pickup | `stalled` on items no launch claimed | at the source |
| A pass deadline, or edits a pass left unshipped | a drive handed to a person (exit `15` or `12`) | at the source; by the tick |
| The dispatcher's own turn failing | `ticks-failing`, `repository-failing` | at the source; the repair by a person alone, once per cause |
| A checkout an unlisted tree holds | a launch refused for a busy holder | at the source; by the tick where the host opts in; by an answer |
| A step a person owes after a merge | a failed follow-up asking about a step | at the source; by an answer for the rest |
| A follow-up that cannot reach the tracker | a failed follow-up on every merge of one repository | at the source; the credential by a person alone, once per account |
| A pickup's scope or batch question | a pickup's question | by an answer |
| A label write failing | `action-failing` on many pull requests at once | at the source |
| A branch to keep or delete | a failed follow-up | at the source (built) |
| A drive stopped with no exit | `stopped-unknown` | at the source (built) |
| Launches that raise no need | the outcome log only | at the source |

Each class's mechanism follows, in the order above. An issue number names
the step that builds it ([Build order](#build-order)).

#### CI repair spent, or a CI verdict misread

A drive's review converged and CI on its head still fails, or the drive
misread CI: a cancelled run read as failed, a CI-hold release read failed,
a check that fails by design while the hold is on read as a real failure.
Most of these have a mechanical answer, so no repair pass is spent on them.

- The drive re-runs a failed check once before it spends a CI-repair pass
  (`ci.rerun_failed_once`, #464). A failure on the infrastructure keeps its
  own re-runs and exit `23`; this re-run is for a failure in the code's own
  checks, such as a flaky test. The drive also keeps a cancelled aggregator
  from spending the budget (#713) and retries the CI-hold release read
  (#715), and the documented workflow keeps label events out of the
  cancelling concurrency group (#716).
- A [held-head check](../GLOSSARY.md) reads as held while `ci.hold_label`
  is on, never as failing, so no repair pass is spent on it. The drive
  recognises one by M13's shape; `ci.hold_sentinels` names the ones that do
  not follow it (#941).
- An [advisory check](../GLOSSARY.md), named in `ci.advisory_checks`, is
  one a repair pass cannot satisfy by itself, such as a scanner's quality
  gate. When every failing check on the converged head is advisory, the
  drive spends no repair pass and parks once (exit `8`) under the
  `reviewer-posture` class: **Fix the finding** (one repair pass aimed at
  it), **Waive it** (a person's decision recorded on the pull request),
  **Leave it to me**. Where the repository's `autonomy.park_classes` leaves
  `reviewer-posture` out, the key has no effect and the configuration check
  says so (#941).
- The number of repair passes is the repository's `drive.ci_repair_rounds`
  (#942).
- The steward may ask for one more re-drive when the failing job is a flake,
  and for a failed run's jobs to be re-run
  ([The steward's remit](#the-stewards-remit)).
- What remains is framed: **Re-run the failed jobs and re-arm**, **One more
  repair pass**, **Leave it to me**.

#### A stage ended without a result

A follow-up, pickup or steward pass ended and recorded no result: its
session died, or its result write failed on the host. The work is
idempotent and the fault is the host's, so no person is asked whether it
finished.

- The state database refuses a schema that disagrees with its version, and
  the host's health check, `jig doctor dispatch`, fails while ticks fail
  (#884). Every stage and every vendor writes a startup wall (#822, #590).
- A follow-up's single run again, which today covers a pass that died,
  also covers a pass whose result write failed, and waits until the host's
  health check passes. It stays one run again per follow-up, counted
  against the pull request's recovery budget; `failures.rerun_died: 0`
  turns it off (#944).
- A pickup that died or recorded no result is not started afresh, which
  could be a second implementer: it takes the stalled pickup's
  push-and-record relaunch, once, in its own tree (#950).
- A question a pass asks about the dispatcher's own database or host goes
  to the host need of its cause, never to a person as a pickup's or a
  follow-up's question (#944).
- These re-runs are the tick's rule, in `routine-reruns.ts`, never a
  steward record: the tick decides them from its own records.

#### A stalled pickup

An item is in progress with no running session. The dispatcher does not
start a claimed item afresh, since a second session would be a second
implementer. Most stalls are not abandoned work: the work landed in a pull
request the item was not linked to, finished work sits in a local tree
with nothing pushed, or the item was an epic.

- `do-item` pushes its branch and records its result before it exits.
- The tick moves an item to its `pr_open` state when an open pull request
  whose head branch is the one this host's launch record for the item names
  also names the item's key, as `do-item` links it (#949). Only the
  host that owns the repository writes, the item never moves to done, and
  the tick comments on the item from a fixed text naming the pull request.
  Where the repository names no `pr_open` state, nothing moves and the need
  is framed with the pull request named.
- The tick finds unpushed commits or uncommitted edits in a stalled
  pickup's tree and relaunches that pickup once, in that tree and never a
  fresh one, with a fixed prompt to push and record, as an unshipped-edits
  re-drive is (`dispatch.stalled_relaunch: finish-once`, #950).
- Pickup planning never takes an epic itself: an epic is worked through its
  children (#951).
- The steward settles what needs reading with a `settle` record: link the
  item to a pull request no launch opened, or release a stale claim
  ([The steward's remit](#the-stewards-remit)).
- What remains is framed: **Release the claim**, **Leave it to me**.

#### A release blocked

A merged pull request's follow-up cannot finish while a release is
untagged: its gates failed (usually on a flake), a required check was
never reported, or the website's deployment is stuck. Every later merge's
follow-up then asks the same question.

- The release step re-runs a releasing commit's failed gates once before it
  gives up on the tag (`changelog.release.rerun_failed_gates`), and the tag
  plan keeps reporting every untagged release, not only those newer than
  the newest tag (#958). A required check a finished run never
  reported does not hold every later tag (#722).
- A follow-up that finds its release untagged records "release owed" as a
  step a person owes (the `person-owed` routine class) and finishes, and the
  line keeps one need per release, not one per merge (#957).
- That need is framed under `release`, act Authorize: **Re-run the failed
  gates**, **Investigate**, **Tag it by hand**.
- Tagging a release by hand where a re-run cannot (#894, #721), an
  environment approval and a stuck deployment (#711) stay a person's alone.

#### A registry park

A drive parked on a class the registry reserves for a person. These are
the decisions the line exists to hand over, so they are made cheap to
answer: framed with a recommendation and answered in a word from the
dashboard (#693). The acceptance report (`jig dispatch log --acceptance`)
shows how often a class follows its recommendation, and a repository may
retire a class from `autonomy.park_classes` on that evidence. The steward
never answers a registry park.

#### A stall re-drive spent

A drive stopped `14` again at the head the tick already re-drove.

- A pass that stands down without acting records why, so the stop carries
  its reason (#960), and a recurring stall finding names the
  stalls it counted (#607).
- The re-drives per head are the repository's `dispatch.redrive.stalled`
  (#959).
- The steward takes no part: one more stall re-drive needs a guard of its
  own, read from the pass output its digest will carry, and is left out
  until that exists.
- What remains is framed: **Re-arm once more**, **Take it over by hand**,
  **Leave it to me**.

#### A pickup that could not claim its item

A pickup stopped because it could not claim: the assignment came through an
epic, the tracker's rate limit was spent, the claim query failed, or the
item was on the wrong checkout for its repository label.

- The work already under way stops most of it: a shared tracker request
  budget (#771) and one repository per tracker namespace for an unlabelled
  item (#774).
- An item a person held with `jig:hold` and then released is wanted again:
  its stale pickup record no longer holds it (#952).
- What remains is framed: **Assign it directly**, **Skip it**.

#### A conflict re-drive spent

A drive stopped `9` again at the same head and base head.

- The conflict-resolve round recognises a stacked base that was
  squash-merged, and merges with the earlier base's tip as the merge base
  (#961).
- The re-drives per pair of head and base head are the repository's
  `dispatch.redrive.conflict` (#959).
- The steward may propose `rearm` once the base has moved, within its
  default remit.
- What remains is framed as a stall re-drive's is.

#### Someone else's work read as a stalled pickup

The stall watch read in-progress items assigned to a watched identity as
dispatched pickups. A served person's items count only when a pickup of
this host claimed them. `dispatch.stalled_scope: claimed` extends that to
the factory identity: an item stalls only when a launch record of this host
or a `do-item` claim marker took it; `assigned` keeps the wider watch, for
a repository whose factory identity nobody else uses (#948).

#### A pass deadline, or edits a pass left unshipped

A pass reached its deadline with its restarts spent (exit `15`), or ended
with edits it never shipped (exit `12`), most often because it ran a long
step in the background and ended its turn. The pass prompt requires the
gates in the foreground; the drive finds a background task still pending
when a pass ends and restarts the pass rather than stopping
(#962). The tick's re-drive in the same tree settles the rest
(#560 for exit `12`, with `jig send`'s re-arm verb).

#### The dispatcher's own turn failing

A host or configuration fault (an unreadable catalog, a configuration
error, the session runtime failing for every repository at once, a state
database out of step) is counted per scope, so one fault is raised for
every repository and tick scope it touches.

- The failure ledger names each failing row's cause, and the line shows one
  host need per cause, naming every scope it touches (`failures.group:
  cause`, #943). A cause is the class of the row's reason, from a
  closed list: the session runtime, the state database, the configuration,
  the tracker, the forge, other.
- `jig doctor dispatch` fails while ticks fail (#884), and a wake-up's
  failing row clears once sweeps of that repository succeed (#932).
- A repository's CI checks what the tick reads from it, with the tick's own
  readers, so a configuration error never reaches the host
  (#947).
- The repair itself is a person's.

#### A checkout an unlisted tree holds

A launch is refused because a worktree the session runtime does not list
holds the branch: another tool's worktree, an agent tool's worktree, or a
tree that leaked test processes keep in use. Some hold commits on no remote
branch.

- `jig gc` collects agent tools' and other managers' worktrees within its
  proven bounds (#343, #585), and test runs reap their orphan processes
  (#880).
- With `detach_idle_holders` on, the tick detaches a holder no process uses
  and whose every commit is on the remote. With `rescue_unpushed` on as
  well, a holder with unpushed commits first has them kept on a
  [rescue branch](../GLOSSARY.md), a local branch the tick never pushes and
  `jig gc` never collects, and is then detached rather than asked about
  (#964). Off, the need stays framed: **Detach the checkout**,
  **Leave it to me**.
- The busy-holder notice has a cause of its own (#629).

#### A step a person owes after a merge

A follow-up asked about a step only a person can take: which consumer
repositories get a migration item, a live check, an approval, whether to
file or close an item. A follow-up records such a step as `[person-owed]`,
files it and finishes. The routine classes a follow-up may settle
unattended are the repository's `dispatch.followup_routine`
(#965); a repository whose filing goes to a shared tracker can
turn `drafted-items` off. A list of consumer repositories in configuration
makes the migration question answerable without a person (#566).

#### A follow-up that cannot reach the tracker

A headless pass on one account cannot reach the tracker (an operating
system keychain approval, a lapsed connection), and every follow-up of that
repository fails on it. Before it launches a stage that touches the
tracker, the tick probes each admitted account's tracker credential
headless (`preflight: [tracker]`). On a failure it holds those stages back
for that repository and account, and raises one host need, act Authorize,
naming the account and the probe's answer (#945). Fixing the
credential stays the person's.

#### A pickup's scope or batch question

A pickup asked what belongs in a batch, whether to widen its scope, or in
what order to take dependent items. These are a person's, and the pickup's
pass frames them with its result
([structured-answers.md § Sessions frame their questions](structured-answers.md#sessions-frame-their-questions)).

#### A label write failing

A new state label shipped before the repository had it, and every label
write in that repository failed. The tick creates a missing dispatch label
the way `jig dispatch labels` does, and reports one repository need when it
cannot, never one per pull request (#946).

#### Settled at the source already, and cost without a need

- **A branch to keep or delete.** The follow-up keeps and lists a local
  leftover (`local-leftover`) and finishes.
- **A drive stopped with no exit.** The tick re-arms it within the recovery
  budget; #543 holds the wording of a person's stop.
- **Launches that raise no need.** Exit `4` re-arms of a drive that is not
  judgeable yet (#524), and a takeover the drive refuses as a usage error
  (exit `2`), launched again at the same facts within minutes: a re-arm or
  takeover that ends `2` is not launched again at the same facts
  (#963).

### Grouping by cause

One cause fans out: a release's failed gates reach every later merge's
follow-up, one session-runtime failure reaches every repository, one
missing label reaches every pull request, one credential reaches every
follow-up of a repository. Wherever a class's cause is a fact of the host,
the release or the repository rather than of one target, the line keeps
one need per cause, naming the targets it holds, and the targets carry no
need of their own for that cause; a target with another cause keeps that
need. A cause is settled once, and its targets leave the line with it.

### The steward's remit

The steward reads a digest and proposes records; the next tick checks and
applies them under its own guards
([ADR-0017](../docs/adr/ADR-0017-the-steward-proposes-within-a-remit-the-host-widens.md)).
Its default remit stays `rearm`, `resume`, `need`, `facet` and `order`. A
host may widen it with three record kinds. Each guard is read by the tick
from the forge, the tracker and its own records, never from the steward's
digest or its words:

| Record | For | The tick applies it only when |
| --- | --- | --- |
| `settle` with `link` (the item, pull request `#N`) | a stalled pickup whose work is in a pull request no launch opened | the pull request is open, in the same repository, opened by a login the repository trusts (a writer, or one of `dispatch.adopt.authors`), and links the item in the repository's `pull_requests.issue_link` form; the tick moves the item to `pr_open`. A merged pull request is not settled this way: its need is framed with the link named, and an item is never moved to done |
| `settle` with `release` (the item) | a stale claim | a launch record or claim marker of this host made the claim, no session holds the work, no open pull request carries the item and its tree holds no unpushed commit; the tick moves the item back to the state a pickup starts from |
| `redrive` (the pull request, class `flake`) | a spent CI re-drive (exit `21`) | the forge shows the failing job passed on the base, or on another run of the same head; one per head, at most three a week per repository, on top of `dispatch.redrive.ci` and within the recovery budget. Reaching the weekly cap records a reflection finding proposing a rule |
| `rerun-checks` (the run) | a failed run on a converged head or a releasing commit | the run's commit is the pull request's head or the releasing commit, and `shared/ci-infra.ts` or the job's history on the forge classifies the failure as passing; once per run |

For each record it applies, the tick comments on the item or the pull
request from a fixed text: the record kind, the facts it checked and how to
reverse it. The steward's reason stays in the owner host's state database
and is never posted, since it is text a pass wrote after reading untrusted
input.

A re-run of a stage that ended without a result is not a steward record:
the tick owns it ([A stage ended without a result](#a-stage-ended-without-a-result)).

**What comes first.** The widened kinds ship only once the steward reliably
finishes and can see what it judges:

1. The steward's digest carries, for each target, the tree's git state
   (branch, unpushed commits, uncommitted edits), the last pass's output,
   the pull requests that name the item, and the failing job's history on
   the head and the base; and fewer than one steward pass in twenty ends
   without submitting, over a week on the owner host (#953). The
   trigger runs on a backlog of unjudged items (#924), and an unapplied
   proposal is accounted for (#925).
2. Then `settle` (#954), `redrive` (#955) and
   `rerun-checks` (#956), in any order.

**Its boundaries stay.** It never launches work, merges, answers a registry
park, re-arms a drive a person stopped or held, writes a tracker item's
done state, changes configuration or sends free text. A record's fields
other than its reason are closed: targets, kinds and classes from fixed
lists, checked at submit. What an injected instruction can ask the tick to
do is what the tick would do anyway on the same facts.

### Configuration

| Key | Layer | Default | Why there |
| --- | --- | --- | --- |
| `ci.rerun_failed_once` | repository | `true` | How a flaky check is treated is the repository's CI posture (#464) |
| `ci.hold_sentinels` | repository | `[]` | A held-head check M13's shape does not recognise is named in the repository's own workflows |
| `ci.advisory_checks` | repository | `[]` | Which checks a repair pass cannot satisfy (scanners) is the repository's |
| `drive.ci_repair_rounds` | repository; the environment's `DRIVE_PR_CI_REPAIR_ROUNDS` still sets one run | `2` | The cost of a repair pass is the repository's CI cost |
| `dispatch.redrive.stalled`, `dispatch.redrive.conflict`, `dispatch.redrive.ci` | repository, capped by the host's `redrive_max` | `1` per head (per pair of head and base head for a conflict) | The behaviour is the repository's; the host pays for the passes |
| `redrive_max` | host | `1` | The most re-drives per head any repository on the host may ask for |
| `dispatch.stalled_scope` | repository | `claimed` | How a repository's tracker marks a claim is its own |
| `dispatch.stalled_relaunch` | repository | `finish-once` | Whether unpushed pickup work may be finished unattended (`never` turns it off) |
| `dispatch.followup_routine` | repository | `[local-leftover, person-owed, drafted-items]` | What a follow-up may file unattended in that repository's tracker |
| `changelog.release.rerun_failed_gates` | repository | `1` | Release policy is the repository's |
| `steward.remit` | host, capped by each repository's `autonomy.max_level` | `[rearm, resume, need, facet, order]` | The host opts in to `settle`, `redrive` and `rerun-checks`; in a repository whose `max_level` is `attended`, the tick turns such a record into a framed need |
| `failures.rerun_died` | host | `1` | A host fault is the host's to retry |
| `failures.group` | host | `cause` (`scope` keeps one need per scope) | One need per host fault |
| `preflight` | host | `[tracker]` | Credentials belong to an account on a machine |
| `detach_idle_holders`, `rescue_unpushed` | host | `false`, `false` | Worktree layouts and the other tools that make them are the machine's |

Host keys live in the machine's dispatch file, `~/.jig/dispatch.yaml`,
`steward.remit` under its `steward` section; repository keys in
`.config/jig.yaml`. The existing settings keep their layers:
`autonomy.park_classes` and `autonomy.level` in the repository,
`steward.enabled` and the stages in the machine's dispatch file, `serve` and
`serve_defaults` on the host.

### What changes in the dispatcher's rules

Two of the dispatcher's standing rules
([dark-factory-dispatch.md § What it never does](dark-factory-dispatch.md#what-it-never-does))
narrow once this is built:

- **It writes to the tracker of its own accord** in one more place: it
  moves an item to `pr_open` when an open pull request on the branch of
  this host's launch names it, and applies a steward `settle` record under
  its guard. It never writes an item's done state.
- **It relaunches a stalled pickup** once, in the same tree, only to push
  and record work the tree already holds, where the repository allows it.

And one rule of its launch records widens: a follow-up's run again also
covers a result write that failed, and waits for the host's health check.

## Build order

One pull request per issue; each is usable alone. The epic,
#940, holds them in this order:

1. **Stop spending CI-repair passes on what a pass cannot fix.** #464,
   #713, #715, #716, #941, #942.
2. **Make host faults the host's.** #884, #943, #944, #822,
   #590, #945, #946, #947.
3. **Settle pickups mechanically.** #948, #949,
   #950, #951, #952.
4. **The steward's digest and its no-result rate**, first:
   #953, with #924 and #925. Then #954, #955 and
   #956, each blocked by #953.
5. **One need per release.** #957, #958, #722.
6. **Re-drives: configuration and diagnosis.** #959,
   #960, #607, #961, #962, #560, #524,
   #963.
7. **Clear held checkouts.** #343, #585, #629, #964.
8. **The follow-up's routine classes as configuration.** #965.

Steps 1 to 3 are independent and may run side by side; step 4's first
issue may start at once, and its other three wait on it. #944 waits
on #884, whose health check it reads.

## Left out

- **The steward on more repositories.** It runs for the owner host's
  checkout of one repository; widening it waits on the tracker's request
  budget (#771) and the steward's own queue reads (#738).
- **A steward record that re-runs a stage, or re-drives a stall.** The tick
  owns the first; the second waits on a guard of its own.
- **The Ready re-gate loop**, a drive marking a pull request Ready and
  re-gating until a person marks it by hand. Too few occurrences to show a
  cause; it is filed once it recurs.
- **Retiring a registry class.** The acceptance report gives the evidence;
  a repository's maintainers decide, in its configuration.
- **A sweep of the needs raised before this.** Clearing that backlog is a
  person's one-off task, not a mechanism.

## Review

Critiqued on 2026-11-12 by a reviewer with fresh context (a subagent that
did not write it), against the draft of this design, its plan item and
ADR-0017 on top of commit `96567939`.
