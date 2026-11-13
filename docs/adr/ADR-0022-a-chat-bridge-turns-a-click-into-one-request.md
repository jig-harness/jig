---
title: "ADR-0022: A chat bridge turns a person's click into one request"
type: adr
status: draft
description: "A team's chat may carry buttons and commands through one resident chat bridge, on the hub or on a host that is not enrolled, which opens an outbound connection and listens on no socket, and turns each interaction into one request through `jig send`'s writers; on the hub a request is posted under the bridge's own forge app identity, naming the person the chat authenticated, and on a host under the host's credential, trusted as `jig send` from it"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-13
owner: maintainers
decision_date: 2026-11-13
supersedes: ~
superseded_by: ~
tags: [adr, chat, dispatcher, hub, answers, security]
---

# ADR-0022: A chat bridge turns a person's click into one request

**Status:** Draft · **Date:** 2026-11-13 · **Deciders:** Jig's maintainers through pull-request review

## Context

The [dispatcher](../../GLOSSARY.md) notifies a person through the session
runtime, and the [dispatch dashboard](../../GLOSSARY.md) shows the same
needs. A team that works in a chat tool wants the line there: what is ready
to merge, each decision with its options, and a way to answer and to ask
without a terminal ([design/chat.md](../../design/chat.md)). Posting into
a chat needs nothing new: the tick makes outbound calls already. Receiving a
click or a command does.

The forces:

- **No resident coordinator, and no route into a host.**
  [ADR-0013](ADR-0013-records-not-a-daemon.md) allows one resident reader
  per machine and no coordinator;
  [ADR-0011](ADR-0011-the-dispatcher-targets-orca-first.md) refuses an
  inbound route to a host. A chat tool delivers a click either to a public
  address it calls or over a connection the app opens to it.
- **A person's act, and whose identity carries it.**
  [ADR-0016](ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)
  makes a person's act with that person's credential, never through the
  hub. A click in a chat is authenticated by the chat tool, not by the
  forge, and the forge comment it becomes must be posted by some identity.
- **Item 40 is not settled.** Nothing yet tells a comment a pass posts
  under a person's login from the person's own, so a surface that posts
  under that login proves no more than `jig send` does.
- **The hub may run where no pass runs.** A secret held only there is out
  of every pass's reach; the same secret on a host is not.

## Decision

A team's chat may carry buttons and commands through a **chat bridge**:

- **One resident process, in one place per chat app.** It runs inside the
  hub (`jig hub serve`) for the hub's enrolled hosts, or as `jig chat
  serve` on a host that is not enrolled. It opens an outbound connection to
  the chat tool (Slack's Socket Mode first) and listens on no socket.
- **A click is one request.** The bridge turns each interaction into one
  request through `jig send`'s writers, with its checks, after checking
  that the chat user belongs to the configured workspace, is mapped or
  linked to a forge login, and for a write that the login may write to the
  repository. It keeps only the ids of the interactions it ran, so one the
  chat delivers twice runs once. It starts no session, nothing the line
  runs reads from it, and stopping it removes the buttons and commands and
  nothing else.
- **Notices stay with the hosts.** The tick of the host that owns a
  repository's notices posts them to the chat, as it writes them today;
  the hub posts none.
- **On the hub, the bridge's own identity posts.** The bridge posts under a
  forge app identity of its own, whose key only the hub holds, and each
  request carries a record naming the chat user and the forge login that
  user linked through that app. A repository that lists the identity in its
  configuration at its base branch counts an answer from it as the linked
  person's, when that person may write to the repository. This is the one
  exception to ADR-0016's rule that a person's act is never made through
  the hub, and the hub's first write on the forge and the tracker, named in
  [design/control-plane.md](../../design/control-plane.md). A request
  whose record lives in a host's working tree (a drive's mailbox) is not
  made through the hub, which calls no host.
- **On a host, the host's credential posts**, with the same record naming
  the chat user, and the request is trusted as `jig send` from that host
  is. The record describes the request and never changes whose it is.
- **Attested classes wait for item 40.** A host's bridge never offers them;
  the hub's offers them once item 40 accepts its identity as proof that a
  person answered, and only where the hub runs on a machine that runs no
  pass.

The bridge is one more resident process where it runs. It reads the
records each request's checks need and writes only the requests a person
makes, so ADR-0013's rule against a coordinator holds; this record adds it
beside the dashboard's reader and the hub as a process ADR-0013 allows.
[ADR-0012](ADR-0012-failures-as-values.md)'s model holds: each interaction
is a bounded request whose failure is a value.

## Alternatives considered

- **A request URL the chat tool calls.** Rejected: it needs an address the
  internet reaches, on the host (which ADR-0011 refuses) or on the hub
  (which then needs a public front). Socket Mode needs neither.
- **Each person's own forge token on the bridge.** Rejected: a comment
  posted with it looks like the person's own, which is exactly what a pass
  under that login can forge, so it proves nothing more while it puts
  every person's credential on one machine.
- **The host's credential on the hub as well.** Rejected: on the hub it
  would carry the passes' login to a place passes cannot reach and lose the
  one property the hub's placement offers, an identity no pass posts under.
- **Messages only, every answer copied and pasted.** Kept as the first tier
  for a team that runs no bridge. Alone it leaves the slowest step of an
  answer, on a phone, where it is.

## Consequences

### Benefits

- A person answers a decision, and asks and tells the line, from the chat,
  with no terminal and no route into any machine.
- On the hub, an answer from the chat is told apart from anything a pass
  can post, and names the person who made it.
- The readers of answers and requests stay as they are: each request is
  one of the records they read today.

### Costs

- One more resident process where the bridge runs, upgraded with the
  plugin.
- A chat app per team, and on the hub a forge app, each with credentials
  to keep.
- One chat app has one placement: a host that enrolls in a hub with a chat
  stops its own bridge, or uses an app of its own.
- On a host, the chat's tokens are as reachable by a pass as the host's
  other credentials, and every chat user the host maps can act as the
  host's login, where before only someone with a shell on the host could;
  a host maps only the people it serves.
- A hub on the host that already dispatches holds the bridge's key where
  passes run, and gives no more proof than a host's bridge;
  `jig chat doctor` warns about it.
- The hub, read-only until now, gains named writes on the forge and the
  tracker, and the permissions they need.
- Everyone in a channel reads what is posted there, private repositories'
  titles and decisions included, so a channel's membership becomes part of
  who may read a repository's work.

## When to reopen

- Item 40 settles how a person's answer is told from a pass's, with a proof
  the bridge's identity does not give.
- A chat tool the team needs delivers interactions only to a public
  address.
- A person needs to merge from the chat.

## Extraction (decisions-become-checks)

Not mechanically checkable until the bridge is built. Then its tests run an
interaction against a station that refuses it and find nothing written; the
records registry's gate holds the `chat-thread`, `chat-link` and
`chat-request` kinds; `trusted-authors.ts`'s tests refuse a bridge identity
the base branch does not list; and that the bridge opens no listening
socket is review's to hold, as ADR-0013's is.
