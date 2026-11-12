---
title: "ADR-0018: The steward proposes within a remit the host widens and the repository caps"
type: adr
status: draft
description: "The steward stays a proposer whose closed record kinds the tick checks and applies; a record kind that writes tracker state, re-runs CI or spends a re-drive past the tick's own rule joins only as an opt-in of the host, capped by the repository's autonomy ceiling, with a guard the tick reads from its own facts, a record a person can reverse, and only once the steward finishes reliably and its digest carries the facts the guard names; work the tick can decide from its own records stays the tick's"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-12
owner: maintainers
decision_date: 2026-11-12
supersedes: ~
superseded_by: ~
tags: [adr, autonomy, dispatcher, steward, dark-factory]
---

# ADR-0018: The steward proposes within a remit the host widens and the repository caps

**Status:** Draft · **Date:** 2026-11-12 · **Deciders:** Jig's maintainers through pull-request review

## Context

The [steward](../../GLOSSARY.md) is an agent pass the
[dispatcher](../../GLOSSARY.md)'s host starts to read what is stopped and
waiting, and to propose records the next tick checks and applies: re-arm a
drive whose logs show a passing cause, resume a routine question with its
recommended option, frame a need, fill an empty facet, order tied items. It
never writes to the forge or the tracker itself, and its only tracker
write, an empty facet, goes through the tick.

Measured on a dispatch host over ten days, most of what reached a person
was not a decision ([design/need-classes.md](../../design/need-classes.md)).
Some of it needs reading that no rule of the tick can do: whether a pull
request carries a stalled item's work, whether a failing check is a flake.
Three record kinds would settle it, and each one goes past the steward's
present remit: linking an item to its pull request or releasing a stale
claim writes tracker state; one more re-drive after a flake spends a pass
past the tick's own once-per-head rule; re-running a run's failed jobs
acts on CI. A fourth, re-running a stage that ended without a result, is
idempotent and decided from the tick's own records.

The forces:

- **The steward reads untrusted text.** Pull request bodies, review
  threads, tracker items and pass output are data an attacker can write.
  Each record kind added raises what an injected instruction could ask the
  tick to do.
- **A silent pass costs more with more authority.** About one steward pass
  in seven ends without submitting, and most of its asks say its digest
  cannot establish why. A wider remit built on that would decide from
  facts it cannot see.
- **A shared tracker is shared.** A wrong reconciliation hides unfinished
  work from everyone who reads the tracker.
- **Retries cost.** A re-drive or a CI re-run spends an account's passes
  and the repository's CI; a loop of them is a large bill.

## Decision

1. **The steward proposes; the tick acts.** Every record the steward
   submits has closed fields (targets, kinds and classes from fixed lists,
   checked at submit) beside a reason in its own words. The tick reads the
   facts each record's guard names itself, from the forge, the tracker and
   its own records, never from the steward's digest or reason, and refuses
   a record whose facts do not hold. The reason stays in the owner host's
   state database and is never posted where others read it. The steward never launches,
   merges, answers a registry-class park
   ([ADR-0010](ADR-0010-parking-is-reserved-for-registry-classes.md)),
   re-arms a drive a person stopped or held, writes an item's done state,
   changes configuration or sends a session free text.
2. **A record kind that writes tracker state, acts on CI, or spends a pass
   past the tick's own rule is a widening.** It joins the steward's remit
   only with all of these:
   - the host opts in through `steward.remit` in the machine's dispatch
     file;
   - the repository's `autonomy.max_level` is `unattended` or `wide`; at
     `attended` the tick turns such a record into a framed need for a
     person;
   - a guard the tick reads from its own facts, stated with the kind;
   - a record of the step where a person sees it and can reverse it: a
     comment on the item or the pull request, written by the tick from a
     fixed text, naming the record kind, the facts it checked and the
     reversal;
   - a cap: once per target and change, and a weekly ceiling per
     repository where the kind spends passes, whose reaching is recorded as
     a reflection finding proposing a rule.
3. **The steward must see before it may act.** A widened kind ships only
   once the steward's digest carries the facts its guard names (the
   workspace's git state, the last pass's output, the pull requests that
   name an item, a failing check's history) and the steward's passes that
   end without submitting stay under one in twenty over a week on the owner
   host.
4. **The kinds admitted on that basis** are `settle` (link an item to the
   pull request that names it, or release a stale claim), `redrive` after a
   flake (one more re-drive per head of a drive whose CI repair is spent)
   and `rerun-checks` (re-run a run's failed jobs once). Their guards are in
   [design/need-classes.md § The steward's remit](../../design/need-classes.md#the-stewards-remit).
5. **What the tick can decide from its own records stays the tick's.** A
   re-run of a stage that died or recorded no result is the tick's rule,
   never a steward record: it needs no reading, and a rule runs the same
   way every time.

## Alternatives considered

- **Keep the remit as it is.** Rejected: the steward then recovers almost
  nothing, and the needs that need reading all reach a person.
- **Give the tick these rules outright.** Kept where the tick can decide
  from facts alone (a pull request a launch opened that names the item, a
  stage that died). Rejected for the rest: telling a flake from a
  regression, or a pull request that carries an item's work from one that
  mentions it, needs reading a rule cannot do.
- **Let the steward act directly**, with its own tracker and forge
  credentials. Rejected: the guards would then run inside the pass that an
  injected instruction steers, and the tick's re-read is the one check the
  pass cannot skip.
- **A free-text instruction record the tick hands to a session.** Rejected:
  it is the injection path the closed fields exist to close.
- **Widen first, fix the steward's reliability later.** Rejected: a pass
  that cannot see why a drive stalled would decide blind, and a silent pass
  with authority leaves work half-settled.

## Consequences

- A host that opts in has fewer needs for a person, and every one the
  steward settles leaves a comment a person can read and reverse.
- A repository at `attended` keeps every widened record as a framed need,
  whatever the host opts in to.
- The steward's skill, its digest and the tick's apply step grow with each
  kind, and each kind needs its guard tested against stale and hostile
  input.
- The prerequisite holds the widening back until the steward's digest and
  reliability work lands.

## When to reopen

- A widened kind's record is reversed by a person more than rarely: its
  guard is too loose, or the kind should go back to a person.
- The acceptance report shows a kind's framed need always answered with
  the steward's proposal: the tick could take it as a rule.
- The steward's no-result rate climbs back over the threshold.

## Extraction (decisions-become-checks)

Not mechanically checkable until the kinds are built. Then the steward's
submit refuses a kind the host's `steward.remit` does not name, the tick's
tests apply each widened kind only when its guard's facts hold and turn it
into a framed need at `attended`, the cap's tests count per target and per
week, and the digest's tests show every fact a guard names present. That
no field but a record's reason carries free text, and that the reason is
never posted, is the records registry's and review's to hold.
