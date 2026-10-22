---
title: "ADR-0005: Herdr is the primary workspace runtime Jig's tooling targets"
type: adr
status: approved
description: "Jig's practices name no workspace runtime; its runnable tooling is built and tested for Herdr first, and other runtimes are supported through the same interfaces"
lifecycle: permanent
version: "1.0"
last_updated: 2026-10-21
owner: maintainers
decision_date: 2026-10-16
supersedes: ~
superseded_by: ~
tags: [adr, workspaces, launcher, parallel-work]
---

# ADR-0005: Herdr is the primary workspace runtime Jig's tooling targets

**Status:** Approved · **Date:** 2026-10-16 · **Deciders:** Jig's maintainers

## Context

A [workspace runtime](../../GLOSSARY.md) is the app or terminal tool that
creates an agent's workspace, usually a git worktree, and runs the agent
session in it. Jig's practices need one only through
[M12](../../modules/M12-parallel-agent-ergonomics/README.md)'s invariants
(each workspace gets its own ports and locks, a lifecycle with a create and a
remove step), and they name none. Jig's runnable tooling does touch one: the
[workspace launcher](../../tools/launcher/README.md) opens workspaces through
a provider per runtime, and the skills that supervise or read agent sessions
run inside whatever runtime started them.

Without a stated target, the only runtime the tooling is built and tested
for is the one Jig's maintainers happen to use. That runtime then reads, to
someone evaluating Jig, as the one Jig is built for, although nothing in
Jig requires it.

[Herdr](https://herdr.dev) is a terminal workspace manager for coding
agents. It runs wherever a terminal does (Linux and macOS, Windows in beta),
on the machine or on a remote host over [SSH](../../GLOSSARY.md), keeps sessions alive across
disconnects, and supports Claude Code, Codex and many other agents. It
creates worktrees and starts and prompts agents through documented commands
and a socket API, and emits lifecycle events (`worktree.created`,
`worktree.removed`) that plugins can hook.

## Decision

Herdr is the primary workspace runtime Jig's runnable tooling targets. Every
part of Jig that touches a workspace runtime (the launcher, M12's lifecycle
mappings, the skills that supervise or read agent sessions) is built to work
in Herdr, on macOS and Linux, and is tested there; a gap in Herdr support
is fixed before the same gap in any other runtime.

The practices stay runtime-neutral: a module names no runtime in its
invariant and maps runtimes in its `mappings.md` as it maps CI providers.
Other runtimes, Conductor among them, keep working through the same
interfaces (a launcher provider, a lifecycle hook point), and none is
presented as Jig's default.

## Alternatives considered

- **Name no target at all**: rejected; neutrality without a tested target
  leaves the maintainers' own runtime as the only one that works.
- **Conductor as the primary target**: rejected; it is a macOS desktop app,
  so a launcher built for it runs on macOS only, and its provider reads the
  app's private database, which is not a documented interface. It remains a
  supported provider.
- **Every runtime equally**: rejected for now; each provider and each hook
  point costs tests to keep working, and an order says which gap is closed
  first.

## Consequences

### Benefits

- One runtime that runs on Linux and on remote hosts is supported first, so
  the tooling is not bound to one desktop operating system.
- Documents written for teams adopting Jig name Herdr where they name a
  runtime, and show Conductor as one supported provider, not as how Jig is
  meant to be run.

### Costs

- The Herdr provider for the launcher, and checks of the skills inside
  Herdr, are now ahead of other workspace work
  ([ROADMAP.md](../../ROADMAP.md) item 19).
- Herdr's command line and event names become an interface Jig depends on,
  so a Herdr release that changes them is work for Jig.

## Extraction (decisions-become-checks)

Not yet checked by a gate. `reflect` records Herdr as the session's wrapper
when `HERDR_ENV` is set (`plugin/skills/reflect/__tests__/events.test.ts`).
The Herdr workspace tool and the launcher's Herdr provider carry their own
tests (`tools/herdr/__tests__/`, `tools/launcher/herdr-provider.test.ts`),
and the tool's README lists the Herdr commands and output it relies on.
