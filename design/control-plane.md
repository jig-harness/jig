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
is told of every change by the forge's and the tracker's
[webhooks](../GLOSSARY.md), keeps one [world view](../GLOSSARY.md) of
them for every host enrolled in it and is the only one of them that reads
the forge and the tracker for the dispatcher. It also grants claims with
leases, so a silent host's work goes to another host, offers work to
whichever host has a free slot, tells a person when a host stops and
serves one view of every host's work. A host that never enrolls loses
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
item 42), the addresses that `jig ask` and `jig send` derive
([addresses.md](addresses.md), item 39), and the governed transports for
outbound calls ([outbound-calls.md](outbound-calls.md), item 55).

## How it works

### Levels of use, each whole without the next

Jig is used at the levels below, and a team stops at whichever suits it:

| Level | What runs | What it adds |
| --- | --- | --- |
| Skills | A person's session runs `do-item`, `drive-pr` and the other skills by hand | Each piece of work driven to merge-ready, with its own fences: the drive's lock and ledger claim, the tracker claim |
| Dispatcher | A timer on each host runs the tick | Work started and kept moving with nobody watching, one host's dashboard |
| Hub | One more service that enrolled hosts call | One world view of the forge and tracker for every host, fed by their events; claims with leases, offers, a stopped host noticed, one view across hosts |

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

The hub is one service: a [portable core](../GLOSSARY.md) that holds all
of its logic, and an [adapter](../GLOSSARY.md) that runs the core on one
kind of platform. The core reaches the world only through a few small
[ports](../GLOSSARY.md) (storage, serving requests, scheduling, outbound
calls and observability), and each adapter implements them for its
platform ([The portable core and its adapters](#the-portable-core-and-its-adapters)).
The adapters designed so far are:

- **The process adapter**, built first: `jig hub serve`, one Bun process
  with one SQLite database, part of the `jig` plugin like the dispatcher
  and `jig gc`, and the same process shipped as a container image for a
  team that runs containers. It runs on any machine its hosts reach over
  HTTPS: in its smallest form on the always-on host that already
  dispatches, or on a small server or a team's machine.
- **A serverless adapter**, built second: Cloudflare Workers, with the
  hub's state in a Durable Object's SQLite storage or in D1 (Cloudflare's
  SQLite database service), and its scheduled work on alarms and cron
  triggers. It is one implementation of a serverless adapter; another
  platform is another adapter, with no change to the core.

Whatever the adapter, the hub opens no connection to a host: hosts call
it, and it calls the forge and the tracker. A host enrolls in at most one
hub. One hub serves one person or one organization; hubs do not talk to
each other.

The hub is the only resident service the hub level adds. The dispatcher
keeps no process running on any host
([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)): its tick and
its change probe run on the host's timers, and each makes request and
answer calls to the hub while it runs. A host that keeps a waiter running
for early wake-ups may hold one call open instead, as a long poll, but
nothing requires it.

### The portable core and its adapters

The core is plain TypeScript that runs on every adapter unchanged. It
holds the host protocol, webhook intake, the world view, the
reconciliation sweep, claims and leases, offers and the source feed. What
differs between platforms sits behind a port:

| Port | What the core asks of it | Process adapter | Cloudflare adapter |
| --- | --- | --- | --- |
| Storage | Named operations on the hub's tables, each change atomic ([Storage](#storage)) | SQLite through `bun:sqlite` | A Durable Object's SQLite storage, or D1 |
| Serving | A request in, a response out, with the caller's credential or the webhook's signature headers | Bun's HTTP server | The Worker's `fetch` handler |
| Scheduling | Run a named job at a time or on a cadence, and run one soon | Timers in the process, with each job's next run kept in storage | Durable Object alarms and cron triggers |
| Outbound | A call to the forge or the tracker through its [governed transport](../GLOSSARY.md), over `fetch` | The shared outbound library, its budget record and cost ledger kept through the storage port | The same |
| Observability | Typed events, metrics and spans ([Observability](#observability)) | OpenTelemetry's protocol (OTLP) to a collector the team names | The platform's own logs and metrics, or OTLP export |

These rules keep the core portable:

- **No subprocess, no runtime-bound module, no local file.** The core
  never runs `gh` or any other program: its forge and tracker calls are
  `fetch` requests through the shared outbound library
  ([ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md)). It
  imports no `bun:` module and no `node:` module, and reads and writes no
  file; what it keeps, it keeps through the storage port. A gate reads
  the core's imports and fails on any of these, and on an import from
  outside the core that brings one in. An import scan cannot see a
  runtime global such as `Bun.file` or `Bun.spawn`, which needs no import,
  so the gate also fails on a reference to a runtime global (`Bun`,
  `process`, `Deno`), and its negative fixtures include those
  import-free violations.
- **What the core shares with the plugin is portable too.** The core uses
  `Outcome` from `plugin/shared/outcome.ts`, which imports nothing and runs
  anywhere. The outbound library's portable parts (the failure classes,
  retry, paging, the conditional request, the budget's arithmetic) are
  split from the parts that open the machine's budget database or run
  `gh`, so the core imports the first and an adapter supplies the second's
  storage. The same gate holds the split: a shared module the core imports
  is held to the core's rules.
- **A ranker that runs a program is the process adapter's alone.** The
  `command` ranker ([How offers are ranked](#how-offers-are-ranked)) runs
  a program, which a serverless platform cannot; a policy that names it is
  refused when it loads on any other adapter, by name. Every built-in
  ranker runs on every adapter.

### Storage

- **One schema, through Drizzle.** The hub's tables are declared once with
  [Drizzle](../GLOSSARY.md), an object-relational mapper (ORM) for
  TypeScript, in its SQLite dialect, and the storage port's operations are
  written with Drizzle's query builder. Drizzle's drivers for `bun:sqlite`,
  D1 and Durable Object SQLite run the same schema and the same
  operations, so the process adapter and the Cloudflare adapter share one
  implementation of the port. Migrations are SQL files that `drizzle-kit`
  generates from the schema and that are checked in; each adapter applies
  them when the hub starts, and how they reach the platform is the
  adapter's. The process adapter reads the checked-in files with Drizzle's
  `bun:sqlite` migrator. Drizzle's D1 migrator reads them from disk, which
  a Worker cannot, so the Cloudflare adapter applies them as a
  deployment-time D1 migration, or bundles the journal and the SQL as
  strings for the Durable Object migrator. The core's bundle holds no
  migrator that reads the filesystem.
- **Queries both dialects can run.** The operations use what SQLite and
  PostgreSQL both support: plain tables, primary and unique keys, `INSERT
  … ON CONFLICT`, conditional `UPDATE … WHERE … RETURNING`, no JSON
  operators in a query (a JSON body is stored and returned whole), no
  dialect's own functions. Times are stored as integers of milliseconds.
- **PostgreSQL is designed for and built on demand.** When a team needs a
  managed database (Cloudflare's Hyperdrive, for one, reaches PostgreSQL
  from a Worker), a PostgreSQL adapter adds a second schema module in
  Drizzle's PostgreSQL dialect and a second implementation of the storage
  port's operations against it, since Drizzle's query builders are typed
  per dialect. A test reads both schema modules through Drizzle's table
  descriptions and fails on any difference in tables, columns, types,
  nullability or keys, and both implementations pass one contract suite
  for the port.
- **Drizzle is vendored.** Code that runs from the plugin depends on Bun's
  built-ins and code vendored beside it
  ([ADR-0001](../docs/adr/ADR-0001-bun-typescript-toolchain.md)). The
  hub imports Drizzle from a bundle Jig builds from the pinned package,
  unminified and compared byte for byte by a test, with its licence and
  its line in NOTICE, as Optique is. The container image and the
  Cloudflare adapter's build import that same bundle, so every adapter
  runs one copy at one version. `drizzle-kit` is a development dependency
  only: it writes the migrations and never ships. Both packages are pinned
  exactly and wait out the supply-chain cooldown like every other.

### Concurrency and failures

The hub handles webhook deliveries, host calls, the sweep and lease
renewals at once. Its programming model is still
[ADR-0012](../docs/adr/ADR-0012-failures-as-values.md)'s, so the plugin
and the hub read alike:

- **Failures are values.** The core and every adapter return an `Outcome`:
  the value, or a failure with a stable `code`, a plain `reason` and the
  `cause` that was thrown. An I/O edge (a port's implementation) turns
  what its platform throws into one. Anything else that throws is a
  `Defect`, caught once at a defect boundary and reported with its stack.
- **Each unit of work is a defect boundary with a deadline.** A unit is
  one webhook delivery, one host call or other request, one run of the
  reconciliation sweep, and one alarm or lease turn. It carries one
  cancellation signal (the standard `AbortSignal`, in both runtimes) with
  its deadline into every port call, and a defect ends that unit only: a
  request answers with a coded failure, a delivery is left for the sweep,
  and a job's next run starts from its stored progress.
- **No state shared in memory between units.** What a later unit needs is
  kept through the storage port, so no unit depends on memory outliving
  its request. A platform may keep memory between requests (a Durable
  Object can stay active), and the core never relies on it.
- **A change never spans an await.** Every change is either one
  conditional statement (a lease granted only `WHERE` it is free or
  lapsed, an acknowledgement moved only `WHERE` the revision is higher), or
  a batch of statements prepared before the first is sent and committed
  together through the storage port's atomic batch: a synchronous
  transaction on `bun:sqlite` and Durable Object SQLite, a batch on D1, a
  transaction on PostgreSQL. The decision sits in the statement's
  condition, never in code between a read and a write.
- **Background work runs only as scheduled jobs.** The sweep, the
  silent-host check and the trimming of old rows run through the
  scheduling port, each idempotent, resumable from progress it stores,
  and held by a job lease row so two runs of one job never overlap. One
  small helper runs a job's steps under its deadline and its lease; no
  library of structured concurrency is needed beyond it.

### Reaching the hub: only the webhook path is public

The hub serves several kinds of caller, and only one of them is public:

- **`/webhooks/<source>`** takes the forge's, the tracker's and, where the
  hub runs a chat bridge, the chat tool's deliveries. It is the only path
  reachable from the internet, because those systems call from it. Every
  delivery's signature is checked before anything else is read
  ([The world view](#the-world-view-events-first-reconciled)).
- **The host protocol, `/v1/`**, is reached by enrolled hosts only, over a
  private network or the hub's own machine, with the host's credential.
- **The page and the source feed** are reached through a
  [private-network front](../GLOSSARY.md) that names the viewer
  ([One view of every host](#one-view-of-every-host)).

On the process adapter, the public path is published by a
[tunnel](../GLOSSARY.md): a connection the hub's machine opens outward to
a tunnel provider, which forwards requests for `/webhooks/` and nothing
else to the hub's webhook listener. Cloudflare Tunnel and Tailscale Funnel
are two implementations; the tunnel's own path rule and a listener of the
hub's that serves only `/webhooks/` both hold the boundary, so a mistake in
one still exposes nothing else. The dashboard and the host protocol are
never published through it: the dispatch dashboard is published to a
private network only
([dispatch-dashboard.md § Left out](dispatch-dashboard.md#left-out)), and
that holds for the hub's page too. The dispatcher on the same machine
gains no route at all
([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)).

On the Cloudflare adapter every path has a public address, so its wave
puts an identity-checking front (Cloudflare Access, for one) in front of
every path but `/webhooks/`, with each host's credential checked behind
it as well.

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
  Its world view holds the forge's and the tracker's facts as they were
  last told or read, each with its version, never a state the hub decided.
- **No server timer rewrites a host's work.** A lapsed lease releases the
  claim it held and nothing else: the hub never marks a host's session
  failed, never cancels one and never counts it against the host. What
  happened to the session is the host's to report. A lease lapses by its
  expiry time, compared when the lease is read; no job moves it.
- **What the hub stores is rebuildable**, except its enrollments and the
  leases it granted. Its world view comes back from a full reconciliation
  sweep, and its copies of host records come back when each host
  backfills after its next `hello`
  ([`report`](#the-host-protocol)). A lost lease lapses on its own, and the fence behind it still
  holds. A hub started with no database waits out a quarantine as long as
  the longest lease it ever grants before it grants an owner duty or a new
  claim, since a host may still hold an unexpired lease the hub no longer
  remembers; reads, reports and enrollment go on meanwhile. So deleting the
  hub's database costs a fresh enrollment of each host and a quarantine
  of one lease lifetime, and nothing that the line depends on.
- **It keeps what it serves**, comment text included, on the machine or
  the platform account the organization chose, as each host's own records
  do. Reading the text through on each request instead would spend the
  reads the hub exists to save.
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
  creates and the hub's configuration names. On GitHub that is a
  [GitHub App](../GLOSSARY.md) of the hub's own, installed on the
  repositories it serves: one App webhook covers every repository of the
  installation, and the hub's reads count against the installation's own
  limits, not any person's. On Linear it is a credential with a signed
  webhook, and on Jira a credential the sweep reads with. The hub writes
  nothing on the forge or the tracker: the forge claim and the tracker
  claim are written by the hosts, as today, so the App needs read access
  only. A hub that is later given a write (a notice on the forge, say)
  names that write and its permission here first. The one named is the
  [chat bridge](chat.md)'s, where a hub runs one: under the bridge's own
  forge app identity, an answer comment and the `drive`, `hold` and
  `release` labels on a pull request (the app's Issues and Pull requests
  write permission), and under the hub's tracker credential the assignment
  `/jig pickup` makes, each with a record naming the person who asked.
- **The hub hands out no credential for the forge or the tracker.** It
  never mints a token, short-lived or not, for a host to act with: a host
  that writes uses its own accounts, and a host whose hub is down still
  holds everything it needs.
- **A person's act is made with that person's credential.** Merging,
  answering a park and every write a dashboard makes for a person go from
  the person's own machine or browser, as the person, never through the hub. The hub
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
([ADR-0012](../docs/adr/ADR-0012-failures-as-values.md),
[Concurrency and failures](#concurrency-and-failures)).

- **`hello`**: the host's stable id, its dispatcher's incarnation (the id
  its state database got when it was created), its Jig version, its
  capabilities and the repositories its machine file lists. The hub
  answers with its own capabilities, the repositories it serves for this
  host and, for each, the host that owns it
  ([Owner duties](#owner-duties)). A tick calls `hello` first; a failed
  `hello` sends the whole tick to the level below.
- **`changes(token)`**: what changed in the world view since the host's
  last token, as a list of repositories and tracker queues, and a new
  token. The answer carries no content: it says where to look, and the
  host's next tick reads there. A lost answer costs a wake-up and nothing
  else, since the timer's tick reads everything anyway. The change probe
  calls it in place of its own forge and tracker queries, and wakes a tick
  for the repositories it names, as it does now.
- **`read(targets, notOlderThan)`**: the forge's and the tracker's facts
  for each target (a repository, a pull request, a queue, an item), each
  with the time it was last confirmed. The hub answers from its world view
  when its copy is at least as new as `notOlderThan`. An applied delivery
  moves a fact's copy, never its confirmation time: a delivery can be lost
  before the hub admits it, so a fully processed queue does not show the
  source is current. The confirmation time is that of the last authoritative
  read (a read-through or a reconciliation sweep), unless the source supplies
  a verifiable completeness watermark, which confirms the target up to it.
  Otherwise, when the bound has expired, the hub reads that target through
  with its own identity before answering. When its own
  budget is spent it says so with the time it resets, and the host reads
  for itself only if its own budget allows. A target no event feed covers
  (a tracker whose deliveries the hub cannot verify) is still read at the
  tick's interval, and that polling is budgeted, not free. The observe phase asks with
  the tick's interval as the bound; the check just before an act asks with
  a bound of seconds, as `freshDriveReading` and `freshPickup` do today.
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
- **`offers(slots)`**, from a later wave: work the hub suggests for the
  host's free slots ([Handing out work](#handing-out-work)).
- **`health`**: the hub's own state, as [Observability](#observability)
  describes, for `jig doctor hub`, the dashboard and a host's receipt.

A dashboard reads the hub through the source feed, `snapshot()` and
`changes(since)`, which the dashboard's design defines, with every fact
stamped with the host it came from. No host is asked anything for it; the
hub serves the copies the hosts reported.

### The world view: events first, reconciled

- **The hub is the only reader for enrolled dispatchers.** While its hub
  answers, an enrolled host's tick and change probe make no forge or
  tracker read of their own: the observe phase, the change probe and the
  check before an act all go to the hub. Two kinds of read stay with the
  host: the read-back that is part of a fence (the forge claim and the
  tracker claim, which the host writes), and every read a session makes.
  When the hub does not answer, the host reads for itself, as without a
  hub.
- **Events are the main feed.** The forge and the tracker tell the hub of
  each change by webhook: GitHub through the hub's App, Linear through a
  signed webhook of the hub's credential. The hub turns each delivery into
  a change to its world view and the `changes` it serves. Where a payload
  does not carry the whole fact the tick needs (a pull request's checks
  and threads, say), the delivery names the target and the hub reads that
  target once, for every host.
- **Every delivery is verified, then admitted, then applied.** The hub
  checks the delivery's signature with the secret its configuration holds
  (GitHub's and Linear's both sign the body with a shared secret) and
  refuses one that fails, before it parses anything else; a Linear
  delivery whose own timestamp is more than a minute old is refused too.
  It then admits the delivery by its delivery id, in one statement that
  ignores an id it already holds, and answers at once, since the sender
  waits only seconds. A delivery that fails admission is not always sent
  again: Linear retries, GitHub does not redeliver on its own. A failed
  admission therefore waits for the next sweep, which finds the change as
  drift, unless the hub redrives failed deliveries from the forge's
  delivery log. Applying the delivery to the world
  view is a unit of its own, run soon after through the scheduling port; a
  delivery admitted and not yet applied is applied by the next run.
- **Order comes from the facts, not the deliveries.** Every fact in the
  world view keeps the version its source gave it (an update time, a head
  commit, a revision). A delivery older than the fact the hub holds
  changes nothing, and a delivery the hub cannot place reads its target
  instead.
- **A reconciliation sweep catches what the events missed.** A webhook can
  be lost, late, sent twice or out of order, so the
  [reconciliation sweep](../GLOSSARY.md) reads every target the hub
  serves on a slow cadence, hourly by default, with conditional requests
  that name the version the hub holds and cost nothing against GitHub's
  hourly limit when nothing changed; a tracker's change probe asks its
  small question before a full read. Each change the sweep finds that no
  delivery brought is counted as drift
  ([Observability](#observability)). A tracker whose deliveries the hub
  cannot verify (Jira, until it can) is read by the change probe's small
  question at the dispatcher's own interval instead of by webhook.
- **Every budget is watched.** The hub keeps a budget per credential for
  every bucket it spends, GitHub's GraphQL points included, and stops
  reading a bucket before it is spent. Its status shows each bucket, the
  age of its newest event and of its newest sweep per repository. The age
  of the newest event is information only, since a quiet repository sends
  none for days. `jig doctor hub` fails on the sweep's progress, on a
  subscription the forge reports unhealthy and on a failed delivery probe,
  never on silence alone.

### Observability

The hub is observed as [M11](../modules/M11-process-observability/README.md)
says a process must be: a closed set of typed events, every metric wired
to a source, a scheduled job that stops reads as stale, never green, and a
signal outside the hub that notices when the hub itself goes quiet.

- **An observability port.** The core emits typed events, metrics and
  spans, each failure named by its `Outcome` code; an adapter exports
  them. The process adapter speaks OTLP to whatever collector the team
  names; the Cloudflare adapter uses the platform's own logs and metrics,
  or OTLP export. A structured log line carries the failure's `code`, and
  nothing reads a `reason` to classify it.
- **One registry.** The hub's events are declared once and checked by M11's
  event-schema lint, and its metrics are declared in a metric registry
  with their source; M11's no-dark-instruments check fails the gates for a
  declared metric whose registry entry has no source. That check reads the
  registry and does not prove the core emits the metric, so the hub adds an
  emission-coverage check: a test that runs the core and fails on a
  declared metric no run emitted.
- **Signals the first wave ships with:**
  - webhook intake per source: deliveries received, verified, refused,
    and the lag from admission to applied;
  - the reconciliation sweep: its duration, the targets it checked, the
    share answered "unchanged", and drift, the changes it found that no
    delivery brought, which is the measure of whether events can stay the
    main feed;
  - quota spent per credential and per named operation, from the cost
    ledger of [outbound calls](outbound-calls.md), kept through the
    storage port;
  - each host's last-report age, against the host's own cadence: a host
    older than its cadence is stale, never green;
  - the host protocol's latency and coded failures per call;
  - defects caught at each kind of boundary.
- **Health, and a dead-man's switch.** `health` answers each scheduled
  job's class (green, degraded, red, stale or running, from M11's
  [heartbeat classifier](../modules/M11-process-observability/reference/heartbeat/README.md)),
  each feed's age and each budget. The hub's jobs are declared with their
  cadence the way the repository's scheduled jobs are. After each sweep
  the hub sends a heartbeat to an external monitor the team names, which
  alarms when the heartbeat stops, so a hub that stopped entirely is
  noticed by something other than itself. The dispatch dashboard shows the
  hub's health beside its hosts.

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
reported silent, by the hub's silent-host job on the scheduling port: on
the hub's page, through the source feed as a card on every dashboard that
reads the hub, and once as a notice to the people the hub's configuration
names. The hub does nothing to the silent host's work; the notice lists
its unfinished follow-ups, which no other host can resume by itself. Its
leases lapse on their own, and its sessions, if they still run, keep
running.

### Owner duties

Today each host's machine file says whether it owns a repository's
notices, labels, board, serialization holds, steward and reflection
findings, and two hosts that both claim a repository are only reported.
From the wave that brings owner leases, `hello` names the owner of each
repository: the host that claimed it first, until that host goes silent,
then the next. Until then the machine file decides, as today. Two hosts
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
decision and in the owner-lease wave's acceptance, so an implementation
never restores a duty during a partition. The duties stay on hosts; moving any
of them into the hub itself waits until a duty is shown to need it.

### Handing out work

A later wave lets the hub suggest which host takes which work. A tick
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
- **A ranker of a team's own: `command`, on the process adapter only.** It
  runs a program the hub's settings name, hands it the host and the
  candidates with their facts as JSON on standard input, and reads back an
  order or a value per candidate on standard output, within a 2-second
  deadline. A command that fails, times out or answers out of shape is
  skipped for that offer and shown on the hub's status, and the rest of
  the policy still ranks. Only the hub's own settings name a command,
  never a repository's file, since the hub runs it with its own identity.
  A serverless adapter runs no program, so it refuses a policy that names
  `command` when the policy loads.
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
and its Needs you covers them all, with the hub's own health beside them.
The hub's machine runs a dashboard server of its own that names the
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
and sees every host at once. Neither the page nor `/feed` is ever
published through the webhook tunnel. The views API between a page and
its own server does not change. This is the dispatch dashboard's only way
to show several hosts: a person with several machines runs a hub in its
smallest form, on the host that already dispatches.

People sign in to the hub's page through that front, which names the
viewer, and see the repositories its grants give them. A sign-in of the
hub's own, for a team without a private network, is left out until a team
needs it.

### How it fits the rest of Jig

| Part of Jig | Without a hub | With a hub |
| --- | --- | --- |
| `do-item`, `drive-pr`, `work-batch` and the review skills | Their own fences | Unchanged: they never call the hub |
| The dispatcher's tick | Reads the forge and the tracker itself | Reads only the hub's world view, bar a fence's read-back; asks it before each claim; reports its records; falls back to reading itself |
| The change probe | Asks the forge and the tracker once a minute | Asks the hub `changes`, which the events move |
| `jig ask`, `jig send`, `/jig:operator` | Read this machine's records and the forge | `ask` may read another host's records from the hub; `send` still writes as the person, never through the hub |
| The dispatch dashboard | Shows its own machine | May read the hub's feed and show every host, and the hub's health |
| The Jig plugin for Orca | Reads this machine's line | Unchanged; reading the hub's feed is a later step of its own |
| The steward, notices, labels, reflection | On the host whose machine file owns the repository | On the host the hub names owner |
| `jig gc` | Cleans the host | Also trims the hub's database where the process adapter runs |
| The records registry | The machine, the working tree, the forge and tracker | One more medium, the hub, for its enrollments, leases, world view and copies |

### Where it lives

`jig hub` is `plugin/hub/`, registered in `plugin/jig.ts` beside `dispatch`,
`gc`, `ask` and `send`, and released with the plugin, so a host and its
hub agree on the protocol by version. The core is `plugin/hub/core/`, the
one directory the portability gate covers, and each adapter is a directory
of its own under `plugin/hub/adapters/`. `jig install hub` installs the
process adapter's `jig hub serve` as a resident job, restarted when it
fails and when the installed copy changes, the way the dispatch
dashboard's reader is installed; the container image is built from the
same release. The Cloudflare adapter's source ships with the plugin too,
so a team deploys the version its hosts run, with the platform's own
deployment tool and its own account. The hub's own settings are in a file
of its own where it runs (its address, its database, its forge and tracker
identities and webhook secrets, the collector and external monitor it
reports to, the people it notifies); a host names its hub in its machine
file (`hub.url`), and keeps the credential `jig hub join` gave it in its
state folder.

## Build order

One pull request per step, each shippable alone. The seams come first and
are worth building for themselves: each makes the dispatcher easier to test
and closes a gap it has today, so building them costs nothing if the hub
never ships. Each wave after the first is planned in detail, and built or
not, by the person who asked for the hub, once the wave before it is in
use. A red-team critique of this design comes before the first
implementation pull request.

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

**First wave: the portable hub, fed by events, read by every host.**

1. The core's ports and the portability gate; the outbound library's
   portable parts split from its machine stores, with a forge transport
   over `fetch`.
2. The storage port through Drizzle, its schema, its migrations and the
   vendored bundle; the scheduling port and the job helper.
3. The process adapter, `jig hub serve`, `jig install hub` and the
   container image.
4. Enrollment, `hello` and `report`, and `jig hub status`.
5. Webhook intake from the hub's GitHub App and from Linear, with
   signatures verified, and the webhook-only listener a tunnel publishes.
6. The world view from events, and the reconciliation sweep.
7. The dispatcher reading through the hub: `changes` and `read` for the
   tick and the change probe, with the fall-back to reading itself.
8. The observability port, its signals, `health`, the external heartbeat
   and `jig doctor hub`.
9. The source feed served from the hosts' reports, and the dashboard
   reading it: one dashboard across hosts, the hub's health on it.

Done when two hosts dispatching the same repositories through one hub make
no forge or tracker reads for the dispatcher but the fences' read-backs,
and the hub spends about what one host spends alone; a webhook delivery
dropped on purpose is found by the next sweep and counted as drift; a hub
stopped mid-tick costs that tick nothing but its receipt's note; the
portability gate passes; and one dashboard shows both hosts and the hub's
health. In this wave `hello` names no owner and no lease exists: each
repository's owner is the host its machine file names, as today.

**Second wave: the Cloudflare adapter.** The core run on Workers, with a
Durable Object's SQLite storage or D1, alarms and cron triggers, and an
identity-checking front before every path but `/webhooks/`.

**Later waves, each planned when the one before is in use:**

- **Claims and owner leases, and a silent host noticed**, once
  [ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
  is approved, since grants and owner leases coordinate hosts, which
  [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines. The
  hub's implementation of `SharedRecords` in front of the fences, pickup
  claims, leases and their renewal, the replay after an outage, the owner
  named by `hello` with its lease, the restart quarantine, and the
  silent-host notice. Done when no two hosts do an owner's effects at once
  through a partition and a restart of the hub.
- **The chat bridge inside the hub** ([chat.md](chat.md)), where the
  chat tool's events may come to the hub's webhook path in place of a
  connection the bridge holds open; that choice is made, and recorded in
  [ADR-0022](../docs/adr/ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md),
  in that wave.
- **Handing out work.** `offers` and the tick's plan taking them as input,
  with the offer policy, its default rankers and `jig hub offers
  --explain`; then the `command` ranker, a step of its own; then each
  further built-in ranker, one at a time, when a team asks for it.
- **The PostgreSQL adapter**, when a team needs a managed database.

## Left out

- **The hub as the only fence.** Dropping the forge claim once every host
  is enrolled would save its writes, but the forge claim is what a host
  outside the hub, or one cut off from it, reads. It is reconsidered once
  the claims wave's grants have shown how often the forge disagrees with
  them.
- **Credentials handed to hosts.** A hub that minted short-lived forge or
  tracker tokens for its hosts would make every host's writes depend on
  it, so a hub outage would stop work instead of returning hosts to the
  level below.
- **Polling as the main feed.** It spends reads on every target whether or
  not it changed, and still lags a change by a polling interval; events
  with a slow sweep spend reads only where something changed.
- **Cancelling or steering a host's session from the hub.** A session is
  the host's; the hub's notices go to people, and `jig send` stays the way
  a person steers.
- **More than one node.** One hub per person or organization carries the
  size Jig is built for; a hub that outgrows one is a decision of its own.
- **A hub's own sign-in for people.** The private-network front names the
  viewer; a sign-in of the hub's own waits for a team that cannot use one.
- **Hubs talking to each other**, and a host enrolled in two hubs.
- **A dashboard that reads each host over SSH.** It would be a second way
  to build one view across hosts, with none of the hub's single read, its
  notice of a stopped host or its view on a phone.
- **Serving the reads a session makes.** A drive's own reads of its pull
  request stay with its account; they are not multiplied across hosts.
