# The hub, a shared control plane for many dispatchers: design

**What problem this solves.** Each host that runs Jig's
[dispatcher](../GLOSSARY.md) reads the forge (the service that hosts the
repositories and their pull requests) and the tracker by itself, on its own
timer. One host is fine. Several hosts that dispatch for one team or one
person read the same pull requests and the same queues several times over,
against limits that belong to one credential or one organization: Linear,
for one, allows each person's keys 2,500 requests an hour between them. A
host sees another host's work only through the forge, a tick behind. A
host that dies leaves its launch claims on the forge until a person
deletes them. One repository's pickups can be dispatched from one host
only, since nothing claims an item before a session opens. Nobody outside a
host learns that it stopped. A person with several machines has one
[dispatch dashboard](../GLOSSARY.md) per machine and no view of all of
them. With this built, an optional service, the [hub](../GLOSSARY.md),
reads the forge and the tracker once for every host enrolled in it. It
also holds claims with leases that lapse when a host goes silent, offers
work to whichever host has a free slot, tells a person when a host stops
and serves one view of every host's work. A host that never enrolls loses
nothing, and a host whose hub is unreachable works exactly as it does
today.

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
  has not answered. Running sessions never notice.
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
  the tracker, and its copies of host records come back at each host's
  next tick. A lost lease lapses on its own, and the fence behind it still
  holds. So deleting the hub's database costs a fresh enrollment of each
  host and nothing that the line depends on.
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
- **The hub reads with an identity of its own**, which the organization
  creates and the hub's configuration names: a GitHub App installation, or
  for the smallest form a read-only token; a Linear or Jira credential
  for the tracker. That identity also writes the few records the hub
  writes on the forge, and the forge's arbitration trusts it like Jig's
  own login.
- **A person's act is made with that person's credential.** Merging,
  answering a park and every write a dashboard makes for a person go from
  the person's own machine, as the person, never through the hub. The hub
  holds no person's credential.
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
([ADR-0012](../docs/adr/ADR-0012-failures-as-values.md)).

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
- **`report(records)`**: the records a tick wrote that the hub serves on:
  the line, each launch's start and end, outcome rows, the drive ledgers'
  digests. Each record goes in the envelope Jig already uses, with its key
  and generation, so a report sent twice counts once.
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
  dispatching one repository's pickups no longer both open a workspace for
  one item. The tracker claim inside `do-item` stays the fence.
- **A silent host's claims lapse.** A lease the host stopped renewing
  lapses, and every enrolled host then reads that host's forge claim as
  ended, with no write on the silent host's behalf. A takeover of a drive
  still needs its ledger's heartbeat past the lease window, never a lapsed
  claim alone. A host that is not enrolled keeps reading the claim as live,
  as it does today.
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
hub's configuration names. The hub does nothing to the silent host's work.
Its leases lapse on their own, and its sessions, if they still run, keep
running.

### Owner duties

Today each host's machine file says whether it owns a repository's
notices, labels, board, serialization holds, steward and reflection
findings, and two hosts that both claim a repository are only reported.
With the hub, `hello` names the owner of each repository: the host that
claimed it first, until that host goes silent, then the next. A host takes
an owner's duty only when the hub named it, and while the hub is
unreachable, only when its own machine file says it owns the repository,
as today. The duties stay on hosts; moving any of them into the hub itself
waits until a duty is shown to need it.

### Handing out work

The last stage lets the hub suggest which host takes which work. A tick
with free slots asks `offers` with its slots, the accounts and agent kinds
it can run, and the repositories it has clones of. The hub answers with
items and pull requests ranked by the queue's order (the tracker's, as the
steward ordered it), skipping work in a change area another launch holds
([serialized areas](dark-factory-dispatch.md)), and preferring the host
that already holds a piece of work's workspace. "Nothing for you" is an
answer of its own.

An offer is only an input to the tick's plan: the host still applies its
own admission (slots, load, walls) and still needs the hub's grant and the
fence. A host that ignores an offer, or never asks for one, dispatches as
it does today. Handing out work coordinates the hosts, which
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines;
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
decides it for enrolled hosts only.

### One view of every host

The hub serves the source feed, so a dashboard that names the hub as its
source shows every enrolled host's work, each fact stamped with its host,
and its Needs you covers them all. A phone reaches the hub's page through
a private-network front, as it reaches a host's page today
([dispatch-dashboard.md § A front on a private network](dispatch-dashboard.md#a-front-on-a-private-network)),
and sees every host at once. The views API between a page and its own
server does not change.

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
receipt's note.

**Stage 2: claims with leases, and a silent host noticed.** The hub's
implementation of `SharedRecords` in front of the fences, pickup claims,
leases and their renewal, the replay after an outage, the owner named by
`hello`, and the silent-host notice.

**Stage 3: one view of every host.** `report`, the hub's copies of host
records, the source feed served from them, and the dashboard reading it,
through a front for a phone.

**Stage 4: handing out work.** `offers` and the tick's plan taking them as
input, once
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
is approved.

## Decisions for a person

Each has a recommendation; the person who asked for the hub decides before
the step that depends on it.

- **The name.** Recommended: the hub, `jig hub`. The word is free since the
  dispatch dashboard stopped using it.
- **Where it lives.** Recommended: in the plugin, released with it, so a
  host and its hub never disagree about the protocol. The alternative is a
  repository of its own, which a team would deploy apart from the plugin.
- **One view across machines without a hub.** The dispatch dashboard's
  stage 2 plans a laptop that reads each host over SSH and shows them
  together. Recommended: drop that path, and let a person with several
  machines run a hub in its smallest form on the host that already
  dispatches. The hub then gives that person the same view, plus the phone,
  the silent-host notice and the single read. Keeping SSH means two ways to
  build one view; dropping it means one more process for that person.
  Either way the source feed's protocol stays.
- **What the hub stores of the forge's text.** Recommended: it keeps what
  it serves, comment text included, on the machine the organization
  chose, as each host's own records do today. The alternative keeps only
  references and reads text through on each request, at the cost of the
  reads the hub exists to save.
- **How a host's offers are ranked.** Recommended: the queue's order, then
  a host that already holds the work's workspace, then the host with the
  most free slots.

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
- **Serving the reads a session makes.** A drive's own reads of its pull
  request stay with its account; they are not multiplied across hosts.
