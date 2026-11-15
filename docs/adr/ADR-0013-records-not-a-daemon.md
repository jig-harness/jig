---
title: "ADR-0013: Components share records, not a daemon"
type: adr
status: draft
description: "Jig's components share registered records on the machine, in the working tree and on the forge and tracker, and each derives what to do from records it does not own; no resident daemon or message bus coordinates them, one resident reader per machine may serve a person's view of them, a chat bridge may turn a person's click into one request, and the record names the conditions for reopening that"
lifecycle: permanent
version: "1.5"
last_updated: 2026-11-13
owner: maintainers
decision_date: 2026-11-04
supersedes: ~
superseded_by: ~
tags: [adr, records, dispatcher, drive, dark-factory, dashboard]
---

# ADR-0013: Components share records, not a daemon

**Status:** Draft · **Date:** 2026-11-04 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's execution line is several programs that never share a process: the
[dispatcher](../../GLOSSARY.md)'s tick, a drive's loop control and the
passes it starts, a pickup's session, a follow-up, `jig gc`, a person's own
session. They coordinate through what each leaves behind: a drive's state on
the machine, its mailbox in the working tree, its ledger on the pull
request, the dispatcher's launch records, a follow-up marker, a claim on the
tracker. Each of those records was designed on its own, with its own
envelope, its own idea of who wrote it and its own versioning, and nothing
lists them in one place ([plugin/RECORDS.md](../../plugin/RECORDS.md) now
does).

The obvious alternative is a resident coordinator: a daemon that every
component talks to, or a message bus they publish on. These constraints
weigh against it.

- **The actors rarely coexist.** A drive pass lives minutes, a dispatcher
  tick seconds, and a person answers a parked question hours later. A
  message from one to another must outlive its sender anyway, so every
  message is a durable record whether or not a bus carries it.
- **A bus across hosts needs an inbound route.** The dispatcher runs on a
  host that accepts no connection from outside: it reads the forge and the
  tracker and starts sessions, and listens only on a private address for its
  dashboard ([ADR-0011](ADR-0011-the-dispatcher-targets-orca-first.md)
  declines a webhook-fed daemon for the same reason).
- **A supervised process with real concurrency is a threshold.**
  [ADR-0012](ADR-0012-failures-as-values.md) keeps plain TypeScript with
  failures as values, and reserves a change of programming model for the
  day Jig holds a resident process with real concurrency. A coordinator
  daemon is that process. A reader that answers each request from one read
  of the records, with no state that two requests change, is not.
- **An early wake-up works without one.** The `jig` plugin
  for Orca runs a tick when an agent waits, blocks or finishes
  ([design/orca-integration.md](../../design/orca-integration.md#the-jig-plugin-for-orca)),
  with the machine's timer catching what an event misses.
- **A person needs one view of the line.** The [dispatch dashboard](../../GLOSSARY.md)
  ([design/dispatch-dashboard.md](../../design/dispatch-dashboard.md)) shows every
  [piece of work](../../GLOSSARY.md) across a person's machines, and a page
  that stays open needs a process that stays up to answer it. That process
  reads records and answers; it coordinates nothing, so it is not the
  coordinator these constraints weigh against.

## Decision

Jig's components share records through registered envelopes on three
media: the machine, the working tree, and the forge and tracker. Every
record kind is registered (`plugin/shared/records/registry.ts`) with its
medium, its owner, where it lives and its schema version, and a record that
carries the envelope says what it is, its key, who wrote it and when, in
the same fields everywhere (`plugin/shared/records/envelope.ts`). A gate
fails a hidden-marker literal, a tagged drive state family or a SQLite
table declaration the registry does not hold. Review must keep arbitrary
file-backed records and dynamically assembled names in the inventory.

Each component derives what to do from records it does not own and writes
only its own: the dispatcher reads the drive ledger, the tracker and the
running sessions, and keeps only what it did. No resident daemon or message
bus coordinates them.

One resident reader per machine is allowed: the dashboard, which serves a
person's view of the line. It listens on loopback (127.0.0.1, which nothing
outside the machine reaches) or on a socket only a
[private-network front](../../GLOSSARY.md) reaches, and opens every
database read-only. It holds no request, no component reads from it, and
the line never waits on it, so stopping it changes nothing the line does. A
write it makes for a person is one of the records the line already reads,
written as that person
([ADR-0014](ADR-0014-addresses-are-derived-and-requests-are-records.md));
a parked decision's answer from its page goes from the person's browser to
the forge, never through the reader
([ADR-0019](ADR-0019-the-dashboard-page-answers-as-the-person.md)).
It is the dispatcher's own dashboard with more views, so Jig still has one
kind of listening server beside the hub ([ADR-0016](ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)),
not a second beside it.

A [chat bridge](../../GLOSSARY.md), where a team runs one, is the other
resident process allowed: inside the hub, or on a host that is not
enrolled. It listens on no socket, connects out to the chat tool, and
turns each click into one request the line already reads, so it
coordinates nothing
([ADR-0022](ADR-0022-a-chat-bridge-turns-a-click-into-one-request.md)).

## Alternatives considered

- **A NATS-like message bus.** Rejected: the senders are gone before the
  receivers start, so every subject would need a durable stream, which is a
  record store with a server in front of it. Across hosts it needs the
  inbound route the dispatcher refuses, and its server is a process to
  supervise and upgrade on every host.
- **An event log as the source of truth.** Rejected: the dispatcher derives
  what is wanted from records it does not own (the forge's pull requests and
  their ledgers, the tracker's items, the runtime's sessions), which change
  without telling it. A log of its own events cannot say what is wanted; it
  can only say what it did, which the outcome log already keeps.

## Consequences

### Benefits

- Nothing has to be running for the line to resume: a stopped host loses no
  message, and the next tick reads the same records.
- A new reader of a record needs its registry entry and the codec, not a
  connection.
- The forge and the tracker stay the place a second host and a person read
  the same facts.

### Costs

- A second host sees another host's state only as fast as the forge
  carries it, a tick or a round behind.
- Every record is polled; a change is noticed at the next read, not pushed.
- The registry is one more thing a change must update, held by its gate.
- A machine that serves the dashboard keeps one more process running, restarted
  when its installed copy changes. The line does not need it; the page
  does.

## When to reopen

Reopen this when one of these holds:

- a second host must see another's state within seconds, not at its next
  tick;
- a nudge to a running session needs a connection rather than a keystroke
  into its terminal;
- someone outside a host must be told that a dispatching host has stopped;
- a second person acts through a host's dashboard, or needs a scope Jig itself
  keeps rather than one a private-network front's grant carries;
- hosts that dispatch for one person or one organization read the forge and
  the tracker several times over, against one credential's limits.

Then build a small control-plane service with a database, which the hosts
write to and a person reads, not a bus. A service that only keeps the
hosts' records and serves them to readers fits this decision. The
[shared control plane](../../GLOSSARY.md)
([design/control-plane.md](../../design/control-plane.md)) also offers the
hosts their work, which is coordinating them;
[ADR-0016](ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
decides it, and supersedes this record where it declines a coordinator for
enrolled hosts only.

## Extraction (decisions-become-checks)

`scripts/check-records-registry.ts` in the gates fails a hidden-marker
literal, a drive state-file family or a SQLite table under `plugin/` that
the registry does not hold, and a registry entry the code no longer names.
The gate parses source with oxc-parser rather than a tokenizer because regular
expressions, division and nested template expressions determine where SQL
string and template literals begin and end.
That no component opens a listening socket other than the dashboard's, or
the hub's where one runs, is not checked, nor that the dashboard listens only on
loopback or on a front's socket; review holds both.
