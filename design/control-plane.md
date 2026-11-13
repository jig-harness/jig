# The hub, a shared control plane for many dispatchers: design

**What problem this solves.** Each host that runs Jig's
[dispatcher](../GLOSSARY.md) reads the forge (the service that hosts the
repositories and their pull requests) and the tracker by itself, on its own
timer. One host is fine. Several hosts that dispatch for one team or one
person read the same pull requests and the same queues several times over,
against limits that belong to one credential or one organization: Linear,
for one, allows each person's keys 2,500 requests an hour between them. A
host sees another host's work only through the forge, a tick behind. One
repository's pickups can be dispatched from one host only, since nothing
claims an item before a session opens. Nobody outside a host learns that
it stopped, so its work waits until a person notices. A person with several machines has one
[dispatch dashboard](../GLOSSARY.md) per machine and no view of all of
them. With this built, an optional service, the [hub](../GLOSSARY.md),
reads the forge and the tracker once for every host enrolled in it. It
also grants claims with leases, so a silent host's work goes to another
host, offers work to whichever host has a free slot, tells a person when a
host stops and serves one view of every host's work. A host that never enrolls loses
nothing, and a host whose hub is unreachable works as it does today, bar
the owner duties that wait for the hub's lease
([Owner duties](#owner-duties)).

This is the design of [plan.md](plan.md) item 49. Nothing of it is built.
It answers the conditions on which
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md#when-to-reopen)
reopens, and its decision record is
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md).
It builds on the dispatcher ([dark-factory-dispatch.md](dark-factory-dispatch.md),
item 33), its shared records ([plugin/RECORDS.md](../plugin/RECORDS.md)),
the dispatch dashboard's source feed
([dispatch-dashboard.md § The source feed](dispatch-dashboard.md#the-source-feed-from-a-host-to-a-dashboard),
item 42), and the addresses that `jig ask` and `jig send` derive
([addresses.md](addresses.md), item 39).

## How it works

### Levels of use, each whole without the next

Jig is used at the levels below, and a team stops at whichever suits it:

| Level | What runs | What it adds |
| --- | --- | --- |
| Skills | A person's session runs `do-item`, `drive-pr` and the other skills by hand | Each piece of work driven to merge-ready, with its own fences: the drive's lock and ledger claim, the tracker claim |
| Dispatcher | A timer on each host runs the tick | Work started and kept moving with nobody watching, one host's dashboard |
| Hub | One more process that enrolled hosts call | One read of the forge and tracker for every host, claims with leases, offers, a stopped host noticed, one view across hosts |

These rules keep each level whole:

- **No level needs the next.** The skills never talk to the dispatcher or
  the hub, and the dispatcher never needs the hub. Nothing at the lower
  levels carries a field, a record or a setting that exists for the hub
  alone; the seams it needs are built for reasons of their own first
  ([Build order](#build-order)).
- **Joining is a setting, and leaving is removing it.** A host joins by
  enrolling and naming the hub in its machine file. Since the hub holds no
  authority over a host's work, nothing moves back when a host leaves.
- **A hub that is down returns its hosts to the level below.** Every call
  a tick makes to the hub has a short deadline. When it fails, the tick
  reads the forge and the tracker itself within its own budgets, claims on
  the forge as it does today, and says on its receipt since when the hub
  has not answered. Running sessions never notice. The one exception is an
  owner's duties, which wait for the hub so two hosts never hold one
  ([Owner duties](#owner-duties)).
- **The hub adds checks in front of the fences and never replaces them.** A
  drive launch still needs the winning claim on the forge, and a pickup
  still needs its tracker claim. The hub's own claim is a faster check
  before them, which stops most races before anything is written; the
  fence decides.

### What the hub is

The hub is one process, `jig hub serve`, with one SQLite database, part of
the `jig` plugin like the dispatcher and `jig gc`. It runs on any machine
that its hosts reach over HTTPS: in its smallest form on the always-on host
that already dispatches, on a small server, or on a team's machine. It
needs no cloud service, and it opens no connection to a host: hosts call
it, and it calls the forge and the tracker. A host enrolls in at most one
hub. One hub serves one person or one organization; hubs do not talk to
each other.

The hub is the only resident process the hub level adds. The dispatcher
keeps no process running on any host
([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)): its tick and
its change probe run on the host's timers, and each makes request and
answer calls to the hub while it runs. A host that keeps a waiter running
for early wake-ups may hold one call open instead, as a long poll, but
nothing requires it.

### What it keeps, and what stays with the hosts

- **A host keeps authority over what it did.** Its launch records, its
  sessions, its outcome log and its walls stay on the host; drive ledgers
  and claims stay on the forge; claims on items stay on the tracker. The
  hub keeps copies of what hosts report, to serve them, and never edits
  one.
- **The hub keeps no phase of its own.** It derives columns, threads and
  the state of a piece of work from records each time it is read, with the
  same fold library as the dispatcher and `jig ask`
  ([dispatch-dashboard.md § The source feed](dispatch-dashboard.md#the-source-feed-from-a-host-to-a-dashboard)).
  A stored copy of a pull request's state drifts from the pull request.
- **No server timer rewrites a host's work.** A lapsed lease releases the
  claim it held and nothing else: the hub never marks a host's session
  failed, never cancels one and never counts it against the host. What
  happened to the session is the host's to report.
- **What the hub stores is rebuildable**, except its enrollments and the
  leases it granted. Its read cache comes back from the forge and
  the tracker, and its copies of host records come back when each host
  backfills after its next `hello`
  ([`report`](#the-host-protocol)). A lost lease lapses on its own, and the fence behind it still
  holds. A hub started with no database waits out a quarantine as long as
  the longest lease it ever grants before it grants an owner duty or a new
  claim, since a host may still hold an unexpired lease the hub no longer
  remembers; reads, reports and enrollment go on meanwhile. So deleting the
  hub's database costs a fresh enrollment of each host and a quarantine
  of one lease lifetime, and nothing that the line depends on.
- **It keeps what it serves**, comment text included, on the machine the
  organization chose, as each host's own records do. Reading the text
  through on each request instead would spend the reads the hub exists to
  save.
- **No relationship store.** Links between items live in the tracker
  ([ADR-0015](../docs/adr/ADR-0015-relationships-live-in-the-tracker.md)),
  and the hub reads them there like any host.

### Enrollment, and whose credential acts

- **A host enrolls with a device grant.** `jig hub join <address>` on the
  host prints a short code. A person who administers the hub approves it
  with `jig hub approve <code>`, and the host receives a credential of its
  own. The host keeps the credential in its state folder, readable only by
  its user. `jig hub revoke <host>` ends it, and `jig hub leave` on the
  host removes it and the setting together.
- **Every call is bound to its host.** The hub takes the host's identity
  from the credential, never from a field the caller fills in. A host can
  write only its own reports, claims and renewals.
- **Every host has an approved scope.** The person who approves a host
  names the repositories and tracker queues it may use, and the hub keeps
  that scope with the credential. `hello` returns the intersection of the
  scope with the host's machine file, and `changes`, `read`, `claim`,
  `report` and `offers` refuse any target outside it with a coded failure.
  A host cannot reach a repository by asking for it; widening a scope is
  another approval.
- **The hub reads with an identity of its own**, which the organization
  creates and the hub's configuration names: a GitHub App installation, or
  for the smallest form a read-only token; a Linear or Jira credential
  for the tracker. The hub writes nothing on the forge or the tracker: the
  forge claim and the tracker claim are written by the hosts, as today, so
  the read-only form is whole. A hub that is later given a write (a notice
  on the forge, say) names that write and its permission here first. The
  one named is the [chat bridge](chat.md)'s, where a hub runs one: under
  the bridge's own forge app identity, an answer comment and the `drive`,
  `hold` and `release` labels on a pull request (the app's Issues and Pull
  requests write permission), and under the hub's tracker credential the
  assignment `/jig pickup` makes, each with a record naming the person who
  asked.
- **A person's act is made with that person's credential.** Merging,
  answering a park and every write a dashboard makes for a person go from
  the person's own machine, as the person, never through the hub. The hub
  holds no person's credential. The one exception is a request made through
  the hub's chat bridge, posted under the bridge's identity and naming the
  person the chat authenticated
  ([ADR-0022](../docs/adr/ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md)).
- **A host keeps its own credentials for its sessions.** A drive pushes,
  comments and reviews with its host's accounts, as today. The hub serves
  the reads the dispatcher makes, not the reads a session makes.

### The host protocol

Hosts call the hub over HTTPS with JSON bodies; each call names the
protocol version in its path (`/v1/`) and carries the host's credential.
A call states its capabilities as named flags, and the hub answers with
its own, so either side adds a capability without changing the other. An
older host simply does not use what it does not know. Every answer is a
value or a coded failure, as everywhere in Jig
([ADR-0012](../docs/adr/ADR-0012-failures-as-values.md)). The hub is a
resident process with concurrent reads, webhook intake and renewals, which
is the case ADR-0012 reserves for reconsidering its programming model:
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
records that reconsideration, and it is settled before stage 1 starts.

- **`hello`**: the host's stable id, its dispatcher's incarnation (the id
  its state database got when it was created), its Jig version, its
  capabilities and the repositories its machine file lists. The hub
  answers with its own capabilities, the repositories it serves for this
  host and, for each, the host that owns it
  ([Owner duties](#owner-duties)). A tick calls `hello` first; a failed
  `hello` sends the whole tick to the level below.
- **`changes(token)`**: what changed since the host's last token, as a
  list of repositories and tracker queues, and a new token. The answer
  carries no content: it says where to look, and the host's next tick
  reads there. A lost answer costs a wake-up and nothing else, since the
  timer's tick reads everything anyway. The change probe calls it in place
  of its own forge and tracker queries, and wakes a tick for the
  repositories it names, as it does now.
- **`read(targets, notOlderThan)`**: the forge's and the tracker's facts
  for each target (a repository, a pull request, a queue, an item), each
  with the time it was read. The hub answers from its cache when its copy
  is at least as new as `notOlderThan`, and otherwise reads through with
  its own identity before answering. When its own budget is spent it says
  so with the time it resets, and the host reads for itself only if its
  own budget allows. The observe phase asks with the tick's interval as the
  bound; the check just before an act asks with a bound of seconds, as
  `freshDriveReading` and `freshPickup` do today.
- **`report(records)`**: the records the hub serves on: the line, each
  launch's start and end, outcome rows, the drive ledgers (decisions
  included), pickup progress, receipts and the correspondence the source
  feed's bounded calls return, each under the visibility its repository's
  scope gives it. Each record goes in the envelope Jig already uses, with
  its repository, key and generation: a key is unique only within its
  repository, so the hub stores a record under host, incarnation,
  repository, kind and key. That tuple names the record, not one update of
  it. Each host stamps every report with a [replication revision](../GLOSSARY.md), a counter
  per incarnation that advances whenever the host observes a body that
  differs from the one it last reported for that record, whatever that
  record's own generation says: the generation Jig writes is one past the
  highest the writer read, so two writers can leave different bodies at the
  same generation, and the revision is what orders what the one host saw.
  The hub replaces the stored copy with a report of a higher revision, counts
  a report of a revision it already holds once, and refuses one of a lower
  revision as a stale replay that never moves the acknowledgement past an
  update the hub did not keep. The record's own generation is stored for
  display and never decides the replacement. The host
  keeps a durable checkpoint of what the hub acknowledged, per incarnation,
  and a tick resends everything after it; after `hello` shows a hub with no
  memory of the host's incarnation (a deleted database) the host backfills
  from its records in full. The hub never asks a host for anything, so
  what the source feed needs on demand is replicated here ahead of the
  asking.
- **`claim`, `check`, `renew`, `end`**: the shared records interface
  (`plugin/shared/records/shared.ts`) over HTTP, with a lease on each
  claim. The host renews the claims of the sessions it still holds at each
  tick and each probe, so a lease outlives several missed probes and
  lapses only when the host has stopped calling.
- **`offers(slots)`**, from the last stage: work the hub suggests for the
  host's free slots ([Handing out work](#handing-out-work)).

A dashboard reads the hub through the source feed, `snapshot()` and
`changes(since)`, which the dashboard's design defines, with every fact
stamped with the host it came from. No host is asked anything for it; the
hub serves the copies the hosts reported.

### Reading the forge and the tracker once

- **The same reads, made once.** The hub runs the reads the tick runs today
  (each repository's query of open pull requests with their checks, threads
  and comments; merged pull requests and their follow-up markers; the
  board; each tracker's queues) once for all the hosts that dispatch a
  repository, and serves the result to each of them. It uses the same
  adapters as the dispatcher, so a tracker Jig supports is supported by the
  hub with no code of its own.
- **Polling first, with the cheap reads.** The hub asks the forge with
  conditional requests, which name the version it already holds and cost
  nothing against GitHub's hourly limit when nothing changed, and asks the
  tracker the change probe's small question before a full read. A hub
  behind a home router works this way with no inbound route.
- **Webhooks when the hub can receive them.** A hub with an address the
  forge and the tracker can reach may take their webhooks: the payload
  read and authenticated, each delivery kept once by its delivery id, and
  then treated only as a hint to read that target again. A webhook can be
  late, missed or sent twice, so the periodic read stays the truth, and the
  hub counts each delivery before it stores anything, so a failed store
  still shows.
- **Every budget is watched.** The hub keeps a budget per credential for
  every bucket it spends, GitHub's GraphQL points included, and stops
  reading a bucket before it is spent. Its status shows each bucket and the
  age of its newest read per repository. A reader that has quietly stopped
  shows as a growing age, and `jig doctor hub` fails on it.

### Claims and leases

The forge claim stays the fence for a drive launch, and the tracker claim
for a pickup ([dark-factory-dispatch.md](dark-factory-dispatch.md#the-records-it-reads)).
The hub's claims sit in front of them:

- **A grant before the fence.** A tick asks the hub for the launch before
  it writes the forge claim. The hub grants it to one host, and the others
  hear "held by" at once rather than after a read-back. The forge claim
  follows, written and read back as today. When the forge says otherwise,
  the forge wins and the host ends its grant.
- **Pickups get a claim before a session opens.** The shared target widens
  from a pull request to a work key, an item's key as well, so two hosts
  dispatching one repository's pickups are less likely to both open a
  workspace for one item. Two hosts can still each read themselves as the
  holder, for instance after a hub outage; the tracker claim inside
  `do-item` stays the fence, and it arbitrates between hosts only with
  `do_item.claim_marker` set, best effort on a lagging listing. The
  dispatcher's double-claim watch is the backstop.
- **A silent host's claims lapse in the hub, not on the forge.** A lease
  the host stopped renewing lapses, and the hub grants that work to
  another host. The forge's own marker is not reinterpreted: an unfinished
  claim still fences a launch for every reader, the skills included, since
  they never consult the hub. A replacement that holds a hub grant
  therefore still takes the forge's own path past the old claim, which
  exists for a drive alone: its takeover, which needs its ledger's
  heartbeat past the lease window. A follow-up's marker has no such path:
  the earlier trusted marker keeps precedence, so a silent host's
  unfinished follow-up is not recovered automatically, and the hub names it
  in the stopped-host notice for a person. A lapsed lease alone never
  releases a forge claim. Making an unfinished claim cease to fence for
  every reader needs a change to the shared records protocol that every
  reader understands, and is its own item. A host that is not enrolled
  reads the claim as live, as it does today.
- **A host back from an outage replays.** On its first `hello` after the
  hub was unreachable, a host sends the claims its launch records still
  hold, and the hub restores each one no other host has been granted
  since.

Writing no forge claim at all, with the hub as the only fence, is left out
([Left out](#left-out)).

### A stopped host, noticed

A host that has not called the hub for three of its own tick intervals is
reported silent: on the hub's page, through the source feed as a card on
every dashboard that reads the hub, and once as a notice to the people the
hub's configuration names. The hub does nothing to the silent host's work;
the notice lists its unfinished follow-ups, which no other host can resume
by itself. Its leases lapse on their own, and its sessions, if they still run, keep
running.

### Owner duties

Today each host's machine file says whether it owns a repository's
notices, labels, board, serialization holds, steward and reflection
findings, and two hosts that both claim a repository are only reported.
From stage 2, `hello` names the owner of each repository: the host that
claimed it first, until that host goes silent, then the next. Until then the
machine file decides, as today. Two hosts
must never hold a duty at once, since a host cut off from the hub alone
would otherwise keep its duty while the hub names another. So the owner
holds its duty under a lease of its own, renewed with each call, and a
host does an owner's effects (notices, label and board writes, the
steward, reflection findings) only while its lease is current. A host
starts an effect only when at least a drain margin of the lease remains,
a margin longer than the effect's own deadline, and stops starting
effects when renewal fails. The hub names a new owner only after the old
lease has lapsed and one drain margin more, so an effect begun in time has
finished before the next owner starts. The residual risk is an effect that
outruns its own deadline, such as a forge write that stalls past it: two
such writes of one notice or label are repeats the forge shows, not
damage, and a notice carries a key so a second is dropped.
While the hub is unreachable a host does only the effects that are safe
to repeat, such as reading, and does none of the rest until it reaches
the hub again, or until a person's machine file says the host owns the
repository without a hub, as today. This is the one exception to "works
as it does today": it is stated in the levels above, in ADR-0016's
decision and in stage 1's and stage 2's acceptance, so an implementation
never restores a duty during a partition. The duties stay on hosts; moving any
of them into the hub itself waits until a duty is shown to need it.

### Handing out work

The last stage lets the hub suggest which host takes which work. A tick
with free slots asks `offers` with its slots, the accounts and agent kinds
it can run, and the repositories it has clones of. The hub answers with
items and pull requests in the order its policy gives
([How offers are ranked](#how-offers-are-ranked)), skipping what the host
cannot take. "Nothing for you" is an answer of its own.

An offer is only an input to the tick's plan: the host still applies its
own admission (slots, load, walls) and still needs the hub's grant and the
fence. A host that ignores an offer, or never asks for one, dispatches as
it does today. Handing out work coordinates the hosts, which
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines;
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
decides it for enrolled hosts only.

### How offers are ranked

How the hub orders the work it offers is a policy, and teams will want
different ones: one shares hosts fairly between repositories, another
keeps a host on the work it started, a third sends the oldest item first.
So the order is declared as data in the hub's settings, as a route is
([ADR-0009](../docs/adr/ADR-0009-routes-are-derived-by-rules-as-data.md)),
never written into the hub's code and never asked of a model, and a
strategy the built-ins lack can be added without changing them.

- **Filters come first and are not policy.** A candidate the host cannot
  take is never offered. That covers a repository the host has no clone
  of, a route whose agent kind none of its accounts runs, work on hold,
  and a change area another launch holds. These follow the fences and the
  tick's own admission, so no policy can turn them off.
- **Then an ordered list of rankers.** A policy is a list of rankers, each
  named, with settings of its own. A ranker is either about the work
  (`queue`, `age`, `facet`, `repository-share`) and gives each candidate
  a value, or about the host (`affinity`, `free-slots`, `load`,
  `host-preference`) and compares the hosts eligible for a candidate.
  Candidates are ordered by the work rankers, the first deciding and the
  next breaking ties. The `weighted` ranker combines other rankers' values
  with weights, for a team that wants a blend rather than an order.
- **Then an allocation, by the host rankers.** A host is eligible for a
  candidate when it passes the filters and has called within one of its
  tick intervals. The hub offers a candidate to the requesting host only
  when no other eligible host ranks ahead of it under the host rankers,
  in the same order of first and tie-breaking. So a host with fewer free
  slots no longer takes work first by asking first, and a host that is the
  only eligible one is always offered it.
- **One list across repositories.** Each repository's candidates are
  ordered under the policy that repository names, and the lists are
  merged by taking one candidate from each repository in turn, repositories
  ordered by the age of the oldest waiting candidate at their head, then
  by name. A merged order is therefore deterministic and fixtures can
  assert it.
- **The default policy** is the work ranker `queue` (the queue's order, as
  the tracker and the steward set it), then the host rankers `affinity`
  (the host that already holds the work's workspace or ran its last round)
  and `free-slots` (the host with the most free slots).
- **More built-ins join behind the same interface**, each a ranker added
  with no change to the others or to the hub's callers. Likely ones:
  - `age`, longest waiting first (a work ranker);
  - `facet`, by a priority or size the tracker keeps
    ([tracker-facets.md](tracker-facets.md));
  - `repository-share`, so one repository's long queue does not starve
    the others;
  - `host-preference`, hosts a repository or an item asks for (a host
    ranker);
  - `load`, the host whose load factor is lowest (a host ranker).
- **A ranker of a team's own: `command`.** It runs a program the hub's
  settings name, hands it the host and the candidates with their facts as
  JSON on standard input, and reads back an order or a value per candidate
  on standard output, within a 2-second deadline. A command that fails,
  times out or answers out of shape is skipped for that offer and shown on
  the hub's status, and the rest of the policy still ranks. Only the hub's
  own settings name a command, never a repository's file, since the hub
  runs it with its own identity.
- **Named policies, chosen per repository.** The hub's settings define
  policies by name and a default. A repository may name one of them in its
  `.config/jig.yaml`, read from its default branch: a choice of data,
  never a program.
- **Every offer explains itself.** An offer carries each ranker's value and
  the ranker that decided its place, and `jig hub offers --explain <host>`
  prints the order for a host's free slots without offering anything.
- **A policy is checked when it loads.** An unknown ranker or setting is
  refused by name, and the hub keeps its last good policy. Policies are
  tested as data: fixtures of hosts and candidates, and the order each
  must give.

### One view of every host

The hub serves the source feed, so a dashboard that names the hub as its
source shows every enrolled host's work, each fact stamped with its host,
and its Needs you covers them all. The hub's machine runs a dashboard server of its own that names the
hub as its source and serves the page; the hub's front routes the page to
that server, never to the hub's host-facing protocol port, so the page
still talks only to its own dashboard server. The front also routes one
more path, `/feed`, to the hub's feed endpoint, which serves only the
source feed's reads (`hello`, `snapshot`, `changes`, `log.rows`,
`receipt.get`, `thread.get`) to a viewer the front names: a laptop's dashboard reaches
the hub there. The hub reads the viewer and its grant from the headers on
the front's own socket, as the dashboard does, and filters every answer
by that grant; the endpoint takes no host calls, which stay on the
protocol port. A phone reaches that page through
a private-network front, as it reaches a host's page today
([dispatch-dashboard.md § A front on a private network](dispatch-dashboard.md#a-front-on-a-private-network)),
and sees every host at once. The views API between a page and its own
server does not change. This is the dispatch dashboard's only way to show
several hosts: a person with several machines runs a hub in its smallest
form, on the host that already dispatches.

People sign in to the hub's page through that front, which names the
viewer, and see the repositories its grants give them. A sign-in of the
hub's own, for a team without a private network, is left out until a team
needs it.

### How it fits the rest of Jig

| Part of Jig | Without a hub | With a hub |
| --- | --- | --- |
| `do-item`, `drive-pr`, `work-batch` and the review skills | Their own fences | Unchanged: they never call the hub |
| The dispatcher's tick | Reads the forge and the tracker itself | Reads through the hub, asks it before each claim, reports its records; falls back to reading itself |
| The change probe | Asks the forge and the tracker once a minute | Asks the hub `changes` |
| `jig ask`, `jig send`, `/jig:operator` | Read this machine's records and the forge | `ask` may read another host's records from the hub; `send` still writes as the person, never through the hub |
| The dispatch dashboard | Shows its own machine | May read the hub's feed and show every host |
| The Jig plugin for Orca | Reads this machine's line | Unchanged; reading the hub's feed is a later step of its own |
| The steward, notices, labels, reflection | On the host whose machine file owns the repository | On the host the hub names owner |
| `jig gc` | Cleans the host | Also trims the hub's database where it runs |
| The records registry | The machine, the working tree, the forge and tracker | One more medium, the hub, for its enrollments, leases and copies |

### Where it lives

`jig hub` is `plugin/hub/`, registered in `plugin/jig.ts` beside `dispatch`,
`gc`, `ask` and `send`, and released with the plugin, so a host and its
hub agree on the protocol by version. `jig install hub` installs
`jig hub serve` as a resident job, restarted when it fails and when the
installed copy changes, the way the dispatch dashboard's reader is
installed. The hub's own settings are in a file of its own on the machine
it runs on (its address, database path, forge and tracker identities, the
people it notifies); a host names its hub in its machine file (`hub.url`),
and keeps the credential `jig hub join` gave it in its state folder.

## Build order

One pull request per step, each shippable alone. The seams come first and
are worth building for themselves: each makes the dispatcher easier to test
and closes a gap it has today, so building them costs nothing if the hub
never ships. Each later stage is planned in detail, and built or not, by
the person who asked for the hub, once the stage before it is in use.

**Seams, inside the dispatcher.**

1. **One shared records implementation, chosen by setting.** The tick, the
   follow-up marker, `jig ask` and the comment listing reach claims only
   through `SharedRecords`, chosen by `records.shared`, rather than calling
   the forge's implementation and parsing comments directly.
2. **The world view apart from the machine view.** The tick's reads of
   the forge and the tracker go through one interface its caller can
   supply, with `fresh(target, notOlderThan)` for the check before an act,
   and the observe phase stops rewriting forge facts with this host's
   launch records.
3. **A pickup claim.** The shared target gains a work key, and a pickup
   publishes a claim before its workspace opens, on the forge and tracker
   medium that already exists.
4. **The GraphQL budget gated.** The tick reads GitHub's GraphQL bucket
   and stops reading it before it is spent, as it already does for REST.

**Stage 1: the hub reads once.** `jig hub serve`, enrollment, `hello`,
`changes` and `read`, the hub's read cache with conditional requests and
its budgets, `jig install hub`, `jig hub status` and `jig doctor hub`; the
tick and the change probe use the hub when the machine file names one, and
fall back when it does not answer. Done when two hosts dispatching the same
repositories through one hub spend, together, about what one host spends
alone, and a hub stopped mid-tick costs that tick nothing but its
receipt's note. In this stage `hello` names no owner and no lease exists:
each repository's owner is the host its machine file names, as today, so
nothing about owner duties changes until stage 2.

**Stage 2: claims with leases, and a silent host noticed**, once
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
is approved, since grants and owner leases coordinate hosts, which
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines. The hub's
implementation of `SharedRecords` in front of the fences, pickup claims,
leases and their renewal, the replay after an outage, the owner named by
`hello` with its lease, the restart quarantine, and the silent-host notice.
Done when no two hosts do an owner's effects at once through a partition
and a restart of the hub.

**Stage 3: one view of every host.** `report`, the hub's copies of host
records, the source feed served from them, and the dashboard reading it,
through a front for a phone.

**Stage 4: handing out work**, once
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
is approved. `offers` and the tick's plan taking them as input, with the
offer policy, its default rankers and `jig hub offers --explain`; then the
`command` ranker, a step of its own; then each further built-in ranker,
one at a time, when a team asks for it.

## Left out

- **The hub as the only fence.** Dropping the forge claim once every host
  is enrolled would save its writes, but the forge claim is what a host
  outside the hub, or one cut off from it, reads. It is reconsidered once
  stage 2's grants have shown how often the forge disagrees with them.
- **Cancelling or steering a host's session from the hub.** A session is
  the host's; the hub's notices go to people, and `jig send` stays the way
  a person steers.
- **More than one node, or a database server.** One process with SQLite
  carries the size Jig is built for; a hub that outgrows it is a decision
  of its own.
- **A hub's own sign-in for people.** The private-network front names the
  viewer; a sign-in of the hub's own waits for a team that cannot use one.
- **Hubs talking to each other**, and a host enrolled in two hubs.
- **A dashboard that reads each host over SSH.** It would be a second way
  to build one view across hosts, with none of the hub's single read, its
  notice of a stopped host or its view on a phone.
- **Serving the reads a session makes.** A drive's own reads of its pull
  request stay with its account; they are not multiplied across hosts.
