---
title: "ADR-0019: The dashboard's page answers a parked decision as the person"
type: adr
status: draft
description: "The dispatch dashboard's page may post a parked decision's answer: from the browser, to the forge's API, with a fine-grained token the person pastes into that browser and that the host never receives; the dashboard's server keeps no write route, the dispatcher never relays an answer, and the answer is trusted as one `jig send` writes from a terminal until item 40 tells a pass's comment from a person's"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-12
owner: maintainers
decision_date: 2026-11-12
supersedes: ~
superseded_by: ~
tags: [adr, dashboard, security, answers, dispatcher]
---

# ADR-0019: The dashboard's page answers a parked decision as the person

**Status:** Draft · **Date:** 2026-11-12 · **Deciders:** Jig's maintainers through pull-request review

## Context

A drive parks a decision it may not make alone and waits for a person's
answer: an `answer <key>:` line in a comment on its pull request, read by
the re-arm from an author the forge vouches for
([structured answers](../../design/structured-answers.md)). The
[dispatch dashboard](../../GLOSSARY.md) shows each parked decision with its
options, lets a person pick and copies the comment that answers it; the
person then pastes it on the pull request, or runs `jig send` in a
terminal. On a phone, away from a terminal, the paste is the slowest step
of the act the dashboard's Needs you view exists for.

The forces:

- **The host must not gain a route that accepts a request**
  ([ADR-0013](ADR-0013-records-not-a-daemon.md)). A host's dashboard
  answers reads only, and its passes run with the person's forge login, so
  a write button the host serves could be pressed by any process running
  as the person, a pass included.
- **Item 40 is not settled.** Nothing yet tells a comment a pass posts
  under the person's login from the person's own, so no surface can offer
  stronger proof of a person than `jig send` does, and a pass that holds
  the login can already post an answer without any surface.
- **A phone has no terminal**, and the dashboard's phone scope must answer
  as well as read.

## Decision

The dashboard's page may submit a parked decision's answer, and does it
from the browser, as the person:

- The person pastes a fine-grained GitHub token once per browser. The page
  tests it with GitHub (`GET /user`), names the login it signs in as, keeps
  it in that browser's local storage alone and forgets it on request.
- A card's **Send** posts, for each decision it answers, the comment
  `jig send` writes: the answer line Copy takes (`approve` or
  `choose <name>` with the decision's digest), any note line, and the
  hidden `drive-answer` record with the digest, the choice and the writer,
  whose host is `dashboard (browser)`. The shared module that builds
  `jig send`'s comment builds it, and the page posts it directly to the
  forge's REST API.
- Send is held back until an option is picked on the card: an approval
  nobody picked is Copy's alone. A guarded pick sends on the second step,
  as it copies.
- Send is offered only when the page came over HTTPS, from loopback
  (`localhost`, 127.0.0.0/8, `::1`); on any other plain-HTTP address the card says why it
  has none.
- Send works on a phone as on a desktop.
- The host stays read-only: the dashboard's server gets no write route and
  never receives the token or the comment, and the dispatcher never relays
  an answer.
- The page's content security policy lets it connect to its own server and
  `https://api.github.com` alone, and runs only its own script.
- An answer the page posts is trusted as one `jig send` posts from a
  terminal, by the person's login, until item 40 settles how a pass's
  comments are told from a person's.

Send is offered only where a station reads an answer comment, a parked
drive's decisions today; any other card keeps Copy and says why it has no
Send.

## Alternatives considered

- **A `POST /answer` route on the dashboard's server, gated by a passkey.**
  Rejected: it adds a write route on the host, which this record chooses
  not to add (ADR-0013 permits a write made for a person, as one of the
  records the line already reads, but does not require one), and needs enrolment and HTTPS before the first answer. Until item 40, the
  answer it posts is still the person's login's comment, so the passkey
  proves a person to the dashboard, not to the drive that reads the answer.
- **Copy and paste only.** Rejected: it keeps the host read-only at the
  cost of the slowest step on a phone, and adds no safety a pass holding
  the login does not already bypass.

## Consequences

### Benefits

- A person answers a parked decision in one tap from any browser,
  a phone's included, with no terminal and no route into the host.
- The comment is the one `jig send` and a paste write, so the re-arm and
  every reader of answers read it unchanged.

### Costs

- The token is as safe as the page's origin and the browser that keeps
  it: a script injected into the page could read it, which the strict
  content security policy and rendering every record's text as data guard
  against, and a narrow scope (the dashboard's repositories, Issues and
  Pull requests only, a short expiry) limits. Over plain HTTP, someone on
  the network path who can change the page could read it, so Send is
  offered only over HTTPS or loopback.
- Any process of the person's account on the device whose browser keeps
  the token can read it, as it can read a terminal's credential.
- Send reaches github.com only; a pull request on another forge keeps Copy.
- A card of several decisions posts several comments, one per decision,
  since a comment carries one record.

## When to reopen

Reopen this when one of these holds:

- item 40 settles how a person's answer is told from a pass's, and that
  proof needs something the browser does not hold;
- a station other than the drive reads an answer from a comment, or
  another forge's pull requests are parked on;
- a second person acts through one dashboard.
