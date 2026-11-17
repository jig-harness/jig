---
title: "ADR-0016: An optional hub serves hosts that keep authority"
type: adr
status: draft
description: "Jig adds an optional shared control plane, the hub: a portable core behind small ports, run by a process adapter (Bun and SQLite, also a container image) and later a Cloudflare adapter, fed by the forge's and the tracker's signed webhooks with a slow reconciliation sweep, and the only reader of the forge and the tracker for enrolled dispatchers; it puts claims with leases in front of the forge and tracker claims, notices a stopped host, serves one view of every host and may offer work; no level of use requires it, hosts keep authority and their own credentials, and a hub that is down returns its hosts to dispatching alone"
lifecycle: permanent
version: "1.2"
last_updated: 2026-11-17
owner: maintainers
decision_date: 2026-11-11
supersedes: ~
superseded_by: ~
tags: [adr, records, dispatcher, hub, control-plane]
---

# ADR-0016: An optional hub serves hosts that keep authority

**Status:** Draft · **Date:** 2026-11-11 · **Deciders:** Jig's maintainers through pull-request review

## Context

Each host that runs the [dispatcher](../../GLOSSARY.md) reads the forge and
the tracker by itself, starts sessions and shares what it did through
records ([ADR-0013](ADR-0013-records-not-a-daemon.md)). No coordinator sits
between hosts, and no host accepts a connection from outside
([ADR-0011](ADR-0011-the-dispatcher-targets-orca-first.md)). For one host,
that is the whole design. Several hosts that dispatch for one team or one
person meet these forces:

- **Reads multiply.** Every host reads the same pull requests and the same
  queues on its own timer, against limits that belong to one credential or
  one organization. A single host has already spent a tracker's hourly
  limit for one person by itself; each further host spends it again.
- **Polling spends reads where nothing changed.** Even one reader asks
  about every target on every tick, and still learns of a change only at
  its next tick.
- **A dead host's work waits.** A launch claim on the forge has no expiry,
  and nothing outside the host notices that it died, so its work waits
  until a person does.
- **Pickups cannot be shared.** Nothing claims an item before a session
  opens, so one repository's pickups are dispatched from one host only.
- **Nobody outside a host learns that it stopped**, which is one of
  ADR-0013's conditions for reopening.
- **A person with several machines has no single view** of the work they
  run.
- **Teams run services in different places**: on a machine they keep, in
  a container, or on a serverless platform, where no process, subprocess
  or local file exists.

## Decision

Jig adds an optional [shared control plane](../../GLOSSARY.md), the
[hub](../../GLOSSARY.md), released with the `jig` plugin. A host enrolls
in it with a device grant and then calls it; the hub keeps one world view
of the forge and the tracker for every enrolled host, puts claims with
leases in front of the forge and tracker claims, notices a host that
stopped calling, serves the source feed of every host's work, and may
offer work to a host with free slots. Its design is
[design/control-plane.md](../../design/control-plane.md).

### A portable core with adapters

- The hub's logic is a [portable core](../../GLOSSARY.md) that reaches
  storage, request serving, scheduling, outbound calls and observability
  only through small [ports](../../GLOSSARY.md). The core runs no
  subprocess (no `gh`: its forge and tracker calls are `fetch` requests
  through the shared outbound library,
  [ADR-0021](ADR-0021-outbound-calls-are-governed.md)), imports no Bun- or
  Node-only module and touches no local file. A gate reads the core's
  imports, and those of every shared module it imports, and fails on any
  of these.
- [Adapters](../../GLOSSARY.md) run the core. The first is the process
  adapter: `jig hub serve`, a Bun process with SQLite, also shipped as a
  container image. The second is a Cloudflare adapter: Workers, with a
  Durable Object's SQLite storage or D1, and alarms and cron triggers. A
  ranker that runs a program (`command`) is the process adapter's alone.
- Storage goes through [Drizzle](../../GLOSSARY.md): one schema in its
  SQLite dialect and one implementation of the storage port's operations
  serve `bun:sqlite`, D1 and Durable Object SQLite, with migrations
  `drizzle-kit` generates and the repository keeps. Queries use only what
  SQLite and PostgreSQL both support. A PostgreSQL adapter is designed for
  and built only when a team needs a managed database: a second schema
  module in Drizzle's PostgreSQL dialect and a second implementation of
  the port's operations, held to the first by a test comparing the two
  schemas and by one contract suite. Drizzle reaches the plugin as a
  bundle Jig builds from the pinned package and vendors, as
  [ADR-0001](ADR-0001-bun-typescript-toolchain.md) requires of code that
  runs from the plugin; `drizzle-kit` is a development dependency that
  never ships.

### Events first, and the hub the only reader

- The forge's and the tracker's [webhooks](../../GLOSSARY.md) are the
  hub's main feed: GitHub through a [GitHub App](../../GLOSSARY.md) of the
  hub's own, whose one webhook covers every repository of its installation
  and whose reads count against the installation's own limits; Linear
  through a signed webhook. Every delivery's signature is verified before
  anything else is read, and a delivery is admitted once by its id.
- A [reconciliation sweep](../../GLOSSARY.md), hourly by default, reads
  every target with conditional requests and corrects what deliveries
  lost or misordered; each change it finds that no delivery brought is
  counted as drift. A tracker whose deliveries the hub cannot verify is
  read by the change probe's question at the dispatcher's interval.
- While its hub answers, an enrolled dispatcher reads the hub's world view
  and makes no forge or tracker read of its own but a fence's read-back.
  When the hub does not answer, it reads for itself.
- Only `/webhooks/` is public. On the process adapter a
  [tunnel](../../GLOSSARY.md) the hub's machine opens outward (Cloudflare
  Tunnel or Tailscale Funnel, for two) publishes that path and nothing
  else; the host protocol, the dashboard and the source feed stay on a
  private network or behind an identity-checking front, and are never
  published through the tunnel.

### The rules it keeps

- **No level of use requires it.** The skills never call it, the
  dispatcher runs without it, and a host whose hub does not answer reads
  and claims by itself, as it does without one. The one exception is an
  owner's duties (notices, labels, board writes, steward, reflection
  findings): they run only under a lease the hub grants, so while it
  does not answer a host does the duties that are safe to repeat and
  waits for the rest.
- **A host keeps authority over what it did.** The hub keeps copies of
  what hosts report and never edits one, keeps no phase of its own, and
  derives every column and thread when it is read.
- **A host keeps its own credentials.** The hub mints no forge or tracker
  token for a host; every write a host or its sessions make uses the
  host's own accounts. The hub writes nothing on the forge or the tracker
  but the chat bridge's named writes.
- **The forge and tracker claims stay the fences.** The hub's grant comes
  before them and stops most races early; when the forge says otherwise,
  the forge wins.
- **No server timer rewrites a host's work.** A lapsed lease releases its
  claim and nothing else; the hub never fails, cancels or steers a host's
  session.
- **Hosts call the hub; the hub calls no host.** The dispatcher keeps no
  resident process: its tick and its change probe make request and answer
  calls while they run. The hub is the only resident service the hub
  level adds.
- **A person's act is made with that person's credential**, from the
  person's own machine, never through the hub.
  The one exception is a request a person makes through the hub's
  [chat bridge](../../GLOSSARY.md), posted under the bridge's own identity
  and naming the person
  ([ADR-0022](ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md)).
- **It is observed as M11 says.** The core emits a closed set of typed
  events, metrics and spans through an observability port, each failure
  by its `Outcome` code; the process adapter exports them as OpenTelemetry
  (OTLP), the Cloudflare adapter through the platform's own observability
  or OTLP. Every declared metric has a wired source, which M11's
  no-dark-instruments check holds; each scheduled job and each host's
  report is stale, never green, past its cadence; and the hub sends a
  heartbeat to an external monitor, a dead-man's switch for the hub
  itself.

### Where it stands against earlier decisions

For enrolled hosts, this supersedes ADR-0013 where it declines a
coordinator: the hub's offers suggest which host takes which work. Every
host that is not enrolled, and every host while its hub is unreachable,
stays under ADR-0013 alone, except for the owner duties above.

ADR-0011's refusal of an inbound route holds for every host's dispatcher.
A machine that runs the hub's process adapter gains one route, to the
hub's webhook path only, through a tunnel it opens outward; its
dispatcher, its dashboard and the hub's host protocol stay unreachable
from outside.

### Concurrency and failures

[ADR-0012](ADR-0012-failures-as-values.md) reserves reconsidering Jig's
programming model for a resident process with real concurrency, and the
hub is one: it takes deliveries, answers hosts, sweeps and renews leases
at once. Outcome is kept for alignment across the plugin and the hub:
Effect's structured concurrency is not needed beyond one small helper for
the sweep and the alarms, and Effect stays declined.

- The hub's core and adapters return `Outcome`
  ([plugin/shared/outcome.ts](../../plugin/shared/outcome.ts), which
  imports nothing and so runs on every adapter). A port's implementation
  turns what its platform throws into one; anything else that throws is a
  `Defect`, caught once at a defect boundary.
- The defect boundaries are the units of work: each webhook delivery, each
  request, each run of the reconciliation sweep, each alarm or lease turn.
  Each unit carries one `AbortSignal` with its deadline into every port
  call, and a defect ends that unit alone.
- Units share nothing in memory; what a later unit needs is in storage.
- A change never spans an await: it is one conditional statement, or a
  batch prepared before the first statement is sent and committed
  atomically by the storage port (a synchronous transaction on
  `bun:sqlite` and Durable Object SQLite, a batch on D1, a transaction on
  PostgreSQL). The decision lives in the statement's condition.
- Background work runs only as scheduled jobs through the scheduling
  port, each idempotent, resumable from stored progress and held by a job
  lease row, so two runs of one job never overlap.

## Alternatives considered

- **Hosts dispatching alone, as now.** Rejected: reads keep multiplying
  with each host, a dead host's work waits until a person notices,
  and pickups stay on one host.
- **A shared read cache that coordinates nothing.** Kept as the hub's first
  wave, which ADR-0013 already allows. Alone it leaves dead claims, shared
  pickups and the stopped host open.
- **A hub that polls, with webhooks as hints.** Rejected: it spends reads
  on every target whether or not it changed, and lags every change by an
  interval. Events with a slow sweep spend reads where something changed,
  and the sweep's drift shows whether the events can be trusted.
- **A hub bound to one runtime**, a Bun process only. Rejected: a team on
  a serverless platform could not run it, and moving later would mean
  rewriting the logic rather than adding an adapter.
- **Short-lived tokens the hub issues to hosts.** Rejected: every host's
  writes would depend on the hub, so its outage would stop work instead of
  returning hosts to the level below, and the hub would hold write access
  it otherwise never needs.
- **Plain SQL with no mapper.** Rejected: three SQLite drivers with
  different calling styles, and a PostgreSQL dialect later, would each
  need their own glue; Drizzle supplies the drivers and typed queries,
  at the cost of one vendored bundle.
- **Effect for the hub alone.** Declined: two error models in one plugin
  for one component, for structured concurrency that one helper covers.
- **The forge's own job system**, each host registered as a self-hosted CI
  runner. Rejected: it binds the line to one forge's CI, a CI job fits
  poorly with a session that waits hours for a person, tracker events need
  a bridge into it, and the job's state lives in the CI system rather than
  in records Jig reads.
- **A control plane that owns each job's phase and directs its hosts.**
  Rejected: a stored copy of a pull request's state drifts from the pull
  request, a server timer that marks a host's work failed ends runs that
  were healthy, and a host could not work without it, so the levels below
  would lose their standing.
- **A message bus.** Rejected in ADR-0013; nothing here changes its
  reasons.
- **A hosted service that Jig's maintainers run.** Rejected: Jig is
  self-hosted tooling, and a team's code and tracker data stay on machines
  or platform accounts it chooses.

## Consequences

### Benefits

- Hosts dispatching the same repositories spend no reads of their own for
  the dispatcher; the hub spends reads only where an event or the sweep
  finds a change.
- A change reaches every host's next probe within seconds of its event.
- A stopped host is noticed: a person is told, and its leases lapse, so
  the hub grants its work to another host, which takes a drive over by the
  forge's own path; a silent host's follow-up is named for a person.
- One repository's pickups can be dispatched from several hosts.
- One dashboard and one phone page show every enrolled host's work and the
  hub's health.
- A team runs the same hub on its own machine, in a container or on a
  serverless platform.

### Costs

- One more resident service where the hub runs, upgraded with the plugin.
- One public path, a tunnel or a platform route to keep, and webhook
  secrets to hold and rotate.
- One organization identity (a GitHub App) with read access to every
  enrolled repository, kept in one place.
- The core's portability is a constraint on every change to it, and the
  outbound library splits its portable parts from its machine stores.
- One vendored library, Drizzle, and a development dependency,
  `drizzle-kit`.
- One more records medium, the hub, which the registry and its gate must
  hold.
- A protocol between hosts and hub that must stay compatible across
  versions, through named capabilities.
- A host that is not enrolled keeps reading a stopped host's forge claim as
  live.

## When to reopen

- The sweep's drift stays high enough that events cannot be the main
  feed, or low enough that the sweep's cadence can be slowed further.
- The hub's grants and the forge's claims disagree often enough that the
  forge claim's writes are not worth keeping, or rarely enough that the
  hub could be the only fence.
- A team outgrows one hub with one database.
- A team needs to sign in to the hub without a private-network front.
- The job helper grows toward a concurrency library of its own, which
  reopens Effect.

## Extraction (decisions-become-checks)

When the hub is built: the portability gate reads the core's imports;
[`scripts/check-throws.ts`](../../scripts/check-throws.ts) covers
`plugin/hub/` as it covers the dispatcher; M11's no-dark-instruments check
holds the hub's metric registry and its event-schema lint the hub's
events; a test fails a delivery whose signature does not verify; the
dispatcher's tests run a tick against a hub that does not answer and find
it reads and claims by itself; the records registry's gate holds the hub
medium's kinds; and a test compares the PostgreSQL schema with the SQLite
one once both exist. That no hub code path edits a host's record or ends a
host's session is review's to hold.
