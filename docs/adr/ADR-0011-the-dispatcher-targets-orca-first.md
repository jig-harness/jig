---
title: "ADR-0011: The dispatcher targets Orca first"
type: adr
status: draft
description: "Herdr stays the first runtime for workspace lifecycle; the dispatcher, which starts the execution line's stages unattended, is built for Orca first, and other runtimes come through the same session runtime interface"
lifecycle: permanent
version: "1.1"
last_updated: 2026-11-13
owner: maintainers
decision_date: 2026-10-30
supersedes: ~
superseded_by: ~
tags: [adr, workspaces, dispatcher, dark-factory]
---

# ADR-0011: The dispatcher targets Orca first

**Status:** Draft · **Date:** 2026-10-30 · **Deciders:** Jig's maintainers through pull-request review

## Context

[ADR-0005](ADR-0005-herdr-is-the-primary-workspace-runtime.md) makes Herdr
the [workspace runtime](../../GLOSSARY.md) Jig's tooling is built and tested
for first: every part of Jig that opens, attaches to, steers or removes an
agent's workspace works in Herdr before any other runtime.

The [dispatcher](../../GLOSSARY.md)
([design/dark-factory-dispatch.md](../../design/dark-factory-dispatch.md))
is a new kind of tooling. It runs with nobody at the keyboard, on a timer,
and starts the stages of the
[execution line](../../FACTORY.md#the-line) (the steps
that carry one work item from pickup to a merged pull request) as agent
sessions: pickups, [re-arms and takeovers](../../GLOSSARY.md) of a stopped
or wedged pull-request drive, follow-ups. To do that it needs these from
the runtime it launches through, beyond a workspace:

- **an account roster**: the subscription accounts on the host, so a drive
  stopped by one account's usage limit is re-armed on another, and each
  account's sessions are capped;
- **a headless server reachable from a phone**: a server process that runs
  the sessions on a host with no desktop app open, which a person's phone
  connects to, so they answer a parked question from wherever they are;
- **a session registry**: which workspace holds a live session for which
  item or pull request, read by a program, so the dispatcher starts only
  what is not already running.

Orca has each of them today: managed accounts per host (`orca account list`),
a headless server (`orca serve`) that a paired desktop or phone app
reaches, and a machine-readable summary of every workspace and its agents
(`orca worktree ps --json`). Herdr keeps sessions alive on a remote host
and has a socket API, but has no account roster, so a dispatcher built on
it first would have to manage subscription accounts outside the runtime.
Herdr's own clients, its mobile app among them, are not evaluated here as
the dispatcher's way to reach a person: the missing roster decides.

## Decision

The dispatcher targets Orca first. It reaches the runtime only through the
[session runtime](../../GLOSSARY.md) interface its design defines (the
sessions in a repository's workspaces, opening a workspace, launching a
session on an account, notifying a person), and Orca is that interface's
first implementation, built and tested first.

ADR-0005 is narrowed, not reversed, and records the narrowing in its
[2026-10-30 amendment](ADR-0005-herdr-is-the-primary-workspace-runtime.md#2026-10-30--the-dispatcher-targets-orca-first-v11):
Herdr stays the first runtime for
workspace lifecycle, and the tools that open, attach to, steer, resume and
remove a worktree with its agent keep Herdr as their first-supported
backend. Only the dispatcher starts on Orca. Another runtime, Herdr among
them, joins the dispatcher as a second implementation of the same
interface, with nothing in the tick changed.

## Alternatives considered

- **Herdr first, per ADR-0005**: rejected for the dispatcher; the account
  roster would be built outside the runtime, as Jig's own service, before
  the first stage could run unattended. A Herdr implementation is added
  when Herdr can supply one.
- **A resident daemon fed by webhooks**: rejected; it needs an inbound route
  to the host and a process to supervise, and still needs a periodic
  reconcile to catch the events it missed. A stateless tick on the
  machine's timer reads the same records and loses nothing when stopped.
  An outbound wake-up channel can start ticks early later without changing
  this.

## Consequences

### Benefits

- The dispatcher's first stage can run unattended on a headless host, with
  accounts and a phone, using what the runtime already has.
- The interface keeps the tick free of Orca's command line, so a second
  runtime is an implementation, not a rewrite.

### Costs

- Orca's command line (`worktree ps`, `worktree create`, `agent launch`,
  `account list`) and its JSON become an interface Jig depends on, so an
  Orca release that changes them is work for Jig.
- Herdr and Orca are each first for different tooling: documents that name
  a runtime say which one a given tool targets first.
- Whether an Orca agent launch can bind an interactive session to an
  account is unverified, so the dispatcher launches headless passes only
  until it is shown to work.

## Extraction (decisions-become-checks)

Not yet checked by a gate. The dispatcher is built (`plugin/dispatch/`),
and its tick's tests run against a fake `orca` command. The Orca commands and
output fields it relies on are not yet listed in one place: the adapter's
header comment (`plugin/dispatch/lib/runtime/orca.ts`) names the commands, and
the [plugin README](../../plugin/README.md) describes the behaviour they give.
The inventory an Orca upgrade is assessed against is still to be written.

## Amendments

### 2026-11-13 — a process runtime joins Orca (v1.1)

Touches the Decision and the Consequences. A second implementation of the
session runtime interface is designed: the process runtime, which runs a
headless pass as a plain managed process in a git worktree Jig opens
itself, with no terminal and no desktop app
([design/dispatched-sessions.md](../../design/dispatched-sessions.md)). A
host chooses it in its machine dispatch file (`runtime: process`); a
repository never chooses a runtime. Orca stays supported, as an option a
host names (`runtime: orca`).

Two of the reasons in the Context no longer bind the dispatcher to Orca.
The account roster the dispatcher uses is its own: the accounts, their caps
and their walls live in the machine file and the dispatcher's records, and
a drive stopped by one account's usage limit is re-armed on another without
reading Orca's roster. And a person's phone reaches the dispatch dashboard,
which lists what waits on a person, so dispatched sessions send no phone
notices: no run marks its workspace or asks its runtime to reach a person.
The tick's `notify` stage, a notice per cause written into Orca's notices
workspace, stays on Orca as an option a host enables, and the process
runtime has none. The session registry is the one need left that a runtime
answers, and the process runtime keeps its own, read from its launch
records, the processes they recorded and the repository's worktrees.

The default stays Orca until the process runtime has run on a host that
dispatches, with every stage that host enables, for seven consecutive days
and at least 20 launches, and that week's outcome log shows the checks the
design lists under "Proof before the default changes": every run ended
with a closing report or a recorded cause; runs went on after the tick that
started them ended, and no pass outlived its launch record; every launch
billed the account it was admitted on; every pickup's first drive ran
through the runtime; every worktree whose pull request merged was collected
or kept with a reason; and a person attached to a run and took one over
without Orca. The pull request that then makes the process runtime the
default records that week's log and adds a dated amendment here.
