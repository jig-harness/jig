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
the forge and the tracker for the dispatcher, bar the check each host makes
on the forge itself just before a write. Its [change feed](../GLOSSARY.md) tells a host's
dispatcher when a target moved, so it stops polling and reads only what
changed. It also grants claims with
leases, so a silent host's work goes to another host, offers work to
whichever host has a free slot, tells a person when a host stops and
serves one view of every host's work. A host that never enrolls loses
nothing, and a host whose hub is unreachable works as it does today, bar
the owner duties that wait for the hub's lease
([Owner duties](#owner-duties)).

This is the design of [plan.md](plan.md) item 49. Nothing of it is built,
and building its first wave waits on a measurement of what hosts spend
today ([Before the first wave](#before-the-first-wave-a-measurement)). It answers the conditions on which
[ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md#when-to-reopen)
reopens, and its decision record is
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md).
It builds on the dispatcher ([dark-factory-dispatch.md](dark-factory-dispatch.md),
item 33), its shared records ([plugin/RECORDS.md](../plugin/RECORDS.md)),
the dispatch dashboard's source feed
([dispatch-dashboard.md § The source feed](dispatch-dashboard.md#the-source-feed-from-a-host-to-a-dashboard),
item 42), the addresses that `jig ask` and `jig send` derive
([Addresses chapter](../plugin/protocol/addresses.md)), and the governed transports for
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

- **No level needs the next.** The skills never talk to the dispatcher, and
  never to the hub unless a drive pass on an enrolled host opts into the
  change feed's watch call; the dispatcher never needs the hub. Nothing at the lower
  levels carries a field, a record or a setting that exists for the hub
  alone; the seams it needs are built for reasons of their own first
  ([Build order](#build-order)).
- **Joining is a setting, and leaving is removing it.** A host joins by
  enrolling and naming the hub in its machine file. Since the hub holds no
  authority over a host's work, nothing moves back when a host leaves.
- **A hub that is down returns its hosts to the level below.** Every call
  a tick makes to the hub has a deadline of 2 seconds. When one fails, the tick
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

### What it solves, and how far

| Problem | What the hub does | How far, and from which wave |
| --- | --- | --- |
| Reads multiply across hosts | One reader for every enrolled dispatcher, fed by events | Whole, from the first wave, for the dispatcher's reads; a session's reads stay with its host |
| A drive pass polls the forge while it waits for checks | The change feed wakes it when its pull request moves, and it reads only the kinds that moved | Only if the measurement before the first wave shows drive polling matters ([The change feed](#the-change-feed)); the reads themselves stay the drive's |
| One host per person has its own dashboard | One view of every host, phone included | Whole, from the first wave |
| Nobody learns that a host stopped | The silent-host notice | Whole from the claims wave; without a hub, a host's tick can send its own heartbeat to an external monitor ([A stopped host, noticed](#a-stopped-host-noticed)) |
| A dead host's drive waits | Its grant lapses and the hub names the one host that takes it over | Partly: the takeover still takes the forge's own path, after the drive ledger's heartbeat has passed its lease window; the hub stops two hosts racing for it |
| A dead host's follow-up waits | Named in the stopped-host notice | Partly: a person resumes it, since a follow-up's marker has no takeover path |
| Pickups run from one host per repository | A claim before the session opens | Partly: best effort; the tracker claim inside `do-item` stays the fence, and the double-claim watch the backstop |

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
  and `jig gc`, and the same process shipped as a container image. It runs
  on any machine its hosts reach over HTTPS: in its smallest form on the
  always-on host that already dispatches, in that container under an OS
  user of its own ([Apart from the sessions](#apart-from-the-sessions-on-a-shared-machine)),
  or on a small server or a team's machine.
- **A serverless adapter**, built second: Cloudflare Workers, with the
  hub's state in Durable Objects' SQLite storage, one object per
  partition ([The size it is built for](#the-size-it-is-built-for)), and
  its scheduled work on alarms and cron triggers. It is second because a
  team with no always-on machine of its own has nowhere else to run a hub,
  and because the core's portability is cheapest to hold while a second
  adapter follows the first; the claims wave comes after it. It is one
  implementation of a serverless adapter; another platform is another
  adapter, with no change to the core.

Whatever the adapter, the hub opens no connection to a host: hosts call
it, and it calls the forge and the tracker. A host enrolls in at most one
hub. One hub serves one person or one organization; hubs do not talk to
each other.

The hub is the only resident service the hub level adds. The dispatcher
keeps no process running on any host
([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)): its tick and
its change probe run on the host's timers, and each makes request and
answer calls to the hub while it runs. The change probe and a waiting
drive pass hold their call to the [change feed](#the-change-feed) open as
a long poll while they run, and nothing on the host outlives the process
that already ran.

### The size it is built for

One hub is sized for this load, and every figure below is checked against
it:

| Measure | Target | Proven by |
| --- | --- | --- |
| Enrolled hosts | about 50 | about 5 in real use in the first wave; 50 simulated hosts in the claims wave's load test, on the process adapter, repeated on the Cloudflare adapter's partitions |
| Repositories served | about 30 | the same load test |
| Open pull requests and tracker items | about 500 | the same load test, and the sweep's own timings in use |
| Webhook deliveries | about 10,000 a day, in bursts of up to 20 a second for a minute after a push to a pull request with a large check matrix | a replay of recorded deliveries at that rate |
| Host calls | one `changes` or `renew` a minute per host and one tick's calls every few minutes: about 1 call a second at 50 hosts | the load test |

At that load the hub answers a host call from its copy within 500
milliseconds at the 95th percentile, acknowledges a webhook delivery within
1 second at the 99th (GitHub waits 10 seconds), and serves a dashboard's
snapshot within 300 milliseconds at the 95th.

**Its state is partitioned, so no one object serializes every host.**
Every table's key starts with its partition:

- **A repository partition** per served repository holds that repository's
  world view, its admitted deliveries, its claims and owner lease, and its
  sweep's progress. A delivery, a sweep chunk, a read-through and a claim
  touch one repository partition.
- **A host partition** per enrolled host holds its enrollment, its
  credential's hash, its acknowledgement checkpoint and the copies of the
  records it reported. A report touches only its host's partition.
- **One directory partition** holds what spans them: the list of
  partitions, each host's scope, the viewer grants, the budgets and the
  cost ledger, and the audit trail.

A call that spans partitions (`changes` across a host's repositories, the
source feed's snapshot) reads each partition's stored projection and merges
them; no statement spans two partitions, and a change that must touch two
is two atomic changes ordered so that either alone is safe. On the Cloudflare
adapter each partition is one Durable Object, so about 30 repository
objects and 50 host objects each see one repository's deliveries or one
host's calls, and none sees them all. The process adapter keeps every
partition in one SQLite database in write-ahead-log mode, which carries this
load in one process: its webhook listener only verifies and admits, one
short statement each, and the units that may run long (applying deliveries,
the sweep, the folds behind a snapshot) run in a worker thread with a
connection of their own, so none of them delays an acknowledgement or a
host's answer.

### The portable core and its adapters

The core is plain TypeScript that runs on every adapter unchanged. It
holds the host protocol, webhook intake, the world view, the
reconciliation sweep, claims and leases, offers and the source feed. What
differs between platforms sits behind a port:

| Port | What the core asks of it | Process adapter | Cloudflare adapter |
| --- | --- | --- | --- |
| Storage | Named operations on the hub's tables, each change atomic within one partition ([Storage](#storage)) | SQLite through `bun:sqlite` | Durable Objects' SQLite storage, one object per partition |
| Serving | A request in, a response out, with the caller's credential or the webhook's signature headers | Bun's HTTP server | The Worker's `fetch` handler |
| Scheduling | Run a named job at a time or on a cadence, and run one soon | Timers in the process, with each job's next run kept in storage | Durable Object alarms and cron triggers |
| Outbound | A call to the forge or the tracker through its [governed transport](../GLOSSARY.md), over `fetch` | The shared outbound library, its budget record and cost ledger kept through the storage port | The same |
| Disable record | Write and read the per-repository owner disables, kept outside what backup restores ([Owner duties](#owner-duties)) | A file beside the hub's machine file | A key-value namespace outside the partitions' restore |
| Observability | Typed events, metrics and spans ([Observability](#observability)) | Structured logs and the metrics `health` serves; OpenTelemetry's protocol (OTLP) to a collector when the settings name one | The platform's own logs and metrics; OTLP export when the settings name a collector |

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
  written with Drizzle's query builder, or as SQL through its `sql`
  template where that reads more plainly. Drizzle's drivers for
  `bun:sqlite`, Durable Object SQLite and D1 run the same schema and the
  same operations, so the process adapter and the Cloudflare adapter share
  one implementation of the port. Migrations are SQL files that
  `drizzle-kit` generates from the schema and that are checked in; each
  adapter applies them when the hub starts, and how they reach the
  platform is the adapter's. The process adapter reads the checked-in
  files with Drizzle's `bun:sqlite` migrator. A Worker cannot read files,
  so the Cloudflare adapter bundles the journal and the SQL as strings for
  the Durable Object migrator, which each object runs when it starts. The
  core's bundle holds no migrator that reads the filesystem.
- **SQLite's SQL, written freely.** The operations use what SQLite, and so
  D1 and Durable Object SQLite, offer, JSON functions included
  (`json_extract` and `json_each` filter and index a stored body, so a
  query reads only the rows a grant or a repository selects). Times are
  stored as integers of milliseconds. Every named operation has an index
  that serves it, and the contract suite asserts the query plan uses it.
- **PostgreSQL is built on demand, and accepts rework.** When a team needs
  a managed database, a PostgreSQL adapter adds a schema module in
  Drizzle's PostgreSQL dialect and its own implementation of the storage
  port's operations, rewriting what SQLite's SQL does differently; both
  implementations then pass one contract suite for the port. Nothing is
  constrained for it before then.
- **Drizzle is vendored**, and plain SQL behind the storage port replaces
  it if the bundle's upkeep (its upgrades, each waiting out the
  supply-chain cooldown) comes to cost more than it saves. Code that runs
  from the plugin depends on Bun's built-ins and code vendored beside it
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
  transaction on `bun:sqlite` and Durable Object SQLite, a
  transaction on PostgreSQL. The decision sits in the statement's
  condition, never in code between a read and a write.
- **One read of a target at a time.** A unit that must read a target
  through first takes the target's in-flight row, a conditional insert
  with a deadline of 30 seconds. A unit that finds the row held waits for
  the read's result in storage, polling with its own deadline, rather than
  reading again, so hosts racing for one pull request cost the hub one
  forge read. A row whose deadline passed is taken over.
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
  ([The world view](#the-world-view-events-first-reconciled)). The listener
  refuses a body over 25 MiB (GitHub's own cap on a payload) and admits at
  most 100 deliveries a second per source, answering 429 above it; a
  GitHub delivery refused that way is redriven from the delivery log
  ([The world view](#the-world-view-events-first-reconciled)).
- **The host protocol, `/v1/`**, is reached by enrolled hosts only, with
  the host's credential. It listens on the loopback interface and on the
  private network's interface only, never on every interface, so a hub on
  a machine with a public address is still unreachable there.
- **The page and the source feed** are reached through a
  [private-network front](../GLOSSARY.md) that names the viewer
  ([One view of every host](#one-view-of-every-host)). The feed listens on
  a Unix socket that only the front's user may open, so a local process
  cannot reach it and set the viewer's header itself; where the front can
  reach only a network port, the feed listens on loopback and takes only
  requests that carry a secret the front adds, held in the hub's settings.

**A host pins its hub's identity at enrollment.** The hub holds an
identity key pair (Ed25519) of its own, made when its database is first
created. `jig hub join` prints the fingerprint of the key the hub
presents, `jig hub approve` shows the person who approves the same
fingerprint as the hub knows it, and the host records it only when the
two agree. From then on every answer the hub gives carries a signature
over the body and a nonce the host's request sent, and a host refuses an
answer that is unsigned, signed by another key or for another nonce, as
it refuses a hub that does not answer: it reads for itself. The
signature does not depend on the network path or on a certificate
authority, so it holds behind a tunnel, a private network's name service
or a platform's edge alike. HTTPS still carries every call; the pin is what
says the far end is the enrolled hub. A hub whose key changes (a rebuilt
database, a recovery after compromise) is a new hub to its hosts, each of
which enrolls again.

**What the hub says is never the last word before a write.** Every fact
that gates a write a host makes (a forge claim, a launch, a label change,
a pull request called merge-ready) the host confirms on the forge itself
at use ([How fresh each fact is](#how-fresh-each-fact-is)). A hub that
lies, or an impostor that slipped past the pin, can make a host consider
work it then declines; it cannot make a host drive a pull request in hold,
pick up an item that was never queued or launch past another host's claim.

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
it as well. The Worker does not trust the front's identity header: on
every request but a webhook it validates the front's signed token itself,
its signature, audience and issuer, so a caller that reaches the Worker
by another route gains nothing. The Worker's platform subdomain and
preview addresses are turned off, leaving one route. A host passes the
front with a service token of its own, made when its enrollment is
approved and rotated with its credential. An unenrolled host has no
such token yet, so an administrator makes a single-use join invitation
through the front, valid 10 minutes, and the front admits `/v1/join`
with that invitation alone.

### Apart from the sessions on a shared machine

The smallest form runs the hub on the host that already dispatches, where
agent sessions read untrusted pull-request and issue text. A session there
must never reach the hub's secrets or its database, so on a machine that
also runs sessions:

- **The hub runs in its container, under an OS user of its own** that no
  session user is, and in no group a session user is in. `jig install hub`
  installs it that way on a machine whose dispatcher is installed, and
  refuses to install it under the dispatcher's user.
- **Its secrets are readable by that user alone.** The GitHub App's private
  key, the webhook secrets, the tracker application's secret and the hub's
  identity key sit in its settings file, mode 0600, owned by the hub's
  user and mounted read-only into the container; its database directory
  is mode 0700. `jig doctor hub` fails when either is readable by any
  other user.
- **Only `/webhooks/` is public**, through the tunnel; `/v1/` and the feed
  listen as [Reaching the hub](#reaching-the-hub-only-the-webhook-path-is-public)
  says.
- **A flaw in the webhook parser reaches the container**, which holds read
  access only: the hub has no write credential on the forge or the
  tracker unless it runs the chat bridge, and the hosts' write credentials
  live under the session users the container cannot read.

On a machine of its own the container is optional; the separate user and
the file modes are not.

### What it keeps, and what stays with the hosts

- **A host keeps authority over what it did.** Its launch records, its
  sessions, its outcome log and its walls stay on the host; drive ledgers
  and claims stay on the forge; claims on items stay on the tracker. The
  hub keeps copies of what hosts report, to serve them, and never edits
  one.
- **The hub keeps no phase of its own.** It derives columns, threads and
  the state of a piece of work from records, with the same fold library as
  the dispatcher and `jig ask`
  ([dispatch-dashboard.md § The source feed](dispatch-dashboard.md#the-source-feed-from-a-host-to-a-dashboard)).
  The fold's result is kept per partition as a projection, recomputed for
  the records a report changed, so a snapshot reads projections rather than
  folding every host's history on every read; the projection is a cache of
  the fold, never a state of its own, and is rebuilt from records when its
  fold library changes.
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
  of one lease lifetime, and nothing that the line depends on. The
  quarantine is 6 minutes: the longest lease, 5 minutes, and one drain
  margin ([Claims and leases](#claims-and-leases)). The non-rebuildable
  part (enrollments, leases, the audit trail) is what `jig hub backup`
  copies, daily by default; restoring that copy also enters the same
  quarantine, because its leases may predate still-valid grants from the
  discarded history. The copies of host records and the world view
  are never backed up, since they come back on their own.
- **It keeps what it serves**, comment text included, on the machine or
  the platform account the organization chose, as each host's own records
  do, for as long as [How long it keeps things](#how-long-it-keeps-things)
  says and no longer. Reading the text through on each request instead
  would spend the reads the hub exists to save. An edit or a deletion on
  the source replaces or removes the hub's copy when its delivery
  applies; a repository removed from one host's scope does not purge its
  shared partition. The trimming run purges a partition only after no
  enrolled host serves it and the App installation no longer serves it (or
  the App is uninstalled), within an hour. At rest the database is
  protected by the machine's disk encryption on the process adapter and by
  the platform's encryption on the Cloudflare adapter; the hub adds none of
  its own.

### How long it keeps things

| What | Kept for | Why that long |
| --- | --- | --- |
| The change log of target versions | 24 hours | A subscriber away longer resyncs with conditional reads ([The change feed](#the-change-feed)) |
| Admitted delivery ids | 7 days | Longer than GitHub keeps a delivery for redelivery (3 days) and Linear retries one, so a late duplicate is still recognized |
| A delivery's body | Until it is applied, then 24 hours, subject to a 100 MiB per-repository body budget | Long enough to read back when an apply is questioned without letting one repository exhaust its partition; a new body that would exceed the budget is admitted by id but not retained and is marked for authoritative re-read |
| Bodies and validators of conditional reads | 24 hours since last use, as the drive's read cache keeps them | A validator older than that rarely matches |
| World-view facts of closed work | 7 days after the work closed | The dashboard's recent-closed view |
| Copies of host records, correspondence and comment text included | 30 days after their work closed; a retired incarnation's rows 7 days after its host's next incarnation first reports | As long as a dashboard shows closed work |
| The cost ledger (hourly totals) | 35 days | Five weekly comparisons of the hub's spend ([What it spends](#what-it-spends-and-how-that-is-checked)) |
| Structured logs | 14 days | Long enough to read back a week's incident |
| The audit trail (enrollment, approval, scope changes, revocation, rotations) | 1 year | Who allowed what, after the fact |

At the target load the per-repository body budget, together with the other
retention rows, bounds each repository partition under about 200 megabytes and
each host partition under about 100, and the directory under
50: well below a Durable Object's storage cap, and small for a SQLite
file on any machine. The trimming job runs hourly through the scheduling
port.
- **No relationship store.** Links between items live in the tracker
  ([ADR-0015](../docs/adr/ADR-0015-relationships-live-in-the-tracker.md)),
  and the hub reads them there like any host.

### Enrollment, and whose credential acts

- **A host enrolls with a device grant.** `jig hub join <address>` on the
  host prints a short code and the hub's identity fingerprint. The join
  endpoint is `/v1/join` on the host protocol's listener, never on the
  public path, and takes at most 10 join requests an hour from one
  address. A code is 8 characters from a 32-symbol alphabet, lives 10
  minutes, is used once, and is void after 5 failed approvals. A person who
  administers the hub approves it with `jig hub approve <code>`, which shows
  what the request carried before anything is granted: the host's name, its
  OS user, its machine id, the address it called from, its Jig version, the
  fingerprint it was shown and the repositories it asks for. On the process
  adapter `jig hub approve` runs on the hub's machine as the hub's user, so
  only a person who can act as that user approves; on the Cloudflare adapter
  it is a call through the identity front by a person the hub's settings
  name as an administrator. Each approval is recorded in the audit trail
  with the approver and the time.
- **A host credential lives 90 days.** The host receives a credential of
  its own and keeps it in its state folder, readable only by its user; the
  hub keeps only its hash. `hello` hands a host a new credential in the
  last 14 days of the old one's life, and the old one stops working once
  the new one is first used. `jig hub revoke <host>` ends it at once, and
  with it the host's grants and owner leases, whose work the hub hands on
  after one drain margin, as for a lapsed lease. `jig hub leave` on the
  host removes it and the setting together. Enrollment, scope changes,
  rotation and revocation are recorded in the audit trail with the person
  who made them.
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
  limits, not any person's. The App asks for these permissions and no
  others: Metadata, Pull requests, Issues, Checks, Commit statuses and
  Actions, each read-only. Contents is excluded, so the App cannot read
  repository files through Contents endpoints. Pull requests read can still
  expose changed code through a pull request's diff or patch, so a leaked App
  key exposes the metadata and changed code those endpoints permit, but not
  general repository-file access. What a host needs from a repository's own
  files (its offer policy's name, say) the host reads in its clone and
  sends in `hello`. On Linear it is an OAuth application of the hub's own,
  authorized to act as the application rather than as a person, so it has
  its own identity and its own rate budget, apart from every person's
  keys; its scope is read, and write only where the hub runs the chat
  bridge. Its webhooks are registered for the teams the hub serves, and a
  delivery for an issue outside every served queue is dropped before it is
  admitted, counted as filtered, unless the hub already holds that issue:
  then it is admitted, the move out of every queue is applied as a
  departure, and the issue's content is purged. On Jira it is a service account with
  read access to the served projects only, which the change probe's small
  question reads with; an Atlassian OAuth application replaces it if
  Jira's webhooks become verifiable and the hub takes them. The hub writes nothing on the forge or the tracker:
  the forge claim and the tracker claim are written by the hosts, as
  today. A hub that is later given a write (a notice on the forge, say)
  names that write and its permission here first. The one named is the
  [chat bridge](chat.md)'s, where a hub runs one: under the bridge's own
  forge app identity, separate from the read App, an answer comment and
  the `drive`, `hold` and `release` labels on a pull request (that app's
  Issues and Pull requests write permission), and under the hub's tracker
  application the assignment `/jig pickup` makes, each with a record
  naming the person who asked. Before each such write the bridge checks
  that the person the chat authenticated may make it: the chat identity
  is linked to a forge login and a tracker user once, by that person, and
  the bridge reads that login's write permission on the repository and that user's membership
  of the queue's team, refusing the write when either falls short.
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
  The hub's tracker application acts as itself, not as a person, so it is
  no person's credential either.
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
[Concurrency and failures](#concurrency-and-failures)), signed with the
hub's identity key ([Reaching the hub](#reaching-the-hub-only-the-webhook-path-is-public)).

- **Deadlines.** An ordinary call has a deadline of 2 seconds, and a tick spends
  at most 10 seconds on ordinary hub calls in all. A `changes` long poll has
  its own 60-second deadline, including its 55-second hold, and does not
  consume that tick budget. The first ordinary call that fails or
  passes its deadline marks the hub unreachable for the rest of that tick,
  which reads for itself from there, so a slow hub costs a tick one
  deadline, never several. A host that found its hub unreachable waits a
  random 0 to 60 seconds before its next call to it, so hosts returning to
  a restarted hub arrive spread out, and the hub may answer `hello` with a
  time to come back when its admission queue is full.
- **Versions.** The hub answers every host whose plugin was released
  within 60 days of its own, in either direction, and refuses one outside
  that window with a coded failure that sends the host to the level below
  and raises a [need](../GLOSSARY.md) on it. A change the capability flags
  cannot carry takes `/v2/`, served beside `/v1/` for 60 days. A hub is
  upgraded before its hosts.

- **`hello`**: the host's stable id, its dispatcher's incarnation (the id
  its state database got when it was created), its Jig version, its
  capabilities and the repositories its machine file lists. The hub
  answers with its own capabilities, the repositories it serves for this
  host and, for each, the host that owns it
  ([Owner duties](#owner-duties)), and, for each budget the host shares
  with other enrolled hosts (one tracker user's keys, say), how many
  hosts share it, which sets the host's share while it reads for itself.
  A tick calls `hello` first; a failed `hello` sends the whole tick to the
  level below.
- **`changes(cursor, subscriptions)`**: the [change feed](#the-change-feed),
  what moved since the subscriber's cursor, as targets with their new
  versions and the kinds that moved, and a new cursor. The answer carries
  no content: it says where to look, and the subscriber reads there. A
  lost answer costs a wake-up and nothing else, since the timer's tick
  reads everything anyway. The change probe calls it with the host's
  scope in place of its own forge and tracker queries, and wakes a tick
  for the repositories it names, as it does now; a drive pass calls it for
  its own pull request.
- **`read(targets, notOlderThan)`**: the forge's and the tracker's facts
  for each target (a repository, a pull request, a queue, an item), each
  with the time it was last confirmed. The hub answers from its world view
  when its copy is at least as new as `notOlderThan`. An applied delivery
  moves a fact's copy, never its confirmation time: a delivery can be lost
  before the hub admits it, so a fully processed queue does not show the
  source is current. The confirmation time is that of the last authoritative
  read (a read-through, a re-validation or a reconciliation sweep, a
  conditional read answered "not modified" included), unless the source
  supplies a verifiable completeness watermark, which confirms the target
  up to it. The observe phase asks with its fact's class bound
  ([How fresh each fact is](#how-fresh-each-fact-is)), which the hub's own
  re-validation and sweep keep met, so it is answered from the copy. When
  a bound has expired regardless (the hub was down, a re-validation is
  late), the hub reads that target through once, one read at a time per
  target, before answering. A host may cause at most 30 read-throughs a
  minute; past that the hub answers from its copy with the copy's
  confirmation time, and the host decides. When the hub's own budget is
  spent it says so with the time it resets, and the host reads for itself
  only within its share. A target no event feed covers (a tracker whose
  deliveries the hub cannot verify) is still read at the tick's interval,
  and that polling is budgeted, not free. The check just before an act is
  not asked of the hub: the host makes it on the forge itself.
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
  from its records in full, back as far as the hub keeps copies. A report
  call carries at most 500 records or 1 MiB, whichever comes first, and the
  hub acknowledges each page as it commits it, so a backlog drains a page
  at a time and a failed page costs only itself; a tick sends at most 10
  pages and leaves the rest for the next tick. A host reports only records
  whose revision advanced, tens a tick in steady use. The hub never asks a
  host for anything, since hosts accept no connection
  ([ADR-0011](../docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)),
  so what the source feed needs on demand is replicated here ahead of the
  asking.
- **`claim`, `check`, `renew`, `end`**: the shared records interface
  (`plugin/shared/records/shared.ts`) over HTTP, with a lease on each
  claim. The host renews every claim it still holds in one `renew` call at
  each tick and each probe, so a lease outlives several missed probes and
  lapses only when the host has stopped calling
  ([Claims and leases](#claims-and-leases) has the figures).
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
  tracker read of their own for what they observe: the observe phase and
  the change probe go to the hub. Three kinds of read stay with the host:
  the read-back that is part of a fence (the forge claim and the tracker
  claim, which the host writes), the check of a fact that gates a write,
  made at use ([How fresh each fact is](#how-fresh-each-fact-is)), and
  every read a session makes, which a drive pass on an enrolled host makes
  when the [change feed](#the-change-feed) says its pull request moved
  rather than on a timer. When the hub does not answer, the host reads
  for itself, as without a hub.
- **Events are the main feed.** The forge and the tracker tell the hub of
  each change by webhook: GitHub through the hub's App, Linear through the
  hub's application's signed webhook. The hub turns each delivery into a
  change to its world view and the `changes` it serves.
- **A delivery's own facts are used when they suffice.** A label, a pull
  request's state, head commit or draft flag, one check run's conclusion
  and a review's verdict arrive in the payload, carry their source's
  version, and are applied with no read. Only where a payload does not
  carry the fact the tick needs (a pull request's unresolved threads, the
  roll-up of its checks after a suite ends) does the delivery mark its
  target to be read.
- **Deliveries for one target collapse into one read.** A target marked to
  be read is read 10 seconds after the first mark, once, whatever else
  arrived for it meanwhile, and at most 3 times a minute; a mark that
  arrives past the cap waits for the next minute. A push to a pull request
  whose checks run as a matrix of tens of jobs sends tens of deliveries
  over some minutes, and costs the hub a handful of reads of that pull
  request, where a host polling on its own every few minutes spent one a
  poll whether or not anything changed.
- **Every delivery is verified, then admitted, then applied.** The hub
  checks the delivery's signature with the secret its configuration holds
  (GitHub's and Linear's both sign the body with a shared secret) and
  refuses one that fails, before it parses anything else; a Linear
  delivery whose own timestamp is more than a minute old is refused too.
  It then admits the delivery by its delivery id, in one statement that
  ignores an id it already holds, and answers at once, since the sender
  waits only seconds. Applying the delivery to the world view is a unit of
  its own, run soon after through the scheduling port; a delivery admitted
  and not yet applied is applied by the next run. A GitHub body replayed
  under a fresh delivery id passes the signature, since the signature does
  not cover the id; it changes nothing, since every fact it carries is no
  newer than the one held, and the per-target cap bounds the reads it can
  cause.
- **Deliveries the sender will not resend are redriven.** Linear retries
  a delivery that failed; GitHub does not. Every 10 minutes the hub lists
  the App's recent deliveries from GitHub's delivery log and asks GitHub to
  redeliver each one that failed or timed out and that it has not admitted,
  within the 3 days GitHub keeps them. A change whose delivery is lost
  outright waits for its target's re-validation or the sweep.
- **Order comes from the facts, not the deliveries.** Every fact in the
  world view keeps the version its source gave it (an update time, a head
  commit, a revision). A delivery older than the fact the hub holds
  changes nothing, and a delivery the hub cannot place reads its target
  instead.
- **A reconciliation sweep catches what the events missed.** A webhook can
  be lost, late, sent twice or out of order, so the
  [reconciliation sweep](../GLOSSARY.md) reads every target the hub
  serves hourly. On GitHub it reads each target's REST resources (the pull
  request, its labels, its reviews, its head commit's check runs and
  statuses) with conditional requests that name the version the hub holds,
  which cost nothing against GitHub's hourly limit when nothing changed.
  GraphQL has no such request, and a review thread's state (resolved or
  not) is a GraphQL-only fact, so the sweep reads thread state only for
  active targets, the open pull requests with a drive; every other
  target's thread state rests on its webhooks (review, review comment and
  review thread deliveries) and on the conditional REST part of the sweep,
  which sees the pull request change when a review or comment lands. On
  Linear, which has no conditional request either, it reads a paged
  inventory of every served queue, not only the issues updated since its
  last sweep, so an issue that has gone is seen as a deletion and its copy
  removed. One sweep of 100 open targets therefore costs about 100 to 500
  REST requests, nearly all answered "not modified" and so free; GraphQL
  points for the thread state of the active targets alone, a few points
  each; and a tracker inventory of a few paged requests per served queue,
  which spends the tracker application's own budget every hour whether or
  not anything changed. The sweep runs in resumable chunks of 50 targets,
  each a unit with a 30-second deadline, so a chunk fits a serverless
  platform's per-run limits and a stopped sweep resumes at its next chunk;
  a sweep must finish within 15 minutes, or its job reads stale. Each
  change, thread-state transition or deletion the sweep finds that no
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
- **Hosts that fall back share what is shared.** When the hub stops, its
  hosts read for themselves, and a budget that belongs to one person or
  one organization (a tracker user's keys) is read by all of them at once.
  So a host reading for itself spends at most its share of such a budget,
  the remaining balance divided by the number of hosts `hello` last said
  share it, and its change probes run again within that share and pause
  while it is spent; its ticks still read at their interval, from the same
  share. The App's budget is the hub's alone, so no host
  falls back onto it.

### How fresh each fact is

Every fact belongs to one of the classes below. Each has a stated longest
time a lost delivery can leave it stale, except the last, the review-thread
state of a pull request no drive holds, which has no bound of its own:

| Class | Which facts | How they are confirmed | Stale for at most |
| --- | --- | --- | --- |
| Gates a write | What a host's write depends on: the forge claim and its read-back, the labels a launch obeys or a write changes (`hold`, `drive`), the state that makes a pull request merge-ready (its checks, reviews and mergeability), and a pickup's item | By the host, at use, on the forge itself: a conditional read with the validator from its own last read, answered "not modified" at no cost against GitHub's hourly limit when nothing changed. A fact with no REST form (unresolved threads) is a GraphQL read, budgeted. A pickup's item is read on the tracker, beside the tracker claim the host writes and reads back | No staleness: read at use |
| Active | Every fact of an open pull request with a drive running or armed, its review threads' state included | By the hub, every 10 minutes, with the same conditional reads, and a GraphQL read of its thread state; events move the copy in between | 10 minutes after a lost delivery; seconds when its delivery arrives |
| Everything else | Other open pull requests, queues and items, and the repository's own facts | By the hub's hourly sweep, with conditional REST reads and the tracker's inventory; events move the copy in between | 75 minutes after a lost delivery: the hour and the sweep's own 15 |
| Thread state of a target with no drive | Whether each review thread of a pull request no drive holds is resolved | By its webhooks alone; the sweep reads it once the pull request becomes active, or when its REST resources show a review or comment changed | Until its next delivery, its next review or comment, or its first drive: no bound of its own. Nothing gates a write on it unread: a drive that starts reads its threads at use |

A host asks `read` with its fact's class bound, and its validators for
the facts that gate a write are its own: GitHub's validators can differ
between credentials, so a host keeps those it got, for 24 hours since last
use, as the drive's read cache does.

### The change feed

Without a hub, a dispatcher's change probe and a drive pass waiting for its
checks poll the forge: a drive asks about its pull request every 30
seconds while its checks run, and each ask is a call whether or not
anything moved. The [change feed](../GLOSSARY.md) lets them wait on the hub
instead, and read the forge only when their target moved.

- **A version per target, and the kinds that moved.** The hub keeps, for
  each pull request and each issue it serves, a version that only grows,
  and for each step of it the kinds of fact that changed: `head` (a push),
  `checks` (check runs, suites and statuses), `reviews` (reviews and their
  threads), `comments`, `labels` and `state`. An applied delivery, a
  re-validation and a sweep that finds a change each bump it, so a change
  whose delivery was lost still reaches the feed when the hub's own read
  finds it. Each bump is appended to its repository partition's change
  log under a sequence number.
- **Signals, not data.** An answer names targets, their new versions and
  the kinds that moved, and carries none of the facts. A woken dispatcher
  reads the changed facts through the hub's `read`, as its tick does, and
  reads the forge only for a fence's read-back and a check at use. A woken
  drive pass reads its own pull request's facts from the forge, with its
  host's credentials and conditional requests, for the kinds that moved and
  no others, as a session's facts never pass through the hub. A subscriber
  that is not woken makes no forge call. So the hub's rules hold as they
  are: it holds no person's credential, sessions read and write the forge
  themselves, the hub stays the enrolled dispatchers' one reader, and a
  fact that gates a write is still confirmed on the forge at use.
- **Two forms of subscription.** A host subscribes to its scope, every
  repository and queue its approved scope covers; this is what the
  dispatcher's change probe and tick use, through `changes`. A drive pass
  subscribes to its target: "tell me when pull request T moves past
  version V in any of these kinds". Both are one call, `changes(cursor,
  subscriptions)`.
- **A cursor says where the subscriber stands.** The answer carries a new
  cursor, opaque to the subscriber, which names a sequence number in each
  partition it covers. Calling with that cursor returns every bump after
  it, in order, with no gap, for as long as the change log keeps them (24
  hours). A cursor older than that, minted by a hub with another identity
  key, or naming a partition that was purged, is answered `cursor-expired`
  with a fresh cursor: the subscriber then treats every subscribed target
  as moved in every kind once, reads them (a dispatcher through the hub's
  `read`, a drive pass from the forge with its conditional requests, nearly
  all answered "not modified" at no cost against GitHub's hourly limit),
  and carries on from the fresh cursor. A first call names no
  cursor, and is answered at once with the current one and the same
  resynchronization as `cursor-expired`: the subscriber treats every
  subscribed target as moved in every kind once and reads it, so a change
  that landed before the cursor was minted is never lost behind it. A
  subscription that gains a target or a partition resynchronizes the added
  ones the same way.
- **A held call, then an answer.** When nothing has moved past the
  cursor, the hub holds the call until something does, for the hold the
  call asks (at most 55 seconds, under the proxies' and tunnels' usual 60),
  then answers with no change and the same cursor. A scope subscription
  asks 55 seconds and has a 60-second deadline of its own, outside the
  tick's total budget. A drive pass's subscription asks 20 seconds and has
  a 25-second deadline, inside its 30-second poll interval. A host holds at most one call for its scope
  and one per running drive pass, 32 in all. A lost answer costs a
  wake-up: the subscriber calls again with the cursor it had. The watch
  credential is a deliberately narrow capability, not an OS-user boundary:
  a session that can read the dispatcher's state directory can use the host
  credential too. The separate hub user protects the hub's privileged
  credentials; isolating untrusted sessions from a dispatcher's host
  credential requires a separate session user or host.
- **Who may subscribe.** The host's enrollment identity, nothing else:
  every call is bound to the host's credential, and a subscription outside
  its approved scope is refused with a coded failure. A drive pass uses a
  second credential the host receives at enrollment beside its own, which
  can call `changes` within the host's scope and nothing else, so a
  session that reads it can neither report, claim nor renew for its host.
  Answers are signed like every other.
- **Transport.** A long poll over HTTPS is the baseline, since it passes
  every proxy, tunnel and serverless platform. Server-sent events and
  WebSocket connections carry the same contract (each message a cursor
  and its bumps; a reconnect resumes from the last cursor) as options a
  capability flag announces. On the Cloudflare adapter the WebSocket
  option uses Durable Objects' hibernatable WebSockets, so an idle
  connection costs no object duration; a long poll there is a request the
  partition's object holds.
- **No hub, or no answer.** Without a hub, or when the hub does not
  answer, the dispatcher's probe and the drive's wait poll the forge as
  they do today, made cheaper by the drive's conditional reads
  ([#1323](https://github.com/jig-harness/jig/issues/1323),
  [#1432](https://github.com/jig-harness/jig/pull/1432)). A drive pass
  waits on the feed with its own 25-second deadline and polls the forge once
  when the call fails, so a hub that stops costs a drive less than one poll
  interval.

**What it saves.** Its value is mainly the dispatchers'. Each host's
change probe asks the forge and the tracker about every repository and
queue it serves once a minute, and every host asks again; on the feed, a
host holds one call for its whole scope and reads only where a target
moved. A drive pass gains less: polling every 30 seconds while it waits,
the default the drive's status loop uses, it makes about 120 forge
requests per pull request per active hour (once conditional reads
land most are answered "not modified" and spend no hourly limit, yet each
is a call with its latency); woken by the feed it would make a few dozen,
the reads of the kinds that moved per push, per check suite that ends and
per review. So drive passes wait on the feed only when the measurement
before the first wave shows that drive polling is at least 15% of the
busiest shared credential's spend
([Before the first wave](#before-the-first-wave-a-measurement)); below
that, drives keep polling and the feed serves dispatchers alone.

### Observability

The hub is observed as [M11](../modules/M11-process-observability/README.md)
says a process must be: a closed set of typed events, every metric wired
to a source, and a scheduled job that stops reads as stale, never green.
One person runs most hubs, so the first wave's minimum is what that person
reads without running anything else: `health`, structured logs, the
metrics `health` serves and the dashboard. An OpenTelemetry collector and
an external heartbeat monitor are settings, off by default. That is an
exception to M11's external-monitor invariant, and the hosts are the
independent watcher that stands in for it: a host that cannot reach its
hub raises a [need](../GLOSSARY.md) on its own receipt and dashboard
within 30 minutes ([Owner duties](#owner-duties)), so a hub that dies
is noticed by something that does not depend on it. A team that wants the
monitor sets it, and a setting that names one is checked to be wired.

- **An observability port.** The core emits typed events, metrics and
  spans, each failure named by its `Outcome` code; an adapter exports
  them. The process adapter writes structured logs and keeps the metrics
  `health` serves, and when its settings name a collector it also exports
  over OTLP; the Cloudflare adapter uses the platform's own logs and
  metrics, and OTLP when named. A structured log line carries the
  failure's `code`, and nothing reads a `reason` to classify it.
- **What telemetry may carry.** An event, span or log line carries codes,
  ids, counts, durations, target names and versions. It never carries a
  request's or a delivery's body, a header, a token, a URL's credentials or
  comment text, and a failure's `cause` is exported as its class and code
  only. A test runs the core over fixtures that hold a token and comment
  text and fails when either reaches an exported line.
- **One registry.** The hub's events are declared once and checked by M11's
  event-schema lint, and its metrics are declared in a metric registry
  with their source; M11's no-dark-instruments check fails the gates for a
  declared metric whose registry entry has no source. That check reads the
  registry and does not prove the core emits the metric, so the hub adds an
  emission-coverage check: a test that runs the core and fails on a
  declared metric no run emitted.
- **An optional sink is wired or refused.** A setting that names a
  collector or an external monitor is a claim that its signals arrive
  there, and M11 counts a claimed but unwired signal as a failure. So when
  either is set, the hub sends a test export or a heartbeat when it
  starts and after each sweep, `health` turns degraded when the last one
  failed, and `jig doctor hub` fails until one succeeds. The external
  monitor, when set, receives a heartbeat after each sweep and alarms when
  it stops, so a hub that stopped entirely is noticed by something other
  than itself; without it, a host's receipt and dashboard show since when
  the hub has not answered.
- **Signals the first wave ships with:**
  - webhook intake per source: deliveries received, verified, refused,
    filtered, redriven, the acknowledgement's latency and the lag from
    admission to applied;
  - the reconciliation sweep and the active targets' re-validation: their
    duration, the targets checked, the share answered "unchanged", and
    drift, the changes found that no delivery brought, which is the
    measure of whether events can stay the main feed;
  - reads: the share of `read` answered from the hub's copy, read-throughs
    per host, and coalesced deliveries per read;
  - the change feed: subscribers held, per kind of subscriber, wake-ups,
    cursors expired, and the polls subscribers did not make, which each
    host counts and reports;
  - change-to-host latency: from a delivery's admission to the first
    host answer that names the change;
  - quota spent per credential, per repository and per named operation,
    from the cost ledger of [outbound calls](outbound-calls.md), kept
    through the storage port;
  - each host's last-report age, against the host's own cadence: a host
    older than its cadence is stale, never green;
  - the host protocol's latency and coded failures per call;
  - defects caught at each kind of boundary.
- **Health.** `health` answers each scheduled job's class (green,
  degraded, red, stale or running, from M11's
  [heartbeat classifier](../modules/M11-process-observability/reference/heartbeat/README.md)),
  each feed's age, each budget and the thresholds below. The hub's jobs are
  declared with their cadence the way the repository's scheduled jobs are.
  The dispatch dashboard shows the hub's health beside its hosts.

| Signal | Degraded when | Red when |
| --- | --- | --- |
| Apply lag, 95th percentile over 10 minutes | over 60 seconds | over 5 minutes |
| Webhook acknowledgement, 99th percentile over 10 minutes | over 2 seconds | over 8 seconds |
| Ordinary host-protocol latency, 95th percentile over 10 minutes | over 500 milliseconds | over 2 seconds |
| Change-feed wake latency, excluding the intentional hold, 95th percentile over 10 minutes | over 500 milliseconds | over 2 seconds |
| Change-to-host latency, 95th percentile over 1 hour | over 2 minutes | over 10 minutes |
| Share of `read` answered by a read-through, over 1 hour | over 20% | over 50% |
| Drift, share of a sweep's targets | over 2% | over 10% |
| A budget's remaining share | under 20% | under 5% |
| The hub's GitHub spend for a repository, against one host's baseline, trailing 24 hours | over 1.2 times | over 2 times |
| A sweep or re-validation run | late by half its cadence | late by a whole cadence |

### What it spends, and how that is checked

The hub is worth running only if it spends less than its hosts did, so
its spend is a stated test, per repository per day, which holds at any
number of hosts:

- **Must pass:** over 7 days, the hub's GitHub spend for the enrolled
  repositories, REST requests and GraphQL points counted apart, is at most
  1.2 times what one host spends reading those repositories alone for the
  dispatcher, both from the cost ledger. The expected figure is 0.3 to 0.5
  times, from webhooks replacing polls.
- **Must pass:** enrolled hosts' own dispatcher reads that spend a forge
  limit are about zero: what remains is the fences' read-backs and the
  checks at use, which conditional requests answer "not modified" for
  free when nothing changed.
- **Tracked:** change-to-host latency, the share of reads served from the
  hub's copy, and drive passes' forge requests per pull request per active hour,
  about 120 per active hour when they poll and a few dozen if they wait on
  the change feed ([The change feed](#the-change-feed)).

The change feed's saving is counted on the hosts' ledgers, apart from the
hub's own spend: it lowers what the hosts spend, mostly the dispatchers'
probes, and adds nothing to what the hub does, since the versions it
serves come from deliveries the hub applies anyway.

**What running it costs.** On the process adapter: the machine that
already dispatches, a container, and a tunnel provider's free tier; the
collector and the monitor only if set. On the Cloudflare adapter: the
platform's paid Workers plan, requests (about 10 million a month at the
target load, most of them held change-feed calls, which hibernatable
WebSockets turn into messages), Durable Object duration for the partitions that hold calls,
and storage; its wave states the monthly figure from its load test before
it is built: a monthly figure for one person with two hosts and for 50
hosts. A figure above the process adapter's by more than the platform's
base plan is put to the person who asked for the hub before the wave is
built.

### Claims and leases

The forge claim stays the fence for a drive launch, and the tracker claim
for a pickup ([dark-factory-dispatch.md](dark-factory-dispatch.md#the-records-it-reads)).
The hub's claims sit in front of them:

- **The figures.** A lease lasts 5 minutes. A host renews every lease it
  holds in one batched `renew` at each tick and each change-probe call,
  about once a minute, so a lease survives four missed renewals. The drain
  margin is 60 seconds, longer than the 30-second deadline of any owner
  effect. A lapsed lease's work is granted again after its expiry and one
  drain margin, 6 minutes after the last renewal, and a hub started with
  no database waits the same 6 minutes before it grants. At 50 hosts that
  is about 50 renew calls a minute, each one batched statement per
  repository partition it touches.
- **A host takes at most what it can run.** The hub grants a host at most
  as many launches as the free slots its `hello` declared, and refuses
  more with a coded failure.

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
  since and that the forge's or the tracker's own claim, as the hub's world
  view holds it, names that host; one the forge does not back is refused, so a host's
  word alone restores nothing.

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

A team without a hub can learn the same from each host's tick sending its
own heartbeat to an external monitor, M11's
[heartbeat](../modules/M11-process-observability/reference/heartbeat/README.md);
the hub's notice adds what that cannot: the list of the silent host's
unfinished work and the lapse of its leases.

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
the hub again, or until a person takes the repository off the hub:
`jig hub release-owner <repository>`, run where the hub runs, first
records a durable disable in the hub's store (the hub then names no owner
for that repository, now or after a restart, and refuses to), then revokes
the lease and waits one drain margin, so an effect begun under the lease
has finished; it reports done only after that. Only then does the person
name the owner in a machine file. With the hub down, the person stops it
first if it still runs, runs the command against its store, which records
the disable the same way, waits out one lease and its drain margin (6
minutes) since the hub last answered, and only then edits the machine
file; the hub is not started again until the disable is recorded.
A disable is not rollbackable state: it is also written through the
core's disable-record operation to a store outside what `jig hub backup`
copies and restores, and the hub reads both at every start, so restoring an
earlier backup never lifts it. The process adapter keeps that record in a
file beside the hub's machine file; the Cloudflare adapter keeps it in a
key-value namespace of its own, outside the partitions' point-in-time
restore. Each repository's record is versioned: a disable and an undo are
entries with a rising generation, and the hub takes the entry with the
highest generation per repository across both stores, so an undo is a
tombstone that a restored older disable cannot override. Only
`jig hub release-owner --undo <repository>` writes one. It refuses until
the person has removed the repository's owner claim from the machine file.
The undo then waits until every enrolled host has sent a `hello`, after
the undo was requested, that reports no owner claim for the repository in
the configuration the host runs on and no running tick that began with
one; each host answers for itself, so one host's file edits never gate
another's. A `hello` sent before the request never counts. A host whose
later `hello` reports a claim again cancels the undo, and a drain margin
must also have passed since the last acknowledgement. Only
then does the hub name an owner again, so the local owner and a hub-named
owner never overlap. A
machine-file edit alone never transfers an owner duty while the hub may
still name an owner. This is the one exception to "works
as it does today": it is stated in the levels above, in ADR-0016's
decision and in the owner-lease wave's acceptance, so an implementation
never restores a duty during a partition. The duties stay on hosts; moving any
of them into the hub itself waits until a duty is shown to need it.

No duty comes back on its own after a timeout, because a host that cannot
reach the hub cannot tell a hub that stopped from a partition in which the
hub has named another owner; a timed fall-back would make two owners in
the second case. What waits is bounded in kind: notices, label and board
writes, the steward and reflection findings pause, while drives and
pickups go on. So the hub is assumed available as a single machine is,
not more: a host that has not reached the hub for 30 minutes, owner or
not and from the first wave, which has no owner leases, raises a
[need](../GLOSSARY.md) on its own receipt and dashboard, so the person who
runs the hub is told by the hosts even when the hub cannot tell anyone,
and that person either restores the hub or takes the repository off it
as above.

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
    ([Tracker facets chapter](../plugin/protocol/tracker-facets.md));
  - `repository-share`, so one repository's long queue does not starve
    the others;
  - `host-preference`, hosts a repository or an item asks for (a host
    ranker);
  - `load`, the host whose load factor is lowest (a host ranker).
- **A ranker of a team's own: `command`, on the process adapter only.** It
  runs a program the hub's settings name, hands it the host and the
  candidates with their facts as JSON on standard input, and reads back an
  order or a value per candidate on standard output, within a deadline of
  500 milliseconds, under the host's 2 seconds for the call. The hub runs
  one such program at a time and reuses its answer for a host for one
  tick interval. A command that fails, times out or answers out of shape is
  skipped for that offer and shown on the hub's status, and the rest of
  the policy still ranks. Only the hub's own settings name a command,
  never a repository's file, since the hub runs it with its own identity.
  A serverless adapter runs no program, so it refuses a policy that names
  `command` when the policy loads.
- **Named policies, chosen per repository.** The hub's settings define
  policies by name and a default. A repository may name one of them in its
  `.config/jig.yaml`, which a host reads from its clone of the default
  branch and sends in `hello`, since the hub's App cannot read a
  repository's files: a choice of data, never a program.
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
  source feed's reads (`hello`, `snapshot`, `changes`, `settlement.get`,
  `log.rows`, `receipt.get`, `thread.get`) to a viewer the front names: a laptop's dashboard reaches
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
viewer, and see the repositories its grants give them. A viewer's grant is
a line in the hub's settings: the identity the front names, and the
repositories or the word `all` it may see; editing it is recorded in the
audit trail. A host's reported records are shown only to viewers, and
through `jig ask` to hosts, whose grant or scope covers their repository.
What hosts report is untrusted text, as the forge's text is: the page
renders it as text, never as markup, and `jig ask` hands it to an agent
fenced as quoted data, never as instructions. A sign-in of the hub's own,
for a team without a private network, is left out until a team needs it.

### How it fits the rest of Jig

| Part of Jig | Without a hub | With a hub |
| --- | --- | --- |
| `do-item`, `drive-pr`, `work-batch` and the review skills | Their own fences | Unchanged: they never call the hub, except an enrolled host's drive pass making the optional watch call below |
| The dispatcher's tick | Reads the forge and the tracker itself | Reads only the hub's world view, bar a fence's read-back; asks it before each claim; reports its records; falls back to reading itself |
| The change probes (one per service, each on its own interval) | Ask the forge, Linear and Jira ([refresh cadences](dark-factory-dispatch.md#refresh-cadences)) | Replaced by the hub's change feed while it answers, which the events move; run again when it does not |
| The dispatcher's local loop | Reads the host's gauges, processes and sessions, and calls nothing outside | Unchanged: the hub cannot see this host's processes |
| A drive pass waiting for checks | Polls its pull request every 30 seconds | Polls as without a hub, or, where the measurement showed drive polling matters, waits on the change feed and reads only the kinds that moved |
| `jig ask`, `jig send`, `/jig:operator` | Read this machine's records and the forge | `ask` may read another host's records from the hub; `send` still writes as the person, never through the hub |
| The dispatch dashboard | Shows its own machine | May read the hub's feed and show every host, and the hub's health |
| The Jig plugin for Orca | Reads this machine's line | Unchanged; reading the hub's feed is a later step of its own |
| The steward, notices, labels, reflection | On the host whose machine file owns the repository | On the host the hub names owner |
| `jig gc` | Cleans the host | Also trims the hub's database where the process adapter runs |
| The records registry | The machine, the working tree, the forge and tracker | One more medium, the hub, for its enrollments, leases, world view and copies |

### Where it lives

`jig hub` is `plugin/hub/`, registered in `plugin/jig.ts` beside `dispatch`,
`gc`, `ask` and `send`, and released with the plugin, so a host and its
hub agree on the protocol by version, within the window
[The host protocol](#the-host-protocol) states. The core is `plugin/hub/core/`, the
one directory the portability gate covers, and each adapter is a directory
of its own under `plugin/hub/`, the process adapter's `plugin/hub/process/`. `jig install hub` installs the
process adapter's `jig hub serve` as a resident job, restarted when it
fails and when the installed copy changes, the way the dispatch
dashboard's reader is installed; the container image is built from the
same release. The Cloudflare adapter's source ships with the plugin too,
so a team deploys the version its hosts run, with the platform's own
deployment tool and its own account. The hub's own settings are in a file
of its own where it runs (its address, its database, its forge and tracker
identities and webhook secrets, its identity key, the viewer grants, the
collector and external monitor it reports to when set, the people it
notifies), readable by the hub's user alone; on the Cloudflare adapter the
secrets are the platform's encrypted secrets instead. A host names its hub
in its machine file (`hub.url`) with the identity fingerprint it pinned,
and keeps the credentials `jig hub join` gave it in its state folder.

### Running a hub

Whoever asked for the hub runs it; for one person that is that person,
and for a team someone who can act as the hub's OS user or administer its
platform account. No one need be paged at night: a hub that stops returns
its hosts to dispatching alone, and only the owner duties wait, which the
hosts announce ([Owner duties](#owner-duties)). The routine work:

- **Setting it up once**: create the GitHub App with the permissions named
  above and install it on the served repositories; create the tracker
  application; set up the tunnel's path rule; on a shared machine, the
  hub's OS user and container. `jig doctor hub` checks each.
- **Upgrades**: the hub is upgraded with the plugin, before its hosts,
  through `jig install hub` on the process adapter and the platform's
  deployment tool on the Cloudflare adapter.
- **Backups**: `jig hub backup`, daily by default, of the part that cannot
  be rebuilt.
- **Rotation**: the webhook secrets and the App's private key once a year,
  and at once on suspicion. The hub accepts two webhook secrets per source
  while one replaces the other (`jig hub rotate webhook <source>`), and
  GitHub holds two App keys at once, so neither rotation drops a delivery.
- **Recovering from a compromise**, in this order: stop the hub; revoke
  the App's private key on GitHub and make a new one; rotate every webhook
  secret; revoke the tracker application's tokens and rotate its secret;
  make a new identity key, which voids every host's pin, credential and
  watch credential, so each host enrolls again; delete the database's
  copies of host records and the world view, which come back on their
  own; then start the hub and approve the hosts again, checking each
  request's details. The audit trail says who held what before.

## Build order

One pull request per step, each shippable alone. The seams come first and
are worth building for themselves: each makes the dispatcher easier to test
and closes a gap it has today, and none of them adds a write or a read to
a host that dispatches its repositories alone. Each wave after the first is
planned in detail, and built or not, by the person who asked for the hub,
once the wave before it is in use.

### Before the first wave: a measurement

Design and planning go on now, and the seams may be built, but building
the first wave waits on evidence that hosts spend what the hub would save:

- **A week of the cost ledger**, taken after the drive's conditional reads
  ([#1432](https://github.com/jig-harness/jig/pull/1432)) and the tick's
  re-reads of waiting items ([#1436](https://github.com/jig-harness/jig/issues/1436))
  have landed, so it measures what remains once each host reads as cheaply
  as it can alone. It splits the dispatcher's reads from the sessions'
  reads per credential and per repository, and records drive passes'
  polling, its requests per pull request per day and its share of each
  shared credential's spend, which decides whether drives join the change
  feed.
- **A count of real deployments** that dispatch the same repositories from
  more than one host, and of the hosts in each.

The first wave is built when the week shows the dispatcher's reads and
drive passes' polling together are at least a third of a shared
credential's spend. Otherwise the hub waits, and per-host fixes come
first: conditional reads in the tick, and each host's own heartbeat to an
external monitor for the stopped-host notice.

### Seams, inside the dispatcher

1. **One shared records implementation, chosen by setting.** The tick, the
   follow-up marker, `jig ask` and the comment listing reach claims only
   through `SharedRecords`, chosen by `records.shared`, rather than calling
   the forge's implementation and parsing comments directly.
2. **The world view apart from the machine view.** The tick's reads of
   the forge and the tracker go through one interface its caller can
   supply, with each fact's class bound, and the observe phase stops
   rewriting forge facts with this host's launch records. The check of a
   fact that gates a write stays a read of the forge at use.
3. **A pickup claim.** The shared target gains a work key, and a pickup
   publishes a claim before its workspace opens, on the forge and tracker
   medium that already exists. Only a repository that more than one host
   dispatches writes it; a repository one host dispatches alone pays no
   extra write.
4. **The GraphQL budget gated.** The tick reads GitHub's GraphQL bucket
   and stops reading it before it is spent, as it already does for REST.

### First wave: the portable hub, fed by events, read by every host

1. The core's ports and the portability gate; the outbound library's
   portable parts split from its machine stores, with a forge transport
   over `fetch`; the cost ledger keyed by repository as well.
2. The storage port through Drizzle, its partitioned schema, its migrations
   and the vendored bundle; the scheduling port and the job helper.
3. The process adapter, `jig hub serve`, `jig install hub` and the
   container image, installed under the hub's own OS user on a machine
   that runs sessions.
4. Enrollment with the pinned identity, `hello` and `report` with paging,
   the audit trail, and `jig hub status`.
5. Webhook intake from the hub's GitHub App and from Linear's application,
   with signatures verified, served-queue filtering, redrive from the
   delivery log, and the webhook-only listener a tunnel publishes.
6. The world view from events, with payload facts, per-target coalescing
   and single reads; the active targets' re-validation; the reconciliation
   sweep in chunks.
7. The change feed and the dispatcher reading through the hub: `changes`
   with the host's scope and `read` for the tick and the change probe, with
   the fall-back to reading itself.
8. Drive passes on the change feed, only if the measurement before the
   first wave showed drive polling at 15% or more of the busiest shared
   credential's spend: the drive's wait for its checks calls `changes` for
   its pull request with the watch credential in place of its sleep
   between polls, and polls as today when the call fails. Below that
   share the step is not built and drives keep polling.
9. The observability port, its signals and thresholds, `health` and
   `jig doctor hub`; the collector and the external heartbeat as settings,
   each checked when set.
10. The source feed served from the hosts' reports, and the dashboard
    reading it: one dashboard across hosts, the hub's health on it.

Done when, on about 5 hosts dispatching the same repositories through one
hub:

- over 7 days, per repository per day, the hub's GitHub spend, REST
  requests and GraphQL points apart, is at most 1.2 times what one host
  spent reading those repositories alone for the dispatcher;
- the enrolled hosts' own dispatcher reads that spend a forge limit are
  about zero, the fences' read-backs and the checks at use aside;
- change-to-host latency, the share of reads served from the hub's copy
  and drive passes' requests per pull request per day are reported against
  the measured baseline;
- a webhook delivery dropped on purpose is found by the active targets'
  re-validation or the sweep, within its class bound, and counted as drift;
- a hub stopped mid-tick costs that tick nothing but its receipt's note,
  and, where drives wait on the feed, a drive one poll interval;
- the portability gate passes; and one dashboard shows every host and the
  hub's health.

In this wave `hello` names no owner and no lease exists: each repository's
owner is the host its machine file names, as today.

### Second wave: the Cloudflare adapter

The core run on Workers, with one Durable Object per partition, alarms and
cron triggers, hibernatable WebSockets for the change feed, and an
identity-checking front before every path but `/webhooks/` whose signed
token the Worker validates itself, with the platform's own subdomain and
preview addresses turned off and a service token per host. Its plan states
the hub's monthly cost at the target load from a load test before it is
built.

### Later waves, each planned when the one before is in use

- **Claims and owner leases, and a silent host noticed.** Grants and
  owner leases coordinate hosts, which
  [ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md) declines and
  [ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
  decides for enrolled hosts. The
  hub's implementation of `SharedRecords` in front of the fences, pickup
  claims, leases and their renewal, the replay after an outage, the owner
  named by `hello` with its lease, the restart quarantine, and the
  silent-host notice. Done when no two hosts do an owner's effects at once
  through a partition and a restart of the hub, and when a load test of 50
  simulated hosts, 30 repositories, 500 open targets and 10,000 deliveries
  a day meets [The size it is built for](#the-size-it-is-built-for) on the
  process adapter and on the Cloudflare adapter's partitions. This is the
  wave that proves 50 hosts, since lease renewals are the load that grows
  with hosts.
- **The chat bridge inside the hub** ([chat.md](chat.md)), where the
  chat tool's events may come to the hub's webhook path in place of a
  connection the bridge holds open; that choice is made, and recorded in
  [ADR-0022](../docs/adr/ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md),
  in that wave, with the chat source's signature scheme.
- **Handing out work.** `offers` and the tick's plan taking them as input,
  with the default policy alone and `jig hub offers --explain`; then the
  policy language (named policies, `weighted`), then the `command` ranker,
  each a step of its own; then each further built-in ranker, one at a time,
  when a team asks for it.
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
  with a slow sweep spend reads where something changed, plus the
  re-validation of active targets and the read-throughs the freshness rule
  requires for a target whose confirmation has expired.
- **Cancelling or steering a host's session from the hub.** A session is
  the host's; the hub's notices go to people, and `jig send` stays the way
  a person steers.
- **More than one node.** One hub per person or organization, partitioned
  as [The size it is built for](#the-size-it-is-built-for) says, carries the
  size Jig is built for; a hub that outgrows one is a decision of its own.
- **A hub's own sign-in for people.** The private-network front names the
  viewer; a sign-in of the hub's own waits for a team that cannot use one.
- **Hubs talking to each other**, and a host enrolled in two hubs.
- **A dashboard that reads each host over SSH, or merges the source feeds
  of hosts it can reach.** Either would be a second way to build one view
  across hosts, with none of the hub's single read, its notice of a
  stopped host or its view on a phone. A dashboard that merges several
  hosts' feeds over a private network is reconsidered, as the dashboard's
  own design item, if the measurement before the first wave stops the hub.
- **A hub with no webhooks.** Feeding the world view from the sweep and
  the active targets' re-validation alone would spare the smallest form
  its App webhook and tunnel, at the cost of staleness up to each class's
  bound; the first wave requires the App and the tunnel.
- **Serving the reads a session makes.** A drive's own reads of its pull
  request stay with its account and are not multiplied across hosts; the
  change feed only tells a drive when to make them.
