---
title: "ADR-0025: Deferred findings stay outside an epic's designed scope"
type: adr
status: approved
description: "Deferred review findings enter the backlog in batches linked to their origin, person-only tails move to one standing list, and completed epic scope leaves the plan"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-15
owner: maintainers
decision_date: 2026-11-15
supersedes: ~
superseded_by: ~
tags: [adr, tracker, relationships, review]
---

# ADR-0025: Deferred findings stay outside an epic's designed scope

**Status:** Approved · **Date:** 2026-11-15 · **Deciders:** Jig's maintainers

## Context

A review can discover work outside the change it is reviewing. Making each
finding a child of the originating [epic](../../GLOSSARY.md) grows the epic's
scope while it is being delivered. Filing each finding separately also
fragments prioritization. An epic whose delivery is finished can remain open
indefinitely because a person's check or newly discovered review debt is
still attached to it, and its plan entry keeps presenting finished scope as
open work.

## Decision

**Deferred findings enter the backlog, linked to their origin.** Each is
filed with a priority and a category. A follow-up has native `related`
relations to the originating issue and its epic, where there is one, and
is never their child. The relation form is already settled by
[ADR-0015](ADR-0015-relationships-live-in-the-tracker.md); this record amends
no earlier record. Nothing is backfilled: existing children carrying
`pr-followup` remain [tails](../../GLOSSARY.md) that leave at closure.

**Batch by pull request and issue type on every tracker.** A repository's
pull request and type identify one open follow-up issue. Its priority is the
highest of its findings and its category is the union of their areas. Later
findings for the same key append to that open issue. GitHub and Linear use
the same rule. There is no per-pull-request cap on deferrals.

**Person-only checks are tails.** Plain `hitl` and `ops-pending` checks move
at closure to one standing open [person-checks list](../../GLOSSARY.md), named
by `issue_tracker.person_checks`. An epic that itself owes an operator step
files that step on the same list and closes once its designed scope has an
accepting verdict or a person's waiver. The step remains owed on the list;
closing the epic does not declare the step done.

**Finished scope leaves the plan in the finishing pull request.** The pull
request that finishes an epic's designed scope removes its `design/plan.md`
entry and its ROADMAP entry when listed there. What changed belongs in the
change note and the released changelog.

**Jig's GitHub epics use the native issue type `Epic`.** An epic needs no
separate work kind. Adopting repositories may instead mark a container with
an epic flag while retaining its work type.

Jig's own repository does not arm the decline ladder, which remains a
documented practice for adopting teams. This decision authorizes no amnesty
pass and no backfill of existing follow-ups.

## Alternatives considered

- **Keep new findings under the epic until closure.** Rejected: each review
  adds children that look like designed scope and pushes closure farther
  away. A related link keeps the association without changing scope.
- **One issue per finding.** Rejected: it spreads prioritization across
  issues whose source and type already identify a coherent batch.
- **Keep a completed epic open for a person's check.** Rejected: it hides
  the distinction between delivered scope and an owed check. The standing
  list keeps that check visible after the epic closes.
- **Cap or forgive deferrals in bulk.** Not adopted: batching limits issue
  growth without discarding findings or choosing an arbitrary cap.

## Consequences

### Benefits

- A review preserves owed work and its provenance without enlarging the
  originating epic's designed scope.
- One open issue per batch gives later findings an existing destination.
- A person's remaining checks stay visible without keeping delivered scope
  on the active plan.

### Costs

- The batch writer must find existing open batches, retain the highest
  priority and union categories when appending.
- Closure must preserve links and move tails before closing; counts alone
  still do not authorize closure.
- The person-checks list needs an owner and a configured destination.

## Implementation

M9 states the work-item rules and the review skill's deferral protocol
applies them. The deferral scripts use the tracker interface and its
[governed transport](ADR-0021-outbound-calls-are-governed.md) for filing,
appending and native relations. The closure sweep, the person-checks
destination and the other readers of the native Epic type are separate
implementation steps; recording this decision does not assert they already
run.

## Extraction (decisions-become-checks)

Not mechanically checkable as a text pattern. The repository has no
decision-rules catalog. Behavioral tests check batching, appending, priority,
category and related links without a parent. Review checks that closure moves
person-only tails, that finished scope leaves the plan in its finishing pull
request, and that an epic type needs no separate kind.
