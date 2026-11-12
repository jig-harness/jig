---
title: "ADR-0016: An optional hub serves hosts that keep authority"
type: adr
status: draft
description: "Jig adds an optional shared control plane, the hub: one self-hosted process that enrolled hosts call, which reads the forge and the tracker once for them, puts claims with leases in front of the forge and tracker claims, notices a stopped host, serves one view of every host and may offer work; no level of use requires it, hosts keep authority over what they did, and a hub that is down returns its hosts to dispatching alone"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-11
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
- **A dead host's work waits.** A launch claim on the forge has no expiry,
  and nothing outside the host notices that it died, so its work waits
  until a person does.
- **Pickups cannot be shared.** Nothing claims an item before a session
  opens, so one repository's pickups are dispatched from one host only.
- **Nobody outside a host learns that it stopped**, which is one of
  ADR-0013's conditions for reopening.
- **A person with several machines has no single view** of the work they
  run.

## Decision

Jig adds an optional [shared control plane](../../GLOSSARY.md), the
[hub](../../GLOSSARY.md): one process, `jig hub serve`, with one database,
released with the `jig` plugin and run on a machine its hosts reach. A host
enrolls in it with a device grant and then calls it; the hub reads the
forge and the tracker once for every enrolled host, puts claims with leases
in front of the forge and tracker claims, notices a host that stopped
calling, serves the source feed of every host's work, and may offer work
to a host with free slots. Its design is
[design/control-plane.md](../../design/control-plane.md).

It keeps these rules:

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
- **The forge and tracker claims stay the fences.** The hub's grant comes
  before them and stops most races early; when the forge says otherwise,
  the forge wins.
- **No server timer rewrites a host's work.** A lapsed lease releases its
  claim and nothing else; the hub never fails, cancels or steers a host's
  session.
- **Hosts call the hub; the hub calls no host.** The dispatcher keeps no
  resident process: its tick and its change probe make request and answer
  calls while they run. The hub is the only resident process the hub level
  adds.
- **A person's act is made with that person's credential**, from the
  person's own machine, never through the hub.

For enrolled hosts, this supersedes ADR-0013 where it declines a
coordinator: the hub's offers suggest which host takes which work. Every
host that is not enrolled, and every host while its hub is unreachable,
stays under ADR-0013 alone, except for the owner duties above. ADR-0011's refusal of an inbound route holds
for every host; the hub, which is not a host, may receive the forge's and
the tracker's webhooks, as hints that never replace its periodic reads.

[ADR-0012](ADR-0012-failures-as-values.md) reserves reconsidering Jig's
programming model for a resident process with real concurrency. The hub is
one: it reads, takes webhooks and renews leases for several hosts at once.
This decision keeps ADR-0012's values-not-throws model for the hub, since
its calls are bounded requests whose failures are coded answers, and
leaves cancellation and supervision of concurrent operations to the hub's
own stage 1 design, which records its choice here before it starts.

## Alternatives considered

- **Hosts dispatching alone, as now.** Rejected: reads keep multiplying
  with each host, a dead host's work waits until a person notices,
  and pickups stay on one host.
- **A shared read cache that coordinates nothing.** Kept as the hub's first
  stage, which ADR-0013 already allows. Alone it leaves dead claims, shared
  pickups and the stopped host open.
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
  it chooses.

## Consequences

### Benefits

- Hosts dispatching the same repositories spend about one host's reads
  between them.
- A stopped host is noticed: a person is told, and its leases lapse, so
  the hub grants its work to another host, which takes a drive over by the
  forge's own path; a silent host's follow-up is named for a person.
- One repository's pickups can be dispatched from several hosts.
- One dashboard and one phone page show every enrolled host's work.

### Costs

- One more resident process where the hub runs, upgraded with the plugin.
- One organization identity with read access to every enrolled repository,
  kept in one place.
- One more records medium, the hub, which the registry and its gate must
  hold.
- A protocol between hosts and hub that must stay compatible across
  versions, through named capabilities.
- A host that is not enrolled keeps reading a stopped host's forge claim as
  live.

## When to reopen

- The hub's grants and the forge's claims disagree often enough that the
  forge claim's writes are not worth keeping, or rarely enough that the
  hub could be the only fence.
- A team outgrows one process with one SQLite database.
- A team needs to sign in to the hub without a private-network front.

## Extraction (decisions-become-checks)

Not mechanically checkable until the hub is built. Then the dispatcher's
tests run a tick against a hub that does not answer and find it reads and
claims by itself; the records registry's gate holds the hub medium's
kinds; and that no hub code path edits a host's record or ends a host's
session is review's to hold.
