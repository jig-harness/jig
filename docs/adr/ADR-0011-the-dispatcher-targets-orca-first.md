---
title: "ADR-0011: The dispatcher targets Orca first"
type: adr
status: draft
description: "Herdr stays the first runtime for workspace lifecycle; the dispatcher, which starts the execution line's stages unattended, is built for Orca first, and other runtimes come through the same session runtime interface"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-30
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
[execution line](../../FACTORY.md#execution-the-work-item-line) (the steps
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
and has a socket API, but has no account roster and no phone client, so a
dispatcher built on it first would have to manage accounts and reach a
person outside the runtime.

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

- **Herdr first, per ADR-0005**: rejected for the dispatcher; accounts and
  the way to reach a person would be built outside the runtime, as Jig's
  own services, before the first stage could run unattended. A Herdr
  implementation is added when Herdr can supply them.
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
- Whether an Orca launch can name the account of an interactive session is
  unverified, so the dispatcher's first stage binds accounts for headless
  passes only.

## Extraction (decisions-become-checks)

Not yet checked by a gate: the dispatcher is not built. Its build order
runs the tick's tests against a fake `orca` command, and its README is to
list the Orca commands and output it relies on, as the
[Orca workspace tool](../../tools/orca/README.md)'s does.
