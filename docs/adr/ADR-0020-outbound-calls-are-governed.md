---
title: "ADR-0020: Every call to an outside system goes through a governed transport"
type: adr
status: approved
description: "Each system Jig integrates with has one transport, built from one shared library, that reuses an answer before it sends, asks a shared budget, bounds what a call can cost, records what it spent, and fails as one of a closed set of classes"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-13
owner: maintainers
decision_date: 2026-11-13
supersedes: ~
superseded_by: ~
tags: [adr, integrations, rate-limits, plugin]
---

# ADR-0020: Every call to an outside system goes through a governed transport

**Status:** Approved · **Date:** 2026-11-13 · **Deciders:** Jig's maintainers through pull-request review

## Context

Jig's runnable code calls systems it does not control: a
[forge](../../GLOSSARY.md), an issue tracker, a store for what sessions
learned. Each of them limits its callers, and in more than one way: a count
of requests an hour, a cost charged per query, a time after which it gives up
on a request. A credential's limits are shared by every process that uses
it: the [dispatcher](../../GLOSSARY.md)'s [ticks](../../GLOSSARY.md), the
sessions it starts and the skills a person runs. The network between them
fails too, and a host is sometimes offline.

Jig runs with nobody watching, on a timer, against whatever a repository
holds. A read that costs a little on a small repository costs a hundred
times more on a busy one, every few minutes, with no person to notice. What
that looked like before this decision:

- A nested list with no page size made one tracker query cost ten times
  what the same answer costs with the size given, and a dozen such queries a
  tick spent the credential's whole hourly allowance.
- A forge read asked for fifty pull requests a page. On a repository whose
  pull requests each carried a hundred check results the forge ran out of
  time on every request, and the repository was not read at all.
- Each cause was found by a person probing the service by hand, since
  nothing recorded what an operation cost.
- Each integration decided for itself what a failure was. One retried a
  refused read and another did not; one told "rate limited" from "offline"
  and another reported both as an exit code. A refusal that would have
  cleared by waiting failed a tick and asked a person.

A [deadline](../../plugin/AGENTS.md) on every call was the only rule that
covered them all.

## Decision

Every call Jig sends to a system it integrates with goes through that
system's one **governed transport**, and every transport is built from one
shared library, `plugin/shared/outbound/`. A transport has these
obligations:

1. **One door.** Each outside system has one transport module, and no other
   code sends to that system.
2. **Reuse before sending.** An answer is cached under what makes it stale:
   the item's update time, or the system's own validator where it offers
   one. The same read asked for twice in one run is sent once. Many items
   are read by key in one request, and a reader asks what changed before it
   reads everything.
3. **Admit before sending.** The transport asks the machine's
   [budget record](../../GLOSSARY.md) for the credential. A spent or refused
   credential sends nothing until the time the system named.
4. **Bound what one call can cost.** Every call has a deadline. Every list
   has a page size, and nested page sizes multiply to less than a ceiling
   declared beside the query. A paged read shrinks its page when the system
   runs out of time on it.
5. **Record and report what it cost.** Requests, the system's own cost unit
   and the time taken, by named operation and by caller, in a
   [cost ledger](../../GLOSSARY.md). Each quota's balance is reported where
   people look, and a quota that will run out is announced before it does.
6. **Fail as one of a closed set of classes**: rate limited (with the
   reset), unreachable, too costly, server fault, unauthorized, not found,
   invalid. Each [failure class](../../GLOSSARY.md) has one policy for
   retries and for when a person is told.
7. **Say what the reader does without an answer.** A reader shows its last
   reading with its age. A tick does not exit nonzero or ask a person for a
   class that clears by waiting, until that class's threshold. A system
   that did not answer is not asked again in the same tick.

The rule covers every system Jig reaches over the network: the forge, the
issue trackers and the reflection stores. A local tool Jig runs (a
workspace application's command, `git` against a remote) has no rate limit
to budget: it keeps obligations 4, 6 and 7 only.

A transport supplies what is its system's own: the limits and how an answer
reports them, how to send, and how to read a call's cost. Everything else
is the library's, so a new integration gets the obligations by construction
and a fix reaches every system at once. The library's parts, each system's
limits, the classes with their policies and the build order are in
[design/outbound-calls.md](../../design/outbound-calls.md).

Any change to an integration is reviewed against these obligations.

## Alternatives considered

- **A rule each transport implements itself.** That was the state before:
  each transport with its own classification of failure, a retry in some,
  and a budget only the trackers fed. A checklist does not stop the copies
  from drifting, and a defect fixed in one stays in the others.
- **A rate-limiting library** that queues or spaces one process's requests.
  The limits here belong to a credential that many short-lived processes
  share, half of Jig's calls leave through a command-line client and not a
  request Jig builds, and the plugin vendors what it ships
  ([ADR-0001](ADR-0001-bun-typescript-toolchain.md)). The budget is a
  record on the machine, as Jig's parts already share everything else
  ([ADR-0013](ADR-0013-records-not-a-daemon.md)).
- **A resident proxy** every call goes through. It would see every request
  and could queue them, and it is one more process to install, keep alive
  and secure on every host. ADR-0013 declines a daemon for the same reasons.
- **Fixing each cost as it is found.** Each fix was correct, and the next
  cause arrived from a read nobody had measured. Without a ledger the next
  one is found the same way.

## Consequences

### Benefits

- What spent a quota is a query over the ledger, not an investigation.
- A read meets a heavier repository by shrinking, and a refused credential
  by waiting, without a person.
- A new tracker or forge adapter writes its limits and its send, and
  inherits the rest.

### Costs

- Every transport is rebuilt on the library, one pull request at a time,
  while the others keep their own handling.
- A query's author declares a cost ceiling and keeps it true.
- The ledger is one more record on the machine, kept small by holding
  totals and not calls.

## Extraction (decisions-become-checks)

[Gates](../../GLOSSARY.md) hold what a script can see, each a
[ratchet](../../GLOSSARY.md) over the calls that predate the rule:
`scripts/check-outbound-boundary.ts` fails a call that leaves by any door
but a transport (obligation 1), and `scripts/check-query-cost.ts` fails a
query with a list that has no page size or whose nested sizes pass its
declared ceiling (obligation 4). The library's types hold obligations 3, 5
and 6: a transport cannot send without the budget, cannot return without a
ledger entry, and cannot fail outside the classes. Tests with a fake of each
system hold obligations 2 and 7 by counting requests and by reading what a
tick reports when a system refuses. The review skill's integration
[lens](../../GLOSSARY.md) asks each obligation as a question of any change
in the integrations' change area. Each of these arrives with the step of the design
that builds it; until then review holds the obligation.
