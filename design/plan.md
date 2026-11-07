# The plan

Jig's open work in priority order, in the detail the people building it
need: what each item builds, what it waits on, and when it is done. The
public [roadmap](../ROADMAP.md) carries the same items under the same
numbers, a few sentences each, for teams that use Jig; an item only Jig's
maintainers need (an internal refactor, Jig's own tooling) is on this page
alone. `bun run gates` checks that every roadmap item is here, in the same
group and order. A session picking up Jig work starts here.

This page lists open work only. When an item is finished it leaves this page,
and the roadmap when it is listed there, in the same pull request: what changed is recorded in
[CHANGELOG.md](../CHANGELOG.md), and how things work now is documented where
they live (module READMEs, the [plugin](../plugin/README.md),
[CONFIGURATION.md](../plugin/CONFIGURATION.md)). Items too large to describe
here have a design in this folder ([README.md](README.md)).

## Now

Now is the line that runs with nobody watching: a team's pull requests
driven to merge-ready while a person keeps every decision that is theirs.
First what keeps an unattended pass from getting past a person, then what
keeps the line from stranding work, then one place to see and steer it,
then Orca, the dispatcher's first session runtime.

### 32. Driving any pull request from anywhere, with autonomy that fits the hour

Most of [the design](dark-factory-driving.md) is built, in
[`drive-pr`](../plugin/skills/drive-pr/README.md) and
[CONFIGURATION.md § `autonomy`](../plugin/CONFIGURATION.md#autonomy). What
it still holds is **the policy from the base branch**: `autonomy.max_level`
and `autonomy.park_classes` read from the pull request's base branch,
failing closed when it cannot be read. Today they come from the working
tree, so a pull request that edits them changes what its own drive may
decide.

`wide` and `off_hours` ship opt-in and documented as not yet validated, a
maintainer's recorded exception to the dark-by-default rule, revisited once
a working repository has run them for a month against the design's
validation measure.

Done when a drive reads its ceiling and park classes from the base branch.

### 40. The pass trust boundary as mechanisms

A drive pass runs with no person at its terminal, usually signed in as the
person who armed the drive and, on a host that opted in, with its
permission prompts off. Where a script checks what the pass does, the pass
cannot get past a person. Where only the pass's instructions say what it
must not do, nothing that runs stops it;
[the mechanism map](../plugin/MECHANISMS.md#where-the-boundary-rests-on-instructions)
lists those places. What it will build: each boundary the map lists as
held only by an instruction for an unattended pass gets a mechanism
instead (a hook, a permission rule or a separate credential), one pull
request per boundary, in this order:

- **Comments trusted by their author**: a park answer, a ledger entry, a
  takeover claim and a follow-up marker count only when they can be told
  apart from a comment a pass posted under the person's login, through a
  pass identity of its own, a token only the driver holds, or a mark on the
  pass's own comments that the readers refuse as an answer, where the mark
  is imposed and protected outside the pass's control (a pass holding the
  person's credential could otherwise post an unmarked comment) or the pass
  has a separate credential, decided in one place, `plugin/shared/trusted-authors.ts`. A pass then cannot answer its
  own park or write the drive ledger.
- **The push and the merge**: inside a drive pass, a push that does not go
  through `plugin/skills/drive-pr/scripts/guarded-push.ts` and every merge
  command are refused by something that runs (a plugin hook, a deny rule
  the drive installs for its pass, or a pre-push check that sees every
  push), and the refusal reaches the pass. A raw `git push` then no longer
  escapes a person's `hold-push`, and a person's own session is not
  affected.
- **A loosened ratchet**: a `Ratchet-Loosen` trailer counts only with
  evidence a person gave it, such as a commit the person signed or an
  approval recorded on the pull request, and the ratchet says which
  evidence it read.
- **The machine's state**: the dispatch and drive records under
  `~/.local/state/jig/` that a script decides from are verified when read,
  or a direct edit is otherwise detected, and the reader's report names the
  refusal. Which records need it, and whether detection is enough, is part
  of the work.
- **Resolving a thread**:
  `plugin/skills/resolve-review-comments/scripts/resolve-thread.ts` refuses,
  with a named exit, a thread that carries no reply from the resolving
  login posted after its last reviewer comment. This binds only a pass that
  uses the script: a pass holding the person's login can send the
  `resolveReviewThread` mutation directly. The work either enforces the
  check where the credential is used or records that bypass as an accepted
  risk, and the script's check is not called mechanical enforcement until
  it does.
- **The installed copy**: before a scheduled job runs, the launcher
  (`plugin/runtime/launcher.ts`) confirms that the plugin copy matches a
  released version, for example by a digest the release records, and
  refuses with a named reason in the job's receipt otherwise.
- **The site's sync record**: in Jig, the gates fail a change to
  `website/content-sync.yaml` that `scripts/website-sync.ts --advance` did
  not make.

How each boundary is held is part of its work. A boundary no mechanism can
hold stays, and the map records it as an accepted risk. A person's command
sent from their own session (`jig send`, through the operator) is outside
this item: no pass runs there. It waits on nothing, and delegated merge
(item 9) waits on it.

Done when each boundary `plugin/MECHANISMS.md` lists as instruction-only
for an unattended pass is enforced by a mechanism or recorded there as an
accepted risk, and the map says which: a park answer a pass posts under the
person's login is not taken as the person's, and a raw `git push` or a
merge command from a pass is refused.

### 33. The dispatcher: a tick that starts the execution line's stages

Every stage of the execution line starts only when a person types it: an
assigned item waits for someone to open a `do-item` session, a drive
stopped by a usage limit or an answered park waits for someone to re-arm
it, a converged pull request that its base later conflicts waits for
someone to notice, a merge waits for someone to run its follow-up. Nothing watches the
tracker or the pull requests for the next thing to start, so with nobody at
the keyboard the line stops at the first stage boundary.
[design/dark-factory-dispatch.md](dark-factory-dispatch.md) has how it
works: `jig dispatch` in `plugin/dispatch/`, a tick on a timer
`jig dispatch install` writes, which keeps what it did in one SQLite
database and nothing in memory between runs, reads the items assigned to the repository's
factory identity in a dispatch state (through a new tracker-interface read,
`assignedIssues(identity, states)`, and `assignedBy(key)` for who made the assignment, beside the unchanged pool query), the drive ledger on each
pull request and the session runtime's list of running sessions; it
reports every stage it would start with its evidence, and with `--apply`
starts each one through a session runtime interface whose first
implementation is Orca
([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)),
within a cap per account, round-robin among the accounts without a usage
wall, binding a headless pass to its account through the Orca profile's
configuration directory. Each launch leaves a launch record that brings the
stage's answer back to the next tick, and a merged pull request's
follow-up is guarded by a marker comment on it. A stop only a person can
settle (a park, a drive stopped on a failure, a stalled pickup) is notified
once. It never merges, answers a park, re-arms a drive a person stopped,
takes over a driver another machine started or passes a flag reserved for
a person, and writes a receipt per tick. Machine values in `~/.jig/dispatch.yaml`, a repository's
in a `dispatch` section of `.config/jig.yaml`. Built in the design's order:
the report, then re-arms within account caps with the timer, then pickups,
then follow-ups and notifications, then control: a permanent outcome
log, one row per ended launch with an outcome class from a
closed list, a dashboard that filters it (`jig dispatch dashboard`, no
report files, which grows into item 42's hub and keeps its command),
drift from each stage's expectation reported and notified
but never acted on, each recurring class recorded once a week as a
reflection finding about the dispatcher, and one
mechanical nudge (`steer`, "continue" after a usage limit resets) with no
open-ended prompt, then the re-drive of a converged pull request the
forge reports conflicting or whose head moved after the drive verified
it, then Codex accounts admitted beside Claude Code's, the account's
vendor choosing the agent a session runs in, then the pull requests that
touch a change area the catalog marks `serialize: true` driven one at a
time, the one closest to merge first and the rest held, with the conflict
history report proposing which areas to mark; the re-arm step waits on the drive
running in a session of its own, and the pickups' launches on an Orca
session that can be bound to a chosen account (until then the pickups are
reported, not started). A park's notification carries the park's framed
decision.

What is open is checking it on a live host. Done when, on a host running
Orca, an item assigned to the factory
identity gets one workspace and one `do-item` session within one interval,
a drive stopped on one account's usage limit is re-armed on another account
by the next tick, a merged pull request gets one follow-up session, a park
reaches a person's phone and its answer on the pull request re-arms the
drive, every launch, refusal and notification is in the tick's
receipts, every ended launch has a row with its outcome class in the
outcome log, `jig dispatch dashboard` filtered to yesterday shows only
yesterday's rows, a drive whose open threads rise across rounds is
reported as drifting and notified once, a session waiting after its
account's wall reopened gets exactly one "continue" nudge, a converged pull
request that now conflicts with its base or whose head moved past the one
the drive verified is re-armed once, one still at the verified head and
mergeable is left alone, and one whose mergeability the forge is still
computing is reported unplaced with no launch, a drive stopped on a Claude
account's wall is re-armed on a Codex account with `CODEX_HOME` bound and
the Claude variables absent, on a host that set `drive.codex_bypass`, and an
account of a vendor with no documented
pass command is reported and never launched, a Codex pass that outruns a
positive `DRIVE_PR_PASS_TIMEOUT` is terminated, and a Codex account is
reported and never launched while that deadline is `0` or on a host without
that setting, and on a
consumer repository three pull requests that touch one serialized area
over a night are re-driven one at a time, the held ones carrying the
`held` label until each leads.

### 36. The dispatch board: what is driven and what is ready to merge

The merge is the one stage of the execution line that stays a person's, and
it sets the pace of the rest: each merge lets the dispatcher re-drive the
pull requests that now conflict and start the next one in a serialized
area. Yet the dispatch dashboard shows no merge queue: a converged,
mergeable pull request is a class the tick reports and leaves alone, a
drive a person or another machine runs is not on the page either, and
nothing tells work that settles by itself from work that waits on a
person. [design/dispatch-board.md](dispatch-board.md) has how it works:
one predicate, `plugin/skills/drive-pr/scripts/lib/merge-ready.ts`, which
the tick, `announce-merge-ready.ts` and `jig ask` all call, places a converged pull
request in a lane of Ready to merge (merge now, with a merge command pinned
to the verified head and built only from values of a strict form; approve
first, naming requested reviewers or that nobody was asked and saying other
protection rules remain unread; update next, one
per repository) or says why not, and merge now never rests on the ledger
alone: the forge must witness a review of the head (the reviewer app's
check, or a person's approval), and an outside author's pull request needs
a person's approval. A board read per repository, made after planning and
isolated from it, under a deadline and a floor on the forge budget it
shares with the drives, reads the facts the predicate and each pull
request's status row need (conflicts, checks with the failing ones named,
unresolved threads, the derived merge state); every card says whether it
settles by waiting or waits on a person, and which act; a pull request that
becomes ready is notified once per head; and the outcome log records when
work became ready and why it left. The hub (item 42) adds marks to every
status row: the drive's round and its time, from the ledger; the
unresolved threads split by bot and not a bot, on the board read's detail
set only and under a cap of its own, its cost in the receipt; and the CI
hold, under which required checks fail on purpose, so a held card reads held, never failing, and is
never in merge now. Later, a board view places every piece
of work in one column (coming, picking up, driven, needs you, ready to
merge, merged), each card moving in any direction and saying where it came
from when it moved back. Built in the design's order, as the first stage
of the hub (item 42): the waiting loss measured from the existing log
first, then Ready to merge in the tick and on the page, then the board's
placement, a design round and the board view. The measurement is a
baseline, not a gate: the board's placement, the design round and the
board view are built whatever its counts show, since the board is what a
person asked for. The design round covers the whole hub, its views, cards and chat, so
the layout holds when the hub's writes arrive, and the board view comes
with the hub's Work page.

Done when, on a host running Orca, a converged pull request whose review the
forge witnesses and that the forge lets merge is in merge now with its
pinned command within one interval and reaches a person's phone once, one
blocked on a required review is in approve first naming requested reviewers
or saying nobody was asked, with unread protection rules explicit and no
claim that approval alone permits merging,
one whose ledger claims a head its reviewer never checked is in Needs you,
one whose base then conflicts leaves Ready to merge with its cause, a
failing board read leaves the tick's launches as they were, a drive a
person armed by hand shows on the board as claimed, every pull request
card shows its conflicts, checks, threads and merge state with the failing
checks named, a pull request under the CI hold reads held and is never in
merge now, and the history view filtered to yesterday shows how many
pull requests became ready, were merged, are still waiting, and were lost
to waiting.

### 39. Addresses: asking and telling the stations of the line

Where a piece of work stands is read from many places (the dispatcher's
report, receipts and log, the dashboard, the ledger comment, the drive's
doctor), and a person steers the line with a different gesture for each
case: an assignment, a label, an `answer` comment, a mailbox directive.
Every session and interface that shows or steers the line reads those
records its own way. [design/addresses.md](addresses.md) has how it works.
What it will build: an address for every station on a piece of work,
`station@repository#key` (`drive@jig#456`), resolved from the records the
line already keeps and declared nowhere; `jig ask <address>`, which answers
who holds the station, its state, what it waits on and its last outcome,
names every record it could not read, with `--thread` adds the address's
correspondence (requests, questions, answers, launches and outcomes, each
linked to its record) in one shape the command line and a panel both
read, and with `--waiting` lists every address that waits on a person,
from the newest tick's line; `jig send <address> <verb>`, which writes the one record
the line already acts on, from a closed list of verbs, and refuses a
person's commands inside a session the line started; an operator skill
that turns a person's sentence into those commands and holds no state;
a launch's result naming what follows it; and a park naming the person it
waits on. No agent stays resident to hold an address, and no daemon or
queue holds a request
([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)). One pull
request per step, in the design's order; built so far: `jig ask`, with its
thread and the list of what waits on a person, the outcome log's key column
and the rule it rests on,
[ADR-0014](../docs/adr/ADR-0014-addresses-are-derived-and-requests-are-records.md)
([plugin/README.md § Asking a station where it stands](../plugin/README.md#asking-a-station-where-it-stands));
`jig send`, its verbs, their checks and the refusal of a person's
commands in a session the line started
([plugin/README.md § Telling a station what to do](../plugin/README.md#telling-a-station-what-to-do));
and the operator skill, `/jig:operator`
([plugin/skills/operator/](../plugin/skills/operator/SKILL.md)). Also
open, for the hub (item 42), which builds them as its stage 2's first
step: the thread grows under `ask`'s version 1, each entry with a stable
id, a question with its key, its class and a status (open, answered, acted
on, expired), an answer with the question it replies to, who answered and
that person's permission on the repository, and an answered park kept from
the drive ledger's resolved parks; the addresses of one piece of work fold
into one thread by its aliases (the item key, the branch, the pull
request), each join with its evidence and only on evidence the
repository's own people wrote, and a work-batch's batch key makes
its members one thread; and `ask` lists the threads that hold something
for a person (an open question, an act a merge waits on, a follow-up's
question) only while they hold it, storing nothing when a reader hides
one.

Done when `jig ask` answers the address of a pick-up, a drive and a
follow-up on the machine that dispatched them and, from the forge and the
tracker alone, on a machine that did not, saying what it could not read;
an address nobody holds answers with its last outcome; the thread a panel
shows for an address is the one `jig ask --thread` prints; each verb of
`jig send` writes a record its reader acts on at its next run, and a
session the line started is refused the verbs that are a person's; the
operator answers "where does this stand" and "what waits on me" from those
commands alone; every ended launch names what follows it; every parked
question names the person it waits on; an answered park stays in its
thread with its answer and status; and a pick-up, the drive of the pull
request it opened and that pull request's follow-up read as one thread,
which leaves the thread list once nothing in it waits on a person.

### 42. The hub: one place to watch and steer the line

Where a piece of work stands is spread over machines and tools: the
dispatch dashboard shows one host's dispatcher and no pull request that
host does not hold, `jig ask` answers one address at a time, and checks,
threads and whether a pull request can merge are on the forge. Nothing
shows a tracker item, its pull request and its follow-up as one piece of
work, nothing shows a pickup's progress before its pull request exists,
and answering a parked question takes a terminal.
[design/hub.md](hub.md) has how it works. What it will build: the
dispatch dashboard (item 33) grown into one page, `jig hub` in
`plugin/hub/`, that opens on an Inbox of what waits on the person and adds
a Board, Ready to merge, a Work page for each piece of work with its
thread, History and Hosts, each derived from the line's records at every
read and none of them stored; marks on item 36's status row (the
drive's round and its time, the unresolved threads by bot and not a bot,
and the CI hold, which reads held and never failing); a `pickup-progress`
record that `do-item` and `work-batch` write at each phase, so a Picking
up card shows the last phase and its age; item 39's thread grown under
`ask`'s version 1 into one thread per piece of work; the views API from a
page to its own hub and the source feed from a host to a hub over
`ssh <host> jig hub rpc`, every fact stamped with its host and a
visibility class, so a shared control plane can later serve the same feed;
a host's hub read-only on loopback, answering only its own pages, a
laptop's hub that serves any browser and reads each host over SSH (Secure
Shell) with a key that runs the feed and nothing else, and Orca, where a
person uses it, opening the hub in its own browser; an optional
private-network front, Tailscale Serve first, that gives a phone an HTTPS
name and the viewer's login, scopes what each person sees by the grants of
the tailnet (Tailscale's private network), trusts that login only on a
Unix socket only Tailscale's daemon reaches, and refuses Tailscale Funnel,
which publishes to the open internet; `hub` as a component of the `jig`
command beside `dispatch` and `gc`, installed as a new `resident` job kind
only where Orca's browser or a front reaches a host's page, which never
upgrades itself and never migrates a database; and an operator chat that
explains and drafts and never sends, its plan cards rendered from
`jig send`'s own dry run and its conversation kept on the person's laptop
as a `hub-conversation` record that `jig gc` removes 30 days after the
thread settles. The hub's views read the forge facts the tick already
read, and its own forge reads keep to a tenth of each hour's budget and
stop when less than two fifths of it is left, above the fifth at which the
tick skips its board read, so an open page adds at most a tenth to what the
line spends. Jig stays whole without Orca:
every view works in any browser, the machines talk over SSH, and each
thing Orca adds has a Herdr or plain-text equivalent. Every write is the
person's, made with their own credential, and the hub writes nothing until
item 40 settles how a comment a pass posts under the person's login is
told from the person's own; each commit then asks for proof that a person
is present. Nothing of it is built. Built in stages, one pull request per
step: the per-pull-request status on the dashboard that exists (rounds and
resolved parks in the drive ledger, item 36's board read, Ready to merge
and placement with the marks, a line one repository's tick refreshes,
pickup progress, then one design round for the whole hub and the Board and
Work views); then each piece of work across machines (item 39's thread
additions, `jig send --json` with `--expect`, the `jig hub` server, its
Inbox, Hosts and History views and its install, the private-network front,
the Orca plugin's "Open the hub" command and its install from a catalog);
then the chat, and writes once item 40 settles. Stages 2 and 3 are
planned in detail once stage 1 has been in use for four weeks, and the
person who asked for the hub decides whether each is built, from the
waiting loss measured since stage 1 shipped and what they still pieced
together outside the page; the call is recorded here with its reason
([hub.md § Build order](hub.md#build-order)). The shared control plane
waits for a decision record of its own (Later: a control-plane service for
the shared records).

Done when, for stage 1, on a headless host running the dispatcher, every
pull request card shows its round and its unresolved threads, split by bot
and not a bot on the board read's detail set within its author cap and as
a total on the others, and, under the CI hold, "held" in place of failing,
never in merge now; a pickup shows its last phase and its age before its
pull request exists; a tick that reads one repository refreshes that
repository's part of the page while a stopped timer still reads overdue;
and serving the page leaves a database one schema behind unchanged byte
for byte. For a stage a person decides to build, stage 2 is done when a
laptop's hub shows each host's work, read over SSH, beside its own in any
browser, with the host's hub listening on loopback only, and says since
when a host stopped answering; one piece of work opens as one Work page,
its item, pull request and follow-up under one thread; Orca's browser opens
the same page; and a phone through the front sees only the repositories
its grant names. For a stage a person decides to build, stage 3 is done
when the operator chat proposes and never sends and, once item 40 has
settled, a commit from the hub writes only as the person, after proof that
they are present and a dry run that still matches.

### 35. One jig command line

The plugin's machine-level tools are separate commands with no shared
shape: `jig gc` and `jig dispatch` each install, remove and report on their
own job in their own words, and installing, updating and checking the
plugin itself is a script in this repository (`tools/plugin/setup.ts`), not
a command the plugin ships. This item makes `jig` one command line, parsed
with [Optique](https://optique.dev) (vendored as a bundle Jig builds,
[ADR-0001](../docs/adr/ADR-0001-bun-typescript-toolchain.md)), with
resource collection and the dispatcher as its components: each component
defines its command beside its code (`plugin/gc/cli.ts`,
`plugin/dispatch/cli.ts`) and `plugin/jig.ts` combines them, so `--help`,
`jig help <command>` and `jig completion <shell>` come from the
definitions that parse. Across the components come the lifecycle verbs
`install`, `uninstall`, `upgrade`, `doctor`, `status`, `receipts` and `run`
(`jig install dispatch`, `jig status`), through one component interface a
third component joins without touching the verbs, while each component's
own work stays under its name (`jig gc --collect`, `jig dispatch --apply`).
`jig` reaches `PATH` through the launcher the installed jobs already run,
which finds the installed plugin copy at each run, so a plugin update
reaches it without a new install. The audit stays a skill; `jig doctor`
runs its configuration-fit check beside its own.

What must keep working through every step, because jobs already installed
on machines run it: each timer's launcher, copied under the gc state
directory, calls `<plugin copy>/jig.ts` with
`--config=<plugin copy>/gc/bunfig.toml` and `gc --scheduled` or
`dispatch --apply`. So `plugin/jig.ts` stays where it is,
`plugin/gc/bunfig.toml` and `plugin/dispatch/bunfig.toml` stay (the
dispatcher's pass wrapper and launches use the second), those two command
lines keep their meaning, the heavy-run lock's re-run of
`jig.ts gc … --collect` keeps working, and `jig dispatch run` stays the
pass wrapper's passthrough.

Built in this order:

1. **Optique, behaviour unchanged**: one parser with a `gc` and a
   `dispatch` command replaces the hand-written ones, every current form
   keeping its meaning and exit code, with generated help and completion.
2. **Lifecycle verbs over one component interface, `jig` on `PATH`**: the
   verbs above for both components, each component's `install` and
   `receipts` reached through them with the old forms still working, and
   `jig install` writing a `jig` command that runs the installed copy
   through the launcher.
3. **`doctor` and `upgrade`**: `tools/plugin/setup.ts`'s install, update
   and check move into the plugin as `jig upgrade` and `jig doctor`, moved
   and not copied: `tools/plugin/setup.ts` keeps only a call into the
   plugin's code, so a first install from a checkout still works. After
   the plugin, `jig upgrade` has the newly installed copy refresh each
   installed job's launcher copy and job, and the `jig` command, keeping
   what each install recorded. `doctor` also runs the audit's
   configuration-fit check, offline.
4. **The timers keep the plugin current**: the launcher runs the installed
   copy's `jig upgrade --scheduled` before each job and resolves the entry
   again, so the job runs the copy the upgrade installed. The upgrade is on
   by default (a machine that runs the dispatcher is the one with nobody at
   the keyboard), follows the channel the machine installed from, and a pin
   receives nothing. It runs at most once per `upgrade.every` (an hour)
   whichever timer fires first, is a line in that job's receipt and in the
   morning report, and when it fails it is reported, named by `jig doctor`,
   and not tried again inside the interval. The launcher runs it from the
   installed copy, never from itself, and the launcher copy is refreshed by
   `jig upgrade` as step 3 has it. A versioned cache install puts each
   version into its own directory, so a run already started keeps the files
   it started with. A plugin loaded in place from a local marketplace has no
   such directory: the scheduled upgrade skips it, reports the skip in the
   job's receipt, and leaves updating it to the person who maintains that
   folder. `jig install --no-upgrade`, or `upgrade: off` in the machine
   file, opts a machine out.

Done when `jig` on `PATH` installs, upgrades, checks and removes both
components through the same verbs, `jig doctor` reports the plugin's
installation and the repository's configuration fit, `tools/plugin/setup.ts`
holds no logic of its own, a job installed before the first step still
runs on a machine that took every release since, two timers firing within
one interval run the upgrade once and the job after it runs the newly
installed copy, a failed upgrade is reported and withheld for the rest of
the interval while the job still runs, a successful and a failed upgrade
each appear in the job's receipt and the morning report and `jig doctor`
names the failed one, a scheduled run on a plugin loaded
in place from a local marketplace leaves that folder untouched, records the
skip in the receipt and still runs the job, and a pinned machine or one with
`upgrade: off` runs no upgrade.

### 34. Jig in the Orca ecosystem

Jig's tooling reaches [Orca](https://www.onorca.dev) in places built
on their own (the workspace tool behind the launcher, `do-item`'s board
updates and workspace names, the dispatcher's session runtime, and a
plugin Orca loads that wakes the dispatcher when an agent's status
changes), and the rest of the execution line meets it only in part:
collection through Orca still races an agent started between its last
registry read and the removal, and the dispatcher cannot read an account's
usage from Orca's command line. [design/orca-integration.md](orca-integration.md)
has how it works, in classes built in order. Still open, on Orca 1.4.248's
plugin hooks: the launch guard, in which `jig gc` takes its admission in a
guard record before its last registry read and the plugin's
`agent.launch.before` hook, reading that record without an awaited call,
refuses a launch into a worktree gc holds; a spike on binding a launch to
its account through the same hook; the plugin's status bar item; and the
Jig panel, which stays the person's inbox, with an answer box and, on a
merge-now entry, a button that runs the pinned merge command as the
person. The board and each piece of work open in the hub (item 42), which
the plugin's "Open the hub" command opens in Orca's own browser. Orca
stays optional: every view of the hub works in any browser,
and each thing the plugin adds has a Herdr or plain-text equivalent. Also
open: what Jig asks of Orca (usage per account
from the command line; a phone push only when an agent needs input; a hook
before a workspace's removal; filed by a person, each with its pull request
offered). One pull request per step, in the design's order.

Done when a launch Orca makes into a worktree `jig gc` is collecting is
refused by the plugin's guard whenever the hook runs and reads the record
(a hook that throws, runs past its deadline or whose worker is down lets the
launch through, and a fresh heartbeat does not promise otherwise; tests cover
each of those cases and an admission abandoned after gc submitted its
removal), a launch the guard let through just before gc's admission
keeps that worktree, and with a stale heartbeat gc collects as before and
its receipt says the collection was unguarded; the plugin's status bar
flags a tick older than twice the interval; the panel's inbox lists the
needs, with their decisions, that the dashboard's Now view lists for the
same tick; the dispatcher's account cap reads `orca
account usage --json` where Orca has it; and an agent in a Jig repository reaching `waiting`, `blocked` or `done`
under the plugin has a tick pending from the moment the event arrives, while the plugin's worker lives (a restart loses the pending flag and the machine's timer tick then processes the repository):
the first event after a minute of quiet starts it at once, an event during
a running tick or the minute after a start waits for one trailing tick
that starts once the running tick has finished and a minute has passed
since the last start, and either stays pending while the machine-wide
tick lock refuses it and survives an event that arrives while that tick
processes the repository.

## Next

Next starts with delegated merge, once item 40 holds. Then come what lets a
second team adopt Jig, work that arrives complete, reviews that catch what
gates cannot, and doctrine and measurement. Last come the developer machine
and its runtimes, and the runs a person owes.

### 9. Delegated merge (`pull_requests.merge: auto-on-converged`)

Lets a converged drive arm the forge's auto-merge for the exact head it
certified. It relaxes "a human merges", so the doctrine change is approved on
its own. It waits on item 40, because delegating the merge to a pass whose
pushes and merges are not enforced widens the gap item 40 closes: a pass
that pushes past a person's hold or runs a merge command itself. Before it
ships, the design must guarantee that:

- the delegation and the merge method are read only from sources the pull
  request cannot change, fetched fresh at the moment of the decision, and the
  integration branch is resolved independently of the pull request's own
  `repository.base_branch`;
- revoking the delegation, or any condition that refuses it, withdraws an
  auto-merge an earlier run armed, whatever the policy then says;
- `drive.ts` leaves the decision to the helper instead of gating on the pull
  request's own copy of the policy;
- an armed auto-merge is bound to the certified head and cannot arm before the
  reviewers summoned by Ready have reported;
- the doctrine (M7 invariant, the human-in-the-loop registry's Merge row, the
  maturity criteria) changes in the same pull request, in the direction the
  decision picks.

### 26. `init`: setting a repository up for Jig

A repository adopts Jig by hand today: read the configuration reference,
write `.config/jig.yaml`, or copy the audit's starter configuration out of
the sheet. [design/init.md](init.md) has how it works: one detector shared
with the audit's configuration fit, a run that derives every value the
repository states, asks at most five questions for the rest, writes the
overlay with its evidence, enables the plugin for everyone who clones, and
checks the result the way the audit will; the audit measures, init writes.
What it will build, one pull request per step:

- **The skill**: `plugin/skills/init/` with `init.ts` (derive, ask, write,
  check) on the shared detector (`plugin/shared/detect.ts`), which learns the
  changelog file, the label taxonomy and the title convention, the `fields` on
  the configuration fit's findings so init can sort them, refresh mode
  after a plugin release, tests from a plugin copy against fixture
  repositories with and without a configuration, the lifecycle-map row and
  the README table row.
- **The pointers**: the adoption pages, setup's next step, the audit's
  `remedy: init` marker and the sheet's command, and the configuration
  fit's finding for a file written under an older plugin than the last
  field-adding release.
- **Project-level enablement** in the host settings files.

Done when a fresh clone with no configuration runs `/jig:init`, commits
what it wrote, the audit's configuration fit reports no finding about a
field init derived or wrote, every other finding is reported with its
remedy, and the brownfield and greenfield pages send a new repository
there first.

### 3. The kickoff family

The greenfield kickoff becomes a living skill instead of a frozen seed, with
the skills it calls, written for Jig and free of third-party lineage. Each
moves in from where it is kept today, and that copy is deleted in the same
rollout:

- **`kickoff`**: the project bootstrap (requirements, architecture,
  red team, synthesis, repository bootstrap, plan review, developer
  documentation, scaffolding, agent hierarchy, implementation plans, tracker).
  It replaces `seeds/project-kickoff/`, which is an older copy. M6's PRD and
  architecture templates and the kickoff's own are merged into one of each.
  The opinions M6 leaves out (tiers, model routing) belong in the skill, not
  the module; its red-team phase runs
  [`red-team`](../plugin/skills/red-team/SKILL.md), which holds the
  personas. M6's PRD and architecture templates move into the
  skill (`templates/`), moved and not copied, and M6's README links them there
  ([the module contract](../modules/AGENTS.md#the-module-contract)); the
  NOTICE entries move with them.
- **Plan review**, folded into `review`, which already accepts a plan
  document: dependencies and critical path, completeness, simplification and
  effort checks.
- **`upgrade-deps`**: grouped, changelog-driven dependency upgrades (the
  majors an update bot cannot do alone), opened through `do-item`'s
  pull-request policy and driven by `drive-pr`; the runnable side of M1's
  pin-and-update rule.
- **`design-brief-builder`**: two copies have diverged; merge the source's
  `failure-modes`, `bundle-contract` and `creative-latitude` references into
  this one.

[adoption/greenfield.md](../adoption/greenfield.md) then points at
`/jig:kickoff` instead of the seed.

### 8. The audit experience: what is left

The audit sheet, the decisions round trip, profiles as targets, the trend
across past records and the starter configuration are in the
[audit skill](../plugin/skills/audit/README.md).
What its [design](audit-experience.md) still holds:

- **Greenfield**: an audit run at the end of the kickoff's repository
  bootstrap leads with the profile check and leaves out modules outside the
  profile; the kickoff family (item 3) calls it.
- **Calibration into the reflection store**: each *this is wrong* decision
  becomes a finding about the `audit` skill in the
  [reflection store](../plugin/skills/reflect/README.md).

Done when a kickoff run ends with the greenfield check and a *wrong*
decision reaches the reflection store.

### 18. The jig-harness.dev website

`website/` renders this repository's documents as a designed site (Astro, a
static Cloudflare Worker), open to every reader and to search engines;
[design/website.md](website.md) has
how it works and what is left. Done when:

- a gate checks the contrast of every text pair and every hover and focus
  state, in both themes;
- search works on a phone, and the plugin page shows one agent's steps at a
  time;
- the home and adoption pages show an audit sheet of Jig's own audit.

### 38. One look for Jig's pages

The pages Jig's tooling draws pick their own colours: the dispatch
dashboard wears Jig's look in light and dark, the decision, explainer and
audit sheets share a neutral blue in light only, and the code-stats report
has a blue of its own. [design/ui-theming.md](ui-theming.md) has how it
works. What it will build: one set of colour names with a light and a dark
value each (`plugin/shared/theme.ts`, the dashboard's values), with every
text-on-background pair held to WCAG AA; the dashboard, the sheet kit and
the code-stats report reading their colours from it; dark mode for the
sheets; Jig's mark as every page's icon; and a test that the site's shared
colours agree. One pull request, the design's first step.

Done when every page Jig's tooling draws takes its colours from
`theme.ts`, follows the reader's light or dark setting, carries Jig's mark,
and each genre's contrast test holds its light and dark pairs.

### 41. Configurable issue attributes: type, priority and size

An issue's type, priority and size are kept differently by each way an
issue is filed: in the tracker's own field, in a label, or nowhere, so a
tracker cannot sort or filter on them. The
[tracker interface](../GLOSSARY.md) reads an issue's native type
(`Issue.nativeType`) but cannot write a type, carries no size, and an
adapter's priority storage is configurable only per adapter (the GitHub label
map `issue_tracker.github.priority_labels`, the Jira priority names
`issue_tracker.jira.priorities`), with no choice between the tracker's field,
a custom field, labels or a command, and only `file-issue` checks that an
issue it files is complete. What it will build: the tracker
interface carries an issue's type, priority and size as canonical values, and
where each of the three is kept is per-repository configuration
(`issue_tracker.attributes`): the tracker's own field, a named custom field,
labels, or the repository's own command, with a documented default per
adapter:

- **GitHub Issues**: the issue type; the organization's Priority field; the
  Effort field when its options carry the size names, else size labels.
- **Jira**: the issue type, matched by name; the priority field; size as
  labels until a size field is named.
- **Linear**: labels for type and size; its priority field; the estimate as
  an option for size.

Today's `issue_tracker.types`, `issue_tracker.github.priority_labels` and
`issue_tracker.jira.field_labels` and `issue_tracker.jira.priorities` become
the label or field form of their attribute, and the native-type read the
interface already has is kept. Every filing path (`file-issue`, `file-deferred.ts`,
`report-bug.ts`, the issue forms) sets and checks all three, and a weekly
check reports the issues missing one. It includes reading and writing the
tracker's own issue type, not only a type label.

Done when a repository on each adapter files and reads all three in its
configured store, and Jig's own repository keeps them in GitHub's fields
with no type, priority or size labels.

### 43. Consumer actions: which Jig changes a repository must act on

A Jig release sometimes asks something of the repositories that use it: a
runbook that describes old behaviour, a configuration key to change, a plugin
source on a machine. Today a person reads the changelog by hand and tests each
entry against the repository, nothing records which release a repository has
already taken, and `/followup` stops on "which repositories are consumers?"
because Jig names none. [design/consumer-actions.md](consumer-actions.md) has
how it works. What it will build: a change note names the **consumer action**
in its list item (the level it is taken at: machine, configuration or
instructions; required or advised; hints that say how to detect it), which the
changelog check validates and the release step derives into a record in the
plugin; a repository records the version it last reconciled with
(`jig.reconciled`); `jig reconcile` reads the record between that version and
the installed one, tests each action against the repository and reports
required, advised, needs-a-look and not-applicable with file and line
evidence, and files the repository's own tracker items only for what a person
approved; a `reconcile` dispatch stage runs it per dispatched repository and
notifies once per new required entry, so a machine's dispatch file is the
list of consumers; `/followup`'s Breaking-changes arm reads its result; and
`/jig:jig` points at it for what changed.

Done when a fixture repository and changelog produce a required, an advised
and a not-applicable entry with evidence and file nothing unapproved, a
dispatch tick notifies once per new required entry, `/followup` no longer asks
which consumers are affected, and `/jig:jig` no longer sends a reader to read
the changelog by hand.

### 12. More tracker adapters

A plan file kept in the repository, beside Linear, GitHub Issues and Jira.
It waits on the open decisions below. For every adapter to work end
to end, the [tracker interface](../GLOSSARY.md) gains attaching a file,
which `decide` and `explain` now do through the Linear MCP tools or the
`linear` command. The deferral step (item 10), `decide`, `explain` and
`do-item`'s instructions then use the interface's operations, and
`do-item`'s parent-status reconciliation reads the interface's answers
instead of Linear's on its native path too. The workspace launcher and the
Herdr kickoff open Linear issues only: a GitHub key (`#123`) needs a
launcher tracker for GitHub Issues and the key's file name (`issue-123`)
where they name a cache file or a claim.
[plugin/EXTENDING.md](../plugin/EXTENDING.md#issue-tracker) lists what
still assumes Linear.

### 27. Work types: depth by kind of work

Every item runs the same stations at the same depth, and the kinds of work
Jig already knows (`labels.bug`, `batch_sizes`, `hitl`, the taxonomy's
closed `types` list) are read in scattered places or not at all.
[design/work-types.md](work-types.md) has how it works: the type derived
from the taxonomy's types family, the tracker's own type or a conventional
title prefix, never asked when derivable; one depth table per type with
defaults a repository overrides field by field; a type lowering depth only
where no flag, catalog review or gate raises it; an unknown type getting
the strictest value of every field. What it will build, one pull request per step:

- **`do-item` reads the row**: the pattern pre-scout, the review tiers and
  skip threshold, the change note, the body sections and the spike's `hitl`
  default move to the table, with a `task` fixture showing the lighter path.
- **`work-batch` and `file-issue`**: batchability from the row; the type
  written at filing.
- **The required check** that refuses a pull request whose item is
  of type `unknown` or links no item, reading its script and the type mapping from
  the base branch rather than the head, with a workflow template and the
  setup that makes it required.
- **The lifecycle map's column and M9's audit criterion.**

Done when a task-typed issue reaches its pull request with the depth its
row gives, a feature keeps every gate it has today, and the three former
conditions have no reader outside the table.

### 29. The spec a work item links

A work item carries or links its requirements, and the link is prose:
`do-item` hands the agent the body, the reviewer is told to check "the
acceptance criteria" wherever they are, and the pull request never says
which were met. [design/spec-link.md](spec-link.md) has how it works, on
the [spec ecosystems research note](spec-ecosystems-research.md): a
read-only resolver with one adapter per layout (the item's own body first,
then the common repository layouts by convention, then the tracker's
attachments once the interface has them) that returns requirements,
acceptance criteria and tasks with their ids; the result handed to the
implementing agent and the reviewer; a pull-request section accounting for
every criterion as met with an evidence record (item 28), deferred to a
filed item, or not applicable. The delivery loop writes no spec and
dictates no format.
What it will build, one pull request per step:

- **The repository adapters**, two or three layouts per pull request, each
  with its fixture folder; M6's audit criterion with the last of them.
- **`do-item` reads and requires**: the `spec` pre-scout by work type
  (item 27), the delegation prompt and the reviewer's list, the policy
  refusal for an unaccounted criterion, the recommended-skills page naming
  the spec-writing tools with the adapter that reads each.
- **The required check** that refuses an unlinked pull request or an
  unaccounted criterion, honouring an exception only when a member of
  `specs.exception_approvers` other than the author and the implementing
  agent's identity applied its label after the exception record `do-item` writes (the references, each source's revision and the exception lines) last changed, the record still matches, and the label is
  still on, reading its script and policy from the base branch rather than
  the head, with a workflow template and the setup that makes it required.
- **`review` in plan mode, `file-issue`, `/followup` and the epic close.**
- **The tracker source**, once the tracker interface has attachments
  (item 12).

Done when a feature whose body links a spec in any supported layout
reaches its pull request with every acceptance criterion accounted for,
one with none stops, saying so, before any code is written, and the stance (a work
item links its requirements; the delivery loop writes no spec) is a decision record.

### 31. Routing work to an agent, a model and an effort

`do-item` chooses which agent implements an issue, from the change-area
catalog, the issue's labels and its title (`determine_agent.ts`), but
nothing chooses the model or the effort that agent runs on, and nothing
records why: a bug fix in one file and an epic's architecture spike are
implemented on whatever model the session runs, the one the launcher's
settings or a person picked. [design/agent-routing.md](agent-routing.md)
has how it works, decided in
[ADR-0009](../docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md): a
route (agent, model tier, effort) for the implementer, derived from the
work type (item 27), the size and flag labels and the catalog's flags and
mandatory reviews, by rules as data with defaults a repository overrides;
raises that only move the effort up; the strictest value on every
conflict; a pinned agent keeping its pin; the reason, the source and
whether it was applied on the pull request, where the drive's loop-cost
report joins them to the outcome; a person's choice always winning; opt-in
until a repository declares its rules; no model asked to route. The design
is written and decided, and its first step is built: `determine_route.ts`
derives the route from the `routing` section and its defaults, and
`do-item` prints it and forwards nothing. What stays open is the rest of
the build, its own epic, one pull request per step:

- **The record**: the `## Route` section written and parsed from
  `plugin/shared/`, and the loop-cost report reading it.
- **M0's declaration point**: the policy, the criterion and the loader's
  families check.
- **`do-item` forwards**, behind a declared `routing` section: the model
  and effort to the subagent tool, the launcher's `route:` prompt line
  honoured, the pinned agent kept.
- **`work-batch` and the audit criterion** at M0 Standard.

The build epic is done when a flagged bug is delegated on a higher effort
than an unflagged one with the `## Route` section saying why, a `route: yours` prompt
delegates with nothing forwarded, and a loop-cost report shows the route
beside the rounds.

### 23. Seed review lenses

`review` runs [review lenses](../GLOSSARY.md) from one file each, and
ships the seed lens `jig.swallowed-failure` for M15; the other rules Jig's
modules state that no gate can judge have none yet.
[design/review-lenses.md](review-lenses.md) has how it works. What is left:

- **`jig.test-gap`** for M14.
- **`jig.stale-comment`**, after M4 gains its rule for comments in code.
- **`jig.type-invariants`**, after M15 gains its rule for types.
- **Measurement and promotion**: a lens's findings on pull request threads
  counted into M8's parity report, one row per lens version, and a lens
  promoted to blocking only with the measurement that cleared the bar.

Done when `review` runs every seed lens a diff triggers and says why it
skipped the others, each seed lens's eval fixtures have passed live, and the
tallying script turns a fixture set of threads into one parity row per lens
version.

### 30. Scanner findings block convergence

`resolve-review-comments` lists the findings a static-analysis app reports as
check-run annotations (`review.scanner_apps`), and `drive-pr` tells the agent
to work them, but the drive's verdict reads threads and summary comments
only, so a drive with annotations as its only findings can end `CONVERGED`
without starting a round. What it will
build: the annotation listing as a third source of open work beside threads
and summary findings, read by `drive-status`, `round-plan` and `converge`,
so the verdict withholds `CONVERGED` while a scanner check is running on the
head or lists a finding no round has answered; a way to record a finding
that stands (rejected, won't fix, deferred) against the head so it stops
counting; and the dismissal in the tool for the apps that expose one
(SonarQube Cloud's issue transitions), as an adapter beside the listing.
Done when a pull request whose scanner check holds a warning does not
converge until a round fixes it or records why it stands.

### 25. Dependency-review feedback

A tool that reviews what a pull request does to the repository's
dependencies (Socket is one) reports through a check run and one summary
comment, and raises no review thread. The loop's CI verdict already counts
that check run like any other non-reviewer check (`ciVerdictOf` in
`plugin/skills/drive-pr/scripts/lib/status/evidence.ts`), so a failing one
reads as failing CI whether or not the repository requires it; what the loop
does not do is read the alerts as findings
([AI reviewers](../plugin/EXTENDING.md#ai-reviewers) says why). What it will
build, one pull request per step:

- **Read the report**: a dependency reporter is configured by its login and
  check name, and read by a format of its own, the way a
  [severity format](../plugin/EXTENDING.md#severity-formats) is: only from
  comments and checks that login posted. Socket is the first built-in, checked
  against its real comments and check runs.
- **Alerts become findings**: each alert the report carries is a finding that
  names the package and the alert, with its severity mapped onto `blocker`,
  `high`, `medium` and `low`. It enters the loop through the path summary
  comments already use, so the decline ladder and a top-level answer apply
  unchanged.
- **Scores stay advisory**: a report's scores (supply chain, quality,
  maintenance, license) appear in the drive's status and the pull-request
  plan, never as findings, with no threshold that turns a score into one.
- **A failing check does not block by itself**: the reporter's check run
  leaves the overall CI verdict, and only its alerts carry weight, as
  findings. A check the repository's effective CI policy requires (listed in
  `ci.required_checks`, or required by branch protection when that is unset)
  keeps that requirement.

Done when a drive on a pull request whose report carries an alert with a
severity answers it as a finding, a report with scores and no alert adds none,
and a failing reporter check with no alert does not hold the drive back,
unless the repository's effective CI policy requires that check.

### 22. Merge conflicts, measured

The replay, live record and [M11/M12 practice](merge-conflicts.md) measure
where parallel work conflicts, expose the result in the audit and cross-PR
scoreboard, and feed each hotspot into the reflection store as a finding
whose class is its cause. What is left concerns only how Jig keeps its own
plan:

- **One file per roadmap item** follows only if the report shows the plan
  or the roadmap conflicting where items are added or removed side by side
  (`append` or `adjacent` hotspots, which now also arrive as reflection
  findings of those classes).

Done when a history report over a window of parallel work on Jig has shown
whether the plan or the roadmap has such hotspots, and one file per item has
then become a plan item of its own or been dropped.

### 17. Corrected designs for the existing modules

Practices a working repository validated, for modules that exist today:

- **M10 and M11**:
  - a ledger of out-of-tree work that blocks promotion.
- **M6 and M7**:
  - an acceptance stage;
  - plan claims checked against the code before building;
  - the execution-plan format the pickup skill reads;
  - a skill that runs the post-merge stage M7 states, for any repository (the
    stage and its criterion are in [M7](../modules/M7-pr-lifecycle-review/README.md));
- **M0, M4 and M5**:
  - a reference generator for the model roster, when the working tool moves
    here;
  - files that change only with an approved decision record.

Done when each module states the practice with its mappings and criteria, and
a re-audit of Jig scores them.

### 10. Values the skills still assume

Move into configuration when a consumer needs them:

- the review skill's deferral step (`defer-batch.ts`) calls Linear directly,
  with fixed label groups, instead of going through the
  [tracker interface](../GLOSSARY.md), so a repository on GitHub Issues,
  the default tracker, cannot defer a finding. Moving it onto the interface makes it work on
  every adapter; revisit for GitHub Issues what the step relies on that
  GitHub lacks or spells differently: label groups (GitHub labels have none,
  so the type and repository groups become configured label lists), its
  `--originating` and `--team` keys (validated through the adapter's key
  shape, `keys.ts`), the conditional description edits that keep concurrent
  deferrals from losing an entry (the interface may need a compare-and-set
  update, or a comment per entry where the tracker cannot compare), and
  GitHub's secondary rate limit on writes when a review defers many
  findings at once. Done when a deferral round files and appends its
  findings on both adapters, with the fake-tracker tests both adapters'
  tests use;
- the git remote: the delivery skills read it from `repository.remote`
  (default `origin`), but `review`, `review-reflections`, `reflect`,
  `code-stats`, `changelog` and the audit's `config-fit.ts` still read
  `origin` directly; they move onto the same setting, through
  `remoteName()` in `shared/consumer.ts`;
- the markers of Jig's own finding format (`ai-review-backlog`,
  `ai-review-round`, the leading `ai-review-*` comments) are fixed, and the
  summary-comment markers default to `<!-- ai-code-review -->` and
  `ai-reviewed-sha`: they become settings with neutral defaults, set to the
  current names first in the repositories whose reviewer writes them.

### 11. Jig's own Simplified Technical English linter

`decide`'s `ste-lint` is a faithful TypeScript translation of a third-party
Python linter, kept output-identical to it. Rewrite it as Jig's own
implementation of the same writing rules, free to deviate where Jig's
rules differ (for example by folding in the corrections its wrapper applies
today), and keep crediting the original
([Credits](../plugin/RECOMMENDED-SKILLS.md#credits)). The parity record and the
golden files from the Python linter then retire with the translation.

### 20. `code-stats`: a reference set and audit evidence

The [code-stats skill](../plugin/skills/code-stats/README.md) classifies a
repository's files from conventions, attributes, its test runners'
configuration, its `code_stats` configuration and a classify command. What
is left:

- **A reference set** of public repositories (a Python service, a Go
  module, a Rust workspace, a Java build, a JavaScript monorepo), each run
  recorded with its commit and its results beside it, as
  [the audit's calibration](../plugin/skills/audit/calibration/) is, so a
  change to a rule shows what it moves.
- **Audit evidence**: `jig:audit` reads `--json` (schema `code-stats/v1`)
  for the criteria that need a measure: the test-to-code ratio, the
  generated share, the scaffolding size, and a large unclassified share as a
  finding about the configuration.

Done when the reference set's recorded results are checked by a test, and
an audit sheet cites code-stats figures as evidence.

### 21. `changelog` skill: several artifacts

The [`changelog` skill](../plugin/skills/changelog/README.md) is the
runnable form of [M16](../modules/M16-releases-versions/README.md) for a
repository with one released artifact. What is left:

- **Several released artifacts in one repository**, each with its own
  changelog, version, tag prefix and release paths: a `changelog` section
  that lists artifacts, a note's front matter naming the artifacts it
  reaches and the bump for each, a release run that releases each artifact
  whose notes wait as one version of that artifact, and tags that carry the
  artifact's name. A note reaching no artifact stays the repository's
  choice (Unreleased, or none). Done when a monorepo with two packages
  releases them independently through the action, and the single-artifact
  configuration keeps working unchanged.
- **Other CI providers' templates** beside GitHub's workflow template, when
  a repository needs one.

### 28. `verify` and `debug`: evidence before claims, and a bounded debugging protocol

A claim that the tests pass points at nothing, and a failure whose cause is
not named gets a fix, then another. [design/verify-and-debug.md](verify-and-debug.md)
has how it works: an evidence record tied to the tree hash, with the test
counts from the runner's report and an expected-failure mode for M14's
seen-to-fail; a `verify` skill that records and a pull-request policy that
refuses a push without a record; a `debug` skill that reproduces,
attributes on a fresh base, narrows, keeps a hypothesis ledger, fixes, and
stops after a budget with the ledger posted where the work is tracked.
What it will build, one pull request per step:

- **`verify`**: the skill, its README, the lifecycle row, the M14 link.
- **Evidence collection**: a resource collection kind that removes records,
  their output and moved-aside reports past `verify.retention_days`, with
  receipts; until it lands, `verify.retention_days` is read and nothing is
  removed.
- **`do-item` and `fix-ci` record and require**: the policy refusal, the
  body's evidence section, the seen-to-fail requirement by work type (item 27).
- **`debug`**: the skill, the ledger, the budget, the hand-off from
  `fix-ci`, tests with a fixture whose failure needs attribution and one
  whose budget runs out.

Done when a pull request `do-item` opens carries an evidence section for
the pushed tree, `fix-ci` hands a surviving test failure to `debug`, and a
drive's repair round ends with a posted ledger when the budget runs out.

### 24. Resource garbage collection for a developer machine

A machine that runs many worktrees fills with what their sessions leave
behind (fixture processes, scratch directories, container volumes and images,
merged branches, tool state), each kind cleaned by its own script on its own
schedule or by nobody.
[design/resource-gc.md](resource-gc.md) has how it works: one runner, one
contract (a lifecycle predicate decides, age only guards, report first, fail
closed, a receipt per run), kinds a repository enables with its own facts,
and a machine layer for the schedule. What it will build, one pull request
per step:

- **Finish the first rollout**: move in the operated worktree reaper and its
  scheduler tests, with the creating/opening tool taking the shared session
  lock, and retire the working repository's copies in the same rollout.
  Coordinate tool-state creators with collection admission before enabling
  retirement; its legacy reaper lock excludes only other reapers.
  Validate its weekly job through the installed command before starting
  the later kinds. Worktree collection stays disabled until this
  integration, except for a worktree Orca manages, which `jig gc` collects
  through Orca.
- **Containers, volumes and images**, keyed to the compose projects the
  worktrees derive, and the machine-level dangling images and build cache.
- **Branches** merged as the forge records it (squash merges included) or
  into the base by ancestry, with the remote branch gone.
- **Processes**: the process registry as a shared module, the test runner
  registering its fixtures, and the kind reaping registered trees whose
  owner is gone.

Done when a working repository's weekly sweep is the installed `jig gc`
job, its own reapers and installers are gone, and the report names each
resource's proof before anything is collected.

### 19. Herdr as the primary workspace runtime

[Herdr](https://herdr.dev) is the workspace runtime Jig's tooling targets
first ([ADR-0005](../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
The [Herdr workspace tool](../tools/herdr/README.md), the launcher's `herdr`
provider and M12's worktree lifecycle in Herdr are in place. What is left
waits on a consumer repository that runs its agents in Herdr; the hosts
that run Jig's own line run Orca. Done when:

- each consumer repository's own Herdr launch and worktree commands call the
  workspace tool, and their copies of what it does are deleted, keeping only
  the repository's own setup as its `.config/worktree-hooks/create`;
- `drive-pr`, `do-item` and `review`'s reading of a delegated agent's output
  are run in a Herdr workspace on macOS and on Linux, and what differs is
  fixed or written down.

### 7. The Notion store, run against Notion

The [Notion store](../plugin/skills/reflect/README.md#notion-store) is built and
passes the conformance suite against a local fake of the Notion API. What
is left is the run against Notion itself, which waits on a person who holds
a Notion integration's token: with `NOTION_TOKEN` and
`JIG_NOTION_LIVE_PARENT` (a scratch page shared with the integration) set,
run `bun test plugin/skills/reflect/__tests__/notion-live.test.ts`, then fix
where the fake and Notion disagree, in both.

Done when that test passes, and a repository reflects into a database `init`
created using only `NOTION_TOKEN` and `reflection.notion.database`.

## Later

- **Scheduled-failure reconciliation.** Move an operated reconciler onto the
  existing tracker interface, following the
  [design](scheduled-failure-reconciliation.md). M11 states the per-cause
  issue lifecycle and announced flood breaker; implementation remains open.
  Done when evidence-only tests feed separate triage, retries and overlapping
  runs preserve one issue per cause, and suppression and genuine recovery
  are verified in a consumer with the source copy retired.

- **Jira store for reflections.** One issue per finding, of a custom issue
  type with fields for class, severity, target, harness, model and Jig
  version; the event kept as an issue property. Its shape and open questions
  are in [design/reflection.md](reflection.md#jira-store-future); build
  it when a team that tracks its work in Jira needs it.
- **A repository's theme.** A `ui` section with an accent colour and a
  mark, the rest of the colours derived from the accent so that contrast
  holds in both modes, applied by the dashboard's server and written into
  each sheet. Its shape is in [design/ui-theming.md](ui-theming.md#a-repositorys-theme);
  build it after item 38, when a team that uses Jig asks for it.
- **More skills.** `scaffolding-update` (keeps agent instruction files in step
  with decisions and audits them; M0), with its paths as configuration; and a
  SOLID-principles review skill, once its generic procedure is separated from
  the stack-specific checks it carries.
- **Tracker planning.** Epic planning and prioritisation as skills on the
  tracker interface, where the procedure is generic rather than one
  organization's workflow.
- **A forge interface.** GitHub is the only forge: the skills that work on
  pull requests call `gh` directly. An interface on the tracker's model (pull
  requests, review threads, checks and required checks, labels and comments),
  with the GitHub implementation behind it, then GitLab as the second; build
  it when a team on another forge needs it. What it covers is in
  [plugin/EXTENDING.md](../plugin/EXTENDING.md#forge-github).
- **CI logs from other providers.** `fix-ci` finds and downloads a failed run
  through GitHub Actions only (any CI's saved log already works with
  `--log`); a provider interface for those two steps.
- **Windows for `drive-pr` and `do-item`.** The remaining acceptance work is
  an **authenticated workflow**: run a real pickup, draft pull
  request, driven round and stop on Windows under Claude Code and under
  Codex with PowerShell. The deterministic smoke uses local fake services;
  it does not certify the agent and credential integration. Fix what the
  authenticated run finds, and remove the corresponding validation limits
  from the skills' READMEs. Cancellation uses captured process identities
  within the cooperative scope recorded in
  [ADR-0008](../docs/adr/ADR-0008-windows-cancellation-uses-captured-process-identities.md).
  **Fixture throughput** also remains: optimize the named multi-round,
  long-CI drive and large post-retirement census fixtures until they fit their
  existing native Windows test budgets, then lift their named skips.
- **Gates and workspace infrastructure.** Cross-worktree locks and
  test infrastructure, remote gates, and a runnable form of
  [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s workspace lifecycle
  for runtimes other than Herdr and Orca, which have one
  ([Herdr](../tools/herdr/README.md#the-worktree-hooks),
  [Orca](../tools/orca/README.md)).
- **Orca: what is left.** The [Orca workspace tool](../tools/orca/README.md)
  and the launcher's `orca` provider open an issue's branch as an Orca
  worktree, on a machine or on a paired Orca server, with the create hook
  run and the agent started once per issue. Still open:
  - the agent's start is recorded on the launching machine
    (`~/.jig/orca/kickoff/`), so two machines opening one issue on the same
    server each start an agent; record it on the server, as the Herdr tool
    does on its host, once Orca offers a place to keep it or the tool runs
    there;
  - `remove` parks reflection findings only when the clone is on this
    machine; on a server's host it reads the worktree's journal over SSH
    and refuses while unsent findings are in it, leaving the parking to a
    reflection run there. Run the journal there, as the Herdr tool runs on
    its host;
  - a hook on a server's host runs as one SSH command under the call's
    deadline, with nothing from Jig there to supervise it: a hook that
    outlives the deadline, or starts a child that outlives it, is left to
    the host, where on a machine the Herdr tool's supervisor ends the hook's
    whole process group. Supervise it there too, once what the host must
    provide is decided: `bun` for the shared supervisor, as the Herdr tool
    asks of its hosts, or a supervisor in the host's own shell;
  - the board card (`plugin/shared/orca-board.ts`) could link the
    tracker's GitHub issue with `--issue`;
  - a worktree created in the Orca app gets Orca's branch name and Orca's
    own setup hook, not the repository's convention and create hook; say in
    M12's mappings how a repository's `orca.yaml` setup script and Orca's
    branch-prefix setting approximate them, once validated in a consumer;
  - the drive, pickup and review skills checked inside Orca worktrees on a
    server, as item 19 does for Herdr;
  - the tool and the launcher's Orca provider on Windows: the tool drives
    its host with `sh`, `test` and `mkdir` and, on this machine, supervises
    its hooks through `/proc` or `ps`
    ([CONTRIBUTING.md § Toolchain](../CONTRIBUTING.md#toolchain) records
    the gap), so a Windows host needs those steps in its own shell first,
    and the provider tried there once it has them.
- **A control-plane service for the shared records.** The hosts that
  dispatch one repository publish who holds a launch and how it ended on the
  forge, and each reads the others' at its next tick
  ([plugin/RECORDS.md](../plugin/RECORDS.md#on-the-forge-and-the-tracker)).
  A service that keeps those records for many hosts is the
  [shared control plane](hub.md#toward-a-shared-control-plane) the hub's
  design describes: one service with a database that reads the forge and
  the tracker once for many hosts, keeps the hosts' records as a second
  implementation behind the same interface
  (`plugin/shared/records/shared.ts`) under its own `records.shared` value,
  hands the hosts their work and serves the hub's source feed through
  connections the hosts open. Handing out work coordinates the hosts, which
  ADR-0013 declines, so the service gets a decision record of its own,
  written when one of
  [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md#when-to-reopen)'s
  conditions holds: hosts dispatching one repository must see each other's
  state within seconds rather than at their next tick, a nudge to a running
  session needs a connection rather than a terminal keystroke, someone
  outside a host must be told that a dispatching host has stopped, or a
  second person acts through a host's hub, or needs a scope Jig itself
  keeps rather than one a private-network front's grant carries. Until then the
  invariants and seams that
  [design/hub.md](hub.md#toward-a-shared-control-plane) lists keep the way
  open, among them a shared claim for pickups, without which one
  repository's pickups are dispatched from one host only.
- **The mailbox as every session's inbox.** The
  [drive mailbox](../GLOSSARY.md) reaches a drive's driver only, and the
  dispatcher's one nudge, the `continue` it types into a session whose usage
  limit has reset, is a keystroke into that session's terminal. Open the
  mailbox to every session the line starts once a second mechanical nudge
  exists that needs it.
- **Change-area consumer lint.** The `lint-consumers` check moves into the
  [change-areas skill](../plugin/skills/change-areas/README.md): the path
  lists in agent rules, hook configuration and CI workflow triggers checked
  against the catalog, so a consumer that restates an area's globs fails when
  they drift ([M3](../modules/M3-change-area-catalog/README.md) lists it as
  future). Bring it in with its tests, and its consumer-specific path lists
  as the repository's configuration or composer.
- **The resolver in the delivery skills.** When a repository declares
  `drive.change_areas_catalog` and no `drive.validation_plan_command`,
  `drive-pr` and `fix-ci` take their validation plan from the change-areas
  resolver instead of `gates.command` alone, as `review` already does for
  its mandatory reviews. Done when a repository with only a catalog gets
  the catalog's plan in a drive round and in `fix-ci`, with a test for each.
- **Bun's linter and formatter.** A linter reports code that breaks a rule;
  a formatter rewrites code into one consistent layout. Jig uses Biome, a
  single tool that does both, for its TypeScript and JSON. Bun is adding its own:
  `bun lint`, which accepts the rules of ESLint and oxlint (two widely used
  JavaScript and TypeScript linters) including rules that use type
  information, and `bun fmt`, which formats as Prettier (a widely used
  formatter) does. They could replace Biome: one development dependency
  fewer, and rules that read the types in place of Biome's experimental
  ones. Evaluate them once they ship in a
  stable Bun release: port the rules in
  [tools/quality/grit/](../tools/quality/grit/) to ESLint rules with their
  fixtures; give the ratchet (`tools/quality/ratchet.jsonc`) a counter for
  `bun lint`'s report in place of its `biome-json` one, with fixtures showing
  it counts the same warnings Biome did, and teach it to read the `[lint]`
  section of `bunfig.toml` and count `eslint-disable` comments;
  map `biome.json`'s rule settings; keep Biome, or another linter that reads
  JSON, for the JSON files if `bun lint` still covers only JavaScript and
  TypeScript; decide whether Markdown and YAML are
  formatted, then run both linters side by side for one release before
  Biome goes. M1's and M14's `mappings.md` gain `bun lint` as a TypeScript
  option in the same pull request.
- **Shared test helper.** A shell-command reachability model for testing
  workflow files, once it is separated from the workflow conventions it is
  written against.
- **Module gaps.** Items each module README lists as future: M4's tag-merge
  normalizer and scheduled wiki lint, M3's catalog-to-regex reverse check
  (can be built on the change-areas skill's resolver), a semantic tier for
  ADR rules (M5 with M7/M8), M12's
  probe-for-free port fallback.
- **Module consistency.** M6's stage gates require `status: accepted`, which
  M4's frontmatter schema does not define (it has `approved`), and M6's
  templates lack M4's required fields: pick one vocabulary. M3's two reference READMEs are correct but long and
  hedged; rewrite them to state the rules plainly.
- **Drive loop follow-ups.**
  - `drive-pr`'s CI-repair round should run `/jig:fix-ci`, but that
    skill commits and pushes on its own, while a drive pass must push through
    `finish-round.ts`; give `fix-ci` a mode that stops before pushing.
  - The orphan warning in `scripts/lib/state/orphans.ts` can never fire under
    the default state directory; remove it or make it look in the right
    place.
  - `references/post-fence.md` says its fence probe can go once every install
    of `resolve-review-comments` also carries `drive-pr`. The plugin ships both
    together; decide whether standalone copies still need the probe.
  - The refocus behaviour is enabled on half of `do-item`'s items as a
    comparison. Decide from its results whether it stays, becomes the
    default, or goes.
- **Standalone reference gates.** The gates in M0–M2 and M6–M9 import the
  repository's `lib/`, so a reader cannot copy one alone. Either make them
  self-contained or ship `lib/` as a documented, versioned dependency.
- **History in the plugin's code comments.** Many comments in `drive-pr`
  and `resolve-review-comments` still tell how the code got its shape ("this
  fix", "an earlier version", "the old code") instead of stating the rule;
  rewrite them as their files are next touched, or in one sweep.

## Standing: backflow

Jig keeps learning from the repositories that use it. When one of them
finds a better gate, a corrected design or a new review lens, evaluate it for
Jig and port the corrected design, not the first attempt
([principle 5](../principles/05-learning-loop.md)). A consumer's own values stay
in that consumer's configuration.

## Open decisions

These need a human decision before the work that depends on them starts.

- **Plan-file tracker format**: one file for the whole plan, or one per item.
- **Optional tracker operations**: whether the tracker interface's reporting
  operations may be optional for an adapter that cannot answer them.
- **Resilience copies of critical rules**: whether a tool-specific instruction
  file may keep a checked copy of a few named critical rules, so they still
  bind when its import of the universal file is missing, or whether M0's
  "duplicate nothing" criterion stands and only asks for the import.
